// THE CHOKE POINT. Runs before every Pages Function, on every hostname the project serves:
// Functions are bound to the PROJECT, not to a hostname, so a convention each route "remembers"
// to call is deny-by-convention, and the next route added in six months would be open on an
// unrecognized host by default. See docs/decisions/0004-partage-par-lien.md ("batch 1a, hardening,
// no new surface", then "batch 1b, the invite").
//
// Three verdicts now exist (`porte.ts`): `"foyer"` (unchanged since batch 1a, full access),
// `"invite"` (no Access, no household identity, a valid invite token is the only credential),
// and `"inconnue"` (refused outright). The guest door reaches exactly three routes: the token
// exchange (`/api/invite`), the plan it names (`/api/plan`), and the realtime wire (`/ws`),
// because that is the entire guest product. Every other route under `/api/` (`/api/plans`,
// `/api/invites`, `/api/err`) stays 403 here, the same way `/api/plans` was already unreachable
// off the household door before this feature existed.
//
// `/api/invite` and `/api/plan` are only ALLOWED THROUGH by this middleware, never AUTHORIZED by
// it: neither route can be granted identity here, because a valid door does not mean a valid
// TOKEN, that decision needs a D1 read, which this choke point deliberately does not make (one
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
// `X-Plan-Internal` is never legitimate on ANY inbound request, on ANY door, it is set only by
// `functions/api/invites.ts`'s OWN outgoing call to the `ROOM` binding, a request built AFTER
// middleware already let the original DELETE through, which this file never sees. It is stripped
// here (the non-foyer doors) rather than on the foyer door too, so as not to disturb the foyer
// branch's own contract ("next() is called with NO argument": nothing about the request is
// rewritten there), the one place this header could otherwise be FORWARDED from an inbound
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

// ---------------------------------------------------------------------------------------------
// LINK PREVIEW CARD (Open Graph / Twitter). The invite token lives in the URL FRAGMENT (`#k=…`),
// which is never sent to a server: a link-preview crawler fetching an invite URL sees only the
// origin, never which plan it names. The card is therefore GENERIC BY CONSTRUCTION, `src/head.html`
// carries the static tags (title, description, type, image size), and none of them may become
// plan-specific without turning the fragment into a leak. Only `og:url` and the two image tags
// need an ABSOLUTE address, and an absolute address needs a host; this repository is public (no
// real hostname committed anywhere), so those three are the ONLY ones injected here, built from
// THIS REQUEST's own Host, correct on the household host, the guest host, and any future preview
// host, with nothing real ever landing in a commit.
//
// Gate is the response CONTENT TYPE, not the door and not the path: a JSON response from
// `/api/plan`, `/api/invite`, or anywhere else under `/api/` never contains `</head>` and is
// therefore returned completely untouched by `.startsWith("text/html")` failing first, this
// function does not need its own `/api/` exclusion to keep that promise, it falls out of the
// gate. Only a served `text/html` document (the one-file app shell) is rewritten, on any door
// that reaches `next()` at all; the door's own verdict (refuse vs. pass) is untouched above this.
const CARTE_OG_IMAGE = "apercu-lien.png"; // repo root, 1200x630, warm-paper palette, an INVENTED apartment, see AGENTS.md "Design".

async function avecCarteOg(reponse: Response, request: Request): Promise<Response> {
  const type = (reponse.headers.get("content-type") || "").toLowerCase();
  if (!type.startsWith("text/html")) return reponse;
  const texte = await reponse.text();
  const i = texte.indexOf("</head>");
  if (i === -1) return new Response(texte, { status: reponse.status, statusText: reponse.statusText, headers: reponse.headers });
  const url = new URL(request.url);
  const origine = `${url.protocol}//${url.host}`;
  const image = `${origine}/${CARTE_OG_IMAGE}`;
  const balises =
    `<meta property="og:url" content="${origine}/">\n` +
    `<meta property="og:image" content="${image}">\n` +
    `<meta name="twitter:image" content="${image}">\n`;
  const corps = texte.slice(0, i) + balises + texte.slice(i);
  const headers = new Headers(reponse.headers);
  headers.delete("content-length"); // the body just grew by the injected tags
  return new Response(corps, { status: reponse.status, statusText: reponse.statusText, headers });
}

export const onRequest: PagesFunction<Env> = async ({ request, next, env }) => {
  const porte = porteDe(request, env);
  if (porte === "foyer") return avecCarteOg(await next(), request);

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
    // unlocks, and the wire. `/api/plan` and `/ws` here are UNVALIDATED passes, the invite token
    // itself is checked downstream, by the route that can actually read D1 (`functions/api/plan.ts`
    // and `functions/ws.ts` both re-derive the plan from the session cookie).
    const surfaceInvite = chemin === "/api/invite" || chemin === "/api/plan" || surLeFil;
    if (chemin.startsWith("/api/") && !surfaceInvite) return refuse("porte_refusee");
    return avecCarteOg(await next(propre), request);
  }

  // "inconnue": exactly today's behaviour (batch 1a). There is no invite token to accept on this
  // door, so it gets nothing beyond static assets.
  if (chemin.startsWith("/api/") || surLeFil) return refuse("porte_inconnue");
  // Static assets (the app shell) still pass, with Access identity stripped.
  return avecCarteOg(await next(propre), request);
};
