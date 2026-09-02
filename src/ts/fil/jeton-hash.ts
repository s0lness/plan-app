// src/ts/fil/jeton-hash.ts: THE INVITE TOKEN'S SHAPE IN `location.hash`, AND NOTHING ELSE.
// PURE, split out of `fil/invite.ts` deliberately: that file's graph (`fil/rest.ts`,
// `fil/emission.ts`) isn't safe to import from a browserless test under `tsconfig.outils.json`
// (`strict:false`); this module has no such graph, so `tests/invite-fil.ts` imports it directly.
// `{16,64}` mirrors the server's own `JETON_RE`: `jetonInvitation()` only ever produces 22
// base64url characters, so this rejects nothing legitimate.
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
