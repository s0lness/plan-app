// src/ts/rendu/etiquettes-disposition.ts: WHERE a room label lands, aware of furniture and of its
// own neighbors (room and furniture labels used to be laid out INDEPENDENTLY, overlapping).
//
// Not pixel-perfect text measurement: width is a character-count ESTIMATE (like `meubles.ts`'s
// `estim`, R-6), generous enough for the monospace-tracked real box. Decides WHERE a room label
// goes, nothing about WHAT gets written (R-2/R-3 in `meubles.ts`/`noms.ts`). A room's name also
// lives in the rail, so a label that cannot be placed without overlap is DROPPED, never forced.
//
// PURE: no DOM, no history, no save; `rendu/calque.ts` is the only caller that touches the DOM.

import type { BBox } from "../geometrie/polygones.ts";
import type { Meuble } from "../partage/plan.ts";
import type { CalquesVisibles } from "../catalogue/catalogue.ts";
import { pieceVisible } from "../catalogue/catalogue.ts";

/** Axis-aligned box in SCREEN px, top-left + size. */
export interface RectPx {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One room label waiting for a spot: `ax`/`ay` is its natural anchor (screen px, pole of inaccessibility). */
export interface CandidatEtiquetteCellule {
  id: string;
  ax: number;
  ay: number;
  texte: string;
  /** Cell area, any unit consistent across candidates: decides placement ORDER, largest first. */
  aire: number;
  /**
   * OPTIONAL: is (x,y), in the SAME screen-px space as `ax`/`ay`, still inside this cell? Without
   * it every nudge is tried; with it, a nudge that would leave the room (and land in a neighbor's
   * territory) is skipped BEFORE the overlap check, so a large room can search far from its pole
   * without ever borrowing a wall from the room next door.
   */
  dansCellule?: ((x: number, y: number) => boolean) | undefined;
}

export const HAUTEUR_ETIQUETTE_CELLULE = 20;
const LARGEUR_CAR = 7.3, LARGEUR_PAD = 14, LARGEUR_MIN = 20;
const ECART = 6;
/**
 * The search grid: HALF-steps (finer than the label's own size) out to `RAYON` steps in every
 * direction, ordered by distance from the anchor so the FIRST clear spot found is also the
 * CLOSEST one. Bounded and deterministic (a fixed comparator, never Map/array iteration order):
 * never an open-ended search, even though it is generous enough to cross a real room (a 4 m
 * kitchen at a working zoom is on the order of ten steps).
 */
const RAYON = 7;
const DECALAGES: ReadonlyArray<readonly [number, number]> = (() => {
  const pts: Array<[number, number]> = [];
  for (let dy = -RAYON; dy <= RAYON; dy++) {
    for (let dx = -RAYON; dx <= RAYON; dx++) pts.push([dx, dy]);
  }
  pts.sort((a, b) => {
    const da = a[0] * a[0] + a[1] * a[1], db = b[0] * b[0] + b[1] * b[1];
    if (da !== db) return da - db;
    if (a[1] !== b[1]) return a[1] - b[1];
    return a[0] - b[0];
  });
  return pts;
})();

/** Estimated box width for a room label (monospace character count, like `meubles.ts`'s `estim`). */
export function largeurEtiquetteCellule(texte: string): number {
  return Math.max(LARGEUR_MIN, String(texte || "").length * LARGEUR_CAR + LARGEUR_PAD);
}

/** Do these two boxes overlap by more than `tol` px on BOTH axes? */
export function seChevauchent(a: RectPx, b: RectPx, tol = 0): boolean {
  const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return dx > tol && dy > tol;
}

/**
 * Obstacle boxes for every VISIBLE piece of furniture: its rotated bounding box. R-6
 * (`meubles.ts`) already keeps a furniture label's own box INSIDE this footprint (its available
 * room, the horizontal chord of the rotated rectangle, is never wider than the rectangle's AABB),
 * so a single box per piece covers both the icon and its name.
 */
export function obstaclesMeubles(pieces: readonly Meuble[], calques: CalquesVisibles, S: number, bb: BBox): RectPx[] {
  const out: RectPx[] = [];
  for (const p of pieces) {
    if (!pieceVisible(p, calques)) continue;
    const pw = (+p.w || 0) * S, ph = (+p.h || 0) * S;
    if (pw <= 0 || ph <= 0) continue;
    const cx = (p.x - bb.minX + p.w / 2) * S, cy = (p.y - bb.minY + p.h / 2) * S;
    const rad = ((p.rot || 0) * Math.PI) / 180, ca = Math.abs(Math.cos(rad)), sa = Math.abs(Math.sin(rad));
    const hw = (pw * ca + ph * sa) / 2, hh = (pw * sa + ph * ca) / 2;
    out.push({ x: cx - hw, y: cy - hh, w: hw * 2, h: hh * 2 });
  }
  return out;
}

/**
 * Places every candidate room label, LARGEST CELL FIRST (id breaks ties: deterministic, never an
 * iteration order borrowed from a Map or an array). For each, walks the grid (`DECALAGES`) out
 * from its natural anchor, skipping any point outside the cell (`dansCellule`, when given); the
 * first spot that overlaps neither a furniture obstacle nor an already-placed room label wins. If
 * none does anywhere in the room, the label is DROPPED (`null`) rather than painted over something
 * else.
 */
export function disposerEtiquettesCellules(
  candidats: readonly CandidatEtiquetteCellule[],
  obstacles: readonly RectPx[],
  tol = 1,
): Map<string, { x: number; y: number } | null> {
  const ordre = candidats
    .slice()
    .sort((a, b) => (b.aire - a.aire) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const placees: RectPx[] = obstacles.slice();
  const res = new Map<string, { x: number; y: number } | null>();
  for (const c of ordre) {
    const w = largeurEtiquetteCellule(c.texte);
    const h = HAUTEUR_ETIQUETTE_CELLULE;
    const stepX = (w + ECART) / 2, stepY = (h + ECART) / 2;
    let placee: { x: number; y: number } | null = null;
    for (const [dx, dy] of DECALAGES) {
      const x = c.ax + dx * stepX, y = c.ay + dy * stepY;
      if (c.dansCellule && !c.dansCellule(x, y)) continue;
      const rect: RectPx = { x: x - w / 2, y: y - h / 2, w, h };
      if (!placees.some((o) => seChevauchent(rect, o, tol))) { placee = { x, y }; placees.push(rect); break; }
    }
    res.set(c.id, placee);
  }
  return res;
}
