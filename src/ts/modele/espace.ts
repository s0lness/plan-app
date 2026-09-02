// src/ts/modele/espace.ts: THE APARTMENT SPACE, GESTURE SIDE.
// Porté de src/js/05-espace-appartement.js (`wallSnapReach`, `NO_WALL_MSG`).
// The rest of js/05 (`aptToScreen`/`screenToApt`, `pieceById`, the helpers for reading legacy
// rooms) already lives in `rendu/vue.ts`, `app/contexte.ts`, and `modele/salles-anciennes.ts`.

import type { Meuble, PlanV5 } from "../partage/plan.ts";
import { v5NearestWall, v5WallMountSide } from "./edition.ts";
import { v5Seg } from "./murs.ts";

/**
 * Snap reach for a wall-mounted object, in cm. A hardcoded 60 cm was a handful of PIXELS at low
 * zoom: placement almost always missed. So we take the larger of 60 cm and 45 px converted to cm
 * at the current scale, capped at 150 cm so it does not snap to a wall clear across the room.
 */
export const wallSnapReach = (scale: number): number => Math.min(150, Math.max(60, 45 / (scale || 1)));

export const NO_WALL_MSG = "No wall nearby: bring the cursor closer to a wall to place this fitting.";

/**
 * THE WALL MAGNET, FOR EVERY PIECE OF FURNITURE. A piece of furniture is not a wall-mounted
 * opening (it keeps moving freely mid-room), but whenever a wall comes within reach OF ITS BACK it
 * snaps to it: back flush against the face, oriented with the wall, dos au mur. This is what every
 * comparable planner does, and it is what replaces the bounds, the tolerances and the 5 cm grid:
 * out of reach the piece is left exactly where the hand put it, wall or no wall.
 *
 * THE REACH IS MEASURED ON THE BACK, NOT ON THE CENTER, and that is the whole difference with the
 * radiator-only version this generalizes. A radiator is 12 cm deep, so its center is always within
 * a few centimeters of the wall it hugs; a 200 cm deep bed pushed flat against a wall has its
 * center a full metre away, so a reach read at the center could never catch it.
 *
 * PURE: reads the plan, returns where the piece SHOULD land (or null, out of reach), touches
 * nothing and knows nothing about pointers. `maxDist` is the SAME reach as an opening
 * (`wallSnapReach`, computed by the caller): one mechanism, not two. `sansAimant` (Alt held) is the
 * ONE escape hatch, and it is passed rather than read, like every other personal input here.
 *
 * The convention matches `v5OpeningBox` / `v5WallMountSide`: `rot = wall angle + 180·side`, so the
 * piece's local +y (its DEPTH axis, same rotation formula as `pieceCorners` in gestes/guides.ts)
 * points INTO the room, and its back edge (local −y) lands exactly on the wall's face,
 * `t/2 + h/2` from the centerline: neither buried in the wall nor floating off it. That local +y is
 * already the FRONT everywhere else in this app (a chair's seat faces its table, `snapChairToTable`
 * in gestes/contraintes.ts), so "the back goes to the wall" needs no per-type table: the catalogue
 * carries no face flag, and the one convention answers for a sofa, a bed and a plant alike.
 */
export interface AimantMur {
  x: number;
  y: number;
  rot: number;
}

export function meubleWallSnap(
  P: PlanV5 | null | undefined,
  rect: Pick<Meuble, "x" | "y" | "w" | "h">,
  maxDist: number,
  sansAimant?: boolean,
): AimantMur | null {
  if (sansAimant) return null;
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  // The center can be a whole half-depth away from a wall its back is touching, so the SEARCH is
  // widened by that half-depth (plus a wall thickness); the reach itself is then judged on the gap
  // between the back and the face, just below.
  const nw = v5NearestWall(P, cx, cy, maxDist + rect.h / 2 + 12);
  if (!nw) return null;
  const w = nw.w, s = v5Seg(w);
  const off = w.t / 2 + rect.h / 2;   // centerline -> back-flush-on-the-face
  if (Math.abs(nw.dist - off) > maxDist) return null;   // the BACK is out of reach: ordinary furniture
  const side = v5WallMountSide(P, w, s, nw.x, nw.y, cx, cy);
  const ang = Math.atan2(s.uy, s.ux) * 180 / Math.PI + (side ? 180 : 0);
  const rot = ((Math.round(ang) % 360) + 360) % 360;
  const rad = rot * Math.PI / 180;
  // local +y in world, at this rotation (same formula as pieceCorners/pieceAABB): away from the
  // wall centerline, into the room.
  const intoX = -Math.sin(rad), intoY = Math.cos(rad);
  const ncx = nw.x + intoX * off, ncy = nw.y + intoY * off;
  return { x: Math.round(ncx - rect.w / 2), y: Math.round(ncy - rect.h / 2), rot };
}
