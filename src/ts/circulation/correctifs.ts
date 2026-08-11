// src/ts/circulation/correctifs.ts — PORTED VERBATIM from src/js/37-flow-correctifs.js (61 lines).
//
// The fixes mutate the REAL piece of the state (apartment coordinates), not the copy the
// engine works with: that's what `realPieceById` (js/36) says. `afterFix()` lives in `FL` because
// js/37 calls it and js/38 provides it (`render(); syncInspector(); analyzeNow();`): between two
// real ES modules, writing it here would be a cycle.

import type { Meuble } from "../partage/plan.ts";
import type { Rect } from "./etat.ts";
import { FL } from "./etat.ts";
import { clamp } from "../noyau/nombres.ts";
import { isWallMount } from "../catalogue/catalogue.ts";
import { v5ClampPiece } from "../modele/edition.ts";
import { v5Touch } from "../app/contexte.ts";
import { aptBBox } from "../rendu/vue.ts";
import { frontNormal, pieceAABB, rectGap, rectsOverlap } from "./contexte.ts";

/**
 * `clampPiece` (js/19): a piece of furniture stays within ITS cell, set back by half a wall
 * thickness; a wall-mounted object is a parametric opening, nothing to clamp. Copied here because js/19 is
 * ported inside `gestes/`, where it isn't exported.
 */
function clampPiece(p: Meuble): void {
  if (isWallMount(p.type)) return;
  v5ClampPiece(FL.ctx.etat.plan, p); v5Touch(FL.ctx);
}

// ---- auto-fixes ----
export function nudgeAway(p: Meuble, zone: Rect, door: Meuble): void {
  // move p out of the swing zone, away from the door, up to 60cm
  const db = pieceAABB(door), pb = pieceAABB(p);
  let vx = pb.cx - db.cx, vy = pb.cy - db.cy; const m = Math.hypot(vx, vy) || 1; vx /= m; vy /= m;
  for (let step = 1; step <= 60; step += 2) {
    const nx = p.x + vx * 2, ny = p.y + vy * 2;
    p.x = nx; p.y = ny; clampPiece(p);
    if (!rectsOverlap(zone, pieceAABB(p))) break;
  }
  FL.afterFix();
}
export function moveCoffeeToDist(sofa: Meuble, coffee: Meuble, target: number): void {
  const sb = pieceAABB(sofa), cb = pieceAABB(coffee);
  let vx = cb.cx - sb.cx, vy = cb.cy - sb.cy; const m = Math.hypot(vx, vy) || 1; vx /= m; vy /= m;
  // move along the line to achieve target gap; iterate (gap is nonlinear w/ rotation)
  for (let iter = 0; iter < 40; iter++) {
    const gap = rectGap(pieceAABB(sofa), pieceAABB(coffee));
    const err = target - gap;
    if (Math.abs(err) < 1) break;
    coffee.x += vx * err; coffee.y += vy * err; clampPiece(coffee);
  }
  FL.afterFix();
}
export function resizeRugToSofa(rug: Meuble, sofa: Meuble): void {
  const sb = pieceAABB(sofa), rb = pieceAABB(rug);
  const target = (sb.x1 - sb.x0) + 40;
  const cx = rug.x + rug.w / 2;
  // rug is usually unrotated; set w so its AABB width ~ target
  const ratio = (rb.x1 - rb.x0) / rug.w || 1;
  rug.w = clamp(Math.round(target / ratio), 20, aptBBox(FL.ctx).w);
  rug.x = Math.round(cx - rug.w / 2); clampPiece(rug);
  FL.afterFix();
}
export function slideRugUnderSofa(rug: Meuble, sofa: Meuble): void {
  const sb = pieceAABB(sofa);
  const fn = frontNormal(sofa);
  // place rug center a bit in front of the sofa center
  const tx = sb.cx + fn.x * 20, ty = sb.cy + fn.y * 20;
  rug.x = Math.round(tx - rug.w / 2); rug.y = Math.round(ty - rug.h / 2); clampPiece(rug);
  FL.afterFix();
}
export function pullSofaIn(sofa: Meuble, dist: number): void {
  const b = pieceAABB(sofa), bb = aptBBox(FL.ctx);
  const dl = b.x0 - bb.minX, dr = bb.maxX - b.x1, dt = b.y0 - bb.minY, dbm = bb.maxY - b.y1;
  const m = Math.min(dl, dr, dt, dbm);
  if (m === dt) sofa.y += dist; else if (m === dbm) sofa.y -= dist;
  else if (m === dl) sofa.x += dist; else sofa.x -= dist;
  clampPiece(sofa); FL.afterFix();
}
export function faceToward(sofa: Meuble, target: Meuble): void {
  const sb = pieceAABB(sofa), tb = pieceAABB(target);
  const ang = Math.atan2(tb.cy - sb.cy, tb.cx - sb.cx) * 180 / Math.PI; // direction to target
  // front normal is (sin r, cos r); we want it to point at target => r = 90 - ang... derive:
  // want atan2(fn.y,fn.x)=ang => atan2(cos r, sin r)=ang => r = 90 - ang
  let rot = (90 - ang); rot = ((rot % 360) + 360) % 360;
  rot = Math.round(rot / 15) * 15 % 360;
  sofa.rot = rot; clampPiece(sofa); FL.afterFix();
}
