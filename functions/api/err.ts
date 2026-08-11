// Crash reporter: the client POSTs uncaught JS errors, we keep them
// in D1 for remote diagnosis (behind Access, so restricted to the household).

import type { Env } from "../env.ts";

const who = (request: Request) => {
  const direct = request.headers.get("Cf-Access-Authenticated-User-Email");
  if (direct) return direct;
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion") ||
    (request.headers.get("Cookie") || "").match(/CF_Authorization=([^;]+)/)?.[1];
  if (jwt) {
    try {
      const p = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      if (p.email) return p.email;
    } catch {}
  }
  return "inconnu";
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let brut: unknown;
  try { brut = await request.json(); } catch { return new Response("bad", { status: 400 }); }
  const b = brut && typeof brut === "object" && !Array.isArray(brut)
    ? brut as Record<string, unknown> : {};
  const s = (v: unknown, n: number) => String(v ?? "").slice(0, n);
  await env.DB
    .prepare("INSERT INTO errors(at,who,msg,src,stack,ua) VALUES(?1,?2,?3,?4,?5,?6)")
    .bind(new Date().toISOString(), who(request), s(b.msg, 500), s(b.src, 300), s(b.stack, 2000), s(b.ua, 300))
    .run();
  // keep the 200 most recent
  await env.DB.prepare("DELETE FROM errors WHERE id NOT IN (SELECT id FROM errors ORDER BY id DESC LIMIT 200)").run();
  return Response.json({ ok: true });
};
