// src/ts/fil/jeton-hash.ts — THE INVITE TOKEN'S SHAPE IN `location.hash`, AND NOTHING ELSE.
//
// PURE, and split out of `fil/invite.ts` deliberately: `invite.ts` also imports `fil/rest.ts`
// (`setSyncChip`) and `fil/emission.ts` (`wsSend`), so importing IT from a browserless test pulls
// their whole graph along, which is fine under `tsconfig.json` (`strict:true`, what the built
// client actually compiles with) but not under `tsconfig.outils.json` (`strict:false`, what
// `tests/**/*.ts` compiles with): a file reached for the FIRST time through a different config's
// program gets re-checked under that config's own rules. This module has no such graph: it is
// safe to import from either program, and `tests/invite-fil.ts` does exactly that.
//
// `{16,64}` mirrors the server's own `JETON_RE` (`functions/invitation.ts`): `jetonInvitation()`
// only ever produces 22 base64url characters, so this rejects nothing legitimate.
const JETON_HASH_RE = /(?:^|&)k=([A-Za-z0-9_-]{16,64})(?:&|$)/;

/** The invite token carried by a `location.hash`-shaped string (leading `#` optional, absent, or
 *  carrying unrelated segments). `null` when there is none. */
export function jetonDepuisHash(hash: string): string | null {
  const h = String(hash || "").replace(/^#/, "");
  const m = JETON_HASH_RE.exec(h);
  return m ? m[1]! : null;
}

/** The SAME hash with the `k=` segment removed, any other segment left untouched. Used to strip
 *  the capability from the address bar without discarding anything else the fragment might carry. */
export function hashSansJeton(hash: string): string {
  const h = String(hash || "").replace(/^#/, "");
  if (!h) return "";
  const reste = h.split("&").filter((seg) => !/^k=/.test(seg));
  return reste.length ? "#" + reste.join("&") : "";
}
