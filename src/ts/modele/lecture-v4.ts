// src/ts/modele/lecture-v4.ts: READING a plan in the LEGACY format (v1 -> v4).
// Porté de src/js/02-etat-migrations.js (block "READING a plan in the legacy format").
//
// NONE of the structures returned here survive `migrate()`: they are rebuilt in memory for the
// duration of the conversion (`modele/conversion-v4.ts`), then discarded. Nothing in the live
// application edits this, and that is the only reason such permissive types are acceptable.
//
// EVERYTHING IS PURE HERE: no `localStorage`, no `state`. The old client mixed reading storage
// with conversion; bootstrap now lives in `main.ts`, these functions know only their argument.

import { clamp, WALL } from "../noyau/nombres.ts";
import { estSolConnu } from "../partage/contrat-serveur.ts";
import { isSideable, isWallMount, TYPEMAP } from "../catalogue/catalogue.ts";
import { closestOnSeg, pointInPoly, wallFacingRot, wallInwardNormal } from "../geometrie/polygones.ts";
import { roomAptBBox, roomAptPoly, roomLocalBBox } from "./salles-anciennes.ts";
import type { EnveloppeAncienne, MeubleAncien, PlanAncien, SalleAncienne } from "./salles-anciennes.ts";
import type { Pt } from "../partage/plan.ts";

export const rectPoly = (w: number, l: number): Pt[] => [[0, 0], [w, 0], [w, l], [0, l]];

/**
 * L-shape: a w x l rectangle with a notch removed (nw wide, nl deep) at the TOP-RIGHT corner.
 * Shared by the preset button and the setup wizard, so the two do not drift apart.
 */
export function lShapePoly(w: number, l: number, nw: number, nl: number): Pt[] {
  nw = clamp(Math.round(nw), 10, w - 10);
  nl = clamp(Math.round(nl), 10, l - 10);
  return ([[0, 0], [w - nw, 0], [w - nw, nl], [w, nl], [w, l], [0, l]] as Pt[])
    .map((p) => [Math.round(p[0]), Math.round(p[1])] as Pt);
}

// THE TWO COUNTERS, AND WHY THEY REMAIN MODULE-LEVEL COUNTERS.
// `uid` numbers the objects of an old plan that have no identifier; `ruid` numbers the ROOMS read
// (never persisted). They used to be two variables in the client's closure; they are now this
// module's private state, which is the same thing more explicitly stated. An identifier drawn
// here ends up in the converted plan: resetting them to zero between two reads would change data.
let uid = Date.now();
let ruid = 0;

/** The next room identifier. Exported only for the "Room 1" room of `defaultState()`. */
export function prochainRuid(): number {
  return ++ruid;
}

/**
 * RESETS BOTH COUNTERS TO A KNOWN VALUE. The only consumer is the compatibility oracle
 * (`tests/compat-donnees.ts`), which reads back dozens of documents in a single process and
 * requires that a read owe NOTHING to the previous one: without this, the corpus's order would
 * change the identifiers drawn, hence the fingerprints, and the oracle would become a coin toss.
 * The old client got the same isolation by re-DECLARING `uid`/`ruid` inside the split reader; an
 * ES module cannot be re-declared from outside, hence this door, explicit and named.
 *
 * THE APPLICATION NEVER CALLS THIS, and must never call it: `uid` starts from `Date.now()` so
 * that an identifier drawn today cannot collide with an identifier drawn yesterday and already
 * recorded in the household's plan.
 */
export function reglerCompteurs(nouvelUid: number, nouveauRuid: number): void {
  uid = nouvelUid;
  ruid = nouveauRuid;
}

/**
 * The next OBJECT identifier. Same counter as reading a legacy plan, and that is deliberate:
 * `mk()` (creating furniture) and reading draw from the same sequence, otherwise a new piece of
 * furniture could receive the identifier of a piece read on open.
 */
export function prochainUid(): number {
  return ++uid;
}

/** Sanitizes the furniture list of a room or the envelope. Unknown keys survive. */
function sanitizePieces(brut: unknown): MeubleAncien[] {
  const liste = Array.isArray(brut) ? (brut as unknown[]) : [];
  return liste
    .filter((raw): raw is Record<string, unknown> => !!raw && !!TYPEMAP[String((raw as Record<string, unknown>)["type"])])
    .map((p) => {
      const type = p["type"] as string;
      const cat = TYPEMAP[String(type)]!;
      return {
        ...p,
        id: (p["id"] != null ? p["id"] : ++uid) as string | number,
        type,
        name: String(p["name"] || cat.name),
        x: Number(p["x"]) || 0,
        y: Number(p["y"]) || 0,
        w: Number(p["w"]) || cat.w,
        h: Number(p["h"]) || cat.h,
        rot: Number(p["rot"]) || 0,
        locked: !!p["locked"],
        hinge: ((type === "door" || type === "sdoor")
          ? (Number(p["hinge"]) ? 1 : 0)
          : (p["hinge"] != null ? (Number(p["hinge"]) ? 1 : 0) : undefined)) as 0 | 1 | undefined,
        swing: ((type === "door") ? (Number(p["swing"]) < 0 ? -1 : 1) : undefined) as 1 | -1 | undefined,
      };
    });
}

/** Puts a room into the canonical shape `{id,name,floor,ax,ay,room:{poly},pieces}`. */
export function sanitizeRoomObj(brut: unknown, fallbackName?: string): SalleAncienne {
  const r = (brut || {}) as Record<string, unknown>;
  const salle = r["room"] as Record<string, unknown> | undefined;
  let poly = ((salle && salle["poly"]) || r["poly"]) as unknown;
  if (!Array.isArray(poly) || poly.length < 3) {
    // Values are taken AS IS (`r.w || 420`), not converted first: it is the polygon conversion,
    // two lines below, that normalizes. A `w` of "0" recorded as a string is therefore 0, as
    // before, not 420.
    const w = (r["w"] || 420) as number, l = (r["l"] || r["h"] || 360) as number;
    poly = rectPoly(w, l);
  }
  const pts: Pt[] = (poly as unknown[]).map((q) => {
    const pair = q as [unknown, unknown];
    return [Number(pair[0]) || 0, Number(pair[1]) || 0] as Pt;
  });
  const pieces = sanitizePieces(r["pieces"]);
  const floor = estSolConnu(r["floor"]) ? r["floor"] : "parquet";
  // offset of this room's local frame within the apartment (cm, integers). null = not placed.
  const ax = (r["ax"] == null || !isFinite(Number(r["ax"]))) ? null : Math.round(Number(r["ax"]));
  const ay = (r["ay"] == null || !isFinite(Number(r["ay"]))) ? null : Math.round(Number(r["ay"]));
  return {
    id: (r["id"] != null ? r["id"] : ++ruid) as string | number,
    name: String(r["name"] || fallbackName || "Room"),
    floor, ax, ay, room: { poly: pts }, pieces,
  };
}

/** The legacy envelope (the apartment): `{poly, floor, pieces}`, already in apartment cm. */
function sanitizeEnvelope(e: unknown): EnveloppeAncienne | null {
  if (e == null) return null;
  if (typeof e !== "object" || Array.isArray(e)) return null;
  const env = e as Record<string, unknown>;
  const poly = env["poly"];
  if (!Array.isArray(poly) || poly.length < 3) return null;
  const pts: Pt[] = (poly as unknown[]).map((q) => {
    const pair = q as [unknown, unknown];
    return [Number(pair[0]) || 0, Number(pair[1]) || 0] as Pt;
  });
  const floor = estSolConnu(env["floor"]) ? env["floor"] : "parquet";
  return { poly: pts, floor, pieces: sanitizePieces(env["pieces"]) };
}

/**
 * Every room read must have an `ax`/`ay` for `roomAptPoly()` to place it: we fill the gaps
 * (left to right, 100 cm apart). Purely local to the read, never persisted.
 */
function slotLegacyRooms(rooms: SalleAncienne[]): SalleAncienne[] {
  let maxRight = 0;
  rooms.forEach((r) => {
    if (r.ax != null && r.ay != null) {
      const b = roomAptBBox(r);
      if (b.x1 > maxRight) maxRight = b.x1;
    }
  });
  let cursor = maxRight > 0 ? maxRight + 100 : 0;
  rooms.forEach((r) => {
    if (r.ax == null || r.ay == null) {
      const b = roomLocalBBox(r);
      r.ax = Math.round(cursor);
      r.ay = 0;
      cursor += b.w + 100;
    }
  });
  return rooms;
}

/**
 * A wall-mounted object faces along its LOCAL +y. An earlier version computed this normal
 * backwards (see `wallInwardNormal`): on VERTICAL walls, every wall-mounted object was RECORDED
 * at 180°, marker pointing outside the home, door swing on the wrong side. This is fixed at
 * READ time, before conversion: a walls-only opening's side (`side`) is DERIVED from this `rot`,
 * so the anomaly would propagate. `rot+180` also flips the local +x: `hinge` and `swing` are
 * reversed at the same time, so the door arc stays PHYSICALLY in the same place.
 * NARROWED SCOPE: we only fix the indisputable anomaly, the object facing OUTSIDE the home while
 * the other face is livable. On an interior wall (both faces livable) nothing is touched.
 * Verified on the household's actual plan: this normalizer changes NO `rot` there.
 */
function normalizeLegacyWallMountFacing(s: PlanAncien): PlanAncien {
  const live = (x: number, y: number): boolean => {
    const ep = s.envelope && s.envelope.poly;
    if (Array.isArray(ep) && ep.length >= 3) return pointInPoly(x, y, ep);
    return (s.rooms || []).some((r) =>
      !!r && !!r.room && Array.isArray(r.room.poly) && r.room.poly.length >= 3
      && pointInPoly(x, y, roomAptPoly(r)));
  };
  const fix = (poly: Pt[] | null | undefined, list: MeubleAncien[] | null | undefined, ox: number, oy: number): void => {
    if (!Array.isArray(poly) || poly.length < 3 || !Array.isArray(list)) return;
    list.forEach((p) => {
      if (!p || !isWallMount(p.type)) return;
      const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
      let best: { x: number; y: number; dist: number; ang: number } | null = null;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1) continue;
        const c = closestOnSeg(cx, cy, a[0], a[1], b[0], b[1]);
        if (!best || c.dist < best.dist) {
          best = { x: c.x, y: c.y, dist: c.dist, ang: Math.atan2(b[1] - a[1], b[0] - a[0]) };
        }
      }
      if (!best || best.dist > WALL) return; // not placed on a wall: touch nothing
      const b = best;
      let want: number;
      if (!isSideable(p.type)) {
        // door / window: they face the inside of the container.
        want = ((Math.round(wallFacingRot(b.ang, b.x, b.y, poly)) % 360) + 360) % 360;
      } else {
        const n = wallInwardNormal(b.ang), off = WALL / 2 + 6;
        const okA = live(b.x + ox + n.x * off, b.y + oy + n.y * off);
        const okB = live(b.x + ox - n.x * off, b.y + oy - n.y * off);
        if (okA === okB) return; // two usable faces: the side belongs to the object
        want = ((Math.round(b.ang * 180 / Math.PI + (okA ? 0 : 180)) % 360) + 360) % 360;
      }
      const have = ((Math.round(p.rot || 0) % 360) + 360) % 360;
      let d = Math.abs(want - have) % 360;
      if (d > 180) d = 360 - d;
      if (d < 135) return; // already facing the right way
      p.rot = want;
      if (p.hinge !== undefined) p.hinge = Number(p.hinge) ? 0 : 1;
      if (p.swing !== undefined) p.swing = (Number(p.swing) < 0) ? 1 : -1;
    });
  };
  (s.rooms || []).forEach((r) => {
    if (!r || !r.room || !Array.isArray(r.room.poly)) return;
    const b = roomLocalBBox(r); // local -> apt: + (ax-minX, ay-minY)
    fix(r.room.poly, r.pieces, (r.ax || 0) - b.minX, (r.ay || 0) - b.minY);
  });
  if (s.envelope) fix(s.envelope.poly, s.envelope.pieces, 0, 0);
  return s;
}

/**
 * `st` (already unwrapped) -> `{rooms, envelope}` in the legacy format, or `null` if it isn't one.
 * D-4: this is the ONLY entry point for the v1 -> v4 shapes.
 */
export function readLegacyRooms(brut: unknown): PlanAncien | null {
  const st = (brut || {}) as Record<string, unknown>;
  let rooms: SalleAncienne[] | null = null;
  if (Array.isArray(st["rooms"]) && (st["rooms"] as unknown[]).length) {
    rooms = (st["rooms"] as unknown[]).map((r, i) => sanitizeRoomObj(r, "Room " + (i + 1)));
    // Deduplication of ids: legacy data has several rooms with the SAME id.
    {
      const seen = new Set<string>();
      let mx = 0;
      for (const r of rooms) { const n = Number(r.id); if (isFinite(n) && n > mx) mx = n; }
      for (const r of rooms) {
        const k = String(r.id);
        if (seen.has(k)) { r.id = ++mx; }
        seen.add(String(r.id));
      }
      if (mx >= ruid) ruid = mx;
    }
  } else if (st["room"] || st["pieces"]) {
    // single-room v1/v2/v3 -> a single room, "Room 1"
    const rm = (st["room"] || {}) as Record<string, unknown>;
    const opts = st["opts"] as Record<string, unknown> | undefined;
    rooms = [sanitizeRoomObj({
      poly: rm["poly"], w: rm["w"], l: rm["l"], h: rm["h"],
      pieces: st["pieces"], floor: (opts && opts["floor"]) || "parquet", name: "Room 1",
    }, "Room 1")];
  }
  if (!rooms) return null;
  const legacy: PlanAncien = { rooms: slotLegacyRooms(rooms), envelope: sanitizeEnvelope(st["envelope"]) };
  normalizeLegacyWallMountFacing(legacy);
  return legacy;
}
