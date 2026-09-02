// src/ts/gestes/contraintes.ts: WHAT HOLDS A PIECE OF FURNITURE BACK: the wall inset, and the chair/table snap.
// Ported from src/js/19-contraintes.js.
//
// TWO INVARIANTS LIVE HERE, and both were paid for by a measured incident:
//   G-6 "bounds can never push farther away": each iteration of `clampCenterToInset` must
//       REDUCE the penetration, or it is discarded. Without this guard, a sofa dropped in a
//       too-narrow room would jump 372 cm, outside the flat.
//   G-5 "the round trip returns to the starting point": `snapChairToTable` only attracts within a
//       radius (`CHAIR_SNAP_MAX`), it does not TELEPORT.
//
// A GESTURE ON FURNITURE NEVER COMES THROUGH HERE ANY MORE. Dragging, dropping and resizing bound
// nothing: a piece may straddle a wall, and the wall magnet (`meubleWallSnap`, modele/espace.ts) is
// what settles it. `clampCenterToInset` survives for the paths that place furniture WITHOUT a hand
// on it (the keyboard, the inspector, the Circulation fixes, orphan repair after a wall moves), all
// of them through `v5ClampPiece`.
//
// WHAT CHANGES COMPARED TO THE OLD CLIENT, and that is all: these functions used to read `state.plan`,
// `state.pieces` and `state.opts` from the single closure. They now take the PLAN and the LAYERS as
// ARGUMENTS. None of them render, none of them save, none of them announce anything.

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
// RULE: a clamp can NEVER move an object farther from its arrival position. Each iteration
// must REDUCE the penetration, or it is discarded and we stop there. Without this guard, a
// piece of furniture bigger than the cell would receive four opposing pushes that ADDED UP: the
// sofa dropped in a too-narrow room would jump 372 cm on release, outside the flat,
// where it wasn't even reachable anymore. A tolerated (and announced) overflow beats a
// catapulted object; it is also what makes a bed too big for its room movable again,
// where every drag used to snap it back to its origin.
// `tolIn` (cm): penetration ALREADY TOLERATED before the gesture. We don't correct what was accepted.
// Without it, putting a piece of furniture back EXACTLY where it was would shift it a few centimeters
// (converted plans have furniture placed flush against the wall, under the inset): the round trip
// never returned to the starting point, and the drift would freeze in on the first cycle. We now
// only prevent going FURTHER into the wall, we no longer push back what was already there.
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
  // THE CORRECTION IS AN AVERAGE, NOT A SUM, and this is a fix, not a detail.
  // Each corner that bites produces the vector that is ENOUGH to bring it back in. Adding them up
  // applied the correction ONCE PER CORNER: two corners out, twice too far; four corners,
  // four times. Measured before the fix: a 45×40 object overflowing 10 cm to the right was moved
  // 67 cm instead of 33, and a bed dropped into a corner would fly 203 cm from the hand. That is what
  // "it sends it way too far" means: the object didn't settle AGAINST the wall, it
  // shot across the room. The iteration count goes from 4 to 16: an average converges in small
  // steps where a sum used to overshoot (and swing back the other way on the next iteration).
  for (let iter = 0; iter < 16; iter++) {
    const corners = pieceCorners(bx, by, w, h, rotDeg);
    // WE CORRECT THE MOST DEEPLY PENETRATING CORNER, AND IT ALONE. Adding up the four corrections
    // applied the correction once PER CORNER (two corners out = twice too far, four
    // corners = four times); averaging them stops overshooting but no longer quite gets there.
    // The worst corner, at full correction, takes exactly the step needed, and the others catch up
    // on subsequent passes.
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
  // WHAT DOESN'T FIT DOESN'T MOVE. An object bigger than its cell has its four corners
  // pushing in OPPOSITE directions: no position satisfies them all, and "the least
  // bad one" makes no sense, which is how a 220 cm sofa dropped in a 170 cm corridor
  // used to fly 372 cm away, outside the flat, neither reachable nor recoverable via "Fit". So we
  // leave it UNDER THE HAND and we SAY SO (`fits:false`, which the caller turns into a banner).
  // This is not at odds with "as close to the limit as possible": settling against the wall only
  // makes sense for what CAN settle there.
  if (bw > TOL) {
    // TWO DIFFERENT FAILURES, AND THEY DON'T CALL FOR THE SAME RESPONSE.
    //
    // HUGE residual penetration = the object is bigger than its cell: its corners push
    // in opposite directions, no position satisfies them, and "the least bad one" doesn't
    // exist. We leave it UNDER THE HAND (this is the 220 cm sofa in the 170 cm corridor, which used
    // to fly 372 cm outside the flat).
    //
    // SMALL residual penetration = we simply haven't finished converging. Here, the best
    // position found really is "as close to the limit as possible," and returning it is exactly
    // what we want: keeping it frozen would lock in place an object that just needs one more centimeter.
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
  // A SNAP ATTRACTS, IT DOES NOT TELEPORT. A chair dropped on the top of a large table
  // used to be shot to the nearest edge: measured, 168 cm of jump plus a rotation thrown in,
  // at the exact moment you thought you were putting it back where it was. Beyond CHAIR_SNAP_MAX, we
  // leave the chair wherever the hand put it.
  if (Math.hypot(wx - ccx, wy - ccy) > CHAIR_SNAP_MAX) return null;
  p.x = Math.round(wx - p.w / 2); p.y = Math.round(wy - p.h / 2);
  // chair front (+y local) must face the table: front = -edge-normal (in table local), then to world
  const fnx = -c.nrm.x, fny = -c.nrm.y;                       // local front dir (toward table)
  const wfx = fnx * ca - fny * sa, wfy = fnx * sa + fny * ca; // world front dir
  // rot such that rotating the chair's own front (0,1) by `rot`, THE SAME WAY THE RENDERER
  // ROTATES IT (pieceCorners/CSS `rotate(deg)`: world=(lx*ca'-ly*sa', lx*sa'+ly*ca')), lands on
  // (wfx,wfy). For lx=0,ly=1 that world vector is (-sin(rot), cos(rot)), so
  // wfx=-sin(rot) and wfy=cos(rot) => rot = atan2(-wfx, wfy), NOT atan2(wfx, wfy).
  // MEASURED BUG: atan2(wfx,wfy) mirrors left/right (a chair docked on either side of the table
  // came out rotated 180deg from the other side's correct answer, backrest toward the table
  // instead of away from it; top/bottom were accidentally right because wfx=0 there).
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
