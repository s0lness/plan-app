// src/ts/gestes/selection-actions.ts — THE MINIMUM OF THE INSPECTOR THAT GESTURES NEED.
//
// The inspector (src/js/21-inspecteur.js) is NOT part of this batch: it will come with the
// panels. But three of its functions are called by GESTURES (Delete, Ctrl+X, the R key on a wall
// light) and have nothing to do with the panel itself: they are actions on the SELECTION. We
// expose them here, at the minimum, rather than dragging the panel in sideways.
//
// `openInspector` / `syncInspector` / `hideInspector`, on the other hand, stay HOOKS (`ctx.crochets`):
// they really are panel operations, and a gesture has no business knowing how they are written.

import type { Contexte } from "../app/contexte.ts";
import type { Meuble, Ouverture } from "../partage/plan.ts";
import { pieceById, v5OpeningById, v5Touch, v5WallById } from "../app/contexte.ts";
import { TYPEMAP, isSideable } from "../catalogue/catalogue.ts";
import { WALL } from "../noyau/nombres.ts";
import { v5CellsAt, v5OpeningBox, v5Seg } from "../modele/murs.ts";
import { v5ClampPiece, v5OpeningBlockerOnSide } from "../modele/edition.ts";
import { imposerEcart, repartirEgalement } from "../modele/repartir.ts";
import { clearSel } from "../rendu/selection.ts";
import { render } from "../rendu/rendu.ts";
import { pushHistory } from "../historique/pile.ts";
import { save } from "../app/persistance.ts";
import { toast } from "../app/toast.ts";

/** The PRIMARY object of the selection, furniture OR opening (openings are outside `pieces[]`). */
/**
 * EVENLY DISTRIBUTE the selection's spacing. The computation is PURE (`modele/repartir.ts`); here
 * we only apply it, with the same rules as any other move:
 *   - ONE single undo step for the whole operation (`pushHistory` before writing);
 *   - the SAME bounds as the keyboard and the drag (`v5ClampPiece`), so no redistribution
 *     can push a piece of furniture out of its room: inventing a path that escapes the clamps is
 *     inventing a path that escapes G-13;
 *   - every refusal is STATED, never a gesture that does nothing without explanation.
 * Returns `true` if something moved.
 */
export function repartirSelection(ctx: Contexte, ecartVoulu?: number): boolean {
  const sel: Meuble[] = [];
  for (const id of ctx.selection.ids) {
    const p = pieceById(ctx, id);
    if (p) sel.push(p);
  }
  // Two operations, ONE single application path: the computation changes, the bounds, the history
  // and the publication do not. Two paths would diverge at the first fix.
  const res = ecartVoulu === undefined ? repartirEgalement(sel) : imposerEcart(sel, ecartVoulu);
  if (!res.ok) {
    toast(res.refus === "moins_de_trois"
      ? "Select at least three objects: with two there is only one gap, so there is nothing to even out."
      : res.refus === "axe_ambigu"
      ? "These objects are not lined up along one direction, so there is no spacing to even out."
      : "One of the middle objects is locked: unlock it, or leave it out of the selection.",
      { geste: true });
    return false;
  }
  if (!res.r.bouges.length) {
    toast("The spacing is already even.", { geste: true });
    return false;
  }
  pushHistory(ctx);
  for (const b of res.r.bouges) {
    const m = pieceById(ctx, b.id);
    if (!m) continue;
    m.x += b.dx; m.y += b.dy;
    v5ClampPiece(ctx.etat.plan, m);
  }
  v5Touch(ctx); render(ctx); ctx.crochets.persister?.();
  for (const b of res.r.bouges) {
    const m = pieceById(ctx, b.id);
    if (m) ctx.crochets.emitDrag?.(m);
  }
  toast(ecartVoulu === undefined
    ? `Spacing evened out to ${Math.round(res.r.ecart)} cm.`
    : `Spacing set to ${Math.round(res.r.ecart)} cm.`, { geste: true });
  return true;
}

export function cur(ctx: Contexte): Meuble | Ouverture | undefined {
  if (ctx.selection.primaire == null) return undefined;
  return pieceById(ctx, ctx.selection.primaire) || v5OpeningById(ctx, ctx.selection.primaire) || undefined;
}

/** Deletes THE ENTIRE selection, both families combined. One single undo step. */
export function delSel(ctx: Contexte): void {
  if (!ctx.selection.ids.size) return;
  pushHistory(ctx);
  const P = ctx.etat.plan;
  const ids = [...ctx.selection.ids];
  ids.forEach((id) => {
    const oi = (P.openings || []).findIndex((o) => String(o.id) === String(id));
    if (oi >= 0) { P.openings.splice(oi, 1); v5Touch(ctx); return; }
    const i = (P.pieces || []).findIndex((x) => String(x.id) === String(id));
    if (i >= 0) { P.pieces.splice(i, 1); v5Touch(ctx); }
  });
  clearSel(ctx); ctx.crochets.hideInspector?.(); render(ctx);
}

/** Do BOTH faces of the mounting wall open onto a cell? If not, the object faces outside. */
function wallMountBothSidesLive(ctx: Contexte, p: Ouverture): boolean {
  if (!p || p.wallId === undefined) return true;
  const w = v5WallById(ctx, p.wallId); if (!w) return true;
  const s = v5Seg(w), b = v5OpeningBox(ctx.etat.plan, p, (TYPEMAP[p.type] || { h: WALL }).h || WALL); if (!b) return true;
  const off = WALL / 2 + 6;
  return !!v5CellsAt(ctx.etat.plan, b.cx - s.uy * off, b.cy + s.ux * off)
    && !!v5CellsAt(ctx.etat.plan, b.cx + s.uy * off, b.cy - s.ux * off);
}

/**
 * "Flip side": put the object on the OTHER face of its wall (the opening's `side`; no
 * new field, the server locks down the allowed keys).
 *
 * THE OTHER FACE CAN BE TAKEN, AND THAT IS REFUSED OUT LOUD. Since two devices can
 * live back to back, the flip is the ONLY gesture able to stack two objects on the same face.
 * Refuse rather than slide the object along the wall: "Flip side" only talks about the face,
 * it has no reason to move the object by a centimeter, and the round trip must stay exact.
 */
export function flipWallMountSide(ctx: Contexte, p: Ouverture | Meuble | undefined): boolean {
  const o = p as Ouverture | undefined;
  if (!o || (o as { locked?: boolean }).locked || !isSideable(o.type) || o.wallId === undefined) return false;
  const bloc = v5OpeningBlockerOnSide(ctx.etat.plan, o, o.side ? 0 : 1);
  if (bloc) {
    toast(`The other face of this wall is already taken here by “${bloc.name || "an object"}”: move one of the two first.`, { geste: true });
    return false;
  }
  pushHistory(ctx);
  o.side = o.side ? 0 : 1; v5Touch(ctx);
  if (!wallMountBothSidesLive(ctx, o)) {
    toast("This wall faces outside: the object now looks out of the flat.", { geste: true });
  }
  render(ctx); ctx.crochets.syncInspector?.(); save(ctx);
  return true;
}
