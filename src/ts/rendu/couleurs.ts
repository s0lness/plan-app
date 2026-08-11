// src/ts/rendu/couleurs.ts — RESOLVE A CSS COLOR TO HEX, then attach an opacity to it.
// Ported from src/js/11-icones.js (`resolveColor`, `withAlpha`), without changing a single byte
// of output.
//
// WHY RESOLVE RATHER THAN PASS `var(--seat)` TO THE SVG: icon fills are EIGHT-digit hexadecimals
// (`#rrggbbaa`), and you can't attach an alpha channel to a `var()` without reading it first. The
// read therefore goes through the root's COMPUTED style, which makes `resolveColor` dependent on
// the document: it's the icon block's only DOM dependency, and it's isolated here so the rest can
// be tested without a browser.
//
// THE CACHE IS DELIBERATELY PERMANENT (it already was in js/08-palette.js, declared high up to
// avoid a temporal dead zone). It holds for the lifetime of the page: a theme change mid-session
// doesn't clear it. Original defect kept, flagged, not fixed.

import { clamp } from "../noyau/nombres.ts";

const _colCache: Record<string, string> = {};

/** `var(--x)` -> `#rrggbb`; a hex passes through as-is; nothing -> the default teal. */
export function resolveColor(c: string | undefined): string {
  if (!c) return "#4e7c82";
  if (c[0] === "#") return c;
  const hit = _colCache[c];
  if (hit !== undefined) return hit;
  const m = /^var\((--[\w-]+)\)$/.exec(c.trim());
  let out = c;
  if (m) {
    const nom = m[1] || "";
    out = getComputedStyle(document.documentElement).getPropertyValue(nom).trim() || "#4e7c82";
  }
  _colCache[c] = out;
  return out;
}

/** `#rrggbb` + alpha (0..1) -> `#rrggbbaa`. Any non-hex color comes back unchanged. */
export function withAlpha(hex: string | undefined, a: number): string {
  const h = resolveColor(hex);
  if (h[0] !== "#" || h.length < 7) return h;
  const v = Math.round(clamp(a, 0, 1) * 255).toString(16).padStart(2, "0");
  return h.slice(0, 7) + v;
}
