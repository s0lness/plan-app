// src/ts/app/contexte.ts: THE SMALL BIT OF MUTABLE STATE THAT RENDERING SHARES, in one place.
//
// The old client was a single closure: `state`, `vScale`, `vOx`, `vOy`, `selIds`, `selId`,
// selection and revision counters were module variables visible from everywhere, and "everything is visible
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
  /** Wall under the mouse: a light highlight and the pointer cursor, never a button (decision 0010). */
  hoverWall: string | null;
  selCell: string | null;
  /** THE wall tool is armed: a click lays a point, the chain follows (`gestes/outil-mur.ts`). */
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
  /** A selected interior wall's own ENDPOINT handle (owner's report: "choper les extrémités des
   * murs et pouvoir étendre et relier à d'autres murs"), `gestes/murs.ts`'s `v5StartWallEndDrag`. */
  boutMurPointerDown?: (e: PointerEvent, wallId: string, bout: "a" | "b") => void;
  /** A wall's central move handle. Facades use the same visible target for selection only. */
  deplacerMurPointerDown?: (e: PointerEvent, wallId: string) => void;
  /** THE SELECTED WALL'S OWN COMMANDS (decision 0010, amended 2026-09-02): drawn on the wall
   * itself, at selection only, calling the SAME functions the sheet used to. Plain clicks, not
   * drags: there is nothing to distinguish a click from a drag here, unlike the handles above. */
  supprimerMurClic?: (e: MouseEvent, wallId: string) => void;
  couperMurClic?: (e: MouseEvent, wallId: string) => void;
  redresserMurClic?: (e: MouseEvent, wallId: string) => void;
  /** THE MERGE GLYPH at a weldable joint (owner: "if i split a wall, and then want to merge it
   * back, how do i do it?"). Drawn where the endpoint handle would be if the end weren't already
   * a joint (`rendu/calque.ts`), only when `v5WallMergeCandidate` says this end continues into
   * exactly one collinear neighbour. */
  fusionnerMurClic?: (e: MouseEvent, wallId: string, bout: "a" | "b") => void;
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
  /** The emission mirror tracks the freshly adopted state (synchronization batch, C-6). */
  resyncMiroir?: (() => void) | undefined;
  /**
   * G-3 + G-12, THE TWO COMBINED. `pushHistory()` falls on a gesture's FIRST real movement, not
   * on `pointerdown` (drag, rotate, wall/vertex/opening drag, resize): the snapshot it takes is
   * "the state right before this gesture". Escape then restores that SAME state through the
   * gesture's own `cancel`, but the snapshot stays sitting on the undo stack: `Ctrl+Z` would pop
   * it, see no visible change (it already IS the current state), and only the SECOND `Ctrl+Z`
   * would reach the action the person actually meant to undo. Wired to `historique/pile.ts`
   * (which `gestes/sortie.ts` cannot import directly: `pile.ts` already imports FROM this
   * module's `gesteActif`, and a cycle here is exactly the shape of bug "Blank startup" warns
   * about), called by `escapeActiveGesture()` right after the gesture's own `cancel()` has run.
   */
  jeterHistoriqueVide?: (() => void) | undefined;
  /** The realtime wire during a drag: ephemeral ghosts, diff suspended (collab batch). */
  dragStart?: (() => void) | undefined;
  dragEnd?: (() => void) | undefined;
  emitDrag?: ((p: unknown) => void) | undefined;
  emitDragMulti?: ((l: unknown[]) => void) | undefined;
  /** The LIVE Circulation analysis, during the gesture (js/38, later batch). */
  liveAnalyze?: (() => void) | undefined;
  /**
   * BATCH 3, guest client (docs/decisions/0004-partage-par-lien.md). `fil/rest.ts` DETECTS the
   * guest door's 403 refusal shape (boot, poll, or a push refused mid-session); it does not
   * decide what to do about it, because that decision lives in `fil/invite.ts`, which THIS
   * module (`rest.ts`) is imported BY (for `setSyncChip`), importing it back would be a cycle.
   * Wired once, right after `brancherFil()` returns in `main.ts`, unconditionally: on the
   * household door neither is ever called, which is exactly the right default.
   *
   * `accesRefuseSansInvite`: no invitation was ever redeemed on this tab, the guest door,
   * visited by a stranger. Enters LOCAL-ONLY mode.
   * `accesRefuseInvite`: an invitation WAS redeemed, and this door slammed anyway (revoked,
   * expired, the plan deleted). The dead end, full screen.
   */
  accesRefuseSansInvite?: (() => void) | undefined;
  accesRefuseInvite?: (() => void) | undefined;
  /**
   * SELF-HEALING FOR THE LOCAL-ONLY DOOR FLAG (`plan-porte-locale`, `fil/invite.ts`). That flag is
   * a GUESS made before confirmation, replayed synchronously on every later boot so a returning
   * local-only visitor doesn't read the household's storage key by mistake. A boot read that
   * SUCCEEDS proves this origin does serve a plan to this tab, which makes the guess wrong: wired
   * from `fil/rest.ts`'s `syncBoot`/`pollPull` (the same two places that lift `bootReconciled`) to
   * `fil/invite.ts`, through a crochet for the same reason `accesRefuseSansInvite` is one, `rest.ts`
   * is imported BY `invite.ts` (for `setSyncChip`), so the reverse import would be a cycle.
   */
  porteMenageConfirmee?: (() => void) | undefined;
  /**
   * BATCH 3+, corrected 2026-08-14. `fil/presence.ts` detects a `guest_unnamed` refusal from the
   * server (the socket carries no name, see `functions/ws.ts`'s device-matched resolution of
   * `invites.last_name`); it does not decide what to DO about it, because that decision lives in
   * `fil/invite.ts`'s name-step UI, which THIS module (`presence.ts`, via `fil/rest.ts`) is
   * imported BY, the same cycle `accesRefuseSansInvite` above avoids the same way. Wired
   * unconditionally in `main.ts`, right beside the other two: never invoked on the household door,
   * since only a guest socket can carry an empty name in the first place.
   */
  guestSansNom?: (() => void) | undefined;
  /**
   * SAME BATCH, THE OTHER HALF: `invites.last_name`/`last_guest_id` is ONE slot, shared by every
   * device holding the link, it remembers whichever device redeemed the token MOST RECENTLY WITH
   * A NAME, not one name per device. Two guests active on the same link at once therefore keep
   * reclaiming that one slot from each other on every fresh `/api/invite` POST (a page load), and
   * a plain WebSocket RECONNECT (no POST at all, a network blip, the heartbeat's dead-socket
   * close) reads the row exactly as the OTHER device last left it: whoever reconnects second, on a
   * row the peer currently owns, gets an EMPTY name from `functions/ws.ts` even though THIS
   * device chose one long ago and never forgot it.
   *
   * `fil/presence.ts`'s `hello` handler is what notices ("the server gave me no name"); it does
   * not decide what to reassert, because the name it should reassert is a client-storage read that
   * belongs in `fil/invite.ts` (`nomInviteConnu()`), same cycle-avoidance reason as
   * `accesRefuseSansInvite`. When both are non-empty, `presence.ts` sends `{t:"name"}` itself
   * (it already imports `wsSend`), it does not need this hook to WRITE, only to READ.
   */
  guestNomLocal?: (() => string) | undefined;
}

export function creerContexte(etat: Etat, canvas: HTMLElement, viewport: HTMLElement): Contexte {
  return {
    etat,
    vue: { scale: 1, ox: 0, oy: 0 },
    ihm: { selWall: null, hoverWall: null, selCell: null, draw: false },
    selection: { ids: new Set<string>(), primaire: null },
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
