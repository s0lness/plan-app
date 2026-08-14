#!/usr/bin/env node
// =============================================================================
//  "A JUNCTION MUST HOLD WHEN A WALL IS MOVED" SUITE — NO BROWSER (the geometry is PURE)
// =============================================================================
// Owner's report, and the reasoning that led here (AGENTS.md, "A JUNCTION MUST HOLD…"):
// three walls drawn separately, joined end to end into two rooms; dragging one of them tore the
// junction open and a room stopped existing. Drawn walls are `free` (2026-08-14 decision,
// `v5ThroughWall` no longer re-extends them), so nothing implicitly keeps a neighbor glued to a
// dragged wall anymore: `v5WallDragCtx`/`v5WallDragApply` (`src/ts/gestes/murs.ts`) decide the
// junctions EXPLICITLY, once, at the start of the gesture.
//
// THE BUG THIS SUITE CAUGHT, red before the fix: the ORIGINAL mechanism intersected a follower's
// OWN line (fixed direction) with the dragged wall's NEW line. That degenerates the moment a
// follower is PARALLEL to the dragged wall — collinear segments, exactly what "draw a partition
// as two strokes" produces. Two parallel lines have no intersection, so the follower's near end
// silently stayed at its OLD position while its perpendicular neighbors moved correctly: a real
// gap, a real torn room, on exactly the kind of geometry the owner described.
// `voisin_colineaire_ne_se_detache_plus` is the direct reproduction; the others cover the
// design questions AGENTS.md asked to be settled explicitly (outline walls, chains, the round
// trip, one cell rebuild, the wire).
//
// TRAP THAT COST A FALSE GREEN WHILE WRITING THIS SUITE: `sanitizeV5Plan` (called by the `plan()`
// helper below) builds BRAND NEW wall objects — it does not keep the caller's references. A first
// draft of this file kept asserting on the ORIGINAL `{id:"wA",...}` literals passed into `plan()`,
// which never mutate: every assertion silently compared a constant against itself and passed
// whether or not the fix existed (`git stash` proved it: reverting the fix still gave "OK 7/7").
// Every assertion below therefore looks the wall up FROM `P.walls` by id, through `mur(P, id)`,
// AFTER the drag: that is the live object `v5WallDragApply` actually wrote to.
//
//   node tests/jonction-glisser-mur.ts
import type { DonneeDynamique } from "./_types.ts";
import { applyOp as applyOpReel, planFp, sanitizeState } from "../live-worker/ops.ts";
import type { Operation, PlanState } from "../live-worker/ops.ts";
import { v5WallDragApply, v5WallDragCtx } from "../src/ts/gestes/murs.ts";
import { v5RebuildCells } from "../src/ts/modele/cellules.ts";
import { sanitizeV5Plan } from "../src/ts/modele/migrations.ts";
import { v5StateWire, wireIdentite } from "../src/ts/fil/pseudo-fil.ts";
import { ws5DiffOps, wsShadowCopy, wsShadowFromServerInto } from "../src/ts/fil/miroir.ts";
import type { Contexte } from "../src/ts/app/contexte.ts";
import type { Id, Miroir, Mur, PlanFil, PlanV5 } from "../src/ts/partage/plan.ts";

// Like the server bench (tests/rapide.ts): `ws5DiffOps` returns the wire's own `Op` union,
// which is a structural superset of the server's `Operation` for everything this suite emits
// (`wall.set`/`cells.replace`); the wrapper matches the existing pattern rather than inventing one.
const applyOp = (state: PlanState, op: unknown) => applyOpReel(state, op as Operation);

let ok = 0, ko = 0;
const rates: DonneeDynamique[] = [];
function test(nom: string, fn: (...args: DonneeDynamique[]) => DonneeDynamique | Promise<DonneeDynamique>) {
  const fails: string[] = [];
  try { fn((c: DonneeDynamique, m: DonneeDynamique) => { if (!c) fails.push(m); }); } catch (e) { fails.push("EXCEPTION: " + (e && (e as Error).stack || e)); }
  if (fails.length) { ko++; rates.push(nom); } else ok++;
  console.log(`  ${fails.length ? "FAIL " : "ok   "} ${nom}`);
  fails.forEach(f => console.log("        - " + f));
}

/** A 400x300 apartment; `murs` are the interior walls under test, all hand-drawn (`free:1`). */
function plan(murs: Mur[]): PlanV5 {
  return sanitizeV5Plan({
    outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
    walls: murs,
    openings: [], pieces: [], cells: [],
  })!;
}
/** The LIVE wall object inside `P.walls`: the one a drag actually mutates. Never trust a wall
 * literal handed to `plan()` after this point, see the header. */
function mur(P: PlanV5, id: Id): Mur {
  const w = P.walls.find((x) => String(x.id) === String(id));
  if (!w) throw new Error(`mur ${id} introuvable`);
  return w;
}
/** A fake `Contexte`: `v5WallDragCtx`/`v5WallDragApply` only ever touch `etat.plan` and `canvas`. */
function ctxDe(P: PlanV5): Contexte {
  return { etat: { plan: P }, canvas: { querySelector: (): null => null }, rev: 0 } as unknown as Contexte;
}
const miroirDe = (fil: PlanFil): Miroir => { const m = {} as Miroir; wsShadowFromServerInto(m, fil, wireIdentite); return m; };
const copieDe = (m: Miroir): Miroir => { const d = {} as Miroir; wsShadowCopy(m, d); return d; };

// The owner's exact shape: three hand-drawn walls, corner to corner, carving the 400x300
// apartment into two rooms (wB is the shared middle segment).
const troisMurs = (): Mur[] => [
  { id: "wA", a: [200, 0], b: [200, 150], t: 12, isOutline: false, free: 1 },
  { id: "wB", a: [200, 150], b: [300, 150], t: 12, isOutline: false, free: 1 },
  { id: "wC", a: [300, 150], b: [300, 300], t: 12, isOutline: false, free: 1 },
];

// ---------------------------------------------------------------------------------------------
test("deux_voisins_perpendiculaires_suivent_le_mur_glisse", (a: DonneeDynamique) => {
  const P = plan(troisMurs());
  v5RebuildCells(P);
  a(P.cells.length === 2, `précondition : deux pièces, vu ${P.cells.length}`);
  const ctx = ctxDe(P);
  const g = v5WallDragCtx(ctx, "wB")!;
  a(g.followers.length === 2, `wB doit avoir exactement deux voisins (wA et wC), vu ${g.followers.length}`);
  v5WallDragApply(ctx, g, 40, true);
  const wA = mur(P, "wA"), wB = mur(P, "wB"), wC = mur(P, "wC");
  a(JSON.stringify(wB.a) === JSON.stringify([200, 190]), `wB doit avoir glissé, vu ${JSON.stringify(wB.a)}`);
  a(JSON.stringify(wA.b) === JSON.stringify(wB.a),
    `wA doit rester soudé au nouveau coin de wB, vu wA.b=${JSON.stringify(wA.b)} wB.a=${JSON.stringify(wB.a)}`);
  a(JSON.stringify(wC.a) === JSON.stringify(wB.b),
    `wC doit rester soudé à l'autre coin de wB, vu wC.a=${JSON.stringify(wC.a)} wB.b=${JSON.stringify(wB.b)}`);
  a(P.cells.length === 2, `la pièce ne doit pas avoir disparu, vu ${P.cells.length} cellule(s)`);
});

test("voisin_colineaire_ne_se_detache_plus", (a: DonneeDynamique) => {
  // wX continues wB in a STRAIGHT line (same direction): the old line-intersection follower
  // formula degenerates on parallel lines and left it behind. wA and wY (perpendicular) are the
  // negative control: they must keep following exactly as before.
  const wX: Mur = { id: "wX", a: [100, 150], b: [200, 150], t: 12, isOutline: false, free: 1 };
  const wY: Mur = { id: "wY", a: [200, 150], b: [200, 250], t: 12, isOutline: false, free: 1 };
  const P = plan([...troisMurs(), wX, wY]);
  const ctx = ctxDe(P);
  const g = v5WallDragCtx(ctx, "wB")!;
  a(g.followers.length === 4, `quatre murs touchent ce bout de wB (wA, wX, wY, wC), vu ${g.followers.length}`);
  v5WallDragApply(ctx, g, 40, true);
  const wA = mur(P, "wA"), wBAfter = mur(P, "wB"), wXAfter = mur(P, "wX"), wYAfter = mur(P, "wY");
  a(JSON.stringify(wBAfter.a) === JSON.stringify([200, 190]), `précondition : wB a bien glissé, vu ${JSON.stringify(wBAfter.a)}`);
  a(JSON.stringify(wXAfter.b) === JSON.stringify(wBAfter.a),
    `le voisin COLINÉAIRE doit suivre exactement comme les autres, vu wX.b=${JSON.stringify(wXAfter.b)} wB.a=${JSON.stringify(wBAfter.a)}`);
  a(JSON.stringify(wA.b) === JSON.stringify(wBAfter.a), "le voisin perpendiculaire (contrôle négatif) doit toujours suivre aussi");
  a(JSON.stringify(wYAfter.a) === JSON.stringify(wBAfter.a), "le second voisin perpendiculaire doit toujours suivre aussi");
});

test("mur_de_contour_n_est_jamais_deplace_par_un_glissement", (a: DonneeDynamique) => {
  // wA's free end sits exactly on the top facade: dragging wB (which does not touch the facade)
  // must never write to an outline wall, and the facade's own points must not move.
  const P = plan(troisMurs());
  const outlineAvant = JSON.stringify(P.outline);
  const contourAvant = P.walls.filter(w => w.isOutline).map(w => JSON.stringify([w.a, w.b]));
  const ctx = ctxDe(P);
  const g = v5WallDragCtx(ctx, "wB")!;
  a(g.followers.every(f => !f.x.isOutline), "aucun mur de contour ne doit apparaître comme suiveur");
  v5WallDragApply(ctx, g, 40, true);
  a(JSON.stringify(mur(P, "wB").a) === JSON.stringify([200, 190]), "précondition : le glissement a bien eu lieu");
  a(JSON.stringify(P.outline) === outlineAvant, "le contour lui-même ne doit pas bouger");
  const contourApres = P.walls.filter(w => w.isOutline).map(w => JSON.stringify([w.a, w.b]));
  a(JSON.stringify(contourApres) === JSON.stringify(contourAvant), "les murs de contour ne doivent pas bouger");
});

test("chaine_ne_propage_qu_un_saut", (a: DonneeDynamique) => {
  // A-B-C-D-E: dragging A (which only touches B) must carry B, never reach C, D or E.
  const murs: Mur[] = [
    { id: "wA", a: [100, 0], b: [100, 100], t: 12, isOutline: false, free: 1 },
    { id: "wB", a: [100, 100], b: [200, 100], t: 12, isOutline: false, free: 1 },
    { id: "wC", a: [200, 100], b: [200, 200], t: 12, isOutline: false, free: 1 },
    { id: "wD", a: [200, 200], b: [300, 200], t: 12, isOutline: false, free: 1 },
    { id: "wE", a: [300, 200], b: [300, 300], t: 12, isOutline: false, free: 1 },
  ];
  const P = plan(murs);
  const cAvant = JSON.stringify([mur(P, "wC").a, mur(P, "wC").b]);
  const dAvant = JSON.stringify([mur(P, "wD").a, mur(P, "wD").b]);
  const eAvant = JSON.stringify([mur(P, "wE").a, mur(P, "wE").b]);
  const bAvant = JSON.stringify([mur(P, "wB").a, mur(P, "wB").b]);
  const ctx = ctxDe(P);
  const g = v5WallDragCtx(ctx, "wA")!;
  a(g.followers.length === 1 && g.followers[0]!.x.id === "wB", `wA ne doit avoir que wB comme voisin, vu ${JSON.stringify(g.followers.map(f => f.x.id))}`);
  v5WallDragApply(ctx, g, 30, true);
  const wA = mur(P, "wA"), wB = mur(P, "wB");
  a(JSON.stringify(wA.b) !== JSON.stringify([100, 100]), `précondition : wA a bien glissé, vu ${JSON.stringify(wA.b)}`);
  a(JSON.stringify(wB.a) === JSON.stringify(wA.b), "wB doit suivre wA (contact direct)");
  a(JSON.stringify([wB.a, wB.b]) !== bAvant, "wB doit s'étirer, pas rester immobile");
  a(JSON.stringify([mur(P, "wC").a, mur(P, "wC").b]) === cAvant, "wC (deux sauts) ne doit PAS bouger");
  a(JSON.stringify([mur(P, "wD").a, mur(P, "wD").b]) === dAvant, "wD (trois sauts) ne doit PAS bouger");
  a(JSON.stringify([mur(P, "wE").a, mur(P, "wE").b]) === eAvant, "wE (quatre sauts) ne doit PAS bouger");
});

test("aller_retour_restaure_exactement", (a: DonneeDynamique) => {
  // G-5: dragging away then back to d=0 must restore every carried endpoint EXACTLY, through
  // an odd sequence of intermediate frames (the shape of a real mouse drag).
  const P = plan(troisMurs());
  const avant = JSON.stringify(P.walls);
  const ctx = ctxDe(P);
  const g = v5WallDragCtx(ctx, "wB")!;
  let sawMoved = false;
  for (const d of [0, 17, 33.333, -12.7, 41, -5.5, 0]) {
    v5WallDragApply(ctx, g, d, false);
    if (JSON.stringify(P.walls) !== avant) sawMoved = true;
  }
  a(sawMoved, "précondition : le mur a réellement bougé pendant le geste (sinon rien n'est testé)");
  v5WallDragApply(ctx, g, 0, true);
  a(JSON.stringify(P.walls) === avant, `retour exact attendu, vu\n  avant=${avant}\n  après=${JSON.stringify(P.walls)}`);
});

test("une_seule_reconstruction_de_cellules_a_la_fin", (a: DonneeDynamique) => {
  const P = plan(troisMurs());
  v5RebuildCells(P);
  const cellsAvant = JSON.stringify(P.cells);
  const ctx = ctxDe(P);
  const g = v5WallDragCtx(ctx, "wB")!;
  // Several intermediate (non-final) frames: the stale cell polygons must not be touched.
  v5WallDragApply(ctx, g, 10, false);
  v5WallDragApply(ctx, g, 25, false);
  v5WallDragApply(ctx, g, 40, false);
  a(JSON.stringify(mur(P, "wB").a) !== JSON.stringify([200, 150]), "précondition : le mur a bougé pendant les frames intermédiaires");
  a(JSON.stringify(P.cells) === cellsAvant, "les cellules ne doivent pas bouger pendant les frames intermédiaires (final=false)");
  v5WallDragApply(ctx, g, 40, true);
  a(JSON.stringify(P.cells) !== cellsAvant, "la reconstruction finale doit, elle, refléter la nouvelle géométrie");
  a(P.cells.length === 2, `toujours deux pièces après reconstruction, vu ${P.cells.length}`);
});

test("le_diff_reseau_porte_tous_les_murs_deplaces_par_la_jonction", (a: DonneeDynamique) => {
  // The wire test AGENTS.md asked for: the emitted diff must carry EVERY wall that actually
  // moved (the dragged wall AND its followers), and a peer applying those ops must converge to
  // the exact same geometry, not merely "the wall I grabbed".
  const P = plan(troisMurs());
  // The SERVER never knows `isOutline` (client-only concept, WALL_KEYS rejects it): a "peer" is
  // built from the same interior walls the wire actually carries.
  const versServeur = (murs: readonly Mur[]) =>
    murs.filter(w => !w.isOutline).map(({ isOutline: _io, ...rest }) => rest);
  const avantMiroir = copieDe(miroirDe(v5StateWire(P, true)));
  // The peer starts from the SAME pre-drag geometry.
  const peer: PlanState = sanitizeState(JSON.parse(JSON.stringify({
    outline: P.outline, walls: versServeur(P.walls), openings: [], pieces: [], cells: [], setupDone: true,
  })));

  const ctx = ctxDe(P);
  const g = v5WallDragCtx(ctx, "wB")!;
  v5WallDragApply(ctx, g, 40, true);
  a(JSON.stringify(mur(P, "wB").a) === JSON.stringify([200, 190]), "précondition : le glissement a bien eu lieu");

  const ops = ws5DiffOps(v5StateWire(P, true), avantMiroir);
  const idsBouges = new Set(ops.filter(o => o.kind === "wall.set").map(o => (o as { wall: { id: string } }).wall.id));
  a(idsBouges.has("wA") && idsBouges.has("wB") && idsBouges.has("wC"),
    `le diff doit porter les TROIS murs (le glissé + ses deux voisins), vu ${JSON.stringify([...idsBouges])}`);
  for (const op of ops) applyOp(peer, op);
  a(planFp(peer) === planFp(sanitizeState(JSON.parse(JSON.stringify({
    outline: P.outline, walls: versServeur(P.walls), openings: P.openings, pieces: P.pieces,
    cells: P.cells, setupDone: true,
  })))), "le pair doit converger vers EXACTEMENT la même géométrie, jonctions comprises");
});

// ---------------------------------------------------------------------------------------------
console.log(`\n${ko ? `FAILURES ${ko}/${ok + ko}` : `OK ${ok}/${ok}`}`);
rates.forEach(n => console.log("  FAIL " + n));
process.exit(ko ? 1 : 0);
