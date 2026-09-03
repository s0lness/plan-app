// src/ts/partage/plan.ts: THE WALLS-ONLY MODEL, TYPED. An outline partitioned by walls; rooms are
// the CELLS, which are DERIVED.
//
// ---- WHAT THE TYPING CLOSES OFF, AND WHAT IT DOESN'T --------------------------------------------
// 1. THE FOUR ENTITIES NO LONGER MIX: a piece has `x`/`y`, an opening's position is parametric
//    (`wallId`/`t0`/`side`), a wall has `a`/`b`/`t`, a cell has `poly`. No field in common beyond
//    `id`, so TypeScript's structural typing refuses the swap with no runtime discriminant needed
//    (no `kind` field carried in memory, since `serialize()` writes the plan verbatim and a `kind`
//    would become a persisted key).
// 2. `Fp` IS OPAQUE (C-2): `fp === String(opCount)` no longer compiles.
// 3. WHAT ISN'T CLOSED OFF: nothing here stops a field from being forgotten in `*Wire` (C-5); only
//    the equality test against the server's whitelists does (`partage/contrat-serveur.ts`).

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
  // NO `free` HERE ANY MORE (decision 0012). It marked a wall that must not stretch to the first
  // barrier; nothing stretches now, so the whole plan is what `free` used to describe. The server
  // still ACCEPTS the key from an older tab (`WALL_KEYS`, `live-worker/ops.ts`), and
  // `sanitizeV5Plan` still reads it without keeping it: a stored plan opens unchanged, and this
  // client never writes the field again.
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
  /**
   * LUMINOUS FLUX, lumens. Absent = this fixture radiates its TYPE’s default
   * (`circulation/lumiere.ts`, `FLUX_DEFAUT`): a default is not a value somebody chose, so it is
   * never written into the plan. Present = somebody set it, and it travels (C-5).
   */
  lm?: number | undefined;
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
   *
   * THE VERTICAL CUT, same rule: nothing derived is stored.
   *   `hp`   height of the LENS above the floor, cm (projector). Absent = not stated.
   *   `off`  vertical offset, SIGNED, in % of the image HEIGHT (projector). Absent = 0. A
   *          ceiling mount is negative, an ultra short throw is past +100: this is the field
   *          that keeps the geometry from ever assuming the lens is under the image.
   *   `hs`   height of the BOTTOM of the screen above the floor, cm (projection screen).
   *   `ratio` image format, as an integer code (`IMAGE_RATIOS`, `partage/contrat-serveur.ts`): 169, 1610,
   *          2351. Absent = 16:9. An integer for the same reason as `tr`.
   */
  tr?: number | undefined;
  dmin?: number | undefined;
  pair?: string | undefined;
  hp?: number | undefined;
  off?: number | undefined;
  hs?: number | undefined;
  ratio?: number | undefined;
  /**
   * LUMINOUS FLUX, lumens. Absent = this fixture radiates its TYPE’s default
   * (`circulation/lumiere.ts`, `FLUX_DEFAUT`): a default is not a value somebody chose, so it is
   * never written into the plan. Present = somebody set it, and it travels (C-5).
   */
  lm?: number | undefined;
}

/** A cell: DERIVED from the walls. Only `name`, `floor` and `lux` are persisted, by matching. */
export interface Cellule {
  id: Id;
  poly: Pt[];
  name: string;
  floor: CellFloor | string;
  /**
   * LIGHTING TARGET, lux. Absent = deduced from the room’s NAME (`cibleLux`), which is a guess
   * about the use; present = somebody stated it, and it wins over the guess.
   */
  lux?: number | undefined;
}

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
  // NO `free` HERE ANY MORE, in either direction (decision 0012): this client never emits it, and
  // ignores it when a peer still running the old code does. The server keeps accepting it.
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
  lm?: number | undefined;
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
  lm?: number | undefined;
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
  hp?: number | undefined;
  off?: number | undefined;
  hs?: number | undefined;
  ratio?: number | undefined;
  lm?: number | undefined;
}

export interface CelluleFil {
  id: Id;
  poly: Pt[];
  name: string;
  floor: CellFloor;
  lux?: number | undefined;
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
  | { kind: "cell.set"; cellId: Id; name?: string | undefined; floor?: CellFloor | string | undefined; poly?: Pt[] | undefined; lux?: number | undefined }
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
