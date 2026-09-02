// src/ts/gestes/murs.ts: select, drag and draw walls, then edit the outline from a facade.
// Ported from src/js/53-v5-outils.js (everything, EXCEPT the OPENING drag which lives in `ouverture.ts`),
// from src/js/54-v5-interface.js (the handle WIRING, whose rendering already lives
// in `rendu/calque.ts`) and from src/js/52 for the single
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
//   G-12 ESCAPE cancels the gesture and puts the object back EXACTLY in place. Each gesture supplies
//        its own `onCancel`.
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
import { photoCellules } from "../modele/photo-cellules.ts";
import {
  v5CanDeleteWall,
  v5ClampOpenings,
  v5ClampPieces,
  v5FlushOpeningsBorned,
  v5BoutLibre,
  v5SnapPoint,
  v5SnapWallEnd,
  v5SyncOutlineWalls,
  v5BornerAuLogement,
  v5WallMergeAt,
  v5CouperContour,
  v5IndexAreteContour,
  v5MurDeTravers,
  v5MurTraverse,
  v5WallMergeCandidate,
  v5WallSplitAt,
  v5WallSplitAtPoint,
  v5WallSplitRefusal,
  v5WallCovering,
  v5DerivedId,
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
import { armGesture, beginGesture, endGesture, gesteActif } from "./sortie.ts";
import { measureMode, spaceHeld } from "./etat-pointeur.ts";
import { clearGuides, drawWallGuides } from "./guides.ts";
// THE WALL TOOL'S GRAMMAR, pure and testable without a browser: what a click MEANS in a chain.
// Where the point lands (the magnets) stays here, because that needs the plan.
import type { OutilMur } from "./outil-mur.ts";
import { outilMurALongueur, outilMurFin, outilMurNeuf, outilMurPoint } from "./outil-mur.ts";
// SYMBOLS EXPECTED FROM A MODULE THAT HAS NO AUTHOR YET (src/js/15-edition-murs.js):
// the outline's orthogonal snap, its guides, and the "walls cross" alert. Outline editing
// can't do without them (`v5StartVertexDrag` and `v5AfterGeometry` call them), and js/15
// belongs to no batch of the project: flagged to the coordinator.
import type { GuideOrtho } from "./edition-murs.ts";
import { aimantFacade, checkShapeWarn, clearStitchGuides, drawOrthoGuides, orthoSnapVertex } from "./edition-murs.ts";
// C-8. `v5NewId` (js/51) draws a device tag from the realtime socket or from
// `sessionStorage`: without it, two people drawing a partition at the same instant would get the
// same `w20` and every other wall would disappear without a word. This is not a function of the plan,
// hence its own separate module.
import { v5NewId } from "../fil/identite.ts";
// THE 45-DEGREE TABLE, pure (`geometrie/angles.ts`, no `Contexte`, no DOM): the wall-endpoint
// drag below quantises a dragged end's direction with it rather than a hand-rolled `cos`/`sin`
// (which would reintroduce the `1.2246e-16` trap that table exists to avoid). No cycle risk: the
// pure `geometrie/` module imports nothing from `gestes/`.
import { DIR8, quantizeAngleDeg } from "../geometrie/angles.ts";

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
 * G-8. Mass bounding recalibrates ONLY orphaned furniture, and it SAYS SO: a piece that MOVED
 * on its own, with nobody's hand on it, is not the kind of thing the drawing alone explains
 * (decision 0014, "l'app se tait" keeps this one, unlike a gesture's own visible result).
 */
export function bornerLesMeubles(ctx: Contexte): number {
  const bilan = v5ClampPieces(ctx.etat.plan);
  if (bilan.message) toast(bilan.message);
  return bilan.perdus;
}

/**
 * SUPPRIMER LA BARRE D'UN T REFERME LA COUPE QU'ELLE AVAIT FAITE. Demande du proprietaire: il trace
 * un mur dans un autre, ce qui coupe le second en deux; en supprimant le premier, la coupe doit
 * disparaitre avec lui, sinon le plan garde la cicatrice d'un mur qui n'existe plus.
 *
 * C'est exactement la regle du « - », appliquee toute seule: on ne ressoude que si le joint
 * n'appartient plus qu'a DEUX murs qui se continuent, ce que `v5WallMergeCandidate` verifie deja.
 * S'il reste un troisieme mur, ou si les deux ne sont pas alignes, on ne touche a rien.
 */
function v5RessouderJoints(ctx: Contexte, joints: readonly Pt[]): void {
  const P = ctx.etat.plan;
  if (!P) return;
  for (const pt of joints) {
    for (const x of [...(P.walls || [])]) {
      if (x.isOutline) continue;
      const bout = (["a", "b"] as const).find((k) => Math.hypot(x[k][0] - pt[0], x[k][1] - pt[1]) <= 2);
      if (!bout) continue;
      if (!v5WallMergeCandidate(P, x.id, bout)) break;
      v5WallMergeAt(P, x.id, bout);
      break;
    }
  }
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
  const joints: Pt[] = [[w.a[0], w.a[1]], [w.b[0], w.b[1]]];
  const k = P.walls.indexOf(w);
  if (k >= 0) P.walls.splice(k, 1);
  v5RessouderJoints(ctx, joints);
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
function v5MursTouchant(P: PlanV5 | null | undefined, w: Pick<Mur, "id" | "a" | "b">): Mur[] {
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

function v5DrawDraft(ctx: Contexte, seg: readonly [Pt, Pt] | null): void {
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

function v5ClearDraft(ctx: Contexte): void {
  ctx.canvas.querySelectorAll(".v5draftwrap").forEach((n) => n.remove());
}

// =================================================================================================
//  AFTER A GEOMETRY CHANGE (js/52)
// =================================================================================================

/**
 * THE GEOMETRY PIPELINE ITSELF, no screen effects: re-sync the outline walls, bring back inside
 * the home any wall end that left it, keep openings inside their wall, and (`final`) rebuild the
 * cells. NOTHING HERE LENGTHENS A WALL (decision 0012): a wall goes from `a` to `b`. Extracted out
 * of `v5AfterGeometry` (below) so a headless test can drive the SAME pipeline without a DOM
 * (`ctx.canvas`, `render()`, `document`) in the loop, exactly how `v5WallDragCtx`/
 * `v5WallDragApply` above are already tested directly, `tests/jonction-glisser-mur.ts`. Pure
 * function of the plan.
 */
export function v5ResoudreGeometrie(P: PlanV5 | null | undefined, final: boolean): void {
  if (!P) return;
  v5SyncOutlineWalls(P);
  (P.walls || []).forEach((w) => { if (!w.isOutline) v5BornerAuLogement(P, w); });
  v5ClampOpenings(P);
  recalculerCellules(P, final);
}

/**
 * LE SOL SUIT LA MAIN. Les murs suivaient la main image par image, mais le SOL est peint à partir
 * des CELLULES (`renderFond`), et les cellules n'étaient recalculées qu'au relâchement
 * (`if (final)`): le fond restait immobile pendant tout le geste, puis sautait. Mesuré sur le plan
 * réel (22 murs, 10 cellules), une façade poussée de 1090 à 1320 cm: le modèle suivait bien en
 * direct, 60 images par seconde tenues, mais la surface peinte restait à g=1098 d=1269 aux 20
 * paliers du glissement, puis sautait à g=659 d=1089 au relâchement. Le garde-fou économisait
 * **0,40 ms de médiane** (0,7 ms au p90, 1,6 ms au pire, sur 30 appels) sur un budget d'image de
 * 16,7 ms, dont un `render()` complet prend déjà 2,3 ms: il ne payait rien.
 *
 * Deux choses restent réservées au relâchement, et ce sont les deux qui ÉCRIVENT quelque chose
 * d'irréversible: le bornage des meubles (C-11, il appartient à l'auteur du geste) et le nettoyage
 * des murs en doublon (`enDirect`, voir `OptionsRecalcul`). Les noms de pièces, eux, sont appariés
 * depuis la PHOTO d'avant-geste, à chaque image comme au relâchement.
 */
function recalculerCellules(P: PlanV5 | null | undefined, final: boolean): void {
  if (!P) return;
  v5RebuildCells(P, { depuis: photoCellules(P), enDirect: !final });
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
// (`v5WallDragCtx`), never re-evaluated mid-drag, re-deciding it on every frame would let a wall
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
// line, and it PIVOTS, measured, a follower at 45° opened to 63° after a 50 cm push. Worse, for a
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
//      no third option, no fallback that carries it some other way, a wall in an apartment plan
//      is never diagonal by accident.
//   2. A follower moves ONLY IF it would otherwise be left touching NOTHING: if its touching point
//      is still within 2 cm of some OTHER wall's endpoint or flank, or of the facade (the SAME
//      tolerance junction detection itself uses), after the dragged wall leaves, it is already
//      held there and STAYS EXACTLY WHERE IT IS, sliding it to chase the dragged wall would tear
//      open whatever it is still attached to. This is checked FIRST, from the geometry at
//      `pointerdown` (only the dragged wall moves, and it is excluded from the check, so "held
//      after it leaves" and "held right now, ignoring it" are the same question); intersection is
//      attempted only for a follower that clears it.
// Rule 1 is why intersection is used AT ALL (a fraction cannot keep a direction); rule 2 is why it
// is not used UNCONDITIONALLY (an already-held neighbor sliding to "correctly" meet the dragged
// wall would rip the room it is still forming with its OTHER neighbor). Combined, three walls
// meeting at one point, a dragged wall, a perpendicular neighbor, and a third wall continuing
// that neighbor in a straight line to the facade, all stay exactly as drawn except the one being
// dragged: the other two hold each other, so neither one is in the void, so neither one moves,
// and the dragged wall simply comes to rest against the flank of whichever of them it now
// overlaps. Nothing tears, nothing tilts. See `docs/decisions/` for the two contradictory owner
// reports this reconciles.
//
// A follower whose own line is near-parallel to the dragged wall's new line (`sin < 0.09`, ~5°,
// covers the exact-collinear case) has no USABLE intersection either way (two near-parallel lines
// meet arbitrarily far away): rule 1 then gives "does not move" directly, without consulting rule
// 2, sliding along a direction the dragged wall's line barely deviates from is not meaningfully
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
// dragged wall's OWN end would leave the apartment, `v5BornerAuLogement` brings it back; that is
// unrelated to this follower list and unchanged by it.
//
// CHAINS ARE ONE HOP, DELIBERATELY: if A meets B and B meets C, dragging B carries A and C (their
// near ends, touching B), but dragging A carries ONLY B, C is not touching A, so it is not in
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
 * dragged wall `w` and the follower `x` itself, another wall's endpoint or flank, or a facade
 * wall (outline walls are ordinary entries of `P.walls`, so they fall out of this same scan for
 * free)? Only `w` moves during this gesture, and it is excluded here, so "held once w has left"
 * and "held right now, ignoring w" are the same question, this can be decided ONCE, from the
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
  v5BornerAuLogement(P, w);
  const wl = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) || 1e-9;
  const wux = (w.b[0] - w.a[0]) / wl, wuy = (w.b[1] - w.a[1]) / wl;
  followers.forEach((f) => {
    // RULE 2 first: already held by someone other than the dragged wall, stays exactly in place,
    // no matter its angle. Sliding it to "correctly" meet the dragged wall would tear open
    // whatever it is still attached to (see the header for the three-wall reproduction).
    if (f.tenu) return;
    // RULE 1: an unheld follower keeps its OWN direction, it slides ALONG THAT DIRECTION to meet
    // the dragged wall's new line (ordinary intersection), or it does not move. Never a fraction,
    // never any other vector: that is what used to tilt it. Near-parallel (`sin < 0.09`, ~5°) has
    // no usable intersection (two near-parallel lines meet arbitrarily far away) and is exactly the
    // collinear case: it does not move either, and, being unheld, DETACHES. An accepted loss
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
  // RULE 3: A JUNCTION THAT WOULD BREAK IS BRIDGED, NOT TORN. Rules 1 and 2 say when a follower
  // may move and when it must not; neither of them can save the junction when the follower is held
  // elsewhere, or when it is collinear with the wall being pushed (two parallel lines never meet).
  // Until now that case simply detached, and `docs/decisions/0005` called the visible gap an
  // accepted loss. The owner asked for the third answer, twice and with pictures: push a wall that
  // continues into another one, and a SEGMENT SHOULD APPEAR to keep them joined, turning the tear
  // into a step. It is better than both of the answers we had, because nothing is lost and nothing
  // silently tilts.
  //
  // Only on the FINAL apply. Bridging on every pointer move would spawn a wall per frame; the
  // gesture shows the gap opening, which is honest, and closes it on release.
  // The bridging is called by the GESTURE on release, deliberately not from here: this function's
  // `final` is ALSO what CANCEL uses to put everything back, and building walls while someone
  // abandons a gesture is the last thing anyone wants.
  v5ClampOpenings(P);
  // Le sol suit la main ici aussi: pousser une cloison recoupe les deux pièces qu'elle sépare à
  // chaque image (`recalculerCellules`). Le bornage des meubles, lui, reste au relâchement.
  recalculerCellules(P, final);
  if (final) bornerLesMeubles(ctx);
  v5Touch(ctx);
  return w;
}

/** The bridging half of rule 3: one segment per junction that the gesture has pulled apart. */
function v5PontsDeJonction(ctx: Contexte, g: ContexteGlisserMur, ponts: Map<Suiveur, Mur>): void {
  const P = ctx.etat.plan;
  const { w, followers } = g;
  if (!P) return;
  for (const f of followers) {
    // Where the contact point WOULD be if it had ridden along with the wall: the same fraction of
    // the wall it was touching. For a perpendicular push this is the old point plus the offset, so
    // the bridge comes out perpendicular too, which is the step the owner drew.
    const cible: Pt = [
      v5R2(w.a[0] + f.t * (w.b[0] - w.a[0])),
      v5R2(w.a[1] + f.t * (w.b[1] - w.a[1])),
    ];
    const p = f.x[f.k];
    const ecart = Math.hypot(p[0] - cible[0], p[1] - cible[1]);
    // Still touching: rule 1 moved it, or the push was too small to separate anything. A junction
    // that did not break needs no bridge. And it may still be touching the wall SOMEWHERE ELSE
    // along its length, which is a perfectly good junction: a wall sliding along its own line
    // keeps meeting the same flank.
    const inutile = ecart <= 2
      || closestOnSeg(p[0], p[1], w.a[0], w.a[1], w.b[0], w.b[1]).dist <= 2;
    const dejaLa = ponts.get(f);
    if (inutile) {
      // The push came back: the bridge that was following the hand goes away with it.
      if (dejaLa) { P.walls = (P.walls || []).filter((q) => q !== dejaLa); ponts.delete(f); }
      continue;
    }
    // ONE bridge per junction, MOVED, not one per frame. The owner asked to see it while dragging
    // rather than at the release, and the naive way to do that would push a new wall on every
    // pointer move. The wall is created once and its two ends follow the hand.
    if (dejaLa) { dejaLa.a = [p[0], p[1]]; dejaLa.b = cible; dejaLa.t = w.t || WALL; continue; }
    // Built here rather than through `v5TryCreateWall`, which pushes its own history entry,
    // reselects and saves: all three are wrong in the middle of another gesture's final apply,
    // which has already pushed one history entry for the whole move.
    //
    // Same thickness as the wall being moved, so the step reads as one piece of masonry rather
    // than two. It used to be marked `free` so the through rule would not stretch it away from the
    // very joint it exists to hold; no wall stretches any more (decision 0012), so the bridge is
    // an ordinary wall like every other.
    const pont: Mur = {
      id: v5NewId("w"),
      a: [p[0], p[1]],
      b: cible,
      t: w.t || WALL,
      isOutline: false,
    };
    P.walls.push(pont);
    ponts.set(f, pont);
  }
}

function v5StartWallDrag(ctx: Contexte, e: PointerEvent, wallId: unknown): void {
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
  // The bridges of rule 3, kept BY FOLLOWER across the whole gesture so each junction owns one wall
  // that follows the hand, instead of one wall per pointer move.
  const ponts = new Map<Suiveur, Mur>();
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
    // AT THE CENTIMETRE, NOT ON A GRID (decision 0012, after 0011 for furniture). The wall used to
    // be rounded to a 5 cm step, with Alt and Ctrl as two different ways out of it. There is no
    // step left to escape, so there is nothing to hold either key for here.
    const d = (cm.x - a0[0]) * s.nx + (cm.y - a0[1]) * s.ny - d0;
    v5WallDragApply(ctx, g, d, false);
    v5PontsDeJonction(ctx, g, ponts);
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
    if (moved) { v5PontsDeJonction(ctx, g, ponts); recalculerCellules(P, true); bornerLesMeubles(ctx); v5Touch(ctx); }
    render(ctx);
    endGesture();
    ctx.crochets.dragEnd?.();
  };
  // G-12. Escape: the wall (and its T junctions) return to their position from before the gesture.
  const cancel = (): void => {
    // An abandoned gesture leaves NOTHING behind, bridges included.
    if (ponts.size) { P.walls = (P.walls || []).filter((q) => ![...ponts.values()].includes(q)); ponts.clear(); }
    v5WallDragApply(ctx, g, 0, true); moved = false; render(ctx);
  };
  window.addEventListener("pointermove", move);
  armGesture(up, null, cancel);   // guaranteed end (G-1)
}

/** The midpoint handle moves a partition, but only selects a derived facade. */
export function v5StartWallMove(ctx: Contexte, e: PointerEvent, wallId: unknown): void {
  const w = v5WallById(ctx, wallId);
  if (!w) return;
  if (!w.isOutline) { v5StartWallDrag(ctx, e, wallId); return; }
  // UNE FACADE SE PREND PAR SON BOUTON, COMME LES AUTRES MURS. Il ne faisait que SELECTIONNER, en
  // laissant le deplacement a la bande du contour; or cette bande n'a pas de z-index, donc une
  // fenetre posee dessus la recouvrait et la facade devenait insaisissable a cet endroit. Demande
  // du proprietaire: « les boutons pour saisir la facade doivent etre de premiere classe, s'il y a
  // une fenetre a l'endroit du bouton je dois pouvoir saisir le bouton ». Un petit disque au-dessus
  // de tout, qui deplace vraiment, repond aux deux: il gagne le test de clic sur sa propre surface,
  // et il ne vole rien ailleurs le long du mur, ou la fenetre reste la cible.
  const i = v5IndexAreteContour(P0(ctx), String(wallId));
  if (i >= 0) { v5StartOutlineEdgeDrag(ctx, e, i, () => v5SelectOutlineEdge(ctx, i)); return; }
  if (e.button !== undefined && e.button !== 0) return;
  if (spaceHeld() || measureMode()) return;
  e.preventDefault(); e.stopPropagation();
  v5SelectWall(ctx, wallId); render(ctx);
}

/** Raccourci lisible: le plan du contexte. */
const P0 = (ctx: Contexte): PlanV5 | null => ctx.etat.plan || null;

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
// because `v5ResoudreGeometrie` already re-traverses EVERY wall on each frame, the same
// mechanism a vertex drag and an outline edge drag already lean on (`v5AfterGeometry`). A
// neighbor that was resting against this wall reacts to the endpoint's NEW position exactly as
// it would to any other geometry edit; there is nothing extra to decide or carry.
//
// THE END LANDS WHERE IT IS DROPPED, and stays there (decision 0012). There used to be a `free`
// flag to set here, because the through rule would otherwise have undone the placement the instant
// the gesture ended; nothing extends any more, so there is nothing to protect the drop from.
// Connection to another wall is made through SNAPPING (`v5SnapWallEnd`) at drop time, and it does
// not "reconnect" by itself if a neighbor is later dragged away.

/**
 * Where the dragged endpoint lands THIS FRAME, in priority order:
 *   1-3. a junction (another wall's endpoint, a point on another wall's segment, or the same on
 *        the outline) within reach, `v5SnapWallEnd` covers all three as one two-stage cascade,
 *        EXACT, regardless of Alt: a deliberate connection is not something "free hand" mode
 *        should make harder to hit.
 *   4. otherwise, the wall's DIRECTION quantised to the nearest 45° measured from the FIXED end
 *      (`DIR8`/`quantizeAngleDeg`, `geometrie/angles.ts`), unless Alt is held, which frees the
 *      angle, the same meaning Alt already has everywhere else in this file.
 *   5. the result is rounded to the CENTIMETRE, along whichever direction stage 4 picked. There
 *      is no 5 cm step any more (decision 0012), so there is no key to escape one either.
 * Mirrors the wall tool's own precedence (vertex > edge > the bare centimetre) so extending a wall
 * feels identical to drawing one.
 */
export function v5WallEndDrop(
  P: PlanV5 | null | undefined,
  wallId: unknown,
  anchor: Pt,
  x: number,
  y: number,
  echelle: number,
  alt: boolean,
): Pt {
  const snapped = v5SnapWallEnd(P, String(wallId), x, y, echelle);
  if (snapped) return snapped;
  if (alt) return [Math.round(x), Math.round(y)];
  const dx = x - anchor[0], dy = y - anchor[1];
  const dir = DIR8[quantizeAngleDeg(Math.atan2(dy, dx) * 180 / Math.PI) / 45]!;
  const t = Math.round(dx * dir[0] + dy * dir[1]);
  return [v5R2(anchor[0] + dir[0] * t), v5R2(anchor[1] + dir[1] * t)];
}

/**
 * Applies the drop: moves ONLY `bout`, then re-settles the
 * geometry (`final` also rebuilds the cells and bounds furniture). Mirrors `v5WallDragApply`'s
 * own shape exactly, including being safe to call headlessly with a stub `Contexte`
 * (`ctx.etat.plan` and `ctx.canvas.querySelector` only, no `render()`, no `document`), so the
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
  v5ResoudreGeometrie(P, final);
  if (final) bornerLesMeubles(ctx);
  v5Touch(ctx);
  return w;
}

/**
 * A T JUNCTION CUTS THE WALL IT LANDS ON. Owner's request: bringing a wall's end onto another wall
 * must connect them AND cut the wall forming the bar of the T, so its two halves become walls in
 * their own right, each with its handles. Connecting alone already worked, through the snap.
 *
 * Called for BOTH ends of the wall that just moved or was just drawn, because either of them can
 * land on something. A refusal is stated once and does not stop the rest: an opening sitting on the
 * contact point is a good reason not to cut there, and no reason at all to undo the junction.
 */
function v5CouperLesTraverses(ctx: Contexte, w: Mur): void {
  const P = ctx.etat.plan;
  if (!P) return;
  for (const bout of ["a", "b"] as const) {
    const cible = v5MurTraverse(P, w[bout], [w.id]);
    // UNE FACADE SE COUPE AUSSI, et c'est la demande explicite du proprietaire: « le mur exterieur
    // doit se comporter comme les murs normaux ». Une facade n'etant pas stockee comme un mur mais
    // recalculee depuis le contour, la couper veut dire donner un sommet de plus au polygone: les
    // deux moities deviennent deux aretes, chacune deplacable comme n'importe quelle facade.
    if (!cible) { v5CouperContour(P, w[bout]); continue; }
    // ON NE REFUSE PAS CE QUE PERSONNE N'A DEMANDE. La coupe du T est une CONSEQUENCE du geste, pas
    // le geste: la personne a trace un mur, et il est trace. Quand une porte occupe le point de
    // contact, la jonction tient quand meme et seule la coupe n'a pas lieu; annoncer un refus
    // ferait croire que le trace a echoue. Mesure: retracer une cloison sur le plan reel sortait
    // « "Porte 2" crosses that point », alors que la cloison etait bien la. Le resultat n'est donc
    // pas lu: les deux moities sont des murs ordinaires, comme celui qu'elles remplacent.
    v5WallSplitAtPoint(P, cible.id, w[bout]);
  }
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
    const target = v5WallEndDrop(P, w.id, anchor, cm.x, cm.y, ctx.vue.scale, ev.altKey);
    v5WallEndDragApply(ctx, w.id, bout, target, false);
    render(ctx);
    v5DrawWallDims(ctx, [w]);
    ctx.crochets.liveAnalyze?.();
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    v5ClearDims(ctx);
    if (moved) {
      // Le T se coupe AVANT de re-resoudre la geometrie: la coupe cree un mur, et les cellules
      // doivent etre reconstruites sur le plan qui en resulte, pas sur celui d'avant.
      const mur = v5WallById(ctx, wallId);
      if (mur) v5CouperLesTraverses(ctx, mur);
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
  // G-12. Escape: the endpoint returns to where it was before the gesture, then everything
  // touching it re-settles (a neighbor may have reacted to the endpoint while it was away).
  const cancel = (): void => {
    w[bout] = p0;
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
//  THE SELECTED WALL'S SHEET ACTIONS: SPLIT, SQUARE UP
// =================================================================================================
// These two used to be discs floating beside the wall, drawn on HOVER. They are commands on an
// object, so they belong where every other command of an object belongs: in its sheet, next to
// "Delete wall" (decision 0010). What the wall itself carries is only what has to be DRAGGED, and
// dragging is the one thing a sheet cannot do: its two ends and its move handle.
//
// A CLICK THAT ACTS IS NOT A CLICK THAT SLIPS. The repository's rule is that a press-release
// without movement never writes ON THE GEOMETRY: clicking a wall, a corner or a facade must only
// ever select. A sheet button is not geometry, and now it also sits outside the plan entirely, so
// there is nothing left for it to slip onto.

function v5RedresserMurSelectionne(ctx: Contexte): void {
  const P = ctx.etat.plan;
  const wallId = ctx.ihm.selWall;
  if (!P || !wallId) return;
  const r = v5MurDeTravers(P, String(wallId));
  // Le bouton n'existe que là où le redressement est légitime, donc ce refus n'est pas une porte
  // fermée à l'usage: c'est la garde du chemin, pour un identifiant périmé d'une image à l'autre.
  if (!r) return;
  const w = v5WallById(ctx, String(wallId));
  if (!w) return;
  pushHistory(ctx);
  w[r.bout] = r.cible;
  // IL N'Y A PLUS RIEN À GELER (décision 0012). Le redressement devait marquer le mur `free`, sinon
  // le bout qu'on venait de bouger d'1 cm, ne touchant plus rien pendant une image, était envoyé
  // jusqu'à la façade (mesuré: `w3` passait de 154 cm à 716 cm, en silence). Un mur ne court plus:
  // le bout redressé reste où le redressement l'a mis, et le mur d'en face, lui, ne bouge pas non
  // plus, ce qui est la contrepartie assumée (voir le dossier 0012).
  v5SelectWall(ctx, w.id);
  v5ResoudreGeometrie(P, true);
  bornerLesMeubles(ctx);
  v5Touch(ctx);
  render(ctx);
  save(ctx);
  // Le résultat se voit dans le dessin (décision 0014, "l'app se tait"): plus de bandeau de
  // confirmation ici. Un redressement de moins d'un centimètre peut rester indistinguable d'un
  // clic qui n'a rien fait, c'est le compromis assumé.
}

/** SPLIT: the selected wall becomes two halves meeting at its midpoint. */
function v5CouperMurSelectionne(ctx: Contexte): void {
  const P = ctx.etat.plan;
  const wallId = ctx.ihm.selWall;
  if (!P || !wallId) return;
  // UNE FACADE SE COUPE AUSSI, ET PAS PAR LE MEME CHEMIN. Demande du proprietaire: « je peux resize
  // un mur de facade comme je veux, donc je devrais aussi pouvoir le couper ». Une facade n'est pas
  // stockee comme un mur, elle est RECALCULEE depuis le polygone du contour: la couper, c'est
  // inserer un sommet (`v5CouperContour`), et les deux moities deviennent deux aretes portant
  // chacune sa propre prise en son centre. `v5WallSplitAt`, lui, fabriquerait un mur que le
  // prochain `v5SyncOutlineWalls` effacerait.
  const cible = v5WallById(ctx, String(wallId));
  if (cible && cible.isOutline) {
    const L = Math.hypot(cible.b[0] - cible.a[0], cible.b[1] - cible.a[1]);
    // Sous 10 cm, les deux moities tomberaient dans la marge des coins (`MARGE_T`) et la coupe
    // fabriquerait un moignon: on le dit au lieu de ne rien faire.
    if (!(L > 10)) { toast("This facade is too short to split.", { geste: true }); return; }
    const coupe = L / 2;
    const obstacle = (P.openings || []).find((o) =>
      String(o.wallId) === String(cible.id) && o.t0 < coupe && coupe < o.t0 + o.w);
    if (obstacle) {
      toast(`“${obstacle.name || "This object"}” crosses that point, so the facade cannot be cut there.`, { geste: true });
      return;
    }
    const milieu: Pt = [v5R2((cible.a[0] + cible.b[0]) / 2), v5R2((cible.a[1] + cible.b[1]) / 2)];
    pushHistory(ctx);
    if (!v5CouperContour(P, milieu)) { toast("This facade cannot be cut here.", { geste: true }); return; }
    v5AfterGeometry(ctx, true); save(ctx);
    return;
  }
  // The refusals are stated, never swallowed: a facade is derived from the outline and cannot be
  // split, and an opening straddling the midpoint blocks the cut by naming itself.
  const refus = v5WallSplitRefusal(P, String(wallId));
  if (refus) { toast(refus, { geste: true }); return; }
  pushHistory(ctx);
  const division = v5WallSplitAt(P, String(wallId));
  if ("refus" in division) { toast(division.refus, { geste: true }); return; }
  // LES DEUX MOITIÉS N'ONT PLUS BESOIN D'ÊTRE GELÉES (décision 0012). Le joint que la coupe vient
  // de créer est un bout des deux moitiés, et la règle traversante les rallongeait aussitôt l'une
  // à travers l'autre (mesuré: un mur de 277 à 1011 rendait 277..644 et 353..1011, superposés).
  // Rien ne rallonge plus, donc la coupe tient d'elle-même et ne change la nature de rien: il n'y
  // a plus de message à dire.
  v5SelectWall(ctx, wallId);
  v5ResoudreGeometrie(P, true);
  bornerLesMeubles(ctx);
  v5Touch(ctx);
  render(ctx);
  save(ctx);
}

// =================================================================================================
//  TOOL 2: THE WALL TOOL, CLICK BY CLICK
// =================================================================================================
// THE WALL IS A TOOL AGAIN, AND THE FLOOR IS A LASSO AGAIN (decision 0010). Dragging over empty
// space used to draw: that is what every comparable planner does NOT do, and it is what forced
// seven pull requests of 32 px boxes, hover buttons and rules to keep them from stealing each
// other's click. The button arms the tool (W), a click lays the start, a click lays the arrival
// AND starts the next segment, a double-click / Enter / Escape ends the chain.
//
// The chain's GRAMMAR is pure and lives in `gestes/outil-mur.ts`, tested without a browser. What
// stays here is what needs the plan and the DOM: where a point LANDS (the magnets), the live
// length next to the pointer, and the wall's creation.

/** The chain being drawn. One tool, one chain; `v5SetDraw` resets it in BOTH directions. */
let chaine: OutilMur = outilMurNeuf();
/** Digits typed during the trace: they set the segment's length on Enter. */
let saisieLongueur = "";
/** Where the pointer last aimed, in apartment cm: the DIRECTION a typed length uses. */
let visee: Pt | null = null;

/** Is a chain open (a start laid, its arrival still in the air)? Read by the keyboard. */
const traceEnCours = (): boolean => chaine.depart !== null;

/**
 * Arms (or disarms) THE wall tool: one tool, one button, one flag. Disarming also drops whatever
 * chain was open, so re-arming never resumes a run somebody left behind.
 */
export function v5SetDraw(ctx: Contexte, on: boolean): void {
  ctx.ihm.draw = !!on;
  chaine = outilMurNeuf(); saisieLongueur = ""; visee = null;
  v5ClearDraft(ctx); v5ClearDims(ctx); cacherLongueur();
  const bSeg = $("btnDrawWall");
  if (bSeg) {
    bSeg.classList.toggle("pri", ctx.ihm.draw);
    bSeg.setAttribute("aria-pressed", ctx.ihm.draw ? "true" : "false");
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
  // A WALL KEEPS THE ENDS YOU DREW, and that is now true of EVERY wall, not just of the ones the
  // tool made (decision 0012). It used to need a `free` flag set here, because otherwise each end
  // was pushed to the first barrier beyond it and a 60 cm stub shot across the room to the facade.
  // `Alt` keeps its own, unrelated meaning below: no imposed right angle, no magnet.
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
  const w: Mur = { id: v5NewId("w"), a: [a[0], a[1]], b: [b[0], b[1]], t: WALL, isOutline: false };
  P.walls.push(w);
  v5BornerAuLogement(P, w);       // trimmed by the outline only, kept as drawn otherwise
  // Un mur TRACE dans un autre forme un T lui aussi, et doit le couper de la meme facon.
  v5CouperLesTraverses(ctx, w);
  v5RebuildCells(P); bornerLesMeubles(ctx); v5Touch(ctx);
  v5SelectWall(ctx, w.id);
  render(ctx); save(ctx);
  return w;
}

/** The live length, next to the pointer, in the SAME readout the resize gesture already uses. */
function cacherLongueur(): void {
  const r = $("rszReadout");
  if (r) { r.hidden = true; r.removeAttribute("style"); r.hidden = true; }
}

function montrerLongueur(ctx: Contexte, clientX: number, clientY: number, L: number): void {
  const r = $("rszReadout");
  if (!r) return;
  const vr = ctx.viewport.getBoundingClientRect();
  r.hidden = false;
  r.style.left = (clientX - vr.left) + "px";
  r.style.top = (clientY - vr.top) + "px";
  // `saisieLongueur` only ever holds digits (the keyboard filters them in), so there is nothing
  // here that could carry markup.
  r.innerHTML = saisieLongueur
    ? '<span class="axon">' + saisieLongueur + '</span> cm <span class="cap">⏎</span>'
    : String(Math.round(L)) + " cm";
}

/**
 * WHERE THE POINT LANDS. The magnets are ON by default and there is ONE key to cut them:
 *   . `Alt` held cuts EVERY magnet for as long as it is held (the point follows the pointer);
 *   . otherwise a junction wins: another wall's endpoint, an outline corner, or a point on a
 *     wall's own face within reach (`v5SnapWallEnd`, through `v5WallEndDrop`);
 *   . otherwise the direction is quantised to 45° from the chain's start, so 0/90 and the
 *     diagonals come out exact;
 *   . `Shift` narrows that to the two AXES, which is what "force the axis" has always meant here.
 * The very first point of a chain has no direction yet: it only snaps (`v5SnapPoint`).
 */
function pointVise(ctx: Contexte, P: PlanV5, e: { altKey?: boolean; shiftKey?: boolean }, cm: { x: number; y: number }): Pt {
  if (e.altKey) return [Math.round(cm.x), Math.round(cm.y)];
  const depart = chaine.depart;
  if (!depart) return v5SnapPoint(P, cm.x, cm.y, ctx.vue.scale);
  if (e.shiftKey) {
    const dx = cm.x - depart[0], dy = cm.y - depart[1];
    return Math.abs(dx) >= Math.abs(dy)
      ? [v5R2(depart[0] + Math.round(dx)), depart[1]]
      : [depart[0], v5R2(depart[1] + Math.round(dy))];
  }
  return v5WallEndDrop(P, null, depart, cm.x, cm.y, ctx.vue.scale, false);
}

/** A segment shorter than this is a click landing on its own start, not a wall. */
const TRACE_MIN = 20;

/**
 * A PRESS WITH THE TOOL ARMED. The first one lays the start; each one after it closes a segment
 * and immediately reopens the chain there, so a room is drawn without letting go.
 *
 * A press that lands back on the start (under `TRACE_MIN`) is a NO-OP, silently: that is exactly
 * the second half of a double-click, the gesture that ends a chain, and refusing it out loud would
 * make every finished run end with a complaint.
 */
function v5OutilMurAppui(ctx: Contexte, e: PointerEvent): void {
  const P = ctx.etat.plan;
  if (!P) return;
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  if (e.detail >= 2) return;                     // belongs to the double-click that ends the chain
  const cm = evtApt(ctx, e);
  const p = pointVise(ctx, P, e, cm);
  visee = p;
  const depart = chaine.depart;
  if (depart && Math.hypot(p[0] - depart[0], p[1] - depart[1]) < TRACE_MIN) return;
  const r = outilMurPoint(chaine, p);
  chaine = r.etat;
  saisieLongueur = "";
  if (r.segment) v5TryCreateWall(ctx, r.segment[0], r.segment[1], { libre: !!e.altKey, brut: [v5R2(cm.x), v5R2(cm.y)] });
  v5ClearDraft(ctx); v5ClearDims(ctx); cacherLongueur();
}

/** The pointer moving with a chain open: the segment follows, and says how long it is. */
function v5OutilMurSuivi(ctx: Contexte, e: PointerEvent): void {
  const P = ctx.etat.plan;
  const depart = chaine.depart;
  if (!P || !depart) return;
  const cm = evtApt(ctx, e);
  visee = pointVise(ctx, P, e, cm);
  const b = saisieLongueur ? (outilMurALongueur(depart, visee, Number(saisieLongueur)) || visee) : visee;
  v5DrawDraft(ctx, [depart, b]);
  v5DrawWallDims(ctx, [{ a: depart, b }]);
  montrerLongueur(ctx, e.clientX, e.clientY, Math.hypot(b[0] - depart[0], b[1] - depart[1]));
}

/**
 * END OF A CHAIN: double-click, Enter, or Escape. The tool STAYS armed so several runs can be
 * drawn one after another; Escape on a chain that holds nothing is what puts it away. The
 * toolbar button losing its pressed state already shows it (decision 0014, "l'app se tait").
 */
function v5OutilMurFin(ctx: Contexte): void {
  const r = outilMurFin(chaine);
  chaine = r.etat; saisieLongueur = ""; visee = null;
  v5ClearDraft(ctx); v5ClearDims(ctx); cacherLongueur();
  if (r.quitter) v5SetDraw(ctx, false);
  render(ctx);
}

/**
 * THE KEYBOARD WHILE THE TOOL IS ARMED. Digits then Enter place the point at that exact length in
 * the direction currently aimed at, the SAME grammar the resize readout already uses (type, then
 * Enter); Enter on an empty buffer ends the chain, like a double-click. Returns true when the key
 * was consumed, so the general keyboard leaves it alone.
 */
export function v5OutilMurTouche(ctx: Contexte, e: KeyboardEvent): boolean {
  if (!ctx.ihm.draw) return false;
  if (e.key >= "0" && e.key <= "9" && chaine.depart) { saisieLongueur = (saisieLongueur + e.key).slice(0, 4); return true; }
  if (e.key === "Backspace" && saisieLongueur) { saisieLongueur = saisieLongueur.slice(0, -1); return true; }
  if (e.key === "Escape") { v5OutilMurFin(ctx); return true; }
  if (e.key !== "Enter") return false;
  const depart = chaine.depart;
  const L = Number(saisieLongueur);
  const p = (depart && visee && saisieLongueur) ? outilMurALongueur(depart, visee, L) : null;
  if (!p || !depart) { v5OutilMurFin(ctx); return true; }
  const pt: Pt = [v5R2(p[0]), v5R2(p[1])];
  chaine = outilMurPoint(chaine, pt).etat;
  saisieLongueur = "";
  v5TryCreateWall(ctx, depart, pt, null);
  v5ClearDraft(ctx); v5ClearDims(ctx);
  return true;
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
  // UN SOMMET NE PLIE PLUS SES FACADES: IL LES EMMENE. Tirer un coin ne bougeait que lui, donc les
  // deux aretes voisines PIVOTAIENT et une facade droite devenait oblique. Signale a l'usage, image
  // a l'appui: le mur du haut plie en zigzag, avec ses fenetres de travers. Depuis que couper une
  // facade insere un sommet, il y en a beaucoup plus sous la main, donc le defaut est devenu facile
  // a declencher. Decision du proprietaire: les sommets restent sur leurs axes.
  //
  // On retient donc, pour chaque voisin, l'axe le long duquel l'arete partagee est CONSTANTE, et on
  // reporte le mouvement dessus: une arete horizontale le reste, une verticale aussi, et un
  // decrochement reste a angle droit. Une arete deja oblique (un plan ancien, un pan coupe) n'a
  // aucun axe constant: on ne lui impose rien, elle se comporte comme avant.
  //
  // ET ON SUIT LA COURSE ENTIERE, PAS LE SEUL VOISIN. Depuis qu'on coupe les facades, un sommet
  // n'est pas forcement un coin: le point de coupe est un sommet PLAT, dont les deux aretes vont
  // dans le meme sens. N'emmener que lui deplacait la moitie attenante et laissait la suivante en
  // place, donc pliait quand meme (mesure: l'arete [450,60]-[900,0] apres avoir tire le coin
  // haut-gauche). Un pan de facade est une course DROITE: on la remonte de sommet plat en sommet
  // plat, et on s'arrete au premier vrai coin, qui lui absorbe le mouvement en s'allongeant.
  const n = poly.length;
  type Voisin = { p: Pt; axe: "x" | "y" | null; d: [number, number] };
  const axeConstant = (p: Pt, q: Pt): "x" | "y" | null =>
    Math.abs(q[0] - p[0]) < 0.5 ? "x" : (Math.abs(q[1] - p[1]) < 0.5 ? "y" : null);
  const course = (pas: 1 | -1): Voisin[] => {
    const out: Voisin[] = [];
    let k = i, prec: Pt = poly[i]!;
    for (let garde = 0; garde < n - 1; garde++) {
      const kk = (k + pas + n) % n, q = poly[kk]!;
      const axe = axeConstant(prec, q);
      out.push({ p: q, axe, d: [q[0] - sx, q[1] - sy] });
      if (axe === null) break;                      // arete deja oblique: on ne lui impose rien
      if (axeConstant(q, poly[(kk + pas + n) % n]!) !== axe) break;   // vrai coin: la course s'arrete
      prec = q; k = kk;
    }
    return out;
  };
  const voisins: Voisin[] = [...course(-1), ...course(1)];
  const suivreLesVoisins = (nx: number, ny: number): void => {
    for (const v of voisins) {
      if (v.axe === "x") v.p[0] = nx;                 // arete verticale: elle reste verticale
      else if (v.axe === "y") v.p[1] = ny;            // arete horizontale: elle reste horizontale
    }
  };
  const rendreLesVoisins = (): void => {
    for (const v of voisins) { v.p[0] = sx + v.d[0]; v.p[1] = sy + v.d[1]; }
  };
  const px0 = e.clientX, py0 = e.clientY;
  let moved = false;
  const move = (ev: PointerEvent): void => {
    if (!moved && Math.hypot(ev.clientX - px0, ev.clientY - py0) >= 3) {
      moved = true;
      pushHistory(ctx);          // history only makes sense if there is really a gesture
    }
    if (!moved) return;
    const cm = evtApt(ctx, ev);                      // pure APARTMENT space
    // AU CENTIMÈTRE (décision 0012): plus de pas de 5 cm, donc plus de touche pour en sortir.
    const o = orthoSnapVertex(poly, i, Math.round(cm.x), Math.round(cm.y), ev.shiftKey, sx, sy, ctx.vue.scale);
    poly[i] = [Math.round(o.x), Math.round(o.y)];
    suivreLesVoisins(poly[i]![0], poly[i]![1]);
    drawOrthoGuides(ctx, o.guides);
    v5AfterGeometry(ctx, false);
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    clearStitchGuides(ctx);
    if (!moved) {
      // CLEAN CLICK: the vertex is SELECTED (it can be removed with Delete), nothing else.
      poly[i] = [sx, sy]; rendreLesVoisins();
      render(ctx); endGesture();
      ctx.crochets.dragEnd?.();
      return;
    }
    v5AfterGeometry(ctx, true); endGesture();
    ctx.crochets.dragEnd?.();
  };
  // G-12. Escape: the vertex goes back.
  const cancel = (): void => { poly[i] = [sx, sy]; rendreLesVoisins(); moved = false; clearStitchGuides(ctx); };
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
  let j = (i + 1) % n;
  const pi = poly[i], pj = poly[j];
  if (!pi || !pj) return;
  const a0: Pt = [pi[0], pi[1]], b0: Pt = [pj[0], pj[1]];
  const s = v5Seg({ a: a0, b: b0 });
  // THE STARTING SHAPE, kept whole: pushing a facade half can INSERT corners (below), so a clean
  // click and a cancel have to put the polygon AND the wall list back as they were, not just the
  // two endpoints of the dragged edge.
  const i0 = i, j0 = j;
  const poly0: Pt[] = poly.map((p) => [p[0], p[1]] as Pt);
  const murs0: Mur[] = ctx.etat.plan.walls.slice();
  const memePt = (p: Pt, q: Pt): boolean => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1;
  const murArete = ctx.etat.plan.walls.find((w) => w.isOutline
    && ((memePt(w.a, a0) && memePt(w.b, b0)) || (memePt(w.a, b0) && memePt(w.b, a0))));
  const epaisseur = murArete?.t || WALL;
  const restaurer = (): void => {
    poly.length = 0; for (const p of poly0) poly.push([p[0], p[1]]);
    ctx.etat.plan.walls.length = 0; for (const w of murs0) ctx.etat.plan.walls.push(w);
    i = i0; j = j0; coinsPoses = false;
  };
  // A FACADE SLIDES, IT NEVER BENDS. Pushing an edge moves its two ends; a neighbouring edge that
  // continues in the SAME direction (the other half of a cut facade) would then have one end moved
  // and one end still, so it would TILT, and the outline would come out bent (owner's report, an
  // oblique segment across the top facade with its windows askew). At the first real centimeter we
  // therefore INSERT a corner at the old position of that end: the neighbour keeps its direction
  // and the two halves are joined by a right-angle connector, which is the outline version of the
  // junction bridge for partitions (decision record 0007). A neighbour that is PERPENDICULAR just
  // grows or shrinks, which is the ordinary rectangle case, and gets no corner.
  let coinsPoses = false;
  // LE COIN SE POSE SUR LA COUPE DE LA FAÇADE, ET NULLE PART AILLEURS (décision 0012, qui renverse
  // 0009). Il allait chercher, à portée d'aimant, le bout de la cloison qui borde la pièce, et
  // portait avec lui la correction des ouvertures des deux façades, un souvenir pour Échap et un
  // message chiffré. Ça répondait à une géométrie qui n'existe plus de la même façon: la pièce
  // suit maintenant ses murs tels qu'ils sont, et si sa cloison ne tombe pas pile sur la coupe,
  // c'est la coupe qu'on déplace, au « + », en le voyant.
  const poserLesCoins = (d: number): void => {
    coinsPoses = true;
    const m = poly.length;
    const av = (i - 1 + m) % m, ap = (j + 1) % m;
    const parallele = (p?: Pt, q?: Pt): boolean => {
      if (!p || !q) return false;
      const ux = q[0] - p[0], uy = q[1] - p[1], L = Math.hypot(ux, uy);
      return L >= 1 && Math.abs(ux * s.nx + uy * s.ny) / L < 0.02;
    };
    const avant = parallele(poly[av], poly[i]), apres = parallele(poly[j], poly[ap]);
    if (!avant && !apres) return;
    const out: Pt[] = []; let ni = i, nj = j;
    for (let k = 0; k < m; k++) {
      if (k === i && avant) out.push([a0[0], a0[1]]);
      if (k === i) ni = out.length;
      if (k === j) nj = out.length;
      out.push(poly[k]!);
      if (k === j && apres) out.push([b0[0], b0[1]]);
    }
    poly.length = 0; for (const p of out) poly.push(p);
    i = ni; j = nj;
    // The connector wall is created HERE, and not left to `v5SyncOutlineWalls`: an edge it cannot
    // pair falls back on the first free outline wall, which shifts every facade downstream by one
    // AND takes their windows along (measured: 9 openings out of 30 moved by up to 11 m on a single
    // gesture). Same reason, same fix as cutting a facade.
    const P = ctx.etat.plan;
    if (avant) P.walls.push({ id: v5DerivedId(P, "w"), a: [a0[0], a0[1]],
      b: [a0[0] + s.nx * d, a0[1] + s.ny * d], t: epaisseur, isOutline: true });
    if (apres) P.walls.push({ id: v5DerivedId(P, "w"), a: [b0[0] + s.nx * d, b0[1] + s.ny * d],
      b: [b0[0], b0[1]], t: epaisseur, isOutline: true });
  };
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
    // AU CENTIMÈTRE, PUIS L'AIMANT (décision 0012). Il y avait une grille de 5 cm, deux touches
    // pour en sortir, et un aimant qui devait ensuite gagner CONTRE elle pour qu'une façade puisse
    // se poser pile sur la ligne d'une autre. Sans grille, l'aimant est seul: une façade se pose au
    // centimètre, sauf si une façade parallèle est à portée, et Alt le coupe.
    let guide: GuideOrtho | null = null;
    if (!ev.altKey) {
      const aim = aimantFacade(poly0, i0, a0, b0, s.nx, s.ny, d, ctx.vue.scale);
      d = aim.d; guide = aim.guide;
    }
    drawOrthoGuides(ctx, guide ? [guide] : null);
    if (!coinsPoses && Math.abs(d) >= 1) poserLesCoins(d);
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
    v5ClearDims(ctx); clearStitchGuides(ctx);
    if (!moved) {
      // CLEAN CLICK: the outline hasn't moved by a centimeter, so NOTHING is recomputed. No
      // v5AfterGeometry, no re-traversal of walls, no re-bounding of furniture.
      restaurer();
      endGesture();
      ctx.crochets.dragEnd?.();
      if (onClick) onClick();
      return;
    }
    // A CONNECTOR BROUGHT BACK TO ZERO IS NOT A CORNER: pushing a half and putting it back leaves
    // two vertices on the same spot, so the outline would keep an invisible corner per round trip.
    for (let k = poly.length - 1; k >= 0 && poly.length > 3; k--) {
      if (memePt(poly[k]!, poly[(k + 1) % poly.length]!)) poly.splice(k, 1);
    }
    // UNE ENCOCHE REFERMÉE NE SE RESSOUDE PAS TOUTE SEULE, et les deux joints plats qu'elle laisse
    // restent: les retirer FUSIONNERAIT deux façades en une, ce qui change une identité que les
    // ouvertures suivent et une épaisseur qu'elles n'ont pas choisie, et surtout ce qui rendrait
    // l'encoche irréversible (mesuré: à 6 sommets, un glissement du milieu la rouvre telle quelle;
    // à 4, il faut d'abord recouper la façade au « + »). Le maillon, lui, est un geste demandé.
    v5AfterGeometry(ctx, true);
    endGesture();
    ctx.crochets.dragEnd?.();
  };
  const cancel = (): void => {
    restaurer();
    moved = false; v5ClearDims(ctx); clearStitchGuides(ctx);
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
function v5OutlineIndexOf(ctx: Contexte, w: Mur | null | undefined): number {
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

function v5OutlineWallAt(ctx: Contexte, i: number): Mur | null {
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

function v5InsertVertex(ctx: Contexte, i: number): void {
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
// The outline's handles (facade band, vertex, "+", corner cross) listen to `pointerdown` on
// themselves and cut the propagation. A wall drawn starting ON a facade would therefore never
// reach the tool: the user would drag the FACADE across the apartment, 15 m² reduced to a 20 cm
// strip, without a word. We settle it UPSTREAM, in capture: AN ARMED TOOL WINS OVER ALL HANDLES,
// with no exception, which is what makes the rule sayable in one line now that a wall carries no
// button of its own.

function v5CaptureDown(ctx: Contexte, e: PointerEvent): void {
  if (!v5On(ctx)) return;
  if (e.button !== undefined && e.button !== 0) return;
  const t = e.target as Element | null;
  if (!t || !t.closest || !t.closest(".v5layer")) return;
  if (measureMode() || spaceHeld()) {
    // Measuring / panning are ALSO armed tools: under them, a handle must especially
    // not trigger a deletion or an insertion under the cursor.
    if (spaceHeld() && t.closest(".mid,.vx")) e.stopPropagation();
    return;
  }
  if (ctx.ihm.draw) {
    e.stopPropagation();
    v5OutilMurAppui(ctx, e);
  }
}

// =================================================================================================
//  LAYER LISTENING: walls / cells / drawing
// =================================================================================================

export function v5LayerDown(ctx: Contexte, e: PointerEvent): void {
  if (!v5On(ctx) || measureMode() || spaceHeld()) return;
  if (e.button !== undefined && e.button !== 0) return;
  const t = e.target as Element | null;
  if (ctx.ihm.draw) { v5OutilMurAppui(ctx, e); return; }
  if (t && t.closest && t.closest(".piece,.vtx,.mid,.edge,.v5wend,.v5wmove")) return;
  const cellEl = (t && t.closest) ? t.closest<HTMLElement>("[data-c]") : null;
  if (cellEl) { e.stopPropagation(); v5SelectCell(ctx, cellEl.dataset["c"], true); return; }
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
  // A SELECTED WALL SHOWS ITS LENGTH AND CLEARANCES (decision 0015, replacing D-held): wired
  // through the shared `apresRendu` slot, like Circulation's own overlay, rather than reaching
  // into `rendu/calque.ts` (a rendering module that must not import a gesture one back). Skipped
  // during an active gesture: dragging the SAME wall already paints its own live dims
  // (`v5DrawWallDims`, a different container), and no other gesture leaves a wall selected while
  // it runs.
  const apresRenduPrecedent = ctx.crochets.apresRendu;
  ctx.crochets.apresRendu = () => {
    apresRenduPrecedent?.();
    if (gesteActif()) return;
    const w = ctx.ihm.selWall ? v5WallById(ctx, ctx.ihm.selWall) : null;
    if (w) drawWallGuides(ctx, w); else clearGuides(ctx);
  };
  // G-14. IN CAPTURE, on the canvas: an armed tool passes BEFORE all handles.
  ctx.canvas.addEventListener("pointerdown", (e) => v5CaptureDown(ctx, e as PointerEvent), true);
  // THE SEGMENT FOLLOWS THE POINTER while a chain is open. One listener for the life of the app,
  // gated on the tool: a click-click tool has no `pointerup` to hang a teardown on, so adding and
  // removing a listener per segment would be one more thing to get wrong.
  ctx.viewport.addEventListener("pointermove", (e) => {
    if (ctx.ihm.draw && traceEnCours()) v5OutilMurSuivi(ctx, e as PointerEvent);
  }, { passive: true });
  // A DOUBLE-CLICK ENDS THE CHAIN, in capture so it never reaches the rename path underneath.
  ctx.canvas.addEventListener("dblclick", (e) => {
    if (!ctx.ihm.draw) return;
    e.preventDefault(); e.stopPropagation();
    v5OutilMurFin(ctx);
  }, true);
  const b = $("btnDrawWall");
  if (b) b.addEventListener("click", () => {
    v5SetDraw(ctx, !ctx.ihm.draw);
    render(ctx);
  });
  // THE WALL SHEET'S THREE ACTIONS. Split, square up and delete used to be buttons floating over
  // the wall itself, appearing on hover; they are ordinary commands on the selected object, so
  // they live where every other command of an object lives, in its sheet.
  $("rcDel")?.addEventListener("click", () => v5DeleteSelectedWall(ctx));
  $("rcSplit")?.addEventListener("click", () => v5CouperMurSelectionne(ctx));
  $("rcSquare")?.addEventListener("click", () => v5RedresserMurSelectionne(ctx));

  // EXACT LENGTH OF A PARTITION. We stretch the FREE end, not both: the other end is almost always
  // a junction with a neighboring wall, and moving it would break the room next door. "Free" = the
  // end no junction holds (`v5BoutLibre`); if BOTH are free, `b`, the end drawn second, hence the
  // one the hand placed last; if NEITHER is, the field is disabled and the sheet says why.
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
      const bout = v5BoutLibre(P, w);
      if (!bout) return;                          // both ends joined: the field is disabled, G-13
      pushHistory(ctx);
      if (bout === "b") w.b = [v5R2(w.a[0] + s2.ux * v), v5R2(w.a[1] + s2.uy * v)];
      else w.a = [v5R2(w.b[0] - s2.ux * v), v5R2(w.b[1] - s2.uy * v)];
      v5BornerAuLogement(P, w);
      v5RebuildCells(P); bornerLesMeubles(ctx); v5Touch(ctx);
      render(ctx); save(ctx);
    },
  });
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
