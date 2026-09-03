// src/ts/modele/projection.ts: THE GEOMETRY OF A VIDEO PROJECTOR, PURE (no DOM, no writes).
//
// DISTANCE IS NOT A PROPERTY OF THE DEVICE, IT IS A RESULT: what a projector has is a THROW RATIO
// (`tr`, x100, the number on its spec sheet), image width = distance / ratio. Everything is
// derived, nothing duplicated: distance from positions, width from the ratio, the verdict from
// the comparison to the screen; none of the three is persisted, so none can drift out of sync.

/** A projector as this module needs to see it. */
export interface Projecteur {
  x: number; y: number; w: number; h: number; rot?: number | undefined;
  /** throw ratio x100 (150 = 1.50; 25 = ultra short throw) */
  tr?: number | undefined;
  /** minimum focus distance, cm. 0/absent = not provided */
  dmin?: number | undefined;
  /**
   * THE VERTICAL CUT. `hp` is the height of the LENS above the floor, cm; absent = we don't
   * claim to know, and no height is stated. `off` is the vertical offset, SIGNED, as a
   * percentage of the image HEIGHT: it says where the image sits relative to the lens axis,
   * and it is the only reason this module never assumes the lens is under the image.
   *   table (hp 80, off +10)   the image rises slightly above the axis;
   *   ceiling (hp 230, off -10) the device hangs and throws DOWNWARD;
   *   short throw (hp 40, off +120) the device sits under the screen, 30 cm from the wall, and
   *   the WHOLE image is above the lens.
   * Absent `off` = 0, which is a lens dead centre on the image.
   */
  hp?: number | undefined;
  off?: number | undefined;
}

export interface Ecran {
  x: number; y: number; w: number; h: number; rot?: number | undefined;
  /** Height of the BOTTOM of the screen above the floor, cm. Absent = not stated. */
  hs?: number | undefined;
  /** Image format, encoded as an integer (see `RATIOS`). Absent = 16:9. */
  ratio?: number | undefined;
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

/**
 * THE THREE IMAGE FORMATS, AS INTEGERS. Same reason as `tr`: a float in a persisted field is a
 * float in the content fingerprint, and two clients must never diverge over a rounding. 169 is
 * 16:9, 1610 is 16:10, 2351 is 2.35:1 (scope).
 */
export const RATIOS = [169, 1610, 2351] as const;
/** 16:9 when nobody has said otherwise: it is what a projector throws by default. */
export const RATIO_DEFAUT = 169;

/** Width over height, from the integer code. An unknown code falls back to 16:9, it never throws. */
export function aspect(ratio?: number | undefined): number {
  const r = Number(ratio) || RATIO_DEFAUT;
  if (r === 1610) return 16 / 10;
  if (r === 2351) return 2.35;
  return 16 / 9;
}

/** Image height from its width and its format. */
export const hauteurImage = (largeur: number, ratio?: number | undefined): number =>
  largeur / aspect(ratio);

/**
 * A centimetre of slack before we call it an overflow. Both bounds are rounded for display, so
 * without it a half-centimetre of arithmetic would turn the line red while it reads "0 cm".
 */
const TOL_V = 1;

/** The vertical cut: where the image lands on the wall, and where the screen is. */
export interface CoupeVerticale {
  /** Image height at this distance, cm. Always known: it follows the width. */
  hauteur: number;
  /** Bottom / top of the image above the floor, cm, or `null` when `hp` is not stated. */
  bas: number | null;
  haut: number | null;
  /** Bottom / top of the screen above the floor, or `null` when there is no screen, or no `hs`. */
  ecranBas: number | null;
  ecranHaut: number | null;
  /** How far the image spills BELOW / ABOVE the screen, cm. 0 when it does not. */
  debordeBas: number;
  debordeHaut: number;
  /** True when the image does not fit the screen vertically. */
  deborde: boolean;
}

/**
 * WHERE THE IMAGE LANDS, VERTICALLY. The lens is at `hp`, the image centre at `hp + off·H`, and
 * the image spans half its height either side of that centre. Nothing here supposes the lens is
 * BELOW the image: a ceiling mount has a negative offset, an ultra short throw a large positive
 * one, and both go through the same three lines.
 */
export function coupeVerticale(pr: Projection, p: Projecteur, ecran?: Ecran | null): CoupeVerticale {
  const ratio = ecran ? ecran.ratio : undefined;
  const hauteur = hauteurImage(pr.largeur, ratio);
  const hp = Number(p.hp);
  const centre = isFinite(hp) && hp > 0 ? hp + (Number(p.off) || 0) / 100 * hauteur : null;
  const bas = centre == null ? null : centre - hauteur / 2;
  const haut = centre == null ? null : centre + hauteur / 2;
  const hs = ecran ? Number(ecran.hs) : NaN;
  const ecranBas = ecran && isFinite(hs) && hs > 0 ? hs : null;
  const ecranHaut = ecranBas == null || !ecran ? null : ecranBas + hauteurImage(ecran.w, ratio);
  let debordeBas = 0, debordeHaut = 0;
  if (bas != null && haut != null && ecranBas != null && ecranHaut != null) {
    debordeBas = Math.max(0, ecranBas - bas);
    debordeHaut = Math.max(0, haut - ecranHaut);
  }
  return {
    hauteur, bas, haut, ecranBas, ecranHaut, debordeBas, debordeHaut,
    deborde: debordeBas > TOL_V || debordeHaut > TOL_V,
  };
}

/**
 * The whole vertical cut in ONE readable line. No section drawing in this MVP: the sentence
 * says the three things that matter (how big the image is, where it lands, whether it fits).
 * Each clause is only written once the number behind it is actually known.
 */
export function phraseCoupe(c: CoupeVerticale, largeur: number): string {
  const r = (v: number): string => String(Math.round(v));
  let s = `Image ${r(largeur)} × ${r(c.hauteur)} cm`;
  if (c.bas == null || c.haut == null) return s + ".";
  s += `, from ${r(c.bas)} to ${r(c.haut)} cm above the floor`;
  if (c.ecranBas == null || c.ecranHaut == null) return s + ".";
  s += `; screen from ${r(c.ecranBas)} to ${r(c.ecranHaut)}`;
  const bouts: string[] = [];
  if (c.debordeBas > TOL_V) bouts.push(`${r(c.debordeBas)} cm below`);
  if (c.debordeHaut > TOL_V) bouts.push(`${r(c.debordeHaut)} cm above`);
  return s + (bouts.length ? `: ${bouts.join(" and ")} the screen` : ": fits the screen");
}

/**
 * The signed width gap between the image and the screen it is aimed at, cm, or `null` when no
 * screen is matched. Positive = the image is WIDER than the screen.
 */
export function ecartLargeur(pr: Projection): number | null {
  if (!pr.versEcran || pr.largeurEcran == null) return null;
  return pr.largeur - pr.largeurEcran;
}

/** The gap as it is written on the beam: a sign, always, so "+12 cm" cannot be read as "12 cm". */
export function texteEcart(ecart: number): string {
  const n = Math.round(ecart);
  return (n < 0 ? "−" : "+") + Math.abs(n) + " cm";
}

/** Beyond this, in either direction, the gap is written in red. */
export const ECART_ALERTE = 5;
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
