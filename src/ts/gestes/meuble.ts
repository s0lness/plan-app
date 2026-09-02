// src/ts/gestes/meuble.ts: DRAG, ROTATE, DRAG A GROUP.
// Ported from src/js/17-drag-meubles.js, verbatim in its arithmetic.
//
// THIS IS THE APPLICATION'S CENTRAL GESTURE, and six invariants live here. None of them is a
// logic error visible on a read-through: all were found by measurement, on the real floor plan.
//
//  G-3  SELECTING NEVER WRITES. `pushHistory()` is pushed on the FIRST MOVEMENT, not on
//       `pointerdown` (exception: Alt+drag, whose duplicate is born on pointerdown).
//  G-4  PICKING UP A PIECE OF FURNITURE DOES NOT MOVE IT. Bounds used to fall on EVERY release, even
//       when still: a simple click would move "Bathtub 2" by 11 cm.
//  G-5  THE ROUND TRIP RETURNS TO THE STARTING POINT. Three causes, all here: the grid counts
//       STEPS FROM THE START OF THE GESTURE (never the absolute position); we round THE CORNER only
//       once (rounding the center then re-deriving the corner would gain 1 cm per cycle on an
//       odd width); and priority to the placement from the SECOND-TO-LAST drag (`_avantDernier`).
//       Measured: 537 exact round trips out of 549, versus 468.
//  G-7  WHAT ALREADY OVERFLOWED KEEPS ITS OVERFLOW, and pushing beyond that is FLATLY REFUSED, never
//       projected (a projection slides along the outline wall, so the round trip no longer returns).
//  G-12 ESCAPE PUTS THE OBJECT BACK EXACTLY IN PLACE: each variant supplies its own restoration to
//       `armGesture`, and `canceled` stops the gesture's end from re-bounding what was just restored.
//  G-13 A GESTURE THAT PRODUCES NOTHING SAYS WHY, and its counterpart "dropped here, put back there."
//
// A SINGLE FRAME OF REFERENCE: the pointer is read in the viewport and converted to APARTMENT cm. No
// container bbox, no re-hosting: a piece of furniture has apartment coordinates, period.

import type { Contexte } from "../app/contexte.ts";
import type { Meuble, Ouverture } from "../partage/plan.ts";
import { pieceById, v5Touch, v5OpeningById } from "../app/contexte.ts";
import { TYPEMAP, isWallMount } from "../catalogue/catalogue.ts";
import { cssId } from "../noyau/dom.ts";
import { nearestOnPoly, pointInPoly } from "../geometrie/polygones.ts";
import { v5CellsAt, v5OpeningBox } from "../modele/murs.ts";
import { clampCenterToApt, radiatorWallSnap, wallSnapReach } from "../modele/espace.ts";
import { autoName } from "../modele/creation.ts";
import { prochainUid } from "../modele/lecture-v4.ts";
import { v5ClampPiece, v5LastFit, v5MoveOpeningTo } from "../modele/edition.ts";
import { deltaScaleMax, dockedChairs, pieceTol, snapChairToTable, TABLE_TYPES } from "./contraintes.ts";
import { alignSnap, clearGuides, drawAlignLines, drawGuides } from "./guides.ts";
import { armGesture, endActiveGesture } from "./sortie.ts";
import { LONGPRESS_MS, TOUCH_DRAG_THRESH, isTouchEvt, measureMode, pasGrille, sansGrille, spaceHeld, touchPts, pointSuivi } from "./etat-pointeur.ts";
import { pushHistory } from "../historique/pile.ts";
import { toast } from "../app/toast.ts";
import { render } from "../rendu/rendu.ts";
import { focusEl } from "../rendu/calque.ts";
import { aptToScreen, screenToApt } from "../rendu/vue.ts";
import { selReplace, selRecomputePrimary, selToggle } from "../rendu/selection.ts";

/**
 * G-5, the fourth cause. Placement each piece of furniture had BEFORE its last drag (session
 * memory, nothing persisted): this is what a long round trip prioritizes returning to.
 */
const RETOUR_TOL = 6, RETOUR_MIN = 50;
interface AvantDernier { x: number; y: number; rot: number; cx: number; cy: number; saut: number }
const _avantDernier = new Map<string, AvantDernier>();
/** Test probe: session memory does not survive a plan change. */
export function oublierAvantDernier(): void { _avantDernier.clear(); }

interface Pose { q: Meuble; x: number; y: number; rot: number }

export function startPieceDrag(ctx: Contexte, e: PointerEvent, p0: Meuble, _resumed?: boolean): void {
  if (measureMode()) return;   // tape measure: the event bubbles up to the viewport
  if (e.button !== undefined && e.button !== 0) return;   // the right button pans
  if (spaceHeld()) return;                                // space + drag = pan
  e.stopPropagation();
  e.preventDefault();   // otherwise the browser starts a text selection on the label
  let p = p0;

  // Ctrl/Cmd held AT PRESS. The decision is DEFERRED to the release, the same pattern as
  // "PRESS TAKES WHAT IS SELECTED, A COMPLETED CLICK MOVES DOWN ONE STEP" (AGENTS.md): a press
  // alone commits to nothing. A completed click (no movement) TOGGLES this piece in the
  // selection, exactly as before; a real drag moves it, grid suppressed (`sansGrille`, which
  // already reads the modifier off each MOVE event, not off this one). Holding Ctrl/Cmd used to
  // start no drag at all, so the only way to reach the fine-grained grid was to grab the
  // modifier after the drag was already under way; this is what let a user who did the natural
  // thing (hold Cmd, THEN drag) get nothing but a selection toggle.
  const ctrlDown = !!(e.ctrlKey || e.metaKey);

  // A piece that cannot be dragged anyway (locked, or an orphaned wall-mounted object with no
  // wall to follow, see the `isWallMount` check below) has nothing to defer: toggle immediately,
  // exactly as before, since no release-time drag/click distinction will ever arise for it.
  if (ctrlDown && (p.locked || isWallMount(p.type))) {
    selToggle(ctx, p.id);
    render(ctx);
    if (ctx.selection.primaire != null) ctx.crochets.openInspector?.();
    else ctx.crochets.hideInspector?.();
    return;
  }
  // Selection BEFORE this gesture touches anything: what a motionless release restores before
  // toggling. A real drag keeps the ORDINARY selection change made just below (selReplace, or
  // the clicked piece becoming primary within its group); only a click without movement rolls it
  // back to toggle instead.
  const preSelIds = ctrlDown ? new Set(ctx.selection.ids) : null;

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
  // undid nothing. Alt+drag is the exception: the duplicate is born right at pointerdown, so
  // the snapshot must be taken BEFORE.
  let histPoussee = false;
  const pousseHist = (): void => { if (!histPoussee) { histPoussee = true; pushHistory(ctx); } };
  // Ctrl/Cmd held from the press already claims the release (toggle-vs-drag, above): the
  // duplicate-on-press exception for Alt does not combine with it, exactly as when Ctrl/Cmd used
  // to intercept the click before Alt was ever considered.
  const altEff = e.altKey && !ctrlDown;
  if (altEff) pousseHist();
  ctx.crochets.dragStart?.();   // suspends the diff-emitter for the duration of the gesture

  let altCopy = false;
  const group = groupDrag && !altEff;
  const origId = p.id;
  // G-12. Snapshot of the placements BEFORE the gesture: this is what Escape restores. `canceled`
  // stops the gesture's end from re-bounding what was just restored: a piece of furniture that
  // already overflowed must end up EXACTLY where it was, not "corrected."
  let canceled = false;
  const poses = (list: Meuble[]): Pose[] => list.map((q) => ({ q, x: q.x, y: q.y, rot: q.rot || 0 }));
  const restorePoses = (snap: Pose[]): void => {
    canceled = true;
    snap.forEach((m) => { m.q.x = m.x; m.q.y = m.y; m.q.rot = m.rot; });
  };
  if (altEff) {
    const n: Meuble = { ...p, id: String(prochainUid()), locked: false, name: autoName(ctx.etat.plan, p.name) };
    ctx.etat.plan.pieces.push(n);
    p = n; selReplace(ctx, n.id); altCopy = true;
    render(ctx); ctx.crochets.openInspector?.();
  }
  // Canceling an Alt+drag must also remove the duplicate created at pointerdown.
  const undoAltCopy = (): void => {
    if (!altCopy) return;
    const k = ctx.etat.plan.pieces.indexOf(p); if (k >= 0) ctx.etat.plan.pieces.splice(k, 1);
    altCopy = false; selReplace(ctx, origId);
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
  // Ctrl/Cmd held from the press never targets the rotation handle: it always meant "candidate
  // for a selection toggle" before this feature, never rotate, and the release-time toggle
  // fallback below is only wired for the solo/group DRAG branches, not for rotation.
  const isRot = !ctrlDown && !!(cible && cible.dataset && cible.dataset["rot"]) && !dansLeCorps;
  const noeud = cont && cont.querySelector<HTMLElement>(`.piece[data-id="${cssId(p.id)}"]`);
  try { noeud?.setPointerCapture(e.pointerId); } catch (_) { /* the gesture holds up without capture */ }
  // Chairs docked under this table at the start of the gesture follow it. A fresh Alt duplicate
  // overlaps the original: it must NOT steal its chairs.
  const riders: Meuble[] = (!altCopy && TABLE_TYPES.has(p.type)) ? dockedChairs(ctx.etat.plan, p, 3) : [];

  if (isRot) {
    const tcx = p.x + p.w / 2, tcy = p.y + p.h / 2;   // table center = chairs' pivot
    const cs = aptToScreen(ctx, tcx, tcy);
    const cx = r.left + cs.x, cy = r.top + cs.y;
    let lastRot = p.rot || 0;
    const move = (ev: PointerEvent): void => {
      pousseHist();
      let a = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI + 90;
      a = (a + 360) % 360;
      if (ctx.etat.opts.snap || ev.shiftKey) a = Math.round(a / 15) * 15 % 360;
      a = Math.round(a);
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
      restorePoses(before); undoAltCopy(); v5Touch(ctx); render(ctx); ctx.crochets.syncInspector?.();
    };
    window.addEventListener("pointermove", move);
    armGesture(up, null, cancelRot);   // guaranteed end (G-1)
    return;
  }

  const g0 = toApt(e.clientX, e.clientY);
  const grabX = g0.x - p.x, grabY = g0.y - p.y;

  // ---- GROUP DRAG: more than one piece of furniture selected, single drag. All move by the SAME
  // delta. The snap is applied once to the primary; guides, alignment and the chair-table
  // snap are cut during a group move.
  if (group) {
    const p0x = p.x, p0y = p.y;
    // THE GROUP BRANCH HAD LOST THE THREE GUARDS OF THE SOLO BRANCH, and that is the only reason
    // a group doesn't come back. The arithmetic itself is correct: each member is
    // recomputed from its remembered `x0/y0` plus a SHARED delta, and the snap is relative to the
    // primary, so at zero delta it returns exactly the origin. Measured on the bench on the real
    // floor plan, 24 lassos, 94 members: 43 exact round trips, drift of up to 132 cm, and **42 of the 51
    // derived members had been BOUNDED ON THE WAY OUT**, i.e. pushed out of the shared delta
    // by the end-of-gesture `v5ClampPiece`. That bounding is never undone: the return only knows
    // how to reapply −delta from the already-bounded placement, so the drift freezes in on the first cycle.
    // The solo branch survives the same bounding thanks to G-5 point 4 (`_avantDernier`); the group
    // branch used to exit BEFORE this block, with no memory and no restoration.
    const horsPolyG = (ctx.etat.plan && ctx.etat.plan.outline) || null;
    const members: {
      pc: Meuble; x0: number; y0: number; rot0: number; c0x: number; c0y: number;
      pen0: number; hors0: number; orphelin0: boolean; rawX: number; rawY: number;
    }[] = [];
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
      const cx0 = pc.x + pc.w / 2, cy0 = pc.y + pc.h / 2;
      members.push({
        pc, x0: pc.x, y0: pc.y, rot0: pc.rot || 0, c0x: cx0, c0y: cy0,
        pen0: pieceTol(ctx.etat.plan, pc),
        // G-7. Overflow ALREADY acquired outside the outline, PER MEMBER: without it, `clampCenterToApt`
        // projects onto the outline even at zero delta, so the return doesn't restore the starting placement.
        hors0: (horsPolyG && horsPolyG.length >= 3 && !pointInPoly(cx0, cy0, horsPolyG))
          ? nearestOnPoly(cx0, cy0, horsPolyG).dist : 0,
        // G-7. A piece of furniture already out of its cell (straddling a wall, the normal case for a
        // converted plan) does not get pulled back toward the neighboring cell's pole.
        orphelin0: !v5CellsAt(ctx.etat.plan, cx0, cy0),
        rawX: cx0, rawY: cy0,
      });
    }
    let movedG = false;             // G-4: a simple click on a group bounds nothing
    // G-14. The shared delta actually requested this tick: what `deltaScaleMax` shrinks at
    // release, so the whole group moves by the SAME reduced amount instead of each member being
    // clamped to ITS OWN nearest spot (see contraintes.ts).
    let lastDax = 0, lastDay = 0;
    const move = (ev: PointerEvent): void => {
      pousseHist();
      movedG = true;
      const cm = toApt(ev.clientX, ev.clientY);
      let px = cm.x - grabX, py = cm.y - grabY;
      // G-5. RELATIVE snap: the 5 cm grid counts STEPS from the starting position, it
      // does not rewrite the absolute position. Ctrl/Cmd (`sansGrille`) suppresses the grid: the
      // step becomes 1 cm instead of 5, still counted from the SAME starting position, so the
      // round-trip property (G-5) survives unchanged.
      const snapOn = !!ctx.etat.opts.snap, noGrid = sansGrille(ev);
      px = pasGrille(p0x, px, snapOn, noGrid); py = pasGrille(p0y, py, snapOn, noGrid);
      const dax = px - p0x, day = py - p0y;
      lastDax = dax; lastDay = day;
      members.forEach((m) => {
        let cx = m.x0 + dax + m.pc.w / 2, cy = m.y0 + day + m.pc.h / 2;
        m.rawX = cx; m.rawY = cy;                    // the WANTED center, before any bounding
        const cl = clampCenterToApt(ctx.etat.plan, cx, cy, m.hors0); cx = cl.x; cy = cl.y;
        m.pc.x = Math.round(cx - m.pc.w / 2); m.pc.y = Math.round(cy - m.pc.h / 2);
      });
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
      // Ctrl/Cmd held from the press, and the release never moved: roll back to the selection
      // BEFORE this gesture and TOGGLE this piece instead, same as the solo branch above.
      if (ctrlDown && !movedG) {
        ctx.selection.ids.clear();
        preSelIds!.forEach((id) => ctx.selection.ids.add(id));
        selRecomputePrimary(ctx);
        selToggle(ctx, p.id);
        render(ctx);
        if (ctx.selection.primaire != null) ctx.crochets.openInspector?.();
        else ctx.crochets.hideInspector?.();
        ctx.crochets.dragEnd?.();
        return;
      }
      // G-4. Bounding falls ONLY if the gesture really moved: without this guard, a simple click
      // on a group would bound its 5 to 11 members all at once.
      if (!canceled && movedG) {
        // G-14. A GROUP MOVES AS ONE. `deltaScaleMax` finds the LARGEST fraction of the requested
        // delta that EVERY member accepts, and that ONE fraction is applied to the whole group:
        // no member is clamped to ITS OWN nearest spot, which is what deformed the selection
        // (measured: 6 of 10 objects failed the round trip, drift up to 24 cm). Openings are
        // untouched here (they already moved, above, through their own wall-slide path).
        const t = deltaScaleMax(ctx.etat.plan, members.map((m) => ({
          cx0: m.c0x, cy0: m.c0y, w: m.pc.w, h: m.pc.h, rot: m.pc.rot || 0, tol: m.pen0, orphelin: m.orphelin0,
        })), lastDax, lastDay);
        members.forEach((m) => {
          const cx = m.c0x + t * lastDax, cy = m.c0y + t * lastDay;
          m.pc.x = Math.round(cx - m.pc.w / 2); m.pc.y = Math.round(cy - m.pc.h / 2);
          // G-5, the fourth cause, EXTENDED TO THE GROUP. We compare the WANTED position (before
          // bounding) to the one from BEFORE the previous drag: a long gesture that puts the member back
          // within RETOUR_TOL of there restores it EXACTLY there. This is what undoes the bounding of
          // the outbound trip, and it is the only thing that makes a group's round trip idempotent.
          const orig = _avantDernier.get(String(m.pc.id));
          if (orig && orig.saut > RETOUR_TOL * 2 && Math.hypot(m.rawX - orig.cx, m.rawY - orig.cy) <= RETOUR_TOL) {
            m.pc.x = orig.x; m.pc.y = orig.y; m.pc.rot = orig.rot;
          }
          _avantDernier.set(String(m.pc.id), {
            x: m.x0, y: m.y0, rot: m.rot0, cx: m.c0x, cy: m.c0y,
            saut: Math.hypot((m.pc.x + m.pc.w / 2) - m.c0x, (m.pc.y + m.pc.h / 2) - m.c0y),
          });
        });
        // G-13. ONE message for the WHOLE GESTURE, not one per member: a group is one gesture, and
        // this project throttles system banners but never a message answering a deliberate one.
        if (t < 1 - 1e-6 && members.length) {
          toast("This selection does not fit there: it was put back as close as possible, inside the room.", { geste: true });
        }
      }
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
  let moved = false;              // a simple click says nothing: the message is for a GESTURE
  const c0x = p.x + p.w / 2, c0y = p.y + p.h / 2;
  const p0x = p.x, p0y = p.y, rot0 = p.rot || 0;
  let rawX = c0x, rawY = c0y;     // last center WANTED by the hand, before snaps and bounding
  let lastSnap: { x: number; y: number } | null = null;
  // G-7. Penetration ALREADY tolerated before the gesture: the end-of-gesture bounding will not push beyond it.
  const pen0 = pieceTol(ctx.etat.plan, p);
  // G-7. A PIECE OF FURNITURE ALREADY OUT OF ITS CELL DOES NOT GET TELEPORTED. A converted plan places furniture
  // straddling a wall: the center of an 80×12 radiator falls into the wall's band, so in
  // NO cell at all. The end-of-gesture bounding used to "repatriate" it on the very first drag: measured,
  // "Radiator 3" would jump from 113 cm in response to a 30 cm push, without a word.
  const orphelin0 = !v5CellsAt(ctx.etat.plan, c0x, c0y);
  // Overflow ALREADY acquired outside the outline.
  const horsPoly = (ctx.etat.plan && ctx.etat.plan.outline) || null;
  const hors0 = (horsPoly && horsPoly.length >= 3 && !pointInPoly(c0x, c0y, horsPoly))
    ? nearestOnPoly(c0x, c0y, horsPoly).dist : 0;
  const riderPen = riders.map((c) => pieceTol(ctx.etat.plan, c));
  const riderIds = new Set<string>([String(p.id), ...riders.map((c) => String(c.id))]);

  const ex0 = e.clientX, ey0 = e.clientY;   // the pointer at the START: precise mode's anchor
  const move = (ev: PointerEvent): void => {
    pousseHist();
    moved = true;
    // SHIFT = precise mode. We slow down the POINTER, not the object: everything that follows (snaps,
    // guides, bounding, messages) stays on the same path and doesn't need to know this mode exists.
    const sp = pointSuivi(ev, ev.clientX, ev.clientY, ex0, ey0);
    const cm = toApt(sp.x, sp.y);
    // G-5. WE ROUND THE CORNER, ONLY ONCE. We used to round the CENTER then re-derive the
    // corner from it, so a second rounding: on an ODD width (a 45 cm chair) the center falls
    // on a half-centimeter and `Math.round` always rounds UP, so every
    // round trip gained 1 cm, without end. The corner is the recorded quantity: it is what we
    // round, and only once.
    let pxA = cm.x - grabX, pyA = cm.y - grabY;
    // Ctrl/Cmd (`sansGrille`) suppresses the 5 cm grid for the same reason as the group branch above.
    const snapOn = !!ctx.etat.opts.snap, noGrid = sansGrille(ev);
    pxA = pasGrille(p0x, pxA, snapOn, noGrid); pyA = pasGrille(p0y, pyA, snapOn, noGrid);
    // G-7. Pushing BEYOND the overflow already acquired is FLATLY REFUSED (the furniture stays at its last
    // legal placement) rather than projected onto the outline: a projection slides ALONG the outline wall,
    // so the round trip never returned to the same spot (measured: 1 cm per cycle).
    if (hors0 > 0 && horsPoly && !pointInPoly(pxA + p.w / 2, pyA + p.h / 2, horsPoly)
      && nearestOnPoly(pxA + p.w / 2, pyA + p.h / 2, horsPoly).dist > hors0 + 0.01) return;
    const cl = clampCenterToApt(ctx.etat.plan, pxA + p.w / 2, pyA + p.h / 2, hors0);
    p.x = Math.round(cl.x - p.w / 2); p.y = Math.round(cl.y - p.h / 2);
    rawX = cl.x; rawY = cl.y;      // where the HAND let go, before any snap
    const snapped = snapChairToTable(ctx.etat.plan, ctx.etat.opts, p);
    lastSnap = snapped;
    // F1. THE RADIATOR MAGNET: a radiator is a MEUBLE, not a wall-mounted opening, but whenever a
    // wall comes within reach (same reach as an opening, `wallSnapReach`) it snaps to it, back
    // flush against the face, oriented with the wall. Out of reach it stays an ordinary piece of
    // furniture (a mobile radiator exists): no new modifier, it just wins over `alignSnap` the
    // same way `alignSnap` already wins over the grid.
    const aimante = (!snapped && p.type === "radiateur")
      ? radiatorWallSnap(ctx.etat.plan, p, wallSnapReach(ctx.vue.scale)) : null;
    if (aimante) { p.x = aimante.x; p.y = aimante.y; p.rot = aimante.rot; }
    const al = (snapped || aimante) ? null : alignSnap(ctx.etat.plan, ctx.etat.opts, p, riderIds);
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
    // Ctrl/Cmd held from the press, and the release never moved: this was a click, not a drag.
    // Roll back the ordinary selection change made at press time (selReplace, above) and TOGGLE
    // instead, exactly as a plain Ctrl+click always has.
    if (ctrlDown && !moved) {
      ctx.selection.ids.clear();
      preSelIds!.forEach((id) => ctx.selection.ids.add(id));
      selRecomputePrimary(ctx);
      selToggle(ctx, p.id);
      render(ctx);
      if (ctx.selection.primaire != null) ctx.crochets.openInspector?.();
      else ctx.crochets.hideInspector?.();
      ctx.crochets.dragEnd?.();
      return;
    }
    let fits = true;
    // G-4. PICKING UP A PIECE OF FURNITURE DOES NOT MOVE IT: bounding falls ONLY if the gesture has
    // really moved.
    if (!canceled && moved) {
      v5ClampPiece(ctx.etat.plan, p, pen0, { gardeOrphelin: orphelin0 }); fits = v5LastFit();
      riders.forEach((c, k) => v5ClampPiece(ctx.etat.plan, c, riderPen[k]));
    }
    // G-5, the fourth cause. THE ORIGINAL POSITION TAKES PRIORITY. The relative grid gets us
    // almost there, but the alignment snap and the wall inset leave 1 to 3 cm along the way,
    // and the drift freezes in on the first cycle. So we remember the placement the furniture had
    // BEFORE its last drag: if a LONG gesture puts it back within a few centimeters of there, it
    // returns there EXACTLY.
    if (!canceled && moved) {
      const orig = _avantDernier.get(String(p.id));
      // We compare the WANTED position (before the chair-table snap, alignment and the wall
      // inset): otherwise a snap that moves 22 cm would mask the return.
      const cxF = rawX, cyF = rawY;
      // THE CONDITION IS ABOUT THE PREVIOUS GESTURE, NOT THIS ONE. We used to require a trip of more
      // than 50 cm: the most common step (30 cm) therefore never qualified, and the furniture
      // would oscillate forever (measured: 62 exact returns out of 122 at 30 cm).
      if (orig && orig.saut > RETOUR_TOL * 2 && Math.hypot(cxF - orig.cx, cyF - orig.cy) <= RETOUR_TOL) {
        p.x = orig.x; p.y = orig.y; p.rot = orig.rot;
      }
      _avantDernier.set(String(p.id), {
        x: p0x, y: p0y, rot: rot0, cx: c0x, cy: c0y,
        saut: Math.hypot((p.x + p.w / 2) - c0x, (p.y + p.h / 2) - c0y),
      });
    }
    v5Touch(ctx); render(ctx); clearGuides(ctx); ctx.crochets.syncInspector?.(); ctx.crochets.openInspector?.();
    // G-6 + G-13. When the object does not fit in the room, we tolerate the overflow rather than
    // catapulting it, AND WE SAY SO.
    if (!fits && moved) {
      toast(`${p.name || "This piece"} is bigger than the room: it sticks out.`, { geste: true });
    }
    // G-13. A GESTURE THAT PRODUCES NOTHING MUST SAY WHY. Measured on the real floor plan: a 45×50 cm
    // chair no longer moved by a centimeter, four drags in a row, in total silence.
    // Condition: the gesture had a REAL intent (more than RETOUR_MIN cm targeted) and changed
    // absolutely nothing.
    else if (!canceled && moved && p.x === p0x && p.y === p0y && (p.rot || 0) === (rot0 || 0)
      && Math.hypot(rawX - c0x, rawY - c0y) > RETOUR_MIN) {
      toast(`${p.name || "This piece"} cannot go any further: it already touches the edge of the room.`, { geste: true });
    }
    // G-13bis. DROPPED HERE, PUT BACK THERE: THAT GETS SAID. Measured: an oven pushed 30 cm to the
    // RIGHT would end up 28 cm to the LEFT, without a word. A chair->table snap, on the other hand, is a
    // wanted and visible effect: it says nothing.
    else if (!canceled && moved && !lastSnap
      && Math.hypot((p.x + p.w / 2) - rawX, (p.y + p.h / 2) - rawY) > 15) {
      toast(`${p.name || "This piece"} does not fit there: it was put back as close as possible, inside the room.`, { geste: true });
    }
    ctx.crochets.dragEnd?.();
  };
  const cancelDrag = (): void => {
    restorePoses(before); undoAltCopy(); v5Touch(ctx); render(ctx); clearGuides(ctx); ctx.crochets.syncInspector?.();
  };
  window.addEventListener("pointermove", move);
  armGesture(up, null, cancelDrag);
}
