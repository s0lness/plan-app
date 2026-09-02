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
// these headers in the Durable Object (`live-worker/worker.ts`) is batch 2, DONE: `PlanRoom.fetch`
// reads all five via `attachmentFromRequest`.
//
// `X-Plan-Guest-Id` identifies a guest's OWN second tab (batch 2, item 1): a client-supplied `?g=`
// query param, cleaned to a narrow shape, empty otherwise. It is NOT a credential and grants
// nothing — the invite token (the cookie) is what grants entry; this only lets `wsSameAccount`
// tell "my other tab" apart from "a different guest" on the client (see `src/ts/fil/etat.ts`).
// `X-Plan-Token` is the invite token itself: what `/revoke` matches sockets against, and what the
// DO's per-token rate cap is keyed on (design edges 6, 15) — always empty on the household door.
// `X-Plan-Expires` is when this guest's link stops being valid (ISO 8601, empty for the household
// and for a row with no expiry). The door checks validity ONCE, at upgrade: without handing the
// deadline over, an already-open socket outlived its own link, and expiry only ever stopped NEW
// connections. Consuming it is the Durable Object's job (`live-worker/`, batch B1), for the same
// reason `/revoke` had to exist: it is the only side still holding the socket.

import type { Env } from "./env.ts";
import { identiteFoyer, porteDe } from "./porte.ts";
import { chargerInvitation, invitationValide, tokenDuCookie } from "./invitation.ts";
import { cleanName } from "./nom.ts";
import { PLAN_ID_RE } from "./plan-id.ts";

// Same shape as the DO's own re-check (`live-worker/worker.ts`, `GUEST_ID_RE`): letters, digits,
// `_`/`-`, 1 to 64 of them. Not a credential, so no cryptographic requirement — just narrow enough
// that it can never carry anything but itself.
const GUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  if (request.headers.get("Upgrade") !== "websocket")
    return new Response("expected websocket", { status: 426 });

  const porte = porteDe(request, env);
  // AN UNRECOGNIZED DOOR GETS NO SOCKET, and this route says so itself. The comment on the
  // household branch below used to call the "anything else" case defensive, and it was not: an
  // unlisted host fell straight into it, `?p=` was honoured, and the upgrade was forwarded to the
  // household's own Durable Object with the identity merely downgraded to `inconnu`. A socket with
  // no name is still a socket ON THE HOUSEHOLD PLAN, able to read it and write ops into it.
  // `functions/_middleware.ts` carries the same check and states, in its own comment, that a zone
  // route sending `/ws*` straight to the Worker would bypass it: this copy is what survives that.
  if (porte !== "foyer" && porte !== "invite")
    return new Response(JSON.stringify({ error: "porte_refusee" }),
      { status: 403, headers: { "content-type": "application/json" } });
  let planId: string | null;
  let email = "";
  let guest = false;
  let name = "";
  let guestId = "";
  let token = "";
  // WHEN THIS SOCKET STOPS BEING ALLOWED. The door checks `invitationValide()` at UPGRADE time and
  // never again, so a link that expires at 18:00 leaves an already-open socket editing the plan
  // for as long as it stays connected: expiry only stopped NEW connections, exactly the hole that
  // `/revoke` had to close for revocation (design edge 6). The Durable Object is the only place
  // that can act on it, because it is the only one still holding the socket, so the deadline is
  // handed to it here. ISO 8601 as stored, empty when the row has no expiry at all and on the
  // household door, where nothing expires.
  let expires = "";

  if (porte === "invite") {
    const invit = await chargerInvitation(env, tokenDuCookie(request));
    if (!invitationValide(invit)) return new Response("invite invalide", { status: 403 });
    planId = invit.plan_id;   // `?p=` IGNORED, forced from the invite row.
    guest = true;
    token = invit.token;
    expires = invit.expires_at || "";
    const gBrut = (new URL(request.url).searchParams.get("g") || "").trim();
    if (GUEST_ID_RE.test(gBrut)) guestId = gBrut;
    // THE SAME DEVICE-MATCH RULE AS THE REDEMPTION ENDPOINT (`functions/api/invite.ts`), and for
    // the SAME reason: `invites.last_name` is ONE row shared by everyone holding the link, not a
    // per-socket identity. Reading it unconditionally here was the OTHER half of the defect that
    // endpoint's own fix closed — worse, in fact, live: every client re-sends its own locally
    // stored name on each redemption (overwriting `last_name`), so BOTH sockets on a shared link
    // read back whichever name landed there last, and BOTH peer dots showed the same person. A
    // guest whose `guestId` does not own the row connects with an EMPTY name instead of a
    // borrowed one; the Durable Object already refuses every op with `guest_unnamed` for an empty
    // name (`live-worker/worker.ts`), which is correct and untouched here — what changes is that
    // "empty" now means "not yet named on the wire", never "wearing someone else's name".
    name = (guestId && invit.last_guest_id && guestId === invit.last_guest_id)
      ? cleanName(invit.last_name, 40) : "";
  } else {
    // Household door, and only it: every other verdict was turned away above.
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
  fwd.headers.set("X-Plan-Guest-Id", guestId);
  fwd.headers.set("X-Plan-Token", token);
  fwd.headers.set("X-Plan-Expires", expires);
  // Never legitimate on a `/ws` upgrade: strip whatever the caller sent, defence in depth on top
  // of `functions/_middleware.ts` already stripping it (see `live-worker/worker.ts`,
  // `INTERNAL_HEADER`). `new Request(url, request)` above copies every header of the original
  // request, this one included.
  fwd.headers.delete("X-Plan-Internal");
  return stub.fetch(fwd);
};
