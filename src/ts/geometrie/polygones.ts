// src/ts/geometrie/polygones.ts: polygon geometry, in APARTMENT cm.
// Ported from src/js/04-geometrie.js (+ `simplifyRectilinear` from src/js/25-enveloppe.js).
//
// EVERYTHING HERE IS PURE. The old `aptBBox()` read `state.plan.outline` from the closure; it becomes
// `bboxOfPoly(outline)`, called with the outline. It's the same function, but its dependency is
// now STATED by its signature instead of being invisible.

import type { Pt } from "../partage/plan.ts";

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  w: number;
  l: number;
}

/**
 * Bounding box of any polygon (cell, outline, sketch), in cm.
 * The 420×360 fallback is the default plan for an empty polygon.
 */
export function bboxOfPoly(poly: readonly Pt[]): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    const x = p[0], y = p[1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 420; maxY = 360; }
  return { minX, minY, maxX, maxY, w: Math.max(1, maxX - minX), l: Math.max(1, maxY - minY) };
}

export function pointInPoly(x: number, y: number, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!, pj = poly[j]!;
    const xi = pi[0], yi = pi[1], xj = pj[0], yj = pj[1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
  }
  return inside;
}

export function polyArea(poly: readonly Pt[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!, pj = poly[j]!;
    a += (pj[0] + pi[0]) * (pj[1] - pi[1]);
  }
  return Math.abs(a / 2);
}

/**
 * AREA centroid of a polygon (the centre of mass of the surface, not the average of the corners:
 * a long wall cut into many vertices would drag that one). Falls back to the average of the
 * corners for a degenerate (zero-area) polygon, which is the only case where it is undefined.
 * Used to break an EXACT tie of overlap area when a room's name has to choose a cell.
 */
export function polyCentroid(poly: readonly Pt[]): { x: number; y: number } {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!, pj = poly[j]!;
    const f = pj[0] * pi[1] - pi[0] * pj[1];
    a += f;
    cx += (pj[0] + pi[0]) * f;
    cy += (pj[1] + pi[1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sy = 0;
    for (const p of poly) { sx += p[0]; sy += p[1]; }
    const n = poly.length || 1;
    return { x: sx / n, y: sy / n };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

export interface PointProche {
  x: number;
  y: number;
  dist: number;
}

export function closestOnSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): PointProche {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-9;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx, y = ay + t * dy;
  return { x, y, dist: Math.hypot(px - x, py - y) };
}

export function nearestOnPoly(x: number, y: number, poly: readonly Pt[]): PointProche {
  const p0 = poly[0]!;
  let best: PointProche = { x: p0[0], y: p0[1], dist: Infinity };
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!, pj = poly[j]!;
    const c = closestOnSeg(x, y, pj[0], pj[1], pi[0], pi[1]);
    if (c.dist < best.dist) best = c;
  }
  return best;
}

/**
 * Signed distance from a point to the polygon (positive inside). Used for the pole of inaccessibility.
 *
 * ONE PASS, NO OBJECT. It used to call `pointInPoly` and then `closestOnSeg` per edge, and
 * `closestOnSeg` returns a fresh `{x, y, dist}`. `poleOfInaccessibility` calls this ~450 times per
 * polygon, so a plan of 30 000 cells allocated tens of millions of throwaway objects for their
 * `.dist` field alone. The arithmetic below is `closestOnSeg`'s, operation for operation, and the
 * inside test is `pointInPoly`'s, in the same edge order: the value returned is the same bits.
 */
export function signedDistToPoly(x: number, y: number, poly: readonly Pt[]): number {
  let inside = false;
  let d = Infinity;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const pi = poly[i]!, pj = poly[j]!;
    const xi = pi[0], yi = pi[1], xj = pj[0], yj = pj[1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
    const dx = xj - xi, dy = yj - yi;
    const len2 = dx * dx + dy * dy || 1e-9;
    let t = ((x - xi) * dx + (y - yi) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = xi + t * dx, cy = yi + t * dy;
    const dist = Math.hypot(x - cx, y - cy);
    if (dist < d) d = dist;
  }
  return inside ? d : -d;
}

// Cache keyed by polygon signature. Declared here, next to its only consumer: in the old client
// it lived in js/00-noyau.js ONLY because the bootstrap conversion called it before
// js/04 was evaluated (temporal dead zone). The import graph settles that on its own.
//
// TWO LEVELS, AND THE FIRST ONE COSTS NOTHING TO CONSULT. The key used to be `JSON.stringify(poly)`
// and the whole cache was EMPTIED as soon as it passed 200 entries. On a plan of more than 200
// rooms that made every lookup a miss AND paid the stringify: the cache was a pure loss, exactly
// where it was needed most. A cell polygon is BUILT, never edited point by point (detection
// rebuilds them whole; the only in-place polygon editing in the client is the OUTLINE, which has
// no pole), so the array identity is a sound key: a `WeakMap` answers the repeat calls on the same
// cells with no key to build at all. The string key remains for the polygons that are copied
// rather than reused (`modele/photo-cellules.ts` deep-copies them), now with a bounded LRU: the
// oldest entry leaves, instead of all of them at once.
const _poleParRef = new WeakMap<readonly Pt[], { x: number; y: number }>();
const _poleCache = new Map<string, { x: number; y: number }>();
const POLE_CACHE_MAX = 1024;

function signaturePoly(poly: readonly Pt[]): string {
  let s = "";
  for (const p of poly) s += p[0] + "," + p[1] + ";";
  return s;
}

function memoriserPole(poly: readonly Pt[], sig: string, res: { x: number; y: number }): void {
  _poleParRef.set(poly, res);
  if (_poleCache.size >= POLE_CACHE_MAX) {
    const plusVieux = _poleCache.keys().next();
    if (!plusVieux.done) _poleCache.delete(plusVieux.value);
  }
  _poleCache.set(sig, res);
}

/**
 * Pole of inaccessibility (polylabel-style): the INTERIOR point farthest from any edge.
 * Handles concave (L-shaped) rooms where the centroid can fall outside. Coarse grid over the
 * bbox, we keep the best interior cell, then two rounds of refinement around it.
 */
export function poleOfInaccessibility(poly: readonly Pt[] | null | undefined): { x: number; y: number } {
  if (!poly || poly.length < 3) return { x: 0, y: 0 };
  const parRef = _poleParRef.get(poly);
  if (parRef) return parRef;
  const sig = signaturePoly(poly);
  const hit = _poleCache.get(sig);
  if (hit) { _poleParRef.set(poly, hit); return hit; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    const x = p[0], y = p[1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const w = maxX - minX, h = maxY - minY;
  let bestX = (minX + maxX) / 2, bestY = (minY + maxY) / 2, bestD = -Infinity;
  // THE BOX IS A CEILING, AND IT IS FREE. The polygon is inside its own bbox, so the largest disk
  // centred on a point and contained in the polygon is contained in the box too: the signed
  // distance can never exceed the distance to the box's border. A sample that cannot BEAT the
  // current best is skipped, and the winner is unchanged because the comparison is strict (a tie
  // never replaced the incumbent either). Roughly half the coarse grid goes this way.
  const plafond = (px: number, py: number): number =>
    Math.min(px - minX, maxX - px, py - minY, maxY - py);
  const N = 16, sx = w / N, sy = h / N;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const px = minX + i * sx, py = minY + j * sy;
      if (bestD >= 0 && plafond(px, py) <= bestD) continue;
      const d = signedDistToPoly(px, py, poly);
      if (d > bestD) { bestD = d; bestX = px; bestY = py; }
    }
  }
  let cell = Math.max(sx, sy);
  for (let r = 0; r < 2; r++) {
    cell /= 4;
    for (let i = -4; i <= 4; i++) {
      for (let j = -4; j <= 4; j++) {
        const px = bestX + i * cell, py = bestY + j * cell;
        if (bestD >= 0 && plafond(px, py) <= bestD) continue;
        const d = signedDistToPoly(px, py, poly);
        if (d > bestD) { bestD = d; bestX = px; bestY = py; }
      }
    }
  }
  if (bestD <= 0) {
    if (!pointInPoly(bestX, bestY, poly)) {
      const c = nearestOnPoly((minX + maxX) / 2, (minY + maxY) / 2, poly);
      bestX = c.x; bestY = c.y;
    }
  }
  const res = { x: bestX, y: bestY };
  memoriserPole(poly, sig, res);
  return res;
}

/**
 * WORLD direction (cm frame, y pointing DOWN) of an object's LOCAL +y, rotated by `angRad`.
 * An earlier version wrote (+sinθ, cosθ): identical on a HORIZONTAL wall, opposite on a
 * VERTICAL wall, hence every wall-mounted object landing at 180° on vertical walls.
 */
export function wallInwardNormal(angRad: number): { x: number; y: number } {
  return { x: -Math.sin(angRad), y: Math.cos(angRad) };
}

/** Rotation (deg) placing a wall-mounted object along a wall, LOCAL +y turned toward the INSIDE. */
export function wallFacingRot(angRad: number, px: number, py: number, facePoly: readonly Pt[]): number {
  let rot = angRad * 180 / Math.PI;
  const n = wallInwardNormal(angRad);
  if (!pointInPoly(px + n.x * 8, py + n.y * 8, facePoly)) rot += 180;
  return rot;
}

function segsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt): number =>
    Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

export function selfIntersects(poly: readonly Pt[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!, b = poly[(i + 1) % n]!;
    for (let k = i + 1; k < n; k++) {
      if (k === i) continue;
      const c = poly[k]!, d = poly[(k + 1) % n]!;
      if (a === c || a === d || b === c || b === d) continue;
      if ((i + 1) % n === k || (k + 1) % n === i) continue;
      if (segsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

/**
 * Rectilinear simplification (src/js/25-enveloppe.js): removes exact duplicates, then vertices
 * that are collinear within `tol`. Called by cell detection and by the v4 → v5 conversion,
 * hence its presence in the pure core.
 */
export function simplifyRectilinear(poly: readonly Pt[], tol: number): Pt[] {
  let pts: Pt[] = poly.slice();
  const out0: Pt[] = [];
  for (const p of pts) {
    const l = out0[out0.length - 1];
    if (!l || l[0] !== p[0] || l[1] !== p[1]) out0.push(p);
  }
  if (out0.length > 1) {
    const a = out0[0]!, b = out0[out0.length - 1]!;
    if (a[0] === b[0] && a[1] === b[1]) out0.pop();
  }
  pts = out0;
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length]!, b = pts[i]!, c = pts[(i + 1) % pts.length]!;
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const segLen = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
      if (Math.abs(cross) / segLen <= tol) { pts.splice(i, 1); changed = true; break; }
    }
  }
  return pts;
}
