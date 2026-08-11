// Pure logic for applying/validating ops on the canonical plan (TypeScript source).
// No Cloudflare/DO dependency: testable under node.
// All ops are idempotent (set of whole entities), so the echo is risk-free.

export type Point = [number, number];

export interface Piece {
  id: string;
  type?: string;
  name?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  locked?: boolean;
  hinge?: number;
  swing?: string | number;
  tr?: number;
  dmin?: number;
  pair?: string;
}

export interface Wall {
  id: string;
  a: Point;
  b: Point;
  t: number;
  free?: number;
}

export interface Opening {
  id: string;
  wallId: string;
  t0: number;
  w: number;
  h?: number;
  type: string;
  side: number;
  name?: string;
  hinge?: number;
  swing?: string | number;
  leaf?: number;
}

export interface Cell {
  id: string;
  poly: Point[];
  name: string;
  floor: string;
}

export interface LegacyRoom {
  id: string;
  name?: string;
  floor?: string | number;
  ax?: number | null;
  ay?: number | null;
  room: { poly: Point[] };
  pieces: Piece[];
}

/** Canonical shape of storage and the wire; the v4 and v5 keys are mutually exclusive in use. */
export interface PlanState {
  outline?: Point[] | null;
  walls?: Wall[];
  openings?: Opening[];
  pieces?: Piece[];
  cells?: Cell[];
  rooms?: LegacyRoom[];
  envelope?: { poly: Point[]; floor?: string | number; pieces: Piece[] } | null;
  setupDone: boolean;
}

/** Common envelope for operations; each `kind` is validated in its own dedicated switch. */
export interface Operation {
  kind: string;
  plan?: PlanState;
  state?: PlanState;
  piece?: Piece;
  pieceId?: string;
  room?: LegacyRoom;
  roomId?: string;
  rooms?: LegacyRoom[];
  outline?: Point[];
  wall?: Wall;
  wallId?: string;
  opening?: Opening;
  openingId?: string;
  cellId?: string;
  cells?: Cell[];
  poly?: Point[];
  name?: string;
  floor?: string | number;
  ax?: number | null;
  ay?: number | null;
}

export interface CursorMessage { room?: string | null; x?: number | null; y?: number | null }
export interface DragMessage extends CursorMessage { pieceId?: string; rot?: number | null }

const COLORS = ["#1f6f78", "#b04a3d", "#7c8a6b", "#8a6e8e"];

// Allowed keys of a piece (furniture item). Everything else is rejected.
export const PIECE_KEYS = new Set([
  "id", "type", "name", "x", "y", "w", "h", "rot", "locked", "hinge", "swing",
  // VIDEO PROJECTOR. The projection distance is NOT stored: it is derived from the position
  // of the projector and that of the screen. What we store are the properties of the DEVICE,
  // the ones found on its spec sheet:
  //   `tr`   throw ratio x100 (150 = 1.50; 25 = 0.25 = ultra-short throw).
  //          image width = distance / (tr/100). Integer, so never a float in the
  //          content fingerprint: two clients cannot diverge on a rounding.
  //   `dmin` minimum focus distance, cm.
  //   `pair` id of the paired projection screen (or absent).
  // The server does NOT know the catalog: it cannot require that only a projector carries
  // these (G-18, the server bounds the dangerous, the client bounds the sensible).
  "tr", "dmin", "pair",
]);

// ---- v5 "wall-partition" model (additive: v4 stays alive until the switchover) ----
// Allowed keys of v5 entities. Same severity as PIECE_KEYS: everything else is rejected.
export const WALL_KEYS = new Set(["id", "a", "b", "t",
  // `free`: this partition does NOT extend until it meets something. A v5 wall reaches through
  // by default (each end is pushed to the first geometry beyond it, and to the outline failing
  // a barrier): that's what makes a partition "always hook onto something". A load-bearing
  // sub-wall, a low wall, a divider that stops in the middle of the room, must instead stay
  // where it was placed. Absent = historical behavior, so no existing plan moves.
  "free"]);
export const OPENING_KEYS = new Set(["id", "wallId", "t0", "w", "h", "type", "side", "name", "hinge", "swing",
  // `leaf`: HOW a window opens, and therefore whether it has a floor footprint.
  //   absent / 0 = fixed or awning (vertical opening) -> NO swing arc
  //   1 = one leaf (the side comes from `hinge`, the direction from `swing`)
  //   2 = double window, two leaves meeting in the MIDDLE
  // The ABSENT default is what makes the addition safe: no opening already in the database
  // changes appearance until someone sets it.
  "leaf"]);
export const CELL_KEYS = new Set(["id", "poly", "name", "floor"]);
// Types of opening/fixture that can be placed on a wall (mirrors the client catalog).
export const OPENING_TYPES = new Set(["door", "sdoor", "window", "sconce", "plug", "rj45"]);
// Faces of a wall: strictly binary. 0 = left normal of the a->b segment, 1 = the other face
// (mirrors v5OpeningBox on the client: rot = wall angle + 180 * side).
export const OPENING_SIDES = new Set([0, 1]);
export const OPENING_LEAVES = new Set([0, 1, 2]);
export const WALL_FREE = new Set([0, 1]);
/** Throw ratio x100. 10 = 0.10 (UST projectors go down to 0.19); 1000 = 10.0, beyond that it's a typo. */
export const THROW_RATIO_MIN = 10, THROW_RATIO_MAX = 1000;
/** Minimum focus distance, cm. 0 = not provided. */
export const THROW_DMIN_MIN = 0, THROW_DMIN_MAX = 2000;
// Allowed floor coverings for a cell (mirrors FLOORS on the client).
export const CELL_FLOORS = new Set(["parquet", "herringbone", "tile", "plain"]);
// v5 geometric bounds (cm).
export const WALL_T_MIN = 1, WALL_T_MAX = 60;
export const OPENING_W_MIN = 1, OPENING_W_MAX = 600;
// h of an opening = DEPTH of its box in TOP-DOWN VIEW, not a ceiling height: the client
// catalog gives 12 cm for a door / sliding door / window / sconce, 6 cm for a plug or RJ45,
// and falls back to the wall thickness (12) for lack of anything better. The bounds therefore
// mirror the client clamp (sanitizeV5Plan: clamp(h,1,200)): any tighter, we would reject
// legitimate values, and a wrongly refused op makes an edit vanish in silence.
export const OPENING_H_MIN = 1, OPENING_H_MAX = 200;
// Max length of a name, aligned with piece.name / cell.name / room.name.
export const NAME_MAX = 80;

// ---- VOLUME and RANGE bounds (defense against a crazed client or a forged wire) ----
// A coordinate is in cm in the apartment frame. 100,000 cm = 1 km: thirty times the largest
// plausible dimension of a home (the real plan fits within 1,418 cm), so no legitimate data
// is refused, but 1e308 / 1e12 are. Without a bound, a single absurd coordinate is enough to
// make the client render unusable and bloat the snapshot.
export const COORD_MAX = 100_000;
// Number of vertices of a polygon (outline, cell, v4 room). The real plan caps at 11.
export const POLY_MAX_PTS = 2000;
// Number of entities per family (walls / openings / furniture / cells / rooms). The real plan
// fits in 22 / 30 / 47 / 10. 2000 leaves two orders of magnitude of margin and bounds the snapshot.
export const MAX_ENTITIES = 2000;
// Bounds of a piece of furniture (cm). Unchanged, extracted into constants.
export const PIECE_WH_MIN = 1, PIECE_WH_MAX = 3000;
// `swing`: opening direction. The client sends "1" / "-1" (furniture) or 1 / -1 (opening).
// Same bound on both sides: without it, `swing` accepted a 5 MB string on a piece of furniture.
export const SWING_MAX = 80;
// `type` of a piece of furniture: an id from the client catalog (sofa3, radiateur, wc...). We do
// NOT mirror the list of 41 types: adding to the catalog would then require a Worker redeploy,
// and in the meantime every placement of the new furniture item would be refused, hence lost in
// silence. We impose the SHAPE of an identifier, which is enough to rule out
// "<img src=x onerror=...>" and any injection. Verified: the catalog's 41 types and the 24
// present in production pass this pattern.
export const TYPE_RE = /^[a-z0-9_-]{1,32}$/;

// ---- A PLAN'S IDENTIFIER -----------------------------------------------------------------------
// It serves TWO purposes that must stay in agreement: the D1 row key, and the Durable Object
// name (`idFromName`). A narrow grammar, then, and a single one: an identifier that would pass
// one and not the other would make a plan whose realtime side and REST fallback don't talk
// about the same document -- exactly the kind of divergence that shows "live checkmark".
// `main` remains the household's historical plan, and the DEFAULT when nothing is requested:
// any client already open keeps landing on it without knowing anything about this field.
export const PLAN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const PLAN_ID_DEFAUT = "main";

/** Returns a VALID plan identifier, or null. Never an exception: callers decide. */
export function cleanPlanId(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return PLAN_ID_DEFAUT;
  const s = String(v).trim().toLowerCase();
  return PLAN_ID_RE.test(s) ? s : null;
}
// Entity identifier: same pattern as the one produced by the client (numeric counter, "w18",
// "c1", "1785486063813"). Verified: the 109 ids of the production plan pass. An id is reinjected
// on the client into `data-id="…"` and into a CSS selector: leaving a quote in it is a flaw.
export const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isId = (v: unknown): v is string => isStr(v) && ID_RE.test(v);
// Readable coordinate: finite number within the physical range of a home.
const isCoord = (v: unknown): v is number => isFiniteNum(v) && v >= -COORD_MAX && v <= COORD_MAX;

// Number read from the wire: a number, or a numeric string (some client ops send "1").
// Returns null if the value is not a readable number.
function numOf(v: unknown): number | null {
  if (isFiniteNum(v)) return v;
  if (isStr(v) && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
// STRICT wire boolean: 0/1, false/true, "0"/"1". null for everything else (2, "left", {}...).
function bitOf(v: unknown): 0 | 1 | null {
  if (v === true) return 1;
  if (v === false) return 0;
  const n = numOf(v);
  return (n === 0 || n === 1) ? n : null;
}
// Cleaned name: string, no control characters, no edge whitespace, TRUNCATED to NAME_MAX.
//
// Why truncate and not refuse: a name that's too long is neither dangerous nor inconsistent, and
// the client's input field has NO limit. A refusal used to translate into a `console.warn` on
// the sender, which had already noted that the server held the value: the op was never
// re-emitted and the furniture item NEVER appeared for the peer. With `cells.replace`, a single
// name that was too long brought down all ten cells at once. Truncating applies the change,
// minus a shortened name, which the user sees right away.
// The truncation counts in UTF-16 units but only advances by code point: a surrogate pair
// (emoji) is never cut in half.
function cleanName(v: unknown, code: string): string {
  if (!isStr(v)) throw new OpError(code);       // non-string = malformed op, not a name too long
  let s = "";
  for (const ch of v) {
    const c = ch.codePointAt(0);
    if (c < 32 || c === 127) continue;
    if (s.length + ch.length > NAME_MAX) break;
    s += ch;
  }
  return s.trim();
}

// Application error: reason = short code (English), passed up to the client as-is.
export class OpError extends Error {
  reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

// ---- CONTENT FINGERPRINT: a plan's unambiguous identity ----------------------------------------
// There were two UNRELATED counters carrying the same name `rev`: D1's (number of writes to the
// row) and the Durable Object's (number of ops since its cold load, so reset to 0 on every
// wake-up). The client only adopted the `hello` state if the two differed: when they coincided
// (which happens constantly, both counters sweeping through the same small integers), it kept a
// stale state forever, "live checkmark" badge and all. A fingerprint, on the other hand, depends
// ONLY on content: two identical plans share it, two different plans (practically) never share
// it, and no value can be mistaken for a counter.
// 64 bits rendered as 16 hex characters, by TWO different mixing functions (FNV-1a and djb2-xor):
// a collision would require fooling both at once.
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function djb2x(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}
// Fingerprint of any STRING (also used to recognize a D1 row already seen, byte for byte).
export function strHash(s: string): string {
  const t = String(s);
  return fnv1a(t).toString(16).padStart(8, "0") + djb2x(t).toString(16).padStart(8, "0");
}

// CANONICAL projection of a plan: lists sorted by id, field order fixed by arrays, absent
// optional field rendered explicitly as `null`. The order of lists and the order of keys
// therefore change nothing about the fingerprint: only the content counts.
function canonPlan(plan: PlanState): string {
  if (!plan || typeof plan !== "object") return "x";
  const byId = <T extends { id: string }, R>(l: T[] | null | undefined, f: (value: T) => R): R[] => (Array.isArray(l)
    ? l.slice().sort((a, b) => {
        const x = String(a && a.id), y = String(b && b.id);
        return x < y ? -1 : x > y ? 1 : 0;
      }).map(f)
    : []);
  // ADDING AN ELEMENT HERE CHANGES EVERYONE'S FINGERPRINT: the array grows, so the projection of
  // EVERY entity changes, so a client stuck on the old code will never again agree with the
  // server. This is why `thr` and `leaf` require a Worker deploy FIRST, client second, tabs
  // reloaded (live-worker/DEPLOY.md).
  const pc = (p: Piece) => [String(p.id), p.type ?? null, p.name ?? null, p.x ?? null, p.y ?? null,
    p.w ?? null, p.h ?? null, p.rot ?? null, p.locked ?? null, p.hinge ?? null, p.swing ?? null,
    p.tr ?? null, p.dmin ?? null, p.pair ?? null];
  if (isV5(plan)) {
    return JSON.stringify(["v5",
      plan.outline == null ? null : plan.outline,
      byId(plan.walls, (w) => [String(w.id), w.a ?? null, w.b ?? null, w.t ?? null, w.free ?? null]),
      byId(plan.openings, (o) => [String(o.id), String(o.wallId), o.t0 ?? null, o.w ?? null,
        o.type ?? null, o.side ?? null, o.h ?? null, o.name ?? null, o.hinge ?? null, o.swing ?? null,
        o.leaf ?? null]),
      byId(plan.pieces, pc),
      byId(plan.cells, (c) => [String(c.id), c.poly ?? null, c.name ?? null, c.floor ?? null]),
      !!plan.setupDone,
    ]);
  }
  return JSON.stringify(["v4",
    byId(plan.rooms, (r) => [String(r.id), r.name ?? null, r.floor ?? null, r.ax ?? null, r.ay ?? null,
      (r.room && r.room.poly) ?? null, byId(r.pieces, pc)]),
    plan.envelope == null ? null
      : [plan.envelope.poly ?? null, plan.envelope.floor ?? null, byId(plan.envelope.pieces, pc)],
    !!plan.setupDone,
  ]);
}

// Content fingerprint of a plan (v4 or v5). This is what `hello`, the op echo and `pong` carry:
// the client compares TWO fingerprints that both came from the server, never a fingerprint
// against a counter. It doesn't need to know how to recompute it.
export function planFp(plan: PlanState): string { return strHash(canonPlan(plan)); }

// NEW plan for a household with nothing yet: WALLS-ONLY shape (v5), not the old one.
// Previously, the cold load of an empty D1 installed `{rooms:[], setupDone:false}`, a plan in
// the OLD format: every op from the live client (outline.set, wall.set, piece.set without a
// room) then fell into the v4 path and came back as `no_room` / `op_shape`, the REST fallback
// was short-circuited because the WebSocket was alive, and the two people each configured their
// own apartment without ever sharing anything. `isV5` recognizes this shape (walls is an array),
// so the dispatch starts on the right side right away.
export function emptyPlan(): PlanState {
  return { outline: null, walls: [], openings: [], pieces: [], cells: [], setupDone: false };
}

// Deterministic color by email (same email -> same color, 2 tabs ok).
export function colorFor(email: string): string {
  const s = String(email || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

// ---- validations ----

// ---- "ABSENT FIELD = NO OPINION", generalized to all entities ----------------------------------
// An op was an upsert of a WHOLE entity: when one person renamed a rug while the other resized
// it, the last op overwrote the first one's field, including on the screen of the person who had
// just typed it, and no one was told. The principle already existed for `h`/`name` of an
// opening; it now applies to ALL fields of ALL entities: a key absent from the wire does not
// mean "erase", it means "I have no opinion", so we fall back to the value already in the
// database.
// Two accepted consequences:
//   - ERASING a value stays possible by sending the EXPLICIT neutral value ("" for a name, false
//     for `locked`, 0 for `hinge`); what becomes unexpressible is the TOTAL REMOVAL of an
//     optional key (`hinge`, `swing`) on an entity already in the database. No client does that
//     (a piece of furniture's type never changes after it's placed), and `plan5.replace` remains
//     the explicit path to lay down a whole new state.
//   - the change can only turn a REFUSAL into an acceptance: as long as the client sends complete
//     entities (which is the case today), `base` is never consulted. Nothing that used to pass
//     can stop passing.
// `base` is only kept if it carries the SAME id: two distinct entities are never merged.
const prevOf = <T extends { id: string }>(prev: Map<string, T> | T | null | undefined, id: string): T | null => {
  if (!prev || id === undefined || id === null) return null;
  const e = prev instanceof Map ? prev.get(id) : prev;
  return (e && String(e.id) === String(id)) ? e : null;
};

// Validates ONE piece of furniture and returns a NEW, complete entity. Never returns the wire
// object: the caller inserts the result in a single assignment, so a refused op leaves no trace
// in the shared plan (cf. the atomicity test).
// Optional keys absent from both the wire AND `prev` stay absent from the output: we don't
// invent a `hinge` on a sofa, and revalidating an entity already stored is idempotent.
function validatePiece(p: Partial<Piece>, prev?: Map<string, Piece> | Piece | null): Piece {
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new OpError("piece_obj");
  for (const k of Object.keys(p)) {
    if (!PIECE_KEYS.has(k)) throw new OpError("piece_key:" + k);
  }
  if (!isId(p.id)) throw new OpError("piece_id");
  const base = prevOf(prev, p.id);
  const pick = (k: keyof Piece) => (p[k] !== undefined ? p[k] : (base ? base[k] : undefined));
  // required numeric fields, all bounded to the physical range of a home
  const num: Record<string, number> = {};
  for (const k of ["x", "y", "w", "h", "rot"] as (keyof Piece)[]) {
    const v = pick(k);
    if (!isFiniteNum(v)) throw new OpError("piece_num:" + k);
    if (!isCoord(v)) throw new OpError("piece_range:" + k);
    num[k] = v;
  }
  if (num.w < PIECE_WH_MIN || num.w > PIECE_WH_MAX || num.h < PIECE_WH_MIN || num.h > PIECE_WH_MAX) {
    throw new OpError("piece_wh");
  }
  const out: Piece = { id: p.id, x: num.x, y: num.y, w: num.w, h: num.h, rot: num.rot };
  // type: catalog identifier, shape enforced (cf. TYPE_RE). Refusal, not truncation: an unknown
  // type is not a human label, it's a render key; truncating it would fix nothing.
  const type = pick("type");
  if (type !== undefined) {
    if (!isStr(type) || !TYPE_RE.test(type)) throw new OpError("piece_type");
    out.type = type;
  }
  // name: human label, TRUNCATED (cf. cleanName).
  const name = pick("name");
  if (name !== undefined) out.name = cleanName(name, "piece_name");
  const locked = pick("locked");
  if (locked !== undefined) {
    if (typeof locked !== "boolean") throw new OpError("piece_locked");
    out.locked = locked;
  }
  // hinge: STRICT boolean (the client sends the string "0"/"1"). Used to accept any nested
  // object: 265 KB had thus been stored in a single piece of furniture's field.
  const hinge = pick("hinge");
  if (hinge !== undefined) {
    const b = bitOf(hinge);
    if (b === null) throw new OpError("piece_hinge");
    out.hinge = b;
  }
  // tr / dmin: bounded integers. `pair`: an entity identifier, SAME grammar as the others.
  // The server does NOT check that the target exists: an op pairing a screen deleted at the same
  // instant would be refused, so the pairing would be lost instead of simply orphaned. It's the
  // client that ignores a `pair` which no longer refers to anything (G-18).
  const tr = pick("tr");
  if (tr !== undefined) {
    if (!isFiniteNum(tr) || tr < THROW_RATIO_MIN || tr > THROW_RATIO_MAX) throw new OpError("piece_tr");
    out.tr = Math.round(tr);
  }
  const dmin = pick("dmin");
  if (dmin !== undefined) {
    if (!isFiniteNum(dmin) || dmin < THROW_DMIN_MIN || dmin > THROW_DMIN_MAX) throw new OpError("piece_dmin");
    out.dmin = Math.round(dmin);
  }
  const pair = pick("pair");
  if (pair !== undefined) {
    if (pair === null || pair === "") out.pair = "";
    else if (!isStr(pair) || !ID_RE.test(pair)) throw new OpError("piece_pair");
    else out.pair = pair;
  }
  // swing: bounded string ("1"/"-1") or number. Same bound as on openings.
  const swing = pick("swing");
  if (swing !== undefined) {
    if (!isFiniteNum(swing) && !(isStr(swing) && swing.length <= SWING_MAX)) {
      throw new OpError("piece_swing");
    }
    out.swing = swing;
  }
  return out;
}

function validatePoly(poly: unknown): Point[] {
  if (!Array.isArray(poly) || poly.length < 3) throw new OpError("poly_len");
  if (poly.length > POLY_MAX_PTS) throw new OpError("poly_max");
  for (const pt of poly) {
    if (!Array.isArray(pt) || pt.length !== 2 || !isFiniteNum(pt[0]) || !isFiniteNum(pt[1])) {
      throw new OpError("poly_pt");
    }
    if (!isCoord(pt[0]) || !isCoord(pt[1])) throw new OpError("poly_range");
  }
  return poly as Point[];
}

// Validates a complete room (structure {id,name,floor,room:{poly},pieces:[]}).
// ASYMMETRY ACCEPTED, and written down here because it wasn't before: `validateRoom` and
// `validateEnvelope` do NOT have an allow-list of keys, unlike the four v5 entities
// (PIECE_KEYS / WALL_KEYS / OPENING_KEYS / CELL_KEYS), which reject any unknown field. An
// unknown key on a room is therefore IGNORED (it does not come back out of validation), not
// refused. We leave it that way: v4 is now only a READ path (no live client emits a v4 op), and
// hardening a read path protects nothing while it could refuse an old document.
// `prev` (optional) = the furniture ALREADY in the database for THIS room, indexed by id (cf.
// idMap): this is what "absent field = no opinion" consults. It used to be, before, the array
// INDEX, because `pieces.map(validatePiece)` passes (element, index, array): `prevOf` received
// 0, 1, 2... and rejected them by chance (`String(e.id)` on a number can never equal any id).
// The bug was therefore harmless, but the rule did NOT apply on the v4 path (invariant V-3), and
// a port would have frozen it as-is. The correct site is `sanitizeV5`'s:
// `map((p) => validatePiece(p, prev))`.
function validateRoom(r: Partial<LegacyRoom>, prev?: Map<string, Piece> | null): LegacyRoom {
  if (!r || typeof r !== "object" || Array.isArray(r)) throw new OpError("room_obj");
  if (!isId(r.id)) throw new OpError("room_id");
  if (r.floor !== undefined && !isStr(r.floor) && !isFiniteNum(r.floor)) throw new OpError("room_floor");
  // ax/ay: apartment offset (cm) of the room's local origin. Optional, null = not placed.
  if (r.ax !== undefined && r.ax !== null && !isCoord(r.ax)) throw new OpError("room_ax");
  if (r.ay !== undefined && r.ay !== null && !isCoord(r.ay)) throw new OpError("room_ay");
  if (!r.room || typeof r.room !== "object") throw new OpError("room_geom");
  validatePoly(r.room.poly);
  const pieces = r.pieces === undefined ? [] : r.pieces;
  if (!Array.isArray(pieces)) throw new OpError("room_pieces");
  if (pieces.length > MAX_ENTITIES) throw new OpError("pieces_max");
  const cleanPieces = pieces.map((p) => validatePiece(p, prev || null));
  return {
    id: r.id,
    name: r.name === undefined ? "" : cleanName(r.name, "room_name"),
    floor: r.floor !== undefined ? r.floor : 0,
    ax: (r.ax === undefined || r.ax === null) ? null : r.ax,
    ay: (r.ay === undefined || r.ay === null) ? null : r.ay,
    room: { poly: r.room.poly.map((pt) => [pt[0], pt[1]]) },
    pieces: cleanPieces,
  };
}

// Validates the ENVELOPE (the apartment): {poly:[...], floor?, pieces:[...]}.
// Same validation as a room but without id/name/ax/ay (origin = apartment origin).
// null is tolerated everywhere (plans without an envelope).
// `prev`: same role and same fix as in `validateRoom` above.
function validateEnvelope(e: PlanState["envelope"], prev?: Map<string, Piece> | null): NonNullable<PlanState["envelope"]> | null {
  if (e == null) return null;
  if (typeof e !== "object" || Array.isArray(e)) throw new OpError("env_obj");
  if (!e.poly) throw new OpError("env_geom");
  validatePoly(e.poly);
  if (e.floor !== undefined && !isStr(e.floor) && !isFiniteNum(e.floor)) throw new OpError("env_floor");
  const pieces = e.pieces === undefined ? [] : e.pieces;
  if (!Array.isArray(pieces)) throw new OpError("env_pieces");
  if (pieces.length > MAX_ENTITIES) throw new OpError("pieces_max");
  return {
    poly: e.poly.map((pt) => [pt[0], pt[1]]),
    floor: e.floor !== undefined ? e.floor : "parquet",
    pieces: pieces.map((p) => validatePiece(p, prev || null)),
  };
}

// ---- v5 validations ----

// A point [x,y]: a pair of finite numbers WITHIN the physical range. `code` qualifies the error.
function validatePt(pt: unknown, code: string): Point {
  if (!Array.isArray(pt) || pt.length !== 2 || !isCoord(pt[0]) || !isCoord(pt[1])) {
    throw new OpError(code);
  }
  return [pt[0], pt[1]];
}

// An interior wall: center-to-center segment {id, a:[x,y], b:[x,y], t} (t = thickness cm).
// `prev` = the wall already in the database (optional): an absent key reuses its value, cf. prevOf.
function validateWall(w: Partial<Wall>, prev?: Map<string, Wall> | Wall | null): Wall {
  if (!w || typeof w !== "object" || Array.isArray(w)) throw new OpError("wall_obj");
  for (const k of Object.keys(w)) {
    if (!WALL_KEYS.has(k)) throw new OpError("wall_key:" + k);
  }
  if (!isId(w.id)) throw new OpError("wall_id");
  const base = prevOf(prev, w.id);
  const pick = (k: keyof Wall) => (w[k] !== undefined ? w[k] : (base ? base[k] : undefined));
  const a = validatePt(pick("a"), "wall_pt:a");
  const b = validatePt(pick("b"), "wall_pt:b");
  const t = pick("t");
  if (!isFiniteNum(t) || t < WALL_T_MIN || t > WALL_T_MAX) throw new OpError("wall_t");
  const out: Wall = { id: w.id, a, b, t };
  // `free` ABSENT stays absent: it is not 0. A wall from before this field did not "choose" to
  // reach through, it does so by default -- and writing 0 everywhere would move the fingerprint
  // of every existing plan for nothing.
  const free = pick("free");
  if (free !== undefined) {
    const n = numOf(free);
    if (n === null || !WALL_FREE.has(n)) throw new OpError("wall_free");
    if (n) out.free = 1;
  }
  return out;
}

// A parametric opening placed on a wall:
//   {id, wallId, t0, w, type, side, h?, name?, hinge?, swing?}
// t0 = distance from wall.a along the wall (cm). `wallIds` = ids of existing walls (mandatory reference).
// `prev` = Map id -> opening ALREADY in the database (optional), cf. the note on h/name below.
//
// ---- TWO shapes accepted on the wire, ONLY ONE in the database ----
// UNPACKED (up-to-date client): `side` is a key in its own right and `hinge` is a pure 0/1
// boolean. PACKED (client from before the widening, still loaded in a tab): no `side` key, and
// `hinge` carries TWO bits: bit 1 = side, bit 0 = hinge, so an integer 0..3.
// The discriminant is the PRESENCE of the `side` key: no old emission carries it, and over the
// shared range (0 and 1) the two readings coincide exactly (side=0, hinge=0/1). The database
// only stores the unpacked shape, `side` ALWAYS written: revalidating an already stored state is
// therefore idempotent (side present -> a pure hinge is not unpacked again).
function validateOpening(o: Partial<Opening>, wallIds: Set<string> | null, prev?: Map<string, Opening> | Opening | null): Opening {
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new OpError("opening_obj");
  for (const k of Object.keys(o)) {
    if (!OPENING_KEYS.has(k)) throw new OpError("opening_key:" + k);
  }
  if (!isId(o.id)) throw new OpError("opening_id");
  // "absent field = no opinion" applies here to ALL fields, not just h/name anymore.
  const old = prevOf(prev, o.id);
  const pick = (k: keyof Opening) => (o[k] !== undefined ? o[k] : (old ? old[k] : undefined));

  const wallId = pick("wallId");
  if (!isId(wallId) || (wallIds && !wallIds.has(wallId))) throw new OpError("opening_wall");
  // t0: distance along the wall. Bounded by the physical range, NOT by the wall's length: the
  // client sometimes shortens a wall before recalibrating its openings, and refusing the
  // intermediate state would make the opening disappear for the peer (a refused op is never
  // re-emitted).
  const t0 = pick("t0");
  if (!isFiniteNum(t0) || t0 < 0 || t0 > COORD_MAX) throw new OpError("opening_t0");
  const ow = pick("w");
  if (!isFiniteNum(ow) || ow < OPENING_W_MIN || ow > OPENING_W_MAX) throw new OpError("opening_w");
  const type = pick("type");
  if (!isStr(type) || !OPENING_TYPES.has(type)) throw new OpError("opening_type");

  // side / hinge: three cases, in this order.
  //   - `side` PRESENT (up-to-date client, unpacked shape): `hinge` is a pure 0/1 boolean;
  //   - `side` absent but `hinge` present (old client, PACKED shape): `hinge` carries two bits,
  //     bit 1 = side, bit 0 = hinge;
  //   - NEITHER one NOR the other: no opinion, we keep what's in the database. This case used to
  //     fall back to the packed shape and reset `side` to 0: a partial op (or an op from an old
  //     client that doesn't touch the side) silently flipped the opening's face.
  let side, hinge;
  if (o.side !== undefined) {
    side = bitOf(o.side);
    if (side === null || !OPENING_SIDES.has(side)) throw new OpError("opening_side");
    if (o.hinge !== undefined) {
      hinge = bitOf(o.hinge);
      if (hinge === null) throw new OpError("opening_hinge");
    } else hinge = old ? old.hinge : undefined;
  } else if (o.hinge !== undefined) {
    const n = numOf(o.hinge);
    if (n === null || !Number.isInteger(n) || n < 0 || n > 3) throw new OpError("opening_hinge");
    side = (n >> 1) & 1;
    hinge = n & 1;
  } else {
    side = old && OPENING_SIDES.has(old.side) ? old.side : 0;
    hinge = old ? old.hinge : undefined;
  }
  // swing: unchanged (bounded string or number; the client sends 1 / -1).
  const swing = pick("swing");
  if (swing !== undefined && !isFiniteNum(swing) && !(isStr(swing) && swing.length <= SWING_MAX)) {
    throw new OpError("opening_swing");
  }
  const rawH = pick("h");
  const rawName = pick("name");

  const out: Opening = { id: o.id, wallId, t0, w: ow, type, side };
  if (rawH !== undefined) {
    if (!isFiniteNum(rawH) || rawH < OPENING_H_MIN || rawH > OPENING_H_MAX) throw new OpError("opening_h");
    out.h = rawH;
  }
  if (rawName !== undefined) out.name = cleanName(rawName, "opening_name");
  if (hinge !== undefined) out.hinge = hinge;
  if (swing !== undefined) out.swing = swing;
  const leaf = pick("leaf");
  if (leaf !== undefined) {
    const n = numOf(leaf);
    if (n === null || !OPENING_LEAVES.has(n)) throw new OpError("opening_leaf");
    out.leaf = n;
  }
  return out;
}

// Id -> entity index, for a family of a v5 plan already in the database (empty if the list doesn't exist).
function idMap<T extends { id: string }>(list: T[] | null | undefined): Map<string, T> {
  const m = new Map<string, T>();
  if (Array.isArray(list)) for (const e of list) { if (e && e.id !== undefined) m.set(e.id, e); }
  return m;
}
function openingMap(plan: PlanState | null | undefined): Map<string, Opening> { return idMap(plan && plan.openings); }
// The four indexes of a v5 plan already in the database: what "absent field = no opinion" consults.
function prevMaps(plan: PlanState | null | undefined) {
  if (!plan || typeof plan !== "object") return null;
  return {
    walls: idMap(plan.walls), openings: idMap(plan.openings),
    pieces: idMap(plan.pieces), cells: idMap(plan.cells),
  };
}

// A cell = DERIVED room (the poly is recomputed on the client): {id, poly, name, floor}.
// The server detects nothing, it keeps the last known poly + metadata.
function validateCell(c: Partial<Omit<Cell, "floor">> & { floor?: string | number }, prev?: Map<string, Cell> | Cell | null): Cell {
  if (!c || typeof c !== "object" || Array.isArray(c)) throw new OpError("cell_obj");
  for (const k of Object.keys(c)) {
    if (!CELL_KEYS.has(k)) throw new OpError("cell_key:" + k);
  }
  if (!isId(c.id)) throw new OpError("cell_id");
  const base = prevOf(prev, c.id);
  const pick = (k: keyof Cell) => (c[k] !== undefined ? c[k] : (base ? base[k] : undefined));
  const poly = validatePoly(pick("poly"));
  const floor = pick("floor");
  if (floor !== undefined && (!isStr(floor) || !CELL_FLOORS.has(floor))) throw new OpError("cell_floor");
  const name = pick("name");
  return {
    id: c.id,
    poly: poly.map((pt) => [pt[0], pt[1]]),
    // Name TRUNCATED, never refused: on cells.replace, a single name that was too long brought
    // down all ten cells at once, so ten rooms disappeared for the peer.
    name: name === undefined ? "" : cleanName(name, "cell_name"),
    floor: isStr(floor) ? floor : "parquet",
  };
}

// Checks the uniqueness of the ids of a list of already validated entities.
function assertUniqueIds<T extends { id: string }>(list: T[], code: string): Set<string> {
  const seen = new Set<string>();
  for (const e of list) {
    if (seen.has(e.id)) throw new OpError(code);
    seen.add(e.id);
  }
  return seen;
}

// Cleans a complete v5 state: {outline, walls, openings, pieces, cells, setupDone}.
// Absent lists are treated as []; outline can be null (volume not yet drawn).
// `prev` (optional) = the four indexes of the plan ALREADY in the database (cf. prevMaps): a
// complete replacement coming from an old client must not erase fields it doesn't know how to carry.
function sanitizeV5(st: PlanState, prev: ReturnType<typeof prevMaps>): PlanState {
  if (!st || typeof st !== "object" || Array.isArray(st)) throw new OpError("state_shape");
  const outline = st.outline == null ? null
    : validatePoly(st.outline).map((pt) => [pt[0], pt[1]] as Point);

  const rawWalls = st.walls === undefined || st.walls === null ? [] : st.walls;
  if (!Array.isArray(rawWalls)) throw new OpError("walls_arr");
  if (rawWalls.length > MAX_ENTITIES) throw new OpError("walls_max");
  const walls = rawWalls.map((w) => validateWall(w, prev && prev.walls));
  const wallIds = assertUniqueIds(walls, "wall_dup");

  const rawOpenings = st.openings === undefined || st.openings === null ? [] : st.openings;
  if (!Array.isArray(rawOpenings)) throw new OpError("openings_arr");
  if (rawOpenings.length > MAX_ENTITIES) throw new OpError("openings_max");
  const openings = rawOpenings.map((o) => validateOpening(o, wallIds, prev && prev.openings));
  assertUniqueIds(openings, "opening_dup");

  const rawPieces = st.pieces === undefined || st.pieces === null ? [] : st.pieces;
  if (!Array.isArray(rawPieces)) throw new OpError("pieces_arr");
  if (rawPieces.length > MAX_ENTITIES) throw new OpError("pieces_max");
  const pieces = rawPieces.map((p) => validatePiece(p, prev && prev.pieces));
  assertUniqueIds(pieces, "piece_dup");

  const rawCells = st.cells === undefined || st.cells === null ? [] : st.cells;
  if (!Array.isArray(rawCells)) throw new OpError("cells_arr");
  if (rawCells.length > MAX_ENTITIES) throw new OpError("cells_max");
  const cells = rawCells.map((c) => validateCell(c, prev && prev.cells));
  assertUniqueIds(cells, "cell_dup");

  return { outline, walls, openings, pieces, cells, setupDone: !!st.setupDone };
}

// Shape of a state ALREADY stored (post-sanitize): v5 as soon as it carries walls/outline as an array.
export function isV5(plan: PlanState): boolean {
  return !!plan && typeof plan === "object" && (Array.isArray(plan.walls) || Array.isArray(plan.outline));
}

// Cleans a complete state, v4 OR v5. The shape is detected from the presence of outline/walls
// (a v4 state has neither). Each shape is validated with its own grid.
// `prev` (optional) = the plan ALREADY in the database. It gives v4 what `plan5.replace` already
// gives v5: a complete replacement coming from an old client must not erase fields it doesn't
// know how to carry ("absent field = no opinion", V-3). Absent, the validation is that of a new plan.
export function sanitizeState(st: PlanState, prev?: PlanState): PlanState {
  if (!st || typeof st !== "object" || Array.isArray(st)) throw new OpError("state_shape");
  if (st.outline !== undefined || st.walls !== undefined) return sanitizeV5(st, prev ? prevMaps(prev) : null);
  if (!Array.isArray(st.rooms)) throw new OpError("state_shape");
  if (st.rooms.length > MAX_ENTITIES) throw new OpError("rooms_max");
  // The `prev` of a room's piece of furniture is the piece of furniture with the SAME id in the
  // room with the SAME id: two distinct entities, or two distinct rooms, are never merged.
  const salles = prev && Array.isArray(prev.rooms) ? idMap(prev.rooms) : null;
  const rooms = st.rooms.map((r) => {
    const av = salles && r && r.id !== undefined ? salles.get(r.id) : null;
    return validateRoom(r, av ? idMap(av.pieces) : null);
  });
  const envAv = prev && prev.envelope && Array.isArray(prev.envelope.pieces) ? idMap(prev.envelope.pieces) : null;
  const envelope = validateEnvelope(st.envelope == null ? null : st.envelope, envAv);
  return { rooms, envelope, setupDone: !!st.setupDone };
}

function findRoom(plan: PlanState, roomId: string): LegacyRoom {
  const r = plan.rooms.find((x) => x.id === roomId);
  if (!r) throw new OpError("no_room");
  return r;
}

// Generates a fresh id unique within the plan (for a merge in case of collision).
function freshId(existing: Set<string>, base: string): string {
  let id = base;
  let n = 1;
  while (existing.has(id)) id = base + "-" + n++;
  existing.add(id);
  return id;
}

// ---- applying ops ----
// Mutates and returns `plan` (the caller has already cloned the state before calling applyOp
// if it wants immutability; here we mutate in place, the DO caller stores the result).
//
// Dispatch by state SHAPE: a v4 state only accepts v4 ops, a v5 state only v5 ops. An op
// addressed to the other shape -> OpError("op_shape"): a v4 client left open therefore cannot
// overwrite a v5 plan (its plan.replace is refused, not applied). One exception: plan5.replace,
// the SWITCHOVER op, accepted regardless of the current shape.
// `piece.front` was REMOVED from both sets and both dispatch tables: no client emits it
// (exhaustive census of the client's `wsSend`/`wsSendOp`: op, cursor, drag, chat, ping, hello).
// The client keeps a RECEIVE branch for it, also dead, to be removed client-side.
const V4_KINDS = new Set([
  "piece.set", "piece.del", "room.add", "room.del", "room.set",
  "plan.replace", "rooms.merge", "env.set", "env.del", "env.piece.set", "env.piece.del",
]);
const V5_KINDS = new Set([
  "piece.set", "piece.del", "outline.set", "wall.set", "wall.del",
  "opening.set", "opening.del", "cell.set", "cells.replace",
]);

export function applyOp(plan: PlanState, op: Operation): PlanState {
  if (!op || typeof op !== "object") throw new OpError("op_obj");
  if (op.kind === "plan5.replace") {
    // v4 -> v5 switchover (or complete v5 replacement: conversion, import).
    // The payload MUST be v5-shaped: otherwise we would silently install an empty plan.
    if (!op.plan || typeof op.plan !== "object" || Array.isArray(op.plan)
      || (op.plan.outline === undefined && op.plan.walls === undefined)) {
      throw new OpError("state_shape");
    }
    // An undo/import coming from an old client sends back ALL its entities in the shape it knows
    // how to write, so amputated of the fields it doesn't know about: we start from those
    // already in the database so as not to lose them along the way (absent field = no opinion,
    // cf. prevOf).
    const clean = sanitizeV5(op.plan, prevMaps(plan));
    delete plan.rooms;
    delete plan.envelope;
    plan.outline = clean.outline;
    plan.walls = clean.walls;
    plan.openings = clean.openings;
    plan.pieces = clean.pieces;
    plan.cells = clean.cells;
    plan.setupDone = clean.setupDone;
    return plan;
  }
  return isV5(plan) ? applyOpV5(plan, op) : applyOpV4(plan, op);
}

function applyOpV4(plan: PlanState, op: Operation): PlanState {
  switch (op.kind) {
    case "piece.set": {
      const r = findRoom(plan, op.roomId);
      const piece = validatePiece(op.piece, idMap(r.pieces));
      const i = r.pieces.findIndex((p) => p.id === piece.id);
      if (i >= 0) r.pieces[i] = piece;
      else {
        if (r.pieces.length >= MAX_ENTITIES) throw new OpError("pieces_max");
        r.pieces.push(piece);
      }
      return plan;
    }
    case "piece.del": {
      const r = findRoom(plan, op.roomId);
      if (!isStr(op.pieceId)) throw new OpError("piece_id");
      r.pieces = r.pieces.filter((p) => p.id !== op.pieceId);
      return plan;
    }
    case "room.add": {
      const room = validateRoom(op.room);
      if (plan.rooms.some((x) => x.id === room.id)) throw new OpError("room_exists");
      if (plan.rooms.length >= MAX_ENTITIES) throw new OpError("rooms_max");
      plan.rooms.push(room);
      return plan;
    }
    case "room.del": {
      findRoom(plan, op.roomId);
      if (plan.rooms.length <= 1) throw new OpError("last_room");
      plan.rooms = plan.rooms.filter((x) => x.id !== op.roomId);
      return plan;
    }
    case "room.set": {
      // EVERYTHING is validated in local variables before any write at all: a refused poly must
      // not leave the already-applied name behind it (an unannounced partial mutation).
      const r = findRoom(plan, op.roomId);
      const patch: Partial<Pick<LegacyRoom, "name" | "floor" | "ax" | "ay">> = {};
      if (op.name !== undefined) patch.name = cleanName(op.name, "room_name");
      if (op.floor !== undefined) {
        if (!isStr(op.floor) && !isFiniteNum(op.floor)) throw new OpError("room_floor");
        patch.floor = op.floor;
      }
      if (op.ax !== undefined) {
        if (op.ax !== null && !isCoord(op.ax)) throw new OpError("room_ax");
        patch.ax = op.ax;
      }
      if (op.ay !== undefined) {
        if (op.ay !== null && !isCoord(op.ay)) throw new OpError("room_ay");
        patch.ay = op.ay;
      }
      let poly;
      if (op.poly !== undefined) poly = validatePoly(op.poly).map((pt) => [pt[0], pt[1]] as Point);
      Object.assign(r, patch);
      if (poly) r.room.poly = poly;
      return plan;
    }
    case "plan.replace": {
      // `plan` second: an undo / import coming from an old client sends back its entities
      // amputated of the fields it doesn't know about. Symmetric to what `plan5.replace` already
      // does with `prevMaps(plan)`.
      const clean = sanitizeState(op.state, plan);
      // plan.replace serves ONLY v4: the shape switchover goes through plan5.replace.
      if (isV5(clean)) throw new OpError("op_shape");
      plan.rooms = clean.rooms;
      plan.envelope = clean.envelope;
      plan.setupDone = clean.setupDone;
      return plan;
    }
    case "env.set": {
      // Creates/updates the envelope (poly and/or floor). The COMPLETE envelope is built on the
      // side, then laid down in a single assignment: an `env.set {floor}` on a plan without an
      // envelope is refused WITHOUT leaving a {poly:null} skeleton behind it, which used to
      // poison the plan and make every subsequent cold load fail (env_geom).
      const cur = plan.envelope == null ? null : plan.envelope;
      const next = {
        poly: cur ? cur.poly : null,
        floor: cur ? cur.floor : "parquet",
        pieces: (cur && Array.isArray(cur.pieces)) ? cur.pieces : [],
      };
      if (op.poly !== undefined) next.poly = validatePoly(op.poly).map((pt) => [pt[0], pt[1]]);
      if (op.floor !== undefined) {
        if (!isStr(op.floor) && !isFiniteNum(op.floor)) throw new OpError("env_floor");
        next.floor = op.floor;
      }
      // env.set must establish a valid envelope: refuses a skeleton without a poly.
      if (!next.poly) throw new OpError("env_geom");
      plan.envelope = next;
      return plan;
    }
    case "env.del": {
      plan.envelope = null;
      return plan;
    }
    case "env.piece.set": {
      if (plan.envelope == null) throw new OpError("no_env");
      const list = Array.isArray(plan.envelope.pieces) ? plan.envelope.pieces : [];
      const piece = validatePiece(op.piece, idMap(list));
      const i = list.findIndex((p) => p.id === piece.id);
      if (i >= 0) list[i] = piece;
      else {
        if (list.length >= MAX_ENTITIES) throw new OpError("pieces_max");
        list.push(piece);
      }
      plan.envelope.pieces = list;
      return plan;
    }
    case "env.piece.del": {
      if (plan.envelope == null) return plan; // idempotent no-op
      if (!isStr(op.pieceId)) throw new OpError("piece_id");
      if (!Array.isArray(plan.envelope.pieces)) plan.envelope.pieces = [];
      plan.envelope.pieces = plan.envelope.pieces.filter((p) => p.id !== op.pieceId);
      return plan;
    }
    case "rooms.merge": {
      if (!Array.isArray(op.rooms)) throw new OpError("merge_rooms");
      const ids = new Set(plan.rooms.map((r) => r.id));
      // Everything is validated and re-identified BEFORE the first insertion: an invalid room in
      // third position must not leave the first two in the shared plan.
      const merged = [];
      for (const raw of op.rooms) {
        const room = validateRoom(raw);
        if (ids.has(room.id)) room.id = freshId(ids, room.id);
        else ids.add(room.id);
        merged.push(room);
      }
      if (plan.rooms.length + merged.length > MAX_ENTITIES) throw new OpError("rooms_max");
      for (const room of merged) plan.rooms.push(room);
      return plan;
    }
    default:
      // v5 op sent to a v4 state -> op_shape; otherwise a genuinely unknown op.
      throw new OpError(V5_KINDS.has(op.kind) ? "op_shape" : "unknown_kind");
  }
}

// ---- v5 ops ----
// Furniture lives in a FLAT list plan.pieces (apartment coordinates), no more per-room array:
// piece.set / piece.del therefore do NOT have a roomId here.
function applyOpV5(plan: PlanState, op: Operation): PlanState {
  // Safety net: a partial v5 state (coming from an old snapshot) must have its 4 lists.
  if (!Array.isArray(plan.walls)) plan.walls = [];
  if (!Array.isArray(plan.openings)) plan.openings = [];
  if (!Array.isArray(plan.pieces)) plan.pieces = [];
  if (!Array.isArray(plan.cells)) plan.cells = [];
  switch (op.kind) {
    case "outline.set": {
      // {kind:"outline.set", outline:[[x,y],...]} — the apartment's volume.
      plan.outline = validatePoly(op.outline).map((pt) => [pt[0], pt[1]]);
      return plan;
    }
    case "wall.set": {
      // {kind:"wall.set", wall:{id,a,b,t}} — upsert by id. Absent keys reuse the value of the
      // wall already in the database: two people can move one an endpoint, the other the thickness.
      const wall = validateWall(op.wall, idMap(plan.walls));
      const i = plan.walls.findIndex((w) => w.id === wall.id);
      if (i >= 0) plan.walls[i] = wall;
      else {
        if (plan.walls.length >= MAX_ENTITIES) throw new OpError("walls_max");
        plan.walls.push(wall);
      }
      return plan;
    }
    case "wall.del": {
      // {kind:"wall.del", wallId} — CASCADE: the openings carried by this wall leave with it
      // (an opening without a wall no longer has any geometry; refusing would leave the client stuck).
      if (!isStr(op.wallId)) throw new OpError("wall_id");
      plan.walls = plan.walls.filter((w) => w.id !== op.wallId);
      plan.openings = plan.openings.filter((o) => o.wallId !== op.wallId);
      return plan;
    }
    case "opening.set": {
      // {kind:"opening.set", opening:{id,wallId,t0,w,type,side,h?,name?,hinge?,swing?}} — upsert,
      // referenced wall mandatory. The packed shape (no `side`) from an old client is accepted
      // and unpacked; h/name absent are reused from the opening already in the database.
      const wallIds = new Set(plan.walls.map((w) => w.id));
      const opening = validateOpening(op.opening, wallIds, openingMap(plan));
      const i = plan.openings.findIndex((o) => o.id === opening.id);
      if (i >= 0) plan.openings[i] = opening;
      else {
        if (plan.openings.length >= MAX_ENTITIES) throw new OpError("openings_max");
        plan.openings.push(opening);
      }
      return plan;
    }
    case "opening.del": {
      // {kind:"opening.del", openingId} — idempotent no-op if absent.
      if (!isStr(op.openingId)) throw new OpError("opening_id");
      plan.openings = plan.openings.filter((o) => o.id !== op.openingId);
      return plan;
    }
    case "cell.set": {
      // {kind:"cell.set", cellId, name?, floor?, poly?} — metadata of a derived room.
      // poly is computed on the client: we accept it to keep the server snapshot fresh.
      // The COMPLETE cell is built on the side then validated as one block, and is only inserted
      // at the very end. The old version pushed {poly:[]} first: a name too long then threw
      // cell_name, leaving an empty-polygon cell in the shared plan, which the first successful
      // op persisted and which made EVERY cold load fail (poly_len).
      if (!isId(op.cellId)) throw new OpError("cell_id");
      const i = plan.cells.findIndex((x) => x.id === op.cellId);
      const cur = i >= 0 ? plan.cells[i] : null;
      // Cell not yet known to the server: creatable only if the client provides its geometry.
      if (!cur && op.poly === undefined) throw new OpError("no_cell");
      const draft = {
        id: op.cellId,
        poly: op.poly !== undefined ? op.poly : cur.poly,
        name: op.name !== undefined ? op.name : (cur ? cur.name : ""),
        floor: op.floor !== undefined ? op.floor : (cur ? cur.floor : "parquet"),
      };
      const cell = validateCell(draft);
      if (i >= 0) plan.cells[i] = cell;
      else {
        if (plan.cells.length >= MAX_ENTITIES) throw new OpError("cells_max");
        plan.cells.push(cell);
      }
      return plan;
    }
    case "cells.replace": {
      // {kind:"cells.replace", cells:[{id,poly,name,floor}]} — after complete re-detection.
      if (!Array.isArray(op.cells)) throw new OpError("cells_arr");
      if (op.cells.length > MAX_ENTITIES) throw new OpError("cells_max");
      const prevCells = idMap(plan.cells);
      const cells = op.cells.map((c) => validateCell(c, prevCells));
      assertUniqueIds(cells, "cell_dup");
      plan.cells = cells;
      return plan;
    }
    case "piece.set": {
      // Absent keys = no opinion: a rename and a resize happening simultaneously on the SAME
      // piece of furniture get merged instead of the last one overwriting the other's field.
      const piece = validatePiece(op.piece, idMap(plan.pieces));
      const i = plan.pieces.findIndex((p) => p.id === piece.id);
      if (i >= 0) plan.pieces[i] = piece;
      else {
        if (plan.pieces.length >= MAX_ENTITIES) throw new OpError("pieces_max");
        plan.pieces.push(piece);
      }
      return plan;
    }
    case "piece.del": {
      if (!isStr(op.pieceId)) throw new OpError("piece_id");
      plan.pieces = plan.pieces.filter((p) => p.id !== op.pieceId);
      return plan;
    }
    default:
      // v4 op (room.*, env.*, plan.replace, rooms.merge) sent to a v5 state -> op_shape.
      throw new OpError(V4_KINDS.has(op.kind) ? "op_shape" : "unknown_kind");
  }
}

// ---- EPHEMERAL messages relayed as-is to the peer (cursor, drag) ----
// They never touch the plan, so they used to escape all validation; they are nonetheless
// reinjected by the client into a CSS SELECTOR (`.piece[data-id="…"]`, where a `"]` makes
// querySelector throw) and into styles (`left: ${x}px`, where a non-numeric value produces
// "NaNpx"). We return a CLEAN object rebuilt field by field, or null if the message is
// inadmissible (in that case nothing is relayed: losing a cursor frame has no consequence).

// Wire container label ("__apt__" today). Same shape as an entity id.
const isWireRoom = (v: unknown): v is string | null | undefined => v == null || isId(v);
// A cursor is NOT plan geometry: it follows the pointer, so it can go very far outside the home
// at low zoom (the client goes down to 0.05 px/cm). We bound it much more loosely than
// COORD_MAX: what we want here is a finite number (no "NaNpx" for the peer), not a physical
// constraint. A lost cursor frame would have no consequence, but a cursor that silently freezes
// on zoom-out would be a false problem of our own making.
const WIRE_COORD_MAX = 10_000_000;
const isWireNum = (v: unknown): v is number => isFiniteNum(v) && v >= -WIRE_COORD_MAX && v <= WIRE_COORD_MAX;

export function sanitizeCursor(msg: CursorMessage): CursorMessage | null {
  if (!msg || typeof msg !== "object") return null;
  const room = msg.room ?? null;
  if (!isWireRoom(room)) return null;
  // room/x/y set to null = "cursor off canvas", a shape explicitly emitted by the client.
  if (room === null || msg.x == null || msg.y == null) return { room: null, x: null, y: null };
  if (!isWireNum(msg.x) || !isWireNum(msg.y)) return null;
  return { room, x: msg.x, y: msg.y };
}

export function sanitizeDrag(msg: DragMessage): DragMessage | null {
  if (!msg || typeof msg !== "object") return null;
  const room = msg.room ?? null;
  if (!isWireRoom(room)) return null;
  if (!isId(msg.pieceId)) return null;
  if (!isWireNum(msg.x) || !isWireNum(msg.y)) return null;
  const out: DragMessage = { room, pieceId: msg.pieceId, x: msg.x, y: msg.y, rot: null };
  if (msg.rot != null) {
    if (!isWireNum(msg.rot)) return null;
    out.rot = msg.rot;
  }
  return out;
}
