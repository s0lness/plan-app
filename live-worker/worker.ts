// Live collaboration server for the planner (deployed online, cf. DEPLOY.md).
// One shared room -> one Durable Object (idFromName("main")).
// Behind Cloudflare Access: identity arrives in Cf-Access-Authenticated-User-Email.
// WebSocket Hibernation API: the DO can go to sleep, presence lives in serializeAttachment.

import {
  applyOp, opWire, sanitizeState, colorFor, isV5, OpError, sanitizeCursor, sanitizeDrag,
  planFp, strHash, emptyPlan, cleanPlanId, cleanGuestName, nameFromEmail,
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

// ---- SOCKET IDENTITY (batch 2, wire identity) ---------------------------------------------------
// `email` is the HOUSEHOLD identity (Access-proven, "inconnu" when unresolvable); `guest` +
// `guestId` + `token` exist ONLY for the guest door and are always "" / false for a household
// socket. `name` is the one field BOTH sides can carry: a guest's self-declared label, or (once a
// household member also sets one through `{t:"name"}`) a chosen label instead of an email-derived
// one. `token` is the raw invite token: it is what `/revoke` matches sockets against (edge 6) and
// what the per-socket rate cap is keyed on (edge 15) — NOT a credential in its own right here (the
// socket is already open), just the label that ties a live connection back to the invite row that
// let it in.
interface SocketAttachment {
  email: string;
  color: string;
  tag: string;
  name: string;
  guest: boolean;
  guestId: string;
  token: string;
  // WHICH plan this socket was opened on. Carried in the ATTACHMENT because an attachment
  // survives hibernation and eviction: an object woken by `webSocketMessage` on a socket opened
  // before the eviction can read back the row that is its own even if nothing else remains.
  planId: string;
  // When this GUEST's invite stops being valid, in milliseconds since the epoch. 0 = unknown, so
  // nothing is checked (a household socket, or a forwarder that predates `X-Plan-Expires`).
  expiresAt: number;
}

// Same shape as functions/ws.ts's `?g=` cleaning: a guest's OWN second tab identifier, not a
// credential, grants nothing. Re-validated here too (defence in depth: this Worker trusts nothing
// forwarded to it without re-checking, the same way functions/api/invites.ts re-checks `porteDe()`
// even though `_middleware.ts` already gated the request).
const GUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Builds a socket's attachment from the headers `functions/ws.ts` sets (ALWAYS set, never
 * conditionally — see its header note — so a caller cannot forge `X-Plan-Guest`/`X-Plan-Name`/
 * `X-Plan-Guest-Id`/`X-Plan-Token` by sending its own copy). Pulled out of `PlanRoom.fetch` as a
 * PURE function of `(request, tag)` so it is testable under plain node without a real
 * `WebSocketPair` (which `fetch` itself needs and node does not provide).
 *
 * `??` NOT `||` ON EMAIL: a guest's `X-Plan-Email` is the EXPLICIT empty string ("there is no
 * email to have"), which `||` would silently coerce back into the literal "inconnu" — a real
 * value with its OWN meaning ("household door, but Access gave us no header"). `??` only falls
 * back when the header is truly ABSENT (an older forwarder, or a test double that never set it).
 */
export function attachmentFromRequest(request: Request, tag: string): SocketAttachment {
  const email = request.headers.get("X-Plan-Email") ?? "inconnu";
  const guest = request.headers.get("X-Plan-Guest") === "1";
  const name = cleanGuestName(request.headers.get("X-Plan-Name") || "");
  const guestIdRaw = (request.headers.get("X-Plan-Guest-Id") || "").trim();
  const guestId = GUEST_ID_RE.test(guestIdRaw) ? guestIdRaw : "";
  const token = String(request.headers.get("X-Plan-Token") || "").trim().slice(0, 128);
  // Colour for a guest is derived from something the GUEST chose or generated (name, then their
  // own device id, then the fresh socket tag as a last resort) instead of the email: there is no
  // email, and `colorFor("")` would hand every unnamed guest the SAME hue.
  const color = guest ? colorFor(name || guestId || tag) : colorFor(email);
  // `X-Plan-Id` is set by `functions/ws.ts` (and by the dormant `fetch` below) on EVERY upgrade.
  // ABSENT or malformed leaves "" ("this socket does not know"), never the household's `main`:
  // a fallback here would be a silent licence to write into somebody else's row.
  const idBrut = request.headers.get("X-Plan-Id");
  const planId = idBrut === null ? "" : (cleanPlanId(idBrut) || "");
  return { email, color, tag, name, guest, guestId, token, planId, expiresAt: expiresFromHeader(request) };
}

/**
 * `X-Plan-Expires`: when this socket's invite stops being valid. Accepts the ISO 8601 form the
 * `invites.expires_at` column holds (what `functions/ws.ts` has at hand) and a plain millisecond
 * epoch. ABSENT or unreadable answers 0, which means "do not check": a socket opened by a
 * forwarder that predates this header must keep working exactly as before, and a household socket
 * has no expiry to have.
 */
function expiresFromHeader(request: Request): number {
  const brut = (request.headers.get("X-Plan-Expires") || "").trim();
  if (!brut) return 0;
  const ms = /^[0-9]+$/.test(brut) ? Number(brut) : Date.parse(brut);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

interface SequenceEntry {
  vus: Set<number>;
  max: number;
  at: number;
}

interface ChatEntry {
  id: string;
  by: string;
  // Author's display name and guest flag AT THE TIME OF SENDING (design edge 19: `chat` needs
  // `name`/`guest` too). Stored so a REPLAYED history (`hello.chat`) can still be redacted for a
  // later guest recipient without recomputing anything from `by` beyond the email-derivation
  // fallback in `chatWire` (for entries written before this field existed, `name` is "").
  name: string;
  guest: boolean;
  text: string;
  ts: number;
}

interface D1PlanRow {
  data: string;
  rev: number;
  updated_by: string;
  updated_at?: string;
}

// A version set aside because two sides wrote without seeing each other. `told` lists the DEVICE
// LABELS already warned (never emails: a guest has none, so one guest told made every guest look
// told).
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
  name?: string;
  /** Cursor chat ("/"): see `CursorMessage.say` in `ops.ts`. */
  say?: string | null;
}

// ---- THE SAME DOOR AS functions/porte.ts, applied here too ------------------------------------
// A DOOR IN WAITING, and that is the point. Today `/ws` is served by Pages
// (`functions/ws.ts` forwards through the `ROOM` binding), so `functions/_middleware.ts` covers
// it and this `fetch` is not reachable from outside: the `workers.dev` subdomain is disabled.
// But `live-worker/DEPLOY.md` §2 describes a zone route that would send `/ws*` straight HERE and
// take precedence over Pages, and that document is a procedure someone may yet run. The day it
// is run, this function becomes the front door of the most privileged route in the product,
// reading a caller-supplied identity header with no middleware in front of it.
// See docs/decisions/0004-partage-par-lien.md.
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
    // an unrecognized host. The asymmetry is deliberate: this handler is not reachable from
    // outside today, so an unrecognized host here means a MISCONFIGURED allowlist far more often
    // than an attack, and refusing would take the whole wire down rather than merely lose
    // attribution. The exposed path is the Pages one, and that one fails closed.
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
    // `new Request(url, request)` COPIES every header of the original request, guest-related ones
    // included: this dormant path has no concept of a guest door (`hoteAutorise` only knows
    // `HOUSEHOLD_HOSTS`), so every one of them is FORCED, not merely defaulted, the same way
    // `X-Plan-Email` already is above — a caller cannot present as a guest, or carry the internal
    // `/revoke` marker (see `INTERNAL_HEADER`, never legitimate on a `/ws` request), through here.
    const fwd = new Request(url.toString(), request);
    fwd.headers.set("X-Plan-Email", email);
    fwd.headers.set("X-Plan-Id", planId);
    fwd.headers.set("X-Plan-Guest", "0");
    fwd.headers.set("X-Plan-Name", "");
    fwd.headers.set("X-Plan-Guest-Id", "");
    fwd.headers.set("X-Plan-Token", "");
    fwd.headers.delete(INTERNAL_HEADER);
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
// Maximum RAW size of an inbound frame, checked BEFORE parsing it. The biggest legitimate message
// is a `plan5.replace` carrying a whole plan, so the ceiling is the plan's plus the room an
// envelope needs; anything beyond is refused without JSON.parse ever seeing it, because parsing is
// exactly the work an oversized frame is trying to make us do.
export const MAX_MSG_BYTES = MAX_PLAN_BYTES + 8_192;
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

// ---- PER-TOKEN RATE CAP (design edge 15) --------------------------------------------------------
// Brute-forcing a 128-bit invite token is not the threat this guards against — revoke (edge 6) is
// the real answer to a link handed around too widely. What this closes is a VALID link behaving
// badly: a tight client-side loop (a bug, or a script fed the token) that would otherwise fill the
// `plans` row and the D1 write quota with no ceiling at all. Measured interactive use: a furniture
// drag emits its final `piece.set` on RELEASE, not per frame (gestures diff-and-send once, cf.
// AGENTS.md "Gestures: ONE exit point"), so even a frantic multi-object session tops out at a
// handful of `op` messages per SECOND. 120 / rolling minute (2/s sustained) leaves roughly ten
// times that headroom — a human editing furniture can never hit it, a runaway loop will.
// Keyed on the ATTACHMENT'S TOKEN, never on `tag`: the cap must follow the LINK (several guest
// tabs can share one token), and a household socket's token is always "", so this never touches
// household traffic (MAX_ENTITIES and the 1.5 MB plan ceiling already bound that side).
const RATE_MAX_OPS = 120;
const RATE_WINDOW_MS = 60_000;
// Bound on the number of DISTINCT (kind, key) windows tracked at once, same spirit as
// SEQ_MAX_ENTRIES: an abandoned or revoked token's timestamp array must not linger in memory
// forever. Six kinds are capped now instead of one, so the bound is per-kind-per-socket.
const RATE_MAX_ENTRIES = 512;
// ---- EVERY KIND OF MESSAGE HAS A CEILING, NOT JUST `op` ---------------------------------------
// The cap only covered `op`, so `cursor`, `drag`, `chat`, `ping` and `name` were unbounded on a
// wire that broadcasts each of them to every peer: one socket in a tight loop cost N sends per
// frame, and `chat` additionally wrote storage each time. The budgets follow measured interactive
// use, an order of magnitude above it: a pointer moves at screen refresh but is only relayed on
// change, a person sends a handful of chat lines a minute, and a name is chosen once.
// A HOUSEHOLD socket gets a wider `op` budget rather than no budget at all: the point of a
// ceiling is a runaway loop, and a household tab loops exactly like a guest tab.
interface RateBudget { max: number; win: number; foyer?: number }
const RATE_BUDGETS: Record<string, RateBudget> = {
  op: { max: RATE_MAX_OPS, win: RATE_WINDOW_MS, foyer: 600 },
  cursor: { max: 30, win: 1_000 },
  drag: { max: 30, win: 1_000 },
  chat: { max: 5, win: 10_000 },
  name: { max: 3, win: 60_000 },
  ping: { max: 60, win: 60_000 },
};
// An overrun is SILENT for the ephemeral kinds (a dropped cursor frame costs nothing, and saying
// so would double the traffic being throttled) and an `err` for the ones a person watches
// succeed or fail.
const RATE_SILENT = new Set(["cursor", "drag", "ping"]);

// ---- HOW MANY SOCKETS A ROOM, AND A LINK, MAY HOLD --------------------------------------------
// Nothing bounded the number of open sockets: every one of them costs a send on every broadcast,
// so the cost of a room is quadratic in the number of tabs pointed at it, and a single invite link
// could open as many as it liked. The household is two people with a few devices; a link is one
// person, occasionally with a phone next to the laptop. Both ceilings answer 429 BEFORE the
// upgrade, so no socket is ever opened and then dropped.
const MAX_SOCKETS_ROOM = 32;
const MAX_SOCKETS_TOKEN = 4;

// The internal marker `functions/api/invites.ts` sets on its OWN freshly-built request to
// `PlanRoom`'s `/revoke` route (docs/decisions/0004-partage-par-lien.md, edge 6). It is never
// derived from an inbound client request — `functions/_middleware.ts` also strips it from every
// request it forwards, and `functions/ws.ts` deletes it explicitly from what it forwards to `/ws`
// — so its mere presence here can only mean this call came from that trusted code path, over the
// `ROOM` binding, a call that never touches the network-facing `export default {fetch}` below (see
// `handleRevoke`).
const INTERNAL_HEADER = "X-Plan-Internal";
// ---- SET-ASIDE VERSIONS ARE A LIST, NOT A SLOT ------------------------------------------------
// `orphan` was a SINGLE storage key: a second conflict overwrote the first, so the version a
// person lost could disappear before anyone came to look for it, and the only way to look was to
// open the Durable Object's storage by hand. The client already keeps the last 5 rejected
// versions (`room-planner-v4-conflit`); the server keeps the same number, and `GET /orphans`
// (internal route, same guard as `/revoke`) is how they are read back.
const ORPHAN_MAX = 5;
// Historical single key, still read once so a conflict recorded before this change is not lost.
const ORPHAN_KEY_OLD = "orphan";
// A distinguishable WebSocket close code (RFC 6455 application range 4000-4999) and reason, so a
// client that reconnects after a revoke can tell it apart from an ordinary drop and show the dead
// end screen instead of quietly retrying forever.
const REVOKE_CLOSE_CODE = 4001;
const REVOKE_CLOSE_REASON = "invite_revoked";
// ---- A DELETED PLAN STAYS DELETED --------------------------------------------------------------
// The DELETE in `functions/api/plans.ts` only erases the D1 row. This object's snapshot being an
// `INSERT … ON CONFLICT`, it recreated that row on the next alarm, and its sockets stayed open on
// a plan that no longer exists. `POST /purge` is what the DELETE calls: sockets closed, alarm
// disarmed, storage erased, and a marker so a message arriving late on a straggling socket is
// refused instead of rewriting anything.
const PURGE_CLOSE_CODE = 4004;
const PURGE_CLOSE_REASON = "plan_deleted";
const PURGED_KEY = "purged";
// ---- AN EXPIRY IS CHECKED WHILE THE SOCKET LIVES, NOT ONLY WHEN IT OPENS -----------------------
// `functions/ws.ts` refuses the upgrade of an expired invite, but an ALREADY OPEN socket never
// passed that door again: a link could expire mid-session and keep writing, which is the very hole
// `/revoke` was built to close for revocation. Same close-code family, same reason: the client can
// tell this apart from an ordinary drop and stop retrying.
const EXPIRE_CLOSE_CODE = 4003;
const EXPIRE_CLOSE_REASON = "link_expired";

// Will the plan fit into the DO's storage and into D1? Checked BEFORE any write: a mutation
// accepted then rejected by storage.put() used to let the exception escape from
// webSocketMessage, with no error for the client, no persistence, and no echo to peers.
// Number of rows actually touched by the last statement, the ONLY verdict of a compare-and-swap.
// Same contract, and same refusal to guess, as `functions/api/plan.ts`'s own `rowsChanged`: D1
// answers `meta.changes`, some SQLite harnesses answer a flat `changes`, and `null` means "the
// executor does not say", which is never read as a success.
export function rowsChanged(res: (D1Result<unknown> & { changes?: number }) | null): number | null {
  if (res && res.meta && typeof res.meta.changes === "number") return res.meta.changes;
  if (res && typeof res.changes === "number") return res.changes;
  return null;
}

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
//   - "empty": D1 has no row, or a row whose `data` is JSON `null` (how a plan is CREATED, cf.
//              functions/api/plans.ts) -> legitimate new plan, we install it and persist it.
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
  // JSON `null` IS "empty", not "unreadable". `functions/api/plans.ts` writes exactly that string
  // when a plan is created ("a new plan is born empty, not copied"), so refusing it made
  // `ensureLoaded` throw, the WebSocket upgrade fail, and the wire never open on a brand-new
  // plan. Same content as an absent column: no data at all.
  if (parsed === null) return { plan: emptyPlan(), source: "empty", persist: true };
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
  // The plan this room served was DELETED (see PURGE_CLOSE_CODE). Cached in memory, but the
  // authority is the storage marker: a fresh instance must find it there.
  purged: boolean;
  // Per-token rate window (design edge 15): token -> timestamps of `op` messages accepted within
  // the rolling window. Memory only, same reasoning as `seq` (cf. RATE_MAX_ENTRIES): losing it on
  // an eviction just resets the counter, which is harmless.
  rateSeen: Map<string, number[]>;

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
    this.purged = false;
    this.rateSeen = new Map();
  }

  /** Was the plan deleted? Read from storage the first time, so a fresh instance woken on a
   *  straggling socket refuses too. */
  async isPurged(): Promise<boolean> {
    if (this.purged) return true;
    if (await this.storage.get<boolean>(PURGED_KEY)) this.purged = true;
    return this.purged;
  }

  // Lazy load: DO storage first, otherwise D1, otherwise an empty plan.
  // Shape-agnostic: sanitizeState validates a v4 snapshot ({rooms,envelope}) or a v5 one
  // ({outline,walls,openings,pieces,cells}) alike; applyOp then dispatches on the loaded shape.
  // A NEW household's plan is in v5 (cf. emptyPlan); a household whose D1 row is still in the
  // old format is still served as-is, and switches over explicitly via the plan5.replace op.
  async ensureLoaded() {
    if (this.loaded) return;
    const stored = await this.storage.get(["plan", "opCount", OPCOUNT_KEY_OLD, "chat", "d1seen", "planId"]);
    // WHICH ROW IS OURS, reread here and not only in `fetch`. `adoptPlanId` used to be the only
    // writer of `this.planId`, and it is called from `fetch` alone: an object woken by
    // `webSocketMessage`, `alarm` or `webSocketClose` after an eviction therefore held null and
    // fell back to `main`, so a shared plan's alarm snapshotted over the HOUSEHOLD's row.
    // Second source, for the case where even the key is gone: a live socket's attachment, which
    // survives hibernation with the plan it was opened on.
    if (!this.planId) {
      this.planId = (stored.get("planId") as string | undefined) || this.planIdFromSockets();
    }
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
        .bind(this.requirePlanId())
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
  async reconcileD1(dirty: boolean): Promise<{ kind: string; why: string; hash?: string; rev: number | null }> {
    const row = await this.env.DB
      .prepare("SELECT data, rev, updated_by, updated_at FROM plans WHERE id=?1")
      .bind(this.requirePlanId())
      .first<D1PlanRow>();
    // The revision READ, handed back so the snapshot can swap against it (see `snapshot`).
    const revLue = row && typeof row.rev === "number" ? row.rev : null;
    const v = { ...d1Verdict(row, this.d1Seen, dirty), rev: revLue };
    if (v.kind === "none") return v;

    if (v.kind === "adopt") {
      // Same policy as on cold load: an unreadable row never replaces a live plan. coldLoad
      // throws on broken JSON -> we keep what we have and report nothing more.
      let cold;
      try { cold = coldLoad(row.data); } catch (_) { this.d1Seen = v.hash; await this.storage.put("d1seen", v.hash); return { kind: "none", why: "unreadable", rev: revLue }; }
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
      // Who has ALREADY been told, by DEVICE LABEL. The one who wrote offline is, by construction,
      // the one who is NOT connected at the moment of the conflict: without this list they would
      // never learn of it. They will be told when they come back, in their `hello`, and only once.
      // Those present are told right away, so they are noted here and not caught again.
      told: [...new Set(this.state.getWebSockets().map((s) => this.attOf(s).tag).filter(Boolean))],
    };
    const liste = await this.loadOrphans();
    let keepBytes = row.data.length <= MAX_PLAN_BYTES;
    if (keepBytes) {
      // If storage refuses the bytes, we fall back to the TRACE alone rather than letting the
      // exception block the alarm (and therefore every subsequent snapshot). Telling without
      // keeping is better than doing nothing at all.
      try { await this.saveOrphans([...liste, { ...trace, data: row.data }]); }
      catch (_) { keepBytes = false; await this.saveOrphans([...liste, trace]); }
    } else {
      await this.saveOrphans([...liste, trace]);
    }
    this.d1Seen = v.hash;               // a single announcement per foreign write
    await this.storage.put("d1seen", this.d1Seen);
    this.broadcastFor((guestAudience) => this.conflictMsg({ ...trace, data: keepBytes ? "…" : null }, guestAudience), null);
    return v;
  }

  /** The versions set aside so far, oldest first. Reads the historical single key once, so a
   *  conflict recorded before this became a list is not lost on the first deploy. */
  async loadOrphans(): Promise<OrphanTrace[]> {
    const liste = await this.storage.get<OrphanTrace[]>("orphans");
    if (Array.isArray(liste)) return liste;
    const seul = await this.storage.get<OrphanTrace>(ORPHAN_KEY_OLD);
    return seul ? [seul] : [];
  }

  /** Keeps the last ORPHAN_MAX of them, and retires the historical single key. */
  async saveOrphans(liste: OrphanTrace[]) {
    await this.storage.put("orphans", liste.slice(-ORPHAN_MAX));
    try { await this.storage.delete(ORPHAN_KEY_OLD); } catch (_) { /* nothing to retire */ }
  }

  /**
   * `GET /orphans` (internal route, same guard and same reachability as `/revoke`): hands back
   * the versions this room set aside, so recovering one is a request instead of an inspection of
   * the Durable Object's storage by hand. `functions/` exposes it to the household door.
   * Response contract: `{orphans:[{at, by, rev, data}]}`, oldest first.
   */
  async handleOrphans(request: Request): Promise<Response> {
    if (request.headers.get(INTERNAL_HEADER) !== "1") return new Response("forbidden", { status: 403 });
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
    const liste = await this.loadOrphans();
    return Response.json({
      orphans: liste.map((o) => ({
        at: o.at ?? null, by: o.by ?? null, rev: o.rev ?? null, data: o.data ?? null,
      })),
    });
  }

  // Conflict message, built from a single place (reconciliation AND the `hello` on return).
  // `by` names a HOUSEHOLD writer (an email, or the REST fallback's "invite:<name>" string for a
  // guest write) — not this batch's "author identity", but the same "no email to a guest" rule
  // from item 2 applies here too: a guest recipient gets no `by` at all, only the fact that
  // something was kept.
  conflictMsg(o: { by?: string | null; at?: string | null; bytes?: number; data?: unknown }, guestAudience: boolean) {
    return {
      t: "conflict", by: guestAudience ? null : (o.by || null), at: o.at || null,
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
    // A MALFORMED identifier leaves the object without a plan rather than pointing it at `main`:
    // `requirePlanId` then refuses every D1 access, and the upgrade fails, which is the correct
    // end for a request nobody can route.
    const id = cleanPlanId(fromHeader);
    if (!id) return;
    this.planId = id;
    await this.storage.put("planId", this.planId);
  }

  /** The plan id carried by a LIVE socket's attachment. Last-resort source for an object woken on
   *  a hibernated socket whose `planId` storage key is somehow gone: the attachment survives both
   *  hibernation and eviction. */
  planIdFromSockets(): string | null {
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as SocketAttachment | null;
      const id = a && a.planId ? cleanPlanId(a.planId) : null;
      if (id) return id;
    }
    return null;
  }

  /**
   * WHICH ROW, or nothing at all. An object that does not know which plan is its own touches
   * NOTHING: it neither reads nor writes D1. The previous `|| PLAN_ID_DEFAUT` turned "I don't
   * know" into "the household's plan", which is the one answer that silently corrupts a
   * different document than the one being edited.
   */
  requirePlanId(): string {
    if (!this.planId) throw new OpError("plan_id_unknown");
    return this.planId;
  }

  async fetch(request: Request): Promise<Response> {
    // `/revoke` is an INTERNAL route (docs/decisions/0004-partage-par-lien.md, edge 6): it never
    // upgrades a socket, so it is handled BEFORE `adoptPlanId`/`ensureLoaded` (this room may not
    // even hold a live plan yet, e.g. a link revoked before anyone ever joined). See `handleRevoke`
    // for why this is safe to reach only from `functions/api/invites.ts`'s own trusted call.
    const url = new URL(request.url);
    if (url.pathname === "/revoke") return this.handleRevoke(request);
    if (url.pathname === "/orphans") return this.handleOrphans(request);
    if (url.pathname === "/purge") return this.handlePurge(request);
    // A deleted plan does not open a wire again: 410, and the client stops retrying.
    if (await this.isPurged()) return new Response("plan deleted", { status: 410 });

    await this.adoptPlanId(request.headers.get("X-Plan-Id"));
    // Nothing routable: refuse the upgrade rather than open a socket onto an object that would
    // have to guess which row is its own.
    if (!this.planId) return new Response("bad plan id", { status: 400 });
    // ---- CEILINGS BEFORE THE UPGRADE (see MAX_SOCKETS_ROOM) --------------------------------------
    // Answered here, ahead of `ensureLoaded` and of the pair: a socket that will be refused must
    // never be opened, and must cost neither a D1 read nor a reconciliation.
    const att = attachmentFromRequest(request, this.freshTag());
    const vivants = this.state.getWebSockets();
    if (vivants.length >= MAX_SOCKETS_ROOM) return new Response("too many sockets", { status: 429 });
    if (att.token) {
      let parJeton = 0;
      for (const ws of vivants) if (this.attOf(ws).token === att.token) parJeton++;
      if (parJeton >= MAX_SOCKETS_TOKEN) return new Response("too many sockets", { status: 429 });
    }
    await this.ensureLoaded();
    // The room was EMPTY: no one was in realtime, so everyone was on the REST fallback. This is
    // the exact moment when D1 can be ahead of us. Tolerant: if D1 doesn't answer, we serve
    // anyway (the REST fallback is dead anyway, better the live one) and the next reconciliation,
    // before the snapshot, will catch up on the foreign write.
    if (this.state.getWebSockets().length === 0) {
      try { await this.reconcileD1(await this.storage.getAlarm() !== null); } catch (_) { /* serve anyway */ }
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Hibernation: the DO manages the socket via webSocketMessage/Close.
    this.state.acceptWebSocket(server);
    server.serializeAttachment(att);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * `POST /revoke {token}` (docs/decisions/0004-partage-par-lien.md, edge 6): closes every LIVE
   * socket whose attachment token matches, so "Revoke" in the owner's Share panel is not a lie for
   * as long as the guest stays connected. Reachable in exactly ONE way: `functions/api/invites.ts`
   * calling `env.ROOM.get(id).fetch(...)` directly on its OWN freshly-built `Request` — that call
   * invokes THIS method straight away, over the binding, and never touches the network-facing
   * `export default {fetch}` below (which still 404s any path but `/ws`, so even a future zone
   * route sending traffic there gets nothing new). The `INTERNAL_HEADER` check is defence in
   * depth on top of that structural guarantee: see its definition for what makes it trustworthy.
   */
  async handleRevoke(request: Request): Promise<Response> {
    if (request.headers.get(INTERNAL_HEADER) !== "1") return new Response("forbidden", { status: 403 });
    let body: { token?: unknown };
    try { body = await request.json(); } catch { return new Response("bad json", { status: 400 }); }
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) return new Response("bad token", { status: 400 });
    let closed = 0;
    for (const ws of this.state.getWebSockets()) {
      const a = this.attOf(ws);
      if (a.token && a.token === token) {
        try { ws.close(REVOKE_CLOSE_CODE, REVOKE_CLOSE_REASON); } catch (_) { /* already gone */ }
        closed++;
      }
    }
    return Response.json({ ok: true, closed });
  }

  /**
   * `POST /purge` (internal route, same guard and same reachability as `/revoke`): the plan this
   * room served has been deleted. Everything this object could use to write that row again goes:
   * the sockets (closed with a distinguishable code, so the client shows a dead end instead of
   * retrying), the alarm, and the whole storage. The `purged` marker is written LAST, over the
   * emptied storage, and is what makes a straggling message harmless.
   * Response contract: `{ok:true, closed:<n>}`.
   */
  async handlePurge(request: Request): Promise<Response> {
    if (request.headers.get(INTERNAL_HEADER) !== "1") return new Response("forbidden", { status: 403 });
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    let closed = 0;
    for (const ws of this.state.getWebSockets()) {
      try { ws.close(PURGE_CLOSE_CODE, PURGE_CLOSE_REASON); } catch (_) { /* already gone */ }
      closed++;
    }
    try { await this.storage.deleteAlarm(); } catch (_) { /* none armed */ }
    await this.storage.deleteAll();
    await this.storage.put(PURGED_KEY, true);
    this.purged = true;
    // In memory too: `loaded` false with no plan means nothing can be snapshotted back.
    this.loaded = false;
    this.plan = null;
    this.chat = [];
    this.d1Seen = null;
    this.seq.clear();
    this.rateSeen.clear();
    return Response.json({ ok: true, closed });
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
      || { email: "inconnu", color: colorFor("inconnu"), tag: "000000", name: "", guest: false, guestId: "", token: "", planId: "", expiresAt: 0 };
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
  //
  // ---- WIRE IDENTITY, batch 2 --------------------------------------------------------------------
  // Every message naming an author now goes through `authorWire`/`identityWire`: `tag`, `name` and
  // `guest` are the SAME for every recipient (a guest recipient must still be able to tell peers
  // apart and see who is who), but `email`/`by` is INCLUDED ONLY for a household recipient (item 2:
  // "emails never cross to a guest"). Because the SAME broadcast reaches both kinds of socket, the
  // household's own attribution must not be stripped at the SOURCE — hence `broadcastFor`, which
  // builds (at most) two payload variants and sends each recipient the one meant for it.

  /**
   * The name a GUEST recipient should see for `a`. A guest author's own declared name if they have
   * one; a HOUSEHOLD author has no such field (`a.name` is always "" there), so without this a
   * guest would see a blank dot where a household peer's should be — "a display name instead [of
   * the email], never an email at all" (item 2) means instead, not nothing.
   */
  nameForGuestAudience(a: SocketAttachment): string {
    return a.name || nameFromEmail(a.email);
  }

  /** The author fields common to every relayed message (`op`/`cursor`/`drag`, which all key the
   *  address as `by`): `tag` always, `name`+`guest` always (see `nameForGuestAudience`), `guestId`
   *  when the author is a guest (not sensitive: a self-generated device id, never a credential),
   *  `by` NEVER unless `guestAudience` is false. */
  authorWire(a: SocketAttachment, guestAudience: boolean): Record<string, unknown> {
    const o: Record<string, unknown> = {
      tag: a.tag || null,
      name: guestAudience ? this.nameForGuestAudience(a) : (a.name || ""),
      guest: !!a.guest,
    };
    if (a.guest && a.guestId) o.guestId = a.guestId;
    if (!guestAudience) o.by = a.email;
    return o;
  }

  /** `hello.you` / `hello.peers` / `peer` shape: `authorWire` plus `color`, plus `email` for a
   *  household recipient (mirrors the pre-batch-2 shape exactly, so an older client still works). */
  identityWire(a: SocketAttachment, guestAudience: boolean): Record<string, unknown> {
    const o: Record<string, unknown> = { color: a.color, ...this.authorWire(a, guestAudience) };
    if (!guestAudience) o.email = a.email;
    return o;
  }

  /** `exclude`: drop ONE socket from the list itself (webSocketClose's "remaining", which has
   *  already left); `null` keeps every socket (hello, and the newcomer broadcast, which excludes
   *  the RECIPIENT via `broadcastFor`'s own `exclude`, not the list). */
  peersWire(guestAudience: boolean, exclude: WebSocket | null): Record<string, unknown>[] {
    return this.state.getWebSockets()
      .filter((ws) => ws !== exclude)
      .map((ws) => this.identityWire(this.attOf(ws), guestAudience));
  }

  /** Full-fidelity peer list (household shape): kept for callers, and for tests, that only ever
   *  cared about the household's own view (`live-worker/test-local.ts`). */
  peers(): Record<string, unknown>[] { return this.peersWire(false, null); }

  /** A stored chat entry, redacted for `guestAudience`. `e.by` (the real author identity) is kept
   *  in STORAGE always; only the outgoing copy ever omits it (design edge 19). */
  chatWire(e: ChatEntry, guestAudience: boolean): Record<string, unknown> {
    const o: Record<string, unknown> = {
      id: e.id, text: e.text, ts: e.ts, guest: !!e.guest,
      name: guestAudience ? (e.name || nameFromEmail(e.by)) : (e.name || ""),
    };
    if (!guestAudience) o.by = e.by;
    return o;
  }

  broadcast(obj: object, exclude: WebSocket | null) {
    const s = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      if (ws === exclude) continue;
      try { ws.send(s); } catch (_) { /* dead socket, close will come */ }
    }
  }

  /**
   * Per-recipient broadcast: `builder(guestAudience)` returns the payload for that AUDIENCE, and
   * we serialize it AT MOST TWICE (once per distinct audience actually among the RECIPIENTS),
   * never once per socket. "Do not simply strip at the source" (item 2): stripping the
   * household's OWN email out of a single shared payload would blind the household to its own
   * attribution, so two payloads are built instead of one, and each recipient gets the one that
   * matches what it is.
   *
   * WHEN ONLY ONE AUDIENCE IS PRESENT among the recipients (the common case: a household with no
   * guest connected, or — for `live-worker/test-local.ts`'s single-socket doubles — always), this
   * delegates to `this.broadcast()` instead of sending directly: tests that override `room.broadcast`
   * to capture what goes out (predating this batch, and unaware `broadcastFor` exists) keep working
   * unchanged. Only a TRULY MIXED audience bypasses it, since `broadcast()` cannot carry two
   * different payloads to two different sockets in one call.
   */
  broadcastFor(builder: (guestAudience: boolean) => object, exclude: WebSocket | null) {
    const destinataires = this.state.getWebSockets().filter((ws) => ws !== exclude);
    const guestPresent = destinataires.some((ws) => this.attOf(ws).guest);
    const householdPresent = destinataires.some((ws) => !this.attOf(ws).guest);
    if (!(guestPresent && householdPresent)) {
      this.broadcast(builder(guestPresent), exclude);
      return;
    }
    let householdStr: string | null = null;
    let guestStr: string | null = null;
    for (const ws of destinataires) {
      const guestAudience = this.attOf(ws).guest;
      const s = guestAudience
        ? (guestStr ??= JSON.stringify(builder(true)))
        : (householdStr ??= JSON.stringify(builder(false)));
      try { ws.send(s); } catch (_) { /* dead socket, close will come */ }
    }
  }

  send(ws: WebSocket, obj: object) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }

  // ---- RATE CAP PER KIND OF MESSAGE (design edge 15, see RATE_BUDGETS) ---------------------------
  // Keyed on the ATTACHMENT'S TOKEN for a guest, because the cap must follow the LINK (several
  // tabs can share one), and on the DEVICE LABEL for a household socket, which carries no token
  // and would otherwise share one bucket with every other household tab.
  // Returns true if this message may proceed (and records it); false if it is OVER the budget for
  // its kind's rolling window. A kind with no budget is never capped (`hello`, `sync`).
  rateOk(att: SocketAttachment, kind: string): boolean {
    const budget = RATE_BUDGETS[kind];
    if (!budget) return true;
    const max = (!att.guest && budget.foyer !== undefined) ? budget.foyer : budget.max;
    const key = kind + "|" + (att.token || ("tag:" + att.tag));
    const now = Date.now();
    let arr = this.rateSeen.get(key);
    if (!arr) {
      while (this.rateSeen.size >= RATE_MAX_ENTRIES) {
        const oldest = this.rateSeen.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.rateSeen.delete(oldest);
      }
      arr = [];
      this.rateSeen.set(key, arr);
    }
    while (arr.length && now - arr[0]! > budget.win) arr.shift();
    if (arr.length >= max) return false;
    arr.push(now);
    return true;
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
    // A deleted plan is never snapshotted back into existence.
    if (await this.isPurged()) { try { await this.storage.deleteAlarm(); } catch (_) {} return; }
    await this.ensureLoaded();
    const v = await this.reconcileD1(true);
    await this.snapshot(v.rev);
  }

  /**
   * ---- THE SNAPSHOT IS A COMPARE-AND-SWAP TOO ---------------------------------------------------
   * There were TWO round trips here (reread, then write) and the write carried no `WHERE`. A PUT
   * compare-and-swap (`functions/api/plan.ts`) landing BETWEEN the two won its swap, answered 200
   * to its client, and was then overwritten by this blind write; `d1Seen` recorded our own bytes,
   * so the next reconciliation saw nothing foreign and no one was ever told. The fallback believed
   * it had written, the row held none of it, and the wire said everything was fine.
   *
   * `expectedRev` is the revision READ by the reconciliation that precedes this call. The write
   * uses the SAME statement shape as the REST Function: insert if the row is absent, update only
   * if the revision is still that one, nothing otherwise. The verdict is read from `meta.changes`,
   * never from a re-read. Zero rows touched = the row moved under us: we reconcile ONCE more
   * (which adopts it, or sets it aside as an orphan and tells the clients, the existing path) and
   * retry exactly once. A second failure lets a D1 error propagate: the alarm replays it.
   *
   * `expectedRev === null` (no row at read time) is not a hole: the INSERT branch fires when the
   * row is genuinely absent, and if a row appeared meanwhile `plans.rev = NULL` is never true, so
   * the swap correctly refuses instead of overwriting it.
   */
  async snapshot(expectedRev: number | null = null, secondeChance = true): Promise<void> {
    const planId = this.requirePlanId();
    const data = JSON.stringify(this.plan);
    const now = new Date().toISOString();
    // A D1 error propagates up: the alarm will be replayed automatically (up to 6 times).
    const res = await this.env.DB
      .prepare(
        "INSERT INTO plans(id,data,rev,updated_at,updated_by) VALUES(?3,?1,1,?2,'live') " +
        "ON CONFLICT(id) DO UPDATE SET data=?1, rev=rev+1, updated_at=?2, updated_by='live' " +
        "WHERE plans.rev=?4"
      )
      .bind(data, now, planId, expectedRev)
      .run();
    if (rowsChanged(res) === 1) {
      // We now know what the row looks like: the next reconciliation won't mistake it for a
      // foreign write (belt-and-suspenders, `updated_by='live'` already says so).
      this.d1Seen = strHash(data);
      await this.storage.put("d1seen", this.d1Seen);
      return;
    }
    // The row moved (or the executor won't say how many rows it touched, which is the same thing
    // here: a swap whose bite we don't know about is not a swap). `d1Seen` is deliberately NOT
    // updated: whatever is in that row is not ours.
    if (!secondeChance) throw new OpError("snapshot_conflict");
    const v = await this.reconcileD1(true);
    await this.snapshot(v.rev, false);
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
    // The plan was DELETED: a message arriving on a socket that has not noticed yet is refused
    // BEFORE `ensureLoaded`, which would otherwise cold-load from D1 and reinstall the row.
    if (await this.isPurged()) {
      this.send(ws, { t: "err", reason: PURGE_CLOSE_REASON });
      try { ws.close(PURGE_CLOSE_CODE, PURGE_CLOSE_REASON); } catch (_) { /* already gone */ }
      return;
    }
    // RAW SIZE FIRST, before parsing: parsing is the work an oversized frame is trying to buy.
    if (typeof raw === "string" && raw.length > MAX_MSG_BYTES) {
      return this.send(ws, { t: "err", reason: "bad_size" });
    }
    await this.ensureLoaded();
    let msg: WireMessage;
    try { msg = JSON.parse(raw); } catch { return this.send(ws, { t: "err", reason: "bad_json" }); }
    const att = this.attOf(ws);

    // ---- EXPIRY AND THE RATE CAP ARE CHECKED ON EVERY MESSAGE, NOT ONLY AT THE DOOR -------------
    // An invite that expires while its socket is open stops here. `expiresAt === 0` means the
    // forwarder said nothing, so nothing is checked (compatibility).
    if (att.guest && att.expiresAt > 0 && Date.now() > att.expiresAt) {
      this.send(ws, { t: "err", reason: EXPIRE_CLOSE_REASON });
      try { ws.close(EXPIRE_CLOSE_CODE, EXPIRE_CLOSE_REASON); } catch (_) { /* already gone */ }
      return;
    }
    // One budget per KIND, for every socket, guest and household alike (see RATE_BUDGETS).
    const genre = (msg && typeof msg.t === "string") ? msg.t : "";
    if (genre && !this.rateOk(att, genre)) {
      if (RATE_SILENT.has(genre)) return;
      return this.send(ws, {
        t: "err", reason: "rate_limited",
        n: (genre === "op" && Number.isSafeInteger(msg.n)) ? msg.n : null,
        kind: (genre === "op" && msg.op && msg.op.kind) || null,
      });
    }

    switch (msg && msg.t) {
      case "hello": {
        this.send(ws, {
          t: "hello",
          // `tag`: device label unique among live sockets (cf. freshTag). `name`/`guest` carry the
          // wire identity added in batch 2; `email` is present here too (this is `att`'s OWN
          // identity, sent back to itself) but stays "" for a guest, exactly as `X-Plan-Email` was.
          you: this.identityWire(att, att.guest),
          peers: this.peersWire(att.guest, null),
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
          chat: this.chat.slice(-CHAT_CAP).map((e) => this.chatWire(e, att.guest)),
        });
        // The others learn about the newcomer.
        this.broadcastFor((guestAudience) => ({ t: "peer", peers: this.peersWire(guestAudience, null) }), ws);
        // A write made offline couldn't be merged while this person was away? It's THEM who lost
        // work, and they weren't there to hear about it. We tell them when they come back, only
        // once (the `told` list remembers who has already been notified).
        // Indexed on the DEVICE LABEL, not the email: a guest's email is always empty, so one
        // guest told marked every guest as told and the others never heard of it.
        // ONE message for the whole list (the most recent set-aside version): the banner says
        // that something was kept, `GET /orphans` is what enumerates them.
        const orphans = await this.loadOrphans();
        const dernier = orphans.length ? orphans[orphans.length - 1] : null;
        if (dernier && att.tag && !(dernier.told || []).includes(att.tag)) {
          this.send(ws, this.conflictMsg(dernier, att.guest));
          await this.saveOrphans(orphans.map((o) => ({
            ...o, told: [...new Set([...(o.told || []), att.tag])],
          })));
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
        // ---- A REFUSAL DOES NOT MOVE THE WINDOW -------------------------------------------------
        // The number used to be consumed as soon as the server had PROCESSED it, refusal included.
        // A gap was then swallowed by the very op that revealed it: n°5 lost, n°6 refused (the
        // refusal returns before the `gap` is sent) but noted anyway, so n°7 looked contiguous and
        // the loss of n°5 was never announced. And a refusal is not always the client's fault:
        // `rate_limited` and `persist_fail` are changes the client SHOULD re-emit. The number is
        // therefore noted below, once the op is APPLIED. The price is one gap announced after a
        // genuine validation refusal, and one is the right side to err on: a gap costs a single
        // idempotent re-emission, a swallowed loss costs the change.

        // ---- GUEST-ONLY REFUSALS (design edges 15, 17; batch 2 items 4, 5, 7) --------------------
        // All three share the SAME numbered err path as an ordinary validation refusal: the client
        // must UNDO through the normal receive path, never silently swallow a rejected change.
        // Item 5: the name gate is client-side in the guest onboarding UI (batch 3), a disabled
        // Join button stops a PERSON, not a script. `sync`/`hello` stay allowed (a nameless guest
        // must still be able to SEE the plan and be told what is wrong); only `op` is gated.
        if (att.guest && !att.name) {
          return this.send(ws, { t: "err", reason: "guest_unnamed", n: seq, kind: (msg.op && msg.op.kind) || null });
        }
        // Item 4: `plan5.replace` replaces the plan in ONE atomic op AND clears undo history (cf.
        // AGENTS.md, "Ctrl+Z undoes only its author's work"). Hidden from the guest UI (batch 3);
        // refused here regardless of what reaches the wire.
        if (att.guest && msg.op && msg.op.kind === "plan5.replace") {
          return this.send(ws, { t: "err", reason: "guest_no_replace", n: seq, kind: "plan5.replace" });
        }

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
        // APPLIED and persisted: only now does the window move past this number.
        if (sq) this.seqNote(sq, seq);
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
        // `opWire`, NOT `msg.op`: the envelope that goes back out is rebuilt from the keys its
        // kind is known to carry (see ops.ts), so a key the validator never looked at cannot ride
        // the broadcast into every peer's receive path.
        const opSortie = opWire(msg.op);
        this.broadcastFor((guestAudience) => ({
          t: "op", op: opSortie, n: seq, opCount: this.opCount, fp: planFp(this.plan),
          ...this.authorWire(att, guestAudience),
        }), null);
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
        // `say` (cursor chat, "/"): `c.say` is `undefined` when the sender had no opinion (an
        // old client, or an ordinary ping with the box closed) — `undefined` is dropped by
        // `JSON.stringify`, so this changes NOTHING for a recipient on an older client. A string
        // or an explicit `null` (the box just closed) travels as-is, per-recipient audience rule
        // unchanged: same `authorWire` redaction as every other relayed message.
        const c = sanitizeCursor(msg);
        if (!c) break;
        this.broadcastFor((guestAudience) => ({
          t: "cursor", color: att.color, room: c.room, x: c.x, y: c.y, say: c.say,
          ...this.authorWire(att, guestAudience),
        }), ws);
        break;
      }

      case "drag": {
        // Preview ghost, ephemeral (the final position follows in piece.set).
        // `pieceId` ends up in a CSS selector on the peer's side: validated, cf. sanitizeDrag.
        const d = sanitizeDrag(msg);
        if (!d) break;
        this.broadcastFor((guestAudience) => ({
          t: "drag", color: att.color, room: d.room, pieceId: d.pieceId, x: d.x, y: d.y, rot: d.rot,
          ...this.authorWire(att, guestAudience),
        }), ws);
        break;
      }

      case "chat": {
        const text = String(msg.text ?? "").slice(0, 500).trim();
        if (!text) return;
        // `name`/`guest` captured AT SEND TIME (design edge 19): a stored entry survives a rename
        // and a departure alike, so the replayed history in a later `hello` must not depend on the
        // author's socket still being around, or on their CURRENT name.
        const entry: ChatEntry = { id: crypto.randomUUID(), by: att.email, name: att.name || "", guest: !!att.guest, text, ts: Date.now() };
        this.chat.push(entry);
        if (this.chat.length > CHAT_CAP) this.chat = this.chat.slice(-CHAT_CAP);
        await this.storage.put("chat", this.chat);
        this.broadcastFor((guestAudience) => ({ t: "chat", msg: this.chatWire(entry, guestAudience) }), null);
        break;
      }

      // A socket may set/change its display name AT ANY TIME (item 5), not only a guest at
      // onboarding: this is also what the sync-chip's "change my name" menu (batch 3/4) will call.
      // Cleaned server-side regardless of what the caller already did upstream (defence in depth,
      // same reasoning as re-checking `porteDe()` in every Pages Function that could reach here).
      case "name": {
        const cleaned = cleanGuestName(msg.name);
        const next: SocketAttachment = { ...att, name: cleaned };
        // Colour follows the SAME formula used at connection time (cf. `attachmentFromRequest`),
        // so picking/typing a name doesn't leave the dot showing the colour derived from the OLD
        // (usually empty) one. A household socket's colour stays tied to its email: it must not
        // drift just because someone typed a name into the same field.
        if (att.guest) next.color = colorFor(cleaned || att.guestId || att.tag);
        ws.serializeAttachment(next);
        // Presence must reflect the rename on every screen right away, including sockets that
        // never send an `op` (a guest who only ever looks) and therefore never trigger the
        // ordinary `peer` broadcast on their own.
        this.broadcastFor((guestAudience) => ({ t: "peer", peers: this.peersWire(guestAudience, null) }), null);
        this.send(ws, { t: "name", ok: true, name: cleaned });
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
    // A purge closed every socket at once: the departure flush would only rewrite the deleted row.
    if (await this.isPurged()) return;
    // The deduplication window dies with the socket: it's indexed by the device label, which is
    // unique per socket and never reused. Nothing to purge later.
    const att = this.attOf(ws);
    if (att && att.tag) this.seq.delete(att.tag);
    this.broadcastFor((guestAudience) => ({ t: "peer", peers: this.peersWire(guestAudience, ws) }), ws);
    const remaining = this.state.getWebSockets().filter((s) => s !== ws);
    // Last departure: immediate flush to D1 if a snapshot is due (alarm armed), then disarming.
    // If the flush fails, we LEAVE the alarm: it will replay the snapshot.
    if (remaining.length === 0) {
      try {
        if (await this.storage.getAlarm() !== null) {
          await this.ensureLoaded();
          const v = await this.reconcileD1(true);   // never overwrite a REST write without saying so
          await this.snapshot(v.rev);
          await this.storage.deleteAlarm();
        }
      } catch (_) { /* the alarm stays armed and will retry */ }
    }
  }

  async webSocketError(ws: WebSocket) {
    try { ws.close(); } catch (_) {}
  }
}
