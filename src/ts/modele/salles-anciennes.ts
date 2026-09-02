// src/ts/modele/salles-anciennes.ts: THE COORDINATE FRAME OF LEGACY ROOMS, and nothing else.
// Porté de src/js/05-espace-appartement.js (block "READING a plan in the legacy format").
//
// In the legacy format, each room had ITS OWN frame: a polygon in local coordinates, plus an
// `ax`/`ay` offset saying where to place that frame in the apartment. The four functions below
// exist ONLY to relocate these polygons and this furniture into APARTMENT cm, for the duration
// of the conversion. No structure described here survives `migrate()`: the walls-only model has
// only ONE space (see `partage/plan.ts`).
//
// The rest of js/05 (`aptToScreen`, `pieceById`, `wallMountPreviewApt`, `clampCenterToApt`) is
// view or live-editing territory: it is not here.

import { bboxOfPoly } from "../geometrie/polygones.ts";
import type { BBox } from "../geometrie/polygones.ts";
import type { Pt } from "../partage/plan.ts";

/**
 * An object placed in a legacy room: furniture, doors, and windows were the SAME thing there
 * (a door was a piece of furniture like any other). The string index is faithful to the port:
 * `sanitizeRoomObj` does `{...p, ...}`, so any key unknown to an old plan survives the read.
 */
export interface MeubleAncien {
  id: string | number;
  type: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  locked: boolean;
  /** absent from objects with no hinge; the KEY exists, its value is `undefined` */
  hinge: 0 | 1 | undefined;
  swing: 1 | -1 | undefined;
  [autre: string]: unknown;
}

/** A room as read. `ax`/`ay` = position of its box's top-left corner in the apartment. */
export interface SalleAncienne {
  id: string | number;
  name: string;
  floor: string;
  ax: number | null;
  ay: number | null;
  room: { poly: Pt[] };
  pieces: MeubleAncien[];
}

/** The legacy envelope (the apartment itself), already in apartment coordinates. */
export interface EnveloppeAncienne {
  poly: Pt[];
  floor: string;
  pieces: MeubleAncien[];
}

/** What `readLegacyRooms()` returns: a plan in the legacy format, in memory, never persisted. */
export interface PlanAncien {
  rooms: SalleAncienne[];
  envelope: EnveloppeAncienne | null;
}

/**
 * LOCAL box of a room (polygon as it was entered).
 * This is exactly `bboxOfPoly` (same 420x360 fallback, same `w`/`l` clamped to 1): we call it
 * instead of recopying it.
 */
export function roomLocalBBox(r: SalleAncienne): BBox {
  return bboxOfPoly(r.room.poly);
}

/** Box of a room in APARTMENT space: `ax`/`ay` offset applied, local origin removed. */
export function roomAptBBox(r: SalleAncienne): {
  x0: number; y0: number; x1: number; y1: number; w: number; l: number; lbb: BBox;
} {
  const b = roomLocalBBox(r);
  const ax = r.ax || 0, ay = r.ay || 0;
  return { x0: ax, y0: ay, x1: ax + b.w, y1: ay + b.l, w: b.w, l: b.l, lbb: b };
}

/** Local point (cm) of a room -> apartment cm: the local origin `lbb.min` sits at (ax, ay). */
export function localToApt(r: SalleAncienne, lx: number, ly: number): { x: number; y: number } {
  const b = roomLocalBBox(r);
  return { x: (r.ax || 0) + lx - b.minX, y: (r.ay || 0) + ly - b.minY };
}

/** A room's polygon expressed in APARTMENT cm. */
export function roomAptPoly(r: SalleAncienne): Pt[] {
  const b = roomLocalBBox(r);
  const dx = (r.ax || 0) - b.minX, dy = (r.ay || 0) - b.minY;
  return r.room.poly.map((p) => [p[0] + dx, p[1] + dy] as Pt);
}
