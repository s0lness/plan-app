// src/ts/sonde-gestes.ts: THE "GESTURES" SLICE OF THE PROBE SURFACE.
// Completes `src/ts/sonde.ts` (RENDER batch) for what the GESTES batch ported, and nothing else.
//
// It is in ITS OWN FILE because `src/js/57-sondes-test.js` was "the repo's most likely git
// conflict point" (src/README.md, coupling #3, 616 lines touched by almost every batch). A file
// per batch removes the conflict, and typing removes the original hook's other measured defect:
// Genuinely duplicate keys existed in the old object, and the last one silently won.
//
// A MISSING ENTRY IS AN ENTRY NOT YET PORTED, never an abandoned entry. What is missing here
// belongs to the inspector, to export, to sync, or to the Circulation engine.

import type { Contexte } from "./app/contexte.ts";
import type { Cellule, Meuble, Ouverture, Pt } from "./partage/plan.ts";
import { pieceById, v5CellById, v5OpeningById, v5Touch, v5WallById } from "./app/contexte.ts";
import { TYPEMAP, isWallMount } from "./catalogue/catalogue.ts";
import { $, COARSE, cssId } from "./noyau/dom.ts";
import { RSZ_BYKEY, RSZ_MAX, RSZ_MIN } from "./rendu/meubles.ts";
import { WALL, clamp, v5R2 } from "./noyau/nombres.ts";
import { closestOnSeg } from "./geometrie/polygones.ts";
import { v5OverlapArea } from "./modele/aires.ts";
import { v5CellsAt, v5DedupeWalls, v5OpeningBox, v5OpeningEdgeLimits, v5Seg, v5WallDeleteVerdict } from "./modele/murs.ts";
import { v5RebuildCells } from "./modele/cellules.ts";
import {
  v5CanDeleteWall, v5ClampPiece, v5ClampPieces, v5FlushOpeningThinned,
  v5FlushPlaceNarrowed, v5LastFit, v5MoveOpeningTo, v5NearestWall, v5PlaceWallMount, v5BornerAuLogement,
  v5WallCovering,
} from "./modele/edition.ts";
import { fabriqueOuverture, mk } from "./modele/creation.ts";
import { wallSnapReach } from "./modele/espace.ts";
import { v5DeviceTag, v5NewId } from "./fil/identite.ts";
import { render } from "./rendu/rendu.ts";
import { aptBBox, aptToScreen, renderView } from "./rendu/vue.ts";
import { selReplace } from "./rendu/selection.ts";
import { save, serialize } from "./app/persistance.ts";
import { clearToast, toast, toastText } from "./app/toast.ts";
import { histInfo, pushHistory, redo, undo } from "./historique/pile.ts";
import {
  endActiveGesture, escapeActiveGesture, gesteActif, gesteArme, fileEnAttente, vieillirGeste,
} from "./gestes/sortie.ts";
import { WALL_INSET, clampCenterToInset } from "./gestes/contraintes.ts";
import { lassoVivant, piecesInClientRect, railOpen } from "./gestes/vue-interactions.ts";
import { setCursorApt, lastCursorApt } from "./gestes/etat-pointeur.ts";
import { cur, delSel, flipWallMountSide } from "./gestes/selection-actions.ts";
import { planClipInfo, planClipReset, planCopy, planPaste, planPasteFromText } from "./gestes/clavier.ts";

import {
  v5AfterGeometry, v5DeleteSelectedWall, v5SelectCell, v5SelectWall, v5SetModel,
  v5WallDragApply, v5WallDragCtx,
} from "./gestes/murs.ts";
import { v5DrawOpeningResize } from "./gestes/ouverture.ts";
import { orthoSnapVertex } from "./gestes/edition-murs.ts";
import { armerPose, placeNewPieceAt, poseArme, poserAuCentre, wallMountPreviewApt } from "./gestes/pose.ts";

const hDefaut = (t: string): number => (TYPEMAP[t] || { h: WALL }).h || WALL;

/** The surface exposed by this batch. A typed literal: a duplicate key does not compile. */
export interface SondeGestes {
  // ---- the gesture safety net (G-1) ----
  readonly gestureActive: boolean;
  readonly gestureArmed: boolean;
  readonly gestureQueued: { state: boolean; op: string | null };
  ageGesture(ms?: number | null): boolean;
  endActiveGesture(): void;
  escapeActiveGesture(): boolean;
  readonly viewOnly: boolean;

  // ---- banners (C-16 / G-13) ----
  readonly toastText: string | null;
  clearToast(): void;
  emitToast(msg: string): boolean;
  emitToastGeste(msg: string): boolean;
  showToast(msg: string): boolean;

  // ---- history ----
  histInfo(): { undo: number; redo: number; log: number };
  undo(): void;
  redo(): void;
  pushHistory(): void;

  // ---- persistence ----
  save(): void;

  // ---- reading the plan ----
  pieceAt(id: unknown): { type: string; rot: number; cx: number; cy: number; cell: string | null } | null;
  pieceHit(id: unknown): { rendered: boolean; hit: boolean; w?: number; h?: number };
  cellAt(x: number, y: number): Cellule | null;
  /** The HISTORICAL name for `cellAt`: the MODEL suites call it this way, word for word. */
  cellOf(x: number, y: number): Cellule | null;
  /** Clamps a furniture piece into ITS cell (and within the outline), then renders it. */
  clampV5Piece(p: Meuble): Meuble;
  /** The clearance, in cm, a furniture piece keeps from the wall's bare face. */
  readonly WALL_INSET: number;
  readonly lastFit: boolean;
  clampToInset(cx: number, cy: number, w: number, h: number, rot: number, poly: Pt[]): { cx: number; cy: number; fits: boolean };

  readonly v5ui: { selWall: string | null; selCell: string | null; draw: boolean };
  canDeleteWall(id: unknown): boolean;
  wallDeleteVerdict(id: unknown, plan?: unknown): string;
  delWall(id: unknown): number;
  addWall(a: Pt, b: Pt): { id: string; a: Pt; b: Pt } | null;
  moveWall(id: unknown, d: number): { id: string; a: Pt; b: Pt } | null;
  moveOutlineEdge(i: number, d: number): Pt[];
  moveOutlineVertex(i: number, x: number, y: number, shift?: boolean): Pt[];
  selectCell(id: unknown): Cellule | null;
  dupWalls(): number;
  dedupeWalls(): number;
  wallCovering(a: Pt, b: Pt): string | null;
  midHandlePoints(): { cursor: string; title: string; at: string | null }[];

  // ---- furniture ----
  addRoomPiece(type: string, x: number, y: number): unknown;
  addV5Piece(type: string, x: number, y: number): Meuble;
  addAtCursor(type: string, ax?: number, ay?: number): unknown;
  placeAt(type: string, apt: { x: number; y: number } | null): unknown;
  setCursorApt(ax: number | null, ay: number | null): void;
  readonly lastCursorApt: { x: number; y: number } | null;
  resizeHandle(pieceId: unknown, hkey: string, dx: number, dy: number): { w: number; h: number; x: number; y: number; rot: number } | null;
  delSel(): void;

  // ---- openings ----
  v5PlaceAt(type: string, x: number, y: number): { id: string; wallId: string; t0: number; side: number; type: string } | null;
  v5OpeningPose(id: unknown): unknown;
  dragOpeningTo(id: unknown, x: number, y: number): unknown;
  openingGeom(id: unknown): { t0: number; w: number; h: number | undefined; wallId: string; side: number } | null;
  openingHandles(id: unknown): { end: string; cursor: string; x: number; y: number; dehors: boolean }[];
  openingLimits(id: unknown): unknown;
  rszReadout(): string | null;
  clickFlipSide(id: unknown): { clicked: boolean; hidden?: boolean };
  pressFlipSide(id: unknown): boolean;
  flipWallMountSide(p: Ouverture | Meuble | undefined): boolean;

  // ---- placement ----
  readonly poseArme: string | null;
  armPose(type: string): string | null;
  paletteArmed(): (string | undefined)[];
  readonly posing: boolean;
  poseArmeAuCentre(): string | null;

  // ---- clipboard (G-24) ----
  clipInfo(): { n: number; verrous: number; muraux: number } | null;
  clipCopy(): number;
  clipCut(): number;
  clipPaste(): number;
  clipReset(): boolean;
  clipPasteText(txt: unknown): number;

  // ---- lasso (G-11) ----
  readonly lassoVivant: boolean;
  piecesInClientRect(rect: { left: number; top: number; right: number; bottom: number }): string[];

  /** Is the pointer COARSE (a finger)? The touch drawer and enlarged targets depend on it. */
  readonly COARSE: boolean;
  wallSnapReach(): number;
  wallMountPreviewApt(type: string, ax: number, ay: number, maxDist?: number): unknown;
  serialize(): unknown;
  overlapArea: typeof v5OverlapArea;
  placeWallMountAt(type: string, x: number, y: number): { placed: boolean; id: string | null; toast: string | null };
  dragWallMountTo(id: unknown, x: number, y: number): unknown;
  railOpen(on?: boolean | null): void;

  // ---- identity (C-8) ----
  deviceTag(): string;
  newId(prefix: string): string;

  // ---- view and rail: what the gesture suites read along the way ----
  readonly vScale: number;
  viewFits(): { left: number; top: number; right: number; bottom: number; fits: boolean };
  panBy(dx: number, dy: number): { scale: number; ox: number; oy: number };
  chipCount(): number;
  chipNames(): (string | null)[];
  chipAreas(): (string | null)[];
  activeChipName(): string | null;
  /** The inspector is not from this batch: the probe calls the HOOK, which may be absent. */
  openInspector(): void;
  /** Replaces the live plan with a walls-only plan (test seed). */
  setModel(plan: unknown): unknown;
  seedPlan(plan: unknown): unknown;
}

export function sondeGestes(ctx: Contexte): SondeGestes {
  return {
    get gestureActive() { return gesteActif(); },
    get gestureArmed() { return gesteArme(); },
    get gestureQueued() { return fileEnAttente(); },
    ageGesture: (ms?: number | null) => vieillirGeste(ms),
    endActiveGesture: () => endActiveGesture(),
    escapeActiveGesture: () => escapeActiveGesture(),
    get viewOnly() { return ctx.viewOnly > 0; },

    get toastText() { return toastText(); },
    clearToast,
    emitToast: (msg: string) => toast(msg),
    emitToastGeste: (msg: string) => toast(msg, { geste: true }),
    showToast: (msg: string) => toast(msg),

    histInfo,
    undo: () => undo(ctx),
    redo: () => redo(ctx),
    pushHistory: () => pushHistory(ctx),

    save: () => save(ctx),

    pieceAt(id: unknown) {
      const p = pieceById(ctx, id); if (!p) return null;
      const c = v5CellsAt(ctx.etat.plan, p.x + p.w / 2, p.y + p.h / 2);
      return {
        type: p.type, rot: p.rot || 0,
        cx: Math.round(p.x + p.w / 2), cy: Math.round(p.y + p.h / 2),
        cell: c ? c.name : null,
      };
    },
    // Is the piece rendered? Is it the hover target at its center (and therefore selectable)?
    pieceHit(id: unknown) {
      const el = ctx.canvas.querySelector<HTMLElement>(`.piece[data-id="${cssId(id)}"]`);
      if (!el) return { rendered: false, hit: false };
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        rendered: true,
        hit: !!(top && top.closest && top.closest(`.piece[data-id="${cssId(id)}"]`)),
        w: Math.round(r.width), h: Math.round(r.height),
      };
    },
    cellAt: (x: number, y: number) => v5CellsAt(ctx.etat.plan, x, y),
    cellOf: (x: number, y: number) => v5CellsAt(ctx.etat.plan, x, y),
    clampV5Piece(p: Meuble) { v5ClampPiece(ctx.etat.plan, p); return p; },
    WALL_INSET,
    get lastFit() { return v5LastFit(); },
    clampToInset: (cx, cy, w, h, rot, poly) => clampCenterToInset(cx, cy, w, h, rot, poly),

    get v5ui() {
      return { selWall: ctx.ihm.selWall, selCell: ctx.ihm.selCell, draw: ctx.ihm.draw };
    },
    canDeleteWall: (id: unknown) => v5CanDeleteWall(ctx.etat.plan, String(id)),
    wallDeleteVerdict: (id: unknown, plan?: unknown) =>
      v5WallDeleteVerdict((plan as never) || ctx.etat.plan, String(id)),
    delWall(id: unknown) {
      v5SelectWall(ctx, id); v5DeleteSelectedWall(ctx);
      return (ctx.etat.plan.cells || []).length;
    },
    // TOOL: draw a wall between two points, via the same path as the pointer.
    addWall(a: Pt, b: Pt) {
      const P = ctx.etat.plan; if (!P) return null;
      const w = { id: v5NewId("w"), a: [a[0], a[1]] as Pt, b: [b[0], b[1]] as Pt, t: WALL, isOutline: false };
      P.walls.push(w); v5BornerAuLogement(P, w);   // a drawn wall keeps the ends it was given
      v5RebuildCells(P); v5ClampPieces(P); v5Touch(ctx); render(ctx); save(ctx);
      return { id: String(w.id), a: w.a, b: w.b };
    },
    moveWall(id: unknown, d: number) {
      const g = v5WallDragCtx(ctx, id); if (!g) return null;
      const w = v5WallDragApply(ctx, g, d, true); render(ctx); save(ctx);
      return { id: String(w.id), a: w.a, b: w.b };
    },
    moveOutlineEdge(i: number, d: number) {
      const poly = ctx.etat.plan.outline, n = poly.length, j = (i + 1) % n;
      const a = poly[i]!, b = poly[j]!;
      const s = v5Seg({ a, b });
      poly[i] = [v5R2(a[0] + s.nx * d), v5R2(a[1] + s.ny * d)];
      poly[j] = [v5R2(b[0] + s.nx * d), v5R2(b[1] + s.ny * d)];
      v5AfterGeometry(ctx, true); save(ctx);
      return ctx.etat.plan.outline;
    },
    // The vertex goes through the SAME orthogonal snapping as the pointer (js/15), otherwise
    // the probe would prove a path nobody actually takes.
    moveOutlineVertex(i: number, x: number, y: number, shift?: boolean) {
      const poly = ctx.etat.plan.outline;
      const p0 = poly[i]; if (!p0) return poly;
      const sx = p0[0], sy = p0[1];
      const o = orthoSnapVertex(poly, i, Math.round(x), Math.round(y), !!shift, sx, sy, ctx.vue.scale);
      poly[i] = [Math.round(o.x), Math.round(o.y)];
      v5AfterGeometry(ctx, true); save(ctx);
      return ctx.etat.plan.outline;
    },
    selectCell(id: unknown) { v5SelectCell(ctx, id, true); return v5CellById(ctx, ctx.ihm.selCell); },
    // Walls exactly overlapping each other in the live plan.
    dupWalls() {
      const P = ctx.etat.plan, seen: Record<string, 1> = {}; let n = 0;
      (P.walls || []).forEach((w) => {
        if (w.isOutline) return;
        const k = [w.a, w.b].map((q) => Math.round(q[0]) + "," + Math.round(q[1])).sort().join("|");
        if (seen[k]) n++; seen[k] = 1;
      });
      return n;
    },
    dedupeWalls: () => v5DedupeWalls(ctx.etat.plan),
    wallCovering(a: Pt, b: Pt) { const w = v5WallCovering(ctx.etat.plan, a, b); return w ? String(w.id) : null; },
    // G-15. A facade's "+": who receives the click, and what a DRAG starting there does.
    midHandlePoints() {
      const l = ctx.canvas.querySelector(".v5layer"); if (!l) return [];
      return [...l.querySelectorAll<HTMLElement>(".edge")].map((e) => {
        const r = e.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          cursor: getComputedStyle(e).cursor, title: e.title,
          at: top ? String(top.className || "") : null,
        };
      });
    },

    addRoomPiece: (type: string, x: number, y: number) => placeNewPieceAt(ctx, type, { x, y }),
    addV5Piece(type: string, x: number, y: number) {
      const p = mk(ctx.etat.plan, type, x, y);
      ctx.etat.plan.pieces.push(p);
      v5ClampPiece(ctx.etat.plan, p); v5Touch(ctx); selReplace(ctx, p.id); render(ctx); save(ctx);
      return p;
    },
    addAtCursor(type: string, ax?: number, ay?: number) {
      if (ax !== undefined) setCursorApt(ax, ay ?? null);
      return placeNewPieceAt(ctx, type, lastCursorApt());
    },
    placeAt: (type: string, apt: { x: number; y: number } | null) => placeNewPieceAt(ctx, type, apt),
    setCursorApt: (ax, ay) => setCursorApt(ax, ay),
    get lastCursorApt() { return lastCursorApt(); },
    // PROGRAMMATIC resize: `dx`/`dy` are in APARTMENT cm, not pixels. It redoes EXACTLY the
    // arithmetic of `startPieceResize` (fixed world anchor, w/h in local frame) instead of
    // synthesizing events: synthetic `PointerEvent`s bypass hit-testing, and the real mouse has
    // its own suite (`ouverture-redim`, `gestes-precision`).
    resizeHandle(pieceId: unknown, hkey: string, dx: number, dy: number) {
      const p = pieceById(ctx, pieceId); if (!p) return null;
      if (p.locked || isWallMount(p.type)) return null;
      const h = RSZ_BYKEY[hkey]; if (!h) return null;
      selReplace(ctx, p.id);
      pushHistory(ctx);
      const rad = (p.rot || 0) * Math.PI / 180, cs = Math.cos(rad), sn = Math.sin(rad);
      const w0 = p.w, h0 = p.h;
      const c0x = p.x + w0 / 2, c0y = p.y + h0 / 2;
      const alx = h.ax * w0 / 2, aly = h.ay * h0 / 2;
      const awx = c0x + (alx * cs - aly * sn), awy = c0y + (alx * sn + aly * cs);
      // the grabbed handle sits at the local corner / midpoint (ux,uy) ...
      const glx = h.ux * w0 / 2, gly = h.uy * h0 / 2;
      const gwx = c0x + (glx * cs - gly * sn), gwy = c0y + (glx * sn + gly * cs);
      // ... it is moved by (dx,dy): this is the position the move handler would see.
      const px = gwx + dx, py = gwy + dy;
      const rx = px - awx, ry = py - awy;
      const dLocX = rx * cs + ry * sn, dLocY = -rx * sn + ry * cs;
      let nw = w0, nh = h0;
      if (h.dw) nw = dLocX * h.ux;
      if (h.dh) nh = dLocY * h.uy;
      nw = Math.round(clamp(nw, RSZ_MIN, RSZ_MAX));
      nh = Math.round(clamp(nh, RSZ_MIN, RSZ_MAX));
      const olx = h.ux * nw / 2, oly = h.uy * nh / 2;
      const ncx = awx + (olx * cs - oly * sn), ncy = awy + (olx * sn + oly * cs);
      p.w = nw; p.h = nh; p.x = Math.round(ncx - nw / 2); p.y = Math.round(ncy - nh / 2);
      v5Touch(ctx);
      render(ctx); ctx.crochets.syncInspector?.();
      return { w: p.w, h: p.h, x: p.x, y: p.y, rot: p.rot || 0 };
    },
    delSel: () => delSel(ctx),

    v5PlaceAt(type: string, x: number, y: number) {
      const op = v5PlaceWallMount(ctx.etat.plan, type, x, y, wallSnapReach(ctx.vue.scale), fabriqueOuverture(ctx.etat.plan), ctx.etat.opts);
      // The old `v5PlaceWallMount` (js/52) used to end with `v5Touch(); selReplace(); render();
      // openInspector();`: that is screen work, so it belongs to the caller. `placeNewPieceAt`
      // already does it (gestes/pose.ts); without it here, the opening existed in the plan but
      // was NEVER painted, and the `une_ouverture_deja_posee_bouge_pendant_le_glisser` case
      // found no node at all.
      if (op) {
        v5Touch(ctx); selReplace(ctx, op.id); render(ctx); ctx.crochets.openInspector?.();
        v5FlushPlaceNarrowed(); save(ctx);
      }
      return op ? { id: String(op.id), wallId: String(op.wallId), t0: op.t0, side: op.side ? 1 : 0, type: op.type } : null;
    },
    // The opening's rendered box (center + rotation) + the cell targeted by its +y.
    v5OpeningPose(id: unknown) {
      const op = v5OpeningById(ctx, id); if (!op) return null;
      const b = v5OpeningBox(ctx.etat.plan, op, hDefaut(op.type)); if (!b) return null;
      const rad = b.rot * Math.PI / 180;           // LOCAL +y in world space = (-sin, cos)
      const ny = { x: -Math.sin(rad), y: Math.cos(rad) };
      const probe = v5CellsAt(ctx.etat.plan, b.cx + ny.x * 20, b.cy + ny.y * 20);
      const back = v5CellsAt(ctx.etat.plan, b.cx - ny.x * 20, b.cy - ny.y * 20);
      const w = v5WallById(ctx, op.wallId);
      return {
        wallId: String(op.wallId), t0: op.t0, side: op.side, rot: b.rot,
        cx: +b.cx.toFixed(1), cy: +b.cy.toFixed(1),
        facesCell: probe ? String(probe.id) : null, facesName: probe ? probe.name : null,
        backCell: back ? String(back.id) : null, backName: back ? back.name : null,
        onWall: w ? +closestOnSeg(b.cx, b.cy, w.a[0], w.a[1], w.b[0], w.b[1]).dist.toFixed(2) : null,
      };
    },
    dragOpeningTo(id: unknown, x: number, y: number) {
      const op = v5OpeningById(ctx, id); if (!op) return null;
      if (!v5MoveOpeningTo(ctx.etat.plan, op, x, y, 0, wallSnapReach(ctx.vue.scale), ctx.etat.opts)) return null;
      v5Touch(ctx); render(ctx); save(ctx);
      // G-16: the depth follows the arrival wall's thickness, and the word is handed back to the
      // gesture; the probe flushes it the way a release would, and reports it.
      const dit = v5FlushOpeningThinned();
      return { id: String(op.id), wallId: String(op.wallId), t0: op.t0, side: op.side, h: op.h, aminci: !!dit };
    },
    openingGeom(id: unknown) {
      const o = v5OpeningById(ctx, id); if (!o) return null;
      return {
        t0: +Number(o.t0).toFixed(2), w: +Number(o.w).toFixed(2), h: o.h,
        wallId: String(o.wallId), side: o.side ? 1 : 0,
      };
    },
    // G-19. The handles actually painted on the selected opening, with their screen position.
    openingHandles(id: unknown) {
      if (id != null) selReplace(ctx, id);
      render(ctx); v5DrawOpeningResize(ctx);
      const cible = (id != null ? id : ctx.selection.primaire);
      const el = ctx.canvas.querySelector<HTMLElement>(`.piece[data-op="1"][data-id="${cssId(cible)}"]`);
      if (!el) return [];
      return [...el.querySelectorAll<HTMLElement>(".rsz-handle")].map((h) => {
        const r = h.getBoundingClientRect();
        return {
          end: String(h.dataset["rsz"]), cursor: h.style.cursor,
          x: +(r.left + r.width / 2).toFixed(1), y: +(r.top + r.height / 2).toFixed(1),
          dehors: parseFloat(h.style.left) < 0 || parseFloat(h.style.left) > el.getBoundingClientRect().width + 0.5,
        };
      });
    },
    openingLimits(id: unknown) {
      const o = v5OpeningById(ctx, id); if (!o) return null;
      const w = v5WallById(ctx, o.wallId); if (!w) return null;
      const l = v5OpeningEdgeLimits(ctx.etat.plan, o, w, ctx.etat.opts);
      return {
        L: +l.L.toFixed(1), lo: +l.lo.toFixed(1), hi: +l.hi.toFixed(1),
        loLim: +l.loLim.toFixed(1), hiLim: +l.hiLim.toFixed(1),
        loQui: l.loQui ? String(l.loQui.name || l.loQui.id) : null,
        hiQui: l.hiQui ? String(l.hiQui.name || l.hiQui.id) : null,
      };
    },
    rszReadout() { const r = $("rszReadout"); return (r && !r.hidden) ? r.textContent : null; },
    // "Switch side" via the REAL card button.
    clickFlipSide(id: unknown) {
      if (id != null) selReplace(ctx, id);
      ctx.crochets.openInspector?.();
      const b = $("iSide") as HTMLButtonElement | null;
      if (!b || b.hidden || b.disabled) return { clicked: false, hidden: !!(b && b.hidden) };
      b.click(); return { clicked: true };
    },
    // "Switch side" via the R KEY (same path as the user's keyboard).
    pressFlipSide(id: unknown) {
      if (id != null) selReplace(ctx, id);
      ctx.crochets.openInspector?.();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true }));
      return true;
    },
    flipWallMountSide: (p) => flipWallMountSide(ctx, p),

    get poseArme() { return poseArme(); },
    armPose(type: string) { armerPose(ctx, type); return poseArme(); },
    paletteArmed: () => [...document.querySelectorAll<HTMLElement>("#palette .pitem.armed")].map((e) => e.dataset["type"]),
    get posing() { const a = document.querySelector(".app"); return !!a && a.classList.contains("posing"); },
    poseArmeAuCentre() { const p = poserAuCentre(ctx); return p ? String(p.id) : null; },

    clipInfo: planClipInfo,
    clipCopy: () => planCopy(ctx, false),
    clipCut: () => planCopy(ctx, true),
    clipPaste: () => planPaste(ctx),
    clipReset: planClipReset,
    clipPasteText: (txt: unknown) => planPasteFromText(ctx, txt),

    get lassoVivant() { return lassoVivant(); },
    piecesInClientRect: (rect) => piecesInClientRect(ctx, rect),

    COARSE,
    wallSnapReach: () => wallSnapReach(ctx.vue.scale),
    // PREVIEW WITHOUT ANY MUTATION: where and how a wall-mounted object will land (G-21). ONE
    // snapping logic, shared with the real placement.
    wallMountPreviewApt: (type: string, ax: number, ay: number, maxDist?: number) =>
      wallMountPreviewApt(ctx.etat.plan, type, ax, ay, maxDist == null ? wallSnapReach(ctx.vue.scale) : maxDist),
    serialize: () => serialize(ctx),
    overlapArea: v5OverlapArea,
    // Full placement of a wall-mounted object via the USER path (placeNewPieceAt), banner included.
    placeWallMountAt(type: string, x: number, y: number) {
      const r = placeNewPieceAt(ctx, type, { x, y });
      return { placed: !!r, id: r ? String(r.id) : null, toast: toastText() };
    },
    dragWallMountTo(id: unknown, x: number, y: number) { return this.dragOpeningTo(id, x, y); },
    railOpen,
    deviceTag: v5DeviceTag,
    newId: v5NewId,

    get vScale() { return ctx.vue.scale; },
    // Does the whole plan fit in the viewport? (overflow in px, negative = it overflows)
    viewFits() {
      const b = aptBBox(ctx), r = ctx.viewport.getBoundingClientRect();
      const a = aptToScreen(ctx, b.minX, b.minY), c = aptToScreen(ctx, b.maxX, b.maxY);
      return {
        left: Math.round(a.x), top: Math.round(a.y),
        right: Math.round(r.width - c.x), bottom: Math.round(r.height - c.y),
        fits: a.x >= -1 && a.y >= -1 && c.x <= r.width + 1 && c.y <= r.height + 1,
      };
    },
    // PROGRAMMATIC panning: the SAME path as the view (renderView), so nothing is persisted (G-2).
    panBy(dx: number, dy: number) {
      ctx.vue.ox += dx; ctx.vue.oy += dy; renderView(ctx);
      return { scale: +ctx.vue.scale.toFixed(6), ox: Math.round(ctx.vue.ox), oy: Math.round(ctx.vue.oy) };
    },
    chipCount() { const e = $("roomsList"); return e ? e.querySelectorAll(".room-chip").length : 0; },
    chipNames: () => [...document.querySelectorAll("#roomsList .room-chip .rc-name")].map((n) => n.textContent),
    chipAreas: () => [...document.querySelectorAll("#roomsList .room-chip .rc-area")].map((n) => n.textContent),
    activeChipName() {
      const e = document.querySelector("#roomsList .room-chip.active .rc-name");
      return e ? e.textContent : null;
    },
    openInspector() { ctx.crochets.openInspector?.(); },
    setModel: (plan: unknown) => v5SetModel(ctx, plan as never),
    seedPlan(plan: unknown) { const r = v5SetModel(ctx, plan as never); save(ctx); return r; },
  };
}

// `cur`, `renderView`, `v5NearestWall`, `v5ClampPieces`, and `v5CellById` are imported to stay
// in the hook's `import` graph: the suites reach them through the entries above, and an
// accidental removal would become a compile error here.
void cur; void renderView; void v5NearestWall; void v5ClampPieces; void v5Seg;
