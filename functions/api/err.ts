// Crash reporter: the client POSTs uncaught JS errors, we keep them
// in D1 for remote diagnosis (behind Access, so restricted to the household).

import type { Env } from "../env.ts";
import { identiteFoyer, porteDe } from "../porte.ts";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let brut: unknown;
  try { brut = await request.json(); } catch { return new Response("bad", { status: 400 }); }
  const b = brut && typeof brut === "object" && !Array.isArray(brut)
    ? brut as Record<string, unknown> : {};
  const s = (v: unknown, n: number) => String(v ?? "").slice(0, n);
  await env.DB
    .prepare("INSERT INTO errors(at,who,msg,src,stack,ua) VALUES(?1,?2,?3,?4,?5,?6)")
    .bind(new Date().toISOString(), identiteFoyer(request, porteDe(request, env)),
      s(b.msg, 500), s(b.src, 300), s(b.stack, 2000), s(b.ua, 300))
    .run();
  // keep the 200 most recent
  await env.DB.prepare("DELETE FROM errors WHERE id NOT IN (SELECT id FROM errors ORDER BY id DESC LIMIT 200)").run();
  return Response.json({ ok: true });
};
