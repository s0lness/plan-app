// src/ts/rendu/couleurs.ts: RESOLVE A CSS COLOR TO HEX, then attach an opacity to it. Icon fills
// are eight-digit hex (`#rrggbbaa`), and a `var()` can't take an alpha channel without reading it
// first (root's COMPUTED style): the icon block's only DOM dependency, isolated here.
//
// THE CACHE IS DELIBERATELY PERMANENT: holds for the page's lifetime, a theme change mid-session
// doesn't clear it. Known, flagged, not fixed.

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
