// src/ts/modele/conversion.ts — recognition of support lines, and "is this segment on the
// outline?". Porté de src/js/49-v5-conversion.js (PURE part: the four functions that the
// plan's sanitization (js/02), the verdict for deleting a wall (js/52), and undo replay
// (js/27) depend on).
//
// `buildV5FromV4`, the bulk of js/49, is NOT here: it depends on `computeEnvelopeHull` (js/25),
// `roomAptPoly`, and `localToApt` (js/05), that is, on the apartment space of the legacy format.
// Still to be ported (see the batch report).

import type { Pt } from "../partage/plan.ts";
import { closestOnSeg } from "../geometrie/polygones.ts";

/** Support line of a segment, in canonical form: normalized direction + distance from origin. */
export interface DroiteSupport {
  dx: number;
  dy: number;
  /** c = n·a, with n = (-dy, dx) */
  c: number;
}

export function v5LineKey(a: Pt, b: Pt): DroiteSupport {
  let dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy) || 1;
  dx /= L; dy /= L;
  if (dx < -1e-9 || (Math.abs(dx) <= 1e-9 && dy < 0)) { dx = -dx; dy = -dy; } // canonical direction
  return { dx, dy, c: (-dy) * a[0] + dx * a[1] };
}

export function v5SameLine(A: DroiteSupport, B: DroiteSupport, tol: number): boolean {
  return Math.abs(A.dx * B.dy - A.dy * B.dx) < 0.02 && Math.abs(A.c - B.c) <= tol;
}

/** Snaps a point onto the outline (vertex takes priority, else edge) if within `tol`. */
export function v5SnapToOutline(p: Pt, outline: readonly Pt[], tol: number): Pt {
  let bv: Pt | null = null, bd = tol;
  for (const q of outline) {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d <= bd) { bd = d; bv = [q[0], q[1]]; }
  }
  if (bv) return bv;
  let be: Pt | null = null;
  bd = tol;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!, b = outline[(i + 1) % outline.length]!;
    const c = closestOnSeg(p[0], p[1], a[0], a[1], b[0], b[1]);
    if (c.dist <= bd) { bd = c.dist; be = [c.x, c.y]; }
  }
  return be || p;
}

/**
 * Does this segment run along an edge of the OUTLINE? This is the rule that decides a wall is an
 * OUTLINE WALL. The outline is authoritative, the `isOutline` flag is only a cache (C-13).
 */
export function v5OnOutline(a: Pt, b: Pt, outline: readonly Pt[], tol: number): boolean {
  const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i]!, q = outline[(i + 1) % outline.length]!;
    if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 1) continue;
    const c = closestOnSeg(mid[0], mid[1], p[0], p[1], q[0], q[1]);
    if (c.dist <= tol && v5SameLine(v5LineKey(a, b), v5LineKey(p, q), tol)) return true;
  }
  return false;
}
