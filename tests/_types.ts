/** Value returned by a JavaScript probe injected into Chrome.
 *
 * `any` is deliberate here: each probe string is a small self-contained JavaScript program
 * that freely chooses the JSON shape of its verdict. The TypeScript envelope cannot know
 * this shape ahead of execution; each suite pins it down as closely as possible in its check function.
 */
export type VerdictSonde = any;

/** Dynamic boundary outside the browser: module loaded from a compared directory, forged frame,
 * or minimal test double of an external API. `any` is deliberate because these tests must be able
 * to build and read deliberately invalid shapes that the product's types would reject. */
export type DonneeDynamique = any;

export interface ResultatTest {
  name: string;
  pass: boolean;
  detail: string;
  verdict: VerdictSonde;
}

export type ControleSonde = (verdict: VerdictSonde) => boolean | string;

export interface PointTest {
  x: number;
  y: number;
}

export interface ResultatSimple {
  name: string;
  pass: boolean;
  detail: string;
}
