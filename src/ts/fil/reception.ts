// src/ts/fil/reception.ts — WHAT COMES IN: SURGICAL APPLICATION OF A REMOTE OP.
// Ported from src/js/43-collab-reception.js, in full.
//
// THREE RULES GOVERN THIS FILE, AND ALL THREE ARE MEASURED LOSSES OF WORK.
//
//  C-5  AN OP CAN BE PARTIAL. The emitter diffs field by field and the server relays the op AS IS:
//       an absent key means "no opinion", exactly as on the server side. We MERGE the keys that
//       are present, we NEVER replace the entity. Manufacturing the key anyway (with `undefined`)
//       erased the piece's name, type, and dimensions on the peer's side as soon as only its
//       position had moved.
//
//  C-10 BOUNDING BELONGS TO THE GESTURE'S AUTHOR. We RECOMPUTE cells (they are derived, and
//       without them nothing paints), but we DO NOT REBOUND EITHER furniture OR openings here. The
//       person who pushes a wall bounds it ONCE, on the FINAL geometry, and publishes the result;
//       the person receiving sees the walls arrive ONE BY ONE, so rebounding on every op made it
//       pass through every INTERMEDIATE geometry and accumulate the drift, measured at 27 cm
//       across 4 pieces of furniture, permanently and without a word, on the screen of the person
//       who had touched nothing.
//       THE ONLY HOLE IN THE RULE, AND NOTHING MORE: when a peer THINS or SHORTENS a wall while we
//       are placing an opening on it, the merge produces an opening outside its wall, and the
//       result is wrong on BOTH screens, this is no longer a divergence, it is invalid data that
//       nobody will ever fix again. So we bound whatever depends on the wall NAMED by that
//       particular op, and nothing else: monotone, deterministic on both sides, and republished
//       by `save()`.
//
//  C-13 A FACADE IS NEVER DELETED, NO MATTER WHERE THE ORDER COMES FROM. The local interface
//       already refused it; this path, though, obeyed. Measured with two browsers: the wall
//       stayed standing (it is DERIVED from the outline, `v5SyncOutlineWalls` recreates it right
//       away) but its openings left for good, 6 objects on a SINGLE received op, recorded as
//       lost. And refusing is not enough: the mirror follows the server, so we GIVE BACK what it
//       lost, we do not just settle for keeping it.

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
import { v5NoteForeignOrphans, v5SyncOutlineWalls } from "../modele/edition.ts";
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
// IN-PLACE MUTATION of entities, NEVER object replacement: the DOM nodes hold closures over them
// (this is the v4 "orphan echo" fix). Cells are derived: after a wall or outline op we RECOMPUTE
// locally rather than waiting for the peer.

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
      // Possibly PARTIAL op (one moves an endpoint, the other changes the thickness): only the
      // keys present are copied over. An UNKNOWN wall, on the other hand, can only be born from a
      // complete op: without `a` or `b` there is no segment to place.
      const w = op.wall || ({} as typeof op.wall);
      const ex = v5WallById(ctx, w.id);
      if (ex) {
        if (w.a) ex.a = [w.a[0], w.a[1]];
        if (w.b) ex.b = [w.b[0], w.b[1]];
        if (w.t !== undefined) ex.t = w.t;
        // C-5: `free` follows the same "present key = opinion" merge as every other field here.
        // It is only ever emitted truthy (see `v5WallWire`), so a present value is always `1`.
        if (w.free !== undefined) ex.free = w.free ? 1 : undefined;
        ex.isOutline = v5OnOutline(ex.a, ex.b, P.outline, 1);
      } else if (w.a && w.b) {
        const a: Pt = [w.a[0], w.a[1]], b: Pt = [w.b[0], w.b[1]];
        P.walls.push({
          id: String(w.id), a, b, t: (w.t || WALL),
          isOutline: v5OnOutline(a, b, P.outline, 1),
          free: w.free ? 1 : undefined,
        });
      }
      // C-10, THE ONLY HOLE IN THE RULE (see the header): we bound ONLY what depends on the wall
      // named by THIS op. No furniture is touched, `v5ClampPieces` stays out of it.
      v5ClampOpeningsOfWall(P, String(w.id), { gardeOrphelines: true });
      geo = true;
      break;
    }

    case "wall.del": {
      const id = String(op.wallId);
      // C-13. On rollback, the "facade" verdict does not apply: it was OUR OWN creation that got
      // refused, undoing it is legitimate. "absent" stays "absent" (nothing to remove).
      let verdict = v5WallDeleteVerdict(P, id);
      if (fil.reverting && verdict === "facade") verdict = "ok";
      if (verdict === "facade") {
        // We keep it. The server, ON ITS SIDE, did cascade: our two plans no longer agree. This
        // is deliberate and TEMPORARY, `refusedDel` republishes the wall and its openings right
        // after, so the divergence resolves FROM THE TOP, by giving back to the other side what
        // it lost, never by destroying here what we still have.
        fil.refusedDel = true;
        (P.openings || []).forEach((o) => { if (String(o.wallId) === id) fil.keptOpenings.add(String(o.id)); });
        while (fil.keptOpenings.size > WS5_KEPT_MAX) {
          fil.keptOpenings.delete(fil.keptOpenings.values().next().value as string);
        }
        toast("A facade was deleted on the other device: it and its openings are kept, and put back into the shared plan.");
        break;
      }
      // "ok" JUST LIKE "absent": the CASCADE is the server's, and it is UNCONDITIONAL over there
      // (`wall.del` filters the openings there without checking whether the wall existed).
      // Cascading only when the wall is still present let a window placed on a wall deleted at
      // the same instant survive on the placer's side, while the server had already thrown it out.
      for (let i = P.openings.length - 1; i >= 0; i--) {
        if (String(P.openings[i]!.wallId) === id) P.openings.splice(i, 1);
      }
      if (verdict === "ok") {
        const k = P.walls.findIndex((w) => String(w.id) === id);
        if (k >= 0) P.walls.splice(k, 1);
        if (String(ctx.ihm.selWall) === id) ctx.ihm.selWall = null;
        // `geo` MEANS "THE GEOMETRY CHANGED", NOT "A WALL OP WENT THROUGH". In the two other
        // branches NO wall moved, and re-running `v5SyncOutlineWalls()` for nothing is NOT
        // neutral: it re-matches facades to the outline's edges and, when one is missing, the
        // fallback loop SHIFTS all the others by one edge. Measured on the two-browser bench: the
        // echo of its OWN deletion made the emitting device's six facades rotate by one notch,
        // its windows ended up on the wrong wall, and the two screens no longer showed the same
        // apartment while ours had stayed intact.
        geo = true;
      }
      break;
    }

    case "opening.set": {
      const o = op.opening || ({} as typeof op.opening);
      const ex = v5OpeningById(ctx, o.id);
      if (ex) {
        // Merge of only the keys present. The PACKED shape from an old client (no `side`, `side`
        // in bit 1 of `hinge`) is unpacked first, and ONLY in that case (V-8).
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
      // Symmetric to the `wall.set` case: the opening may have been placed on a wall WE have
      // already thinned or shortened. We bound THIS opening on ITS wall, not the others, a plan
      // saved long ago is never silently recalculated.
      const cible = v5OpeningById(ctx, o.id);
      if (cible) v5ClampOpeningsOfWall(P, cible.wallId, { only: cible.id, gardeOrphelines: true });
      break;
    }

    case "opening.del": {
      const oid = String(op.openingId);
      // C-13, the follow-up of the refused cascade. We CANNOT refuse facade opening deletions as
      // a block: deleting ONE window is a perfectly legitimate move. What we refuse is the
      // CONSEQUENCE of a facade deletion we just turned away, recognized by identifier and ONLY ONCE.
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
      // We REUSE the object when the identifier already exists: the DOM nodes hold closures over
      // it (see the section header).
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
        // C-16. NOTHING DISAPPEARS FROM UNDER SOMEONE'S HAND WITHOUT A WORD. A piece deleted by
        // the other person while it was selected (or being dragged) here: seeing it evaporate in
        // silence is the worst kind of disappearance, one believes it is a bug in one's own gesture.
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

    // `piece.front` no longer exists: the server removed it from both its op sets and no client
    // emits it. An op with this name falls through here and is ignored, this is the old client's
    // behavior, and `Op`'s typing even makes it inexpressible on the emission side.
    default:
      return false;
  }

  // C-10. We recompute CELLS (derived, without them nothing paints) and facades, but we do NOT
  // rebound EITHER furniture OR openings. See the header.
  if (geo) { v5SyncOutlineWalls(P); v5RebuildCells(P); }
  // A piece that the OTHER person's op has just left outside any cell is THEIR business: it is
  // them who bounds it and republishes it. We note the orphan so as not to claim its repair on
  // the next local gesture.
  if (!fil.reverting && !fil.rebasing) v5NoteForeignOrphans(P);
  v5Touch(ctx); render(ctx);
  return true;
}

/**
 * Returns TRUE if the op was REFUSED (facade deletion, or an opening from its cascade). A refused
 * op never happened here: it must not enter the undo journal either, otherwise the first Ctrl+Z
 * would replay it onto the snapshot and redo exactly the disappearance we just prevented (C-9 + C-13).
 */
export function wsApplyRemoteOp(ctx: Contexte, fil: Fil, op: Op | null | undefined): boolean {
  if (!op || !op.kind) return false;
  // C-17. A full replacement DURING a local gesture erases the gesture: the dragged object
  // becomes orphaned (the closure holds the old object) and the view recenters under one's
  // fingers. We QUEUE it, we do not drop it: the gesture's shared exit applies it, watchdog included.
  if (op.kind === "plan5.replace" && gesteActif()) { fileOpDistante(op); return false; }
  fil.wsSuppress = true;
  fil.refusedDel = false;
  let refuse = false;
  try {
    // Full replacement of the shared plan (conversion of an old plan on a peer's side, import,
    // undo). This is the ONLY op that replaces everything; the others are surgical.
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
    // The mirror follows the SERVER: we apply the op to it, never the local state (C-6).
    wsShadowApplyOp(ctx, fil, op);
    // C-13. FACADE REFUSAL: WE GIVE BACK, WE DO NOT JUST SETTLE FOR KEEPING IT. The mirror
    // describes the server, which just lost the wall AND its openings (cascade); our plan, on the
    // other hand, still has them. The diff therefore sees them as CREATIONS and re-emits them in
    // full on the next `save()`. We trigger it RIGHT AWAY, outside `wsSuppress`: without this the
    // preservation would only hold until the first F5 (the `hello` would adopt the amputated
    // plan) and the other person would never see their windows again. During a gesture, `save()`
    // bails out early and the end of the gesture replays a real `save()`.
    refuse = fil.refusedDel;
    fil.refusedDel = false;
    if (refuse) save(ctx);
  }
  return refuse;
}

// =================================================================================================
//  ROLLBACK OF AN OP THE SERVER REFUSED (C-11)
// =================================================================================================
// BEFORE: the client KEPT the local change, showed a 4 s banner, left the chip on "live ✓" and
// updated its emission mirror as if the op had gone through, so the diff never re-emitted it.
// Measured: 33 openings on one side, 33 on the other, NOT the same ones, 30 at the server, and
// both screens announcing "live ✓".
// DECISION: we VISIBLY UNDO the local change. The chip, though, DOES NOT LIE: the link IS alive,
// it is that particular write that got refused. Switching it to "not saved" would say something
// FALSE about the rest of the plan, and would leave it false until an event that will never
// arrive (the server retries nothing).

/** Returns true if the change could be undone PRECISELY (otherwise a resync was requested). */
export function wsRevertRefused(ctx: Contexte, fil: Fil, n: number | null | undefined): boolean {
  const e = (n !== undefined && n !== null) ? fil.pending.get(n) : null;
  if (e && n != null) fil.pending.delete(n);
  // A refusal IS a response: this op no longer waits for anything, it must not trigger a resend.
  // The server, on its side, consumed its number for the same reason.
  if (n !== undefined && n !== null) fil.unacked.delete(n);
  // Server from BEFORE this fix (no `n`), or a non-invertible op (`plan5.replace`): we do not
  // know what to undo, but we know who to ask. A full resync brings this screen back in line
  // with the shared plan, without inventing anything.
  if (!e || !e.undo) { wsRequestFullSync(fil); return false; }
  if (!e.undo.length) return true;        // the server did not know the entity: nothing to undo
  fil.reverting = true;
  try { e.undo.forEach((op) => { wsApplyRemoteOp(ctx, fil, op); }); }
  finally { fil.reverting = false; }
  save(ctx);                              // the local state goes back into storage; the diff stays silent
  return true;
}

// =================================================================================================
//  RESUME AFTER AN OUTAGE: WHAT THE SERVER NEVER RECEIVED GOES BACK OUT (C-3)
// =================================================================================================
// On reconnection, the `hello` carries the household plan and the client ADOPTS it (the
// fingerprint has moved, if only because it was forgotten when the link dropped). Adoption
// replaces the local state: everything that was IN FLIGHT at the moment of the outage would then
// disappear from its author's screen, without a word. The replay puts this work back ON TOP OF
// the adopted state, then the final `save()` republishes it through the ordinary diff.
//
// The replayed ops are computed BEFORE adoption: `ws5DiffOps(local state, ACKNOWLEDGED mirror)`.
// This is exactly our unconfirmed work, and nothing else:
//   - an entity the PEER modified without us: local == acknowledged -> no op;
//   - an entity the peer created: absent from both -> no op;
//   - an entity the peer deleted: present in both -> no op;
//   - an entity WE touched: they differ -> one op, at its CURRENT value.
// This is Replicache's rebasing, written with our field-by-field diff.

export function wsRejouerNonAcquittees(ctx: Contexte, fil: Fil, ops: Op[] | null | undefined): number {
  if (!ops || !ops.length || ops.length > WS_REBASE_MAX) return 0;
  fil.rebasing = true;
  try { ops.forEach((op) => { wsApplyRemoteOp(ctx, fil, op); }); }
  finally { fil.rebasing = false; }
  save(ctx);                              // the diff (mirror = server state) republishes them in order
  return ops.length;
}

// =================================================================================================
//  REMOTE DRAG GHOSTS
// =================================================================================================
// A ghost is the SOURCE OF TRUTH while a peer moves a piece: we apply the position directly onto
// the DOM node on every rAF frame, AND after every `render()` (otherwise a re-render would freeze
// the piece). Expires ~800 ms after the last message, or when the `piece.set` arrives.

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
  // `key` comes from the wire: NEVER raw in a selector (R-9). An exception here would kill the
  // ghost rAF loop, hence ALL of the peer's ghosts, not just this one.
  const el = cont.querySelector<HTMLElement>(`.piece[data-id="${cssId(key)}"]`);
  if (!el) return false;
  el.style.left = ((g.x - lbb.minX) * ctx.vue.scale) + "px";
  el.style.top = ((g.y - lbb.minY) * ctx.vue.scale) + "px";
  // The ghost drives the NODE's rotation: the label, which is its child, must be straightened
  // against THAT rotation. `renderPieces` set it on `p.rot`, the value from BEFORE the peer's
  // gesture: without this callback, a piece the other person rotates showed its name upside down
  // for the whole drag, then straightened itself alone when the `piece.set` arrived (R-1).
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
export function wsClearGhost(fil: Fil, pieceId: unknown): void {
  fil.ghosts.delete(String(pieceId));
}
