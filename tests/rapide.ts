#!/usr/bin/env node
// =================================================================================================
//  THE FAST LOOP: against the TypeScript MODULES (src/ts), by import.
// =================================================================================================
//   node tests/rapide.ts     # 46 checks, all imported from the served client

import { applyOp as applyOpReel, sanitizeState as sanitizeStateReel, planFp, OpError } from "../live-worker/ops.ts";
import * as SRV from "../live-worker/ops.ts";
import type { Opening as OuvertureServeur, Operation, Piece, PlanState, Point } from "../live-worker/ops.ts";
import type { DonneeDynamique, PointTest, ResultatSimple } from "./_types.ts";
import type { Etat } from "../src/ts/modele/etat.ts";
import type { Miroir, Mur, Ouverture, PlanFil, PlanV5 } from "../src/ts/partage/plan.ts";

import {
  // core
  clamp, escapeHtml, WALL,
  // catalog
  TYPEMAP, LEGACY_TYPE_NAMES, fam, isWallMount,
  // geometry
  pointInPoly, polyArea, bboxOfPoly, closestOnSeg, nearestOnPoly, poleOfInaccessibility,
  selfIntersects, simplifyRectilinear,
  // model
  v5SignedArea, v5OverlapArea, v5DetectCells, v5AssignNames, v5RebuildCells,
  v5Seg, v5WallLen, v5OpeningSameSlot, v5OpeningDepthMax, v5OpeningDepthFor, v5OpeningEdgeLimits,
  v5OpeningBox, v5CellsAt, sanitizeV5Plan, v5ClampOpeningsOfWall,
  // wire
  v5StateWire, v5AdoptOpening, wireIdentite,
  wsShadowCopy, wsShadowFromServerInto, ws5ShadowPut, wsShadowApplyOpInto, ws5FieldDiff, ws5DiffOps,
  // rendering
  isChosenName, doorArcSVG,
  // shared contract, verified below against the server
  OPENING_TYPES, OPENING_SIDES, CELL_FLOORS, OPENING_KEYS, WALL_KEYS, PIECE_KEYS, CELL_KEYS,
  NAME_MAX, OPENING_H_MAX, OPENING_W_MAX, PIECE_WH_MAX, WALL_T_MIN, WALL_T_MAX,
} from "../src/ts/noyau.ts";
import { CATALOG, KIND_BY_TYPE, KIND_ORDER, catalogueParNature, kindOf } from "../src/ts/catalogue/catalogue.ts";
import { FL } from "../src/ts/circulation/etat.ts";
import { analyzeApt } from "../src/ts/circulation/regles.ts";
import { buildAptContext } from "../src/ts/circulation/contexte.ts";
import { carteLumiere, cibleLux, CIBLE_DEFAUT, sourcesLumiere } from "../src/ts/circulation/lumiere.ts";
import { oublierPhotoCellules, photoCellules, photographierCellules } from "../src/ts/modele/photo-cellules.ts";
import { meubleWallSnap } from "../src/ts/modele/espace.ts";
import { oublierAvantAimant, rotationAimantee } from "../src/ts/modele/aimant-memoire.ts";
import { outilMurALongueur, outilMurFin, outilMurNeuf, outilMurPoint } from "../src/ts/gestes/outil-mur.ts";
import { angleVersPointeur } from "../src/ts/gestes/guides.ts";
import { v5PlaceWallMount, v5WallMergeAt, v5WallMergeCandidate, v5WallSplitAt } from "../src/ts/modele/edition.ts";
// Le lot « un mur va d'un point à un point » (0012) éprouve le PIPELINE, pas un helper: le module
// entier est importé une fois, plutôt que six symboles nommés dont aucun n'a d'autre lecteur ici.
import * as MURS from "../src/ts/gestes/murs.ts";
import { empilables, passeAuDessus } from "../src/ts/catalogue/catalogue.ts";
import { PLAN_ID_RE as PLAN_ID_RE_FN } from "../functions/plan-id.ts";
import { cleanName as cleanNameFn } from "../functions/nom.ts";
import { porteDe } from "../functions/porte.ts";
import { cleanCursorSay, cleanGuestName } from "../live-worker/ops.ts";
import { hoteAutorise } from "../live-worker/worker.ts";
import { migrate } from "../src/ts/modele/etat.ts";
import { rescueUnreadable } from "../src/ts/modele/filets.ts";
import { V5_RESCUE_KEY } from "../src/ts/noyau/nombres.ts";

type OpBanc = Operation & {
  piece?: Partial<Piece>;
  opening?: Partial<OuvertureServeur>;
  pieceId?: string;
  [cle: string]: unknown;
};
// Like the server bench, these cases deliberately pass invalid shapes to the real validator.
const applyOp = (state: PlanState, op: unknown) => applyOpReel(state, op as Operation);
const sanitizeState = (state: unknown) => sanitizeStateReel(state as PlanState);

// =================================================================================================
//  0. THE CLIENT/SERVER CONTRACT, VERIFIED AT STARTUP (invariant C-5)
// =================================================================================================
// "A persisted field that is not declared in both the client's pseudo-wire AND live-worker/ops.ts never
// crosses the network, with no visible error. Two files, two repos, no mechanism." Already happened
// twice. Since the deliverable must stay standalone, `src/ts` cannot import `ops.ts`: the
// contract is therefore copied there, and the copy is only acceptable because it is compared here,
// set by set, BEFORE the slightest check runs.
// Same spirit as the original extraction: a disagreement fails STARTUP, loudly,
// rather than letting 46 green cases run against a stale contract.
(function verifierContratServeur() {
  const ecarts: string[] = [];
  const memeEnsemble = (nom: string, mien: Iterable<unknown>, sien: Iterable<unknown>) => {
    const a = [...mien].map(String).sort().join(",");
    const b = [...sien].map(String).sort().join(",");
    if (a !== b) ecarts.push(`${nom}\n    src/ts : ${a}\n    serveur: ${b}`);
  };
  const memeNombre = (nom: string, mien: number, sien: number) => {
    if (mien !== sien) ecarts.push(`${nom} : src/ts=${mien}, serveur=${sien}`);
  };
  memeEnsemble("OPENING_TYPES", OPENING_TYPES, SRV.OPENING_TYPES);
  memeEnsemble("OPENING_SIDES", OPENING_SIDES, SRV.OPENING_SIDES);
  memeEnsemble("CELL_FLOORS", CELL_FLOORS, SRV.CELL_FLOORS);
  memeEnsemble("OPENING_KEYS", OPENING_KEYS, SRV.OPENING_KEYS);
  memeEnsemble("WALL_KEYS", WALL_KEYS, SRV.WALL_KEYS);
  memeEnsemble("PIECE_KEYS", PIECE_KEYS, SRV.PIECE_KEYS);
  memeEnsemble("CELL_KEYS", CELL_KEYS, SRV.CELL_KEYS);
  memeNombre("NAME_MAX", NAME_MAX, SRV.NAME_MAX);
  memeNombre("OPENING_H_MAX", OPENING_H_MAX, SRV.OPENING_H_MAX);
  memeNombre("OPENING_W_MAX", OPENING_W_MAX, SRV.OPENING_W_MAX);
  memeNombre("PIECE_WH_MAX", PIECE_WH_MAX, SRV.PIECE_WH_MAX);
  memeNombre("WALL_T_MIN", WALL_T_MIN, SRV.WALL_T_MIN);
  memeNombre("WALL_T_MAX", WALL_T_MAX, SRV.WALL_T_MAX);
  if (ecarts.length) {
    throw new Error("CONTRAT CLIENT/SERVEUR ROMPU (invariant C-5), src/ts/partage/contrat-serveur.ts "
      + "ne dit plus la même chose que live-worker/ops.ts :\n  " + ecarts.join("\n  "));
  }
})();

// =================================================================================================
//  1. THE CLIENT CODE, IMPORTED
// =================================================================================================
// The six objects below carry EXACTLY the same keys as the six `new Function` in
// `tests/rapide.ts`, so the 46 checks hold without being touched. The only
// differences are SIGNATURES that became honest: what these functions used to read from the
// closure (`state.plan`, `state.opts`, the computed CSS color) is now an ARGUMENT.

const CLIENT = {
  state: { plan: null as DonneeDynamique, opts: {} },
  pointInPoly, closestOnSeg, poleOfInaccessibility, simplifyRectilinear,
  v5SignedArea, v5OverlapArea,
  v5DetectCells: (outline: unknown, walls: unknown) => v5DetectCells(outline as PlanV5["outline"], walls as Mur[]),
  v5AssignNames, v5RebuildCells,
  v5Seg,
  v5OpeningSameSlot: (a: { type: string; side: number }, b: { type: string; side: number }) =>
    v5OpeningSameSlot(a as Pick<Ouverture, "type" | "side">, b as Pick<Ouverture, "type" | "side">),
  v5OpeningDepthMax, v5OpeningDepthFor,
  fam, isWallMount, selfIntersects,
  // `v5WallLen(id)` used to read `state.plan`; `v5OpeningEdgeLimits(op,w)` used to read `state.plan.openings`
  // AND `state.opts` (through `pieceVisible`). Both now take what they read as arguments.
  v5WallLen: (id: string) => v5WallLen(CLIENT.state.plan, id),
  v5ClampOpeningsOfWall,
  v5OpeningEdgeLimits: (op: unknown, w: unknown) => v5OpeningEdgeLimits(CLIENT.state.plan,
    op as Parameters<typeof v5OpeningEdgeLimits>[1], w as Mur, CLIENT.state.opts),
};

// The wire: client EMISSION (field-by-field diff + ops) and MIRRORS. This bench's entities are
// already in wire shape (they come out of `sanitizeState`), so the four *Wire* functions are
// the identity, it used to be "the only substitution", it is now a typed parameter.
const FIL = {
  ws5ShadowPut, ws5FieldDiff,
  ws5DiffOps: (plan: PlanState, miroir: Miroir) =>
    ws5DiffOps(plan as unknown as PlanFil, miroir) as unknown as OpBanc[],
  wsShadowCopy,
  wsShadowFromServerInto: (m: Miroir, st: PlanFil | PlanState) => wsShadowFromServerInto(m, st as PlanFil, wireIdentite),
  wsShadowApplyOpInto: (m: Miroir, op: Operation) => wsShadowApplyOpInto(m, op as Parameters<typeof wsShadowApplyOpInto>[1], wireIdentite),
};

// `sanitizeV5Plan` (js/02) and `doorArcSVG` (js/11): two pure functions. `resolveColor` used to read a
// computed CSS variable, it was THE document dependency of `doorArcSVG`, it has become an
// argument with the same default value.
const PLAN = { sanitizeV5Plan, doorArcSVG, TYPEMAP };

// The pseudo-wire (js/51): `v5StateWire()` used to read `state.plan` and `state.setupDone`.
const WIRE = {
  state: { plan: null as PlanV5, setupDone: true },
  v5AdoptOpening: (opening: unknown): Ouverture =>
    v5AdoptOpening(opening as Parameters<typeof v5AdoptOpening>[0]) as unknown as Ouverture,
  v5StateWire: () => v5StateWire(WIRE.state.plan, WIRE.state.setupDone),
};

const NOMS = { isChosenName, TYPEMAP, LEGACY_TYPE_NAMES };

// =================================================================================================
//  1bis. THE CIRCULATION ENGINE, IMPORTED
// =================================================================================================
// The engine reads the same state object as the cases below. Only the minimal application context
// needed for its pure computation is set up; no DOM or rendering enters this suite.
const FLOW = { state: { plan: null, pieces: [], opts: {} } as Etat, analyzeApt, buildAptContext };
FL.ctx = { etat: FLOW.state } as typeof FL.ctx;

// =================================================================================================
//  2. ASSERTION PLUMBING (same vocabulary as _harness-v5.ts: `test` / `expect` / `near`)
// =================================================================================================
const results: ResultatSimple[] = [];
function test(name: string, corps: () => boolean | string | void): void {
  let pass = false, detail = "";
  try { const r = corps(); if (r === true || r === undefined) pass = true; else detail = String(r); }
  catch (e) { detail = String((e && e.stack) || e); }
  results.push({ name, pass, detail });
  process.stdout.write((pass ? "  ok   " : "  FAIL ") + name + "\n");
  if (!pass) process.stdout.write("       " + detail.replace(/\n/g, "\n       ") + "\n");
}
const near = (a: DonneeDynamique, b: DonneeDynamique, tol?: number): boolean => Math.abs(a - b) <= (tol == null ? 1 : tol);
function expect(cond: unknown, msg: string): true { if (!cond) throw new Error(msg); return true; }
const aire = (poly: Point[]): number => Math.round(Math.abs(CLIENT.v5SignedArea(poly)));
// The client's ACKNOWLEDGED mirror, built on the server's state: it is THIS that the diff compares.
function miroirDe(plan: PlanFil | PlanState): Miroir { const m = {} as Miroir; FIL.wsShadowFromServerInto(m, plan); return m; }
function copieDe(m: Miroir): Miroir { const d = {} as Miroir; FIL.wsShadowCopy(m, d); return d; }

// The 600x400 rectangle with its four facades, served everywhere (mirror of SEED_PLAN from the v5 harness).
const RECT = (): PlanV5 => ({
  outline: [[0, 0], [600, 0], [600, 400], [0, 400]],
  walls: [], openings: [], pieces: [], cells: [],
});

// =================================================================================================
//  2bis. DELIBERATE COPIES ACROSS BUNDLES, VERIFIED IDENTICAL (E2, same spirit as C-5 above)
// =================================================================================================
// `functions/` (Pages Functions) and `live-worker/` (the realtime Worker) are two independent
// bundles: neither can import from the other. Three small rules used to be copied THREE or FOUR
// times across them with no mechanism holding the copies together; each now lives in exactly ONE
// place per bundle (functions/plan-id.ts for the six functions/*.ts files; live-worker/ops.ts's
// own `cleanTexteBornee` for its two exports), and the remaining cross-bundle pair is compared
// here so a drift fails this fast suite instead of surfacing as a silently rejected id or a
// differently-cleaned name on one side of the wire.
test("e2_plan_id_re_identique_functions_live_worker", () =>
  expect(PLAN_ID_RE_FN.source === SRV.PLAN_ID_RE.source && PLAN_ID_RE_FN.flags === SRV.PLAN_ID_RE.flags,
    "functions/plan-id.ts et live-worker/ops.ts doivent accepter EXACTEMENT les mêmes identifiants\n  "
    + PLAN_ID_RE_FN + " vs " + SRV.PLAN_ID_RE));

test("e2_nettoyage_de_nom_identique_functions_live_worker", () => {
  const cas = [
    "Elise", "  padded  ", "", "a".repeat(200),
    "avant" + String.fromCharCode(7) + "milieu" + String.fromCharCode(127) + "apres",
    "avant" + String.fromCodePoint(0x202e) + "milieu" + String.fromCodePoint(0x202c) + "apres",
    "avant" + String.fromCodePoint(0x2066) + "milieu" + String.fromCodePoint(0x2069) + "apres",
    "Mélanie", "\t\ttabs\t\t", "juste un nom normal",
  ];
  const ecarts: string[] = [];
  for (const c of cas) {
    const guest = cleanNameFn(c, SRV.GUEST_NAME_MAX);
    const via = cleanGuestName(c);
    if (guest !== via) ecarts.push(`cleanName(${JSON.stringify(c)},${SRV.GUEST_NAME_MAX})=${JSON.stringify(guest)} vs cleanGuestName=${JSON.stringify(via)}`);
    const say = cleanNameFn(c, SRV.CURSOR_SAY_MAX);
    const viaSay = cleanCursorSay(c);
    if (say !== viaSay) ecarts.push(`cleanName(${JSON.stringify(c)},${SRV.CURSOR_SAY_MAX})=${JSON.stringify(say)} vs cleanCursorSay=${JSON.stringify(viaSay)}`);
  }
  // A non-string never throws on either side, and both come back empty.
  if (cleanNameFn(42, 40) !== cleanGuestName(42)) ecarts.push("un non-string doit rendre '' des deux côtés");
  return expect(ecarts.length === 0, ecarts.join("\n  "));
});

test("e2_hoteAutorise_identique_a_porteDe_pour_le_foyer", () => {
  const cas: { hosts?: string; host: string }[] = [
    { host: "plan.example.com" },
    { hosts: "plan.example.com", host: "plan.example.com" },
    { hosts: "plan.example.com", host: "autre.example.com" },
    { hosts: "*.plan-x.pages.dev", host: "abc123.plan-x.pages.dev" },
    { hosts: "*.plan-x.pages.dev", host: "plan-x.pages.dev" },
    { hosts: "PLAN.example.com , autre.example.com", host: "plan.example.com" },
    { hosts: "", host: "plan.example.com" },
  ];
  const ecarts: string[] = [];
  for (const c of cas) {
    const env = c.hosts === undefined ? {} : { HOUSEHOLD_HOSTS: c.hosts };
    const request = new Request("https://" + c.host + "/ws", { headers: { Host: c.host } });
    const attendu = porteDe(request, env) === "foyer";
    const vu = hoteAutorise(request, env);
    if (attendu !== vu) ecarts.push(`host=${c.host} hosts=${JSON.stringify(c.hosts)} : porteDe=foyer? ${attendu}, hoteAutorise=${vu}`);
  }
  return expect(ecarts.length === 0, ecarts.join("\n  "));
});

// =================================================================================================
//  3. GEOMETRY AND CELL DETECTION
//  (moved from tests/model-v5-cellules.ts, same names, same assertions, no Chrome)
// =================================================================================================
test("v5_detect_single_wall_2_cells", () => {
  const out = CLIENT.v5DetectCells([[0, 0], [600, 0], [600, 400], [0, 400]],
    [{ id: "w1", a: [300, 0], b: [300, 400], t: 12 }]);
  const areas = out.cells.map((c) => aire(c.poly));
  return expect(out.cells.length === 2, "2 cellules attendues, " + out.cells.length + " report=" + JSON.stringify(out.report))
      && expect(areas.every((a) => near(a, 120000, 500)), "chaque moitié = 300×400 = 120000 cm², vu " + JSON.stringify(areas));
});

test("v5_detect_cross_4_cells", () => {
  const out = CLIENT.v5DetectCells([[0, 0], [600, 0], [600, 400], [0, 400]],
    [{ id: "w1", a: [300, 0], b: [300, 400], t: 12 },
     { id: "w2", a: [0, 200], b: [600, 200], t: 12 }]);
  const areas = out.cells.map((c) => aire(c.poly));
  return expect(out.cells.length === 4, "4 cellules attendues, " + out.cells.length)
      && expect(areas.every((a) => near(a, 60000, 500)), "chaque quart = 300×200 = 60000 cm², vu " + JSON.stringify(areas))
      && expect(out.report.nodes >= 9, "le croisement doit créer le nœud intérieur (>=9 nœuds), vu " + out.report.nodes);
});

test("v5_detect_t_junction_3_cells", () => {
  const out = CLIENT.v5DetectCells([[0, 0], [600, 0], [600, 400], [0, 400]],
    [{ id: "w1", a: [300, 0], b: [300, 400], t: 12 },
     { id: "w2", a: [300, 200], b: [600, 200], t: 12 }]);
  const areas = out.cells.map((c) => aire(c.poly)).sort((a, b) => a - b);
  return expect(out.cells.length === 3, "la jonction en T doit rendre 3 cellules, vu " + out.cells.length)
      && expect(out.report.pruned === 0, "rien ne doit être élagué, pruned=" + out.report.pruned)
      && expect(near(areas[0], 60000, 500) && near(areas[1], 60000, 500) && near(areas[2], 120000, 500),
         "60000/60000/120000 cm² attendus, vu " + JSON.stringify(areas));
});

test("v5_detect_L_outline_1_cell", () => {
  // L: 600x400 minus a 200x150 notch at the top right -> 240000-30000 = 210000 cm2
  const out = CLIENT.v5DetectCells([[0, 0], [400, 0], [400, 150], [600, 150], [600, 400], [0, 400]], []);
  const c = out.cells[0];
  return expect(out.cells.length === 1, "contour en L sans mur = 1 cellule, vu " + out.cells.length)
      && expect(near(aire(c.poly), 210000, 500), "aire du L = 210000 cm², vu " + aire(c.poly))
      && expect(c.poly.length === 6, "la cellule concave garde ses 6 coins, vu " + c.poly.length);
});

test("v5_detect_dangling_wall_pruned", () => {
  const out = CLIENT.v5DetectCells([[0, 0], [600, 0], [600, 400], [0, 400]],
    [{ id: "w1", a: [300, 0], b: [300, 250], t: 12 }]);
  return expect(out.cells.length === 1, "un mur en cul-de-sac ne partitionne rien, vu " + out.cells.length + " cellules")
      && expect(out.report.pruned >= 1, "le cul-de-sac doit être élagué, pruned=" + out.report.pruned);
});

test("v5_names_survive_wall_move", () => {
  const P = RECT();
  P.walls.push({ id: "w1", a: [300, 0], b: [300, 400], t: 12 });
  CLIENT.v5RebuildCells(P);
  const minx = (c: PlanV5["cells"][number]) => c.poly.reduce((m: number, p: Point) => Math.min(m, p[0]), 1e9);
  const maxx = (c: PlanV5["cells"][number]) => c.poly.reduce((m: number, p: Point) => Math.max(m, p[0]), -1e9);
  const gauche = minx(P.cells[0]) < 150 ? P.cells[0] : P.cells[1];
  const droite = gauche === P.cells[0] ? P.cells[1] : P.cells[0];
  gauche.name = "Salon";   gauche.floor = "herringbone";
  droite.name = "Chambre"; droite.floor = "tile";
  P.walls[0].a = [400, 0]; P.walls[0].b = [400, 400];   // the wall moves by 100 cm
  CLIENT.v5RebuildCells(P);
  const L = P.cells.find((c) => minx(c) === 0), R = P.cells.find((c) => minx(c) === 400);
  return expect(P.cells.length === 2, "toujours 2 cellules après le déplacement, vu " + P.cells.length)
      && expect(L && L.name === "Salon" && L.floor === "herringbone",
         "la cellule gauche garde Salon/herringbone, vu " + JSON.stringify(L && { n: L.name, f: L.floor }))
      && expect(R && R.name === "Chambre" && R.floor === "tile",
         "la cellule droite garde Chambre/tile, vu " + JSON.stringify(R && { n: R.name, f: R.floor }))
      && expect(maxx(L) === 400, "la cellule gauche doit avoir grandi jusqu'à x=400, vu " + maxx(L));
});

test("v5_new_cell_gets_default_name", () => {
  const P = RECT();
  CLIENT.v5RebuildCells(P);
  P.cells[0].name = "Salon";
  P.walls.push({ id: "w1", a: [300, 0], b: [300, 400], t: 12 });
  CLIENT.v5RebuildCells(P);
  const names = P.cells.map((c) => c.name), floors = P.cells.map((c) => c.floor);
  return expect(names.length === 2, "2 cellules attendues, vu " + names.length)
      && expect(names.indexOf("Salon") >= 0, "Salon doit survivre, vu " + JSON.stringify(names))
      && expect(names.some((n) => /^Room \d+$/.test(n)), "la cellule neuve a besoin d'un défaut « Room N » (cf. modele/cellules.ts), vu " + JSON.stringify(names))
      && expect(floors.every((f) => typeof f === "string" && f.length), "chaque cellule a un sol, vu " + JSON.stringify(floors));
});

test("v5_cellAt_and_wallsOf", () => {
  const P = RECT();
  P.walls.push({ id: "w1", a: [300, 0], b: [300, 400], t: 12 });
  CLIENT.v5RebuildCells(P);
  // `cellAt`: the cell that CONTAINS the point (the client rule, js/02 and js/34).
  const cellAt = (x: number, y: number) => P.cells.find((c) => CLIENT.pointInPoly(x, y, c.poly)) || null;
  // `wallsOf`: the walls (outline included) with a segment running along the cell's edge.
  const bords = [...P.walls, { id: "_o", a: [0, 0], b: [600, 0] }, { id: "_r", a: [600, 0], b: [600, 400] },
                 { id: "_b", a: [600, 400], b: [0, 400] }, { id: "_l", a: [0, 400], b: [0, 0] }];
  // A wall borders the cell if its ENTIRE length runs along the edge (three sample points):
  // the midpoint alone is not enough, it lands on the neighboring cell's corner.
  const surLeBord = (cell: PlanV5["cells"][number], x: number, y: number) => {
    for (let i = 0; i < cell.poly.length; i++) {
      const p = cell.poly[i], q = cell.poly[(i + 1) % cell.poly.length];
      if (CLIENT.closestOnSeg(x, y, p[0], p[1], q[0], q[1]).dist <= 0.5) return true;
    }
    return false;
  };
  const wallsOf = (cell: PlanV5["cells"][number]) => bords.filter((w) => [0.25, 0.5, 0.75].every((t) =>
    surLeBord(cell, w.a[0] + (w.b[0] - w.a[0]) * t, w.a[1] + (w.b[1] - w.a[1]) * t)));
  const a = cellAt(100, 200), b = cellAt(500, 200), dehors = cellAt(-50, 200);
  const wa = wallsOf(a), wb = wallsOf(b);
  const partages = wa.filter((w) => wb.some((x) => x.id === w.id)).map((w) => w.id);
  return expect(a && b && a.id !== b.id, "les deux points doivent tomber dans des cellules différentes : " + (a && a.id) + "/" + (b && b.id))
      && expect(dehors === null, "un point hors contour doit rendre null, vu " + (dehors && dehors.id))
      && expect(partages.length === 1 && partages[0] === "w1",
         "le mur mitoyen est UN objet partagé par les deux, vu " + JSON.stringify(partages));
});

// Two model invariants the barrier did not verify directly anywhere.
test("rapide_cellules_pavent_le_contour", () => {
  const P = RECT();
  P.walls.push({ id: "w1", a: [300, 0], b: [300, 400], t: 12 },
                { id: "w2", a: [0, 200], b: [300, 200], t: 12 });
  CLIENT.v5RebuildCells(P);
  const somme = P.cells.reduce((s, c) => s + aire(c.poly), 0);
  return expect(near(somme, 240000, 800), "la somme des cellules doit valoir l'aire du contour (240000), vu " + somme);
});

// LE RECOUVREMENT RESTE EXACT SUR UN PAN COUPÉ. Deux triangles rectangles à 45 degrés, dont
// l'intersection vaut exactement 2500: leurs seules abscisses de sommet sont 0 et 100, donc le
// balayage n'avait qu'UNE tranche et lisait la section du milieu comme si elle valait pour toute
// la largeur, soit 5000, le double. C'est l'appariement des noms qui s'en sert.
test("rapide_recouvrement_exact_sur_un_pan_coupe", () => {
  const A: Point[] = [[0, 0], [100, 0], [0, 100]];
  const B: Point[] = [[0, 0], [100, 0], [100, 100]];
  const ov = CLIENT.v5OverlapArea(A, B);
  return expect(Math.abs(ov - 2500) < 1e-6, "l'intersection des deux triangles vaut 2500, vu " + ov)
      && expect(Math.abs(CLIENT.v5OverlapArea(A, A) - 5000) < 1e-6,
         "un triangle recouvre exactement sa propre aire (5000), vu " + CLIENT.v5OverlapArea(A, A));
});

// À ÉGALITÉ EXACTE DE RECOUVREMENT, C'EST LA GÉOMÉTRIE QUI TRANCHE, PAS L'ORDRE DU TABLEAU.
// Une cellule de 0 à 250 recouvre EXACTEMENT 30000 de A (0-100) et 30000 de B (100-200). Le
// départage était « le plus petit index précédent », donc A. C'est B qu'elle contient le plus
// franchement: son centroïde est à 25 du centre de la nouvelle cellule, celui de A à 75.
test("rapide_egalite_de_recouvrement_tranchee_par_la_geometrie", () => {
  const cellules = [
    { id: "c1", poly: [[0, 0], [250, 0], [250, 300], [0, 300]] as Point[], name: "", floor: "parquet" },
    { id: "c2", poly: [[250, 0], [400, 0], [400, 300], [250, 300]] as Point[], name: "", floor: "parquet" },
  ];
  const avant = [
    { name: "A", floor: "parquet", poly: [[0, 0], [100, 0], [100, 300], [0, 300]] as Point[] },
    { name: "B", floor: "tile", poly: [[100, 0], [200, 0], [200, 300], [100, 300]] as Point[] },
    { name: "C", floor: "parquet", poly: [[200, 0], [400, 0], [400, 300], [200, 300]] as Point[] },
  ];
  CLIENT.v5AssignNames(cellules, avant);
  return expect(cellules[1].name === "C", "la cellule de droite garde C, vu " + cellules[1].name)
      && expect(cellules[0].name === "B",
         "à égalité d'aire, le nom dont le centroïde est le plus proche l'emporte (B), vu " + cellules[0].name)
      && expect(cellules[0].floor === "tile", "et son sol vient avec, vu " + cellules[0].floor);
});

// UN NOM N'EST JAMAIS PERDU TANT QUE SA CELLULE D'ORIGINE PEUT ÊTRE RETROUVÉE.
//
// Trois pièces A|B|C séparées à x=100 et x=200 dans un contour large de 400. Pousser la cloison de
// gauche jusqu'à 250 fusionne deux pièces, et le recouvrement de la cellule fusionnée vaut
// EXACTEMENT 30000 avec A comme avec B. Le départage était `(a.pi - b.pi)`, c'est-à-dire « le plus
// petit index précédent gagne » : un pur artefact d'ordre de tableau. Le nom perdu devenait
// « Room 1 », et RAMENER la cloison à 100 ne le ramenait pas, parce que la photo du geste
// (`modele/photo-cellules.ts`) ne couvre qu'un geste et que le suivant repart d'un plan où le nom
// n'existe plus. Une « Chambre d'Élise » tapée à la main disparaissait pour un aller-retour en
// DEUX gestes, ce que la suite sol-suit-la-main ne voit pas : elle tient dans un seul.
test("rapide_un_nom_revient_apres_un_aller_retour_en_deux_gestes", () => {
  const P: PlanV5 = {
    outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
    walls: [{ id: "wg", a: [100, 0], b: [100, 300], t: 12 },
            { id: "wd", a: [200, 0], b: [200, 300], t: 12 }],
    openings: [], pieces: [], cells: [],
  };
  CLIENT.v5RebuildCells(P);
  const parX = (x: number) => P.cells.find((c) => CLIENT.pointInPoly(x, 150, c.poly));
  expect(P.cells.length === 3, "3 cellules attendues au départ, vu " + P.cells.length);
  parX(50)!.name = "A"; parX(150)!.name = "B"; parX(300)!.name = "C";
  const wg = P.walls[0]!;
  // geste 1 : la cloison de gauche est poussée jusqu'à 250, deux pièces fusionnent
  photographierCellules(P);
  wg.a = [250, 0]; wg.b = [250, 300];
  CLIENT.v5RebuildCells(P, { depuis: photoCellules(P) });
  oublierPhotoCellules();
  const apresPoussee = P.cells.map((c) => c.name).sort();
  // La poussée écrase une pièce contre l'autre: une cellule ne porte qu'un nom, donc un des trois
  // n'a plus de cellule. C'est CE nom-là qui doit revenir, pas la géométrie (elle revient déjà).
  expect(["A", "B", "C"].filter((n) => apresPoussee.indexOf(n) < 0).length === 1,
    "la poussée doit coûter exactement un des trois noms, vu " + JSON.stringify(apresPoussee));
  // geste 2 : elle revient exactement où elle était
  photographierCellules(P);
  wg.a = [100, 0]; wg.b = [100, 300];
  CLIENT.v5RebuildCells(P, { depuis: photoCellules(P) });
  oublierPhotoCellules();
  const noms = P.cells.map((c) => c.name).sort();
  return expect(noms.length === 3, "3 cellules après le retour, vu " + noms.length)
      && expect(JSON.stringify(noms) === JSON.stringify(["A", "B", "C"]),
         "les trois noms doivent revenir après l'aller-retour, vu " + JSON.stringify(noms)
         + " (après la poussée : " + JSON.stringify(apresPoussee) + ")");
});

test("rapide_detection_est_deterministe", () => {
  const murs = [{ id: "w2", a: [0, 200], b: [600, 200], t: 12 },
                { id: "w1", a: [300, 0], b: [300, 400], t: 12 }];
  const a = CLIENT.v5DetectCells([[0, 0], [600, 0], [600, 400], [0, 400]], murs);
  const b = CLIENT.v5DetectCells([[0, 0], [600, 0], [600, 400], [0, 400]], murs.slice().reverse());
  const cle = (o: { cells: PlanV5["cells"] }) => JSON.stringify(o.cells.map((c) => [c.id, aire(c.poly)]));
  return expect(cle(a) === cle(b), "l'ordre des murs ne doit rien changer :\n  " + cle(a) + "\n  " + cle(b));
});

// =================================================================================================
//  4. BOUNDS: OPENING DEPTH, NON-OVERLAP BY FACE
// =================================================================================================
test("rapide_profondeur_bornee_par_le_mur", () => {
  // An opening can never be deeper than the thickness of ITS wall (client mirror of
  // OPENING_H_MAX), and never zero.
  const fin = { t: 6 }, epais = { t: 40 };
  return expect(CLIENT.v5OpeningDepthMax(fin) === 6, "mur de 6 -> profondeur max 6, vu " + CLIENT.v5OpeningDepthMax(fin))
      && expect(CLIENT.v5OpeningDepthFor(fin, 12) === 6, "une porte de 12 sur un mur de 6 est rabotée à 6, vu " + CLIENT.v5OpeningDepthFor(fin, 12))
      && expect(CLIENT.v5OpeningDepthFor(epais, 12) === 12, "sur un mur de 40, 12 reste 12, vu " + CLIENT.v5OpeningDepthFor(epais, 12))
      && expect(CLIENT.v5OpeningDepthFor(fin, 0) >= 1, "jamais de profondeur nulle, vu " + CLIENT.v5OpeningDepthFor(fin, 0))
      && expect(CLIENT.v5OpeningDepthMax({ t: 5000 }) === 200, "le plafond serveur (200) tient, vu " + CLIENT.v5OpeningDepthMax({ t: 5000 }));
});

test("rapide_non_chevauchement_par_face", () => {
  // Two openings (door/window) get in each other's way on BOTH sides; two surface-mounted
  // devices only get in each other's way on the SAME face; two different families never get in each other's way.
  const porteG = { type: "door", side: 0 }, porteD = { type: "door", side: 1 };
  const priseG = { type: "plug", side: 0 }, priseD = { type: "plug", side: 1 };
  return expect(CLIENT.v5OpeningSameSlot(porteG, porteD) === true, "deux percements se gênent dos à dos")
      && expect(CLIENT.v5OpeningSameSlot(priseG, priseG) === true, "deux prises sur la même face se gênent")
      && expect(CLIENT.v5OpeningSameSlot(priseG, priseD) === false, "deux prises dos à dos ne se gênent pas")
      && expect(CLIENT.v5OpeningSameSlot(porteG, priseG) === false, "familles différentes : jamais de gêne");
});

test("rapide_redim_ouverture_bute_sur_le_voisin", () => {
  const w = { id: "w1", a: [0, 0], b: [600, 0], t: 12 };
  const op = { id: "o1", wallId: "w1", t0: 200, w: 80, h: 12, type: "door", side: 0 };
  const voisin = { id: "o2", wallId: "w1", t0: 320, w: 60, h: 12, type: "door", side: 0 };
  const loin = { id: "o3", wallId: "w1", t0: 60, w: 40, h: 12, type: "door", side: 0 };
  CLIENT.state.plan = { outline: [], walls: [w], openings: [op, voisin, loin], pieces: [], cells: [] };
  const lim = CLIENT.v5OpeningEdgeLimits(op, w);
  return expect(near(lim.L, 600, 0.01), "longueur du mur = 600, vu " + lim.L)
      && expect(lim.hiLim === 320, "le bord haut bute sur le voisin à 320, vu " + lim.hiLim)
      && expect(lim.hiQui && lim.hiQui.id === "o2", "et il sait QUI le borne, vu " + JSON.stringify(lim.hiQui && lim.hiQui.id))
      && expect(lim.loLim === 100, "le bord bas bute sur o3 (60+40), vu " + lim.loLim);
});

test("rapide_ouverture_reste_dans_son_mur", () => {
  const w = { id: "w1", a: [0, 0], b: [300, 0], t: 12 };
  CLIENT.state.plan = { outline: [], walls: [w], openings: [], pieces: [], cells: [] };
  const op = { id: "o1", wallId: "w1", t0: 10, w: 50, h: 12, type: "window", side: 0 };
  CLIENT.state.plan.openings.push(op);
  const lim = CLIENT.v5OpeningEdgeLimits(op, w);
  return expect(lim.hiLim === lim.L, "sans voisin, la borne haute est le bout du mur, vu " + lim.hiLim + "/" + lim.L)
      && expect(lim.loLim === 0, "sans voisin, la borne basse est l'origine du mur, vu " + lim.loLim);
});

// =================================================================================================
//  4bis. SANITIZATION ON READ, AND DOOR ARC
//  (moved from tests/model-v5-conversion-rendu.ts and tests/run.ts, same names, same
//   assertions, no Chrome: `sanitizeV5Plan` and `doorArcSVG` touch neither the DOM nor rendering.)
// =================================================================================================
test("v5_sanitize_defensive", () => {
  const s = PLAN.sanitizeV5Plan;
  const v = {
    nul: s(null) === null, str: s("x") === null, arr: s([]) === null,
    shortOutline: s({ outline: [[0, 0], [1, 1]] }) === null,
    dropped: (function () {
      const p = s({ outline: [[0, 0], [100, 0], [100, 100], [0, 100]],
        walls: [{ id: "w1", a: [0, 0], b: [100, 0] }, { id: "w1", a: [0, 0], b: [0, 100] },
                { id: "bad", a: [0, 0], b: [0, 0] }, { a: "nope" }],
        openings: [{ id: "o1", wallId: "nowhere", type: "door", t0: 0, w: 80 },
                   { id: "o2", wallId: "w1", type: "pas-un-type", t0: 0, w: 80 },
                   { id: "o3", wallId: "w1", type: "door", t0: 9999, w: 80 }],
        pieces: [{ id: "p1", type: "sofa3", x: 0, y: 0, w: 1e9, h: -5, rot: 725 }, { id: "p2", type: "inconnu" }],
        cells: [{ id: "c1", poly: [[0, 0], [10, 0], [10, 10], [0, 10]], name: "X", floor: "lave" }, { poly: [[0, 0]] }] });
      return { walls: p.walls.length, ids: p.walls.map((w) => w.id),
               openings: p.openings.length, t0: p.openings[0] ? p.openings[0].t0 : null,
               pieces: p.pieces.length, w: p.pieces[0].w, h: p.pieces[0].h, rot: p.pieces[0].rot,
               cells: p.cells.length, floor: p.cells[0].floor };
    })(),
  };
  return expect(v.nul && v.str && v.arr && v.shortOutline, "bad inputs must yield null: " + JSON.stringify(v))
      && expect(v.dropped.walls === 2, "degenerate/malformed walls must be dropped, got " + v.dropped.walls)
      && expect(v.dropped.ids[0] !== v.dropped.ids[1], "duplicate wall ids must be de-duplicated: " + JSON.stringify(v.dropped.ids))
      && expect(v.dropped.openings === 1, "openings on unknown walls/types must be dropped, got " + v.dropped.openings)
      && expect(v.dropped.t0 >= 0 && v.dropped.t0 <= 100, "t0 must be clamped to the wall length, got " + v.dropped.t0)
      && expect(v.dropped.pieces === 1 && v.dropped.w <= 3000 && v.dropped.h >= 1 && v.dropped.rot === 5,
         "piece fields must be clamped/normalised: " + JSON.stringify(v.dropped))
      && expect(v.dropped.cells === 1 && v.dropped.floor === "parquet", "unknown floor must fall back to parquet");
});

test("v5_sanitize_garde_les_champs_recents_au_second_passage", () => {
  // "migrate(serialize(migrate(d)))" (Ctrl+Z, historique/pile.ts:40,91): `serialize()` writes
  // `plan: ctx.etat.plan` VERBATIM and `migrate()` gives that nested `plan` PRIORITY over the flat
  // wire shape (D-4, modele/etat.ts). So what a snapshot restore actually exercises is a SECOND
  // `sanitizeV5Plan` pass over a JSON round trip of the first one's output: exactly what this case
  // reproduces without needing a DOM `Contexte` to call the real `serialize()`.
  //
  // Built from the CONTRACT's key lists (`WALL_KEYS`/`OPENING_KEYS`/`PIECE_KEYS`/`CELL_KEYS`), not
  // a hand-written list of field names: a field added to the contract and forgotten in
  // `sanitizeV5Plan` still fails this test, instead of only the ones someone remembered to name.
  const EXCEPTIONS_PIECE = ["hinge", "swing"];
  // `free` is in `WALL_KEYS` only because the SERVER still accepts it (decision 0012 took the
  // through-running wall away; a tab running the old code may still send the field, and the server
  // still stores it). No client type carries it any more, `sanitizeV5Plan` reads it and drops it,
  // and `v5WallWire` never emits it: the same documented asymmetry as `hinge`/`swing` above, in
  // the same direction (G-18, the server is the more permissive of the two).
  const EXCEPTIONS_MUR = ["free"];
  // `hinge`/`swing` are in `PIECE_KEYS` only because the SERVER still accepts the OLD format (a
  // door used to be a piece of furniture); `v5PieceWire` never emits them on a walls-only
  // `Meuble` and it does not declare them either (contrat-serveur.ts's own comment on the line
  // that defines `PIECE_KEYS`). Not a forgotten field, the one documented case where the server
  // is more permissive than the client (G-18).
  const VALEUR: Record<string, DonneeDynamique> = {
    a: [10, 20], b: [130, 20], t: 15, free: 1,
    t0: 5, w: 20, h: 8, side: 1, name: "Contrat", hinge: 1, swing: -1, leaf: 2,
    x: 33, y: 44, rot: 90, locked: true, tr: 150, dmin: 60, pair: "ecran1",
    poly: [[0, 0], [10, 0], [10, 10], [0, 10]], floor: "tile",
  };
  const entiteDepuisCles = (cles: readonly string[], overrides: Record<string, DonneeDynamique>): Record<string, DonneeDynamique> => {
    const e: Record<string, DonneeDynamique> = {};
    cles.forEach((k) => { e[k] = Object.prototype.hasOwnProperty.call(overrides, k) ? overrides[k] : VALEUR[k]; });
    return e;
  };
  const murKeysUtiles = WALL_KEYS.filter((k) => EXCEPTIONS_MUR.indexOf(k) < 0);
  const wallSeed = entiteDepuisCles(WALL_KEYS, { id: "w1" });
  const openingSeed = entiteDepuisCles(OPENING_KEYS, { id: "o1", wallId: "w1", type: "door" });
  const pieceKeysUtiles = PIECE_KEYS.filter((k) => EXCEPTIONS_PIECE.indexOf(k) < 0);
  const pieceSeed = entiteDepuisCles(pieceKeysUtiles, { id: "p1", type: "sofa3" });
  const cellSeed = entiteDepuisCles(CELL_KEYS, { id: "c1" });
  const planSeed = {
    outline: [[0, 0], [600, 0], [600, 400], [0, 400]],
    walls: [wallSeed], openings: [openingSeed], pieces: [pieceSeed], cells: [cellSeed],
  };
  const p1 = PLAN.sanitizeV5Plan(planSeed);
  const p2 = PLAN.sanitizeV5Plan(JSON.parse(JSON.stringify(p1)) as DonneeDynamique);
  const familles: Array<[string, readonly string[], Record<string, DonneeDynamique>, DonneeDynamique]> = [
    ["walls", murKeysUtiles, wallSeed, p2 ? p2.walls[0] : null],
    ["openings", OPENING_KEYS, openingSeed, p2 ? p2.openings[0] : null],
    ["pieces", pieceKeysUtiles, pieceSeed, p2 ? p2.pieces[0] : null],
    ["cells", CELL_KEYS, cellSeed, p2 ? p2.cells[0] : null],
  ];
  const ecarts: string[] = [];
  familles.forEach(([nom, liste, seed, obtenu]) => {
    liste.forEach((k) => {
      const attendu = JSON.stringify(seed[k]);
      const vu = JSON.stringify(obtenu ? (obtenu as DonneeDynamique)[k] : undefined);
      if (attendu !== vu) ecarts.push(nom + "." + k + " : attendu " + attendu + ", vu " + vu);
    });
  });
  return expect(!!p1 && !!p2, "le plan doit rester lisible aux deux passages")
      && expect(ecarts.length === 0, "champs perdus au second passage de sanitizeV5Plan :\n         " + ecarts.join("\n         "));
});

test("un_plan_v1_a_v4_n_est_plus_lu_et_part_au_filet_illisible", () => {
  // Décision 0021. Les formats v1 à v4 ne sont plus lus: `migrate()` les REFUSE (null) au lieu de
  // les convertir. Ce n'est pas une perte, c'est le chemin « plan illisible » qui s'ouvre (D-2):
  // l'amorçage (`main.ts`) met alors les octets de côté SOUS LEUR PROPRE CLÉ, tels quels, avant
  // que quoi que ce soit ne les remplace, et l'affiche dans une bannière avec un bouton de
  // téléchargement. Rien ne se convertit, rien ne se jette.
  const v4 = {
    rooms: [{
      id: 1, name: "Salon", floor: "parquet", ax: 0, ay: 0,
      room: { poly: [[0, 0], [400, 0], [400, 300], [0, 300]] },
      pieces: [{ id: 9, type: "sofa", name: "Canapé", x: 10, y: 10, w: 200, h: 90, rot: 0 }],
    }],
    envelope: { poly: [[0, 0], [400, 0], [400, 300], [0, 300]], floor: "parquet", pieces: [] as DonneeDynamique[] },
    setupDone: true,
  };
  const v3 = { room: { poly: [[0, 0], [500, 0], [500, 380], [0, 380]], w: 500, l: 380 }, pieces: [] as DonneeDynamique[] };
  // Contrôle: un plan v5 reste lu, sinon ce test passerait aussi avec un `migrate()` cassé.
  const v5 = {
    outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
    walls: [{ id: "w1", a: [0, 0], b: [400, 0], t: 12 }],
    openings: [] as DonneeDynamique[], pieces: [] as DonneeDynamique[], cells: [] as DonneeDynamique[], setupDone: true,
  };

  const octets = JSON.stringify(v4);
  const MEM: Record<string, string> = {};
  const avant = Object.prototype.hasOwnProperty.call(globalThis, "localStorage")
    ? globalThis.localStorage : undefined;
  globalThis.localStorage = {
    getItem: (k: string) => (Object.prototype.hasOwnProperty.call(MEM, k) ? MEM[k]! : null),
    setItem: (k: string, v: string) => { MEM[k] = String(v); },
    removeItem: (k: string) => { delete MEM[k]; },
  } as Storage;
  let filet;
  try { filet = rescueUnreadable(octets); }
  finally {
    if (avant === undefined) delete (globalThis as { localStorage?: Storage }).localStorage;
    else globalThis.localStorage = avant;
  }

  return expect(migrate(v4 as unknown) === null, "un plan v4 (rooms[]+envelope) n'est plus lu")
      && expect(migrate(v3 as unknown) === null, "un plan v1/v2/v3 mono-pièce n'est plus lu non plus")
      && expect(!!migrate(v5 as unknown), "contrôle: un plan v5 reste lu")
      && expect(!!filet && filet.kept === true && filet.bytes === octets.length,
        "le filet garde les octets, vu " + JSON.stringify(filet))
      && expect(MEM[V5_RESCUE_KEY] === octets,
        "les octets sont mis de côté TELS QUELS sous la clé illisible");
});

test("v5_sanitize_applique_les_bornes_serveur_a_la_lecture", () => {
  // A2: `migrations.ts` used to apply NONE of `COORD_MAX`/`POLY_MAX_PTS`/`MAX_ENTITIES`/`ID_RE`
  // on read: a plan loaded out of bounds OPENED, but every future op on it got rejected by the
  // server. The read now corrects, on the spot, exactly what the server would refuse.
  const s = PLAN.sanitizeV5Plan;

  // -- COORD_MAX: an absurd coordinate is clamped, not left to overflow every downstream sum.
  const coord = s({
    outline: [[0, 0], [600, 0], [600, 400], [0, 400]],
    walls: [{ id: "w1", a: [0, 0], b: [1e9, 0], t: 12 }],
    pieces: [{ id: "p1", type: "sofa3", x: 1e9, y: -1e9, w: 200, h: 90 }],
  });

  // -- ID_RE: an id carrying an injection attempt is REPLACED, and the reference following it
  // (an opening's `wallId`) is NOT orphaned by the replacement.
  const idInjecte = s({
    outline: [[0, 0], [600, 0], [600, 400], [0, 400]],
    walls: [{ id: 'bad"><img>', a: [0, 0], b: [600, 0], t: 12 }],
    openings: [{ id: "o1", wallId: 'bad"><img>', type: "window", t0: 100, w: 80 }],
  });

  // -- ID_RE + a valid but 100-character id: truncated to at most 80 AND still ID_RE-shaped.
  const idLong = s({
    outline: [[0, 0], [600, 0], [600, 400], [0, 400]],
    walls: [{ id: "w".repeat(100), a: [0, 0], b: [600, 0], t: 12 }],
  });

  // -- MAX_ENTITIES: 2001 walls in, at most 2000 out.
  const trop: DonneeDynamique = { outline: [[0, 0], [600, 0], [600, 400], [0, 400]], walls: [] };
  for (let i = 0; i < 2001; i++) trop.walls.push({ id: "m" + i, a: [0, i], b: [1, i], t: 5 });
  const bornes = s(trop);

  const ID_RE_TEST = /^[A-Za-z0-9_.:-]{1,80}$/;
  return expect(!!coord && Math.abs(coord.walls[0]!.b[0]) === 100000,
          "une coordonnée absurde doit être ramenée à ±COORD_MAX, vu " + (coord && coord.walls[0]!.b[0]))
      && expect(!!coord && coord.pieces[0]!.x === 100000 && coord.pieces[0]!.y === -100000,
          "un meuble hors bornes aussi (x/y sont des coordonnées) : " + JSON.stringify(coord && coord.pieces[0]))
      && expect(!!idInjecte && idInjecte.walls[0]!.id !== 'bad"><img>' && ID_RE_TEST.test(idInjecte.walls[0]!.id),
          "un id qui ne passe pas ID_RE doit être remplacé : " + JSON.stringify(idInjecte && idInjecte.walls[0]))
      && expect(!!idInjecte && idInjecte.openings.length === 1 && idInjecte.openings[0]!.wallId === idInjecte.walls[0]!.id,
          "et la référence (wallId) doit suivre le remplacement, pas s'orpheliner : " + JSON.stringify(idInjecte && idInjecte.openings))
      && expect(!!idLong && idLong.walls[0]!.id.length <= 80 && ID_RE_TEST.test(idLong.walls[0]!.id),
          "un id de 100 caractères doit être ramené à <= 80 et rester conforme à ID_RE, vu " + (idLong && idLong.walls[0]!.id))
      && expect(!!bornes && bornes.walls.length === 2000,
          "2001 murs en entrée, au plus MAX_ENTITIES en sortie, vu " + (bornes && bornes.walls.length));
});

test("v5_clamp_ouvertures_repare_un_champ_non_fini", () => {
  // A3 (modele/murs.ts:173-183): `{t0:NaN, w:NaN, h:NaN}` used to come out UNCHANGED, and the
  // function reported `[]` (nothing to say). `clamp(NaN, lo, hi)` returns NaN, untouched: it
  // then survives in memory, `JSON.stringify` turns it into `null` on the next save, and the
  // NEXT read floors it to 1cm (`num(null, default)` treats `null` as a REAL 0, not "missing").
  const P: PlanV5 = {
    outline: [[0, 0], [600, 0], [600, 400], [0, 400]],
    walls: [{ id: "w1", a: [0, 0], b: [600, 0], t: 12, isOutline: true }],
    openings: [{ id: "o1", wallId: "w1", t0: NaN, w: NaN, h: NaN, type: "window", side: 0, name: "Fenêtre" }],
    pieces: [], cells: [],
  };
  const chg = CLIENT.v5ClampOpeningsOfWall(P, "w1");
  const o = P.openings[0]!;
  return expect(isFinite(o.t0) && isFinite(o.w) && isFinite(o.h),
          "t0/w/h doivent redevenir des nombres finis : " + JSON.stringify({ t0: o.t0, w: o.w, h: o.h }))
      && expect(o.w >= 1 && o.h >= 1, "et rester dans les bornes physiques, pas à 0 : " + JSON.stringify({ w: o.w, h: o.h }))
      && expect(chg.length > 0, "la réparation doit être signalée comme un changement, pas silencieuse (ardoise vide)");
});

test("door_arc_center_is_hinge", () => {
  function impliedCenter(svg: string): PointTest[] | null {
    const m = svg.match(/M\s+([\-\d.]+)\s+([\-\d.]+)\s+A\s+([\-\d.]+)\s+([\-\d.]+)\s+0\s+0\s+([01])\s+([\-\d.]+)\s+([\-\d.]+)/);
    if (!m) return null;
    const x1 = +m[1], y1 = +m[2], r = +m[3], sweep = +m[5], x2 = +m[6], y2 = +m[7];
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const dx = x2 - x1, dy = y2 - y1, d = Math.hypot(dx, dy);
    const h = Math.sqrt(Math.max(0, r * r - (d / 2) * (d / 2)));
    const ux = -dy / d, uy = dx / d, s = sweep ? 1 : -1;
    return [{ x: mx + ux * h * s, y: my + uy * h * s }, { x: mx - ux * h * s, y: my - uy * h * s }];
  }
  const W = 80, out: DonneeDynamique[] = [];
  [[0, 1], [1, 1], [0, -1], [1, -1]].forEach((hs) => {
    const hinge = hs[0], swing = hs[1];
    const svg = PLAN.doorArcSVG(W, hinge, swing);
    const hx = hinge ? W : 0, hy = 0;
    const cands = impliedCenter(svg);
    let ok = false;
    if (cands) cands.forEach((c) => { if (Math.hypot(c.x - hx, c.y - hy) < 1.0) ok = true; });
    out.push({ hinge, swing, ok });
  });
  const bad = out.filter((c) => !c.ok);
  return expect(bad.length === 0, "these hinge/swing combos have arc center != hinge: " + JSON.stringify(bad));
});

// =================================================================================================
//  4ter. CIRCULATION: THE FRONT DOOR, AND THE UNREACHABLE CELL
//  (moved from tests/model-v5-circulation.ts and tests/model-v5-edition.ts, same names,
//   same assertions. The engine only reads the plan and returns a list of findings: no pixel.)
// =================================================================================================
// Sets a plan in the engine, cells recomputed as the application does.
function flowPlan(plan: DonneeDynamique): PlanV5 {
  CLIENT.v5RebuildCells(plan as PlanV5);
  FLOW.state.plan = plan as PlanV5;
  return plan;
}
const FRONT_DOOR_PLAN = (wall: string, t0: number): PlanV5 => ({
  outline: [[0, 0], [600, 0], [600, 400], [0, 400]],
  walls: [{ id: "wS", a: [0, 400], b: [600, 400], t: 12, isOutline: true },
          { id: "wN", a: [0, 0], b: [600, 0], t: 12, isOutline: true },
          { id: "wW", a: [0, 0], b: [0, 400], t: 12, isOutline: true },
          { id: "wE", a: [600, 0], b: [600, 400], t: 12, isOutline: true },
          { id: "wI", a: [300, 0], b: [300, 400], t: 12, isOutline: false }],
  openings: [{ id: "d1", wallId: wall, t0, w: 90, h: 210, type: "door", side: 0,
               name: "Porte", hinge: 0, swing: 1 }],
  pieces: [], cells: [],
});
const flowVerdict = () => {
  const f = FLOW.analyzeApt().findings;
  return { ids: f.map((x) => x.id),
           front: FLOW.buildAptContext().pieces.filter((p) => p.type === "door")
             .map((p) => ({ onOutline: !!p.onOutline, ci: p.ci })) };
};

["wN", "wS", "wW", "wE"].forEach((w) => {
  test("flow_porte_d_entree_reconnue_sur_la_facade_" + w, () => {
    flowPlan(FRONT_DOOR_PLAN(w, 150));
    const v = flowVerdict();
    return expect(v.front.length === 1 && v.front[0].onOutline === true,
            "la porte doit être reconnue sur la façade " + w + " : " + JSON.stringify(v.front))
        && expect(v.ids.indexOf("nofrontdoor") < 0,
            "la règle doit se TAIRE quand l'entrée existe (" + w + ") : " + JSON.stringify(v.ids));
  });
});

test("flow_porte_d_entree_manquante_est_signalee", () => {
  flowPlan(FRONT_DOOR_PLAN("wI", 150));
  const v = flowVerdict();
  return expect(v.front.length === 1 && v.front[0].onOutline === false,
          "une porte sur le mur intérieur n'est pas une entrée : " + JSON.stringify(v.front))
      && expect(v.ids.indexOf("nofrontdoor") >= 0,
          "la règle doit se déclencher : " + JSON.stringify(v.ids));
});

// The minimal v5 plan of the `model-v5-*` suites (SEED_PLAN from _harness-v5.ts): 600x400, one partition
// in the middle, the four facades present as walls.
const SEED_PLAN_V5 = (): DonneeDynamique => ({
  outline: [[0, 0], [600, 0], [600, 400], [0, 400]],
  walls: [{ id: "w1", a: [300, 0], b: [300, 400], t: 12, isOutline: false },
          { id: "wt", a: [0, 0], b: [600, 0], t: 12, isOutline: true },
          { id: "wr", a: [600, 0], b: [600, 400], t: 12, isOutline: true },
          { id: "wb", a: [600, 400], b: [0, 400], t: 12, isOutline: true },
          { id: "wl", a: [0, 400], b: [0, 0], t: 12, isOutline: true }],
  openings: [], pieces: [], cells: [],
});

test("v5_flow_doorless_cell_unreachable", () => {
  const P = SEED_PLAN_V5();
  // a single door, on the top facade, opening into the LEFT cell
  P.openings.push({ id: "d1", wallId: "wt", t0: 100, w: 80, h: 12, type: "door", side: 0, hinge: 0, swing: 1 });
  flowPlan(P);
  const f = FLOW.analyzeApt().findings;
  const findingsIds = f.map((x) => x.id);
  const unreach = f.filter((x) => /^unreach_room_/.test(x.id)).length;
  return expect(P.cells.length === 2, "expected 2 cells, got " + P.cells.length)
      && expect(unreach === 1, "exactly one cell (the door-less one) must be flagged unreachable, got "
         + unreach + ", findings: " + JSON.stringify(findingsIds));
});

test("v5_flow_inner_door_makes_it_reachable", () => {
  const P = SEED_PLAN_V5();
  P.openings.push({ id: "d1", wallId: "wt", t0: 100, w: 80, h: 12, type: "door", side: 0, hinge: 0, swing: 1 });
  P.openings.push({ id: "d2", wallId: "w1", t0: 160, w: 80, h: 12, type: "door", side: 0, hinge: 0, swing: 1 });
  flowPlan(P);
  const unreach = FLOW.analyzeApt().findings.filter((x) => /^unreach_room_/.test(x.id)).length;
  return expect(unreach === 0, "with a door in the partition nothing should be unreachable, got " + unreach);
});

// =================================================================================================
//  4quater. THE SHARED SHAPE OF AN OPENING
//  (moved from tests/model-v5-fil-serveur.ts, same name, same assertions.)
// =================================================================================================
test("v5_opening_side_survives_the_wire", () => {
  const P = SEED_PLAN_V5();
  P.openings.push({ id: "o1", wallId: "w1", t0: 100, w: 80, h: 12, type: "door", side: 1, hinge: 1, swing: -1, name: "Porte du séjour" });
  P.openings.push({ id: "o2", wallId: "wt", t0: 10, w: 10, h: 6, type: "plug", side: 1, hinge: 0, name: "Prise TV" });
  WIRE.state.plan = P;
  const wire = WIRE.v5StateWire().openings;
  const back = wire.map((o) => WIRE.v5AdoptOpening(o));
  // PACKED form (client from before the widening): side inside bit 1 of hinge
  const p = WIRE.v5AdoptOpening({ id: "o3", wallId: "w1", t0: 5, w: 80, type: "door", hinge: 3, swing: 1 });
  const packed = { side: p.side, hinge: p.hinge, h: p.h, name: p.name };
  const v = { wire, packed, back: back.map((o) => ({ id: o.id, side: o.side, hinge: o.hinge, swing: o.swing, h: o.h, name: o.name })) };
  return expect(v.wire[0].side === 1 && v.wire[0].hinge === 1,
          "door with side=1,hinge=1 must go out UNFOLDED (side:1, hinge:1), got " + JSON.stringify(v.wire[0]))
      && expect(v.wire[1].side === 1 && v.wire[1].hinge === 0, "plug side must be its own key, got " + JSON.stringify(v.wire[1]))
      && expect(v.wire[0].h === 12 && v.wire[0].name === "Porte du séjour",
          "h/name must travel on the wire: " + JSON.stringify(v.wire[0]))
      && expect(v.back[0].side === 1 && v.back[0].hinge === 1 && v.back[0].swing === -1,
          "door round-trip lost data: " + JSON.stringify(v.back[0]))
      && expect(v.back[1].side === 1 && v.back[1].hinge === 0 && v.back[1].name === "Prise TV",
          "plug round-trip lost side/name: " + JSON.stringify(v.back[1]))
      && expect(v.back[0].h > 0 && v.back[0].name.length > 0, "h/name must survive the round-trip")
      && expect(v.packed.side === 1 && v.packed.hinge === 1 && v.packed.h > 0 && v.packed.name.length > 0,
          "the PACKED legacy form must still be readable: " + JSON.stringify(v.packed));
});

// =================================================================================================
//  4quinquies. THE WALL MAGNET, FOR EVERY PIECE OF FURNITURE (modele/espace.ts, `meubleWallSnap`)
//  PURE: plan + rectangle + reach -> snapped {x,y,rot}, or null out of reach. No DOM, no gesture:
//  the drag/drop wiring (gestes/meuble.ts, gestes/pose.ts) is exercised by the browser suites only.
// =================================================================================================
const RADIATEUR_WH = { w: 80, h: 12 };
// A rectangle centered on (cx,cy), the shape `meubleWallSnap` takes.
const rectCentre = (cx: number, cy: number) =>
  ({ x: cx - RADIATEUR_WH.w / 2, y: cy - RADIATEUR_WH.h / 2, w: RADIATEUR_WH.w, h: RADIATEUR_WH.h });
/** Any rectangle, centered on (cx,cy): a bed is 160 wide and 200 DEEP, so its center sits a full
 *  metre from the wall its back is flush against. */
const rectTaille = (cx: number, cy: number, w: number, h: number) =>
  ({ x: cx - w / 2, y: cy - h / 2, w, h });
const PLAN_MUR = (wall: Mur): PlanV5 => ({ outline: [], walls: [wall], openings: [], pieces: [], cells: [] });

test("radiateur_aimant_mur_horizontal_a_portee_se_colle_dos_au_mur", () => {
  const wall: Mur = { id: "wH", a: [0, 0], b: [200, 0], t: 12 };
  // center 4cm below the wall's centerline (well within a 20cm reach): must snap.
  const r = meubleWallSnap(PLAN_MUR(wall), rectCentre(100, 4), 20);
  if (!r) return "expected a snap, got null";
  const backY = r.y;   // corner y = the top edge at rot 0 = the back, flush on the wall's face
  return expect(r.rot === 0, "a horizontal wall must align rot to 0, got " + r.rot)
      && expect(near(backY, 6, 0.5), "the back must land exactly on the wall's face (y=6), got " + backY);
});

test("radiateur_hors_de_portee_du_mur_reste_inchange", () => {
  const wall: Mur = { id: "wH", a: [0, 0], b: [200, 0], t: 12 };
  // center 40cm below the wall's centerline, beyond a 20cm reach: no snap.
  const r = meubleWallSnap(PLAN_MUR(wall), rectCentre(100, 40), 20);
  return expect(r === null, "40cm is out of a 20cm reach, expected null, got " + JSON.stringify(r));
});

test("radiateur_aimant_mur_vertical_rot_90", () => {
  const wall: Mur = { id: "wV", a: [0, 0], b: [0, 200], t: 12 };
  // center 4cm to the LEFT of the wall: within reach, rot must align to the vertical wall (90).
  const r = meubleWallSnap(PLAN_MUR(wall), rectCentre(-4, 100), 20);
  return expect(!!r && r.rot === 90, "a vertical wall must align rot to 90, got " + JSON.stringify(r));
});

test("radiateur_aimant_mur_oblique_45_degres", () => {
  const wall: Mur = { id: "wO", a: [0, 0], b: [100, 100], t: 12 };
  // center 4cm off the wall's midpoint, along its normal (the side that resolves to `side=0`).
  const n = { x: -Math.SQRT1_2, y: Math.SQRT1_2 };
  const r = meubleWallSnap(PLAN_MUR(wall), rectCentre(50 + n.x * 4, 50 + n.y * 4), 20);
  return expect(!!r && r.rot === 45, "a 45deg wall must snap rot to 45, got " + JSON.stringify(r));
});

test("radiateur_aimant_glisse_le_long_du_mur_en_suivant_le_centre", () => {
  const wall: Mur = { id: "wH", a: [0, 0], b: [200, 0], t: 12 };
  const a = meubleWallSnap(PLAN_MUR(wall), rectCentre(50, 4), 20);
  const b = meubleWallSnap(PLAN_MUR(wall), rectCentre(150, 4), 20);
  if (!a || !b) return "expected both to snap, got " + JSON.stringify({ a, b });
  return expect(a.rot === 0 && b.rot === 0, "both stay aligned with the wall while sliding along it")
      && expect(a.x !== b.x, "sliding the center along the wall must move the snapped x, got the same " + a.x);
});

// ---- the same magnet, on a DEEP piece of furniture: the reach is read on the BACK ---------------
// A bed is 160 x 200: flush against a wall, its center is 100 cm away from it. Reading the reach at
// the center (what the radiator-only version did) could never catch it, whatever the depth.
const MUR_H: Mur = { id: "wH", a: [0, 0], b: [400, 0], t: 12 };
/** Center of a `w x h` piece whose BACK sits `gap` cm from the horizontal wall's inner face (y=6). */
const litDosA = (gap: number, h: number) => 6 + gap + h / 2;

test("aimant_lit_dos_a_8cm_du_mur_se_colle_avec_la_rotation_du_mur", () => {
  const r = meubleWallSnap(PLAN_MUR(MUR_H), rectTaille(200, litDosA(8, 200), 160, 200), 20);
  if (!r) return "expected a snap for a bed whose back is 8cm from the wall, got null";
  return expect(r.rot === 0, "a horizontal wall must align rot to 0, got " + r.rot)
      && expect(near(r.y, 6, 0.5), "the bed's back must land on the wall's face (y=6), got " + r.y);
});

test("aimant_lit_dos_a_60cm_du_mur_ne_bouge_pas", () => {
  const r = meubleWallSnap(PLAN_MUR(MUR_H), rectTaille(200, litDosA(60, 200), 160, 200), 20);
  return expect(r === null, "60cm of back-to-wall gap is out of a 20cm reach, got " + JSON.stringify(r));
});

test("aimant_coupe_par_alt_ne_colle_rien", () => {
  const rect = rectTaille(200, litDosA(8, 200), 160, 200);
  const avec = meubleWallSnap(PLAN_MUR(MUR_H), rect, 20);
  const sans = meubleWallSnap(PLAN_MUR(MUR_H), rect, 20, true);
  return expect(!!avec, "control: without Alt this bed snaps")
      && expect(sans === null, "Alt held (sansAimant) must cut the magnet outright, got " + JSON.stringify(sans));
});

test("aimant_aller_retour_revient_au_point_de_depart", () => {
  // The drag is now: round the corner once, then the magnet. No grid, no bounds, no tolerance, so
  // a piece pushed by +37 cm and pulled back by -37 must land on the exact same centimetre.
  const P = PLAN_MUR(MUR_H);
  const depart = rectTaille(200, litDosA(8, 200), 160, 200);
  const a = meubleWallSnap(P, depart, 20);
  if (!a) return "control: the starting position must snap";
  // out of reach, mid-room: the hand keeps it, the magnet says nothing
  const loin = { x: a.x + 37, y: a.y + 400, w: 160, h: 200 };
  if (meubleWallSnap(P, loin, 20)) return "control: 400cm away nothing must snap";
  const retour = { x: loin.x - 37, y: loin.y - 400, w: 160, h: 200 };
  const b = meubleWallSnap(P, retour, 20);
  return expect(!!b && b.x === a.x && b.y === a.y && b.rot === a.rot,
    "the round trip must return to the exact starting placement, " + JSON.stringify(a) + " vs " + JSON.stringify(b));
});

test("aimant_meuble_chevauchant_le_mur_est_ressorti_jamais_repousse_ailleurs", () => {
  // A converted plan places furniture STRADDLING the wall. Nothing pushes it home any more: the
  // magnet alone acts, and it only brings the back onto the face, keeping the piece on its own
  // side of the wall (the room side its center was on).
  const r = meubleWallSnap(PLAN_MUR(MUR_H), rectTaille(200, 100, 160, 200), 20);
  if (!r) return "a piece straddling the wall is within reach: expected a snap, got null";
  return expect(near(r.y, 6, 0.5), "its back must come out onto the wall's face (y=6), got " + r.y)
      && expect(r.x === 200 - 80, "it must not slide along the wall: x stays under the hand, got " + r.x);
});

// F2. In hauteur: a radiator (LOW) and a wall-mounted fixture (window/sconce/plug/RJ45, ON the
// wall ABOVE it) never occupy "the same floor spot" for one another; a door is the one exception
// (you don't pass OVER a radiator to walk through a doorway).
test("catalogue_passe_au_dessus_radiateur_et_fixations_murales", () => {
  return expect(passeAuDessus("radiateur", "window"), "a window passes above a radiator")
      && expect(passeAuDessus("sconce", "radiateur"), "a wall light passes above a radiator (either order)")
      && expect(passeAuDessus("radiateur", "plug"), "a socket passes above a radiator")
      && expect(passeAuDessus("radiateur", "rj45"), "an RJ45 passes above a radiator")
      && expect(!passeAuDessus("radiateur", "door"), "a door does NOT pass above a radiator: it stays a floor obstacle")
      && expect(!passeAuDessus("radiateur", "sdoor"), "a sliding door does NOT pass above a radiator either")
      && expect(!passeAuDessus("radiateur", "dining"), "an ordinary piece of furniture is not exempted")
      && expect(!passeAuDessus("sofa2", "window"), "the exemption is specific to the radiator, not furniture in general");
});

// F2, at the CIRCULATION engine level. A single 400x300 room, four facades.
const PIECE_PLAN_F2 = (): PlanV5 => ({
  outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
  walls: [
    { id: "wN", a: [0, 0], b: [400, 0], t: 12, isOutline: true },
    { id: "wS", a: [400, 300], b: [0, 300], t: 12, isOutline: true },
    { id: "wE", a: [400, 0], b: [400, 300], t: 12, isOutline: true },
    { id: "wW", a: [0, 300], b: [0, 0], t: 12, isOutline: true },
  ],
  openings: [], pieces: [], cells: [],
});

// NOTE ON "RED BEFORE GREEN" HERE: `isBlocker` (circulation/contexte.ts) already excludes every
// `wallMount`/`opening` type (windows included) from `solides`, for a reason unrelated to
// radiators. Checked BOTH ways (with `passeAuDessus` wired into Rule 6bis, and with that one line
// reverted): this scenario reports ZERO "Two objects" findings either way, because a window on a
// wall physically never overlaps a radiator flush on that same wall by more than a graze (a
// window's box stays inside the wall's own thickness band; the radiator's back starts exactly at
// the wall's face). So this case can't be driven red by this predicate: it is a CONFIRMATION, like
// pose_fenetre below, not a regression test. The genuine red-before-green for F2's rule lives at
// the predicate itself (`catalogue_passe_au_dessus_radiateur_et_fixations_murales`, red before
// `passeAuDessus` existed) and at the negative control right after this test.
test("flow_radiateur_colle_et_fenetre_au_dessus_zero_signalement", () => {
  const P = PIECE_PLAN_F2();
  P.pieces.push({ id: "rad1", type: "radiateur", name: "Radiateur", x: 150, y: 6, w: 80, h: 12, rot: 0, locked: false });
  // depth exaggerated on purpose (real windows stay within the wall's own thickness): even a
  // window whose box reaches deep into the room must not be flagged against the radiator below it.
  P.openings.push({ id: "win1", wallId: "wN", t0: 130, w: 120, h: 40, type: "window", side: 0, name: "Fenêtre" });
  flowPlan(P);
  const ids = FLOW.analyzeApt().findings.map((f) => f.id);
  return expect(!ids.some((id) => id.indexOf("overlap_") === 0),
    "no 'Two objects' finding expected for a radiator + the window above it, got " + JSON.stringify(ids));
});

// NEGATIVE CONTROL, genuinely red/green: an overly broad predicate (or a mistake in `isBlocker`)
// would silence this too. A radiator and a table sharing the same floor spot are NOT exempted.
test("flow_radiateur_et_table_au_meme_endroit_reste_signale", () => {
  const P = PIECE_PLAN_F2();
  P.pieces.push({ id: "rad1", type: "radiateur", name: "Radiateur", x: 150, y: 100, w: 80, h: 12, rot: 0, locked: false });
  P.pieces.push({ id: "t1", type: "dining", name: "Table", x: 150, y: 100, w: 150, h: 90, rot: 0, locked: false });
  flowPlan(P);
  const ids = FLOW.analyzeApt().findings.map((f) => f.id);
  return expect(ids.indexOf("overlap_rad1_t1") >= 0,
    "a radiator overlapping a table must still be flagged, got " + JSON.stringify(ids));
});

// A door stays a floor obstacle: a radiator in its swing is still caught, by Rule 2, which
// `passeAuDessus` never touches (doors are excluded from the predicate on purpose).
test("flow_radiateur_devant_porte_reste_signale", () => {
  const P = PIECE_PLAN_F2();
  P.openings.push({ id: "d1", wallId: "wN", t0: 150, w: 80, h: 12, type: "door", side: 0, name: "Porte", hinge: 0, swing: 1 });
  P.pieces.push({ id: "rad1", type: "radiateur", name: "Radiateur", x: 150, y: 20, w: 80, h: 12, rot: 0, locked: false });
  flowPlan(P);
  const ids = FLOW.analyzeApt().findings.map((f) => f.id);
  return expect(ids.indexOf("swing_d1_rad1") >= 0,
    "a radiator in the doorway must still block the door swing, got " + JSON.stringify(ids));
});

// F2, bullets 2 and 3: placing/moving a wall fixture near a radiator, and sliding a radiator under
// an existing wall fixture, are pure functions of the WALLS (`v5NearestWall`): they never read
// `P.pieces`/`P.openings` of the OTHER kind, so neither can refuse because of the other. Proved,
// not assumed.
test("pose_fenetre_sur_mur_ou_un_radiateur_est_deja_colle_n_est_pas_refusee", () => {
  const wall: Mur = { id: "wN", a: [0, 0], b: [400, 0], t: 12 };
  const P: PlanV5 = {
    outline: [], walls: [wall], openings: [],
    pieces: [{ id: "rad1", type: "radiateur", name: "Radiateur", x: 150, y: 6, w: 80, h: 12, rot: 0, locked: false }],
    cells: [],
  };
  const fab = { newId: (prefix: string) => prefix + "1", autoName: (base: string) => base };
  const op = v5PlaceWallMount(P, "window", 190, 0, 60, fab);
  return expect(!!op, "placing a window on a wall where a radiator already sits must NOT be refused, got null");
});

test("aimant_radiateur_sous_une_fenetre_existante_n_est_pas_refuse", () => {
  const wall: Mur = { id: "wN", a: [0, 0], b: [400, 0], t: 12 };
  const P: PlanV5 = {
    outline: [], walls: [wall],
    openings: [{ id: "win1", wallId: "wN", t0: 130, w: 120, h: 12, type: "window", side: 0, name: "Fenêtre" }],
    pieces: [], cells: [],
  };
  const r = meubleWallSnap(P, rectCentre(190, 4), 20);
  return expect(!!r, "the wall magnet must not be blocked by a window already on that wall, got null");
});

// =================================================================================================
//  4sexies. DETACHING FROM A WALL RESTORES THE ROTATION FROM BEFORE THE MAGNET
//  (modele/aimant-memoire.ts, `rotationAimantee`). Lot S7: "si je le fais 'stick' à un mur par
//  inadvertance qu'il puisse reprendre son orientation originale si je le détache du mur." PURE:
//  (rot at pointerdown, the magnet's verdict this instant or null) -> rot to apply, with a session
//  Map as its only side effect (`oublierAvantAimant` resets it between cases).
// =================================================================================================
test("aimant_memoire_meme_geste_hors_de_portee_reprend_l_origine", () => {
  oublierAvantAimant("m1");
  const depart = 30;
  const collee = rotationAimantee("m1", depart, 0);          // the back enters reach, mid-drag
  const hors = rotationAimantee("m1", depart, null);          // same drag, hand keeps moving, out of reach
  return expect(collee === 0, "snapped: rot must be the wall's, got " + collee)
      && expect(hors === depart, "pulled away in the SAME gesture: must return to " + depart + ", got " + hors);
});

test("aimant_memoire_nouveau_geste_hors_de_portee_reprend_l_origine", () => {
  oublierAvantAimant("m2");
  const depart = 45;
  rotationAimantee("m2", depart, 90);   // gesture 1: snaps, released with rot=90 (untested here)
  // gesture 2 starts: pointerdown reads the CURRENT rot (90, what the piece was left at), then
  // the hand carries it out of reach with no wall ever entering range again.
  const hors = rotationAimantee("m2", 90, null);
  return expect(hors === depart, "a later gesture that only leaves the wall must still return to "
    + depart + ", got " + hors);
});

test("aimant_memoire_tournee_a_la_main_puis_detachee_garde_le_choix", () => {
  oublierAvantAimant("m3");
  rotationAimantee("m3", 0, 90);         // snaps once, memory holds 0
  oublierAvantAimant("m3");              // the PERSON rotates it by hand: the hint is gone
  const choisie = 135;                   // the rotation they picked
  const hors = rotationAimantee("m3", choisie, null);   // next gesture starts there, leaves the wall
  return expect(hors === choisie, "a manual rotation must survive a later detach, expected "
    + choisie + ", got " + hors);
});

test("aimant_memoire_glissee_le_long_du_mur_reste_collee", () => {
  oublierAvantAimant("m4");
  rotationAimantee("m4", 10, 0);   // gesture 1: snaps
  // gesture 2: the piece never leaves reach (slides along the wall), so the magnet keeps firing
  // on every tick; it must keep answering the wall's rotation, never the remembered original.
  const t1 = rotationAimantee("m4", 0, 0);
  const t2 = rotationAimantee("m4", 0, 0);
  return expect(t1 === 0 && t2 === 0, "still snapped while sliding: rot must stay the wall's (0), got "
    + JSON.stringify({ t1, t2 }));
});

// =================================================================================================
//  5. SERVER VALIDATION (live-worker/ops.ts, already pure)
// =================================================================================================
const planV5 = () => ({ plan: sanitizeState({
  outline: [[0, 0], [600, 0], [600, 400], [0, 400]],
  walls: [{ id: "w1", a: [300, 0], b: [300, 400], t: 12 }],
  openings: [], pieces: [], cells: [], setupDone: true,
}) });
const refuse = (plan: PlanState, op: unknown, raison?: string): string | void => {
  try { applyOp(plan, op); return "op acceptée alors qu'elle devait être refusée (" + raison + ") : " + JSON.stringify(op); }
  catch (e) {
    if (!(e instanceof OpError)) return "erreur inattendue : " + e;
    if (raison && e.reason !== raison) return "refus attendu « " + raison + " », vu « " + e.reason + " »";
    return null;
  }
};

test("rapide_serveur_borne_la_profondeur_d_ouverture", () => {
  const st = planV5();
  const mauvais = refuse(st.plan, { kind: "opening.set", id: "o1",
    opening: { id: "o1", wallId: "w1", t0: 10, w: 80, h: 5000, type: "door", side: 0 } });
  applyOp(st.plan, { kind: "opening.set", id: "o2",
    opening: { id: "o2", wallId: "w1", t0: 10, w: 80, h: 12, type: "door", side: 0 } });
  return expect(!mauvais, mauvais || "")
      && expect(st.plan.openings.length === 1, "l'ouverture légitime doit passer, vu " + st.plan.openings.length);
});

test("rapide_serveur_borne_largeur_et_epaisseur", () => {
  const st = planV5();
  const e1 = refuse(st.plan, { kind: "wall.set", id: "w2", wall: { id: "w2", a: [0, 0], b: [10, 0], t: 999 } });
  const e2 = refuse(st.plan, { kind: "opening.set", id: "o1",
    opening: { id: "o1", wallId: "w1", t0: 0, w: 9999, h: 12, type: "door", side: 0 } });
  const e3 = refuse(st.plan, { kind: "opening.set", id: "o1",
    opening: { id: "o1", wallId: "w1", t0: 0, w: 80, h: 12, type: "trapdoor", side: 0 } });
  const e4 = refuse(st.plan, { kind: "opening.set", id: "o1",
    opening: { id: "o1", wallId: "w1", t0: 0, w: 80, h: 12, type: "door", side: 7 } });
  return expect(!e1 && !e2 && !e3 && !e4, [e1, e2, e3, e4].filter(Boolean).join(" | "));
});

test("rapide_serveur_refuse_une_coordonnee_absurde", () => {
  const st = planV5();
  const e1 = refuse(st.plan, { kind: "wall.set", id: "w2", wall: { id: "w2", a: [0, 0], b: [1e12, 0], t: 12 } });
  const e2 = refuse(st.plan, { kind: "wall.set", id: "w2", wall: { id: "w2", a: [0, 0], b: [NaN, 0], t: 12 } });
  return expect(!e1 && !e2, [e1, e2].filter(Boolean).join(" | "));
});

test("rapide_serveur_refuse_un_id_hostile", () => {
  const st = planV5();
  const e = refuse(st.plan, { kind: "wall.set", id: 'w"><img src=x>',
    wall: { id: 'w"><img src=x>', a: [0, 0], b: [10, 0], t: 12 } });
  return expect(!e, e || "");
});

test("rapide_serveur_tronque_un_nom_trop_long", () => {
  const st = planV5();
  applyOp(st.plan, { kind: "cells.replace",
    cells: [{ id: "c1", poly: [[0, 0], [100, 0], [100, 100], [0, 100]], name: "x".repeat(500), floor: "parquet" }] });
  const n = st.plan.cells[0].name.length;
  return expect(n === 80, "le nom doit être TRONQUÉ à 80 (jamais refusé : un refus fait disparaître la modif), vu " + n);
});

test("rapide_ouverture_orpheline_est_refusee", () => {
  const st = planV5();
  const e = refuse(st.plan, { kind: "opening.set", id: "o1",
    opening: { id: "o1", wallId: "wZZ", t0: 10, w: 80, h: 12, type: "door", side: 0 } });
  return expect(!e, e || "");
});

test("rapide_supprimer_un_mur_emporte_ses_ouvertures", () => {
  const st = planV5();
  applyOp(st.plan, { kind: "opening.set", id: "o1",
    opening: { id: "o1", wallId: "w1", t0: 10, w: 80, h: 12, type: "door", side: 0 } });
  applyOp(st.plan, { kind: "wall.del", wallId: "w1" });
  return expect(st.plan.walls.length === 0, "le mur doit partir, vu " + st.plan.walls.length)
      && expect(st.plan.openings.length === 0, "aucune ouverture ORPHELINE ne doit rester, vu " + st.plan.openings.length);
});

test("rapide_ops_sont_idempotentes", () => {
  // The server's echo replays the op at its author's: replaying it must change NOTHING.
  const st = planV5();
  const op = { kind: "piece.set", id: "p1",
    piece: { id: "p1", type: "sofa3", name: "canapé", x: 10, y: 10, w: 200, h: 90, rot: 0 } };
  applyOp(st.plan, op);
  const fp1 = planFp(st.plan);
  applyOp(st.plan, op); applyOp(st.plan, op);
  return expect(planFp(st.plan) === fp1, "trois applications = une seule (empreinte)")
      && expect(st.plan.pieces.length === 1, "un seul meuble, vu " + st.plan.pieces.length);
});

// =================================================================================================
//  6. NETWORK SERIALIZATION AND FIELD-BY-FIELD DIFF
// =================================================================================================
test("rapide_diff_n_emet_que_le_champ_change", () => {
  const st = planV5();
  applyOp(st.plan, { kind: "piece.set", id: "p1",
    piece: { id: "p1", type: "sofa3", name: "canapé", x: 10, y: 10, w: 200, h: 90, rot: 0 } });
  const avant = copieDe(miroirDe(st.plan));
  st.plan.pieces[0].x = 42;
  const ops = FIL.ws5DiffOps(st.plan, avant);
  return expect(ops.length === 1, "un seul champ bougé = une seule op, vu " + ops.length + " : " + JSON.stringify(ops))
      && expect(ops[0].kind === "piece.set" && ops[0].piece.id === "p1", "op mal adressée : " + JSON.stringify(ops[0]))
      && expect(ops[0].piece && ops[0].piece.x === 42, "l'op doit porter la NOUVELLE valeur, vu " + JSON.stringify(ops[0].piece))
      && expect(!("y" in ops[0].piece) || ops[0].piece.y === 10, "y ne doit pas être réécrit à tort : " + JSON.stringify(ops[0].piece));
});

// UN MUR SE SUPPRIME EN DERNIER, APRES LES OUVERTURES. Le serveur CASCADE les ouvertures d'un
// `wall.del`. Souder deux murs deplace les ouvertures du mur avale vers le survivant PUIS supprime
// le mur avale: en envoyant la suppression d'abord, le serveur detruisait ces ouvertures, et
// l'`opening.set` qui suivait etait refuse (`opening_w`: la ligne n'existe plus) donc rien ne les
// ramenait. Trouve par une revue adverse en rejouant les ops emises contre le VRAI validateur:
// souder un mur portant deux portes en laissait une seule sur le plan partage.
test("rapide_un_mur_se_supprime_apres_les_ouvertures_qui_l_ont_quitte", () => {
  const st = planV5();
  applyOp(st.plan, { kind: "wall.set", wall: { id: "wA", a: [0, 300], b: [200, 300], t: 12, free: 1 } });
  applyOp(st.plan, { kind: "wall.set", wall: { id: "wB", a: [200, 300], b: [400, 300], t: 12, free: 1 } });
  applyOp(st.plan, { kind: "opening.set", opening: { id: "oA", wallId: "wA", t0: 40, w: 80, h: 12, type: "door", side: 0 } });
  applyOp(st.plan, { kind: "opening.set", opening: { id: "oB", wallId: "wB", t0: 40, w: 80, h: 12, type: "door", side: 0 } });
  const avant = copieDe(miroirDe(st.plan));
  // L'etat que le SERVEUR a avant la soudure: une copie exacte, passee par son propre validateur.
  const serveur = { plan: sanitizeState(JSON.parse(JSON.stringify(st.plan))) };
  // La soudure telle que le modele la fait: l'ouverture du mur avale passe au survivant, et le mur
  // avale disparait.
  const wA = st.plan.walls.find((w: DonneeDynamique) => String(w.id) === "wA");
  wA.b = [400, 300];
  const oB = st.plan.openings.find((o: DonneeDynamique) => String(o.id) === "oB");
  oB.wallId = "wA"; oB.t0 = 240;
  st.plan.walls = st.plan.walls.filter((w: DonneeDynamique) => String(w.id) !== "wB");
  const ops = FIL.ws5DiffOps(st.plan, avant);
  const iSup = ops.findIndex((o: DonneeDynamique) => o.kind === "wall.del" && o.wallId === "wB");
  const iOuv = ops.findIndex((o: DonneeDynamique) => o.kind === "opening.set" && o.opening && o.opening.id === "oB");
  if (!expect(iSup >= 0 && iOuv >= 0, "la soudure doit emettre wall.del ET opening.set : " + JSON.stringify(ops))) return false;
  if (!expect(iOuv < iSup, "l'ouverture doit etre relogee AVANT que son ancien mur ne parte : " + JSON.stringify(ops.map((o: DonneeDynamique) => o.kind)))) return false;
  // Et on rejoue contre le VRAI serveur: les deux portes doivent survivre.
  let refus = "";
  for (const op of ops) {
    try { applyOpReel(serveur.plan, op as unknown as Operation); }
    catch (e) { refus += (e instanceof OpError ? e.message : String(e)) + " "; }
  }
  return expect(!refus, "le serveur ne doit refuser aucune op de la soudure, vu : " + refus)
      && expect(serveur.plan.openings.length === 2,
        "les DEUX portes doivent survivre a la soudure, vu " + JSON.stringify(serveur.plan.openings.map((o: DonneeDynamique) => String(o.id))));
});

test("rapide_diff_ne_dit_rien_quand_rien_ne_bouge", () => {
  const st = planV5();
  applyOp(st.plan, { kind: "piece.set", id: "p1",
    piece: { id: "p1", type: "sofa3", name: "canapé", x: 10, y: 10, w: 200, h: 90, rot: 0 } });
  return expect(FIL.ws5DiffOps(st.plan, copieDe(miroirDe(st.plan))).length === 0, "aucun changement = aucune op");
});

test("rapide_creation_envoie_l_entite_entiere", () => {
  const st = planV5();
  const avant = copieDe(miroirDe(st.plan));
  st.plan.openings.push({ id: "o1", wallId: "w1", t0: 10, w: 80, h: 12, type: "door", side: 0 });
  const ops = FIL.ws5DiffOps(st.plan, avant);
  return expect(ops.length === 1 && ops[0].kind === "opening.set", "une création = une op opening.set, vu " + JSON.stringify(ops))
      && expect(["wallId", "t0", "w", "h", "type"].every((k) => k in ops[0].opening),
         "une création porte l'entité ENTIÈRE, vu " + JSON.stringify(ops[0].opening));
});

test("rapide_une_suppression_part_sur_le_fil", () => {
  const st = planV5();
  applyOp(st.plan, { kind: "opening.set", id: "o1",
    opening: { id: "o1", wallId: "w1", t0: 10, w: 80, h: 12, type: "door", side: 0 } });
  const avant = copieDe(miroirDe(st.plan));
  st.plan.openings = [];
  const ops = FIL.ws5DiffOps(st.plan, avant);
  return expect(ops.length === 1 && ops[0].kind === "opening.del" && ops[0].openingId === "o1",
    "une suppression = opening.del, vu " + JSON.stringify(ops));
});

test("rapide_le_diff_traverse_le_serveur", () => {
  // The contract that matters: what the diff emits, the server accepts, and the plan converges.
  const st = planV5();
  const avant = copieDe(miroirDe(st.plan));
  st.plan.walls.push({ id: "w9", a: [0, 200], b: [300, 200], t: 12 });
  st.plan.openings.push({ id: "o1", wallId: "w1", t0: 10, w: 80, h: 12, type: "door", side: 0 });
  st.plan.pieces.push({ id: "p1", type: "sofa3", name: "canapé", x: 10, y: 10, w: 200, h: 90, rot: 0 });
  const ops = FIL.ws5DiffOps(st.plan, avant);
  const serveur = planV5();
  for (const op of ops) applyOp(serveur.plan, op);
  return expect(ops.length === 3, "trois entités neuves = trois ops, vu " + ops.length)
      && expect(planFp(serveur.plan) === planFp(st.plan),
         "le serveur doit converger sur le plan de l'émetteur\n  serveur=" + planFp(serveur.plan) + "\n  client =" + planFp(st.plan));
});

test("rapide_forme_du_fil_est_la_forme_du_serveur", () => {
  // No foreign key crosses over: `sanitizeState` REFUSES, it does not clean up silently.
  const st = planV5();
  const sale = JSON.parse(JSON.stringify(st.plan));
  sale.pieces.push({ id: "p1", type: "sofa3", name: "x", x: 1, y: 1, w: 10, h: 10, rot: 0, _drag: true });
  let refuse = null;
  try { sanitizeState(sale); } catch (e) { refuse = e.reason; }
  // and the emission mirror, meanwhile, CARRIES only the wire's keys.
  const m = miroirDe(st.plan);
  const w = JSON.parse(m.walls.get("w1"));
  return expect(refuse === "piece_key:_drag", "une clé étrangère doit être refusée nommément, vu " + refuse)
      && expect(Object.keys(w).sort().join(",") === "a,b,id,t",
         "le miroir du mur ne porte que a,b,id,t, vu " + JSON.stringify(Object.keys(w)));
});

// =================================================================================================
//  7. UNDO
// =================================================================================================
test("rapide_annuler_puis_retablir_rend_le_meme_document", () => {
  // Figma's rule: N undos then N redos yield an IDENTICAL document.
  const st = planV5();
  const instantanes = [JSON.parse(JSON.stringify(st.plan))];
  const suite = [
    { kind: "piece.set", id: "p1", piece: { id: "p1", type: "sofa3", name: "a", x: 10, y: 10, w: 100, h: 50, rot: 0 } },
    { kind: "opening.set", id: "o1", opening: { id: "o1", wallId: "w1", t0: 10, w: 80, h: 12, type: "door", side: 0 } },
    { kind: "piece.set", id: "p1", piece: { id: "p1", type: "sofa3", name: "a", x: 90, y: 10, w: 100, h: 50, rot: 0 } },
  ];
  for (const op of suite) { applyOp(st.plan, op); instantanes.push(JSON.parse(JSON.stringify(st.plan))); }
  const fpFinal = planFp(st.plan);
  const fpDebut = planFp(instantanes[0]);
  // three undos = returning to the starting snapshot; three redos = replaying the sequence.
  const rejoue = JSON.parse(JSON.stringify(instantanes[0]));
  for (const op of suite) applyOp(rejoue, op);
  return expect(planFp(rejoue) === fpFinal, "le rétablissement doit rendre le document identique\n  " + planFp(rejoue) + " vs " + fpFinal)
      && expect(fpDebut !== fpFinal, "le document doit VRAIMENT avoir changé (sinon la vérification ne prouve rien)");
});

test("rapide_annuler_ne_detruit_pas_le_travail_de_l_autre", () => {
  // Local undo republishes BY DIFF against the mirror: the peer's op, arrived in the meantime,
  // is not in the diff, so it survives.
  const st = planV5();
  applyOp(st.plan, { kind: "piece.set", id: "moi",
    piece: { id: "moi", type: "sofa3", name: "a", x: 10, y: 10, w: 100, h: 50, rot: 0 } });
  const avantMonGeste = JSON.parse(JSON.stringify(st.plan));
  applyOp(st.plan, { kind: "piece.set", id: "moi",
    piece: { id: "moi", type: "sofa3", name: "a", x: 300, y: 10, w: 100, h: 50, rot: 0 } });
  // the peer places THEIR furniture in the meantime
  applyOp(st.plan, { kind: "piece.set", id: "lui",
    piece: { id: "lui", type: "table", name: "b", x: 400, y: 300, w: 120, h: 80, rot: 0 } });
  // I undo: I restore MY entity to its prior value, by diff, without touching the rest
  const miroir = miroirDe(st.plan);
  const cible = JSON.parse(JSON.stringify(st.plan));
  cible.pieces = cible.pieces.map((p: DonneeDynamique) => (p.id === "moi" ? avantMonGeste.pieces[0] : p));
  const ops = FIL.ws5DiffOps(cible, copieDe(miroir));
  for (const op of ops) applyOp(st.plan, op);
  const moi = st.plan.pieces.find((p) => p.id === "moi"), lui = st.plan.pieces.find((p) => p.id === "lui");
  const vises = ops.map((o) => (o.piece && o.piece.id) || o.pieceId || null);
  return expect(vises.every((v) => v === "moi"), "l'annulation ne doit adresser QUE mon entité, vu " + JSON.stringify(vises))
      && expect(moi && moi.x === 10, "mon meuble revient à x=10, vu " + (moi && moi.x))
      && expect(lui && lui.x === 400, "le meuble du PAIR doit survivre à mon annulation, vu " + JSON.stringify(lui));
});

test("rapide_un_remplacement_global_ne_laisse_pas_d_orphelin", () => {
  const st = planV5();
  applyOp(st.plan, { kind: "opening.set", id: "o1",
    opening: { id: "o1", wallId: "w1", t0: 10, w: 80, h: 12, type: "door", side: 0 } });
  applyOp(st.plan, { kind: "outline.set", outline: [[0, 0], [800, 0], [800, 500], [0, 500]] });
  const murs = new Set(st.plan.walls.map((w) => w.id));
  return expect(st.plan.openings.every((o) => murs.has(String(o.wallId))),
    "aucune ouverture ne doit pointer un mur absent, vu " + JSON.stringify(st.plan.openings.map((o) => o.wallId)));
});

// =================================================================================================
//  8. ONLY A CHOSEN NAME GETS WRITTEN ON THE PLAN (screen, printed sheet and PNG share the rule)
// =================================================================================================
const nommee = (type: string, name: string): Piece => ({ id: "x", type, name, x: 0, y: 0, w: 100, h: 100, rot: 0 });

test("rapide_nom_de_catalogue_courant_ne_s_ecrit_pas", () => {
  const cas = [["chair", "Chair"], ["dining", "Dining table"], ["coffee", "Coffee table"],
               ["counter", "Worktop"], ["bed", "Bed (160)"]];
  const dus = cas.filter(([t, n]) => NOMS.isChosenName(nommee(t, n)));
  return expect(dus.length === 0, "aucun libellé du catalogue COURANT ne doit s'écrire, vu " + JSON.stringify(dus));
});

test("rapide_ancien_libelle_anglais_ne_s_ecrit_pas", () => {
  // The catalog was translated along the way: an earlier plan still carries "Chair",
  // "Table", "Coffee table". Without the table of historical labels (js/01), the rule
  // mistook them for chosen names, measured on the household's plan: four "Chair" surrounding a
  // "Table" at working zoom, exactly what we wanted to silence.
  const dus = [];
  for (const type of Object.keys(NOMS.LEGACY_TYPE_NAMES))
    for (const ancien of NOMS.LEGACY_TYPE_NAMES[type])
      if (NOMS.isChosenName(nommee(type, ancien))) dus.push([type, ancien]);
  return expect(dus.length === 0, "aucun libellé HISTORIQUE ne doit s'écrire, vu " + JSON.stringify(dus));
});

test("rapide_le_numero_d_occurrence_ne_fait_pas_un_nom_choisi", () => {
  // Same normalization for both tables: `baseName` strips the "3" from "Chair 3".
  const dus = [["chair", "Chair 3"], ["chair", "Chaise 2"], ["counter", "Plan de travail 3"],
               ["dining", "Table 2"], ["coffee", "Coffee table 4"]]
    .filter(([t, n]) => NOMS.isChosenName(nommee(t, n)));
  return expect(dus.length === 0, "un numéro d'occurrence ne transforme pas un nom de catalogue en nom choisi, vu " + JSON.stringify(dus));
});

test("rapide_un_nom_tape_s_ecrit_toujours", () => {
  // The point of the rule: what is nowhere else on the plan must stay legible on it.
  const muets = [["sofa3", "Homu"], ["sofa3", "Ikea"], ["desk", "Bureau d'Élise"],
                 ["chair", "Chaise de bureau"], ["inconnu", "Machin"]]
    .filter(([t, n]) => !NOMS.isChosenName(nommee(t, n)));
  return expect(muets.length === 0, "un nom TAPÉ s'écrit, et un type INCONNU ne se juge pas, vu " + JSON.stringify(muets));
});

test("rapide_la_table_des_anciens_libelles_ne_couvre_que_des_types_connus", () => {
  // A type gone from the catalog would silence a name for nothing: the table is catalog
  // data, it must stay aligned with it.
  const orphelins = Object.keys(NOMS.LEGACY_TYPE_NAMES).filter((t) => !NOMS.TYPEMAP[t]);
  const vides = Object.keys(NOMS.LEGACY_TYPE_NAMES).filter((t) => !NOMS.LEGACY_TYPE_NAMES[t].length);
  return expect(orphelins.length === 0, "type historique absent du catalogue : " + JSON.stringify(orphelins))
      && expect(vides.length === 0, "entrée historique vide : " + JSON.stringify(vides));
});

// =================================================================================================
//  THE SECOND TAXONOMY (by kind)
// =================================================================================================
// The `KIND_BY_TYPE` table lives ALONGSIDE the catalog and not INSIDE it: it reads at a glance,
// but nothing in the language forces a batch that adds furniture to register it there. This is the test that
// forces it. Without it, a new object would silently fall into "Other" and the by-kind grouping
// would lie without anything breaking.
test("rapide_chaque_type_du_catalogue_a_une_nature", () => {
  const types = CATALOG.flatMap((g) => g.items.map((it) => it.type));
  const sans = types.filter((t) => !KIND_BY_TYPE[t]);
  const inconnues = Object.keys(KIND_BY_TYPE).filter((t) => !types.includes(t));
  const horsOrdre = [...new Set(Object.values(KIND_BY_TYPE))].filter((k) => !KIND_ORDER.includes(k));
  return expect(sans.length === 0, "type sans nature (il tomberait dans « Other ») : " + JSON.stringify(sans))
      && expect(inconnues.length === 0, "nature déclarée pour un type absent du catalogue : " + JSON.stringify(inconnues))
      && expect(horsOrdre.length === 0, "nature absente de KIND_ORDER, donc jamais affichée : " + JSON.stringify(horsOrdre));
});

test("rapide_ranger_par_nature_ne_perd_ni_ne_duplique_aucun_objet", () => {
  // Both groupings must contain EXACTLY the same objects: changing axis is a view,
  // not a filter. An object lost here would be an object that became impossible to place.
  const parPiece = CATALOG.flatMap((g) => g.items.map((it) => it.type)).sort();
  const parNature = catalogueParNature().flatMap((g) => g.items.map((it) => it.type)).sort();
  const doublons = parNature.filter((t, i) => i > 0 && parNature[i - 1] === t);
  return expect(JSON.stringify(parPiece) === JSON.stringify(parNature),
      "les deux axes doivent contenir les mêmes types (pièce " + parPiece.length + ", nature " + parNature.length + ")")
      && expect(doublons.length === 0, "objet en double dans le rangement par nature : " + JSON.stringify(doublons))
      && expect(kindOf("type_inconnu_venu_d_un_import") === "Other", "un type inconnu doit retomber sur « Other »");
});

// =================================================================================================
//  L'OUTIL MUR : LA CHAINE, SANS NAVIGATEUR
// =================================================================================================
// La grammaire du tracé clic-clic, isolée dans `gestes/outil-mur.ts` pour être testable: ce qu'un
// clic VEUT DIRE, sans plan, sans DOM et sans aimant. Où le point atterrit reste la décision de
// l'appelant.

test("outil_mur_le_premier_clic_pose_un_depart_sans_creer_de_segment", () => {
  const r = outilMurPoint(outilMurNeuf(), [10, 20]);
  return expect(r.segment === null, "le premier clic ne doit fermer aucun segment")
      && expect(JSON.stringify(r.etat.depart) === "[10,20]", "il doit retenir le départ, vu " + JSON.stringify(r.etat.depart));
});

test("outil_mur_chaque_clic_suivant_ferme_un_segment_et_rouvre_la_chaine", () => {
  const a = outilMurPoint(outilMurNeuf(), [0, 0]);
  const b = outilMurPoint(a.etat, [300, 0]);
  const c = outilMurPoint(b.etat, [300, 200]);
  return expect(JSON.stringify(b.segment) === "[[0,0],[300,0]]", "segment 1, vu " + JSON.stringify(b.segment))
      && expect(JSON.stringify(c.segment) === "[[300,0],[300,200]]", "segment 2, vu " + JSON.stringify(c.segment))
      && expect(JSON.stringify(c.etat.depart) === "[300,200]", "l'arrivée devient le départ du suivant");
});

test("outil_mur_finir_une_chaine_ouverte_ne_quitte_pas_l_outil_et_ne_cree_rien", () => {
  const a = outilMurPoint(outilMurNeuf(), [0, 0]);
  const f = outilMurFin(a.etat);
  return expect(f.quitter === false, "une chaîne commencée: Échap la termine, il ne quitte pas l'outil")
      && expect(f.etat.depart === null, "et la chaîne est vide après")
      // deuxième Échap, plus rien dans la main: là seulement on quitte
      && expect(outilMurFin(f.etat).quitter === true, "Échap sur un premier point non posé quitte l'outil");
});

test("outil_mur_une_longueur_tapee_pose_le_point_dans_la_direction_visee", () => {
  const p = outilMurALongueur([0, 0], [500, 0], 120);
  const q = outilMurALongueur([100, 100], [100, 900], 50);
  return expect(p !== null && p[0] === 120 && p[1] === 0, "120 cm vers la droite, vu " + JSON.stringify(p))
      && expect(q !== null && q[0] === 100 && q[1] === 150, "50 cm vers le bas, vu " + JSON.stringify(q))
      && expect(outilMurALongueur([0, 0], [0, 0], 120) === null, "sans direction visée, rien n'est posé")
      && expect(outilMurALongueur([0, 0], [500, 0], 0) === null, "une longueur nulle ne pose rien");
});

// =================================================================================================
//  UN MUR VA D'UN POINT À UN POINT (décision 0012)
// =================================================================================================
// Un mur v5 était TRAVERSANT: chaque bout était repoussé jusqu'à la première géométrie rencontrée,
// à chaque recalcul, donc au chargement, à chaque image d'un geste et à la réception d'une op. Il
// fallait un drapeau `free` pour y échapper, et ce drapeau était posé par le tracé, par la coupe,
// par le redressement, par la longueur tapée et par un couple de boutons dans la fiche. Ce qui
// reste: un mur va de `a` à `b`, l'aimant décide où `b` se pose, et rien ne s'allonge tout seul.
// Le contour, lui, borne toujours: « libre » n'a jamais voulu dire « autorisé à sortir du logement ».

/** Un 400x300 avec ses quatre façades, et les cloisons passées en argument. */
const planMurs = (murs: DonneeDynamique[]): PlanV5 => sanitizeV5Plan({
  outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
  walls: murs, openings: [], pieces: [], cells: [],
} as DonneeDynamique)!;
/** Le mur VIVANT dans `P.walls`: `sanitizeV5Plan` reconstruit des objets neufs. */
const murDe = (P: PlanV5, id: string): Mur => P.walls.find((w) => String(w.id) === id)!;
/** `v5WallDragCtx`/`v5WallDragApply`/`v5WallEndDragApply` ne touchent que `etat.plan` et `canvas`. */
const ctxMurs = (P: PlanV5): DonneeDynamique =>
  ({ etat: { plan: P }, canvas: { querySelector: (): null => null }, rev: 0, crochets: {}, ihm: {} }) as DonneeDynamique;

test("un_mur_pose_a_40_cm_d_un_autre_reste_a_40_cm", () => {
  // AVANT: `v5ThroughWall` poussait le bout `b` jusqu'à la cloison (x=200) et le bout `a` jusqu'à
  // la façade (x=0), donc une cloison de 120 cm dessinée à la main en faisait 200 dès le premier
  // recalcul. C'est le défaut d'usage qui a mené à ce lot.
  const P = planMurs([
    { id: "wB", a: [200, 50], b: [200, 250], t: 10, isOutline: false },
    { id: "wA", a: [40, 150], b: [160, 150], t: 10, isOutline: false },
  ]);
  MURS.v5ResoudreGeometrie(P, true);
  const a = murDe(P, "wA");
  return expect(a.a[0] === 40 && a.b[0] === 160,
      "la cloison garde ses deux bouts, vu a=" + JSON.stringify(a.a) + " b=" + JSON.stringify(a.b));
});

test("un_bout_amene_sur_un_mur_y_est_joint_et_le_suit", () => {
  // La jonction se fait par l'AIMANT au moment du lâcher (`v5WallEndDrop`), pas en restant
  // traversant, et c'est elle, et elle seule, qui fait suivre le bout quand le mur porteur bouge
  // (les suiveurs de la décision 0005, gardés).
  const P = planMurs([
    { id: "wB", a: [200, 50], b: [200, 250], t: 10, isOutline: false },
    { id: "wA", a: [40, 150], b: [160, 150], t: 10, isOutline: false },
  ]);
  const ctx = ctxMurs(P);
  const cible = MURS.v5WallEndDrop(P, "wA", [40, 150], 197, 150, 1, false);
  MURS.v5WallEndDragApply(ctx, "wA", "b", cible, true);
  const joint = murDe(P, "wA").b[0] === 200;
  const g = MURS.v5WallDragCtx(ctx, "wB");
  MURS.v5WallDragApply(ctx, g, 30, true);
  const a = murDe(P, "wA");
  return expect(joint, "le bout lâché à 3 cm du mur doit s'y poser exactement (x=200), vu " + murDe(P, "wA").b[0])
      && expect(murDe(P, "wB").a[0] === 170, "le mur porteur doit avoir bougé de 30 cm, vu " + murDe(P, "wB").a[0])
      && expect(a.b[0] === 170, "et le bout joint doit l'avoir suivi, vu " + JSON.stringify(a.b))
      && expect(a.a[0] === 40, "sans que l'autre bout bouge, vu " + JSON.stringify(a.a));
});

test("un_bout_laisse_loin_d_un_mur_ne_suit_plus_rien", () => {
  // Le contrôle négatif de la précédente: hors de portée, il n'y a pas de jonction, donc pas de
  // suiveur, donc rien ne bouge. C'était déjà vrai; ce qui change, c'est qu'il ne se rallonge plus
  // non plus jusqu'au mur voisin en attendant.
  const P = planMurs([
    { id: "wB", a: [200, 50], b: [200, 250], t: 10, isOutline: false },
    { id: "wA", a: [40, 150], b: [160, 150], t: 10, isOutline: false },
  ]);
  const ctx = ctxMurs(P);
  const g = MURS.v5WallDragCtx(ctx, "wB");
  MURS.v5WallDragApply(ctx, g, 30, true);
  const a = murDe(P, "wA");
  return expect(a.b[0] === 160, "le bout à 40 cm ne suit pas, vu " + JSON.stringify(a.b))
      && expect(a.a[0] === 40, "et l'autre bout non plus, vu " + JSON.stringify(a.a));
});

test("free_est_lu_en_entree_ignore_et_jamais_reecrit", () => {
  // C-5 à l'envers: le serveur accepte encore la clé (`WALL_KEYS`), un onglet resté ouvert peut
  // encore l'envoyer, et le client la lit sans la garder. Ce qu'il ne fait plus JAMAIS, c'est
  // l'écrire: ni dans le plan enregistré, ni sur le fil.
  const P = planMurs([{ id: "wA", a: [40, 150], b: [160, 150], t: 10, isOutline: false, free: 1 }]);
  const a = murDe(P, "wA");
  const fil = v5StateWire(P, true);
  const w = fil.walls.find((q) => String(q.id) === "wA");
  return expect(!("free" in (a as unknown as Record<string, unknown>)),
      "la relecture ne garde pas `free`, vu " + JSON.stringify(a))
      && expect(a.a[0] === 40 && a.b[0] === 160, "et elle ne déplace pas le mur d'un centimètre")
      && expect(!!w && !("free" in (w as unknown as Record<string, unknown>)),
      "le fil ne porte plus la clé `free`, vu " + JSON.stringify(w));
});

test("une_fenetre_survit_a_une_coupe_puis_a_un_ressoudage", () => {
  // Le propriétaire: « if i split a wall, and then want to "merge it back" how do i do it? »
  // `v5WallMergeAt` RÉPROJETTE chaque ouverture depuis le mur qui la porte au moment de la fusion,
  // plutôt que d'additionner des longueurs (qui suppose les deux moitiés dans le même sens): ce
  // test vérifie que la fenêtre revient exactement à sa place d'avant la coupe, une fois les deux
  // moitiés ressoudées en une seule paroi.
  const P: PlanV5 = {
    outline: [[0, 0], [500, 0], [500, 300], [0, 300]],
    walls: [{ id: "w1", a: [0, 150], b: [500, 150], t: 10, isOutline: false }],
    openings: [{ id: "o1", wallId: "w1", t0: 300, w: 60, h: 12, type: "window", side: 0, name: "Fenêtre" } as Ouverture],
    pieces: [], cells: [],
  };
  const div = v5WallSplitAt(P, "w1");
  expect("id" in div, "la coupe doit réussir, vu " + JSON.stringify(div));
  if (!("id" in div)) return;
  expect(P.walls.length === 2, "deux moitiés après la coupe, vu " + P.walls.length);
  // La coupe est au milieu (x=250): la fenêtre (t0=300) est au-delà, donc bascule sur la SECONDE
  // moitié à t0=50. C'est précisément ce cas (l'ouverture n'est plus portée par le mur qui garde
  // son bout `a`) qui force `v5WallMergeAt` à reprojeter plutôt qu'à recopier `t0` tel quel.
  expect(String(P.openings[0]!.wallId) === String(div.id) && P.openings[0]!.t0 === 50,
    "la fenêtre bascule sur la seconde moitié à t0=50, vu " + JSON.stringify(P.openings[0]));
  expect(!!v5WallMergeCandidate(P, "w1", "b"), "le bout b de la première moitié doit être un candidat à la fusion");
  const fusion = v5WallMergeAt(P, "w1", "b");
  expect("id" in fusion, "la fusion doit réussir, vu " + JSON.stringify(fusion));
  expect(P.walls.length === 1, "une seule paroi après ressoudage, vu " + P.walls.length);
  return expect(P.openings.length === 1 && P.openings[0]!.t0 === 300 && String(P.openings[0]!.wallId) === "w1",
    "la fenêtre est de retour à t0=300 sur w1, vu " + JSON.stringify(P.openings[0]));
});

// =================================================================================================
//  LIGHTING: A MAP OF LEVELS, CUT BY THE WALLS (src/ts/circulation/lumiere.ts)
// =================================================================================================
// La carte se calcule sur la MÊME grille que Circulation : on passe donc par `analyzeApt()`, qui
// construit le contexte (`FL.flowCtx`) et la grille, puis on lit `grid.g`.
const carteDuPlan = (jour: boolean) => {
  const r = FLOW.analyzeApt();
  const g = r.grid.g;
  if (!g) return null;
  const cells = FL.flowCtx ? FL.flowCtx.cells : [];
  const pieces = FL.flowCtx ? FL.flowCtx.pieces : [];
  return { g, cells, carte: carteLumiere(g, sourcesLumiere(pieces, cells, jour), cells) };
};

test("lumiere_plafonnier_1500lm_dans_une_piece_de_4m_donne_la_moyenne_attendue", () => {
  // Une pièce carrée de 4 m, un plafonnier de 1 500 lm en son centre, à 2,40 m. La formule est
  // lm / (4·pi·d²), d en mètres, d² = (dx² + dy² + h²). Intégrée sur le sol praticable, elle vaut
  // une quinzaine de lux : un plafonnier seul n'éclaire PAS une pièce de 16 m² à la cible de 150.
  const P: DonneeDynamique = {
    outline: [[0, 0], [400, 0], [400, 400], [0, 400]],
    walls: [{ id: "wt", a: [0, 0], b: [400, 0], t: 12, isOutline: true },
            { id: "wr", a: [400, 0], b: [400, 400], t: 12, isOutline: true },
            { id: "wb", a: [400, 400], b: [0, 400], t: 12, isOutline: true },
            { id: "wl", a: [0, 400], b: [0, 0], t: 12, isOutline: true }],
    openings: [],
    pieces: [{ id: "L1", type: "ceil", name: "Plafonnier", x: 185, y: 185, w: 30, h: 30, rot: 0, locked: false }],
    cells: [],
  };
  flowPlan(P);
  const v = carteDuPlan(false);
  if (!v) return expect(false, "la grille de circulation doit exister");
  const moy = v.carte.moyennes[0] ?? -1;
  // RÉFÉRENCE INDÉPENDANTE : la même physique, sur un pas de 1 cm écrit ici, sur la zone que la
  // grille laisse libre (les cases à moins de wallPad = cs·0,7 = 7 cm d'une paroi sont bloquées).
  let somme = 0, n = 0;
  for (let x = 7.5; x < 393; x += 1) {
    for (let y = 7.5; y < 393; y += 1) {
      const d2 = ((x - 200) ** 2 + (y - 200) ** 2 + 240 ** 2) / 10000;
      somme += 1500 / (4 * Math.PI * d2); n++;
    }
  }
  const attendu = somme / n;
  return expect(Math.abs(moy - attendu) / attendu < 0.10,
      "la moyenne de la pièce doit être à ±10 % de " + attendu.toFixed(2) + " lx, vue " + moy.toFixed(2))
      && expect(moy > 10 && moy < 40, "et rester dans l'ordre de grandeur physique, vue " + moy.toFixed(2));
});

test("lumiere_le_mur_coupe_la_piece_voisine_recoit_zero", () => {
  // 600x400 coupé en deux par une cloison : un plafonnier posé À GAUCHE n'éclaire pas la droite.
  const P = SEED_PLAN_V5();
  P.pieces.push({ id: "L1", type: "ceil", name: "Plafonnier", x: 135, y: 185, w: 30, h: 30, rot: 0, locked: false });
  flowPlan(P);
  const v = carteDuPlan(false);
  if (!v) return expect(false, "la grille de circulation doit exister");
  const eclairees = v.carte.moyennes.filter((m) => m > 0).length;
  const nulles = v.carte.moyennes.filter((m) => m === 0).length;
  return expect(v.cells.length === 2, "deux pièces attendues, vues " + v.cells.length)
      && expect(eclairees === 1 && nulles === 1,
          "une pièce éclairée, la voisine à 0, vu " + JSON.stringify(v.carte.moyennes.map((m) => Math.round(m))));
});

test("lumiere_cible_deduite_du_nom_et_le_lux_saisi_gagne", () => {
  return expect(cibleLux("Cuisine") === 300, "Cuisine -> 300, vu " + cibleLux("Cuisine"))
      && expect(cibleLux("Kitchen") === 300, "Kitchen -> 300, vu " + cibleLux("Kitchen"))
      && expect(cibleLux("Bureau") === 500, "Bureau -> 500, vu " + cibleLux("Bureau"))
      && expect(cibleLux("Salle de bain") === 200, "Salle de bain -> 200, vu " + cibleLux("Salle de bain"))
      && expect(cibleLux("Entrée") === 100, "Entrée (accentuée) -> 100, vu " + cibleLux("Entrée"))
      && expect(cibleLux("Atelier") === CIBLE_DEFAUT, "un nom inconnu -> 150, vu " + cibleLux("Atelier"))
      && expect(cibleLux("Cuisine", 220) === 220, "un lux saisi gagne sur le nom, vu " + cibleLux("Cuisine", 220));
});

// =================================================================================================
//  ROTATION HANDLE: PURE GEOMETRY (decision 0013)
// =================================================================================================
test("poignee_rotation_angle_depuis_le_centre_et_pas_de_15_sous_contrainte", () => {
  // The app's zero is "up" and it turns CLOCKWISE, exactly like a clock face: a pointer straight
  // above the center reads 0°, one straight to the right reads 90°.
  const haut = angleVersPointeur(50, 50, 50, 0, false);
  const droite = angleVersPointeur(50, 50, 150, 50, false);
  const bas = angleVersPointeur(50, 50, 50, 150, false);
  const gauche = angleVersPointeur(50, 50, -50, 50, false);
  // 40° unconstrained; Shift snaps to the NEAREST 15° step, here 45° (closer than 30°).
  const rad = (40 - 90) * Math.PI / 180;
  const px = 1000 * Math.cos(rad), py = 1000 * Math.sin(rad);
  const libre = angleVersPointeur(0, 0, px, py, false);
  const contraint = angleVersPointeur(0, 0, px, py, true);
  return expect(haut === 0, "tout droit au-dessus du centre = 0°, vu " + haut)
      && expect(droite === 90, "à droite du centre = 90°, vu " + droite)
      && expect(bas === 180, "en dessous du centre = 180°, vu " + bas)
      && expect(gauche === 270, "à gauche du centre = 270°, vu " + gauche)
      && expect(libre === 40, "sans contrainte, l'angle exact (40°) est gardé, vu " + libre)
      && expect(contraint === 45, "avec Shift, l'angle se cale sur le pas de 15° le plus proche (45°), vu " + contraint);
});

// =================================================================================================
//  VERDICT
// =================================================================================================
const passed = results.filter((r) => r.pass).length;
process.stdout.write("\n");
if (passed === results.length) {
  process.stdout.write("OK " + passed + "/" + results.length + "\n");
  process.exit(0);
} else {
  process.stdout.write("FAILURES " + (results.length - passed) + "/" + results.length + ":\n");
  results.filter((r) => !r.pass).forEach((r) => process.stdout.write("  - " + r.name + ": " + r.detail.split("\n")[0] + "\n"));
  process.exit(1);
}
