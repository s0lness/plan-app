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

/**
 * WHAT A GUEST IS ALLOWED TO LEARN ABOUT AN AUTHOR. Mirrors the wire's own redaction
 * (`nameFromEmail` in live-worker/ops.ts) for the REST fallback, which shares no code with the
 * Durable Object and would otherwise hand a raw `updated_by` column to anyone holding a link.
 *
 * Three shapes reach this: `live` (the DO's own snapshot marker), `invite:<name>` (a guest's own
 * write, already a display name), and an Access email. Only the last needs reducing, to the local
 * part with its trailing digits and separators smoothed out — enough to say WHO wrote before you,
 * not enough to write to them.
 */
export function auteurPourInvite(v: string | null): string | null {
  if (!v) return v;
  if (v === "live" || v.startsWith("invite:")) return v;
  const local = v.split("@")[0];
  const mots = local.replace(/\d+$/, "").split(/[._\-+]+/).filter(Boolean);
  const nom = mots.map((m) => m.charAt(0).toUpperCase() + m.slice(1)).join(" ").slice(0, 32);
  return nom || "Quelqu'un";
}

/**
 * LE MÊME NETTOYAGE, MAIS LE TEXTE LIBRE GARDE SES LIGNES. `cleanName` retire TOUS les caractères
 * de contrôle, ce qui est juste pour un NOM (un nom n'a pas de retour à la ligne) et faux pour un
 * retour d'utilisateur : quelqu'un qui écrit en paragraphes verrait ses lignes disparaître et ses
 * mots se coller. Or ce champ existe précisément pour qu'on y raconte quelque chose.
 *
 * Le saut de ligne survit donc, et lui seul : les autres contrôles et les inverseurs bidi partent
 * comme ailleurs, pour la même raison (ils réordonnent visuellement le TEXTE AUTOUR). Un retour
 * chariot est ramené au simple saut, pour que la même saisie donne les mêmes octets quel que soit
 * le système, et une rafale de sauts est ramenée à deux : un retour n'est pas une mise en page.
 */
export function cleanTexte(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const SAUT = 10;
  let out = "";
  for (const ch of v.replace(/\r\n?/g, "\n").trim()) {
    const c = ch.codePointAt(0) as number;
    if (c === SAUT) {
      if (out.endsWith("\n\n")) continue;
    } else if (c < CONTROLE_BAS || c === DEL) {
      continue;
    } else if ((c >= BIDI_MIN_1 && c <= BIDI_MAX_1) || (c >= BIDI_MIN_2 && c <= BIDI_MAX_2)) {
      continue;
    }
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

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
