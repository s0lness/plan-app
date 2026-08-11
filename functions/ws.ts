// WebSocket entry point, same origin as the app (so Access applies automatically).
// The Durable Object PlanRoom lives in the `plan-live` Worker; Pages accesses it via the
// ROOM binding (external namespace). We forward the upgrade, attaching the identity to it.

import type { Env } from "./env.ts";

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  if (request.headers.get("Upgrade") !== "websocket")
    return new Response("expected websocket", { status: 426 });
  const email = request.headers.get("Cf-Access-Authenticated-User-Email") || "inconnu";
  // WHICH plan: the URL's `?p=`, `main` by default. A malformed identifier is an ERROR and
  // never a fallback to `main`: editing the household's plan while believing to edit another
  // one would be worse than not connecting at all.
  const brut = new URL(request.url).searchParams.get("p");
  const planId = (brut === null || brut === "") ? "main"
    : (/^[a-z0-9][a-z0-9_-]{0,39}$/.test(String(brut).trim().toLowerCase()) ? String(brut).trim().toLowerCase() : null);
  if (!planId) return new Response("bad plan id", { status: 400 });
  const stub = env.ROOM.get(env.ROOM.idFromName(planId));
  const cible = new URL("/ws", request.url);
  cible.searchParams.set("p", planId);
  const fwd = new Request(cible.toString(), request);
  fwd.headers.set("X-Plan-Email", email);
  fwd.headers.set("X-Plan-Id", planId);
  return stub.fetch(fwd);
};
