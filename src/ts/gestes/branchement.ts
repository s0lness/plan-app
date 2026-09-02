// src/ts/gestes/branchement.ts: WHERE GESTURES LAND ON THE RENDER.
//
// The render (batch E3a) creates the nodes and calls `ctx.gestes.*`: it knows NOTHING about
// gestures. This module is the only place that fills in that table, and it is deliberate: in the
// old client, a furniture item's `pointerdown` was written IN THE MIDDLE of `renderPieces` (js/12),
// so touching a gesture reopened the render crossroads (coupling #1 in `src/README.md`).
//
// G-9 / G-10. PRESS TAKES WHAT IS SELECTED, THE COMPLETED CLICK STEPS DOWN ONE LEVEL. The two
// families (furniture and openings) share the SAME arbiter, `pickStacked`, and each must know how
// to redirect to the other: `dataset.op === "1"` marks an opening.

import type { Contexte } from "../app/contexte.ts";
import { pieceById, v5OpeningById, v5Touch } from "../app/contexte.ts";
import { cssId } from "../noyau/dom.ts";
import { render } from "../rendu/rendu.ts";
import { selReplace } from "../rendu/selection.ts";
import { save } from "../app/persistance.ts";
import { pushHistory } from "../historique/pile.ts";
import { renommerCelluleEnLigne, renommerMeubleEnLigne } from "../panneaux/renommer-en-ligne.ts";
import { pickStacked } from "./pile.ts";
import { startPieceDrag } from "./meuble.ts";
import { startPieceResize } from "./redimension.ts";
import { v5StartOpeningDrag } from "./ouverture.ts";
import {
  v5DeleteVertex, v5SelectCell, v5StartInsertHandle,
  v5StartOutlineEdgeDrag, v5StartVertexDrag, v5SelectOutlineEdge, v5LayerDown,
  v5StartWallEndDrag, v5StartWallMove,
} from "./murs.ts";
import { measureMode } from "./etat-pointeur.ts";
import { fitCell } from "../rendu/vue.ts";

const noeudMeuble = (ctx: Contexte, id: unknown): HTMLElement | null =>
  ctx.canvas.querySelector<HTMLElement>(`.piece[data-id="${cssId(id)}"]:not([data-op])`);
const noeudOuverture = (ctx: Contexte, id: unknown): HTMLElement | null =>
  ctx.canvas.querySelector<HTMLElement>(`.piece[data-op="1"][data-id="${cssId(id)}"]`);

export function brancherGestes(ctx: Contexte): void {
  ctx.gestes.meublePointerDown = (e, id) => {
    const el = noeudMeuble(ctx, id);
    const tgt = pickStacked(ctx, e, el);
    if (tgt && tgt !== el && tgt.dataset["op"] === "1") {
      const o = v5OpeningById(ctx, tgt.dataset["id"]);
      if (o) { v5StartOpeningDrag(ctx, e, o); return; }
    }
    const cp = pieceById(ctx, (tgt || el)?.dataset["id"]) || pieceById(ctx, id);
    if (cp) startPieceDrag(ctx, e, cp);
  };

  // Double-click: ONE meaning left (decision 0013), rename. It used to also rotate 90° (or flip a
  // door's leaf) everywhere ELSE on the piece, a second path for what the rotation handle and
  // "Rotate 90°" already do; that branch is gone. Only the LABEL still answers a double-click
  // (see `etiquetteSous`); elsewhere on the piece it now does nothing.
  ctx.gestes.meubleDblClick = (e, id) => {
    const cp = pieceById(ctx, id); if (!cp) return;
    if (!etiquetteSous(e, ".plabel")) return;
    e.preventDefault(); e.stopPropagation();
    ctx.gestes.etiquetteDblClick?.(e, id, "piece");
  };

  /**
   * THE LABEL UNDER THE POINTER, VIA A REAL COLLISION TEST, AND ABOVE ALL NOT VIA `e.target`.
   *
   * Measured: `e.target` is UNUSABLE here. The first click starts a drag, which takes
   * POINTER CAPTURE on the `.piece` node; from then on Chrome re-targets every subsequent mouse
   * event, including `click` and `dblclick`, to that node. A listener placed on `.plabel` therefore
   * NEVER fires on the second click, and the spy proved it: three events, three times the
   * `.piece` target, while `elementFromPoint` was correctly returning `.plabel` at the same instant.
   * A collision test redone on the fly ignores the capture.
   */
  const etiquetteSous = (e: MouseEvent, sel: string): HTMLElement | null => {
    if (!document.elementsFromPoint) return null;
    for (const n of document.elementsFromPoint(e.clientX, e.clientY)) {
      const hit = (n as Element).closest?.<HTMLElement>(sel);
      if (hit) return hit;
    }
    return null;
  };

  // Double-click on the LABEL: rename. We don't invent a floating input field on the
  // plan (it would need positioning, rotating against the object's own rotation, closing, handling
  // Escape): we open the panel THAT ALREADY HAS the name field, cursor in it and text selected, so
  // typing replaces it. One name field per kind of object, one write path.
  ctx.gestes.etiquetteDblClick = (e, id, sorte) => {
    // THE FIELD LANDS ON THE LABEL, not in the panel: that's the request, and it's the gesture
    // of a grid. So we find the TARGETED label via a collision test (same reason as
    // for deciding rename-vs-rotate: pointer capture makes `e.target` unusable).
    const lab = etiquetteSous(e, sorte === "cell" ? ".ov-name[data-c]" : ".plabel");
    if (!lab) return;
    if (sorte === "cell") { renommerCelluleEnLigne(ctx, id, lab); return; }
    const cp = pieceById(ctx, id); if (!cp) return;
    selReplace(ctx, cp.id);
    render(ctx);
    // We re-read the label AFTER the render: selection may have moved it, and writing into a node
    // that `render` just replaced would put the field on a ghost.
    const lab2 = etiquetteSous(e, ".plabel") || lab;
    renommerMeubleEnLigne(ctx, id, lab2);
  };

  ctx.gestes.ouverturePointerDown = (e, id) => {
    const el = noeudOuverture(ctx, id);
    const tgt = pickStacked(ctx, e, el) || el;
    if (tgt && tgt.dataset["op"] !== "1") {
      const q = pieceById(ctx, tgt.dataset["id"]);
      if (q) { startPieceDrag(ctx, e, q); return; }
    }
    const o = v5OpeningById(ctx, tgt?.dataset["id"]) || v5OpeningById(ctx, id);
    if (o) v5StartOpeningDrag(ctx, e, o);
  };

  ctx.gestes.ouvertureDblClick = (e, id) => {
    const o = v5OpeningById(ctx, id); if (!o) return;
    e.preventDefault(); e.stopPropagation();
    selReplace(ctx, o.id); pushHistory(ctx);
    if (o.type === "door" || o.type === "sdoor") o.hinge = o.hinge ? 0 : 1; else o.side = o.side ? 0 : 1;
    v5Touch(ctx); render(ctx); ctx.crochets.openInspector?.(); save(ctx);
  };

  ctx.gestes.poigneeRedim = (e, id, poignee) => {
    const p = pieceById(ctx, id); if (!p) return;
    startPieceResize(ctx, e, p, poignee);
  };

  ctx.gestes.calquePointerDown = (e) => v5LayerDown(ctx, e);
  // A room name keeps the same double-click rename path as a furniture label.
  ctx.gestes.calqueDblClick = (e) => {
    const lab = etiquetteSous(e, ".ov-name[data-c]");
    const cid = lab?.dataset["c"];
    if (cid) { e.preventDefault(); e.stopPropagation(); ctx.gestes.etiquetteDblClick?.(e, cid, "cell"); return; }
  };
  ctx.gestes.choisirCellule = (id, ouvrirFiche) => v5SelectCell(ctx, id, ouvrirFiche);
  ctx.gestes.cadrerCellule = (c) => fitCell(ctx, c);

  ctx.gestes.contourAretePointerDown = (e, i) => v5StartOutlineEdgeDrag(ctx, e, i, () => v5SelectOutlineEdge(ctx, i));
  ctx.gestes.contourInsertionPointerDown = (e, i) => v5StartInsertHandle(ctx, e, i);
  ctx.gestes.contourSommetPointerDown = (e, i) => v5StartVertexDrag(ctx, e, i);
  ctx.gestes.contourSommetSupprimer = (e, i) => {
    if (measureMode()) return;
    e.preventDefault(); e.stopPropagation(); v5DeleteVertex(ctx, i);
  };
  ctx.gestes.boutMurPointerDown = (e, id, bout) => v5StartWallEndDrag(ctx, e, id, bout);
  ctx.gestes.deplacerMurPointerDown = (e, id) => v5StartWallMove(ctx, e, id);
}
