// src/ts/fil/pseudo-fil.ts: THE SHARED SHAPE OF AN ENTITY, and reading it back.
// C-5, the most fragile invariant in the repo: a persisted field must be declared HERE (the
// `*Wire` functions) AND in `live-worker/ops.ts`'s whitelist, or it never crosses the network.
// The four functions return a NAMED type whose keys are exactly the server contract's;
// `tests/rapide.ts` compares it to `ops.ts`'s `Set`s, so a forgotten key is a red test, not
// silence. The order of keys in each literal is a contract: the emission mirror compares
// `JSON.stringify` strings, so reordering a key would re-emit every entity in the plan.

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
  const out: MurFil = {
    id: String(w.id),
    a: [v5R2(w.a[0]), v5R2(w.a[1])],
    b: [v5R2(w.b[0]), v5R2(w.b[1])],
    t: clamp(Math.round(w.t || WALL), WALL_T_MIN, WALL_T_MAX),
  };
  // NO `free` ON THE WIRE (decision 0012): a wall is its two points and its thickness. The server
  // still accepts and normalizes the key from an old tab (`WALL_FREE`, `live-worker/ops.ts`).
  return out;
}

/**
 * UNPACKED shape: `side` is a key in its own right (so `hinge` is a pure 0/1 boolean), and
 * `h`/`name` cross the network. `plan` gives the carrying wall's length.
 */
export function v5OpeningWire(plan: PlanV5 | null | undefined, o: Ouverture): OuvertureFil {
  const L = v5WallLen(plan, o.wallId);
  const t = TYPEMAP[o.type];
  // KNOWN DEFECT, NOT FIXED HERE: `o.w || t.w` on a type outside the catalogue (a peer-created
  // entity) returns `undefined`, so the op goes out with a NaN width and is silently refused.
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
    // The vertical cut, same rule again. `off` is SIGNED: `Math.round` and nothing else, no
    // `Math.max(0, …)` anywhere on the way out.
    ...(p.hp === undefined ? {} : { hp: Math.round(p.hp) }),
    ...(p.off === undefined ? {} : { off: Math.round(p.off) }),
    ...(p.hs === undefined ? {} : { hs: Math.round(p.hs) }),
    ...(p.ratio === undefined ? {} : { ratio: Math.round(p.ratio) }),
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

/** D-16: the four wire lists are sorted by identifier; the order of the LIVE plan is untouched. */
const v5ById = (a: { id: string }, b: { id: string }): number =>
  String(a.id) < String(b.id) ? -1 : (String(a.id) > String(b.id) ? 1 : 0);

/** The full shared STATE, flattened, as `sanitizeState()` recognizes it. `plan`/`setupDone` are
 * arguments rather than read from a closure, so this is testable standalone. */
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
// The emission mirror (`fil/miroir.ts`) serializes the state announced by the server. Tests whose
// entities already come out of the server validator substitute `wireIdentite` as a typed argument.

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
