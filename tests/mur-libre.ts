#!/usr/bin/env node
// =============================================================================
//  "FREE PARTITION" SUITE — NO BROWSER (the geometry is PURE)
// =============================================================================
// Usage request: "walls always latch onto something, I want to be able to make ones that
// stick out, like a divider".
//
// THE MECHANISM, AND WHY IT HAPPENED "SOMETIMES". A v5 wall is THROUGH-GOING: each end is
// pushed to the first geometry it meets beyond it. When there is nothing beyond, the code
// did not stop there regardless, it fell back to CROPPING by the outline, which is only
// meant to be a ceiling. Result: for lack of a guard, the partition stretched all the way to
// the facade. Hence "it always latches on", and hence the "sometimes": when a barrier sat in
// the path, the extension stopped earlier and the wall looked like it stuck out.
//
// `free` reverses the rule for THIS wall: no more extension, cropping alone. Absent =
// through-going, so no existing plan moves.
//
//   node tests/mur-libre.ts
//
//   sans_free_le_mur_s_allonge_jusqu_au_contour   the historical behavior, unchanged
//   free_garde_les_deux_bouts                     a divider stays where it was placed
//   free_est_encore_rogne_par_le_contour          free does not mean "leaves the home"
//   free_ne_touche_pas_les_autres_murs            only one wall changes, not the plan
//   rebasculer_en_traversant_rallonge             the setting shows immediately, both ways
import type { DonneeDynamique } from "./_types.ts";
import { v5ThroughWall } from "../src/ts/modele/edition.ts";
import { RATIO_PRECIS, pointSuivi } from "../src/ts/gestes/etat-pointeur.ts";
import type { Mur, PlanV5 } from "../src/ts/partage/plan.ts";

let ok = 0, ko = 0;
const rates: DonneeDynamique[] = [];
function test(nom: string, fn: (...args: DonneeDynamique[]) => DonneeDynamique | Promise<DonneeDynamique>) {
  const fails = [];
  try { fn((c: DonneeDynamique, m: DonneeDynamique) => { if (!c) fails.push(m); }); } catch (e) { fails.push("EXCEPTION: " + (e && e.stack || e)); }
  if (fails.length) { ko++; rates.push(nom); } else ok++;
  console.log(`  ${fails.length ? "FAIL " : "ok   "} ${nom}`);
  fails.forEach(f => console.log("        - " + f));
}

/** A 400x300 rectangular home, closed outline, and the four facades as walls. */
const plan = (murs: Mur[]): PlanV5 => ({
  outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
  walls: [
    { id: "o1", a: [0, 0], b: [400, 0], t: 12, isOutline: true },
    { id: "o2", a: [400, 0], b: [400, 300], t: 12, isOutline: true },
    { id: "o3", a: [400, 300], b: [0, 300], t: 12, isOutline: true },
    { id: "o4", a: [0, 300], b: [0, 0], t: 12, isOutline: true },
    ...murs,
  ],
  openings: [], pieces: [], cells: [],
});
const L = (w: Mur) => Math.round(Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]));

// ---------------------------------------------------------------------------------------------
test("sans_free_le_mur_s_allonge_jusqu_au_contour", (a: DonneeDynamique) => {
  // A 60 cm stub in the middle of the living room, with nothing around it: it must stretch from one wall to the other.
  const w: Mur = { id: "w1", a: [200, 120], b: [200, 180], t: 12, isOutline: false };
  const P = plan([w]);
  v5ThroughWall(P, w);
  a(L(w) >= 290, `traversant, il doit rejoindre les deux façades (~300), vu ${L(w)}`);
  a(Math.round(w.a[1]) <= 6 && Math.round(w.b[1]) >= 294,
    `et toucher le haut ET le bas, vu a=${JSON.stringify(w.a)} b=${JSON.stringify(w.b)}`);
});

test("free_garde_les_deux_bouts", (a: DonneeDynamique) => {
  const w: Mur = { id: "w1", a: [200, 120], b: [200, 180], t: 12, isOutline: false, free: 1 };
  const P = plan([w]);
  v5ThroughWall(P, w);
  a(L(w) === 60, `une cloison libre garde sa longueur (60), vu ${L(w)}`);
  a(JSON.stringify(w.a) === JSON.stringify([200, 120]) && JSON.stringify(w.b) === JSON.stringify([200, 180]),
    `et ses deux bouts exacts, vu a=${JSON.stringify(w.a)} b=${JSON.stringify(w.b)}`);
});

test("free_est_encore_rogne_par_le_contour", (a: DonneeDynamique) => {
  // Free does NOT mean "is allowed to leave the home": the end that sticks out comes back.
  const w: Mur = { id: "w1", a: [200, 150], b: [200, 460], t: 12, isOutline: false, free: 1 };
  const P = plan([w]);
  v5ThroughWall(P, w);
  a(w.b[1] <= 301, `le bout qui sortait doit être ramené au contour (<=300), vu ${w.b[1]}`);
  a(Math.round(w.a[1]) === 150, `et le bout qui était DEDANS ne doit pas bouger, vu ${w.a[1]}`);
});

test("free_ne_touche_pas_les_autres_murs", (a: DonneeDynamique) => {
  const libre: Mur = { id: "w1", a: [100, 120], b: [100, 180], t: 12, isOutline: false, free: 1 };
  const trav: Mur = { id: "w2", a: [300, 120], b: [300, 180], t: 12, isOutline: false };
  const P = plan([libre, trav]);
  v5ThroughWall(P, libre);
  v5ThroughWall(P, trav);
  a(L(libre) === 60, `la libre reste courte, vu ${L(libre)}`);
  a(L(trav) >= 290, `la traversante s'allonge quand même, vu ${L(trav)}`);
});

test("rebasculer_en_traversant_rallonge", (a: DonneeDynamique) => {
  // The setting must be VISIBLE right away in both directions, otherwise you'd have to guess
  // that it will act "later".
  const w: Mur = { id: "w1", a: [200, 120], b: [200, 180], t: 12, isOutline: false, free: 1 };
  const P = plan([w]);
  v5ThroughWall(P, w);
  a(L(w) === 60, "libre d'abord");
  delete w.free;
  v5ThroughWall(P, w);
  a(L(w) >= 290, `repassée traversante, elle doit s'allonger immédiatement, vu ${L(w)}`);
});

test("maj_ralentit_le_point_suivi", (a: DonneeDynamique) => {
  // Without SHIFT: the tracked point IS the pointer. With it: it moves five times slower, anchored to the
  // gesture's starting point. It's this ratio that makes the centimeter reachable at working
  // scale, without changing the plan's unit.
  const sans = pointSuivi({ shiftKey: false }, 300, 200, 100, 100);
  a(sans.x === 300 && sans.y === 200, "sans MAJ, le point est inchange, vu " + JSON.stringify(sans));
  const avec = pointSuivi({ shiftKey: true }, 300, 200, 100, 100);
  a(avec.x === 100 + 200 * RATIO_PRECIS && avec.y === 100 + 100 * RATIO_PRECIS,
    "avec MAJ, l'ecart est reduit d'un facteur " + RATIO_PRECIS + ", vu " + JSON.stringify(avec));
  const nul = pointSuivi({ shiftKey: true }, 100, 100, 100, 100);
  a(nul.x === 100 && nul.y === 100, "au point de depart, MAJ ne decale rien, vu " + JSON.stringify(nul));
});

// ---------------------------------------------------------------------------------------------
console.log(`\n${ko ? `FAILURES ${ko}/${ok + ko}` : `OK ${ok}/${ok}`}`);
rates.forEach(n => console.log("  FAIL " + n));
process.exit(ko ? 1 : 0);
