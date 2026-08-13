// THE CHOKE POINT. Runs before every Pages Function, on every hostname the project serves:
// Functions are bound to the PROJECT, not to a hostname, so a convention each route "remembers"
// to call is deny-by-convention, and the next route added in six months would be open on an
// unrecognized host by default. See docs/decisions/0004-partage-par-lien.md ("batch 1a").
//
// Batch 1a adds no guest surface: only two verdicts exist today (`porte.ts`), "foyer" and
// "inconnue". There is no invite token to accept here yet, so "inconnue" gets nothing beyond
// static assets.

import { porteDe } from "./porte.ts";
import type { Env } from "./env.ts";

// Rebuilds the request with every `Cf-Access-*` header and the `CF_Authorization` cookie
// removed, BEFORE anything downstream can read them. `identiteFoyer` already refuses to trust
// these off the household door, but this strips them at the source so a future handler that
// reads `request.headers` directly (bypassing `identiteFoyer`) finds nothing believable either.
const sansAccess = (request: Request): Request => {
  const headers = new Headers();
  for (const [nom, valeur] of request.headers) {
    if (nom.startsWith("cf-access-")) continue;
    if (nom === "cookie") {
      const reste = valeur.split(";").map((p) => p.trim())
        .filter((p) => p && !/^CF_Authorization=/.test(p));
      if (reste.length) headers.set("cookie", reste.join("; "));
      continue;
    }
    headers.append(nom, valeur);
  }
  return new Request(request, { headers });
};

export const onRequest: PagesFunction<Env> = async ({ request, next, env }) => {
  const porte = porteDe(request, env);
  if (porte === "foyer") return next();

  const propre = sansAccess(request);
  const chemin = new URL(request.url).pathname;
  // `/ws` IS REFUSED HERE TOO, and it is not an afterthought. On the household host a zone route
  // sends `/ws*` straight to the `plan-live` Worker, so this middleware never sees it; on any
  // OTHER host there is no such route, so `/ws` arrives right here, and `functions/ws.ts` would
  // happily forward the upgrade to the Durable Object for `?p=main` with the identity merely
  // downgraded to `inconnu`. Stripping the headers is not enough: a socket with no name is still
  // a socket ON THE HOUSEHOLD PLAN, able to read it and write ops into it. Until an invite token
  // exists to authorize one (batch 1b), an unrecognized host gets no wire at all.
  if (chemin.startsWith("/api/") || chemin === "/ws" || chemin.startsWith("/ws/")) {
    return new Response(JSON.stringify({ error: "porte_inconnue" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  // Static assets (the app shell) still pass, with Access identity stripped.
  return next(propre);
};
