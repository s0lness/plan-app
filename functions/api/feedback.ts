// THE FEEDBACK DROP: a free-text note from inside the app, no account. Reachable on BOTH doors —
// "foyer" (a household member) AND "invite" (a guest) — because the whole point is that a visitor
// looking at a shared link can report something too, not only someone Access already let in.
// `functions/_middleware.ts` is what actually lets an "invite" door request reach this path at all
// (a NAMED surface, see its own header comment); this file re-checks `porteDe()` itself anyway,
// the same belt-and-suspenders discipline every other route in this codebase uses
// (`functions/api/invites.ts`'s own header comment says it best): every direct-import test here
// (tests/retour.ts) calls this file directly and bypasses the middleware entirely.
//
// UNAUTHENTICATED WRITE FROM THE PUBLIC INTERNET: every field is bounded below, and each bound
// carries its own reason. Never fails the caller's submission because a BOOKKEEPING write (the
// retention sweep) failed — the row that matters has already landed by then.

import type { Env } from "../env.ts";
import { identiteFoyer, porteDe } from "../porte.ts";
import { cleanName, cleanTexte } from "../nom.ts";
import { chargerInvitation, invitationValide, tokenDuCookie } from "../invitation.ts";
import { PLAN_ID_RE } from "../plan-id.ts";

// A report, not a novel: 2000 characters comfortably fits "the wall snapped back when I let go of
// the handle" with room to spare, while still bounding what an unauthenticated caller can write.
const TEXTE_MAX = 2000;
// "How to reach you" is optional and short: an email address or a first name, never a paragraph.
const CONTACT_MAX = 200;
const UA_MAX = 300;
// Long enough for an IPv6 literal with room to spare; this column is bookkeeping, never displayed.
const IP_MAX = 64;

// RATE LIMIT: this write needs no Access identity on EITHER door, so the caller's IP is the only
// handle available at all. 5 per hour comfortably covers a real person filing a couple of
// distinct reports plus a retry after a flaky connection (this feature must never lose what
// someone typed, so a retry is expected), while still stopping a script from filling the table
// for free — a genuine household generates at most a handful of these a year.
export const FEEDBACK_PAR_HEURE_MAX = 5;
const HEURE_MS = 3_600_000;

/**
 * THE ONE RATE LIMIT IN THIS CODEBASE, and it is shared rather than copied: `functions/api/err.ts`
 * is the other unauthenticated-ish write that can be driven in a loop, and two hand-written copies
 * of a counting query drift the day one of them is tuned.
 *
 * `table` and `colonne` are a CLOSED UNION, never caller data: they are interpolated into the SQL
 * because a table or column name cannot be a bind parameter, and the type is what guarantees only
 * these four spellings ever reach it. Both tables carry `at` (ISO), which is what makes one
 * function fit both. WHICH handle is counted differs on purpose: `feedback` has an `ip` column and
 * needs no identity on either door, while `errors` has no `ip` column at all (live-worker/schema.sql)
 * and is reachable ONLY on the household door, so its author (`who`) is the handle available there.
 *
 * Returns how many rows that handle already wrote inside the window; the caller compares it to its
 * own cap. An empty handle counts as 0: refusing a caller we cannot even name would refuse
 * everyone at once.
 */
export async function comptageRecent(
  env: Env, table: "feedback" | "errors", colonne: "ip" | "who", valeur: string,
  fenetreMs: number = HEURE_MS,
): Promise<number> {
  if (!valeur) return 0;
  const depuis = new Date(Date.now() - fenetreMs).toISOString();
  const r = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${colonne}=?1 AND at>?2`)
    .bind(valeur, depuis).first<{ n: number }>();
  return (r && typeof r.n === "number") ? r.n : 0;
}

// RETENTION: same mechanism as functions/api/err.ts's own cap on `errors`. This table is a
// mailbox read periodically by hand, not a permanent log: keep only the newest 500 rows.
const FEEDBACK_GARDE_MAX = 500;

const json = (o: unknown, status?: number) => new Response(JSON.stringify(o),
  { status: status || 200, headers: { "content-type": "application/json" } });
const refuse = () => json({ error: "porte_refusee" }, 403);
// Same shape every other guest-facing route uses for "no usable session here" (functions/api/plan.ts,
// functions/ws.ts): telling "revoked" apart from "expired" apart from "unknown" would confirm a guess.
const inviteInvalide = () => json({ error: "invite_invalide" }, 403);

/** Same rule as functions/api/plan.ts's `planIdDe`: no `?p=` = the household's own plan (`main`
 *  by convention), a malformed one is an ERROR, never a silent fallback. */
const planIdDeLaRequete = (request: Request): string | null => {
  let brut: string | null = null;
  try { brut = new URL(request.url).searchParams.get("p"); } catch { return "main"; }
  if (brut === null || brut === "") return "main";
  const s = brut.trim().toLowerCase();
  return PLAN_ID_RE.test(s) ? s : null;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const porte = porteDe(request, env);
  if (porte !== "foyer" && porte !== "invite") return refuse();

  // WHO and WHICH PLAN are resolved from the door, never trusted from the request body — same
  // discipline as functions/api/plan.ts: a guest cannot claim another plan, and cannot claim to be
  // someone they are not.
  let planId: string;
  let who: string;
  if (porte === "invite") {
    const invit = await chargerInvitation(env, tokenDuCookie(request));
    if (!invitationValide(invit)) return inviteInvalide();
    planId = invit.plan_id;
    // The guest's ALREADY-KNOWN chosen name (set once, at the name step): never an email, there is
    // none to have. "" when nobody has ever declared one, never a guess.
    who = cleanName(invit.last_name, 40);
  } else {
    const pid = planIdDeLaRequete(request);
    if (!pid) return json({ error: "bad_plan_id" }, 400);
    planId = pid;
    who = identiteFoyer(request, porte);
  }

  let brut: unknown;
  try { brut = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
  const b = brut && typeof brut === "object" && !Array.isArray(brut)
    ? brut as Record<string, unknown> : {};

  // THE SAME CLEANER AS EVERY OTHER HUMAN-TYPED STRING IN THIS CODEBASE (functions/nom.ts):
  // control characters and Unicode bidi overrides stripped, truncated at the cap rather than
  // rejected outright — an over-long report is still a report.
  const texte = cleanTexte(b.texte, TEXTE_MAX);
  if (!texte) return json({ error: "texte_requis" }, 400);
  const contact = cleanName(b.contact, CONTACT_MAX);

  const ip = (request.headers.get("CF-Connecting-IP") || "").trim().slice(0, IP_MAX);
  if (await comptageRecent(env, "feedback", "ip", ip) >= FEEDBACK_PAR_HEURE_MAX) {
    return json({ error: "trop_de_retours", max: FEEDBACK_PAR_HEURE_MAX }, 429);
  }

  const ua = String((typeof b.ua === "string" && b.ua) || request.headers.get("user-agent") || "").slice(0, UA_MAX);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO feedback(at,who,porte,plan_id,texte,contact,ua,ip) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)"
  ).bind(now, who, porte, planId, texte, contact, ua, ip).run();

  // BEST-EFFORT bookkeeping (same reasoning as functions/api/err.ts's own sweep): the row that
  // matters has already landed above, so a failure here must never turn an accepted report into a
  // failed one from the caller's point of view.
  try {
    await env.DB.prepare(
      "DELETE FROM feedback WHERE id NOT IN (SELECT id FROM feedback ORDER BY id DESC LIMIT ?1)"
    ).bind(FEEDBACK_GARDE_MAX).run();
  } catch {}

  return json({ ok: true });
};
