#!/usr/bin/env node
// =============================================================================
//  "NO GRID" SUITE: NO BROWSER (the modifier and the grid math are PURE)
// =============================================================================
// Usage request: dragging always lands on the 5 cm grid (`ctx.etat.opts.snap`); there was no
// per-gesture escape to the whole centimeter. Shift already exists but does something DIFFERENT
// (`RATIO_PRECIS`, it slows the pointer, the grid still rounds the result), and Alt is taken
// (duplicate on furniture, free partition on walls).
//
// Ctrl (or Cmd) held during a drag now suppresses the grid instead: `sansGrille` is the ONE named
// helper for the modifier test (`src/ts/gestes/etat-pointeur.ts`, next to `estPrecis`), used by
// every gesture that applies the grid (furniture solo/group drag, wall drag, outline edge drag,
// opening resize, furniture resize) instead of a scattered `ev.ctrlKey || ev.metaKey`.
//
// `pasGrille` is the REAL production function furniture dragging calls (`gestes/meuble.ts`, both
// the solo and the group branch): it used to be two inline copies of the same formula, now ONE
// function, which is also what makes it testable here without a browser.
//
//   node tests/sans-grille.ts
//
//   sans_grille_lit_ctrl_et_cmd            the modifier test itself, both keys, neither alone
//   sans_grille_ignore_maj_et_alt          Shift and Alt are SOMEONE ELSE's modifier, not this one
//   pas_grille_arrondit_a_5_par_defaut     grid on, no modifier: 5 cm steps, counted from the start
//   pas_grille_arrondit_au_cm_avec_ctrl    grid on, Ctrl held: whole centimeters, no snapping
//   pas_grille_grille_coupee_ignore_snap   `snap` option OFF: whole centimeters regardless of Ctrl
//   aller_retour_revient_exactement_grille a start off the 5 cm grid still returns EXACTLY, snapped
//   aller_retour_revient_exactement_libre  same round trip, Ctrl held throughout: still exact
import type { DonneeDynamique } from "./_types.ts";
import { sansGrille, pasGrille } from "../src/ts/gestes/etat-pointeur.ts";

let ok = 0, ko = 0;
const rates: DonneeDynamique[] = [];
function test(nom: string, fn: (...args: DonneeDynamique[]) => DonneeDynamique | Promise<DonneeDynamique>) {
  const fails: string[] = [];
  try { fn((c: DonneeDynamique, m: DonneeDynamique) => { if (!c) fails.push(m); }); } catch (e) { fails.push("EXCEPTION: " + (e && (e as Error).stack || e)); }
  if (fails.length) { ko++; rates.push(nom); } else ok++;
  console.log(`  ${fails.length ? "FAIL " : "ok   "} ${nom}`);
  fails.forEach((f) => console.log("        - " + f));
}

// ---------------------------------------------------------------------------------------------
test("sans_grille_lit_ctrl_et_cmd", (a: DonneeDynamique) => {
  a(sansGrille({ ctrlKey: true }) === true, "Ctrl seul doit suffire");
  a(sansGrille({ metaKey: true }) === true, "Cmd seul doit suffire (Mac)");
  a(sansGrille({ ctrlKey: true, metaKey: true }) === true, "les deux ensemble restent vrai");
  a(sansGrille({}) === false, "ni l'un ni l'autre : faux");
  a(sansGrille({ ctrlKey: false, metaKey: false }) === false, "explicitement faux des deux cotes : faux");
});

test("sans_grille_ignore_maj_et_alt", (a: DonneeDynamique) => {
  // MAJ (precise mode) et Alt (copie / cloison libre) sont DEJA pris par d'autres gestes : ce
  // n'est pas parce qu'ils sont tenus que la grille doit sauter.
  a(sansGrille({ shiftKey: true } as DonneeDynamique) === false, "Maj seule ne doit pas couper la grille");
  a(sansGrille({ altKey: true } as DonneeDynamique) === false, "Alt seul ne doit pas couper la grille");
  a(sansGrille({ shiftKey: true, altKey: true } as DonneeDynamique) === false,
    "Maj+Alt sans Ctrl/Cmd : la grille reste active");
});

// ---------------------------------------------------------------------------------------------
test("pas_grille_arrondit_a_5_par_defaut", (a: DonneeDynamique) => {
  // Départ à 100 (multiple de 5), la main demande 100+27=127 : le pas relatif arrondit 27 à 25.
  a(pasGrille(100, 127, true, false) === 125, `attendu 125, vu ${pasGrille(100, 127, true, false)}`);
  // Départ HORS grille (133) : le pas est toujours relatif au départ, pas à l'absolu.
  // 133 + round(27/5)*5 = 133 + 25 = 158, jamais 160 (qui serait l'arrondi de 158 lui-même).
  a(pasGrille(133, 160, true, false) === 158, `attendu 158, vu ${pasGrille(133, 160, true, false)}`);
});

test("pas_grille_arrondit_au_cm_avec_ctrl", (a: DonneeDynamique) => {
  const noGrid = sansGrille({ ctrlKey: true });
  a(pasGrille(100, 127.4, true, noGrid) === 127, `attendu 127 (cm entier), vu ${pasGrille(100, 127.4, true, noGrid)}`);
  a(pasGrille(133, 160.2, true, noGrid) === 160, `attendu 160, vu ${pasGrille(133, 160.2, true, noGrid)}`);
});

test("pas_grille_grille_coupee_ignore_snap", (a: DonneeDynamique) => {
  // `snap` (l'option de grille) déjà à faux : Ctrl ne change rien, c'était déjà le cm entier.
  a(pasGrille(100, 127.4, false, false) === 127, "snap deja coupe : cm entier sans Ctrl");
  a(pasGrille(100, 127.4, false, true) === 127, "snap deja coupe : cm entier avec Ctrl aussi");
});

// ---------------------------------------------------------------------------------------------
// G-5 : UN ALLER-RETOUR REVIENT EXACTEMENT AU DEPART, meme depuis une position hors grille (un
// plan converti, une largeur impaire). Deux gestes SEPARES : le premier part de `depart`, arrive
// quelque part ; le second part de LA (nouveau depart), et redemande explicitement `depart`.
test("aller_retour_revient_exactement_grille", (a: DonneeDynamique) => {
  const depart = 133;             // hors grille de 5 cm, comme un meuble de largeur impaire
  const p1 = pasGrille(depart, depart + 27, true, false);   // premier geste : demande +27
  const p2 = pasGrille(p1, depart, true, false);            // second geste : redemande le depart exact
  a(p2 === depart, `l'aller-retour (grille) doit revenir a ${depart}, vu ${p2} (etape ${p1})`);
});

test("aller_retour_revient_exactement_libre", (a: DonneeDynamique) => {
  const depart = 133.0;
  const noGrid = sansGrille({ metaKey: true });   // Cmd tenu pendant les DEUX gestes
  const p1 = pasGrille(depart, depart + 26.6, true, noGrid);
  const p2 = pasGrille(p1, depart, true, noGrid);
  a(p2 === depart, `l'aller-retour (sans grille) doit revenir a ${depart}, vu ${p2} (etape ${p1})`);
});

// ---------------------------------------------------------------------------------------------
console.log(`\n${ko ? `FAILURES ${ko}/${ok + ko}` : `OK ${ok}/${ok}`}`);
rates.forEach((n) => console.log("  FAIL " + n));
process.exit(ko ? 1 : 0);
