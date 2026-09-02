// src/ts/historique/pile.ts: UNDO / REDO, IN MEMORY, NEVER PERSISTED.
//
// C-9: Ctrl+Z undoes only its author's work. Fixed in two steps, both carried here: (1) REPLAY,
// the peers' ops taken since the snapshot are replayed on top (`histReplay`); (2) PUBLISH BY
// DIFF, `applyReplacedState(..., {keepShadow:true})` so `save()` only emits changed entities.
//
// G-3: `pushHistory()` is pushed on the FIRST REAL MOVEMENT, not `pointerdown` (exception:
// Alt+drag). The caller upholds this; this module only makes it cheap (dedupe on the snapshot).

import type { Contexte } from "../app/contexte.ts";
import type { Op, PlanV5 } from "../partage/plan.ts";
import { $ } from "../noyau/dom.ts";
import { migrate } from "../modele/etat.ts";
import { histApplyOp } from "./rejeu.ts";
import { save, serialize } from "../app/persistance.ts";
import { fileEtatDistant, gesteActif } from "../gestes/sortie.ts";
import { clearGuides } from "../gestes/guides.ts";
import { render } from "../rendu/rendu.ts";
import { renderRoomChips } from "../rendu/puces-rail.ts";

const HIST_MAX = 60;
const HIST_LOG_MAX = 800;

interface Entree { s: string; m: number }

let undoStack: Entree[] = [];
let redoStack: Entree[] = [];
/** The PEERS' ops, in application order. Our own ops come back to us as an echo: excluded. */
let histLog: Op[] = [];

const snapshot = (ctx: Contexte): string => JSON.stringify(serialize(ctx));

export function histInfo(): { undo: number; redo: number; log: number } {
  return { undo: undoStack.length, redo: redoStack.length, log: histLog.length };
}

/**
 * Logs an op COMING FROM A PEER. `plan5.replace` replaces the whole shared plan (import,
 * conversion, old client): none of our snapshots describe a past of THIS plan anymore, so we clear
 * the history rather than offer an undo that would resurrect a dead plan.
 */
export function histNoteRemoteOp(op: Op | null | undefined): void {
  if (!op || !op.kind) return;
  if (op.kind === "plan5.replace") {
    histLog.length = 0; undoStack.length = 0; redoStack.length = 0; return;
  }
  // Nothing to undo: nobody will ever replay what follows, the log starts over from zero.
  if (!undoStack.length && !redoStack.length) { histLog.length = 0; return; }
  histLog.push(op);
  if (histLog.length > HIST_LOG_MAX) {
    // The log is bounded. We cut from the head, and DROP the history entries that could
    // no longer be replayed faithfully: losing an undo step is nothing compared
    // to silently destroying the other person's work.
    const cut = histLog.length - HIST_LOG_MAX;
    histLog = histLog.slice(cut);
    const keep = (e: Entree): boolean => e.m >= cut;
    undoStack = undoStack.filter(keep); redoStack = redoStack.filter(keep);
    undoStack.forEach((e) => { e.m -= cut; }); redoStack.forEach((e) => { e.m -= cut; });
  }
}

// `ctx` is here ONLY for the PERSONAL SETTINGS (D-7): a snapshot carries no `opts`, so reading it
// back without them would fall the screen back to defaults on every Ctrl+Z.
function histReplay(ctx: Contexte, entry: Entree): ReturnType<typeof migrate> {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(entry.s) as Record<string, unknown>; } catch (_) { return null; }
  const P = raw["plan"] as PlanV5 | undefined;
  if (P) for (let i = entry.m; i < histLog.length; i++) histApplyOp(P, histLog[i]);
  // `serialize()` ALSO writes the flat plan (server shape) next to `plan`. `migrate` gives
  // priority to `plan`: we remove the duplicates rather than patch them twice.
  if (P) { delete raw["outline"]; delete raw["walls"]; delete raw["openings"]; delete raw["pieces"]; delete raw["cells"]; }
  return migrate(raw, ctx.etat.opts);
}

/** Captures the CURRENT state BEFORE a mutation. Clears the redo stack. */
export function pushHistory(ctx: Contexte): void {
  const snap = snapshot(ctx);
  const dernier = undoStack[undoStack.length - 1];
  if (dernier && dernier.s === snap) { redoStack.length = 0; return; }
  undoStack.push({ s: snap, m: histLog.length });
  if (undoStack.length > HIST_MAX) undoStack.shift();
  redoStack.length = 0;
}

/**
 * G-3/G-12: called right after a gesture's `cancel()` (Escape) has restored the pre-gesture
 * state. If a history entry was pushed on the gesture's first move, the top of the undo stack now
 * describes EXACTLY the current state: pop it, or the next Ctrl+Z wastes itself on a no-op.
 */
export function jeterHistoriqueVide(ctx: Contexte): void {
  const top = undoStack[undoStack.length - 1];
  if (top && top.s === snapshot(ctx)) { undoStack.pop(); }
}

export interface OptionsRemplacement {
  /** DO NOT resync the outgoing mirror onto the new state: `save()` then publishes the
   * entity-by-entity difference instead of a whole plan. What UNDO wants; import/adoption resync. */
  keepShadow?: boolean;
}

/**
 * Complete, safe replacement of the state. Shared by `restore()` (undo/redo), import and
 * synchronization. Does NOT push history (callers decide) and does not alert.
 */
export function applyReplacedState(
  ctx: Contexte,
  ns: ReturnType<typeof migrate>,
  opts?: OptionsRemplacement | null,
): void {
  if (!ns || !ns.plan) return;
  // C-17. During a local gesture, replacing the whole state would lose the gesture (the dragged
  // object is no longer in the live plan): we QUEUE it, gesture exit applies it.
  if (gesteActif()) { fileEtatDistant(ns, opts || null); return; }
  if (ns.setupDone === undefined) ns.setupDone = true;
  ctx.etat = ns;
  ctx.rev++;
  // A real plan has just arrived: the first-use assistant no longer has a reason to be.
  ns.setupDone = true;
  ctx.canvas.classList.add("v5");
  { const l = ctx.canvas.querySelector<HTMLElement>(".v5layer"); if (l) delete l.dataset["sig"]; }
  if (!ctx.ihm.selCell && ns.plan.cells.length) ctx.ihm.selCell = String(ns.plan.cells[0]!.id);
  ctx.selection.ids.clear(); ctx.selection.primaire = null; ctx.selVtx = -1;
  ctx.crochets.hideInspector?.();
  clearGuides(ctx);
  // Reasserts the UI from PERSONAL SETTINGS (D-7): can never adopt a received plan's options.
  const cl = $("optLabels") as HTMLInputElement | null; if (cl) cl.checked = !!ns.opts.labels;
  renderRoomChips(ctx, true);
  // The mirror follows the freshly adopted state, EXCEPT for an undo (see `keepShadow`).
  if (!(opts && opts.keepShadow)) ctx.crochets.resyncMiroir?.();
  render(ctx);
  save(ctx);
  ctx.crochets.analyser?.();
}

/** Restoring an entry: snapshot + peers' ops replayed on top, then published BY DIFF
 * (`keepShadow`), never a `plan5.replace` (C-9). */
function restore(ctx: Contexte, entry: Entree): void {
  const ns = histReplay(ctx, entry); if (!ns) return;
  applyReplacedState(ctx, ns, { keepShadow: true });
}

export function undo(ctx: Contexte): void {
  if (!undoStack.length) return;
  redoStack.push({ s: snapshot(ctx), m: histLog.length });
  restore(ctx, undoStack.pop()!);
}

export function redo(ctx: Contexte): void {
  if (!redoStack.length) return;
  undoStack.push({ s: snapshot(ctx), m: histLog.length });
  restore(ctx, redoStack.pop()!);
}

/** Wiring for the two File-menu entries (decision 0015). No disabled-state tracking: `undo()`/
 * `redo()` already no-op on an empty stack. */
export function brancherBoutonsHistorique(ctx: Contexte): void {
  $("btnMenuUndo")?.addEventListener("click", () => undo(ctx));
  $("btnMenuRedo")?.addEventListener("click", () => redo(ctx));
}
