// src/ts/geometrie/angles.ts: THE 45-DEGREE TABLE, pure (no `Contexte`, no DOM, no `toast`), like
// `geometrie/polygones.ts`. Consumed by the wall tool's endpoint drag (`v5WallEndDrop`,
// `gestes/murs.ts`) to quantise a dragged end's direction from its wall's fixed end.

import type { Pt } from "../partage/plan.ts";

/** The 8 unit directions a run can quantise to, indexed by `quantizeAngleDeg(deg) / 45`. Table
 * lookup instead of calling `cos`/`sin` on a rounded degree value: axis directions come out
 * EXACTLY `0`/`±1`, never `1.2246e-16`, which matters because a direction taken from here feeds
 * divisions at the call site. */
export const DIR8: readonly Pt[] = [
  [1, 0], [Math.SQRT1_2, Math.SQRT1_2], [0, 1], [-Math.SQRT1_2, Math.SQRT1_2],
  [-1, 0], [-Math.SQRT1_2, -Math.SQRT1_2], [0, -1], [Math.SQRT1_2, -Math.SQRT1_2],
];

/** Nearest multiple of 45, wrapped into [0, 360). */
export function quantizeAngleDeg(rawDeg: number): number {
  const a = ((rawDeg % 360) + 360) % 360;
  const q = Math.round(a / 45) * 45;
  return q >= 360 ? 0 : q;
}
