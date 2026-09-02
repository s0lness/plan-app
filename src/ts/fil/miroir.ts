// src/ts/fil/miroir.ts: THE EMISSION MIRROR AND THE FIELD-BY-FIELD DIFF (pure; covered without a
// browser by `tests/harnais-graine.ts`). The mirror describes the SERVER, never us (C-6); an op
// is a field-by-field diff, an absent field means "no opinion" (C-5); two mirrors make resending
// safe (C-3).

import { v5R2 } from "../noyau/nombres.ts";
import type { Serialiseurs } from "./pseudo-fil.ts";
import type { Id, Miroir, Op, PlanFil, Pt } from "../partage/plan.ts";

/** Copies one mirror into the other. The Maps are rebuilt: no structure is shared. */
export function wsShadowCopy(src: Miroir, dst: Miroir): void {
  dst.outline = src.outline;
  dst.walls = new Map(src.walls);
  dst.openings = new Map(src.openings);
  dst.pieces = new Map(src.pieces);
  dst.cells = new Map(src.cells);
}

/**
 * Rebuilds the mirror from the state announced by the `hello` (or a `state`), each entity passed
 * back through its serializer (C-6). An entity we fail to serialize is left ABSENT from the
 * mirror: the next diff emits it in full, the safe direction for the error.
 */
export function wsShadowFromServerInto(m: Miroir, st: unknown, wire: Serialiseurs): void {
  m.outline = null;
  m.walls = new Map();
  m.openings = new Map();
  m.pieces = new Map();
  m.cells = new Map();
  if (!st || typeof st !== "object") return;
  const s = st as Partial<PlanFil>;
  if (!Array.isArray(s.walls)) return; // unknown shape: empty mirror
  if (Array.isArray(s.outline)) {
    m.outline = JSON.stringify(s.outline.map((p) => [v5R2(p[0]), v5R2(p[1])] as Pt));
  }
  const put = <E>(map: Map<Id, string>, list: E[] | undefined, fn: (e: E) => { id: Id }): void => {
    (list || []).forEach((e) => {
      try {
        const w = fn(e);
        map.set(String(w.id), JSON.stringify(w));
      } catch { /* unreadable entity: left absent, see the header */ }
    });
  };
  put(m.walls, s.walls, wire.wall as (e: unknown) => { id: Id });
  put(m.openings, s.openings, wire.opening as (e: unknown) => { id: Id });
  put(m.pieces, s.pieces, wire.piece as (e: unknown) => { id: Id });
  put(m.cells, s.cells, wire.cell as (e: unknown) => { id: Id });
}

/** Applies a PARTIAL entity to the mirror, field by field; an `undefined` field is not written,
 * same rule as the server's (`prevOf`/`pick`), which is what makes C-5 hold on both sides. */
export function ws5ShadowPut(map: Map<Id, string>, ent: { id: Id } & Record<string, unknown>): void {
  const id = String(ent.id);
  const prev = map.get(id);
  const base: Record<string, unknown> = prev ? JSON.parse(prev) : {};
  Object.keys(ent).forEach((k) => {
    if (ent[k] !== undefined) base[k] = ent[k];
  });
  base["id"] = id;
  map.set(id, JSON.stringify(base));
}

/** The mirror follows the server op by op (C-6): applied TO THE MIRROR, exactly as the server
 * applies it to its plan, never resynced from local state. */
export function wsShadowApplyOpInto(m: Miroir, op: Op | null | undefined, wire: Serialiseurs): void {
  if (!op || !op.kind) return;
  switch (op.kind) {
    case "plan5.replace":
      wsShadowFromServerInto(m, op.plan, wire);
      break;
    case "outline.set":
      m.outline = JSON.stringify((op.outline || []).map((p) => [v5R2(p[0]), v5R2(p[1])] as Pt));
      break;
    case "wall.set":
      if (op.wall && op.wall.id !== undefined) ws5ShadowPut(m.walls, op.wall as { id: Id } & Record<string, unknown>);
      break;
    case "wall.del": {
      const id = String(op.wallId);
      m.walls.delete(id);
      [...m.openings].forEach(([k, v]) => {
        try {
          if (String((JSON.parse(v) as { wallId: unknown }).wallId) === id) m.openings.delete(k);
        } catch { /* unreadable entry: we keep it, the next diff will settle it */ }
      });
      break;
    }
    case "opening.set":
      if (op.opening && op.opening.id !== undefined) {
        ws5ShadowPut(m.openings, op.opening as { id: Id } & Record<string, unknown>);
      }
      break;
    case "opening.del":
      m.openings.delete(String(op.openingId));
      break;
    case "piece.set":
      if (op.piece && op.piece.id !== undefined) ws5ShadowPut(m.pieces, op.piece as { id: Id } & Record<string, unknown>);
      break;
    case "piece.del":
      m.pieces.delete(String(op.pieceId));
      break;
    case "cell.set": {
      const e: { id: Id } & Record<string, unknown> = { id: String(op.cellId) };
      if (op.name !== undefined) e["name"] = op.name;
      if (op.floor !== undefined) e["floor"] = op.floor;
      if (op.poly !== undefined) e["poly"] = op.poly.map((p) => [v5R2(p[0]), v5R2(p[1])] as Pt);
      ws5ShadowPut(m.cells, e);
      break;
    }
    case "cells.replace":
      m.cells = new Map();
      (op.cells || []).forEach((c) => {
        try {
          const w = wire.cell(c);
          m.cells.set(String(w.id), JSON.stringify(w));
        } catch { /* see the header: absent from the mirror = re-emitted in full */ }
      });
      break;
  }
}

/**
 * Field-by-field diff of an entity against its mirror. Returns `null` if nothing moved, the WHOLE
 * entity if the server doesn't know it yet (creation) or if a key it has is now absent locally
 * (inexpressible as a partial), otherwise `{id}` plus only the changed fields.
 */
export function ws5FieldDiff<E extends { id: Id }>(cur: E, prevStr: string | undefined): E | (Partial<E> & { id: Id }) | null {
  if (prevStr === undefined) return cur; // creation: the whole entity
  const prev = JSON.parse(prevStr) as Record<string, unknown>;
  const out: Record<string, unknown> = { id: cur.id };
  let n = 0;
  const c = cur as unknown as Record<string, unknown>;
  for (const k in c) {
    if (k === "id") continue;
    if (JSON.stringify(c[k]) !== JSON.stringify(prev[k])) { out[k] = c[k]; n++; }
  }
  for (const k in prev) {
    if (k !== "id" && c[k] === undefined) return cur;
  }
  return n ? (out as Partial<E> & { id: Id }) : null;
}

/**
 * The ops the mirror `m` is missing for it to describe `wire`. A PURE function (C-3).
 * The order is a contract: outline before walls (C-13), `wall.del` after openings (the server
 * cascades a deleted wall's openings, so a re-homed opening must move first), cells last.
 */
export function ws5DiffOps(wire: PlanFil, m: Miroir): Op[] {
  const ops: Op[] = [];
  const outStr = JSON.stringify(wire.outline);
  if (outStr !== m.outline) ops.push({ kind: "outline.set", outline: wire.outline });

  // walls: upsert new/modified ones (ONLY the changed fields), wall.del for the ones that
  // disappeared (the server cascades their openings)
  const curW = new Set<Id>();
  wire.walls.forEach((w) => {
    curW.add(w.id);
    const d = ws5FieldDiff(w, m.walls.get(w.id));
    if (d) ops.push({ kind: "wall.set", wall: d });
  });
  // Un mur se supprime en dernier, apres les ouvertures: le serveur cascade les ouvertures d'un
  // `wall.del`, donc une ouverture re-hebergee par une soudure doit d'abord porter son nouveau
  // `wallId`, ou le `wall.del` la detruirait avant que l'`opening.set` suivant ne la sauve.
  const mursSupprimes: Id[] = [];
  m.walls.forEach((_, id) => { if (!curW.has(id)) mursSupprimes.push(id); });

  // openings
  const curO = new Set<Id>();
  wire.openings.forEach((o) => {
    curO.add(o.id);
    const d = ws5FieldDiff(o, m.openings.get(o.id));
    if (d) ops.push({ kind: "opening.set", opening: d });
  });
  m.openings.forEach((_, id) => { if (!curO.has(id)) ops.push({ kind: "opening.del", openingId: id }); });
  // Ici, et pas plus tot: toute ouverture qui a change de mur porte deja son nouveau `wallId`.
  mursSupprimes.forEach((id) => ops.push({ kind: "wall.del", wallId: id }));

  // furniture (FLAT list: piece.set/piece.del with no roomId)
  const curP = new Set<Id>();
  wire.pieces.forEach((p) => {
    curP.add(p.id);
    const d = ws5FieldDiff(p, m.pieces.get(p.id));
    if (d) ops.push({ kind: "piece.set", piece: d });
  });
  m.pieces.forEach((_, id) => { if (!curP.has(id)) ops.push({ kind: "piece.del", pieceId: id }); });

  // cells: geometry changed -> cells.replace; otherwise name/floor only -> cell.set
  let geoChanged = wire.cells.length !== m.cells.size;
  if (!geoChanged) {
    for (const c of wire.cells) {
      const prev = m.cells.get(c.id);
      if (prev === undefined) { geoChanged = true; break; }
      if (JSON.stringify((JSON.parse(prev) as { poly: unknown }).poly) !== JSON.stringify(c.poly)) {
        geoChanged = true;
        break;
      }
    }
  }
  if (geoChanged) {
    ops.push({ kind: "cells.replace", cells: wire.cells });
  } else {
    wire.cells.forEach((c) => {
      const prev = m.cells.get(c.id);
      if (prev === undefined) return;
      const pc = JSON.parse(prev) as { name?: string; floor?: string };
      if (pc.name !== c.name || pc.floor !== c.floor) {
        ops.push({ kind: "cell.set", cellId: c.id, name: c.name, floor: c.floor, poly: c.poly });
      }
    });
  }
  return ops;
}
