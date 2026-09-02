// src/ts/gestes/pile.ts — TWO OBJECTS AT THE SAME SPOT: THE ONE UNDERNEATH STAYS REACHABLE.
// Ported from src/js/12-rendu.js (`pickStacked`, `STACK_TOL`, `STACK_MS`).
//
// G-9 / G-10, and it is the sole arbiter of the stack: it is called by the `pointerdown` of
// FURNITURE and by that of OPENINGS, and it returns the NODE to act on.
//
// The real floor plan contains two wall lights exactly overlapping, and stacking is normal (a
// hob on a worktop, a rug under a sofa). The node on top took 100% of the
// clicks: "thinking you were grabbing one handle, you'd move the washing machine 74 cm without seeing it".
//
// TWO RULES, AND THEY ARE DISTINCT:
//  · PRESS acts on whatever is SELECTED in the stack, otherwise on the top one;
//  · it is the COMPLETED CLICK (press + release without movement, at the same spot) that steps down
//    one level. Stepping down as soon as press fired made the object you'd just reached
//    UNMOVABLE: the next drag, starting from the same pixel, would grab the next one in the stack.
//
// AND THE CYCLE KEY DOES NOT DEPEND ON SELECTION. `elementsFromPoint` gives the REAL paint
// order, but `.piece.sel` raises the selected item to `z-index:50`: the stack would reorder on
// every click, the key would change, and the cycle would restart from zero. Measured on five
// stacked objects: twelve clicks only reached two of them, the three underneath stayed
// UNREACHABLE. `stackedAt` therefore re-sorts on `data-paint`, the paint rank, and the key is the
// sorted SET of identifiers.

import type { Contexte } from "../app/contexte.ts";
import { pieceById, v5OpeningById } from "../app/contexte.ts";
import { stackedAt } from "../rendu/meubles.ts";
import { isSel, selReplace } from "../rendu/selection.ts";
import { render } from "../rendu/rendu.ts";
import { toast } from "../app/toast.ts";

const STACK_TOL = 6, STACK_MS = 2500;

let _stkAt: { x: number; y: number } | null = null;
let _stkKey = "";
let _stkT = 0;
let _stkArme = false;

/** Returns the `.piece` node to act on for this `pointerdown`. */
export function pickStacked(
  ctx: Contexte,
  e: PointerEvent,
  selfEl: HTMLElement | null,
): HTMLElement | null {
  const stack = stackedAt(e);
  if (stack.length < 2) { _stkAt = null; return selfEl; }
  // Key INDEPENDENT OF ORDER: it is the SET of objects present that defines the stack.
  const key = stack.map((n) => n.dataset["id"]).slice().sort().join(",");
  const now = Date.now();
  const suite = !!_stkAt && key === _stkKey && (now - _stkT) < STACK_MS
    && Math.hypot(e.clientX - _stkAt.x, e.clientY - _stkAt.y) <= STACK_TOL;
  let i = stack.findIndex((n) => isSel(ctx, n.dataset["id"]));
  if (i < 0) i = 0;
  const el = stack[i] || selfEl;
  _stkAt = { x: e.clientX, y: e.clientY }; _stkKey = key; _stkT = now;
  if (suite && !_stkArme) {
    _stkArme = true;
    const x0 = e.clientX, y0 = e.clientY, idPris = el && el.dataset["id"];
    let bouge = false;
    const mv = (ev: PointerEvent): void => {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > STACK_TOL) bouge = true;
    };
    const fin = (): void => {
      window.removeEventListener("pointermove", mv, true);
      window.removeEventListener("pointerup", fin, true);
      window.removeEventListener("pointercancel", fin, true);
      _stkArme = false;
      if (bouge) return;                      // it was a DRAG: don't change target
      // After the gesture ends (armGesture), otherwise its `openInspector()` would take back control.
      setTimeout(() => {
        const st = stackedAt({ clientX: x0, clientY: y0 });
        if (st.length < 2) return;
        const k = st.findIndex((n) => n.dataset["id"] === idPris);
        const j = ((k < 0 ? 0 : k) + 1) % st.length;
        const nx = st[j]; if (!nx) return;
        selReplace(ctx, nx.dataset["id"]); render(ctx); ctx.crochets.openInspector?.();
        _stkT = Date.now();
        const p = pieceById(ctx, nx.dataset["id"]) || v5OpeningById(ctx, nx.dataset["id"]);
        // We only speak up WHEN STEPPING DOWN the stack: announcing every overlap (a rug
        // under a sofa, a hob on a worktop) would pop a banner on every single grab.
        toast(`${st.length} objects here: ${(p && p.name) || "object"} (${j + 1}/${st.length}). Click again for the next one.`, { geste: true });
      }, 0);
    };
    window.addEventListener("pointermove", mv, true);
    window.addEventListener("pointerup", fin, true);
    window.addEventListener("pointercancel", fin, true);
  }
  return el;
}
