// Pure logic for applying/validating ops on the canonical plan. No Cloudflare/DO dependency:
// testable under node. Every op is idempotent (each sets a WHOLE entity), so the echo, a replay
// and a re-emission after a `gap` are all risk-free.

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
  lm?: number;
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
  lm?: number;
}

export interface Cell {
  id: string;
  poly: Point[];
  name: string;
  floor: string;
  lux?: number;
}

/**
 * Canonical shape of storage and the wire. ONE model: the walls-only plan (decision 0021). A row
 * still written in one of the formats that came before it is no longer READ: `sanitizeState`
 * refuses it, so `coldLoad` serves its bytes verbatim (`source:"raw"`) and no op can write over
 * them.
 */
export interface PlanState {
  outline?: Point[] | null;
  walls?: Wall[];
  openings?: Opening[];
  pieces?: Piece[];
  cells?: Cell[];
  setupDone: boolean;
}

/** Common envelope for operations; each `kind` is validated in its own dedicated switch. */
export interface Operation {
  kind: string;
  plan?: PlanState;
  piece?: Piece;
  pieceId?: string;
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
  lux?: number;
}

export interface CursorMessage {
  room?: string | null; x?: number | null; y?: number | null;
  /**
   * CURSOR CHAT ("/", FigJam-style): the LIVE text of what its author is typing, riding the
   * SAME `cursor` message so it follows the pointer with no extra synchronization. Absent =
   * "no opinion" (an ordinary position ping, box not open); `null` = an EXPLICIT "I stopped
   * speaking" (box closed: Enter, Escape, blur); a string = the current, letter-by-letter text.
   * Cleaned by `cleanCursorSay` below: never persisted, never entered into chat history, never
   * an op, it never touches `plan`.
   */
  say?: string | null;
}
export interface DragMessage extends CursorMessage { pieceId?: string; rot?: number | null }

const COLORS = ["#1f6f78", "#b04a3d", "#7c8a6b", "#8a6e8e"];

// Allowed keys of a piece (furniture item). Everything else is rejected.
export const PIECE_KEYS = new Set([
  "id", "type", "name", "x", "y", "w", "h", "rot", "locked", "hinge", "swing",
  // VIDEO PROJECTOR: properties of the DEVICE, not the derived projection distance. `tr` throw
  // ratio x100 (integer, never a float in the fingerprint), `dmin` min focus distance cm, `pair`
  // paired screen id. The server doesn't know the catalog, so it can't require only a projector
  // carries these (G-18: server bounds the dangerous, client bounds the sensible).
  "tr", "dmin", "pair",
  // LIGHT FIXTURE: `lm`, the luminous flux it radiates. Absent = the client falls back on its
  // type's default; the server doesn't know the catalog, so it only bounds the number.
  "lm",
]);

// ---- the "wall-partition" model, the only one ----
// Allowed keys of its entities. Same severity as PIECE_KEYS: everything else is rejected.
export const WALL_KEYS = new Set(["id", "a", "b", "t",
  // `free`: this partition does NOT extend until it meets something (a v5 wall reaches through by
  // default). Absent = historical behavior, so no existing plan moves.
  "free"]);
export const OPENING_KEYS = new Set(["id", "wallId", "t0", "w", "h", "type", "side", "name", "hinge", "swing",
  // `leaf`: HOW a window opens. Absent/0 = fixed (no swing arc), 1 = one leaf, 2 = double window.
  // Absent default is what makes the addition safe: nothing changes appearance until set.
  "leaf",
  // `lm`: a wall light and a window are openings, and both are light sources.
  "lm"]);
// `lux`: the room's own lighting target. Absent = the client deduces it from the room's name.
export const CELL_KEYS = new Set(["id", "poly", "name", "floor", "lux"]);
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
/** Luminous flux of a light fixture, lumens. 0 = off; 20 000 lm is already a stadium floodlight. */
export const LM_MIN = 0, LM_MAX = 20000;
/** A room's lighting target, lux. 0 = no opinion; 2000 lx is an operating theatre. */
export const LUX_MIN = 0, LUX_MAX = 2000;
// Allowed floor coverings for a cell (mirrors FLOORS on the client).
export const CELL_FLOORS = new Set(["parquet", "herringbone", "tile", "plain"]);
// v5 geometric bounds (cm).
export const WALL_T_MIN = 1, WALL_T_MAX = 60;
export const OPENING_W_MIN = 1, OPENING_W_MAX = 600;
// h of an opening = DEPTH of its box in TOP-DOWN VIEW, not a ceiling height. Mirrors the client
// clamp (`sanitizeV5Plan`): any tighter, a wrongly refused op makes an edit vanish in silence.
export const OPENING_H_MIN = 1, OPENING_H_MAX = 200;
// Max length of a name, aligned with piece.name / cell.name.
export const NAME_MAX = 80;

// ---- VOLUME and RANGE bounds (defense against a crazed client or a forged wire) ----
// Coordinates are cm in the apartment frame; 100,000 cm = 1km, thirty times the largest plausible
// home, rejects nothing legitimate but bounds a forged 1e308.
export const COORD_MAX = 100_000;
// Vertices of a polygon (outline, cell); entities per family (walls/openings/furniture/cells).
// Both generously bound the snapshot without rejecting any real plan.
export const POLY_MAX_PTS = 2000;
export const MAX_ENTITIES = 2000;
// Bounds of a piece of furniture (cm). Unchanged, extracted into constants.
export const PIECE_WH_MIN = 1, PIECE_WH_MAX = 3000;
// `swing`: opening direction. The client sends "1" / "-1" (furniture) or 1 / -1 (opening).
// Same bound on both sides: without it, `swing` accepted a 5 MB string on a piece of furniture.
export const SWING_MAX = 80;
// `type` of a piece of furniture: an id from the client catalog. We do NOT mirror the list (a
// catalog addition would then need a Worker redeploy first); we impose the SHAPE of an
// identifier, enough to rule out injection.
export const TYPE_RE = /^[a-z0-9_-]{1,32}$/;

// ---- A PLAN'S IDENTIFIER -----------------------------------------------------------------------
// Serves TWO purposes that must stay in agreement: the D1 row key, and the Durable Object name
// (`idFromName`). One narrow grammar, or realtime and REST fallback could disagree on the
// document. `main` is the household's historical plan and the default.
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
// Cleaned name: string, no control characters, no edge whitespace, TRUNCATED (never refused, D-14)
// to NAME_MAX. Counts in UTF-16 units but only advances by code point: a surrogate pair (emoji)
// is never cut in half.
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

// ---- CONTENT FINGERPRINT: a plan's unambiguous identity (C-2) -----------------------------------
// Depends ONLY on content, unlike the two unrelated counters that used to share the name `rev`
// (D1's row-write count vs. the Durable Object's op count, reset on every wake-up): two identical
// plans share a fingerprint, two different plans practically never do. 64 bits as 16 hex
// characters, by TWO mixing functions (FNV-1a and djb2-xor) in one pass over the string.
export function strHash(s: string): string {
  const t = String(s);
  let f = 0x811c9dc5, d = 5381;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    f = Math.imul(f ^ c, 16777619) >>> 0;
    d = (Math.imul(d, 33) ^ c) >>> 0;
  }
  return f.toString(16).padStart(8, "0") + d.toString(16).padStart(8, "0");
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

// Content fingerprint of a plan. This is what `hello`, the op echo and `pong` carry:
// the client compares TWO fingerprints that both came from the server, never a fingerprint
// against a counter. It doesn't need to know how to recompute it.
export function planFp(plan: PlanState): string { return strHash(canonPlan(plan)); }

// NEW plan for a household with nothing yet: WALLS-ONLY shape (v5). `isV5` recognizes this shape
// (walls is an array), so the dispatch starts on the right side right away.
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

// ---- GUEST IDENTITY (decision 0004, batch 2) ---------------------------------------------------
// A guest carries no Access-verified email, so identity fields are cleaned twice: once when
// `functions/ws.ts` forwards the invite's `last_name` as a header, and again here for a name
// arriving later over an open socket (`{t:"name"}`), which never passes through a Function.
// Same cap as `functions/nom.ts`: a plan name keeps its historical 80/60, a guest name is tighter.
export const GUEST_NAME_MAX = 40;
const CONTROLE_BAS = 32, DEL = 127;
// LRE, RLE, PDF, LRO, RLO
const BIDI_MIN_1 = 0x202a, BIDI_MAX_1 = 0x202e;
// LRI, RLI, FSI, PDI
const BIDI_MIN_2 = 0x2066, BIDI_MAX_2 = 0x2069;

/**
 * Same rule as `functions/nom.ts`'s `cleanName`, deliberately COPIED rather than imported (one
 * repository, two independent bundles). Filters bidi override code points too, since a plain
 * `c < 32` filter lets them through to visually reorder the TEXT AROUND a name. Never throws
 * (unlike `cleanName` above): a malformed guest message should produce an empty string, not drop
 * the socket. `cleanGuestName` and `cleanCursorSay` share this, only the cap differs.
 */
function cleanTexteBornee(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  let out = "";
  for (const ch of v.trim()) {
    const c = ch.codePointAt(0) as number;
    if (c < CONTROLE_BAS || c === DEL) continue;
    if ((c >= BIDI_MIN_1 && c <= BIDI_MAX_1) || (c >= BIDI_MIN_2 && c <= BIDI_MAX_2)) continue;
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

export function cleanGuestName(v: unknown): string {
  return cleanTexteBornee(v, GUEST_NAME_MAX);
}

// ---- CURSOR CHAT ("/", docs pending): the SECOND untrusted string this client renders --------
// The guest name above was the FIRST. This is the second: it rides the `cursor` message (see
// `CursorMessage.say`), so it reaches every peer's `.pc-say` bubble (`src/ts/mesure/curseur-pair.ts`,
// `textContent` only, never `innerHTML`) long before anyone submits anything.
export const CURSOR_SAY_MAX = 140;

export function cleanCursorSay(v: unknown): string {
  return cleanTexteBornee(v, CURSOR_SAY_MAX);
}

/**
 * Same derivation as the client's `displayName()` (`src/ts/mesure/curseur-pair.ts`), duplicated
 * here since this Worker cannot import from `src/ts`. Its only caller is the guest-audience path:
 * emails never cross to a guest, but a household author has no self-declared `name`, so without
 * this a guest would see "?" where a household peer's dot should be.
 */
export function nameFromEmail(email: string): string {
  const s = String(email || "").trim();
  if (!s) return "";
  const local = (s.split("@")[0] || "").replace(/\d+$/, "");
  const mots = local.split(/[._\-+]+/).filter(Boolean);
  if (!mots.length) return "";
  return mots.map((m) => m.charAt(0).toUpperCase() + m.slice(1).toLowerCase()).join(" ").slice(0, 32);
}

// ---- validations ----

// ---- "ABSENT FIELD = NO OPINION", generalized to all entities (C-5) -----------------------------
// A key absent from the wire does not mean "erase", it means "no opinion", so we fall back to the
// value already in the database. Erasing stays possible via the explicit neutral value ("" for a
// name, false for `locked`, 0 for `hinge`); total removal of an optional key becomes
// inexpressible, which no client needs. `base` is only kept if it carries the SAME id.
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
  // lm: bounded integer, same shape as `tr`. A finite number outside 0..20000 is REFUSED, not
  // clamped: a flux of 1e9 is a bug on the sending side, and silently storing 20000 would hide it.
  const lm = pick("lm");
  if (lm !== undefined) {
    if (!isFiniteNum(lm) || lm < LM_MIN || lm > LM_MAX) throw new OpError("piece_lm");
    out.lm = Math.round(lm);
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
  // `lm`: same bound and same refusal as on a piece. A wall light is an opening here.
  const olm = pick("lm");
  if (olm !== undefined) {
    if (!isFiniteNum(olm) || olm < LM_MIN || olm > LM_MAX) throw new OpError("opening_lm");
    out.lm = Math.round(olm);
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

// Upsert that REPLACES the list instead of writing into it: `list[i] = e` and `list.push(e)` both
// mutate the array the caller already held, which is exactly what `applyOpUndoable` must be able
// to hand back. Copying a few hundred references costs under a microsecond; a deep copy of the
// plan cost 392.
function putEntity<T extends { id: string }>(list: T[], i: number, e: T): T[] {
  const out = list.slice();
  if (i >= 0) out[i] = e;
  else out.push(e);
  return out;
}
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
  // `lux`: the room's lighting target. Bounded like `lm`, and ABSENT stays absent: a room that was
  // never asked has no opinion, and writing 150 everywhere would move every plan's fingerprint.
  const lux = pick("lux");
  if (lux !== undefined && (!isFiniteNum(lux) || lux < LUX_MIN || lux > LUX_MAX)) throw new OpError("cell_lux");
  return {
    id: c.id,
    poly: poly.map((pt) => [pt[0], pt[1]]),
    // Name TRUNCATED, never refused: on cells.replace, a single name that was too long brought
    // down all ten cells at once, so ten rooms disappeared for the peer.
    name: name === undefined ? "" : cleanName(name, "cell_name"),
    floor: isStr(floor) ? floor : "parquet",
    // LAST, and in the SAME position as `v5CellWire` puts it: the emission mirror compares
    // `JSON.stringify` strings, so a key in a different place re-emits every cell of the plan.
    ...(lux === undefined ? {} : { lux: Math.round(lux as number) }),
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

/**
 * Shape of a state ALREADY stored (post-sanitize): the walls-only plan carries `walls` or
 * `outline` as an array. A row still written in a format from before the switchover carries
 * neither, and is no longer readable (decision 0021): it is served verbatim and refuses every op.
 */
export function isV5(plan: PlanState): boolean {
  return !!plan && typeof plan === "object" && (Array.isArray(plan.walls) || Array.isArray(plan.outline));
}

/**
 * Cleans a complete state. ONE shape, the walls-only plan: a payload carrying neither `outline`
 * nor `walls` is REFUSED (`state_shape`) instead of being read as one of the formats that came
 * before it. `coldLoad` turns that refusal into "keep the bytes as they are", so nothing is
 * converted and nothing is thrown away.
 * `prev` (optional) = the plan ALREADY in the database, so a complete replacement coming from an
 * older client does not erase the fields it does not know how to carry ("absent field = no
 * opinion", V-3). Absent, the validation is that of a new plan.
 */
export function sanitizeState(st: PlanState, prev?: PlanState): PlanState {
  if (!st || typeof st !== "object" || Array.isArray(st)) throw new OpError("state_shape");
  if (st.outline === undefined && st.walls === undefined) throw new OpError("state_shape");
  return sanitizeV5(st, prev ? prevMaps(prev) : null);
}

// ---- applying ops ----
// Mutates and returns `plan` (the caller clones beforehand if it wants immutability).
//
// ONE MODEL (decision 0021): every op is a walls-only op. The one guard left is the state's own
// shape: a row served VERBATIM because the validator refused it accepts nothing but
// `plan5.replace`, or the first `wall.set` would quietly graft a walls-only plan onto bytes it
// cannot read. `piece.front`/`rooms.merge` are gone: no client emits them (census of `wsSend`/
// `wsSendOp`).

// ---- THE ENVELOPE OF AN OP IS REBUILT, NEVER RELAYED AS RECEIVED -------------------------------
// An op's ENTITIES are behind a whitelist (PIECE_KEYS, WALL_KEYS, ...); its ENVELOPE was behind
// nothing, so a junk key applied cleanly and the server rebroadcast it verbatim: any socket could
// push arbitrary bytes through every peer's receive path. The op that goes back out is therefore
// REBUILT from the keys its kind is known to carry.
export const OP_KEYS: Record<string, string[]> = {
  "piece.set": ["piece"],
  "piece.del": ["pieceId"],
  "outline.set": ["outline"],
  "wall.set": ["wall"],
  "wall.del": ["wallId"],
  "opening.set": ["opening"],
  "opening.del": ["openingId"],
  "cell.set": ["cellId", "name", "floor", "poly", "lux"],
  "cells.replace": ["cells"],
  /** COMPLETE replacement: conversion, import, undo of a whole snapshot. */
  "plan5.replace": ["plan"],
};

/** The op as it must leave the server: `kind` plus the keys that kind is known to carry, and
 *  nothing else. An unknown kind reduces to its `kind` alone (it never reaches here: `applyOp`
 *  refuses it first). */
export function opWire(op: Operation): Operation {
  const kind = op && typeof op === "object" ? String(op.kind) : "";
  const sortie: Record<string, unknown> = { kind };
  const permis = OP_KEYS[kind];
  if (permis) {
    const brut = op as unknown as Record<string, unknown>;
    for (const k of permis) if (brut[k] !== undefined) sortie[k] = brut[k];
  }
  return sortie as unknown as Operation;
}

/** What takes an op back: it puts the plan's own fields back the way they were. */
export type OpUndo = () => void;

/**
 * ---- APPLYING WITHOUT COPYING THE PLAN -------------------------------------------------------
 * `applyOp` writes INTO the plan it is given, so the server used to hand it a
 * `structuredClone(this.plan)`: 392 us of the 887 us an op cost on a 300-piece floor plan, paid on
 * EVERY op, to carry a guarantee only a refusal ever uses.
 *
 * The guarantee stays, at O(number of top-level fields). Two properties make it exact:
 *  - **an op never writes before it has finished validating**, which is the invariant the
 *    atomicity corpus already covers (`live-worker/test-local.ts`, `V5_BAD`);
 *  - **an op never mutates a list or an entity in place**: it REPLACES the whole list
 *    (`putEntity`, `filter`, `map`), and the validators return brand-new entities.
 * So a shallow copy of the plan's own fields (7 keys) describes the previous state completely,
 * and restoring it is a complete rollback. The nested arrays it points to are still the ones from
 * before, untouched.
 *
 * The caller keeps its `plan` reference: this is what lets the Durable Object hold `this.plan`
 * across an op that is applied, then taken back because the plan grew too big or storage refused
 * it. Without a rollback there, a refused op would stay on screen for every peer.
 */
export function applyOpUndoable(plan: PlanState, op: Operation): OpUndo {
  const avant = { ...plan } as Record<string, unknown>;
  const cible = plan as unknown as Record<string, unknown>;
  const undo: OpUndo = () => {
    for (const k of Object.keys(cible)) if (!(k in avant)) Reflect.deleteProperty(cible, k);
    Object.assign(cible, avant);
  };
  // Belt and braces: today no op writes then throws, and the corpus says so. If one ever does,
  // it is taken back here rather than left half-applied in the shared plan.
  try { applyOp(plan, op); } catch (e) { undo(); throw e; }
  return undo;
}

export function applyOp(plan: PlanState, op: Operation): PlanState {
  if (!op || typeof op !== "object") throw new OpError("op_obj");
  if (op.kind === "plan5.replace") {
    // COMPLETE replacement: conversion, import, undo of a whole snapshot. It is also the ONLY op
    // a row served verbatim (a shape the validator refuses) accepts, so a household still on such
    // a row has a way out.
    // The payload MUST be walls-only: otherwise we would silently install an empty plan.
    if (!op.plan || typeof op.plan !== "object" || Array.isArray(op.plan)
      || (op.plan.outline === undefined && op.plan.walls === undefined)) {
      throw new OpError("state_shape");
    }
    // An undo/import coming from an old client sends back ALL its entities in the shape it knows
    // how to write, so amputated of the fields it doesn't know about: we start from those
    // already in the database so as not to lose them along the way (absent field = no opinion,
    // cf. prevOf).
    const clean = sanitizeV5(op.plan, prevMaps(plan));
    // A row kept verbatim can still carry the keys of a shape we no longer read: the replacement
    // drops them, so the row never ends up holding half of each.
    Reflect.deleteProperty(plan, "rooms");
    Reflect.deleteProperty(plan, "envelope");
    plan.outline = clean.outline;
    plan.walls = clean.walls;
    plan.openings = clean.openings;
    plan.pieces = clean.pieces;
    plan.cells = clean.cells;
    plan.setupDone = clean.setupDone;
    return plan;
  }
  // A state the validator refused (a shape from before the switchover, kept byte for byte by
  // `coldLoad`) takes NO ordinary op: applying one would graft a walls-only plan onto bytes we
  // cannot read. `op_shape` is the same refusal a mismatched op has always produced, and the
  // client already knows it: it announces the model conflict and reloads.
  if (!isV5(plan)) throw new OpError("op_shape");
  return applyOpV5(plan, op);
}

// ---- the ops ----
// Furniture lives in a FLAT list plan.pieces (apartment coordinates), never a per-room array.
function applyOpV5(plan: PlanState, op: Operation): PlanState {
  // Safety net: a partial state (coming from an old snapshot) must have its 4 lists.
  if (!Array.isArray(plan.walls)) plan.walls = [];
  if (!Array.isArray(plan.openings)) plan.openings = [];
  if (!Array.isArray(plan.pieces)) plan.pieces = [];
  if (!Array.isArray(plan.cells)) plan.cells = [];
  switch (op.kind) {
    case "outline.set": {
      // {kind:"outline.set", outline:[[x,y],...]}, the apartment's volume.
      plan.outline = validatePoly(op.outline).map((pt) => [pt[0], pt[1]]);
      return plan;
    }
    case "wall.set": {
      // {kind:"wall.set", wall:{id,a,b,t}}, upsert by id. Absent keys reuse the value of the
      // wall already in the database: two people can move one an endpoint, the other the thickness.
      const wall = validateWall(op.wall, idMap(plan.walls));
      const i = plan.walls.findIndex((w) => w.id === wall.id);
      if (i < 0 && plan.walls.length >= MAX_ENTITIES) throw new OpError("walls_max");
      plan.walls = putEntity(plan.walls, i, wall);
      return plan;
    }
    case "wall.del": {
      // {kind:"wall.del", wallId}, CASCADE: the openings carried by this wall leave with it
      // (an opening without a wall no longer has any geometry; refusing would leave the client stuck).
      if (!isStr(op.wallId)) throw new OpError("wall_id");
      plan.walls = plan.walls.filter((w) => w.id !== op.wallId);
      plan.openings = plan.openings.filter((o) => o.wallId !== op.wallId);
      return plan;
    }
    case "opening.set": {
      // {kind:"opening.set", opening:{id,wallId,t0,w,type,side,h?,name?,hinge?,swing?}}, upsert,
      // referenced wall mandatory. The packed shape (no `side`) from an old client is accepted
      // and unpacked; h/name absent are reused from the opening already in the database.
      const wallIds = new Set(plan.walls.map((w) => w.id));
      const opening = validateOpening(op.opening, wallIds, openingMap(plan));
      const i = plan.openings.findIndex((o) => o.id === opening.id);
      if (i < 0 && plan.openings.length >= MAX_ENTITIES) throw new OpError("openings_max");
      plan.openings = putEntity(plan.openings, i, opening);
      return plan;
    }
    case "opening.del": {
      // {kind:"opening.del", openingId}, idempotent no-op if absent.
      if (!isStr(op.openingId)) throw new OpError("opening_id");
      plan.openings = plan.openings.filter((o) => o.id !== op.openingId);
      return plan;
    }
    case "cell.set": {
      // {kind:"cell.set", cellId, name?, floor?, poly?}, metadata of a derived room.
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
        // C-5: an absent `lux` is "no opinion", so the value already stored stays.
        ...(op.lux !== undefined ? { lux: op.lux } : (cur && cur.lux !== undefined ? { lux: cur.lux } : {})),
      };
      const cell = validateCell(draft);
      if (i < 0 && plan.cells.length >= MAX_ENTITIES) throw new OpError("cells_max");
      plan.cells = putEntity(plan.cells, i, cell);
      return plan;
    }
    case "cells.replace": {
      // {kind:"cells.replace", cells:[{id,poly,name,floor}]}, after complete re-detection.
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
      if (i < 0 && plan.pieces.length >= MAX_ENTITIES) throw new OpError("pieces_max");
      plan.pieces = putEntity(plan.pieces, i, piece);
      return plan;
    }
    case "piece.del": {
      if (!isStr(op.pieceId)) throw new OpError("piece_id");
      plan.pieces = plan.pieces.filter((p) => p.id !== op.pieceId);
      return plan;
    }
    default:
      // Any kind this model does not have. A tab left open on the shapes that came before it
      // (`room.*`, `env.*`, `plan.replace`) lands here too, and the client reads this refusal
      // exactly as it reads `op_shape`: it announces the conflict and reloads.
      throw new OpError("unknown_kind");
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
  const out: CursorMessage = { room, x: msg.x, y: msg.y };
  // `say` ABSENT from the wire = no opinion (out.say stays undefined, so JSON drops the key: an
  // old client, or one that never opened the chat box, changes nothing for anyone). `say: null`
  // is preserved AS-IS, the explicit "stopped speaking" a closed box sends once. A string is
  // cleaned (control characters, bidi overrides, capped at CURSOR_SAY_MAX): it may clean down to
  // "", which is still a valid (empty) opinion, not the same as never having one.
  if (msg.say === null) out.say = null;
  else if (msg.say !== undefined) out.say = cleanCursorSay(msg.say);
  return out;
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
