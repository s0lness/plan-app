// src/ts/modele/migrations.ts: SANITIZATION OF THE WALLS-ONLY PLAN ON READ.
// Porté de src/js/02-etat-migrations.js (PURE part: `sanitizeV5Plan`, `normalizeOpeningFacing`,
// `cleanOpts`). The rest of js/02 (`migrate`, `defaultState`, `bootOpts`, `bindState`, reading
// `localStorage` at bootstrap) touches storage and bootstrap ordering: still to be ported.
//
// D-4: `migrate()` is the ONLY entry point for legacy formats, and `sanitizeV5Plan` is the only
// entry point for a walls-only plan. Any absurd field is silently discarded; an unreadable plan
// returns null (D-2: "neither a plan, nor no plan", it is the caller that decides).

import { clamp, WALL } from "../noyau/nombres.ts";
import {
  COORD_MAX, estSolConnu, ID_RE, MAX_ENTITIES, NAME_MAX, OPENING_H_MAX, PIECE_WH_MAX,
  POLY_MAX_PTS, WALL_T_MAX, WALL_T_MIN,
} from "../partage/contrat-serveur.ts";
import { TYPEMAP } from "../catalogue/catalogue.ts";
import { pointInPoly } from "../geometrie/polygones.ts";
import { v5OnOutline } from "./conversion.ts";
import type { Cellule, Meuble, Mur, Ouverture, PlanV5, Pt } from "../partage/plan.ts";

const num = (v: unknown, d?: number): number => {
  const n = Number(v);
  return isFinite(n) ? n : (d || 0);
};

// A2 (docs/invariants.md C-5's sibling for BOUNDS, not keys): a coordinate is clamped to
// ±COORD_MAX, the SAME ceiling `live-worker/ops.ts`'s `isCoord` enforces. Read applies this
// too, not only the server, so a plan loaded out of bounds is not "openable but every future op
// on it gets rejected": corrected, not merely tolerated.
const pt = (q: unknown): Pt | null => {
  if (!Array.isArray(q) || q.length < 2) return null;
  const x = Number(q[0]), y = Number(q[1]);
  if (!isFinite(x) || !isFinite(y)) return null;
  return [clamp(x, -COORD_MAX, COORD_MAX), clamp(y, -COORD_MAX, COORD_MAX)];
};

// A2: one constant for every entity id's length, matching `ID_RE`'s `{1,80}`, instead of the
// previous mismatched 40 (walls, cells) and `NAME_MAX` (openings, pieces, which happens to also
// be 80 but for an unrelated reason: it bounds a NAME, not an identifier).
const ID_MAX = 80;

/**
 * A raw id turned into one the server will accept: truncated to `ID_MAX` (leaving room for the
 * de-duplication suffix below, so it never pushes the result past `ID_MAX`), and REPLACED by the
 * same synthetic id used when the id is absent if it does not match `ID_RE` (a quote or an angle
 * bracket would otherwise be injected back into a `data-id="…"` attribute and a CSS selector,
 * G-18: the server bounds the dangerous, we bound the sensible, but an id must respect the
 * server's SHAPE regardless). `brut` carries the id BEFORE that replacement, so a caller can
 * alias references made against it (an opening's `wallId`, a piece's `pair`): without this, a
 * reference following an ill-formed id is silently orphaned by the very fix that made it safe.
 */
function idSur(raw: unknown, auto: string, dej: Set<string>): { id: string; brut: string | null } {
  let brut: string | null = null;
  let id: string;
  if (raw == null) {
    id = auto;
  } else {
    const s = String(raw).slice(0, ID_MAX);
    if (ID_RE.test(s)) id = s;
    else { brut = String(raw); id = auto; }
  }
  if (dej.has(id)) {
    // A single trailing `_` per collision cannot, by construction, stay under `ID_MAX` past a
    // handful of EXACT duplicates (an adversarial payload can hold up to `MAX_ENTITIES` of
    // them): a numbered suffix is bounded and always finds a free slot within a few digits.
    let n = 2, cand: string;
    do {
      const suf = "_" + n;
      cand = (id.length + suf.length > ID_MAX ? id.slice(0, ID_MAX - suf.length) : id) + suf;
      n++;
    } while (dej.has(cand));
    id = cand;
  }
  dej.add(id);
  return { id, brut };
}

/**
 * Sanitizes a payload into a walls-only plan, or returns `null`.
 * Identifiers are made unique and reshaped to `ID_RE`, orphaned openings (nonexistent wall)
 * removed, positions along a wall clamped to its length, names truncated to NAME_MAX (D-14: a
 * name is truncated, never rejected, a rejection makes the change disappear forever), and every
 * bound the server enforces (`COORD_MAX`, `POLY_MAX_PTS`, `MAX_ENTITIES`, `ID_RE`) is applied
 * here too (A2): a plan read out of bounds is corrected on the spot, not merely opened and left
 * for the server to reject op by op.
 */
export function sanitizeV5Plan(p: unknown): PlanV5 | null {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const src = p as Record<string, unknown>;
  // A2: the outline polygon is bounded to POLY_MAX_PTS, the same ceiling `validatePoly`
  // enforces server-side, TRUNCATED (never rejected, same D-14 spirit as a name).
  const outline = (Array.isArray(src["outline"]) ? (src["outline"] as unknown[]) : [])
    .map(pt).filter((q): q is Pt => !!q).slice(0, POLY_MAX_PTS);
  if (outline.length < 3) return null;

  const walls: Mur[] = [];
  const wid = new Set<string>();
  const wallIdAlias = new Map<string, string>(); // raw (ill-formed) wall id -> final id
  // A2: raw entries are capped to MAX_ENTITIES BEFORE filtering, the first ones kept, so the
  // reconstructed plan can never hold more than the server would ever accept for this family.
  (Array.isArray(src["walls"]) ? (src["walls"] as unknown[]) : []).slice(0, MAX_ENTITIES).forEach((raw, i) => {
    if (!raw || typeof raw !== "object") return;
    const w = raw as Record<string, unknown>;
    const a = pt(w["a"]), b = pt(w["b"]);
    if (!a || !b) return;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1) return;
    const { id, brut } = idSur(w["id"], "w" + (i + 1), wid);
    // `isOutline` is DERIVED from the geometry: the wire does not carry this flag (WALL_KEYS =
    // id/a/b/t). A wall lying on an outline edge is an outline wall.
    walls.push({
      id,
      a,
      b,
      t: clamp(num(w["t"], WALL), WALL_T_MIN, WALL_T_MAX),
      isOutline: !!w["isOutline"] || v5OnOutline(a, b, outline, 1),
      // `free` IS READ AND IGNORED (decision 0012). It marked a wall that must not stretch to the
      // first barrier; no wall stretches any more, so every stored plan is already "free" and
      // dropping the key moves nothing: a wall's geometry is what is stored, and it is kept
      // verbatim. This function never writes the field back, so a plan saved by this client no
      // longer carries it at all.
    });
    if (brut != null) wallIdAlias.set(brut, id);
  });

  // A2: an opening naming a wall by its RAW (ill-formed) id must still find it, otherwise fixing
  // the wall's id would orphan every opening on it, which is exactly the kind of "correction"
  // that isn't one. The alias only fills a gap, it never shadows a wall that legitimately owns
  // that string as its FINAL id.
  const byId = new Map(walls.map((w) => [w.id, w]));
  wallIdAlias.forEach((finalId, brut) => {
    if (!byId.has(brut)) { const w = byId.get(finalId); if (w) byId.set(brut, w); }
  });
  const openings: Ouverture[] = [];
  const oid = new Set<string>();
  (Array.isArray(src["openings"]) ? (src["openings"] as unknown[]) : []).slice(0, MAX_ENTITIES).forEach((raw, i) => {
    if (!raw || typeof raw !== "object") return;
    const o = raw as Record<string, unknown>;
    const cat = TYPEMAP[String(o["type"])];
    if (!cat) return;
    const w = byId.get(String(o["wallId"]));
    if (!w) return;
    const { id } = idSur(o["id"], "o" + (i + 1), oid);
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const ow = clamp(num(o["w"], cat.w), 1, Math.max(1, L));
    openings.push({
      id,
      wallId: w.id,
      t0: clamp(num(o["t0"], 0), 0, Math.max(0, L - ow)),
      w: ow,
      h: clamp(num(o["h"], cat.h), 1, OPENING_H_MAX),
      type: String(o["type"]),
      side: o["side"] ? 1 : 0,
      name: String(o["name"] || cat.name).slice(0, NAME_MAX),
      hinge: o["hinge"] != null ? (Number(o["hinge"]) ? 1 : 0) : undefined,
      swing: o["swing"] != null ? (Number(o["swing"]) < 0 ? -1 : 1) : undefined,
      // `leaf` follows the SAME rule as `free` just above, and the same defect: absent stays
      // absent (D-7's "an absent field is not a field set to zero"), it is declared in
      // `partage/plan.ts` (`Ouverture.leaf`) and emitted by `v5OpeningWire`
      // (`fil/pseudo-fil.ts`), but this function used to drop it on every re-read. Ctrl+Z goes
      // through `serialize()` then `migrate()` (`historique/pile.ts`), so undoing anything lost
      // whether a window was fixed or opened. Same unpacking as `v5AdoptOpening`.
      leaf: o["leaf"] != null ? ((Number(o["leaf"]) | 0) as 0 | 1 | 2) : undefined,
      // `lm` (luminous flux of a wall light or a window): same rule again, absent stays absent.
      // The server bounds it on write (`LM_MIN`/`LM_MAX`); here we only refuse what isn't a number.
      lm: o["lm"] != null && isFinite(Number(o["lm"])) ? Math.max(0, Number(o["lm"])) : undefined,
    });
  });

  const pieces: Meuble[] = [];
  const pid = new Set<string>();
  const pieceIdAlias = new Map<string, string>(); // raw (ill-formed) piece id -> final id
  (Array.isArray(src["pieces"]) ? (src["pieces"] as unknown[]) : []).slice(0, MAX_ENTITIES).forEach((raw, i) => {
    if (!raw || typeof raw !== "object") return;
    const q = raw as Record<string, unknown>;
    const cat = TYPEMAP[String(q["type"])];
    if (!cat) return;
    const { id, brut } = idSur(q["id"], "p" + (i + 1), pid);
    if (brut != null) pieceIdAlias.set(brut, id);
    pieces.push({
      id,
      type: String(q["type"]),
      name: String(q["name"] || cat.name).slice(0, NAME_MAX),
      x: clamp(num(q["x"], 0), -COORD_MAX, COORD_MAX),
      y: clamp(num(q["y"], 0), -COORD_MAX, COORD_MAX),
      w: clamp(num(q["w"], cat.w), 1, PIECE_WH_MAX),
      h: clamp(num(q["h"], cat.h), 1, PIECE_WH_MAX),
      rot: ((Math.round(num(q["rot"], 0)) % 360) + 360) % 360,
      locked: !!q["locked"],
      // `tr`/`dmin`/`pair` (video projector fields, `Meuble.tr`/`.dmin`/`.pair` in
      // `partage/plan.ts`, emitted by `v5PieceWire`): same defect as `leaf` above, absent stays
      // absent, and a re-read (including Ctrl+Z) used to erase the pairing and the throw-ratio
      // silently. `tr`/`dmin` are finite numbers >= 0 (the server further bounds them on write,
      // `THROW_RATIO_*`/`THROW_DMIN_*`); `pair` is a chosen identifier, truncated like any other
      // name so a corrupt payload cannot grow it without bound.
      tr: q["tr"] != null && isFinite(Number(q["tr"])) ? Math.max(0, Number(q["tr"])) : undefined,
      dmin: q["dmin"] != null && isFinite(Number(q["dmin"])) ? Math.max(0, Number(q["dmin"])) : undefined,
      pair: q["pair"] != null ? String(q["pair"]).slice(0, NAME_MAX) : undefined,
      // `lm` (luminous flux of a ceiling light or a floor lamp): same rule as `tr` above.
      lm: q["lm"] != null && isFinite(Number(q["lm"])) ? Math.max(0, Number(q["lm"])) : undefined,
    });
  });
  // A2: a `pair` made against a piece's RAW (ill-formed) id follows the replacement, exactly like
  // an opening's `wallId` above. A `pair` that names nothing at all (a screen deleted meanwhile)
  // is left as is: G-18 already tolerates a dangling `pair` (`fil/pseudo-fil.ts`'s own comment),
  // this only protects the one case that is NOT dangling, an id our own fix just renamed.
  pieces.forEach((piece) => {
    if (piece.pair != null && pieceIdAlias.has(piece.pair)) piece.pair = pieceIdAlias.get(piece.pair);
  });

  const cells: Cellule[] = [];
  const cid = new Set<string>();
  (Array.isArray(src["cells"]) ? (src["cells"] as unknown[]) : []).slice(0, MAX_ENTITIES).forEach((raw, i) => {
    if (!raw || typeof raw !== "object") return;
    const c = raw as Record<string, unknown>;
    // A2: same POLY_MAX_PTS truncation as the outline (`validatePoly` bounds both identically).
    const poly = (Array.isArray(c["poly"]) ? (c["poly"] as unknown[]) : [])
      .map(pt).filter((q): q is Pt => !!q).slice(0, POLY_MAX_PTS);
    if (poly.length < 3) return;
    const { id } = idSur(c["id"], "c" + (i + 1), cid);
    cells.push({
      id,
      poly,
      name: String(c["name"] || "Room").slice(0, NAME_MAX),
      floor: estSolConnu(c["floor"]) ? c["floor"] : "parquet",
      // `lux` (the room's lighting target): absent stays absent, otherwise a re-read would write
      // "this room aims for 150" onto every room that had merely never been asked.
      lux: c["lux"] != null && isFinite(Number(c["lux"])) ? Math.max(0, Number(c["lux"])) : undefined,
    });
  });

  return { outline, walls, openings, pieces, cells };
}

/** An OUTLINE-WALL opening has a cell on only one side: we force that side. */
export function normalizeOpeningFacing<T extends PlanV5>(plan: T | null | undefined): T | null | undefined {
  if (!plan || !Array.isArray(plan.openings) || !Array.isArray(plan.cells) || !plan.cells.length) return plan;
  const cellAt = (x: number, y: number): boolean =>
    plan.cells.some((c) => Array.isArray(c.poly) && pointInPoly(x, y, c.poly));
  plan.openings.forEach((op) => {
    const w = (plan.walls || []).find((x) => String(x.id) === String(op.wallId));
    if (!w) return;
    const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1];
    const L = Math.hypot(dx, dy) || 1;
    const ux = dx / L, uy = dy / L, tc = op.t0 + op.w / 2;
    const px = w.a[0] + ux * tc, py = w.a[1] + uy * tc, off = WALL / 2 + 6;
    const n0 = { x: -uy, y: ux };
    const cA = cellAt(px + n0.x * off, py + n0.y * off);
    const cB = cellAt(px - n0.x * off, py - n0.y * off);
    if (cA && !cB) op.side = 0;
    else if (cB && !cA) op.side = 1;
  });
  return plan;
}

// =================================================================================================
//  PERSONAL SETTINGS, they NEVER cross over, in either direction (D-7)
// =================================================================================================
// Everything here describes the person's SCREEN (layers, labels, Circulation panel,
// overlay, collapsed categories, TV inches), not the apartment.
// They used to travel inside the shared plan: one household member unchecks "Luminaires", the
// other reloads, their wall lights vanish.
//
// WHAT THE TYPING MAKES STRUCTURAL: `Options` shares NO field with `PlanV5` and is not named by
// any of the wire's shapes (`EtatFil`, `Op`). An `opts` slipped into a shared payload is now a
// compile error, whereas the guarantee used to rest on three independent barriers and a
// convention written as a comment.

// THE `snap` KEY IS GONE (decision 0012, after 0011 for furniture). Walls and openings were the
// last readers of the 5 cm step; they move at the centimetre now, magnets and all. An old stored
// setting still carrying `snap` is read without complaint and simply dropped by `cleanOpts`,
// which never writes it back. `overlay` is GONE THE SAME WAY (decision 0015): the shaded floor is
// now a state of `flow` (one Circulation button opens the panel and paints the layer together),
// so an old value is read and dropped too.
export interface Options {
  labels: boolean;
  flow: boolean;
  tvIn: number | string | null;
  collapsedCats: string[];
  layFurn: boolean;
  layLight: boolean;
  layPlug: boolean;
  /**
   * How the palette is SORTED: by room of use (the default, R-5) or by object kind.
   * This is a PERSONAL setting like the layers: one household member can search by kind while
   * the other sorts by room, without either one forcing the other.
   */
  palBy: "room" | "kind";
  /**
   * THE TWO OVERLAYS THE CIRCULATION PANEL DRIVES, and the hour of the day the second one assumes.
   *   `circLayer` the shaded walkable floor. Decision 0015 made it a state of the Circulation
   *               button; it stays ON by default, so opening the panel still paints it, and the
   *               box only exists so it can be taken OFF while reading the lighting map.
   *   `light`     the lighting map (`circulation/lumiere.ts`).
   *   `day`       Day = the windows count as sources; Night = the fixtures alone.
   * All three describe a SCREEN, not the flat: they never cross over (D-7).
   */
  circLayer: boolean;
  light: boolean;
  day: boolean;
}

const DEFAULT_OPTS: Options = {
  labels: true, flow: false, tvIn: null, collapsedCats: [],
  layFurn: true, layLight: true, layPlug: true, palBy: "room",
  circLayer: true, light: false, day: false,
};

export function cleanOpts(opts: Partial<Options> | null | undefined): Options {
  const o: Options & { floor?: unknown; snap?: unknown; overlay?: unknown } = Object.assign({}, DEFAULT_OPTS, opts || {});
  delete o.floor;   // the floor is a CELL property, never a setting
  delete o.snap;    // the 5 cm step: read from an old save, never kept and never written back
  delete o.overlay; // the shaded floor is now a STATE of `flow` (decision 0015), not its own key
  o.collapsedCats = Array.isArray(o.collapsedCats) ? o.collapsedCats.filter((c) => typeof c === "string") : [];
  // An unknown value (old setting, hand-edited file) falls back to the default instead of
  // breaking the palette's construction.
  if (o.palBy !== "kind") o.palBy = "room";
  // The three lighting/overlay switches are booleans: an old save, or a hand-edited file, carries
  // whatever it carries, and `!!` is what keeps the panel's boxes from rendering "undefined".
  o.circLayer = o.circLayer !== false;
  o.light = !!o.light;
  o.day = !!o.day;
  return o;
}
