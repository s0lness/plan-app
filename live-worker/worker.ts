// Live collaboration server for the planner (deployed online, cf. DEPLOY.md).
// One shared room -> one Durable Object (idFromName("main")).
// Behind Cloudflare Access: identity arrives in Cf-Access-Authenticated-User-Email.
// WebSocket Hibernation API: the DO can go to sleep, presence lives in serializeAttachment.

import {
  applyOp, sanitizeState, colorFor, isV5, OpError, sanitizeCursor, sanitizeDrag,
  planFp, strHash, emptyPlan, cleanPlanId, PLAN_ID_DEFAUT,
} from "./ops.ts";
import type { Operation, PlanState } from "./ops.ts";

interface Env {
  DB: D1Database;
  ROOM: DurableObjectNamespace;
  // Optional door allowlist, same contract as functions/porte.ts: comma-separated hostnames,
  // an entry may start with `*.`. ABSENT = trust the header as before (live-worker/test-local.ts
  // has no such variable configured and must stay green).
  HOUSEHOLD_HOSTS?: string;
}

interface SocketAttachment {
  email: string;
  color: string;
  tag: string;
}

interface SequenceEntry {
  vus: Set<number>;
  max: number;
  at: number;
}

interface ChatEntry {
  id: string;
  by: string;
  text: string;
  ts: number;
}

interface D1PlanRow {
  data: string;
  rev: number;
  updated_by: string;
  updated_at?: string;
}

interface OrphanTrace {
  at?: string | null;
  by?: string | null;
  rev?: number | null;
  bytes?: number;
  data?: string | null;
  seenAt?: number;
  told?: string[];
}

interface WireMessage {
  t?: string;
  n?: number;
  op?: Operation;
  text?: string;
  ts?: number;
  room?: string | null;
  pieceId?: string;
  x?: number | null;
  y?: number | null;
  rot?: number | null;
}

// ---- THE SAME DOOR AS functions/porte.ts, applied here too ------------------------------------
// A zone route sends `plan.example.com/ws*` straight to THIS Worker, bypassing Pages Functions
// entirely (docs/decisions/0004-partage-par-lien.md): `functions/_middleware.ts` never sees this
// request, so a choke point living only there misses the most privileged route in the product.
// Kept as an independent copy, not an import from `functions/`: this file is bundled and
// deployed as its own Worker (`live-worker/build-worker.ts`), a separate unit from the Pages
// Functions it happens to share a repository with.
function hoteAutorise(request: Request, env: Env): boolean {
  const hotes = (env.HOUSEHOLD_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  // ABSENT VARIABLE = trust the header, exactly as before this door existed:
  // live-worker/test-local.ts has no such configuration and must stay green.
  if (!hotes.length) return true;
  const hote = (request.headers.get("Host") || "").split(":")[0].trim().toLowerCase();
  return hotes.some((motif) => motif.startsWith("*.")
    ? hote.length > motif.length - 1 && hote.endsWith(motif.slice(1))
    : hote === motif);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") return new Response("not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    // Access has already filtered on the household host; missing header -> "unknown" but we let
    // it through. Off an unrecognized host (HOUSEHOLD_HOSTS declared and not matching) the header
    // is caller-supplied and unsigned, so it is never trusted: force "inconnu" instead.
    // It DOWNGRADES rather than refuses, unlike `functions/_middleware.ts`, which answers 403 on
    // an unrecognized host. The asymmetry is deliberate: this Worker is reachable only through
    // the zone route (its `workers.dev` subdomain is disabled), so an unrecognized host here means
    // a MISCONFIGURED allowlist far more often than an attack, and refusing would take the whole
    // wire down rather than merely lose attribution. The exposed path is the Pages one, and that
    // one fails closed.
    const email = hoteAutorise(request, env)
      ? (request.headers.get("Cf-Access-Authenticated-User-Email") || "inconnu")
      : "inconnu";
    // WHICH plan. A refused identifier is an ERROR, never a silent fallback to `main`: falling
    // back to the household's plan because a URL was malformed would mean editing the wrong
    // document while believing to edit another one.
    const planId = cleanPlanId(url.searchParams.get("p"));
    if (!planId) return new Response("bad plan id", { status: 400 });
    const id = env.ROOM.idFromName(planId);
    const stub = env.ROOM.get(id);
    // We forward the identity AND the plan to the DO via headers on the forwarded request.
    const fwd = new Request(url.toString(), request);
    fwd.headers.set("X-Plan-Email", email);
    fwd.headers.set("X-Plan-Id", planId);
    return stub.fetch(fwd);
  },
};

// Chat history kept, AND sent back in full in the `hello`: the two numbers used to be out of
// sync (200 kept, 50 served), so 150 messages sat in storage without any client ever being able
// to read them.
const CHAT_CAP = 50;
// Maximum serialized size of the plan. Two ceilings drive it, we take the more restrictive one
// with some margin:
//   - the storage of a DO backed by SQLite (our case, new_sqlite_classes) caps key + value at
//     2 MB; the "structured clone" serialization of storage.put() doesn't have exactly the same
//     size as the JSON, hence the margin;
//   - the REST Function (functions/api/plan.ts) refuses beyond 2,000,000 bytes, so a plan
//     accepted here must remain relayable by it.
// The real plan weighs 10 KiB. Beyond the ceiling, the op is refused BEFORE any write.
const MAX_PLAN_BYTES = 1_500_000;
// Debounce of the D1 snapshot, carried by a storage ALARM (see markDirty).
const SNAP_DELAY_MS = 30_000;
// ---- TWO COUNTERS WITH THE SAME NAME IS ONE TOO MANY ------------------------------------------
// There were two `rev` in this system, and they counted UNRELATED things: the Durable Object's
// counted its operations, the D1 row's counts its REST writes. Having compared them by mistake
// produced a permanent divergence, two screens showing "live checkmark".
// The fix at the time (making one start from the other's value) sidestepped the collision
// without lifting the ambiguity. The Durable Object's counter is now called `opCount`, it starts
// from ZERO, it never touches D1's `rev` again, and it only serves to date messages in the logs.
// CONTENT IDENTITY, the only thing that's comparable, is the `fp` fingerprint (planFp).
// Historical storage key, read once so as not to restart from zero after a deploy.
const OPCOUNT_KEY_OLD = "rev";
// ---- ACKNOWLEDGMENT AND DEDUPLICATION BY (tag, n) ----------------------------------------------
// Deduplication memory window: one entry PER LIVE SOCKET, in MEMORY only, never in storage.
// Three reasons:
//   - the key is the device label `tag`, which is unique per SOCKET and dies with it;
//   - persisting a counter per op would double the storage writes of the hottest path;
//   - losing this table (eviction, redeploy) is HARMLESS: ops are idempotent, the worst effect
//     of a missed deduplication is an op applied twice, so nothing.
// It is therefore bounded by the number of sockets, plus a safety margin in case a `close` was missed.
const SEQ_MAX_ENTRIES = 64;
// Window width above the last CONTIGUOUS number. A simple "highest number seen" was not enough:
// under reordering, a legitimate op arriving late would pass for a duplicate and be DROPPED. We
// therefore keep the numbers seen above the contiguous one, up to this width; beyond it, we
// consider the gap final and close the window on the highest one.
const SEQ_WINDOW = 64;

// Will the plan fit into the DO's storage and into D1? Checked BEFORE any write: a mutation
// accepted then rejected by storage.put() used to let the exception escape from
// webSocketMessage, with no error for the client, no persistence, and no echo to peers.
export function planTooBig(plan: PlanState): boolean {
  return JSON.stringify(plan).length > MAX_PLAN_BYTES;
}

// A plan in the OLD format and completely EMPTY carries no data: it's the new plan that an
// earlier version installed for a household without a D1 row, and it doomed that household to
// never share anything (every op from the live client fell into the v4 path). We replace it with
// the new WALLS-ONLY plan. An old plan that contains ANYTHING AT ALL (a room, an envelope) is
// never touched: its conversion belongs to the client, via the plan5.replace op.
export function upgradeEmptyLegacy(plan: PlanState): PlanState {
  if (!plan || typeof plan !== "object") return plan;
  if (isV5(plan)) return plan;
  const vide = Array.isArray(plan.rooms) && plan.rooms.length === 0
    && (plan.envelope === undefined || plan.envelope === null);
  if (!vide) return plan;
  const neuf = emptyPlan();
  neuf.setupDone = !!plan.setupDone;
  return neuf;
}

// COLD load decision, isolated from the Cloudflare runtime to be testable.
// `rowData` = D1's `data` column, or null/undefined if there is NO row at all.
// Three outcomes, deliberately distinct:
//   - "empty": D1 has no row -> legitimate new plan, we can install it and persist it.
//   - "d1"   : row read AND validated -> canonical shape.
//   - "raw"  : row read but REFUSED by the current validator (schema that has moved on) -> we
//              keep the bytes as-is. Better an old state than an empty plan.
// An unreadable row (broken JSON) throws: the DO then refuses to serve, rather than installing
// an empty plan that a first modification would go write over the real row.
export function coldLoad(rowData: unknown): { plan: PlanState; source: string; persist: boolean } {
  if (rowData === null || rowData === undefined) {
    // New plan in the WALLS-ONLY format, never the old one: cf. emptyPlan() in ops.ts. A
    // `{rooms:[]}` used to get 100% of the live client's ops refused on a new household, and the
    // two people each configured their own apartment without ever sharing anything.
    return { plan: emptyPlan(), source: "empty", persist: true };
  }
  if (typeof rowData !== "string") throw new OpError("cold_unreadable");
  let parsed;
  try { parsed = JSON.parse(rowData); } catch (_) { throw new OpError("cold_unparsable"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new OpError("cold_unreadable");
  try {
    return { plan: upgradeEmptyLegacy(sanitizeState(parsed as PlanState)), source: "d1", persist: true };
  } catch (_) {
    // Refused by the current validator: we serve the raw data and take it as-is.
    return { plan: parsed, source: "raw", persist: true };
  }
}

// ---- RECONCILING WITH D1: the REST fallback is no longer a sink -------------------------------
// The Durable Object NEVER reread D1 after its first load. During a Worker outage, the client
// switches to the REST fallback (functions/api/plan.ts): the write succeeds, it travels from one
// screen to another, it does end up in the D1 row — then the Worker comes back, its `hello`
// reimposes the plan it held in memory, the change disappears from both screens, and the
// snapshot alarm overwrites the row. Accept, confirm, then silently destroy.
//
// The discriminant is `updated_by`: the DO NEVER writes anything but 'live', and the REST
// Function NEVER writes 'live' (it sets the Access email, or 'inconnu'). A row that doesn't say
// 'live' is therefore, for sure, a write the DO didn't make. `seen` (fingerprint of the bytes
// already written OR already adopted) guarantees we only process it ONCE.
//
// `dirty` = does the DO have work of its own, not yet snapshotted? The armed alarm IS this flag
// (it is persisted, unlike an instance variable which doesn't survive an eviction).
//   - foreign row + DO at rest    -> "adopt"    : D1 is fresher, the DO has nothing to lose.
//   - foreign row + DO at work    -> "conflict" : both sides wrote without seeing each other. The
//     DO keeps its state (someone is editing on it RIGHT NOW), but it keeps the foreign bytes
//     and TELLS the clients. What is forbidden is destroying them without saying so.
// Merging the two states field by field is NOT done here: the REST fallback writes a COMPLETE
// state, with no reliable common base, and a guessed merge would resurrect deleted entities.
export function d1Verdict(
  row: { data?: string; updated_by?: string; rev?: unknown } | null,
  seen: string | null,
  dirty: boolean,
): { kind: string; why: string; hash?: string } {
  if (!row || typeof row.data !== "string") return { kind: "none", why: "no_row" };
  const hash = strHash(row.data);
  if (row.updated_by === "live") return { kind: "none", why: "own_write", hash };
  if (seen && hash === seen) return { kind: "none", why: "already_seen", hash };
  return { kind: dirty ? "conflict" : "adopt", why: "foreign", hash };
}

export class PlanRoom {
  state: DurableObjectState;
  env: Env;
  storage: DurableObjectStorage;
  loaded: boolean;
  planId: string | null;
  plan: PlanState | null;
  opCount: number;
  chat: ChatEntry[];
  seq: Map<string, SequenceEntry>;
  d1Seen: string | null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.storage = state.storage;
    this.loaded = false;
    // WHICH plan this object holds. `idFromName(planId)` guarantees one object per plan, so this
    // value NEVER changes for a given object. It is persisted because memory doesn't survive
    // hibernation, and an awakened object must know which D1 row is its own BEFORE reading it.
    this.planId = null;
    // plan/opCount/chat are loaded lazily on first access (ensureLoaded).
    this.plan = null;
    // Number of operations applied by THIS Durable Object. Informative: it's not compared to
    // anything, and especially not to the D1 row's `rev` (cf. the block at the top of the file).
    this.opCount = 0;
    this.chat = [];
    // Deduplication: device label -> {hwm, at}. Memory only (cf. SEQ_MAX_ENTRIES).
    this.seq = new Map();
    // Fingerprint of the bytes of the D1 row that this DO last wrote or adopted. Persisted:
    // without this, an eviction would re-adopt the same REST write over and over.
    this.d1Seen = null;
  }

  // Lazy load: DO storage first, otherwise D1, otherwise an empty plan.
  // Shape-agnostic: sanitizeState validates a v4 snapshot ({rooms,envelope}) or a v5 one
  // ({outline,walls,openings,pieces,cells}) alike; applyOp then dispatches on the loaded shape.
  // A NEW household's plan is in v5 (cf. emptyPlan); a household whose D1 row is still in the
  // old format is still served as-is, and switches over explicitly via the plan5.replace op.
  async ensureLoaded() {
    if (this.loaded) return;
    const stored = await this.storage.get(["plan", "opCount", OPCOUNT_KEY_OLD, "chat", "d1seen"]);
    this.d1Seen = (stored.get("d1seen") as string | undefined) || null;
    if (stored.get("plan")) {
      this.plan = stored.get("plan") as PlanState;
      // New key, otherwise the old one (`rev`): a deploy doesn't reset the counter to zero.
      this.opCount = (stored.get("opCount") as number | undefined)
        || (stored.get(OPCOUNT_KEY_OLD) as number | undefined) || 0;
      this.chat = (stored.get("chat") as ChatEntry[] | undefined) || [];
      // The DO snapshot survives deploys: it can therefore contain entities written by an
      // earlier version of the validator (e.g. openings whose `side` is still packed into
      // `hinge`). We run it back through sanitizeState on wake-up so the database converges at
      // once to the canonical shape, instead of staying mixed until the next write of each
      // entity. On refusal we KEEP the raw plan: better an old state than an empty plan.
      try { this.plan = sanitizeState(this.plan); } catch (_) { /* keep the raw one */ }
      // A DO created BEFORE the fix keeps the new plan in the old format in its storage: it must
      // be caught up on wake-up, otherwise that household stays doomed to share nothing.
      this.plan = upgradeEmptyLegacy(this.plan);
      // Partial v5 snapshot (old write): we guarantee the 4 lists.
      if (isV5(this.plan)) {
        for (const k of ["walls", "openings", "pieces", "cells"] as ("walls" | "openings" | "pieces" | "cells")[]) {
          if (!Array.isArray(this.plan[k])) this.plan[k] = [];
        }
        if (this.plan.outline === undefined) this.plan.outline = null;
      }
    } else {
      // First wake-up: we read D1. A read FAILURE is NOT an empty plan: we let the exception
      // escape, the WebSocket upgrade fails and the client retries via its backoff.
      // Previously everything was swallowed by a silent catch, an empty plan was installed THEN
      // persisted, and the first modification overwrote the real D1 row: total loss.
      const row = await this.env.DB
        .prepare("SELECT data, rev, updated_by FROM plans WHERE id=?1")
        .bind(this.planId || PLAN_ID_DEFAUT)
        .first<D1PlanRow>();
      const cold = coldLoad(row && row.data !== undefined ? row.data : null);
      this.plan = cold.plan;
      // The op counter STARTS FROM ZERO. It used to start from the D1 row's `rev`, so the two
      // counters wouldn't sweep through the same small integers and wouldn't coincide by accident
      // for a client comparing them. That band-aid no longer has a reason to exist: no one
      // compares them anymore, they no longer share a name, and the authoritative identity is `fp`.
      // Reading D1's `rev` to make it ours was the LAST place where the two touched each other.
      this.opCount = 0;
      this.chat = [];
      this.d1Seen = row && typeof row.data === "string" ? strHash(row.data) : null;
      if (cold.persist) {
        await this.storage.put({ plan: this.plan, opCount: this.opCount, chat: this.chat, d1seen: this.d1Seen });
      }
    }
    this.loaded = true;
  }

  // Rereads the D1 row and applies the verdict (cf. d1Verdict). Called at the ONLY moments where
  // the DO could otherwise destroy a write it hasn't seen:
  //   - when the room REPOPULATES after being empty (end of a REST fallback period);
  //   - before ANY snapshot (alarm, and flush on the last departure).
  // `dirty`: see d1Verdict. Returns the verdict, for tests and for the log.
  async reconcileD1(dirty: boolean) {
    const row = await this.env.DB
      .prepare("SELECT data, rev, updated_by, updated_at FROM plans WHERE id=?1")
      .bind(this.planId || PLAN_ID_DEFAUT)
      .first<D1PlanRow>();
    const v = d1Verdict(row, this.d1Seen, dirty);
    if (v.kind === "none") return v;

    if (v.kind === "adopt") {
      // Same policy as on cold load: an unreadable row never replaces a live plan. coldLoad
      // throws on broken JSON -> we keep what we have and report nothing more.
      let cold;
      try { cold = coldLoad(row.data); } catch (_) { this.d1Seen = v.hash; await this.storage.put("d1seen", v.hash); return { kind: "none", why: "unreadable" }; }
      this.plan = cold.plan;
      this.opCount++;                   // the state changed: clients must notice
      this.d1Seen = v.hash;
      // No markDirty: the D1 row ALREADY IS this plan, a snapshot would only rewrite the same
      // bytes. We only persist the DO's storage.
      await this.storage.put({ plan: this.plan, opCount: this.opCount, d1seen: this.d1Seen });
      this.broadcast({ t: "state", state: this.plan, opCount: this.opCount, fp: planFp(this.plan), reason: "d1_adopt" }, null);
      return v;
    }

    // CONFLICT: both sides worked. The DO keeps its state (it has live sockets), but the foreign
    // bytes are KEPT and the clients are told. A plan really weighs 10 KiB; we only refuse to
    // store beyond the ceiling (a SQLite DO's storage caps at 2 MB per key), in which case we
    // keep the trace without the bytes.
    const trace = {
      at: row.updated_at || null, by: row.updated_by || null, rev: row.rev ?? null,
      bytes: row.data.length, data: null as string | null, seenAt: Date.now(),
      // Who has ALREADY been told. The one who wrote offline is, by construction, the one who is
      // NOT connected at the moment of the conflict: without this list they would never learn of
      // it. They will be told when they come back, in their `hello`, and only once.
      told: [] as string[],
    };
    let keepBytes = row.data.length <= MAX_PLAN_BYTES;
    if (keepBytes) {
      // If storage refuses the bytes, we fall back to the TRACE alone rather than letting the
      // exception block the alarm (and therefore every subsequent snapshot). Telling without
      // keeping is better than doing nothing at all.
      try { await this.storage.put("orphan", { ...trace, data: row.data }); }
      catch (_) { keepBytes = false; await this.storage.put("orphan", trace); }
    } else {
      await this.storage.put("orphan", trace);
    }
    this.d1Seen = v.hash;               // a single announcement per foreign write
    await this.storage.put("d1seen", this.d1Seen);
    // Those present are told right away; we note who, so as not to catch them again in the `hello`.
    const vus = [...new Set(this.state.getWebSockets().map((s) => this.attOf(s).email))];
    if (vus.length) {
      const o = await this.storage.get<OrphanTrace>("orphan");
      if (o) await this.storage.put("orphan", { ...o, told: vus });
    }
    this.broadcast(this.conflictMsg({ ...trace, data: keepBytes ? "…" : null }), null);
    return v;
  }

  // Conflict message, built from a single place (reconciliation AND the `hello` on return).
  conflictMsg(o: { by?: string | null; at?: string | null; bytes?: number; data?: unknown }) {
    return {
      t: "conflict", by: o.by || null, at: o.at || null,
      bytes: o.bytes || 0, kept: o.data ? "server" : "none",
    };
  }

  /**
   * WHICH plan this object holds. Called before ANY D1 access.
   *
   * `idFromName(planId)` guarantees one object per plan: the value therefore never changes for a
   * given object, and a disagreement between the header and what is stored would be a ROUTING
   * BUG, not a legitimate change. We then keep the STORED value: it designates the D1 row that
   * this object has already read and maybe already written, and making it switch rows mid-life
   * would overwrite another plan with this document.
   */
  async adoptPlanId(fromHeader: string | null) {
    if (this.planId) return;
    const stocke = await this.storage.get<string>("planId");
    if (stocke) { this.planId = stocke; return; }
    const id = cleanPlanId(fromHeader);
    this.planId = id || PLAN_ID_DEFAUT;
    await this.storage.put("planId", this.planId);
  }

  async fetch(request: Request): Promise<Response> {
    await this.adoptPlanId(request.headers.get("X-Plan-Id"));
    await this.ensureLoaded();
    // The room was EMPTY: no one was in realtime, so everyone was on the REST fallback. This is
    // the exact moment when D1 can be ahead of us. Tolerant: if D1 doesn't answer, we serve
    // anyway (the REST fallback is dead anyway, better the live one) and the next reconciliation,
    // before the snapshot, will catch up on the foreign write.
    if (this.state.getWebSockets().length === 0) {
      try { await this.reconcileD1(await this.storage.getAlarm() !== null); } catch (_) { /* serve anyway */ }
    }
    const email = request.headers.get("X-Plan-Email") || "inconnu";
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Hibernation: the DO manages the socket via webSocketMessage/Close.
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ email, color: colorFor(email), tag: this.freshTag() });
    return new Response(null, { status: 101, webSocket: client });
  }

  // Device label, unique among LIVE sockets, stable for the duration of the socket. It's used by
  // the client to build entity identifiers that cannot collide: two people drawing a partition
  // at the same moment would both number from THEIR local plan (v5NewId), get the same "w20",
  // and the second wall would overwrite the first — no error, no banner, both screens converging
  // on the survivor.
  // Two tabs of the same person receive two different labels: the email alone would not be enough.
  freshTag() {
    const used = new Set();
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as SocketAttachment | null;
      if (a && a.tag) used.add(a.tag);
    }
    let tag;
    do { tag = crypto.randomUUID().replace(/-/g, "").slice(0, 6); } while (used.has(tag));
    return tag;
  }

  // ---- presence ----
  attOf(ws: WebSocket): SocketAttachment {
    return (ws.deserializeAttachment() as SocketAttachment | null)
      || { email: "inconnu", color: colorFor("inconnu"), tag: "000000" };
  }

  // ---- TECHNICAL IDENTITY IS THE DEVICE, NOT THE EMAIL ADDRESS -----------------------------------
  // The household has two accounts, but ONE person has several devices (the computer on the
  // table, the phone in the apartment), both behind the same Access identity. The server already
  // assigned a unique device label per SOCKET (freshTag) but only broadcast it in the `hello`: on
  // the client, everything was decided on `by === my email`, so the second device of the same
  // person was mistaken for ONESELF. Measured consequences: its ops didn't enter the replay log
  // (a Ctrl+Z destroyed its work on both screens AND on the server), and neither its badge, nor
  // its cursor, nor its drag ghosts appeared.
  // `tag` therefore accompanies EVERYTHING that is relayed: presence, ops, cursors, ghosts.
  // An OLD client simply ignores the extra key.
  peers() {
    return this.state.getWebSockets().map((ws) => {
      const a = this.attOf(ws);
      return { email: a.email, color: a.color, tag: a.tag || null };
    });
  }

  broadcast(obj: object, exclude: WebSocket | null) {
    const s = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      if (ws === exclude) continue;
      try { ws.send(s); } catch (_) { /* dead socket, close will come */ }
    }
  }

  send(ws: WebSocket, obj: object) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }

  // ---- D1 snapshot (30 s debounce, carried by a storage ALARM) ----
  // A setTimeout does NOT survive the Durable Object's eviction: under the Hibernation API,
  // sockets stay open while the object leaves memory, and on wake-up the constructor starts from
  // scratch. The pending snapshot then vanished without a trace.
  // The alarm, on the other hand, is a STORAGE operation: it is persisted, it wakes up an
  // inactive object (the constructor is called before alarm()), it is guaranteed at least once
  // and replayed with exponential backoff if alarm() throws. Only one slot per DO, hence getAlarm().
  // Verified on developers.cloudflare.com/durable-objects/api/alarms (fetched as .md) and on
  // .../best-practices/websockets ("Clients remain connected while the Durable Object is not
  // in memory"). Alarms also work on a SQLite namespace (new_sqlite_classes).
  // The alarm IS the "dirty" flag: it is persisted, so unlike `this.dirty` it survives an
  // eviction. An armed alarm = a D1 snapshot due.
  async markDirty() {
    if (await this.storage.getAlarm() === null) {
      await this.storage.setAlarm(Date.now() + SNAP_DELAY_MS);
    }
  }

  // Alarm handler: unconditionally rewrites the current state to D1. No in-memory flag is
  // consulted (they don't survive an eviction); the write is idempotent.
  // Alarm handler: the alarm has already been consumed by the runtime, so by construction the DO
  // has unsnapshotted work (dirty = true). We RECONCILE before writing: without this, the
  // snapshot silently overwrites everything the REST fallback deposited during the outage.
  async alarm() {
    await this.ensureLoaded();
    await this.reconcileD1(true);
    await this.snapshot();
  }

  async snapshot() {
    const data = JSON.stringify(this.plan);
    const now = new Date().toISOString();
    // A D1 error propagates up: the alarm will be replayed automatically (up to 6 times).
    await this.env.DB
      .prepare(
        "INSERT INTO plans(id,data,rev,updated_at,updated_by) VALUES(?4,?1,1,?2,'live') " +
        "ON CONFLICT(id) DO UPDATE SET data=?1, rev=rev+1, updated_at=?2, updated_by='live'"
      )
      .bind(data, now, null, this.planId || PLAN_ID_DEFAUT)
      .run();
    // We now know what the row looks like: the next reconciliation won't mistake it for a
    // foreign write (belt-and-suspenders, `updated_by='live'` already says so).
    this.d1Seen = strHash(data);
    await this.storage.put("d1seen", this.d1Seen);
  }

  // The alarm is armed BEFORE the write: if `put` fails, the caller can roll back without
  // leaving storage ahead of memory, and the extra alarm will only produce a D1 snapshot of the
  // current state (idempotent). The reverse order would open a divergence if setAlarm threw
  // after a successful put.
  async persistPlan() {
    await this.markDirty();
    await this.storage.put({ plan: this.plan, opCount: this.opCount });
  }

  // ---- PER-DEVICE SEQUENCE: acknowledging, deduplicating, flagging a gap -------------------------
  // Deduplication entry of a socket. `vus` = the numbers ACTUALLY processed (accepted or refused:
  // in both cases the client got its response), kept over a sliding window.
  // `max` = the highest number seen, used to spot a gap.
  //
  // Why a set and not a simple "highest number seen": under reordering, a legitimate op arriving
  // late would pass for a duplicate and be DROPPED. And why not a "last contiguous number"
  // either: an unknown `tag` would then have to DECLARE that everything below has been seen,
  // which is false as soon as the very first frame of a socket is lost.
  // So we claim nothing: we only know what we've seen go by.
  seqOf(tag: string, n: number): SequenceEntry {
    let e = this.seq.get(tag);
    if (!e) {
      // Safety bound: a missed `close` must not make the table grow indefinitely.
      while (this.seq.size >= SEQ_MAX_ENTRIES) this.seq.delete(this.seq.keys().next().value);
      e = { vus: new Set(), max: n - 1, at: Date.now() };
      this.seq.set(tag, e);
    }
    e.at = Date.now();
    return e;
  }
  // Has this number already been processed?
  seqVu(e: SequenceEntry, n: number) { return e.vus.has(n); }
  // The number has just been processed. The window slides: beyond SEQ_WINDOW numbers, the oldest
  // one drops out. The worst effect of falling out of the window is reapplying an op 64 sends
  // old, so nothing (ops are idempotent, and the client never re-emits an op as-is).
  seqNote(e: SequenceEntry, n: number) {
    if (n > e.max) e.max = n;
    e.vus.add(n);
    while (e.vus.size > SEQ_WINDOW) e.vus.delete(e.vus.values().next().value);
  }

  // ---- Hibernation handlers ----
  async webSocketMessage(ws: WebSocket, raw: string) {
    await this.ensureLoaded();
    let msg: WireMessage;
    try { msg = JSON.parse(raw); } catch { return this.send(ws, { t: "err", reason: "bad_json" }); }
    const att = this.attOf(ws);

    switch (msg && msg.t) {
      case "hello": {
        this.send(ws, {
          t: "hello",
          // `tag`: device label unique among live sockets (cf. freshTag).
          you: { email: att.email, color: att.color, tag: att.tag || null },
          peers: this.peers(),
          state: this.plan,
          // `opCount` replaces the old `rev`: it's THIS Durable Object's op counter, it is purely
          // INFORMATIVE and is not compared to anything (especially not to the D1 row's `rev`,
          // which the client reads at startup via the REST fallback). `fp` is the content
          // identity, the only thing to compare (cf. planFp). No client reads this number; it
          // stays for the logs.
          opCount: this.opCount,
          fp: planFp(this.plan),
          // CAPABILITY ANNOUNCEMENT: this server acknowledges receipt of ops by their number (`n`
          // in the echo, `ack` message for a duplicate, `gap` message when a number is missing).
          // An up-to-date client only arms its re-emission IF it sees this flag: facing an older
          // server, it behaves exactly as before, without re-emitting anything into the void.
          acks: true,
          chat: this.chat.slice(-CHAT_CAP),
        });
        // The others learn about the newcomer.
        this.broadcast({ t: "peer", peers: this.peers() }, ws);
        // A write made offline couldn't be merged while this person was away? It's THEM who lost
        // work, and they weren't there to hear about it. We tell them when they come back, only
        // once (the `told` list remembers who has already been notified).
        const orphan = await this.storage.get<OrphanTrace>("orphan");
        if (orphan && !(orphan.told || []).includes(att.email)) {
          this.send(ws, this.conflictMsg(orphan));
          await this.storage.put("orphan", { ...orphan, told: [...(orphan.told || []), att.email] });
        }
        break;
      }

      case "op": {
        // TRANSACTION: the op is applied to a COPY. The shared plan is only replaced once the op
        // is accepted AND the size checked; if persistence fails we roll back and tell the
        // client, instead of leaving a live but unpersisted mutation that peers would never hear about.
        //
        // ---- A REFUSAL NOW SAYS *WHICH ONE* -----------------------------------------------------
        // The client emits by DIFF and marks the value as acquired right after sending it: a
        // refused op was never re-emitted, the screen kept the change, the badge stayed "live
        // checkmark", and the two devices diverged permanently without anything saying so.
        // The client therefore numbers its ops (`n`, an increasing integer, private to its
        // socket) and the refusal returns that number: it knows exactly which change to undo. An
        // OLD client doesn't send `n`; we then return `n:null` and it falls back to a full
        // resync. `seq` never leaves the socket that emitted it, it is never persisted.
        //
        // ---- AND IT NOW ACKNOWLEDGES *THE ONES THAT GO THROUGH* --------------------------------
        // Without an ack, an op lost in transit was only caught by the `pong`'s fingerprint
        // comparison, up to 10 s later, and that re-read ADOPTS the server state: the lost change
        // was not caught up, it was ERASED. The op echo therefore now carries its number `n`:
        // paired with `tag` (the device), it tells the author "that one arrived". Three cases,
        // three responses, never silence:
        //   - number already processed -> {t:"ack"}   (duplicate: nothing is reapplied, but we acknowledge)
        //   - expected number          -> the ordinary echo, which carries `n`
        //   - number ahead             -> the echo, PLUS {t:"gap"}: a number is missing, re-emit
        const seq = Number.isSafeInteger(msg.n) ? msg.n : null;
        const tag = att.tag || null;
        const sq = (tag && seq !== null) ? this.seqOf(tag, seq) : null;
        if (sq && this.seqVu(sq, seq)) {
          // ALREADY PROCESSED. We apply nothing (it would have no effect, ops are idempotent, but
          // it would be an `opCount` and a broadcast for nothing) and we acknowledge, otherwise
          // the author would think their change was lost and would re-emit it endlessly.
          return this.send(ws, { t: "ack", n: seq, tag, opCount: this.opCount, fp: planFp(this.plan), dup: true });
        }
        // A GAP IS MEASURED ON THE HIGHEST NUMBER ALREADY SEEN, not on the last contiguous one.
        // On the contiguous one, a gap never filled would mask all the following ones: every new
        // loss must be announced once, and only once.
        const gapNeed = (sq && seq > sq.max + 1) ? sq.max + 1 : null;
        // The number is CONSUMED as soon as the server has processed it, refusal included: in
        // both cases the client got its response (the echo or the `err`), so it won't re-emit it.
        if (sq) this.seqNote(sq, seq);
        const before = this.plan;
        let next;
        try {
          next = applyOp(structuredClone(this.plan), msg.op);
        } catch (e) {
          const reason = e instanceof OpError ? e.reason : "op_fail";
          return this.send(ws, { t: "err", reason, n: seq, kind: (msg.op && msg.op.kind) || null });
        }
        if (planTooBig(next)) {
          return this.send(ws, { t: "err", reason: "too_big", n: seq, kind: (msg.op && msg.op.kind) || null });
        }
        this.plan = next;
        this.opCount++;
        try {
          await this.persistPlan();
        } catch (_) {
          this.plan = before;
          this.opCount--;
          return this.send(ws, { t: "err", reason: "persist_fail", n: seq, kind: (msg.op && msg.op.kind) || null });
        }
        // Echo to EVERYONE (sender included): ops are idempotent, it consumes the op.
        // `fp` accompanies every echo: this way the client knows, without recomputing anything,
        // which content identity the server holds after this op, and a later `hello` that
        // doesn't carry the same fingerprint tells it that it missed something.
        // `tag` = the author device. It is THIS that the client compares to decide whether the op
        // is its own (undo replay log), not the email: two devices of the same person carry the
        // same email and different labels.
        // `n` = the author's number. THE ECHO IS THE ACK: the message already existed, it already
        // goes to the author, it already carries the plan's fingerprint AFTER the op. A separate
        // ack message would have doubled the traffic to say something the echo establishes
        // better (it proves not only receipt, but APPLICATION). Peers, for their part, ignore a
        // number that isn't theirs: they compare `tag` to their own, exactly as for the undo
        // replay log.
        this.broadcast({ t: "op", op: msg.op, by: att.email, tag: att.tag || null, n: seq,
          opCount: this.opCount, fp: planFp(this.plan) }, null);
        // A NUMBER IS MISSING. The op that just went through wasn't the expected next one: an op
        // from this device was lost in transit. We tell it right away rather than letting it wait
        // for its own guard delay: it will re-emit what's missing, at its CURRENT value.
        // The client responds to a `gap` with a COMPLETE re-emission of what it's missing (diff
        // against its acknowledged mirror): a single message is enough to cover several losses at once.
        if (gapNeed !== null) this.send(ws, { t: "gap", tag, need: gapNeed, n: seq });
        break;
      }

      case "sync": {
        // The client knows (or believes) it's out of sync: it re-requests the complete state
        // without closing the socket, so without losing presence, cursors and chat.
        this.send(ws, { t: "state", state: this.plan, opCount: this.opCount, fp: planFp(this.plan), reason: "sync" });
        break;
      }

      case "cursor": {
        // Ephemeral, not persisted. room:null = cursor off canvas.
        // Relayed as-is to the other tab: therefore validated, cf. sanitizeCursor.
        const c = sanitizeCursor(msg);
        if (!c) break;
        this.broadcast({
          t: "cursor", by: att.email, tag: att.tag || null, color: att.color,
          room: c.room, x: c.x, y: c.y,
        }, ws);
        break;
      }

      case "drag": {
        // Preview ghost, ephemeral (the final position follows in piece.set).
        // `pieceId` ends up in a CSS selector on the peer's side: validated, cf. sanitizeDrag.
        const d = sanitizeDrag(msg);
        if (!d) break;
        this.broadcast({
          t: "drag", by: att.email, tag: att.tag || null, color: att.color,
          room: d.room, pieceId: d.pieceId, x: d.x, y: d.y, rot: d.rot,
        }, ws);
        break;
      }

      case "chat": {
        const text = String(msg.text ?? "").slice(0, 500).trim();
        if (!text) return;
        const entry = { id: crypto.randomUUID(), by: att.email, text, ts: Date.now() };
        this.chat.push(entry);
        if (this.chat.length > CHAT_CAP) this.chat = this.chat.slice(-CHAT_CAP);
        await this.storage.put("chat", this.chat);
        this.broadcast({ t: "chat", msg: entry }, null);
        break;
      }

      case "ping": {
        // Client heartbeat: we send back the timestamp for the round trip (HUD ?rt=1). No storage access.
        // It also carries the current fingerprint: the client therefore has, every 10 s and
        // without a single byte of extra traffic, what it needs to notice it missed a message and
        // request a `sync`.
        this.send(ws, { t: "pong", ts: msg.ts, fp: planFp(this.plan) });
        break;
      }

      default:
        this.send(ws, { t: "err", reason: "unknown_t" });
    }
  }

  async webSocketClose(ws: WebSocket) {
    try { ws.close(); } catch (_) {}
    // The deduplication window dies with the socket: it's indexed by the device label, which is
    // unique per socket and never reused. Nothing to purge later.
    const att = this.attOf(ws);
    if (att && att.tag) this.seq.delete(att.tag);
    const remaining = this.state.getWebSockets().filter((s) => s !== ws);
    this.broadcast({ t: "peer", peers: remaining.map((s) => {
      const a = this.attOf(s);
      return { email: a.email, color: a.color, tag: a.tag || null };
    }) }, ws);
    // Last departure: immediate flush to D1 if a snapshot is due (alarm armed), then disarming.
    // If the flush fails, we LEAVE the alarm: it will replay the snapshot.
    if (remaining.length === 0) {
      try {
        if (await this.storage.getAlarm() !== null) {
          await this.ensureLoaded();
          await this.reconcileD1(true);   // never overwrite a REST write without saying so
          await this.snapshot();
          await this.storage.deleteAlarm();
        }
      } catch (_) { /* the alarm stays armed and will retry */ }
    }
  }

  async webSocketError(ws: WebSocket) {
    try { ws.close(); } catch (_) {}
  }
}
