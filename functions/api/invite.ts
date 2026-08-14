// THE GUEST-FACING EXCHANGE: a fragment token becomes a session. Reachable ONLY on the "invite"
// door (docs/decisions/0004-partage-par-lien.md, "batch 1b, the invite").
//
// A browser cannot set headers on a WebSocket upgrade, so without this exchange the capability
// carried in the link's `#k=` fragment would have to travel as `?k=` on `/ws`, landing in edge
// logs on every reconnect. This route trades the one-time capability for a session: an
// `HttpOnly`, `Secure`, `SameSite=Strict` cookie. `HttpOnly` means a stored XSS elsewhere on the
// guest door cannot read it back (design edge 1: the guest name is the first untrusted string
// this codebase renders, so that risk is real). `SameSite=Strict` is the CSRF guard, because the
// cookie is now an AMBIENT credential sent on every request to this origin, unlike the fragment
// that only the client ever saw.
//
// ONE 404, whatever fails: an unknown token, a revoked one, and an expired one all answer the
// SAME body. Telling them apart would let a probe learn that a guessed token is real but merely
// expired — see functions/api/plan.ts and functions/ws.ts, which read the SAME cookie later and
// answer with the same shape of refusal for the same reason.

import type { Env } from "../env.ts";
import { porteDe } from "../porte.ts";
import { cleanName } from "../nom.ts";
import { chargerInvitation, dureeCookieSecondes, INVITE_COOKIE, invitationValide } from "../invitation.ts";

const GUEST_NAME_MAX = 40;
// Same shape as `src/ts/fil/identite.ts`'s `guestIdCourant()` (what generates it) and
// `functions/ws.ts` / `live-worker/worker.ts`'s own copies (what re-checks it on the socket):
// not a credential, so no cryptographic requirement, just narrow enough to carry nothing but
// itself. Kept a fourth local copy rather than a shared import: `live-worker/worker.ts` cannot
// import from `functions/`, and the other three already each state "same shape as" rather than share code.
const GUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const refuse = () => new Response(JSON.stringify({ error: "porte_refusee" }),
  { status: 403, headers: { "content-type": "application/json" } });
const deadEnd = () => new Response(JSON.stringify({ error: "invite_invalide" }),
  { status: 404, headers: { "content-type": "application/json" } });

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // Allowed ONLY on the invite door: a household member hitting this route (curl, or their own
  // account habits) gets refused rather than silently redeeming a token meant for a stranger.
  if (porteDe(request, env) !== "invite") return refuse();

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return deadEnd(); }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return deadEnd();

  const row = await chargerInvitation(env, token);
  if (!invitationValide(row)) return deadEnd();

  // The plan can be deleted while a link stays live (edge case 10): same dead end as revocation,
  // never a different message that would tell the two failures apart.
  const plan = await env.DB.prepare("SELECT name FROM plans WHERE id=?1")
    .bind(row.plan_id).first<{ name: string | null }>();
  if (!plan) return deadEnd();

  // The name lives in the invite row, not in local storage (edge case 20): iOS in-app browsers
  // partition and discard storage, exactly where a shared link is most likely to be opened. But
  // the row remembers only ONE (name, device) pair, and the token is a LINK-scoped capability, not
  // a device-scoped one: sending the name back to whoever redeems the token next, with no check on
  // who is asking, handed a second person the first person's identity. Confirmed in production:
  // one row carrying `last_name` and 5 `uses`, one name shown on two different people's screens.
  // `guestId` is the fix: the SAME durable per-browser-profile id already on the wire
  // (`src/ts/fil/identite.ts`'s `guestIdCourant()`), stored beside the name as `last_guest_id`. The
  // remembered name is only ever handed back to the device it was recorded for.
  const nomEnvoye = cleanName(body.name, GUEST_NAME_MAX);
  const guestIdBrut = typeof body.guestId === "string" ? body.guestId : "";
  const guestId = GUEST_ID_RE.test(guestIdBrut) ? guestIdBrut : "";
  // NOT a credential: it grants nothing by itself (the token above already did the granting), so
  // an absent or malformed id simply means "cannot be recognized as a returning device", never a
  // refusal. Validated all the same, because it is about to sit in a stored column.
  const nomRendu = nomEnvoye || ((guestId && row.last_guest_id && guestId === row.last_guest_id) ? row.last_name : null);

  // BEST-EFFORT bookkeeping: a write failure here must never turn an already-valid invite into a
  // refused one — the guest earned entry above, on the row as it stood before this update.
  // A REDEMPTION WITH NO NAME (the first call of every visit, before the name step even shows)
  // must never touch `last_name`/`last_guest_id`: that is what lets a SECOND device's silent probe
  // (checking whether a name is already on file) coexist with a FIRST device's remembered identity,
  // without one overwriting the other. Only a call that CARRIES a name claims the row.
  try {
    if (nomEnvoye) {
      await env.DB.prepare("UPDATE invites SET uses=uses+1, last_used_at=?2, last_name=?3, last_guest_id=?4 WHERE token=?1")
        .bind(token, new Date().toISOString(), nomEnvoye, guestId || null).run();
    } else {
      await env.DB.prepare("UPDATE invites SET uses=uses+1, last_used_at=?2 WHERE token=?1")
        .bind(token, new Date().toISOString()).run();
    }
  } catch {}

  const maxAge = dureeCookieSecondes(row.expires_at);
  const cookie = `${INVITE_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

  return new Response(JSON.stringify({
    planId: row.plan_id,
    planName: plan.name || row.plan_id,
    role: row.role,
    name: nomRendu,
  }), { status: 200, headers: { "content-type": "application/json", "Set-Cookie": cookie } });
};
