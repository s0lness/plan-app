// API for the shared plan. Behind Cloudflare Access (only household members get through),
// identity read from the header set by Access after JWT validation.
// A single 'main' row: the household's plan.
//
// ---- `rev` IS NO LONGER JUST INFORMATION: IT IS THE LOCK ---------------------------------------
// There are TWO writers to this row: the Durable Object (snapshot every 30 s) and the client via
// this PUT, when realtime is down. The PUT used to be BLIND: no revision in the body, last writer
// wins. Two people falling back at the same time overwrote one another, and a late client could
// overwrite a more recent state — this is the "split brain" that Figma had to lock at the database
// level. State of the art is unambiguous: any "whole document" write requires a COMPARE-AND-SWAP
// on the revision.
//
// The contract, from now on:
//   PUT {state, rev}  -> the client states the revision IT HAS THE CONTENT OF. The write only
//                        succeeds if the row still carries that revision, otherwise 409 with the
//                        winning state.
//   PUT {state}       -> blind write, the OLD contract. Kept for a legitimate writer that doesn't
//                        play compare-and-swap: a tab open before this deploy, and any caller
//                        outside the client (see the "what the Worker still has to do" note
//                        below). The live client, itself, ALWAYS sends `rev`.
//
// The swap is done by A SINGLE statement, so it is atomic: there is no SELECT then INSERT in
// between which another writer could slip in. `ON CONFLICT(id) DO UPDATE … WHERE plans.rev = ?4`
// inserts the row if it doesn't exist, updates it IF AND ONLY IF the expected revision is still
// the one in the database, and does NOTHING otherwise. The verdict is read from the number of
// rows touched (`meta.changes`), never from a re-read.
//
// WHAT REMAINS OPEN, AND BELONGS TO THE WORKER: the Durable Object's snapshot
// (live-worker/worker.ts, `snapshot()`) writes this same row WITHOUT an expected revision, via
// its own D1 binding — it does not go through this Function. Until it has its own
// compare-and-swap (see DEPLOY.md / the report), it can still overwrite a REST write it hasn't
// seen; it MITIGATES this by rereading the row before every snapshot (`reconcileD1`).

// Identity: `identiteFoyer` (../porte.ts) is THE ONE implementation of `who()`. It reads the
// header set by Access, with a JWT-decoding fallback, but ONLY on the household door: off it,
// every one of those inputs is caller-supplied and unsigned. See docs/decisions/0004-partage-par-lien.md.
//
// ---- THE "invite" DOOR (batch 1b) ----------------------------------------------------------
// A guest carries no Access identity and no `?p=`: `?p=` is IGNORED on this door (design edge 5,
// a guest editing the URL must not reach another plan), and the plan comes from the SESSION
// COOKIE set by functions/api/invite.ts, resolved through the SAME `invites` row every other
// guest-facing route reads (functions/invitation.ts). A PUT here also drops the OLD blind-write
// contract entirely: `rev` is required, because a blind PUT is `plan5.replace` by another name
// (last writer wins, whole document), the old contract exists for a tab opened before this
// feature deployed, and no guest tab predates it. `updated_by` for a guest write is
// `"invite:" + <name or "?">`, built from the invite row's `last_name` — never an email (there is
// none to have), and never the literal `"live"` (identiteFoyer already screens that out; this
// path never calls it at all).
import type { Env } from "../env.ts";
import { identiteFoyer, porteDe } from "../porte.ts";
import { auteurPourInvite, cleanName } from "../nom.ts";
import { chargerInvitation, invitationValide, tokenDuCookie } from "../invitation.ts";

interface PlanRow {
  data: string;
  rev: number;
  updated_at: string | null;
  updated_by: string | null;
}

// WHICH plan. `main` by default (the household's historical plan); a malformed identifier is an
// ERROR and never a silent fallback, otherwise a broken URL would write into the wrong plan.
const PLAN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const planIdDe = (request: Request) => {
  // NO REQUEST = NO URL = the household's plan. This is not the same thing as a MALFORMED
  // identifier, which remains an error: here nobody asked for anything, there somebody asked for
  // something impossible. An internal caller (a test suite, a future server-to-server call) has
  // no URL to present and must land on `main`.
  let brut = null;
  try { brut = new URL(request.url).searchParams.get("p"); } catch (_) { return "main"; }
  if (brut === null || brut === "") return "main";
  const s = String(brut).trim().toLowerCase();
  return PLAN_ID_RE.test(s) ? s : null;
};
const mauvaisPlan = () => new Response(JSON.stringify({ error: "bad_plan_id" }),
  { status: 400, headers: { "content-type": "application/json" } });
// ONE shape for "no invite cookie", "unknown token", "revoked" and "expired": telling them apart
// would confirm a guess. Also what a revoked guest gets mid-session (design edge 18): "offline"
// would dress a PERMISSION answer as a NETWORK one, in the codebase whose rule is that the chip
// never lies, so 403 (not the 401/404 mix used elsewhere) routes the client to its dead-end
// screen instead of a retry loop.
const inviteInvalide = () => new Response(JSON.stringify({ error: "invite_invalide" }),
  { status: 403, headers: { "content-type": "application/json" } });

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const porte = porteDe(request, env);
  let planId: string;
  if (porte === "invite") {
    const invit = await chargerInvitation(env, tokenDuCookie(request));
    if (!invitationValide(invit)) return inviteInvalide();
    planId = invit.plan_id;   // `?p=` IGNORED: design edge 5.
  } else {
    const pid = planIdDe(request);
    if (!pid) return mauvaisPlan();
    planId = pid;
  }
  const row = await env.DB
    .prepare("SELECT data, rev, updated_at, updated_by FROM plans WHERE id=?1")
    .bind(planId)
    .first<PlanRow>();
  if (!row) return Response.json({ data: null, rev: 0 });
  // A ROW WITH NO PLAN IN IT READS EXACTLY LIKE AN ABSENT ROW. `functions/api/plans.ts` creates a
  // plan EMPTY (nobody has drawn anything yet), and "empty" is `data` holding no plan at all: the
  // JSON literal `null` today, an SQL NULL the day `plans.data` stops being `TEXT NOT NULL`
  // (live-worker/schema.sql). Both must answer the contract's `{data:null, rev}`, because the
  // client decides "the household has no plan yet" from that shape and nothing else. `JSON.parse`
  // was reached with `null` as its argument in the SQL-NULL case, which coerces to the string
  // "null" and happened to work; a column holding "" or half a document, on the other hand, threw
  // and turned a readable row into a 500 (see the corrupt-row guard below).
  if (row.data === null || row.data === undefined || row.data === "") {
    return Response.json({
      data: null, rev: row.rev, updatedAt: row.updated_at,
      updatedBy: porte === "invite" ? auteurPourInvite(row.updated_by) : row.updated_by,
    });
  }
  return Response.json({
    data: JSON.parse(row.data),
    rev: row.rev,
    updatedAt: row.updated_at,
    // THE LAST PLACE A HOUSEHOLD ADDRESS COULD CROSS TO A GUEST. Batch 2 stopped emails on the
    // WIRE (the Durable Object projects every message per recipient), but this is the REST
    // fallback, a Pages Function that shares no code with it — and it reads the raw `updated_by`
    // column, which holds an Access email. One GET from the guest door and anyone holding a link
    // collects the couple's address. Design edge 16 covers the wire; this is its other half.
    // A guest is told WHAT they need (someone else wrote before you) and not WHO in a form they
    // could mail: an author already written as `invite:<name>` passes through, an email is
    // reduced to the same display name the wire would have shown.
    updatedBy: porte === "invite" ? auteurPourInvite(row.updated_by) : row.updated_by,
  });
};

// The REST fallback must recognize BOTH shapes, exactly like the client (migrate) and like the
// Worker (ops.ts sanitizeState):
//   - WALLS-ONLY, the live model: `outline` / `walls` FLAT, plus a `plan` nested in the client's
//     complete state (serialize()), which additionally carries h/side/name of the openings;
//   - OLD FORMAT, still readable: `rooms[]`.
// The original guard only accepted `rooms`, so it refused 100% of PUTs from the live model: the
// D1 fallback was dead, and the badge advertised a deferred sync that didn't exist.
// The content is not revalidated here (the Function shares no code with the Worker): the DO
// runs the row back through sanitizeState on cold load, and the client through migrate().
const knownShape = (st: Record<string, unknown>) =>
  Array.isArray(st.rooms) ||
  Array.isArray(st.walls) ||
  Array.isArray(st.outline) ||
  (st.plan && typeof st.plan === "object" && !Array.isArray(st.plan));

// Number of rows actually touched by the last statement. D1 returns it in `meta.changes`
// (verified on the production database: every response carries `meta.changes`). We also accept
// the flat shape from SQLite test harnesses. `null` = the executor doesn't say: we don't GUESS,
// we refuse (a compare-and-swap whose bite we don't know about is not a compare-and-swap).
const rowsChanged = (res: D1Result<unknown> & { changes?: number }) => {
  if (res && res.meta && typeof res.meta.changes === "number") return res.meta.changes;
  if (res && typeof res.changes === "number") return res.changes;
  return null;
};

// The winning state, returned as-is to the loser of the swap: it rereads within the same
// response, without a second round trip (so without a new race).
async function currentRow(env: Env, planId: string) {
  const row = await env.DB
    .prepare("SELECT data, rev, updated_at, updated_by FROM plans WHERE id=?1")
    .bind(planId)
    .first<PlanRow>();
  if (!row) return { data: null, rev: 0, updatedAt: null, updatedBy: null };
  let data = null;
  try { data = JSON.parse(row.data); } catch { data = null; }
  return { data, rev: row.rev, updatedAt: row.updated_at, updatedBy: row.updated_by };
}

export const onRequestPut: PagesFunction<Env> = async ({ request, env }) => {
  const porte = porteDe(request, env);
  let planId: string;
  // Non-empty only when the write comes through the invite door: captured here, at the point
  // where the invite row is still in scope, so the write below never has to re-resolve it.
  let nomEcrivainInvite = "?";
  if (porte === "invite") {
    const invit = await chargerInvitation(env, tokenDuCookie(request));
    if (!invitationValide(invit)) return inviteInvalide();
    planId = invit.plan_id;   // `?p=` IGNORED: same reason as the GET above.
    nomEcrivainInvite = cleanName(invit.last_name, 40) || "?";
  } else {
    const pid = planIdDe(request);
    if (!pid) return mauvaisPlan();
    planId = pid;
  }

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return new Response("bad json", { status: 400 }); }
  const st = body && body.state;
  if (!st || typeof st !== "object" || Array.isArray(st) || !knownShape(st as Record<string, unknown>))
    return new Response("bad state", { status: 400 });
  const data = JSON.stringify(st);
  if (data.length > 2_000_000) return new Response("too big", { status: 413 });
  const now = new Date().toISOString();

  const expected = body && Number.isInteger(body.rev) ? Number(body.rev) : null;
  if (porte === "invite" && expected === null) {
    // A BLIND PUT is `plan5.replace` by another name: no expected revision, last writer wins, the
    // whole document at once. The old contract exists for a tab opened BEFORE this feature
    // deployed; no guest tab predates it, so the guest door requires `rev` on every write.
    return new Response(JSON.stringify({ error: "rev_requis" }),
      { status: 400, headers: { "content-type": "application/json" } });
  }
  const by = porte === "invite"
    // NEVER an email (there is none), NEVER the literal "live": a guest's identity is
    // self-declared and lives in the invite row, not in an Access header this door doesn't have.
    ? "invite:" + nomEcrivainInvite
    : identiteFoyer(request, porte);

  // BLIND write (old contract): no expected revision, last writer wins. Never reachable from the
  // invite door: refused above.
  if (expected === null) {
    await env.DB
      .prepare(
        "INSERT INTO plans(id,data,rev,updated_at,updated_by) VALUES(?4,?1,1,?2,?3) " +
        "ON CONFLICT(id) DO UPDATE SET data=?1, rev=rev+1, updated_at=?2, updated_by=?3"
      )
      .bind(data, now, by, planId)
      .run();
    const row = await env.DB.prepare("SELECT rev FROM plans WHERE id=?1").bind(planId).first<{ rev: number }>();
    return Response.json({ ok: true, rev: row.rev, updatedAt: now, updatedBy: by, cas: false });
  }

  // COMPARE-AND-SWAP, a single statement: insertion if the row doesn't exist, update if and only
  // if `rev` is still the one the client read, nothing at all otherwise.
  const res = await env.DB
    .prepare(
      "INSERT INTO plans(id,data,rev,updated_at,updated_by) VALUES(?5,?1,1,?2,?3) " +
      "ON CONFLICT(id) DO UPDATE SET data=?1, rev=rev+1, updated_at=?2, updated_by=?3 " +
      "WHERE plans.rev=?4"
    )
    .bind(data, now, by, expected, planId)
    .run();
  const changed = rowsChanged(res);
  if (changed === 1) {
    const row = await env.DB.prepare("SELECT rev FROM plans WHERE id=?1").bind(planId).first<{ rev: number }>();
    return Response.json({ ok: true, rev: row ? row.rev : expected + 1,
                           updatedAt: now, updatedBy: by, cas: true });
  }
  // EXPLICIT REFUSAL, never a generic 400: the body carries the revision and the state that won,
  // so the client REREADS instead of rewriting.
  const cur = await currentRow(env, planId);
  return Response.json(
    { ok: false, conflict: true, expected, rev: cur.rev, updatedAt: cur.updatedAt,
      updatedBy: cur.updatedBy, data: cur.data,
      why: changed === null ? "unknown-changes" : "rev-moved" },
    { status: 409 }
  );
};
