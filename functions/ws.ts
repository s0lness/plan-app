// WebSocket entry point, same origin as the app (so Access applies automatically on the
// household door). The Durable Object PlanRoom lives in the `plan-live` Worker; Pages accesses
// it via the ROOM binding (external namespace). We forward the upgrade, attaching identity to it.
//
// ---- THE "invite" DOOR (batch 1b, docs/decisions/0004-partage-par-lien.md) --------------------
// A browser cannot set headers on a WebSocket upgrade, so a guest cannot present the invite
// token the way `/api/plan` does (a request header). It presents the SESSION COOKIE instead,
// set by functions/api/invite.ts once the token has already been redeemed; this route resolves
// that cookie back to the invite row and refuses the upgrade outright (403) if it is missing,
// unknown, revoked or expired — no socket opens for an invalid invite, ever. `?p=` is ignored on
// this door (a guest editing the URL must not reach another plan): the plan id is FORCED from
// the invite row.
//
// Identity headers forwarded to the Durable Object are ALWAYS SET, never conditionally: a caller
// cannot forge `X-Plan-Guest` or `X-Plan-Name` by sending its own copy, because whatever it sent
// arrives on the INCOMING request and gets overwritten here, downstream of the one place that
// decided them. `X-Plan-Email` is empty for a guest (there is no email to have — never the
// literal "inconnu" either, that string means something else on the household door). Consuming
// these headers in the Durable Object (`live-worker/worker.ts`) is batch 2, not this one: this
// route only ever sets them.

import type { Env } from "./env.ts";
import { identiteFoyer, porteDe } from "./porte.ts";
import { chargerInvitation, invitationValide, tokenDuCookie } from "./invitation.ts";
import { cleanName } from "./nom.ts";

const PLAN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  if (request.headers.get("Upgrade") !== "websocket")
    return new Response("expected websocket", { status: 426 });

  const porte = porteDe(request, env);
  let planId: string | null;
  let email = "";
  let guest = false;
  let name = "";

  if (porte === "invite") {
    const invit = await chargerInvitation(env, tokenDuCookie(request));
    if (!invitationValide(invit)) return new Response("invite invalide", { status: 403 });
    planId = invit.plan_id;   // `?p=` IGNORED, forced from the invite row.
    guest = true;
    name = cleanName(invit.last_name, 40);
  } else {
    // Household door (and, defensively, anything else this route is reached from: `identiteFoyer`
    // already reads no header off a non-household door, so `email` naturally stays "inconnu" —
    // the middleware is what actually keeps an unrecognized host from reaching this far).
    email = identiteFoyer(request, porte);
    // WHICH plan: the URL's `?p=`, `main` by default. A malformed identifier is an ERROR and
    // never a fallback to `main`: editing the household's plan while believing to edit another
    // one would be worse than not connecting at all.
    const brut = new URL(request.url).searchParams.get("p");
    planId = (brut === null || brut === "") ? "main"
      : (PLAN_ID_RE.test(String(brut).trim().toLowerCase()) ? String(brut).trim().toLowerCase() : null);
  }
  if (!planId) return new Response("bad plan id", { status: 400 });

  const stub = env.ROOM.get(env.ROOM.idFromName(planId));
  const cible = new URL("/ws", request.url);
  cible.searchParams.set("p", planId);
  const fwd = new Request(cible.toString(), request);
  fwd.headers.set("X-Plan-Email", email);
  fwd.headers.set("X-Plan-Id", planId);
  fwd.headers.set("X-Plan-Guest", guest ? "1" : "0");
  fwd.headers.set("X-Plan-Name", name);
  return stub.fetch(fwd);
};
