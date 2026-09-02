// src/ts/mesure/mesure.ts: THE MEASURING TAPE. Ephemeral, never persisted, PERSONAL.
// Ported from src/js/06-mesure.js, plus the three wiring points that lived elsewhere in
// the old client (the toolbar button and hover, src/js/22; Escape, src/js/33).
//
// MODEL: a measurement is `{a:{x,y}, b:{x,y}}` in APARTMENT cm. A pending point, set on the
// first click, plus a rubber band to the cursor (snapped) as long as the second click hasn't
// landed. SNAPPING prefers, in this order: furniture corners > outline and cell vertices
// > nearest wall line (foot of the perpendicular), so that "between this couch and this
// wall" is exact. The final point is snapped to the centimeter.
//
// NONE OF THIS EXISTS AT REST: `#measures` is emptied on every render and only fills back up
// if the tool is on or a measurement has been placed. The render fingerprint therefore never sees a
// `.mchip` on a plan that hasn't been measured.

import type { Contexte } from "../app/contexte.ts";
import type { Meuble } from "../partage/plan.ts";
import { $ } from "../noyau/dom.ts";
import { v5NearestWall } from "../modele/edition.ts";
import { aptToScreen, renderView, screenToApt } from "../rendu/vue.ts";
import { clearSel } from "../rendu/selection.ts";
import {
  TOUCH_DRAG_THRESH, isTouchEvt, measureMode, setMeasureModeFlag, touchPts,
} from "../gestes/etat-pointeur.ts";
import { armGesture } from "../gestes/sortie.ts";
import { clearCursorGuides, drawCursorGuides, scheduleCursorGuides } from "./guides-curseur.ts";

export interface PointMesure {
  x: number;
  y: number;
}

export interface PointAccroche extends PointMesure {
  kind: "corner" | "vertex" | "wall" | "free";
}

export interface Segment {
  a: PointMesure;
  b: PointMesure;
}

let measures: Segment[] = [];       // validated segments (apartment cm)
let measurePend: PointMesure | null = null;   // first point placed, waiting for the second
let measureCur: PointMesure | null = null;    // last snapped cursor point (the live rubber band)

export const mesuresPosees = (): Segment[] => measures;
export const mesureEnAttente = (): PointMesure | null => measurePend;

/** Tolerance in cm equivalent to ~14 screen px at the current zoom (6 cm minimum, zoomed-out view). */
function measureTol(ctx: Contexte): number { return Math.max(6, 14 / (ctx.vue.scale || 1)); }

/** Every furniture corner in APARTMENT cm, rotation included. */
export function allPieceCornersApt(ctx: Contexte): PointMesure[] {
  const out: PointMesure[] = [];
  ((ctx.etat.plan && ctx.etat.plan.pieces) || []).forEach((p: Meuble) => {
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2, rad = (p.rot || 0) * Math.PI / 180;
    const cs = Math.cos(rad), sn = Math.sin(rad);
    const hw = p.w / 2, hh = p.h / 2;
    ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as const).forEach(([lx, ly]) => {
      out.push({ x: cx + lx * cs - ly * sn, y: cy + lx * sn + ly * cs });
    });
  });
  return out;
}

/** Every vertex of the outline and the cells, in APARTMENT cm. */
function allVerticesApt(ctx: Contexte): PointMesure[] {
  const out: PointMesure[] = []; const P = ctx.etat.plan;
  if (!P) return out;
  (P.outline || []).forEach(([x, y]) => out.push({ x, y }));
  (P.cells || []).forEach((c) => c.poly.forEach(([x, y]) => out.push({ x, y })));
  return out;
}

/**
 * Snaps an apartment-cm point to the nearest line (corner > vertex > wall), within `tol`.
 * The resulting point is snapped to the whole centimeter.
 */
export function snapMeasurePoint(ctx: Contexte, ax: number, ay: number, tol?: number | null): PointAccroche {
  const t = (tol == null ? measureTol(ctx) : tol);
  let best: (PointAccroche & { d: number }) | null = null;
  const take = (pt: PointMesure, kind: PointAccroche["kind"], d: number): void => {
    if (!best || d < best.d) best = { x: pt.x, y: pt.y, kind, d };
  };
  for (const c of allPieceCornersApt(ctx)) { const d = Math.hypot(c.x - ax, c.y - ay); if (d <= t) take(c, "corner", d); }
  if (!best) { for (const v of allVerticesApt(ctx)) { const d = Math.hypot(v.x - ax, v.y - ay); if (d <= t) take(v, "vertex", d); } }
  if (!best) { const w = v5NearestWall(ctx.etat.plan, ax, ay, t); if (w) take({ x: w.x, y: w.y }, "wall", w.dist); }
  if (!best) return { x: Math.round(ax), y: Math.round(ay), kind: "free" };
  const b = best as PointAccroche & { d: number };
  return { x: Math.round(b.x), y: Math.round(b.y), kind: b.kind };
}

/** Distance in cm between two apartment-cm points. */
export function measureDistCm(a: PointMesure, b: PointMesure): number { return Math.hypot(b.x - a.x, b.y - a.y); }

/** Paints all measurements + the live rubber band into `#measures` (screen px via `aptToScreen`). */
export function drawMeasures(ctx: Contexte): void {
  const ov = $("measures"); if (!ov) return;
  ov.innerHTML = "";
  if (!measureMode() && measures.length === 0) return;
  const seg = (a: PointMesure, b: PointMesure, idx: number | null): void => {
    const sa = aptToScreen(ctx, a.x, a.y), sb = aptToScreen(ctx, b.x, b.y);
    const len = Math.hypot(sb.x - sa.x, sb.y - sa.y);
    const ang = Math.atan2(sb.y - sa.y, sb.x - sa.x) * 180 / Math.PI;
    const line = document.createElement("div"); line.className = "mseg";
    line.style.left = sa.x + "px"; line.style.top = sa.y + "px";
    line.style.width = len + "px"; line.style.transform = "rotate(" + ang + "deg)";
    ov.appendChild(line);
    [sa, sb].forEach((s) => {
      const t = document.createElement("div"); t.className = "mtick";
      t.style.left = s.x + "px"; t.style.top = s.y + "px"; t.style.transform = "rotate(" + ang + "deg)";
      ov.appendChild(t);
    });
    const dot0 = document.createElement("div"); dot0.className = "mdot"; dot0.style.left = sa.x + "px"; dot0.style.top = sa.y + "px"; ov.appendChild(dot0);
    const dot1 = document.createElement("div"); dot1.className = "mdot"; dot1.style.left = sb.x + "px"; dot1.style.top = sb.y + "px"; ov.appendChild(dot1);
    const d = measureDistCm(a, b);
    // R-1: the chip is in SCREEN coordinates, with no rotation at all. The line rotates, the number doesn't.
    const chip = document.createElement("div"); chip.className = "mchip";
    chip.style.left = ((sa.x + sb.x) / 2) + "px"; chip.style.top = ((sa.y + sb.y) / 2) + "px";
    chip.textContent = (d / 100).toFixed(2) + " m";
    if (idx != null) {
      const x = document.createElement("span"); x.className = "mx"; x.textContent = "✕";
      chip.title = "Click to delete this measurement";
      chip.appendChild(x);
      chip.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation(); ev.preventDefault(); measures.splice(idx, 1); drawMeasures(ctx);
      });
    }
    ov.appendChild(chip);
  };
  measures.forEach((m, i) => seg(m.a, m.b, i));
  if (measureMode() && measurePend && measureCur) seg(measurePend, measureCur, null);
}

function setMeasureCursor(ctx: Contexte, ax: number | null, ay?: number): void {
  measureCur = (ax == null) ? null : snapMeasurePoint(ctx, ax, ay as number);
}

export function clearMeasures(ctx: Contexte): void {
  measures = []; measurePend = null; measureCur = null; drawMeasures(ctx);
}

/**
 * Handles a click/tap at the apartment-cm point (ax,ay) in measure mode. The first click sets the
 * pending point, the second validates a segment and re-arms for the next one. Returns the validated
 * segment, or null.
 */
export function measureClickApt(ctx: Contexte, ax: number, ay: number): Segment | null {
  const p = snapMeasurePoint(ctx, ax, ay);
  if (!measurePend) { measurePend = { x: p.x, y: p.y }; measureCur = { x: p.x, y: p.y }; drawMeasures(ctx); return null; }
  const segObj: Segment = { a: measurePend, b: { x: p.x, y: p.y } };
  measures.push(segObj); measurePend = null; measureCur = null; drawMeasures(ctx);
  return segObj;
}

/** Resets the (pending point, cursor) pair, for a probe that chains two clicks. */
export function resetMeasurePending(): void { measurePend = null; measureCur = null; }

export function setMeasureMode(ctx: Contexte, on: boolean): void {
  const v = !!on;
  if (v === measureMode()) return;
  setMeasureModeFlag(v);
  measurePend = null; measureCur = null;
  if (v) measures = [];            // a fresh session every time the tool is turned on
  const b = $("btnMeasure");
  if (b) { b.setAttribute("aria-pressed", v ? "true" : "false"); b.classList.toggle("pri", v); }
  ctx.viewport.classList.toggle("measuring", v);
  // `.measuring` on `.app` makes furniture and handles inert to the pointer (CSS): that's what
  // lets the click bubble up to the viewport and become a measurement.
  document.querySelector(".app")?.classList.toggle("measuring", v);
  if (v) { clearSel(ctx); ctx.crochets.hideInspector?.(); }
  if (!v) { clearMeasures(ctx); clearCursorGuides(); } else { drawMeasures(ctx); }
}

export function brancherMesure(ctx: Contexte): void {
  // The layer render repaints measurements and clears stale guides (src/js/12). The
  // `apresRendu` call point is already taken by the opening handles: we WRAP it rather than
  // replace it, so that no sub-batch needs to know about the others.
  const avant = ctx.crochets.apresRendu;
  ctx.crochets.apresRendu = (): void => {
    avant?.();
    if (measureMode() || measures.length) drawMeasures(ctx);
    if (!measureMode()) clearCursorGuides();   // stale hovers; they come back on the next move
  };

  // Measuring is a read-only overlay and owns the pointer while it is armed.
  $("btnMeasure")?.addEventListener("click", () => {
    setMeasureMode(ctx, !measureMode());
  });

  // Live rubber band between the two clicks, and cursor-distance probe.
  ctx.viewport.addEventListener("pointermove", (e) => {
    if (!measureMode()) return;
    if (e.pointerType === "touch") return;   // touch has its own path (no hover)
    const vr = ctx.viewport.getBoundingClientRect();
    const a = screenToApt(ctx, e.clientX - vr.left, e.clientY - vr.top);
    setMeasureCursor(ctx, a.x, a.y);
    if (measurePend) drawMeasures(ctx);
    scheduleCursorGuides(ctx, a.x, a.y);
  });
  ctx.viewport.addEventListener("pointerleave", () => { scheduleCursorGuides(ctx, null); });

  // THE CLICK THAT MEASURES. The furniture gesture and the lasso bail out first thing on `measureMode()`
  // without stopping propagation: the event therefore arrives here, on the viewport.
  ctx.viewport.addEventListener("pointerdown", (e) => {
    if (!measureMode()) return;
    if (e.button !== 0 && e.button !== undefined) return;   // right/middle = panning
    const t = e.target as HTMLElement | null;
    if (t && t.closest && t.closest(".mchip")) return;      // the chip handles its own deletion
    e.preventDefault();
    const vr = ctx.viewport.getBoundingClientRect();
    const apt = screenToApt(ctx, e.clientX - vr.left, e.clientY - vr.top);
    // TOUCH: we wait for release and switch to panning if the finger travels (the
    // two-finger pinch has already been preempted by the capture layer). MOUSE: we place right
    // away, on `pointerdown`.
    if (isTouchEvt(e)) {
      const sx = e.clientX, sy = e.clientY; let moved = false;
      const mv = (ev: PointerEvent): void => {
        if (touchPts.size >= 2) { moved = true; return; }
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) >= TOUCH_DRAG_THRESH) {
          moved = true;
          const v = ctx.viewport.getBoundingClientRect();
          ctx.vue.ox = (ev.clientX - v.left) - apt.x * ctx.vue.scale;
          ctx.vue.oy = (ev.clientY - v.top) - apt.y * ctx.vue.scale;
          renderView(ctx);
        }
      };
      const upT = (ev?: Event | null): void => {
        window.removeEventListener("pointermove", mv);
        const pe = ev as PointerEvent | null | undefined;
        if (!moved && touchPts.size < 2 && pe) {
          const v = ctx.viewport.getBoundingClientRect();
          const a = screenToApt(ctx, pe.clientX - v.left, pe.clientY - v.top);
          measureClickApt(ctx, a.x, a.y);
        }
      };
      window.addEventListener("pointermove", mv); armGesture(upT);
      return;
    }
    measureClickApt(ctx, apt.x, apt.y);
  });

  // THE MEASURING TAPE OWNS THE KEYBOARD for its narrow set: Escape exits and clears, everything else is
  // inert (`gestes/clavier.ts` bails out first thing on `measureMode()`, without stopping propagation).
  window.addEventListener("keydown", (e) => {
    if (!measureMode()) return;
    const tgt = (e.target || {}) as HTMLElement;
    const typing = /INPUT|TEXTAREA|SELECT/.test(tgt.tagName || "") || tgt.isContentEditable;
    if (typing) return;
    if (e.key === "Escape") { e.preventDefault(); setMeasureMode(ctx, false); }
  });
}

/** Probe: the cursor-distance probe, drawn right away (without going through the rAF). */
export function drawCursorGuidesNow(ctx: Contexte, ax: number, ay: number): void { drawCursorGuides(ctx, ax, ay); }
