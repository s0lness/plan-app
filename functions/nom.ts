// THE ONE PLACE A HUMAN-TYPED NAME IS CLEANED: a plan's own name (functions/api/plans.ts) and a
// guest's self-declared name (functions/api/invite.ts, functions/api/plan.ts, functions/ws.ts)
// go through the SAME function, with only the length cap differing per caller. Previously
// duplicated as `cleanName` in functions/api/plans.ts; that file now calls this one.
//
// See docs/decisions/0004-partage-par-lien.md, edge case 2: the guest name is the first
// UNTRUSTED string this codebase has ever rendered (every name before it came from an
// Access-verified email). Unicode bidi overrides (U+202A-U+202E, U+2066-U+2069) do not corrupt
// the name itself — a control character check alone lets them through — they visually reorder
// the TEXT AROUND the name: a chat line, a cursor label, a tooltip. Stripped for every caller,
// not only guests, because a plan name sits on the same screen.
//
// `max` is a parameter, not a constant, because the two callers bound differently: a plan name
// keeps its historical 60 characters, a guest name is capped at 40 (design edge 2).

const CONTROLE_BAS = 32;
const DEL = 127;
// LRE, RLE, PDF, LRO, RLO
const BIDI_MIN_1 = 0x202a, BIDI_MAX_1 = 0x202e;
// LRI, RLI, FSI, PDI
const BIDI_MIN_2 = 0x2066, BIDI_MAX_2 = 0x2069;

export function cleanName(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  let out = "";
  for (const ch of v.trim()) {
    const c = ch.codePointAt(0) as number;
    if (c < CONTROLE_BAS || c === DEL) continue;
    if ((c >= BIDI_MIN_1 && c <= BIDI_MAX_1) || (c >= BIDI_MIN_2 && c <= BIDI_MAX_2)) continue;
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}
