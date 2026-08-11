#!/usr/bin/env node
// =============================================================================
//  SUITE "WINDOW SWING" — NO BROWSER (the drawing is PURE)
// =============================================================================
// Usage request: "show a window's swing the way a door's is shown". With the detail that
// changes everything, given right after: "some of my windows have a footprint on the floor and
// others don't" — awning windows (vertical opening) and double windows (opening at the middle).
//
// THE TRAP AVOIDED, AND IT'S WHAT THE SUITE GUARDS: widening the `type === "door"` test to
// windows would have grown an arc on EVERY window already placed (34 on the household's plan),
// awning and fixed windows included. `leaf` ABSENT draws NOTHING, and that default is what makes
// the field deployable without changing the look of a single existing plan.
//
//   node tests/fenetre-battement.ts
//
//   sans_leaf_aucun_arc                   old windows do NOT change appearance
//   leaf_1_dessine_un_vantail             one arc, like a door
//   leaf_2_dessine_deux_vantaux           double window: two arcs of radius w/2
//   les_deux_vantaux_se_rejoignent        they start from the jambs and end AT THE MIDDLE
//   la_charniere_est_le_centre_de_l_arc   the four hinge x direction combinations
//   le_sens_deplace_la_boite              opening outward raises the viewBox
//   une_porte_n_est_pas_touchee           CHECK: `doorArcSVG` renders exactly the same thing
import type { DonneeDynamique } from "./_types.ts";
import { doorArcSVG, windowArcSVG } from "../src/ts/rendu/arc-porte.ts";

let ok = 0, ko = 0;
const rates: DonneeDynamique[] = [];
function test(nom: string, fn: (...args: DonneeDynamique[]) => DonneeDynamique | Promise<DonneeDynamique>) {
  const fails = [];
  try { fn((c: DonneeDynamique, m: DonneeDynamique) => { if (!c) fails.push(m); }); } catch (e) { fails.push("EXCEPTION: " + (e && e.stack || e)); }
  if (fails.length) { ko++; rates.push(nom); } else ok++;
  console.log(`  ${fails.length ? "FAIL " : "ok   "} ${nom}`);
  fails.forEach(f => console.log("        - " + f));
}
const arcs = (svg: DonneeDynamique) => (svg.match(/<path /g) || []).length;
const traits = (svg: DonneeDynamique) => (svg.match(/<line /g) || []).length;
/** The (rx, ry) pairs of each `A` in the path: the RADIUS of each arc. */
const rayons = (svg: DonneeDynamique) => [...svg.matchAll(/A (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)/g)].map(m => +m[1]);
/** The ARRIVAL point of each arc (the hinge, by construction). */
const fins = (svg: DonneeDynamique) => [...svg.matchAll(/A [\d.]+ [\d.]+ 0 0 [01] (-?[\d.]+) (-?[\d.]+)/g)].map(m => [+m[1], +m[2]]);
/** The DEPARTURE point of each arc (the free end of the leaf). */
const departs = (svg: DonneeDynamique) => [...svg.matchAll(/M (-?[\d.]+) (-?[\d.]+) A/g)].map(m => [+m[1], +m[2]]);

// ---------------------------------------------------------------------------------------------
test("sans_leaf_aucun_arc", (a: DonneeDynamique) => {
  a(windowArcSVG(120, 0, 1, 0) === "", "leaf = 0 ne doit RIEN dessiner");
  a(windowArcSVG(120, 0, 1, undefined) === "", "leaf absent ne doit RIEN dessiner");
  a(windowArcSVG(120, 1, -1, null) === "", "leaf null ne doit RIEN dessiner");
  a(windowArcSVG(120, 0, 1, 3) === "", "une valeur hors domaine ne dessine rien plutôt que n'importe quoi");
});

test("leaf_1_dessine_un_vantail", (a: DonneeDynamique) => {
  const s = windowArcSVG(120, 0, 1, 1);
  a(arcs(s) === 1, `un seul arc attendu, vu ${arcs(s)}`);
  a(traits(s) === 1, `un seul trait de vantail attendu, vu ${traits(s)}`);
  a(rayons(s)[0] === 120, `le rayon doit être la largeur (120), vu ${rayons(s)[0]}`);
});

test("leaf_2_dessine_deux_vantaux", (a: DonneeDynamique) => {
  const s = windowArcSVG(120, 0, 1, 2);
  a(arcs(s) === 2, `deux arcs attendus, vu ${arcs(s)}`);
  a(traits(s) === 2, `deux traits de vantail attendus, vu ${traits(s)}`);
  const r = rayons(s);
  a(r.length === 2 && r.every(v => v === 60),
    `chaque vantail doit avoir un rayon de w/2 = 60, vu ${JSON.stringify(r)}`);
});

test("les_deux_vantaux_se_rejoignent", (a: DonneeDynamique) => {
  const w = 140, s = windowArcSVG(w, 0, 1, 2);
  // The DEPARTURES (free ends) are both at the middle; the ARRIVALS (hinges) at the jambs.
  const d = departs(s).map(p => p[0]).sort((x, y) => x - y);
  const f = fins(s).map(p => p[0]).sort((x, y) => x - y);
  a(d.length === 2 && d.every(v => Math.abs(v - w / 2) < 0.01),
    `les deux vantaux doivent partir du MILIEU (${w / 2}), vu ${JSON.stringify(d)}`);
  a(f.length === 2 && Math.abs(f[0] - 0) < 0.01 && Math.abs(f[1] - w) < 0.01,
    `les charnières doivent être aux deux jambages (0 et ${w}), vu ${JSON.stringify(f)}`);
});

test("la_charniere_est_le_centre_de_l_arc", (a: DonneeDynamique) => {
  // For each combination, the arc must END on the hinge: that's what distinguishes a correct arc
  // from a mirrored one (the historical defect fixed in `doorArcSVG`).
  for (const hinge of [0, 1]) {
    for (const swing of [1, -1]) {
      const s = windowArcSVG(100, hinge, swing, 1);
      const f = fins(s)[0];
      const attendu = hinge ? 100 : 0;
      a(f && Math.abs(f[0] - attendu) < 0.01,
        `hinge=${hinge} swing=${swing} : l'arc doit finir sur la charnière x=${attendu}, vu ${f && f[0]}`);
      a(f && Math.abs(Math.abs(f[1]) - 100) < 0.01,
        `hinge=${hinge} swing=${swing} : et à une portée de 100, vu ${f && f[1]}`);
      a(f && Math.sign(f[1]) === Math.sign(swing),
        `hinge=${hinge} swing=${swing} : du bon côté, vu ${f && f[1]}`);
    }
  }
});

test("le_sens_deplace_la_boite", (a: DonneeDynamique) => {
  const dedans = windowArcSVG(90, 0, 1, 1);
  const dehors = windowArcSVG(90, 0, -1, 1);
  a(/viewBox="0 0 90 90"/.test(dedans), `vers l'intérieur : viewBox à 0, vu ${dedans.slice(0, 80)}`);
  a(/viewBox="0 -90 90 90"/.test(dehors), `vers l'extérieur : viewBox remontée, vu ${dehors.slice(0, 80)}`);
});

test("une_porte_n_est_pas_touchee", (a: DonneeDynamique) => {
  // CHECK. `doorArcSVG` is shared with door rendering and proven elsewhere: the refactor that
  // extracted `battant()` must not have changed ANYTHING about its output.
  const porte = doorArcSVG(80, 1, -1, "#123456");
  const fenetre = windowArcSVG(80, 1, -1, 1, "#123456");
  a(arcs(porte) === 1 && traits(porte) === 1, "une porte garde un arc et un vantail");
  a(rayons(porte)[0] === 80, `rayon de porte inchangé, vu ${rayons(porte)[0]}`);
  // A window with ONE leaf draws exactly the same swing as a door of the same width: that's
  // intentional, and it proves both go through the same calculation.
  a(JSON.stringify(fins(porte)) === JSON.stringify(fins(fenetre)),
    `même charnière, ${JSON.stringify(fins(porte))} vs ${JSON.stringify(fins(fenetre))}`);
});

// ---------------------------------------------------------------------------------------------
console.log(`\n${ko ? `FAILURES ${ko}/${ok + ko}` : `OK ${ok}/${ok}`}`);
rates.forEach(n => console.log("  FAIL " + n));
process.exit(ko ? 1 : 0);
