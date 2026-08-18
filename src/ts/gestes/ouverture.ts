// src/ts/gestes/ouverture.ts — OPENINGS THAT GET DRAGGED AND RESIZED.
// Ported from src/js/53-v5-outils.js (`v5DrawOpeningGuides`, `v5StartOpeningDrag`) and from
// src/js/56-ouverture-redim.js (EVERYTHING: handles, the width gesture, the bound slate).
//
// An opening has NO coordinates of its own: it belongs to its wall (`wallId`, `t0`, `side`)
// and its depth `h` is the thickness of the object WITHIN that wall. So the two gestures here never
// touch an x/y: the drag only changes the supporting wall and `t0`, resizing only
// changes `w` (and `t0` when it's the edge on the corner-A side being pulled).
//
// FOUR INVARIANTS LIVE HERE.
//
//  G-1  Both gestures arm through `armGesture(finish, null, cancel)` and NEVER listen to
//       `pointerup` themselves: focus loss, `pointercancel` and the watchdog count
//       just as much as the release.
//  G-3  SELECTING NEVER WRITES. `pushHistory()` falls on the FIRST 3 px movement, never on
//       `pointerdown`: a clean click on a window (or on one of its handles) selects it,
//       period.
//  G-12 ESCAPE restores EXACTLY the prior state: the supporting wall, `t0`, the face, the width and
//       the depth for the drag; the width and the position for the handle.
//  G-16 DEPTH IS BOUNDED BY THE WALL'S THICKNESS. Dragging can change the supporting wall:
//       `v5MoveOpeningTo` makes the depth follow DOWNWARD, never upward, Escape
//       restores it, and `v5FlushOpeningThinned` SAYS SO on release.
//  G-19 AN OPENING RESIZES AT ITS HANDLES, OPPOSITE EDGE FIXED, AND EVERY BOUND IS STATED.
//       The three arbitration rules are copied at the top of the "resize" block, right where they apply.
//
// WHAT THE PORT CHANGES, AND IT IS THE ONLY DELIBERATE DEPARTURE: THE `renderV5` WRAPPER DISAPPEARS.
// The old js/56 used to end with `const base=renderV5; renderV5=function(){ base(...); …}`, a
// wrapper installed at runtime, solely because js/50 and js/54 were owned by another
// workstream, which forced the manifest to keep js/56 AFTER js/50 (wrapping a function not
// yet defined under that name would have broken startup). Its own comment already said that
// "a direct call, added at the end of renderV5(), remains the definitive place for this line."
// With real ES modules there is no longer a concatenation order to respect: this module EXPOSES
// `v5DrawOpeningResize(ctx)` and wraps nothing. Bootstrap wires it once
// (`main.ts`: `ctx.crochets.apresRendu = () => v5DrawOpeningResize(ctx)`), so it is called at the
// end of EVERY `render()`, which the wrapper achieved by attaching to the end of `renderV5()`, and
// `rendu/` still imports no gesture module. A function called by its name, instead of
// a variable reassigned after the fact: it's the same line, but it is READABLE from
// bootstrap, and the wrapper's `try/catch` no longer has a reason to exist since it no longer inserts
// itself behind anyone's back. The only point of caution is that `apresRendu` is a SINGLE slot:
// the batch that adds ghosts and cursors to it will have to CHAIN, not replace.

import type { Contexte } from "../app/contexte.ts";
import type { Ouverture } from "../partage/plan.ts";
import { v5OpeningById, v5Touch } from "../app/contexte.ts";
import { TYPEMAP, pieceVisible } from "../catalogue/catalogue.ts";
import { $, cssId } from "../noyau/dom.ts";
import { WALL, v5R2 } from "../noyau/nombres.ts";
import {
  v5CellsAt,
  v5OpeningBox,
  v5OpeningEdgeLimits,
  v5OpeningSameSlot,
  v5Seg,
  v5WallById,
  v5WallLen,
} from "../modele/murs.ts";
import { wallSnapReach } from "../modele/espace.ts";
import {
  v5FlushOpeningRefus,
  v5FlushOpeningThinned,
  v5MoveOpeningTo,
} from "../modele/edition.ts";
import { toast } from "../app/toast.ts";
import { pushHistory } from "../historique/pile.ts";
import { render } from "../rendu/rendu.ts";
import { focusEl } from "../rendu/calque.ts";
import { RSZ_BYKEY, RSZ_COMPACT_PX, RSZ_OUT_PX, resizeCursor } from "../rendu/meubles.ts";
import { screenToApt } from "../rendu/vue.ts";
import { selReplace, selToggle } from "../rendu/selection.ts";
import { addGuideSeg, clearGuides } from "./guides.ts";
import { armGesture, beginGesture, endGesture } from "./sortie.ts";
import { measureMode, sansGrille, spaceHeld, pointSuivi } from "./etat-pointeur.ts";

// =================================================================================================
//  THE CLEARANCE GUIDES ALONG THE WALL (js/53)
// =================================================================================================
// 1-D port of v4: an opening isn't measured in x/y, but ALONG its wall. From each
// edge, a segment goes to the first obstacle of the same family AND THE SAME FACE
// (`v5OpeningSameSlot`), or to the end of the wall.

export function v5DrawOpeningGuides(ctx: Contexte, op: Ouverture): void {
  clearGuides(ctx);
  const P = ctx.etat.plan;
  const w = v5WallById(P, op.wallId);
  if (!w) return;
  const s = v5Seg(w), halfW = op.w / 2, t = op.t0 + halfW;
  let nx = s.nx, ny = s.ny;
  const cell = v5CellsAt(P, w.a[0] + s.ux * t + nx * 8, w.a[1] + s.uy * t + ny * 8);
  if (!cell) { nx = -nx; ny = -ny; }
  const inOff = 14 / (ctx.vue.scale || 1);
  const cont = document.createElement("div");
  cont.className = "guides";
  for (const sgn of [-1, 1]) {
    const myEdge = t + sgn * halfW;
    let target = sgn < 0 ? 0 : s.L;
    (P.openings || []).forEach((q) => {
      if (q === op || String(q.wallId) !== String(op.wallId)) return;
      // Same arbiter as the anti-overlap snap: an object on the OTHER face does not bound the clearance
      // (an outlet in the bedroom does not obstruct a back-to-back outlet in the living room).
      if (!v5OpeningSameSlot(op, q) || !pieceVisible(q, ctx.etat.opts)) return;
      const qc = q.t0 + q.w / 2, qNear = qc - sgn * (q.w / 2);
      if (sgn < 0) { if (qNear <= myEdge && qNear > target) target = qNear; }
      else { if (qNear >= myEdge && qNear < target) target = qNear; }
    });
    const gap = Math.abs(target - myEdge);
    if (gap < 1 || gap > 400) continue;
    const p1 = { x: w.a[0] + s.ux * myEdge + nx * inOff, y: w.a[1] + s.uy * myEdge + ny * inOff };
    const p2 = { x: w.a[0] + s.ux * target + nx * inOff, y: w.a[1] + s.uy * target + ny * inOff };
    addGuideSeg(ctx, cont, p1, p2, Math.round(gap) + " cm");
  }
  if (cont.children.length) { const host = focusEl(ctx); if (host) host.appendChild(cont); }
}

// =================================================================================================
//  DRAGGING AN OPENING (js/53, TOOL 6)
// =================================================================================================
// Drag along the wall (`t0` alone); releasing near an ANOTHER wall (within snap reach) re-parameterizes
// the opening onto it. The target wall is searched among ALL walls, with no membership
// condition whatsoever: changing wall is just changing `wallId`/`t0`.

// THE ENTRY POINT IS NOT HERE. An opening box's `pointerdown` goes through
// `ctx.gestes.ouverturePointerDown` (`gestes/branchement.ts`), which arbitrates the stack first
// (`pickStacked`, G-10: two wall lights exactly overlapping exist on the real floor plan) and
// redirects to FURNITURE when the reached node is not an opening. This module only receives
// the already-resolved opening: a gesture doesn't go looking for its own node in the DOM.

export function v5StartOpeningDrag(ctx: Contexte, e: PointerEvent, op: Ouverture): void {
  if (measureMode() || spaceHeld()) return;
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  if (e.ctrlKey || e.metaKey) {
    selToggle(ctx, op.id); render(ctx);
    if (ctx.selection.primaire != null) ctx.crochets.openInspector?.();
    else ctx.crochets.hideInspector?.();
    return;
  }
  // THE TRAIN. An opening already in a multi-selection no longer DESTROYS it by being grabbed:
  // that was the root of the defect "moving several windows on the same wall scrambles them."
  // The unconditional `selReplace` used to reduce the selection to the single grabbed opening, so the others
  // wouldn't move, and then the same-family overlap rule would PUSH them as the one being
  // dragged passed by. So they did move, but pushed, not moved deliberately. Furniture already
  // had its guard (`groupDrag`, gestes/meuble.ts); openings never had it.
  const enGroupe = ctx.selection.ids.size > 1 && ctx.selection.ids.has(String(op.id));
  if (enGroupe) ctx.selection.primaire = String(op.id);
  else selReplace(ctx, op.id);
  render(ctx); ctx.crochets.openInspector?.();
  beginGesture();
  ctx.crochets.dragStart?.();
  // G-12: the pre-gesture state, depth included (it can follow a thinner wall).
  const op0 = { wallId: String(op.wallId), t0: op.t0, side: op.side, w: op.w, h: op.h };
  // Clean slate for the end-of-gesture messages. Both model-side `flush` calls RETURN the sentence
  // instead of displaying it (`modele/edition.ts` doesn't know about the screen): here we discard it, which is
  // exactly what the old call did, clearing out whatever lingered from a previous gesture.
  v5FlushOpeningRefus(); v5FlushOpeningThinned();
  let lastT: number | null = null;
  // G-3. A clean click on a window SELECTS it: no history entry for nothing (otherwise the
  // first Ctrl+Z after a simple pickup visibly does nothing).
  const px0 = e.clientX, py0 = e.clientY;
  let moved = false;
  // Pure APARTMENT space: the pointer is converted through `screenToApt` (single frame, cm).
  const vr = ctx.viewport.getBoundingClientRect();
  // THE PICKUP OFFSET, SAME ROOT CAUSE AS G-19. `v5MoveOpeningTo` RE-CENTERS the opening under the cursor
  // (`op.t0 = tc − op.w/2`): the dimension is derived from the pointer's ABSOLUTE position, no pickup
  // offset is remembered. Grabbing a wall light by its edge therefore makes it jump under the hand on the
  // very first movement, and above all the RETURN reproduces the CURSOR, not `t0`: the residual gap equals
  // the difference between the recorded whole-number `t0` and the grab pixel converted to cm, i.e.
  // a fraction of a centimeter on every contact. Measured in real usage: 57 exact round trips out of
  // 73, fourteen of the sixteen gaps under 0.6 cm. We remember the pickup/CENTER offset once, and we
  // subtract it every frame, along the CURRENT wall (a wall change doesn't change where
  // the hand grabbed the object).
  let prise = 0;
  {
    const wG = v5WallById(ctx.etat.plan, op.wallId);
    if (wG) {
      const sG = v5Seg(wG);
      const cmG = screenToApt(ctx, e.clientX - vr.left, e.clientY - vr.top);
      prise = (cmG.x - wG.a[0]) * sG.ux + (cmG.y - wG.a[1]) * sG.uy - (op.t0 + op.w / 2);
    }
  }
  // THE CARRIAGES: the other selected openings ON THE SAME WALL, with their starting `t0`.
  // Same wall only, and this is a DIRECTION constraint, not a simplification: "advance by
  // 40 cm" doesn't have the same direction on two different walls, so a train straddling two
  // walls has no geometric translation.
  const wagons: { o: Ouverture; t0: number }[] = [];
  if (enGroupe) {
    for (const id of ctx.selection.ids) {
      const q = v5OpeningById(ctx, id);
      if (!q || String(q.id) === String(op.id)) continue;
      if (String(q.wallId) !== String(op.wallId)) continue;
      wagons.push({ o: q, t0: q.t0 });
    }
  }
  const enTrain = wagons.length > 0;
  const tOp0 = op.t0;

  /**
   * The SHARED offset, bounded by the most constrained carriage. A TRAIN THAT HITS A WALL STOPS AS A WHOLE:
   * the gaps are preserved and the gesture becomes a no-op, rather than letting the first
   * window snap in place while the others keep going, which is exactly what used to scramble them.
   * This is the same rule as G-13 on the furniture side, applied to the group instead of the individual.
   */
  const borneDelta = (d: number): number => {
    const L = v5WallLen(ctx.etat.plan, op.wallId);
    if (!L) return 0;
    const membres = [{ o: op, t0: tOp0 }].concat(wagons);
    const selIds = new Set(membres.map((m) => String(m.o.id)));
    for (const m of membres) {
      d = Math.max(d, -m.t0);                    // lower bound of the WALL
      d = Math.min(d, L - m.o.w - m.t0);         // upper bound of the WALL
      for (const q of ctx.etat.plan.openings || []) {
        if (String(q.wallId) !== String(op.wallId)) continue;
        if (selIds.has(String(q.id))) continue;  // a carriage never bounds another carriage
        if (!v5OpeningSameSlot(m.o, q) || !pieceVisible(q, ctx.etat.opts)) continue;
        if (q.t0 + q.w <= m.t0 + 0.01) d = Math.max(d, (q.t0 + q.w) - m.t0);
        else if (q.t0 >= m.t0 + m.o.w - 0.01) d = Math.min(d, q.t0 - (m.t0 + m.o.w));
      }
    }
    return d;
  };

  const move = (ev: PointerEvent): void => {
    if (!moved) {
      if (Math.hypot(ev.clientX - px0, ev.clientY - py0) < 3) return;
      moved = true; pushHistory(ctx);
    }
    if (enTrain) {
      // AS A TRAIN: no wall change, no face flip, no snap. A train pushes along its
      // wall, and nothing else. The only degree of freedom is the offset,
      // and that is what guarantees the gaps are EXACTLY preserved.
      const wT = v5WallById(ctx.etat.plan, op.wallId);
      if (!wT) return;
      const sT = v5Seg(wT);
      const spT = pointSuivi(ev, ev.clientX, ev.clientY, px0, py0);
      const bT = screenToApt(ctx, spT.x - vr.left, spT.y - vr.top);
      const tc = (bT.x - wT.a[0]) * sT.ux + (bT.y - wT.a[1]) * sT.uy - prise;
      const d = borneDelta(v5R2(tc - op.w / 2) - tOp0);
      op.t0 = v5R2(tOp0 + d);
      for (const m of wagons) m.o.t0 = v5R2(m.t0 + d);
      v5Touch(ctx); render(ctx); v5DrawOpeningGuides(ctx, op); ctx.crochets.liveAnalyze?.();
      const champT = $("iWallPos") as HTMLInputElement | null;
      if (champT && document.activeElement !== champT) champT.value = String(Math.round(op.t0));
      ctx.crochets.emitDrag?.(op);
      for (const m of wagons) ctx.crochets.emitDrag?.(m.o);
      return;
    }
    const sp = pointSuivi(ev, ev.clientX, ev.clientY, px0, py0);
    const brut = screenToApt(ctx, sp.x - vr.left, sp.y - vr.top);
    const w0 = String(op.wallId);
    // direction of the movement along the CURRENT wall (for the anti-overlap snap)
    const wc = v5WallById(ctx.etat.plan, op.wallId);
    const sc = wc ? v5Seg(wc) : null;
    // The tracked point is the object's CENTER, not the cursor's tip: we subtract the pickup offset
    // along the wall (the normal component, which decides the face, is untouched).
    const cm = (sc && prise) ? { x: brut.x - prise * sc.ux, y: brut.y - prise * sc.uy } : brut;
    let dir = 0;
    if (wc && sc) {
      const tc = (cm.x - wc.a[0]) * sc.ux + (cm.y - wc.a[1]) * sc.uy;
      if (lastT != null) dir = Math.sign(tc - lastT);
      lastT = tc;
    }
    v5MoveOpeningTo(ctx.etat.plan, op, cm.x, cm.y, dir, wallSnapReach(ctx.vue.scale), ctx.etat.opts);
    if (String(op.wallId) !== w0) lastT = null;   // wall changed: the t coordinate restarts from zero
    v5Touch(ctx); render(ctx); v5DrawOpeningGuides(ctx, op); ctx.crochets.liveAnalyze?.();
    const champ = $("iWallPos") as HTMLInputElement | null;
    if (champ && String(op.id) === String(ctx.selection.primaire) && document.activeElement !== champ) {
      champ.value = String(Math.round(op.t0));
    }
    ctx.crochets.emitDrag?.(op);
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    clearGuides(ctx); ctx.crochets.syncInspector?.();
    // "this wall is too short": stated on screen, never again in silence. And "this wall is
    // thinner": the depth followed (G-16), that gets said too.
    const refus = v5FlushOpeningRefus(); if (refus) toast(refus, { geste: true });
    const aminci = v5FlushOpeningThinned(); if (aminci) toast(aminci, { geste: true });
    endGesture();
    ctx.crochets.dragEnd?.();
  };
  // G-12. Escape: the opening gets back its wall, position, face AND depth from before the
  // gesture. Clearing the thinning slate is done via `flush` (discarded): it's the only way
  // to write into the model's private state, and it's exactly what `v5LastThinned=null` did.
  const cancel = (): void => {
    op.wallId = op0.wallId; op.t0 = op0.t0; op.side = op0.side; op.w = op0.w; op.h = op0.h;
    for (const m of wagons) m.o.t0 = m.t0;   // G-12: the WHOLE train comes back, not just the head
    v5FlushOpeningThinned();
    v5Touch(ctx); render(ctx); clearGuides(ctx); ctx.crochets.syncInspector?.();
  };
  window.addEventListener("pointermove", move);
  armGesture(up, null, cancel);   // guaranteed end (G-1)
}

// =================================================================================================
//  RESIZING AN OPENING BY ITS HANDLE (js/56)
// =================================================================================================
// A piece of furniture resizes at its handles; an opening used to only change through the
// "Width" field of the card. Same need, same gesture: two handles at the TWO ENDS of
// the opening, which lengthen or shorten it ALONG ITS WALL.
//
// THREE ARBITRATION RULES, held here and nowhere else (G-19):
//
// 1. THE OTHER END DOES NOT MOVE. This is a resize by an EDGE: the grabbed edge follows the
//    pointer, the opposite edge is fixed at its wall coordinate at `pointerdown`. Keeping the object CENTERED
//    would move both edges at half the hand's speed: what's under the cursor
//    would no longer be what moves (this application's central rule), the distance to the neighbor
//    would show a number that matches no held edge, and "From the corner" (t0) would jump
//    while only the width is being touched. This is also what furniture handles already do
//    (`RSZ_HANDLES`, rendu/meubles.ts: each handle pins the OPPOSITE corner).
//
// 2. AN OPENING HAS NO FREE WIDTH. Three bounds, all computed at pickup:
//    the WALL (0 .. its length), the NEIGHBORS of the same family ON THE SAME FACE
//    (`v5OpeningSameSlot`, modele/murs.ts: the back-to-back rule is reused, never redone),
//    and the SERVER VALIDATOR (`OPENING_W_MIN=1` / `OPENING_W_MAX=600`, live-worker/ops.ts;
//    beyond that, the op is REFUSED and the modification is lost). The interface floor stays 5 cm,
//    like the card's field: nobody wants a 1 cm window.
//
// 3. WHEN IT HITS A WALL, IT SAYS SO. The live dimension follows the cursor throughout the gesture (the
//    same `#rszReadout` as furniture) and the clearance guides show the remaining space; on
//    release, a banner NAMES the bound reached (the neighbor, the end of the wall, the server bound,
//    the minimum width). Without that word, a handle that stops advancing is indistinguishable from a glitch.
//
// The DEPTH (the thickness within the wall) has no handle: it belongs to the wall, not to
// the opening (G-16). It stays in the card (`#iH`).

export const OP_RSZ_MIN = 5;               // cm, interface floor (the server accepts 1)
export const OP_RSZ_MAX = 600;             // cm, OPENING_W_MAX (live-worker/ops.ts): beyond that, op refused
/** The two handles, in WALL coordinates: "lo" = the edge on the t0 side (corner A), "hi" = the other. */
const OP_RSZ_ENDS = ["lo", "hi"] as const;
export type BordOuverture = (typeof OP_RSZ_ENDS)[number];

/**
 * THE HANDLES. They are CHILDREN of the opening's box (`.piece[data-op="1"]`, painted by
 * `rendu/calque.ts`): the wall's rotation carries them along with no extra computation. The box's
 * local frame is flipped when `side` is 1 (`v5OpeningBox` adds 180°): the "lo" edge is then on the
 * RIGHT. We never paint twice: nodes are reused, and removed as soon as the selection
 * changes.
 *
 * G-19, SMALL OPENINGS: an outlet is 10 cm, i.e. ~6 px at "Fit" zoom. Two
 * 9 px handles placed on its edges would cover the entire object and make it
 * unmovable. So we follow EXACTLY the furniture rule (G-20): below `RSZ_COMPACT_PX` of
 * length, the handles come out of the box by `RSZ_OUT_PX`. There is no middle handle to
 * remove, there are only ever two.
 */
export function v5DrawOpeningResize(ctx: Contexte): void {
  const layer = focusEl(ctx);
  if (!layer) return;
  const seul = (ctx.selection.ids.size === 1) ? v5OpeningById(ctx, ctx.selection.primaire) : null;
  layer.querySelectorAll<HTMLElement>('.piece[data-op="1"] .rsz-handle').forEach((h) => {
    const parent = h.parentNode as HTMLElement | null;
    if (!seul || !parent || parent.dataset["id"] !== String(seul.id)) h.remove();
  });
  if (!seul || measureMode()) return;
  const el = layer.querySelector<HTMLElement>(`.piece[data-op="1"][data-id="${cssId(seul.id)}"]`);
  if (!el) return;
  const w = v5WallById(ctx.etat.plan, seul.wallId);
  if (!w) return;
  const t = TYPEMAP[seul.type];
  const box = v5OpeningBox(ctx.etat.plan, seul, (t && t.h) || WALL);
  if (!box) return;
  // The threshold applies to LENGTH alone, not to `min(length, thickness)` as for a piece of
  // furniture: an opening is always thin (12 cm, i.e. ~8 px), so the min would declare it "compact"
  // even at 5 m wide and would offset its handles for nothing. What we're protecting here is the
  // grabbable MIDDLE between the two ends: length is what decides it.
  const S = ctx.vue.scale;
  const lenPx = seul.w * S, epPx = (box.h || WALL) * S;
  const off = (lenPx < RSZ_COMPACT_PX) ? RSZ_OUT_PX : 0;
  OP_RSZ_ENDS.forEach((end) => {
    let h = el.querySelector<HTMLElement>(`.rsz-handle[data-rsz="${end}"]`);
    if (!h) {
      h = document.createElement("span");
      h.className = "rsz-handle";
      h.dataset["rsz"] = end;
      h.title = "Drag to change the width; the other end stays put";
      const noeud = h;
      // The DOM node survives object replacements: we resolve the opening by its identifier at
      // click time, never the object captured at creation.
      noeud.addEventListener("pointerdown", (ev) => {
        const o = v5OpeningById(ctx, el.dataset["id"]);
        if (!o) return;
        v5StartOpeningResize(ctx, ev, o, noeud.dataset["rsz"] === "hi" ? "hi" : "lo");
      });
      el.appendChild(h);
    }
    // `side` flips the box: the "lo" edge moves to the right. `dir` = its LOCAL side (-1 left).
    const dir = ((end === "lo") !== !!seul.side) ? -1 : 1;
    h.style.left = (lenPx * (dir + 1) / 2 + dir * off) + "px";
    h.style.top = (epPx / 2) + "px";
    h.dataset["h"] = (dir < 0) ? "w" : "e";
    const modele = RSZ_BYKEY[(dir < 0) ? "w" : "e"];
    if (modele) h.style.cursor = resizeCursor(modele, box.rot || 0);
  });
}

// ---- THE GESTURE -----------------------------------------------------------------------------------
// A single undo step (`pushHistory` on the FIRST real movement, as everywhere else: a
// clean click on a handle must write nothing, G-3), exit via `armGesture` (so Escape, focus
// loss and the watchdog included, G-1), and network emission on release through the ordinary path
// (`endGesture` -> `save` -> the `opening.set` diff).

/** Bound reached during the current gesture, stated at the end. Private to the module (it was to
 *  the single closure before): the only way to read it is this getter, the only way to clear it is the flush. */
let _opRszBute: string | null = null;

export function v5OpRszBute(): string | null { return _opRszBute; }

export function v5FlushOpeningRszBute(): string | null {
  const b = _opRszBute;
  _opRszBute = null;
  if (b) toast(b, { geste: true });
  return b;
}

export function v5StartOpeningResize(
  ctx: Contexte,
  e: PointerEvent,
  op: Ouverture,
  end: BordOuverture,
): void {
  if (measureMode() || spaceHeld()) return;
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const w = v5WallById(ctx.etat.plan, op.wallId);
  if (!w) return;
  selReplace(ctx, op.id); render(ctx); ctx.crochets.openInspector?.();
  beginGesture();
  ctx.crochets.dragStart?.();
  const s = v5Seg(w);
  const lim = v5OpeningEdgeLimits(ctx.etat.plan, op, w, ctx.etat.opts);
  const t0_0 = op.t0, w0 = op.w;
  const fixe = (end === "lo") ? (op.t0 + op.w) : op.t0;      // the OPPOSITE edge, fixed for the whole gesture
  const vr = ctx.viewport.getBoundingClientRect();
  // G-19, THE PICKUP OFFSET IS REMEMBERED. The handle is painted OUTSIDE the box when the opening is
  // short on screen (`RSZ_OUT_PX`, G-20): the pointer at `pointerdown` is therefore NOT on the edge
  // it's holding. Computing the width from the pointer's ABSOLUTE position (`want = t - fixe`)
  // used to teleport the edge under the cursor on the first movement, i.e. 6 px / scale = 9.4 cm at the
  // opening zoom, rounded to 10 by the snap grid. Measured: a 70 cm window pulled by
  // 30 cm gave 110, and the handle put back AT THE EXACT PIXEL rendered 80, not 70 (3 exact round trips
  // out of 21). We remember the handle/edge offset once, and subtract it every frame:
  // "what is under the cursor is what moves" becomes true again down to the centimeter.
  const cmG = screenToApt(ctx, e.clientX - vr.left, e.clientY - vr.top);
  const tG = (cmG.x - w.a[0]) * s.ux + (cmG.y - w.a[1]) * s.uy;
  const prise = tG - ((end === "lo") ? op.t0 : (op.t0 + op.w));
  const readout = $("rszReadout");
  let moved = false;
  _opRszBute = null;
  const nomDe = (q: Ouverture | null): string => (q && q.name) ? q.name : "another object";
  const montre = (ev: PointerEvent): void => {
    if (!readout) return;
    readout.hidden = false;
    readout.style.left = (ev.clientX - vr.left) + "px";
    readout.style.top = (ev.clientY - vr.top) + "px";
    readout.innerHTML = '<span class="axon">' + Math.round(op.w) + '</span> cm';
  };
  const move = (ev: PointerEvent): void => {
    if (!moved) {
      if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return;
      moved = true; pushHistory(ctx);
    }
    const cm = screenToApt(ctx, ev.clientX - vr.left, ev.clientY - vr.top);
    // the pointer, in WALL coordinates, MINUS the pickup offset: this is the HELD EDGE, not the cursor.
    const t = (cm.x - w.a[0]) * s.ux + (cm.y - w.a[1]) * s.uy - prise;
    // width wanted by the hand, then the three bounds, each with its own message
    let want = (end === "lo") ? (fixe - t) : (t - fixe);
    let bute: string | null = null;
    if (want < OP_RSZ_MIN) {
      want = OP_RSZ_MIN;
      bute = `An opening cannot be narrower than ${OP_RSZ_MIN} cm.`;
    }
    if (want > OP_RSZ_MAX) {
      want = OP_RSZ_MAX;
      bute = `An opening cannot be wider than ${OP_RSZ_MAX} cm.`;
    }
    // 5 cm grid: we round the WIDTH (the fixed edge itself never moves by a hair). Ctrl/Cmd
    // (`sansGrille`) suppresses it, same key as furniture and walls.
    if (ctx.etat.opts.snap && !ev.altKey && !sansGrille(ev)) want = Math.max(OP_RSZ_MIN, Math.round(want / 5) * 5);
    if (end === "lo") {
      const min = Math.max(0, lim.loLim);
      if (fixe - want < min - 0.01) {
        want = fixe - min;
        bute = lim.loQui
          ? `“${op.name || "This opening"}” runs into “${nomDe(lim.loQui)}”: it cannot be extended on that side.`
          : `“${op.name || "This opening"}” touches the corner of the wall: it cannot be extended on that side.`;
      }
    } else {
      const max = Math.min(lim.L, lim.hiLim);
      if (fixe + want > max + 0.01) {
        want = max - fixe;
        bute = lim.hiQui
          ? `“${op.name || "This opening"}” runs into “${nomDe(lim.hiQui)}”: it cannot be extended on that side.`
          : `This wall is ${Math.round(lim.L)} cm: “${op.name || "this opening"}” cannot go any further.`;
      }
    }
    want = Math.max(OP_RSZ_MIN, Math.min(OP_RSZ_MAX, want));
    op.w = v5R2(want);
    op.t0 = v5R2((end === "lo") ? (fixe - op.w) : fixe);
    if (bute) _opRszBute = bute;
    v5Touch(ctx); render(ctx); v5DrawOpeningGuides(ctx, op); ctx.crochets.liveAnalyze?.();
    ctx.crochets.syncInspector?.(); montre(ev);
    ctx.crochets.emitDrag?.(op);
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    if (readout) readout.hidden = true;
    clearGuides(ctx);
    // G-3. A clean click on the handle SELECTS, it writes nothing (same rule as everywhere).
    if (!moved) {
      _opRszBute = null;
      render(ctx); ctx.crochets.syncInspector?.(); endGesture();
      ctx.crochets.dragEnd?.();
      return;
    }
    render(ctx); ctx.crochets.syncInspector?.(); ctx.crochets.openInspector?.();
    v5FlushOpeningRszBute();
    endGesture();
    ctx.crochets.dragEnd?.();
  };
  // G-12. Escape: the opening gets back EXACTLY the width and position from before the gesture.
  const cancel = (): void => {
    op.t0 = t0_0; op.w = w0; _opRszBute = null; moved = false;
    if (readout) readout.hidden = true;
    v5Touch(ctx); render(ctx); clearGuides(ctx); ctx.crochets.syncInspector?.();
  };
  window.addEventListener("pointermove", move);
  armGesture(up, null, cancel);
}
