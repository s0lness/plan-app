#!/usr/bin/env node
// =============================================================================
//  "FREEHAND WALL TRACE" SUITE — NO BROWSER (the geometry is PURE)
// =============================================================================
// Usage request, verbatim: "i think we should have a sort of 'free draw' thing for walls. you
// draw and then it turns into walls. cos sometimes you want to make a corner or smth and it's
// not easy." A single freehand stroke becomes a CHAIN of walls: this suite covers the pure
// pipeline in `src/ts/geometrie/trace-libre.ts` (simplify -> straighten -> dedupe -> segment),
// exactly as `tests/mur-libre.ts` covers `v5ThroughWall`. The impure gesture
// (`src/ts/gestes/trace-libre.ts`: capture, undo, toast) is covered by
// `tests/trace-libre-geste.ts`, with a real mouse.
//
//   node tests/trace-libre.ts
//
//   rdp_ecrase_une_ligne_secouee            200 noisy points along a line collapse to a few
//   rdp_garde_un_vrai_coin                  a deliberate corner survives simplification
//   redresser_verrouille_le_presque_axe     a near-horizontal run locks onto exactly horizontal
//   redresser_garde_une_diagonale_deliberee a 45deg run is left alone, not forced onto an axis
//   redresser_libre_n_impose_rien           Alt (libre): no snap, the raw shape is kept
//   redresser_partage_le_coin_sur_plusieurs a 4-leg staircase: exact shared vertices throughout
//   segmenter_ecarte_un_troncon_degenere    a collapsed run produces no wall
//   dedupliquer_fusionne_les_points_proches close points collapse to one
//   longueur_somme_les_troncons             strokeLength is the path length, not the span
//   pipeline_secoue_en_l_fait_peu_de_murs   a 200-point shaky "L" makes very few walls
//   pipeline_seuls_les_bouts_sont_libres    a 3-leg stroke: only the outer walls are `free`
import type { DonneeDynamique } from "./_types.ts";
import {
  dedupeChain,
  segmentChain,
  simplifyRDP,
  straightenChain,
  strokeLength,
  traceToWallSegments,
} from "../src/ts/geometrie/trace-libre.ts";
import { TRACE_LIBRE_RDP_TOL_CM } from "../src/ts/noyau/nombres.ts";
import type { Pt } from "../src/ts/partage/plan.ts";

let ok = 0, ko = 0;
const rates: DonneeDynamique[] = [];
function test(nom: string, fn: (...args: DonneeDynamique[]) => DonneeDynamique | Promise<DonneeDynamique>) {
  const fails = [];
  try { fn((c: DonneeDynamique, m: DonneeDynamique) => { if (!c) fails.push(m); }); } catch (e) { fails.push("EXCEPTION: " + (e && e.stack || e)); }
  if (fails.length) { ko++; rates.push(nom); } else ok++;
  console.log(`  ${fails.length ? "FAIL " : "ok   "} ${nom}`);
  fails.forEach(f => console.log("        - " + f));
}

// ---------------------------------------------------------------------------------------------
test("rdp_ecrase_une_ligne_secouee", (a: DonneeDynamique) => {
  // 200 points along a straight 0..300cm line, deterministic "hand tremor" of a few cm
  // (well under TRACE_LIBRE_RDP_TOL_CM=8): they must collapse to essentially the two endpoints.
  const pts: Pt[] = [];
  for (let i = 0; i < 200; i++) {
    const t = i / 199;
    pts.push([t * 300, Math.sin(i * 0.9) * 2.5]);
  }
  const out = simplifyRDP(pts, TRACE_LIBRE_RDP_TOL_CM);
  a(out.length <= 4, `200 points quasi droits doivent s'effondrer a peu de points, vu ${out.length}`);
  a(out[0][0] === 0 && out[0][1] === pts[0][1], "le premier point est conserve tel quel");
  a(out[out.length - 1][0] === 300, "le dernier point est conserve tel quel");
});

test("rdp_garde_un_vrai_coin", (a: DonneeDynamique) => {
  // A right-angle corner: the deviation from the start-end chord is huge (~106cm), far above
  // the 8cm tolerance, so the corner MUST survive.
  const pts: Pt[] = [[0, 0], [150, 0], [150, 150]];
  const out = simplifyRDP(pts, TRACE_LIBRE_RDP_TOL_CM);
  a(out.length === 3, `un vrai coin ne doit pas disparaitre, vu ${out.length} points`);
  a(out[1][0] === 150 && out[1][1] === 0, "le coin reste exactement ou il a ete pose");
});

test("redresser_verrouille_le_presque_axe", (a: DonneeDynamique) => {
  // ~1.9deg off horizontal: well inside TRACE_LIBRE_ANGLE_TOL_DEG (12deg), must snap exactly.
  const out = straightenChain([[0, 0], [150, 5]], false);
  a(out.length === 2, "deux points en entree, deux points en sortie");
  a(out[1][1] === out[0][1], `presque-horizontal doit se verrouiller EXACTEMENT (y identique), vu ${JSON.stringify(out)}`);
  a(out[1][0] === 150, "x suit le tracé brut");
});

test("redresser_garde_une_diagonale_deliberee", (a: DonneeDynamique) => {
  // A clean 45deg run: far outside the axis tolerance on EITHER side, must stay diagonal.
  const out = straightenChain([[0, 0], [100, 100]], false);
  a(out[1][0] !== out[0][0] && out[1][1] !== out[0][1],
    `une diagonale de 45deg ne doit etre forcee sur AUCUN axe, vu ${JSON.stringify(out)}`);
  a(out[1][0] === 100 && out[1][1] === 100, "et garder son tracé exact");
});

test("redresser_libre_n_impose_rien", (a: DonneeDynamique) => {
  // Alt held ("libre"): the SAME near-horizontal run as the first case must NOT snap.
  const out = straightenChain([[0, 0], [150, 5]], true);
  a(out[1][1] === 5, `Alt (libre) ne doit imposer aucun angle droit, vu ${JSON.stringify(out)}`);
});

test("redresser_partage_le_coin_sur_plusieurs", (a: DonneeDynamique) => {
  // A 4-leg staircase, each run a couple of degrees off its axis (well inside tolerance): every
  // consecutive pair must share its vertex EXACTLY (round once, AGENTS.md "round the corner,
  // once"), and every leg must land EXACTLY on its axis, not "nearly".
  const raw: Pt[] = [[0, 0], [150, 3], [153, 148], [300, 145], [296, 296]];
  const chaine = straightenChain(raw, false);
  a(chaine.length === 5, `4 troncons attendus, vu ${chaine.length - 1}`);
  const legs = segmentChain(chaine);
  a(legs.length === 4, `4 murs attendus, vu ${legs.length}`);
  for (let i = 0; i < legs.length - 1; i++) {
    a(legs[i].b[0] === legs[i + 1].a[0] && legs[i].b[1] === legs[i + 1].a[1],
      `le segment ${i} et le segment ${i + 1} doivent partager EXACTEMENT le meme sommet, vu ${JSON.stringify(legs[i].b)} vs ${JSON.stringify(legs[i + 1].a)}`);
  }
  a(legs[0].a[1] === legs[0].b[1], "le premier troncon doit etre parfaitement horizontal");
  a(legs[1].a[0] === legs[1].b[0], "le deuxieme troncon doit etre parfaitement vertical");
  a(legs[2].a[1] === legs[2].b[1], "le troisieme troncon doit etre parfaitement horizontal");
  a(legs[3].a[0] === legs[3].b[0], "le quatrieme troncon doit etre parfaitement vertical");
  a(legs[0].free === 1, "le tout premier troncon (bout libre du trace) doit etre `free`");
  a(legs[3].free === 1, "le tout dernier troncon (bout libre du trace) doit etre `free`");
  a(!legs[1].free, "un troncon interieur (jonction des deux cotes) ne doit PAS etre `free`");
  a(!legs[2].free, "un troncon interieur (jonction des deux cotes) ne doit PAS etre `free`");
});

test("segmenter_ecarte_un_troncon_degenere", (a: DonneeDynamique) => {
  const chaine: Pt[] = [[0, 0], [100, 0], [100.3, 0.2], [250, 0]];
  const legs = segmentChain(chaine);
  a(legs.length === 2, `un troncon effondre (<1cm) ne doit produire aucun mur, vu ${legs.length} murs`);
});

test("dedupliquer_fusionne_les_points_proches", (a: DonneeDynamique) => {
  const out = dedupeChain([[0, 0], [0.2, 0.3], [100, 0], [100.4, 0.1]]);
  a(out.length === 2, `les points a moins d'1cm doivent fusionner, vu ${out.length}`);
});

test("longueur_somme_les_troncons", (a: DonneeDynamique) => {
  const L = strokeLength([[0, 0], [30, 0], [30, 40]]);
  a(L === 70, `la longueur doit sommer les troncons (30+40=70), vu ${L}`);
  a(strokeLength([[0, 0]]) === 0, "un point seul a une longueur nulle");
});

test("pipeline_secoue_en_l_fait_peu_de_murs", (a: DonneeDynamique) => {
  // 200-point deliberately shaky "L": 100 points per leg, ~2cm perpendicular jitter (under the
  // 8cm RDP tolerance), each leg 150cm. The whole pipeline must still produce a small number of
  // walls, sharing an exact corner, both ends free.
  const pts: Pt[] = [];
  for (let i = 0; i < 100; i++) {
    const t = i / 99;
    pts.push([t * 150, Math.sin(i * 1.3) * 2]);
  }
  const cx = pts[pts.length - 1][0], cy = pts[pts.length - 1][1];
  for (let i = 1; i < 100; i++) {
    const t = i / 99;
    pts.push([cx + Math.sin(i * 1.7) * 2, cy + t * 150]);
  }
  a(pts.length === 199, "précondition : le trace brut porte bien ~200 points");
  const legs = traceToWallSegments(pts, false);
  a(legs.length >= 2 && legs.length <= 4, `un trace secoue en L doit faire PEU de murs, vu ${legs.length}`);
  a(legs[0].free === 1, "le premier mur (bout libre) doit etre `free`");
  a(legs[legs.length - 1].free === 1, "le dernier mur (bout libre) doit etre `free`");
  for (let i = 0; i < legs.length - 1; i++) {
    a(legs[i].b[0] === legs[i + 1].a[0] && legs[i].b[1] === legs[i + 1].a[1],
      `les murs ${i} et ${i + 1} doivent partager exactement leur sommet`);
  }
});

test("pipeline_seuls_les_bouts_sont_libres", (a: DonneeDynamique) => {
  // A clean 3-leg stroke (a "U"), through the WHOLE pipeline: only the two outer walls carry
  // `free`, the middle one (a true interior junction on both ends) does not.
  const stroke: Pt[] = [];
  for (let i = 0; i <= 20; i++) stroke.push([i * 5, 0]);          // 0..100, y=0
  for (let i = 1; i <= 20; i++) stroke.push([100, i * 5]);        // x=100, 0..100
  for (let i = 1; i <= 20; i++) stroke.push([100 + i * 5, 100]);  // 100..200, y=100
  const legs = traceToWallSegments(stroke, false);
  a(legs.length === 3, `un "U" propre doit faire exactement 3 murs, vu ${legs.length}`);
  a(legs[0].free === 1 && legs[2].free === 1, "les deux murs des bouts doivent etre `free`");
  a(!legs[1].free, "le mur du milieu (jonction des deux cotes) ne doit PAS etre `free`");
  a(legs[0].b[0] === legs[1].a[0] && legs[0].b[1] === legs[1].a[1], "premier coin partage exactement");
  a(legs[1].b[0] === legs[2].a[0] && legs[1].b[1] === legs[2].a[1], "second coin partage exactement");
});

// ---------------------------------------------------------------------------------------------
console.log(`\n${ko ? `FAILURES ${ko}/${ok + ko}` : `OK ${ok}/${ok}`}`);
rates.forEach(n => console.log("  FAIL " + n));
process.exit(ko ? 1 : 0);
