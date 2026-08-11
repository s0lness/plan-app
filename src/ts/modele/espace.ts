// src/ts/modele/espace.ts — THE APARTMENT SPACE, GESTURE SIDE.
// Porté de src/js/05-espace-appartement.js (`clampCenterToApt`, `wallSnapReach`, `NO_WALL_MSG`).
// The rest of js/05 (`aptToScreen`/`screenToApt`, `pieceById`, the helpers for reading legacy
// rooms) already lives in `rendu/vue.ts`, `app/contexte.ts`, and `modele/salles-anciennes.ts`.

import type { PlanV5 } from "../partage/plan.ts";
import { bboxOfPoly, nearestOnPoly, pointInPoly } from "../geometrie/polygones.ts";

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
