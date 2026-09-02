// src/ts/partage/contrat-serveur.ts: THE CLIENT/SERVER CONTRACT, WRITTEN ONCE (C-5). The
// deliverable must stay self-contained (`build.ts` rejects any module outside `src/ts/`), so this
// file cannot import `live-worker/ops.ts`: the lists are copied here, verified by `tests/rapide.ts`
// importing `ops.ts`'s Sets and requiring equality, set by set. Server side: `Set`s (runtime
// check); here: `as const` tuples (compile-time check).

// ---- key whitelists (ops.ts: PIECE_KEYS / WALL_KEYS / OPENING_KEYS / CELL_KEYS) ------------------
// `hinge` and `swing` really are in a PIECE's whitelist, and that's not a typo:
// in the old format a door was a piece of furniture like any other, and those plans still travel.
// `v5PieceWire` does NOT emit them (a walls-only piece doesn't have them): the server is simply more
// permissive than we are, which is the right direction for the asymmetry (G-18).
// This is the exact line that `tests/rapide.ts`'s startup check caught out on its first run:
// the copy said nine keys, the server accepts eleven.
export const PIECE_KEYS = ["id", "type", "name", "x", "y", "w", "h", "rot", "locked", "hinge", "swing", "tr", "dmin", "pair"] as const;
// `free` is still ACCEPTED by the server, and this list must stay set-for-set equal to
// `ops.ts`'s (`tests/rapide.ts` checks it). No client type carries the field any more (decision
// 0012): a tab running the old code may still send it, and the server may still store it.
export const WALL_KEYS = ["id", "a", "b", "t", "free"] as const;
export const OPENING_KEYS = ["id", "wallId", "t0", "w", "h", "type", "side", "name", "hinge", "swing", "leaf"] as const;
export const CELL_KEYS = ["id", "poly", "name", "floor"] as const;

// ---- value domains (ops.ts: OPENING_TYPES / OPENING_SIDES / CELL_FLOORS) -------------------------
export const OPENING_TYPES = ["door", "sdoor", "window", "sconce", "plug", "rj45"] as const;
export const OPENING_SIDES = [0, 1] as const;
/**
 * HOW a window opens, and therefore whether it has a footprint on the floor.
 *   0 (or absent) = fixed, or a skylight: the opening is VERTICAL, nothing on the floor.
 *   1 = one leaf: `hinge` gives the side, `swing` the direction.
 *   2 = double window: two leaves that meet in the MIDDLE.
 * The ABSENT default is what makes the field safe to deploy: the 34 openings already placed
 * don't change appearance until someone sets them.
 */
export const OPENING_LEAVES = [0, 1, 2] as const;
export const CELL_FLOORS = ["parquet", "herringbone", "tile", "plain"] as const;

// ---- bounds (ops.ts) ---------------------------------------------------------------------------
// The server bounds what's DANGEROUS; the client bounds what's SENSIBLE (G-18). The two must never
// contradict each other, so the server values live here and the client can only be STRICTER.
export const WALL_T_MIN = 1, WALL_T_MAX = 60;
export const OPENING_W_MIN = 1, OPENING_W_MAX = 600;
export const OPENING_H_MIN = 1, OPENING_H_MAX = 200;
export const PIECE_WH_MIN = 1, PIECE_WH_MAX = 3000;
export const NAME_MAX = 80;
export const COORD_MAX = 100_000;
export const POLY_MAX_PTS = 2000;
export const MAX_ENTITIES = 2000;
export const SWING_MAX = 80;
export const THROW_RATIO_MIN = 10, THROW_RATIO_MAX = 1000;
export const THROW_DMIN_MIN = 0, THROW_DMIN_MAX = 2000;

export const TYPE_RE = /^[a-z0-9_-]{1,32}$/;
export const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

// ---- the types DERIVED from the constants, never hand-rewritten -----------------------------------
export type OpeningType = (typeof OPENING_TYPES)[number];
export type OpeningSide = (typeof OPENING_SIDES)[number];
export type OpeningLeaf = (typeof OPENING_LEAVES)[number];
export type CellFloor = (typeof CELL_FLOORS)[number];
export type OpeningKey = (typeof OPENING_KEYS)[number];
export type WallKey = (typeof WALL_KEYS)[number];
export type PieceKey = (typeof PIECE_KEYS)[number];
export type CellKey = (typeof CELL_KEYS)[number];

// The four recognized floors, in the shape the reading code expects (`FLOORS.has(...)`).
// A single source of truth: the list above.
export const FLOORS: ReadonlySet<string> = new Set<string>(CELL_FLOORS);

export function estSolConnu(v: unknown): v is CellFloor {
  return typeof v === "string" && FLOORS.has(v);
}
