// src/ts/rendu/noms.ts: ONLY A CHOSEN NAME GETS WRITTEN ON THE PLAN (R-3), PURE. A piece is born
// with its TYPE's label plus an occurrence number ("Table 2"); writing that over the icon teaches
// nothing. A name someone TYPED is information that exists nowhere else. The catalogue has a
// history (labels once English, then translated): comparing only the CURRENT label mistook old
// labels for chosen names (R-3). Two consumers must agree: the screen and the printed sheet/PNG,
// hence a single exported module rather than a convention duplicated at each call site.

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
