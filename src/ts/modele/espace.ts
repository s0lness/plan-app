// src/ts/modele/espace.ts: THE APARTMENT SPACE, GESTURE SIDE.
// Porté de src/js/05-espace-appartement.js (`clampCenterToApt`, `wallSnapReach`, `NO_WALL_MSG`).
// The rest of js/05 (`aptToScreen`/`screenToApt`, `pieceById`, the helpers for reading legacy
// rooms) already lives in `rendu/vue.ts`, `app/contexte.ts`, and `modele/salles-anciennes.ts`.

import type { Meuble, PlanV5 } from "../partage/plan.ts";
import { bboxOfPoly, nearestOnPoly, pointInPoly } from "../geometrie/polygones.ts";
import { v5NearestWall, v5WallMountSide } from "./edition.ts";
import { v5Seg } from "./murs.ts";

/**
 * G-7. Clamps an apartment-cm center so it cannot leave the outline.
 *
 * `hors` (cm) = overflow ALREADY acquired. A converted floor plan places furniture straddling
 * the outline wall (an 80 cm radiator whose center falls outside the outline). Pulling that
 * center back in on the first gesture catapulted the furniture: measured, "Radiateur 3" jumped
 * 113 cm in response to a push of 30, without a word of warning. So it keeps its overflow,
 * never more: it can move back inward, it cannot go further out.
 */
export function clampCenterToApt(
  P: PlanV5 | null | undefined,
  ax: number,
  ay: number,
  hors?: number,
): { x: number; y: number } {
  const poly = (P && P.outline) || null;
  if (!poly || poly.length < 3) return { x: ax, y: ay };
  if (pointInPoly(ax, ay, poly)) return { x: ax, y: ay };
  const np = nearestOnPoly(ax, ay, poly);
  if ((hors || 0) > 0 && np.dist <= (hors || 0) + 0.01) return { x: ax, y: ay };
  const c = bboxOfPoly(poly);
  const ix = (c.minX + c.maxX) / 2 - np.x, iy = (c.minY + c.maxY) / 2 - np.y;
  const m = Math.hypot(ix, iy) || 1;
  return { x: np.x + ix / m * 2, y: np.y + iy / m * 2 };
}

/**
 * Snap reach for a wall-mounted object, in cm. A hardcoded 60 cm was a handful of PIXELS at low
 * zoom: placement almost always missed. So we take the larger of 60 cm and 45 px converted to cm
 * at the current scale, capped at 150 cm so it does not snap to a wall clear across the room.
 */
export const wallSnapReach = (scale: number): number => Math.min(150, Math.max(60, 45 / (scale || 1)));

export const NO_WALL_MSG = "No wall nearby: bring the cursor closer to a wall to place this fitting.";

/**
 * F1. THE RADIATOR MAGNET: a radiator is a MEUBLE (catalogue.ts), not a wall-mounted opening (it
 * keeps moving freely mid-room, a mobile radiator exists), but whenever a wall comes within reach
 * it snaps to it exactly like an opening would: back flush against the face, dos au mur. Out of
 * reach it is left untouched: an ordinary piece of furniture.
 *
 * PURE: reads the plan, returns where the piece SHOULD land (or null, out of reach), touches
 * nothing and knows nothing about pointers or modifiers. `maxDist` is the SAME reach as an
 * opening (`wallSnapReach`, computed by the caller): one mechanism, not two.
 *
 * The convention matches `v5OpeningBox` / `v5WallMountSide`: `rot = wall angle + 180·side`, so the
 * piece's local +y (its DEPTH axis, same rotation formula as `pieceCorners` in gestes/guides.ts)
 * points INTO the room, and its back edge (local −y) lands exactly on the wall's face,
 * `t/2 + h/2` from the centerline: neither buried in the wall nor floating off it.
 */
export interface AimantMurRadiateur {
  x: number;
  y: number;
  rot: number;
}

export function radiatorWallSnap(
  P: PlanV5 | null | undefined,
  rect: Pick<Meuble, "x" | "y" | "w" | "h">,
  maxDist: number,
): AimantMurRadiateur | null {
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  const nw = v5NearestWall(P, cx, cy, maxDist);
  if (!nw) return null;
  const w = nw.w, s = v5Seg(w);
  const side = v5WallMountSide(P, w, s, nw.x, nw.y, cx, cy);
  const ang = Math.atan2(s.uy, s.ux) * 180 / Math.PI + (side ? 180 : 0);
  const rot = ((Math.round(ang) % 360) + 360) % 360;
  const rad = rot * Math.PI / 180;
  // local +y in world, at this rotation (same formula as pieceCorners/pieceAABB): away from the
  // wall centerline, into the room.
  const intoX = -Math.sin(rad), intoY = Math.cos(rad);
  const off = w.t / 2 + rect.h / 2;   // centerline -> back-flush-on-the-face
  const ncx = nw.x + intoX * off, ncy = nw.y + intoY * off;
  return { x: Math.round(ncx - rect.w / 2), y: Math.round(ncy - rect.h / 2), rot };
}
