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

/** THE FURNITURE MAGNET HAS ITS OWN, SHORT REACH: `wallSnapReach` is sized for an opening's
 * CENTER (60-150cm); applied to furniture it was "too aggressive" (owner's words). A piece
 * attracts only when its back is a dozen screen pixels from the face, 6-20cm depending on zoom. */
export const meubleSnapReach = (scale: number): number => Math.min(20, Math.max(6, 12 / (scale || 1)));

/** Types that LIVE against a wall: they keep the opening's long reach (60 to 150 cm), because
 *  "the radiator does not really snap" with the short one; everything else gets the short reach. */
const TYPES_AU_MUR = new Set(["radiateur"]);
export const porteeAimantMeuble = (type: string, scale: number): number =>
  TYPES_AU_MUR.has(type) ? wallSnapReach(scale) : meubleSnapReach(scale);

export const NO_WALL_MSG = "No wall nearby: bring the cursor closer to a wall to place this fitting.";

/**
 * THE WALL MAGNET, FOR EVERY PIECE OF FURNITURE (G-7): whenever a wall comes within reach OF ITS
 * BACK it snaps to it, back flush, oriented with the wall; out of reach it stays where the hand
 * put it. The reach is measured on the BACK, not the center (a 200cm bed's center never gets
 * close enough for a center-based reach). PURE: returns where the piece should land, or null;
 * `maxDist` is the SAME reach as an opening; `sansAimant` (Alt held) is the one escape hatch.
 * Convention matches `v5OpeningBox`/`v5WallMountSide`: `rot = wall angle + 180·side`, local +y is
 * the FRONT everywhere in this app, so "the back goes to the wall" needs no per-type table.
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
