// src/ts/modele/migrations.ts — SANITIZATION OF THE WALLS-ONLY PLAN ON READ.
// Porté de src/js/02-etat-migrations.js (PURE part: `sanitizeV5Plan`, `normalizeOpeningFacing`,
// `cleanOpts`). The rest of js/02 (`migrate`, `defaultState`, `bootOpts`, `bindState`, reading
// `localStorage` at bootstrap) touches storage and bootstrap ordering: still to be ported.
//
// D-4: `migrate()` is the ONLY entry point for legacy formats, and `sanitizeV5Plan` is the only
// entry point for a walls-only plan. Any absurd field is silently discarded; an unreadable plan
// returns null (D-2: "neither a plan, nor no plan", it is the caller that decides).

import { clamp, WALL } from "../noyau/nombres.ts";
import { estSolConnu, NAME_MAX, OPENING_H_MAX, PIECE_WH_MAX, WALL_T_MAX, WALL_T_MIN } from "../partage/contrat-serveur.ts";
import { TYPEMAP } from "../catalogue/catalogue.ts";
import { pointInPoly } from "../geometrie/polygones.ts";
import { v5OnOutline } from "./conversion.ts";
import type { Cellule, Meuble, Mur, Ouverture, PlanV5, Pt } from "../partage/plan.ts";

const num = (v: unknown, d?: number): number => {
  const n = Number(v);
  return isFinite(n) ? n : (d || 0);
};

const pt = (q: unknown): Pt | null => {
  if (!Array.isArray(q) || q.length < 2) return null;
  if (!isFinite(Number(q[0])) || !isFinite(Number(q[1]))) return null;
  return [num(q[0]), num(q[1])];
};

/**
 * Sanitizes a payload into a walls-only plan, or returns `null`.
 * Identifiers are made unique, orphaned openings (nonexistent wall) removed, positions along a
 * wall clamped to its length, names truncated to NAME_MAX (D-14: a name is truncated, never
 * rejected, a rejection makes the change disappear forever).
 */
export function sanitizeV5Plan(p: unknown): PlanV5 | null {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const src = p as Record<string, unknown>;
  const outline = (Array.isArray(src["outline"]) ? (src["outline"] as unknown[]) : []).map(pt).filter((q): q is Pt => !!q);
  if (outline.length < 3) return null;

  const walls: Mur[] = [];
  const wid = new Set<string>();
  (Array.isArray(src["walls"]) ? (src["walls"] as unknown[]) : []).forEach((raw, i) => {
    if (!raw || typeof raw !== "object") return;
    const w = raw as Record<string, unknown>;
    const a = pt(w["a"]), b = pt(w["b"]);
    if (!a || !b) return;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1) return;
    let id = String(w["id"] == null ? "w" + (i + 1) : w["id"]).slice(0, 40);
    while (wid.has(id)) id += "_";
    wid.add(id);
    // `isOutline` is DERIVED from the geometry: the wire does not carry this flag (WALL_KEYS =
    // id/a/b/t). A wall lying on an outline edge is an outline wall.
    walls.push({
      id,
      a,
      b,
      t: clamp(num(w["t"], WALL), WALL_T_MIN, WALL_T_MAX),
      isOutline: !!w["isOutline"] || v5OnOutline(a, b, outline, 1),
    });
  });

  const byId = new Map(walls.map((w) => [w.id, w]));
  const openings: Ouverture[] = [];
  const oid = new Set<string>();
  (Array.isArray(src["openings"]) ? (src["openings"] as unknown[]) : []).forEach((raw, i) => {
    if (!raw || typeof raw !== "object") return;
    const o = raw as Record<string, unknown>;
    const cat = TYPEMAP[String(o["type"])];
    if (!cat) return;
    const w = byId.get(String(o["wallId"]));
    if (!w) return;
    let id = String(o["id"] == null ? "o" + (i + 1) : o["id"]).slice(0, NAME_MAX);
    while (oid.has(id)) id += "_";
    oid.add(id);
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
    });
  });

  const pieces: Meuble[] = [];
  const pid = new Set<string>();
  (Array.isArray(src["pieces"]) ? (src["pieces"] as unknown[]) : []).forEach((raw, i) => {
    if (!raw || typeof raw !== "object") return;
    const q = raw as Record<string, unknown>;
    const cat = TYPEMAP[String(q["type"])];
    if (!cat) return;
    let id = String(q["id"] == null ? "p" + (i + 1) : q["id"]).slice(0, NAME_MAX);
    while (pid.has(id)) id += "_";
    pid.add(id);
    pieces.push({
      id,
      type: String(q["type"]),
      name: String(q["name"] || cat.name).slice(0, NAME_MAX),
      x: num(q["x"], 0),
      y: num(q["y"], 0),
      w: clamp(num(q["w"], cat.w), 1, PIECE_WH_MAX),
      h: clamp(num(q["h"], cat.h), 1, PIECE_WH_MAX),
      rot: ((Math.round(num(q["rot"], 0)) % 360) + 360) % 360,
      locked: !!q["locked"],
    });
  });

  const cells: Cellule[] = [];
  const cid = new Set<string>();
  (Array.isArray(src["cells"]) ? (src["cells"] as unknown[]) : []).forEach((raw, i) => {
    if (!raw || typeof raw !== "object") return;
    const c = raw as Record<string, unknown>;
    const poly = (Array.isArray(c["poly"]) ? (c["poly"] as unknown[]) : []).map(pt).filter((q): q is Pt => !!q);
    if (poly.length < 3) return;
    let id = String(c["id"] == null ? "c" + (i + 1) : c["id"]).slice(0, 40);
    while (cid.has(id)) id += "_";
    cid.add(id);
    cells.push({
      id,
      poly,
      name: String(c["name"] || "Room").slice(0, NAME_MAX),
      floor: estSolConnu(c["floor"]) ? c["floor"] : "parquet",
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
//  PERSONAL SETTINGS — they NEVER cross over, in either direction (D-7)
// =================================================================================================
// Everything here describes the person's SCREEN (layers, labels, snap, Circulation panel,
// overlay, collapsed categories, TV inches), not the apartment.
// They used to travel inside the shared plan: one household member unchecks "Luminaires", the
// other reloads, their wall lights vanish.
//
// WHAT THE TYPING MAKES STRUCTURAL: `Options` shares NO field with `PlanV5` and is not named by
// any of the wire's shapes (`EtatFil`, `Op`). An `opts` slipped into a shared payload is now a
// compile error, whereas the guarantee used to rest on three independent barriers and a
// convention written as a comment.

export interface Options {
  snap: boolean;
  labels: boolean;
  flow: boolean;
  overlay: boolean;
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
}

const DEFAULT_OPTS: Options = {
  snap: true, labels: true, flow: false, overlay: false, tvIn: null, collapsedCats: [],
  layFurn: true, layLight: true, layPlug: true, palBy: "room",
};

export function cleanOpts(opts: Partial<Options> | null | undefined): Options {
  const o: Options & { floor?: unknown } = Object.assign({}, DEFAULT_OPTS, opts || {});
  delete o.floor; // the floor is a CELL property, never a setting
  o.collapsedCats = Array.isArray(o.collapsedCats) ? o.collapsedCats.filter((c) => typeof c === "string") : [];
  // An unknown value (old setting, hand-edited file) falls back to the default instead of
  // breaking the palette's construction.
  if (o.palBy !== "kind") o.palBy = "room";
  return o;
}
