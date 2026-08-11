// src/ts/gestes/guides.ts — THE LIVE DIMENSIONS OF THE DRAG, and the alignment snap.
// Ported from src/js/20-guides.js, plus `aptToLayerPx` (src/js/07-pieces-persistance.js) and
// `pieceAABB` (src/js/34-flow-contexte.js), which had no port yet and for which this module is
// the first taker.
//
// G-5 IS HELD HERE, and it is the most expensive line in the file: `alignSnap` TRUNCATES its
// delta toward zero. We used to apply `Math.round(p.x + delta)`; an odd width puts the center on a
// half-centimeter, the rounding used to OVERSHOOT the targeted line, and the furniture would
// oscillate by ±2 cm forever.
//
// TWO FAMILIES IN THE SAME FILE, and the boundary is sharp:
//   - PURE: `rayToPoly`, `alignSnap`, `openingWallInfo`, `pieceAABB`, `rotatePieceWithChairs`.
//     They take the PLAN, never the context, and touch no node.
//   - EPHEMERAL DOM: `clearGuides`, `drawAlignLines`, `drawGuides`, `addGuideLine`, `addGuideSeg`.
//     They take the CONTEXT, because they need the layer (`focusEl`) and the scale.
// None of them render, none of them save, none of them announce anything.

import type { Contexte } from "../app/contexte.ts";
import type { Meuble, Ouverture, PlanV5, Pt } from "../partage/plan.ts";
import { TYPEMAP, isWallMount, pieceVisible, type CalquesVisibles } from "../catalogue/catalogue.ts";
import { v5CellsAt, v5Seg, v5WallById } from "../modele/murs.ts";
import { focusEl } from "../rendu/calque.ts";
import { resolveColor } from "../rendu/couleurs.ts";
import { aptBBox } from "../rendu/vue.ts";
import { TABLE_TYPES, dockedChairs } from "./contraintes.ts";

export interface PointCm {
  x: number;
  y: number;
}

/**
 * APARTMENT cm -> LOCAL px of the layer (src/js/07). The layer is positioned on the outline's
 * bbox: these px are therefore already relative to its corner, without going through the viewport.
 */
export function aptToLayerPx(ctx: Contexte, x: number, y: number): PointCm {
  const bb = aptBBox(ctx);
  return { x: (x - bb.minX) * ctx.vue.scale, y: (y - bb.minY) * ctx.vue.scale };
}

export interface AABB {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
}

/** AXIS-ALIGNED bounding box of a ROTATED piece of furniture, in cm (src/js/34). */
export function pieceAABB(p: Pick<Meuble, "x" | "y" | "w" | "h" | "rot">): AABB {
  const cx = p.x + p.w / 2, cy = p.y + p.h / 2, a = (p.rot || 0) * Math.PI / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  const hw = p.w / 2, hh = p.h / 2;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [dx, dy] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as Pt[]) {
    const rx = cx + dx * ca - dy * sa, ry = cy + dx * sa + dy * ca;
    if (rx < minX) minX = rx; if (rx > maxX) maxX = rx; if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
  }
  return { x0: minX, y0: minY, x1: maxX, y1: maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

// =====================================================================
//  LIVE DISTANCE GUIDES (ephemeral DOM, drawn while dragging)
// =====================================================================
// Ray from (ox,oy) along unit (dx,dy) to the nearest edge of the CELL that contains the point
// (the outline as a fallback); dist in cm or null. Everything is in apartment cm.
export function rayToPoly(
  P: PlanV5 | null | undefined,
  ox: number, oy: number, dx: number, dy: number,
): number | null {
  const c = v5CellsAt(P, ox, oy);
  const poly: readonly Pt[] = (c && c.poly) || (P && P.outline) || [];
  if (poly.length < 3) return null;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!, pj = poly[j]!;
    const ax = pj[0], ay = pj[1], bx = pi[0], by = pi[1];
    const ex = bx - ax, ey = by - ay;
    const den = dx * ey - dy * ex; if (Math.abs(den) < 1e-9) continue;   // parallel
    const t = ((ax - ox) * ey - (ay - oy) * ex) / den;                    // along the ray
    const u = ((ax - ox) * dy - (ay - oy) * dx) / den;                    // along the edge
    if (t > 1e-6 && u >= -1e-6 && u <= 1 + 1e-6 && t < best) best = t;
  }
  return isFinite(best) ? best : null;
}

export function clearGuides(ctx: Contexte): void {
  ctx.canvas.querySelectorAll(".guides").forEach((g) => g.remove());
}

// Feature 2: magnetic alignment snap. Compare the dragged piece's AABB left/center/right (x)
// and top/center/bottom (y) to every other visible non-wall-mounted piece's same lines.
// Within ALIGN_TOL cm, snap the piece (alignment wins over grid) and report the nearest line
// per axis for drawing. `excludeIds` = dragged piece + chairs it drags along.
export const ALIGN_TOL = 1.5;

export interface LigneAlignX {
  delta: number;
  line: number;
  y0: number;
  y1: number;
}

export interface LigneAlignY {
  delta: number;
  line: number;
  x0: number;
  x1: number;
}

export interface Alignement {
  x: LigneAlignX | null;
  y: LigneAlignY | null;
}

export function alignSnap(
  P: PlanV5 | null | undefined,
  calques: CalquesVisibles,
  p: Meuble,
  excludeIds: Set<string>,
): Alignement | null {
  if (isWallMount(p.type)) return null;
  const box = pieceAABB(p);
  const xs = [box.x0, (box.x0 + box.x1) / 2, box.x1];   // left, cx, right
  const ys = [box.y0, (box.y0 + box.y1) / 2, box.y1];   // top,  cy, bottom
  let bestX: LigneAlignX | null = null, bestY: LigneAlignY | null = null;   // {delta, line, span:[a,b]}
  for (const q of (P && P.pieces) || []) {
    if (excludeIds.has(q.id)) continue;
    if (!pieceVisible(q, calques)) continue;   // Feature B: hidden layers aren't snap targets
    const t = TYPEMAP[q.type]; if (t && (t.opening || t.wallMount)) continue;
    const qb = pieceAABB(q);
    const qxs = [qb.x0, (qb.x0 + qb.x1) / 2, qb.x1];
    const qys = [qb.y0, (qb.y0 + qb.y1) / 2, qb.y1];
    for (const mine of xs) for (const other of qxs) {
      const d = other - mine;
      if (Math.abs(d) <= ALIGN_TOL && (!bestX || Math.abs(d) < Math.abs(bestX.delta))) {
        bestX = { delta: d, line: other, y0: Math.min(box.y0, qb.y0), y1: Math.max(box.y1, qb.y1) };
      }
    }
    for (const mine of ys) for (const other of qys) {
      const d = other - mine;
      if (Math.abs(d) <= ALIGN_TOL && (!bestY || Math.abs(d) < Math.abs(bestY.delta))) {
        bestY = { delta: d, line: other, x0: Math.min(box.x0, qb.x0), x1: Math.max(box.x1, qb.x1) };
      }
    }
  }
  if (!bestX && !bestY) return null;
  // ---- A SNAP THAT SETTLES ON ITSELF MUST NOT MOVE ANYTHING ANYMORE ---------------------------
  // We used to apply `Math.round(p.x + delta)`. An odd width puts the center on a half-
  // centimeter, so `delta` too: the rounding used to OVERSHOOT the targeted line (delta 1.5 -> 2 cm), the
  // next computation would find a gap of 0.5, round it back to 1, and the furniture would oscillate
  // forever. We truncate TOWARD ZERO: the snap never overshoots, and what remains (less than a
  // centimeter) gets truncated to 0 on the next pass. The snapping becomes idempotent.
  if (bestX) { const d = Math.trunc(bestX.delta); if (d) p.x += d; }
  if (bestY) { const d = Math.trunc(bestY.delta); if (d) p.y += d; }
  return { x: bestX, y: bestY };
}

/** Draw the alignment hairlines (full extent through both pieces) into the guides overlay. */
export function drawAlignLines(ctx: Contexte, al: Alignement | null | undefined): void {
  if (!al) return;
  const host = focusEl(ctx); if (!host) return;
  let cont = host.querySelector<HTMLElement>(".guides");
  if (!cont) { cont = document.createElement("div"); cont.className = "guides"; host.appendChild(cont); }
  const acc = resolveColor("var(--accent)");
  const mkline = (x1: number, y1: number, x2: number, y2: number): void => {
    const sa = aptToLayerPx(ctx, x1, y1), sb = aptToLayerPx(ctx, x2, y2);
    const el = document.createElement("div"); el.className = "gline";
    el.style.position = "absolute"; el.style.left = Math.min(sa.x, sb.x) + "px"; el.style.top = Math.min(sa.y, sb.y) + "px";
    if (x1 === x2) { el.style.width = "0"; el.style.height = Math.abs(sb.y - sa.y) + "px"; el.style.borderLeft = "1px solid " + acc; }
    else { el.style.height = "0"; el.style.width = Math.abs(sb.x - sa.x) + "px"; el.style.borderTop = "1px solid " + acc; }
    el.style.opacity = "0.7";
    cont!.appendChild(el);
  };
  if (al.x) mkline(al.x.line, al.x.y0, al.x.line, al.x.y1);
  if (al.y) mkline(al.y.x0, al.y.line, al.y.x1, al.y.line);
}

/** Draw up-to-4 axis guides from the dragged piece p to the nearest obstacle (piece or wall) each side. */
export function drawGuides(
  ctx: Contexte,
  p: Meuble,
  snapDir: { x: number; y: number } | null | undefined,
): void {
  clearGuides(ctx);
  if (isWallMount(p.type)) return;   // wall-stuck pieces use their own along-wall guides
  const P = ctx.etat.plan;
  const calques = ctx.etat.opts;
  const box = pieceAABB(p);
  // feature 4: if snapped to a table, suppress the guide toward that table (gap is 0)
  let suppress: string | null = null;
  if (snapDir) {
    if (Math.abs(snapDir.y) >= Math.abs(snapDir.x)) suppress = snapDir.y < 0 ? "up" : "down";
    else suppress = snapDir.x < 0 ? "left" : "right";
  }
  // candidate AABBs: other solid, non-opening, non-soft pieces
  const cands: AABB[] = [];
  for (const q of (P && P.pieces) || []) {
    if (q.id === p.id) continue;
    if (!pieceVisible(q, calques)) continue;   // Feature B: hidden layers aren't gap targets
    const t = TYPEMAP[q.type]; if (t && (t.opening || t.wallMount || t.soft)) continue;
    cands.push(pieceAABB(q));
  }
  const cont = document.createElement("div"); cont.className = "guides";
  // dir: [axis, sign]; vertical dirs need x-overlap, horizontal need y-overlap
  const specs: { dir: string; axis: "x" | "y"; sign: number }[] = [
    { dir: "up",    axis: "y", sign: -1 },
    { dir: "down",  axis: "y", sign:  1 },
    { dir: "left",  axis: "x", sign: -1 },
    { dir: "right", axis: "x", sign:  1 },
  ];
  for (const sp of specs) {
    if (sp.dir === suppress) continue;   // chair snapped flush to a table on this side
    let gap = Infinity;
    // nearest facing piece in this direction with cross-axis overlap > 0
    for (const c of cands) {
      if (sp.axis === "y") {
        if (!(c.x0 < box.x1 && c.x1 > box.x0)) continue;         // x-interval overlap
        const d = sp.sign < 0 ? box.y0 - c.y1 : c.y0 - box.y1;   // facing-edge gap
        if (d > 0 && d < gap) gap = d;
      } else {
        if (!(c.y0 < box.y1 && c.y1 > box.y0)) continue;
        const d = sp.sign < 0 ? box.x0 - c.x1 : c.x0 - box.x1;
        if (d > 0 && d < gap) gap = d;
      }
    }
    // no piece nearer -> ray-cast to wall from the facing-edge midpoint
    let a: PointCm, b: PointCm;   // span endpoints [cm]
    if (sp.axis === "y") {
      const mx = (box.x0 + box.x1) / 2, ey = sp.sign < 0 ? box.y0 : box.y1;
      if (!isFinite(gap)) { const r = rayToPoly(P, mx, ey, 0, sp.sign); if (r == null) continue; gap = r; }
      a = { x: mx, y: ey }; b = { x: mx, y: ey + sp.sign * gap };
    } else {
      const my = (box.y0 + box.y1) / 2, ex = sp.sign < 0 ? box.x0 : box.x1;
      if (!isFinite(gap)) { const r = rayToPoly(P, ex, my, sp.sign, 0); if (r == null) continue; gap = r; }
      a = { x: ex, y: my }; b = { x: ex + sp.sign * gap, y: my };
    }
    if (gap > 400 || gap < 1) continue;
    addGuideLine(ctx, cont, a, b, Math.round(gap) + " cm", sp.axis);
  }
  if (cont.children.length) { const host = focusEl(ctx); if (host) host.appendChild(cont); }
}

/** Draw one dashed line (a->b, axis-aligned) plus a centered cm chip. axis "x"=horizontal line. */
export function addGuideLine(
  ctx: Contexte, cont: HTMLElement, a: PointCm, b: PointCm, text: string, axis: "x" | "y",
): void {
  const sa = aptToLayerPx(ctx, a.x, a.y), sbp = aptToLayerPx(ctx, b.x, b.y);
  const line = document.createElement("div");
  if (axis === "x") {
    line.className = "gline h";
    line.style.left = Math.min(sa.x, sbp.x) + "px"; line.style.top = sa.y + "px";
    line.style.width = Math.abs(sbp.x - sa.x) + "px";
  } else {
    line.className = "gline v";
    line.style.left = sa.x + "px"; line.style.top = Math.min(sa.y, sbp.y) + "px";
    line.style.height = Math.abs(sbp.y - sa.y) + "px";
  }
  cont.appendChild(line);
  const lab = document.createElement("div"); lab.className = "glab"; lab.textContent = text;
  lab.style.left = ((sa.x + sbp.x) / 2) + "px"; lab.style.top = ((sa.y + sbp.y) / 2) + "px";
  cont.appendChild(lab);
}

export interface InfoMurOuverture {
  ei: string;
  t: number;
  halfW: number;
  segLen: number;
  ax: number;
  ay: number;
  ux: number;
  uy: number;
}

// openingWallInfo(p): an opening's supporting wall + its position along the wall. apartment cm.
// An opening is PARAMETRIC (wallId + t0): t0 is the only unknown, never x/y.
export function openingWallInfo(
  P: PlanV5 | null | undefined,
  p: Ouverture | null | undefined,
): InfoMurOuverture | null {
  if (!p || p.wallId === undefined) return null;
  const w = v5WallById(P, p.wallId); if (!w) return null;
  const s = v5Seg(w);
  return {
    ei: String(w.id), t: p.t0 + p.w / 2, halfW: p.w / 2, segLen: s.L,
    ax: w.a[0], ay: w.a[1], ux: s.ux, uy: s.uy,
  };
}

/** Draw an arbitrary-angle dashed segment + centered chip (used for along-wall opening guides). */
export function addGuideSeg(
  ctx: Contexte, cont: HTMLElement, a: PointCm, b: PointCm, text: string,
): void {
  const sa = aptToLayerPx(ctx, a.x, a.y), sbp = aptToLayerPx(ctx, b.x, b.y);
  const len = Math.hypot(sbp.x - sa.x, sbp.y - sa.y);
  const ang = Math.atan2(sbp.y - sa.y, sbp.x - sa.x) * 180 / Math.PI;
  const line = document.createElement("div"); line.className = "gline h";
  line.style.left = sa.x + "px"; line.style.top = sa.y + "px";
  line.style.width = len + "px";
  line.style.transformOrigin = "0 0"; line.style.transform = `rotate(${ang}deg)`;
  cont.appendChild(line);
  const lab = document.createElement("div"); lab.className = "glab"; lab.textContent = text;
  lab.style.left = ((sa.x + sbp.x) / 2) + "px"; lab.style.top = ((sa.y + sbp.y) / 2) + "px";
  cont.appendChild(lab);
}

// Feature 1: set a table's absolute rotation, orbiting its docked chairs by the same delta.
// `riders` optional (precomputed); otherwise detects docked chairs now.
export function rotatePieceWithChairs(
  P: PlanV5 | null | undefined,
  p: Meuble,
  newRot: number,
  riders?: Meuble[] | null,
): void {
  const r = ((Math.round(newRot) % 360) + 360) % 360;
  const dRot = r - (p.rot || 0);
  if (TABLE_TYPES.has(p.type) && dRot) {
    const chairs = riders || dockedChairs(P, p, 3);
    const tcx = p.x + p.w / 2, tcy = p.y + p.h / 2;
    const rad = dRot * Math.PI / 180, cr = Math.cos(rad), sr = Math.sin(rad);
    chairs.forEach((ch) => {
      const cchx = ch.x + ch.w / 2, cchy = ch.y + ch.h / 2;
      const rx = cchx - tcx, ry = cchy - tcy;
      ch.x = Math.round(tcx + rx * cr - ry * sr - ch.w / 2); ch.y = Math.round(tcy + rx * sr + ry * cr - ch.h / 2);
      ch.rot = ((Math.round((ch.rot || 0) + dRot) % 360) + 360) % 360;
    });
  }
  p.rot = r;
}
