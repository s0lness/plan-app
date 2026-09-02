// src/ts/rendu/selection.ts: THE SELECTION MODEL. `ids` is the source of truth (a set of
// identifiers); `primaire` is DERIVED, the LAST one added, read by the inspector and the rotation
// handle. The two fields only touch each other through these functions.

import type { Contexte } from "../app/contexte.ts";

/** The last one inserted wins: `Set` preserves insertion order. */
function recalculerPrimaire(ctx: Contexte): void {
  ctx.selection.primaire = null;
  for (const id of ctx.selection.ids) ctx.selection.primaire = id;
}

export const isSel = (ctx: Contexte, id: unknown): boolean => ctx.selection.ids.has(String(id));

export function clearSel(ctx: Contexte): void {
  ctx.selection.ids.clear();
  ctx.selection.primaire = null;
}

export function selReplace(ctx: Contexte, id: unknown): void {
  const k = String(id);
  ctx.selection.ids.clear();
  ctx.selection.ids.add(k);
  ctx.selection.primaire = k;
}

export function selAdd(ctx: Contexte, id: unknown): void {
  const k = String(id);
  ctx.selection.ids.add(k);
  ctx.selection.primaire = k;
}

/**
 * Returns the state AFTER toggling (true = now selected). The old client used to show, in
 * passing, the "multi" hint beyond one object: that's a UI hint, it belongs to the gestures
 * batch, not to the selection model.
 */
export function selToggle(ctx: Contexte, id: unknown): boolean {
  const k = String(id);
  if (ctx.selection.ids.has(k)) {
    ctx.selection.ids.delete(k);
    recalculerPrimaire(ctx);
    return false;
  }
  ctx.selection.ids.add(k);
  ctx.selection.primaire = k;
  return true;
}

/**
 * Recomputes the primary after a removal done ELSEWHERE (toggling a layer removes from the
 * selection whatever just became invisible). `selRecomputePrimary` in the old client.
 */
export function selRecomputePrimary(ctx: Contexte): void { recalculerPrimaire(ctx); }
