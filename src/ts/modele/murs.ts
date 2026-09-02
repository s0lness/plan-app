// src/ts/modele/murs.ts — editing geometry for walls and openings.
// Porté de src/js/52-v5-geometrie-edition.js (PURE part), + `v5OpeningEdgeLimits` (js/56) and
// `v5OpeningBox` / `v5CellsAt` (js/50), which are likewise pure functions of the plan.
//
// WHAT CHANGES, AND THIS IS THE POINT OF THIS BATCH: in the old client, `v5WallById(id)` read
// `state.plan` through the closure. These functions now take the PLAN as an argument. This is
// not cosmetic: `v5ClampOpeningsOfWall` is called with the LIVE plan by the author of a gesture
// and with a DATA plan (a history snapshot) on replay, and its purity is what makes C-12 safe.
// Passing it as an argument makes that purity VERIFIABLE by the compiler.

import { clamp, v5R2, WALL } from "../noyau/nombres.ts";
import { OPENING_H_MAX } from "../partage/contrat-serveur.ts";
import { fam, pieceVisible, TYPEMAP, type CalquesVisibles } from "../catalogue/catalogue.ts";
import { pointInPoly } from "../geometrie/polygones.ts";
import { v5OnOutline } from "./conversion.ts";
import type { Cellule, Id, Mur, Ouverture, PlanV5, Pt } from "../partage/plan.ts";

/** A wall's local frame: direction (u), normal (n), length. */
export interface SegmentMur {
  dx: number;
  dy: number;
  L: number;
  ux: number;
  uy: number;
  nx: number;
  ny: number;
}

export function v5Seg(w: Pick<Mur, "a" | "b">): SegmentMur {
  const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1];
  const L = Math.hypot(dx, dy) || 1;
  return { dx, dy, L, ux: dx / L, uy: dy / L, nx: -dy / L, ny: dx / L };
}

export function v5WallById(plan: PlanV5 | null | undefined, id: Id): Mur | null {
  if (!plan) return null;
  return (plan.walls || []).find((w) => String(w.id) === String(id)) || null;
}

export function v5WallLen(plan: PlanV5 | null | undefined, id: Id): number {
  const w = v5WallById(plan, id);
  return w ? v5Seg(w).L : 0;
}

// ---- duplicate walls -----------------------------------------------------------------------------
// Two lines at the same spot = TWO exactly overlapping walls: the second is invisible (its band
// paints over the first), "Delete wall" only removes one and the button looks broken.

export interface ComparaisonSegment {
  same: boolean;
  flipped: boolean;
}

export function v5SameSegment(w: Pick<Mur, "a" | "b">, x: Pick<Mur, "a" | "b">, tol?: number): ComparaisonSegment {
  const t = tol == null ? 1 : tol;
  const d1 = Math.hypot(w.a[0] - x.a[0], w.a[1] - x.a[1]) + Math.hypot(w.b[0] - x.b[0], w.b[1] - x.b[1]);
  const d2 = Math.hypot(w.a[0] - x.b[0], w.a[1] - x.b[1]) + Math.hypot(w.b[0] - x.a[0], w.b[1] - x.a[1]);
  return { same: Math.min(d1, d2) <= t, flipped: d2 < d1 };
}

/** Purges a plan's exactly overlapping walls, carrying their openings over. Mutates `plan`. */
export function v5DedupeWalls(plan: PlanV5 | null | undefined): number {
  const P = plan;
  if (!P || !Array.isArray(P.walls)) return 0;
  let n = 0;
  for (let i = 0; i < P.walls.length; i++) {
    const w = P.walls[i]!;
    if (w.isOutline) continue;
    for (let j = P.walls.length - 1; j > i; j--) {
      const x = P.walls[j]!;
      if (x.isOutline) continue;
      const cmp = v5SameSegment(w, x, 1);
      if (!cmp.same) continue;
      const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
      (P.openings || []).forEach((o) => {
        if (String(o.wallId) !== String(x.id)) return;
        o.wallId = String(w.id);
        if (cmp.flipped) o.t0 = v5R2(clamp(L - o.t0 - o.w, 0, Math.max(0, L - o.w))); // wall picked up reversed
      });
      P.walls.splice(j, 1);
      n++;
    }
  }
  return n;
}

// ---- DO TWO WALL-MOUNTED OBJECTS GET IN EACH OTHER'S WAY? THE FACE MATTERS ----------------------
// The 1-D non-overlap rule used to be computed per WALL and per FAMILY, never per FACE: an outlet
// in the bedroom and an outlet in the living room, back to back in the same partition (the most
// ordinary case in a home), were impossible. Physics decides family by family:
//   - DOOR / WINDOW / SLIDING DOOR: through OPENING, both faces. `side` is ignored.
//   - WALL LIGHT, OUTLET / RJ45: a device BOLTED onto one face. Back to back, two distinct
//     surfaces.
//   - DIFFERENT families: never in each other's way.
export function v5OpeningSameSlot(
  a: Pick<Ouverture, "type" | "side">,
  b: Pick<Ouverture, "type" | "side">,
): boolean {
  const fa = fam(a.type);
  if (fa !== fam(b.type)) return false;
  if (fa === "opening") return true; // through opening: both faces
  return (a.side ? 1 : 0) === (b.side ? 1 : 0); // surface device: the same face only
}

// ---- AN OPENING'S DEPTH BELONGS TO ITS WALL (G-16) ------------------------------------------------
// `h` is the object's thickness INSIDE the wall. The box is centered on the midline and an
// opening REPAINTS THE BACKGROUND: `h` larger than the wall carves a white hole that overflows
// symmetrically on both sides. Measured: 200 cm of depth on a 10 cm wall, accepted silently,
// 455 px of white cutting across the plan.
// The server clamps to 1..200: it clamps the DANGEROUS, we clamp the SENSIBLE, and ours is
// stricter, so it never conflicts with it (G-18). The server ceiling is IMPORTED from the shared
// contract (`OPENING_H_MAX`) instead of being hardcoded: it used to be a bare 200 in the old code.

export function v5OpeningDepthMax(w: { t?: number | undefined } | null | undefined): number {
  const t = Math.round(Number(w && w.t) || WALL);
  return Math.max(1, Math.min(OPENING_H_MAX, isFinite(t) ? t : WALL));
}

export function v5OpeningDepthFor(w: { t?: number | undefined } | null | undefined, want: unknown): number {
  const h = Math.round(Number(want) || 0);
  return Math.max(1, Math.min(v5OpeningDepthMax(w), h > 0 ? h : WALL));
}

// ---- WHAT DEPENDS ON A WALL FOLLOWS THAT WALL (C-12) ----------------------------------------------
// An opening has no coordinates of its own. There are therefore THREE ways to invalidate it by
// touching the wall: SHORTENING it (the opening sticks out past the end), THINNING it (white hole
// across the wall), DELETING it (the opening is left orphaned). The result is wrong on BOTH
// sides, so nobody will fix it.
// The rule lives here, ONCE: PURE, MONOTONIC (it only shrinks or pulls in, so no oscillation),
// NARROW (the NAMED wall), and SILENT toward the receiver (`gardeOrphelines`).

export interface ChangementOuverture {
  id: Id;
  name: string;
  quoi: "orpheline" | "retrecie" | "deplacee" | "aminci";
  de?: number;
  a?: number;
}

export interface OptionsClamp {
  /** clamp only ONE opening, the one that just arrived */
  only?: Id | null | undefined;
  /**
   * do NOT remove an opening whose wall is missing. On the wire, an `opening.set` can arrive
   * BEFORE the wall that carries it: it is the CASCADE that cleans that up, not this clamping,
   * which must never make an object disappear.
   */
  gardeOrphelines?: boolean | undefined;
}

export function v5ClampOpeningsOfWall(
  P: PlanV5 | null | undefined,
  wallId: Id,
  opts?: OptionsClamp | null,
): ChangementOuverture[] {
  const out: ChangementOuverture[] = [];
  if (!P) return out;
  const id = String(wallId);
  const only = opts && opts.only != null ? String(opts.only) : null;
  const w = (P.walls || []).find((x) => String(x.id) === id);
  const L = w ? v5Seg(w).L : 0;
  const hMax = w ? v5OpeningDepthMax(w) : 0;
  for (let i = (P.openings || []).length - 1; i >= 0; i--) {
    const o = P.openings[i]!;
    if (String(o.wallId) !== id) continue;
    if (only !== null && String(o.id) !== only) continue;
    if (!w) {
      if (opts && opts.gardeOrphelines) continue;
      P.openings.splice(i, 1);
      out.push({ id: String(o.id), name: o.name || "", quoi: "orpheline" });
      continue;
    }
    const w0 = Number(o.w), t00 = Number(o.t0), h0raw = Number(o.h);
    // A3. A NON-FINITE FIELD (NaN: an interrupted drag, a division by a then-zero-length wall
    // elsewhere) must NOT survive `clamp` below unrepaired: `clamp(NaN, lo, hi)` returns NaN,
    // untouched — `NaN > hi` and `NaN < lo` are both false, so the usual "clamp catches
    // everything" reasoning does not apply to it. Left alone, that NaN is then written out:
    // `JSON.stringify` turns it into `null`, and the NEXT read (`sanitizeV5Plan`'s
    // `num(null, default)`, which treats `null` as a REAL value of 0, never as "missing") floors
    // it to the 1cm minimum. Replaced here by the catalog's value (0 for `t0`, which has none)
    // BEFORE the clamp, and reported below through the SAME verdicts a real resize would get:
    // the repair IS a resize, from the reader's point of view.
    const cat = TYPEMAP[o.type];
    if (!isFinite(w0)) o.w = cat ? cat.w : 1;
    if (!isFinite(t00)) o.t0 = 0;
    const h0 = isFinite(h0raw) ? Math.round(h0raw || WALL) : (cat ? cat.h : WALL);
    if (!isFinite(h0raw)) o.h = h0;
    o.w = clamp(o.w, 1, Math.max(1, L));
    o.t0 = v5R2(clamp(o.t0, 0, Math.max(0, L - o.w)));
    if (h0 > hMax) o.h = hMax;
    if (!isFinite(w0) || Math.abs(o.w - w0) > 0.5) {
      out.push({ id: String(o.id), name: o.name || "", quoi: "retrecie", de: Math.round(isFinite(w0) ? w0 : 0), a: Math.round(o.w) });
    } else if (!isFinite(t00) || Math.abs(o.t0 - t00) > 0.5) {
      out.push({ id: String(o.id), name: o.name || "", quoi: "deplacee" });
    }
    if (h0 > hMax) out.push({ id: String(o.id), name: o.name || "", quoi: "aminci", de: h0, a: hMax });
    else if (!isFinite(h0raw)) out.push({ id: String(o.id), name: o.name || "", quoi: "aminci", de: 0, a: h0 });
  }
  return out;
}

// ---- WHO IS ALLOWED TO DISAPPEAR (C-13) ------------------------------------------------------------
// An OUTLINE WALL is DERIVED from the outline: deleting it does not remove the wall (it gets
// recreated) but permanently takes its openings with it. THREE verdicts, not two: "absent" is
// NOT "refused", the ordinary case of a shrunken outline on a peer's side sends `outline.set`
// BEFORE `wall.del`. `isOutline` is only a CACHE; the OUTLINE is authoritative.

export type VerdictSuppressionMur = "absent" | "facade" | "ok";

export function v5WallDeleteVerdict(
  P: { walls?: Mur[] | undefined; outline?: Pt[] | undefined } | null | undefined,
  id: Id,
): VerdictSuppressionMur {
  const list = P && Array.isArray(P.walls) ? P.walls : [];
  const w = list.find((x) => String(x.id) === String(id));
  if (!w) return "absent";
  if (!w.isOutline) return "ok";
  return v5OnOutline(w.a, w.b, (P && P.outline) || [], 1) ? "facade" : "ok";
}

// ---- RESIZE LIMITS FOR AN OPENING (G-19, js/56) -----------------------------------------------------
// Limits of the wall coordinate `t` for each edge, neighbors included. Also returns WHO sets the
// limit, so the message can name them.

export interface BornesOuverture {
  L: number;
  lo: number;
  hi: number;
  loLim: number;
  hiLim: number;
  loQui: Ouverture | null;
  hiQui: Ouverture | null;
}

export function v5OpeningEdgeLimits(
  plan: PlanV5,
  op: Ouverture,
  w: Mur,
  calques?: CalquesVisibles,
): BornesOuverture {
  const s = v5Seg(w), L = s.L;
  const lo = op.t0, hi = op.t0 + op.w;
  const vis = calques || {};
  let loLim = 0, hiLim = L;
  let loQui: Ouverture | null = null, hiQui: Ouverture | null = null;
  (plan.openings || []).forEach((q) => {
    if (q === op || String(q.wallId) !== String(op.wallId)) return;
    if (!v5OpeningSameSlot(op, q) || !pieceVisible(q, vis)) return;
    const qLo = q.t0, qHi = q.t0 + q.w;
    if (qHi <= lo + 0.01 && qHi > loLim) { loLim = qHi; loQui = q; }
    if (qLo >= hi - 0.01 && qLo < hiLim) { hiLim = qLo; hiQui = q; }
  });
  return { L, lo, hi, loLim, hiLim, loQui, hiQui };
}

// ---- AN OPENING'S BOX, AND THE CELL UNDER A POINT (js/50) ------------------------------------------

export interface BoiteOuverture {
  cx: number;
  cy: number;
  rot: number;
  w: number;
  h: number;
  wall: Mur;
}

export function v5OpeningBox(
  plan: Pick<PlanV5, "walls">,
  op: Ouverture,
  hDefaut: number,
): BoiteOuverture | null {
  const w = (plan.walls || []).find((x) => x.id === op.wallId);
  if (!w) return null;
  const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1];
  const L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L, tc = op.t0 + op.w / 2;
  const ang = Math.atan2(uy, ux) * 180 / Math.PI + (op.side ? 180 : 0);
  return {
    cx: w.a[0] + ux * tc,
    cy: w.a[1] + uy * tc,
    rot: ((Math.round(ang) % 360) + 360) % 360,
    w: op.w,
    h: op.h || hDefaut,
    wall: w,
  };
}

export function v5CellsAt(plan: PlanV5 | null | undefined, x: number, y: number): Cellule | null {
  if (!plan) return null;
  for (const c of plan.cells || []) if (pointInPoly(x, y, c.poly)) return c;
  return null;
}
