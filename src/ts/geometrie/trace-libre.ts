// src/ts/geometrie/trace-libre.ts — FREEHAND WALL TRACE, the pure geometry.
//
// The owner's request, verbatim: "i think we should have a sort of 'free draw' thing for walls.
// you draw and then it turns into walls. cos sometimes you want to make a corner or smth and
// it's not easy." Today a corner takes two straight drags that must meet EXACTLY where the first
// one ended, fighting the magnet the whole way. Here a single freehand stroke becomes a CHAIN of
// walls in one gesture.
//
// EVERYTHING HERE IS PURE, in the spirit of `geometrie/polygones.ts`: no `Contexte`, no DOM, no
// `toast`. The impure half (capturing the pointer, creating the walls, undo, persistence) lives
// in `gestes/trace-libre.ts`. `tests/trace-libre.ts` exercises this file directly, no browser.
//
// THE PIPELINE, in order:
//   1. `simplifyRDP`   — a 200-point shaky stroke must not become 200 walls.
//   2. `straightenChain` — each run near horizontal/vertical LOCKS onto the axis, unless the
//      stroke was drawn free-hand (Alt held, same meaning it already has for a single wall).
//   3. `dedupeChain`   — a run collapsed to nothing by straightening does not become a wall.
//   4. `segmentChain`  — turns the point chain into wall descriptors, marking which ends are
//      LOOSE (the stroke's own two extremities) versus JUNCTIONS (shared with the next run).
//
// WHY THE SHARED VERTEX IS EXACT, "ROUND ONCE" (AGENTS.md, "A click lands on what is visible"):
// `straightenChain` builds each new point from the PREVIOUS corrected point plus the RAW delta
// from the ORIGINAL (unsimplified-further) samples, and rounds that result with `v5R2` exactly
// ONCE. It never re-derives a corner from an already-rounded value, which is the exact defect
// that cost this codebase a permanent 1cm-per-round-trip drift before.

import type { Pt } from "../partage/plan.ts";
import { TRACE_LIBRE_ANGLE_TOL_DEG, TRACE_LIBRE_RDP_TOL_CM, v5R2 } from "../noyau/nombres.ts";

/** Total length of a polyline, cm: the sum of its segment lengths (not the endpoint distance). */
export function strokeLength(pts: readonly Pt[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) {
    L += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  }
  return L;
}

/**
 * Ramer-Douglas-Peucker: keeps only the points that deviate from the straight line between their
 * neighbors by more than `tol` (cm). Iterative (a stack, not recursion) so a 200-point stroke
 * costs nothing to simplify.
 */
export function simplifyRDP(points: readonly Pt[], tol: number): Pt[] {
  if (points.length <= 2) return points.map((p) => [p[0], p[1]] as Pt);
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const pile: [number, number][] = [[0, points.length - 1]];
  while (pile.length) {
    const [lo, hi] = pile.pop()!;
    if (hi - lo < 2) continue;
    const a = points[lo]!, b = points[hi]!;
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const abLen = Math.hypot(abx, aby) || 1e-9;
    let loin = -1, dLoin = -1;
    for (let i = lo + 1; i < hi; i++) {
      const p = points[i]!;
      const d = Math.abs((p[0] - a[0]) * aby - (p[1] - a[1]) * abx) / abLen;
      if (d > dLoin) { dLoin = d; loin = i; }
    }
    if (loin >= 0 && dLoin > tol) {
      keep[loin] = true;
      pile.push([lo, loin]);
      pile.push([loin, hi]);
    }
  }
  const out: Pt[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push([points[i]![0], points[i]![1]]);
  return out;
}

/**
 * Locks each run near horizontal/vertical onto the axis, one run at a time, chained from the
 * PREVIOUS (already-corrected) vertex: this is what makes two consecutive snapped runs meet at an
 * EXACT right angle instead of a nearly-exact one, with no separate "fix the corner" pass. Each
 * new point is built from the RAW delta of the corresponding original samples (never from an
 * already-snapped delta), so a long chain does not drift from the drawn shape.
 *
 * `libre` (Alt held) means what it already means for a single wall: no imposed right angle, no
 * snap. The chain is still simplified (step 1), just never straightened.
 */
export function straightenChain(points: readonly Pt[], libre: boolean): Pt[] {
  if (!points.length) return [];
  const out: Pt[] = [[v5R2(points[0]![0]), v5R2(points[0]![1])]];
  for (let i = 1; i < points.length; i++) {
    const prev = out[i - 1]!;
    const a = points[i - 1]!, b = points[i]!;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    if (libre || (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9)) {
      out.push([v5R2(prev[0] + dx), v5R2(prev[1] + dy)]);
      continue;
    }
    const angle = Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI; // 0deg = horizontal, 90deg = vertical
    if (angle <= TRACE_LIBRE_ANGLE_TOL_DEG) {
      out.push([v5R2(prev[0] + dx), prev[1]]);        // horizontal: y held from the previous vertex
    } else if (angle >= 90 - TRACE_LIBRE_ANGLE_TOL_DEG) {
      out.push([prev[0], v5R2(prev[1] + dy)]);         // vertical: x held from the previous vertex
    } else {
      out.push([v5R2(prev[0] + dx), v5R2(prev[1] + dy)]); // a deliberate diagonal: kept as drawn
    }
  }
  return out;
}

/** Drops a vertex that collapsed onto its predecessor (straightening two runs down to zero length). */
export function dedupeChain(points: readonly Pt[], tol = 1): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= tol) out.push([p[0], p[1]]);
  }
  return out;
}

/** A wall-to-be: consecutive segments SHARE their endpoint (`a`/`b` come from the same chain array). */
export interface SegmentChain {
  a: Pt;
  b: Pt;
  /** Only the stroke's own two loose ends get this: an interior junction stays through-going. */
  free?: 1 | undefined;
}

/**
 * Turns a point chain into wall descriptors. ONLY the FIRST and LAST segment are marked `free`:
 * their outer end has nothing else touching it, so a v5 wall's default through-going extension
 * would stretch it all the way to the facade (`tests/mur-libre.ts`'s whole complaint). An
 * INTERIOR segment's ends are both junctions, already touching the neighboring segment created
 * in the same chain at the exact same point: through-going extension is a safe no-op there
 * (the wall-through algorithm recognizes "already touches here" and does not move it), and
 * leaving it through-going keeps its meaning honest for later edits (a genuinely free wall does
 * not try to reconnect if a neighbor is later dragged away; an interior chain wall should).
 */
export function segmentChain(chain: readonly Pt[]): SegmentChain[] {
  const out: SegmentChain[] = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i]!, b = chain[i + 1]!;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1) continue; // degenerate run: no wall for it
    const seg: SegmentChain = { a: [a[0], a[1]], b: [b[0], b[1]] };
    if (i === 0 || i === chain.length - 2) seg.free = 1;
    out.push(seg);
  }
  return out;
}

/** The whole pipeline, steps 1-4, from a raw captured pointer path to wall descriptors. */
export function traceToWallSegments(rawPts: readonly Pt[], libre: boolean): SegmentChain[] {
  const simplifie = simplifyRDP(rawPts, TRACE_LIBRE_RDP_TOL_CM);
  const droite = straightenChain(simplifie, libre);
  const chaine = dedupeChain(droite);
  return segmentChain(chaine);
}
