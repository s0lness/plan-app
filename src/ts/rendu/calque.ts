// src/ts/rendu/calque.ts — THE LAYER, the SINGLE editing container.
// Ported from src/js/50-v5-rendu.js (`renderV5`, `v5RenderBack`) and src/js/54-v5-interface.js
// (`v5RenderOpenings`, `v5RenderLabels`, `v5DrawHandles`).
//
// There is only ONE container, `.v5layer`, positioned on the outline's bbox: guides, handles and
// dimensions anchor to it. No more "focused room", so no more local reference frame.
//
// THE BACKGROUND IS CACHED, THE REST IS RECONCILED. Floors, wall bands and hit shapes are only
// rebuilt when the geometry, scale or layers change (`data-sig` signature). Furniture, openings,
// labels and handles are reconciled on EVERY render: a drag must not depend on a rebuild, and the
// DOM nodes hold closures.

import type { BBox } from "../geometrie/polygones.ts";
import type { Contexte } from "../app/contexte.ts";
import type { PlanV5, Pt } from "../partage/plan.ts";
import { TYPEMAP, pieceVisible } from "../catalogue/catalogue.ts";
import { bboxOfPoly, pointInPoly, poleOfInaccessibility, polyArea } from "../geometrie/polygones.ts";
import { v5OpeningBox } from "../modele/murs.ts";
import { WALL, escapeHtml, safeDim, v5R2 } from "../noyau/nombres.ts";
import { SVGNS, cssId } from "../noyau/dom.ts";
import { aptToScreen, evtApt } from "./vue.ts";
import { floorPatternDefs } from "./sol.ts";
import { resolveColor, withAlpha } from "./couleurs.ts";
import { pieceIconSVG } from "./icones.ts";
import { doorArcSVG, windowArcSVG } from "./arc-porte.ts";
import { polygoneFaisceau, projection } from "../modele/projection.ts";
import { renderPieces } from "./meubles.ts";
import { isSel } from "./selection.ts";
import type { CandidatEtiquetteCellule } from "./etiquettes-disposition.ts";
import { disposerEtiquettesCellules, obstaclesMeubles } from "./etiquettes-disposition.ts";

/** The layer, if mounted. */
export const focusEl = (ctx: Contexte): HTMLElement | null =>
  ctx.canvas.querySelector<HTMLElement>(".v5layer");

const finsSurvol = new WeakMap<Contexte, number>();
const survolBranche = new WeakSet<Contexte>();

function murPointe(t: EventTarget | null): string | null {
  const e = t instanceof Element ? t.closest<HTMLElement>("[data-w]") : null;
  return e?.dataset["w"] || null;
}

function montrerPoigneesMur(ctx: Contexte, layer: HTMLElement, wallId: string | null): void {
  const old = finsSurvol.get(ctx);
  if (old !== undefined) { window.clearTimeout(old); finsSurvol.delete(ctx); }
  if (wallId && !(ctx.etat.plan.walls || []).some((w) => String(w.id) === wallId)) wallId = null;
  if (ctx.ihm.hoverWall === wallId) return;
  ctx.ihm.hoverWall = wallId;
  const P = ctx.etat.plan;
  if (P?.outline?.length >= 3) drawHandles(ctx, layer, bboxOfPoly(P.outline), ctx.vue.scale);
}

function planifierMasquageMur(ctx: Contexte, layer: HTMLElement): void {
  const old = finsSurvol.get(ctx);
  if (old !== undefined) window.clearTimeout(old);
  const id = window.setTimeout(() => montrerPoigneesMur(ctx, layer, null), 120);
  finsSurvol.set(ctx, id);
}

function murGeometrique(ctx: Contexte, e: PointerEvent): string | null {
  const p = evtApt(ctx, e);
  let best: { id: string; d: number } | null = null;
  for (const w of (ctx.etat.plan.walls || [])) {
    const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1], ll = dx * dx + dy * dy;
    const u = ll ? Math.max(0, Math.min(1, ((p.x - w.a[0]) * dx + (p.y - w.a[1]) * dy) / ll)) : 0;
    const d = Math.hypot(p.x - (w.a[0] + u * dx), p.y - (w.a[1] + u * dy));
    const reach = Math.max((w.t || WALL) / 2, 7 / Math.max(0.01, ctx.vue.scale));
    if (d <= reach && (!best || d < best.d)) best = { id: String(w.id), d };
  }
  return best?.id || null;
}

function brancherSurvolMurs(ctx: Contexte): void {
  if (survolBranche.has(ctx)) return;
  survolBranche.add(ctx);
  // Geometric detection deliberately leaves transparent wall bands out of the hit-test stack.
  // A transparent DOM band would join the hit-test stack and could cover the furniture that is
  // visibly painted above it. Geometry only decides whether handles should be shown; the real DOM
  // target still decides what receives the press.
  ctx.viewport.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    const layer = focusEl(ctx); if (!layer) return;
    const direct = murPointe(e.target);
    if (direct) { montrerPoigneesMur(ctx, layer, direct); return; }
    const t = e.target instanceof Element ? e.target : null;
    // Furniture and openings are the visible target. Clear wall handles immediately so even a
    // direct jump onto a piece cannot leave a wall control above the following press.
    if (t?.closest(".piece,.ov-name")) { montrerPoigneesMur(ctx, layer, null); return; }
    const id = murGeometrique(ctx, e);
    if (id) montrerPoigneesMur(ctx, layer, id); else planifierMasquageMur(ctx, layer);
  });
  ctx.viewport.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    const layer = focusEl(ctx), t = e.target instanceof Element ? e.target : null;
    if (!layer || t?.closest(".piece,.ov-name")) return;
    montrerPoigneesMur(ctx, layer, murPointe(e.target) || murGeometrique(ctx, e));
  }, { capture: true });
  ctx.viewport.addEventListener("pointerleave", () => {
    const layer = focusEl(ctx); if (layer) planifierMasquageMur(ctx, layer);
  });
}

export function renderV5(ctx: Contexte): void {
  const P = ctx.etat.plan;
  let layer = ctx.canvas.querySelector<HTMLElement>(".v5layer");
  if (!P || !Array.isArray(P.outline) || P.outline.length < 3) { if (layer) layer.remove(); return; }
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "v5layer";
    layer.addEventListener("pointerdown", (e) => {
      // Hover does not exist on touch. Remembering the tapped wall makes its handles reachable on
      // the next tap, while the clean first tap still writes no geometry.
      if ((e as PointerEvent).pointerType === "touch") montrerPoigneesMur(ctx, layer!, murPointe(e.target));
      ctx.gestes.calquePointerDown?.(e as PointerEvent);
    });
    layer.addEventListener("dblclick", (e) => ctx.gestes.calqueDblClick?.(e as MouseEvent));
    ctx.canvas.appendChild(layer);
  }
  brancherSurvolMurs(ctx);
  const bb = bboxOfPoly(P.outline);
  const sp = aptToScreen(ctx, bb.minX, bb.minY);
  const S = ctx.vue.scale;
  layer.style.left = sp.x + "px";
  layer.style.top = sp.y + "px";
  layer.style.width = safeDim(bb.w * S) + "px";
  layer.style.height = safeDim(bb.l * S) + "px";
  layer.classList.toggle("drawing", !!ctx.ihm.draw);
  const o = ctx.etat.opts;
  // `ctx.ihm.draw` gates the HIT shapes below (walls/cells only get their clickable band while
  // the draw tool is OFF): leaving it out of the cache key is exactly the bug that made "turn the
  // tool off" and "never having turned it on" two different renders. Escape happened to work by
  // accident, through a DIFFERENT branch (`v5SelectWall(ctx,null)`) that bumps `ctx.rev` as a
  // side effect of clearing the selection, not because it releases anything the button doesn't.
  const sig = S.toFixed(4) + "|" + ctx.rev + "|" + (o.labels ? 1 : 0) + "|" + (o.layFurn !== false ? 1 : 0)
    + (o.layLight !== false ? 1 : 0) + (o.layPlug !== false ? 1 : 0)
    + "|" + (ctx.ihm.selWall || "") + "|" + (ctx.ihm.draw ? 1 : 0);
  if (layer.dataset["sig"] !== sig) { layer.dataset["sig"] = sig; renderFond(ctx, layer, P, bb, S); }
  renderPieces(ctx, layer, bb);
  renderOuvertures(ctx, layer, bb, S);
  renderEtiquettesCellules(ctx, layer, bb, S);
  renderFaisceaux(ctx, layer, bb, S);
  drawHandles(ctx, layer, bb, S);
}

/** Floors per cell, grid, wall bands (ONE per wall only), and hit shapes. */
export function renderFond(ctx: Contexte, layer: HTMLElement, P: PlanV5, bb: BBox, S: number): void {
  const old = layer.querySelector("svg.v5svg");
  if (old) old.remove();
  const X = (x: number): number => v5R2((x - bb.minX) * S);
  const Y = (y: number): number => v5R2((y - bb.minY) * S);
  const pts = (poly: readonly Pt[]): string => poly.map((p) => X(p[0]) + "," + Y(p[1])).join(" ");
  // R-17, blank-page safeguard: the pattern scale is clamped before any size computation.
  let gs = S;
  if (!isFinite(gs) || gs <= 0) gs = 0.5;
  gs = Math.max(0.01, Math.min(40, gs));
  const m = 100 * gs, f = m / 10;
  const css = getComputedStyle(document.documentElement);
  const cFine = css.getPropertyValue("--grid-fine").trim() || "#e7e9e3";
  const cM = css.getPropertyValue("--grid-m").trim() || "#cfd3cc";
  const cWall = css.getPropertyValue("--line-strong").trim() || "#c6c9c2";
  let defs = `<pattern id="v5gf" width="${f}" height="${f}" patternUnits="userSpaceOnUse">
        <path d="M ${f} 0 L 0 0 0 ${f}" fill="none" stroke="${cFine}" stroke-width="1"/></pattern>
      <pattern id="v5gm" width="${m}" height="${m}" patternUnits="userSpaceOnUse">
        <path d="M ${m} 0 L 0 0 0 ${m}" fill="none" stroke="${cM}" stroke-width="1"/></pattern>`;
  let body = "";
  const W = safeDim(bb.w * S), H = safeDim(bb.l * S);
  (P.cells || []).forEach((c, i) => {
    const fl = floorPatternDefs(c.floor || "parquet", S, "_v5" + i);
    defs += fl.defs + `<clipPath id="v5clip${i}"><polygon points="${pts(c.poly)}"/></clipPath>`;
    const gridOp = (c.floor && c.floor !== "plain") ? 0.45 : 1;
    body += `<polygon points="${pts(c.poly)}" fill="${fl.fill}"/>
        <g clip-path="url(#v5clip${i})" opacity="${gridOp}">
          <rect x="0" y="0" width="${W}" height="${H}" fill="url(#v5gf)"/>
          <rect x="0" y="0" width="${W}" height="${H}" fill="url(#v5gm)"/></g>`;
  });
  // outline band (closed) then one segment per interior wall: never two bands at the same spot
  const outBand = Math.max(2, WALL * gs);
  body += `<polygon points="${pts(P.outline)}" fill="none" stroke="#3b3f3d" stroke-width="${outBand}" stroke-linejoin="miter"/>
      <polygon points="${pts(P.outline)}" fill="none" stroke="${cWall}" stroke-width="1" stroke-linejoin="miter" opacity="0.6"/>`;
  const selW = ctx.ihm.selWall;
  (P.walls || []).forEach((w) => {
    if (w.isOutline) return;
    const band = Math.max(2, (w.t || WALL) * gs);
    const cls = "v5band" + (String(selW) === String(w.id) ? " sel" : "");
    body += `<line class="${cls}" data-wid="${escapeHtml(w.id)}" x1="${X(w.a[0])}" y1="${Y(w.a[1])}" x2="${X(w.b[0])}" y2="${Y(w.b[1])}"
        stroke="#3b3f3d" stroke-width="${band}" stroke-linecap="square"/>`;
  });
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("class", "v5svg");
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = `<defs>${defs}</defs>${body}`;
  layer.insertBefore(svg, layer.firstChild);
}

/**
 * The openings from the live model, in the SAME container as the furniture.
 *
 * R-2: NO NAME IS EVER WRITTEN ON A WALL OBJECT. The icon already says what it is (a door's arc,
 * a window's broken band, a sconce's half-disk). Measured on the real plan: a single facade
 * carried four stacked labels, and the living room wall three "Sconce" side by side, unreadable
 * at working zoom. 15 opening labels before, 0 after. The name STAYS in the model (the sheet, the
 * furniture list, export, `opening.set` on the wire): we're removing a DISPLAY, not a piece of
 * data, hence the absence of `op.name` from the cache key.
 *
 * R-1, the trap kept here for memory: this `innerHTML` cache key carried NEITHER `side` NOR
 * `rot`, so flipping a sconce rotated its box 180° without rebuilding its content.
 */
export function renderOuvertures(ctx: Contexte, layer: HTMLElement, bb: BBox, S: number): void {
  const P = ctx.etat.plan;
  const X = (x: number): number => v5R2((x - bb.minX) * S);
  const Y = (y: number): number => v5R2((y - bb.minY) * S);
  const seen: Record<string, 1> = {};
  (P.openings || []).forEach((op) => {
    const t = TYPEMAP[op.type];
    if (!t || !pieceVisible(op, ctx.etat.opts)) return;
    const box = v5OpeningBox(P, op, t.h || WALL);
    if (!box) return;
    let el = layer.querySelector<HTMLElement>(`.piece[data-op="1"][data-id="${cssId(op.id)}"]`);
    if (!el) {
      el = document.createElement("div");
      el.className = "piece opening";
      el.dataset["id"] = String(op.id);
      el.dataset["op"] = "1";
      const noeud = el;
      noeud.addEventListener("pointerdown", (ev) => {
        ctx.gestes.ouverturePointerDown?.(ev as PointerEvent, String(noeud.dataset["id"]));
      });
      noeud.addEventListener("dblclick", (ev) => {
        ctx.gestes.ouvertureDblClick?.(ev as MouseEvent, String(noeud.dataset["id"]));
      });
      layer.appendChild(el);
    }
    seen[String(op.id)] = 1;
    const w = box.w, h = box.h, rot = box.rot;
    el.style.zIndex = "8";
    el.dataset["paint"] = "-1";   // an opening is ALWAYS below the furniture (cf. `stackedAt`)
    el.style.left = X(box.cx - w / 2) + "px";
    el.style.top = Y(box.cy - h / 2) + "px";
    el.style.width = safeDim(w * S) + "px";
    el.style.height = safeDim(h * S) + "px";
    el.style.transform = `rotate(${rot}deg)`;
    el.style.borderColor = t.color;
    if (t.opening) { el.style.background = "var(--room-bg)"; el.style.borderWidth = "0"; }
    else { el.style.background = withAlpha(t.color, 0.14); el.style.borderWidth = "1.5px"; }
    el.style.borderRadius = t.opening ? "1px" : "3px";
    el.classList.toggle("sel", isSel(ctx, op.id));
    // `leaf` IS PART OF THE KEY: without it, switching a window from "fixed" to "double" would
    // not change the key, so the icon cache would keep the old drawing and the setting would
    // have no visible effect. Same trap as R-3 on labels.
    const key = `${op.type}|${Math.round(w)}|${Math.round(h)}|${op.hinge ? 1 : 0}|${Number(op.swing) < 0 ? -1 : 1}|${op.leaf || 0}|${Math.round(S * 100)}`;
    if (el.dataset["k"] !== key) {
      el.dataset["k"] = key;
      let html = "";
      if (op.type === "door") html += doorArcSVG(w, op.hinge ? 1 : 0, (Number(op.swing) < 0) ? -1 : 1, resolveColor("var(--open)"));
      else if (op.type === "window") html += windowArcSVG(w, op.hinge ? 1 : 0, (Number(op.swing) < 0) ? -1 : 1, op.leaf || 0, resolveColor("var(--open)"));
      html += pieceIconSVG(op.type, w, h);
      el.innerHTML = html;
      if (op.type === "door" || op.type === "window") {
        const d = el.querySelector<HTMLElement>(".darc");
        if (d) {
          const aw = safeDim(w * S);
          const sg = (Number(op.swing) < 0) ? -1 : 1;
          d.style.left = "0px";
          d.style.top = (sg < 0 ? -aw : 0) + "px";
          d.style.width = aw + "px";
          d.style.height = aw + "px";
        }
      }
      if (op.type === "sdoor") {
        const ic = el.querySelector<HTMLElement>(".picon");
        if (ic && op.hinge) ic.style.transform = "scaleX(-1)";
      }
    }
  });
  layer.querySelectorAll<HTMLElement>('.piece[data-op="1"]').forEach((n) => {
    if (!seen[String(n.dataset["id"])]) n.remove();
  });
}

/**
 * A VIDEOPROJECTOR'S BEAM.
 *
 * It is painted BELOW the furniture and above the floor: it is a placement aid, not an object of
 * the plan, so it must neither cover what's being moved nor be left forgotten. It exists ONLY if
 * a projection ratio has been entered: a projector that was just placed does not bar the room
 * with a cone before anything has been told to it.
 *
 * No state here: everything comes from `modele/projection.ts`, which is pure and proven without
 * a browser.
 */
export function renderFaisceaux(ctx: Contexte, layer: HTMLElement, bb: BBox, S: number): void {
  const P = ctx.etat.plan;
  const vieux = layer.querySelector("svg.v5beams");
  if (vieux) vieux.remove();
  const projs = (P.pieces || []).filter((p) => p.type === "projector" && Number(p.tr) > 0
                                            && pieceVisible(p, ctx.etat.opts));
  if (!projs.length) return;
  const X = (x: number): number => v5R2((x - bb.minX) * S);
  const Y = (y: number): number => v5R2((y - bb.minY) * S);
  let body = "";
  for (const p of projs) {
    const ecran = p.pair ? (P.pieces || []).find((q) => String(q.id) === String(p.pair)) : null;
    const pr = projection(p, ecran || null);
    const poly = polygoneFaisceau(p, ecran || null);
    // Red when the image won't be sharp: this is the only case where the beam must ALERT, width
    // discrepancies are already spelled out in the inspector.
    const col = resolveColor(pr.tropPres ? "var(--danger)" : "var(--open)");
    body += `<polygon points="${poly.map((q) => X(q[0]) + "," + Y(q[1])).join(" ")}"`
      + ` fill="${withAlpha(col, pr.tropPres ? 0.16 : 0.10)}" stroke="${withAlpha(col, 0.45)}"`
      + ` stroke-width="1" stroke-dasharray="6 4"/>`;
    // The firing axis: without it, a very wide cone no longer says where the device is AIMING.
    body += `<line x1="${X(pr.ox)}" y1="${Y(pr.oy)}" x2="${X(pr.ox + pr.ux * pr.distance)}"`
      + ` y2="${Y(pr.oy + pr.uy * pr.distance)}" stroke="${withAlpha(col, 0.35)}" stroke-width="1"`
      + ` stroke-dasharray="3 5"/>`;
  }
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("class", "v5beams");
  const W = safeDim(bb.w * S), H = safeDim(bb.l * S);
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = body;
  // Right after the background, so BELOW the furniture: `insertBefore` on the second child.
  layer.insertBefore(svg, layer.children[1] || null);
}

/**
 * A cell's name, anchored on its POLE OF INACCESSIBILITY (an L-shaped room doesn't have its
 * centroid inside it) then NUDGED AWAY from furniture and from other room labels
 * (`disposerEtiquettesCellules`, `rendu/etiquettes-disposition.ts`).
 *
 * Room labels and furniture labels used to be laid out independently: on a real 103 m2 apartment
 * (ten rooms), a chosen furniture name landed on top of "Cuisine", and other room labels landed on
 * an appliance icon. A label that cannot be placed without overlapping something is DROPPED, never
 * painted over it: the name also lives in the rail, so losing it on the canvas costs less than an
 * unreadable stack.
 */
export function renderEtiquettesCellules(ctx: Contexte, layer: HTMLElement, bb: BBox, S: number): void {
  const P = ctx.etat.plan;
  const seen: Record<string, 1> = {};
  const candidats: CandidatEtiquetteCellule[] = (P.cells || []).map((c) => {
    const pl = poleOfInaccessibility(c.poly);
    const poly = c.poly;
    return {
      id: String(c.id),
      ax: (pl.x - bb.minX) * S,
      ay: (pl.y - bb.minY) * S,
      texte: c.name || "",
      aire: polyArea(c.poly),
      // The label is never pushed into a NEIGHBOR's territory while searching for a clear spot:
      // a nudge is only tried while it is still inside THIS cell's own polygon.
      dansCellule: (x: number, y: number) => pointInPoly(x / S + bb.minX, y / S + bb.minY, poly),
    };
  });
  const obstacles = obstaclesMeubles(P.pieces || [], ctx.etat.opts, S, bb);
  const places = disposerEtiquettesCellules(candidats, obstacles);
  (P.cells || []).forEach((c) => {
    const id = String(c.id);
    const pos = places.get(id) || null;
    let el = layer.querySelector<HTMLElement>(`.ov-name[data-c="${cssId(c.id)}"]`);
    if (!pos) { if (el) el.remove(); return; } // YIELDS: no spot clears every obstacle
    if (!el) {
      el = document.createElement("div");
      el.className = "ov-name ov-name-center";
      el.dataset["c"] = String(c.id);
      const noeud = el;
      noeud.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        ctx.gestes.choisirCellule?.(String(noeud.dataset["c"]), true);
      });
      layer.appendChild(el);
    }
    seen[id] = 1;
    el.textContent = c.name || "";
    el.classList.toggle("focused", String(ctx.ihm.selCell) === String(c.id));
    el.style.left = pos.x + "px";
    el.style.top = pos.y + "px";
    el.style.right = "auto";
  });
  layer.querySelectorAll<HTMLElement>(".ov-name[data-c]").forEach((n) => {
    if (!seen[String(n.dataset["c"])]) n.remove();
  });
}

/**
 * OUTLINE handles (edges, corner insertions, vertices) and the delete cross of the selected wall.
 * The outline controls exist only while a facade or one of its corners is selected. They cover
 * the whole perimeter, so mere hover would make them intrude on ordinary work near a wall.
 *
 * G-15: the corner-insertion "+" is OFFSET 18 px OUTSIDE the outline. Placed on the facade, it
 * stole the selection click, and its global recomputation would cut the wall in two and move
 * 16 pieces of furniture.
 */
export function drawHandles(ctx: Contexte, layer: HTMLElement, bb: BBox, S: number): void {
  layer.querySelectorAll(".vtx,.mid,.edge,.v5wx,.v5wend,.v5wmid,.v5wmove").forEach((n) => n.remove());
  if (ctx.ihm.hoverWall && !(ctx.etat.plan.walls || []).some((w) => String(w.id) === String(ctx.ihm.hoverWall))) {
    ctx.ihm.hoverWall = null;
  }
  const poly = ctx.etat.plan.outline, np = poly.length;
  const toC = (x: number, y: number): { x: number; y: number } => ({ x: (x - bb.minX) * S, y: (y - bb.minY) * S });
  const selectionMur = (ctx.etat.plan.walls || []).find((w) => String(w.id) === String(ctx.ihm.selWall));
  const contourVisible = !!selectionMur?.isOutline || ctx.selVtx >= 0;
  for (let i = 0; i < np && contourVisible; i++) {
    const a = poly[i]!, b = poly[(i + 1) % np]!;
    const sa = toC(a[0], a[1]), sb = toC(b[0], b[1]);
    const s = { x: (sa.x + sb.x) / 2, y: (sa.y + sb.y) / 2 };
    const lenpx = Math.hypot(sb.x - sa.x, sb.y - sa.y);
    const ang = Math.atan2(sb.y - sa.y, sb.x - sa.x) * 180 / Math.PI;
    const eb = document.createElement("div");
    eb.className = "edge";
    const ow = (ctx.etat.plan.walls || []).find((w) => w.isOutline
      && (Math.hypot(w.a[0] - a[0], w.a[1] - a[1]) + Math.hypot(w.b[0] - b[0], w.b[1] - b[1]) < 2
       || Math.hypot(w.a[0] - b[0], w.a[1] - b[1]) + Math.hypot(w.b[0] - a[0], w.b[1] - a[1]) < 2));
    if (ow) eb.dataset["w"] = String(ow.id);
    eb.style.width = Math.max(10, lenpx - 36) + "px";
    eb.style.left = s.x + "px";
    eb.style.top = s.y + "px";
    eb.style.transform = `translate(-50%,-50%) rotate(${ang}deg)`;
    const aa = ((ang % 180) + 180) % 180;
    eb.style.cursor = (aa < 20 || aa > 160) ? "ns-resize" : (aa > 70 && aa < 110) ? "ew-resize" : "move";
    eb.title = "Click to select this facade · drag to move it";
    const idx = i;
    eb.addEventListener("pointerdown", (ev) => ctx.gestes.contourAretePointerDown?.(ev as PointerEvent, idx));
    layer.appendChild(eb);
    const nOut = outlineOutward(ctx, i);
    const md = document.createElement("div");
    md.className = "mid";
    md.textContent = "+";
    md.title = "Insert a corner on this facade";
    md.style.left = (s.x + nOut.x * 18) + "px";
    md.style.top = (s.y + nOut.y * 18) + "px";
    md.addEventListener("pointerdown", (ev) => ctx.gestes.contourInsertionPointerDown?.(ev as PointerEvent, idx));
    layer.appendChild(md);
  }
  poly.forEach((v, i) => {
    if (!contourVisible) return;
    const s = toC(v[0], v[1]);
    const h = document.createElement("div");
    h.className = "vtx" + ((i === ctx.selVtx) ? " sel" : "");
    h.style.left = s.x + "px";
    h.style.top = s.y + "px";
    h.title = "Drag to move · click then Del to remove";
    const x = document.createElement("div");
    x.className = "vx";
    x.textContent = "×";
    x.title = "Remove this corner";
    x.addEventListener("pointerdown", (ev) => ctx.gestes.contourSommetSupprimer?.(ev as PointerEvent, i));
    h.appendChild(x);
    h.addEventListener("pointerdown", (ev) => ctx.gestes.contourSommetPointerDown?.(ev as PointerEvent, i));
    layer.appendChild(h);
  });
  const ids = [ctx.ihm.selWall, ctx.ihm.hoverWall].filter((id, i, a): id is string => !!id && a.indexOf(id) === i);
  const murs = ids.map((id) => (ctx.etat.plan.walls || []).find((q) => String(q.id) === String(id))).filter((w) => w !== undefined);
  for (const w of murs) {
    const mx = (w.a[0] + w.b[0]) / 2, my = (w.a[1] + w.b[1]) / 2;
    const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1], L = Math.hypot(dx, dy) || 1;
    const lenpx = L * S;
    const sMid = toC(mx, my);
    const move = document.createElement("div");
    move.className = "v5wmove";
    move.dataset["w"] = String(w.id);
    move.style.left = sMid.x + "px";
    move.style.top = sMid.y + "px";
    move.title = w.isOutline ? "Click to select this facade" : "Click to select this wall, or drag to move it";
    move.addEventListener("pointerdown", (ev) => ctx.gestes.deplacerMurPointerDown?.(ev as PointerEvent, String(w.id)));
    layer.appendChild(move);
    // A facade is derived from the outline. Its move handle deliberately SELECTS only: moving the
    // outline remains the job of its existing edge and vertex controls.
    if (w.isOutline) continue;
    // The rendered diameters are 20 px for move/elbow/delete and 16 px for endpoints. At least
    // 48 px leaves 4 px between the central move target and each endpoint. The lower-priority
    // elbow and delete controls appear from 132 px, which adds a 10 px pointer lane around the
    // three central targets, so a short working-zoom partition remains a
    // clear three-target row instead of a five-target cluster.
    const showEnds = lenpx >= 48;
    const showDetails = lenpx >= 132;
    // ENDPOINT HANDLES (owner's report: "choper les extrémités des murs et pouvoir étendre et
    // relier à d'autres murs"). One per end, sitting EXACTLY on the endpoint: unlike the
    // outline's "+" (G-15) there is no selection click to steal here, since the wall's own drag
    // band already covers the whole segment INCLUDING its very tip, and grabbing the small
    // circle right on top of it starts `v5StartWallEndDrag` instead (wired through
    // `ctx.gestes.boutMurPointerDown`, `gestes/branchement.ts`), which moves ONLY that end.
    if (showEnds) (["a", "b"] as const).forEach((bout) => {
      const p = w[bout];
      const s = toC(p[0], p[1]);
      const h = document.createElement("div");
      h.className = "v5wend";
      h.dataset["w"] = String(w.id);
      h.dataset["bout"] = bout;
      h.style.left = s.x + "px";
      h.style.top = s.y + "px";
      h.title = "Drag to extend this wall, or connect it to another";
      h.addEventListener("pointerdown", (ev) => ctx.gestes.boutMurPointerDown?.(ev as PointerEvent, String(w.id), bout));
      layer.appendChild(h);
    });
    // G-15-BIS: SAME TRAP AS THE OUTLINE'S "+", one wall family over. Dead-center on the wall's
    // own segment, this "x" used to sit exactly where `[data-w]` (the drag band, G-3's "grab it
    // again to nudge it") is grabbed: selecting a wall by dragging it once, then reaching for the
    // SAME spot to adjust it again, deleted it instead — the delete handler wins the hit-test the
    // layer's own early return grants `.v5wx` (`v5LayerDown`). Measured: a wall dragged out and
    // back vanished on the second grab, silently (no toast, `v5DeleteSelectedWall`'s refusal path
    // is for facades, not "wrong target"). Offset PERPENDICULAR to the wall, clear of its own
    // half-thickness, exactly the outline fix's shape (`outlineOutward`, an outward normal), so
    // the drag band stays reachable at its own center.
    if (!showDetails) continue;
    const nx = -dy / L, ny = dx / L;
    const off = Math.max(((w.t || 0) * S) / 2 + 16, 22);
    // The elbow handle uses the same clearance as the delete cross, on the opposite normal. If it
    // sat on the segment itself it would steal the wall band's midpoint, the ordinary place used
    // to grab the selected wall again and nudge the whole partition.
    const coude = document.createElement("div");
    coude.className = "v5wmid";
    coude.dataset["w"] = String(w.id);
    coude.textContent = "⌜";
    coude.title = "Drag to split this wall and move the new joint";
    coude.style.left = (sMid.x - nx * off) + "px";
    coude.style.top = (sMid.y - ny * off) + "px";
    coude.addEventListener("pointerdown", (ev) => ctx.gestes.coudeMurPointerDown?.(ev as PointerEvent, String(w.id)));
    layer.appendChild(coude);
    const s = { x: sMid.x + nx * off, y: sMid.y + ny * off };
    const x = document.createElement("div");
    x.className = "v5wx";
    x.dataset["w"] = String(w.id);
    x.textContent = "×";
    x.title = "Delete this wall (the two rooms merge)";
    x.style.left = s.x + "px";
    x.style.top = s.y + "px";
    x.addEventListener("pointerdown", (ev) => ctx.gestes.supprimerMurSelectionne?.(ev as PointerEvent));
    layer.appendChild(x);
  }
}

/**
 * OUTWARD normal of the outline's edge `i`, in screen coordinates (y downward). Ported from
 * `v5OutlineOutward` (src/js/53): rendering needs it to offset the "+" outside the outline, and
 * that is its only dependency on this utility file.
 */
export function outlineOutward(ctx: Contexte, i: number): { x: number; y: number } {
  const poly = ctx.etat.plan && ctx.etat.plan.outline;
  if (!poly || poly.length < 3) return { x: 0, y: -1 };
  const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
  let nx = -dy / L, ny = dx / L;
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  if (pointInPoly(mx + nx * 10, my + ny * 10, poly)) { nx = -nx; ny = -ny; }
  return { x: nx, y: ny };
}
