// src/ts/gestes/contraintes.ts: WHAT HOLDS A PIECE OF FURNITURE BACK: the wall inset, and the
// chair/table snap. Two invariants: G-6 (each iteration of `clampCenterToInset` must REDUCE the
// penetration, or it's discarded) and G-5 (`snapChairToTable` only attracts within a radius, it
// does not teleport).
//
// A GESTURE ON FURNITURE NEVER COMES THROUGH HERE ANY MORE (G-7): dragging bounds nothing, the
// wall magnet settles it. `clampCenterToInset` survives for paths that place furniture WITHOUT a
// hand on it (keyboard, inspector, Circulation fixes, orphan repair), through `v5ClampPiece`.

import { clamp, WALL } from "../noyau/nombres.ts";
import { nearestOnPoly, pointInPoly, signedDistToPoly } from "../geometrie/polygones.ts";
import { pieceVisible, type CalquesVisibles } from "../catalogue/catalogue.ts";
import type { Meuble, PlanV5, Pt } from "../partage/plan.ts";

// Keep a piece INSIDE the room, resting against the wall's inner face (not through it): the piece's
// rotated AABB must stay inside the polygon INSET by half the wall thickness (WALL/2=6cm). We push the
// center inward until all 4 rotated corners clear the inset. Approximate + cheap: a few iterations,
// each nudging the center along the sum of per-corner inward normals. Only pushes if penetration is
// real (> INSET_TOL) so plans with furniture already flush against walls don't visibly jump.

/** 6cm: furniture face rests here, off the wall centerline */
export const WALL_INSET = WALL / 2;
/** don't nudge for <1cm of penetration (avoid jitter / legacy jumps) */
const INSET_TOL = 1;

function pieceCorners(cx: number, cy: number, w: number, h: number, rotDeg: number): Pt[] {
  const a = (rotDeg || 0) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a), hw = w / 2, hh = h / 2;
  const c: Pt[] = [];
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as Pt[]) {
    const lx = sx * hw, ly = sy * hh;
    c.push([cx + lx * ca - ly * sa, cy + lx * sa + ly * ca]);
  }
  return c;
}

/** Worst penetration of the 4 rotated corners (0 = everything is within the inset). */
function insetWorst(
  cx: number, cy: number, w: number, h: number, rotDeg: number, poly: readonly Pt[],
): number {
  let worst = 0;
  for (const [px, py] of pieceCorners(cx, cy, w, h, rotDeg)) {
    const pen = WALL_INSET - signedDistToPoly(px, py, poly);
    if (pen > worst) worst = pen;
  }
  return worst;
}

export interface CentreBorne {
  cx: number;
  cy: number;
  fits: boolean;
}

// Push (cx,cy) inward so every rotated corner is >= WALL_INSET inside poly.
// Returns {cx,cy,fits}; `fits:false` = the object does NOT FIT inside the polygon, it overflows.
// RULE (G-6): a clamp can NEVER move an object farther from its arrival position; each iteration
// must REDUCE the penetration, or it's discarded and we stop there. A tolerated (and announced)
// overflow beats a catapulted object.
// `tolIn` (cm): penetration ALREADY TOLERATED before the gesture, so putting a piece back exactly
// where it was (flush against the wall, under the inset) doesn't drift on the round trip (G-5).
export function clampCenterToInset(
  cx: number, cy: number, w: number, h: number, rotDeg: number,
  poly: readonly Pt[] | null | undefined, tolIn?: number,
): CentreBorne {
  if (!poly || poly.length < 3) return { cx, cy, fits: true };
  const TOL = Math.max(INSET_TOL, tolIn || 0);
  const cx0 = cx, cy0 = cy;   // where the object started from: the only safe position if it doesn't fit
  // Beyond this residual (cm), the penetration is no longer a convergence shortfall but a
  // geometric IMPOSSIBILITY: the object doesn't fit in the cell, period.
  const IRREDUCTIBLE = 5;
  let bx = cx, by = cy, bw = insetWorst(cx, cy, w, h, rotDeg, poly);
  if (bw <= TOL) return { cx: bx, cy: by, fits: true };
  // Summing the four corners' corrections applies the correction once PER CORNER (twice too far
  // with two out, four times with four), so we correct the MOST DEEPLY PENETRATING corner alone,
  // at full correction, and let the others catch up on subsequent passes (16 iterations).
  for (let iter = 0; iter < 16; iter++) {
    const corners = pieceCorners(bx, by, w, h, rotDeg);
    let mvx = 0, mvy = 0, pire = -Infinity;
    for (const [px, py] of corners) {
      const sd = signedDistToPoly(px, py, poly);   // >0 inside, distance to nearest edge
      const pen = WALL_INSET - sd;                  // how far this corner is short of the inset
      if (pen > 0) {
        // inward direction at this corner = toward the nearest interior point
        const np = nearestOnPoly(px, py, poly);
        let dx = bx - np.x, dy = by - np.y; const m = Math.hypot(dx, dy) || 1; dx /= m; dy /= m;
        // if the corner is OUTSIDE (sd would be negative), push toward the boundary point + inset
        const inside = pointInPoly(px, py, poly);
        const dir = inside ? { x: dx, y: dy } : { x: (np.x - px), y: (np.y - py) };
        const dm = Math.hypot(dir.x, dir.y) || 1;
        if (pen > pire) { pire = pen; mvx = dir.x / dm * pen; mvy = dir.y / dm * pen; }
      }
    }
    if (!mvx && !mvy) break;
    const nx = bx + mvx, ny = by + mvy;
    const nw = insetWorst(nx, ny, w, h, rotDeg, poly);
    if (nw >= bw - 1e-6) break;                      // no improvement: keep the arrival position
    bx = nx; by = ny; bw = nw;
    if (bw <= TOL) break;
  }
  // WHAT DOESN'T FIT DOESN'T MOVE: an object bigger than its cell has its four corners pushing in
  // opposite directions, so "the least bad position" makes no sense; leave it under the hand and
  // say so (`fits:false`). Distinguish that from small residual penetration (not yet converged,
  // where the best position found is genuinely "as close to the limit as possible").
  if (bw > TOL) {
    if (bw > TOL + IRREDUCTIBLE) return { cx: cx0, cy: cy0, fits: false };
    return { cx: bx, cy: by, fits: false };
  }
  return { cx: bx, cy: by, fits: true };
}

// Chairs snap TUCKED under tables (feature 4). Respects the table's rotation via a local-frame test.
// Returns the world-direction the chair was snapped toward {x,y} (to suppress that feature-1 guide), else null.
export const TABLE_TYPES = new Set<string>(["dining", "desk", "coffee", "side"]);
/**
 * A snapped chair slides ~22cm UNDER the tabletop edge (real chairs tuck); clamped so at
 * least ~8cm of seat stays outside on shallow chairs. Shared by snapChairToTable + dockedChairs.
 */
const CHAIR_TUCK = 22;
/** cm: reach of the chair->table snap (beyond it, no movement) */
const CHAIR_SNAP_MAX = 40;

const chairTuck = (h: number): number => Math.max(0, Math.min(CHAIR_TUCK, h - 16));

/** A candidate edge of the table, in the table's LOCAL frame. */
interface AreteTable {
  edge: string;
  d: number;
  lx: number;
  ly: number;
  along: "x" | "y";
  extent: number;
  nrm: { x: number; y: number };
}

interface MeilleureArete {
  q: Meuble;
  a: number;
  ca: number;
  sa: number;
  tcx: number;
  tcy: number;
  c: AreteTable;
  hw: number;
  hh: number;
  cd: number;
  cw: number;
}

export function snapChairToTable(
  P: PlanV5 | null | undefined,
  calques: CalquesVisibles,
  p: Meuble,
): { x: number; y: number } | null {
  if (p.type !== "chair" || p.locked) return null;
  const ccx = p.x + p.w / 2, ccy = p.y + p.h / 2;   // chair center (world)
  let best: MeilleureArete | null = null, bestDist = Infinity;
  for (const q of (P && P.pieces) || []) {
    if (!TABLE_TYPES.has(q.type)) continue;
    if (!pieceVisible(q, calques)) continue;   // Feature B: don't snap to a hidden table
    const tcx = q.x + q.w / 2, tcy = q.y + q.h / 2, a = (q.rot || 0) * Math.PI / 180;
    const ca = Math.cos(a), sa = Math.sin(a);
    // chair center into table local frame (rotate by -rot)
    const rx = ccx - tcx, ry = ccy - tcy;
    const lx = rx * ca + ry * sa, ly = -rx * sa + ry * ca;
    const hw = q.w / 2, hh = q.h / 2;
    // nearest of 4 local edges; the chair presents its DEPTH (p.h) side to the table
    const cd = p.h / 2, cw = p.w / 2;   // chair half-depth (faces table), half-width (slides along edge)
    const off = cd - chairTuck(p.h);   // tucked: chair center offset outward from the table edge
    const cands: AreteTable[] = [
      { edge: "top",    d: Math.abs(ly - (-hh)), lx, ly: -hh - off, along: "x", extent: hw, nrm: { x: 0, y: -1 } },
      { edge: "bottom", d: Math.abs(ly - ( hh)), lx, ly:  hh + off, along: "x", extent: hw, nrm: { x: 0, y:  1 } },
      { edge: "left",   d: Math.abs(lx - (-hw)), lx: -hw - off, ly, along: "y", extent: hh, nrm: { x: -1, y: 0 } },
      { edge: "right",  d: Math.abs(lx - ( hw)), lx:  hw + off, ly, along: "y", extent: hh, nrm: { x:  1, y: 0 } },
    ];
    // accept: hovering within ~12cm of flush (no need to push into the table), or anywhere
    // inside the table footprint (nearest edge wins, kills the dead zone on wide tables)
    const inside = Math.abs(lx) <= hw && Math.abs(ly) <= hh;
    for (const c of cands) {
      if (c.d < bestDist && (inside || c.d <= cd + 12)) { bestDist = c.d; best = { q, a, ca, sa, tcx, tcy, c, hw, hh, cd, cw }; }
    }
  }
  if (!best) return null;
  const { ca, sa, tcx, tcy, c, cw } = best;
  // clamp chair along the edge so its width stays within the edge extent
  let lx = c.lx, ly = c.ly;
  if (c.along === "x") { lx = clamp(c.lx, -c.extent + cw, c.extent - cw); }
  else                 { ly = clamp(c.ly, -c.extent + cw, c.extent - cw); }
  // back to world
  const wx = tcx + lx * ca - ly * sa, wy = tcy + lx * sa + ly * ca;
  // A SNAP ATTRACTS, IT DOES NOT TELEPORT (G-5): beyond CHAIR_SNAP_MAX, leave the chair wherever
  // the hand put it.
  if (Math.hypot(wx - ccx, wy - ccy) > CHAIR_SNAP_MAX) return null;
  p.x = Math.round(wx - p.w / 2); p.y = Math.round(wy - p.h / 2);
  // chair front (+y local) must face the table: front = -edge-normal (in table local), then to world
  const fnx = -c.nrm.x, fny = -c.nrm.y;                       // local front dir (toward table)
  const wfx = fnx * ca - fny * sa, wfy = fnx * sa + fny * ca; // world front dir
  // rot such that rotating the chair's own front (0,1) the SAME WAY THE RENDERER does (CSS
  // `rotate(deg)`) lands on (wfx,wfy): rot = atan2(-wfx, wfy), NOT atan2(wfx, wfy) (which mirrors
  // left/right, backrest toward the table instead of away from it).
  p.rot = ((Math.round(Math.atan2(-wfx, wfy) * 180 / Math.PI) % 360) + 360) % 360;
  return { x: wfx, y: wfy };
}

// Feature 1: chairs docked to a given table. Docked = type "chair", not locked, its center
// sits at the TUCKED offset (~tol cm) against one of the table's edges, on the room side of
// that edge, and within the edge's extent. Mirrors snapChairToTable's local-frame geometry.
// Tolerance is widened OUTWARD by CHAIR_TUCK so chairs saved at the old flush position
// (offset = cd, before tucking existed) still count as docked.
export function dockedChairs(
  P: PlanV5 | null | undefined,
  table: Meuble,
  tol?: number,
): Meuble[] {
  const t = tol == null ? 3 : tol;
  if (!TABLE_TYPES.has(table.type)) return [];
  const tcx = table.x + table.w / 2, tcy = table.y + table.h / 2, a = (table.rot || 0) * Math.PI / 180;
  const ca = Math.cos(a), sa = Math.sin(a), hw = table.w / 2, hh = table.h / 2;
  const out: Meuble[] = [];
  for (const p of (P && P.pieces) || []) {
    if (p.type !== "chair" || p.locked || p.id === table.id) continue;
    const ccx = p.x + p.w / 2, ccy = p.y + p.h / 2;
    const rx = ccx - tcx, ry = ccy - tcy;
    const lx = rx * ca + ry * sa, ly = -rx * sa + ry * ca;   // chair center in table local frame
    const cd = p.h / 2;                                       // chair half-depth presented to the table
    const tuck = chairTuck(p.h);
    const lo = (cd - tuck) - t, hi = cd + t;                  // accepted outward-offset band [tucked .. flush]
    // signed outward distance of the chair center past each edge, and along-edge extent test
    const near = [
      { out: -ly - hh, along: Math.abs(lx), extent: hw },   // top
      { out:  ly - hh, along: Math.abs(lx), extent: hw },   // bottom
      { out: -lx - hw, along: Math.abs(ly), extent: hh },   // left
      { out:  lx - hw, along: Math.abs(ly), extent: hh },   // right
    ];
    let hit = false;
    for (const n of near) { if (n.out >= lo && n.out <= hi && n.along <= n.extent + p.w / 2) { hit = true; break; } }
    if (hit) out.push(p);
  }
  return out;
}
