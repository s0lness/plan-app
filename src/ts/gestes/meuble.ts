// src/ts/gestes/meuble.ts: DRAG, ROTATE, DRAG A GROUP.
// Ported from src/js/17-drag-meubles.js, verbatim in its arithmetic.
//
// THIS IS THE APPLICATION'S CENTRAL GESTURE, and six invariants live here. None of them is a
// logic error visible on a read-through: all were found by measurement, on the real floor plan.
//
//  G-3  SELECTING NEVER WRITES. `pushHistory()` is pushed on the FIRST MOVEMENT, not on
//       `pointerdown`.
//  G-4  PICKING UP A PIECE OF FURNITURE DOES NOT MOVE IT.
//  G-5  THE ROUND TRIP RETURNS TO THE STARTING POINT. The corner follows the hand to the whole
//       centimetre, rounded ONCE (rounding the center then re-deriving the corner would gain 1 cm
//       per cycle on an odd width), and every magnet is a pure function of that position, so the
//       same hand position always gives back the same placement.
//  G-12 ESCAPE PUTS THE OBJECT BACK EXACTLY IN PLACE: each variant supplies its own restoration to
//       `armGesture`.
//
// NOTHING PUSHES FURNITURE ANY MORE. A piece may straddle a wall: it is never repelled, never
// brought home, never bounded. What places it is a MAGNET (the wall, an aligned neighbour, a table
// for a chair), and Alt suspends every one of them for the length of one gesture.
//
// A SINGLE FRAME OF REFERENCE: the pointer is read in the viewport and converted to APARTMENT cm. No
// container bbox, no re-hosting: a piece of furniture has apartment coordinates, period.

import type { Contexte } from "../app/contexte.ts";
import type { Meuble, Ouverture } from "../partage/plan.ts";
import { pieceById, v5Touch, v5OpeningById } from "../app/contexte.ts";
import { TYPEMAP, isWallMount } from "../catalogue/catalogue.ts";
import { cssId } from "../noyau/dom.ts";
import { v5OpeningBox } from "../modele/murs.ts";
import { meubleSnapReach, meubleWallSnap, wallSnapReach } from "../modele/espace.ts";
import { v5MoveOpeningTo } from "../modele/edition.ts";
import { dockedChairs, snapChairToTable, TABLE_TYPES } from "./contraintes.ts";
import { alignSnap, angleVersPointeur, clearGuides, drawAlignLines, drawGuides } from "./guides.ts";
import { armGesture, endActiveGesture } from "./sortie.ts";
import { LONGPRESS_MS, TOUCH_DRAG_THRESH, isTouchEvt, measureMode, spaceHeld, touchPts } from "./etat-pointeur.ts";
import { pushHistory } from "../historique/pile.ts";
import { render } from "../rendu/rendu.ts";
import { focusEl } from "../rendu/calque.ts";
import { aptToScreen, screenToApt } from "../rendu/vue.ts";
import { selReplace, selToggle } from "../rendu/selection.ts";

interface Pose { q: Meuble; x: number; y: number; rot: number }

export function startPieceDrag(ctx: Contexte, e: PointerEvent, p0: Meuble, _resumed?: boolean): void {
  if (measureMode()) return;   // tape measure: the event bubbles up to the viewport
  if (e.button !== undefined && e.button !== 0) return;   // the right button pans
  if (spaceHeld()) return;                                // space + drag = pan
  e.stopPropagation();
  e.preventDefault();   // otherwise the browser starts a text selection on the label
  const p = p0;

  // SHIFT HELD AT PRESS = multi-selection toggle, decided right here (decision 0013: Ctrl means
  // nothing in this app any more, and Shift already reads "add to the selection" on the lasso).
  if (e.shiftKey) {
    selToggle(ctx, p.id);
    render(ctx);
    if (ctx.selection.primaire != null) ctx.crochets.openInspector?.();
    else ctx.crochets.hideInspector?.();
    return;
  }

  // FINGER LONG-PRESS = multi-selection toggle (equivalent of Ctrl+click). A fast movement
  // cancels the timer and continues as a normal drag; the long press only fires if the finger stays
  // in place. When a multi-selection is already active, a simple press drags the group.
  //
  // G-1. THIS DISAMBIGUATION WINDOW IS ITSELF A GESTURE, so it arms through `armGesture(finish, onUp)`
  // (`gestes/sortie.ts`) exactly like the drag it may turn into, instead of hand-rolling its own
  // `pointermove`/`pointerup`. Before this fix it listened for neither `pointercancel` nor window
  // `blur`: an interrupted touch (a second finger landing, a system gesture, the tab losing focus)
  // left the 450 ms timer running untouched, so the long-press selection still fired later even
  // though the touch that was supposed to hold it had already gone away. `armGesture`'s shared exit
  // now ends this window (and clears the timer, in `finish`) on the SAME signals every other gesture
  // already respects.
  if (isTouchEvt(e) && !_resumed) {
    const sx = e.clientX, sy = e.clientY, pid = p.id;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (): void => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", lpMove, true);
    };
    const lpMove = (ev: PointerEvent): void => {
      if (touchPts.size >= 2) { endActiveGesture(); return; }
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) >= TOUCH_DRAG_THRESH) {
        endActiveGesture();
        startPieceDrag(ctx, e, p, true);   // movement won the race: real drag
      }
    };
    // Fires only on a REAL release (`pointerup`/`lostpointercapture`), never on a `pointercancel`
    // or a focus loss: those end the gesture through `finish` alone, with no selection change,
    // exactly what a touch that never completed should produce.
    const onUp = (): void => {
      // brief press (neither a long press nor movement): simple selection, no drag, no history.
      const groupTap = ctx.selection.ids.size > 1 && ctx.selection.ids.has(String(pid));
      if (groupTap) ctx.selection.primaire = String(pid); else selReplace(ctx, pid);
      render(ctx); ctx.crochets.openInspector?.();
    };
    armGesture(finish, onUp, null);
    window.addEventListener("pointermove", lpMove, true);
    timer = setTimeout(() => {
      selToggle(ctx, pid); render(ctx);
      if (ctx.selection.primaire != null) ctx.crochets.openInspector?.();
      else ctx.crochets.hideInspector?.();
      endActiveGesture();   // the timer fired: ends this window WITHOUT the tap's own `onUp`
    }, LONGPRESS_MS);
    return;
  }

  // Simple click: if this piece of furniture is part of a multi-selection, we KEEP the selection and
  // start a GROUP drag.
  const groupDrag = ctx.selection.ids.size > 1 && ctx.selection.ids.has(String(p.id));
  if (groupDrag) ctx.selection.primaire = String(p.id);   // the clicked piece becomes primary
  else selReplace(ctx, p.id);
  render(ctx); ctx.crochets.openInspector?.();
  if (p.locked) return;   // a locked piece of furniture gets selected, it never drags
  // A wall-mounted object is an OPENING, dragged by `v5StartOpeningDrag`. An ORPHANED wall-mounted
  // object from an old plan (no supporting wall found on read) has no wall to follow: it
  // selects but does not drag.
  if (isWallMount(p.type)) return;

  // G-3. A clean click SELECTS: the history entry is only pushed on the first real
  // movement. Otherwise, picking up a piece of furniture then letting go left a Ctrl+Z that visibly
  // undid nothing.
  let histPoussee = false;
  const pousseHist = (): void => { if (!histPoussee) { histPoussee = true; pushHistory(ctx); } };
  ctx.crochets.dragStart?.();   // suspends the diff-emitter for the duration of the gesture

  const group = groupDrag;
  // G-12. Snapshot of the placements BEFORE the gesture: this is what Escape restores.
  const poses = (list: Meuble[]): Pose[] => list.map((q) => ({ q, x: q.x, y: q.y, rot: q.rot || 0 }));
  const restorePoses = (snap: Pose[]): void => {
    snap.forEach((m) => { m.q.x = m.x; m.q.y = m.y; m.q.rot = m.rot; });
  };

  const cible = e.target as HTMLElement | null;
  const cont = focusEl(ctx);
  const r = ctx.viewport.getBoundingClientRect();
  const toApt = (cx: number, cy: number): { x: number; y: number } => screenToApt(ctx, cx - r.left, cy - r.top);
  // INSIDE THE PIECE'S OWN BODY, THE PIECE WINS. `e.target` is real DOM hit-testing: it knows
  // nothing about the piece's APARTMENT box, only about screen pixels. The rotation handle floats
  // ~24 screen px above the piece's CENTER, in FIXED pixels, so on a THIN piece at a zoomed-out
  // scale (measured: an 88×13 cm radiator at scale ~0.517, half-extent ~3.4 px on the short axis)
  // the handle's invisible reach covers the piece's own center: a click aimed dead-center on the
  // piece would land on `.rot-handle` and start a no-op rotation instead of a drag. The handle
  // stays grabbable only where it truly sticks out beyond the piece: rotate the click point into
  // the piece's own (unrotated) local frame and let the handle win only outside that box.
  const clicApt = toApt(e.clientX, e.clientY);
  const pcx0 = p.x + p.w / 2, pcy0 = p.y + p.h / 2;
  const radP = (p.rot || 0) * Math.PI / 180;
  const ddx = clicApt.x - pcx0, ddy = clicApt.y - pcy0;
  const locX = ddx * Math.cos(radP) + ddy * Math.sin(radP);
  const locY = -ddx * Math.sin(radP) + ddy * Math.cos(radP);
  const dansLeCorps = Math.abs(locX) <= p.w / 2 && Math.abs(locY) <= p.h / 2;
  const isRot = !!(cible && cible.dataset && cible.dataset["rot"]) && !dansLeCorps;
  const noeud = cont && cont.querySelector<HTMLElement>(`.piece[data-id="${cssId(p.id)}"]`);
  try { noeud?.setPointerCapture(e.pointerId); } catch (_) { /* the gesture holds up without capture */ }
  // Chairs docked under this table at the start of the gesture follow it.
  const riders: Meuble[] = TABLE_TYPES.has(p.type) ? dockedChairs(ctx.etat.plan, p, 3) : [];

  if (isRot) {
    const tcx = p.x + p.w / 2, tcy = p.y + p.h / 2;   // table center = chairs' pivot
    const cs = aptToScreen(ctx, tcx, tcy);
    const cx = r.left + cs.x, cy = r.top + cs.y;
    let lastRot = p.rot || 0;
    const move = (ev: PointerEvent): void => {
      pousseHist();
      // G-13 (decision 0013): the pure geometry lives in `gestes/guides.ts`, so it is provable
      // without a browser (`tests/rapide.ts`). Shift still quantizes to 15° steps.
      const a = angleVersPointeur(cx, cy, ev.clientX, ev.clientY, ev.shiftKey);
      const dRot = a - lastRot;
      if (dRot && riders.length) {
        const rad = dRot * Math.PI / 180, cr = Math.cos(rad), sr = Math.sin(rad);
        riders.forEach((ch) => {
          const cchx = ch.x + ch.w / 2, cchy = ch.y + ch.h / 2;
          const rx = cchx - tcx, ry = cchy - tcy;
          const nx = tcx + rx * cr - ry * sr, ny = tcy + rx * sr + ry * cr;
          ch.x = Math.round(nx - ch.w / 2); ch.y = Math.round(ny - ch.h / 2);
          ch.rot = ((Math.round((ch.rot || 0) + dRot) % 360) + 360) % 360;
        });
      }
      lastRot = a;
      p.rot = a; v5Touch(ctx); render(ctx); ctx.crochets.syncInspector?.(); ctx.crochets.liveAnalyze?.();
      ctx.crochets.emitDrag?.(p);
    };
    const before = poses([p].concat(riders));
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      ctx.crochets.dragEnd?.();
    };
    const cancelRot = (): void => {
      restorePoses(before); v5Touch(ctx); render(ctx); ctx.crochets.syncInspector?.();
    };
    window.addEventListener("pointermove", move);
    armGesture(up, null, cancelRot);   // guaranteed end (G-1)
    return;
  }

  const g0 = toApt(e.clientX, e.clientY);
  const grabX = g0.x - p.x, grabY = g0.y - p.y;

  // ---- GROUP DRAG: more than one piece of furniture selected, single drag. All move by the SAME
  // delta, so the selection keeps its shape. The wall magnet is read on the PRIMARY and its
  // correction is carried by everyone (a magnet applied member by member would deform the group);
  // alignment guides and the chair-table snap stay off during a group move.
  if (group) {
    const p0x = p.x, p0y = p.y;
    const members: { pc: Meuble; x0: number; y0: number }[] = [];
    // OPENINGS JOIN THE GROUP TOO.
    // `pieceById` only knows about FURNITURE, and `isWallMount` used to filter out anything living on a
    // wall: an outlet, a wall light or a window selected along with a piece of furniture would not move,
    // and only the grabbed object would follow the hand. They have no `x/y` to translate, they are
    // parameterized by (wall, offset), but they have a CENTER, and the same move is
    // applicable to them by going through the simple-drag path, which knows how to reattach them to the
    // nearest wall. So they keep their wall when the wall follows, and change wall when needed.
    const ouverts: { op: Ouverture; c0x: number; c0y: number }[] = [];
    for (const id of ctx.selection.ids) {
      const o = v5OpeningById(ctx, id);
      if (!o) continue;
      const t = TYPEMAP[o.type];
      const box = v5OpeningBox(ctx.etat.plan, o, (t && t.h) || 12);
      if (box) ouverts.push({ op: o, c0x: box.cx, c0y: box.cy });
    }
    for (const id of ctx.selection.ids) {
      const pc = pieceById(ctx, id); if (!pc || pc.locked || isWallMount(pc.type)) continue;
      members.push({ pc, x0: pc.x, y0: pc.y });
    }
    const primaire = members.find((m) => m.pc === p) || null;
    const move = (ev: PointerEvent): void => {
      pousseHist();
      const cm = toApt(ev.clientX, ev.clientY);
      // G-5. WE ROUND THE CORNER, ONLY ONCE, and the whole group then rides on that one integer
      // delta: at zero delta it returns exactly to the origin, member by member.
      const px = Math.round(cm.x - grabX), py = Math.round(cm.y - grabY);
      let dax = px - p0x, day = py - p0y;
      // THE MAGNET IS READ ONCE, ON THE PIECE UNDER THE HAND, and moves the whole selection with
      // it. TRANSLATION ONLY: turning the primary to face the wall would leave the rest of the
      // group behind, which is the deformation this branch exists to prevent.
      if (primaire) {
        const aim = meubleWallSnap(
          ctx.etat.plan,
          { x: primaire.x0 + dax, y: primaire.y0 + day, w: p.w, h: p.h },
          meubleSnapReach(ctx.vue.scale), ev.altKey,
        );
        if (aim) { dax = aim.x - primaire.x0; day = aim.y - primaire.y0; }
      }
      members.forEach((m) => { m.pc.x = m.x0 + dax; m.pc.y = m.y0 + day; });
      // The SAME move, for openings, through the simple-drag path: `dir = 0`
      // (no privileged direction for the anti-overlap snap, there is no "last
      // movement" specific to each one in a group gesture).
      ouverts.forEach((o) => {
        v5MoveOpeningTo(ctx.etat.plan, o.op, o.c0x + dax, o.c0y + day, 0,
                        wallSnapReach(ctx.vue.scale), ctx.etat.opts);
      });
      v5Touch(ctx); render(ctx); ctx.crochets.liveAnalyze?.();
      ctx.crochets.emitDragMulti?.(members.map((m) => ({ pc: m.pc })));
      ouverts.forEach((o) => ctx.crochets.emitDrag?.(o.op));
    };
    const beforeGrp = poses(members.map((m) => m.pc));
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      v5Touch(ctx); render(ctx); clearGuides(ctx); ctx.crochets.syncInspector?.();
      ctx.crochets.dragEnd?.();
    };
    const avantOuv = ouverts.map((o) => ({ o, wallId: String(o.op.wallId), t0: o.op.t0, side: o.op.side }));
    const cancelGrp = (): void => {
      for (const v of avantOuv) { v.o.op.wallId = v.wallId; v.o.op.t0 = v.t0; v.o.op.side = v.side; }
      restorePoses(beforeGrp); v5Touch(ctx); render(ctx); clearGuides(ctx); ctx.crochets.syncInspector?.();
    };
    window.addEventListener("pointermove", move);
    armGesture(up, null, cancelGrp);
    return;
  }

  let lastX = p.x, lastY = p.y;   // delta applied, so the chairs can follow
  const riderIds = new Set<string>([String(p.id), ...riders.map((c) => String(c.id))]);

  const move = (ev: PointerEvent): void => {
    pousseHist();
    const cm = toApt(ev.clientX, ev.clientY);
    // G-5. WE ROUND THE CORNER, ONLY ONCE. We used to round the CENTER then re-derive the
    // corner from it, so a second rounding: on an ODD width (a 45 cm chair) the center falls
    // on a half-centimeter and `Math.round` always rounds UP, so every
    // round trip gained 1 cm, without end. The corner is the recorded quantity: it is what we
    // round, and only once. Nothing rounds it a second time: no grid, no bounds.
    p.x = Math.round(cm.x - grabX); p.y = Math.round(cm.y - grabY);
    // ALT SUSPENDS EVERY MAGNET for the length of the gesture, and it is the only modifier that
    // does: the piece then goes exactly where the hand puts it, to the centimetre.
    const libre = !!ev.altKey;
    const snapped = libre ? null : snapChairToTable(ctx.etat.plan, ctx.etat.opts, p);
    // THE WALL MAGNET, for every piece of furniture: whenever a wall comes within reach OF ITS
    // BACK (same reach as an opening, `wallSnapReach`) the piece snaps to it, back flush against
    // the face, oriented with the wall. Out of reach it is left exactly where the hand put it.
    const aimante = snapped
      ? null : meubleWallSnap(ctx.etat.plan, p, meubleSnapReach(ctx.vue.scale), libre);
    if (aimante) { p.x = aimante.x; p.y = aimante.y; p.rot = aimante.rot; }
    const al = (libre || snapped || aimante) ? null : alignSnap(ctx.etat.plan, ctx.etat.opts, p, riderIds);
    const dx = p.x - lastX, dy = p.y - lastY;
    if ((dx || dy) && riders.length) riders.forEach((ch) => { ch.x += dx; ch.y += dy; });
    lastX = p.x; lastY = p.y;
    v5Touch(ctx); render(ctx); drawGuides(ctx, p, snapped); drawAlignLines(ctx, al);
    ctx.crochets.liveAnalyze?.();
    ctx.crochets.emitDrag?.(p);
  };

  const before = poses([p].concat(riders));
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    v5Touch(ctx); render(ctx); clearGuides(ctx); ctx.crochets.syncInspector?.(); ctx.crochets.openInspector?.();
    ctx.crochets.dragEnd?.();
  };
  const cancelDrag = (): void => {
    restorePoses(before); v5Touch(ctx); render(ctx); clearGuides(ctx); ctx.crochets.syncInspector?.();
  };
  window.addEventListener("pointermove", move);
  armGesture(up, null, cancelDrag);
}
