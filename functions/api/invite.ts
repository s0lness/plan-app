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
  // partition and discard storage, exactly where a shared link is most likely to be opened. A
  // name sent with this call becomes the new `last_name`; a returning guest who sends none keeps
  // the one already on file, which the response echoes back to prefill the name step.
  const nomEnvoye = cleanName(body.name, GUEST_NAME_MAX);
  // BEST-EFFORT bookkeeping: a write failure here must never turn an already-valid invite into a
  // refused one — the guest earned entry above, on the row as it stood before this update.
  try {
    if (nomEnvoye) {
      await env.DB.prepare("UPDATE invites SET uses=uses+1, last_used_at=?2, last_name=?3 WHERE token=?1")
        .bind(token, new Date().toISOString(), nomEnvoye).run();
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
    name: nomEnvoye || row.last_name || null,
  }), { status: 200, headers: { "content-type": "application/json", "Set-Cookie": cookie } });
};
