// SHARED DATA-LAYER for the `invites` table (docs/decisions/0004-partage-par-lien.md, "batch 1b,
// the invite"). functions/api/invite.ts (the guest's redemption), functions/api/invites.ts (the
// owner's management), functions/api/plan.ts and functions/ws.ts (both consult the session
// cookie to resolve which plan a guest may reach) all read the SAME row shape and apply the SAME
// validity rule, so "revoked", "expired" and "unknown" are decided identically everywhere a
// guest is let in or turned away.

import type { Env } from "./env.ts";

/** Session cookie set by functions/api/invite.ts, read by functions/api/plan.ts and
 * functions/ws.ts. A browser cannot set headers on a WebSocket upgrade, so this cookie is what
 * lets the capability travel to `/ws` without landing a `?k=` in edge logs on every reconnect. */
export const INVITE_COOKIE = "plan_invite";
const TRENTE_JOURS_S = 30 * 24 * 3600;

export interface LigneInvitation {
  token: string;
  plan_id: string;
  role: string;
  created_at: string | null;
  created_by: string | null;
  expires_at: string | null;
  revoked: number;
  uses: number;
  last_used_at: string | null;
  last_name: string | null;
  last_guest_id: string | null;
}

const COLONNES = "token, plan_id, role, created_at, created_by, expires_at, revoked, uses, last_used_at, last_name, last_guest_id";

/**
 * THE SHAPE OF A TOKEN, checked before it is ever used for anything. `jetonInvitation` only ever
 * produces base64url, so this rejects nothing legitimate, and it buys two things.
 *
 * It closes a header-injection class by construction: `functions/api/invite.ts` echoes the token
 * back inside a `Set-Cookie` value, and a token carrying CR, LF or `;` could append cookie
 * attributes or split the header. That is unreachable today (a token must already exist in D1 to
 * get that far, and only `jetonInvitation` writes one), which is exactly why it should be
 * impossible rather than merely unreached: the guarantee must not depend on a table's contents.
 *
 * And it makes a probe cheap to refuse: junk is turned away here, without a D1 query.
 */
const JETON_RE = /^[A-Za-z0-9_-]{16,64}$/;

export async function chargerInvitation(env: Env, token: string): Promise<LigneInvitation | null> {
  const t = (token || "").trim();
  if (!JETON_RE.test(t)) return null;
  const row = await env.DB.prepare(`SELECT ${COLONNES} FROM invites WHERE token=?1`).bind(t).first<LigneInvitation>();
  return row || null;
}

/**
 * Same rule everywhere a guest is let in: not revoked, not expired. Deliberately does NOT check
 * that the plan itself still exists (edge case 10), that is a separate query each caller runs,
 * because the two failures are never reported differently: both collapse to the same dead end.
 */
export function invitationValide(row: LigneInvitation | null): row is LigneInvitation {
  if (!row) return false;
  if (row.revoked) return false;
  if (row.expires_at) {
    const exp = Date.parse(row.expires_at);
    if (!Number.isNaN(exp) && exp <= Date.now()) return false;
  }
  return true;
}

export function tokenDuCookie(request: Request): string {
  const cru = request.headers.get("Cookie") || "";
  const m = cru.match(new RegExp("(?:^|;\\s*)" + INVITE_COOKIE + "=([^;]+)"));
  if (!m) return "";
  // `decodeURIComponent` THROWS on a malformed escape (`%zz`), and the cookie is caller-supplied:
  // unguarded, a mangled cookie turns a clean dead end into a 500. The raw value is a perfectly
  // good fallback, `chargerInvitation` validates the shape either way.
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

/**
 * Seconds until `expiresAt`, capped at 30 days: the cookie must never outlive the 30-day
 * backstop, whatever the row says, and a row with no expiry at all still gets a bounded cookie
 * rather than an eternal one.
 */
export function dureeCookieSecondes(expiresAt: string | null): number {
  if (!expiresAt) return TRENTE_JOURS_S;
  const exp = Date.parse(expiresAt);
  if (Number.isNaN(exp)) return TRENTE_JOURS_S;
  const s = Math.floor((exp - Date.now()) / 1000);
  return Math.max(1, Math.min(s, TRENTE_JOURS_S));
}

/** 128 bits, base64url, no padding: 22 characters, matching the `#k=` fragment the link carries
 * (docs/decisions/0004-partage-par-lien.md). Brute-forcing this is not the threat model, revoke
 * is (design edge 15), but 128 bits costs nothing extra to generate correctly. */
export function jetonInvitation(): string {
  const octets = new Uint8Array(16);
  crypto.getRandomValues(octets);
  let bin = "";
  for (const b of octets) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
