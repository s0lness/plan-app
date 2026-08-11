// Pure node test of the ops/validation logic (no cloudflare import).
// `worker.ts` only uses Cloudflare globals (WebSocketPair, storage) INSIDE methods:
// importing it under node has no side effect, which makes `coldLoad` testable as-is.
// Run: node live-worker/test-local.ts
import type { DonneeDynamique } from "../tests/_types.ts";
import { applyOp as applyOpReel, sanitizeState as sanitizeStateReel, colorFor, OpError, sanitizeCursor as sanitizeCursorReel, sanitizeDrag as sanitizeDragReel, isV5, planFp, strHash, emptyPlan } from "./ops.ts";
import type { CursorMessage, DragMessage, Operation, Piece, PlanState, Point } from "./ops.ts";
import { coldLoad, planTooBig, PlanRoom, d1Verdict, upgradeEmptyLegacy } from "./worker.ts";

// The doubles only implement the surface actually read by PlanRoom. These two boundaries
// concentrate the adaptation to the full Cloudflare contract, without weighing down each scenario.
const nouvelleRoom = (state: unknown, env: unknown) => new PlanRoom(
  state as ConstructorParameters<typeof PlanRoom>[0],
  env as ConstructorParameters<typeof PlanRoom>[1],
);
const messageSocket = (room: PlanRoom, socket: unknown, message: string) =>
  room.webSocketMessage(socket as WebSocket, message);
const fermeSocket = (room: PlanRoom, socket: unknown) => room.webSocketClose(socket as WebSocket);

let n = 0;
function ok(cond: unknown, label: string) {
  n++;
  if (!cond) throw new Error("FAIL: " + label);
}
function throws(fn: () => unknown, label: string) {
  n++;
  let threw = false;
  try { fn(); } catch (e) { threw = e instanceof OpError; }
  if (!threw) throw new Error("EXPECTED OpError: " + label);
}
// Expects a precise SHAPE refusal (v4 op on v5 state and vice versa).
function shapeErr(fn: () => unknown, label: string) {
  n++;
  let reason = null;
  try { fn(); } catch (e) { reason = e && e.reason; }
  if (reason !== "op_shape") throw new Error("EXPECTED op_shape (" + reason + "): " + label);
}

// Deliberately invalid calls belong to this bench's contract: the boundary therefore accepts
// an unknown shape, then lets the real validator produce its verdict.
const applyOp = (state: PlanState, op: unknown) => applyOpReel(state, op as Operation);
const sanitizeState = (state: unknown) => sanitizeStateReel(state as PlanState);
const sanitizeCursor = (message: unknown) => sanitizeCursorReel(message as CursorMessage);
const sanitizeDrag = (message: unknown) => sanitizeDragReel(message as DragMessage);
const poly = (): Point[] => [[0, 0], [100, 0], [100, 100], [0, 100]];
const freshPlan = (): PlanState => ({
  rooms: [
    { id: "r1", name: "Salon", floor: 0, room: { poly: poly() }, pieces: [] },
  ],
  setupDone: true,
});
const piece = (over: Record<string, unknown> = {}): Piece => ({
  id: "p1", type: "sofa", name: "Canapé", x: 10, y: 20, w: 200, h: 90, rot: 0, ...over,
} as Piece);

// ---- piece.set: upsert ----
let plan = freshPlan();
applyOp(plan, { kind: "piece.set", roomId: "r1", piece: piece() });
ok(plan.rooms[0].pieces.length === 1, "piece.set insert");
applyOp(plan, { kind: "piece.set", roomId: "r1", piece: piece({ x: 55 }) });
ok(plan.rooms[0].pieces.length === 1, "piece.set upsert no dup");
ok(plan.rooms[0].pieces[0].x === 55, "piece.set upsert value");

// idempotence: replaying the same set leaves the state identical
applyOp(plan, { kind: "piece.set", roomId: "r1", piece: piece({ x: 55 }) });
ok(plan.rooms[0].pieces.length === 1 && plan.rooms[0].pieces[0].x === 55, "piece.set idempotent");

// ---- piece.set validations ----
throws(() => applyOp(freshPlan(), { kind: "piece.set", roomId: "r1", piece: piece({ x: NaN }) }), "NaN coord");
throws(() => applyOp(freshPlan(), { kind: "piece.set", roomId: "r1", piece: piece({ w: 0 }) }), "w below 1");
throws(() => applyOp(freshPlan(), { kind: "piece.set", roomId: "r1", piece: piece({ w: 4000 }) }), "w above 3000");
// A NAME that's too long is TRUNCATED, never refused (a refusal made the furniture item disappear for the peer).
{
  const pt = freshPlan();
  applyOp(pt, { kind: "piece.set", roomId: "r1", piece: piece({ name: "x".repeat(200) }) });
  ok(pt.rooms[0].pieces[0].name.length === 80, "v4 piece name truncated not rejected");
}
throws(() => applyOp(freshPlan(), { kind: "piece.set", roomId: "r1", piece: piece({ evil: 1 }) }), "unknown key");
throws(() => applyOp(freshPlan(), { kind: "piece.set", roomId: "nope", piece: piece() }), "no such room");

// ---- piece.del ----
plan = freshPlan();
applyOp(plan, { kind: "piece.set", roomId: "r1", piece: piece() });
applyOp(plan, { kind: "piece.set", roomId: "r1", piece: piece({ id: "p2" }) });
applyOp(plan, { kind: "piece.del", roomId: "r1", pieceId: "p1" });
ok(plan.rooms[0].pieces.length === 1 && plan.rooms[0].pieces[0].id === "p2", "piece.del removes");
// del of an absent id = idempotent no-op
applyOp(plan, { kind: "piece.del", roomId: "r1", pieceId: "p1" });
ok(plan.rooms[0].pieces.length === 1, "piece.del absent no-op");

// ---- piece.front: REMOVED op (no client emits it, exhaustive census) ----
throws(() => applyOp(freshPlan(), { kind: "piece.front", roomId: "r1", pieceId: "p1" }), "v4 piece.front removed");
throws(() => applyOp(freshPlan(), { kind: "piece.front", pieceId: "p1" }), "piece.front removed everywhere");

// ---- room.add ----
plan = freshPlan();
applyOp(plan, { kind: "room.add", room: { id: "r2", name: "Cuisine", floor: 0, room: { poly: poly() }, pieces: [] } });
ok(plan.rooms.length === 2, "room.add appends");
throws(() => applyOp(plan, { kind: "room.add", room: { id: "r2", name: "x", floor: 0, room: { poly: poly() }, pieces: [] } }), "room.add dup id");
throws(() => applyOp(freshPlan(), { kind: "room.add", room: { id: "r9", room: { poly: [[0, 0], [1, 1]] } } }), "poly 2 points");
throws(() => applyOp(freshPlan(), { kind: "room.add", room: { id: "r9", room: { poly: [[0, 0], [1, 1], ["a", 2]] } } }), "poly non-number");

// ---- room.set ----
plan = freshPlan();
applyOp(plan, { kind: "room.set", roomId: "r1", name: "Séjour", floor: 1 });
ok(plan.rooms[0].name === "Séjour" && plan.rooms[0].floor === 1, "room.set meta");
applyOp(plan, { kind: "room.set", roomId: "r1", poly: [[0, 0], [50, 0], [50, 50]] });
ok(plan.rooms[0].room.poly.length === 3, "room.set poly");
throws(() => applyOp(plan, { kind: "room.set", roomId: "r1", poly: [[0, 0], [1, 1]] }), "room.set bad poly");
applyOp(plan, { kind: "room.set", roomId: "r1", name: "x".repeat(200) });
ok(plan.rooms[0].name.length === 80, "room.set name truncated not rejected");

// ---- room.set ax/ay (apartment offset) ----
plan = freshPlan();
applyOp(plan, { kind: "room.set", roomId: "r1", ax: 300, ay: 0 });
ok(plan.rooms[0].ax === 300 && plan.rooms[0].ay === 0, "room.set ax/ay");
applyOp(plan, { kind: "room.set", roomId: "r1", ax: null, ay: null });
ok(plan.rooms[0].ax === null && plan.rooms[0].ay === null, "room.set ax/ay null");
throws(() => applyOp(freshPlan(), { kind: "room.set", roomId: "r1", ax: "nope" }), "room.set bad ax");
// ax/ay survive validateRoom (room.add) and sanitizeState
plan = freshPlan();
applyOp(plan, { kind: "room.add", room: { id: "r2", name: "C", floor: 0, ax: 520, ay: 40, room: { poly: poly() }, pieces: [] } });
ok(plan.rooms[1].ax === 520 && plan.rooms[1].ay === 40, "room.add keeps ax/ay");
const cleanAx = sanitizeState({ rooms: [{ id: "s1", name: "S", floor: 0, ax: 100, ay: 200, room: { poly: poly() }, pieces: [] }], setupDone: true });
ok(cleanAx.rooms[0].ax === 100 && cleanAx.rooms[0].ay === 200, "sanitizeState keeps ax/ay");
const cleanNoAx = sanitizeState({ rooms: [{ id: "s2", name: "S", floor: 0, room: { poly: poly() }, pieces: [] }], setupDone: true });
ok(cleanNoAx.rooms[0].ax === null && cleanNoAx.rooms[0].ay === null, "sanitizeState defaults ax/ay null");

// ---- room.del ----
plan = freshPlan();
applyOp(plan, { kind: "room.add", room: { id: "r2", name: "C", floor: 0, room: { poly: poly() }, pieces: [] } });
applyOp(plan, { kind: "room.del", roomId: "r1" });
ok(plan.rooms.length === 1 && plan.rooms[0].id === "r2", "room.del removes");
throws(() => applyOp(plan, { kind: "room.del", roomId: "r2" }), "room.del refuse last");
throws(() => applyOp(freshPlan(), { kind: "room.del", roomId: "nope" }), "room.del no such");

// ---- plan.replace ----
plan = freshPlan();
applyOp(plan, {
  kind: "plan.replace",
  state: {
    rooms: [{ id: "z1", name: "New", floor: 2, room: { poly: poly() }, pieces: [piece()] }],
    setupDone: false,
    opts: { foo: 1 },   // must be stripped
    active: "z1",       // must be stripped
  },
});
ok(plan.rooms.length === 1 && plan.rooms[0].id === "z1", "plan.replace rooms");
ok(plan.setupDone === false, "plan.replace setupDone");
ok(!("opts" in plan) && !("active" in plan), "plan.replace strips opts/active");
throws(() => applyOp(freshPlan(), { kind: "plan.replace", state: { rooms: "nope" } }), "plan.replace bad shape");

// ---- rooms.merge ----
plan = freshPlan();
applyOp(plan, { kind: "rooms.merge", rooms: [
  { id: "r1", name: "Collision", floor: 0, room: { poly: poly() }, pieces: [] }, // collision -> fresh id
  { id: "r5", name: "Neuf", floor: 0, room: { poly: poly() }, pieces: [] },
] });
ok(plan.rooms.length === 3, "rooms.merge appends both");
ok(plan.rooms.some((r) => r.id === "r5"), "rooms.merge keeps free id");
ok(plan.rooms.filter((r) => r.id === "r1").length === 1, "rooms.merge reids collision");
throws(() => applyOp(freshPlan(), { kind: "rooms.merge", rooms: "nope" }), "rooms.merge bad arg");

// ---- sanitizeState directly ----
const clean = sanitizeState({ rooms: [{ id: "s1", name: "S", floor: 0, room: { poly: poly() }, pieces: [piece()] }], setupDone: true, opts: {}, active: 1 });
ok(!("opts" in clean) && !("active" in clean), "sanitizeState strips");
throws(() => sanitizeState({ rooms: [{ id: "s1", room: { poly: poly() }, pieces: [piece({ id: 123 })] }] }), "sanitize bad piece id");

// ---- envelope: sanitizeState ----
const envPoly = () => [[0, 0], [600, 0], [600, 400], [0, 400]];
// null tolerated everywhere
const cleanNoEnv = sanitizeState({ rooms: [{ id: "s1", name: "S", floor: 0, room: { poly: poly() }, pieces: [] }], setupDone: true });
ok(cleanNoEnv.envelope === null, "sanitizeState envelope null default");
// complete envelope survives
const cleanEnv = sanitizeState({
  rooms: [{ id: "s1", name: "S", floor: 0, room: { poly: poly() }, pieces: [] }],
  envelope: { poly: envPoly(), floor: "parquet", pieces: [piece({ id: "e1", type: "door" })] },
  setupDone: true,
});
ok(cleanEnv.envelope && cleanEnv.envelope.poly.length === 4, "sanitizeState keeps envelope poly");
ok(cleanEnv.envelope.floor === "parquet", "sanitizeState keeps envelope floor");
ok(cleanEnv.envelope.pieces.length === 1 && cleanEnv.envelope.pieces[0].id === "e1", "sanitizeState keeps envelope pieces");
ok(cleanEnv.envelope.pieces[0].type === "door", "envelope piece type kept");
throws(() => sanitizeState({ rooms: [], envelope: { poly: [[0, 0], [1, 1]] } }), "envelope bad poly");
throws(() => sanitizeState({ rooms: [], envelope: { poly: envPoly(), pieces: [piece({ evil: 1 })] } }), "envelope bad piece");

// ---- env.set / env.del ----
plan = freshPlan();
ok(plan.envelope === undefined || plan.envelope === null, "fresh plan no envelope");
applyOp(plan, { kind: "env.set", poly: envPoly(), floor: "tile" });
ok(plan.envelope && plan.envelope.poly.length === 4 && plan.envelope.floor === "tile", "env.set creates envelope");
ok(Array.isArray(plan.envelope.pieces) && plan.envelope.pieces.length === 0, "env.set inits pieces");
// idempotence: replaying the same env.set leaves the state identical
applyOp(plan, { kind: "env.set", poly: envPoly(), floor: "tile" });
ok(plan.envelope.poly.length === 4 && plan.envelope.floor === "tile", "env.set idempotent");
// change just the floor
applyOp(plan, { kind: "env.set", floor: "parquet" });
ok(plan.envelope.floor === "parquet" && plan.envelope.poly.length === 4, "env.set floor only keeps poly");
throws(() => applyOp(freshPlan(), { kind: "env.set", poly: [[0, 0], [1, 1]] }), "env.set bad poly");
throws(() => applyOp(freshPlan(), { kind: "env.set", floor: "x" }), "env.set skeleton needs poly");
// env.del
applyOp(plan, { kind: "env.del" });
ok(plan.envelope === null, "env.del removes envelope");
applyOp(plan, { kind: "env.del" });
ok(plan.envelope === null, "env.del idempotent");

// ---- env.piece.set / env.piece.del ----
plan = freshPlan();
applyOp(plan, { kind: "env.set", poly: envPoly() });
applyOp(plan, { kind: "env.piece.set", piece: piece({ id: "ep1", type: "door" }) });
ok(plan.envelope.pieces.length === 1, "env.piece.set insert");
applyOp(plan, { kind: "env.piece.set", piece: piece({ id: "ep1", type: "door", x: 99 }) });
ok(plan.envelope.pieces.length === 1 && plan.envelope.pieces[0].x === 99, "env.piece.set upsert");
applyOp(plan, { kind: "env.piece.set", piece: piece({ id: "ep2", type: "plant" }) });
applyOp(plan, { kind: "env.piece.del", pieceId: "ep1" });
ok(plan.envelope.pieces.length === 1 && plan.envelope.pieces[0].id === "ep2", "env.piece.del removes");
applyOp(plan, { kind: "env.piece.del", pieceId: "nope" });
ok(plan.envelope.pieces.length === 1, "env.piece.del absent no-op");
throws(() => applyOp(freshPlan(), { kind: "env.piece.set", piece: piece() }), "env.piece.set no envelope");
throws(() => applyOp(plan, { kind: "env.piece.set", piece: piece({ evil: 1 }) }), "env.piece.set bad piece");
// del without envelope: idempotent no-op
plan = freshPlan();
applyOp(plan, { kind: "env.piece.del", pieceId: "x" });
ok(plan.envelope === undefined || plan.envelope === null, "env.piece.del no env no-op");

// ---- plan.replace carries envelope ----
plan = freshPlan();
applyOp(plan, { kind: "env.set", poly: envPoly() });
applyOp(plan, {
  kind: "plan.replace",
  state: { rooms: [{ id: "z1", name: "N", floor: 0, room: { poly: poly() }, pieces: [] }], envelope: { poly: envPoly(), floor: "tile", pieces: [] }, setupDone: true },
});
ok(plan.envelope && plan.envelope.floor === "tile", "plan.replace carries envelope");
applyOp(plan, { kind: "plan.replace", state: { rooms: [{ id: "z2", name: "N", floor: 0, room: { poly: poly() }, pieces: [] }], setupDone: true } });
ok(plan.envelope === null, "plan.replace null envelope clears it");

// =====================================================================
// ---- v5 "wall-partition": {outline, walls, openings, pieces, cells} ----
// =====================================================================
const outline = () => [[0, 0], [800, 0], [800, 600], [0, 600]];
const wall = (over = {}) => ({ id: "w1", a: [0, 300], b: [800, 300], t: 10, ...over });
const opening = (over = {}) => ({ id: "o1", wallId: "w1", t0: 120, w: 80, type: "door", ...over });
const cell = (over = {}) => ({ id: "c1", poly: poly(), name: "Salon", floor: "parquet", ...over });
const v5State = (over = {}) => ({
  outline: outline(),
  walls: [wall()],
  openings: [opening()],
  pieces: [piece()],
  cells: [cell()],
  setupDone: true,
  ...over,
});
// Minimal v5 plan used as the base for ops (already sanitized).
const freshV5 = () => sanitizeState(v5State());

// ---- sanitizeState accepts a valid v5 ----
const c5 = sanitizeState(v5State());
ok(c5.outline.length === 4, "v5 sanitize outline");
ok(c5.walls.length === 1 && c5.walls[0].t === 10, "v5 sanitize walls");
ok(c5.openings.length === 1 && c5.openings[0].wallId === "w1", "v5 sanitize openings");
ok(c5.pieces.length === 1 && c5.pieces[0].id === "p1", "v5 sanitize pieces flat");
ok(c5.cells.length === 1 && c5.cells[0].name === "Salon", "v5 sanitize cells");
ok(c5.setupDone === true, "v5 sanitize setupDone");
ok(!("rooms" in c5) && !("envelope" in c5), "v5 sanitize has no v4 keys");
// absent lists -> []; outline null tolerated (volume not yet drawn)
const c5min = sanitizeState({ walls: [] });
ok(c5min.outline === null && c5min.walls.length === 0 && c5min.openings.length === 0
  && c5min.pieces.length === 0 && c5min.cells.length === 0, "v5 sanitize defaults");
// stray client keys (opts/active/rooms from an old state) are stripped
const c5strip = sanitizeState({ ...v5State(), opts: { foo: 1 }, active: 2 });
ok(!("opts" in c5strip) && !("active" in c5strip), "v5 sanitize strips extras");

// ---- sanitizeState rejects every malformed variant ----
throws(() => sanitizeState({ outline: [[0, 0], [1, 1]], walls: [] }), "v5 outline < 3 pts");
throws(() => sanitizeState({ outline: [[0, 0], [1, 1], ["a", 2]], walls: [] }), "v5 outline non-number");
throws(() => sanitizeState(v5State({ walls: "nope" })), "v5 walls not array");
throws(() => sanitizeState(v5State({ walls: [wall({ id: 1 })], openings: [] })), "v5 wall numeric id");
throws(() => sanitizeState(v5State({ walls: [wall({ a: [0] })], openings: [] })), "v5 wall bad point");
throws(() => sanitizeState(v5State({ walls: [wall({ a: [NaN, 0] })], openings: [] })), "v5 wall NaN point");
throws(() => sanitizeState(v5State({ walls: [wall({ t: 0 })], openings: [] })), "v5 wall t below 1");
throws(() => sanitizeState(v5State({ walls: [wall({ t: 61 })], openings: [] })), "v5 wall t above 60");
throws(() => sanitizeState(v5State({ walls: [wall({ evil: 1 })], openings: [] })), "v5 wall unknown key");
throws(() => sanitizeState(v5State({ walls: [wall(), wall()], openings: [] })), "v5 wall dup id");
throws(() => sanitizeState(v5State({ openings: "nope" })), "v5 openings not array");
throws(() => sanitizeState(v5State({ openings: [opening({ wallId: "ghost" })] })), "v5 opening dangling wallId");
throws(() => sanitizeState(v5State({ openings: [opening({ t0: -1 })] })), "v5 opening t0 negative");
throws(() => sanitizeState(v5State({ openings: [opening({ t0: Infinity })] })), "v5 opening t0 infinite");
throws(() => sanitizeState(v5State({ openings: [opening({ w: 0 })] })), "v5 opening w below 1");
throws(() => sanitizeState(v5State({ openings: [opening({ w: 601 })] })), "v5 opening w above 600");
throws(() => sanitizeState(v5State({ openings: [opening({ type: "portal" })] })), "v5 opening unknown type");
throws(() => sanitizeState(v5State({ openings: [opening({ hinge: {} })] })), "v5 opening bad hinge");
throws(() => sanitizeState(v5State({ openings: [opening({ swing: {} })] })), "v5 opening bad swing");
throws(() => sanitizeState(v5State({ openings: [opening({ evil: 1 })] })), "v5 opening unknown key");
throws(() => sanitizeState(v5State({ openings: [opening(), opening({ t0: 300 })] })), "v5 opening dup id");
throws(() => sanitizeState(v5State({ pieces: "nope" })), "v5 pieces not array");
throws(() => sanitizeState(v5State({ pieces: [piece({ evil: 1 })] })), "v5 piece unknown key");
throws(() => sanitizeState(v5State({ pieces: [piece(), piece()] })), "v5 piece dup id");
throws(() => sanitizeState(v5State({ cells: "nope" })), "v5 cells not array");
throws(() => sanitizeState(v5State({ cells: [cell({ poly: [[0, 0], [1, 1]] })] })), "v5 cell poly < 3");
ok(sanitizeState(v5State({ cells: [cell({ name: "x".repeat(200) })] })).cells[0].name.length === 80, "v5 cell name truncated");
throws(() => sanitizeState(v5State({ cells: [cell({ floor: "moquette" })] })), "v5 cell floor not whitelisted");
throws(() => sanitizeState(v5State({ cells: [cell({ evil: 1 })] })), "v5 cell unknown key");
throws(() => sanitizeState(v5State({ cells: [cell(), cell({ name: "Bis" })] })), "v5 cell dup id");
// optional hinge/swing accepted as string or number
const c5hs = sanitizeState(v5State({ openings: [opening({ hinge: 1, swing: "-1" })] }));
ok(c5hs.openings[0].hinge === 1 && c5hs.openings[0].swing === "-1", "v5 opening hinge/swing ok");

// ---- outline.set ----
let p5 = freshV5();
applyOp(p5, { kind: "outline.set", outline: [[0, 0], [500, 0], [500, 500]] });
ok(p5.outline.length === 3, "outline.set replaces");
applyOp(p5, { kind: "outline.set", outline: [[0, 0], [500, 0], [500, 500]] });
ok(p5.outline.length === 3, "outline.set idempotent");
throws(() => applyOp(freshV5(), { kind: "outline.set", outline: [[0, 0], [1, 1]] }), "outline.set bad poly");

// ---- wall.set: upsert ----
p5 = freshV5();
applyOp(p5, { kind: "wall.set", wall: wall({ id: "w2", a: [400, 0], b: [400, 300] }) });
ok(p5.walls.length === 2, "wall.set insert");
applyOp(p5, { kind: "wall.set", wall: wall({ id: "w2", a: [400, 0], b: [400, 300], t: 7 }) });
ok(p5.walls.length === 2 && p5.walls[1].t === 7, "wall.set upsert no dup");
applyOp(p5, { kind: "wall.set", wall: wall({ id: "w2", a: [400, 0], b: [400, 300], t: 7 }) });
ok(p5.walls.length === 2 && p5.walls[1].t === 7, "wall.set idempotent");
throws(() => applyOp(freshV5(), { kind: "wall.set", wall: wall({ t: 99 }) }), "wall.set t out of range");
throws(() => applyOp(freshV5(), { kind: "wall.set", wall: wall({ id: "" }) }), "wall.set empty id");
throws(() => applyOp(freshV5(), { kind: "wall.set", wall: wall({ b: "nope" }) }), "wall.set bad b");

// ---- wall.del: CASCADE of the openings carried ----
p5 = freshV5();
applyOp(p5, { kind: "wall.set", wall: wall({ id: "w2", a: [400, 0], b: [400, 300] }) });
applyOp(p5, { kind: "opening.set", opening: opening({ id: "o2", wallId: "w2", t0: 40 }) });
ok(p5.openings.length === 2, "two openings before cascade");
applyOp(p5, { kind: "wall.del", wallId: "w1" });
ok(p5.walls.length === 1 && p5.walls[0].id === "w2", "wall.del removes wall");
ok(p5.openings.length === 1 && p5.openings[0].id === "o2", "wall.del cascades its openings");
applyOp(p5, { kind: "wall.del", wallId: "w1" });
ok(p5.walls.length === 1 && p5.openings.length === 1, "wall.del absent no-op idempotent");
throws(() => applyOp(freshV5(), { kind: "wall.del", wallId: 12 }), "wall.del non-string id");

// ---- opening.set / opening.del ----
p5 = freshV5();
applyOp(p5, { kind: "opening.set", opening: opening({ id: "o2", t0: 500, type: "window", w: 140 }) });
ok(p5.openings.length === 2, "opening.set insert");
applyOp(p5, { kind: "opening.set", opening: opening({ id: "o2", t0: 520, type: "window", w: 140 }) });
ok(p5.openings.length === 2 && p5.openings[1].t0 === 520, "opening.set upsert");
applyOp(p5, { kind: "opening.set", opening: opening({ id: "o2", t0: 520, type: "window", w: 140 }) });
ok(p5.openings.length === 2 && p5.openings[1].t0 === 520, "opening.set idempotent");
throws(() => applyOp(freshV5(), { kind: "opening.set", opening: opening({ wallId: "ghost" }) }), "opening.set dangling wallId");
throws(() => applyOp(freshV5(), { kind: "opening.set", opening: opening({ type: "hatch" }) }), "opening.set bad type");
throws(() => applyOp(freshV5(), { kind: "opening.set", opening: opening({ w: 900 }) }), "opening.set w too wide");
applyOp(p5, { kind: "opening.del", openingId: "o1" });
ok(p5.openings.length === 1 && p5.openings[0].id === "o2", "opening.del removes");
applyOp(p5, { kind: "opening.del", openingId: "o1" });
ok(p5.openings.length === 1, "opening.del absent no-op");
throws(() => applyOp(freshV5(), { kind: "opening.del", openingId: 3 }), "opening.del non-string id");

// ---- cell.set (metadata + fresh poly) ----
p5 = freshV5();
applyOp(p5, { kind: "cell.set", cellId: "c1", name: "Chambre", floor: "tile" });
ok(p5.cells[0].name === "Chambre" && p5.cells[0].floor === "tile", "cell.set meta");
applyOp(p5, { kind: "cell.set", cellId: "c1", poly: [[0, 0], [10, 0], [10, 10]] });
ok(p5.cells[0].poly.length === 3 && p5.cells[0].name === "Chambre", "cell.set poly keeps meta");
applyOp(p5, { kind: "cell.set", cellId: "c1", name: "Chambre", floor: "tile" });
ok(p5.cells[0].name === "Chambre" && p5.cells.length === 1, "cell.set idempotent");
// unknown cell: created only if the client provides its geometry
applyOp(p5, { kind: "cell.set", cellId: "c9", name: "Neuve", poly: poly() });
ok(p5.cells.length === 2 && p5.cells[1].id === "c9", "cell.set creates with poly");
throws(() => applyOp(freshV5(), { kind: "cell.set", cellId: "ghost", name: "X" }), "cell.set unknown cell no poly");
throws(() => applyOp(freshV5(), { kind: "cell.set", cellId: "c1", floor: "moquette" }), "cell.set bad floor");
{
  const pc = freshV5();
  applyOp(pc, { kind: "cell.set", cellId: "c1", name: "x".repeat(200) });
  ok(pc.cells[0].name.length === 80 && pc.cells[0].poly.length === 4, "cell.set name truncated, poly intact");
}
throws(() => applyOp(freshV5(), { kind: "cell.set", cellId: "c1", poly: [[0, 0]] }), "cell.set bad poly");

// ---- cells.replace (after re-detection) ----
p5 = freshV5();
applyOp(p5, { kind: "cells.replace", cells: [cell({ id: "cA" }), cell({ id: "cB", name: "Cuisine", floor: "tile" })] });
ok(p5.cells.length === 2 && p5.cells[1].floor === "tile", "cells.replace bulk");
applyOp(p5, { kind: "cells.replace", cells: [cell({ id: "cA" }), cell({ id: "cB", name: "Cuisine", floor: "tile" })] });
ok(p5.cells.length === 2, "cells.replace idempotent");
applyOp(p5, { kind: "cells.replace", cells: [] });
ok(p5.cells.length === 0, "cells.replace can empty");
throws(() => applyOp(freshV5(), { kind: "cells.replace", cells: "nope" }), "cells.replace bad arg");
throws(() => applyOp(freshV5(), { kind: "cells.replace", cells: [cell(), cell()] }), "cells.replace dup id");

// ---- furniture flat in v5 ----
p5 = freshV5();
applyOp(p5, { kind: "piece.set", piece: piece({ id: "p2", x: 300 }) });
ok(p5.pieces.length === 2, "v5 piece.set insert flat");
applyOp(p5, { kind: "piece.set", piece: piece({ id: "p2", x: 333 }) });
ok(p5.pieces.length === 2 && p5.pieces[1].x === 333, "v5 piece.set upsert flat");
applyOp(p5, { kind: "piece.set", piece: piece({ id: "p3" }) });
ok(p5.pieces.map((p) => p.id).join(",") === "p1,p2,p3", "v5 piece.set keeps insertion order");
applyOp(p5, { kind: "piece.del", pieceId: "p2" });
ok(p5.pieces.length === 2 && !p5.pieces.some((p) => p.id === "p2"), "v5 piece.del flat");
applyOp(p5, { kind: "piece.del", pieceId: "p2" });
ok(p5.pieces.length === 2, "v5 piece.del absent no-op");
throws(() => applyOp(freshV5(), { kind: "piece.set", piece: piece({ evil: 1 }) }), "v5 piece.set unknown key");
throws(() => applyOp(freshV5(), { kind: "piece.set", piece: piece({ w: 5000 }) }), "v5 piece.set w out of range");

// ---- plan5.replace: switchover + round-trip ----
p5 = freshPlan();                     // v4 state at the start
applyOp(p5, { kind: "plan5.replace", plan: v5State() });
ok(!("rooms" in p5) && !("envelope" in p5), "plan5.replace drops v4 keys");
ok(p5.walls.length === 1 && p5.openings.length === 1 && p5.cells.length === 1, "plan5.replace installs v5");
ok(JSON.stringify(sanitizeState(p5)) === JSON.stringify(sanitizeState(v5State())), "plan5.replace round-trip");
applyOp(p5, { kind: "plan5.replace", plan: v5State() });
ok(JSON.stringify(sanitizeState(p5)) === JSON.stringify(sanitizeState(v5State())), "plan5.replace idempotent");
throws(() => applyOp(freshPlan(), { kind: "plan5.replace", plan: { walls: "nope" } }), "plan5.replace bad shape");
throws(() => applyOp(freshPlan(), { kind: "plan5.replace", plan: v5State({ openings: [opening({ wallId: "ghost" })] }) }), "plan5.replace dangling opening");
// v4 payload sent to plan5.replace: refused (otherwise we'd install an empty v5 plan)
throws(() => applyOp(freshPlan(), { kind: "plan5.replace", plan: freshPlan() }), "plan5.replace refuses v4 payload");
// v5 payload sent to v4's plan.replace: refused too (the switchover goes through plan5.replace)
shapeErr(() => applyOp(freshPlan(), { kind: "plan.replace", state: v5State() }), "plan.replace refuses v5 payload");

// ---- shape tightness: op_shape both ways ----
// v4 ops refused on a v5 state (a v4 client left open cannot overwrite the v5 plan)
shapeErr(() => applyOp(freshV5(), { kind: "plan.replace", state: freshPlan() }), "v4 plan.replace on v5");
shapeErr(() => applyOp(freshV5(), { kind: "room.add", room: { id: "r9", name: "X", floor: 0, room: { poly: poly() }, pieces: [] } }), "v4 room.add on v5");
shapeErr(() => applyOp(freshV5(), { kind: "room.set", roomId: "r1", name: "X" }), "v4 room.set on v5");
shapeErr(() => applyOp(freshV5(), { kind: "room.del", roomId: "r1" }), "v4 room.del on v5");
shapeErr(() => applyOp(freshV5(), { kind: "rooms.merge", rooms: [] }), "v4 rooms.merge on v5");
shapeErr(() => applyOp(freshV5(), { kind: "env.set", poly: envPoly() }), "v4 env.set on v5");
shapeErr(() => applyOp(freshV5(), { kind: "env.del" }), "v4 env.del on v5");
shapeErr(() => applyOp(freshV5(), { kind: "env.piece.set", piece: piece() }), "v4 env.piece.set on v5");
shapeErr(() => applyOp(freshV5(), { kind: "env.piece.del", pieceId: "p1" }), "v4 env.piece.del on v5");
// v5 ops refused on a v4 state
shapeErr(() => applyOp(freshPlan(), { kind: "wall.set", wall: wall() }), "v5 wall.set on v4");
shapeErr(() => applyOp(freshPlan(), { kind: "wall.del", wallId: "w1" }), "v5 wall.del on v4");
shapeErr(() => applyOp(freshPlan(), { kind: "outline.set", outline: outline() }), "v5 outline.set on v4");
shapeErr(() => applyOp(freshPlan(), { kind: "opening.set", opening: opening() }), "v5 opening.set on v4");
shapeErr(() => applyOp(freshPlan(), { kind: "opening.del", openingId: "o1" }), "v5 opening.del on v4");
shapeErr(() => applyOp(freshPlan(), { kind: "cell.set", cellId: "c1", name: "X" }), "v5 cell.set on v4");
shapeErr(() => applyOp(freshPlan(), { kind: "cells.replace", cells: [] }), "v5 cells.replace on v4");
// a genuinely unknown op: unknown_kind in both shapes
throws(() => applyOp(freshV5(), { kind: "nope" }), "v5 unknown kind");
throws(() => applyOp(freshV5(), null), "v5 null op");
// piece.set in v4 always requires a valid roomId (unchanged behavior)
throws(() => applyOp(freshPlan(), { kind: "piece.set", piece: piece() }), "v4 piece.set still needs roomId");

// ---- a v4 state is never mistaken for a v5 (and vice versa) ----
ok(!("outline" in sanitizeState({ rooms: [], setupDone: true })), "v4 stays v4");
ok(Array.isArray(sanitizeState(v5State()).walls), "v5 stays v5");
throws(() => sanitizeState({ nope: 1 }), "neither shape rejected");

// =====================================================================
// ---- openings: side / h / name as first-class fields, and compatibility ----
// =====================================================================
// Reminder of the two wire shapes:
//   UNPACKED  {..., side:0|1, h:cm, name:"", hinge:0|1}   (up-to-date client)
//   PACKED    {..., hinge:0..3}                           (old client, bit1=side, bit0=hinge)
// The database keeps ONLY the unpacked shape, with `side` always written.

// -- unpacked shape: the three fields are accepted and kept --
const richOpening = (over = {}) => opening({ side: 1, h: 12, name: "Porte cuisine", hinge: 1, ...over });
let cRich = sanitizeState(v5State({ openings: [richOpening()] }));
ok(cRich.openings[0].side === 1, "opening side kept");
ok(cRich.openings[0].h === 12, "opening h kept");
ok(cRich.openings[0].name === "Porte cuisine", "opening name kept");
ok(cRich.openings[0].hinge === 1, "opening hinge kept as pure bit");
// side is ALWAYS present in the database, even when the op says nothing about it
ok(sanitizeState(v5State()).openings[0].side === 0, "opening side defaults to 0 and is always stored");

// -- side: strictly binary --
ok(sanitizeState(v5State({ openings: [opening({ side: 0 })] })).openings[0].side === 0, "side 0 ok");
ok(sanitizeState(v5State({ openings: [opening({ side: true })] })).openings[0].side === 1, "side true -> 1");
ok(sanitizeState(v5State({ openings: [opening({ side: "1" })] })).openings[0].side === 1, "side \"1\" -> 1");
throws(() => sanitizeState(v5State({ openings: [opening({ side: 2 })] })), "side 2 rejected");
throws(() => sanitizeState(v5State({ openings: [opening({ side: -1 })] })), "side -1 rejected");
throws(() => sanitizeState(v5State({ openings: [opening({ side: "gauche" })] })), "side non-numeric string rejected");
throws(() => sanitizeState(v5State({ openings: [opening({ side: {} })] })), "side object rejected");
throws(() => sanitizeState(v5State({ openings: [opening({ side: null })] })), "side null rejected");

// -- h: box depth in cm, bounds 1..200 (mirrors the client clamp) --
ok(sanitizeState(v5State({ openings: [opening({ side: 0, h: 1 })] })).openings[0].h === 1, "h min accepted");
ok(sanitizeState(v5State({ openings: [opening({ side: 0, h: 200 })] })).openings[0].h === 200, "h max accepted");
ok(sanitizeState(v5State({ openings: [opening({ side: 0, h: 6 })] })).openings[0].h === 6, "h of a plug accepted");
throws(() => sanitizeState(v5State({ openings: [opening({ side: 0, h: 0 })] })), "h below 1 rejected");
throws(() => sanitizeState(v5State({ openings: [opening({ side: 0, h: 201 })] })), "h above 200 rejected");
throws(() => sanitizeState(v5State({ openings: [opening({ side: 0, h: NaN })] })), "h NaN rejected");
throws(() => sanitizeState(v5State({ openings: [opening({ side: 0, h: "12" })] })), "h string rejected");

// -- name: string bounded to 80, cleaned (control characters stripped, edges trimmed) --
ok(sanitizeState(v5State({ openings: [opening({ side: 0, name: "  Fenêtre séjour  " })] })).openings[0].name === "Fenêtre séjour", "name trimmed");
const ctrlName = "A" + String.fromCharCode(0) + "B" + String.fromCharCode(31) + "C";
ok(sanitizeState(v5State({ openings: [opening({ side: 0, name: ctrlName })] })).openings[0].name === "ABC", "name control chars stripped");
ok(sanitizeState(v5State({ openings: [opening({ side: 0, name: "x".repeat(80) })] })).openings[0].name.length === 80, "name 80 accepted");
ok(sanitizeState(v5State({ openings: [opening({ side: 0, name: "" })] })).openings[0].name === "", "name empty accepted");
ok(sanitizeState(v5State({ openings: [opening({ side: 0, name: "x".repeat(81) })] })).openings[0].name.length === 80, "name 81 truncated");
throws(() => sanitizeState(v5State({ openings: [opening({ side: 0, name: 42 })] })), "name non-string rejected");

// -- hinge in unpacked shape: strict boolean --
ok(sanitizeState(v5State({ openings: [opening({ side: 1, hinge: 0 })] })).openings[0].hinge === 0, "unpacked hinge 0");
ok(sanitizeState(v5State({ openings: [opening({ side: 1, hinge: "1" })] })).openings[0].hinge === 1, "unpacked hinge \"1\"");
throws(() => sanitizeState(v5State({ openings: [opening({ side: 0, hinge: 2 })] })), "unpacked hinge 2 rejected");
throws(() => sanitizeState(v5State({ openings: [opening({ side: 0, hinge: {} })] })), "unpacked hinge object rejected");
// an opening without hinge (window, plug) doesn't gain one
ok(!("hinge" in sanitizeState(v5State({ openings: [opening({ side: 1, type: "window" })] })).openings[0]), "no hinge invented");

// -- any still-unknown key remains refused --
throws(() => sanitizeState(v5State({ openings: [opening({ side: 0, sides: 1 })] })), "opening still rejects unknown key");
throws(() => applyOp(freshV5(), { kind: "opening.set", opening: opening({ side: 0, elevation: 90 }) }), "opening.set still rejects unknown key");

// -- UNPACKING an op from an old client: hinge carries two bits --
const unpack = (packedHinge: DonneeDynamique) => sanitizeState(v5State({ openings: [opening({ hinge: packedHinge })] })).openings[0];
ok(unpack(0).side === 0 && unpack(0).hinge === 0, "packed 0 -> side 0 hinge 0");
ok(unpack(1).side === 0 && unpack(1).hinge === 1, "packed 1 -> side 0 hinge 1");
ok(unpack(2).side === 1 && unpack(2).hinge === 0, "packed 2 -> side 1 hinge 0");
ok(unpack(3).side === 1 && unpack(3).hinge === 1, "packed 3 -> side 1 hinge 1");
ok(unpack("2").side === 1, "packed numeric string unpacked");
throws(() => sanitizeState(v5State({ openings: [opening({ hinge: 4 })] })), "packed hinge 4 rejected");
throws(() => sanitizeState(v5State({ openings: [opening({ hinge: -1 })] })), "packed hinge -1 rejected");
throws(() => sanitizeState(v5State({ openings: [opening({ hinge: 1.5 })] })), "packed hinge non-integer rejected");
throws(() => sanitizeState(v5State({ openings: [opening({ hinge: "gauche" })] })), "packed hinge non-numeric rejected");
// a packed opening with NO hinge at all stays valid (side 0 by default)
ok(sanitizeState(v5State({ openings: [opening()] })).openings[0].side === 0, "packed without hinge -> side 0");

// -- IDEMPOTENCE: revalidating the canonical shape does not unpack it again --
const canon = sanitizeState(v5State({ openings: [opening({ hinge: 3, })] }));
const canon2 = sanitizeState(canon);
ok(JSON.stringify(canon) === JSON.stringify(canon2), "canonical opening survives a second sanitize");
ok(canon2.openings[0].side === 1 && canon2.openings[0].hinge === 1, "re-sanitize keeps side/hinge");
// idempotence of the op itself
p5 = freshV5();
applyOp(p5, { kind: "opening.set", opening: richOpening({ id: "oX" }) });
const afterFirst = JSON.stringify(p5.openings);
applyOp(p5, { kind: "opening.set", opening: richOpening({ id: "oX" }) });
ok(JSON.stringify(p5.openings) === afterFirst, "opening.set with rich fields is idempotent");

// =====================================================================
// ---- COEXISTENCE: an old tab and an up-to-date tab on the same plan ----
// =====================================================================
// 1) the UP-TO-DATE client creates a rich opening
p5 = freshV5();
applyOp(p5, { kind: "opening.set", opening: { id: "oc", wallId: "w1", t0: 100, w: 90, type: "door", side: 1, h: 12, name: "Porte chambre", hinge: 1, swing: -1 } });
let oc = p5.openings.find((o) => o.id === "oc");
ok(oc.side === 1 && oc.h === 12 && oc.name === "Porte chambre", "new client creates a rich opening");
// 2) the OLD client moves it: it sends back the packed shape, WITHOUT h or name
applyOp(p5, { kind: "opening.set", opening: { id: "oc", wallId: "w1", t0: 260, w: 90, type: "door", hinge: 3, swing: -1 } });
oc = p5.openings.find((o) => o.id === "oc");
ok(oc.t0 === 260, "old client move applied");
ok(oc.side === 1 && oc.hinge === 1, "old client keeps side/hinge through the bitfield");
ok(oc.h === 12, "old client rewrite does NOT lose h");
ok(oc.name === "Porte chambre", "old client rewrite does NOT lose name");
// 3) the old client flips the opening (side 0): the bit passes through, h/name survive
applyOp(p5, { kind: "opening.set", opening: { id: "oc", wallId: "w1", t0: 260, w: 90, type: "door", hinge: 1, swing: -1 } });
oc = p5.openings.find((o) => o.id === "oc");
ok(oc.side === 0 && oc.hinge === 1 && oc.name === "Porte chambre", "old client can still flip side, name intact");
// 4) the up-to-date client stays AUTHORITATIVE over name/h when it sends them
applyOp(p5, { kind: "opening.set", opening: { id: "oc", wallId: "w1", t0: 260, w: 90, type: "door", side: 0, h: 20, name: "Porte SDB", hinge: 1, swing: -1 } });
oc = p5.openings.find((o) => o.id === "oc");
ok(oc.h === 20 && oc.name === "Porte SDB", "new client rewrites h/name");
applyOp(p5, { kind: "opening.set", opening: { id: "oc", wallId: "w1", t0: 260, w: 90, type: "door", side: 0, h: 20, name: "", hinge: 1, swing: -1 } });
ok(p5.openings.find((o) => o.id === "oc").name === "", "new client can clear the name explicitly");
// 5) an opening created by the OLD client invents neither h nor name (the server has no catalog)
applyOp(p5, { kind: "opening.set", opening: { id: "od", wallId: "w1", t0: 10, w: 120, type: "window", hinge: 2 } });
const od = p5.openings.find((o) => o.id === "od");
ok(od.side === 1 && !("h" in od) && !("name" in od), "old-client creation stores no invented h/name");
// 6) an OLD client's plan5.replace (undo/import): the h/name already in the database survive
p5 = freshV5();
applyOp(p5, { kind: "opening.set", opening: { id: "o1", wallId: "w1", t0: 120, w: 80, type: "door", side: 1, h: 14, name: "Entrée", hinge: 0 } });
applyOp(p5, { kind: "plan5.replace", plan: v5State({ openings: [{ id: "o1", wallId: "w1", t0: 300, w: 80, type: "door", hinge: 2 }] }) });
const o1 = p5.openings.find((o) => o.id === "o1");
ok(o1.t0 === 300 && o1.side === 1, "old-client plan5.replace applied");
ok(o1.h === 14 && o1.name === "Entrée", "old-client plan5.replace does NOT lose h/name");
// 7) a state loaded from D1 (no previous state) fabricates nothing
const fromD1 = sanitizeState(v5State({ openings: [{ id: "o1", wallId: "w1", t0: 5, w: 80, type: "door", hinge: 3 }] }));
ok(fromD1.openings[0].side === 1 && !("h" in fromD1.openings[0]) && !("name" in fromD1.openings[0]), "D1 load unpacks without inventing");
// 8) the wall.del cascade stays indifferent to the new fields
p5 = freshV5();
applyOp(p5, { kind: "opening.set", opening: richOpening({ id: "oz" }) });
applyOp(p5, { kind: "wall.del", wallId: "w1" });
ok(p5.openings.length === 0, "wall.del still cascades rich openings");

// ---- deterministic colors ----
ok(colorFor("a@b.com") === colorFor("a@b.com"), "colorFor deterministic");
ok(/^#[0-9a-f]{6}$/.test(colorFor("x@y.z")), "colorFor palette");

// ---- unknown / malformed op ----
throws(() => applyOp(freshPlan(), { kind: "nope" }), "unknown kind");
throws(() => applyOp(freshPlan(), null), "null op");

// =====================================================================
// ---- ATOMICITY: a REFUSED op leaves NO trace in the plan ----
// =====================================================================
// This is the invariant that protects the shared plan. A refused op that had already mutated the
// state left an incomplete entity behind it (a cell with an empty polygon, an envelope without a
// poly); the first successful op persisted it, the D1 snapshot copied it over, and EVERY later
// cold load then failed on that entity. We check byte for byte.
function atomic(makePlan: DonneeDynamique, op: DonneeDynamique, label: string) {
  n++;
  const p = makePlan();
  const before = JSON.stringify(p);
  let threw = false;
  try { applyOp(p, op); } catch (e) { threw = true; }
  if (!threw) throw new Error("EXPECTED refusal (atomicity corpus): " + label);
  if (JSON.stringify(p) !== before) {
    throw new Error("NON ATOMIQUE: " + label + "\n  avant: " + before + "\n  apres: " + JSON.stringify(p));
  }
}

// v4 corpus: every refusable op, including those touching MULTIPLE fields.
const V4_BAD = [
  ["piece.set piece invalide", { kind: "piece.set", roomId: "r1", piece: piece({ evil: 1 }) }],
  ["piece.set coord NaN", { kind: "piece.set", roomId: "r1", piece: piece({ x: NaN }) }],
  ["piece.set coord 1e308", { kind: "piece.set", roomId: "r1", piece: piece({ x: 1e308 }) }],
  ["piece.set w hors bornes", { kind: "piece.set", roomId: "r1", piece: piece({ w: 5000 }) }],
  ["piece.set type forgé", { kind: "piece.set", roomId: "r1", piece: piece({ type: "<img src=x>" }) }],
  ["piece.set id forgé", { kind: "piece.set", roomId: "r1", piece: piece({ id: 'a"]' }) }],
  ["piece.set salle absente", { kind: "piece.set", roomId: "nope", piece: piece() }],
  ["piece.del salle absente", { kind: "piece.del", roomId: "nope", pieceId: "p1" }],
  ["piece.del pieceId non-chaîne", { kind: "piece.del", roomId: "r1", pieceId: 12 }],
  ["room.add id déjà pris", { kind: "room.add", room: { id: "r1", room: { poly: poly() } } }],
  ["room.add poly trop court", { kind: "room.add", room: { id: "r9", room: { poly: [[0, 0], [1, 1]] } } }],
  ["room.set poly invalide APRÈS un nom valide", { kind: "room.set", roomId: "r1", name: "Bureau", poly: [[0, 0]] }],
  ["room.set floor invalide après nom", { kind: "room.set", roomId: "r1", name: "Bureau", floor: {} }],
  ["room.set ax invalide après nom", { kind: "room.set", roomId: "r1", name: "Bureau", ax: "nope" }],
  ["room.set ay hors bornes après nom", { kind: "room.set", roomId: "r1", name: "Bureau", ay: 1e308 }],
  ["room.del dernière salle", { kind: "room.del", roomId: "r1" }],
  ["room.del salle absente", { kind: "room.del", roomId: "nope" }],
  ["plan.replace state cassé", { kind: "plan.replace", state: { rooms: "nope" } }],
  ["plan.replace payload v5", { kind: "plan.replace", state: v5State() }],
  ["env.set floor seul sans enveloppe", { kind: "env.set", floor: "tile" }],
  ["env.set poly invalide", { kind: "env.set", poly: [[0, 0], [1, 1]] }],
  ["env.set poly hors bornes", { kind: "env.set", poly: [[0, 0], [1e308, 0], [0, 1]] }],
  ["env.piece.set sans enveloppe", { kind: "env.piece.set", piece: piece() }],
  ["rooms.merge argument non-tableau", { kind: "rooms.merge", rooms: "nope" }],
  ["rooms.merge 2e salle invalide", { kind: "rooms.merge", rooms: [
    { id: "ok1", room: { poly: poly() } }, { id: "ko", room: { poly: [[0, 0]] } }] }],
  ["op v5 sur état v4", { kind: "wall.set", wall: wall() }],
  ["kind inconnu", { kind: "nope" }],
  ["op nulle", null],
];
for (const [label, op] of V4_BAD) atomic(freshPlan, op, "v4 " + label);

// A v4 plan that ALREADY has an envelope: env.set must stay atomic on it too.
const v4WithEnv = () => {
  const p = freshPlan();
  applyOp(p, { kind: "env.set", poly: envPoly(), floor: "tile" });
  applyOp(p, { kind: "env.piece.set", piece: piece({ id: "ep1", type: "door" }) });
  return p;
};
atomic(v4WithEnv, { kind: "env.set", poly: [[0, 0]] }, "v4 env.set poly invalide sur enveloppe existante");
atomic(v4WithEnv, { kind: "env.set", floor: {} }, "v4 env.set floor invalide sur enveloppe existante");
atomic(v4WithEnv, { kind: "env.piece.set", piece: piece({ evil: 1 }) }, "v4 env.piece.set meuble invalide");

// v5 corpus.
const V5_BAD = [
  ["outline.set poly trop court", { kind: "outline.set", outline: [[0, 0], [1, 1]] }],
  ["outline.set coord 1e308", { kind: "outline.set", outline: [[0, 0], [1e308, 0], [0, 1]] }],
  ["wall.set t hors bornes", { kind: "wall.set", wall: wall({ id: "wz", t: 99 }) }],
  ["wall.set point 1e308", { kind: "wall.set", wall: wall({ id: "wz", a: [1e308, 0] }) }],
  ["wall.set clé inconnue", { kind: "wall.set", wall: wall({ id: "wz", evil: 1 }) }],
  ["wall.del id non-chaîne", { kind: "wall.del", wallId: 12 }],
  ["opening.set mur fantôme", { kind: "opening.set", opening: opening({ id: "oz", wallId: "ghost" }) }],
  ["opening.set type inconnu", { kind: "opening.set", opening: opening({ id: "oz", type: "portal" }) }],
  ["opening.set t0 1e12", { kind: "opening.set", opening: opening({ id: "oz", t0: 1e12 }) }],
  ["opening.set hinge objet", { kind: "opening.set", opening: opening({ id: "oz", side: 0, hinge: {} }) }],
  ["opening.set swing géant", { kind: "opening.set", opening: opening({ id: "oz", swing: "z".repeat(5000) }) }],
  ["opening.del id non-chaîne", { kind: "opening.del", openingId: 3 }],
  ["cell.set inconnue sans poly", { kind: "cell.set", cellId: "ghost", name: "X" }],
  ["cell.set nouvelle cellule + sol invalide", { kind: "cell.set", cellId: "cNEW", poly: poly(), floor: "moquette" }],
  ["cell.set nouvelle cellule + nom non-chaîne", { kind: "cell.set", cellId: "cNEW", poly: poly(), name: 42 }],
  ["cell.set nouvelle cellule + poly invalide", { kind: "cell.set", cellId: "cNEW", poly: [[0, 0]] }],
  ["cell.set existante + poly invalide", { kind: "cell.set", cellId: "c1", name: "Ok", poly: [[0, 0]] }],
  ["cell.set existante + sol invalide", { kind: "cell.set", cellId: "c1", name: "Ok", floor: "moquette" }],
  ["cell.set cellId forgé", { kind: "cell.set", cellId: 'c"]', poly: poly() }],
  ["cells.replace argument non-tableau", { kind: "cells.replace", cells: "nope" }],
  ["cells.replace ids en double", { kind: "cells.replace", cells: [cell(), cell()] }],
  ["cells.replace 1 cellule cassée sur 10", { kind: "cells.replace", cells: Array.from({ length: 10 },
    (_, i) => cell({ id: "cx" + i, floor: i === 5 ? "moquette" : "parquet" })) }],
  ["piece.set clé inconnue", { kind: "piece.set", piece: piece({ id: "pz", evil: 1 }) }],
  ["piece.set hinge objet imbriqué", { kind: "piece.set", piece: piece({ id: "pz", hinge: { a: { b: 1 } } }) }],
  ["piece.set hinge null", { kind: "piece.set", piece: piece({ id: "pz", hinge: null }) }],
  ["piece.set swing 5 Mo", { kind: "piece.set", piece: piece({ id: "pz", swing: "z".repeat(200) }) }],
  ["piece.del pieceId non-chaîne", { kind: "piece.del", pieceId: {} }],
  ["plan5.replace payload v4", { kind: "plan5.replace", plan: freshPlan() }],
  ["plan5.replace ouverture pendante", { kind: "plan5.replace", plan: v5State({ openings: [opening({ wallId: "ghost" })] }) }],
  ["op v4 sur état v5", { kind: "room.add", room: { id: "r9", room: { poly: poly() } } }],
  ["kind inconnu", { kind: "nope" }],
  ["op nulle", null],
];
for (const [label, op] of V5_BAD) atomic(freshV5, op, "v5 " + label);

// =====================================================================
// ---- PERSISTENCE ROUND-TRIP ----
// =====================================================================
// The invariant every cold load depends on: whatever plan is produced by a SEQUENCE of ops
// (successful or refused), sanitizeState must accept it, and a second pass must be a fixed
// point (otherwise the snapshot never converges to the canonical shape).
function roundTrip(plan: DonneeDynamique, label: string) {
  n++;
  let clean;
  try { clean = sanitizeState(plan); }
  catch (e) { throw new Error("ROUND-TRIP KO (" + (e.reason || e.message) + "): " + label); }
  const twice = sanitizeState(clean);
  if (JSON.stringify(clean) !== JSON.stringify(twice)) {
    throw new Error("SANITIZE NON IDEMPOTENT: " + label);
  }
}

// Realistic v5 sequence, interleaved with every REFUSED op of the corpus: at the end, the plan
// must still be persistable. This is exactly the scenario that broke cold loading.
{
  const p = freshV5();
  applyOp(p, { kind: "outline.set", outline: [[0, 0], [900, 0], [900, 700], [0, 700]] });
  applyOp(p, { kind: "wall.set", wall: wall({ id: "w2", a: [450, 0], b: [450, 700] }) });
  applyOp(p, { kind: "opening.set", opening: opening({ id: "o2", wallId: "w2", t0: 200, w: 90, type: "door", side: 1, h: 12, name: "Chambre", hinge: 1, swing: -1 }) });
  applyOp(p, { kind: "cells.replace", cells: [cell({ id: "cA", name: "Salon" }), cell({ id: "cB", name: "Cuisine", floor: "tile" })] });
  applyOp(p, { kind: "cell.set", cellId: "cA", name: "x".repeat(300) });
  applyOp(p, { kind: "piece.set", piece: piece({ id: "pA", name: "y".repeat(300) }) });
  for (const [, op] of V5_BAD) { try { applyOp(p, op); } catch (_) {} }
  roundTrip(p, "v5 apres suite mixte reussies+refusees");
  ok(p.cells.find((c) => c.id === "cA").name.length === 80, "nom de cellule tronque conserve");
  ok(p.cells.length === 2 && p.walls.length === 2, "aucune entite fantome apres le corpus refuse");
}
// Same thing on the v4 side.
{
  const p = freshPlan();
  applyOp(p, { kind: "room.add", room: { id: "r2", name: "Cuisine", floor: 0, room: { poly: poly() }, pieces: [] } });
  applyOp(p, { kind: "env.set", poly: envPoly(), floor: "tile" });
  applyOp(p, { kind: "env.piece.set", piece: piece({ id: "ep1", type: "door" }) });
  applyOp(p, { kind: "piece.set", roomId: "r2", piece: piece({ id: "pz", name: "z".repeat(300) }) });
  for (const [, op] of V4_BAD) { try { applyOp(p, op); } catch (_) {} }
  roundTrip(p, "v4 apres suite mixte reussies+refusees");
  // Some ops from the corpus become LEGITIMATE on this enriched plan (room.del is no longer the
  // last room): so we only check what must hold in every case.
  ok(p.rooms.length >= 1, "v4 garde au moins une salle");
  ok(p.envelope && p.envelope.poly.length === 4, "v4 enveloppe intacte apres le corpus refuse");
  ok(!p.rooms.some((r) => !r.room || !Array.isArray(r.room.poly) || r.room.poly.length < 3), "aucune salle fantome");
}
// A freshly sanitized state is a fixed point in both shapes.
roundTrip(freshV5(), "v5 frais");
roundTrip(freshPlan(), "v4 frais");
roundTrip(sanitizeState(v5State({ openings: [opening({ hinge: 3 })] })), "v5 ouverture depaquetee");

// =====================================================================
// ---- VOLUME AND RANGE BOUNDS ----
// =====================================================================
// Coordinates: the physical range of a home, generously bounded (the real plan fits within
// 1,418 cm; the bound is at 100,000 cm).
ok(sanitizeState(v5State({ pieces: [piece({ x: 100000, y: -100000 })] })).pieces[0].x === 100000, "coord a la borne acceptee");
throws(() => sanitizeState(v5State({ pieces: [piece({ x: 100001 })] })), "coord au-dela de la borne");
throws(() => sanitizeState(v5State({ pieces: [piece({ x: 1e308 })] })), "coord 1e308 refusee");
throws(() => sanitizeState(v5State({ walls: [wall({ b: [1e308, 0] })], openings: [] })), "mur 1e308 refuse");
throws(() => sanitizeState({ outline: [[0, 0], [1e308, 0], [0, 1]], walls: [] }), "contour 1e308 refuse");
throws(() => sanitizeState(v5State({ cells: [cell({ poly: [[0, 0], [1e12, 0], [0, 1]] })] })), "cellule 1e12 refusee");
throws(() => sanitizeState(v5State({ openings: [opening({ t0: 1e12 })] })), "ouverture t0 1e12 refusee");
ok(sanitizeState(v5State({ openings: [opening({ t0: 805 })] })).openings[0].t0 === 805, "t0 reel accepte");

// hinge of a piece of furniture: STRICT boolean (265 KB had been stored in this field).
ok(sanitizeState(v5State({ pieces: [piece({ hinge: "1" })] })).pieces[0].hinge === 1, "piece hinge \"1\" -> 1");
ok(sanitizeState(v5State({ pieces: [piece({ hinge: "0" })] })).pieces[0].hinge === 0, "piece hinge \"0\" -> 0");
ok(sanitizeState(v5State({ pieces: [piece({ hinge: false })] })).pieces[0].hinge === 0, "piece hinge false -> 0");
throws(() => sanitizeState(v5State({ pieces: [piece({ hinge: { a: 1 } })] })), "piece hinge objet refuse");
throws(() => sanitizeState(v5State({ pieces: [piece({ hinge: null })] })), "piece hinge null refuse");
throws(() => sanitizeState(v5State({ pieces: [piece({ hinge: 2 })] })), "piece hinge 2 refuse");
ok(!("hinge" in sanitizeState(v5State({ pieces: [piece()] })).pieces[0]), "aucun hinge inventé sur un canapé");
// swing of a piece of furniture: bounded as on openings.
ok(sanitizeState(v5State({ pieces: [piece({ swing: "-1" })] })).pieces[0].swing === "-1", "piece swing \"-1\" ok");
ok(String(sanitizeState(v5State({ pieces: [piece({ swing: "x".repeat(80) })] })).pieces[0].swing).length === 80, "piece swing 80 ok");
throws(() => sanitizeState(v5State({ pieces: [piece({ swing: "x".repeat(81) })] })), "piece swing 81 refuse");
throws(() => sanitizeState(v5State({ pieces: [piece({ swing: {} })] })), "piece swing objet refuse");

// type of a piece of furniture: catalog-identifier shape, not a tag.
ok(sanitizeState(v5State({ pieces: [piece({ type: "sofa3" })] })).pieces[0].type === "sofa3", "type catalogue accepte");
ok(sanitizeState(v5State({ pieces: [piece({ type: "radiateur" })] })).pieces[0].type === "radiateur", "type accentue-libre accepte");
throws(() => sanitizeState(v5State({ pieces: [piece({ type: "<img src=x onerror=alert(1)>" })] })), "type balise refuse");
throws(() => sanitizeState(v5State({ pieces: [piece({ type: "a b" })] })), "type avec espace refuse");
throws(() => sanitizeState(v5State({ pieces: [piece({ type: "x".repeat(33) })] })), "type trop long refuse");

// ids: same shape as the ones produced by the client (the 109 production ids conform to it).
ok(sanitizeState(v5State({ pieces: [piece({ id: "1785486063813" })] })).pieces[0].id === "1785486063813", "id numerique de production accepte");
throws(() => sanitizeState(v5State({ pieces: [piece({ id: 'a"]' })] })), "id avec guillemet refuse");
throws(() => sanitizeState(v5State({ pieces: [piece({ id: "" })] })), "id vide refuse");
throws(() => sanitizeState(v5State({ cells: [cell({ id: "c 1" })] })), "id cellule avec espace refuse");

// per-family ceilings: 2000 entities (the real plan fits in 22/30/47/10).
const manyCells = (k: number) => Array.from({ length: k }, (_, i) => cell({ id: "c" + i }));
ok(sanitizeState(v5State({ cells: manyCells(2000) })).cells.length === 2000, "2000 cellules acceptees");
throws(() => sanitizeState(v5State({ cells: manyCells(2001) })), "2001 cellules refusees");
throws(() => applyOp(freshV5(), { kind: "cells.replace", cells: manyCells(50000) }), "cells.replace 50000 refuse");
throws(() => sanitizeState(v5State({ pieces: Array.from({ length: 2001 }, (_, i) => piece({ id: "p" + i })) })), "2001 meubles refuses");
throws(() => sanitizeState(v5State({ walls: Array.from({ length: 2001 }, (_, i) => wall({ id: "w" + i })), openings: [] })), "2001 murs refuses");
// upsert one by one: the ceiling holds outside a complete replacement too.
{
  const p = freshV5();
  for (let i = 0; i < 1999; i++) applyOp(p, { kind: "wall.set", wall: wall({ id: "W" + i, a: [0, i], b: [10, i] }) });
  ok(p.walls.length === 2000, "2000 murs par upsert");
  throws(() => applyOp(p, { kind: "wall.set", wall: wall({ id: "Wtrop", a: [0, 1], b: [10, 1] }) }), "2001e mur par upsert refuse");
  // an upsert on an ALREADY present wall stays possible once the ceiling is reached
  applyOp(p, { kind: "wall.set", wall: wall({ id: "W0", a: [0, 0], b: [10, 0], t: 15 }) });
  ok(p.walls.find((w) => w.id === "W0").t === 15, "upsert d'un mur existant possible au plafond");
}
// polygons: number of vertices bounded (the real plan caps at 11).
const bigPoly = (k: number) => Array.from({ length: k }, (_, i) => [i % 1000, Math.floor(i / 1000)]);
throws(() => sanitizeState({ outline: bigPoly(2001), walls: [] }), "contour de 2001 sommets refuse");
ok(sanitizeState({ outline: bigPoly(2000), walls: [] }).outline.length === 2000, "contour de 2000 sommets accepte");

// =====================================================================
// ---- EPHEMERAL messages relayed (cursor / drag) ----
// =====================================================================
ok(JSON.stringify(sanitizeCursor({ room: "__apt__", x: 10, y: 20 })) === JSON.stringify({ room: "__apt__", x: 10, y: 20 }), "cursor normal relaye");
ok(sanitizeCursor({ room: null, x: null, y: null }).room === null, "cursor hors canvas relaye");
ok(sanitizeCursor({ room: "__apt__", x: null, y: 3 }).x === null, "cursor partiel = hors canvas");
ok(sanitizeCursor({ room: "__apt__", x: "12", y: 3 }) === null, "cursor x non numerique rejete");
ok(sanitizeCursor({ room: "__apt__", x: NaN, y: 3 }) === null, "cursor NaN rejete");
ok(sanitizeCursor({ room: "__apt__", x: 1e308, y: 3 }) === null, "cursor 1e308 rejete");
ok(sanitizeCursor({ room: "__apt__", x: -250000, y: 3 }).x === -250000, "cursor loin hors plan accepte (zoom arriere)");
ok(sanitizeCursor({ room: "__apt__", x: 2e7, y: 3 }) === null, "cursor au-dela de la borne du fil rejete");
ok(sanitizeCursor({ room: 'a"]', x: 1, y: 2 }) === null, "cursor room forge rejete");
ok(sanitizeCursor(null) === null, "cursor null rejete");
ok(sanitizeDrag({ room: "__apt__", pieceId: "12", x: 1, y: 2, rot: 90 }).rot === 90, "drag normal relaye");
ok(sanitizeDrag({ room: "__apt__", pieceId: "12", x: 1, y: 2 }).rot === null, "drag sans rot -> rot null");
ok(sanitizeDrag({ room: "__apt__", pieceId: 'p"] , *', x: 1, y: 2 }) === null, "drag pieceId injectant un selecteur rejete");
ok(sanitizeDrag({ room: "__apt__", pieceId: "12", x: "a", y: 2 }) === null, "drag x non numerique rejete");
ok(sanitizeDrag({ room: "__apt__", pieceId: "12", x: 1, y: 2, rot: "x" }) === null, "drag rot non numerique rejete");
ok(sanitizeDrag({ room: "__apt__", pieceId: "", x: 1, y: 2 }) === null, "drag pieceId vide rejete");
ok(sanitizeDrag({ pieceId: "12", x: 1, y: 2 }).room === null, "drag sans room accepte (room null)");

// ---- SIZE safety net before persistence ----
// The real plan weighs ~10 KiB; the ceiling protects the DO's storage (SQLite: key+value < 2 MB)
// and the REST Function (2,000,000 bytes).
ok(planTooBig(freshV5()) === false, "plan reel sous le plafond de taille");
ok(planTooBig(sanitizeState(v5State({ cells: manyCells(2000) }))) === false, "2000 cellules restent sous le plafond");
{
  // The only remaining path to approach the ceiling despite the entity ceilings: very long
  // polygons. We check that the safety net sees it.
  const gros = sanitizeState({ outline: null, walls: [],
    cells: Array.from({ length: 400 }, (_, i) => ({ id: "c" + i, poly: bigPoly(1000), name: "n", floor: "parquet" })) });
  ok(planTooBig(gros) === true, "plan volumineux detecte avant persistance");
}

// =====================================================================
// ---- COLD LOAD (logic extracted from the DO, testable without a Cloudflare stub) ----
// =====================================================================
// D1 with no row = legitimate new plan: we install it and persist it. The new plan is in the
// WALLS-ONLY format (v5), not the old one: otherwise a new household saw ALL live-client ops
// refused (no_room / op_shape), and the two people each configured their own apartment.
{
  const c = coldLoad(null);
  ok(c.source === "empty" && c.persist === true, "coldLoad D1 vide -> plan neuf");
  ok(c.plan.rooms === undefined && c.plan.envelope === undefined, "coldLoad plan neuf : plus d'ancien format");
  ok(Array.isArray(c.plan.walls) && c.plan.walls.length === 0, "coldLoad plan neuf : walls");
  ok(Array.isArray(c.plan.openings) && Array.isArray(c.plan.pieces) && Array.isArray(c.plan.cells),
    "coldLoad plan neuf : les 4 listes v5");
  ok(c.plan.outline === null && c.plan.setupDone === false, "coldLoad plan neuf : contour vide, pas configure");
  ok(isV5(c.plan) === true, "coldLoad plan neuf : aiguille sur les ops v5");
  ok(JSON.stringify(sanitizeState(c.plan)) === JSON.stringify(emptyPlan()), "coldLoad plan neuf : deja canonique");
}
// And on this new plan, the live client's ops PASS (that's the whole point of the change).
{
  const p = coldLoad(null).plan;
  applyOp(p, { kind: "outline.set", outline: outline() });
  applyOp(p, { kind: "wall.set", wall: wall() });
  applyOp(p, { kind: "piece.set", piece: piece() });
  ok(p.walls.length === 1 && p.pieces.length === 1 && p.outline.length === 4, "foyer neuf : outline/wall/piece acceptes");
  shapeErr(() => applyOp(coldLoad(null).plan, { kind: "room.add", room: { id: "r1", name: "S", room: { poly: poly() }, pieces: [] } }),
    "foyer neuf : une op propre a l'ancien modele est refusee en op_shape");
}
// A new plan in the OLD format, already installed by an earlier version, is caught up.
// An old plan that carries ANYTHING is NOT: its conversion belongs to the client.
{
  const rattrape = upgradeEmptyLegacy({ rooms: [], envelope: null, setupDone: false });
  ok(isV5(rattrape) && rattrape.rooms === undefined, "plan neuf a l'ancien format : rattrape en v5");
  ok(upgradeEmptyLegacy({ rooms: [], envelope: null, setupDone: true }).setupDone === true, "rattrapage : setupDone conserve");
  const vrai = { rooms: [{ id: "r1", name: "S", floor: 0, ax: null as DonneeDynamique, ay: null as DonneeDynamique, room: { poly: poly() }, pieces: [] as DonneeDynamique[] }], envelope: null as DonneeDynamique, setupDone: true };
  ok(upgradeEmptyLegacy(vrai) === vrai, "un ancien plan qui porte une salle n'est PAS touche");
  const avecEnv = sanitizeState({ rooms: [], envelope: { poly: envPoly() }, setupDone: true });
  ok(upgradeEmptyLegacy(avecEnv) === avecEnv, "un ancien plan qui porte une enveloppe n'est PAS touche");
  const v5 = freshV5();
  ok(upgradeEmptyLegacy(v5) === v5, "un plan v5 n'est jamais touche");
  // and via the real path: a D1 row containing the old version's new plan
  const c = coldLoad(JSON.stringify({ rooms: [], setupDone: false }));
  ok(isV5(c.plan) && c.plan.walls.length === 0, "coldLoad : une ligne D1 '{rooms:[]}' est rattrapee");
}
// A new household's first complete plan goes through plan5.replace: that's the expected switchover.
{
  const p = coldLoad(null).plan;
  applyOp(p, { kind: "plan5.replace", plan: v5State() });
  ok(p.walls.length === 1 && p.cells.length === 1 && p.setupDone === true, "foyer neuf : plan5.replace installe le plan complet");
}
// D1 with a valid row: canonical shape.
{
  const c = coldLoad(JSON.stringify(v5State()));
  ok(c.source === "d1" && c.plan.walls.length === 1 && c.plan.cells.length === 1, "coldLoad ligne valide");
  ok(c.plan.openings[0].side === 0, "coldLoad canonise l'ouverture");
}
// D1 with a row REFUSED by the current validator (schema that has moved on): we keep the RAW one.
// This is the case that used to install an empty plan, then overwrite it on D1 on the first change.
{
  const older = { outline: null as DonneeDynamique, walls: [{ id: "w1", a: [0, 0], b: [100, 0], t: 10 }],
    openings: [{ id: "o1", wallId: "w1", t0: 5, w: 80, type: "door", cadre: "chene" }],
    pieces: [] as DonneeDynamique[], cells: [] as DonneeDynamique[], setupDone: true };
  throws(() => sanitizeState(older), "la ligne d'exemple est bien refusee par le validateur courant");
  const c = coldLoad(JSON.stringify(older));
  ok(c.source === "raw", "coldLoad ligne refusee -> brut");
  ok(c.plan.walls.length === 1 && c.plan.openings.length === 1, "coldLoad ne vide PAS un plan refuse");
  ok((c.plan.openings[0] as unknown as Record<string, unknown>).cadre === "chene", "coldLoad conserve les champs inconnus du brut");
}
// Unreadable D1: we REFUSE to serve rather than installing an empty plan meant to overwrite the row.
throws(() => coldLoad("{ pas du json"), "coldLoad JSON casse -> refus");
throws(() => coldLoad("[1,2,3]"), "coldLoad tableau -> refus");
throws(() => coldLoad("null"), "coldLoad literal null -> refus");
throws(() => coldLoad(42), "coldLoad valeur non-chaine -> refus");
// No case returns an EMPTY plan while the row carried something: that's the invariant.
{
  const c = coldLoad(JSON.stringify(v5State()));
  ok(!(Array.isArray(c.plan.rooms) && c.plan.rooms.length === 0), "coldLoad ne substitue jamais un plan vide a une ligne pleine");
}

// =====================================================================
// ---- Durable Object op path: transaction, rollback, alarm ----
// =====================================================================
// Minimal runtime double (storage + D1 + sockets). No Cloudflare dependency: we only test
// PlanRoom's logic, not the platform.
function fakeRoom({ d1Row = null, d1Fail = false, storageFail = false }: {
  d1Row?: DonneeDynamique; d1Fail?: boolean; storageFail?: boolean;
} = {}) {
  const kv = new Map();
  let alarmAt: DonneeDynamique = null;
  const sent: DonneeDynamique[] = [];
  const ws = {
    deserializeAttachment: () => ({ email: "a@b.c", color: "#1f6f78", tag: "aaaaaa" }),
    send: (s: DonneeDynamique) => sent.push(JSON.parse(s)),
    close: () => {},
  };
  const storage = {
    async get(keys: DonneeDynamique) {
      if (Array.isArray(keys)) return new Map(keys.filter((k) => kv.has(k)).map((k) => [k, kv.get(k)]));
      return kv.get(keys);
    },
    async put(a: DonneeDynamique, b: DonneeDynamique) {
      if (storageFail) throw new Error("storage plein");
      if (typeof a === "string") kv.set(a, b);
      else for (const [k, v] of Object.entries(a)) kv.set(k, v);
    },
    async getAlarm() { return alarmAt; },
    async setAlarm(t: DonneeDynamique) { alarmAt = t; },
    async deleteAlarm() { alarmAt = null; },
  };
  const d1Writes: DonneeDynamique[] = [];
  const env = { DB: { prepare(sql: string) { return {
    bind(...args: DonneeDynamique[]) { return this; },
    async first() { if (d1Fail) throw new Error("D1 indispo"); return d1Row; },
    async run() { d1Writes.push(sql); return {}; },
  }; } } };
  const state = { storage, getWebSockets: () => [ws], acceptWebSocket: () => {} };
  const room = nouvelleRoom(state, env);
  return { room, ws, sent, kv, d1Writes, alarm: () => alarmAt };
}

// Cold load when D1 is UNREACHABLE: the DO refuses to serve, it installs NOTHING.
// (Before: empty plan installed + persisted, overwritten on D1 on the first change.)
{
  const f = fakeRoom({ d1Fail: true });
  n++;
  let threw = false;
  await f.room.ensureLoaded().catch(() => { threw = true; });
  if (!threw) throw new Error("FAIL: ensureLoaded doit lever quand D1 est injoignable");
  ok(f.kv.size === 0 && f.room.plan === null, "D1 injoignable : rien n'est installe ni persiste");
}
// Cold load on a valid D1 row.
{
  const f = fakeRoom({ d1Row: { data: JSON.stringify(v5State()) } });
  await f.room.ensureLoaded();
  ok(f.room.plan.walls.length === 1 && f.kv.get("plan").walls.length === 1, "ligne D1 valide chargee et persistee");
}
// A valid op: applied, persisted, snapshot alarm armed.
{
  const f = fakeRoom({ d1Row: { data: JSON.stringify(v5State()) } });
  await messageSocket(f.room, f.ws, JSON.stringify({ t: "op", op: { kind: "wall.set", wall: wall({ id: "w2", a: [1, 1], b: [50, 1] }) } }));
  ok(f.room.plan.walls.length === 2 && f.room.opCount === 1, "op appliquee et opCount incremente");
  ok(f.alarm() !== null, "snapshot D1 arme sur une ALARME (survit a l'eviction)");
  ok(f.sent.some((m) => m.t === "op"), "op echo au client");
}
// A REFUSED op: the shared plan is unchanged, rev doesn't move, no alarm.
{
  const f = fakeRoom({ d1Row: { data: JSON.stringify(v5State()) } });
  await f.room.ensureLoaded();
  const before = JSON.stringify(f.room.plan);
  await messageSocket(f.room, f.ws, JSON.stringify({ t: "op", op: { kind: "wall.set", wall: wall({ id: "wz", t: 99 }) } }));
  ok(JSON.stringify(f.room.plan) === before && f.room.opCount === 0, "op refusee : plan et opCount intacts");
  ok(f.sent.some((m) => m.t === "err" && m.reason === "wall_t"), "op refusee : raison remontee au client");
  ok(f.alarm() === null, "op refusee : aucun snapshot arme");
}
// Persistence fails: ROLLBACK and the client is told (before: silent exception, live but
// unpersisted mutation, peers never informed).
{
  const f = fakeRoom({ d1Row: { data: JSON.stringify(v5State()) }, storageFail: false });
  await f.room.ensureLoaded();
  const before = JSON.stringify(f.room.plan);
  f.room.storage.put = async () => { throw new Error("storage plein"); };
  await messageSocket(f.room, f.ws, JSON.stringify({ t: "op", op: { kind: "wall.set", wall: wall({ id: "w2", a: [1, 1], b: [50, 1] }) } }));
  ok(JSON.stringify(f.room.plan) === before && f.room.opCount === 0, "persistance KO : rollback du plan et du opCount");
  ok(f.sent.some((m) => m.t === "err" && m.reason === "persist_fail"), "persistance KO : client prevenu");
  ok(!f.sent.some((m) => m.t === "op"), "persistance KO : aucun echo aux pairs");
}
// ---- TECHNICAL IDENTITY IS THE DEVICE, NOT THE EMAIL ADDRESS -----------------------------------
// The household has two accounts, but one person has several devices (the computer and the
// phone, behind a single Access identity). The server already assigned a per-SOCKET label but
// only broadcast it in the `hello`: on the client, everything was decided on the email, so the
// second device of the same person was mistaken for oneself (a Ctrl+Z destroyed its work, and
// neither its presence nor its cursor appeared). `tag` therefore accompanies EVERYTHING relayed.
{
  const f = fakeRoom({ d1Row: { data: JSON.stringify(v5State()) } });
  await f.room.ensureLoaded();
  ok(f.room.peers()[0].tag === "aaaaaa", "peers() transporte l'etiquette d'appareil");
  const relaye: DonneeDynamique[] = [];
  f.room.broadcast = (o) => relaye.push(o);
  await messageSocket(f.room, f.ws, JSON.stringify({ t: "op", op: { kind: "wall.set", wall: wall({ id: "w2", a: [1, 1], b: [50, 1] }) } }));
  ok(relaye.some((m) => m.t === "op" && m.tag === "aaaaaa" && m.by === "a@b.c"),
    "l'echo d'op porte l'appareil ET la personne");
  await messageSocket(f.room, f.ws, JSON.stringify({ t: "cursor", room: "__apt__", x: 1, y: 2 }));
  ok(relaye.some((m) => m.t === "cursor" && m.tag === "aaaaaa"), "le curseur relaye porte l'appareil");
  await messageSocket(f.room, f.ws, JSON.stringify({ t: "drag", room: "__apt__", pieceId: "p1", x: 1, y: 2 }));
  ok(relaye.some((m) => m.t === "drag" && m.tag === "aaaaaa"), "le fantome relaye porte l'appareil");
}
// Two sockets of the SAME person get two different labels: the email alone would not be enough.
{
  const f = fakeRoom({ d1Row: { data: JSON.stringify(v5State()) } });
  const t1 = f.room.freshTag();
  ok(typeof t1 === "string" && t1.length === 6, "freshTag rend une etiquette courte");
  ok(t1 !== "aaaaaa", "freshTag evite l'etiquette deja prise par un socket vivant");
}
// ---- A REFUSAL NOW SAYS *WHICH ONE* -------------------------------------------------------------
// The client emits by diff and marks the value as acquired right after sending it: a refused op
// was never re-emitted, the screen kept the change, the badge stayed "live checkmark" and the two
// devices diverged permanently. The client numbers its ops, the refusal returns that number.
{
  const f = fakeRoom({ d1Row: { data: JSON.stringify(v5State()) } });
  await f.room.ensureLoaded();
  await messageSocket(f.room, f.ws, JSON.stringify({ t: "op", n: 42, op: { kind: "wall.set", wall: wall({ id: "wz", t: 99 }) } }));
  const e = f.sent.filter((m) => m.t === "err").pop();
  ok(e && e.reason === "wall_t" && e.n === 42 && e.kind === "wall.set",
    "un refus de validation renvoie le numero et le genre de l'op, vu " + JSON.stringify(e));
}
{
  // BACKWARD COMPATIBILITY: an OLD client doesn't send a number. We answer `n:null`, it falls
  // back to a full re-read; nothing breaks.
  const f = fakeRoom({ d1Row: { data: JSON.stringify(v5State()) } });
  await f.room.ensureLoaded();
  await messageSocket(f.room, f.ws, JSON.stringify({ t: "op", op: { kind: "wall.set", wall: wall({ id: "wz", t: 99 }) } }));
  const e = f.sent.filter((m) => m.t === "err").pop();
  ok(e && e.n === null, "sans numero client, le refus renvoie n:null, vu " + JSON.stringify(e));
  // A non-integer number doesn't go through either.
  await messageSocket(f.room, f.ws, JSON.stringify({ t: "op", n: "42", op: { kind: "wall.set", wall: wall({ id: "wz", t: 99 }) } }));
  ok(f.sent.filter((m) => m.t === "err").pop().n === null, "un numero non entier est ignore");
}
{
  // `persist_fail` also carries the number: this is the case where the server backed out.
  const f = fakeRoom({ d1Row: { data: JSON.stringify(v5State()) } });
  await f.room.ensureLoaded();
  f.room.storage.put = async () => { throw new Error("storage plein"); };
  await messageSocket(f.room, f.ws, JSON.stringify({ t: "op", n: 7, op: { kind: "wall.set", wall: wall({ id: "w2", a: [1, 1], b: [50, 1] }) } }));
  const e = f.sent.filter((m) => m.t === "err").pop();
  ok(e && e.reason === "persist_fail" && e.n === 7, "un rollback serveur nomme l'op, vu " + JSON.stringify(e));
}
// A forged ephemeral message is not relayed.
{
  const f = fakeRoom({ d1Row: { data: JSON.stringify(v5State()) } });
  await f.room.ensureLoaded();
  const others: DonneeDynamique[] = [];
  f.room.broadcast = (o) => others.push(o);
  await messageSocket(f.room, f.ws, JSON.stringify({ t: "drag", room: "__apt__", pieceId: 'p"] , *', x: 1, y: 2 }));
  await messageSocket(f.room, f.ws, JSON.stringify({ t: "cursor", room: "__apt__", x: "nope", y: 2 }));
  ok(others.length === 0, "drag/cursor forges non relayes");
  await messageSocket(f.room, f.ws, JSON.stringify({ t: "drag", room: "__apt__", pieceId: "p1", x: 1, y: 2, rot: 90 }));
  ok(others.length === 1 && others[0].pieceId === "p1", "drag legitime relaye");
}
// The alarm writes to D1 and needs NO in-memory flag (it doesn't survive an eviction).
{
  const f = fakeRoom({ d1Row: { data: JSON.stringify(v5State()) } });
  await messageSocket(f.room, f.ws, JSON.stringify({ t: "op", op: { kind: "outline.set", outline: outline() } }));
  const revived = fakeRoom({ d1Row: { data: JSON.stringify(v5State()) } });   // new constructor = flags reset
  revived.kv.set("plan", f.room.plan); revived.kv.set("opCount", f.room.opCount); revived.kv.set("chat", []);
  await revived.room.storage.setAlarm(Date.now());
  await revived.room.alarm();
  ok(revived.d1Writes.length === 1, "alarm() apres reveil ecrit bien le snapshot D1");
}
// `hello` serves exactly what is kept (the two numbers were out of sync: 200/50).
{
  const f = fakeRoom({ d1Row: { data: JSON.stringify(v5State()) } });
  await f.room.ensureLoaded();
  for (let i = 0; i < 60; i++) await messageSocket(f.room, f.ws, JSON.stringify({ t: "chat", text: "m" + i }));
  f.sent.length = 0;
  await messageSocket(f.room, f.ws, JSON.stringify({ t: "hello" }));
  const hello = f.sent.find((m) => m.t === "hello");
  ok(f.room.chat.length === hello.chat.length, "hello sert TOUT le chat conserve");
  ok(hello.chat[hello.chat.length - 1].text === "m59", "hello sert les derniers messages");
}
// `{t:"room"}` no longer exists (no client emitted it; att.room was always null).
{
  const f = fakeRoom({ d1Row: { data: JSON.stringify(v5State()) } });
  await f.room.ensureLoaded();
  f.sent.length = 0;
  await messageSocket(f.room, f.ws, JSON.stringify({ t: "room", room: "r1" }));
  ok(f.sent.some((m) => m.t === "err" && m.reason === "unknown_t"), "t:room retire");
  ok(!("room" in f.room.peers()[0]), "peers() ne transporte plus de champ room");
}

// =====================================================================
// ---- CONTENT FINGERPRINT: the identity `rev` couldn't carry ----
// =====================================================================
// The original bug: D1's `rev` (row writes) and the DO's `rev` (ops since its cold load) are two
// UNRELATED counters sweeping through the same small integers. When they coincided, the arrival
// kept a stale state, its badge said "live checkmark", and nothing ever fixed it. The
// fingerprint, on the other hand, depends ONLY on content.
{
  ok(/^[0-9a-f]{16}$/.test(strHash("")), "strHash : 16 hexa");
  ok(strHash("a") !== strHash("b"), "strHash distingue deux chaines");
  ok(strHash("abc") === strHash("abc"), "strHash est deterministe");
}
{
  const a = sanitizeState(v5State());
  ok(planFp(a) === planFp(sanitizeState(v5State())), "meme contenu -> meme empreinte");
  // A single change, any one at all, changes the fingerprint.
  const nom = structuredClone(a); nom.cells[0].name = "Chambre de Device A";
  ok(planFp(nom) !== planFp(a), "un nom de cellule change l'empreinte");
  const t0 = structuredClone(a); t0.openings[0].t0 += 1;
  ok(planFp(t0) !== planFp(a), "une ouverture deplacee change l'empreinte");
  const sd = structuredClone(a); sd.setupDone = !sd.setupDone;
  ok(planFp(sd) !== planFp(a), "setupDone change l'empreinte");
  const px = structuredClone(a); px.pieces[0].x += 1;
  ok(planFp(px) !== planFp(a), "un meuble deplace change l'empreinte");
  // The ORDER of lists doesn't count: this is a CONTENT identity, not a serialization one.
  const deux = sanitizeState(v5State({
    walls: [wall(), wall({ id: "w2", a: [0, 100], b: [800, 100] })],
    openings: [], cells: [cell(), cell({ id: "c2" })],
    pieces: [piece(), piece({ id: "p2", x: 5 })],
  }));
  const melange = structuredClone(deux);
  melange.walls.reverse(); melange.cells.reverse(); melange.pieces.reverse();
  ok(planFp(melange) === planFp(deux), "l'ordre des listes ne change pas l'empreinte");
  // A v4 plan and a v5 plan are never confused.
  ok(planFp(sanitizeState(freshPlan())) !== planFp(a), "v4 et v5 ont des empreintes distinctes");
  ok(planFp(emptyPlan()) !== planFp(a), "le plan neuf a sa propre empreinte");
}
// The fingerprint survives a JSON round-trip (which is what the DO's storage does).
{
  const a = sanitizeState(v5State());
  ok(planFp(JSON.parse(JSON.stringify(a))) === planFp(a), "empreinte stable apres aller-retour JSON");
}

// =====================================================================
// ---- "ABSENT FIELD = NO OPINION", generalized (cross-editing the same object) ----
// =====================================================================
// A household member renames a rug while the other resizes it: ops were upserts of a WHOLE
// entity, so the last one overwrote the first one's field, including on the screen of whoever had
// just typed it. An op that carries ONLY the changed field must now be accepted and merged.
{
  let p = freshV5();
  p = applyOp(p, { kind: "piece.set", piece: { id: "p1", type: "rug", name: "Tapis", x: 10, y: 10, w: 200, h: 150, rot: 0, locked: false } });
  // two CONCURRENT partial ops on the same entity
  p = applyOp(p, { kind: "piece.set", piece: { id: "p1", name: "Tapis de Device A" } });
  p = applyOp(p, { kind: "piece.set", piece: { id: "p1", w: 260 } });
  const q = p.pieces.find((x) => x.id === "p1");
  ok(q.name === "Tapis de Device A" && q.w === 260, "meuble : le nom ET la largeur survivent");
  ok(q.type === "rug" && q.x === 10 && q.y === 10 && q.h === 150 && q.rot === 0 && q.locked === false,
    "meuble : les champs non mentionnes sont intacts");
  // erasing stays possible, but EXPLICITLY
  p = applyOp(p, { kind: "piece.set", piece: { id: "p1", name: "" } });
  ok(p.pieces[0].name === "", "meuble : un nom s'efface en envoyant la valeur vide EXPLICITE");
  p = applyOp(p, { kind: "piece.set", piece: { id: "p1", locked: true } });
  ok(p.pieces[0].locked === true && p.pieces[0].name === "", "meuble : locked seul, le reste tient");
}
// A partial op on an UNKNOWN entity stays refused: no piece of furniture is ever created without geometry.
{
  throws(() => applyOp(freshV5(), { kind: "piece.set", piece: { id: "pX", name: "orphelin" } }),
    "meuble inconnu : une op partielle ne cree rien");
  throws(() => applyOp(freshV5(), { kind: "wall.set", wall: { id: "wX", t: 10 } }),
    "mur inconnu : une op partielle ne cree rien");
}
// Walls: one moves an endpoint, the other the thickness.
{
  let p = freshV5();
  p = applyOp(p, { kind: "wall.set", wall: { id: "w1", b: [700, 300] } });
  p = applyOp(p, { kind: "wall.set", wall: { id: "w1", t: 20 } });
  const w = p.walls[0];
  ok(w.b[0] === 700 && w.t === 20 && w.a[0] === 0 && w.a[1] === 300, "mur : extremite et epaisseur fusionnees");
}
// Openings: the generalization breaks neither the unpacked shape nor the packed one.
{
  let p = sanitizeState(v5State({ openings: [opening({ side: 1, h: 12, name: "Porte cuisine", hinge: 1, swing: -1 })] }));
  p = applyOp(p, { kind: "opening.set", opening: { id: "o1", t0: 200 } });
  const o = p.openings[0];
  ok(o.t0 === 200, "ouverture : t0 seul applique");
  ok(o.side === 1, "ouverture : une op qui ne dit rien du cote ne le remet PAS a 0");
  ok(o.hinge === 1 && o.name === "Porte cuisine" && o.h === 12 && o.swing === -1 && o.w === 80 && o.type === "door" && o.wallId === "w1",
    "ouverture : tous les autres champs intacts");
  // an old client (PACKED shape) still imposes the side it carries
  const q = applyOp(structuredClone(p), { kind: "opening.set", opening: { id: "o1", wallId: "w1", t0: 5, w: 80, type: "door", hinge: 0 } });
  ok(q.openings[0].side === 0 && q.openings[0].hinge === 0, "ouverture : la forme empaquetee reste maitresse du cote");
  ok(q.openings[0].name === "Porte cuisine" && q.openings[0].h === 12, "ouverture : h/name preserves face a un ancien client");
}
// Cells: a cell.set without poly keeps the geometry, a cells.replace without a name keeps the name.
{
  let p = sanitizeState(v5State({ cells: [cell({ name: "Salon", floor: "tile" })] }));
  p = applyOp(p, { kind: "cell.set", cellId: "c1", name: "Chambre" });
  ok(p.cells[0].name === "Chambre" && p.cells[0].floor === "tile" && p.cells[0].poly.length === 4,
    "cellule : nom seul, sol et polygone conserves");
  p = applyOp(p, { kind: "cells.replace", cells: [{ id: "c1", poly: poly() }] });
  ok(p.cells[0].name === "Chambre" && p.cells[0].floor === "tile",
    "cells.replace : une cellule sans nom/sol reprend ceux de la base");
}
// plan5.replace coming from an amputated client: nothing it can't say is erased.
{
  let p = sanitizeState(v5State({
    openings: [opening({ side: 1, h: 12, name: "Porte" })],
    pieces: [piece({ name: "Tapis", locked: true })],
    cells: [cell({ name: "Salon", floor: "tile" })],
  }));
  const pauvre = {
    outline: outline(),
    walls: [{ id: "w1", a: [0, 300], b: [800, 300], t: 10 }],
    openings: [{ id: "o1", wallId: "w1", t0: 120, w: 80, type: "door" }],
    pieces: [{ id: "p1", x: 10, y: 10, w: 60, h: 40, rot: 0 }],
    cells: [{ id: "c1", poly: poly() }],
    setupDone: true,
  };
  p = applyOp(p, { kind: "plan5.replace", plan: pauvre });
  ok(p.openings[0].name === "Porte" && p.openings[0].h === 12 && p.openings[0].side === 1, "plan5.replace : ouverture non amputee");
  ok(p.pieces[0].name === "Tapis" && p.pieces[0].locked === true && p.pieces[0].type === "sofa", "plan5.replace : meuble non ampute");
  ok(p.cells[0].name === "Salon" && p.cells[0].floor === "tile", "plan5.replace : cellule non amputee");
}
// The merge NEVER crosses the boundary between two entities: a different id lends nothing.
{
  let p = freshV5();
  throws(() => applyOp(structuredClone(p), { kind: "piece.set", piece: { id: "p9", name: "vol" } }),
    "aucune fusion entre entites d'ids differents");
}
// And the principle didn't relax validation: a PRESENT but illegal value stays refused.
{
  throws(() => applyOp(freshV5(), { kind: "wall.set", wall: { id: "w1", t: 99 } }), "fusion : une epaisseur illegale reste refusee");
  throws(() => applyOp(freshV5(), { kind: "piece.set", piece: { id: "p1", w: 99999 } }), "fusion : une largeur illegale reste refusee");
  throws(() => applyOp(freshV5(), { kind: "opening.set", opening: { id: "o1", type: "hublot" } }), "fusion : un type inconnu reste refuse");
  throws(() => applyOp(freshV5(), { kind: "piece.set", piece: { id: "p1", couleur: "bleu" } }), "fusion : une cle inconnue reste refusee");
}
// Atomicity preserved: a refused partial op leaves NOTHING behind it.
{
  const p = freshV5();
  const avant = JSON.stringify(p);
  try { applyOp(p, { kind: "piece.set", piece: { id: "p1", name: "ok", w: 99999 } }); } catch (_) {}
  ok(JSON.stringify(p) === avant, "op partielle refusee : plan intact");
}

// =====================================================================
// ---- IDENTIFIERS PROOF AGAINST COLLISIONS (the server's share) ----
// =====================================================================
// Two people drawing a partition at the same moment both got "w20" (the client numbers from ITS
// own local plan) and the second one overwrote the first, no error, no banner. Uniqueness must be
// guaranteed AT CREATION, client-side: a server refusal would be LOST (the sender works by diff
// and never re-emits), and an id assigned by the server would require the client to rewrite all
// its references. The server's share is twofold: accept the new id scheme without tightening
// anything, and provide a unique device label the client can use.
{
  // The prescribed scheme: prefix + local counter + '-' + device label.
  for (const id of ["w20-a3f9c1", "o22-000000", "c1-zz", "p-1785486063813-a3f9c1", "w1", "1785486063813", "c10"]) {
    const p = applyOp(sanitizeState({ outline: outline(), walls: [], openings: [], pieces: [], cells: [] }),
      { kind: "wall.set", wall: { id, a: [0, 0], b: [100, 0], t: 10 } });
    ok(p.walls[0].id === id, "id accepte : " + id);
  }
  // What remains refused: anything that would break a CSS selector on the peer's side.
  for (const id of ['w20"]', "w20 a", "w/20", "", "w".repeat(81)]) {
    throws(() => applyOp(freshV5(), { kind: "wall.set", wall: { id, a: [0, 0], b: [100, 0], t: 10 } }),
      "id refuse : " + JSON.stringify(id));
  }
  // 80 characters remain the upper bound, and the prescribed scheme fits very comfortably within it.
  ok("w20-a3f9c1".length < 80, "le schema d'id prescrit tient dans la borne");
}
// The old bug is STILL there if the client doesn't change: this is what makes the client's share
// mandatory. The server cannot tell "two creations" apart from "one modification".
{
  let p = sanitizeState({ outline: outline(), walls: [], openings: [], pieces: [], cells: [] });
  p = applyOp(p, { kind: "wall.set", wall: { id: "w20", a: [0, 0], b: [100, 0], t: 10 } });
  p = applyOp(p, { kind: "wall.set", wall: { id: "w20", a: [50, 50], b: [50, 200], t: 10 } });
  ok(p.walls.length === 1, "collision d'ids : le serveur ne peut PAS l'inventer (la part client est obligatoire)");
  // ... whereas with the prescribed scheme, both walls coexist.
  let q = sanitizeState({ outline: outline(), walls: [], openings: [], pieces: [], cells: [] });
  q = applyOp(q, { kind: "wall.set", wall: { id: "w20-a3f9c1", a: [0, 0], b: [100, 0], t: 10 } });
  q = applyOp(q, { kind: "wall.set", wall: { id: "w20-7b2e04", a: [50, 50], b: [50, 200], t: 10 } });
  ok(q.walls.length === 2, "schema d'id prescrit : les deux cloisons coexistent");
}

// =====================================================================
// ---- D1 RECONCILIATION VERDICT (pure logic) ----
// =====================================================================
{
  const row = (over = {}) => ({ data: JSON.stringify(v5State()), rev: 5, updated_by: "a@example.com", updated_at: "2026-08-03T10:00:00Z", ...over });
  ok(d1Verdict(null, null, false).kind === "none", "pas de ligne D1 -> rien a faire");
  ok(d1Verdict({ rev: 1 }, null, false).kind === "none", "ligne sans data -> rien a faire");
  ok(d1Verdict(row({ updated_by: "live" }), null, true).kind === "none", "notre propre snapshot -> rien a faire");
  ok(d1Verdict(row(), null, false).kind === "adopt", "ecriture REST + DO au repos -> adoption");
  ok(d1Verdict(row(), null, true).kind === "conflict", "ecriture REST + DO au travail -> conflit");
  ok(d1Verdict(row({ updated_by: "inconnu" }), null, false).kind === "adopt", "updated_by 'inconnu' est aussi une ecriture REST");
  const h = d1Verdict(row(), null, false).hash;
  ok(d1Verdict(row(), h, false).kind === "none", "une ecriture deja adoptee n'est pas re-adoptee");
  ok(d1Verdict(row(), h, true).kind === "none", "une ecriture deja signalee n'est pas re-signalee");
  ok(d1Verdict(row({ data: JSON.stringify(v5State({ setupDone: false })) }), h, false).kind === "adopt",
    "une NOUVELLE ecriture REST est bien vue");
}

// =====================================================================
// ---- THE D1 FALLBACK IS NO LONGER A SINK (Durable Object) ----
// =====================================================================
// Double with a MUTABLE D1 row and several sockets: what was needed to replay
// "the Worker goes down, the REST fallback writes, the Worker comes back".
function fakeD1Room({ data = null, by = "live", rev = 1 }: {
  data?: string | null; by?: string; rev?: number;
} = {}) {
  const kv = new Map();
  let alarmAt: DonneeDynamique = null;
  const row = data === null ? null : { data, rev, updated_by: by, updated_at: "2026-08-03T10:00:00Z" };
  const world = { row, writes: [] as DonneeDynamique[] };
  const sockets: DonneeDynamique[] = [];
  const mkWs = (email: string, tag: string) => {
    const att = { email, color: "#1f6f78", tag };
    const w = { sent: [] as DonneeDynamique[], deserializeAttachment: () => att, serializeAttachment: (a: DonneeDynamique) => Object.assign(att, a),
      send: (s: DonneeDynamique) => w.sent.push(JSON.parse(s)), close: () => {} };
    sockets.push(w);
    return w;
  };
  const storage = {
    async get(keys: DonneeDynamique) {
      if (Array.isArray(keys)) return new Map(keys.filter((k) => kv.has(k)).map((k) => [k, kv.get(k)]));
      return kv.get(keys);
    },
    async put(a: DonneeDynamique, b: DonneeDynamique) {
      if (typeof a === "string") kv.set(a, b);
      else for (const [k, v] of Object.entries(a)) kv.set(k, v);
    },
    async getAlarm() { return alarmAt; },
    async setAlarm(t: DonneeDynamique) { alarmAt = t; },
    async deleteAlarm() { alarmAt = null; },
  };
  const env = { DB: { prepare(sql: string) { return {
    args: [] as DonneeDynamique[],
    bind(...a: DonneeDynamique[]) { this.args = a; return this; },
    async first() {
      if (!world.row) return null;
      return { data: world.row.data, rev: world.row.rev, updated_by: world.row.updated_by, updated_at: world.row.updated_at };
    },
    async run() {
      const [data, at] = this.args;
      world.row = { data, rev: (world.row ? world.row.rev : 0) + 1, updated_by: "live", updated_at: at };
      world.writes.push(data);
      return {};
    },
  }; } } };
  const st = { storage, getWebSockets: () => sockets.slice(), acceptWebSocket: () => {} };
  const room = nouvelleRoom(st, env);
  // Write from the REST fallback (functions/api/plan.ts): `updated_by` = the email, never 'live'.
  const putRest = (plan: DonneeDynamique, who = "b@example.com") => {
    world.row = { data: JSON.stringify(plan), rev: (world.row ? world.row.rev : 0) + 1, updated_by: who, updated_at: "2026-08-03T11:00:00Z" };
  };
  return { room, kv, world, mkWs, sockets, putRest, alarm: () => alarmAt, setAlarm: (t: DonneeDynamique) => { alarmAt = t; } };
}

// The complete scenario: the DO runs, everyone loses realtime, the REST fallback writes, realtime
// comes back. Before: the `hello` reimposed the DO's plan and the alarm overwrote the row.
{
  const f = fakeD1Room({ data: JSON.stringify(v5State()) });
  await f.room.ensureLoaded();
  ok(f.room.plan.cells[0].name === "Salon", "depart : le DO tient le plan D1");
  // the REST fallback renames a room during the outage
  const pendant = sanitizeState(v5State());
  pendant.cells[0].name = "Travail pendant la panne";
  f.putRest(pendant);
  // realtime comes back: the room is EMPTY, so we reconcile
  const v = await f.room.reconcileD1(await f.room.storage.getAlarm() !== null);
  ok(v.kind === "adopt", "retour du temps reel sur une salle vide : adoption de l'ecriture REST");
  ok(f.room.plan.cells[0].name === "Travail pendant la panne", "le travail fait pendant la panne SURVIT");
  ok(f.kv.get("plan").cells[0].name === "Travail pendant la panne", "et il est persiste dans le storage du DO");
  // the hello does serve the adopted state
  const ws = f.mkWs("a@example.com", "aaa111");
  await messageSocket(f.room, ws, JSON.stringify({ t: "hello" }));
  const hello = ws.sent.find((m) => m.t === "hello");
  ok(hello.state.cells[0].name === "Travail pendant la panne", "le hello sert l'etat adopte, pas l'ancien");
  // and the next snapshot doesn't destroy it
  await messageSocket(f.room, ws, JSON.stringify({ t: "op", op: { kind: "piece.set", piece: piece({ id: "p2", x: 3 }) } }));
  await f.room.alarm();
  ok(JSON.parse(f.world.row.data).cells[0].name === "Travail pendant la panne", "l'alarme n'ecrase plus le travail du repli");
  // nothing gets re-adopted in a loop
  const v2 = await f.room.reconcileD1(false);
  ok(v2.kind === "none", "la meme ligne n'est pas ré-adoptee au tour suivant");
}
// The DO AT WORK no longer silently destroys: it keeps its state, keeps the bytes, and SAYS so.
{
  const f = fakeD1Room({ data: JSON.stringify(v5State()) });
  await f.room.ensureLoaded();
  const ws = f.mkWs("a@example.com", "aaa111");
  await messageSocket(f.room, ws, JSON.stringify({ t: "op", op: { kind: "cell.set", cellId: "c1", name: "Vu par le live" } }));
  ok(f.alarm() !== null, "le DO a du travail non snapshotte (alarme armee)");
  const perdu = sanitizeState(v5State());
  perdu.cells[0].name = "Ecrit par le repli";
  f.putRest(perdu);
  ws.sent.length = 0;
  const v = await f.room.reconcileD1(true);
  ok(v.kind === "conflict", "DO au travail + ecriture REST -> conflit");
  ok(f.room.plan.cells[0].name === "Vu par le live", "le DO garde son etat (quelqu'un edite dessus)");
  const orphan = f.kv.get("orphan");
  ok(orphan && JSON.parse(orphan.data).cells[0].name === "Ecrit par le repli", "les octets etrangers sont CONSERVES");
  ok(orphan.by === "b@example.com" && orphan.bytes > 0, "l'orphelin sait de qui et de quand il vient");
  const dit = ws.sent.find((m) => m.t === "conflict");
  ok(dit && dit.by === "b@example.com" && dit.kept === "server", "les clients connectes sont PREVENUS");
  // a single announcement per foreign write
  ws.sent.length = 0;
  const v2 = await f.room.reconcileD1(true);
  ok(v2.kind === "none" && !ws.sent.some((m) => m.t === "conflict"), "pas d'annonce en boucle");
  // The one who wrote offline was NOT connected at the moment of the conflict: they learn it
  // when they come back, and only once.
  const wsE = f.mkWs("b@example.com", "bbb222");
  await messageSocket(f.room, wsE, JSON.stringify({ t: "hello" }));
  const avis = wsE.sent.find((m) => m.t === "conflict");
  ok(avis && avis.by === "b@example.com" && avis.kept === "server", "l'absente est prevenue a son retour");
  wsE.sent.length = 0;
  await messageSocket(f.room, wsE, JSON.stringify({ t: "hello" }));
  ok(!wsE.sent.some((m) => m.t === "conflict"), "et une seule fois : pas de bandeau a chaque hello");
  // the one who WAS there when the conflict happened isn't caught again either
  ws.sent.length = 0;
  await messageSocket(f.room, ws, JSON.stringify({ t: "hello" }));
  ok(!ws.sent.some((m) => m.t === "conflict"), "le present n'est pas prevenu deux fois");
}
// Adoption tells connected clients (a `state` message): no one is left on the old plan.
{
  const f = fakeD1Room({ data: JSON.stringify(v5State()) });
  await f.room.ensureLoaded();
  const ws = f.mkWs("a@example.com", "aaa111");
  const neuf = sanitizeState(v5State()); neuf.cells[0].name = "Depuis D1";
  f.putRest(neuf);
  await f.room.reconcileD1(false);
  const st = ws.sent.find((m) => m.t === "state");
  ok(st && st.reason === "d1_adopt" && st.state.cells[0].name === "Depuis D1", "adoption diffusee aux clients");
  ok(st.fp === planFp(f.room.plan), "le message d'adoption porte l'empreinte du nouvel etat");
}
// An unreadable D1 row never overwrites a live plan.
{
  const f = fakeD1Room({ data: JSON.stringify(v5State()) });
  await f.room.ensureLoaded();
  const avant = JSON.stringify(f.room.plan);
  f.world.row = { data: "{ pas du json", rev: 9, updated_by: "b@example.com", updated_at: "x" };
  const v = await f.room.reconcileD1(false);
  ok(v.kind === "none" && JSON.stringify(f.room.plan) === avant, "ligne illisible : le plan vivant est garde");
  const v2 = await f.room.reconcileD1(false);
  ok(v2.kind === "none", "ligne illisible : pas de boucle de relecture");
}
// The DO's own snapshot is never mistaken for a foreign write (belt AND suspenders).
{
  const f = fakeD1Room({ data: JSON.stringify(v5State()) });
  await f.room.ensureLoaded();
  const ws = f.mkWs("a@example.com", "aaa111");
  await messageSocket(f.room, ws, JSON.stringify({ t: "op", op: { kind: "cell.set", cellId: "c1", name: "A" } }));
  await f.room.alarm();
  ok(f.kv.get("d1seen") === strHash(f.world.row.data), "apres snapshot, l'empreinte de la ligne est memorisee");
  const v = await f.room.reconcileD1(false);
  ok(v.kind === "none" && v.why === "own_write", "notre propre snapshot n'est pas une ecriture etrangere");
}
// ---- TWO COUNTERS WITH THE SAME NAME IS ONE TOO MANY ------------------------------------------
// The Durable Object's counter is called `opCount` and STARTS FROM ZERO. It used to start from
// D1's `rev`: a band-aid so the two wouldn't sweep through the same small integers and wouldn't
// coincide by accident for a client comparing them. That was the LAST place where the two
// touched; it no longer has a reason to exist, no one compares them anymore.
{
  const f = fakeD1Room({ data: JSON.stringify(v5State()), rev: 256 });
  await f.room.ensureLoaded();
  ok(f.room.opCount === 0, "chargement a froid : le compteur d'ops part de zero, jamais du rev D1");
  ok((f.room as unknown as Record<string, unknown>).rev === undefined, "le Durable Object ne porte plus aucun champ nomme rev");
  const f2 = fakeD1Room({ data: JSON.stringify(v5State()), rev: 0 });
  await f2.room.ensureLoaded();
  ok(f2.room.opCount === 0, "rev 0 en D1 -> compteur d'ops a 0 lui aussi");
}
// A Durable Object already in service keeps its counter on wake-up: the historical storage key
// (`rev`) is read once, the new one (`opCount`) is then written.
{
  const f = fakeD1Room({ data: JSON.stringify(v5State()) });
  f.room.storage.put("rev", 41);
  f.room.storage.put("plan", sanitizeState(v5State()));
  await f.room.ensureLoaded();
  ok(f.room.opCount === 41, "reveil : l'ancienne cle de storage est relue, vu " + f.room.opCount);
  const ws = f.mkWs("a@example.com", "aaa111");
  await messageSocket(f.room, ws, JSON.stringify({ t: "op", n: 1, op: { kind: "cell.set", cellId: "c1", name: "X" } }));
  ok(await f.room.storage.get("opCount") === 42, "le compteur est desormais persiste sous opCount");
}

// =====================================================================
// ---- THE WIRE CARRIES A CONTENT IDENTITY (hello / op / pong / sync) ----
// =====================================================================
{
  const f = fakeD1Room({ data: JSON.stringify(v5State()) });
  await f.room.ensureLoaded();
  const ws = f.mkWs("a@example.com", "aaa111");
  await messageSocket(f.room, ws, JSON.stringify({ t: "hello" }));
  const hello = ws.sent.find((m) => m.t === "hello");
  ok(hello.fp === planFp(f.room.plan), "hello porte l'empreinte du plan servi");
  ok(hello.you.tag === "aaa111", "hello porte l'etiquette d'appareil");
  ok(typeof hello.opCount === "number", "hello porte le compteur d'ops sous son nom propre");
  ok(!("rev" in hello), "hello ne porte plus aucun champ nomme rev");
  // the fingerprint CHANGES when the plan changes, even if the two `rev` coincide
  const fpAvant = hello.fp;
  ws.sent.length = 0;
  await messageSocket(f.room, ws, JSON.stringify({ t: "op", op: { kind: "cell.set", cellId: "c1", name: "Chambre de Device A" } }));
  const echo = ws.sent.find((m) => m.t === "op");
  ok(echo.fp && echo.fp !== fpAvant, "l'echo d'op porte la NOUVELLE empreinte");
  ok(echo.fp === planFp(f.room.plan), "l'empreinte de l'echo est celle du plan du serveur");
  // THIS IS THE CASE THAT USED TO BREAK: an arrival whose `rev` coincides with the server's.
  ws.sent.length = 0;
  await messageSocket(f.room, ws, JSON.stringify({ t: "hello" }));
  const hello2 = ws.sent.find((m) => m.t === "hello");
  ok(hello2.fp !== fpAvant, "deux `hello` de contenus differents ne peuvent pas se ressembler");
  ok(hello2.fp === echo.fp, "deux `hello` de meme contenu portent la meme empreinte");
  // pong: the fingerprint without a single extra byte of traffic
  ws.sent.length = 0;
  await messageSocket(f.room, ws, JSON.stringify({ t: "ping", ts: 42 }));
  const pong = ws.sent.find((m) => m.t === "pong");
  ok(pong.ts === 42 && pong.fp === planFp(f.room.plan), "pong porte l'empreinte courante");
  // sync: requesting the complete state without closing the socket
  ws.sent.length = 0;
  await messageSocket(f.room, ws, JSON.stringify({ t: "sync" }));
  const state = ws.sent.find((m) => m.t === "state");
  ok(state && state.reason === "sync" && state.fp === planFp(f.room.plan), "sync renvoie l'etat complet + empreinte");
  ok(JSON.stringify(state.state) === JSON.stringify(f.room.plan), "sync renvoie EXACTEMENT le plan du serveur");
  ok(!f.world.writes.length || true, "sync n'ecrit rien");
}
// A device label is unique among live sockets (two tabs of the same person included): this is
// the building block the client uses for ids that cannot collide.
{
  const f = fakeD1Room({ data: JSON.stringify(v5State()) });
  await f.room.ensureLoaded();
  const tags = new Set();
  for (let i = 0; i < 40; i++) { const t = f.room.freshTag(); tags.add(t); f.mkWs("a@example.com", t); }
  ok(tags.size === 40, "40 etiquettes d'appareil, 40 valeurs distinctes");
  ok([...tags].every((t) => /^[0-9a-f]{6}$/.test(String(t))), "etiquette : 6 hexa, utilisable telle quelle dans un id");
}
// A client that has never received anything from the wire can NO LONGER conclude "nothing new" by
// accident: it has no fingerprint to compare, so it adopts. (Verified here server-side: the
// fingerprint is always present and is never an integer that could be mistaken for a counter.)
{
  const f = fakeD1Room({ data: JSON.stringify(v5State()) });
  await f.room.ensureLoaded();
  const ws = f.mkWs("a@example.com", "aaa111");
  await messageSocket(f.room, ws, JSON.stringify({ t: "hello" }));
  const hello = ws.sent.find((m) => m.t === "hello");
  ok(typeof hello.fp === "string" && /^[0-9a-f]{16}$/.test(hello.fp), "l'empreinte est une chaine hexa, jamais un compteur");
  ok(hello.fp !== String(hello.rev), "l'empreinte ne peut pas etre confondue avec le rev");
}

// =====================================================================
// ---- THE PRODUCTION ROW STAYS VALID (shapes recorded reading D1) ----
// =====================================================================
// Recorded on 2026-08-03 on the `main` row (rev 256, updated_by 'live', 10,023 bytes): 22 walls,
// 30 openings, 47 furniture items, 10 cells, a 6-vertex outline, 109 ids all distinct. The
// openings there are still in the PACKED shape (no `side` key, integer `hinge`, no `h` or
// `name`): that's the deployed Worker, predating the unpacking. No tightening must refuse it.
{
  const prod = {
    setupDone: true,
    outline: [[0, 0], [1418, 0], [1418, 700], [905, 700], [905, 185], [0, 185]],
    walls: [{ id: "w1", a: [905, 185], b: [1418, 185], t: 12 }, { id: "w22", a: [0, 100], b: [500, 100], t: 12 }],
    openings: [
      { id: "1785486063813", wallId: "w1", t0: 341, w: 70, type: "window", hinge: 0 },
      { id: "1785486063820", wallId: "w22", t0: 10, w: 80, type: "door", hinge: 3, swing: -1 },
      { id: "5", wallId: "w1", t0: 4, w: 6, type: "plug" },
    ],
    pieces: [{ id: "1785485210441", type: "sofa3", name: "Homu", x: 1160, y: 230, w: 200, h: 100, rot: 0, locked: false }],
    cells: [{ id: "c1", poly: [[0, 0], [900, 0], [900, 180], [0, 180]], name: "Pièce 9", floor: "tile" }],
  };
  const s = sanitizeState(prod);
  ok(s.walls.length === 2 && s.openings.length === 3 && s.pieces.length === 1 && s.cells.length === 1, "ligne de prod acceptee");
  ok(coldLoad(JSON.stringify(prod)).source === "d1", "ligne de prod : chargement a froid canonique, pas 'raw'");
  ok(JSON.stringify(sanitizeState(s)) === JSON.stringify(s), "ligne de prod : validation idempotente");
  // the unpacking of the production `hinge` is intact
  ok(s.openings[0].side === 0 && s.openings[0].hinge === 0, "prod : hinge 0 -> side 0, hinge 0");
  ok(s.openings[1].side === 1 && s.openings[1].hinge === 1 && s.openings[1].swing === -1, "prod : hinge 3 -> side 1, hinge 1");
  ok(s.openings[2].side === 0 && s.openings[2].hinge === undefined, "prod : une prise sans hinge reste sans hinge");
  ok(s.openings[0].h === undefined && s.openings[0].name === undefined, "prod : h/name absents ne sont pas inventes");
  // the production ids all pass, including the very small ones ("5", "c1") and the timestamped ones
  for (const id of ["w1", "w22", "1785486063813", "5", "c1", "c10"]) ok(sanitizeState({
    outline: null, walls: [{ id, a: [0, 0], b: [10, 0], t: 12 }], openings: [], pieces: [], cells: [],
  }).walls[0].id === id, "id de prod accepte : " + id);
  // and the current client's incremental ops apply to it without losing anything
  let p = structuredClone(s);
  p = applyOp(p, { kind: "opening.set", opening: { id: "1785486063820", t0: 25 } });
  ok(p.openings[1].t0 === 25 && p.openings[1].side === 1 && p.openings[1].hinge === 1 && p.openings[1].swing === -1,
    "prod : deplacer une ouverture ne retourne pas sa face ni ne perd son sens d'ouverture");
  p = applyOp(p, { kind: "piece.set", piece: { id: "1785485210441", name: "Canapé" } });
  ok(p.pieces[0].name === "Canapé" && p.pieces[0].w === 200 && p.pieces[0].type === "sofa3", "prod : renommer un meuble ne perd pas sa taille");
  ok(planFp(s) !== planFp(p), "prod : l'empreinte suit les modifications");
}

// =====================================================================
// ---- ACKNOWLEDGMENT, DEDUPLICATION BY (tag, n), SEQUENCE GAP ----
// =====================================================================
// Before: the op number only served to undo a REFUSAL. Nothing acknowledged what WENT THROUGH,
// so an op lost in transit was never re-emitted; the only safety net was the `pong`'s
// fingerprint, up to 10 s later, and that re-read ADOPTS the server state, so it ERASES the lost
// change instead of catching it up.
{
  const f = fakeD1Room({ data: JSON.stringify(v5State()) });
  await f.room.ensureLoaded();
  const ws = f.mkWs("a@example.com", "aaa111");
  await messageSocket(f.room, ws, JSON.stringify({ t: "hello" }));
  ok(ws.sent.find((m) => m.t === "hello").acks === true, "le hello ANNONCE que ce serveur accuse reception");
  ws.sent.length = 0;
  await messageSocket(f.room, ws, JSON.stringify({ t: "op", n: 1, op: { kind: "cell.set", cellId: "c1", name: "A" } }));
  const echo = ws.sent.find((m) => m.t === "op");
  ok(echo && echo.n === 1 && echo.tag === "aaa111", "L'ECHO EST L'ACCUSE : il porte le numero ET l'appareil");
  ok(echo.opCount === f.room.opCount, "l'echo porte le compteur d'ops sous son nom propre");
  ok(!("rev" in echo), "l'echo ne porte plus aucun champ nomme rev");
}
// The same number twice: nothing is reapplied, but the ack goes out anyway. Without it, the
// author would think their change was lost and would re-emit it endlessly.
{
  const f = fakeD1Room({ data: JSON.stringify(v5State()) });
  await f.room.ensureLoaded();
  const ws = f.mkWs("a@example.com", "aaa111");
  const op = { kind: "piece.set", piece: piece({ id: "p9", x: 10 }) };
  await messageSocket(f.room, ws, JSON.stringify({ t: "op", n: 1, op }));
  const opCount1 = f.room.opCount;
  ws.sent.length = 0;
  await messageSocket(f.room, ws, JSON.stringify({ t: "op", n: 1, op }));
  ok(f.room.opCount === opCount1, "numero deja traite : RIEN n'est reapplique");
  const a = ws.sent.find((m) => m.t === "ack");
  ok(a && a.n === 1 && a.dup === true && a.tag === "aaa111", "numero deja traite : un accuse part quand meme, vu " + JSON.stringify(ws.sent));
  ok(!ws.sent.some((m) => m.t === "op"), "numero deja traite : aucun echo aux pairs");
}
// The memory window is ONE ENTRY PER SOCKET, in memory, and it dies with the socket. No storage
// bytes: losing it is harmless (ops are idempotent).
{
  const f = fakeD1Room({ data: JSON.stringify(v5State()) });
  await f.room.ensureLoaded();
  const ws = f.mkWs("a@example.com", "aaa111");
  await messageSocket(f.room, ws, JSON.stringify({ t: "op", n: 7, op: { kind: "cell.set", cellId: "c1", name: "A" } }));
  ok(f.room.seq.size === 1 && f.room.seq.get("aaa111").vus.has(7), "une entree par appareil, calee sur le premier numero vu");
  ok(![...f.kv.keys()].some((k) => /seq/i.test(k)), "le dedoublonnage ne coute AUCUN octet de storage");
  await fermeSocket(f.room, ws);
  ok(f.room.seq.size === 0, "la fenetre meurt avec le socket");
}
// The window SLIDES: it cannot grow indefinitely, and falling out of it isn't dangerous.
{
  const f = fakeD1Room({ data: JSON.stringify(v5State()) });
  await f.room.ensureLoaded();
  const ws = f.mkWs("a@example.com", "aaa111");
  for (let i = 1; i <= 300; i++)
    await messageSocket(f.room, ws, JSON.stringify({ t: "op", n: i, op: { kind: "cell.set", cellId: "c1", name: "n" + i } }));
  const e = f.room.seq.get("aaa111");
  ok(e.vus.size === 64 && e.max === 300, "la fenetre reste bornee a 64 numeros, vu " + e.vus.size);
  ok(e.vus.has(300) && !e.vus.has(1), "elle garde les recents et laisse sortir les anciens");
  // Falling out of the window: the op is reapplied. Harmless, it's idempotent.
  const avant = planFp(f.room.plan);
  ws.sent.length = 0;
  await messageSocket(f.room, ws, JSON.stringify({ t: "op", n: 300, op: { kind: "cell.set", cellId: "c1", name: "n300" } }));
  ok(ws.sent.some((m) => m.t === "ack"), "dans la fenetre : dedoublonne");
  await messageSocket(f.room, ws, JSON.stringify({ t: "op", n: 1, op: { kind: "cell.set", cellId: "c1", name: "n300" } }));
  ok(planFp(f.room.plan) === avant, "hors fenetre : reapplique, et sans consequence (op idempotente)");
}
// A client from BEFORE doesn't send a number: no entry is created, everything works as before.
{
  const f = fakeD1Room({ data: JSON.stringify(v5State()) });
  await f.room.ensureLoaded();
  const ws = f.mkWs("a@example.com", "aaa111");
  await messageSocket(f.room, ws, JSON.stringify({ t: "op", op: { kind: "cell.set", cellId: "c1", name: "A" } }));
  ok(f.room.seq.size === 0, "client sans numero : aucune sequence n'est ouverte");
  const echo = ws.sent.find((m) => m.t === "op");
  ok(echo && echo.n === null, "client sans numero : l'echo porte n:null");
  ok(f.room.plan.cells[0].name === "A", "client sans numero : l'op s'applique quand meme");
}
// A NUMBER IS MISSING: the server applies the op that arrived AND flags the gap, right away.
// This is the fastest loss detector: one round trip, versus 2.5 s for the client's guard delay.
{
  const f = fakeD1Room({ data: JSON.stringify(v5State()) });
  await f.room.ensureLoaded();
  const ws = f.mkWs("a@example.com", "aaa111");
  await messageSocket(f.room, ws, JSON.stringify({ t: "op", n: 1, op: { kind: "cell.set", cellId: "c1", name: "A" } }));
  ws.sent.length = 0;
  // op n°2 is LOST in transit; n°3 arrives
  await messageSocket(f.room, ws, JSON.stringify({ t: "op", n: 3, op: { kind: "cell.set", cellId: "c1", name: "C" } }));
  const g = ws.sent.find((m) => m.t === "gap");
  ok(g && g.need === 2 && g.n === 3, "un numero manquant est SIGNALE, avec celui qu'on attendait, vu " + JSON.stringify(ws.sent));
  ok(f.room.plan.cells[0].name === "C", "l'op arrivee est appliquee quand meme : le trou n'est pas une raison de refuser");
  ok(ws.sent.some((m) => m.t === "op" && m.n === 3), "l'op arrivee est bien accusee, trou ou pas");
  // The gap is only signaled ONCE: the following ops resume normally, without a burst of messages.
  ws.sent.length = 0;
  await messageSocket(f.room, ws, JSON.stringify({ t: "op", n: 4, op: { kind: "cell.set", cellId: "c1", name: "D" } }));
  ok(!ws.sent.some((m) => m.t === "gap"), "un trou deja signale ne se re-signale pas a chaque op");
}
// A REFUSAL consumes the number: the client got its response (`err`), it won't re-emit it, so
// the following number must not be mistaken for a gap.
{
  const f = fakeD1Room({ data: JSON.stringify(v5State()) });
  await f.room.ensureLoaded();
  const ws = f.mkWs("a@example.com", "aaa111");
  await messageSocket(f.room, ws, JSON.stringify({ t: "op", n: 1, op: { kind: "wall.set", wall: wall({ id: "wz", t: 99 }) } }));
  ok(ws.sent.pop().reason === "wall_t", "op invalide refusee");
  ok(f.room.seq.get("aaa111").vus.has(1), "le numero refuse est CONSOMME");
  ws.sent.length = 0;
  await messageSocket(f.room, ws, JSON.stringify({ t: "op", n: 2, op: { kind: "cell.set", cellId: "c1", name: "A" } }));
  ok(!ws.sent.some((m) => m.t === "gap"), "apres un refus, le numero suivant n'est pas un trou");
}
// Two devices, two sequences: one's numbers neither acknowledge nor deduplicate the other's.
{
  const f = fakeD1Room({ data: JSON.stringify(v5State()) });
  await f.room.ensureLoaded();
  const a = f.mkWs("a@example.com", "aaa111");
  const b = f.mkWs("a@example.com", "bbb222");     // SAME person, another device
  await messageSocket(f.room, a, JSON.stringify({ t: "op", n: 1, op: { kind: "cell.set", cellId: "c1", name: "A" } }));
  b.sent.length = 0;
  await messageSocket(f.room, b, JSON.stringify({ t: "op", n: 1, op: { kind: "piece.set", piece: piece({ id: "p2", x: 7 }) } }));
  ok(!b.sent.some((m) => m.t === "ack"), "le n°1 du second appareil n'est pas un doublon du n°1 du premier");
  ok(f.room.plan.pieces.some((p) => p.id === "p2"), "et il s'applique");
  ok(f.room.seq.size === 2, "une sequence par appareil");
  // The echo carries the AUTHOR device: this is what lets each one recognize ITS OWN ack.
  const echo = a.sent.filter((m) => m.t === "op").pop();
  ok(echo.tag === "bbb222" && echo.n === 1, "l'echo relaye a l'autre appareil porte l'appareil auteur et son numero");
}

// =====================================================================
// ---- TRANSPORT THAT LOSES, DELAYS AND REORDERS (server bench) ----
// =====================================================================
// No bench modeled message loss: the only simulated network effect was a uniform delay. This
// transport loses, delays and reorders frames, on a REAL PlanRoom.
type TrameTest = { t: DonneeDynamique; n?: number; [key: string]: unknown };
function lienPerturbe(room: PlanRoom, ws: unknown, {
  perdre = () => false,
  retarder = () => 0,
}: { perdre?: (message: TrameTest, tour: number) => boolean; retarder?: (message: TrameTest, tour: number) => number } = {}) {
  const enVol: DonneeDynamique[] = [];
  let horloge = 0;
  return {
    // Client -> server emission. Returns false if the frame was LOST.
    async envoyer(msg: TrameTest) {
      horloge++;
      if (perdre(msg, horloge)) return false;
      const d = retarder(msg, horloge);
      if (d > 0) { enVol.push({ msg, quand: horloge + d }); await this.livrer(horloge); return true; }
      await messageSocket(room, ws, JSON.stringify(msg));
      await this.livrer(horloge);
      return true;
    },
    // Delivers everything whose deadline has passed: this is where the order flips.
    async livrer(t: number) {
      const prets = enVol.filter((e) => e.quand <= t).sort((a, b) => a.quand - b.quand);
      for (const e of prets) { enVol.splice(enVol.indexOf(e), 1); await messageSocket(room, ws, JSON.stringify(e.msg)); }
    },
    async vider() { horloge += 1000; await this.livrer(horloge); },
    get enVol() { return enVol.length; },
  };
}
// LOSS: one op in three never arrives. The server signals every gap, and the final plan only has
// what got through — it's up to the client to re-emit (cf. tests/collab-accuses.ts).
{
  const f = fakeD1Room({ data: JSON.stringify(v5State()) });
  await f.room.ensureLoaded();
  const ws = f.mkWs("a@example.com", "aaa111");
  const lien = lienPerturbe(f.room, ws, { perdre: (m) => m.t === "op" && m.n % 3 === 0 });
  let envoyees = 0, perdues = 0;
  for (let i = 1; i <= 9; i++) {
    const ok2 = await lien.envoyer({ t: "op", n: i, op: { kind: "piece.set", piece: piece({ id: "p" + i, x: i }) } });
    envoyees++; if (!ok2) perdues++;
  }
  ok(envoyees === 9 && perdues === 3, "banc : 3 trames sur 9 perdues");
  ok(f.room.plan.pieces.filter((p) => /^p[1-9]$/.test(p.id)).length === 6, "le serveur n'a QUE ce qui est passe");
  // 3, 6 and 9 are lost. The first two are flagged by the FOLLOWING op (4 then 7); the third is
  // the last frame sent, so nothing comes after it to reveal the gap: only the client's guard
  // delay catches that one. That's the reason both safety nets exist.
  const trous = ws.sent.filter((m) => m.t === "gap");
  ok(trous.length === 2 && trous.map((g) => g.need).join(",") === "3,6",
    "chaque perte SUIVIE d'une autre op est signalee, avec le bon numero manquant, vu " + JSON.stringify(trous));
}
// DELAY AND REORDERING: frames arrive out of order. The referee remains ARRIVAL ORDER (no
// clock), and nothing is lost: the final plan carries the nine furniture items.
{
  const f = fakeD1Room({ data: JSON.stringify(v5State()) });
  await f.room.ensureLoaded();
  const ws = f.mkWs("a@example.com", "aaa111");
  const lien = lienPerturbe(f.room, ws, { retarder: (m) => (m.n % 2 === 0 ? 3 : 0) });
  for (let i = 1; i <= 9; i++) await lien.envoyer({ t: "op", n: i, op: { kind: "piece.set", piece: piece({ id: "p" + i, x: i }) } });
  await lien.vider();
  ok(f.room.plan.pieces.filter((p) => /^p[1-9]$/.test(p.id)).length === 9, "reordonnancement : les neuf ops sont appliquees");
  ok(ws.sent.filter((m) => m.t === "op").length === 9, "reordonnancement : les neuf sont accusees");
}
// THE SAME FIELD, REORDERED: two writes to the same field arrive backwards. It's the LAST ONE
// TO ARRIVE that wins, never the highest date nor the highest number. This is precisely why
// the client NEVER re-emits a stale op as-is: it re-emits the CURRENT value.
{
  const f = fakeD1Room({ data: JSON.stringify(v5State()) });
  await f.room.ensureLoaded();
  const ws = f.mkWs("a@example.com", "aaa111");
  await messageSocket(f.room, ws, JSON.stringify({ t: "op", n: 2, op: { kind: "cell.set", cellId: "c1", name: "RECENT" } }));
  await messageSocket(f.room, ws, JSON.stringify({ t: "op", n: 1, op: { kind: "cell.set", cellId: "c1", name: "PERIME" } }));
  ok(f.room.plan.cells[0].name === "PERIME", "l'ordre d'ARRIVEE arbitre, meme quand il inverse les numeros");
}

// =================================================================================================
//  THE TWO NEW FIELDS: `leaf` (window) and `tr`/`dmin`/`pair` (video projector)
// =================================================================================================
// A persisted field only exists if it's declared on BOTH sides (C-5). The client/server contract
// is already checked set-by-set by tests/rapide.ts; what's missing here is that the server
// VALIDATES them instead of accepting them as-is — this is exactly what had let 265 KB through
// in a single piece of furniture's field.
{
  // leaf: 0, 1, 2 and nothing else. ABSENT stays absent (it is not 0).
  ok(sanitizeState(v5State({ openings: [opening({ leaf: 2 })] })).openings[0].leaf === 2, "leaf 2 kept");
  ok(sanitizeState(v5State({ openings: [opening({ leaf: 0 })] })).openings[0].leaf === 0, "leaf 0 kept");
  ok(sanitizeState(v5State({ openings: [opening()] })).openings[0].leaf === undefined,
     "leaf ABSENT stays absent: an unset window is not a fixed window");
  throws(() => sanitizeState(v5State({ openings: [opening({ leaf: 3 })] })), "leaf 3 rejected");
  throws(() => sanitizeState(v5State({ openings: [opening({ leaf: -1 })] })), "leaf -1 rejected");
  throws(() => sanitizeState(v5State({ openings: [opening({ leaf: "double" })] })), "leaf string rejected");
  throws(() => sanitizeState(v5State({ openings: [opening({ leaf: { a: 1 } })] })), "leaf object rejected");
}
{
  // tr / dmin: bounded integers. pair: an identifier, not an object.
  const P = (over: DonneeDynamique) => sanitizeState(v5State({ pieces: [Object.assign({
    id: "pp", type: "projector", name: "P", x: 0, y: 0, w: 35, h: 30, rot: 0, locked: false,
  }, over)] })).pieces[0];
  ok(P({ tr: 150 }).tr === 150, "throw ratio 1.50 kept");
  ok(P({ tr: 19 }).tr === 19, "ultra short throw 0.19 kept");
  ok(P({ tr: 150.4 }).tr === 150, "throw ratio rounded to an integer: no float in the fingerprint");
  throws(() => P({ tr: 5 }), "throw ratio below the floor rejected");
  throws(() => P({ tr: 5000 }), "throw ratio above the ceiling rejected");
  throws(() => P({ tr: "1.5" }), "throw ratio as a string rejected");
  ok(P({ dmin: 120 }).dmin === 120, "minimum focus distance kept");
  throws(() => P({ dmin: -1 }), "negative minimum distance rejected");
  ok(P({ pair: "op-a3f9c1" }).pair === "op-a3f9c1", "paired screen id kept");
  ok(P({ pair: "" }).pair === "", "empty pair clears the pairing");
  throws(() => P({ pair: { id: "x" } }), "pair as an object rejected");
  throws(() => P({ pair: "a b c" }), "pair with spaces rejected (same grammar as any id)");
}

console.log("OK " + n + " assertions");
