// src/ts/gestes/murs.ts — WALLS MODE: select, drag, draw, edit the outline.
// Ported from src/js/53-v5-outils.js (everything, EXCEPT the OPENING drag which lives in `ouverture.ts`),
// from src/js/54-v5-interface.js (`v5SyncTools` and the handle WIRING, whose rendering already lives
// in `rendu/calque.ts`), from src/js/23-mode-murs.js (`setWallsMode`) and from src/js/52 for the single
// `v5AfterGeometry`, which belongs to no other batch: it calls rendering and persistence,
// so it lives on the gestures side, not the model's.
//
// THE INVARIANTS THIS FILE HOLDS, AND WHAT THEY COST BEFORE THEY EXISTED:
//   G-1  every gesture arms through `armGesture(finish[, onUp[, onCancel]])` and NEVER listens to
//        `pointerup` itself. A gesture that doesn't end makes the application MUTE and causes
//        the whole session to be lost on reload, without a single message.
//   G-3  SELECTING NEVER WRITES. `v5StartWallDrag`, `v5StartVertexDrag` and
//        `v5StartOutlineEdgeDrag` only push history and only recompute the geometry if the
//        pointer has moved by 3 px. Measured: a clean click on an outline wall produced 28 differences
//        (a 90 cm wall lengthened three meters away from there, the apartment going from 10 to 11 rooms,
//        16 pieces of furniture moved by up to 114 cm); a click on a vertex cut a room in two.
//   G-12 ESCAPE cancels the gesture, puts the object back EXACTLY in place (each gesture supplies its own
//        `onCancel`), and leaving Walls mode gets STATED (the message lives in the keyboard batch).
//   G-13 a gesture that produces nothing says why, on EVERY attempt (`toast(msg,{geste:true})`).
//   G-14 AN ARMED TOOL WINS, DURING THE CAPTURE PHASE, OVER ALL HANDLES (`v5CaptureDown`).
//   G-15 the "+" handle lives 18 px OUTSIDE the outline. The outward normal (`outlineOutward`) is
//        already ported in `rendu/calque.ts`, with its sole taker, the render: it is NOT
//        re-declared here (the old `v5OutlineOutward` from js/53 and the one from js/54 were the same
//        computation written twice).
//   C-13 AN OUTLINE WALL CANNOT BE DELETED: `v5DeleteSelectedWall` goes through the three-outcome verdict
//        (`v5WallDeleteVerdict`, via `v5CanDeleteWall`).
//
// WHAT CHANGES COMPARED TO THE OLD CLIENT: the plan and the context are ARGUMENTS, never
// globals, and the mass-bounding banner (`v5ClampPieces`) is emitted here, since the model now
// returns a TEXT, it no longer talks on its own.

import type { Contexte } from "../app/contexte.ts";
import type { Mur, PlanV5, Pt } from "../partage/plan.ts";
import { v5Touch, v5On, v5WallById } from "../app/contexte.ts";
import { $ } from "../noyau/dom.ts";
import { clamp, WALL, v5R2 } from "../noyau/nombres.ts";
import { closestOnSeg } from "../geometrie/polygones.ts";
import { v5DedupeWalls, v5Seg } from "../modele/murs.ts";
import { v5RebuildCells } from "../modele/cellules.ts";
import {
  v5CanDeleteWall,
  v5ClampOpenings,
  v5ClampPieces,
  v5FlushOpeningsBorned,
  v5SnapPoint,
  v5SnapVertex,
  v5SnapWallEnd,
  v5SyncOutlineWalls,
  v5ThroughWall,
  v5WallCovering,
} from "../modele/edition.ts";
import { render } from "../rendu/rendu.ts";
import { syncCellCard } from "../rendu/fiche-cellule.ts";
import { aptToScreen, evtApt, fitView } from "../rendu/vue.ts";
import { resolveColor } from "../rendu/couleurs.ts";
import { clearSel } from "../rendu/selection.ts";
import { renderRoomChips } from "../rendu/puces-rail.ts";
import { sanitizeV5Plan } from "../modele/migrations.ts";
import { save } from "../app/persistance.ts";
import { toast } from "../app/toast.ts";
import { numField } from "../noyau/champ-numerique.ts";
import { pushHistory } from "../historique/pile.ts";
import { armGesture, beginGesture, endGesture } from "./sortie.ts";
import { measureMode, sansGrille, spaceHeld } from "./etat-pointeur.ts";
import { clearGuides } from "./guides.ts";
// SYMBOLS EXPECTED FROM A MODULE THAT HAS NO AUTHOR YET (src/js/15-edition-murs.js):
// the outline's orthogonal snap, its guides, and the "walls cross" alert. Walls mode
// can't do without them (`v5StartVertexDrag` and `v5AfterGeometry` call them), and js/15
// belongs to no batch of the project: flagged to the coordinator.
import { checkShapeWarn, clearStitchGuides, drawOrthoGuides, orthoSnapVertex } from "./edition-murs.ts";
// C-8. `v5NewId` (js/51) draws a device tag from the realtime socket or from
// `sessionStorage`: without it, two people drawing a partition at the same instant would get the
// same `w20` and every other wall would disappear without a word. This is not a function of the plan,
// hence its own separate module.
import { v5NewId } from "../fil/identite.ts";
// FREEHAND WALL TRACE (a stroke becomes a CHAIN of walls). One-directional import ONLY (this
// file -> trace-libre.ts): trace-libre.ts must not import back from here, see its own header for
// why (a cycle between the two is exactly the shape of bug "Blank startup" warns about).
import { v5StartFreeDraw } from "./trace-libre.ts";
// THE 45-DEGREE TABLE, from the PURE half of the freehand trace (`geometrie/trace-libre.ts`, no
// `Contexte`, no DOM): the wall-endpoint drag below quantises a dragged end's direction the SAME
// way a freehand stroke's own runs are quantised (AGENTS.md, "same convention as the freehand
// trace"), so it reuses the exact table rather than a second hand-rolled `cos`/`sin` (which would
// reintroduce the `1.2246e-16` trap that table exists to avoid). No cycle risk: this is a
// DIFFERENT file from `./trace-libre.ts` above (the impure gesture half), and the pure
// `geometrie/` module imports nothing from `gestes/`.
import { DIR8, quantizeAngleDeg } from "../geometrie/trace-libre.ts";

// =================================================================================================
//  SELECTING A WALL, A CELL, AND DELETION
// =================================================================================================

export function v5SelectWall(ctx: Contexte, id: unknown): void {
  ctx.ihm.selWall = (id == null ? null : String(id));
  v5Touch(ctx);
  const card = $("roomCard");
  if (card && !card.hidden) syncCellCard(ctx);
}

export function v5SelectCell(ctx: Contexte, id: unknown, openCard?: boolean): void {
  ctx.ihm.selCell = (id == null ? null : String(id));
  ctx.ihm.selWall = null;
  v5Touch(ctx);
  const card = $("roomCard");
  if (openCard && card) card.hidden = false;
  if (card && !card.hidden) syncCellCard(ctx);
  render(ctx);
}

/**
 * G-8. Mass bounding recalibrates ONLY orphaned furniture, and it SAYS SO. The old
 * `v5ClampPieces()` used to call `toast` itself; the model now returns the text, and this is where
 * it gets spoken, without `{geste:true}`, exactly as before (this particular banner describes a
 * REPAIR, not a gesture's refusal).
 */
export function bornerLesMeubles(ctx: Contexte): number {
  const bilan = v5ClampPieces(ctx.etat.plan);
  if (bilan.message) toast(bilan.message);
  return bilan.perdus;
}

export function v5DeleteSelectedWall(ctx: Contexte): void {
  const P = ctx.etat.plan, id = ctx.ihm.selWall;
  if (!P || !id) return;
  const w = v5WallById(ctx, id);
  if (!w) return;
  // An outline wall is DERIVED from the outline: deleting it would take its windows down and leave the wall
  // standing (v5SyncOutlineWalls recreates it). We refuse, and we say why (before: total silence).
  if (!v5CanDeleteWall(P, id)) {
    toast("A facade cannot be deleted: move it, or remove a corner of the outline.", { geste: true });
    return;
  }
  pushHistory(ctx);
  // the server CASCADES the wall's openings (wall.del): we do the same here, otherwise they
  // would become orphaned locally (no supporting geometry).
  for (let i = P.openings.length - 1; i >= 0; i--) {
    if (String(P.openings[i]!.wallId) === String(id)) P.openings.splice(i, 1);
  }
  const k = P.walls.indexOf(w);
  if (k >= 0) P.walls.splice(k, 1);
  v5SelectWall(ctx, null);
  // the two cells merge; v5AssignNames gives the name of the LARGER one (max overlap)
  v5RebuildCells(P); bornerLesMeubles(ctx); v5Touch(ctx);
  render(ctx); save(ctx);
}

// =================================================================================================
//  DIMENSIONS AND EPHEMERAL DRAFTS
// =================================================================================================
// They live on the CANVAS (viewport px via `aptToScreen`), not in the layer: they are not
// geometry, they do not survive the gesture.

export function v5ClearDims(ctx: Contexte): void {
  ctx.canvas.querySelectorAll(".v5dimwrap").forEach((n) => n.remove());
}

/**
 * A wall's dimension, at the segment's midpoint. `t` (the thickness) was never read by `v5Seg`: the
 * callers that used to pass `{a,b,t:WALL}` now pass `{a,b}`, which changes nothing.
 */
/**
 * The walls that TOUCH `w` at one end, outline walls included.
 *
 * Why it matters during a drag: moving a partition doesn't just change ITS length, it
 * lengthens or shortens all the walls resting on it. Showing only the dragged wall's dimension is
 * showing the one measurement that raises no question: you push a wall to adjust the room
 * NEXT TO IT, and that room is bounded by the neighboring walls.
 */
export function v5MursTouchant(P: PlanV5 | null | undefined, w: Pick<Mur, "id" | "a" | "b">): Mur[] {
  if (!P) return [];
  const TOL = 3;   // cm: two ends within 3 cm are the same junction (V5_JOIN_TOL + margin)
  const proche = (p: Pt, q: Pt): boolean => Math.hypot(p[0] - q[0], p[1] - q[1]) <= TOL;
  const out: Mur[] = [];
  for (const q of (P.walls || [])) {
    if (String(q.id) === String(w.id)) continue;
    if (proche(q.a, w.a) || proche(q.a, w.b) || proche(q.b, w.a) || proche(q.b, w.b)) out.push(q);
  }
  return out;
}

export function v5DrawWallDims(ctx: Contexte, walls: ReadonlyArray<Pick<Mur, "a" | "b">> | null | undefined): void {
  v5ClearDims(ctx);
  const cont = document.createElement("div");
  cont.className = "ov-guides v5dimwrap";
  (walls || []).forEach((w) => {
    const L = Math.round(v5Seg(w).L);
    if (L < 5) return;
    const s = aptToScreen(ctx, (w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2);
    const el = document.createElement("div");
    el.className = "v5dim";
    el.textContent = L + " cm";
    el.style.left = s.x + "px";
    el.style.top = s.y + "px";
    cont.appendChild(el);
  });
  if (cont.children.length) ctx.canvas.appendChild(cont);
}

export function v5DrawDraft(ctx: Contexte, seg: readonly [Pt, Pt] | null): void {
  v5ClearDraft(ctx);
  if (!seg) return;
  const cont = document.createElement("div");
  cont.className = "ov-guides v5draftwrap";
  const a = aptToScreen(ctx, seg[0][0], seg[0][1]), b = aptToScreen(ctx, seg[1][0], seg[1][1]);
  const el = document.createElement("div");
  el.className = "gline";
  const len = Math.hypot(b.x - a.x, b.y - a.y), ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
  el.style.position = "absolute";
  el.style.left = a.x + "px";
  el.style.top = a.y + "px";
  el.style.width = len + "px";
  el.style.height = "0";
  el.style.borderTop = "3px dashed " + resolveColor("var(--accent)");
  el.style.transformOrigin = "0 0";
  el.style.transform = `rotate(${ang}deg)`;
  cont.appendChild(el);
  ctx.canvas.appendChild(cont);
}

export function v5ClearDraft(ctx: Contexte): void {
  ctx.canvas.querySelectorAll(".v5draftwrap").forEach((n) => n.remove());
}

// =================================================================================================
//  AFTER A GEOMETRY CHANGE (js/52)
// =================================================================================================

/**
 * THE GEOMETRY PIPELINE ITSELF, no screen effects: re-sync the outline walls, re-traverse every
 * interior wall, keep openings inside their wall, and (`final`) rebuild the cells. Extracted out
 * of `v5AfterGeometry` (below) so a headless test can drive the SAME pipeline without a DOM
 * (`ctx.canvas`, `render()`, `document`) in the loop — exactly how `v5WallDragCtx`/
 * `v5WallDragApply` above are already tested directly, `tests/jonction-glisser-mur.ts`. Pure
 * function of the plan.
 */
export function v5ResoudreGeometrie(P: PlanV5 | null | undefined, final: boolean): void {
  if (!P) return;
  v5SyncOutlineWalls(P);
  (P.walls || []).forEach((w) => { if (!w.isOutline) v5ThroughWall(P, w); });
  v5ClampOpenings(P);
  if (final) v5RebuildCells(P);
}

/**
 * The outline or a wall just moved. `final` = the gesture is OVER.
 *
 * C-11, bounding belongs to the gesture's AUTHOR: it bounds once, on the FINAL geometry, it
 * SAYS SO, and it is the bounded result that gets published. During the drag (`final=false`) we bound
 * without speaking: the geometry isn't settled yet.
 */
export function v5AfterGeometry(ctx: Contexte, final: boolean): void {
  const P = ctx.etat.plan;
  if (!P) return;
  v5ResoudreGeometrie(P, final);
  if (final) {
    const msg = v5FlushOpeningsBorned();
    if (msg) toast(msg, { geste: true });
    bornerLesMeubles(ctx);
  }
  checkShapeWarn(ctx);   // the outline just moved: the "walls cross" alert follows
  v5Touch(ctx); render(ctx);
}

// =================================================================================================
//  TOOL 1: DRAGGING A WALL, AND THE JUNCTIONS THAT MUST HOLD (C-19)
// =================================================================================================
// The wall is A SINGLE shared object: moving it adjusts BOTH cells by construction. Any OTHER
// wall whose endpoint sits on the dragged wall (a corner it was drawn from, or a T further along
// it) is a FOLLOWER: it is decided ONCE, from the geometry at `pointerdown`
// (`v5WallDragCtx`), never re-evaluated mid-drag — re-deciding it on every frame would let a wall
// pick up a NEW neighbor it merely swept past, which is not what "this wall was already
// connected there" means.
//
// A follower's touching point is stored as `t`, its FRACTION along the dragged wall's ORIGINAL
// a0->b0 (0 at `a0`, 1 at `b0`, and anything in between for a T-junction on the middle). On
// every frame, that follower's near end is set to the SAME fraction along the dragged wall's
// CURRENT a/b: its OTHER end (`k`'s opposite) is left untouched, so the follower stretches or
// pivots around it, exactly like pushing one panel of a room and watching its neighbors flex.
//
// WHY NOT A FRACTION ANYMORE (what PR #17 shipped, and why it was itself wrong): PR #17's fix
// carried the touching point along a FRACTION of the dragged wall's length, which happens to move
// by the SAME VECTOR as the wall itself (the wall only ever TRANSLATES while being pushed
// sideways, never rotates). That vector is along a perpendicular follower's own axis for free (a T
// at a dragged wall's foot just gets longer or shorter), but along NO OTHER angle: an oblique
// follower's far end is fixed, its near end gets dragged sideways by a vector that isn't its own
// line, and it PIVOTS — measured, a follower at 45° opened to 63° after a 50 cm push. Worse, for a
// follower COLLINEAR with the dragged wall (PR #17's own target case) the fraction produced the
// SAME tilt, just disguised as "still attached": the owner's second report is a straight vertical
// wall that continued the dragged one downward to the facade, and PR #17's fraction bent it into a
// visible diagonal, exactly the defect it claimed to fix, because a fraction has no notion of
// "this neighbor's own direction," only of "where along the wall I'm pushing."
//
// TWO RULES, in this order, decided ONCE at `pointerdown` (`v5WallDragCtx`) and never
// re-evaluated mid-drag:
//   1. A follower NEVER tilts. It keeps its own direction (`Suiveur.dir`), fixed at its far end
//      (`Suiveur.fixe`): either its touching point SLIDES ALONG THAT DIRECTION until it meets the
//      dragged wall's new line (ordinary line intersection), or it does not move at all. There is
//      no third option, no fallback that carries it some other way — a wall in an apartment plan
//      is never diagonal by accident.
//   2. A follower moves ONLY IF it would otherwise be left touching NOTHING: if its touching point
//      is still within 2 cm of some OTHER wall's endpoint or flank, or of the facade (the SAME
//      tolerance junction detection itself uses), after the dragged wall leaves, it is already
//      held there and STAYS EXACTLY WHERE IT IS — sliding it to chase the dragged wall would tear
//      open whatever it is still attached to. This is checked FIRST, from the geometry at
//      `pointerdown` (only the dragged wall moves, and it is excluded from the check, so "held
//      after it leaves" and "held right now, ignoring it" are the same question); intersection is
//      attempted only for a follower that clears it.
// Rule 1 is why intersection is used AT ALL (a fraction cannot keep a direction); rule 2 is why it
// is not used UNCONDITIONALLY (an already-held neighbor sliding to "correctly" meet the dragged
// wall would rip the room it is still forming with its OTHER neighbor). Combined, three walls
// meeting at one point — a dragged wall, a perpendicular neighbor, and a third wall continuing
// that neighbor in a straight line to the facade — all stay exactly as drawn except the one being
// dragged: the other two hold each other, so neither one is in the void, so neither one moves,
// and the dragged wall simply comes to rest against the flank of whichever of them it now
// overlaps. Nothing tears, nothing tilts. See `docs/decisions/` for the two contradictory owner
// reports this reconciles.
//
// A follower whose own line is near-parallel to the dragged wall's new line (`sin < 0.09`, ~5°,
// covers the exact-collinear case) has no USABLE intersection either way (two near-parallel lines
// meet arbitrarily far away): rule 1 then gives "does not move" directly, without consulting rule
// 2 — sliding along a direction the dragged wall's line barely deviates from is not meaningfully
// different from not sliding, and forcing a numerically unstable solve is worse than staying put.
// A collinear follower that ALSO turns out to be in the void (nothing else holds it) therefore
// DETACHES rather than stretch into a diagonal: an accepted loss, spelled out in
// `docs/decisions/`, because a visible gap is honest and reversible while a diagonal is neither.
//
// AN OUTLINE WALL NEITHER FOLLOWS NOR IS FOLLOWED: it is DERIVED from the outline
// (`v5SyncOutlineWalls` owns its geometry), never from an interior wall's drag. Making it "slide
// along" would need a projection rule that exists nowhere else in this model and would fight the
// next `v5SyncOutlineWalls` rebuild; leaving it alone is the choice already in force (`x.isOutline`
// is excluded from followers, and the dragged wall itself can never be an outline wall). Where a
// dragged wall's OWN end rests against a facade, `v5ThroughWall`'s trim (below) is what keeps it
// from leaving the apartment; that is unrelated to this follower list and unchanged by it.
//
// CHAINS ARE ONE HOP, DELIBERATELY: if A meets B and B meets C, dragging B carries A and C (their
// near ends, touching B), but dragging A carries ONLY B — C is not touching A, so it is not in
// A's follower list, and B's OWN far end (the one touching C) is never written by this function,
// so C stays exactly where it was. Propagating transitively would mean grabbing one wall silently
// drags the whole connected partition system across the apartment: that is a MASS operation, the
// same shape as the mass-renormalization this codebase already refuses elsewhere (G-8, AGENTS.md
// "NO MASS RENORMALIZATION"). A person pushing one wall of a room expects that wall's own corners
// to react, not the far side of the apartment.

/** A junction that follows the dragged wall: its end `k`, WHERE along the dragged wall (`t`, 0..1)
 * it was touching when the gesture started (kept only as the reference point for the intersection's
 * own sanity check, see `v5WallDragApply`), its OWN geometry at that same moment (`dir`, `fixe`: the
 * UNIT direction from its fixed far end to the touching end, and that far end itself, copied by
 * value so it never moves with the live wall object), and `tenu` (rule 2, held elsewhere): true if
 * something OTHER than the dragged wall already touches this same point, in which case this
 * follower never moves at all, no matter its angle. */
interface Suiveur {
  x: Mur;
  k: "a" | "b";
  t: number;
  dir: Pt;
  fixe: Pt;
  tenu: boolean;
}

/** UNIT vector from `fixe` to `p` ("this follower's own axis, at gesture start"). */
function v5FollowerDir(fixe: Pt, p: Pt): Pt {
  const dx = p[0] - fixe[0], dy = p[1] - fixe[1];
  const L = Math.hypot(dx, dy) || 1e-9;
  return [dx / L, dy / L];
}

/** RULE 2: is `pt` (a follower's touching point) still within 2 cm of some wall OTHER than the
 * dragged wall `w` and the follower `x` itself — another wall's endpoint or flank, or a facade
 * wall (outline walls are ordinary entries of `P.walls`, so they fall out of this same scan for
 * free)? Only `w` moves during this gesture, and it is excluded here, so "held once w has left"
 * and "held right now, ignoring w" are the same question — this can be decided ONCE, from the
 * geometry at `pointerdown`, exactly like the rest of the follower list. */
function v5EstTenuAilleurs(P: PlanV5, w: Mur, x: Mur, pt: Pt): boolean {
  return (P.walls || []).some((v) => {
    if (v === w || v === x) return false;
    return closestOnSeg(pt[0], pt[1], v.a[0], v.a[1], v.b[0], v.b[1]).dist <= 2;
  });
}

/** Context for a wall drag, fixed at `pointerdown`: original segment + junctions to follow. */
export interface ContexteGlisserMur {
  w: Mur;
  a0: Pt;
  b0: Pt;
  s: ReturnType<typeof v5Seg>;
  followers: Suiveur[];
}

/** The fraction along a0->b0 (clamped 0..1) closest to `p`. Mirrors `closestOnSeg`'s own formula
 * (geometrie/polygones.ts), which computes the same `t` internally but only returns the clamped
 * POINT: this is the one extra number that formula throws away and C-19 needs kept. */
function v5Fraction(p: Pt, a0: Pt, b0: Pt): number {
  const dx = b0[0] - a0[0], dy = b0[1] - a0[1];
  const len2 = dx * dx + dy * dy || 1e-9;
  return clamp(((p[0] - a0[0]) * dx + (p[1] - a0[1]) * dy) / len2, 0, 1);
}

export function v5WallDragCtx(ctx: Contexte, wallId: unknown): ContexteGlisserMur | null {
  const P = ctx.etat.plan;
  const w = v5WallById(ctx, wallId);
  if (!P || !w || w.isOutline) return null;
  const a0: Pt = [w.a[0], w.a[1]], b0: Pt = [w.b[0], w.b[1]];
  const followers: Suiveur[] = [];
  (P.walls || []).forEach((x) => {
    if (x === w || x.isOutline) return;
    (["a", "b"] as const).forEach((k) => {
      const c = closestOnSeg(x[k][0], x[k][1], a0[0], a0[1], b0[0], b0[1]);
      if (c.dist <= 2) {
        const autre = x[k === "a" ? "b" : "a"];
        const fixe: Pt = [autre[0], autre[1]];
        const tenu = v5EstTenuAilleurs(P, w, x, x[k]);
        followers.push({ x, k, t: v5Fraction(x[k], a0, b0), dir: v5FollowerDir(fixe, x[k]), fixe, tenu });
      }
    });
  });
  return { w, a0, b0, s: v5Seg({ a: a0, b: b0 }), followers };
}

/**
 * Applies a PERPENDICULAR offset `d` (cm): the wall moves, gets re-traversed, its junctions
 * follow it (C-19), the openings stay within it. `final` recomputes cells + furniture.
 */
export function v5WallDragApply(ctx: Contexte, g: ContexteGlisserMur, d: number, final: boolean): Mur {
  const { w, a0, b0, s, followers } = g;
  const P = ctx.etat.plan;
  w.a = [v5R2(a0[0] + s.nx * d), v5R2(a0[1] + s.ny * d)];
  w.b = [v5R2(b0[0] + s.nx * d), v5R2(b0[1] + s.ny * d)];
  v5ThroughWall(P, w);
  const wl = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) || 1e-9;
  const wux = (w.b[0] - w.a[0]) / wl, wuy = (w.b[1] - w.a[1]) / wl;
  followers.forEach((f) => {
    // RULE 2 first: already held by someone other than the dragged wall — stays exactly in place,
    // no matter its angle. Sliding it to "correctly" meet the dragged wall would tear open
    // whatever it is still attached to (see the header for the three-wall reproduction).
    if (f.tenu) return;
    // RULE 1: an unheld follower keeps its OWN direction — it slides ALONG THAT DIRECTION to meet
    // the dragged wall's new line (ordinary intersection), or it does not move. Never a fraction,
    // never any other vector: that is what used to tilt it. Near-parallel (`sin < 0.09`, ~5°) has
    // no usable intersection (two near-parallel lines meet arbitrarily far away) and is exactly the
    // collinear case: it does not move either, and — being unheld — DETACHES. An accepted loss
    // (`docs/decisions/`): a visible gap is honest and reversible, a diagonal is neither.
    const cross = f.dir[0] * wuy - f.dir[1] * wux;
    if (Math.abs(cross) < 0.09) return;
    const u = ((w.a[0] - f.fixe[0]) * wuy - (w.a[1] - f.fixe[1]) * wux) / cross;
    if (u < 1) return;                                    // would collapse to under 1 cm: refuse
    const qx = f.fixe[0] + u * f.dir[0], qy = f.fixe[1] + u * f.dir[1];
    // Sanity floor on the solve itself (extreme geometry, not the near-parallel case above, which
    // is already excluded): a follower's new point must stay within a plausible distance of where
    // it was touching before this gesture.
    const p0x = a0[0] + f.t * (b0[0] - a0[0]), p0y = a0[1] + f.t * (b0[1] - a0[1]);
    if (Math.hypot(qx - p0x, qy - p0y) > 1000) return;
    f.x[f.k] = [v5R2(qx), v5R2(qy)];
  });
  v5ClampOpenings(P);
  if (final) { v5RebuildCells(P); bornerLesMeubles(ctx); }
  v5Touch(ctx);
  return w;
}

export function v5StartWallDrag(ctx: Contexte, e: PointerEvent, wallId: unknown): void {
  const P = ctx.etat.plan;
  const w = v5WallById(ctx, wallId);
  if (!P || !w || w.isOutline) return;
  if (e.button !== undefined && e.button !== 0) return;
  if (spaceHeld() || measureMode()) return;
  e.preventDefault(); e.stopPropagation();
  v5SelectWall(ctx, wallId); render(ctx);
  const g = v5WallDragCtx(ctx, wallId);
  if (!g) return;
  const { a0, s, followers } = g;
  beginGesture();
  ctx.crochets.dragStart?.();
  // Pure APARTMENT space (evtApt): the pointer is read in the viewport and converted to cm.
  const g0 = evtApt(ctx, e);
  const d0 = (g0.x - a0[0]) * s.nx + (g0.y - a0[1]) * s.ny;
  const px0 = e.clientX, py0 = e.clientY;
  let moved = false;
  // G-3. A clean click on a partition SELECTS it: neither history nor geometry touched until
  // the pointer has crossed 3 px (same threshold as the outline wall and the vertex).
  const move = (ev: PointerEvent): void => {
    if (!moved) {
      if (Math.hypot(ev.clientX - px0, ev.clientY - py0) < 3) return;
      moved = true; pushHistory(ctx);
    }
    const cm = evtApt(ctx, ev);
    let d = (cm.x - a0[0]) * s.nx + (cm.y - a0[1]) * s.ny - d0;
    // Alt = free partition (unchanged). Ctrl/Cmd (`sansGrille`) is the SAME escape hatch as
    // furniture and openings: one key to remember for "no grid," without taking Alt away from
    // free-drawing.
    if (ctx.etat.opts.snap && !ev.altKey && !sansGrille(ev)) {
      const na = [a0[0] + s.nx * d, a0[1] + s.ny * d];
      if (Math.abs(s.nx) > 0.99) d += (Math.round(na[0]! / 5) * 5 - na[0]!) / s.nx;
      else if (Math.abs(s.ny) > 0.99) d += (Math.round(na[1]! / 5) * 5 - na[1]!) / s.ny;
      else d = Math.round(d / 5) * 5;
    }
    v5WallDragApply(ctx, g, d, false);
    render(ctx);
    // The dragged wall, the ones following it, AND THE ONES TOUCHING IT: their length is what we're
    // trying to adjust by pushing this one. `Map` keyed by identifier so as not to dimension twice a
    // wall that happens to be both a follower and a neighbor.
    const vus = new Map<string, Mur>();
    for (const m of ([w] as Mur[]).concat(followers.map((f) => f.x))) vus.set(String(m.id), m);
    for (const m of [w].concat(followers.map((f) => f.x))) {
      for (const v of v5MursTouchant(ctx.etat.plan, m)) vus.set(String(v.id), v);
    }
    v5DrawWallDims(ctx, [...vus.values()]);
    ctx.crochets.liveAnalyze?.();
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    v5ClearDims(ctx);
    if (moved) { v5RebuildCells(P); bornerLesMeubles(ctx); v5Touch(ctx); }
    render(ctx);
    endGesture();
    ctx.crochets.dragEnd?.();
  };
  // G-12. Escape: the wall (and its T junctions) return to their position from before the gesture.
  const cancel = (): void => { v5WallDragApply(ctx, g, 0, true); moved = false; render(ctx); };
  window.addEventListener("pointermove", move);
  armGesture(up, null, cancel);   // guaranteed end (G-1)
}

// =================================================================================================
//  TOOL 1-BIS: DRAGGING A WALL'S OWN ENDPOINT, TO EXTEND OR CONNECT IT
// =================================================================================================
// The owner's report, verbatim: "j'aimerais aussi pouvoir choper les extrémités des murs et
// pouvoir étendre et relier à d'autres murs. parfois je fais un mur mais je me rate, je voulais
// le faire plus long, et là je dois le delete et recommencer." Before this, a SELECTED interior
// wall carried exactly ONE handle, the "×" that deletes it (`rendu/calque.ts`'s `drawHandles`):
// a wall drawn too short could only be deleted and redrawn.
//
// ONE endpoint moves, the OTHER stays exactly where it was. This is NOT the perpendicular-offset
// drag of TOOL 1 above (`v5WallDragCtx`/`v5WallDragApply`, which moves the WHOLE wall and carries
// its junctions as FOLLOWERS, decided once at `pointerdown`): here there is no follower list,
// because `v5ResoudreGeometrie` already re-traverses EVERY wall on each frame — the same
// mechanism a vertex drag and an outline edge drag already lean on (`v5AfterGeometry`). A
// neighbor that was resting against this wall reacts to the endpoint's NEW position exactly as
// it would to any other geometry edit; there is nothing extra to decide or carry.
//
// THE DRAGGED END BECOMES `free`, DELIBERATELY (same reasoning as the "exact length" field
// further down, and the 2026-08-14 decision on drawn walls, see `v5TryCreateWall`'s own note):
// `v5ThroughWall` extends a non-free wall's ends to the nearest barrier on every recompute, which
// would silently undo a deliberate placement in open space the instant the gesture ends.
// Connection to another wall is made through SNAPPING (`v5SnapWallEnd`) at drop time, never
// through staying through-going: a `free` wall does not "reconnect" if a neighbor is later
// dragged away, which is exactly what a deliberately extended stub should do.

/**
 * Where the dragged endpoint lands THIS FRAME, in priority order:
 *   1-3. a junction (another wall's endpoint, a point on another wall's segment, or the same on
 *        the outline) within reach — `v5SnapWallEnd` covers all three as one two-stage cascade,
 *        EXACT, regardless of Alt: a deliberate connection is not something "free hand" mode
 *        should make harder to hit.
 *   4. otherwise, the wall's DIRECTION quantised to the nearest 45° measured from the FIXED end
 *      (`DIR8`/`quantizeAngleDeg`, the freehand trace's own table) — unless Alt is held, which
 *      frees the angle, "same convention as the freehand trace" (AGENTS.md).
 *   5. `step` (5cm, or 1cm under Ctrl/Cmd — the caller passes it, see `sansGrille`) rounds the
 *      result along whichever direction stage 4 picked.
 * Mirrors `v5StartDraw`'s own precedence (vertex > edge > grid) so extending a wall feels
 * identical to drawing one.
 */
export function v5WallEndDrop(
  P: PlanV5 | null | undefined,
  wallId: unknown,
  anchor: Pt,
  x: number,
  y: number,
  echelle: number,
  alt: boolean,
  step: number,
): Pt {
  const snapped = v5SnapWallEnd(P, String(wallId), x, y, echelle);
  if (snapped) return snapped;
  if (alt) return [Math.round(x / step) * step, Math.round(y / step) * step];
  const dx = x - anchor[0], dy = y - anchor[1];
  const dir = DIR8[quantizeAngleDeg(Math.atan2(dy, dx) * 180 / Math.PI) / 45]!;
  const t = dx * dir[0] + dy * dir[1];
  const tq = Math.round(t / step) * step;
  return [v5R2(anchor[0] + dir[0] * tq), v5R2(anchor[1] + dir[1] * tq)];
}

/**
 * Applies the drop: moves ONLY `bout`, marks the wall `free` (see file header), re-settles the
 * geometry (`final` also rebuilds the cells and bounds furniture). Mirrors `v5WallDragApply`'s
 * own shape exactly, including being safe to call headlessly with a stub `Contexte`
 * (`ctx.etat.plan` and `ctx.canvas.querySelector` only — no `render()`, no `document`), so the
 * SAME function drives both the real gesture below and `tests/bouts-de-mur.ts`.
 */
export function v5WallEndDragApply(
  ctx: Contexte,
  wallId: unknown,
  bout: "a" | "b",
  target: Pt,
  final: boolean,
): Mur | null {
  const P = ctx.etat.plan;
  const w = v5WallById(ctx, wallId);
  if (!P || !w || w.isOutline) return null;
  w[bout] = target;
  w.free = 1;
  v5ResoudreGeometrie(P, final);
  if (final) bornerLesMeubles(ctx);
  v5Touch(ctx);
  return w;
}

export function v5StartWallEndDrag(ctx: Contexte, e: PointerEvent, wallId: unknown, bout: "a" | "b"): void {
  const P = ctx.etat.plan;
  const w = v5WallById(ctx, wallId);
  if (!P || !w || w.isOutline) return;
  if (e.button !== undefined && e.button !== 0) return;
  if (spaceHeld() || measureMode()) return;
  e.preventDefault(); e.stopPropagation();
  v5SelectWall(ctx, wallId); render(ctx);
  const fixe: "a" | "b" = bout === "a" ? "b" : "a";
  const p0: Pt = [w[bout][0], w[bout][1]];
  const anchor: Pt = [w[fixe][0], w[fixe][1]];
  const freeAvant = w.free;
  beginGesture();
  ctx.crochets.dragStart?.();
  const px0 = e.clientX, py0 = e.clientY;
  let moved = false;
  // G-3. A clean click on the handle SELECTS the wall (already done above): neither history nor
  // geometry touched until the pointer has crossed 3 px, same threshold as every other geometry
  // gesture in this file.
  const move = (ev: PointerEvent): void => {
    if (!moved) {
      if (Math.hypot(ev.clientX - px0, ev.clientY - py0) < 3) return;
      moved = true; pushHistory(ctx);
    }
    const cm = evtApt(ctx, ev);
    const step = sansGrille(ev) ? 1 : (ctx.etat.opts.snap ? 5 : 1);
    const target = v5WallEndDrop(P, w.id, anchor, cm.x, cm.y, ctx.vue.scale, ev.altKey, step);
    v5WallEndDragApply(ctx, w.id, bout, target, false);
    render(ctx);
    v5DrawWallDims(ctx, [w]);
    ctx.crochets.liveAnalyze?.();
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    v5ClearDims(ctx);
    if (moved) {
      v5ResoudreGeometrie(P, true);
      const msg = v5FlushOpeningsBorned();
      if (msg) toast(msg, { geste: true });
      bornerLesMeubles(ctx);
      v5Touch(ctx);
    }
    render(ctx);
    endGesture();
    ctx.crochets.dragEnd?.();
  };
  // G-12. Escape: the endpoint AND its `free` flag return to before the gesture, then everything
  // touching it re-settles (a neighbor may have reacted to the endpoint while it was away).
  const cancel = (): void => {
    w[bout] = p0; w.free = freeAvant;
    v5ResoudreGeometrie(P, true);
    bornerLesMeubles(ctx);
    v5Touch(ctx);
    moved = false;
    render(ctx);
  };
  window.addEventListener("pointermove", move);
  armGesture(up, null, cancel);
}

// =================================================================================================
//  TOOL 2: DRAWING A WALL
// =================================================================================================

/**
 * Arms (or disarms) a draw tool. `libre` picks WHICH one while `on` is true: the single-segment
 * tool (default, unchanged behaviour) or the freehand trace (`gestes/trace-libre.ts`), which
 * turns a stroke into a chain of walls. Two buttons, one state machine: activating one clears
 * the other, matching the segmented Furniture/Walls control's own look.
 */
export function v5SetDraw(ctx: Contexte, on: boolean, libre?: boolean): void {
  ctx.ihm.draw = !!on;
  ctx.ihm.drawFree = !!on && !!libre;
  const bSeg = $("btnDrawWall");
  if (bSeg) {
    const actif = ctx.ihm.draw && !ctx.ihm.drawFree;
    bSeg.classList.toggle("pri", actif);
    bSeg.setAttribute("aria-pressed", actif ? "true" : "false");
  }
  const bLibre = $("btnDrawWallFree");
  if (bLibre) {
    const actif = ctx.ihm.draw && ctx.ihm.drawFree;
    bLibre.classList.toggle("pri", actif);
    bLibre.setAttribute("aria-pressed", actif ? "true" : "false");
  }
  const l = ctx.canvas.querySelector<HTMLElement>(".v5layer");
  if (l) l.classList.toggle("drawing", !!on);
}

/** What the drawing knows about itself at the moment the wall is created (to NAME the true culprit). */
export interface OptionsTrace {
  /** Alt held: no right angle, no snap. */
  libre?: boolean;
  /** the arrival point BEFORE the snap. */
  brut?: Pt | null;
}

/**
 * CREATE A DRAWN WALL: a single place, refusal and message included.
 *
 * A second stroke over an already-existing partition would create a wall EXACTLY overlapping, hence
 * invisible, and "Delete wall" would only remove one of them. We refuse, we select the existing
 * partition, and we SAY SO, on EVERY attempt (`geste:true`), not just the first: redoing the gesture is
 * precisely what someone who didn't understand does (G-13).
 *
 * The message names the true culprit when it is the SNAP that pulled the stroke onto a partition
 * it was still far from (2, 5, 10 cm): otherwise the gesture just seems to evaporate.
 */
export function v5TryCreateWall(ctx: Contexte, a: Pt, b: Pt, o?: OptionsTrace | null): Mur | null {
  // OWNER'S DECISION (2026-08-14): A WALL DRAWN WITH THE TOOL KEEPS THE ENDS YOU DREW.
  // Before, every drawn wall was through-going (`v5ThroughWall` pushes each end to the first
  // barrier beyond it): a 60 cm stub drawn by hand shot across the room to the facade, which is
  // right for a wall REBUILT from the outline but surprises everyone drawing by hand. `free` is
  // the model's existing escape hatch for exactly this (see AGENTS.md "free partition", the
  // "Ends: Through | Free" control): a wall born from THIS tool now sets it unconditionally,
  // no `Alt` required. `Alt` keeps its OTHER, unrelated meaning below (no imposed right angle,
  // no magnet): it never touches `free` here.
  //
  // BLAST RADIUS: this is the ONLY function that turns a drawn stroke into a wall object
  // (`v5StartDraw`'s single caller, plus the identical test probe `sonde-fil.ts`'s `drawWall`,
  // which exists precisely to exercise this same code path). It does not touch outline walls
  // (`v5SyncOutlineWalls`), walls rebuilt from the outline, walls received from a peer
  // (`historique/rejeu.ts`, `fil/*`), walls read from a stored plan (`modele/migrations.ts`), or
  // conversion from the old format (`modele/conversion-v4.ts`): none of those call this function,
  // and none of them were touched by this change.
  const P = ctx.etat.plan;
  if (!P) return null;
  const dup = v5WallCovering(P, a, b);
  if (dup) {
    const aimante = !(o && o.libre) && !!(o && o.brut) && !v5WallCovering(P, a, o.brut);
    v5SelectWall(ctx, dup.id); render(ctx);
    toast(aimante
      ? "The line snapped onto the partition next to it, which is already there. Hold Alt to draw without the magnet."
      : "That partition is already there.", { geste: true });
    return null;
  }
  pushHistory(ctx);
  const w: Mur = { id: v5NewId("w"), a: [a[0], a[1]], b: [b[0], b[1]], t: WALL, isOutline: false, free: 1 };
  P.walls.push(w);
  v5ThroughWall(P, w);            // `free`: trimmed by the outline only, kept as drawn otherwise
  v5RebuildCells(P); bornerLesMeubles(ctx); v5Touch(ctx);
  v5SelectWall(ctx, w.id);
  render(ctx); save(ctx);
  return w;
}

export function v5StartDraw(ctx: Contexte, e: PointerEvent): void {
  const P = ctx.etat.plan;
  if (!P) return;
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const A = evtApt(ctx, e);                          // pure APARTMENT space
  // `Alt` = FREE drawing: no imposed right angle, NOR snap. The snap reaches up to a wall
  // thickness (12 cm): a stroke deliberately placed 2, 5 or 10 cm from an existing partition would
  // therefore end up sticking onto it, the duplicate would be refused, and the gesture seemed to
  // evaporate. The refusal is legitimate (two overlapping walls are invisible), but there needs to be
  // an exit door AND a message that names it.
  const snap = !!ctx.etat.opts.snap;
  // START POINT: `v5SnapPoint` already checks vertices (outline corners, wall endpoints) BEFORE
  // edges and the grid, so a stroke starting near an existing joint already lands exactly on it.
  const a: Pt = e.altKey ? [v5R2(A.x), v5R2(A.y)] : v5SnapPoint(P, A.x, A.y, ctx.vue.scale, snap);
  let draft: [Pt, Pt] | null = null, libre = !!e.altKey, brut: Pt | null = null;
  const move = (ev: PointerEvent): void => {
    const cm = evtApt(ctx, ev);
    brut = [v5R2(cm.x), v5R2(cm.y)];
    libre = !!ev.altKey;
    let b: Pt;
    if (ev.altKey) {
      b = [v5R2(cm.x), v5R2(cm.y)];
    } else {
      // END POINT, TWO ROOMS CLOSING ON ONE ANOTHER: an existing joint (outline corner or wall
      // endpoint) wins over the orthogonal constraint below. `v5SnapVertex` is the SAME vertex
      // check `v5SnapPoint` already runs first (reused, not a second notion of snapping); when it
      // finds one within reach (tolerance: one wall thickness, capped between 8 cm and 12 cm,
      // shrinking with zoom, `v5SnapPoint`'s own header) the two walls share that EXACT point,
      // rather than merely the same axis as it. Only the fallback (grid/edge) below still folds
      // onto the orthogonal line, exactly as before.
      const vtx = v5SnapVertex(P, cm.x, cm.y, ctx.vue.scale);
      if (vtx) {
        b = vtx;
      } else {
        b = v5SnapPoint(P, cm.x, cm.y, ctx.vue.scale, snap);
        if (Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1])) b = [b[0], a[1]]; else b = [a[0], b[1]];
      }
    }
    draft = [a, b];
    v5DrawDraft(ctx, draft);
    v5DrawWallDims(ctx, [{ a: draft[0], b: draft[1] }]);
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    v5ClearDraft(ctx); v5ClearDims(ctx);
    // THE TOOL STAYS ARMED (owner's #1 complaint: drawing a room meant re-clicking "Draw a wall"
    // between every single segment). Disarming now happens only where it is a DELIBERATE act: the
    // button again (toggles off, `brancherOutilsMurs`), Escape while no gesture is running
    // (`gestes/clavier.ts`, the Walls-mode branch), or leaving Walls mode
    // (`setWallsMode`/`v5SyncTools` below). The toolbar button's `.pri` class and `aria-pressed`
    // (`v5SetDraw`) already track the armed state continuously, so staying armed stays VISIBLE.
    const d = draft;
    if (!d || Math.hypot(d[1][0] - d[0][0], d[1][1] - d[0][1]) < 20) { render(ctx); return; }
    v5TryCreateWall(ctx, d[0], d[1], { libre, brut });
  };
  // G-12. Escape: the drawing in progress is abandoned, no wall is created.
  const cancel = (): void => { draft = null; };
  window.addEventListener("pointermove", move);
  armGesture(up, null, cancel);
}

// =================================================================================================
//  TOOL 4: OUTLINE EDITING
// =================================================================================================
// Reuses v4's orthogonal snap (orthoSnapVertex / drawOrthoGuides). Interior walls
// follow through re-traversal (`v5AfterGeometry`), so a wall resting against a moved outline wall stays
// stuck to it.

/**
 * G-3. A CLICK ON A VERTEX SELECTS IT, IT DOES NOT WRITE. Same rule as the outline wall: the vertex
 * used to push history right at `pointerdown` and fire off a `v5AfterGeometry(true)` on release,
 * EVEN without the slightest movement. Measured on the real floor plan, a single click on the top-left
 * corner lengthened a partition by 90 cm three meters away from there, cut a room in two (9.6 m² -> 7.7 +
 * 1.9), moved a radiator by 114 cm, and recorded all of it. The pointer must have
 * moved by at least 3 px for anything at all to be pushed into history or recomputed.
 */
export function v5StartVertexDrag(ctx: Contexte, e: PointerEvent, i: number): void {
  if (measureMode() || spaceHeld()) return;
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const poly = ctx.etat.plan.outline;
  const v0 = poly[i];
  if (!v0) return;
  beginGesture();
  ctx.crochets.dragStart?.();
  ctx.selVtx = i; v5SelectWall(ctx, null);
  const sx = v0[0], sy = v0[1];
  const px0 = e.clientX, py0 = e.clientY;
  let moved = false;
  const move = (ev: PointerEvent): void => {
    if (!moved && Math.hypot(ev.clientX - px0, ev.clientY - py0) >= 3) {
      moved = true;
      pushHistory(ctx);          // history only makes sense if there is really a gesture
    }
    if (!moved) return;
    const cm = evtApt(ctx, ev);                      // pure APARTMENT space
    // Ctrl/Cmd (`sansGrille`): same "no grid" key as the edge, the wall, furniture and openings.
    const step = (ctx.etat.opts.snap && !sansGrille(ev)) ? 5 : 1;
    const lx = Math.round(cm.x / step) * step, ly = Math.round(cm.y / step) * step;
    const o = orthoSnapVertex(poly, i, lx, ly, ev.shiftKey, sx, sy, ctx.vue.scale);
    poly[i] = [Math.round(o.x), Math.round(o.y)];
    drawOrthoGuides(ctx, o.guides);
    v5AfterGeometry(ctx, false);
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    clearStitchGuides(ctx);
    if (!moved) {
      // CLEAN CLICK: the vertex is SELECTED (it can be removed with Delete), nothing else.
      poly[i] = [sx, sy];
      render(ctx); endGesture();
      ctx.crochets.dragEnd?.();
      return;
    }
    v5AfterGeometry(ctx, true); endGesture();
    ctx.crochets.dragEnd?.();
  };
  // G-12. Escape: the vertex goes back.
  const cancel = (): void => { poly[i] = [sx, sy]; moved = false; clearStitchGuides(ctx); };
  window.addEventListener("pointermove", move);
  armGesture(up, null, cancel);
}

/**
 * G-3. SELECTING NEVER MODIFIES ANYTHING. A simple click on an outline wall must not cost a
 * `v5AfterGeometry(true)`: this recomputation re-traverses every wall, recuts the cells and re-bounds
 * the furniture. On the real floor plan, a click without the slightest movement cut the outline wall in two,
 * lengthened a kitchen partition by 90 cm three meters away from there, took the apartment from
 * 10 to 11 rooms and moved 16 pieces of furniture, without a word.
 * Now: as long as the pointer hasn't moved, NOTHING is pushed into history, NOTHING is
 * recomputed, and release only executes `onClick` (typically: selecting the outline wall).
 */
export function v5StartOutlineEdgeDrag(
  ctx: Contexte,
  e: PointerEvent,
  i: number,
  onClick?: (() => void) | null,
): void {
  if (measureMode() || spaceHeld()) return;
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const poly = ctx.etat.plan.outline, n = poly.length;
  const j = (i + 1) % n;
  const pi = poly[i], pj = poly[j];
  if (!pi || !pj) return;
  const a0: Pt = [pi[0], pi[1]], b0: Pt = [pj[0], pj[1]];
  const s = v5Seg({ a: a0, b: b0 });
  beginGesture();
  ctx.crochets.dragStart?.();
  ctx.selVtx = -1;
  const g0 = evtApt(ctx, e);                         // pure APARTMENT space
  const d0 = (g0.x - a0[0]) * s.nx + (g0.y - a0[1]) * s.ny;
  const px0 = e.clientX, py0 = e.clientY;
  let moved = false;
  const move = (ev: PointerEvent): void => {
    if (!moved && Math.hypot(ev.clientX - px0, ev.clientY - py0) >= 3) {
      moved = true;
      pushHistory(ctx);          // history only makes sense if there is really a gesture
      v5SelectWall(ctx, null);
    }
    if (!moved) return;
    const cm = evtApt(ctx, ev);
    let d = (cm.x - a0[0]) * s.nx + (cm.y - a0[1]) * s.ny - d0;
    // Alt = free partition (unchanged). Ctrl/Cmd (`sansGrille`) is the SAME escape hatch as
    // furniture and openings: one key to remember for "no grid," without taking Alt away from
    // free-drawing.
    if (ctx.etat.opts.snap && !ev.altKey && !sansGrille(ev)) {
      const na = [a0[0] + s.nx * d, a0[1] + s.ny * d];
      if (Math.abs(s.nx) > 0.99) d += (Math.round(na[0]! / 5) * 5 - na[0]!) / s.nx;
      else if (Math.abs(s.ny) > 0.99) d += (Math.round(na[1]! / 5) * 5 - na[1]!) / s.ny;
      else d = Math.round(d / 5) * 5;
    }
    poly[i] = [Math.round(a0[0] + s.nx * d), Math.round(a0[1] + s.ny * d)];
    poly[j] = [Math.round(b0[0] + s.nx * d), Math.round(b0[1] + s.ny * d)];
    v5AfterGeometry(ctx, false);
    // THE TWO NEIGHBORING OUTLINE WALLS ARE DIMENSIONED TOO. Pushing an outline wall doesn't change ITS
    // length, it translates, but it changes the length of the two walls resting on it: that is exactly the
    // measurement being sought by pushing it. Showing only its own dimension shows the only one that doesn't
    // move. We add the interior partitions touching the moved edge, for the same reason.
    const av = (i - 1 + poly.length) % poly.length;   // edge ending on vertex i
    const ap = (j + 1) % poly.length;                 // edge starting from vertex j
    const cotes: Array<Pick<Mur, "a" | "b">> = [
      { a: poly[i]!, b: poly[j]! },
      { a: poly[av]!, b: poly[i]! },
      { a: poly[j]!, b: poly[ap]! },
    ];
    for (const q of v5MursTouchant(ctx.etat.plan, { id: "__arete__", a: poly[i]!, b: poly[j]! })) {
      cotes.push({ a: q.a, b: q.b });
    }
    v5DrawWallDims(ctx, cotes);
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    v5ClearDims(ctx);
    if (!moved) {
      // CLEAN CLICK: the outline hasn't moved by a centimeter, so NOTHING is recomputed. No
      // v5AfterGeometry, no re-traversal of walls, no re-bounding of furniture.
      poly[i] = [a0[0], a0[1]]; poly[j] = [b0[0], b0[1]];
      endGesture();
      ctx.crochets.dragEnd?.();
      if (onClick) onClick();
      return;
    }
    v5AfterGeometry(ctx, true);
    endGesture();
    ctx.crochets.dragEnd?.();
  };
  const cancel = (): void => {
    poly[i] = [a0[0], a0[1]]; poly[j] = [b0[0], b0[1]];
    moved = false; v5ClearDims(ctx);
  };
  window.addEventListener("pointermove", move);
  armGesture(up, null, cancel);
}

// ---- THE "+" HANDLE (G-15) --------------------------------------------------------------------
// The "+" used to sit at the exact center of each outline wall, ON TOP of the wall. A click meant to
// select the outline wall would therefore land on it and insert a corner: it is this insertion, and the
// global recomputation that follows it, that used to rewrite the whole plan in one click. The two are separated
// PHYSICALLY: the outline wall keeps its full length for selection and dragging, and the "+" lives
// 18 px OUTSIDE the outline, where nothing else competes for the pointer.
// The outward normal (`outlineOutward`) lives in `rendu/calque.ts`, with its sole taker.

/** The OUTLINE wall that mirrors edge `i` of the outline (`v5SyncOutlineWalls` keeps them paired). */
/** The INDEX of the outline edge carried by this outline wall, or -1. Reverse of `v5OutlineWallAt`. */
export function v5OutlineIndexOf(ctx: Contexte, w: Mur | null | undefined): number {
  const P = ctx.etat.plan;
  if (!P || !w || !w.isOutline || !Array.isArray(P.outline)) return -1;
  const poly = P.outline;
  const d = (p: Pt, q: Pt): number => Math.hypot(p[0] - q[0], p[1] - q[1]);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    if (d(w.a, a) + d(w.b, b) < 2 || d(w.a, b) + d(w.b, a) < 2) return i;
  }
  return -1;
}

export function v5OutlineWallAt(ctx: Contexte, i: number): Mur | null {
  const P = ctx.etat.plan;
  if (!P) return null;
  const poly = P.outline, a = poly[i], b = poly[(i + 1) % poly.length];
  if (!a || !b) return null;
  const d = (p: Pt, q: Pt): number => Math.hypot(p[0] - q[0], p[1] - q[1]);
  return (P.walls || []).find((w) => w.isOutline
    && (d(w.a, a) + d(w.b, b) < 2 || d(w.a, b) + d(w.b, a) < 2)) || null;
}

/** Clean click on an outline wall: we SELECT, period. No geometry moves. */
export function v5SelectOutlineEdge(ctx: Contexte, i: number): void {
  const w = v5OutlineWallAt(ctx, i);
  v5SelectWall(ctx, w ? w.id : null);
  const card = $("roomCard");
  if (card && !card.hidden) syncCellCard(ctx);
  render(ctx);
}

/** The "+" acts on RELEASE: moving away by more than 6 px, or Escape, cancels the insertion. */
export function v5StartInsertHandle(ctx: Contexte, e: PointerEvent, i: number): void {
  if (measureMode() || spaceHeld()) return;
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const px0 = e.clientX, py0 = e.clientY;
  let away = false;
  const move = (ev: PointerEvent): void => {
    if (Math.hypot(ev.clientX - px0, ev.clientY - py0) >= 6) away = true;
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    if (!away) v5InsertVertex(ctx, i);
  };
  const cancel = (): void => { away = true; };
  window.addEventListener("pointermove", move);
  armGesture(up, null, cancel);
}

export function v5InsertVertex(ctx: Contexte, i: number): void {
  const poly = ctx.etat.plan.outline, n = poly.length;
  const a = poly[i], b = poly[(i + 1) % n];
  if (!a || !b) return;
  pushHistory(ctx);
  poly.splice(i + 1, 0, [Math.round((a[0] + b[0]) / 2), Math.round((a[1] + b[1]) / 2)]);
  ctx.selVtx = i + 1;
  v5AfterGeometry(ctx, true); save(ctx);
}

export function v5DeleteVertex(ctx: Contexte, i: number): void {
  const poly = ctx.etat.plan.outline;
  if (poly.length <= 3) { toast("An outline needs at least 3 corners.", { geste: true }); return; }
  pushHistory(ctx);
  poly.splice(i, 1); ctx.selVtx = -1;
  v5AfterGeometry(ctx, true); save(ctx);
}

// =================================================================================================
//  TOOL PRIORITY, DURING THE CAPTURE PHASE (G-14)
// =================================================================================================
// The outline's handles (outline wall, vertex, "+", delete cross) listen to `pointerdown` on
// themselves and cut the propagation. A partition drawing started ON a wall (which is what
// the tooltip asks for, "drag from one wall to another") therefore never reached `v5StartDraw`:
// the user would drag the OUTLINE WALL across the apartment, 15 m² reduced to a 20 cm strip,
// without a word. We settle it UPSTREAM, in capture: an ARMED tool wins over all handles.

export function v5CaptureDown(ctx: Contexte, e: PointerEvent): void {
  if (!v5On(ctx)) return;
  if (e.button !== undefined && e.button !== 0) return;
  const t = e.target as Element | null;
  if (!t || !t.closest || !t.closest(".v5layer")) return;
  if (measureMode() || spaceHeld()) {
    // Measuring / panning are ALSO armed tools: under them, a handle must especially
    // not trigger a deletion or an insertion under the cursor.
    if (t.closest(".v5wx") || (spaceHeld() && t.closest(".mid,.vx"))) e.stopPropagation();
    return;
  }
  // An ARMED tool wins over ALL the outline's handles (outline wall band, vertex, "+", cross).
  // The old version only diverted the "+": a drawing started on the outline wall band
  // still reached v5StartOutlineEdgeDrag, and a simple click there triggered a
  // v5AfterGeometry(true) that lengthened a partition three meters away from there.
  if (ctx.ihm.draw) {
    e.stopPropagation();
    if (ctx.ihm.drawFree) v5StartFreeDraw(ctx, e);
    else v5StartDraw(ctx, e);
    return;
  }
}

// =================================================================================================
//  LAYER LISTENING: walls / cells / drawing
// =================================================================================================

export function v5LayerDown(ctx: Contexte, e: PointerEvent): void {
  if (!v5On(ctx) || measureMode() || spaceHeld()) return;
  if (e.button !== undefined && e.button !== 0) return;
  if (ctx.ihm.draw) {
    if (ctx.ihm.drawFree) v5StartFreeDraw(ctx, e);
    else v5StartDraw(ctx, e);
    return;
  }
  const t = e.target as Element | null;
  if (t && t.closest && t.closest(".piece,.vtx,.mid,.edge,.v5wx,.v5wend")) return;
  const wallEl = (t && t.closest) ? t.closest<HTMLElement>("[data-w]") : null;
  if (wallEl && ctx.wallsMode) {
    // An outline wall does not drag by its band (it follows the outline): it gets SELECTED.
    // Before, this click did nothing at all, not even a selection.
    const w = v5WallById(ctx, wallEl.dataset["w"]);
    if (w && w.isOutline) { e.stopPropagation(); v5SelectWall(ctx, wallEl.dataset["w"]); render(ctx); return; }
    v5StartWallDrag(ctx, e, wallEl.dataset["w"]); return;
  }
  const cellEl = (t && t.closest) ? t.closest<HTMLElement>("[data-c]") : null;
  if (cellEl) { e.stopPropagation(); v5SelectCell(ctx, cellEl.dataset["c"], ctx.wallsMode); return; }
}

export function v5LayerDbl(ctx: Contexte, e: MouseEvent): void {
  if (!v5On(ctx)) return;
  const t = e.target as Element | null;
  if (t && t.closest && t.closest(".piece")) return;
  if (!ctx.wallsMode) { e.preventDefault(); setWallsMode(ctx, true); }
}

// =================================================================================================
//  v5 TOOLBAR (js/54)
// =================================================================================================

export function v5SyncTools(ctx: Contexte): void {
  const on = v5On(ctx) && ctx.wallsMode;
  const bSeg = $("btnDrawWall");
  if (bSeg) bSeg.hidden = !on;
  const bLibre = $("btnDrawWallFree");
  if (bLibre) bLibre.hidden = !on;
  if (!on && ctx.ihm.draw) v5SetDraw(ctx, false);
}

// =================================================================================================
//  GLOBAL FURNITURE <-> WALLS TOGGLE (js/23)
// =================================================================================================
// Walls mode shows the OUTLINE's handles and makes walls grabbable; furniture is frozen
// and the room card (cell) replaces the inspector.
// G-12: leaving this mode in silence is indistinguishable from a glitch (measured: 16 walls clicked in
// a row with no effect, incident filed as "not reproducible"). The Escape message lives in the
// keyboard batch, which calls this function.

export function setWallsMode(ctx: Contexte, on: boolean): void {
  on = !!on;
  if (on === ctx.wallsMode) return;
  ctx.crochets.crumb?.("mode", on ? "murs" : "meubles");
  ctx.wallsMode = on;
  // any selection and any guide fall away on a mode change
  clearSel(ctx); ctx.selVtx = -1; ctx.crochets.hideInspector?.(); clearGuides(ctx);
  const bf = $("btnModeFurn"), bw = $("btnModeWalls");
  if (bf) { bf.classList.toggle("pri", !on); bf.setAttribute("aria-pressed", on ? "false" : "true"); }
  if (bw) { bw.classList.toggle("pri", on); bw.setAttribute("aria-pressed", on ? "true" : "false"); }
  const pal = $("palette");
  if (pal) pal.classList.toggle("disabled", on);       // palette inert while editing walls
  const hint = $("wallsHint");
  if (hint) hint.hidden = !on;                         // banner: mode visible, furniture locked
  if (on) ctx.crochets.showHint?.("walls");            // hint on first entry into Walls mode
  const card = $("roomCard");
  if (on) {
    ctx.editRoom = true;                 // outline handles
    if (card) card.hidden = false;
    syncCellCard(ctx);
    render(ctx); checkShapeWarn(ctx);
  } else {
    if (card) card.hidden = true;
    v5SetDraw(ctx, false); ctx.editRoom = false; ctx.selVtx = -1; v5SelectWall(ctx, null);
    checkShapeWarn(ctx);       // wallsMode dropped back down: the warning turns off
    render(ctx); ctx.crochets.analyser?.();
  }
  v5SyncTools(ctx);
}

// =================================================================================================
//  THE WIRING
// =================================================================================================
// THE `ctx.gestes.*` TABLE IS FILLED ELSEWHERE, AND THAT IS DELIBERATE: `gestes/branchement.ts` is the
// ONLY place that fills it, for both families at once (furniture and openings share
// the stack arbiter, G-10). The outline's handles refer back to this file's functions there.
//
// So what remains here is what does NOT go through the render's table, because these are listeners set
// once on nodes that aren't part of the layer:
//   - the CAPTURE phase on the canvas (G-14), which must precede all handles;
//   - the "Draw a wall" toolbar button.
// To be called ONCE at bootstrap, after `brancherGestes`.

export function brancherOutilsMurs(ctx: Contexte): void {
  // G-14. IN CAPTURE, on the canvas: an armed tool passes BEFORE all handles.
  ctx.canvas.addEventListener("pointerdown", (e) => v5CaptureDown(ctx, e as PointerEvent), true);
  const b = $("btnDrawWall");
  if (b) b.addEventListener("click", () => {
    v5SetDraw(ctx, !(ctx.ihm.draw && !ctx.ihm.drawFree), false);
    render(ctx);
  });
  const bLibre = $("btnDrawWallFree");
  if (bLibre) bLibre.addEventListener("click", () => {
    v5SetDraw(ctx, !(ctx.ihm.draw && ctx.ihm.drawFree), true);
    render(ctx);
  });
  // The Furniture / Walls segmented control. In the old client it was wired FROM js/29
  // (the config modal), i.e. three files away from the function it calls:
  // the application's most visible button lived inside a module with nothing to do with it. It is
  // now wired right next to `setWallsMode`.
  $("btnModeFurn")?.addEventListener("click", () => setWallsMode(ctx, false));
  $("btnModeWalls")?.addEventListener("click", () => setWallsMode(ctx, true));
  // "Delete wall" from the cell card. The REST of the card (name, flooring) belongs to the
  // panels batch; this particular button triggers a geometry GESTURE, so it is wired here.
  $("rcDel")?.addEventListener("click", () => v5DeleteSelectedWall(ctx));

  // EXACT LENGTH OF A PARTITION. We stretch the FREE end, not both: the other end is
  // almost always a junction with a neighboring wall, and moving it would break the room next door.
  // "Free" = the end that touches no other wall; if BOTH touch, we stretch `b`, which is
  // the end drawn second, hence the one the hand placed last.
  numField($("rcLen"), {
    label: "The wall length", unit: "cm",
    bounds: () => ({ min: 10, max: 3000 }),
    get: () => {
      const w = ctx.ihm.selWall ? v5WallById(ctx, ctx.ihm.selWall) : null;
      return w ? Math.round(v5Seg(w).L) : null;
    },
    set: (v: number) => {
      const P = ctx.etat.plan;
      const w = ctx.ihm.selWall ? v5WallById(ctx, ctx.ihm.selWall) : null;
      if (!P || !w) return;
      // AN OUTLINE WALL IS ADJUSTED BY MOVING THE NEXT ONE, not by stretching its own ends.
      //
      // The outline is a CLOSED POLYGON: lengthening an edge by pushing its end would make
      // the next edge OBLIQUE, so a rectangle would stop being a rectangle on the first
      // typed number. By translating the next edge along ours, it stays PARALLEL to
      // itself: the right angles hold, and that's exactly what dragging an outline wall
      // already does (`v5StartOutlineEdgeDrag`), keyboard aside.
      if (w.isOutline) {
        const idx = v5OutlineIndexOf(ctx, w);
        const poly = P.outline;
        if (idx < 0 || !Array.isArray(poly) || poly.length < 3) return;
        const A = poly[idx]!, B = poly[(idx + 1) % poly.length]!;
        const L0 = Math.hypot(B[0] - A[0], B[1] - A[1]);
        if (L0 < 1) return;
        const ux = (B[0] - A[0]) / L0, uy = (B[1] - A[1]) / L0;
        const d = v - L0;
        if (!d) return;
        pushHistory(ctx);
        const j = (idx + 1) % poly.length, k = (idx + 2) % poly.length;
        poly[j] = [v5R2(poly[j]![0] + ux * d), v5R2(poly[j]![1] + uy * d)];
        poly[k] = [v5R2(poly[k]![0] + ux * d), v5R2(poly[k]![1] + uy * d)];
        v5AfterGeometry(ctx, true);
        render(ctx); save(ctx);
        return;
      }
      const s2 = v5Seg(w);
      if (!s2.L) return;
      const touche = v5MursTouchant(P, w);
      const TOL = 3;
      const colle = (p: Pt): boolean =>
        touche.some((q) => Math.hypot(q.a[0] - p[0], q.a[1] - p[1]) <= TOL
                        || Math.hypot(q.b[0] - p[0], q.b[1] - p[1]) <= TOL);
      const bougeB = !colle(w.b) || colle(w.a);   // we prefer to move `b`, unless it's the only one welded
      pushHistory(ctx);
      if (bougeB) w.b = [v5R2(w.a[0] + s2.ux * v), v5R2(w.a[1] + s2.uy * v)];
      else w.a = [v5R2(w.b[0] - s2.ux * v), v5R2(w.b[1] - s2.uy * v)];
      // A partition given an imposed length becomes FREE: without this, `v5ThroughWall` would
      // immediately lengthen it back to the first barrier and the typed number would have been useless.
      w.free = 1;
      v5ThroughWall(P, w);
      v5RebuildCells(P); bornerLesMeubles(ctx); v5Touch(ctx);
      render(ctx); save(ctx);
    },
  });

  // THROUGH <-> FREE. Toggling RECOMPUTES the geometry: switching to free doesn't shorten the
  // wall (it's already extended, and shortening it by force would make a partition you could
  // see disappear), but switching to through LENGTHENS it right away, otherwise the setting would say nothing
  // on screen and you'd have to guess that it will act "later."
  //
  // Switching to Through sets `w.free = 0`, it does NOT delete the key. A deleted key and a wall
  // that never used this control at all became BYTE-IDENTICAL on the wire (`v5WallWire`), so the
  // field-by-field diff had no way to tell "never set" from "just cleared", and the CLEAR never
  // reached a peer: the author saw Through, the peer kept showing Free, forever, until a full
  // resync. `0` is a real value the server already understands and already normalizes to the
  // same storage as absence (`WALL_FREE`, `live-worker/ops.ts`), so nothing downstream changes;
  // only the wire, in between, finally gets to carry the clear.
  for (const [id, libre] of [["rcThrough", false], ["rcFree", true]] as const) {
    $(id)?.addEventListener("click", () => {
      const P = ctx.etat.plan;
      const w = ctx.ihm.selWall ? v5WallById(ctx, ctx.ihm.selWall) : null;
      if (!P || !w || w.isOutline) return;
      if (!!w.free === libre) return;
      pushHistory(ctx);
      w.free = libre ? 1 : 0;
      v5ThroughWall(P, w);
      v5RebuildCells(P); bornerLesMeubles(ctx); v5Touch(ctx);
      render(ctx); save(ctx);
    });
  }
}

// =================================================================================================
//  THE ONLY POINT THAT REPLACES THE LIVE GEOMETRY
// =================================================================================================
// Ported from src/js/50-v5-rendu.js (`v5SetModel`). It lives HERE and not in `rendu/` because it doesn't
// paint: it WRITES the plan (import, server adoption, restoration, test seed), and
// rendering has no right to write. An INCOMING plan can carry exactly overlapping walls:
// invisible, they throw off the cell count and make "Delete wall" incomprehensible.
// We purge them here, at the single point that replaces the live geometry.

export function v5SetModel(
  ctx: Contexte,
  plan?: PlanV5 | null,
  opts?: { keepView?: boolean } | null,
): { model: string; cells: number } {
  if (plan !== undefined) {
    const p = sanitizeV5Plan(plan);
    if (!p) return { model: String(ctx.etat.model), cells: 0 };
    ctx.etat.plan = p; v5DedupeWalls(p); ctx.rev++;
  }
  ctx.canvas.classList.add("v5");
  const l = ctx.canvas.querySelector<HTMLElement>(".v5layer"); if (l) delete l.dataset["sig"];
  const P = ctx.etat.plan;
  if (P && (!P.cells || !P.cells.length)) v5RebuildCells(P);
  if (!ctx.ihm.selCell && P.cells.length) ctx.ihm.selCell = String(P.cells[0]!.id);
  clearSel(ctx); ctx.crochets.hideInspector?.();
  render(ctx);
  renderRoomChips(ctx);
  // C-17 / R-16: a remote op NEVER reframes the view of someone who is working.
  if (!(opts && opts.keepView)) fitView(ctx);
  return { model: String(ctx.etat.model), cells: ((P && P.cells) || []).length };
}
