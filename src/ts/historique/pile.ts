// src/ts/historique/pile.ts: UNDO / REDO, IN MEMORY, NEVER PERSISTED.
// Ported from src/js/27-historique.js (`snapshot`, `histNoteRemoteOp`, `histReplay`, `pushHistory`,
// `applyReplacedState`, `restore`, `undo`, `redo`, `updateHistBtns`).
//
// C-9. A CTRL+Z UNDOES ONLY ITS AUTHOR'S WORK. Before: `undo()` replayed a COMPLETE
// snapshot and published it as a replacement (`plan5.replace`). Since ops received from the other
// person NEVER entered the history, the snapshot was by construction blind to everything she had
// done since the last local action: her furniture would move back, her renaming would vanish, on BOTH
// screens, without a word. Fixed in two steps, both carried here:
//   1. REPLAY: the peers' ops taken since the snapshot are replayed ON TOP (`histReplay`).
//   2. PUBLISHING BY DIFF: `applyReplacedState(..., {keepShadow:true})` lets the mirror describe
//      the SERVER, so the final `save()` only emits the entities that changed.
//
// G-3. `pushHistory()` is NOT pushed on `pointerdown` but on the FIRST REAL MOVEMENT (exception:
// Alt+drag, whose duplicate is born at pointerdown, so the snapshot must come first). It's
// the caller who upholds this rule: this module only makes it cheap (a snapshot
// identical to the previous one doesn't create an entry).

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

function updateHistBtns(): void {
  const u = $("btnUndo") as HTMLButtonElement | null;
  const r = $("btnRedo") as HTMLButtonElement | null;
  if (u) u.disabled = !undoStack.length;
  if (r) r.disabled = !redoStack.length;
}

/**
 * Logs an op COMING FROM A PEER. `plan5.replace` replaces the whole shared plan (import,
 * conversion, old client): none of our snapshots describe a past of THIS plan anymore, so we clear
 * the history rather than offer an undo that would resurrect a dead plan.
 */
export function histNoteRemoteOp(op: Op | null | undefined): void {
  if (!op || !op.kind) return;
  if (op.kind === "plan5.replace") {
    histLog.length = 0; undoStack.length = 0; redoStack.length = 0; updateHistBtns(); return;
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
    updateHistBtns();
  }
}

// `ctx` is here ONLY for the PERSONAL SETTINGS (D-7). A history snapshot carries
// no `opts` at all (`serialize()` never writes any), so reading it back without them would fall
// the whole screen back to defaults on every Ctrl+Z: layers turned back on, the Circulation panel
// reopened, categories re-expanded.
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
  if (dernier && dernier.s === snap) { redoStack.length = 0; updateHistBtns(); return; }
  undoStack.push({ s: snap, m: histLog.length });
  if (undoStack.length > HIST_MAX) undoStack.shift();
  redoStack.length = 0;
  updateHistBtns();
}

/**
 * G-3 + G-12. Called right after a gesture's own `cancel()` has restored the pre-gesture state
 * (Escape). If that gesture had pushed a history entry on its first real movement (the ordinary
 * `pushHistory()` pattern shared by drag, rotate, wall/vertex/opening drag and resize), the top of
 * the undo stack now describes EXACTLY the current state: popping it costs nothing, and keeping it
 * would waste the next `Ctrl+Z` on a no-op, pushing the action the person actually meant to undo
 * one step further away. The comparison is the SAME string equality `pushHistory()` already uses
 * to dedupe, so this only ever removes an entry that is byte-identical to now: a gesture whose
 * `cancel()` did not fully restore the original state (there is none today, but never say never)
 * simply keeps its entry, exactly as before this function existed.
 */
export function jeterHistoriqueVide(ctx: Contexte): void {
  const top = undoStack[undoStack.length - 1];
  if (top && top.s === snapshot(ctx)) { undoStack.pop(); updateHistBtns(); }
}

export interface OptionsRemplacement {
  /**
   * DO NOT resync the outgoing mirror onto the new state: it then keeps describing what
   * the SERVER holds, and the final `save()` publishes the entity-by-entity difference instead
   * of a whole plan. That's what UNDO wants; adopting a server plan and importing,
   * on the other hand, do resync.
   */
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
  // Reasserts the UI from the PERSONAL SETTINGS: `ctx.etat.opts` is the same object as before the
  // replacement, so these lines can never adopt the options of a received plan (D-7).
  const cl = $("optLabels") as HTMLInputElement | null; if (cl) cl.checked = !!ns.opts.labels;
  renderRoomChips(ctx, true);
  // The mirror follows the freshly adopted state, EXCEPT for an undo (see `keepShadow`).
  if (!(opts && opts.keepShadow)) ctx.crochets.resyncMiroir?.();
  render(ctx);
  save(ctx);
  ctx.crochets.analyser?.();
}

/**
 * Restoring an entry: snapshot + peers' ops replayed on top, then published BY
 * DIFF (`keepShadow`), never a `plan5.replace` that would resurrect a whole plan of which our
 * snapshot doesn't know half.
 */
function restore(ctx: Contexte, entry: Entree): void {
  const ns = histReplay(ctx, entry); if (!ns) return;
  applyReplacedState(ctx, ns, { keepShadow: true });
}

export function undo(ctx: Contexte): void {
  if (!undoStack.length) return;
  redoStack.push({ s: snapshot(ctx), m: histLog.length });
  restore(ctx, undoStack.pop()!);
  updateHistBtns();
}

export function redo(ctx: Contexte): void {
  if (!redoStack.length) return;
  undoStack.push({ s: snapshot(ctx), m: histLog.length });
  restore(ctx, redoStack.pop()!);
  updateHistBtns();
}

/** Wiring for the two toolbar buttons. Called once at startup. */
export function brancherBoutonsHistorique(ctx: Contexte): void {
  $("btnUndo")?.addEventListener("click", () => undo(ctx));
  $("btnRedo")?.addEventListener("click", () => redo(ctx));
  updateHistBtns();
}
