// src/ts/app/contexte.ts — THE SMALL BIT OF MUTABLE STATE THAT RENDERING SHARES, in one place.
//
// The old client was a single closure: `state`, `vScale`, `vOx`, `vOy`, `selIds`, `selId`,
// `wallsMode`, `v5Rev` were module variables visible from everywhere, and "everything is visible
// everywhere" was the first coupling listed by `src/README.md`. With real ES modules, an
// exported `let` cannot be reassigned from the outside: so we gather these variables into ONE
// object, passed explicitly. The gain isn't cosmetic, it's mechanical:
//   - who writes to the view is visible in the signature (`ctx.vue.scale = …`);
//   - rendering becomes testable without a global browser: you give it its context;
//   - the VIEW (`vue`) and the PLAN (`etat.plan`) are two distinct fields of the same object, which
//     makes invariant G-2 "the view is not the plan" visible.
//
// WHAT ISN'T HERE: nothing of synchronization, nothing of gestures. Gestures come in their
// own batch, and will wire onto `ctx.gestes` (empty today, see below).

import type { Cellule, Meuble, Mur, Ouverture } from "../partage/plan.ts";
import type { Etat } from "../modele/etat.ts";

// The application state `{plan, opts, setupDone, model}` is defined ONCE, with the reading of
// old formats that builds it (`modele/etat.ts`). Rendering reads it, it does not redefine it.
export type { Etat };

/**
 * The view transform: `screen = origin + cm × scale`. It is NOT a modification of the
 * plan (G-2): no one has the right to persist it or send it over the wire.
 */
export interface Vue {
  /** px per cm */
  scale: number;
  /** px of the apartment origin (cm 0,0) within the viewport */
  ox: number;
  oy: number;
}

/** The UI state of the walls-only model (`v5UI()` in the old client). */
export interface EtatIHM {
  selWall: string | null;
  selCell: string | null;
  draw: boolean;
}

/**
 * The selection model. `ids` is the source of truth, `primaire` is DERIVED (the last one added):
 * they are kept in sync by the functions of `rendu/selection.ts`, never by hand.
 */
export interface Selection {
  ids: Set<string>;
  primaire: string | null;
}

/**
 * The entry points that GESTURES will come and wire up (next batch). Rendering sets the
 * listeners once, at node creation, and calls whatever is wired: a DOM node survives
 * object replacements, the creation closure doesn't, and that's already what the old
 * client did by resolving the piece in the current state at the moment of the click.
 *
 * As long as nothing is wired, a click does NOTHING, and above all writes nothing: "selecting
 * never writes" (G-3) is true by construction at this stage.
 */
export interface Gestes {
  meublePointerDown?: (e: PointerEvent, id: string) => void;
  meubleDblClick?: (e: MouseEvent, id: string) => void;
  /**
   * Double-click on the LABEL (the painted name), not on the object: rename. Separate from
   * `meubleDblClick` (which rotates by 90°) because these are two different intents on two
   * different targets, and because the label exists ONLY if a name has been chosen (R-3): the
   * condition "except when the name is empty" is then true by construction, without a single test.
   */
  etiquetteDblClick?: (e: MouseEvent, id: string, sorte: "piece" | "cell") => void;
  ouverturePointerDown?: (e: PointerEvent, id: string) => void;
  ouvertureDblClick?: (e: MouseEvent, id: string) => void;
  poigneeRedim?: (e: PointerEvent, id: string, poignee: string) => void;
  calquePointerDown?: (e: PointerEvent) => void;
  calqueDblClick?: (e: MouseEvent) => void;
  choisirCellule?: (id: string, ouvrirFiche: boolean) => void;
  cadrerCellule?: (c: Cellule) => void;
  contourAretePointerDown?: (e: PointerEvent, i: number) => void;
  contourInsertionPointerDown?: (e: PointerEvent, i: number) => void;
  contourSommetPointerDown?: (e: PointerEvent, i: number) => void;
  contourSommetSupprimer?: (e: PointerEvent, i: number) => void;
  supprimerMurSelectionne?: (e: PointerEvent) => void;
  /** Placing an object turns its layer back on (G-22, gestes/pose.ts): the toggles follow (js/28). */
  syncLayerToggles?: () => void;
  /** The rail drawer (js/09): an armed placement closes it, otherwise it covers what you're aiming at. */
  railOpen?: (on: boolean) => void;
}

export interface Contexte {
  etat: Etat;
  vue: Vue;
  ihm: EtatIHM;
  selection: Selection;
  /** Global Furniture <-> Walls toggle. Never persisted. */
  wallsMode: boolean;
  /** Outline handles visible (driven by `wallsMode`). */
  editRoom: boolean;
  /** Selected outline vertex during editing, -1 = none. */
  selVtx: number;
  /** Incremented on every plan replacement: invalidates the layer's background cache. */
  rev: number;
  /**
   * Counter of renders WITHOUT PERSISTENCE (pan, zoom, pinch, "Fit",
   * window resize). Measured before: a 40-move pan cost
   * 40 serializations and 854,520 bytes written (G-2).
   */
  viewOnly: number;
  canvas: HTMLElement;
  viewport: HTMLElement;
  gestes: Gestes;
  crochets: Crochets;
}

/**
 * What `render()` calls and which does NOT belong to rendering: persistence (data batch), and
 * Circulation analysis, peer ghosts, cursors, measurements (later batches).
 *
 * The old client called them via `typeof x === "function"`: a guard that says neither who sets the
 * function, nor when. Here absence is an optional field, so it's visible in the type, and rendering
 * cannot call anything that hasn't been wired at bootstrap.
 */
export interface Crochets {
  /** `save()`: ONE local write, never during a gesture nor during a view render (G-2). */
  persister?: (() => void) | undefined;
  /** Everything that follows painting: debounced analysis, ghosts, cursors, measurements. */
  apresRendu?: (() => void) | undefined;
  /** The Circulation engine, finalized on exiting a gesture (later batch). */
  analyser?: (() => void) | undefined;
  /** Action breadcrumb trail and crash reporter (js/40, later batch). */
  crumb?: ((a: string, b?: string) => void) | undefined;
  reportError?: ((e: unknown, ou?: string) => void) | undefined;
  /**
   * C-17. What exiting a gesture replays: a full replacement or an op received DURING the
   * gesture, queued rather than dropped. Wired by the synchronization batch.
   */
  appliquerEtatFile?: ((st: unknown, opts: unknown) => void) | undefined;
  appliquerOpFile?: ((op: unknown) => void) | undefined;
  /** Local freshness counter: it keeps running EVEN during a gesture (otherwise adoption becomes allowed again). */
  toucherFraicheur?: (() => void) | undefined;
  /** What `save()` triggers downstream: the D1 fallback (js/41) and the realtime wire (js/42). */
  publierD1?: (() => void) | undefined;
  publierFil?: (() => void) | undefined;
  /**
   * C-14. THE WHOLE PLAN, IN ONE ATOMIC OP (`plan5.replace`), BEFORE `save()`. This is NOT
   * `publierFil`: that one is what `save()` triggers DOWNSTREAM, and it emits a DIFF. Two uses,
   * both DELIBERATE and global: the end of the assistant on a fresh household, and the "replace"
   * import. The diff cannot serve them (the mirror is empty, so the plan would leave entity
   * by entity and the peer would see it arrive half-built).
   */
  publierPlanEntier?: (() => void) | undefined;
  /**
   * D-3. THE TAB DETACHES FROM SHARING, PERMANENTLY FOR THIS SESSION. Set by the
   * restoration of the pre-conversion plan: no more op, PUT, or poll leaves from
   * here, and the chip says "local". This is a LOCAL recourse; the shared plan keeps its own
   * history, so we cut the link rather than overwrite the household with an old snapshot.
   */
  detacherSynchro?: (() => void) | undefined;
  /** The furniture inspector (panels batch): open / resync / hide. */
  openInspector?: (() => void) | undefined;
  syncInspector?: (() => void) | undefined;
  hideInspector?: (() => void) | undefined;
  /** The first-use hint (js/31, later batch). */
  showHint?: ((k: string) => void) | undefined;
  /** The emission mirror tracks the freshly adopted state (synchronization batch, C-6). */
  resyncMiroir?: (() => void) | undefined;
  /** The realtime wire during a drag: ephemeral ghosts, diff suspended (collab batch). */
  dragStart?: (() => void) | undefined;
  dragEnd?: (() => void) | undefined;
  emitDrag?: ((p: unknown) => void) | undefined;
  emitDragMulti?: ((l: unknown[]) => void) | undefined;
  /** The LIVE Circulation analysis, during the gesture (js/38, later batch). */
  liveAnalyze?: (() => void) | undefined;
}

export function creerContexte(etat: Etat, canvas: HTMLElement, viewport: HTMLElement): Contexte {
  return {
    etat,
    vue: { scale: 1, ox: 0, oy: 0 },
    ihm: { selWall: null, selCell: null, draw: false },
    selection: { ids: new Set<string>(), primaire: null },
    wallsMode: false,
    editRoom: false,
    selVtx: -1,
    rev: 0,
    viewOnly: 0,
    canvas,
    viewport,
    gestes: {},
    crochets: {},
  };
}

// ---- shared reads --------------------------------------------------------------------------------
// They live here because they read the context and nothing else. Their old equivalent
// (`v5Touch`, `v5SelectedCell`, `v5OpeningById`) was scattered across js/51 and js/52.

/**
 * "The geometry has changed": invalidates the layer's background cache. Call after ANY geometry
 * edit, never after a plain view change.
 */
export function v5Touch(ctx: Contexte): void {
  ctx.rev++;
  const l = ctx.canvas.querySelector<HTMLElement>(".v5layer");
  if (l) delete l.dataset["sig"];
}

export function v5CellById(ctx: Contexte, id: unknown): Cellule | null {
  const P = ctx.etat.plan;
  if (!P) return null;
  return (P.cells || []).find((c) => String(c.id) === String(id)) || null;
}

/**
 * The room-sheet cell. It may have DISAPPEARED (a wall was deleted: two cells merge):
 * we then fall back to the first one, and the caller resyncs the identifier (R-13).
 */
export function v5SelectedCell(ctx: Contexte): Cellule | null {
  const P = ctx.etat.plan;
  if (!P || !P.cells || !P.cells.length) return null;
  return v5CellById(ctx, ctx.ihm.selCell) || P.cells[0] || null;
}

export function v5OpeningById(ctx: Contexte, id: unknown): Ouverture | null {
  const P = ctx.etat.plan;
  if (!P) return null;
  return (P.openings || []).find((o) => String(o.id) === String(id)) || null;
}

export function v5WallById(ctx: Contexte, id: unknown): Mur | null {
  const P = ctx.etat.plan;
  if (!P) return null;
  return (P.walls || []).find((w) => String(w.id) === String(id)) || null;
}

/** Furniture is a FLAT list in apartment cm: it's found by id, never by room. */
export function pieceById(ctx: Contexte, id: unknown): Meuble | null {
  const P = ctx.etat.plan;
  return ((P && P.pieces) || []).find((p) => String(p.id) === String(id)) || null;
}

/** Is the walls-only model served by this plan? */
export function v5On(ctx: Contexte): boolean {
  const P = ctx.etat.plan;
  return !!(P && Array.isArray(P.outline) && P.outline.length > 2);
}
