// src/ts/rendu/vue.ts: THE VIEW TRANSFORM, and nothing else.
//
// G-2, the point of this module: THE VIEW IS NOT THE PLAN. Panning, zooming, pinching, "Fit" and
// window resizing repaint WITHOUT PERSISTING ANYTHING: no local write, no rearmed debounced send,
// no blocked remote adoption, no analysis. The `ctx.viewOnly` counter carries this distinction;
// `renderView()` is the only one to increment it.

import type { Cellule } from "../partage/plan.ts";
import type { BBox } from "../geometrie/polygones.ts";
import type { Contexte } from "../app/contexte.ts";
import { bboxOfPoly } from "../geometrie/polygones.ts";
import { v5SignedArea } from "../modele/aires.ts";
import { clamp, fmtM2 } from "../noyau/nombres.ts";
import { $ } from "../noyau/dom.ts";

/** Margin (px) left around the plan by "Fit". */
const FIT_PAD = 56;

export interface Point {
  x: number;
  y: number;
}

/** apartment cm -> viewport px. THE conversion, with its inverse: there is no other. */
export const aptToScreen = (ctx: Contexte, x: number, y: number): Point =>
  ({ x: ctx.vue.ox + x * ctx.vue.scale, y: ctx.vue.oy + y * ctx.vue.scale });

export const screenToApt = (ctx: Contexte, px: number, py: number): Point =>
  ({ x: (px - ctx.vue.ox) / ctx.vue.scale, y: (py - ctx.vue.oy) / ctx.vue.scale });

/** Pointer -> APARTMENT cm. EVERY gesture goes through here (src/js/51). */
export const evtApt = (ctx: Contexte, ev: { clientX: number; clientY: number }): Point => {
  const vr = ctx.viewport.getBoundingClientRect();
  return screenToApt(ctx, ev.clientX - vr.left, ev.clientY - vr.top);
};

/**
 * THE APARTMENT IS THE OUTLINE: it is the only framing box (the old `roomBBox()` read the
 * focused room, there is no more room). The 420×360 fallback is the default plan.
 */
export function aptBBox(ctx: Contexte): BBox {
  return bboxOfPoly(((ctx.etat.plan && ctx.etat.plan.outline) || []) as [number, number][]);
}

export interface BornesEchelle {
  fit: number;
  min: number;
  max: number;
}

/** `scale` bounds: fit/4 .. 6 px/cm, never below 0.05, never above 8. */
export function scaleBounds(ctx: Contexte): BornesEchelle {
  const u = aptBBox(ctx);
  const vw = ctx.viewport.clientWidth - FIT_PAD * 2, vh = ctx.viewport.clientHeight - FIT_PAD * 2;
  let fit = Math.min(vw / u.w, vh / u.l);
  if (!isFinite(fit) || fit <= 0) fit = 0.5;
  return { fit, min: Math.max(0.05, fit / 4), max: Math.min(8, 6) };
}

/**
 * Repaints WITHOUT PERSISTING (G-2). Rendering goes through a callback wired at bootstrap rather
 * than through a direct import: that is what avoids a `vue -> rendu -> vue` cycle, and it makes it
 * visible that the view knows nothing of rendering beyond "repaint".
 */
let _repeindre: (() => void) | null = null;
export function brancherRendu(fn: () => void): void { _repeindre = fn; }

export function renderView(ctx: Contexte): void {
  ctx.viewOnly++;
  try { if (_repeindre) _repeindre(); } finally { ctx.viewOnly--; }
}

/** Frames the whole apartment (initial view and "Fit" button). */
export function fitView(ctx: Contexte): void {
  const u = aptBBox(ctx);
  const { fit, min, max } = scaleBounds(ctx);
  ctx.vue.scale = clamp(fit, min, max);
  const rw = u.w * ctx.vue.scale, rl = u.l * ctx.vue.scale;
  ctx.vue.ox = Math.round((ctx.viewport.clientWidth - rw) / 2 - u.minX * ctx.vue.scale);
  ctx.vue.oy = Math.round((ctx.viewport.clientHeight - rl) / 2 - u.minY * ctx.vue.scale);
  renderView(ctx);
}

/** Frames a CELL ± margin (click on a rail chip). */
export function fitCell(ctx: Contexte, c: Cellule | null | undefined): void {
  if (!c || !Array.isArray(c.poly) || c.poly.length < 3) return;
  const b = bboxOfPoly(c.poly);
  const { min, max } = scaleBounds(ctx);
  const vw = ctx.viewport.clientWidth - FIT_PAD * 2, vh = ctx.viewport.clientHeight - FIT_PAD * 2;
  let s = Math.min(vw / b.w, vh / b.l);
  if (!isFinite(s) || s <= 0) s = 0.5;
  ctx.vue.scale = clamp(s, min, max);
  const rw = b.w * ctx.vue.scale, rl = b.l * ctx.vue.scale;
  ctx.vue.ox = Math.round((ctx.viewport.clientWidth - rw) / 2 - b.minX * ctx.vue.scale);
  ctx.vue.oy = Math.round((ctx.viewport.clientHeight - rl) / 2 - b.minY * ctx.vue.scale);
  renderView(ctx);
}

/** Zooms by factor `f` while keeping the apartment point under (cx,cy) screen fixed. */
export function zoomAt(ctx: Contexte, cxScreen: number, cyScreen: number, f: number): void {
  const { min, max } = scaleBounds(ctx);
  const ns = clamp(ctx.vue.scale * f, min, max);
  if (ns === ctx.vue.scale) return;
  const apt = screenToApt(ctx, cxScreen, cyScreen);
  ctx.vue.scale = ns;
  ctx.vue.ox = cxScreen - apt.x * ctx.vue.scale;
  ctx.vue.oy = cyScreen - apt.y * ctx.vue.scale;
  renderView(ctx);
}

/**
 * The toolbar: dwelling dimensions, scale, total area and room count.
 * R-12: the area goes through `fmtM2`, like the rail chip and the room sheet. The same number
 * used to be written in three forms a few pixels apart.
 */
export function updateReadout(ctx: Contexte): void {
  const u = aptBBox(ctx);
  const sr = $("scaleReadout");
  if (sr) {
    sr.textContent = `${(u.w / 100).toFixed(2)} × ${(u.l / 100).toFixed(2)} m  ·  scale 1:${Math.round(100 / ctx.vue.scale) || "?"}  ·  grid = 1 m`;
  }
  const P = ctx.etat.plan;
  const tot = (P && Array.isArray(P.outline) && P.outline.length > 2) ? Math.abs(v5SignedArea(P.outline)) / 10000 : 0;
  const nc = ((P && P.cells) || []).length;
  const ac = $("areaChip");
  if (ac) ac.textContent = tot ? `total ${fmtM2(tot * 10000)} · ${nc} ${nc > 1 ? "rooms" : "room"}` : "";
}
