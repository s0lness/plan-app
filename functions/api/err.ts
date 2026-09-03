// Crash reporter: the client POSTs uncaught JS errors, we keep them
// in D1 for remote diagnosis (behind Access, so restricted to the household).
//
// HOUSEHOLD DOOR ONLY, and this file says so itself rather than trusting the choke point.
// `functions/_middleware.ts` already keeps every other door away from `/api/err`, but every
// direct-import test in this codebase (tests/porte.ts, tests/repli-conflit.ts) calls a route file
// directly and bypasses the middleware entirely, a route that trusted it alone would be unguarded
// under test, and under any future caller that reaches it a different way. Same discipline as
// functions/api/invites.ts.

import type { Env } from "../env.ts";
import { identiteFoyer, porteDe } from "../porte.ts";
import { comptageRecent, PAR_HEURE_MAX } from "../debit.ts";

const json = (o: unknown, status?: number) => new Response(JSON.stringify(o),
  { status: status || 200, headers: { "content-type": "application/json" } });

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const porte = porteDe(request, env);
  if (porte !== "foyer") return json({ error: "porte_refusee" }, 403);
  const who = identiteFoyer(request, porte);

  let brut: unknown;
  try { brut = await request.json(); } catch { return new Response("bad", { status: 400 }); }
  const b = brut && typeof brut === "object" && !Array.isArray(brut)
    ? brut as Record<string, unknown> : {};
  const s = (v: unknown, n: number) => String(v ?? "").slice(0, n);

  // `functions/debit.ts`'s shared counter, not a copy: this is a route a page can drive in a LOOP
  // without anyone typing anything. An error inside a render path fires on every frame, and the
  // retention sweep below only bounds what is KEPT, never how many writes D1 is asked to do. Five
  // per hour and per author is enough to diagnose: a crash loop repeats the SAME error, so the
  // fifth copy says exactly what the five hundredth would. The handle is the author, not the IP,
  // because `errors` has no `ip` column (live-worker/schema.sql) and this door is the only one
  // that reaches here anyway.
  if (await comptageRecent(env, "errors", "who", who) >= PAR_HEURE_MAX) {
    return json({ error: "trop_d_erreurs", max: PAR_HEURE_MAX }, 429);
  }

  await env.DB
    .prepare("INSERT INTO errors(at,who,msg,src,stack,ua) VALUES(?1,?2,?3,?4,?5,?6)")
    .bind(new Date().toISOString(), who,
      s(b.msg, 500), s(b.src, 300), s(b.stack, 2000), s(b.ua, 300))
    .run();
  // keep the 200 most recent
  await env.DB.prepare("DELETE FROM errors WHERE id NOT IN (SELECT id FROM errors ORDER BY id DESC LIMIT 200)").run();
  return Response.json({ ok: true });
};
