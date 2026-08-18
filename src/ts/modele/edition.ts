// src/ts/modele/edition.ts — THE EDITING GEOMETRY: what moves when you trace, drag, or place.
// Porté de src/js/52-v5-geometrie-edition.js, the half that was NOT already in `modele/murs.ts`
// (that one holds only the functions with no slate and no neighbors: `v5Seg`, `v5WallById`,
// `v5SameSegment`, `v5DedupeWalls`, `v5OpeningSameSlot`, `v5OpeningDepthMax`/`For`,
// `v5ClampOpeningsOfWall`, `v5WallDeleteVerdict`, `v5OpeningEdgeLimits`, `v5OpeningBox`,
// `v5CellsAt`). None of that is re-declared here: it is imported.
//
// THE INVARIANTS THIS FILE HOLDS, and every one of them was paid for by an incident:
//   G-6  a clamp can NEVER move something farther away (`clampCenterToInset`: an iteration that
//        does not improve the penetration is discarded; without this guard the sofa jumped 372 cm);
//   G-7  what was already overflowing keeps its overflow (`tol`, `opts.gardeOrphelin`);
//   G-8  no mass renormalization (`v5ClampPieces` touches ONLY orphans) and the banner belongs to
//        the AUTHOR of the gesture (`v5NoteForeignOrphans`);
//   G-16 an opening's depth is bounded by its wall's thickness (`v5MoveOpeningTo`,
//        `v5PlaceWallMount`, `v5PasteWallMount`, via `v5OpeningDepthFor`).
//
// ---- WHAT THE PORT CHANGES, AND NOTHING ELSE -----------------------------------------------------
// 1. THE PLAN IS AN ARGUMENT. The old code read `state.plan` through the closure. Here every
//    function receives `P`. This is not cosmetic: these functions are called with the LIVE plan
//    by the author of a gesture and with a DATA plan on replay.
// 2. NO SCREEN EFFECTS. Where the old code called `toast(...)`, `render()`, `save()`, `v5Touch()`,
//    `selReplace()`, or `openInspector()`, we RETURN the data and the caller decides. The four
//    `v5Flush*` functions therefore return the message TEXT (or `null`), to display with
//    `{geste:true}` as the old code did; `v5ClampPieces` returns both its count AND its message
//    (that message never carried `{geste:true}`).
// 3. THE SLATES REMAIN MODULE-LEVEL VARIABLES, as before, but they are now read only through an
//    exported accessor (`v5LastFit()`, `v5LastRefus()`, ...).
// 4. WHAT DEPENDED ON THE VIEW BECOMES A PARAMETER. `wallSnapReach()` (js/05) and `vScale` depend
//    on the zoom: `maxDist` and `echelle` are therefore REQUIRED, never guessed. `state.opts.snap`
//    becomes `snap`. The visibility layers are a PERSONAL setting: they are passed in too.
//
// ---- A DELIBERATE BORROW, AND WHY --------------------------------------------------------------
// `v5ResolveOpening` comes from js/53 (tools batch), but placing, pasting, and moving an opening
// all three call it: it is PURE, it is ported here and EXPORTED, so the tools batch can import it
// instead of making yet another copy. `clampCenterToInset` (js/19), by contrast, already has an
// owner (`gestes/contraintes.ts`): it is imported from there.

import { clamp, v5R2, WALL } from "../noyau/nombres.ts";
import {
  isWallMount,
  pieceVisible,
  TYPEMAP,
  type CalquesVisibles,
  type ItemCatalogue,
} from "../catalogue/catalogue.ts";
import { closestOnSeg, nearestOnPoly, poleOfInaccessibility, pointInPoly } from "../geometrie/polygones.ts";
import { clampCenterToInset } from "../gestes/contraintes.ts";
import { v5LineKey, v5SameLine } from "./conversion.ts";
import {
  v5CellsAt,
  v5ClampOpeningsOfWall,
  v5OpeningDepthFor,
  v5OpeningDepthMax,
  v5OpeningSameSlot,
  v5Seg,
  v5WallById,
  v5WallDeleteVerdict,
  type ChangementOuverture,
  type SegmentMur,
} from "./murs.ts";
import type { Cellule, Id, Meuble, Mur, Ouverture, PlanV5, Pt } from "../partage/plan.ts";

/**
 * Is the plan usable? (valid outline). `v5On()` from js/51, without the global: false only on a
 * broken state.
 */
function planUtilisable(P: PlanV5 | null | undefined): boolean {
  return !!P && Array.isArray(P.outline) && P.outline.length > 2;
}

// =================================================================================================
//  IDENTIFIER FOR A DERIVED ENTITY (js/51)
// =================================================================================================
// Identifier for a DERIVED entity, which both devices recompute identically from the same
// geometry (outline walls, a mirror of the outline's edges). Here the collision IS the intended
// behavior: without it, a received `outline.set` would spawn a second outline wall on the peer's
// side carrying a different identifier, and the two plans would diverge. Hence no device tag: just
// local numbering, as before.
// Ported here because `v5SyncOutlineWalls` depends on it and `fil/pseudo-fil.ts` does not carry it
// yet; `v5NewId`, by contrast, depends on the socket and on `sessionStorage`, and remains an
// injected FACTORY (see `FabriqueOuverture`).

export function v5DerivedId(P: PlanV5 | null | undefined, prefix: string): Id {
  const p = P || ({} as Partial<PlanV5>);
  const used = new Set<string>();
  const listes: { id: Id }[][] = [p.walls || [], p.openings || [], p.pieces || [], p.cells || []];
  for (const l of listes) for (const e of l) used.add(String(e.id));
  let n = 1, id: string;
  do { id = prefix + (n++); } while (used.has(id));
  return id;
}

// =================================================================================================
//  BARRIERS, RAYS, LINES
// =================================================================================================

/** An edge that STOPS something. `outline:true` = an outline edge (only it TRIMS). */
export interface Barriere {
  a: Pt;
  b: Pt;
  outline: boolean;
}

// "Barrier" segments: outline edges + interior walls (except `excludeId`).
// `outline:true` marks the OUTLINE: only it TRIMS a wall (a wall never leaves the apartment).
// Interior walls, on the other hand, STOP an endpoint that runs into them, and nothing more: a
// wall they cross through its middle is not cut.
export function v5Barriers(P: PlanV5 | null | undefined, excludeId: Id | null | undefined): Barriere[] {
  const out: Barriere[] = [];
  if (!P) return out;
  const O = P.outline || [];
  for (let i = 0; i < O.length; i++) {
    const a = O[i]!, b = O[(i + 1) % O.length]!;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1) out.push({ a, b, outline: true });
  }
  (P.walls || []).forEach((w) => {
    if (w.isOutline || String(w.id) === String(excludeId)) return;
    out.push({ a: w.a, b: w.b, outline: false });
  });
  return out;
}

export interface CroisementRayon {
  t: number;
  outline: boolean;
}

// Every crossing along the ray (ox,oy)+t*(ux,uy), sorted by increasing t. `tMin` allows looking a
// touch BACKWARD: an overshoot of two centimeters must snap back to the junction it just crossed,
// not run off to the far end of the apartment.
export function v5RayHits(
  P: PlanV5 | null | undefined,
  ox: number,
  oy: number,
  ux: number,
  uy: number,
  excludeId: Id | null | undefined,
  tMin?: number | null,
): CroisementRayon[] {
  const lo = (tMin == null ? 0.5 : tMin);
  const out: CroisementRayon[] = [];
  v5Barriers(P, excludeId).forEach((s) => {
    const a = s.a, b = s.b;
    const rx = b[0] - a[0], ry = b[1] - a[1];
    const den = ux * ry - uy * rx;
    if (Math.abs(den) < 1e-9) return;
    const t = ((a[0] - ox) * ry - (a[1] - oy) * rx) / den;
    const u = ((a[0] - ox) * uy - (a[1] - oy) * ux) / den;
    if (t >= lo && u >= -1e-6 && u <= 1 + 1e-6) out.push({ t, outline: !!s.outline });
  });
  out.sort((p, q) => p.t - q.t);
  return out;
}

// =================================================================================================
//  A v5 WALL RUNS THROUGH, AND IT DOES SO OVER ITS ENTIRE LENGTH
// =================================================================================================
// BUSINESS DECISION. Each endpoint is pushed out to the first geometry encountered BEYOND itself
// (a T-junction), and trimmed by the OUTLINE if it goes past it. What crosses the wall BETWEEN
// its two endpoints no longer shortens it.
// The ray used to start from the wall's MIDPOINT and stop at the first crossing: any wall crossed
// anywhere other than exactly at its midpoint was therefore truncated on the next drag, a room
// vanished, silently. Starting from the ENDPOINT makes the crossing (an off-center T, a cross, or
// multiple crossings) have no effect, and the operation idempotent.

/** cm: an overshoot of less than 2 cm snaps back to the junction it crossed */
export const V5_JOIN_TOL = 2;

export function v5ThroughEnd(
  P: PlanV5 | null | undefined,
  w: Mur,
  s: SegmentMur,
  sign: number,
): Pt | null {
  const half = s.L / 2;
  const mx = (w.a[0] + w.b[0]) / 2, my = (w.a[1] + w.b[1]) / 2;
  const ux = s.ux * sign, uy = s.uy * sign;
  const ex = (sign > 0 ? w.b[0] : w.a[0]), ey = (sign > 0 ? w.b[1] : w.a[1]);
  // 1. EXTENSION: first barrier seen from the endpoint (t~0 => it already touches there, we do
  //    not move; no barrier => we do not extend on this side).
  let ext: number | null = null;
  const fromEnd = v5RayHits(P, ex, ey, ux, uy, w.id, -V5_JOIN_TOL);
  if (fromEnd.length) ext = half + fromEnd[0]!.t;
  // 2. TRIM: a wall never leaves the outline.
  let trim: number | null = null;
  const fromMid = v5RayHits(P, mx, my, ux, uy, w.id, 0.5);
  for (const h of fromMid) { if (h.outline) { trim = h.t; break; } }
  const t = (ext != null && trim != null) ? Math.min(ext, trim) : (ext != null ? ext : trim);
  if (t == null || !isFinite(t) || t <= 0.5) return null;
  return [v5R2(mx + ux * t), v5R2(my + uy * t)];
}

/**
 * TRIM ONLY: every endpoint that LEAVES the outline is brought back onto it, and nothing else
 * moves. Serves free-standing partitions, which keep their ends but are not allowed to overflow
 * the home.
 */
function v5TrimWall(P: PlanV5 | null | undefined, w: Mur, s: SegmentMur): Mur {
  const poly = P && Array.isArray(P.outline) ? P.outline : null;
  if (!poly || poly.length < 3) return w;
  for (const sign of [1, -1] as const) {
    const ux = s.ux * sign, uy = s.uy * sign;
    const ex = (sign > 0 ? w.b[0] : w.a[0]), ey = (sign > 0 ? w.b[1] : w.a[1]);
    if (pointInPoly(ex, ey, poly)) continue;          // this end is inside: leave it alone
    // THE RAY STARTS FROM THE OTHER END, NOT THE MIDPOINT. When an endpoint is far outside, the
    // wall's MIDPOINT can be outside too: a ray cast from there never crosses the outline going
    // outward again, and the trim would not happen. The other end, on the other hand, is the only
    // point we know is on the right side when there is still something to trim.
    const ox = (sign > 0 ? w.a[0] : w.b[0]), oy = (sign > 0 ? w.a[1] : w.b[1]);
    if (!pointInPoly(ox, oy, poly)) continue;         // BOTH ends outside: we do not guess
    const hits = v5RayHits(P, ox, oy, ux, uy, w.id, 0.5);
    let t: number | null = null;
    for (const h of hits) { if (h.outline) { t = h.t; break; } }
    if (t == null || !isFinite(t) || t <= 0.5) continue;
    const p: Pt = [v5R2(ox + ux * t), v5R2(oy + uy * t)];
    if (sign > 0) w.b = p; else w.a = p;
  }
  return w;
}

/** Mutates `w`: both endpoints are recomputed. Returns the wall, as the old code did. */
export function v5ThroughWall(P: PlanV5 | null | undefined, w: Mur): Mur {
  const s = v5Seg(w);
  // A FREE-STANDING PARTITION DOES NOT EXTEND. It is still TRIMMED by the outline (free does not
  // mean "allowed to leave the home"), but no endpoint is pushed out looking for a barrier: that
  // is exactly what makes it stay where it was placed.
  if (w.free) return v5TrimWall(P, w, s);
  const nb = v5ThroughEnd(P, w, s, 1), na = v5ThroughEnd(P, w, s, -1);
  if (nb) w.b = nb;
  if (na) w.a = na;
  return w;
}

// Does a wall ALREADY carry the segment a->b? (same support line within `tol`, and at least 60%
// of the requested length already covered). Serves to refuse a second stroke on an existing
// partition: two strokes at the same spot = two overlapping walls, the second invisible, and
// "Delete wall" only removes one (see `v5DedupeWalls`, modele/murs.ts).
export function v5WallCovering(
  P: PlanV5 | null | undefined,
  a: Pt,
  b: Pt,
  tol?: number,
): Mur | null {
  if (!P) return null;
  const t = (tol == null ? 4 : tol);
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
  if (L < 1) return null;
  const ux = dx / L, uy = dy / L;
  for (const w of (P.walls || [])) {
    if (w.isOutline) continue;
    const s = v5Seg(w);
    if (Math.abs(s.ux * uy - s.uy * ux) > 0.035) continue;               // not collinear (~2°)
    const d1 = Math.abs((w.a[0] - a[0]) * (-uy) + (w.a[1] - a[1]) * ux);
    const d2 = Math.abs((w.b[0] - a[0]) * (-uy) + (w.b[1] - a[1]) * ux);
    if (d1 > t || d2 > t) continue;
    const t1 = (w.a[0] - a[0]) * ux + (w.a[1] - a[1]) * uy, t2 = (w.b[0] - a[0]) * ux + (w.b[1] - a[1]) * uy;
    const lo = Math.max(0, Math.min(t1, t2)), hi = Math.min(L, Math.max(t1, t2));
    if (hi - lo >= L * 0.6) return w;
  }
  return null;
}

// Outline walls = mirror of the outline's edges (support for exterior windows/outlets).
// Rematched by support line so openings survive an outline move.
// Mutates `P`: `P.walls` is rewritten (interior walls first, outline walls next) and the openings
// of vanished outline walls are carried away with them.
export function v5SyncOutlineWalls(P: PlanV5 | null | undefined): void {
  if (!P) return;
  const O = P.outline || [], n = O.length;
  const old = (P.walls || []).filter((w) => w.isOutline);
  const inner = (P.walls || []).filter((w) => !w.isOutline);
  const taken = new Set<Mur>(), keep: Mur[] = [];
  for (let i = 0; i < n; i++) {
    const a = O[i]!, b = O[(i + 1) % n]!;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1) continue;
    const k = v5LineKey(a, b);
    let w = old.find((o) => !taken.has(o) && v5SameLine(v5LineKey(o.a, o.b), k, 6));
    if (!w) w = old.find((o) => !taken.has(o));
    if (w) { taken.add(w); w.a = [a[0], a[1]]; w.b = [b[0], b[1]]; w.t = w.t || WALL; }
    // OUTLINE wall: an entity derived from the outline, recomputed identically on both sides ->
    // identifier WITHOUT a device tag (see v5DerivedId, js/51).
    else w = { id: v5DerivedId(P, "w"), a: [a[0], a[1]], b: [b[0], b[1]], t: WALL, isOutline: true };
    keep.push(w);
  }
  const gone = old.filter((o) => !taken.has(o));
  if (gone.length) {
    const ids = new Set(gone.map((w) => String(w.id)));
    for (let i = (P.openings || []).length - 1; i >= 0; i--) {
      if (ids.has(String(P.openings[i]!.wallId))) P.openings.splice(i, 1);
    }
  }
  P.walls.length = 0;
  inner.forEach((w) => P.walls.push(w));
  keep.forEach((w) => P.walls.push(w));
}

// =================================================================================================
//  WHAT DEPENDS ON A WALL FOLLOWS THAT WALL: THE GESTURE AUTHOR'S CLAMPING
// =================================================================================================
// Openings stay INSIDE their wall, on EVERY wall: this is the clamping done for the AUTHOR of a
// geometry gesture. What was moved or shrunk is remembered, and reported on release. The per-wall
// rule itself lives in `v5ClampOpeningsOfWall` (modele/murs.ts): PURE, MONOTONIC, NARROW.

let ardoiseBorned: ChangementOuverture[] | null = null;

/** The last clamping's slate, without clearing it (the old `v5LastBorned`). */
export function v5LastBorned(): ChangementOuverture[] | null {
  return ardoiseBorned;
}

export function v5ClampOpenings(P: PlanV5 | null | undefined): void {
  if (!P) return;
  const murs = new Set((P.openings || []).map((o) => String(o.wallId)));
  let chg: ChangementOuverture[] = [];
  murs.forEach((id) => { chg = chg.concat(v5ClampOpeningsOfWall(P, id)); });
  if (chg.length) ardoiseBorned = (ardoiseBorned || []).concat(chg).slice(0, 50);
}

/**
 * A clamp that MOVES or SHRINKS something gets reported, just as moving to a thinner wall already
 * does (`v5FlushOpeningThinned`). One single message per gesture, the first one named.
 * Returns the TEXT (the old code called `toast(texte,{geste:true})` right here) or `null`.
 */
export function v5FlushOpeningsBorned(): string | null {
  const l = ardoiseBorned;
  ardoiseBorned = null;
  if (!l || !l.length) return null;
  const r = l[0]!, quoi = r.name ? `“${r.name}”` : "an opening";
  const n = l.length > 1 ? ` (and ${l.length - 1} other${l.length > 2 ? "s" : ""})` : "";
  if (r.quoi === "aminci") return `This wall is thinner: ${quoi} goes from ${r.de} to ${r.a} cm deep${n}.`;
  if (r.quoi === "retrecie") return `This wall is shorter: ${quoi} goes from ${r.de} to ${r.a} cm wide${n}.`;
  if (r.quoi === "orpheline") return `The wall is gone: ${quoi} with it${n}.`;
  return `This wall is shorter: ${quoi} was brought back inside${n}.`;
}

// Would opening `op`, placed on face `side` of ITS wall, run into an object there? Returns the
// obstruction (the first one found) or null. Serves the refusal of "Changer de côté": the only
// way to create a stack on one face, once back-to-back is allowed.
export function v5OpeningBlockerOnSide(
  P: PlanV5 | null | undefined,
  op: Ouverture | null | undefined,
  side: 0 | 1,
  calques?: CalquesVisibles,
): Ouverture | null {
  if (!P || !op) return null;
  const vis = calques || {};
  const probe = { type: op.type, side };
  return (P.openings || []).find((q) => q !== op && String(q.wallId) === String(op.wallId)
    && v5OpeningSameSlot(probe, q) && pieceVisible(q, vis)
    && op.t0 < q.t0 + q.w && op.t0 + op.w > q.t0) || null;
}

// =================================================================================================
//  A PIECE OF FURNITURE STAYS IN ITS CELL (G-6, G-7)
// =================================================================================================
// The wall inset itself (`clampCenterToInset`, and the G-6 / G-7 guards it holds) belongs to
// `gestes/contraintes.ts` (js/19): it is IMPORTED, never recopied. A second version of that guard
// is exactly how the 372 cm sofa comes back.
//
// `v5LastFit` says whether the LAST clamped piece of furniture really fit in its cell: when it
// overflows, the gesture that just released it SAYS SO (js/17, js/16) instead of letting it go
// silently.
let ardoiseFit = true;

export function v5LastFit(): boolean {
  return ardoiseFit;
}

export interface OptionsClampPiece {
  /**
   * this piece of furniture was ALREADY outside a cell when the hand grabbed it. Bringing it back
   * to the nearest cell would be a mass correction disguised as a gesture: measured, a radiator
   * straddling a wall traveled 113 cm on the first drag, silently (js/17).
   */
  gardeOrphelin?: boolean | undefined;
}

/**
 * A piece of furniture stays inside ITS cell, inset by half a wall thickness. Mutates `p`.
 * `tol` (cm): penetration already tolerated before the gesture (`pieceTol`, js/19, which stays
 * with its owner: it is passed in as an argument, exactly as it is today).
 */
export function v5ClampPiece(P: PlanV5, p: Meuble, tol?: number, opts?: OptionsClampPiece): void {
  if (!planUtilisable(P) || isWallMount(p.type)) return;
  let cx = p.x + p.w / 2, cy = p.y + p.h / 2;
  let cell: Cellule | null = v5CellsAt(P, cx, cy);
  if (!cell && opts && opts.gardeOrphelin) { ardoiseFit = true; return; }
  if (!cell) {                                   // outside a cell: bring back to the nearest one
    let bd = Infinity;
    (P.cells || []).forEach((c) => {
      const np = nearestOnPoly(cx, cy, c.poly);
      if (np.dist < bd) { bd = np.dist; cell = c; }
    });
    if (cell) {
      const np = nearestOnPoly(cx, cy, (cell as Cellule).poly);
      const pl = poleOfInaccessibility((cell as Cellule).poly);
      const ix = pl.x - np.x, iy = pl.y - np.y;
      const m = Math.hypot(ix, iy) || 1;
      cx = np.x + ix / m * 2; cy = np.y + iy / m * 2;
    }
  }
  if (!cell) { ardoiseFit = true; return; }
  const r = clampCenterToInset(cx, cy, p.w, p.h, p.rot || 0, (cell as Cellule).poly, tol);
  ardoiseFit = (r.fits !== false);
  p.x = Math.round(r.cx - p.w / 2); p.y = Math.round(r.cy - p.h / 2);
}

// ---- WE NEVER RENORMALIZE SILENTLY (G-8) ---------------------------------------------------------
// `v5ClampPiece` is the INTERACTIVE clamp: it applies to the object that was just released, and it
// is allowed to push it against the wall. The MASS clamp, on the other hand, used to run on every
// structural change and sweep back over all 47 pieces of furniture in the plan: on the real plan,
// 16 of them jumped (up to 114 cm) because they had been placed before this inset existed. Only
// one was truly lost; the other 15 simply bit into the 6 cm inset by a few centimeters and were
// exactly where they were meant to be. Consequence: the plan shown on open was not the plan you
// had, and the first click rewrote it without a word.
// DECISION: the mass clamp now touches ONLY ORPHANED furniture (center in no cell: no room houses
// it anymore, a genuine repair), and it SAYS SO.
//
// ---- THE BANNER BELONGS TO THE AUTHOR OF THE GESTURE ----------------------------------------------
// The mass clamp runs on every LOCAL geometry gesture, but it also repairs furniture that a PEER's
// op just orphaned: that is what made the message erratic. Measured across three devices:
// "'Radiateur 3' is no longer in any room..." showed up on 2 screens out of 3, and sometimes on
// the one that had done nothing rather than on the author's, because whoever did the NEXT geometry
// gesture inherited the announcement.
// So we remember the orphans created by the wire (`v5NoteForeignOrphans`, called on receipt,
// js/43): their repair still happens, but SILENTLY. On the author's side, that same piece of
// furniture is already an orphan BEFORE its op leaves: it is that device, and only that device,
// that announces it.

const v5ForeignOrphans = new Set<string>();
const V5_FOREIGN_MAX = 500;

export function v5NoteForeignOrphans(P: PlanV5 | null | undefined): void {
  if (!P) return;
  (P.pieces || []).forEach((p) => {
    if (isWallMount(p.type)) return;
    if (!v5CellsAt(P, p.x + p.w / 2, p.y + p.h / 2)) v5ForeignOrphans.add(String(p.id));
  });
  while (v5ForeignOrphans.size > V5_FOREIGN_MAX) {
    v5ForeignOrphans.delete(v5ForeignOrphans.values().next().value as string);
  }
}

export interface BilanClampPieces {
  /** number of orphaned pieces of furniture repaired (what the old `v5ClampPieces()` returned) */
  perdus: number;
  /** the message to display, or null. Without `{geste:true}`: this banner never carried one. */
  message: string | null;
}

export function v5ClampPieces(P: PlanV5 | null | undefined): BilanClampPieces {
  if (!P) return { perdus: 0, message: null };
  const perdus = (P.pieces || []).filter((p) => !isWallMount(p.type) && !v5CellsAt(P, p.x + p.w / 2, p.y + p.h / 2));
  // Orphans inherited from a received op are repaired without a word: their author already said it.
  const miens = perdus.filter((p) => !v5ForeignOrphans.has(String(p.id)));
  perdus.forEach((p) => { v5ClampPiece(P, p); v5ForeignOrphans.delete(String(p.id)); });
  ardoiseFit = true;
  let message: string | null = null;
  if (miens.length) {
    message = miens.length === 1
      ? `“${miens[0]!.name || "A piece"}” was no longer in any room: it was brought back inside.`
      : `${miens.length} pieces were no longer in any room: they were brought back inside.`;
  }
  return { perdus: perdus.length, message };
}

// =================================================================================================
//  PLACING, PASTING, MOVING A WALL-MOUNTED OBJECT
// =================================================================================================

export interface MurLePlusProche {
  w: Mur;
  x: number;
  y: number;
  dist: number;
}

/**
 * Nearest wall to an apartment point (outline walls included), within `maxDist`.
 * `maxDist` is REQUIRED: the old `wallSnapReach()` fallback (js/05) depends on the current zoom,
 * hence on the VIEW. Letting this function guess it would make it impure without saying so.
 */
export function v5NearestWall(
  P: PlanV5 | null | undefined,
  x: number,
  y: number,
  maxDist: number,
): MurLePlusProche | null {
  if (!P) return null;
  let best: MurLePlusProche | null = null, bd = maxDist;
  (P.walls || []).forEach((w) => {
    const c = closestOnSeg(x, y, w.a[0], w.a[1], w.b[0], w.b[1]);
    if (c.dist <= bd) { bd = c.dist; best = { w, x: c.x, y: c.y, dist: c.dist }; }
  });
  return best;
}

// Which side of the wall the wall-mounted object must FACE (its local +y). side=0 => left normal
// n0=(-uy,ux) (see v5OpeningBox: rot = ang + 180*side, and the local +y of rot=ang equals n0).
// We take the CURSOR's side; on an outline wall (only one adjacent cell) we force the interior.
// `_w`: the old code takes the wall as an argument and NEVER reads it (everything goes through
// `s`). The parameter is kept so the call stays readable, prefixed so the compiler tolerates it.
export function v5WallMountSide(
  P: PlanV5 | null | undefined,
  _w: Mur,
  s: SegmentMur,
  px: number,
  py: number,
  x: number,
  y: number,
): 0 | 1 {
  const n0 = { x: -s.uy, y: s.ux };
  let side: 0 | 1 = (((x - px) * n0.x + (y - py) * n0.y) >= 0) ? 0 : 1;
  const off = WALL / 2 + 6;
  const cA = !!v5CellsAt(P, px + n0.x * off, py + n0.y * off);
  const cB = !!v5CellsAt(P, px - n0.x * off, py - n0.y * off);
  if (cA && !cB) side = 0; else if (cB && !cA) side = 1;
  return side;
}

// ---- TOOL 6: ANTI-OVERLAP SETTLING (js/53) ---------------------------------------------------------
// 1-D non-overlap between openings of the same family AND THE SAME FACE (`v5OpeningSameSlot`): a
// through opening (door/window) crosses the wall and blocks both faces, a surface device (wall
// light, outlet, RJ45) only blocks its own.
// PORTED HERE and exported even though it comes from js/53: placing, pasting, and moving an
// opening all three call it, and making yet another copy would be the second version of a rule
// that is only allowed to exist once.
export function v5ResolveOpening(
  P: PlanV5 | null | undefined,
  op: Ouverture,
  dir: number,
  calques?: CalquesVisibles,
): void {
  if (!P) return;
  const w = v5WallById(P, op.wallId);
  if (!w) return;
  const s = v5Seg(w), halfW = op.w / 2;
  let t = op.t0 + halfW;
  const vis = calques || {};
  const nbs: { lo: number; hi: number }[] = [];
  (P.openings || []).forEach((q) => {
    if (q === op || String(q.wallId) !== String(op.wallId)) return;
    if (!v5OpeningSameSlot(op, q) || !pieceVisible(q, vis)) return;
    nbs.push({ lo: q.t0, hi: q.t0 + q.w });
  });
  for (let pass = 0; pass < nbs.length + 1; pass++) {
    let hit: { lo: number; hi: number } | null = null;
    for (const nb of nbs) { if (t - halfW < nb.hi && t + halfW > nb.lo) { hit = nb; break; } }
    if (!hit) break;
    const toLeft = hit.lo - halfW, toRight = hit.hi + halfW;
    if (dir < 0) t = toLeft; else if (dir > 0) t = toRight;
    else t = (Math.abs(t - toLeft) <= Math.abs(t - toRight)) ? toLeft : toRight;
  }
  let bestGap = Infinity, bestT = t;
  for (const nb of nbs) {
    const gL = nb.lo - (t + halfW), gR = (t - halfW) - nb.hi;
    if (gL > 0 && gL < bestGap) { bestGap = gL; bestT = nb.lo - halfW; }
    if (gR > 0 && gR < bestGap) { bestGap = gR; bestT = nb.hi + halfW; }
  }
  if (bestGap > 0 && bestGap <= 6) t = bestT;
  op.t0 = v5R2(clamp(t - halfW, 0, Math.max(0, s.L - op.w)));
}

/**
 * WHAT PLACEMENT CANNOT MANUFACTURE ON ITS OWN.
 * `v5NewId` (js/51) draws a device tag from the realtime socket or from `sessionStorage`: this is
 * not a function of the plan, it cannot live here. `autoName` (js/07) numbers a name by looking at
 * `state.pieces`. Both are therefore INJECTED, and placement remains a pure function of the plan.
 */
export interface FabriqueOuverture {
  /** identifier unique per family, device tag included (`v5NewId`, js/51) */
  newId(prefix: string): Id;
  /** name free of duplicates (`autoName`, js/07) */
  autoName(base: string): string;
}

// Placing a wall-mounted object (door/window/wall light/outlet/RJ45) = creating a parametric
// OPENING on the nearest wall. Returns the created opening, or null if no wall is in reach.
// The old code chained `v5Touch(); selReplace(op.id); render(); openInspector();`: that is screen
// work, the caller handles it.
export function v5PlaceWallMount(
  P: PlanV5 | null | undefined,
  type: string,
  x: number,
  y: number,
  maxDist: number,
  fab: FabriqueOuverture,
  calques?: CalquesVisibles,
): Ouverture | null {
  if (!P) return null;
  const nw = v5NearestWall(P, x, y, maxDist);
  if (!nw) return null;
  const w = nw.w, s = v5Seg(w), t: Partial<ItemCatalogue> = TYPEMAP[type] || {};
  const want = t.w || 60;
  const ow = Math.min(want, s.L);
  // The wall is shorter than the object: we place what fits, and `v5FlushPlaceNarrowed` reports
  // it at the end of the gesture (js/16). Without that word, the door was born at 43 cm without
  // anything announcing it.
  ardoiseNarrowed = (ow < want - 0.5) ? { len: Math.round(s.L), want: Math.round(want), name: t.name || type } : null;
  const tc = (x - w.a[0]) * s.ux + (y - w.a[1]) * s.uy;
  const op: Ouverture = {
    id: fab.newId("o"), wallId: String(w.id),
    // The CATALOG depth (12 cm) is a default, not a user choice: on a thinner wall it follows the
    // wall, without a word (nothing chosen is lost).
    t0: v5R2(clamp(tc - ow / 2, 0, Math.max(0, s.L - ow))), w: ow, h: v5OpeningDepthFor(w, t.h || WALL), type,
    side: v5WallMountSide(P, w, s, nw.x, nw.y, x, y), name: fab.autoName(t.name || ""),
  };
  if (type === "door" || type === "sdoor") op.hinge = 0;
  if (type === "door") op.swing = 1;
  P.openings.push(op);
  v5ResolveOpening(P, op, 0, calques);
  return op;
}

/** What a paste knows about the copied object: its type, and the rest at best. */
export type SourceCollage = Pick<Ouverture, "type"> & Partial<Ouverture>;

// ---- PASTING A WALL-MOUNTED OBJECT -----------------------------------------------------------------
// A wall-mounted object has no coordinates: it belongs to a WALL (`wallId`, `t0`, `side`).
// "Pasting it at point P" therefore only makes sense by ATTACHING it to the wall nearest P,
// exactly as a drag or a placement from the palette does. We keep its width, depth, name, hinges,
// and swing direction; the FACE, on the other hand, is recomputed from the paste point, because
// that is the only thing the new wall can say. Returns the opening, or null if no wall is in
// reach (the caller SAYS SO).
export function v5PasteWallMount(
  P: PlanV5 | null | undefined,
  src: SourceCollage | null | undefined,
  x: number,
  y: number,
  maxDist: number,
  fab: FabriqueOuverture,
  calques?: CalquesVisibles,
): Ouverture | null {
  if (!P || !src) return null;
  const nw = v5NearestWall(P, x, y, maxDist);
  if (!nw) return null;
  const w = nw.w, s = v5Seg(w), t: Partial<ItemCatalogue> = TYPEMAP[src.type] || {};
  const want = src.w || t.w || 60;
  const ow = Math.min(want, s.L);
  ardoiseNarrowed = (ow < want - 0.5)
    ? { len: Math.round(s.L), want: Math.round(want), name: src.name || t.name || src.type }
    : null;
  const tc = (x - w.a[0]) * s.ux + (y - w.a[1]) * s.uy;
  const op: Ouverture = {
    id: fab.newId("o"), wallId: String(w.id),
    t0: v5R2(clamp(tc - ow / 2, 0, Math.max(0, s.L - ow))), w: ow,
    h: v5OpeningDepthFor(w, src.h || t.h || WALL), type: src.type,
    side: v5WallMountSide(P, w, s, nw.x, nw.y, x, y), name: fab.autoName(src.name || t.name || src.type),
  };
  if (src.hinge !== undefined) op.hinge = src.hinge;
  if (src.swing !== undefined) op.swing = src.swing;
  P.openings.push(op);
  v5ResolveOpening(P, op, 0, calques);
  return op;
}

// v5: bring opening `op` to the APARTMENT point (x,y). ONE single implementation, shared by
// pointer dragging, the keyboard arrow, and the test hook. No notion of room: we look for the
// nearest wall among ALL walls, we change `wallId` if another one is closer, we re-orient `side`
// onto the cursor's CELL (so the other face of the same wall flips the object), then we set t0.
// `dir` = direction of movement along the wall (for anti-overlap settling). Returns the opening.
// A wall that is TOO SHORT does not take the opening. Before, `op.w=Math.min(op.w,s.L)` shaved the
// door down to the length of the targeted wall: an 80 cm door briefly placed on a 43 cm stub of
// wall came back at 43 cm, PERMANENTLY (bringing it back home gave it nothing back, the desired
// width no longer existed anywhere). Since the server accepts no unknown key (live-worker/ops.ts),
// we cannot keep the desired width on the side: we therefore REFUSE the drop, and we say so.

/** last wall refused during the current gesture (for the end-of-gesture message) */
export interface RefusOuverture {
  len: number;
  need: number;
  name: string;
}

/** depth brought back down to the arrival wall's thickness (reported at the end) */
export interface AmincissementOuverture {
  t: number;
  avant: number;
  name: string;
}

let ardoiseRefus: RefusOuverture | null = null;
let ardoiseThinned: AmincissementOuverture | null = null;

export function v5LastRefus(): RefusOuverture | null {
  return ardoiseRefus;
}

export function v5LastThinned(): AmincissementOuverture | null {
  return ardoiseThinned;
}

export function v5OpeningFitsWall(op: Pick<Ouverture, "w">, w: Pick<Mur, "a" | "b">): boolean {
  return v5Seg(w).L + 0.5 >= op.w;
}

export function v5MoveOpeningTo(
  P: PlanV5 | null | undefined,
  op: Ouverture,
  x: number,
  y: number,
  dir: number,
  maxDist: number,
  calques?: CalquesVisibles,
): Ouverture | null {
  const nw = v5NearestWall(P, x, y, maxDist);
  if (nw && String(nw.w.id) !== String(op.wallId)) {
    if (v5OpeningFitsWall(op, nw.w)) op.wallId = String(nw.w.id);
    else ardoiseRefus = { len: Math.round(v5Seg(nw.w).L), need: Math.round(op.w), name: op.name || "" };
  }
  const w = v5WallById(P, op.wallId);
  if (!w) return null;
  // THE ARRIVAL WALL CAN BE THINNER. Depth belongs to the wall: it follows the wall DOWNWARD
  // (otherwise the object would overflow both sides of the new wall and repaint the floor), never
  // upward (nobody asked to thicken a window by moving it). This is not a refusal, unlike width: a
  // width is CHOSEN, a depth is dictated by the wall. It is reported on release
  // (v5FlushOpeningThinned), and Escape restores the previous depth (js/53).
  const hMax = v5OpeningDepthMax(w);
  if (Math.round(Number(op.h) || WALL) > hMax) {
    ardoiseThinned = { t: hMax, avant: Math.round(Number(op.h) || WALL), name: op.name || "" };
    op.h = hMax;
  }
  const s = v5Seg(w);
  if (op.type !== "door" && op.type !== "sdoor") {
    const c = closestOnSeg(x, y, w.a[0], w.a[1], w.b[0], w.b[1]);
    op.side = v5WallMountSide(P, w, s, c.x, c.y, x, y);
  }
  const tc = (x - w.a[0]) * s.ux + (y - w.a[1]) * s.uy;
  op.w = Math.min(op.w, s.L);
  op.t0 = v5R2(clamp(tc - op.w / 2, 0, Math.max(0, s.L - op.w)));
  v5ResolveOpening(P, op, dir || 0, calques);
  return op;
}

/** End-of-gesture message: a refused drop must not go unnoticed. */
export function v5FlushOpeningRefus(): string | null {
  const r = ardoiseRefus;
  ardoiseRefus = null;
  if (!r) return null;
  return `This wall is ${r.len} cm: too short for “${r.name || "this object"}” (${r.need} cm).`;
}

/** Same, for the DEPTH brought down to the arrival wall's thickness: the value changed, it is reported. */
export function v5FlushOpeningThinned(): string | null {
  const r = ardoiseThinned;
  ardoiseThinned = null;
  if (!r) return null;
  return `This wall is ${r.t} cm thick: “${r.name || "this object"}” goes from ${r.avant} to ${r.t} cm deep.`;
}

// ---- A SHAVED-DOWN PLACEMENT IS REPORTED -----------------------------------------------------------
// Placing a 90 cm door on a 43 cm wall does not refuse it (at PLACEMENT time, no width has been
// chosen yet: it is the catalog default), but the resulting width is not the one you think you
// got. Measured in a real session: nothing was ever announced, not even on the first try.
// Moving an opening that is ALREADY placed remains a refusal (v5FlushOpeningRefus): there, a
// chosen width would be destroyed.

export interface PoseRabotee {
  len: number;
  want: number;
  name: string;
}

let ardoiseNarrowed: PoseRabotee | null = null;

export function v5LastNarrowed(): PoseRabotee | null {
  return ardoiseNarrowed;
}

export function v5FlushPlaceNarrowed(): string | null {
  const r = ardoiseNarrowed;
  ardoiseNarrowed = null;
  if (!r) return null;
  return `This wall is ${r.len} cm: “${r.name || "this object"}” was placed at ${r.len} cm instead of ${r.want} cm.`;
}

// Snapping a drawn point: outline vertices / wall endpoints > edges > 5 cm grid.
// The drawing snap used to be expressed in PIXELS (14 px), so in cm it grew as you zoomed out: at
// the "Fit" scale of a real apartment it was worth ~18 cm and jumped clean over the real gap
// between two parallel partitions. Deleting one of the two and redrawing it became impossible:
// the stroke stuck to the other one and "Cette cloison est déjà là" refused the wall. So the snap
// is now capped at one wall thickness: it can no longer jump across a gap that genuinely exists.
// `echelle` = the view's `vScale`, `snap` = `state.opts.snap`: two settings that are not part of
// the plan, hence two arguments.

/** The tolerance shared by every point-snap in this file: one wall thickness at most, never less
 * than 8 cm, and shrinking with zoom (14 screen px converted to cm) so it stays a SCREEN-sized
 * target rather than a fixed apartment distance. */
function v5SnapTol(echelle: number): number {
  return Math.min(WALL, Math.max(8, 14 / (echelle || 1)));
}

/**
 * VERTEX-ONLY snap: outline corners and interior wall endpoints, nothing else (no edge, no grid).
 * Factored out of `v5SnapPoint` so a caller that needs to know "did this land EXACTLY on an
 * existing joint" (closing a room by drawing back onto another wall's end, `gestes/murs.ts`) can
 * ask the same question `v5SnapPoint` already answers first, without a second notion of snapping.
 * Returns null outside `tol` cm (see `v5SnapTol`).
 */
export function v5SnapVertex(P: PlanV5 | null | undefined, x: number, y: number, echelle: number): Pt | null {
  if (!P) return null;
  const tol = v5SnapTol(echelle);
  let best: Pt | null = null, bd = tol;
  const tryPt = (q: Pt): void => {
    const d = Math.hypot(q[0] - x, q[1] - y);
    if (d <= bd) { bd = d; best = [q[0], q[1]]; }
  };
  (P.outline || []).forEach((q) => tryPt(q));
  (P.walls || []).forEach((w) => { if (!w.isOutline) { tryPt(w.a); tryPt(w.b); } });
  return best ? [v5R2((best as Pt)[0]), v5R2((best as Pt)[1])] : null;
}

export function v5SnapPoint(P: PlanV5, x: number, y: number, echelle: number, snap: boolean): Pt {
  const tol = v5SnapTol(echelle);
  const vtx = v5SnapVertex(P, x, y, echelle);
  if (vtx) return vtx;
  let best: Pt | null = null, bd = tol;
  v5Barriers(P, null).forEach((s) => {
    const c = closestOnSeg(x, y, s.a[0], s.a[1], s.b[0], s.b[1]);
    if (c.dist <= bd) { bd = c.dist; best = [c.x, c.y]; }
  });
  if (best) return [v5R2((best as Pt)[0]), v5R2((best as Pt)[1])];
  const st = snap ? 5 : 1;
  return [Math.round(x / st) * st, Math.round(y / st) * st];
}

// ---- SNAP FOR A DRAGGED WALL ENDPOINT (owner's report: "choper les extrémités des murs et
// pouvoir étendre et relier à d'autres murs") -------------------------------------------------
// Same two-stage precedence as `v5SnapPoint` (a junction first, a segment next), reused rather
// than re-invented, but with THREE differences that `v5SnapPoint` cannot serve as-is:
//   1. THE WALL'S OWN TWO ENDPOINTS ARE EXCLUDED. `v5SnapPoint`/`v5SnapVertex` snap onto ANY
//      wall endpoint, including the dragged wall's own FIXED end: dragging the free end back
//      toward it would then "snap" the wall down to zero length the moment the pointer got
//      close, instead of letting the person actually place it there by hand.
//   2. THE TWO TOLERANCES ARE WIDER (15px / 10px vs 14px for both stages of `v5SnapPoint`): a
//      junction that must physically CONNECT two walls needs a more forgiving target than a
//      point merely snapping to an existing line while drawing.
//   3. `snap` (the personal "snapping enabled" setting) plays NO PART here, matching how
//      `v5SnapPoint` itself never gates its own vertex/edge stages on it either (only the
//      GRID fallback, computed by the caller, is gated by that setting): a junction connection
//      is not an optional convenience to turn off, only the grid-rounding fallback is.

/** cm: tolerance for stage 1 (another wall's endpoint, or an outline corner). Mirrors
 * `v5SnapTol`'s shape (a floor, a ceiling at one wall thickness) with the wider px budget the
 * owner's report calls for: a junction has to hold, so it gets a more forgiving target than the
 * drawing tool's own vertex snap. */
function v5SnapTolBout(echelle: number): number {
  return Math.min(WALL, Math.max(8, 15 / (echelle || 1)));
}

/** cm: tolerance for stage 2 (a point ON another wall's segment, or on the outline's own body). */
function v5SnapTolSegment(echelle: number): number {
  return Math.min(WALL, Math.max(6, 10 / (echelle || 1)));
}

/**
 * Where a dragged wall ENDPOINT lands when released near another wall's own endpoint / an
 * outline corner (stage 1, exact), or near another wall's segment / the outline's own body
 * (stage 2, exact). `excludeWallId` is the wall being dragged: its own two endpoints never
 * compete as targets (see file note above). Returns null when nothing is in reach: the caller
 * (`gestes/murs.ts`, `v5WallEndDrop`) then falls back to 45-degree direction quantisation and
 * the grid.
 */
export function v5SnapWallEnd(
  P: PlanV5 | null | undefined,
  excludeWallId: Id,
  x: number,
  y: number,
  echelle: number,
): Pt | null {
  if (!P) return null;
  let bestV: Pt | null = null, bdV = v5SnapTolBout(echelle);
  const tryPt = (q: Pt): void => {
    const d = Math.hypot(q[0] - x, q[1] - y);
    if (d <= bdV) { bdV = d; bestV = [q[0], q[1]]; }
  };
  (P.outline || []).forEach((q) => tryPt(q));
  (P.walls || []).forEach((w) => {
    if (w.isOutline || String(w.id) === String(excludeWallId)) return;
    tryPt(w.a); tryPt(w.b);
  });
  if (bestV) return [v5R2((bestV as Pt)[0]), v5R2((bestV as Pt)[1])];
  let bestE: Pt | null = null, bdE = v5SnapTolSegment(echelle);
  v5Barriers(P, excludeWallId).forEach((s) => {
    const c = closestOnSeg(x, y, s.a[0], s.a[1], s.b[0], s.b[1]);
    if (c.dist <= bdE) { bdE = c.dist; bestE = [c.x, c.y]; }
  });
  if (bestE) return [v5R2((bestE as Pt)[0]), v5R2((bestE as Pt)[1])];
  return null;
}

// ---- WHO IS ALLOWED TO DISAPPEAR (C-13) --------------------------------------------------------
// An OUTLINE WALL is an entity DERIVED from the outline: `v5SyncOutlineWalls` recreates it on the
// next update. Deleting it therefore does not remove the wall, but permanently takes its openings
// with it. The three-outcome verdict lives in `v5WallDeleteVerdict` (modele/murs.ts); here, the
// only question is the LOCAL path: does this particular wall get deleted?
export function v5CanDeleteWall(P: PlanV5 | null | undefined, id: Id): boolean {
  return v5WallDeleteVerdict(P, id) === "ok";
}
