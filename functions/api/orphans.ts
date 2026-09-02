// THE VERSIONS THE LIVE PLAN SET ASIDE. HOUSEHOLD DOOR ONLY.
//
// When a write made outside real time cannot be merged, the Durable Object keeps ITS version and
// announces a `conflict` to the client. The bytes it discarded are not thrown away: it holds the
// last few of them. Until this route existed there was no way to ask for them, and the client's
// own banner said "They are held on the server" — true, and useless, because nothing could reach
// them. This is the reach.
//
// FOYER ONLY, and refused here rather than only in `functions/_middleware.ts`, exactly like every
// other owner route (functions/api/invites.ts, functions/api/plans.ts): a discarded version is a
// piece of the household's plan, and a guest holding a link has no business reading a state the
// household never published. Every direct-import test in this codebase bypasses the middleware,
// which is what makes a route that trusted it alone unguarded under test.
//
// A RELAY, NOT A SECOND STORE. The Durable Object is the only holder; this route forwards
// `GET /orphans` to it through the `ROOM` binding and hands the answer back unchanged. If the
// object cannot be reached, the answer is an EMPTY list with `live:false`, never an error: the
// client asks this while it is already showing a conflict banner, and a second failure there must
// say "nothing to offer", not turn into a crash on top of a conflict.

import type { Env } from "../env.ts";
import { porteDe } from "../porte.ts";

const PLAN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const json = (o: unknown, status?: number) => new Response(JSON.stringify(o),
  { status: status || 200, headers: { "content-type": "application/json" } });

interface Orphelin { at?: string; by?: string; rev?: number; data?: unknown }

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (porteDe(request, env) !== "foyer") return json({ error: "porte_refusee" }, 403);

  // Same rule as every other route that takes a `?p=`: absent means the household's own plan,
  // malformed is an ERROR and never a silent fallback onto `main`.
  let brut: string | null = null;
  try { brut = new URL(request.url).searchParams.get("p"); } catch { brut = null; }
  const planId = (brut === null || brut === "") ? "main" : brut.trim().toLowerCase();
  if (!PLAN_ID_RE.test(planId)) return json({ error: "bad_plan_id" }, 400);

  if (!env.ROOM) return json({ orphans: [], live: false });
  try {
    const stub = env.ROOM.get(env.ROOM.idFromName(planId));
    const r = await stub.fetch(new Request("https://plan-live-internal/orphans", {
      method: "GET",
      headers: { "X-Plan-Internal": "1" },
    }));
    if (!r || !r.ok) return json({ orphans: [], live: false });
    const corps = await r.json<{ orphans?: Orphelin[] }>();
    const liste = (corps && Array.isArray(corps.orphans)) ? corps.orphans : [];
    return json({ orphans: liste, live: true });
  } catch {
    return json({ orphans: [], live: false });
  }
};
