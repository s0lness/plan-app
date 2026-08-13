// THE CHOKE POINT. Runs before every Pages Function, on every hostname the project serves:
// Functions are bound to the PROJECT, not to a hostname, so a convention each route "remembers"
// to call is deny-by-convention, and the next route added in six months would be open on an
// unrecognized host by default. See docs/decisions/0004-partage-par-lien.md ("batch 1a, hardening,
// no new surface", then "batch 1b, the invite").
//
// Three verdicts now exist (`porte.ts`): `"foyer"` (unchanged since batch 1a, full access),
// `"invite"` (no Access, no household identity — a valid invite token is the only credential),
// and `"inconnue"` (refused outright). The guest door reaches exactly four routes: the token
// exchange (`/api/invite`), the plan it names (`/api/plan`), the realtime wire (`/ws`), and the
// feedback drop (`/api/feedback`, "retour-utilisateur": a visitor can flag something too) —
// because that is the entire guest product. Every other route under `/api/` (`/api/plans`,
// `/api/invites`, `/api/err`) stays 403 here, the same way `/api/plans` was already unreachable
// off the household door before this feature existed.
//
// `/api/invite` and `/api/plan` are only ALLOWED THROUGH by this middleware, never AUTHORIZED by
// it: neither route can be granted identity here, because a valid door does not mean a valid
// TOKEN — that decision needs a D1 read, which this choke point deliberately does not make (one
// extra query on every static-asset request would be a bad trade). `functions/api/invite.ts`
// re-validates the token itself, and `functions/api/plan.ts` / `functions/ws.ts` both re-derive
// the plan from the session cookie, exactly the way `functions/api/invites.ts` re-checks the
// household door itself rather than trusting that only `"foyer"` requests ever reach it: every
// direct-import test in this codebase (tests/repli-conflit.ts, tests/plan-abime.ts, this batch's
// tests/invitation.ts) calls a route file directly and bypasses this middleware entirely, so a
// route that trusted the choke point alone would be unguarded under test.

import { porteDe } from "./porte.ts";
import type { Env } from "./env.ts";

// Rebuilds the request with every `Cf-Access-*` header, the `CF_Authorization` cookie, AND the
// `/revoke` internal marker (`X-Plan-Internal`, see `live-worker/worker.ts`) removed, BEFORE
// anything downstream can read them. `identiteFoyer` already refuses to trust the Access ones off
// the household door, but this strips them at the source so a future handler that reads
// `request.headers` directly (bypassing `identiteFoyer`) finds nothing believable either.
//
// `X-Plan-Internal` is never legitimate on ANY inbound request, on ANY door — it is set only by
// `functions/api/invites.ts`'s OWN outgoing call to the `ROOM` binding, a request built AFTER
// middleware already let the original DELETE through, which this file never sees. It is stripped
// here (the non-foyer doors) rather than on the foyer door too, so as not to disturb the foyer
// branch's own contract ("next() is called with NO argument": nothing about the request is
// rewritten there) — the one place this header could otherwise be FORWARDED from an inbound
// request is `functions/ws.ts`, which deletes it explicitly for the same reason.
const sansAccess = (request: Request): Request => {
  const headers = new Headers();
  for (const [nom, valeur] of request.headers) {
    if (nom.startsWith("cf-access-") || nom === "x-plan-internal") continue;
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

const refuse = (erreur: string) => new Response(JSON.stringify({ error: erreur }), {
  status: 403,
  headers: { "content-type": "application/json" },
});

export const onRequest: PagesFunction<Env> = async ({ request, next, env }) => {
  const porte = porteDe(request, env);
  if (porte === "foyer") return next();

  const propre = sansAccess(request);
  const chemin = new URL(request.url).pathname;
  // `/ws` IS CHECKED HERE TOO, and it is not an afterthought. `/ws` is served by Pages
  // (`functions/ws.ts` forwards the upgrade to the Durable Object through the `ROOM` binding), so
  // it arrives right here like every other route. Without this it would forward the upgrade for
  // `?p=main` with the identity merely downgraded to `inconnu`, and stripping headers is not
  // enough: a socket with no name is still a socket ON THE HOUSEHOLD PLAN, able to read it and
  // write ops into it.
  // (`live-worker/DEPLOY.md` §2 describes a zone route that would send `/ws*` straight to the
  // Worker and bypass this file. It was never applied: see decision 0004. If it ever is, this
  // check stops covering the household host, and the copy in `worker.ts` becomes the only one.)
  const surLeFil = chemin === "/ws" || chemin.startsWith("/ws/");

  if (porte === "invite") {
    // A NAMED surface, not "everything except the owner routes": the token exchange, the plan it
    // unlocks, the wire, and the feedback drop. `/api/plan`, `/api/feedback` and `/ws` here are
    // UNVALIDATED passes — the invite token itself is checked downstream, by the route that can
    // actually read D1 (`functions/api/feedback.ts` re-derives the plan from the session cookie,
    // exactly like `/api/plan` and `/ws` already do).
    const surfaceInvite = chemin === "/api/invite" || chemin === "/api/plan" ||
      chemin === "/api/feedback" || surLeFil;
    if (chemin.startsWith("/api/") && !surfaceInvite) return refuse("porte_refusee");
    return next(propre);
  }

  // "inconnue": exactly today's behaviour (batch 1a). There is no invite token to accept on this
  // door, so it gets nothing beyond static assets.
  if (chemin.startsWith("/api/") || surLeFil) return refuse("porte_inconnue");
  // Static assets (the app shell) still pass, with Access identity stripped.
  return next(propre);
};
