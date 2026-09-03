// src/ts/circulation/contexte.ts: the circulation engine's analysis context (`FL.flowCtx`),
// built once per pass over the whole apartment.

import type { BBox } from "../geometrie/polygones.ts";
import type { ItemCatalogue } from "../catalogue/catalogue.ts";
import type { PlanV5, Pt } from "../partage/plan.ts";
import type { AABB, CelluleFlow, ContexteFlow, ObjetFlow, Rect } from "./etat.ts";
import { FL, meublesDuPlan } from "./etat.ts";
import { TYPEMAP } from "../catalogue/catalogue.ts";
import { bboxOfPoly, pointInPoly } from "../geometrie/polygones.ts";
import { WALL } from "../noyau/nombres.ts";
import { v5CellsAt, v5OpeningBox } from "../modele/murs.ts";
import { aptBBox, aptToScreen } from "../rendu/vue.ts";

// =====================================================================
//  CIRCULATION ENGINE
// =====================================================================
export const PRIMARY_SEAT = new Set(["sofa3", "sofa2", "arm"]);

// =====================================================================
//  ANALYSIS CONTEXT (a single pass, the whole apartment)
// =====================================================================
// The apartment is analyzed as ONE plan, in apartment cm throughout (no local frame or
// translation). Cells are the rooms, the outline is the envelope.
export function fcCells(): CelluleFlow[] { return FL.flowCtx ? FL.flowCtx.cells : []; }
export function fcPieces(): ObjetFlow[] { return FL.flowCtx ? FL.flowCtx.pieces : meublesDuPlan(); }
export function fcBBox(): BBox { return FL.flowCtx ? FL.flowCtx.bb : aptBBox(FL.ctx); }
// does the point (apartment cm) fall inside ONE cell?
export function inAnyCell(x: number, y: number): boolean {
  const cs = fcCells();
  for (let i = 0; i < cs.length; i++) { if (pointInPoly(x, y, cs[i]!.poly)) return true; }
  return false;
}
/**
 * Index of the cell containing the point, or -1, in a list GIVEN as an argument. The lighting map
 * (`circulation/lumiere.ts`) walks tens of thousands of grid squares against a cell list it
 * already holds, and it must stay callable with no `FL` set at all (headless test).
 */
export function indexCelluleDans(cells: CelluleFlow[], x: number, y: number): number {
  for (let i = 0; i < cells.length; i++) { if (pointInPoly(x, y, cells[i]!.poly)) return i; }
  return -1;
}
// index (in flowCtx.cells) of the cell containing the point, or -1
export function cellIndexAt(x: number, y: number): number {
  return indexCelluleDans(fcCells(), x, y);
}
/** The default depth of an opening, the one `v5OpeningBox` takes implicitly. */
export const hDefaut = (type: string): number => (TYPEMAP[type] || { h: WALL }).h || WALL;

// Builds the context. Walls become barriers "for free": buildGrid already
// blocks every cell near a cell boundary (wallPad), and only doors (carve)
// punch through. A cell without a door is thus indeed unreachable.
export function buildAptContext(): ContexteFlow {
  const cells: CelluleFlow[] = [], pieces: ObjetFlow[] = [];
  const P: PlanV5 = FL.ctx.etat.plan || ({} as PlanV5);
  (P.cells || []).forEach((c, i) => cells.push({
    poly: c.poly.map(([x, y]) => [x, y] as Pt), ci: i, name: c.name, lux: c.lux,
  }));
  // `ci:"env"` = the object doesn't fall into any cell: it's on the outline (front door)
  // or inside a wall's thickness.
  const cellAt = (x: number, y: number): { ci: number | "env"; name: string } => {
    const c = v5CellsAt(P, x, y);
    return c ? { ci: (P.cells || []).indexOf(c), name: c.name } : { ci: "env", name: "Appartement" };
  };
  (P.pieces || []).forEach((p) => {
    const k = cellAt(p.x + p.w / 2, p.y + p.h / 2);
    pieces.push({ ...p, ci: k.ci, cellName: k.name });
  });
  // `onOutline` = the opening is carried by a FACADE wall (`isOutline`, from `sanitizeV5Plan`).
  // Not derived from `ci==="env"`: an opening's center sits on its wall's median line, a cell
  // boundary, where `pointInPoly` answers ambiguously depending on which side it falls.
  (P.openings || []).forEach((o) => {
    const box = v5OpeningBox(P, o, hDefaut(o.type)); if (!box) return;
    const k = cellAt(box.cx, box.cy);
    pieces.push({
      id: o.id, type: o.type, name: o.name, x: box.cx - box.w / 2, y: box.cy - box.h / 2,
      w: box.w, h: box.h, rot: box.rot, hinge: o.hinge, swing: o.swing, locked: false,
      ci: k.ci, cellName: k.name, onOutline: !!(box.wall && box.wall.isOutline),
    });
  });
  const env = { poly: (P.outline || []).map(([x, y]) => [x, y] as Pt) };
  const eb = bboxOfPoly(env.poly);
  return { cells, pieces, bb: { minX: eb.minX, minY: eb.minY, maxX: eb.maxX, maxY: eb.maxY, w: eb.w, l: eb.l }, env };
}
// Signature of everything that changes the analysis: outline, walls, openings, furniture geometry,
// + circulation options (tvIn). EXCLUDES: floor, lock, name, layers.
export function aptFlowSig(): string {
  let s = ""; const P: PlanV5 = FL.ctx.etat.plan || ({} as PlanV5);
  (P.outline || []).forEach((p) => { s += p[0] + "," + p[1] + ";"; });
  (P.walls || []).forEach((w) => { s += "W" + w.id + ":" + w.a[0] + "," + w.a[1] + ":" + w.b[0] + "," + w.b[1] + ":" + w.t + "|"; });
  (P.openings || []).forEach((o) => { s += "O" + o.id + ":" + o.wallId + ":" + Math.round(o.t0) + ":" + Math.round(o.w) + ":" + o.type + ":" + (o.side ? 1 : 0) + ":" + (o.hinge ? 1 : 0) + ":" + (Number(o.swing) < 0 ? -1 : 1) + "|"; });
  (P.pieces || []).forEach((p) => { s += p.id + ":" + p.type + ":" + Math.round(p.x) + ":" + Math.round(p.y) + ":" + Math.round(p.w) + ":" + Math.round(p.h) + ":" + Math.round(p.rot || 0) + "|"; });
  return s + "@tv=" + (FL.ctx.etat.opts.tvIn || 0);
}

// Flow canvas now spans the whole viewport; overlay is drawn in viewport px.
export function sizeFlowCanvas(): void {
  const flowCanvas = FL.flowCanvas;
  if (!flowCanvas) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const vw = FL.ctx.viewport.clientWidth, vh = FL.ctx.viewport.clientHeight;
  flowCanvas.style.left = "0px"; flowCanvas.style.top = "0px";
  flowCanvas.style.width = vw + "px"; flowCanvas.style.height = vh + "px";
  // NEVER reassign width/height to the same value: that clears the canvas and costs a reallocation
  const W = Math.max(1, Math.round(vw * dpr)), H = Math.max(1, Math.round(vh * dpr));
  if (flowCanvas.width !== W) flowCanvas.width = W;
  if (flowCanvas.height !== H) flowCanvas.height = H;
}
// apartment cm -> viewport px (the global grid, routes and findings all live in apt cm)
export function aptCmToVp(x: number, y: number): { x: number; y: number } { return aptToScreen(FL.ctx, x, y); }

// ---- geometry helpers (all cm) ----
export function pieceAABB(p: Pick<ObjetFlow, "x" | "y" | "w" | "h"> & { rot?: number | undefined }): AABB {
  const cx = p.x + p.w / 2, cy = p.y + p.h / 2, a = (p.rot || 0) * Math.PI / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  const hw = p.w / 2, hh = p.h / 2;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [dx, dy] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as Array<[number, number]>) {
    const rx = cx + dx * ca - dy * sa, ry = cy + dx * sa + dy * ca;
    if (rx < minX) minX = rx; if (rx > maxX) maxX = rx; if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
  }
  return { x0: minX, y0: minY, x1: maxX, y1: maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}
// wall-mounted (sconce/plug) sit at height: never an obstacle, like openings and rugs
export function isBlocker(p: { type: string }): boolean {
  const t: Partial<ItemCatalogue> = TYPEMAP[p.type] || {};
  return !t.soft && !t.opening && !t.wallMount;
}
export function rectsOverlap(a: Rect, b: Rect): boolean { return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0; }
export function rectGap(a: Rect, b: Rect): number { // nearest-edge gap between two AABBs (0 if overlap)
  const dx = Math.max(0, Math.max(a.x0 - b.x1, b.x0 - a.x1));
  const dy = Math.max(0, Math.max(a.y0 - b.y1, b.y0 - a.y1));
  return Math.hypot(dx, dy);
}
export function allOf(types: string[]): ObjetFlow[] { const s = new Set(types); return fcPieces().filter((p) => s.has(p.type)); }
export function frontNormal(p: { rot?: number | undefined }): { x: number; y: number } { // local +y (depth) direction rotated
  const a = (p.rot || 0) * Math.PI / 180;
  return { x: Math.sin(a), y: Math.cos(a) }; // rotate (0,1) clockwise by rot
}
export function norm(v: { x: number; y: number }): { x: number; y: number } { const m = Math.hypot(v.x, v.y) || 1; return { x: v.x / m, y: v.y / m }; }

export interface PassageDePorte {
  cx: number; cy: number;
  ux: number; uy: number;
  nx: number; ny: number;
  halfLen: number;
}

// ---- oriented door passage: the walkable zone a door/sdoor carves through its wall span ----
// Returns {cx,cy, ux,uy (along the wall), nx,ny (towards the cell), halfLen} in apartment cm.
export function doorPassage(door: ObjetFlow): PassageDePorte {
  const b = pieceAABB(door);
  const cx = b.cx, cy = b.cy;
  const rad = (door.rot || 0) * Math.PI / 180;
  // wall axis = the door's WIDTH direction (local x), rotated
  const ux = Math.cos(rad), uy = Math.sin(rad);
  // normal towards the cell = local +y
  const nx = Math.sin(rad), ny = Math.cos(rad);
  const halfLen = Math.max(door.w, door.h) / 2;
  return { cx, cy, ux, uy, nx, ny, halfLen };
}
