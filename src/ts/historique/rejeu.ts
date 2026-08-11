// src/ts/historique/rejeu.ts — REPLAYING AN OP ONTO A DATA PLAN.
// Ported from src/js/27-historique.js (the PURE part: `histApplyOp`). The snapshot stack, the
// bounded log and the buttons live in the DOM: still to be ported.
//
// C-9: CTRL+Z UNDOES ONLY ITS AUTHOR'S WORK. `undo()` used to replay a COMPLETE snapshot and
// publish it as a replacement of the plan. Since ops received from the other person NEVER entered
// the history, the snapshot was by construction blind to everything she had done since the
// last local action: her furniture would move back, her renaming would vanish, on BOTH screens,
// without a word. The longer we stayed idle while she worked, the more our own Ctrl+Z
// destroyed.
//
// The fix takes two steps, and this is the first one: a snapshot is a past SHARED
// state, so the peers' ops received since it was taken are REPLAYED on top before
// restoring. The second step (publishing BY DIFF, never `plan5.replace`) is in
// `fil/miroir.ts`.
//
// Ops have been PARTIAL ever since the emitter diffs field by field: WE MERGE, we never replace
// a whole entity with a partial op.

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
        // ONE SINGLE DELIBERATE DIVERGENCE FROM js/27, and it only concerns an ERROR path:
        // the old code passed `w.a`/`w.b` RAW to `v5OnOutline` while it fell back to `[0,0]`
        // to store them. A partial wall op with no `a` (possible when the wall no longer exists
        // on that side) therefore made the replay THROW, which failed the whole undo. Here both
        // reads see the same fallback value: on every path that succeeded, the result is
        // identical down to the character.
        const a = (w.a || [0, 0]).slice() as Pt;
        const b = (w.b || [0, 0]).slice() as Pt;
        L("walls").push({ id: String(w.id), a, b, t: w.t || WALL, isOutline: v5OnOutline(a, b, P.outline, 1) });
      }
      break;
    }
    case "wall.del": {
      const id = String(op.wallId);
      L("walls"); L("openings");
      // SAME RULE AS THE WIRE AND AS THE UI: a FACADE cannot be deleted (C-13). Without this
      // guard, receiving would correctly keep the facade and its openings, then the first Ctrl+Z would
      // make them disappear again, and since the restored snapshot is published BY DIFF, the loss would
      // propagate all the way to the shared plan.
      if (v5WallDeleteVerdict(P, id) === "facade") break;
      // "absent" cascades anyway: the server filters openings without checking whether the wall
      // existed, and a replay must give the same plan it would.
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
      } else if (op.poly !== undefined) {
        L("cells").push({
          id: String(op.cellId),
          poly: op.poly.map((p) => [p[0], p[1]] as Pt),
          name: String(op.name || "Room"),
          floor: op.floor || "parquet",
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
