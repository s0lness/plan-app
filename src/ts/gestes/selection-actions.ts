// src/ts/gestes/selection-actions.ts: THE MINIMUM OF THE INSPECTOR THAT GESTURES NEED.
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
import { pieceById, v5OpeningById, v5Touch } from "../app/contexte.ts";
import { isSideable } from "../catalogue/catalogue.ts";
import { oublierAvantAimant } from "../modele/aimant-memoire.ts";
import { v5ClampPiece, v5OpeningBlockerOnSide } from "../modele/edition.ts";
import { autoName } from "../modele/creation.ts";
import { prochainUid } from "../modele/lecture-v4.ts";
import { clearSel, selAdd } from "../rendu/selection.ts";
import { render } from "../rendu/rendu.ts";
import { pushHistory } from "../historique/pile.ts";
import { save } from "../app/persistance.ts";
import { toast } from "../app/toast.ts";

/** The PRIMARY object of the selection, furniture OR opening (openings are outside `pieces[]`). */
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
    oublierAvantAimant(String(id));   // no wall-given rotation left to come back to for a gone piece
    const oi = (P.openings || []).findIndex((o) => String(o.id) === String(id));
    if (oi >= 0) { P.openings.splice(oi, 1); v5Touch(ctx); return; }
    const i = (P.pieces || []).findIndex((x) => String(x.id) === String(id));
    if (i >= 0) { P.pieces.splice(i, 1); v5Touch(ctx); }
  });
  clearSel(ctx); ctx.crochets.hideInspector?.(); render(ctx);
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
  render(ctx); ctx.crochets.syncInspector?.(); save(ctx);
  return true;
}

/**
 * DUPLICATE THE SELECTION, ONE SINGLE PATH (decision 0013): the inspector's Duplicate button and
 * `Ctrl+D` both call this, so there is no second gesture (Alt+drag) to keep in step. Openings are
 * skipped: they belong to their wall, and `Ctrl+C`/`Ctrl+V` already know how to re-attach a copy
 * to the nearest wall, which a plain offset copy cannot. Returns `true` if something was
 * duplicated.
 */
export function dupliquerSelection(ctx: Contexte): boolean {
  if (!ctx.selection.ids.size) return false;
  const src = [...ctx.selection.ids].map((id) => pieceById(ctx, id)).filter((p): p is Meuble => !!p);
  if (!src.length) return false;   // openings-only selection: nothing here duplicates them
  pushHistory(ctx);
  const newIds: string[] = [];
  src.forEach((p) => {
    const n: Meuble = {
      ...p, id: String(prochainUid()), x: p.x + 15, y: p.y + 15,
      locked: false, name: autoName(ctx.etat.plan, p.name),
    };
    ctx.etat.plan.pieces.push(n); v5ClampPiece(ctx.etat.plan, n); newIds.push(String(n.id));
  });
  v5Touch(ctx); clearSel(ctx); newIds.forEach((i) => selAdd(ctx, i));
  render(ctx); ctx.crochets.openInspector?.();
  return true;
}
