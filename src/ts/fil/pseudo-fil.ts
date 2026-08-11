// src/ts/fil/pseudo-fil.ts — THE SHARED SHAPE OF AN ENTITY, and reading it back.
// Ported from src/js/51-v5-pseudo-fil.js.
//
// C-5, THE MOST FRAGILE INVARIANT IN THE REPO: a persisted field must be declared HERE (in the
// `*Wire` functions) **and** in `live-worker/ops.ts`'s whitelist, OTHERWISE IT NEVER CROSSES THE
// NETWORK, WITH NO VISIBLE ERROR. Already happened twice: an opening's name and depth used to not
// travel, then the side got packed as a bitfield into the hinge for lack of an authorized key
// ("the server believed it was validating a hinge while it was validating three mixed-up fields,
// and any finite number would pass").
//
// WHAT THE PORT CHANGES: the four functions now return a NAMED type (`MurFil`, `OuvertureFil`,
// `MeubleFil`, `CelluleFil`) whose keys are exactly those of the server contract, and
// `tests/rapide.ts` compares this contract to the `Set`s exported by `ops.ts`. Forgetting a key
// is no longer silent: it is a red test. C-5 stays conventional in the sense of "add a field on
// both sides", but it can no longer DIVERGE without our knowing.
//
// THE ORDER OF KEYS IN EACH LITERAL IS A CONTRACT: the emission mirror compares `JSON.stringify`
// strings, so reordering a key would re-emit every entity in the plan.

import { clamp, v5R2, WALL } from "../noyau/nombres.ts";
import { estSolConnu, NAME_MAX, OPENING_H_MAX, OPENING_W_MAX, PIECE_WH_MAX, WALL_T_MAX, WALL_T_MIN } from "../partage/contrat-serveur.ts";
import { TYPEMAP } from "../catalogue/catalogue.ts";
import { v5WallLen } from "../modele/murs.ts";
import type {
  Cellule,
  CelluleFil,
  EtatFil,
  Meuble,
  MeubleFil,
  Mur,
  MurFil,
  Ouverture,
  OuvertureFil,
  OuvertureFilEntrante,
  PlanV5,
  Pt,
} from "../partage/plan.ts";

function v5WallWire(w: Mur): MurFil {
  return {
    id: String(w.id),
    a: [v5R2(w.a[0]), v5R2(w.a[1])],
    b: [v5R2(w.b[0]), v5R2(w.b[1])],
    t: clamp(Math.round(w.t || WALL), WALL_T_MIN, WALL_T_MAX),
  };
}

/**
 * UNPACKED shape: `side` is a key in its own right (so `hinge` is a pure 0/1 boolean), and
 * `h`/`name` cross the network.
 * `plan` is needed to know the length of the carrying wall: in the old client this read went
 * through the closure (`state.plan`), which made the function impure without saying so.
 */
export function v5OpeningWire(plan: PlanV5 | null | undefined, o: Ouverture): OuvertureFil {
  const L = v5WallLen(plan, o.wallId);
  const t = TYPEMAP[o.type];
  // FAITHFUL TO THE OLD CLIENT, INCLUDING ITS DEFECT: `o.w || t.w` on an UNKNOWN type (hence
  // absent from the catalogue) returns `undefined`, so `v5R2(undefined)` returns NaN, so the op
  // goes out with a NaN width and the server refuses it, a placement lost in silence. The case is
  // only reachable through an entity created by a peer with a `type` outside the catalogue (the
  // server only enforces a SHAPE, not the list). This is NOT fixed here: the rewrite changes the
  // language of the code, not its behavior. To be handled in its own batch, with its own measurement.
  const ow = clamp(v5R2(o.w || (t ? t.w : (undefined as unknown as number))), 1, OPENING_W_MAX);
  const out: OuvertureFil = {
    id: String(o.id),
    wallId: String(o.wallId),
    t0: Math.max(0, v5R2(clamp(o.t0 || 0, 0, Math.max(0, (L || ow) - ow)))),
    w: ow,
    type: o.type,
    h: clamp(Math.round(o.h || (t ? t.h : 0) || WALL), 1, OPENING_H_MAX), // server bound
    side: o.side ? 1 : 0, // key in its own right (unpacked shape)
    name: String(o.name || (t ? t.name : "") || "").slice(0, NAME_MAX), // server bound
    hinge: o.hinge != null && Number(o.hinge) ? 1 : 0,
  };
  if (o.type === "door") out.swing = Number(o.swing) < 0 ? -1 : 1;
  // `leaf` is ONLY EMITTED if it is set. Emitting 0 by default would write "this window is fixed"
  // onto every opening of every plan on the first op that touches it, whereas absence means
  // "nobody has stated an opinion" (C-5: an absent field is not a field set to zero).
  if (o.leaf !== undefined) out.leaf = o.leaf;
  // A casement window needs its direction, just like a door. Without this, `swing` does not cross
  // the network and the arc opens on the wrong side for the peer.
  if (o.type === "window" && o.leaf) out.swing = Number(o.swing) < 0 ? -1 : 1;
  return out;
}

/**
 * wire -> local: unpacks `side`, re-derives `h`/`name` from the catalogue. Idempotent on an
 * already-local object (V-8: both shapes of an opening are accepted during the rollout window).
 * The input type explicitly says `hinge` can be 0..3: the packing is no longer tribal knowledge,
 * it is in the signature.
 */
export function v5AdoptOpening<T>(o: T): T | Ouverture {
  if (!o || typeof o !== "object") return o;
  const src = o as unknown as OuvertureFilEntrante;
  if (src.side !== undefined || src.h !== undefined) return o; // already rich (local copy)
  const t = TYPEMAP[src.type];
  const packed = Number(src.hinge);
  const hp = isFinite(packed) ? packed : 0;
  return {
    id: String(src.id),
    wallId: String(src.wallId),
    t0: Number(src.t0) || 0,
    w: Number(src.w) || (t ? t.w : 0) || 80,
    h: (t ? t.h : 0) || WALL,
    type: src.type,
    side: (hp & 2) ? 1 : 0,
    name: String((t ? t.name : "") || ""),
    hinge: (hp & 1) ? 1 : 0,
    swing: Number(src.swing) < 0 ? -1 : 1,
    ...(src.leaf === undefined ? {} : { leaf: (Number(src.leaf) | 0) as 0 | 1 | 2 }),
  };
}

export function v5PieceWire(p: Meuble): MeubleFil {
  return {
    id: String(p.id),
    type: String(p.type),
    name: String(p.name || ""),
    x: Math.round(p.x),
    y: Math.round(p.y),
    w: clamp(Math.round(p.w), 1, PIECE_WH_MAX),
    h: clamp(Math.round(p.h), 1, PIECE_WH_MAX),
    rot: Math.round(p.rot || 0),
    locked: !!p.locked,
    // Same rule as `leaf`: absent as long as nobody has set it.
    // Same rule as `leaf`: absent as long as nobody has set them. `pair` goes out even empty,
    // because "no more paired screen" is information that must cross the network.
    ...(p.tr === undefined ? {} : { tr: Math.round(p.tr) }),
    ...(p.dmin === undefined ? {} : { dmin: Math.round(p.dmin) }),
    ...(p.pair === undefined ? {} : { pair: String(p.pair) }),
  };
}

function v5CellWire(c: Cellule): CelluleFil {
  return {
    id: String(c.id),
    poly: c.poly.map((p) => [v5R2(p[0]), v5R2(p[1])] as Pt),
    name: String(c.name || ""),
    floor: estSolConnu(c.floor) ? c.floor : "parquet",
  };
}

/**
 * D-16: THE FOUR WIRE LISTS ARE SORTED BY IDENTIFIER.
 * The content of a list is a SET, but the LOCAL order diverges as soon as two people each create
 * an entity at the same moment. Without this sort, two plans with identical content gave two
 * different exports, two different PUT bodies, and a screen comparison that failed with no
 * entity actually differing. The order of the LIVE plan is never touched.
 */
const v5ById = (a: { id: string }, b: { id: string }): number =>
  String(a.id) < String(b.id) ? -1 : (String(a.id) > String(b.id) ? 1 : 0);

/**
 * The full shared STATE, flattened, as `sanitizeState()` recognizes it.
 * `plan` and `setupDone` are ARGUMENTS: in the old client the function read `state.plan` and
 * `state.setupDone` from the closure, which made it untestable without bringing up the whole
 * client (this is exactly why `tests/rapide.ts` had to fabricate a fake `state`).
 */
export function v5StateWire(plan: PlanV5 | null | undefined, setupDone: boolean): EtatFil {
  const P = plan || ({} as Partial<PlanV5>);
  const ids = new Set((P.walls || []).map((w) => String(w.id)));
  return {
    outline: (P.outline || []).map((p) => [v5R2(p[0]), v5R2(p[1])] as Pt),
    walls: (P.walls || []).map(v5WallWire).sort(v5ById),
    openings: (P.openings || [])
      .filter((o) => ids.has(String(o.wallId)))
      .map((o) => v5OpeningWire(plan, o))
      .sort(v5ById),
    pieces: (P.pieces || []).map(v5PieceWire).sort(v5ById),
    cells: (P.cells || []).map(v5CellWire).sort(v5ById),
    setupDone: !!setupDone,
  };
}

// =================================================================================================
//  THE FOUR SERIALIZERS, IN A SINGLE OBJECT
// =================================================================================================
// The emission mirror (`fil/miroir.ts`) serializes the state announced by the server. In the old
// client it called the four `*Wire` functions by their closure name; this is precisely what
// `tests/rapide.ts` and `tests/harnais-graine.ts` had to SUBSTITUTE ("the only substitution in
// this whole file"), because their entities already come out of the server validator.
// The substitution becomes a TYPED ARGUMENT. The bench no longer hacks a closure; it passes
// `wireIdentite`.

export interface Serialiseurs {
  wall(w: Mur): MurFil;
  opening(o: Ouverture): OuvertureFil;
  piece(p: Meuble): MeubleFil;
  cell(c: Cellule): CelluleFil;
}

/** The real serializers, bound to the plan that gives the walls' length. */
export function serialiseursPour(plan: PlanV5 | null | undefined): Serialiseurs {
  return {
    wall: v5WallWire,
    opening: (o) => v5OpeningWire(plan, o),
    piece: v5PieceWire,
    cell: v5CellWire,
  };
}

/**
 * The entities ARE already in wire shape (they come out of `sanitizeState` / `applyOp`, that is,
 * out of the server validator itself): the pass-through is a deep copy.
 */
export const wireIdentite: Serialiseurs = {
  wall: (w) => JSON.parse(JSON.stringify(w)) as MurFil,
  opening: (o) => JSON.parse(JSON.stringify(o)) as OuvertureFil,
  piece: (p) => JSON.parse(JSON.stringify(p)) as MeubleFil,
  cell: (c) => JSON.parse(JSON.stringify(c)) as CelluleFil,
};
