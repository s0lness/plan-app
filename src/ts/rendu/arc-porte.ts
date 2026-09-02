// src/ts/rendu/arc-porte.ts: A DOOR'S SWING ARC, as standalone SVG.
//
// THE ARC'S CENTER IS THE HINGE, across the FOUR hinge x direction combinations: two candidate
// centers for two endpoints and a radius `r`, distinguished by `sweep = sign((lx-hx)*sg) > 0`.
// `resolveColor` is an ARGUMENT (not read from a computed CSS variable), so the test can check
// the `d` path without a browser.

/**
 * @param w door width, in cm (= swing radius)
 * @param hinge 0 = hinge on the left, 1 = on the right
 * @param swing 1 = opens inward (+y), -1 = opens outward (-y)
 * @param couleur the stroke's tint, already resolved (the old client used to pass `resolveColor("var(--open)")`)
 */
/**
 * ONE leaf: the dashed arc plus the wide-open leaf's stroke, in LOCAL coordinates.
 * `hx` = hinge's x, `lx` = free end's x, `r` = radius (= the leaf's reach).
 * Extracted from `doorArcSVG` to be called TWICE for a two-leaf window; the `sweep` computation
 * is the same, so it only ever exists in one place.
 */
function battant(hx: number, lx: number, r: number, sg: number, open: string, sw: number,
                 S: (x: number) => number): string {
  const sweep = (lx - hx) * sg > 0 ? 1 : 0;
  const oy = S(sg * r);
  return `<path d="M ${S(lx)} 0 A ${S(r)} ${S(r)} 0 0 ${sweep} ${S(hx)} ${oy}" fill="none" stroke="${open}" stroke-width="${sw}" stroke-dasharray="${S(sw * 2.2)} ${S(sw * 2)}" opacity="0.55"/>`
    + `<line x1="${S(hx)}" y1="0" x2="${S(hx)}" y2="${oy}" stroke="${open}" stroke-width="${S(sw * 1.2)}" stroke-linecap="round" opacity="0.85"/>`;
}

/**
 * A WINDOW'S SWING, which is NOT always a door's.
 *
 * Not every window has a footprint on the floor: a skylight opens VERTICALLY, a fixed one doesn't
 * open at all. `leaf` is what decides, and its ABSENT default is what makes adding it safe:
 * simply widening the `type === "door"` test would have grown an arc on ALL windows already
 * placed at once (34 on the household's plan), including the ones that have none.
 *
 *   leaf 1: one leaf, radius = the width, hinge given by `hinge` (like a door)
 *   leaf 2: DOUBLE WINDOW, two leaves of radius w/2 that meet in the MIDDLE (cremone bolt)
 *
 * @returns "" when there is nothing to draw: the caller has no condition to write.
 */
/**
 * ARC STROKE THICKNESS, IN CENTIMETERS, CONSTANT.
 *
 * It used to be `max(2.2, width * 3%)`: an 80 cm door had a 2.4 cm stroke, a 300 cm bay a 9 cm
 * stroke. But the SVG's viewBox is in apartment centimeters and the element is stretched to the
 * opening's size: the stroke therefore grew TWICE, once from the formula and once from the
 * stretch. On screen, two neighboring openings didn't share the same stroke, and the wider one
 * looked "thicker" even though it's the same pencil line.
 *
 * A stroke is a drawing convention, not a property of the drawn object: it does not depend on
 * what it describes.
 */
const TRAIT_ARC = 2.2;

export function windowArcSVG(w: number, hinge: 0 | 1 | number, swing: number, leaf: number,
                             couleur = "var(--open)"): string {
  const n = Number(leaf) | 0;
  if (n !== 1 && n !== 2) return "";
  const open = String(couleur);
  const S = (x: number): number => +x.toFixed(2);
  const sw = TRAIT_ARC;
  const sg = Number(swing) < 0 ? -1 : 1;
  let g = "";
  if (n === 1) {
    const hx = hinge ? w : 0, lx = hinge ? 0 : w;
    g = battant(hx, lx, w, sg, open, sw, S);
  } else {
    // Two leaves that open FROM THE MIDDLE: each is hinged on its jamb and its free end is the
    // center. The radius is therefore the HALF-width, and the two arcs meet.
    const r = w / 2;
    g = battant(0, r, r, sg, open, sw, S) + battant(w, r, r, sg, open, sw, S);
  }
  const vbY = sg < 0 ? -w : 0;
  return `<svg class="darc" viewBox="0 ${vbY} ${w} ${w}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">${g}</svg>`;
}

export function doorArcSVG(w: number, hinge: 0 | 1 | number, swing: number, couleur = "var(--open)"): string {
  const open = String(couleur);
  const S = (x: number): number => +x.toFixed(2);
  const sw = TRAIT_ARC;
  const r = w; // swing radius = door width
  const sg = Number(swing) < 0 ? -1 : 1;
  const hx = hinge ? w : 0; // hinge's x (along the wall)
  const lx = hinge ? 0 : w; // x of the wide-open leaf's end (the other jamb)
  const sweep = (lx - hx) * sg > 0 ? 1 : 0;
  const oy = S(sg * r);
  const arc = `<path d="M ${S(lx)} 0 A ${S(r)} ${S(r)} 0 0 ${sweep} ${S(hx)} ${oy}" fill="none" stroke="${open}" stroke-width="${sw}" stroke-dasharray="${S(sw * 2.2)} ${S(sw * 2)}" opacity="0.55"/>`;
  const leaf = `<line x1="${S(hx)}" y1="0" x2="${S(hx)}" y2="${oy}" stroke="${open}" stroke-width="${S(sw * 1.2)}" stroke-linecap="round" opacity="0.85"/>`;
  // the viewBox's top moves up to -w when the door opens outward, so the mirrored arc stays
  // visible
  const vbY = sg < 0 ? -w : 0;
  return `<svg class="darc" viewBox="0 ${vbY} ${w} ${w}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">${arc}${leaf}</svg>`;
}
