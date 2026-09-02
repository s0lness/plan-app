// src/ts/rendu/noms.ts: ONLY A CHOSEN NAME GETS WRITTEN ON THE PLAN (R-3).
// Ported from src/js/12-rendu.js (`isChosenName` only: it is a PURE function of three inputs,
// its argument, the catalogue, the table of legacy labels, so it never needed a browser to be
// verified).
//
// A piece of furniture is born with its TYPE's label, possibly followed by an occurrence number
// ("Table 2", "Coffee table 3"). Writing that over the icon teaches NOTHING and clutters. A name
// someone TYPED, on the other hand, is information that exists nowhere else on the plan.
//
// AND THE CATALOGUE HAS A HISTORY: the application was born in English, so a plan from before
// translation carries "Chair", "Table", "Coffee table". Comparing only against the CURRENT label
// mistook those for chosen names and filled the dining corner with four "Chair".
//
// TWO CONSUMERS, AND THEY MUST STAY IN AGREEMENT: the screen and the printed sheet / the PNG
// (js/32). In the old client it was a convention; here it's an exported module, so a single body.

import { baseName, LEGACY_TYPE_NAMES, TYPEMAP } from "../catalogue/catalogue.ts";

/**
 * Was this name TYPED by someone (so it gets written), or is it the catalogue's label (so it
 * stays silent)? An UNKNOWN type (old plan, trimmed catalogue) is displayed: we don't judge what
 * we don't know.
 */
export function isChosenName(p: { name?: unknown; type?: string } | null | undefined): boolean {
  const n = String((p && p.name) || "").trim();
  if (!n) return false;
  const t = p && p.type !== undefined ? TYPEMAP[p.type] : undefined;
  if (!t || !t.name) return true;
  const b = baseName(n);
  if (b === baseName(t.name)) return false;
  const anciens = (p && p.type !== undefined ? LEGACY_TYPE_NAMES[p.type] : undefined) || [];
  for (let i = 0; i < anciens.length; i++) {
    if (b === baseName(anciens[i])) return false;
  }
  return true;
}
