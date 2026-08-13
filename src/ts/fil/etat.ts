// src/ts/fil/etat.ts — ALL THE SYNC LAYER'S MUTABLE STATE, IN A SINGLE OBJECT.
//
// WHY THIS OBJECT EXISTS, AND WHAT IT REPLACES. The old client held these forty variables in its
// single closure, spread across five files (js/41 to js/45) that passed them around without any
// signature ever saying so: `serverRev` was written by js/41 AND by js/44 (`wsOnDown`),
// `syncDetached` was read by js/41, js/42, js/44 and js/55. With real modules, an exported `let`
// cannot be reassigned from the outside; so the state is gathered here, the way `app/contexte.ts`
// does for rendering. The gain is the same: WHO WRITES WHAT is visible in the signature.
//
// WHAT IS NOT HERE: nothing pure. The two-tier mirror and the field-by-field diff live in
// `fil/miroir.ts` (ported in E2, proven by 20,000 seeds with no browser). This object only HOLDS
// the two mirrors; it does not know how to manipulate them.
//
// ---- THE TWO COUNTERS THAT MUST NEVER BE COMPARED (C-2) -----------------------------------------
// `serverRev` counts writes to the D1 ROW and drives the REST poll. `fp` is a CONTENT FINGERPRINT
// announced by the Durable Object. Having confused the two (they were both once called `rev`)
// produced a permanent divergence with two screens both showing "live ✓". The `Fp` type is opaque:
// `fp === String(serverRev)` does not compile. The wire does not even read `opCount`.

import type { Fp, Id, Miroir, Op, OpKind } from "../partage/plan.ts";
import { nouveauMiroir } from "../partage/plan.ts";

/**
 * A peer, as the server announces it. `tag` = the DEVICE, `email` = the PERSON (C-7).
 *
 * Batch 2 (wire identity): `name`/`guest` accompany every peer message now, household and guest
 * alike (a guest recipient never gets `email`/`by` at all: `live-worker/worker.ts` omits the key
 * rather than sending "" — this interface allows it because JSON simply doesn't carry it, not
 * because the value would be falsy). `guestId` exists ONLY for a guest author: it is what
 * `wsSameAccount` compares to tell a guest's OWN other tab from a different guest entirely.
 */
export interface Pair {
  email?: string | undefined;
  by?: string | undefined;
  tag?: string | undefined;
  color?: string | undefined;
  name?: string | undefined;
  guest?: boolean | undefined;
  guestId?: string | undefined;
}

/** A peer cursor being smoothed. `s*` = rendered position, `t*` = target. */
export interface CurseurPair {
  color: string;
  el: HTMLElement;
  ax: number;
  ay: number;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** A remote drag ghost: the position the PEER is currently imposing. */
export interface Fantome {
  x: number;
  y: number;
  rot: number | null;
  color: string;
  expiry: number;
}

/**
 * An EMITTED op, kept for as long as a refusal might still arrive, with the INVERSE op pulled
 * from the mirror BEFORE sending. `undo` is `[]` when the server did not know the entity (nothing
 * to undo) and `null` when we do not know how to undo it (we will request the full state instead).
 */
export interface EnAttente {
  t: number;
  kind: OpKind | undefined;
  undo: Op[] | null;
}

/** The current revision refusal: who wrote before us, when, and on which revision. */
export interface RefusRevision {
  by: string;
  at: string;
  rev: number;
}

/** What the chip can say. NO SIXTH STATE: a revision refusal is not a TRANSPORT state (D-10).
 *  `__ws__` is the only state the collaboration layer sets. */
export type EtatPuce =
  | "ok" | "saving" | "offline" | "slow" | "local" | "unsaved" | "__ws__"
  | { by: string };

export interface Fil {
  // ---- js/39 + js/55: where we have the right to write -------------------------------------------
  /**
   * D-3. The tab has DETACHED from sharing (pre-conversion plan restored). No more op, PUT, or
   * poll goes out from here. Read by everything that emits, across the five modules.
   */
  detached: boolean;

  // ---- js/41: the REST fallback -------------------------------------------------------------------
  /** The D1 revision whose CONTENT this client has. This is the basis of the compare-and-swap (D-9). */
  serverRev: number;
  lastLocalChange: number;
  lastServerBy: string;
  lastServerAt: string;
  pushTimer: ReturnType<typeof setTimeout> | null;
  putInFlight: boolean;
  dirtySincePut: boolean;
  /**
   * D-10. A PUT failed and the change is STILL not in the shared plan. This flag exists because
   * the GET poll, on its own, succeeds every 4 s: without it, every tick would repaint "slow sync"
   * over the failure, and the chip would claim a sync that had not happened.
   */
  putFailed: boolean;
  chipRevertTimer: ReturnType<typeof setTimeout> | null;
  /** True while adopting a remote state: `save()` must not republish it. */
  suppressPush: boolean;
  /**
   * D-8. NOTHING GOES OUT UNTIL THE FIRST READ HAS ANSWERED. The push is debounced by one second
   * and did not wait for the bootstrap GET: a change made early on a slow page would publish what
   * THIS device believed it had, and a device whose local storage is damaged believes it has the
   * default apartment. Lifted by the FIRST read that succeeds, never by a failure.
   */
  bootReconciled: boolean;
  putConflict: RefusRevision | null;
  /**
   * The mirror of what the D1 ROW holds, serialized exactly like the PUT body. Without it, a
   * change pending at the moment of adoption would go out right after and republish the adopted
   * state: the row would advance a revision for nothing, and the neighbor's PUT, which carried
   * the PREVIOUS revision, would be refused with a 409 with no real conflict existing.
   */
  serverMirror: string | null;
  /** D-12. The FIRST adoption recenters the view, later ones do not (they land mid-work). */
  firstAdoptDone: boolean;

  // ---- js/42: transport and emission ------------------------------------------------------------
  ws: WebSocket | null;
  /** Socket OPEN and `hello` received. This is `wsLive()`: the source of truth for the WS / D1
   *  fallback choice. */
  wsOpen: boolean;
  /** C-2. CONTENT fingerprint of the plan held by the real-time server. Never a counter. */
  wsFp: Fp | null;
  /**
   * C-4. Does this server know how to acknowledge receipt (`acks:true` in the `hello`)? IN FRONT
   * OF AN OLDER SERVER, ALL THE RESEND MACHINERY STAYS DORMANT: without acknowledgement, it would
   * republish the whole plan every 2.5 s. This is not a vestige, it is what keeps a tab left open
   * from destroying the plan.
   */
  wsAcksOn: boolean;
  wsReconnectDelay: number;
  wsReconnectTimer: ReturnType<typeof setTimeout> | null;
  /**
   * The identity returned by the `hello`. `tag` = THIS SOCKET, hence THIS device (C-7).
   * `guest`/`guestId` (batch 2): this device's OWN guest fallback identity, if it is one — the
   * "same person" key `wsSameAccount` compares against a peer's `guestId`, since a guest carries
   * no email to compare instead.
   */
  wsMe: { email: string; tag: string | null; color: string; name: string; guest: boolean; guestId: string };
  /** True while applying a remote op: no echo (mirror of `suppressPush`). */
  wsSuppress: boolean;
  /** True during a furniture drag: the diff falls silent, only ephemeral ghosts go out. */
  wsDragActive: boolean;
  opSeq: number;
  pending: Map<number, EnAttente>;
  /** C-3. The queue of ops sent WITHOUT A RESPONSE. It is only a TIMER: the memory of what has not
   *  gone through is the gap between the local state and the ACKNOWLEDGED mirror. */
  unacked: Map<number, { t: number; kind: OpKind | undefined }>;
  ackTimer: ReturnType<typeof setInterval> | null;
  ackTries: number;
  retransmits: number;
  /** The link dropped while ops were waiting: the next `hello` will put this work back. */
  hadUnacked: boolean;
  /** C-3, the OPTIMISTIC mirror: it advances on emission. This is the one the diff compares against. */
  ws5: Miroir;
  /** C-3, the ACKNOWLEDGED mirror: it only advances on what the server has CONFIRMED. */
  ws5Ack: Miroir;
  /** Test probe: log of EVERYTHING that goes out (ops AND service messages). Never in production. */
  outLog: unknown[] | null;
  /** Test probe: log of emitted ops only. */
  opLog: Op[] | null;
  /** Throttling of the full resync: at most one every 5 s, never a loop. */
  syncAskedAt: number;

  // ---- js/43: reception --------------------------------------------------------------------------
  /** We just REFUSED a facade deletion: the wall and its openings must be republished. */
  refusedDel: boolean;
  /** True during the ROLLBACK of an op refused by the server (C-11). */
  reverting: boolean;
  /** True during the REPLAY of unacknowledged ops after a reconnection (C-3). */
  rebasing: boolean;
  /**
   * C-13. THE CASCADE ARRIVES IN TWO STAGES. The diff emitter does not know the server's: when a
   * facade disappears from ITS plan, it sends `wall.del` THEN one `opening.del` per opening
   * (measured: 1 + 6). Refusing the wall without also turning away the follow-up saves nothing.
   * Each identifier is protected ONLY ONCE: the window the other person will VOLUNTARILY delete
   * later will go through.
   */
  keptOpenings: Set<Id>;
  ghostRaf: number;

  // ---- js/44: presence, cursors, chat ------------------------------------------------------------
  /** C-7. Indexed by DEVICE (`tag`), otherwise by email in front of an older server. */
  peers: Map<string, Pair>;
  cursors: Map<string, CurseurPair>;
  ghosts: Map<Id, Fantome>;
  chatUnread: number;
  conflictHandled: boolean;
  errSeen: Map<string, number>;
  lastInbound: number;
  lastRtt: number | null;
  heartbeat: ReturnType<typeof setInterval> | null;
  curPending: { x: number; y: number } | null;
  curRafId: number;
  curRafLoop: number;
  lastDrag: number;

  // ---- js/45: the latency HUD --------------------------------------------------------------------
  curIn: number;
  curOut: number;
  dragOut: number;
  paintLat: { t: number; ms: number }[];
}

export function creerFil(): Fil {
  return {
    detached: false,

    serverRev: -1,
    lastLocalChange: 0,
    lastServerBy: "",
    lastServerAt: "",
    pushTimer: null,
    putInFlight: false,
    dirtySincePut: false,
    putFailed: false,
    chipRevertTimer: null,
    suppressPush: false,
    bootReconciled: false,
    putConflict: null,
    serverMirror: null,
    firstAdoptDone: false,

    ws: null,
    wsOpen: false,
    wsFp: null,
    wsAcksOn: false,
    wsReconnectDelay: 1000,
    wsReconnectTimer: null,
    wsMe: { email: "", tag: null, color: "var(--accent)", name: "", guest: false, guestId: "" },
    wsSuppress: false,
    wsDragActive: false,
    opSeq: 0,
    pending: new Map(),
    unacked: new Map(),
    ackTimer: null,
    ackTries: 0,
    retransmits: 0,
    hadUnacked: false,
    ws5: nouveauMiroir(),
    ws5Ack: nouveauMiroir(),
    outLog: null,
    opLog: null,
    syncAskedAt: 0,

    refusedDel: false,
    reverting: false,
    rebasing: false,
    keptOpenings: new Set(),
    ghostRaf: 0,

    peers: new Map(),
    cursors: new Map(),
    ghosts: new Map(),
    chatUnread: 0,
    conflictHandled: false,
    errSeen: new Map(),
    lastInbound: 0,
    lastRtt: null,
    heartbeat: null,
    curPending: null,
    curRafId: 0,
    curRafLoop: 0,
    lastDrag: 0,

    curIn: 0,
    curOut: 0,
    dragOut: 0,
    paintLat: [],
  };
}

/**
 * IS THE REAL-TIME LINK THE SOURCE? One single read, everywhere: the D1 fallback (PUT, poll)
 * FALLS SILENT when it is true, because it is then the Durable Object that writes the D1 row.
 * A function rather than a field read directly, so that callers name the intent (`wsLive()` in
 * the old client) rather than a boolean whose name says nothing.
 */
export const wsLive = (fil: Fil): boolean => fil.wsOpen;

/**
 * DEVICE key of a relayed message (op, cursor, drag) or of a presence entry. C-7: a server
 * WITHOUT `tag` makes the client fall back to email, exactly as before the fix.
 */
export const wsDevKey = (o: Pair | null | undefined): string =>
  (o && o.tag) ? String(o.tag) : String((o && (o.by || o.email)) || "");

/** Does this message come from THIS socket? By device when the server announces it, otherwise by email. */
export function wsFromMe(fil: Fil, o: Pair | null | undefined): boolean {
  if (!o) return false;
  if (o.tag && fil.wsMe.tag) return String(o.tag) === String(fil.wsMe.tag);
  return String(o.by || o.email || "") === String(fil.wsMe.email || "");
}

/**
 * Is this device an OTHER device of MY account? (outline ring, tooltip, "Other device") — the
 * strongest trust marker in the UI.
 *
 * Design edge 8: BEFORE `guest` existed, every unauthenticated caller shared the SAME fallback
 * identity ("inconnu"), so this comparison silently married every stranger holding a link to "my
 * other device". It FAILED TOWARD TRUST, which is the wrong direction for a marker this strong.
 *
 * If EITHER side is a guest, email is never the arbiter: `email`/`by` compares two ADDRESSES, and
 * a guest carries none (routing it through the empty-string branch is exactly the old bug). The
 * comparison instead runs on `guestId` — a value the GUEST'S OWN BROWSER generated and stores
 * locally (batch 3), read back identically by every tab of that SAME browser profile, and never by
 * anyone else's. Two different guests therefore never match (two different random ids), the same
 * guest's two tabs do (same stored id), and a guest can never match a household member (one side
 * has no `guestId` at all).
 */
export function wsSameAccount(fil: Fil, o: Pair | null | undefined): boolean {
  if (!o || wsFromMe(fil, o)) return false;
  if (o.guest || fil.wsMe.guest) {
    return !!(fil.wsMe.guest && o.guest && fil.wsMe.guestId && String(o.guestId || "") === fil.wsMe.guestId);
  }
  return !!(fil.wsMe.email && String(o.by || o.email || "") === String(fil.wsMe.email));
}
