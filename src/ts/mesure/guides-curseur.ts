// src/ts/mesure/guides-curseur.ts: THE CURSOR-DISTANCE PROBE (Measure mode only).
// Ported from src/js/06-mesure.js (`allBlockerAABBsApt`, `rayToAnyPolyApt`, `cursorDistances`,
// `drawCursorGuides`, `scheduleCursorGuides`, `clearCursorGuides`).
//
// This is the "bare cursor" analogue of a piece of furniture's drag guides. On every move in
// Measure mode, we cast four rays (up, down, left, right) from the apartment point under the cursor
// to the nearest obstacle (bounding-box edge of a piece of furniture, over the WHOLE plan, OR a
// cell wall / the outline) and lay down an accent thread plus a cm chip on each side.
//
// EPHEMERAL: these guides coexist with the measuring tape's segments, are cleared on `pointerleave`
// and on exiting the mode, and are paced by `requestAnimationFrame`. At rest, `#cursorGuides`
// is empty: no `.cgchip` can ever enter the render fingerprint.

import type { Contexte } from "../app/contexte.ts";
import type { Meuble, Pt } from "../partage/plan.ts";
import { $ } from "../noyau/dom.ts";
import { TYPEMAP, pieceVisible, type ItemCatalogue } from "../catalogue/catalogue.ts";
import { pieceAABB } from "../gestes/guides.ts";
import { measureMode } from "../gestes/etat-pointeur.ts";
import { aptToScreen } from "../rendu/vue.ts";

/** cm: beyond this, we no longer read anything in that direction. */
const CURSOR_GUIDE_MAX = 500;

export interface BoiteObstacle {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface DistanceCurseur {
  dir: "up" | "down" | "left" | "right";
  axis: "x" | "y";
  dist: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
}

/** Every SOLID piece of furniture (not an opening, not wall-mounted, not soft) as a bounding box, apartment cm. */
function allBlockerAABBsApt(ctx: Contexte): BoiteObstacle[] {
  const out: BoiteObstacle[] = [];
  ((ctx.etat.plan && ctx.etat.plan.pieces) || []).forEach((p: Meuble) => {
    const t: Partial<ItemCatalogue> = TYPEMAP[p.type] || {};
    if (t.opening || t.wallMount || t.soft) return;
    if (!pieceVisible(p, ctx.etat.opts)) return;
    const b = pieceAABB(p);           // axis-aligned box, rotation included, already in apartment cm
    out.push({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 });
  });
  return out;
}

/** Ray from (ox,oy) in the unit direction (dx,dy) to the nearest cell edge. */
function rayToAnyPolyApt(ctx: Contexte, ox: number, oy: number, dx: number, dy: number): number | null {
  let best = Infinity;
  const scan = (poly: readonly Pt[]): void => {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const pj = poly[j]!, pi = poly[i]!;
      const ax = pj[0], ay = pj[1], bx = pi[0], by = pi[1];
      const ex = bx - ax, ey = by - ay;
      const den = dx * ey - dy * ex; if (Math.abs(den) < 1e-9) continue;
      const t = ((ax - ox) * ey - (ay - oy) * ex) / den;
      const u = ((ax - ox) * dy - (ay - oy) * dx) / den;
      if (t > 1e-6 && u >= -1e-6 && u <= 1 + 1e-6 && t < best) best = t;
    }
  };
  const P = ctx.etat.plan;
  if (!P) return null;
  (P.cells || []).forEach((c) => scan(c.poly));
  if (Array.isArray(P.outline) && P.outline.length > 2) scan(P.outline);
  return isFinite(best) ? best : null;
}

/**
 * Up to four `{dir,dist,from,to}` (apartment cm) from (ax,ay) toward the nearest furniture edge
 * (with overlap on the cross axis) OR the wall, in each direction. A direction with no
 * hit within `CURSOR_GUIDE_MAX` is omitted.
 */
function cursorDistances(ctx: Contexte, ax: number, ay: number): DistanceCurseur[] {
  const cands = allBlockerAABBsApt(ctx);
  const specs = [
    { dir: "up" as const, axis: "y" as const, sign: -1 },
    { dir: "down" as const, axis: "y" as const, sign: 1 },
    { dir: "left" as const, axis: "x" as const, sign: -1 },
    { dir: "right" as const, axis: "x" as const, sign: 1 },
  ];
  const out: DistanceCurseur[] = [];
  for (const sp of specs) {
    let gap = Infinity;
    for (const c of cands) {
      if (sp.axis === "y") {
        if (!(c.x0 < ax && c.x1 > ax)) continue;                    // the cursor is within the furniture's x band
        const d = sp.sign < 0 ? ay - c.y1 : c.y0 - ay;              // gap to the facing edge
        if (d > 0 && d < gap) gap = d;
      } else {
        if (!(c.y0 < ay && c.y1 > ay)) continue;
        const d = sp.sign < 0 ? ax - c.x1 : c.x0 - ax;
        if (d > 0 && d < gap) gap = d;
      }
    }
    if (!isFinite(gap)) {                                           // no furniture facing it: ray toward the wall
      const r = (sp.axis === "y") ? rayToAnyPolyApt(ctx, ax, ay, 0, sp.sign) : rayToAnyPolyApt(ctx, ax, ay, sp.sign, 0);
      if (r == null) continue;
      gap = r;
    }
    if (gap < 0.5 || gap > CURSOR_GUIDE_MAX) continue;
    const to = (sp.axis === "y") ? { x: ax, y: ay + sp.sign * gap } : { x: ax + sp.sign * gap, y: ay };
    out.push({ dir: sp.dir, axis: sp.axis, dist: gap, from: { x: ax, y: ay }, to });
  }
  return out;
}

export function clearCursorGuides(): void { const ov = $("cursorGuides"); if (ov) ov.innerHTML = ""; }

/**
 * Paints the live four-branch reading at the apartment point (ax,ay) into `#cursorGuides` (screen
 * px), reusing the measuring tape's thread and chip. Replaces the previous frame; a null `ax`
 * clears it.
 */
export function drawCursorGuides(ctx: Contexte, ax: number | null, ay?: number): void {
  const ov = $("cursorGuides"); if (!ov) return;
  ov.innerHTML = "";
  if (!measureMode() || ax == null) return;
  const dirs = cursorDistances(ctx, ax, ay as number);
  for (const g of dirs) {
    const sa = aptToScreen(ctx, g.from.x, g.from.y), sb = aptToScreen(ctx, g.to.x, g.to.y);
    const len = Math.hypot(sb.x - sa.x, sb.y - sa.y);
    const ang = Math.atan2(sb.y - sa.y, sb.x - sa.x) * 180 / Math.PI;
    const line = document.createElement("div"); line.className = "cgline";
    line.style.left = sa.x + "px"; line.style.top = sa.y + "px";
    line.style.width = len + "px"; line.style.transform = "rotate(" + ang + "deg)";
    ov.appendChild(line);
    // R-1: the chip is in SCREEN coordinates. The thread rotates with the direction, the number stays upright.
    const chip = document.createElement("div"); chip.className = "cgchip";
    chip.style.left = ((sa.x + sb.x) / 2) + "px"; chip.style.top = ((sa.y + sb.y) / 2) + "px";
    chip.textContent = Math.round(g.dist) + " cm";
    ov.appendChild(chip);
  }
}

let cursorGuideRaf = 0;
let cursorGuidePending: { x: number; y: number } | null = null;

export function scheduleCursorGuides(ctx: Contexte, ax: number | null, ay?: number): void {
  cursorGuidePending = (ax == null) ? null : { x: ax, y: ay as number };
  if (cursorGuideRaf) return;
  cursorGuideRaf = requestAnimationFrame(() => {
    cursorGuideRaf = 0;
    if (!measureMode() || !cursorGuidePending) { clearCursorGuides(); return; }
    drawCursorGuides(ctx, cursorGuidePending.x, cursorGuidePending.y);
  });
}
