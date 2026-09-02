#!/usr/bin/env node
// =================================================================================================
//  THE FAST LOOP — against the TypeScript MODULES (src/ts), by import.
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
  v5OpeningBox, v5CellsAt, sanitizeV5Plan,
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
import { oublierPhotoCellules, photoCellules, photographierCellules } from "../src/ts/modele/photo-cellules.ts";

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
    throw new Error("CONTRAT CLIENT/SERVEUR ROMPU (invariant C-5) — src/ts/partage/contrat-serveur.ts "
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
//  3. GEOMETRY AND CELL DETECTION
//  (moved from tests/model-v5-cellules.ts — same names, same assertions, no Chrome)
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
//  (moved from tests/model-v5-conversion-rendu.ts and tests/run.ts — same names, same
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
//  (moved from tests/model-v5-circulation.ts and tests/model-v5-edition.ts — same names,
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
         + unreach + " — findings: " + JSON.stringify(findingsIds));
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
//  (moved from tests/model-v5-fil-serveur.ts — same name, same assertions.)
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
