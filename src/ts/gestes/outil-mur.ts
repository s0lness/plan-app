// src/ts/gestes/outil-mur.ts: THE WALL TOOL'S CHAIN, PURE. A wall is drawn CLICK-CLICK: a click
// sets the start, the next click sets the arrival AND becomes the start of the next segment. A
// double-click, Enter or Escape ends the chain; Escape on a start never laid leaves the tool.
// PURE (no `Contexte`, no DOM, no plan, no snapping): the caller decides WHERE a point lands,
// this module decides only WHAT a click means, so `tests/rapide.ts` drives it without a browser.

import type { Pt } from "../partage/plan.ts";

/** The chain: the point a segment would start from, or null when nothing is laid yet. */
export interface OutilMur {
  readonly depart: Pt | null;
}

export const outilMurNeuf = (): OutilMur => ({ depart: null });

/**
 * A click at `p`. The first one only lays the start; every later one CLOSES a segment and
 * immediately reopens the chain at that same point, so a room is drawn without letting go.
 */
export function outilMurPoint(o: OutilMur, p: Pt): { etat: OutilMur; segment: [Pt, Pt] | null } {
  const depart: Pt = [p[0], p[1]];
  if (!o.depart) return { etat: { depart }, segment: null };
  return { etat: { depart }, segment: [[o.depart[0], o.depart[1]], depart] };
}

/**
 * Double-click, Enter, or Escape. `quitter` says the tool itself should disarm: that only happens
 * when the chain held NOTHING, so the first Escape ends the run being drawn and the second one
 * puts the tool away. Ending a chain never creates a segment: the pending point is dropped.
 */
export function outilMurFin(o: OutilMur): { etat: OutilMur; quitter: boolean } {
  return { etat: outilMurNeuf(), quitter: !o.depart };
}

/**
 * The point at EXACTLY `L` cm from `depart`, in the direction currently aimed at (`vers`). This is
 * what "type digits, press Enter" lands on: the number sets the length, the pointer keeps setting
 * the direction. No direction (the pointer sits on the start), or a length that is not a usable
 * number: nothing is placed, and the caller says why.
 */
export function outilMurALongueur(depart: Pt, vers: Pt, L: number): Pt | null {
  if (!isFinite(L) || L <= 0) return null;
  const dx = vers[0] - depart[0], dy = vers[1] - depart[1];
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return null;
  return [depart[0] + (dx / d) * L, depart[1] + (dy / d) * L];
}
