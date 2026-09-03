// src/ts/historique/rejeu.ts: REPLAYING AN OP ONTO A DATA PLAN, pure (`histApplyOp`).
//
// C-9, step one: a snapshot is a past SHARED state, so the peers' ops received since it was taken
// are REPLAYED on top before restoring (step two, publishing by diff, is `fil/miroir.ts`).
// Ops are PARTIAL: we merge, never replace a whole entity with a partial op.

import { WALL } from "../noyau/nombres.ts";
import { v5OnOutline } from "../modele/conversion.ts";
import { v5WallDeleteVerdict } from "../modele/murs.ts";
import { v5AdoptOpening } from "../fil/pseudo-fil.ts";
import type { Cellule, Meuble, Mur, Op, Ouverture, PlanV5, Pt } from "../partage/plan.ts";

type ListeNom = "walls" | "openings" | "pieces" | "cells";

/**
 * Replays an op onto a DATA plan (the `plan` object of a snapshot), with no rendering, no derived
 * geometry, no side effect. Mutates `P`.
 */
export function histApplyOp(P: PlanV5 | null | undefined, op: Op | null | undefined): void {
  if (!P || !op || !op.kind) return;
  const L = <K extends ListeNom>(k: K): PlanV5[K] => {
    if (!Array.isArray(P[k])) (P[k] as unknown) = [];
    return P[k];
  };
  const at = (k: ListeNom, id: unknown): number =>
    (L(k) as Array<{ id: unknown }>).findIndex((e) => String(e.id) === String(id));

  switch (op.kind) {
    case "outline.set":
      P.outline = (op.outline || []).map((p) => [p[0], p[1]] as Pt);
      break;
    case "wall.set": {
      const w = JSON.parse(JSON.stringify(op.wall || {})) as Partial<Mur> & { id?: unknown };
      if (w.id === undefined) break;
      const i = at("walls", w.id);
      if (i >= 0) {
        const ex = L("walls")[i]!;
        Object.assign(ex, w);
        ex.id = String(w.id);
        ex.isOutline = v5OnOutline(ex.a, ex.b, P.outline, 1);
      } else {
        // A partial wall op with no `a`/`b` (wall no longer exists on that side) must not throw
        // and fail the whole undo: both reads share the same `[0,0]` fallback.
        const a = (w.a || [0, 0]).slice() as Pt;
        const b = (w.b || [0, 0]).slice() as Pt;
        L("walls").push({ id: String(w.id), a, b, t: w.t || WALL, isOutline: v5OnOutline(a, b, P.outline, 1) });
      }
      break;
    }
    case "wall.del": {
      const id = String(op.wallId);
      L("walls"); L("openings");
      // Same rule as the wire and the UI: a facade cannot be deleted (C-13), or the first Ctrl+Z
      // after a kept-facade receipt would make it disappear again, published by diff.
      if (v5WallDeleteVerdict(P, id) === "facade") break;
      // "absent" cascades anyway, same as the server.
      P.walls = L("walls").filter((w) => String(w.id) !== id);
      P.openings = L("openings").filter((o) => String(o.wallId) !== id);
      break;
    }
    case "opening.set": {
      const o = op.opening || ({} as { id?: unknown });
      if (o.id === undefined) break;
      const i = at("openings", o.id);
      // Clone: the op stays in the log, it must never share an object with a plan.
      if (i >= 0) {
        const ex = L("openings")[i]!;
        Object.assign(ex, JSON.parse(JSON.stringify(o)));
        ex.id = String(o.id);
      } else {
        L("openings").push(v5AdoptOpening(JSON.parse(JSON.stringify(o))) as Ouverture);
      }
      break;
    }
    case "opening.del":
      P.openings = L("openings").filter((o) => String(o.id) !== String(op.openingId));
      break;
    case "cell.set": {
      const i = at("cells", op.cellId);
      if (i >= 0) {
        const c = L("cells")[i]!;
        if (op.name !== undefined) c.name = op.name;
        if (op.floor !== undefined) c.floor = op.floor;
        if (op.poly !== undefined) c.poly = op.poly.map((p) => [p[0], p[1]] as Pt);
        if (op.lux !== undefined) c.lux = op.lux;
      } else if (op.poly !== undefined) {
        L("cells").push({
          id: String(op.cellId),
          poly: op.poly.map((p) => [p[0], p[1]] as Pt),
          name: String(op.name || "Room"),
          floor: op.floor || "parquet",
          ...(op.lux === undefined ? {} : { lux: op.lux }),
        });
      }
      break;
    }
    case "cells.replace":
      P.cells = (op.cells || []).map((c): Cellule => ({
        id: String(c.id),
        poly: (c.poly || []).map((p) => [p[0], p[1]] as Pt),
        name: String(c.name || ""),
        floor: c.floor || "parquet",
        ...(c.lux === undefined ? {} : { lux: c.lux }),
      }));
      break;
    case "piece.set": {
      const p = JSON.parse(JSON.stringify(op.piece || {})) as Partial<Meuble> & { id?: unknown };
      if (p.id === undefined) break;
      const i = at("pieces", p.id);
      if (i >= 0) {
        const ex = L("pieces")[i]!;
        Object.assign(ex, p);
        ex.id = String(p.id);
      } else {
        L("pieces").push(Object.assign({}, p, { id: String(p.id) }) as Meuble);
      }
      break;
    }
    case "piece.del":
      P.pieces = L("pieces").filter((p) => String(p.id) !== String(op.pieceId));
      break;
    case "plan5.replace":
      // A complete replacement of the shared plan clears the history on the caller's side: no
      // snapshot describes a past of THIS plan anymore. Nothing to replay here.
      break;
  }
}
