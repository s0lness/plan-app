#!/usr/bin/env node
// =================================================================================================
//  DETERMINISTIC HARNESS — gap #4 from docs/collab-etat-de-l-art.md
// =================================================================================================
// The eighteen barrier suites drive real browsers: they prove INTEGRATION, but they can't explore
// ten thousand interleavings, and the only network effect they model is a uniform delay. This
// harness does the opposite: NO browser, the REAL server, two or three client replicas, and a
// transport driven by a SEED that loses, delays, reorders and duplicates frames. The same number
// replays exactly the same scenario.
//
//   node tests/harnais-graine.ts                 # normal mode: GRAINES_COURT seeds
//   node tests/harnais-graine.ts 3000            # long mode: 3000 seeds
//   node tests/harnais-graine.ts --graine 12345  # replay ONE seed, with its sequence
//   node tests/harnais-graine.ts --verbeux       # print every generated op
//
// ---- WHAT IS REAL, AND WHAT IS MODELED ----------------------------------------------------------
// REAL, imported without copying:
//   - the server: `PlanRoom` from live-worker/worker.ts, mounted on a storage and D1 double
//     (same doubles as tests/collab-accuses.ts), and `applyOp` / `sanitizeState` / `planFp` from
//     live-worker/ops.ts;
//   - the client's EMISSION: `ws5FieldDiff` and `ws5DiffOps` are IMPORTED from
//     `src/ts/fil/miroir.ts`, not recopied: a change to the client diff shows up here immediately;
//   - the emission MIRRORS: `ws5ShadowPut`, `wsShadowApplyOpInto`, `wsShadowFromServerInto` and
//     `wsShadowCopy`, imported from the same place. It's this pair (optimistic / acknowledged)
//     that decides what goes back out after a loss.
// MODELED, and it has to be said:
//   - RECEPTION. The real path (`src/ts/fil/reception.ts`) recomputes cells, bounds, paints and
//     talks to the screen: it doesn't run outside a browser. The replica therefore applies the
//     received op with `applyOp`, THE SAME code as the server, which is exactly the assumption
//     convergence rests on, "same function, same arrival order", and that's what's being tested.
//   - UNDO. The real `histApplyOp` (`src/ts/historique/rejeu.ts`) depends on derived geometry; the
//     replica replays peer ops onto the snapshot with `applyOp`, the same field-by-field merge
//     semantics, then republishes BY DIFF (mirror unchanged), exactly like
//     `restore({keepShadow:true})`.
//   - DELAYS. Time is a turn counter, not milliseconds: the client's 2.5 s guard delay becomes
//     "on every idle turn, resend the diff against the acknowledged state".
//
// ---- WHAT IS CHECKED -----------------------------------------------------------------------------
//   1. CONVERGENCE: traffic quiet => fingerprint(A) === fingerprint(B) === fingerprint(server).
//   2. UNDO (Figma's rule): N undos then N redos give back an IDENTICAL document, including with
//      a peer's ops interleaved in.
//   3. BUSINESS INVARIANTS after EVERY merge (what the Automerge Model Checker recommends):
//      no orphaned opening, no opening outside its wall, no zero-length wall, closed outline,
//      no opening depth greater than its wall's thickness.
// Client code is imported from the TypeScript MODULES: a rename becomes a compile error.
// The server stays imported from its own source and is never recopied here.

import type { DonneeDynamique } from "./_types.ts";
import { applyOp, sanitizeState, planFp, OpError } from "../live-worker/ops.ts";
import type { Operation, PlanState, Wall } from "../live-worker/ops.ts";
import { PlanRoom } from "../live-worker/worker.ts";
import type { Miroir, PlanFil } from "../src/ts/partage/plan.ts";

type MessageFil = { t?: string; tag?: string; op?: Operation; state?: PlanState } & Record<string, unknown>;
type FauxSocket = WebSocket & { boite: MessageFil[] };

import {
  v5R2, v5ClampOpeningsOfWall, wireIdentite,
  wsShadowCopy, wsShadowFromServerInto, ws5ShadowPut, wsShadowApplyOpInto, ws5FieldDiff, ws5DiffOps,
} from "../src/ts/noyau.ts";

// ---- arguments -----------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const VERBEUX = argv.includes("--verbeux");
const iGraine = argv.indexOf("--graine");
const GRAINE_UNIQUE = iGraine >= 0 ? Number(argv[iGraine + 1]) : null;
const GRAINES_COURT = 2500;
const N_GRAINES = Number(argv.find((a) => /^\d+$/.test(a))) || GRAINES_COURT;
// =================================================================================================
//  1. THE CLIENT CODE, IMPORTED (no more textual carve-out)
// =================================================================================================
// `CLIENT` keeps exactly the same keys as before, so the rest of the file stays unchanged.
// Two adaptations, and they are the whole point of the port:
//
//  1. THE FOUR *Wire* FUNCTIONS ARE NO LONGER SUBSTITUTED BY A CLOSURE: THEY ARE AN ARGUMENT.
//     This bench's entities are ALREADY in wire shape (they come out of `sanitizeState` /
//     `applyOp`, that is, out of the server validator itself), so the pass-through is a copy:
//     that's `wireIdentite`. It used to be "the only substitution in this whole file"; it is now
//     a typed parameter of `wsShadowFromServerInto` / `wsShadowApplyOpInto`.
//  2. `v5Seg` and `v5OpeningDepthMax` are no longer extracted: they live INSIDE the ported
//     function (`v5ClampOpeningsOfWall`), which has always taken the plan as an argument.
const CLIENT = {
  v5R2,
  wsShadowCopy,
  ws5ShadowPut,
  ws5FieldDiff,
  ws5DiffOps,
  v5ClampOpeningsOfWall,
  wsShadowFromServerInto: (m: DonneeDynamique, st: DonneeDynamique) => wsShadowFromServerInto(m, st, wireIdentite),
  wsShadowApplyOpInto: (m: DonneeDynamique, op: DonneeDynamique) => wsShadowApplyOpInto(m, op, wireIdentite),
};


// =================================================================================================
//  2. REPRODUCIBLE RANDOMNESS
// =================================================================================================
// xorshift32: same seed, same sequence, on every machine. `Math.random` has no place here.
// The seed first goes through an avalanche (splitmix32) and eight draws are discarded: without
// that, two neighboring seeds give a neighboring FIRST draw. Measured, and it's a costly trap:
// since a frame's fate is drawn from a stream indexed by (device, number), every frame from the
// same device would get lost or go through AS A BLOCK, and the harness would report a false
// divergence.
function melange(n: number) {
  let z = (n ^ 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}
function alea(graine: number) {
  let x = melange(graine | 0) | 0 || 0x9e3779b9;
  const f = () => { x ^= x << 13; x |= 0; x ^= x >>> 17; x ^= x << 5; x |= 0; return (x >>> 0) / 4294967296; };
  for (let i = 0; i < 8; i++) f();
  f.entier = (n: number) => Math.floor(f() * n);
  f.choix = (t: DonneeDynamique) => t[f.entier(t.length)];
  return f;
}

// =================================================================================================
//  3. THE STARTING PLAN
// =================================================================================================
// A tiny but complete apartment: closed outline, four facades, one partition, two cells, two
// openings, three pieces of furniture. Enough for the invariants to make sense, small enough
// for a reduced sequence to stay readable.
function planDepart(): PlanState {
  const W = 600, H = 400, T = 12;
  return sanitizeState({
    outline: [[0, 0], [W, 0], [W, H], [0, H]],
    walls: [
      { id: "w1", a: [0, 0], b: [W, 0], t: T },
      { id: "w2", a: [W, 0], b: [W, H], t: T },
      { id: "w3", a: [W, H], b: [0, H], t: T },
      { id: "w4", a: [0, H], b: [0, 0], t: T },
      { id: "w5", a: [300, 0], b: [300, H], t: T },
    ],
    openings: [
      { id: "o1", wallId: "w5", t0: 150, w: 80, h: T, type: "door", side: 0, hinge: 0, swing: 1, name: "Porte" },
      { id: "o2", wallId: "w1", t0: 60, w: 120, h: T, type: "window", side: 0, hinge: 0, name: "Fenêtre" },
    ],
    pieces: [
      { id: "p1", type: "sofa", name: "Canapé", x: 40, y: 60, w: 200, h: 90, rot: 0, locked: false },
      { id: "p2", type: "bed", name: "Lit", x: 340, y: 60, w: 160, h: 200, rot: 0, locked: false },
      { id: "p3", type: "table", name: "Table", x: 60, y: 240, w: 120, h: 80, rot: 0, locked: false },
    ],
    cells: [
      { id: "c1", poly: [[0, 0], [300, 0], [300, H], [0, H]], name: "Salon", floor: "parquet" },
      { id: "c2", poly: [[300, 0], [W, 0], [W, H], [300, H]], name: "Chambre", floor: "parquet" },
    ],
    setupDone: true,
  });
}
const longueur = (w: DonneeDynamique) => Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);

// =================================================================================================
//  4. THE BUSINESS INVARIANTS
// =================================================================================================
// Checked AFTER EVERY MERGE, on all three plans. Two individually valid states can merge into a
// state that isn't: that's exactly what we're looking for.
const EPS = 0.51;
function invariants(plan: DonneeDynamique) {
  const maux = [];
  const murs = new Map<string, Wall>((plan.walls || []).map((w: DonneeDynamique) => [String(w.id), w]));
  for (const w of plan.walls || []) {
    if (longueur(w) <= EPS) maux.push(`mur_longueur_nulle:${w.id}`);
  }
  for (const o of plan.openings || []) {
    const w = murs.get(String(o.wallId));
    if (!w) { maux.push(`ouverture_orpheline:${o.id}`); continue; }
    if (o.t0 < -EPS || o.t0 + o.w > longueur(w) + EPS)
      maux.push(`ouverture_hors_du_mur:${o.id}(t0=${o.t0}+w=${o.w}>L=${longueur(w).toFixed(1)})`);
    if (o.h !== undefined && o.h > w.t + EPS)
      maux.push(`profondeur_au_dela_du_mur:${o.id}(h=${o.h}>t=${w.t})`);
  }
  const out = plan.outline;
  if (!Array.isArray(out) || out.length < 3) maux.push("contour_non_ferme:moins_de_3_points");
  else {
    for (let i = 0; i < out.length; i++) {
      const a = out[i], b = out[(i + 1) % out.length];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= EPS) { maux.push(`contour_non_ferme:arete_nulle_${i}`); break; }
    }
  }
  return maux;
}

// The KNOWN violations, left green on purpose. Each one is named, dated and tied to a
// reproducible seed: they describe a defect in the APPLICATION, not in the harness, and this
// batch fixes no behavior (see the report). Removing an entry from here must turn the suite red
// as long as the defect is present.
// Fixed on 2026-08-05: `ouverture_hors_du_mur` and `profondeur_au_dela_du_mur` were held to be
// accepted consequences of rule 17 (the receiver doesn't rebound). They weren't: rule 17 protects
// the plan of SOMEONE we would silently reset, but here the merge's result is wrong on BOTH
// screens, so no one is left to repair it. `v5ClampOpeningsOfWall` (js/52) bounds what depends on
// the wall NAMED by the op, nothing else, monotonically and deterministically.
const CONNUS: DonneeDynamique[] = [];
// `--strict` puts the known cases back to red: that's how we CHECK they're still there (an
// exception that's become pointless must show), and how we get their minimal seed for the report.
const STRICT = argv.includes("--strict");
const inconnus = (maux: string[]) => (STRICT ? maux : maux.filter((m: DonneeDynamique) => !CONNUS.some((re) => re.test(m))));

// =================================================================================================
//  5. THE SERVER: the REAL PlanRoom, over doubles
// =================================================================================================
function faireServeur(plan: DonneeDynamique) {
  const kv = new Map();
  let alarme: DonneeDynamique = null;
  const storage = {
    get: (k: string) => Promise.resolve(Array.isArray(k)
      ? new Map(k.filter((x) => kv.has(x)).map((x) => [x, kv.get(x)]))
      : kv.get(k)),
    put: (a: DonneeDynamique, b: DonneeDynamique) => { if (typeof a === "string") kv.set(a, b); else Object.keys(a).forEach((k) => kv.set(k, a[k])); return Promise.resolve(); },
    getAlarm: () => Promise.resolve(alarme),
    setAlarm: (t: DonneeDynamique) => { alarme = t; return Promise.resolve(); },
    deleteAlarm: () => { alarme = null; return Promise.resolve(); },
  };
  let ligne = { data: JSON.stringify(plan), rev: 1, updated_by: "amorce", updated_at: "" };
  const env = { DB: { prepare: () => ({
    args: [] as DonneeDynamique[],
    bind(...a: DonneeDynamique[]) { this.args = a; return this; },
    first: () => Promise.resolve(ligne),
    run() { ligne = { data: this.args[0], rev: ligne.rev + 1, updated_by: "live", updated_at: this.args[1] }; return Promise.resolve({}); },
  }) } };
  const sockets: DonneeDynamique[] = [];
  const st = { storage, getWebSockets: () => sockets.slice(), acceptWebSocket() {} };
  const room = new PlanRoom(
    st as unknown as ConstructorParameters<typeof PlanRoom>[0],
    env as unknown as ConstructorParameters<typeof PlanRoom>[1],
  );
  const ouvrir = (tag: string, email: string) => {
    let att = { email, color: "#1f6f78", tag };
    const boite: DonneeDynamique[] = [];
    const ws = {
      deserializeAttachment: () => att,
      serializeAttachment: (a: DonneeDynamique) => { att = a; },
      send: (s: DonneeDynamique) => boite.push(JSON.parse(s)),
      close() {},
      boite,
    } as unknown as FauxSocket;
    sockets.push(ws);
    return ws;
  };
  return { room, ouvrir, sockets };
}

// =================================================================================================
//  6. A CLIENT REPLICA
// =================================================================================================
const miroirVide = (): Miroir => ({ outline: null, walls: new Map(), openings: new Map(), pieces: new Map(), cells: new Map() });
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));

// ---- BOUNDING ON RECEIPT, WRITTEN ONCE ------------------------------------------------------------
// C-12: on receiving a `wall.set` or an `opening.set`, the client bounds the openings OF THE WALL
// NAMED by the op (`v5ClampOpeningsOfWall`). The server, for its part, does NOT bound `t0` by the
// wall's length (V-4, deliberate: "if we touched it, it would be a clamp, never a refusal"). So
// the two can't coincide as soon as a received shortening actually bounds an opening.
// TWO paths in this file apply a RECEIVED op: the replica (§6) and the round-trip ORACLE (§9),
// which replays peers' arrived ops onto the snapshot. As long as the oracle only replayed with
// `applyOp`, it expected a document the client cannot produce. Measured on seed 93793636: an
// `opening.set t0=234` received on a wall that had become 157 long gave `expected t0=234` against
// `client t0=95`. This was not a defect in the application, it was the oracle only modeling HALF
// of the reception path. So the rule is written HERE, once, and both paths use it: rewriting it
// on only one side would reproduce exactly this false red.
function bornerAlaReception(plan: DonneeDynamique, op: DonneeDynamique) {
  if (op.kind === "wall.set" && op.wall) CLIENT.v5ClampOpeningsOfWall(plan, op.wall.id);
  else if (op.kind === "opening.set" && op.opening) {
    const cible = (plan.openings || []).find((o: DonneeDynamique) => String(o.id) === String(op.opening.id));
    if (cible) CLIENT.v5ClampOpeningsOfWall(plan, cible.wallId, { only: cible.id });
  }
  return plan;
}
// Applying a RECEIVED op: `applyOp` (the server validator, same as the real merge path), THEN the
// bound. An op refused by the validator bounds nothing: same order, same exit point as
// `Replique.recevoir`.
function appliquerRecu(plan: DonneeDynamique, op: DonneeDynamique) {
  return bornerAlaReception(applyOp(plan, clone(op)), op);
}

class Replique {
  nom: string;
  tag: string;
  email: string;
  plan: PlanState;
  ws5: Miroir;
  ws5Ack: Miroir;
  n: number;
  enVol: Operation[];
  undo: { s: string; m: number }[];
  redo: { s: string; m: number }[];
  histLog: Operation[];
  refusRecus: string[];
  seqId = 0;
  ws: FauxSocket;
  reconnexionDemandee?: boolean;
  constructor(nom: string, tag: string, email: string, plan: PlanState) {
    this.nom = nom; this.tag = tag; this.email = email;
    this.plan = clone(plan);
    this.ws5 = miroirVide();
    this.ws5Ack = miroirVide();
    this.n = 0;                 // op number, specific to the device
    this.enVol = [];            // ops emitted, not yet seen coming back (for the report)
    this.undo = []; this.redo = []; this.histLog = []; this.refusRecus = [];
    this.synchroniser(); CLIENT.wsShadowCopy(this.ws5, this.ws5Ack);
  }
  // This replica's plan is ALREADY in wire shape (it comes out of the server validator): the
  // mirror is therefore filled directly, where the client goes through v5StateWire().
  wire(): PlanFil {
    const p = this.plan, tri = (a: DonneeDynamique, b: DonneeDynamique) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
    return {
      outline: (p.outline || []).map((q) => [CLIENT.v5R2(q[0]), CLIENT.v5R2(q[1])] as [number, number]),
      walls: clone(p.walls || []).sort(tri), openings: clone(p.openings || []).sort(tri),
      pieces: clone(p.pieces || []).sort(tri), cells: clone(p.cells || []).sort(tri),
      setupDone: !!p.setupDone,
    } as unknown as PlanFil;
  }
  synchroniser() {
    const w = this.wire(), m = this.ws5;
    m.outline = JSON.stringify(w.outline);
    m.walls = new Map(w.walls.map((e) => [String(e.id), JSON.stringify(e)]));
    m.openings = new Map(w.openings.map((e) => [String(e.id), JSON.stringify(e)]));
    m.pieces = new Map(w.pieces.map((e) => [String(e.id), JSON.stringify(e)]));
    m.cells = new Map(w.cells.map((e) => [String(e.id), JSON.stringify(e)]));
  }
  // The ops the server is missing to describe our state. Two possible bases, and that's the
  // WHOLE protocol: the optimistic one as things stream by, the acknowledged one to resend
  // whatever got lost.
  diff(base: DonneeDynamique) { return CLIENT.ws5DiffOps(this.wire(), base); }
  // Applies a RECEIVED op (an echo of our own, or a peer's op). The plan and BOTH mirrors advance.
  recevoir(op: DonneeDynamique, tag: string) {
    // The undo log describes what the SERVER accepted, not what this replica managed to apply:
    // it is therefore filled BEFORE the attempt. Filling it afterward let undo resurrect, from a
    // snapshot, a wall with a stale thickness when the peer's op had been refused locally by the
    // validator (measured: seed 9931426, t=17 on the client against t=18 on the server, with no
    // opening at fault).
    // THE DECISION IS THE `tag`, never the author's e-mail, and this harness has always modelled
    // it that way: `src/ts/fil/presence.ts` now matches it (it used to require a `by`, which a
    // guest never carries, so a guest's ops silently stayed out of the journal).
    if (tag !== this.tag && (this.undo.length || this.redo.length)) this.histLog.push(clone(op));
    try { this.plan = applyOp(this.plan, clone(op)); }
    catch (e) {
      if (!(e instanceof OpError)) throw e;
      // MODELING, not to be confused with a defect in the application. The real reception path
      // (`src/ts/fil/reception.ts`) MERGES without revalidating: it cannot refuse. Here the
      // replica applies with `applyOp`, which is also the VALIDATOR: a received op can therefore
      // be refused locally (typically an `opening.set` whose wall doesn't exist yet on this side)
      // while the server accepted it. We count it and say so, rather than let a false
      // "convergence defect" come out of the harness.
      this.refusRecus.push(op.kind + ":" + e.reason);
      return false;
    }
    // The REAL reception path (`src/ts/fil/reception.ts`) bounds what depends on the wall NAMED
    // by the op, and nothing else: it's the hole rule 17 left open (a peer thins or shortens a
    // wall while we're placing an opening on it, and the merge is wrong on BOTH screens). The
    // function is the source's own, carved out, not a copy. The MIRRORS, meanwhile, only advance
    // on the op: the bounded value therefore differs from the mirror and goes back out on the
    // next diff, exactly like `wsApplyRemoteOp`'s exit `save()` republishes it.
    bornerAlaReception(this.plan, op);
    CLIENT.wsShadowApplyOpInto(this.ws5, op);
    CLIENT.wsShadowApplyOpInto(this.ws5Ack, op);
    return true;
  }
  // A full state pushed by the server (`state`, `hello`): both mirrors describe it.
  adopter(st: DonneeDynamique) {
    this.plan = sanitizeState(clone(st));
    CLIENT.wsShadowFromServerInto(this.ws5, this.plan);
    CLIENT.wsShadowCopy(this.ws5, this.ws5Ack);
  }
  // ---- undo: snapshot + replay of peers' ops, publication BY DIFF -------------------------------
  pousserHistorique() {
    this.undo.push({ s: JSON.stringify(this.plan), m: this.histLog.length });
    if (this.undo.length > 60) this.undo.shift();
    this.redo.length = 0;
  }
  rejouer(entree: DonneeDynamique) {
    let p = sanitizeState(JSON.parse(entree.s));
    for (let i = entree.m; i < this.histLog.length; i++) {
      try { p = applyOp(p, clone(this.histLog[i])); } catch (e) { if (!(e instanceof OpError)) throw e; }
    }
    return p;
  }
  annuler() {
    if (!this.undo.length) return false;
    this.redo.push({ s: JSON.stringify(this.plan), m: this.histLog.length });
    this.plan = this.rejouer(this.undo.pop());
    return true;   // mirrors UNCHANGED: the next diff publishes the difference (keepShadow)
  }
  retablir() {
    if (!this.redo.length) return false;
    this.undo.push({ s: JSON.stringify(this.plan), m: this.histLog.length });
    this.plan = this.rejouer(this.redo.pop());
    return true;
  }
}

// =================================================================================================
//  7. THE TRANSPORT THAT LOSES, DELAYS, REORDERS AND DUPLICATES
// =================================================================================================
// One turn = one time step. A client frame gets its verdict at emission: delivered right away,
// delayed by k turns (that's what produces reordering), duplicated, or LOST. Nothing is lost on
// the server -> client return: the protocol has no resend in that direction, that's what the
// `pong` and the fingerprint cover, and they are not the subject of this harness.
//
// A frame's fate is drawn from a randomness specific to (seed, device, op number), NOT from a
// shared stream: removing a step from the sequence therefore doesn't redistribute the losses of
// everything else, and sequence reduction (§10) makes sense. That's the same reason each gesture
// is drawn from its own stream, indexed by its ORIGINAL place.
class Transport {
  graine: number;
  taux: { perte: number; retard: number; doublon: number };
  tour: number;
  file: { trame: { cl: Replique; msg: { t: DonneeDynamique; op: Operation; n: number } }; quand: number }[];
  perdues: number;
  constructor(graine: number, taux: { perte: number; retard: number; doublon: number }) {
    this.graine = graine; this.taux = taux; this.tour = 0; this.file = []; this.perdues = 0;
  }
  emettre(trame: DonneeDynamique) {
    let h = this.graine >>> 0;
    for (const c of trame.cl.tag + ":" + trame.msg.n) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
    const rnd = alea(h);
    if (rnd() < this.taux.perte) { this.perdues++; return; }
    const d = rnd() < this.taux.retard ? 1 + rnd.entier(3) : 0;
    this.file.push({ trame, quand: this.tour + d });
    if (rnd() < this.taux.doublon) this.file.push({ trame, quand: this.tour + d + rnd.entier(3) });
  }
  prets() {
    const out = this.file.filter((e) => e.quand <= this.tour);
    this.file = this.file.filter((e) => e.quand > this.tour);
    return out.map((e) => e.trame);
  }
  vider() { this.tour += 1000; }
  enAttente() { return this.file.length; }
}

// =================================================================================================
//  8. THE SEQUENCE GENERATOR
// =================================================================================================
// PLAUSIBLE gestures, each bounded on ITS author's plan, exactly like the application (bounding
// belongs to the gesture's author). What breaks must come from the MERGE, not from an absurd
// gesture no interface would ever produce.
const GESTES = ["poser", "deplacer", "renommer", "supprimer", "redimensionner", "tracer_mur",
                "supprimer_mur", "raccourcir_mur", "poser_ouverture", "glisser_ouverture", "epaissir_mur",
                "annuler", "reconnecter"];

function appliquerGeste(cl: DonneeDynamique, geste: DonneeDynamique, rnd: DonneeDynamique) {
  const P = cl.plan;
  const marque = () => cl.pousserHistorique();
  switch (geste) {
    case "poser": {
      marque();
      const id = "p" + (++cl.seqId) + "-" + cl.tag;
      P.pieces.push({ id, type: "chair", name: "Chaise", x: 20 + rnd.entier(500), y: 20 + rnd.entier(300),
                      w: 40 + rnd.entier(60), h: 40 + rnd.entier(60), rot: 0, locked: false });
      return "poser " + id;
    }
    case "deplacer": {
      if (!P.pieces.length) return null;
      marque();
      const p = rnd.choix(P.pieces);
      p.x = 10 + rnd.entier(520); p.y = 10 + rnd.entier(320);
      return "deplacer " + p.id;
    }
    case "renommer": {
      if (!P.cells.length) return null;
      marque();
      const c = rnd.choix(P.cells);
      c.name = "Pièce " + rnd.entier(1000);
      return "renommer " + c.id;
    }
    case "supprimer": {
      const mien = P.pieces.filter((p: DonneeDynamique) => String(p.id).endsWith("-" + cl.tag));
      if (!mien.length) return null;
      marque();
      const p = rnd.choix(mien);
      P.pieces = P.pieces.filter((q: DonneeDynamique) => q.id !== p.id);
      return "supprimer " + p.id;
    }
    case "redimensionner": {
      if (!P.pieces.length) return null;
      marque();
      const p = rnd.choix(P.pieces);
      p.w = 30 + rnd.entier(200); p.h = 30 + rnd.entier(200);
      return "redimensionner " + p.id;
    }
    case "tracer_mur": {
      marque();
      const id = "w" + (++cl.seqId) + "-" + cl.tag;
      const x = 60 + rnd.entier(480);
      P.walls.push({ id, a: [x, 0], b: [x, 400], t: 8 + rnd.entier(10) });
      return "tracer_mur " + id;
    }
    case "poser_ouverture": {
      // An INTERIOR partition only: a facade is not deleted and does not move here.
      const cand = P.walls.filter((w: DonneeDynamique) => longueur(w) > 120);
      if (!cand.length) return null;
      marque();
      const w = rnd.choix(cand);
      const id = "o" + (++cl.seqId) + "-" + cl.tag;
      const ow = 60 + rnd.entier(40);
      P.openings.push({ id, wallId: String(w.id), t0: Math.round(rnd() * (longueur(w) - ow)),
                        w: ow, h: w.t, type: "window", side: 0, hinge: 0, name: "Fenêtre" });
      return "poser_ouverture " + id + "@" + w.id;
    }
    case "glisser_ouverture": {
      if (!P.openings.length) return null;
      const o = rnd.choix(P.openings);
      const w = P.walls.find((x: DonneeDynamique) => String(x.id) === String(o.wallId));
      if (!w) return null;
      marque();
      // Bounded on MY wall, at the moment of MY gesture: that's what the application does.
      o.t0 = Math.max(0, Math.round(rnd() * Math.max(0, longueur(w) - o.w)));
      return "glisser_ouverture " + o.id;
    }
    case "raccourcir_mur": {
      // Pulling the end of a PARTITION. The gesture's author bounds their OWN openings to the new
      // length (that's what the interface does, and that's the rule: bounding belongs to the
      // author, the receiver does not rebound). Facades do not move here.
      const cand = P.walls.filter((w: DonneeDynamique) => String(w.id).includes("-"));
      if (!cand.length) return null;
      marque();
      const w = rnd.choix(cand);
      w.b = [w.b[0], 120 + rnd.entier(260)];
      const L = longueur(w);
      P.openings.forEach((o: DonneeDynamique) => {
        if (String(o.wallId) !== String(w.id)) return;
        o.w = Math.min(o.w, Math.max(1, Math.floor(L)));
        o.t0 = Math.max(0, Math.min(o.t0, Math.floor(L - o.w)));
      });
      return "raccourcir_mur " + w.id;
    }
    case "epaissir_mur": {
      if (!P.walls.length) return null;
      marque();
      const w = rnd.choix(P.walls);
      w.t = 4 + rnd.entier(20);
      // The depth of THIS wall's openings follows downward, never upward (js/52).
      P.openings.forEach((o: DonneeDynamique) => { if (String(o.wallId) === String(w.id) && o.h > w.t) o.h = w.t; });
      return "epaissir_mur " + w.id;
    }
    case "supprimer_mur": {
      // A FACADE is not deleted (js/52, `v5WallDeleteVerdict`): only partitions TRACED by this
      // device go away, and their openings go with them, one op per opening, exactly the
      // two-step cascade the diff emitter produces (AGENTS.md).
      const mien = P.walls.filter((w: DonneeDynamique) => String(w.id).endsWith("-" + cl.tag));
      if (!mien.length) return null;
      marque();
      const w = rnd.choix(mien);
      P.walls = P.walls.filter((x: DonneeDynamique) => x.id !== w.id);
      P.openings = P.openings.filter((o: DonneeDynamique) => String(o.wallId) !== String(w.id));
      return "supprimer_mur " + w.id;
    }
    case "annuler":
      return cl.annuler() ? "annuler" : null;
    case "reconnecter":
      // The socket dropped and comes back. Work left IN FLIGHT is replayed on top of the adopted
      // state: without that, adoption erased it without a word (AGENTS.md, gap #2). That's the
      // rebasing path from `src/ts/fil/presence.ts`.
      cl.reconnexionDemandee = true;
      return "reconnecter";
  }
  return null;
}

// =================================================================================================
//  9. ONE FULL RUN, FROM A SEED
// =================================================================================================
// `sequence` (optional) replays a sequence that's already been reduced; otherwise it's drawn from the seed.
async function executer(graine: number, opts?: DonneeDynamique) {
  opts = opts || {};
  const rnd = alea(graine);
  const base = planDepart();
  const srv = faireServeur(base);
  const nClients = 2 + (graine % 2);            // two or three devices
  const taux = { perte: 0.10 + rnd() * 0.15, retard: 0.30, doublon: 0.05 };
  const tr = new Transport(graine ^ 0x5bf03635, taux);

  const clients: DonneeDynamique[] = [];
  for (let i = 0; i < nClients; i++) {
    const tag = "dev" + i;
    const ws = srv.ouvrir(tag, i === 0 ? "a@example.com" : "b@example.com");
    const cl = new Replique("C" + i, tag, i === 0 ? "a@example.com" : "b@example.com", base);
    cl.seqId = 100 + i * 100; cl.ws = ws;
    clients.push(cl);
  }
  // Handshake: everyone introduces themselves, the server serves them their hello.
  for (const cl of clients) {
    await srv.room.webSocketMessage(cl.ws, JSON.stringify({ t: "hello" }));
    for (const m of cl.ws.boite.splice(0)) if (m.t === "hello") cl.adopter(m.state);
  }

  const journal = [];
  const violations: DonneeDynamique[] = [];      // DURABLE: still there once traffic goes quiet
  const transitoires: DonneeDynamique[] = [];    // for the duration of a burst: a gesture becomes SEVERAL ops
  // Two weights, two measures, and it's deliberate. A gesture from the interface (thinning a
  // wall and pulling down the depth of its openings) goes out as SEVERAL ops: between the first
  // and the last, the server holds a state the interface would never have produced. That's
  // inherent to a wire with no transactions, it settles by itself, and counting it as a defect
  // would drown out the real ones. What matters is what's left once traffic goes quiet.
  const controler = (quand: DonneeDynamique, durable: DonneeDynamique) => {
    for (const p of [srv.room.plan, ...clients.map((c) => c.plan)]) {
      const maux = inconnus(invariants(p));
      if (maux.length) (durable ? violations : transitoires).push({ quand, maux });
    }
  };
  controler("depart", true);

  // ---- a client sends: diff against the chosen mirror, numbering, transport ---------------------
  const emettre = (cl: DonneeDynamique, base: DonneeDynamique) => {
    const ops = cl.diff(base);
    if (base === cl.ws5Ack) CLIENT.wsShadowCopy(cl.ws5Ack, cl.ws5);   // resend: starting over from the acknowledged state
    for (const op of ops) {
      cl.n++;
      tr.emettre({ cl, msg: { t: "op", op, n: cl.n } });
    }
    cl.synchroniser();   // the OPTIMISTIC mirror advances on emission
    return ops.length;
  };

  // ---- one turn: the transport delivers to the server, the server replies to everyone -----------
  const tourner = async () => {
    tr.tour++;
    for (const t of tr.prets()) await srv.room.webSocketMessage(t.cl.ws, JSON.stringify(t.msg));
    let bouge = false;
    for (const cl of clients) {
      for (const m of cl.ws.boite.splice(0)) {
        bouge = true;
        if (m.t === "op") cl.recevoir(m.op, m.tag);
        else if (m.t === "state" || m.t === "hello") cl.adopter(m.state);
        else if (m.t === "gap") emettre(cl, cl.ws5Ack);
        // `ack` (duplicate) and `err` (refusal): nothing to apply. A refusal leaves the local
        // change in place; the next diff against the acknowledged state re-proposes it, which is
        // the client's behavior (a refusal's rollback lives in `src/ts/fil/reception.ts`).
      }
    }
    return bouge;
  };

  // ---- the sequence -------------------------------------------------------------------------------
  // Each step carries its ORIGINAL place (`k`) and draws its parameters from a stream indexed by
  // it: removing a step therefore doesn't reshuffle the others, and §10 can genuinely reduce.
  const sequence = opts.sequence || [];
  if (!opts.sequence) {
    const n = 12 + rnd.entier(14);
    for (let k = 0; k < n; k++) sequence.push({ k, c: rnd.entier(nClients), g: rnd.choix(GESTES) });
  }
  for (let i = 0; i < sequence.length; i++) {
    const pas = sequence[i];
    const rp = alea((graine ^ ((pas.k + 1) * 2654435761)) | 0);
    const cl = clients[pas.c];
    const quoi = appliquerGeste(cl, pas.g, rp);
    if (quoi === "reconnecter") {
      cl.reconnexionDemandee = false;
      journal.push(cl.nom + " reconnecter");
      if (VERBEUX) process.stdout.write("    " + cl.nom + " reconnecter\n");
      // What the server never received, BEFORE adoption: that's the work in flight.
      const enVol = cl.diff(cl.ws5Ack);
      await srv.room.webSocketMessage(cl.ws, JSON.stringify({ t: "hello" }));
      for (const m of cl.ws.boite.splice(0)) if (m.t === "hello" || m.t === "state") cl.adopter(m.state);
      for (const op of enVol) { try { cl.plan = applyOp(cl.plan, clone(op)); } catch (e) { if (!(e instanceof OpError)) throw e; } }
      emettre(cl, cl.ws5Ack);
    } else if (quoi) {
      journal.push(cl.nom + " " + quoi);
      if (VERBEUX) process.stdout.write("    " + cl.nom + " " + quoi + "\n");
      emettre(cl, cl.ws5);
    }
    // A few network turns between two gestures: that's where interleaving plays out.
    for (let k = 0; k < 1 + rp.entier(3); k++) await tourner();
    controler("geste " + i + " (" + (quoi || pas.g + ":sans effet") + ")", false);
  }

  // ---- traffic goes quiet -------------------------------------------------------------------------
  // We drain the queue, then everyone resends what the server never received (diff against the
  // acknowledged state), until nothing moves anymore. That's the client's 2.5 s guard delay, in
  // discrete time.
  tr.vider();
  for (let garde = 0; garde < 60; garde++) {
    let bouge = await tourner();
    for (const cl of clients) if (emettre(cl, cl.ws5Ack)) bouge = true;
    tr.vider();
    if (!(await tourner()) && !bouge) break;
  }
  controler("apres_extinction", true);

  // ---- INVARIANT 1: convergence ---------------------------------------------------------------
  const fpS = planFp(srv.room.plan);
  const fps = clients.map((c) => planFp(c.plan));
  const converge = fps.every((f) => f === fpS);
  const planServeur = clone(srv.room.plan), plansFinaux = clients.map((c) => clone(c.plan));

  // ---- INVARIANT 2: N undos then N redos give back the same document ----------------------------
  // Figma's verifiable rule, measured on client 0, WITH a peer's operations interleaved between
  // each notch. The peer PLACES new furniture: fresh identifiers, so no field in dispute, so the
  // expected state is well defined, that's `avant` on which the peer's ops are replayed. On a
  // disputed field, "identical" would no longer make sense: the final value would depend on
  // arrival order, which IS the arbiter (cf. Figma, last one to reach the server wins).
  let allerRetour = true, detailAR = "";
  const cl0 = clients[0];
  const avant = JSON.parse(JSON.stringify(cl0.plan));
  const m0 = cl0.histLog.length;
  const pair = clients[1];
  const rndAR = alea(graine ^ 0x1d872b41);
  const propager = async () => { for (let k = 0; k < 6; k++) { tr.vider(); await tourner(); } };

  let n = 0;
  while (n < 5 && cl0.annuler()) {
    n++;
    emettre(cl0, cl0.ws5);
    if (appliquerGeste(pair, "poser", rndAR)) emettre(pair, pair.ws5);
    await propager();
  }
  for (let i = 0; i < n; i++) {
    if (!cl0.retablir()) { allerRetour = false; detailAR = "rétablissement manquant"; break; }
    emettre(cl0, cl0.ws5);
    if (appliquerGeste(pair, "poser", rndAR)) emettre(pair, pair.ws5);
    await propager();
  }
  for (let garde = 0; garde < 40; garde++) {
    let bouge = await tourner();
    for (const cl of clients) if (emettre(cl, cl.ws5Ack)) bouge = true;
    tr.vider();
    if (!(await tourner()) && !bouge) break;
  }
  if (allerRetour && n > 0) {
    // The expected value: the document from before the dance, with the peer's ops replayed on
    // top. Replayed through the SAME path as reception (`appliquerRecu`, §6): these ops arrived
    // from the peer, so the client merged them THEN bounded them. A replay with `applyOp` alone
    // would expect a document the client cannot produce (seed 93793636).
    let attendu = sanitizeState(avant);
    for (let i = m0; i < cl0.histLog.length; i++) {
      try { attendu = appliquerRecu(attendu, cl0.histLog[i]); } catch (e) { if (!(e instanceof OpError)) throw e; }
    }
    if (planFp(attendu) !== planFp(cl0.plan)) {
      allerRetour = false;
      detailAR = `${n} annulations + ${n} rétablissements ne redonnent pas le document attendu · `
        + differences(attendu, cl0.plan).slice(0, 3).join(" | ");
    }
  }

  return {
    graine, sequence, journal, converge, allerRetour, detailAR, nAnnulations: n,
    fpS, fps, violations, transitoires, perdues: tr.perdues, nClients,
    planServeur, plans: plansFinaux, refus: clients.flatMap((c) => c.refusRecus),
    ok: converge && allerRetour && !violations.length,
  };
}

// =================================================================================================
//  10. REDUCTION: the MINIMAL sequence that reproduces the failure
// =================================================================================================
// Naive delta debugging: we remove a step, replay with the SAME seed, keep the removal if it
// still fails. A failure that can't be replayed is worthless; so is a 26-step failure.
async function reduire(graine: number, sequence: string[]) {
  let seq = sequence.slice();
  for (let passe = 0; passe < 3; passe++) {
    const avant = seq.length;
    for (let i = seq.length - 1; i >= 0 && seq.length > 1; i--) {
      const essai = seq.slice(0, i).concat(seq.slice(i + 1));
      let r;
      try { r = await executer(graine, { sequence: essai.map((p: DonneeDynamique) => ({ ...p })) }); } catch (_) { continue; }
      if (!r.ok) seq = essai;
    }
    if (seq.length === avant) break;
  }
  return seq;
}

// =================================================================================================
//  11. EXECUTION
// =================================================================================================
const echecs = [];
let passees = 0, transitoiresVus = 0;
const t0 = Date.now();
const graines = GRAINE_UNIQUE !== null ? [GRAINE_UNIQUE]
  : Array.from({ length: N_GRAINES }, (_, i) => 1000 + i * 7919);

for (const g of graines) {
  let r;
  try { r = await executer(g); }
  catch (e) { echecs.push({ graine: g, quoi: "le harnais a levé", detail: String(e && e.stack || e), sequence: [] as DonneeDynamique[] }); continue; }
  transitoiresVus += (r.transitoires||[]).length;
  if (r.ok) { passees++; if (GRAINE_UNIQUE !== null) rapportGraine(r); continue; }
  const quoi = !r.converge ? "divergence"
    : r.violations.length ? "invariant métier"
    : "aller-retour annuler/rétablir";
  const seqMin = await reduire(g, r.sequence);
  const rejoue = await executer(g, { sequence: seqMin.map((p: DonneeDynamique) => ({ ...p })) }).catch((): null => null);
  echecs.push({ graine: g, quoi, r, seqMin, rejoue });
}

// Exactly where two plans differ, in plain terms: it's the first thing you want to read.
function differences(a: DonneeDynamique, b: DonneeDynamique) {
  const out = [];
  if (JSON.stringify(a.outline) !== JSON.stringify(b.outline)) out.push("outline");
  for (const fam of ["walls", "openings", "pieces", "cells"]) {
    const ia = new Map((a[fam] || []).map((e: DonneeDynamique) => [String(e.id), JSON.stringify(e)]));
    const ib = new Map((b[fam] || []).map((e: DonneeDynamique) => [String(e.id), JSON.stringify(e)]));
    for (const [id, v] of ia) {
      if (!ib.has(id)) out.push(`${fam}/${id}: chez le serveur seulement`);
      else if (ib.get(id) !== v) out.push(`${fam}/${id}: srv=${v} clt=${ib.get(id)}`);
    }
    for (const id of ib.keys()) if (!ia.has(id)) out.push(`${fam}/${id}: chez le client seulement`);
  }
  return out;
}

function rapportGraine(r: DonneeDynamique) {
  process.stdout.write(`graine ${r.graine} · ${r.nClients} appareils · ${r.perdues} trames perdues\n`);
  r.journal.forEach((l: DonneeDynamique) => process.stdout.write("  " + l + "\n"));
  process.stdout.write(`  empreinte serveur ${r.fpS} · clients ${r.fps.join(" ")}\n`);
  process.stdout.write(`  convergence=${r.converge} aller-retour=${r.allerRetour} (${r.nAnnulations} annulations)\n`);
}

const secondes = ((Date.now() - t0) / 1000).toFixed(1);
process.stdout.write(`\nharnais déterministe : ${passees}/${graines.length} graines passées en ${secondes} s\n`);
process.stdout.write(`  invariants connus laissés verts : ${CONNUS.length} (voir CONNUS dans ce fichier)`
  + (STRICT ? " — REARMÉS par --strict" : "") + "\n");
if (transitoiresVus)
  process.stdout.write(`  états transitoires non conformes traversés : ${transitoiresVus}`
    + " (un geste part en plusieurs ops, ils se résorbent seuls)\n");
for (const e of echecs) {
  process.stdout.write(`\n  ÉCHEC graine ${e.graine} — ${e.quoi}\n`);
  if (e.detail) { process.stdout.write("    " + e.detail.split("\n").slice(0, 6).join("\n    ") + "\n"); continue; }
  if (e.r.violations.length)
    process.stdout.write("    invariants violés : " +
      [...new Set(e.r.violations.flatMap((v) => v.maux))].slice(0, 6).join(", ") + "\n");
  if (e.r.refus && e.r.refus.length) process.stdout.write(`    ops reçues refusées localement : ${[...new Set(e.r.refus)].join(", ")}
`);
  if (!e.r.converge) {
    process.stdout.write(`    serveur ${e.r.fpS} · clients ${e.r.fps.join(" ")}\n`);
    e.r.plans.forEach((p, i) => {
      if (e.r.fps[i] === e.r.fpS) return;
      differences(e.r.planServeur, p).slice(0, 4).forEach((d) => process.stdout.write(`    C${i} ${d}\n`));
    });
  }
  if (!e.r.allerRetour) process.stdout.write("    " + e.r.detailAR + "\n");
  process.stdout.write(`    séquence minimale (${e.seqMin.length} pas, rejouable) :\n`);
  process.stdout.write("      node tests/harnais-graine.ts --graine " + e.graine + "\n");
  e.seqMin.forEach((p: DonneeDynamique, i: number) => process.stdout.write(`      ${i + 1}. client ${p.c} : ${p.g}\n`));
}

if (echecs.length) { process.stdout.write(`\nFAILURES ${echecs.length}/${graines.length}\n`); process.exit(1); }
process.stdout.write(`OK ${passees}/${graines.length}\n`);
