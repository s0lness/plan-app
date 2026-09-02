// List, creation and renaming of PLANS. Behind Cloudflare Access, like everything else.
//
// A PLAN'S NAME IS NOT IN THE PLAN, and that's the central choice of this file. It lives in its
// own D1 column (`name`), not in the JSON document. Three reasons, in order of importance:
//
//  1. The document goes through the Durable Object, which REWRITES it (`sanitizeState` keeps only
//     known keys). A `planName` slipped in there would be erased on the first snapshot, silently.
//  2. The name is metadata ABOUT the plan, not part of its geometry. Putting it in the document
//     would make it enter the content fingerprint, so renaming a plan would count as a change to
//     sync, whereas it isn't one for the drawing.
//  3. Listing plans must be CHEAP: `SELECT id, name` doesn't read each document's 12 KB, where a
//     `json_extract` on the blob would read them all.
//
// The column is added by `ALTER TABLE plans ADD COLUMN name TEXT` (additive: no existing row is
// touched, `main` simply ends up with `name = NULL` and falls back to its id).

import { PLAN_ID_RE } from "../plan-id.ts";

const NAME_MAX = 60;
const MAX_PLANS = 40;   // safety guard: this is not a plan-hosting service

interface PlanRow {
  id: string;
  name: string | null;
  rev: number;
  updated_at: string;
  updated_by: string;
  bytes: number;
}

import type { Env } from "../env.ts";
import { identiteFoyer, porteDe } from "../porte.ts";
import { cleanName as nettoieNom } from "../nom.ts";

const json = (o: unknown, status?: number) => new Response(JSON.stringify(o),
  { status: status || 200, headers: { "content-type": "application/json" } });

// HOUSEHOLD DOOR ONLY, whatever the method, and stated here rather than borrowed from the choke
// point: listing, creating, renaming and DELETING plans is owner work. `functions/_middleware.ts`
// already refuses every other door on this path; this is the copy that survives a direct import
// (every route test in this codebase is one) and any future caller that arrives another way. Same
// rule, same wording, as functions/api/invites.ts.
const refuse = () => json({ error: "porte_refusee" }, 403);
const horsFoyer = (request: Request, env: Env): boolean => porteDe(request, env) !== "foyer";

/** Clean name: no control characters, no bidi overrides, no edge whitespace, truncated at
 * NAME_MAX. "" = no name. Now THE SAME implementation a guest's self-declared name goes through
 * (functions/nom.ts), a plan name sits on the same screen as a guest name, so it gets the same
 * bidi-override stripping (docs/decisions/0004-partage-par-lien.md, edge case 2), just with the
 * historical 60-character cap instead of a guest's 40. */
const cleanName = (v: unknown) => nettoieNom(v, NAME_MAX);

/**
 * An identifier DERIVED from the name, but never EQUAL to the name: the name is free (accents,
 * spaces, emoji), the identifier is a D1 row key AND a Durable Object name. Numeric suffix on
 * collision, because two plans can legitimately share the same name.
 */
const idDepuisNom = (nom: string, pris: Set<string>) => {
  const base = (nom || "plan").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "plan";
  let id = /^[a-z0-9]/.test(base) ? base : "p-" + base;
  if (!pris.has(id)) return id;
  for (let i = 2; i < 500; i++) {
    const c = (id + "-" + i).slice(0, 40);
    if (!pris.has(c)) return c;
  }
  return null;
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (horsFoyer(request, env)) return refuse();
  const r = await env.DB
    .prepare("SELECT id, name, rev, updated_at, updated_by, length(data) AS bytes FROM plans ORDER BY id")
    .all<PlanRow>();
  const plans = (r.results || []).map((row) => ({
    id: row.id,
    name: row.name || row.id,
    rev: row.rev,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    bytes: row.bytes,
  }));
  return json({ plans });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (horsFoyer(request, env)) return refuse();
  let brut: unknown;
  try { brut = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
  const body = brut && typeof brut === "object" && !Array.isArray(brut)
    ? brut as Record<string, unknown> : {};
  const nom = cleanName(body.name);
  if (!nom) return json({ error: "name_required" }, 400);

  const existants = await env.DB.prepare("SELECT id FROM plans").all<{ id: string }>();
  const pris = new Set((existants.results || []).map((r) => r.id));
  if (pris.size >= MAX_PLANS) return json({ error: "too_many_plans", max: MAX_PLANS }, 409);

  // An EXPLICIT identifier is accepted if valid and free; otherwise we derive it from the name.
  let id = body && body.id !== undefined ? String(body.id).trim().toLowerCase() : "";
  if (id) {
    if (!PLAN_ID_RE.test(id)) return json({ error: "bad_plan_id" }, 400);
    if (pris.has(id)) return json({ error: "plan_exists", id }, 409);
  } else {
    id = idDepuisNom(nom, pris);
    if (!id) return json({ error: "cannot_derive_id" }, 409);
  }

  // A NEW PLAN IS BORN EMPTY, NOT COPIED. Nothing is in `data` until someone has laid something
  // down: the client will see "no plan" and open its outline assistant, exactly as on first
  // startup. Copying the current plan would be a DIFFERENT gesture ("duplicate"), and confusing
  // it with "new" would start from an apartment that isn't the one meant to be drawn.
  //
  // WHY THE JSON LITERAL AND NOT AN SQL NULL. "No plan" wants to be an SQL NULL, and cannot be
  // one: `plans.data` is `TEXT NOT NULL` in production (live-worker/schema.sql, an exact
  // reproduction of the live definitions), so binding `null` here raises
  // "NOT NULL constraint failed: plans.data" and creating a plan fails outright. Dropping that
  // constraint means rebuilding the table on the live database, which belongs with the schema
  // file, not with this route. So "no plan" is encoded IN the column, as the one text every
  // reader already parses back to nothing: `functions/api/plan.ts`'s GET answers `{data:null}`
  // for it (and for an SQL NULL, the day there is one), and the Durable Object's cold load must
  // read it as an empty plan rather than an unreadable one.
  const PLAN_VIDE = "null";
  const now = new Date().toISOString();
  await env.DB
    .prepare("INSERT INTO plans(id,name,data,rev,updated_at,updated_by) VALUES(?1,?2,?3,0,?4,?5)")
    .bind(id, nom, PLAN_VIDE, now, identiteFoyer(request, porteDe(request, env)))
    .run();
  return json({ ok: true, id, name: nom });
};

export const onRequestPatch: PagesFunction<Env> = async ({ request, env }) => {
  if (horsFoyer(request, env)) return refuse();
  let brut: unknown;
  try { brut = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
  const body = brut && typeof brut === "object" && !Array.isArray(brut)
    ? brut as Record<string, unknown> : {};
  const id = String(body.id || "").trim().toLowerCase();
  if (!PLAN_ID_RE.test(id)) return json({ error: "bad_plan_id" }, 400);
  const nom = cleanName(body && body.name);
  if (!nom) return json({ error: "name_required" }, 400);
  // RENAMING DOES NOT TOUCH `data` OR `rev`: this is not a change to the drawing, so it must not
  // trigger any resynchronization for the peers.
  const res = await env.DB.prepare("UPDATE plans SET name=?2 WHERE id=?1").bind(id, nom).run();
  const touche = (res && res.meta && typeof res.meta.changes === "number") ? res.meta.changes : 0;
  if (!touche) return json({ error: "plan_not_found", id }, 404);
  return json({ ok: true, id, name: nom });
};

export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  if (horsFoyer(request, env)) return refuse();
  let brut: unknown;
  try { brut = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
  const body = brut && typeof brut === "object" && !Array.isArray(brut)
    ? brut as Record<string, unknown> : {};
  const id = String(body.id || "").trim().toLowerCase();
  if (!PLAN_ID_RE.test(id)) return json({ error: "bad_plan_id" }, 400);
  // `main` IS THE HOUSEHOLD'S PLAN: it cannot be deleted from the interface. A button that can
  // erase the plan of the apartment one lives in has no place next to a selector.
  if (id === "main") return json({ error: "main_is_protected" }, 403);
  const res = await env.DB.prepare("DELETE FROM plans WHERE id=?1").bind(id).run();
  const touche = (res && res.meta && typeof res.meta.changes === "number") ? res.meta.changes : 0;
  if (!touche) return json({ error: "plan_not_found", id }, 404);
  // DELETING THE ROW IS NOT DELETING THE PLAN. The Durable Object holds the live copy AND keeps
  // snapshotting it back into D1 on its alarm: without this call, a deleted plan reappears at the
  // next snapshot, and whoever was connected keeps editing a plan that no longer exists, live,
  // with no way to be told. `/purge` closes those sockets (4004 `plan_deleted`) and wipes the
  // object's storage so nothing is ever written back.
  //
  // BEST-EFFORT, exactly like `/revoke` in functions/api/invites.ts: the row is gone either way,
  // so a Worker hiccup must never turn a successful deletion into an error. What the caller gets
  // instead is `live:false`, which says the live copy could not be reached, and `closed` when it
  // could (how many sockets were shown the door).
  let live = false;
  let closed = 0;
  if (env.ROOM) {
    try {
      const stub = env.ROOM.get(env.ROOM.idFromName(id));
      const r = await stub.fetch(new Request("https://plan-live-internal/purge", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Plan-Internal": "1" },
        body: JSON.stringify({ id }),
      }));
      // A 500 from the object is NOT a purge: reading `closed` off it would report work that was
      // never done. Only a 2xx counts, and only then is `live` true.
      if (r && r.ok) {
        live = true;
        let corps: { closed?: number } | null = null;
        try { corps = await r.json<{ closed?: number }>(); } catch { corps = null; }
        closed = (corps && typeof corps.closed === "number") ? corps.closed : 0;
      }
    } catch { /* best-effort, see above */ }
  }
  return json({ ok: true, id, live, closed });
};
