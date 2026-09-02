// src/ts/fil/emission.ts — WHAT GOES OUT: THE DIFF, THE SEQUENCE NUMBERS, THE ACKNOWLEDGEMENTS,
// THE RESEND.
// Ported from src/js/42-collab-fil.js, the IMPURE part (the pure part, mirror and field-by-field
// diff, has lived in `fil/miroir.ts` since E2, and 20,000 seeds cover it with no browser).
//
// ---- C-3. AN OP LOST EN ROUTE GOES OUT AGAIN, AND IT IS THE CURRENT VALUE THAT GOES OUT AGAIN ----
// THE ECHO IS THE ACKNOWLEDGEMENT: the server re-emits every op to everyone, the author included,
// with `tag` (the device) and `n` (the author's sequence number). It proves more than a separate
// ack would: it says the op WAS APPLIED, and it already carries the fingerprint of the plan that
// resulted. Only the DUPLICATE needs a message of its own (`{t:"ack"}`): the server replays
// nothing for it, so there is no echo.
//
// THE MIRROR CANNOT SERVE AS MEMORY BY ITSELF. We keep TWO mirrors:
//   `ws5`    OPTIMISTIC: it advances on emission (otherwise every `save()` would re-emit the same
//            op for the whole round trip) and on reception. This is the one the diff compares
//            against.
//   `ws5Ack` ACKNOWLEDGED: it only advances on what the server has CONFIRMED. This is the MEMORY
//            of what is actually on the other side.
// Resending means `ws5 := ws5Ack` then an ordinary diff. What goes back out is NEVER the stale
// intent of a dead op, but the CURRENT value of what the server is missing. This is where we
// diverge from Replicache, whose "exactly once" assumes an ordered BATCH send: on a frame-by-frame
// wire, replaying a stale op after a more recent one would let it win.
//
// THE `pong` SAFETY NET DID NOT COVER THIS CASE. It compares the fingerprint announced by the
// server to the previous one, but an op lost ON THE WAY OUT changes nothing on the server. It
// catches a missed INCOMING message, never a lost OUTGOING op. And the full resync it triggered
// ERASED instead of catching up: adoption made the lost change disappear from its author's
// screen, silently.
//
// ---- THE "OLD SERVER" MODE IS NOT A VESTIGE (C-4) -------------------------------------------------
// A server without `acks` leaves ALL of this machinery dormant (`wsAcksOn` false): `wsUnackedPut`
// records nothing, the timer never arms, no resend goes out. Without acknowledgement, a resend on
// the guard delay would republish the entire plan every 2.5 s. This mode is what keeps a tab left
// open from destroying the plan.

import type { Contexte } from "../app/contexte.ts";
import type { Fil } from "./etat.ts";
import type {
  CelluleFil, Id, MeublePartiel, Miroir, MurPartiel, Op, OuvertureFil, OuverturePartielle, Pt,
} from "../partage/plan.ts";
import { ws5DiffOps, wsShadowApplyOpInto, wsShadowCopy, wsShadowFromServerInto } from "./miroir.ts";
import { serialiseursPour, v5StateWire } from "./pseudo-fil.ts";

const WS_PENDING_TTL = 30000;       // beyond this, a refusal will no longer arrive: we forget
const WS_PENDING_MAX = 400;
const WS_UNACKED_MAX = 500;         // bound: see `wsUnackedPut` (nothing is lost on overflow)
export const WS_ACK_RTO = 2500;     // ms without an ack before resending (real round trip < 200 ms)
const WS_ACK_TRIES = 3;             // successive resends without the slightest ack -> the link is dead

// =================================================================================================
//  THE TWO MIRRORS, LAID OVER THE CURRENT STATE OR OVER THE SERVER'S STATE
// =================================================================================================

const serialiseurs = (ctx: Contexte): ReturnType<typeof serialiseursPour> =>
  serialiseursPour(ctx.etat.plan);

/** The wire content for the current LOCAL state. */
export const etatFilCourant = (ctx: Contexte): ReturnType<typeof v5StateWire> =>
  v5StateWire(ctx.etat.plan, !!ctx.etat.setupDone);

function ws5SyncInto(ctx: Contexte, m: Miroir): void {
  const wire = etatFilCourant(ctx);
  m.outline = JSON.stringify(wire.outline);
  m.walls = new Map(); m.openings = new Map(); m.pieces = new Map(); m.cells = new Map();
  wire.walls.forEach((w) => m.walls.set(w.id, JSON.stringify(w)));
  wire.openings.forEach((o) => m.openings.set(o.id, JSON.stringify(o)));
  wire.pieces.forEach((p) => m.pieces.set(p.id, JSON.stringify(p)));
  wire.cells.forEach((c) => m.cells.set(c.id, JSON.stringify(c)));
}

/**
 * (Re)builds the OPTIMISTIC mirror on the current state, WITHOUT emitting any op. The
 * acknowledged one does not move: what we just emitted is not yet on the other side.
 */
export function wsShadowSync(ctx: Contexte, fil: Fil): void { ws5SyncInto(ctx, fil.ws5); }

/** The local state IS the server's (we just adopted it): BOTH mirrors describe it. */
export function wsShadowAdopted(ctx: Contexte, fil: Fil): void {
  ws5SyncInto(ctx, fil.ws5);
  wsShadowCopy(fil.ws5, fil.ws5Ack);
}

/**
 * C-6. The mirror must describe the SERVER, not us. A `hello` WITHOUT adoption (fresh household,
 * or reconnection with an identical fingerprint) used to copy the LOCAL state: the diff would
 * then only emit the local delta, and the shared plan stayed short of everything the server had
 * never received.
 */
export function wsShadowFromServer(ctx: Contexte, fil: Fil, st: unknown): void {
  wsShadowFromServerInto(fil.ws5, st, serialiseurs(ctx));
  wsShadowCopy(fil.ws5, fil.ws5Ack);
}

/**
 * An op RECEIVED from the server advances BOTH mirrors: it is an established fact on the other
 * side. TWO EXCEPTIONS, both ops MANUFACTURED HERE, that the server has never seen:
 *   - the rollback of a refusal (`reverting`): it corrects an optimistic assumption, it reports
 *     nothing from the server. Writing it into the acknowledged mirror would make the value of
 *     ANOTHER op still in flight look confirmed, and that op would then never be resent;
 *   - the replay of unacknowledged ops after reconnection (`rebasing`): these ops go out
 *     precisely BECAUSE the server does not have them; no mirror should record them.
 */
export function wsShadowApplyOp(ctx: Contexte, fil: Fil, op: Op | null | undefined): void {
  if (fil.rebasing) return;
  const w = serialiseurs(ctx);
  wsShadowApplyOpInto(fil.ws5, op, w);
  if (!fil.reverting) wsShadowApplyOpInto(fil.ws5Ack, op, w);
}

// =================================================================================================
//  RAW SENDING
// =================================================================================================

/**
 * Everything that goes out passes through here, ops AND service messages. `outLog` is a TEST
 * PROBE, and the array it returns is LIVE: the `tests/collab-accuses.ts` bench uses it as a
 * client -> server pipe, reading new entries on every pump cycle.
 */
export function wsSend(fil: Fil, obj: unknown): void {
  if (fil.detached) return;
  if (fil.outLog) fil.outLog.push(obj);
  if (fil.ws && fil.wsOpen && fil.ws.readyState === 1) {
    try { fil.ws.send(JSON.stringify(obj)); } catch (_) { /* socket gone: the backoff reconnects */ }
  }
}

// =================================================================================================
//  THE INVERSE OP, COMPUTED BEFORE SENDING (C-11)
// =================================================================================================
// The emitter works by DIFF and marks the value as confirmed right after sending: a refused op is
// never resent. Measured: two screens each showed 33 openings, not the same ones, the server had
// 30, and both announced "live ✓". So, BEFORE sending, we retain the op able to restore the
// entity to what the MIRROR (hence the server) knows.

/**
 * A mirror entry, read back. The mirror only ever contains entities that passed through the
 * `*Wire` functions: their shape is the wire's shape, and that is why they can go back out
 * unchanged inside an op.
 */
function wsShadowGet<T>(map: Map<Id, string>, id: unknown): T | null {
  const v = map.get(String(id));
  if (v === undefined) return null;
  try { return JSON.parse(v) as T; } catch (_) { return null; }
}

/**
 * `[]` = nothing to undo (the server did not know the entity and the op was a deletion).
 * `null` = we do not know how to undo: the caller will request the full state instead.
 */
function wsUndoOpsFor(fil: Fil, op: Op | null | undefined): Op[] | null {
  if (!op || !op.kind) return null;
  switch (op.kind) {
    case "wall.set": {
      const id = String(op.wall && op.wall.id);
      const prev = wsShadowGet<MurPartiel>(fil.ws5.walls, id);
      return prev ? [{ kind: "wall.set", wall: prev }] : [{ kind: "wall.del", wallId: id }];
    }
    case "wall.del": {
      const id = String(op.wallId);
      const prev = wsShadowGet<MurPartiel>(fil.ws5.walls, id);
      const ops: Op[] = prev ? [{ kind: "wall.set", wall: prev }] : [];
      // C-13. The server cascades the wall's openings: the rollback puts ALL of them back.
      fil.ws5.openings.forEach((v) => {
        try {
          const o = JSON.parse(v) as OuvertureFil;
          if (String(o.wallId) === id) ops.push({ kind: "opening.set", opening: o });
        } catch (_) { /* unreadable entry: nothing to put back for this one */ }
      });
      return ops;
    }
    case "opening.set": {
      const id = String(op.opening && op.opening.id);
      const prev = wsShadowGet<OuverturePartielle>(fil.ws5.openings, id);
      return prev ? [{ kind: "opening.set", opening: prev }] : [{ kind: "opening.del", openingId: id }];
    }
    case "opening.del": {
      const prev = wsShadowGet<OuverturePartielle>(fil.ws5.openings, String(op.openingId));
      return prev ? [{ kind: "opening.set", opening: prev }] : [];
    }
    case "piece.set": {
      const id = String(op.piece && op.piece.id);
      const prev = wsShadowGet<MeublePartiel>(fil.ws5.pieces, id);
      return prev ? [{ kind: "piece.set", piece: prev }] : [{ kind: "piece.del", pieceId: id }];
    }
    case "piece.del": {
      const prev = wsShadowGet<MeublePartiel>(fil.ws5.pieces, String(op.pieceId));
      return prev ? [{ kind: "piece.set", piece: prev }] : [];
    }
    case "cell.set":
    case "cells.replace": {
      const cells: CelluleFil[] = [];
      fil.ws5.cells.forEach((v) => { try { cells.push(JSON.parse(v) as CelluleFil); } catch (_) { /* nothing */ } });
      return cells.length ? [{ kind: "cells.replace", cells }] : null;
    }
    case "outline.set": {
      if (!fil.ws5.outline) return null;
      try { return [{ kind: "outline.set", outline: JSON.parse(fil.ws5.outline) as Pt[] }]; }
      catch (_) { return null; }
    }
  }
  return null;
}

// =================================================================================================
//  SEQUENCE NUMBERS, THE UNACKNOWLEDGED QUEUE, THE TIMER
// =================================================================================================

function wsPendingPut(fil: Fil, n: number, e: { t: number; kind: Op["kind"] | undefined; undo: Op[] | null }): void {
  const cut = Date.now() - WS_PENDING_TTL;
  fil.pending.forEach((v, k) => { if (v.t < cut) fil.pending.delete(k); });
  while (fil.pending.size >= WS_PENDING_MAX) fil.pending.delete(fil.pending.keys().next().value as number);
  fil.pending.set(n, e);
}

/**
 * The unacknowledged queue is ONLY A TIMER: it says which ones are waiting and since when. The
 * memory of what has not gone through, on the other hand, is the gap between the local state and
 * `ws5Ack`, and that gap has NO bound to cross. On overflow we therefore drop the oldest entry
 * without losing anything: the next one keeps aging, the guard delay eventually fires, and the
 * resend goes out from the acknowledged mirror, so it also catches up on the one whose timer we
 * dropped.
 */
function wsUnackedPut(ctx: Contexte, fil: Fil, n: number, kind: Op["kind"] | undefined): void {
  while (fil.unacked.size >= WS_UNACKED_MAX) fil.unacked.delete(fil.unacked.keys().next().value as number);
  fil.unacked.set(n, { t: Date.now(), kind });
  wsAckArm(ctx, fil);
}

/** An op has been confirmed by the server (echo of OUR op, or `ack` of a duplicate). */
export function wsAckOp(fil: Fil, n: number | null | undefined): boolean {
  if (n === undefined || n === null) return false;
  fil.ackTries = 0;
  fil.pending.delete(n);              // no refusal will ever arrive for this number now
  return fil.unacked.delete(n);
}

function wsAckArm(ctx: Contexte, fil: Fil): void {
  if (!fil.ackTimer && fil.wsAcksOn) fil.ackTimer = setInterval(() => wsAckTick(ctx, fil), 1000);
}

export function wsAckDisarm(fil: Fil): void {
  if (fil.ackTimer) { clearInterval(fil.ackTimer); fil.ackTimer = null; }
  fil.ackTries = 0;
}

export function wsAckTick(ctx: Contexte, fil: Fil): void {
  if (!fil.unacked.size) { wsAckDisarm(fil); return; }
  if (!fil.wsOpen || !fil.wsAcksOn) return;
  let oldest = Infinity;
  fil.unacked.forEach((e) => { if (e.t < oldest) oldest = e.t; });
  if (Date.now() - oldest < WS_ACK_RTO) return;
  fil.ackTries++;
  // Three resends without the slightest acknowledgement: this is no longer a lost frame, it is a
  // link dead in one direction. We close it; the backoff reconnects, and the `hello` replays
  // whatever is missing.
  if (fil.ackTries >= WS_ACK_TRIES) {
    fil.ackTries = 0;
    try { fil.ws?.close(); } catch (_) { /* already gone */ }
    return;
  }
  wsRetransmit(ctx, fil);
}

/**
 * RESEND. The optimistic mirror drops back onto the acknowledged one, the queue empties out, and
 * an ordinary diff re-emits exactly what the server is missing, AT TODAY'S VALUE.
 * If `wsOnSave` bails out early (a drag in progress, applying a remote op), nothing is lost: the
 * mirror has ALREADY dropped back, so the NEXT `save()` will emit the same thing.
 */
export function wsRetransmit(ctx: Contexte, fil: Fil): void {
  fil.retransmits++;
  wsShadowCopy(fil.ws5Ack, fil.ws5);
  fil.unacked.clear();
  wsOnSave(ctx, fil);
}

// =================================================================================================
//  EMISSION
// =================================================================================================

export function wsSendOp(ctx: Contexte, fil: Fil, op: Op): void {
  if (fil.opLog) fil.opLog.push(op);
  const n = ++fil.opSeq;
  wsPendingPut(fil, n, { t: Date.now(), kind: op && op.kind, undo: wsUndoOpsFor(fil, op) });
  if (fil.wsAcksOn) wsUnackedPut(ctx, fil, n, op && op.kind);
  wsSend(fil, { t: "op", op, n });
}

/**
 * THE DIFF EMITTER. All mutations pass through `save()` -> here: we compare the current state to
 * the optimistic mirror and emit the minimal ops (idempotent upserts / dels). It thus covers ALL
 * mutation points at once: end of drag, inspector, rotation, lock, rename, duplication, deletion,
 * floor, outline, wall drawn / moved / deleted, clearing, import.
 */
function ws5OnSave(ctx: Contexte, fil: Fil): void {
  ws5DiffOps(etatFilCourant(ctx), fil.ws5).forEach((op) => wsSendOp(ctx, fil, op));
  wsShadowSync(ctx, fil);
}

export function wsOnSave(ctx: Contexte, fil: Fil): void {
  // During a furniture drag, ONLY the ephemeral `{t:"drag"}` messages go out: the diff falls
  // silent, and the end of the gesture will emit the final `piece.set`.
  if (!fil.wsOpen || fil.detached || fil.wsSuppress || fil.wsDragActive) return;
  ws5OnSave(ctx, fil);
}

// =================================================================================================
//  THE ATOMIC PUBLICATION OF THE WHOLE PLAN (C-14)
// =================================================================================================
// TWO USES, BOTH VOLUNTARY AND GLOBAL: the "replace" import, and bootstrapping a fresh household
// (end of the wizard, or a `hello` from a server with no plan while this device has one).
// UNDO NO LONGER GOES THROUGH HERE: it publishes by DIFF (C-9), otherwise it would put back a
// whole plan whose snapshot does not know half of it.

export function wsPublishWholePlan(ctx: Contexte, fil: Fil): void {
  if (!fil.wsOpen || fil.detached) return;
  wsSendOp(ctx, fil, { kind: "plan5.replace", plan: etatFilCourant(ctx) });
  wsShadowSync(ctx, fil);
}

export function wsMaybeReplace(ctx: Contexte, fil: Fil): void {
  if (fil.wsSuppress) return;      // applying a remote op: no echo
  wsPublishWholePlan(ctx, fil);
}

/** Throttled: at most one full resync every 5 s, so that no loop can settle in. */
export function wsRequestFullSync(fil: Fil): void {
  const now = Date.now();
  if (now - fil.syncAskedAt < 5000) return;
  fil.syncAskedAt = now;
  wsSend(fil, { t: "sync" });
}

/** What the server has NEVER received: the diff against the ACKNOWLEDGED mirror (C-3, resume). */
export const opsNonAcquittees = (ctx: Contexte, fil: Fil): Op[] =>
  ws5DiffOps(etatFilCourant(ctx), fil.ws5Ack);
