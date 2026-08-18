// src/ts/gestes/edition-murs.ts — THE OUTLINE'S ORTHOGONAL SNAP AND ITS GUIDES.
// Ported from src/js/15-edition-murs.js (`orthoTol`, `orthoSnapAxis`, `orthoSnapVertex`,
// `clearStitchGuides`, `drawOrthoGuides`, `checkShapeWarn`).
//
// The snap pulls the moved vertex so its incident edges become AXIAL as soon as another
// vertex of the SAME polygon shares an X/Y within tolerance. Both axes can snap, which
// gives a 90° corner. ORDER: the caller applies the GRID first, then this.
//
// THE OUTLINE MUST NOT SELF-INTERSECT, AND ONLY ONE PLACE SAYS SO: the cell card (`#rcWarn`),
// which follows a selected facade or corner. The old `#shapeWarn` banner used to live INSIDE
// the config modal, hidden as soon as you edit the outline: it could never display.

import type { Contexte } from "../app/contexte.ts";
import type { Pt } from "../partage/plan.ts";
import { $ } from "../noyau/dom.ts";
import { selfIntersects } from "../geometrie/polygones.ts";
import { resolveColor } from "../rendu/couleurs.ts";
import { aptToScreen } from "../rendu/vue.ts";

const ORTHO_TOL_CM = 8;
/** 8 cm or 8 px, whichever is bigger: at low zoom, 8 cm is only a few pixels. */
const orthoTol = (scale: number): number => Math.max(ORTHO_TOL_CM, 8 / scale);

export interface GuideOrtho { axis: "x" | "y"; line: number; a: number; b: number }

/**
 * Snaps ONE axis of the dragged vertex to the coordinate of the closest vertex of the same
 * polygon on that axis. Both NEIGHBORS win (they make an incident edge perfectly H/V), then
 * any other vertex. Returns `{val, target}` (`target` = aligned index, or -1).
 */
function orthoSnapAxis(
  poly: readonly Pt[], i: number, val: number, ax: "x" | "y", scale: number,
): { val: number; target: number } {
  const c = (ax === "x") ? 0 : 1, tol = orthoTol(scale), n = poly.length;
  const prev = (i - 1 + n) % n, next = (i + 1) % n;
  let best: { d: number; ad: number; pri: number; k: number } | null = null;
  const consider = (k: number, pri: number): void => {
    if (k === i) return;
    const pt = poly[k]; if (!pt) return;
    const d = pt[c]! - val; const ad = Math.abs(d);
    if (ad > tol) return;
    // rank: neighbors (pri 0) beat distant vertices (pri 1); same rank, the closest one wins.
    if (!best || pri < best.pri || (pri === best.pri && ad < best.ad)) best = { d, ad, pri, k };
  };
  consider(prev, 0); consider(next, 0);
  for (let k = 0; k < n; k++) { if (k !== prev && k !== next) consider(k, 1); }
  if (!best) return { val, target: -1 };
  const b = best as { d: number; ad: number; pri: number; k: number };
  return { val: val + b.d, target: b.k };
}

/**
 * Full snap of vertex `i` to the post-grid apartment position `(lx,ly)`. `shiftLock` forces a
 * purely horizontal OR vertical pull relative to `(sx,sy)`, the drag's starting point:
 * the locked axis is chosen from the dominant movement, so a small crossing movement is discarded.
 */
export function orthoSnapVertex(
  poly: readonly Pt[], i: number, lx: number, ly: number,
  shiftLock: boolean, sx: number, sy: number, scale: number,
): { x: number; y: number; guides: GuideOrtho[] } {
  let x = lx, y = ly;
  if (shiftLock) {
    if (Math.abs(lx - sx) >= Math.abs(ly - sy)) y = sy; else x = sx;
  }
  const sX = orthoSnapAxis(poly, i, x, "x", scale);
  const sY = orthoSnapAxis(poly, i, y, "y", scale);
  x = sX.val; y = sY.val;
  const guides: GuideOrtho[] = [];
  if (sX.target >= 0) guides.push({ axis: "x", line: x, a: y, b: poly[sX.target]![1]! });
  if (sY.target >= 0) guides.push({ axis: "y", line: y, a: x, b: poly[sY.target]![0]! });
  return { x, y, guides };
}

/** The snapping guides live on the canvas (viewport px via `aptToScreen`). */
export function clearStitchGuides(ctx: Contexte): void {
  const g = ctx.canvas.querySelector(".ov-guides"); if (g) g.remove();
}

export function drawOrthoGuides(ctx: Contexte, guides: GuideOrtho[] | null | undefined): void {
  clearStitchGuides(ctx);
  if (!guides || !guides.length) return;
  const cont = document.createElement("div"); cont.className = "ov-guides";
  const acc = resolveColor("var(--accent)");
  const pad = 14;   // cm of overshoot, so the line clearly connects the two corners
  guides.forEach((g) => {
    const el = document.createElement("div");
    el.className = "gline"; el.style.position = "absolute"; el.style.opacity = "0.85";
    const lo = Math.min(g.a, g.b) - pad, hi = Math.max(g.a, g.b) + pad;
    if (g.axis === "x") {   // vertical line at X=g.line, covering Y from lo to hi
      const s0 = aptToScreen(ctx, g.line, lo), s1 = aptToScreen(ctx, g.line, hi);
      el.style.left = s0.x + "px"; el.style.top = Math.min(s0.y, s1.y) + "px";
      el.style.width = "0"; el.style.height = Math.abs(s1.y - s0.y) + "px";
      el.style.borderLeft = "1px solid " + acc;
    } else {                // horizontal line at Y=g.line, covering X from lo to hi
      const s0 = aptToScreen(ctx, lo, g.line), s1 = aptToScreen(ctx, hi, g.line);
      el.style.left = Math.min(s0.x, s1.x) + "px"; el.style.top = s0.y + "px";
      el.style.height = "0"; el.style.width = Math.abs(s1.x - s0.x) + "px";
      el.style.borderTop = "1px solid " + acc;
    }
    cont.appendChild(el);
  });
  ctx.canvas.appendChild(cont);
}

/**
 * Called on EVERY geometry change (`v5AfterGeometry`): crossing the outline by dragging a
 * vertex lights up the warning right away, uncrossing it turns it off.
 */
export function checkShapeWarn(ctx: Contexte): void {
  const rw = $("rcWarn"); if (!rw) return;
  const poly = (ctx.etat.plan && ctx.etat.plan.outline) || [];
  const selection = ctx.ihm.selWall
    ? (ctx.etat.plan.walls || []).find((w) => String(w.id) === String(ctx.ihm.selWall))
    : null;
  rw.classList.toggle("on", (!!selection?.isOutline || ctx.selVtx >= 0) && poly.length > 2 && selfIntersects(poly));
}
