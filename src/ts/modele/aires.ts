// src/ts/modele/aires.ts — signed areas, segment intersections, exact overlap.
// Porté de src/js/47-v5-modele.js.

import type { Pt } from "../partage/plan.ts";

/** SIGNED area: the sign carries the orientation, and cell detection relies on it. */
export function v5SignedArea(poly: readonly Pt[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!, pj = poly[j]!;
    a += pj[0] * pi[1] - pi[0] * pj[1];
  }
  return a / 2;
}

/** PROPER intersection of two segments (null if parallel, collinear, or off-segment). */
export function v5SegInt(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const r: Pt = [b[0] - a[0], b[1] - a[1]];
  const s: Pt = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null; // parallel / collinear: handled by the split
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return [a[0] + t * r[0], a[1] + t * r[1]];
}

/** Vertical spans of the polygon at abscissa `xm` (sorted [y0,y1] pairs). */
function v5SpansAt(poly: readonly Pt[], xm: number): Array<[number, number]> {
  const ys: number[] = [];
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const pi = poly[i]!, pj = poly[j]!;
    const x1 = pj[0], y1 = pj[1], x2 = pi[0], y2 = pi[1];
    if ((x1 <= xm) === (x2 <= xm)) continue;
    const t = (xm - x1) / ((x2 - x1) || 1e-12);
    ys.push(y1 + t * (y2 - y1));
  }
  ys.sort((p, q) => p - q);
  const out: Array<[number, number]> = [];
  for (let k = 0; k + 1 < ys.length; k += 2) out.push([ys[k]!, ys[k + 1]!]);
  return out;
}

/**
 * EXACT intersection area of two rectilinear polygons: vertical sweep, the section is constant
 * between two consecutive abscissas, so the midpoint rule is exact.
 * It is this area matching that lets a room's name survive a wall being moved.
 */
export function v5OverlapArea(A: readonly Pt[], B: readonly Pt[]): number {
  const xs = Array.from(new Set(A.map((p) => p[0]).concat(B.map((p) => p[0])))).sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const x0 = xs[i]!, x1 = xs[i + 1]!, dx = x1 - x0;
    if (dx <= 1e-9) continue;
    const sa = v5SpansAt(A, (x0 + x1) / 2);
    if (!sa.length) continue;
    const sb = v5SpansAt(B, (x0 + x1) / 2);
    if (!sb.length) continue;
    let len = 0;
    for (const u of sa) {
      for (const v of sb) {
        const lo = Math.max(u[0], v[0]), hi = Math.min(u[1], v[1]);
        if (hi > lo) len += hi - lo;
      }
    }
    area += len * dx;
  }
  return area;
}
