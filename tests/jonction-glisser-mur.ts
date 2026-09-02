#!/usr/bin/env node
// =============================================================================
//  "A JUNCTION MUST HOLD WHEN A WALL IS MOVED" SUITE: NO BROWSER (the geometry is PURE)
// =============================================================================
// Owner's report #1, and the reasoning that led here (AGENTS.md, "A JUNCTION MUST HOLD…"):
// three walls drawn separately, joined end to end into two rooms; dragging one of them tore the
// junction open and a room stopped existing. Drawn walls are `free` (2026-08-14 decision,
// `v5ThroughWall` no longer re-extends them), so nothing implicitly keeps a neighbor glued to a
// dragged wall anymore: `v5WallDragCtx`/`v5WallDragApply` (`src/ts/gestes/murs.ts`) decide the
// junctions EXPLICITLY, once, at the start of the gesture.
//
// PR #17 shipped a FRACTION carry: a follower's touching point rides the same fraction along the
// dragged wall's length. THE BUG THAT SHIPPED WITH IT, only caught by owner's report #2: the
// dragged wall only ever TRANSLATES while pushed sideways (never rotates), so a fraction carry
// always moves the touching point by the exact SAME VECTOR as the wall, which lands on a
// perpendicular follower's own axis for free, but on NO OTHER angle. A follower COLLINEAR with the
// dragged wall, PR #17's own target case, got the same treatment and bent into a visible
// diagonal: the very defect PR #17 claimed to fix. Report #2 is a straight wall continuing the
// dragged one to the facade, exactly that shape.
//
// THE CURRENT MECHANISM, `docs/decisions/0005-un-suiveur-ne-bascule-jamais.md`: two rules, in
// order. (1) A follower never tilts, it keeps its own direction, sliding along it to meet the
// dragged wall's new line (ordinary intersection) or not moving at all; no fraction, no other
// vector. (2) A follower moves ONLY if it would otherwise be left touching nothing: if it is still
// held by some OTHER wall or the facade (same 2 cm tolerance as junction detection) once the
// dragged wall has left, it stays exactly where it is. Rule 2 is checked first, from the geometry
// at `pointerdown` (`Suiveur.tenu`); rule 1 only runs for a follower that clears it.
//
// `voisins_qui_se_tiennent_ne_bougent_pas` is the REWRITE of what PR #17's own test used to assert
// (`voisin_colineaire_ne_se_detache_plus`, which claimed the collinear neighbor MUST reach the
// dragged wall's new corner, i.e. must become a diagonal). That claim was the bug; the test is
// gone, replaced by the truth report #2 established. `trois_murs_au_meme_point...` is the direct
// reproduction of report #2. `voisin_colineaire_dans_le_vide_se_detache` writes down, deliberately,
// the one case where rule 1 still costs something: nothing else holds it, its own line can't
// usefully intersect the dragged wall's, so it stays put and comes apart from it.
//
// TRAP THAT COST A FALSE GREEN WHILE WRITING THIS SUITE: `sanitizeV5Plan` (called by the `plan()`
// helper below) builds BRAND NEW wall objects, it does not keep the caller's references. A first
// draft of this file kept asserting on the ORIGINAL `{id:"wA",...}` literals passed into `plan()`,
// which never mutate: every assertion silently compared a constant against itself and passed
// whether or not the fix existed (`git stash` proved it: reverting the fix still gave "OK 7/7").
// Every assertion below therefore looks the wall up FROM `P.walls` by id, through `mur(P, id)`,
// AFTER the drag: that is the live object `v5WallDragApply` actually wrote to.
//
// SECOND TRAP, this round: `plan()`'s apartment is 400×300. A wall whose full length lies exactly
// ON a facade edge (both endpoints at y=0, y=300, x=0 or x=400) gets reclassified `isOutline` by
// `sanitizeV5Plan`, and an outline wall neither follows nor is followed. Every geometry below keeps
// its touching corners strictly INSIDE that box (y away from 0/300, x away from 0/400) unless the
// point is deliberately testing an outline wall.
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

/** Direction angle (degrees, -180..180) of every wall with a non-degenerate length, keyed by id.
 * Used by `aucun_mur_ne_bascule_jamais` (rule 1's invariant): a wall's OWN direction, not just its
 * touching point, must survive any drag it is not the target of. */
function anglesDe(walls: readonly Mur[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of walls) {
    const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1];
    if (Math.hypot(dx, dy) < 0.01) continue;
    m.set(String(w.id), Math.atan2(dy, dx) * 180 / Math.PI);
  }
  return m;
}
/** Smallest angular gap between two angles in degrees, wraparound-safe. */
function ecartAngle(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// The owner's exact shape: three hand-drawn walls, corner to corner, carving the 400x300
// apartment into two rooms (wB is the shared middle segment).
const troisMurs = (): Mur[] => [
  { id: "wA", a: [200, 0], b: [200, 150], t: 12, isOutline: false },
  { id: "wB", a: [200, 150], b: [300, 150], t: 12, isOutline: false },
  { id: "wC", a: [300, 150], b: [300, 300], t: 12, isOutline: false },
];

// ---------------------------------------------------------------------------------------------
test("deux_voisins_perpendiculaires_suivent_le_mur_glisse", (a: DonneeDynamique) => {
  // wA and wC touch nothing but wB: unheld (rule 2 clears them), so they follow, the control of
  // rule 1 (they slide along their OWN axis, i.e. lengthen, without tilting) and rule 2 (they are
  // in the void, so rule 1 gets to run at all) at once.
  const P = plan(troisMurs());
  v5RebuildCells(P);
  a(P.cells.length === 2, `précondition : deux pièces, vu ${P.cells.length}`);
  const ctx = ctxDe(P);
  const g = v5WallDragCtx(ctx, "wB")!;
  a(g.followers.length === 2, `wB doit avoir exactement deux voisins (wA et wC), vu ${g.followers.length}`);
  a(g.followers.every(f => !f.tenu), "précondition : ni wA ni wC ne doivent être tenus par autre chose que wB");
  v5WallDragApply(ctx, g, 40, true);
  const wA = mur(P, "wA"), wB = mur(P, "wB"), wC = mur(P, "wC");
  a(JSON.stringify(wB.a) === JSON.stringify([200, 190]), `wB doit avoir glissé, vu ${JSON.stringify(wB.a)}`);
  a(JSON.stringify(wA.b) === JSON.stringify(wB.a),
    `wA doit rester soudé au nouveau coin de wB, vu wA.b=${JSON.stringify(wA.b)} wB.a=${JSON.stringify(wB.a)}`);
  a(JSON.stringify(wC.a) === JSON.stringify(wB.b),
    `wC doit rester soudé à l'autre coin de wB, vu wC.a=${JSON.stringify(wC.a)} wB.b=${JSON.stringify(wB.b)}`);
  a(P.cells.length === 2, `la pièce ne doit pas avoir disparu, vu ${P.cells.length} cellule(s)`);
});

test("voisins_qui_se_tiennent_ne_bougent_pas", (a: DonneeDynamique) => {
  // THE REWRITE of PR #17's own test (was `voisin_colineaire_ne_se_detache_plus`), which is now
  // known to have asserted the BUG: it claimed wX (collinear with wB) had to reach wB's new
  // corner, i.e. had to become a diagonal, and called that "not detaching". That IS the shape of
  // the owner's second report. In this exact geometry wA, wX and wY all meet wB at the SAME point
  // (200,150) and touch EACH OTHER there too: once wB leaves, all three are still held by one
  // another (rule 2), so NONE of them moves, at any angle, not wA (perpendicular), not wX
  // (collinear), not wY (perpendicular the other way). Only wB moves.
  const wX: Mur = { id: "wX", a: [100, 150], b: [200, 150], t: 12, isOutline: false };
  const wY: Mur = { id: "wY", a: [200, 150], b: [200, 250], t: 12, isOutline: false };
  const P = plan([...troisMurs(), wX, wY]);
  const wAAvant = JSON.stringify([mur(P, "wA").a, mur(P, "wA").b]);
  const wXAvant = JSON.stringify([mur(P, "wX").a, mur(P, "wX").b]);
  const wYAvant = JSON.stringify([mur(P, "wY").a, mur(P, "wY").b]);
  const ctx = ctxDe(P);
  const g = v5WallDragCtx(ctx, "wB")!;
  a(g.followers.length === 4, `quatre murs touchent ce bout de wB (wA, wX, wY, wC), vu ${g.followers.length}`);
  a(g.followers.filter(f => f.x.id === "wA" || f.x.id === "wX" || f.x.id === "wY").every(f => f.tenu),
    "précondition : wA, wX et wY se tiennent mutuellement (tenus par un tiers, pas seulement par wB)");
  v5WallDragApply(ctx, g, 40, true);
  a(JSON.stringify(mur(P, "wB").a) === JSON.stringify([200, 190]), "précondition : wB a bien glissé");
  a(JSON.stringify([mur(P, "wA").a, mur(P, "wA").b]) === wAAvant, "wA (perpendiculaire, tenu par wX/wY) ne doit pas bouger");
  a(JSON.stringify([mur(P, "wX").a, mur(P, "wX").b]) === wXAvant, "wX (colinéaire, tenu par wA/wY) ne doit pas bouger, PAS devenir une diagonale");
  a(JSON.stringify([mur(P, "wY").a, mur(P, "wY").b]) === wYAvant, "wY (perpendiculaire, tenu par wA/wX) ne doit pas bouger");
});

test("voisin_perpendiculaire_change_de_longueur_pas_d_angle", (a: DonneeDynamique) => {
  // Owner's report #1: wA vertical, wB horizontal, touching AT wA's foot, and wB touches NOTHING
  // else (in the void). Pushing wA sideways must shorten/lengthen wB, never tilt it. GREEN before
  // and after the fix: a follower EXACTLY perpendicular to the dragged wall has its own axis
  // parallel to the wall's normal, and the dragged wall only ever TRANSLATES (never rotates) while
  // being pushed sideways, so the vector carried to the touching point was, by construction,
  // already along wB's own line even under the old fraction carry. Kept as a non-regression guard,
  // three separate assertions so a future break says which one broke.
  const wA: Mur = { id: "wA", a: [300, 50], b: [300, 250], t: 12, isOutline: false };
  const wB: Mur = { id: "wB", a: [100, 250], b: [300, 250], t: 12, isOutline: false };
  const P = plan([wA, wB]);
  const ctx = ctxDe(P);
  const g = v5WallDragCtx(ctx, "wA")!;
  a(g.followers.length === 1 && !g.followers[0]!.tenu,
    "précondition : wB est un suiveur, et il n'est tenu par rien d'autre, sinon ce cas mesure autre chose que son nom");
  v5WallDragApply(ctx, g, 50, true);
  const wBAfter = mur(P, "wB");
  a(wBAfter.a[1] === 250 && wBAfter.b[1] === 250,
    `wB doit rester HORIZONTAL (même y=250 aux deux bouts), vu ${JSON.stringify([wBAfter.a, wBAfter.b])}`);
  a(JSON.stringify(wBAfter.a) === JSON.stringify([100, 250]),
    `le bout FIXE de wB ne doit pas bouger, vu ${JSON.stringify(wBAfter.a)}`);
  a(wBAfter.b[0] === 250, `le bout soudé de wB doit suivre en x=250, vu ${wBAfter.b[0]}`);
});

test("voisin_oblique_garde_son_angle", (a: DonneeDynamique) => {
  // wC touches wA's foot at 45°, and touches NOTHING else (in the void). RED before ANY fix
  // (measured 63.43°, an 18° tilt for a 50 cm sideways push): the fraction carry moves the
  // touching point by the dragged wall's own translation vector, along neither wC's line nor
  // anything close to it once the angle is neither 0° nor 90°. GREEN after: wC's own line meets
  // wA's new line by intersection, so it keeps its 45° and only its length changes.
  const wA: Mur = { id: "wA", a: [300, 50], b: [300, 250], t: 12, isOutline: false };
  const wC: Mur = { id: "wC", a: [200, 150], b: [300, 250], t: 12, isOutline: false };
  const P = plan([wA, wC]);
  const ctx = ctxDe(P);
  const g = v5WallDragCtx(ctx, "wA")!;
  a(g.followers.length === 1 && !g.followers[0]!.tenu,
    "précondition : wC est un suiveur, et il n'est tenu par rien d'autre, sinon ce cas mesure autre chose que son nom");
  v5WallDragApply(ctx, g, 50, true);
  const wCAfter = mur(P, "wC");
  const angle = Math.atan2(wCAfter.b[1] - wCAfter.a[1], wCAfter.b[0] - wCAfter.a[0]) * 180 / Math.PI;
  a(Math.abs(angle - 45) <= 0.5, `wC doit rester à 45° à 0,5° près, vu ${angle.toFixed(2)}°`);
  a(JSON.stringify(wCAfter.a) === JSON.stringify([200, 150]), "le bout fixe de wC ne doit pas bouger");
});

test("voisin_colineaire_dans_le_vide_se_detache", (a: DonneeDynamique) => {
  // The cost rule 1 accepts, written down rather than discovered: wZ continues wA in a PERFECTLY
  // straight line, and its far end touches nothing (in the void, the negative of the previous
  // test's "held" case). Two near-parallel lines have no usable intersection, and nothing else
  // holds wZ, so it does not move AT ALL: it detaches from wA rather than stretch into a diagonal.
  const wA: Mur = { id: "wA", a: [300, 50], b: [300, 250], t: 12, isOutline: false };
  const wZ: Mur = { id: "wZ", a: [300, 250], b: [300, 290], t: 12, isOutline: false };
  const P = plan([wA, wZ]);
  const wZAvant = JSON.stringify([mur(P, "wZ").a, mur(P, "wZ").b]);
  const ctx = ctxDe(P);
  const g = v5WallDragCtx(ctx, "wA")!;
  a(g.followers.length === 1 && !g.followers[0]!.tenu,
    "précondition : wZ est un suiveur, et il n'est tenu par rien d'autre");
  v5WallDragApply(ctx, g, 50, true);
  const wAAfter = mur(P, "wA");
  a(JSON.stringify(wAAfter.a) === JSON.stringify([250, 50]), "précondition : wA a bien glissé");
  a(JSON.stringify([mur(P, "wZ").a, mur(P, "wZ").b]) === wZAvant,
    `wZ doit rester EXACTEMENT où il était (se détache plutôt que basculer), vu ${JSON.stringify([mur(P, "wZ").a, mur(P, "wZ").b])}`);
});

test("trois_murs_au_meme_point_rien_ne_bascule_rien_ne_bouge", (a: DonneeDynamique) => {
  // THE DIRECT REPRODUCTION of the owner's second report: wHaut (dragged, vertical), wHoriz
  // (touches wHaut's foot), and wBas (continues wHaut in a straight line downward to the facade).
  // All three meet at (300,150). RED against the ORIGINAL code (PR #17 only, no rules): measured
  // wHoriz torn down to (100,150)-(210,150) and wBas bent into the diagonal (210,150)-(300,300).
  // GREEN with both rules: wHoriz and wBas hold EACH OTHER at (300,150) (each is "tenu" by the
  // other, rule 2), so neither one is in the void, so neither one moves; wHaut simply comes to
  // rest on wHoriz's FLANK, further left. Nothing tears, nothing tilts.
  const wHaut: Mur = { id: "wHaut", a: [300, 50], b: [300, 150], t: 12, isOutline: false };
  const wHoriz: Mur = { id: "wHoriz", a: [100, 150], b: [300, 150], t: 12, isOutline: false };
  const wBas: Mur = { id: "wBas", a: [300, 150], b: [300, 300], t: 12, isOutline: false };
  const P = plan([wHaut, wHoriz, wBas]);
  const wHorizAvant = JSON.stringify([mur(P, "wHoriz").a, mur(P, "wHoriz").b]);
  const wBasAvant = JSON.stringify([mur(P, "wBas").a, mur(P, "wBas").b]);
  const anglesAvant = anglesDe(P.walls);
  const ctx = ctxDe(P);
  const g = v5WallDragCtx(ctx, "wHaut")!;
  a(g.followers.length === 2, `wHoriz et wBas doivent tous deux toucher wHaut, vu ${g.followers.length}`);
  a(g.followers.every(f => f.tenu), "précondition : wHoriz et wBas se tiennent mutuellement au même point");
  v5WallDragApply(ctx, g, 90, true);
  a(JSON.stringify(mur(P, "wHaut").a) === JSON.stringify([210, 50]), "précondition : wHaut a bien glissé de 90 cm vers la gauche");
  a(JSON.stringify([mur(P, "wHoriz").a, mur(P, "wHoriz").b]) === wHorizAvant,
    `le mur HORIZONTAL doit rester INCHANGÉ au bit près, vu ${JSON.stringify([mur(P, "wHoriz").a, mur(P, "wHoriz").b])}`);
  a(JSON.stringify([mur(P, "wBas").a, mur(P, "wBas").b]) === wBasAvant,
    `le mur vertical BAS doit rester INCHANGÉ au bit près (pas de diagonale), vu ${JSON.stringify([mur(P, "wBas").a, mur(P, "wBas").b])}`);
  const anglesApres = anglesDe(P.walls);
  for (const [id, angleAvant] of anglesAvant) {
    const angleApres = anglesApres.get(id)!;
    a(ecartAngle(angleAvant, angleApres) <= 0.5,
      `${id} ne doit garder que sa PROPRE direction, vu ${angleAvant.toFixed(2)}° → ${angleApres.toFixed(2)}°`);
  }
});

test("aucun_mur_ne_bascule_jamais", (a: DonneeDynamique) => {
  // RULE 1's invariant, swept across every drag this suite performs, not asserted as a one-off:
  // for every wall present before and after a drag, its OWN direction is unchanged (0,5° close),
  // whether it moved (lengthened/shortened along its own axis), stayed put (held, or detached), or
  // was the dragged wall itself (translated, never rotated).
  const scenarios: Array<{ nom: string; murs: Mur[]; id: string; d: number }> = [
    { nom: "trois murs + T colinéaire (PR #17)", id: "wB", d: 40, murs: [
      ...troisMurs(),
      { id: "wX", a: [100, 150], b: [200, 150], t: 12, isOutline: false },
      { id: "wY", a: [200, 150], b: [200, 250], t: 12, isOutline: false },
    ] },
    { nom: "chaîne à cinq murs", id: "wA", d: 30, murs: [
      { id: "wA", a: [100, 0], b: [100, 100], t: 12, isOutline: false },
      { id: "wB", a: [100, 100], b: [200, 100], t: 12, isOutline: false },
      { id: "wC", a: [200, 100], b: [200, 200], t: 12, isOutline: false },
      { id: "wD", a: [200, 200], b: [300, 200], t: 12, isOutline: false },
      { id: "wE", a: [300, 200], b: [300, 300], t: 12, isOutline: false },
    ] },
    { nom: "voisin perpendiculaire seul (rapport n°1)", id: "wA", d: 50, murs: [
      { id: "wA", a: [300, 50], b: [300, 250], t: 12, isOutline: false },
      { id: "wB", a: [100, 250], b: [300, 250], t: 12, isOutline: false },
    ] },
    { nom: "voisin oblique 45°", id: "wA", d: 50, murs: [
      { id: "wA", a: [300, 50], b: [300, 250], t: 12, isOutline: false },
      { id: "wC", a: [200, 150], b: [300, 250], t: 12, isOutline: false },
    ] },
    { nom: "trois murs au même point (rapport n°2)", id: "wHaut", d: 90, murs: [
      { id: "wHaut", a: [300, 50], b: [300, 150], t: 12, isOutline: false },
      { id: "wHoriz", a: [100, 150], b: [300, 150], t: 12, isOutline: false },
      { id: "wBas", a: [300, 150], b: [300, 300], t: 12, isOutline: false },
    ] },
  ];
  for (const sc of scenarios) {
    const P = plan(sc.murs);
    const avant = anglesDe(P.walls);
    const ctx = ctxDe(P);
    const g = v5WallDragCtx(ctx, sc.id)!;
    v5WallDragApply(ctx, g, sc.d, true);
    const apres = anglesDe(P.walls);
    for (const [id, angleAvant] of avant) {
      const angleApres = apres.get(id);
      if (angleApres == null) continue; // devenu dégénéré (longueur ~0) : hors du champ de cet invariant
      a(ecartAngle(angleAvant, angleApres) <= 0.5,
        `[${sc.nom}] ${id} ne doit pas basculer, vu ${angleAvant.toFixed(2)}° → ${angleApres.toFixed(2)}°`);
    }
  }
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
    { id: "wA", a: [100, 0], b: [100, 100], t: 12, isOutline: false },
    { id: "wB", a: [100, 100], b: [200, 100], t: 12, isOutline: false },
    { id: "wC", a: [200, 100], b: [200, 200], t: 12, isOutline: false },
    { id: "wD", a: [200, 200], b: [300, 200], t: 12, isOutline: false },
    { id: "wE", a: [300, 200], b: [300, 300], t: 12, isOutline: false },
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
  // CONTRAT INVERSÉ LE 19/08/2026, ET C'EST VOULU. Ce cas exigeait l'inverse: « les cellules ne
  // doivent pas bouger pendant les frames intermédiaires ». Cette économie était le défaut
  // signalé par le propriétaire, mot pour mot: « when i move a facade the ground underneath lags
  // behind significantly ». Le sol est peint À PARTIR des cellules, donc ne les reconstruire qu'au
  // relâchement laissait le fond immobile pendant tout le geste, puis sauter. Mesuré sur le plan
  // réel: la surface peinte restait à la même place aux vingt paliers d'un glissement, puis
  // bondissait de 439 px. Et la reconstruction coûte 0,4 ms en médiane, 1,6 ms au pire, contre
  // 2,3 ms pour un rendu complet: l'économie ne payait rien.
  // Le cas énonce donc la règle en vigueur, sans rien perdre de ce qu'il protégeait: la
  // reconstruction finale reste juste, et le nombre de pièces est le même à la fin.
  v5WallDragApply(ctx, g, 10, false);
  const cellsMiGeste = JSON.stringify(P.cells);
  v5WallDragApply(ctx, g, 25, false);
  v5WallDragApply(ctx, g, 40, false);
  a(JSON.stringify(mur(P, "wB").a) !== JSON.stringify([200, 150]), "précondition : le mur a bougé pendant les frames intermédiaires");
  a(cellsMiGeste !== cellsAvant, "les cellules doivent suivre dès la première frame intermédiaire, pas attendre le relâchement");
  a(JSON.stringify(P.cells) !== cellsMiGeste, "et continuer de suivre aux frames suivantes");
  v5WallDragApply(ctx, g, 40, true);
  a(JSON.stringify(P.cells) !== cellsAvant, "la reconstruction finale doit refléter la nouvelle géométrie");
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
