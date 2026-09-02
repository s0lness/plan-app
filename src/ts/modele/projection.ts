// src/ts/modele/projection.ts: THE GEOMETRY OF A VIDEO PROJECTOR.
//
// Usage request: "see the projection throw to know where to place it, be able to match it to a
// screen, move it back and forward, and know whether the minimum distance is respected,
// including with ultra short throw, set right in front of the screen".
//
// DISTANCE IS NOT A PROPERTY OF THE DEVICE, IT IS A RESULT. What a projector has is a THROW
// RATIO (`tr`, x100): image width = distance / ratio. This is the number on its spec sheet, and
// the only one that makes ultra short throw expressible: a UST at 0.25 casts a 120 cm image from
// 30 cm off the wall, which no stored "projection distance" can express.
//
// EVERYTHING IS DERIVED, NOTHING IS DUPLICATED: distance comes from positions, image width from
// the ratio, the verdict from the comparison to the screen. None of these three values is
// persisted, so none of them can drift out of sync with the plan.
//
// PURE module: it does not read the DOM, writes nothing, and proves itself without a browser.

/** A projector as this module needs to see it. */
export interface Projecteur {
  x: number; y: number; w: number; h: number; rot?: number | undefined;
  /** throw ratio x100 (150 = 1.50; 25 = ultra short throw) */
  tr?: number | undefined;
  /** minimum focus distance, cm. 0/absent = not provided */
  dmin?: number | undefined;
}

export interface Ecran {
  x: number; y: number; w: number; h: number; rot?: number | undefined;
}

export interface Projection {
  /** Throw direction, unit vector, in apartment coordinates. */
  ux: number; uy: number;
  /** The lens exit point (middle of the front face). */
  ox: number; oy: number;
  /** Distance to the matched screen, or the default throw if none. */
  distance: number;
  /** Image width obtained at this distance, cm. */
  largeur: number;
  /** True if a screen is matched AND the distance was measured to it. */
  versEcran: boolean;
  /** True if `dmin` is provided and the distance is below it: the image will not be in focus. */
  tropPres: boolean;
  /** Width of the matched screen, if there is one. */
  largeurEcran: number | null;
}

/** Default throw ratio when the spec sheet has not been entered: 1.50, the common case. */
export const TR_DEFAUT = 150;
/** Throw drawn when no screen is matched: enough to see the cone without cluttering the plan. */
const PORTEE_LIBRE = 400;

/**
 * THE THROW DIRECTION IS THE LOCAL +y, rotated by `rot`.
 *
 * This is not arbitrary: the icon draws the lens on the FRONT face (the one facing the room,
 * `y = h` in local coordinates, see `rendu/icones.ts`), and `rot` is applied by the same CSS
 * rotation as the thumbnail. A local vector (0,1) rotated by `rot` is therefore (-sin, cos).
 */
export function directionTir(rot?: number | undefined): { ux: number; uy: number } {
  const a = ((rot || 0) * Math.PI) / 180;
  return { ux: -Math.sin(a), uy: Math.cos(a) };
}

/** The center of the FRONT face: this is where the beam starts, not the center of the box. */
export function sortieObjectif(p: Projecteur): { ox: number; oy: number } {
  const { ux, uy } = directionTir(p.rot);
  const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
  return { ox: cx + ux * (p.h / 2), oy: cy + uy * (p.h / 2) };
}

/**
 * The distance from the lens to the screen's PLANE, measured along the throw axis. We project
 * the lens-to-screen-center vector onto this axis: it is the only measurement that makes optical
 * sense, and it stays correct even if the screen is offset sideways (the projector is not always
 * facing it head on). Returns `null` if the screen is BEHIND the projector.
 */
export function distanceAEcran(p: Projecteur, e: Ecran): number | null {
  const { ux, uy } = directionTir(p.rot);
  const { ox, oy } = sortieObjectif(p);
  const ex = e.x + e.w / 2, ey = e.y + e.h / 2;
  const d = (ex - ox) * ux + (ey - oy) * uy;
  return d > 0 ? d : null;
}

/** Image width at a given distance. `tr` is x100, hence the division by 100. */
export const largeurImage = (distance: number, tr?: number | undefined): number =>
  distance / (((tr || TR_DEFAUT)) / 100);

/**
 * Everything needed to draw the beam and return a verdict.
 * `ecran` absent (or behind): we draw the free throw, with no screen verdict.
 */
export function projection(p: Projecteur, ecran?: Ecran | null): Projection {
  const { ux, uy } = directionTir(p.rot);
  const { ox, oy } = sortieObjectif(p);
  const d = ecran ? distanceAEcran(p, ecran) : null;
  const versEcran = d != null;
  const distance = versEcran ? d : PORTEE_LIBRE;
  const dmin = Number(p.dmin) || 0;
  return {
    ux, uy, ox, oy, distance,
    largeur: largeurImage(distance, p.tr),
    versEcran,
    // "Too close" only makes sense if the spec sheet gave a minimum distance: without it, we do
    // not pretend to know. A UST at 30 cm is perfectly placed; it is `dmin` that says so, not a
    // hunch about the distance.
    tropPres: dmin > 0 && distance < dmin,
    largeurEcran: ecran ? ecran.w : null,
  };
}

/**
 * The beam's quadrilateral, in apartment coordinates: two points at the lens (spread apart by
 * the device's width, so the cone starts from the lens and not a mathematical point) and two at
 * the far end, spread apart by the image width.
 */
export function polygoneFaisceau(p: Projecteur, ecran?: Ecran | null): Array<[number, number]> {
  const pr = projection(p, ecran);
  const nx = -pr.uy, ny = pr.ux;                 // normal to the throw axis
  const demiDep = Math.min(p.w, 12) / 2;         // the beam starts from the lens, not a point
  const demiArr = pr.largeur / 2;
  const fx = pr.ox + pr.ux * pr.distance, fy = pr.oy + pr.uy * pr.distance;
  return [
    [pr.ox - nx * demiDep, pr.oy - ny * demiDep],
    [pr.ox + nx * demiDep, pr.oy + ny * demiDep],
    [fx + nx * demiArr, fy + ny * demiArr],
    [fx - nx * demiArr, fy - ny * demiArr],
  ];
}

/**
 * The readable verdict, or `null` if everything is fine. This is what shows under the fields: a
 * bare number does not say whether it is good.
 */
export function verdictProjection(pr: Projection): string | null {
  if (pr.tropPres) return "Too close to focus";
  if (!pr.versEcran || pr.largeurEcran == null) return null;
  const ecart = pr.largeur - pr.largeurEcran;
  if (Math.abs(ecart) <= Math.max(5, pr.largeurEcran * 0.03)) return null;   // within 3%, close enough
  return ecart > 0
    ? `Image ${Math.round(ecart)}cm wider than the screen`
    : `Image ${Math.round(-ecart)}cm narrower than the screen`;
}
