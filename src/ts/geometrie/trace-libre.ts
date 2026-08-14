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
//   1. `simplifyRDP`: a 200-point shaky stroke must not become 200 walls.
//   2. `straightenChain`: every run is quantised to the NEAREST MULTIPLE OF 45 DEGREES,
//      unconditionally (horizontal, vertical, or diagonal, never anything else), unless the
//      stroke was drawn free-hand (Alt held, same meaning it already has for a single wall).
//   3. `dedupeChain`: a run collapsed to nothing by straightening does not become a wall.
//   4. `segmentChain`: turns the point chain into wall descriptors, marking which ends are
//      LOOSE (the stroke's own two extremities) versus JUNCTIONS (shared with the next run).
//
// 2026-08-15, "a badly drawn right angle must become a right angle": the owner drew an L to
// close a room and got ~12deg off on both legs, corner not square. The old `straightenChain`
// only snapped a run onto an axis when it was ALREADY within a tolerance: draw at 15deg off and
// it stayed at 15deg. Fixed by quantising unconditionally.
//
// THE TRAP, spelled out because it is the whole difficulty: rotating each run independently
// around its own midpoint (or its own start) breaks the chain, consecutive runs no longer share
// an endpoint, replacing a badly-closed corner with an OPEN one. `straightenChain` therefore
// quantises DIRECTIONS ONLY and rebuilds VERTICES from those quantised lines:
//   . the stroke's own two loose ends anchor the FIRST and LAST line at the exact point the hand
//     pressed / released (matching the help text: "the path's own two ends stay where you drew
//     them"). The one case where that cannot hold, a stroke that is, or collapses to, a SINGLE
//     run, keeps the press point and lets the release point snap onto the corrected line: one
//     of the two has to give, and the single-segment wall tool already resolves the same choice
//     the same way (`v5StartDraw`, `gestes/murs.ts`: the start point is snapped first, the end
//     point is derived from it).
//   . every INTERIOR vertex is the intersection of its two neighbouring quantised lines, so two
//     runs 45/90/135deg apart always meet at an EXACT point, that is what makes the corner
//     square, not a second "fix the corner" pass.
//   . two consecutive runs that quantise to the SAME axis (or its exact opposite: a stroke that
//     doubles back on itself) have parallel lines that never meet: they are fused into one run
//     before reconstruction, so the intersection step never actually faces two parallel lines.
//     A run left too short by this reconstruction (a sliver, not a corner) is folded into a
//     neighbour too (`TRACE_LIBRE_45_MIN_RUN_CM`). Both loops run to a fixed point that always
//     terminates (every iteration either merges two runs into one, shrinking the list by exactly
//     one, or stops): no NaN, no wall of absurd length, because two DIFFERENT quantised axes are
//     always at least 45deg apart, which bounds how far an intersection can land from its anchors.
//
// WHY THE SHARED VERTEX IS EXACT, "ROUND ONCE" (AGENTS.md, "A click lands on what is visible"):
// every output point is rounded with `v5R2` exactly once, straight from the RAW sample(s) that
// produced it (an anchor point, or an intersection of two anchor-and-direction lines built from
// raw samples), never re-derived from an already-rounded value, which is the exact defect that
// cost this codebase a permanent 1cm-per-round-trip drift before.

import type { Pt } from "../partage/plan.ts";
import { TRACE_LIBRE_45_MIN_RUN_CM, TRACE_LIBRE_RDP_TOL_CM, v5R2 } from "../noyau/nombres.ts";

/** The 8 unit directions a run can quantise to, indexed by `quantizeAngleDeg(deg) / 45`. Table
 * lookup instead of calling `cos`/`sin` on a rounded degree value: axis directions come out
 * EXACTLY `0`/`±1`, never `1.2246e-16`, which matters because `dir` feeds a line-intersection
 * divide-by-`denom` below. */
const DIR8: readonly Pt[] = [
  [1, 0], [Math.SQRT1_2, Math.SQRT1_2], [0, 1], [-Math.SQRT1_2, Math.SQRT1_2],
  [-1, 0], [-Math.SQRT1_2, -Math.SQRT1_2], [0, -1], [Math.SQRT1_2, -Math.SQRT1_2],
];

/** Nearest multiple of 45, wrapped into [0, 360). */
function quantizeAngleDeg(rawDeg: number): number {
  const a = ((rawDeg % 360) + 360) % 360;
  const q = Math.round(a / 45) * 45;
  return q >= 360 ? 0 : q;
}

/** A run-to-be-quantised: `p0`/`p1` are RAW sample points (never already-quantised ones), so a
 * run born from merging still quantises its direction from the true hand-drawn geometry. */
interface Run { p0: Pt; p1: Pt }

/** An infinite line: `anchor` is a point ON it, `dir` one of the 8 unit vectors above. */
interface Ligne { anchor: Pt; dir: Pt }

/**
 * The quantised line for run `i` of `total`. The two OUTER runs (a stroke's own loose ends)
 * anchor on the exact raw point the hand pressed (`i===0`) or released (`i===total-1`): when
 * `total===1` both conditions describe the same run and the press point wins, the same
 * press-first precedent `v5StartDraw` already sets for a single wall. An interior run has no
 * point of its own worth preserving (both its ends are about to be replaced by intersections
 * with its neighbours), so it anchors on its own midpoint, splitting the difference.
 */
function ligneDuTroncon(r: Run, i: number, total: number): Ligne {
  const dx = r.p1[0] - r.p0[0], dy = r.p1[1] - r.p0[1];
  const dir = DIR8[quantizeAngleDeg(Math.atan2(dy, dx) * 180 / Math.PI) / 45]!;
  if (i === 0) return { anchor: r.p0, dir };
  if (i === total - 1) return { anchor: r.p1, dir };
  return { anchor: [(r.p0[0] + r.p1[0]) / 2, (r.p0[1] + r.p1[1]) / 2], dir };
}

/** Nearest point on `l` to `p` (perpendicular projection): the one place a loose end MOVES, when
 * the stroke has only one run and cannot keep both its raw ends on an axis-quantised line. */
function projeteSurLigne(p: Pt, l: Ligne): Pt {
  const t = (p[0] - l.anchor[0]) * l.dir[0] + (p[1] - l.anchor[1]) * l.dir[1];
  return [l.anchor[0] + t * l.dir[0], l.anchor[1] + t * l.dir[1]];
}

/** Where two lines cross. `l1`/`l2` are never parallel by the time this is called (the merge
 * loop below fuses same-axis neighbours away first), but the fallback (their anchors' midpoint)
 * is kept anyway: a guard that could still divide by ~0 is worse than one that cannot. */
function intersectionLignes(l1: Ligne, l2: Ligne): Pt {
  const denom = l1.dir[0] * l2.dir[1] - l1.dir[1] * l2.dir[0];
  if (Math.abs(denom) < 1e-9) {
    return [(l1.anchor[0] + l2.anchor[0]) / 2, (l1.anchor[1] + l2.anchor[1]) / 2];
  }
  const dx = l2.anchor[0] - l1.anchor[0], dy = l2.anchor[1] - l1.anchor[1];
  const t = (dx * l2.dir[1] - dy * l2.dir[0]) / denom;
  return [l1.anchor[0] + t * l1.dir[0], l1.anchor[1] + t * l1.dir[1]];
}

const r2 = (p: Pt): Pt => [v5R2(p[0]), v5R2(p[1])];

/** Rebuilds the vertex chain from the (already merged/quantised-safe) run list: the true loose
 * ends where they belong, every interior vertex as an exact line intersection. */
function reconstruireSommets(runs: readonly Run[]): Pt[] {
  const total = runs.length;
  const lignes = runs.map((r, i) => ligneDuTroncon(r, i, total));
  const out: Pt[] = new Array(total + 1);
  out[0] = r2(lignes[0]!.anchor);
  for (let i = 1; i < total; i++) out[i] = r2(intersectionLignes(lignes[i - 1]!, lignes[i]!));
  out[total] = total === 1 ? r2(projeteSurLigne(runs[0]!.p1, lignes[0]!)) : r2(lignes[total - 1]!.anchor);
  return out;
}

const longueur = (r: Run): number => Math.hypot(r.p1[0] - r.p0[0], r.p1[1] - r.p0[1]);
/** Same-axis test: `deg` and `deg+180` both quantise here to the same value, which is exactly
 * "parallel", doubled-back stroke included. */
const classe = (r: Run): number => quantizeAngleDeg(Math.atan2(r.p1[1] - r.p0[1], r.p1[0] - r.p0[0]) * 180 / Math.PI) % 180;

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
 * Quantises every run of the chain to the nearest multiple of 45 degrees, UNCONDITIONALLY: no
 * tolerance, horizontal/vertical/diagonal and nothing else, then rebuilds the vertex chain so it
 * stays connected (see the file header for why that is the whole difficulty). Two passes run to a
 * fixed point before any vertex is computed: same-axis neighbours (a stroke with no real corner
 * between them, forward or doubled back) are fused, and a run reduced to (near) zero length loses
 * its direction entirely and is fused away too. A THIRD pass then checks the reconstructed
 * geometry itself: a run the intersection step left shorter than `TRACE_LIBRE_45_MIN_RUN_CM` (a
 * sliver, not a corner) is fused the same way and the whole thing is rebuilt again. Every fusion
 * shrinks the run count by exactly one, so the loop always terminates.
 *
 * `libre` (Alt held) means what it already means for a single wall: no imposed right angle, no
 * snap, the raw shape kept as drawn (each point rounded once, nothing else touched).
 */
export function straightenChain(points: readonly Pt[], libre: boolean): Pt[] {
  if (!points.length) return [];
  if (libre || points.length === 1) return points.map((p) => r2(p));

  const runs: Run[] = [];
  for (let i = 1; i < points.length; i++) runs.push({ p0: points[i - 1]!, p1: points[i]! });

  const fuse = (i: number): void => { runs.splice(i, 2, { p0: runs[i]!.p0, p1: runs[i + 1]!.p1 }); };

  while (runs.length > 1) {
    let did = false;
    // 1. same axis, forward or doubled back: no real corner here, one run instead of two.
    for (let i = 0; i < runs.length - 1; i++) {
      if (classe(runs[i]!) === classe(runs[i + 1]!)) { fuse(i); did = true; break; }
    }
    if (did) continue;
    // 2. (near) zero length: no direction to quantise, fold into whichever neighbour exists.
    for (let i = 0; i < runs.length; i++) {
      if (longueur(runs[i]!) < 1e-6) { fuse(i < runs.length - 1 ? i : i - 1); did = true; break; }
    }
    if (did) continue;
    // 3. rebuild and check: a run the intersection left too short is a sliver, not a corner.
    const v = reconstruireSommets(runs);
    let court = -1;
    for (let i = 0; i < v.length - 1; i++) {
      if (Math.hypot(v[i + 1]![0] - v[i]![0], v[i + 1]![1] - v[i]![1]) < TRACE_LIBRE_45_MIN_RUN_CM) { court = i; break; }
    }
    if (court === -1) return v;
    fuse(court < runs.length - 1 ? court : court - 1);
  }
  return reconstruireSommets(runs);
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
