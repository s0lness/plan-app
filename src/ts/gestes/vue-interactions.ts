// src/ts/gestes/vue-interactions.ts — THE VIEW, THE FINGER, AND THE LASSO.
// Ported from src/js/22-interactions-vue.js (wheel, panning, pinch, long press, rubber
// band, `piecesInClientRect`).
//
// THREE INVARIANTS LIVE HERE:
//
//  G-2  THE VIEW IS NOT THE PLAN. Panning, zoom, pinch and "Fit" go through
//       `renderView()`, which repaints WITHOUT PERSISTING ANYTHING. Measured before: a 40-move
//       pan = 40 serializations and 854,520 bytes written.
//  G-11 THE LASSO KNOWS BOTH FAMILIES, AND WHAT IT CATCHES GETS MARKED DURING THE GESTURE.
//       `pieceById` only knows about furniture: windows, doors, wall lights and outlets live in
//       `plan.openings` and were being SILENTLY dropped (measured: a full-screen lasso caught
//       47 objects and zero openings). And NOTHING gets written during the gesture: neither `selIds`, nor
//       `render()`, nor `save()`; the marking is paced by `requestAnimationFrame` and applied to
//       only the nodes whose state CHANGES.
//  G-12 ESCAPE RESTORES EVERYTHING TO ITS PRIOR STATE. Without this restoration, the shared exit used to
//       VALIDATE the rectangle's selection: Escape was selecting instead of canceling.

import type { Contexte } from "../app/contexte.ts";
import { pieceById, v5OpeningById } from "../app/contexte.ts";
import { pieceVisible } from "../catalogue/catalogue.ts";
import { $, cssId } from "../noyau/dom.ts";
import { clamp } from "../noyau/nombres.ts";
import { fitView, renderView, scaleBounds, screenToApt, zoomAt } from "../rendu/vue.ts";
import { render } from "../rendu/rendu.ts";
import { clearSel } from "../rendu/selection.ts";
import { armGesture } from "./sortie.ts";
import { v5StartDraw } from "./murs.ts";
import {
  TOUCH_DRAG_THRESH, isTouchEvt, measureMode, setCursorApt, setSpaceHeld, spaceHeld, touchPts,
} from "./etat-pointeur.ts";

/** px of travel before a drag becomes a band (below: it's a click). */
export const RUBBER_THRESH = 4;

/**
 * True when a wheel event's target sits inside a panel that scrolls its OWN overflow (today, only
 * the chat message list, `.chat-list` — it lives INSIDE `#viewport`, see `html/02-scene.html`, so
 * its wheel events reach this listener by ordinary bubbling). Measured live, two people testing
 * multiplayer together: the wheel over the open chat panel zoomed the plan underneath it instead
 * of scrolling the messages, because the viewport's own wheel handler ran first and called
 * `preventDefault()` unconditionally, on every target, everywhere inside it.
 *
 * Walks from the event's target up to (but not including) `viewport` itself: nothing OUTSIDE the
 * viewport ever reaches this listener in the first place (bubbling stops caring past the element
 * the listener is attached to), so anywhere this returns true is provably a panel nested inside
 * the viewport. Deliberately a GENERAL rule — "does the nearest scrolling ancestor actually have
 * something to scroll" — rather than a hardcoded `.chat-list` check, so a later panel added inside
 * the viewport inherits the fix instead of needing its own copy of it.
 */
function surPanneauDeroulant(viewport: HTMLElement, cible: EventTarget | null): boolean {
  let el = cible instanceof Element ? cible : null;
  while (el && el !== viewport) {
    if (el.scrollHeight > el.clientHeight) {
      const overflowY = getComputedStyle(el).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") return true;
    }
    el = el.parentElement;
  }
  return false;
}

let rubberLive = false;
/** Test probe: is a lasso in progress? */
export const lassoVivant = (): boolean => rubberLive;

/** Starts a pan from a client point. The VIEW persists nothing (G-2). */
export function startPan(ctx: Contexte, e: PointerEvent): void {
  const r0 = ctx.viewport.getBoundingClientRect();
  const start = screenToApt(ctx, e.clientX - r0.left, e.clientY - r0.top);
  ctx.viewport.classList.add("panning");
  const move = (ev: PointerEvent): void => {
    const rect = ctx.viewport.getBoundingClientRect();
    const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    // the apartment point captured at pointerdown stays under the cursor
    ctx.vue.ox = px - start.x * ctx.vue.scale;
    ctx.vue.oy = py - start.y * ctx.vue.scale;
    renderView(ctx);
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    ctx.viewport.classList.remove("panning");
  };
  window.addEventListener("pointermove", move);
  armGesture(up);   // G-1: guaranteed end
}

/**
 * G-11. Every VISIBLE, unlocked object whose SCREEN box intersects the rectangle. We read the
 * NODE's box, so zoom, pan and rotation are already baked in. OPENINGS ARE PART OF
 * THIS: the rest of the chain already accepts them (`delSel` deletes them, the clipboard
 * copies them, a group drag ignores them, since an opening has no free x/y).
 */
export function piecesInClientRect(
  ctx: Contexte,
  rect: { left: number; top: number; right: number; bottom: number },
): string[] {
  const ids: string[] = [];
  ctx.canvas.querySelectorAll<HTMLElement>(".piece").forEach((el) => {
    const id = el.dataset["id"];
    const pc = pieceById(ctx, id) || v5OpeningById(ctx, id);
    // `locked` is NOT an opening key (the server locks down the list, `OPENING_KEYS`): we read it
    // in case an old plan carries one, exactly as the single closure used to do.
    if (!pc || (pc as { locked?: boolean }).locked) return;
    if (!pieceVisible(pc, ctx.etat.opts)) return;
    const b = el.getBoundingClientRect();
    if (b.right < rect.left || b.left > rect.right || b.bottom < rect.top || b.top > rect.bottom) return;
    ids.push(String(pc.id));
  });
  return ids;
}

/**
 * G-11. Rubber band OR click. YOU SEE WHAT YOU'RE CATCHING, WHILE YOU'RE CATCHING IT: the rectangle
 * used to show only itself, you were dragging blind. The mark is EXACTLY that of an acquired
 * selection, not a third state: what the screen shows during the gesture is what you'll get on
 * release, and the rectangle alone already says the gesture is in progress.
 */
export function startRubberOrClick(ctx: Contexte, e: PointerEvent): void {
  // CTRL/CMD ADDS, AND SHIFT NO LONGER DOES, because Shift is now what OPENS the lasso at all:
  // an ordinary drag over empty space draws a wall. Leaving Shift in this set made every lasso
  // additive and no lasso could ever replace a selection again, so the two modifiers stopped
  // meaning different things. Caught by `selection-visible.ts`, which states the replacing half of
  // the rule on its new base rather than dropping it when the unmodified gesture disappeared.
  const additiveMod = e.ctrlKey || e.metaKey;
  const vr = ctx.viewport.getBoundingClientRect();
  const sx = e.clientX, sy = e.clientY;
  const rb = $("rubber");
  let banding = false, lastPt = { x: sx, y: sy };
  // `avant` = the selection FROM BEFORE the gesture (the nodes already carry it on screen); `vifs` = what
  // carries the mark at this instant. We only touch the difference between the two.
  const avant = new Set([...ctx.selection.ids].map(String));
  let vifs = new Set(avant);
  let annule = false, raf = 0;
  const noeud = (id: string): HTMLElement | null =>
    ctx.canvas.querySelector<HTMLElement>(`.piece[data-id="${cssId(id)}"]`);
  const marquer = (ids: string[]): void => {
    const veut = new Set(ids.map(String));
    vifs.forEach((id) => { if (!veut.has(id)) { const n = noeud(id); if (n) n.classList.remove("sel"); } });
    veut.forEach((id) => { if (!vifs.has(id)) { const n = noeud(id); if (n) n.classList.add("sel"); } });
    vifs = veut;
  };
  const vifDe = (ex: number, ey: number): string[] => {
    const rect = {
      left: Math.min(sx, ex), top: Math.min(sy, ey),
      right: Math.max(sx, ex), bottom: Math.max(sy, ey),
    };
    const hits = piecesInClientRect(ctx, rect).map(String);
    return additiveMod ? [...new Set([...avant, ...hits])] : hits;
  };
  const move = (ev: PointerEvent): void => {
    lastPt = { x: ev.clientX, y: ev.clientY };
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    if (!banding && Math.hypot(dx, dy) >= RUBBER_THRESH) { banding = true; rubberLive = true; }
    if (!banding) return;
    if (rb) {
      const x0 = Math.min(sx, ev.clientX) - vr.left, y0 = Math.min(sy, ev.clientY) - vr.top;
      rb.hidden = false;
      rb.style.left = x0 + "px"; rb.style.top = y0 + "px";
      rb.style.width = Math.abs(ev.clientX - sx) + "px";
      rb.style.height = Math.abs(ev.clientY - sy) + "px";
    }
    // The computation reads each object's screen box: one frame per refresh is enough, and
    // this is what stops a burst of `pointermove` events from redoing it ten times for nothing.
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; if (!banding || annule) return; marquer(vifDe(lastPt.x, lastPt.y)); });
  };
  // G-12. Without this restoration, the shared exit used to VALIDATE the rectangle's selection.
  const cancel = (): void => {
    annule = true;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    marquer([...avant]);
  };
  const up = (ev?: Event | null): void => {
    window.removeEventListener("pointermove", move);
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    rubberLive = false;
    if (rb) { rb.hidden = true; rb.removeAttribute("style"); rb.hidden = true; }
    if (annule) { marquer([...avant]); return; }
    // The shared exit can call `up` WITHOUT an event (pointercancel, focus loss, the watchdog):
    // we then fall back to the last position seen by move.
    const pe = ev as PointerEvent | null | undefined;
    const ex = (pe && pe.clientX != null) ? pe.clientX : lastPt.x;
    const ey = (pe && pe.clientY != null) ? pe.clientY : lastPt.y;
    if (banding) {
      const finale = vifDe(ex, ey);
      ctx.selection.ids.clear();
      finale.forEach((id) => ctx.selection.ids.add(id));
      let primaire: string | null = null;
      for (const id of ctx.selection.ids) primaire = id;   // the last one inserted wins
      ctx.selection.primaire = primaire;
      if (ctx.selection.ids.size > 1) ctx.crochets.showHint?.("multi");
      // `render()` reapplies the class from `isSel`: the live marks and the acquired selection
      // reconcile here, in a single paint, and nothing can stay marked by mistake.
      render(ctx);
      if (ctx.selection.primaire != null) ctx.crochets.openInspector?.();
      else ctx.crochets.hideInspector?.();
      return;
    }
    // a click (no band): simple deselection
    clearSel(ctx); ctx.crochets.hideInspector?.(); render(ctx);
  };
  window.addEventListener("pointermove", move);
  armGesture(up, null, cancel);
}

/**
 * TOUCH, one finger: pan OR tap. A movement beyond TOUCH_DRAG_THRESH becomes a
 * pan; below it, it stays a tap that deselects. Two fingers are caught by the
 * pinch layer during the CAPTURE phase, which cancels this one via a synthetic `pointerup`.
 */
export function startTouchPanOrTap(ctx: Contexte, e: PointerEvent): void {
  if (spaceHeld()) return;
  const rect0 = ctx.viewport.getBoundingClientRect();
  const start = screenToApt(ctx, e.clientX - rect0.left, e.clientY - rect0.top);
  const sx = e.clientX, sy = e.clientY;
  let panning = false;
  const move = (ev: PointerEvent): void => {
    if (touchPts.size >= 2) return;   // the pinch has taken control
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    if (!panning && Math.hypot(dx, dy) >= TOUCH_DRAG_THRESH) { panning = true; ctx.viewport.classList.add("panning"); }
    if (!panning) return;
    const rect = ctx.viewport.getBoundingClientRect();
    ctx.vue.ox = (ev.clientX - rect.left) - start.x * ctx.vue.scale;
    ctx.vue.oy = (ev.clientY - rect.top) - start.y * ctx.vue.scale;
    renderView(ctx);
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    ctx.viewport.classList.remove("panning");
    if (panning) return;      // it was a pan, not a tap
    if (ctx.wallsMode) return;
    clearSel(ctx); ctx.crochets.hideInspector?.(); render(ctx);
  };
  window.addEventListener("pointermove", move);
  armGesture(up);
}

/**
 * G-23bis. THE RAIL DRAWER (narrow screen / finger). Ported from src/js/09-viewport-rail.js. It is
 * not "part of the render": it is a gesture (a button, a scrim, Escape), and placing by finger depends
 * on it entirely, without it, the thumbnail is unreachable and drag-and-drop doesn't exist.
 */
export function railOpen(on?: boolean | null): void {
  const app = document.querySelector(".app"); if (!app) return;
  const open = (on == null) ? !app.classList.contains("rail-open") : !!on;
  app.classList.toggle("rail-open", open);
  const b = $("btnRail"); if (b) b.setAttribute("aria-expanded", open ? "true" : "false");
}

/** Wires the wheel, panning, pinch and lasso onto the viewport. Called once at bootstrap. */
export function brancherInteractionsVue(ctx: Contexte): void {
  const viewport = ctx.viewport;

  // THE DRAWER IS WIRED TO THE CONTEXT, NOT JUST EXPORTED. `ctx.gestes.railOpen` used to be
  // DECLARED and never SET: the call to `armerPose` (`ctx.gestes.railOpen?.(false)`) therefore
  // did nothing, silently, and the drawer stayed open over the plan. On a finger, the next
  // tap landed on the thumbnail instead of the plan: no `pointerdown` reached the
  // viewport, the placement ghost was never painted and nothing got placed. Measured:
  // `document.elementFromPoint` under the finger returned `.pitem armed` instead of `#viewport`, and the
  // container's class stayed `app rail-open posing` where the old client gives `app posing`.
  // A `?.` on a hook that was never set is a silence: this is the same class of defect as the
  // old client's `typeof x === "function"`, and that is why these points are typed fields
  // of `ctx.gestes` and not global variables.
  ctx.gestes.railOpen = (on: boolean) => railOpen(on);

  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    if (e.code === "Space" && !/INPUT|TEXTAREA|SELECT/.test((t && t.tagName) || "") && !(t && t.isContentEditable)) {
      setSpaceHeld(true); viewport.classList.add("spaceready");
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") { setSpaceHeld(false); viewport.classList.remove("spaceready"); }
  });

  // wheel = zoom (ctrl/⌘ = trackpad pinch, same handling), centered on the pointer — UNLESS the
  // pointer is over a panel that scrolls its own content (`surPanneauDeroulant`), in which case we
  // get out of the way entirely: no `preventDefault()`, no zoom, so the browser's native scroll
  // runs exactly as it would with no listener here at all.
  viewport.addEventListener("wheel", (e) => {
    if (surPanneauDeroulant(viewport, e.target)) return;
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const f = e.ctrlKey ? Math.exp(-e.deltaY * 0.01) : (e.deltaY < 0 ? 1.1 : 1 / 1.1);
    zoomAt(ctx, cx, cy, f);
  }, { passive: false });

  // the context menu is removed on the canvas so that right-button dragging pans
  viewport.addEventListener("contextmenu", (e) => e.preventDefault());

  // G-22 / G-24. THE LAST POINTER POSITION OVER THE PLAN, in apartment cm, on EVERY
  // movement. This is the placement reference shared by placing from the palette and by
  // pasting: "two different rules for two neighboring gestures would be one more source of
  // error." In the old client this line lived in the middle of the COLLABORATION cursor
  // emitter (js/44): a piece of furniture's placement therefore depended, without saying so, on a
  // realtime module. It is here now, with the other view gestures.
  viewport.addEventListener("pointermove", (e) => {
    const vr = viewport.getBoundingClientRect();
    const apt = screenToApt(ctx, e.clientX - vr.left, e.clientY - vr.top);
    setCursorApt(apt.x, apt.y);
  }, { passive: true });
  // `pointerleave` does NOT clear it: you leave the plan to go click a thumbnail in the
  // rail, and clearing it would place the furniture at the view's center instead of the last targeted point.

  // ---- TOUCH LAYER (pointerType "touch" only; the mouse path is unchanged) ----
  // Two fingers = pinch + pan, handled during the CAPTURE phase to PREEMPT (and cancel)
  // any one-finger gesture already in progress. One finger falls through to the ordinary handlers.
  let pinch: { d0: number; s0: number } | null = null;
  let pinchRaf = 0;
  let pinchPending: { d: number; mid: { x: number; y: number } } | null = null;

  const cancelTouchGesture = (): void => {
    // a synthetic `pointerup` cleanly tears down the window listeners of the ongoing gesture
    try { window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); }
    catch (_) { try { window.dispatchEvent(new Event("pointerup")); } catch (__) { /* nothing */ } }
  };
  const pinchMid = (): { x: number; y: number } => {
    let sx = 0, sy = 0, n = 0;
    for (const p of touchPts.values()) { sx += p.x; sy += p.y; n++; }
    return { x: sx / n, y: sy / n };
  };
  const pinchDist = (): number => {
    const a = [...touchPts.values()]; if (a.length < 2) return 0;
    return Math.hypot(a[0]!.x - a[1]!.x, a[0]!.y - a[1]!.y);
  };
  const pinchApply = (): void => {
    pinchRaf = 0; if (!pinch || !pinchPending) return;
    const { d, mid } = pinchPending;
    const rect = viewport.getBoundingClientRect();
    const cx = mid.x - rect.left, cy = mid.y - rect.top;
    // we scale around the current midpoint while keeping that apartment point fixed
    const apt = screenToApt(ctx, cx, cy);
    const { min, max } = scaleBounds(ctx);
    ctx.vue.scale = clamp(pinch.s0 * (d / pinch.d0), min, max);
    ctx.vue.ox = cx - apt.x * ctx.vue.scale; ctx.vue.oy = cy - apt.y * ctx.vue.scale;
    renderView(ctx);
  };

  viewport.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touchPts.size === 2) {
      cancelTouchGesture();
      e.preventDefault();
      pinch = { d0: pinchDist() || 1, s0: ctx.vue.scale };
      viewport.classList.add("panning");
      try { viewport.setPointerCapture(e.pointerId); } catch (_) { /* holds up without capture */ }
    }
  }, { capture: true });

  viewport.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "touch") return;
    if (!touchPts.has(e.pointerId)) return;
    touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && touchPts.size >= 2) {
      e.preventDefault(); e.stopPropagation();
      pinchPending = { d: pinchDist() || pinch.d0, mid: pinchMid() };
      if (!pinchRaf) pinchRaf = requestAnimationFrame(pinchApply);
    }
  }, { capture: true });

  const endTouchPt = (e: PointerEvent): void => {
    if (e.pointerType !== "touch") return;
    touchPts.delete(e.pointerId);
    if (touchPts.size < 2 && pinch) {
      pinch = null; pinchPending = null;
      if (pinchRaf) { cancelAnimationFrame(pinchRaf); pinchRaf = 0; }
      viewport.classList.remove("panning");
    }
  };
  viewport.addEventListener("pointerup", endTouchPt, { capture: true });
  viewport.addEventListener("pointercancel", endTouchPt, { capture: true });

  viewport.addEventListener("pointerdown", (e) => {
    // right button (2) or middle button (1): pans FROM ANYWHERE, even over a room
    if (e.button === 2 || e.button === 1) { e.preventDefault(); e.stopPropagation(); startPan(ctx, e); return; }
    if (e.button !== 0 && e.button !== undefined) return;
    if (spaceHeld()) { e.preventDefault(); startPan(ctx, e); return; }
    // The tape measure (js/06) is not part of this batch: as long as it isn't wired, `measureMode()` is
    // false and this path doesn't exist.
    if (measureMode()) return;
    const t = e.target as HTMLElement | null;
    const pieceEl = t && t.closest && t.closest(".piece");
    const nameEl = t && t.closest && t.closest(".ov-name");
    const handleEl = t && t.closest && t.closest(".vtx,.mid,.edge,.v5wx,.v5wend,.v5wmid,.v5wmove");
    if (pieceEl || nameEl || handleEl) return;   // pieces and handles have their own gestures
    // Walls mode keeps cells and the outline on their existing controls. An interior wall BODY is
    // intentionally ordinary drawing space now: only its visible move handle owns wall movement.
    const wallBody = t && t.closest && t.closest(".v5hit-wall[data-w]");
    if (ctx.wallsMode && !wallBody) return;
    // TOUCH: a finger over empty space = PAN (the rubber band and wall drawing are mouse only).
    if (isTouchEvt(e)) { startTouchPanOrTap(ctx, e); return; }
    if (e.shiftKey) { startRubberOrClick(ctx, e); return; }
    ctx.crochets.showHint?.("draw");
    v5StartDraw(ctx, e, () => { clearSel(ctx); ctx.crochets.hideInspector?.(); });
  });

  $("btnFit")?.addEventListener("click", () => fitView(ctx));
  $("btnRail")?.addEventListener("click", () => railOpen());
  $("railScrim")?.addEventListener("click", () => railOpen(false));
  window.addEventListener("keydown", (e) => {
    const app = document.querySelector(".app");
    if (e.key === "Escape" && app && app.classList.contains("rail-open")) railOpen(false);
  });
}
