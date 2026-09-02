// src/ts/gestes/redimension.ts: RESIZING A PIECE OF FURNITURE BY ITS HANDLES.
// Ported from src/js/18-redimension.js.
//
// The gesture works in the piece's LOCAL frame, so a rotated piece resizes along
// ITS OWN axes. The ANCHOR (the OPPOSITE corner or edge) is fixed in world space: it is computed
// once at pickup, then every frame re-derives w/h from the pointer's offset measured along the
// local axes from that anchor, and repositions the center so the anchor doesn't move. This is the
// same rule as G-19 for openings: "what is under the cursor is what moves."
//
// G-1, AND THIS IS WHERE THE DEFECT WAS FOUND. A digit typed during a resize used to
// leave the gesture OPEN: keyboard listening must survive the release (you're still typing your
// number), but the GESTURE itself must end right away. Without this separation, `gestureActive`
// stayed true forever, `save()` bailed out on every call, and the whole session
// would disappear on reload, without a single message. Hence `releaseWsDrag()`, deliberately SEPARATE from
// `finish()`.

import type { Contexte } from "../app/contexte.ts";
import type { Meuble } from "../partage/plan.ts";
import { v5Touch } from "../app/contexte.ts";
import { isWallMount } from "../catalogue/catalogue.ts";
import { $, cssId } from "../noyau/dom.ts";
import { clamp } from "../noyau/nombres.ts";
import { RSZ_BYKEY, RSZ_MAX, RSZ_MIN } from "../rendu/meubles.ts";
import { focusEl } from "../rendu/calque.ts";
import { render } from "../rendu/rendu.ts";
import { screenToApt } from "../rendu/vue.ts";
import { selReplace } from "../rendu/selection.ts";
import { armGesture, disarmGesture, endActiveGesture, escapeActiveGesture } from "./sortie.ts";
import { measureMode, spaceHeld } from "./etat-pointeur.ts";
import { pushHistory } from "../historique/pile.ts";

export function startPieceResize(ctx: Contexte, e: PointerEvent, p: Meuble, hkey: string): void {
  if (measureMode()) return;   // tape measure: the event bubbles up to the viewport (no stopPropagation)
  if (e.button !== undefined && e.button !== 0) return;
  if (spaceHeld()) return;
  e.stopPropagation(); e.preventDefault();
  if (p.locked || isWallMount(p.type)) return;
  const h = RSZ_BYKEY[hkey]; if (!h) return;
  selReplace(ctx, p.id); render(ctx); ctx.crochets.openInspector?.();
  ctx.crochets.dragStart?.();
  const cont = focusEl(ctx);
  // APARTMENT frame (viewport + screenToApt): no more container bbox.
  const rc = ctx.viewport.getBoundingClientRect();
  const toCm = (cx: number, cy: number): { x: number; y: number } => screenToApt(ctx, cx - rc.left, cy - rc.top);
  const noeud = cont && cont.querySelector<HTMLElement>(`.piece[data-id="${cssId(p.id)}"]`);
  try { noeud?.setPointerCapture(e.pointerId); } catch (_) { /* the gesture holds up without capture */ }
  const rad = (p.rot || 0) * Math.PI / 180, cs = Math.cos(rad), sn = Math.sin(rad);
  const w0 = p.w, h0 = p.h;
  const x0 = p.x, y0 = p.y;                              // placement at pickup (Escape restores it as-is)
  const c0x = p.x + w0 / 2, c0y = p.y + h0 / 2;
  // world position of the fixed anchor: center + R(rot)·(anchor in cm)
  const alx = h.ax * w0 / 2, aly = h.ay * h0 / 2;
  const awx = c0x + (alx * cs - aly * sn), awy = c0y + (alx * sn + aly * cs);

  // G-20 IS A DEBT OWED BY THIS GESTURE, AND THE PICKUP IS WHAT SETTLES IT. Below `RSZ_COMPACT_PX`
  // of thumbnail size, `rendu/meubles.ts` paints the four corners `RSZ_OUT_PX` = 6 px OUTSIDE the
  // box: so the pointer at `pointerdown` is NOT on the corner it's holding. Deriving w/h from the
  // pointer's ABSOLUTE position relative to the anchor (`nw = dLocX * h.ux`) used to teleport the
  // corner under the cursor on the very first movement, i.e. 6 px / scale = 9.4 cm at the opening
  // zoom, rounded to 10 by the grid. Measured: a 45×50 chair, corner moved 6 px then PUT BACK AT
  // THE EXACT PIXEL, would come out 55×60 and shrink back 10 cm on both axes; 0 exact round trips out
  // of 19 for compact furniture, and at "Fit" zoom the threshold is 100 cm, so
  // nearly all furniture is affected. We record the handle/edge offset once, at
  // pickup, and subtract it every frame: the corner follows the HAND, not the cursor.
  const cmG = toCm(e.clientX, e.clientY);
  const rgx = cmG.x - awx, rgy = cmG.y - awy;
  const priseX = h.dw ? ((rgx * cs + rgy * sn) - w0 * h.ux) : 0;
  const priseY = h.dh ? ((-rgx * sn + rgy * cs) - h0 * h.uy) : 0;

  // G-3. SELECTING NEVER WRITES: the undo step falls on the FIRST real movement (or on
  // the first typed dimension), never on `pointerdown`. This gesture was the only one of the three to push
  // the history right at pickup, while `gestes/meuble.ts` and `gestes/ouverture.ts` already
  // followed the rule. Measured consequence of a clean click on a handle: `histInfo().undo` would go from
  // 0 to 1 without anything changing, so the first Ctrl+Z did nothing and the second destroyed
  // a real modification.
  let histPousse = false;
  const noterEdition = (): void => { if (histPousse) return; histPousse = true; pushHistory(ctx); };

  /** Applies new LOCAL dimensions while keeping the anchor fixed in world space. */
  const applyWH = (nwIn: number, nhIn: number): void => {
    const nw = Math.round(clamp(nwIn, RSZ_MIN, RSZ_MAX));
    const nh = Math.round(clamp(nhIn, RSZ_MIN, RSZ_MAX));
    const olx = h.ux * nw / 2, oly = h.uy * nh / 2;
    const ncx = awx + (olx * cs - oly * sn), ncy = awy + (olx * sn + oly * cs);
    p.w = nw; p.h = nh;
    p.x = Math.round(ncx - nw / 2); p.y = Math.round(ncy - nh / 2);
    // NOTHING BOUNDS A RESIZE: a piece can be made bigger than the room it stands in, and it
    // simply sticks out. The wall it grows into is Circulation's business to report, not this
    // gesture's to prevent.
    v5Touch(ctx);
  };

  // ---- live dimension + keyboard number entry ---------------------------------------------
  // During the gesture, the readout floats near the cursor. A digit starts an entry that REPLACES
  // the current axis (edge = its dimension; corner = W, then Tab -> H). Enter applies exactly
  // (anchor fixed) and ends the gesture; Escape cancels the entry while keeping the dragged value.
  const readout = $("rszReadout");
  const canW = !!h.dw, canH = !!h.dh;
  let typing = false, buf = "", axis: "w" | "h" = (canW ? "w" : "h");
  let lastClient = { x: e.clientX, y: e.clientY };
  let lastDragW = w0, lastDragH = h0;
  let pointerDown = true, ended = false, moved = false;

  function showReadout(): void {
    if (!readout) return;
    readout.hidden = false;
    const vr = ctx.viewport.getBoundingClientRect();
    readout.style.left = (lastClient.x - vr.left) + "px";
    readout.style.top = (lastClient.y - vr.top) + "px";
    const wStr = (typing && axis === "w") ? (buf === "" ? "–" : buf) : String(p.w);
    const hStr = (typing && axis === "h") ? (buf === "" ? "–" : buf) : String(p.h);
    const wCls = (typing && axis === "w") ? "axon" : "";
    const hCls = (typing && axis === "h") ? "axon" : "";
    let html = '<span class="' + wCls + '">' + wStr + '</span> × <span class="' + hCls + '">' + hStr + '</span> cm';
    if (typing) html += ' <span class="cap">⏎</span>';
    readout.innerHTML = html;
  }

  const move = (ev: PointerEvent): void => {
    lastClient = { x: ev.clientX, y: ev.clientY };
    if (typing) { showReadout(); return; }   // typing freezes the drag; we only reposition
    if (!moved) {
      if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) { showReadout(); return; }
      moved = true; noterEdition();
    }
    const cm = toCm(ev.clientX, ev.clientY);
    // pointer's offset from the anchor, expressed along the piece's LOCAL axes (rotation by -rot),
    // MINUS the pickup offset: what we track is the corner being held, not the cursor's tip.
    const rx = cm.x - awx, ry = cm.y - awy;
    const dLocX = rx * cs + ry * sn;
    const dLocY = -rx * sn + ry * cs;
    let nw = w0, nh = h0;
    if (h.dw) nw = (dLocX - priseX) * h.ux;
    if (h.dh) nh = (dLocY - priseY) * h.uy;
    // NO GRID: a dimension follows the hand to the whole centimetre (`applyWH` rounds it, once).
    applyWH(nw, nh);
    lastDragW = p.w; lastDragH = p.h;
    render(ctx); ctx.crochets.syncInspector?.(); ctx.crochets.liveAnalyze?.(); showReadout();
    ctx.crochets.emitDrag?.(p);
  };

  // End of the GESTURE part. Idempotent, and deliberately SEPARATE from `finish()`: on release
  // during a dimension entry it fires right away, so nothing stays blocked while
  // the user finishes typing their number (G-1).
  let wsEnded = false;
  function releaseWsDrag(): void { if (wsEnded) return; wsEnded = true; ctx.crochets.dragEnd?.(); }
  /** A click ELSEWHERE abandons a dimension entry left hanging (pointer already released). */
  function abandon(): void { endActiveGesture(); }

  function finish(): void {
    if (ended) return; ended = true;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerdown", abandon, true);
    disarmGesture();                                  // idempotent: the shared exit may already have disarmed
    window.removeEventListener("keydown", onKey, true);
    if (readout) readout.hidden = true;
    render(ctx); ctx.crochets.syncInspector?.(); ctx.crochets.openInspector?.();
    releaseWsDrag();
  }

  function commitTyped(): void {
    const val = parseFloat(buf);
    if (isFinite(val) && val > 0) {
      let nw = p.w, nh = p.h;
      if (axis === "w") nw = val; else nh = val;
      noterEdition();                                 // a TYPED dimension is a real modification
      applyWH(nw, nh);
      render(ctx); ctx.crochets.syncInspector?.(); ctx.crochets.liveAnalyze?.();
      ctx.crochets.emitDrag?.(p);
    }
    typing = false; buf = "";
  }

  const onKey = (ev: KeyboardEvent): void => {
    // A dimension entry is only valid over the PLAN: as soon as focus is in a field (a piece of
    // furniture's name, a room's name...), we no longer capture ANYTHING, and if the pointer is already
    // released we abandon. Without this, "Room 2" was impossible to type: the 2 was swallowed here.
    const ae = document.activeElement as HTMLElement | null;
    if (ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName || "") || ae.isContentEditable)) {
      if (!pointerDown) endActiveGesture();
      return;
    }
    const k = ev.key;
    if (/^[0-9]$/.test(k)) {
      ev.preventDefault(); ev.stopPropagation();
      if (!typing) { typing = true; buf = ""; if (!(axis === "w" ? canW : canH)) axis = (canW ? "w" : "h"); }
      buf += k; showReadout(); return;
    }
    if (k === "." && typing) { ev.preventDefault(); ev.stopPropagation(); if (!buf.includes(".")) buf += "."; showReadout(); return; }
    if (k === "Backspace" && typing) { ev.preventDefault(); ev.stopPropagation(); buf = buf.slice(0, -1); showReadout(); return; }
    if (k === "Tab" && typing && canW && canH) {
      ev.preventDefault(); ev.stopPropagation();
      if (buf !== "") {
        const val = parseFloat(buf);
        if (isFinite(val) && val > 0) { noterEdition(); if (axis === "w") applyWH(val, p.h); else applyWH(p.w, val); render(ctx); ctx.crochets.syncInspector?.(); }
      }
      axis = (axis === "w") ? "h" : "w"; buf = ""; showReadout(); return;
    }
    if (k === "Enter") {
      ev.preventDefault(); ev.stopPropagation();
      if (typing) commitTyped();
      endActiveGesture(); return;                     // always through the shared exit
    }
    if (k === "Escape") {
      ev.preventDefault(); ev.stopPropagation();
      if (typing) { typing = false; buf = ""; applyWH(lastDragW, lastDragH); render(ctx); ctx.crochets.syncInspector?.(); showReadout(); }
      else escapeActiveGesture();   // G-12: the dimension from before the gesture comes back
      return;
    }
  };

  // Release: if a dimension entry is in progress, the keyboard listening SURVIVES. But the GESTURE
  // itself ends immediately: this exact block was what used to kill the whole session's saving
  // whenever the user never pressed Enter (G-1).
  const onUp = (): boolean => {
    pointerDown = false;
    if (!typing) return true;
    releaseWsDrag();
    window.addEventListener("pointerdown", abandon, true);
    return false;
  };
  // G-12. Escape: the piece gets back exactly the dimension and placement it had at pointerdown.
  const cancelResize = (): void => {
    typing = false; buf = "";
    p.w = w0; p.h = h0; p.x = x0; p.y = y0; v5Touch(ctx); render(ctx); ctx.crochets.syncInspector?.();
  };
  lastDragW = p.w; lastDragH = p.h; showReadout();
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("pointermove", move);
  armGesture(finish, onUp, cancelResize);
}
