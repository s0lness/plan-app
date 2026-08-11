// src/ts/modele/repartir.ts — DISTRIBUTE SPACING EVENLY ACROSS SEVERAL PIECES OF FURNITURE.
//
// Usage request: "the same gap between the bed and the two nightstands". This is the operation
// every layout tool calls "distribute", and it holds three decisions, all made HERE and nowhere
// else.
//
//  1. THE AXIS IS DERIVED, NEVER ASKED FOR. It is the one the objects are most spread out on.
//     Three pieces of furniture in a horizontal row have only one sensible answer; on a perfect
//     tie we REFUSE instead of guessing, because an arbitrary choice would move furniture in a
//     direction nobody asked for.
//
//  2. THE TWO EXTREMES DO NOT MOVE. This is the convention every such tool follows, and it is the
//     only one that does not translate the whole group across the plan: we redistribute the
//     inside, we do not relocate the block. In the bed case, the two nightstands stay where they
//     are and it is the bed that centers between them.
//
//  3. THE GAP IS MEASURED BETWEEN BOXES, NOT BETWEEN CENTERS. "10 cm between the bed and the
//     table" means 10 cm of empty space, not 10 cm between their midpoints. The box of a rotated
//     object is its bounding box (`pieceAABB`), hence the same one circulation and guides see.
//
// A LOCKED OBJECT NEVER MOVES. If it is in the middle, no distribution is possible without moving
// it: we REFUSE and say so. A lock that is silently ignored is a broken lock.
//
// THIS MODULE TOUCHES NOTHING: it returns the move to apply, by identifier. The caller clamps,
// writes history, publishes, and displays. This is what makes it testable without a browser.

import type { Meuble } from "../partage/plan.ts";
import { pieceAABB } from "../circulation/contexte.ts";

export type AxeRepartition = "x" | "y";

export interface Repartition {
  /** Moves to apply, in apartment cm. The extremes never appear in it. */
  bouges: { id: string; dx: number; dy: number }[];
  axe: AxeRepartition;
  /** The resulting common gap, in cm (can be negative if the objects already overlap). */
  ecart: number;
  /** The gaps as they were BEFORE, in axis order: what the interface displays. */
  ecartsAvant: number[];
}

export type RefusRepartition =
  | "moins_de_trois"      // two objects = a single gap: there is nothing to equalize
  | "axe_ambigu"          // identical spread on both axes
  | "verrou_au_milieu";   // a locked object would need to move

export type ResultatRepartition = { ok: true; r: Repartition } | { ok: false; refus: RefusRepartition };

/**
 * IMPOSE A GAP, instead of merely equalizing it.
 *
 * "Distribute" says "the same", it does not say WHICH. Typing 10 says which, but says nothing
 * about the other gaps: these are two different operations, and both are needed. This one sets
 * the requested gap EVERYWHERE, keeping the FIRST object in place and pushing the following ones
 * out: keeping both extremes would be contradictory here, since the envelope must precisely
 * change size for the gap to be the one that was typed.
 *
 * Same refusals as `repartirEgalement`: fewer than three objects, ambiguous axis, a lock that
 * would need to move. A lock in the FIRST position does not get in the way, it does not move,
 * and that is the common case (we anchor on the piece of furniture that IS already in place).
 */
export function imposerEcart(pieces: readonly Meuble[], ecart: number): ResultatRepartition {
  if (pieces.length < 3) return { ok: false, refus: "moins_de_trois" };
  const base = repartirEgalement(pieces);
  if (!base.ok) return base;
  const axe = base.r.axe;
  const boites = pieces.map((p) => ({ p, b: pieceAABB(p) }));
  const lo = (o: { b: { x0: number; y0: number } }): number => (axe === "x" ? o.b.x0 : o.b.y0);
  const hi = (o: { b: { x1: number; y1: number } }): number => (axe === "x" ? o.b.x1 : o.b.y1);
  const ordre = boites.slice().sort((u, v) => (lo(u) - lo(v)) || (String(u.p.id) < String(v.p.id) ? -1 : 1));

  const bouges: { id: string; dx: number; dy: number }[] = [];
  let curseur = hi(ordre[0]!);
  for (let i = 1; i < ordre.length; i++) {
    const o = ordre[i]!;
    const vise = curseur + ecart;
    const delta = vise - lo(o);
    curseur = vise + (hi(o) - lo(o));
    if (Math.abs(delta) < 0.005) continue;
    if (o.p.locked) return { ok: false, refus: "verrou_au_milieu" };
    bouges.push({
      id: String(o.p.id),
      dx: axe === "x" ? +delta.toFixed(2) : 0,
      dy: axe === "y" ? +delta.toFixed(2) : 0,
    });
  }
  return { ok: true, r: { bouges, axe, ecart: +ecart.toFixed(2), ecartsAvant: base.r.ecartsAvant } };
}

/**
 * @param pieces the SELECTED pieces of furniture, in any order.
 * @returns the moves to apply, or the reason for refusal.
 */
export function repartirEgalement(pieces: readonly Meuble[]): ResultatRepartition {
  if (pieces.length < 3) return { ok: false, refus: "moins_de_trois" };

  const boites = pieces.map((p) => ({ p, b: pieceAABB(p) }));

  // 1. THE AXIS: the one the group is most spread out on.
  const etX = Math.max(...boites.map((o) => o.b.x1)) - Math.min(...boites.map((o) => o.b.x0));
  const etY = Math.max(...boites.map((o) => o.b.y1)) - Math.min(...boites.map((o) => o.b.y0));
  if (Math.abs(etX - etY) < 1e-6) return { ok: false, refus: "axe_ambigu" };
  const axe: AxeRepartition = etX > etY ? "x" : "y";
  const lo = (o: { b: { x0: number; y0: number } }): number => (axe === "x" ? o.b.x0 : o.b.y0);
  const hi = (o: { b: { x1: number; y1: number } }): number => (axe === "x" ? o.b.x1 : o.b.y1);

  // 2. Order along the axis. On a tied position, the identifier breaks the tie: distribution is
  //    DETERMINISTIC, two calls on the same plan produce the same result (and the same fingerprint).
  const ordre = boites.slice().sort((u, v) => (lo(u) - lo(v)) || (String(u.p.id) < String(v.p.id) ? -1 : 1));

  const ecartsAvant: number[] = [];
  for (let i = 1; i < ordre.length; i++) ecartsAvant.push(+(lo(ordre[i]!) - hi(ordre[i - 1]!)).toFixed(2));

  // 3. The common gap: the TOTAL free space between the two extremes, divided by the number of
  //    gaps. Since the extremes do not move, the envelope is fixed and the space to distribute is
  //    what remains once every thickness is removed.
  const debut = hi(ordre[0]!);
  const fin = lo(ordre[ordre.length - 1]!);
  let epaisseurs = 0;
  for (let i = 1; i < ordre.length - 1; i++) epaisseurs += hi(ordre[i]!) - lo(ordre[i]!);
  const nbEcarts = ordre.length - 1;
  const ecart = (fin - debut - epaisseurs) / nbEcarts;

  // 4. The moves. Only the objects in the MIDDLE move.
  const bouges: { id: string; dx: number; dy: number }[] = [];
  let curseur = debut;
  for (let i = 1; i < ordre.length - 1; i++) {
    const o = ordre[i]!;
    const vise = curseur + ecart;
    const delta = vise - lo(o);
    curseur = vise + (hi(o) - lo(o));
    if (Math.abs(delta) < 0.005) continue;              // already in place: no op for nothing
    if (o.p.locked) return { ok: false, refus: "verrou_au_milieu" };
    bouges.push({
      id: String(o.p.id),
      dx: axe === "x" ? +delta.toFixed(2) : 0,
      dy: axe === "y" ? +delta.toFixed(2) : 0,
    });
  }
  return { ok: true, r: { bouges, axe, ecart: +ecart.toFixed(2), ecartsAvant } };
}
