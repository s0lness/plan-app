// src/ts/fil/reception.ts: WHAT COMES IN: SURGICAL APPLICATION OF A REMOTE OP.
//
// Three rules govern this file: C-5 (an op can be PARTIAL, merge only the keys present, never
// replace the entity), C-10 (bounding belongs to the gesture's author: cells are recomputed, but
// neither furniture nor openings are rebounded here, except the one wall named by a `wall.set`/
// `opening.set`, C-11), C-13 (a facade is never deleted, and a refusal gives back what the server
// already cascaded away, not merely keeps what we still have).

import type { Contexte } from "../app/contexte.ts";
import type { Fil } from "./etat.ts";
import type { Meuble, Op, Ouverture, OuvertureFilEntrante, Pt } from "../partage/plan.ts";
import { v5CellById, v5OpeningById, v5Touch, v5WallById } from "../app/contexte.ts";
import { WALL } from "../noyau/nombres.ts";
import { cssId, setLabelSpin } from "../noyau/dom.ts";
import { estSolConnu } from "../partage/contrat-serveur.ts";
import { toast } from "../app/toast.ts";
import { save } from "../app/persistance.ts";
import { render } from "../rendu/rendu.ts";
import { aptBBox } from "../rendu/vue.ts";
import { selRecomputePrimary } from "../rendu/selection.ts";
import { fileOpDistante, gesteActif } from "../gestes/sortie.ts";
import { v5SetModel } from "../gestes/murs.ts";
import { v5OnOutline } from "../modele/conversion.ts";
import { sanitizeV5Plan } from "../modele/migrations.ts";
import { v5ClampOpeningsOfWall, v5WallDeleteVerdict } from "../modele/murs.ts";
import { v5FlushOpeningsBorned, v5NoteForeignOrphans, v5SyncOutlineWalls } from "../modele/edition.ts";
import { v5RebuildCells } from "../modele/cellules.ts";
import { v5AdoptOpening } from "./pseudo-fil.ts";
import { wsShadowApplyOp, wsRequestFullSync } from "./emission.ts";
import { personColor } from "../mesure/curseur-pair.ts";

const WS5_KEPT_MAX = 200;   // an identifier never reclaimed must not accumulate for life
const WS_GHOST_TTL = 800;
const WS_REBASE_MAX = 500;  // beyond this, it is no longer a resume: adoption takes over

/**
 * A piece coming from the WIRE into local shape. C-5: ONLY the keys present are copied over.
 * `hinge` and `swing` are normalized because the wire carries them as free-form numbers.
 */
function wsAdoptPiece(wp: Partial<Meuble> & { id: unknown; hinge?: unknown; swing?: unknown }): Partial<Meuble> & { id: string } {
  const o: Record<string, unknown> = { id: String(wp.id) };
  (["type", "name", "x", "y", "w", "h", "rot"] as const).forEach((k) => {
    if (wp[k] !== undefined) o[k] = wp[k];
  });
  if (wp.locked !== undefined) o["locked"] = !!wp.locked;
  if (wp.hinge !== undefined) o["hinge"] = Number(wp.hinge) ? 1 : 0;
  if (wp.swing !== undefined) o["swing"] = (Number(wp.swing) < 0 ? -1 : 1);
  return o as Partial<Meuble> & { id: string };
}

// =================================================================================================
//  SURGICAL APPLICATION
// =================================================================================================
// IN-PLACE MUTATION of entities, never object replacement: the DOM nodes hold closures over them.
// Cells are derived: after a wall or outline op we RECOMPUTE locally rather than waiting for the peer.

function ws5ApplyRemoteOp(ctx: Contexte, fil: Fil, op: Op): boolean {
  const P = ctx.etat.plan;
  if (!P) return false;
  let geo = false;
  switch (op.kind) {
    case "outline.set":
      P.outline.length = 0;
      (op.outline || []).forEach((pt) => P.outline.push([pt[0], pt[1]] as Pt));
      geo = true;
      break;

    case "wall.set": {
      // Possibly PARTIAL op: only the keys present are copied over (C-5). An unknown wall can only
      // be born from a complete op: without `a` or `b` there is no segment to place.
      const w = op.wall || ({} as typeof op.wall);
      const ex = v5WallById(ctx, w.id);
      if (ex) {
        if (w.a) ex.a = [w.a[0], w.a[1]];
        if (w.b) ex.b = [w.b[0], w.b[1]];
        if (w.t !== undefined) ex.t = w.t;
        // `free` is read and dropped (decision 0012): a peer on old code may still send it.
        ex.isOutline = v5OnOutline(ex.a, ex.b, P.outline, 1);
      } else if (w.a && w.b) {
        const a: Pt = [w.a[0], w.a[1]], b: Pt = [w.b[0], w.b[1]];
        P.walls.push({
          id: String(w.id), a, b, t: (w.t || WALL),
          isOutline: v5OnOutline(a, b, P.outline, 1),
        });
      }
      // C-10/C-11: bound ONLY what depends on the wall named by THIS op; no furniture touched.
      v5ClampOpeningsOfWall(P, String(w.id), { gardeOrphelines: true });
      geo = true;
      break;
    }

    case "wall.del": {
      const id = String(op.wallId);
      // C-13. On rollback, the "facade" verdict does not apply: it was OUR OWN creation refused,
      // undoing it is legitimate.
      let verdict = v5WallDeleteVerdict(P, id);
      if (fil.reverting && verdict === "facade") verdict = "ok";
      if (verdict === "facade") {
        // We keep it; the server did cascade, deliberately and temporarily: `refusedDel`
        // republishes the wall and its openings right after (C-13).
        fil.refusedDel = true;
        (P.openings || []).forEach((o) => { if (String(o.wallId) === id) fil.keptOpenings.add(String(o.id)); });
        while (fil.keptOpenings.size > WS5_KEPT_MAX) {
          fil.keptOpenings.delete(fil.keptOpenings.values().next().value as string);
        }
        toast("A facade was deleted on the other device: it and its openings are kept, and put back into the shared plan.");
        break;
      }
      // "ok" like "absent": the cascade is the server's and unconditional; only cascading when
      // the wall is still present would let a window placed on it survive on our side.
      for (let i = P.openings.length - 1; i >= 0; i--) {
        if (String(P.openings[i]!.wallId) === id) P.openings.splice(i, 1);
      }
      if (verdict === "ok") {
        const k = P.walls.findIndex((w) => String(w.id) === id);
        if (k >= 0) P.walls.splice(k, 1);
        if (String(ctx.ihm.selWall) === id) ctx.ihm.selWall = null;
        // `geo` means "the geometry changed", not "a wall op went through" (C-14): re-running
        // `v5SyncOutlineWalls()` for nothing shifts facades to the wrong edge.
        geo = true;
      }
      break;
    }

    case "opening.set": {
      const o = op.opening || ({} as typeof op.opening);
      const ex = v5OpeningById(ctx, o.id);
      if (ex) {
        // Merge of only the keys present (C-5). The packed shape from an old client is unpacked
        // first, and only in that case (V-8).
        const src = Object.assign({}, o) as OuvertureFilEntrante & Record<string, unknown>;
        if (src.side === undefined && src.hinge !== undefined) {
          const n = Number(src.hinge) || 0;
          if (n > 1) { src.side = ((n >> 1) & 1) as 0 | 1; src.hinge = n & 1; }
        }
        Object.keys(src).forEach((k) => {
          if (k !== "id" && src[k] !== undefined) (ex as unknown as Record<string, unknown>)[k] = src[k];
        });
      } else {
        // Clone: the op then lives on in the undo journal, no shared object.
        P.openings.push(v5AdoptOpening(JSON.parse(JSON.stringify(o))) as Ouverture);
      }
      // Symmetric to `wall.set`: bound THIS opening on ITS wall only (C-10/C-11).
      const cible = v5OpeningById(ctx, o.id);
      if (cible) v5ClampOpeningsOfWall(P, cible.wallId, { only: cible.id, gardeOrphelines: true });
      break;
    }

    case "opening.del": {
      const oid = String(op.openingId);
      // C-13 follow-up: we cannot block facade opening deletions wholesale (deleting one window is
      // legitimate). We refuse only the CONSEQUENCE of a facade deletion just turned away, by id, once.
      if (fil.keptOpenings.delete(oid)) { fil.refusedDel = true; break; }
      const k = P.openings.findIndex((o) => String(o.id) === oid);
      if (k >= 0) P.openings.splice(k, 1);
      break;
    }

    case "cell.set": {
      const c = v5CellById(ctx, op.cellId);
      if (c) {
        if (op.name !== undefined) c.name = op.name;
        if (op.floor !== undefined && estSolConnu(op.floor)) c.floor = op.floor;
        if (op.poly !== undefined) c.poly = op.poly.map((pt) => [pt[0], pt[1]] as Pt);
      } else if (op.poly !== undefined) {
        P.cells.push({
          id: String(op.cellId),
          poly: op.poly.map((pt) => [pt[0], pt[1]] as Pt),
          name: String(op.name || "Room"),
          floor: estSolConnu(op.floor) ? op.floor : "parquet",
        });
      }
      break;
    }

    case "cells.replace": {
      // We REUSE the object when the identifier already exists: the DOM nodes hold closures over it.
      const keep = new Map(P.cells.map((c) => [String(c.id), c] as const));
      P.cells.length = 0;
      (op.cells || []).forEach((c) => {
        const ex = keep.get(String(c.id));
        const poly = (c.poly || []).map((pt) => [pt[0], pt[1]] as Pt);
        const floor = estSolConnu(c.floor) ? c.floor : "parquet";
        if (ex) { ex.poly = poly; ex.name = c.name; ex.floor = floor; P.cells.push(ex); }
        else P.cells.push({ id: String(c.id), poly, name: String(c.name || "Room"), floor });
      });
      break;
    }

    case "piece.set": {
      const np = wsAdoptPiece(op.piece as Partial<Meuble> & { id: unknown });
      wsClearGhost(fil, np.id);
      const i = P.pieces.findIndex((p) => String(p.id) === String(np.id));
      if (i >= 0) {
        const ex = P.pieces[i]!;
        Object.keys(np).forEach((k) => {
          if (k !== "id") (ex as unknown as Record<string, unknown>)[k] = (np as unknown as Record<string, unknown>)[k];
        });
      } else {
        const cree = np as unknown as Record<string, unknown>;
        if (cree["type"] === "door" && cree["swing"] === undefined) cree["swing"] = 1;   // catalogue default
        P.pieces.push(cree as unknown as Meuble);
      }
      break;
    }

    case "piece.del": {
      const i = P.pieces.findIndex((p) => String(p.id) === String(op.pieceId));
      if (i >= 0) {
        // C-15/C-16: a piece deleted by the other person while selected (or dragged) here says so.
        const mien = !fil.reverting && !fil.rebasing
          && [...ctx.selection.ids].some((id) => String(id) === String(op.pieceId));
        P.pieces.splice(i, 1);
        for (const id of [...ctx.selection.ids]) if (String(id) === String(op.pieceId)) ctx.selection.ids.delete(id);
        selRecomputePrimary(ctx);
        if (ctx.selection.primaire == null) ctx.crochets.hideInspector?.();
        if (mien) {
          toast(gesteActif()
            ? "The piece you were moving has just been deleted by the other person."
            : "The selected piece has just been deleted by the other person.");
        }
      }
      break;
    }

    // `piece.front` no longer exists: an op with this name falls through and is ignored.
    default:
      return false;
  }

  // C-10: recompute CELLS (derived) and facades, but do not rebound furniture or openings.
  if (geo) {
    v5SyncOutlineWalls(P);
    v5RebuildCells(P);
    // C-13's sibling for the ordinary case (a peer's outline shrink relogs a facade's openings).
    // `v5FlushOpeningsBorned()` is flushed HERE, on receipt, so the banner never lands on the
    // wrong screen (attributed to whatever LOCAL gesture ran next).
    const perdu = v5FlushOpeningsBorned();
    if (perdu) toast(perdu);
  }
  // A piece the OTHER person's op left outside any cell is THEIR business to bound and republish;
  // we only note the orphan so as not to claim its repair on the next local gesture.
  if (!fil.reverting && !fil.rebasing) v5NoteForeignOrphans(P);
  v5Touch(ctx); if (_renduGroupe) _renduDu = true; else render(ctx);
  return true;
}

// ---- ONE PAINT FOR A BATCH THAT ARRIVES AS A BATCH ----------------------------------------------
// The surgical path repaints after EVERY op, right for ops arriving one by one off the wire. A
// REPLAY describes ONE final state handed over as a list: painting each intermediate one costs a
// full `render()` per op for a picture nobody sees, so this groups them into a single paint.
//
// A COUNTER, not a boolean: `wsApplyRemoteOp` is re-entrant through `save()` on a facade refusal.
// `_renduDu` records that something asked to paint, so a batch where every op was refused paints nothing.
let _renduGroupe = 0;
let _renduDu = false;

/** Applies `corps` with a single paint at the end. The paint is REAL, never skipped: leaving the
 *  screen on the pre-replay state would be worse than repainting too often. */
function enUnSeulRendu(ctx: Contexte, corps: () => void): void {
  _renduGroupe++;
  try { corps(); } finally {
    _renduGroupe--;
    if (!_renduGroupe && _renduDu) { _renduDu = false; render(ctx); }
  }
}

/** Returns TRUE if the op was REFUSED (facade deletion, or an opening from its cascade): a
 * refused op must not enter the undo journal, or Ctrl+Z would redo the disappearance (C-9/C-13). */
export function wsApplyRemoteOp(ctx: Contexte, fil: Fil, op: Op | null | undefined): boolean {
  if (!op || !op.kind) return false;
  // C-17: a full replacement DURING a local gesture erases it (orphaned closure, recentered
  // view). We QUEUE it, the gesture's shared exit applies it, watchdog included.
  if (op.kind === "plan5.replace" && gesteActif()) { fileOpDistante(op); return false; }
  fil.wsSuppress = true;
  fil.refusedDel = false;
  let refuse = false;
  try {
    // The ONLY op that replaces everything; the others are surgical.
    if (op.kind === "plan5.replace") {
      const p = sanitizeV5Plan({
        outline: op.plan && op.plan.outline,
        walls: op.plan && op.plan.walls,
        cells: op.plan && op.plan.cells,
        pieces: op.plan && op.plan.pieces,
        openings: ((op.plan && op.plan.openings) || []).map(v5AdoptOpening),
      });
      // C-17. `keepView`: a remote op NEVER recenters the view of the person receiving it.
      if (p) v5SetModel(ctx, p, { keepView: true });
      return false;
    }
    ws5ApplyRemoteOp(ctx, fil, op);
  } finally {
    fil.wsSuppress = false;
    // The mirror follows the SERVER, never local state (C-6).
    wsShadowApplyOp(ctx, fil, op);
    // C-13: facade refusal gives back what the server cascaded away. The mirror now describes it
    // as gone, so the diff sees our copy as a CREATION and re-emits it on the next `save()`,
    // triggered right away (outside `wsSuppress`) so it survives an F5 before that.
    refuse = fil.refusedDel;
    fil.refusedDel = false;
    if (refuse) save(ctx);
  }
  return refuse;
}

// =================================================================================================
//  ROLLBACK OF AN OP THE SERVER REFUSED (C-10)
// =================================================================================================
// We VISIBLY UNDO the local change. The chip does not lie: the link IS alive, it is that
// particular write that got refused; switching it to "not saved" would be false about the rest of
// the plan, with no event ever coming to clear it.

/** Returns true if the change could be undone PRECISELY (otherwise a resync was requested). */
export function wsRevertRefused(ctx: Contexte, fil: Fil, n: number | null | undefined): boolean {
  const e = (n !== undefined && n !== null) ? fil.pending.get(n) : null;
  if (e && n != null) fil.pending.delete(n);
  // A refusal IS a response: this op no longer waits for anything, must not trigger a resend.
  if (n !== undefined && n !== null) fil.unacked.delete(n);
  // No `n`, or a non-invertible op (`plan5.replace`): a full resync brings this screen back in
  // line with the shared plan, without inventing anything.
  if (!e || !e.undo) { wsRequestFullSync(fil); return false; }
  if (!e.undo.length) return true;        // the server did not know the entity: nothing to undo
  fil.reverting = true;
  try { e.undo.forEach((op) => { wsApplyRemoteOp(ctx, fil, op); }); }
  finally { fil.reverting = false; }
  save(ctx);                              // the local state goes back into storage; the diff stays silent
  return true;
}

// =================================================================================================
//  RESUME AFTER AN OUTAGE: WHAT THE SERVER NEVER RECEIVED GOES BACK OUT (C-18)
// =================================================================================================
// Adoption on reconnection replaces local state, which would erase whatever was IN FLIGHT at the
// moment of the outage. Ops computed BEFORE adoption (`ws5DiffOps(local, ACKNOWLEDGED mirror)`,
// exactly our unconfirmed work) are replayed on top of the adopted state, then republished by `save()`.

export function wsRejouerNonAcquittees(ctx: Contexte, fil: Fil, ops: Op[] | null | undefined): number {
  if (!ops || !ops.length || ops.length > WS_REBASE_MAX) return 0;
  fil.rebasing = true;
  // ONE PAINT for the whole replay: up to 500 ops (`WS_REBASE_MAX`) describing ONE state, on the
  // reconnection frame, where the screen has the least room to spare for one `render()` each.
  try { enUnSeulRendu(ctx, () => { ops.forEach((op) => { wsApplyRemoteOp(ctx, fil, op); }); }); }
  finally { fil.rebasing = false; }
  save(ctx);                              // the diff (mirror = server state) republishes them in order
  return ops.length;
}

// =================================================================================================
//  REMOTE DRAG GHOSTS
// =================================================================================================
// A ghost is the SOURCE OF TRUTH while a peer moves a piece: applied onto the DOM node on every
// rAF frame and after every `render()`. Expires ~800ms after the last message, or on `piece.set`.

export function wsApplyRemoteDrag(
  ctx: Contexte, fil: Fil,
  msg: { pieceId: unknown; x: number; y: number; rot?: number | null; by?: string; color?: string },
): void {
  fil.ghosts.set(String(msg.pieceId), {
    x: msg.x, y: msg.y, rot: (msg.rot != null ? msg.rot : null),
    color: personColor(msg.by, msg.color), expiry: Date.now() + WS_GHOST_TTL,
  });
  wsEnsureGhostLoop(ctx, fil);
}

/** Applies a ghost onto its piece's DOM node (apartment cm -> local layer px). */
function wsApplyOneGhost(ctx: Contexte, key: string, g: { x: number; y: number; rot: number | null; color: string }): boolean {
  const cont = ctx.canvas.querySelector<HTMLElement>(".v5layer");
  if (!cont) return false;
  const lbb = aptBBox(ctx);
  // `key` comes from the wire: NEVER raw in a selector (R-9), or an exception kills the ghost rAF
  // loop for ALL of the peer's ghosts.
  const el = cont.querySelector<HTMLElement>(`.piece[data-id="${cssId(key)}"]`);
  if (!el) return false;
  el.style.left = ((g.x - lbb.minX) * ctx.vue.scale) + "px";
  el.style.top = ((g.y - lbb.minY) * ctx.vue.scale) + "px";
  // The label must be straightened against the ghost's rotation too, or it reads upside down for
  // the whole drag (R-1).
  if (g.rot != null) {
    el.style.transform = `rotate(${g.rot}deg)`;
    setLabelSpin(el.querySelector<HTMLElement>(".plabel-wrap"), g.rot);
  }
  if (!el.classList.contains("peer-ghost")) el.classList.add("peer-ghost");
  el.style.outlineColor = g.color || "var(--accent)";
  return true;
}

/** Reapplies ALL active ghosts onto the DOM (after `render()` and on every rAF frame). */
export function wsApplyGhostsToDOM(ctx: Contexte, fil: Fil): void {
  if (!fil.ghosts.size) return;
  fil.ghosts.forEach((g, key) => { wsApplyOneGhost(ctx, key, g); });
}

function wsGhostTick(ctx: Contexte, fil: Fil): void {
  fil.ghostRaf = 0;
  const now = Date.now();
  let expired = false;
  fil.ghosts.forEach((g, key) => { if (now >= g.expiry) { fil.ghosts.delete(key); expired = true; } });
  wsApplyGhostsToDOM(ctx, fil);
  if (expired) render(ctx);               // a piece finished its ghost -> back to the real state
  if (fil.ghosts.size) wsEnsureGhostLoop(ctx, fil);
}

function wsEnsureGhostLoop(ctx: Contexte, fil: Fil): void {
  if (!fil.ghostRaf) fil.ghostRaf = requestAnimationFrame(() => wsGhostTick(ctx, fil));
}

/** When the corresponding `piece.set` arrives: the ghost no longer has a reason to exist. */
function wsClearGhost(fil: Fil, pieceId: unknown): void {
  fil.ghosts.delete(String(pieceId));
}
