// src/ts/partage/plan.ts — THE WALLS-ONLY MODEL, TYPED.
//
// AN outline partitioned by walls; ROOMS are the CELLS, which are DERIVED.
// Carried over from src/js/47-v5-modele.js, without changing a single data key (docs/reecriture.md §7.5:
// "the rewrite changes the language of the code, not a data key").
//
// ---- WHAT THE TYPING CLOSES OFF HERE, AND WHAT IT DOESN'T -----------------------------------------
//
// 1. THE FOUR ENTITIES NO LONGER MIX (docs/reecriture.md §5.2, the `NaN` defect).
//    A piece of furniture has `x`/`y`. An opening does NOT: its position is parametric (`wallId`, `t0`,
//    `side`). Nor does a wall (`a`, `b`, `t`). Nor does a cell (`poly`). Passing an opening
//    where a piece of furniture is expected has already written `NaN`s into the household's plan.
//    These four interfaces have NO field in common beyond `id`: TypeScript's structural typing
//    already refuses the swap, with no discriminant needing to exist at runtime.
//
//    WHY THERE'S NO `kind` FIELD IN MEMORY, contrary to the plan's recommendation (§5.2):
//    `serialize()` (js/07) writes `plan: state.plan` VERBATIM into `room-planner-v4`, into the body
//    of the PUT and into every file export. A `kind` carried in memory would therefore become a
//    PERSISTED key, in bytes that the old client reads back, which is precisely the kind of
//    change §7.5 forbids. The structural discriminant costs zero bytes and gives the same
//    compile-time guarantee.
//
// 2. `Fp` IS OPAQUE (docs/invariants.md C-2). Two identically-named counters (content `fp`, ops
//    `opCount`) were once compared: a permanent divergence with both screens showing "live ✓".
//    `fp === String(opCount)` no longer compiles.
//
// 3. WHAT THE TYPING DOES NOT CLOSE OFF, and it must be said: nothing here stops a field from being
//    forgotten in `*Wire` (C-5). Only the equality test against the server's whitelists does
//    (`partage/contrat-serveur.ts`).

import type { CellFloor, OpeningLeaf, OpeningType } from "./contrat-serveur.ts";

/** A point, in FLAT cm. Tuple: `p[0]`/`p[1]` are `number`, never `undefined`. */
export type Pt = [number, number];

/** Entity identifier. Server pattern ID_RE = `^[A-Za-z0-9_.:-]{1,80}$`. */
export type Id = string;

/**
 * Content fingerprint of the plan (`planFp`, 64 bits as 16 hex digits). OPAQUE: it only compares to
 * another fingerprint, never to an ops counter (C-2).
 */
export type Fp = string & { readonly __fp: unique symbol };

// =================================================================================================
//  THE FOUR LIVE ENTITIES (what `state.plan` contains)
// =================================================================================================

/** A wall. `t` = thickness (cm). `isOutline` is a CACHE derived from the outline, never transported. */
export interface Mur {
  id: Id;
  a: Pt;
  b: Pt;
  t: number;
  isOutline?: boolean | undefined;
  /**
   * FREE PARTITION: it does NOT STRETCH until it meets something.
   *
   * A v5 wall is THROUGH-RUNNING by default: each end is pushed to the first
   * geometry beyond it, and lacking a barrier, all the way to the outline. That's what makes a
   * partition "always latch onto" something. A load-bearing partition, a low wall, a divider that
   * stops in the middle of the room don't have this behavior: they stay where they were placed.
   *
   * Absent = through-running, so no existing plan changes. Trimming by the outline, however,
   * ALWAYS applies: free doesn't mean "allowed to leave the flat".
   */
  free?: 1 | undefined;
}

/**
 * An opening: door, window, wall light, plug. NO coordinate of its own: `t0`, `w` and `h` only
 * mean something RELATIVE to its wall (C-12).
 */
export interface Ouverture {
  id: Id;
  wallId: Id;
  /** abscissa of the bottom edge along a→b, in cm */
  t0: number;
  /** width along the wall, in cm */
  w: number;
  /** depth INSIDE the wall, bounded by its thickness (G-16) */
  h: number;
  type: OpeningType | string;
  side: 0 | 1;
  name: string;
  hinge?: 0 | 1 | undefined;
  swing?: 1 | -1 | undefined;
  /**
   * HOW this opening opens, and therefore whether it has a footprint ON THE FLOOR.
   * Absent = fixed or a skylight: the opening is vertical, there's nothing to draw on the floor.
   * That's the default, and it's what makes the field safe: an opening already placed doesn't
   * change appearance until someone has set it.
   */
  leaf?: OpeningLeaf | undefined;
}

/** A piece of furniture, in FLAT cm (no more per-room array). */
export interface Meuble {
  id: Id;
  type: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  locked: boolean;
  /**
   * VIDEO PROJECTOR. The projection distance is NOT stored: it's a RESULT of the position
   * of the device and of the screen. What's stored are the DEVICE's properties,
   * the ones from its spec sheet.
   *   `tr`   projection ratio ×100 (150 = 1.50; 25 = ultra short throw).
   *          image width = distance ÷ (tr/100). An INTEGER, so never a float in the content
   *          fingerprint: two clients cannot diverge over a rounding.
   *   `dmin` minimum focus distance, cm. Absent = we don't claim to know.
   *   `pair` identifier of the paired projection screen.
   */
  tr?: number | undefined;
  dmin?: number | undefined;
  pair?: string | undefined;
}

/** A cell: DERIVED from the walls. Only `name` and `floor` are persisted, by matching. */
export interface Cellule {
  id: Id;
  poly: Pt[];
  name: string;
  floor: CellFloor | string;
}

/**
 * Union of the four. With no discriminant at runtime (see the header): we discriminate on
 * field presence, and the guards below are the ONLY places that do.
 */
export type Entite = Mur | Ouverture | Meuble | Cellule;

export const estMeuble = (e: Entite): e is Meuble =>
  typeof (e as Meuble).x === "number" && typeof (e as Meuble).y === "number";
export const estOuverture = (e: Entite): e is Ouverture =>
  typeof (e as Ouverture).wallId === "string";
export const estMur = (e: Entite): e is Mur =>
  Array.isArray((e as Mur).a) && Array.isArray((e as Mur).b);
export const estCellule = (e: Entite): e is Cellule => Array.isArray((e as Cellule).poly);

/** The live plan. `cells` is derived; `outline` is not an entity, it's a bare polygon. */
export interface PlanV5 {
  outline: Pt[];
  walls: Mur[];
  openings: Ouverture[];
  pieces: Meuble[];
  cells: Cellule[];
  /** report from the last cell detection (diagnostic, never persisted) */
  _report?: RapportDetection | undefined;
}

export interface RapportDetection {
  segments: number;
  nodes: number;
  edges: number;
  pruned: number;
  faces: number;
  dropped: number;
  tiny: number;
  outside: number;
}

// =================================================================================================
//  THE WIRE: the STRICT shapes that `sanitizeState` (live-worker/ops.ts) accepts
// =================================================================================================
// Any unknown key makes the op FAIL server-side, hence types distinct from the live plan's:
// `Mur` carries `isOutline`, `MurFil` doesn't; `Cellule` can carry any floor,
// `CelluleFil` only the four recognized ones.

export interface MurFil {
  id: Id;
  a: Pt;
  b: Pt;
  t: number;
  /**
   * FREE PARTITION, mirrors `Mur.free` (see there). Emitted ONLY if set (same rule as an
   * opening's `leaf`, below): absence means "through-going", the historical default, so no
   * existing plan changes shape the first time an unrelated field on it is touched.
   */
  free?: 1 | undefined;
}

/**
 * OUTGOING opening, UNPACKED shape: `side` is a key of its own, so `hinge` is a pure
 * 0/1 boolean, and `h`/`name` go through. Before `ops.ts` was widened they didn't: renaming a
 * window emitted NO op at all (C-5).
 */
export interface OuvertureFil {
  id: Id;
  wallId: Id;
  t0: number;
  w: number;
  type: OpeningType | string;
  h: number;
  side: 0 | 1;
  name: string;
  hinge: 0 | 1;
  swing?: 1 | -1 | undefined;
  leaf?: OpeningLeaf | undefined;
}

/**
 * INCOMING opening. `OuvertureFil` IS NOT `Ouverture`, and the OLD shape isn't
 * `OuvertureFil` either: a tab left open packs `side` into bit 1 of `hinge`, so
 * `hinge: 0|1|2|3` on input and `0|1` at rest (V-8). Unpacking is explicit
 * (`v5AdoptOpening`), it is never implicit.
 */
export interface OuvertureFilEntrante {
  id: Id;
  wallId: Id;
  t0?: number | undefined;
  w?: number | undefined;
  type: OpeningType | string;
  h?: number | undefined;
  side?: 0 | 1 | undefined;
  name?: string | undefined;
  /** 0|1 in unpacked shape; 0..3 in packed shape (bit 0 = hinge, bit 1 = side) */
  hinge?: number | undefined;
  swing?: number | undefined;
  leaf?: number | undefined;
}

export interface MeubleFil {
  id: Id;
  type: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  locked: boolean;
  tr?: number | undefined;
  dmin?: number | undefined;
  pair?: string | undefined;
}

export interface CelluleFil {
  id: Id;
  poly: Pt[];
  name: string;
  floor: CellFloor;
}

/** The FLAT plan, as `sanitizeState` recognizes it. */
export interface PlanFil {
  outline: Pt[];
  walls: MurFil[];
  openings: OuvertureFil[];
  pieces: MeubleFil[];
  cells: CelluleFil[];
}

/** What `v5StateWire()` returns: the flat plan + the setup flag. */
export interface EtatFil extends PlanFil {
  setupDone: boolean;
}

// =================================================================================================
//  THE OPERATIONS (docs/reecriture.md §5.3)
// =================================================================================================
// An op is a FIELD-BY-FIELD DIFF: an absent field means "no opinion", and the server keeps
// the value it holds (C-5). Hence the `Partial<…> & {id}`: a partial op is the ORDINARY case,
// the whole entity is only sent on CREATION.

export type MurPartiel = Partial<MurFil> & { id: Id };
export type OuverturePartielle = Partial<OuvertureFil> & { id: Id };
export type MeublePartiel = Partial<MeubleFil> & { id: Id };

export type Op =
  | { kind: "plan5.replace"; plan: PlanFil }
  | { kind: "outline.set"; outline: Pt[] }
  | { kind: "wall.set"; wall: MurPartiel }
  /** CASCADE: the server takes the wall's openings down with it (C-13) */
  | { kind: "wall.del"; wallId: Id }
  | { kind: "opening.set"; opening: OuverturePartielle }
  | { kind: "opening.del"; openingId: Id }
  | { kind: "cell.set"; cellId: Id; name?: string | undefined; floor?: CellFloor | string | undefined; poly?: Pt[] | undefined }
  | { kind: "cells.replace"; cells: CelluleFil[] }
  | { kind: "piece.set"; piece: MeublePartiel }
  | { kind: "piece.del"; pieceId: Id };

export type OpKind = Op["kind"];

// =================================================================================================
//  THE OUTGOING MIRROR (C-6: it describes the SERVER, never us)
// =================================================================================================
// Each entity is kept SERIALIZED there (a JSON string), because the diff compares bytes and
// nothing must share an object with the live plan.

export interface Miroir {
  outline: string | null;
  walls: Map<Id, string>;
  openings: Map<Id, string>;
  pieces: Map<Id, string>;
  cells: Map<Id, string>;
}

export function nouveauMiroir(): Miroir {
  return { outline: null, walls: new Map(), openings: new Map(), pieces: new Map(), cells: new Map() };
}
