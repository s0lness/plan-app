// src/ts/gestes/trace-libre.ts — FREEHAND WALL TRACE: the gesture.
// The pure half (simplify, straighten, which ends are free) lives in
// `geometrie/trace-libre.ts` and is tested there, without a browser. This file is the impure
// half: capture the pointer path, then turn it into a CHAIN of walls in ONE undo step.
//
// WHY THIS FILE DOES NOT IMPORT FROM `./murs.ts`, EVEN THOUGH IT DUPLICATES A FEW LINES FROM IT
// (selecting the just-drawn wall, bounding orphaned furniture): `murs.ts` must import THIS file
// (to arm the tool from its own capture-phase and layer pointer-down handlers, and to wire the
// toolbar button), and a cycle between the two is exactly the shape of bug this codebase has
// already been bitten by three times (AGENTS.md, "Blank startup, the number one trap"). The few
// duplicated lines are the price of keeping the module graph a DAG.
//
// G-1: arms through `armGesture`, never listens to `pointerup` itself.
// G-13: a gesture that produces nothing SAYS why, on every attempt.
// "A press-release without movement never writes, anywhere": a click with the tool armed
// creates nothing, same as the single-segment tool.
// THE TOOL STAYS ARMED across strokes (2026-08-14, same owner's decision as the single-segment
// tool): this file used to disarm itself on every release via an injected `onDone` callback,
// which no longer exists. Disarming is now entirely `murs.ts`'s job (the button again, Escape,
// pressing Escape while idle) and this file has nothing left to call back into it for.

import type { Contexte } from "../app/contexte.ts";
import { v5Touch } from "../app/contexte.ts";
import type { Mur, Pt } from "../partage/plan.ts";
import { TRACE_LIBRE_MIN_CM, WALL } from "../noyau/nombres.ts";
import { strokeLength, traceToWallSegments } from "../geometrie/trace-libre.ts";
import { v5RebuildCells } from "../modele/cellules.ts";
import { v5ClampPieces, v5ThroughWall } from "../modele/edition.ts";
import { render } from "../rendu/rendu.ts";
import { aptToScreen, evtApt } from "../rendu/vue.ts";
import { resolveColor } from "../rendu/couleurs.ts";
import { syncCellCard } from "../rendu/fiche-cellule.ts";
import { $ } from "../noyau/dom.ts";
import { save } from "../app/persistance.ts";
import { toast } from "../app/toast.ts";
import { pushHistory } from "../historique/pile.ts";
import { armGesture } from "./sortie.ts";
import { v5NewId } from "../fil/identite.ts";

/** Same visual language as the single-segment tool's own draft line (`gestes/murs.ts`), extended
 * to a polyline: one `.gline` per run, inside the same `.v5draftwrap` container/CSS, so nothing
 * new needs styling. */
function dessinerTraceLibre(ctx: Contexte, pts: readonly Pt[]): void {
  effacerTraceLibre(ctx);
  if (pts.length < 2) return;
  const cont = document.createElement("div");
  cont.className = "ov-guides v5draftwrap";
  for (let i = 1; i < pts.length; i++) {
    const a = aptToScreen(ctx, pts[i - 1]![0], pts[i - 1]![1]);
    const b = aptToScreen(ctx, pts[i]![0], pts[i]![1]);
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
  }
  ctx.canvas.appendChild(cont);
}

function effacerTraceLibre(ctx: Contexte): void {
  ctx.canvas.querySelectorAll(".v5draftwrap").forEach((n) => n.remove());
}

/** Same wrapper as `bornerLesMeubles` (`gestes/murs.ts`): mass-bound only the orphans, say so. */
function bornerLesMeublesTrace(ctx: Contexte): void {
  const bilan = v5ClampPieces(ctx.etat.plan);
  if (bilan.message) toast(bilan.message);
}

/** Same body as `v5SelectWall` (`gestes/murs.ts`): select the wall, resync the card if it is open. */
function selectionnerMurTrace(ctx: Contexte, id: string): void {
  ctx.ihm.selWall = id;
  v5Touch(ctx);
  const card = $("roomCard");
  if (card && !card.hidden) syncCellCard(ctx);
}

/**
 * Turns a captured raw pointer path into a chain of walls, in ONE `pushHistory` / one
 * `v5RebuildCells` / one `save()`, so `Ctrl+Z` removes the whole chain at once. A stroke too
 * short to be a wall (a click, or a wiggle under `TRACE_LIBRE_MIN_CM`) is REFUSED and SAYS SO
 * (G-13): silence here would read as a bug in the click itself, not as "nothing to draw".
 */
function creerChaineDeMurs(ctx: Contexte, rawPts: readonly Pt[], libre: boolean): Mur[] | null {
  const P = ctx.etat.plan;
  if (!P) return null;
  if (strokeLength(rawPts) < TRACE_LIBRE_MIN_CM) {
    toast("This stroke is too short to become a wall.", { geste: true });
    return null;
  }
  const segments = traceToWallSegments(rawPts, libre);
  if (!segments.length) {
    toast("This stroke is too short to become a wall.", { geste: true });
    return null;
  }
  pushHistory(ctx);
  // IDS ARE ASSIGNED AND PUSHED ONE AT A TIME, in the same loop: `v5NewId` numbers by reading
  // what is ALREADY in `P.walls` (`radicauxUtilises`, fil/identite.ts). Assigning every id first
  // via `.map()` and pushing afterward made every wall in the chain read the SAME "next free
  // number", so a 2-wall corner silently created two DIFFERENT wall objects sharing ONE id
  // (`v5WallById` then always resolved to the first, and the second was invisible to selection,
  // undo diffing, and this very function's own caller). One wall enters the plan before the next
  // one is numbered.
  const created: Mur[] = [];
  for (const s of segments) {
    const w: Mur = { id: v5NewId("w"), a: s.a, b: s.b, t: WALL, isOutline: false };
    if (s.free) w.free = 1;
    P.walls.push(w);
    created.push(w);
  }
  created.forEach((w) => v5ThroughWall(P, w));
  v5RebuildCells(P);
  bornerLesMeublesTrace(ctx);
  v5Touch(ctx);
  selectionnerMurTrace(ctx, String(created[created.length - 1]!.id));
  render(ctx);
  save(ctx);
  return created;
}

/**
 * Arms the freehand tool for ONE stroke. THE TOOL STAYS ARMED across strokes (owner's decision,
 * same as the single-segment tool in `murs.ts`'s own `v5StartDraw`: re-clicking the button
 * between every wall was the #1 complaint about drawing a room). Disarming is therefore no longer
 * this function's job; it happens only where it is a deliberate act (the button again, Escape,
* pressing Escape while idle), all owned by `murs.ts`. The `onDone` callback this used to take has no
 * more work to do and was removed rather than kept as a no-op parameter.
 */
export function v5StartFreeDraw(ctx: Contexte, e: PointerEvent): void {
  const P = ctx.etat.plan;
  if (!P) return;
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const a0 = evtApt(ctx, e);
  const pts: Pt[] = [[a0.x, a0.y]];
  let libre = !!e.altKey;
  const px0 = e.clientX, py0 = e.clientY;
  let moved = false;
  const move = (ev: PointerEvent): void => {
// G-3-style threshold: the same 3px the other wall gestures use before deciding a gesture
    // is really underway (the wall drag, the vertex drag, the outline edge drag, `gestes/murs.ts`).
    if (!moved && Math.hypot(ev.clientX - px0, ev.clientY - py0) < 3) return;
    moved = true;
    libre = !!ev.altKey;
    const cm = evtApt(ctx, ev);
    pts.push([cm.x, cm.y]);
    dessinerTraceLibre(ctx, pts);
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    effacerTraceLibre(ctx);
    if (!moved) { render(ctx); return; } // a clean click creates nothing, same as the segment tool
    creerChaineDeMurs(ctx, pts, libre);
  };
  // G-12. Escape: the stroke in progress is abandoned, no wall is created; the tool stays armed
  // (same as the single-segment tool's own cancel).
  const cancel = (): void => { moved = false; effacerTraceLibre(ctx); };
  window.addEventListener("pointermove", move);
  armGesture(up, null, cancel);
}
