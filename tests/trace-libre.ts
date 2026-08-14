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
//
// 2026-08-15, "a badly drawn right angle must become a right angle" (the owner's L came out
// ~12deg off on both legs): every run is now quantised to the nearest multiple of 45 degrees,
// UNCONDITIONALLY, no tolerance.
//   quarantecinq_quantifie_sans_tolerance    12/20/30/44deg off axis all land on a 45deg multiple
//   quarantecinq_carre_un_l_maladroit        a sloppy L (well outside the OLD 12deg tolerance)
//                                            becomes a TRUE right angle, exact shared corner
//   quarantecinq_garde_le_zigzag_connecte    a 4-leg zigzag, none of it axis-aligned: every
//                                            vertex still shared exactly between its two walls
//   quarantecinq_fusionne_les_memes_axes     two consecutive runs that quantise to the SAME axis
//                                            (a gentle S-curve) merge into ONE straight run
//   quarantecinq_fusionne_l_aller_retour     a stroke that doubles back on itself (parallel,
//                                            opposite direction): no NaN, no absurd length
//   quarantecinq_fusionne_un_troncon_ras     a run left too short by reconstruction is folded
//                                            into its neighbour, not kept as a sliver wall
//   quarantecinq_libre_ignore_tout_ca        Alt (libre): the whole pipeline still keeps raw angles
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
//  45deg QUANTISATION, UNCONDITIONAL (2026-08-15)
// ---------------------------------------------------------------------------------------------
test("quarantecinq_quantifie_sans_tolerance", (a: DonneeDynamique) => {
  // Every one of these is OUTSIDE the old 12deg tolerance (12 itself included, since the old
  // code only snapped a run that was AT MOST 12deg off, and stayed raw past it). Every single
  // one must still land on an exact multiple of 45deg: 12/20 are closer to 0 than to 45 (below
  // the 22.5deg midpoint) and must become perfectly horizontal; 30/44 are past that midpoint and
  // must become a perfect diagonal, not horizontal.
  const casDeg = [
    { off: 12, attendu: 0 }, { off: 20, attendu: 0 }, { off: 30, attendu: 45 }, { off: 44, attendu: 45 },
  ];
  for (const { off, attendu } of casDeg) {
    const rad = off * Math.PI / 180;
    const L = 300;
    const raw: Pt[] = [[0, 0], [L * Math.cos(rad), L * Math.sin(rad)]];
    const out = straightenChain(raw, false);
    const angle = Math.atan2(out[1][1] - out[0][1], out[1][0] - out[0][0]) * 180 / Math.PI;
    const mod45 = Math.abs(angle % 45);
    a(mod45 < 0.05 || mod45 > 44.95,
      `${off}deg hors tolerance doit quand meme tomber sur un multiple de 45, vu angle=${angle.toFixed(3)}`);
    const arrondi = Math.round(angle / 45) * 45;
    a(arrondi === attendu, `${off}deg doit se quantifier a ${attendu}deg, vu ${arrondi}`);
  }
});

test("quarantecinq_carre_un_l_maladroit", (a: DonneeDynamique) => {
  // The owner's own defect, reproduced: a hand-drawn L with BOTH legs ~15deg off their axis,
  // comfortably outside the old 12deg tolerance. It must come out as a TRUE right angle: both
  // walls exactly horizontal/vertical, sharing one exact point.
  const A: Pt = [0, 0], B: Pt = [200, 55], C: Pt = [145, 255]; // AB ~15.4deg off horiz, BC ~15.4deg off vert
  const legs = traceToWallSegments([A, B, C], false);
  a(legs.length === 2, `un L a 2 tronçons doit faire 2 murs, vu ${legs.length}`);
  if (legs.length === 2) {
    const [m0, m1] = legs;
    a(m0.b[0] === m1.a[0] && m0.b[1] === m1.a[1],
      `les deux murs doivent partager EXACTEMENT le meme coin, vu ${JSON.stringify(m0.b)} vs ${JSON.stringify(m1.a)}`);
    a(m0.a[1] === m0.b[1], `le premier mur doit etre PARFAITEMENT horizontal, vu ${JSON.stringify(m0)}`);
    a(m1.a[0] === m1.b[0], `le second mur doit etre PARFAITEMENT vertical, vu ${JSON.stringify(m1)}`);
    a(m0.free === 1 && m1.free === 1, "les deux bouts libres du trace doivent rester `free`");
  }
});

test("quarantecinq_garde_le_zigzag_connecte", (a: DonneeDynamique) => {
  // 4 legs, none of them anywhere near an axis on their own raw angle (10-15deg, or 74-75deg):
  // alternating quantised classes (0/90/0/90), so no two neighbours ever merge, and the pure
  // line-reconstruction has to hold across the WHOLE chain, not just one corner.
  const raw: Pt[] = [[0, 0], [100, 18], [130, 120], [230, 145], [255, 240]];
  const legs = traceToWallSegments(raw, false);
  a(legs.length === 4, `un zigzag a 4 tronçons doit faire 4 murs, vu ${legs.length}`);
  for (let i = 0; i < legs.length - 1; i++) {
    a(legs[i].b[0] === legs[i + 1].a[0] && legs[i].b[1] === legs[i + 1].a[1],
      `le sommet ${i} doit rester EXACTEMENT partage, vu ${JSON.stringify(legs[i].b)} vs ${JSON.stringify(legs[i + 1].a)}`);
    const seg = legs[i];
    a(seg.a[0] === seg.b[0] || seg.a[1] === seg.b[1],
      `chaque troncon doit etre parfaitement axial (0 ou 90deg), vu ${JSON.stringify(seg)}`);
  }
});

test("quarantecinq_fusionne_les_memes_axes", (a: DonneeDynamique) => {
  // A gentle S: 5deg then ~20deg off horizontal, both on the SAME side of the axis. Neither run
  // alone forces a real corner (both quantise to the SAME 0deg class): this is not two walls
  // meeting, it is one straight wall the hand wobbled while drawing.
  const raw: Pt[] = [[0, 0], [200, 17.5], [400, 90.29]];
  const out = straightenChain(raw, false);
  a(out.length === 2, `deux troncons de meme axe doivent fusionner en UN seul mur, vu ${out.length - 1} troncons`);
  a(out[0][0] === 0 && out[0][1] === 0, "le tout premier point du trace reste exactement ou la main a pose");
  a(out[1][1] === out[0][1], `le mur fusionne doit etre parfaitement horizontal, vu ${JSON.stringify(out)}`);
});

test("quarantecinq_fusionne_l_aller_retour", (a: DonneeDynamique) => {
  // The hand overshoots then comes back over itself: run 1 goes right (~0deg), run 2 goes back
  // left-and-slightly-down (~186deg, i.e. also class 0deg mod 180 = the exact-opposite direction).
  // Two parallel lines that never meet: must not explode into NaN or a wall stretching miles away.
  const raw: Pt[] = [[0, 0], [300, 10], [150, -5]];
  const out = straightenChain(raw, false);
  for (const p of out) {
    a(Number.isFinite(p[0]) && Number.isFinite(p[1]), `aucune coordonnee ne doit etre NaN/infinie, vu ${JSON.stringify(out)}`);
    // the raw stroke never left a ~300x15 box: nothing legitimate justifies landing far outside it.
    a(Math.abs(p[0]) < 3000 && Math.abs(p[1]) < 3000, `aucun mur de longueur absurde, vu ${JSON.stringify(out)}`);
  }
  a(out.length === 2, `l'aller-retour doit fusionner en un seul mur, vu ${out.length - 1} troncons`);
});

test("quarantecinq_fusionne_un_troncon_ras", (a: DonneeDynamique) => {
  // A near-right-angle L with a tiny (~0.6cm) wobble stuck in the middle of the corner. The
  // reconstructed middle run collapses to a couple of centimetres, well under
  // TRACE_LIBRE_45_MIN_RUN_CM (12cm, the wall thickness): it must be folded away, not shipped
  // as its own sliver wall, leaving a clean 2-leg right angle.
  const raw: Pt[] = [[0, 0], [150, 2], [150.5, 2.3], [150, 180]];
  const out = straightenChain(raw, false);
  a(out.length === 3, `le troncon ras doit disparaitre, il ne doit rester que 2 murs, vu ${out.length - 1} troncons: ${JSON.stringify(out)}`);
  const legs = segmentChain(out);
  for (const seg of legs) {
    const len = Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]);
    a(len >= 12, `aucun mur ne doit etre plus court que l'epaisseur d'un mur (12cm), vu ${len.toFixed(2)}cm`);
  }
  if (legs.length === 2) {
    a(legs[0].b[0] === legs[1].a[0] && legs[0].b[1] === legs[1].a[1], "le coin doit rester exactement partage apres fusion");
  }
});

test("quarantecinq_libre_ignore_tout_ca", (a: DonneeDynamique) => {
  // Alt (libre) is the escape hatch: even through the WHOLE pipeline, a deliberately odd angle
  // (20deg, nowhere near a 45deg multiple) must survive untouched.
  const raw: Pt[] = [[0, 0], [300, 300 * Math.tan(20 * Math.PI / 180)]];
  const legs = traceToWallSegments(raw, true);
  a(legs.length === 1, `un seul troncon doit faire un seul mur, vu ${legs.length}`);
  const seg = legs[0];
  const angle = Math.atan2(seg.b[1] - seg.a[1], seg.b[0] - seg.a[0]) * 180 / Math.PI;
  a(Math.abs(angle - 20) < 0.1, `Alt doit garder l'angle brut (20deg), vu ${angle.toFixed(2)}deg`);
});

// ---------------------------------------------------------------------------------------------
console.log(`\n${ko ? `FAILURES ${ko}/${ok + ko}` : `OK ${ok}/${ok}`}`);
rates.forEach(n => console.log("  FAIL " + n));
process.exit(ko ? 1 : 0);
