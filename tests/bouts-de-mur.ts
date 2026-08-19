#!/usr/bin/env node
// =============================================================================
//  "WALL ENDPOINT HANDLES" SUITE — NO BROWSER (the geometry is PURE)
// =============================================================================
// Owner's report, verbatim: "j'aimerais aussi pouvoir choper les extrémités des murs et pouvoir
// étendre et relier à d'autres murs. parfois je fais un mur mais je me rate, je voulais le faire
// plus long, et là je dois le delete et recommencer." Before this batch, a SELECTED interior wall
// carried exactly ONE handle, the "×" that deletes it (`rendu/calque.ts`'s `drawHandles`): a wall
// drawn too short could only be deleted and redrawn.
//
// This suite exercises the PURE half: `v5SnapWallEnd` (junction/segment/outline snap,
// `modele/edition.ts`), `v5WallEndDrop` (the full cascade: snap, then 45° direction, then the
// grid, `gestes/murs.ts`), and `v5WallEndDragApply` (the mutation itself: only ONE endpoint
// moves, the wall becomes `free`, geometry re-settles). All three are safe to call with a stub
// `Contexte` (no `render()`, no `document`), exactly the way `v5WallDragCtx`/`v5WallDragApply` are
// already exercised by `tests/jonction-glisser-mur.ts`.
//
// WHAT THIS SUITE DOES NOT COVER, DELIBERATELY: "a press-release without movement writes
// nothing" needs the REAL gesture wiring (`armGesture`, `pushHistory` -> `$("btnUndo")` ->
// `document`), which this repository never drives outside a real browser (see
// `tests/jonction-glisser-mur-geste.ts` and every other `*-geste.ts` suite). That case, and
// "the handle is actually hittable", live in `tests/bouts-de-mur-geste.ts` instead.
//
//   node tests/bouts-de-mur.ts
import type { DonneeDynamique } from "./_types.ts";
import { v5ResoudreGeometrie, v5WallEndDragApply, v5WallEndDrop } from "../src/ts/gestes/murs.ts";
import { v5BoutJoint, v5MurTraverse, v5SnapWallEnd, v5WallSplitAtPoint } from "../src/ts/modele/edition.ts";
import { v5RebuildCells } from "../src/ts/modele/cellules.ts";
import { sanitizeV5Plan } from "../src/ts/modele/migrations.ts";
import type { Contexte } from "../src/ts/app/contexte.ts";
import type { Id, Mur, PlanV5, Pt } from "../src/ts/partage/plan.ts";

let ok = 0, ko = 0;
const rates: DonneeDynamique[] = [];
function test(nom: string, fn: (...args: DonneeDynamique[]) => DonneeDynamique | Promise<DonneeDynamique>) {
  const fails: string[] = [];
  try { fn((c: DonneeDynamique, m: DonneeDynamique) => { if (!c) fails.push(m); }); } catch (e) { fails.push("EXCEPTION: " + (e && (e as Error).stack || e)); }
  if (fails.length) { ko++; rates.push(nom); } else ok++;
  console.log(`  ${fails.length ? "FAIL " : "ok   "} ${nom}`);
  fails.forEach(f => console.log("        - " + f));
}

/** A 400x300 apartment; `murs` are the interior walls under test. */
function plan(murs: Mur[]): PlanV5 {
  return sanitizeV5Plan({
    outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
    walls: murs,
    openings: [], pieces: [], cells: [],
  })!;
}
/** The LIVE wall object inside `P.walls` (see `tests/jonction-glisser-mur.ts`'s own header: never
 * trust the literal handed to `plan()`, `sanitizeV5Plan` builds fresh objects). */
function mur(P: PlanV5, id: Id): Mur {
  const w = P.walls.find((x) => String(x.id) === String(id));
  if (!w) throw new Error(`mur ${id} introuvable`);
  return w;
}
/** A fake `Contexte`: `v5WallEndDragApply` only ever touches `etat.plan`, `canvas` and `vue`. */
function ctxDe(P: PlanV5): Contexte {
  return {
    etat: { plan: P, opts: { snap: true } },
    canvas: { querySelector: (): null => null },
    vue: { scale: 1, ox: 0, oy: 0 },
    rev: 0,
  } as unknown as Contexte;
}

// ---------------------------------------------------------------------------------------------
//  v5WallEndDragApply: only ONE endpoint moves, the wall becomes `free`
// ---------------------------------------------------------------------------------------------
test("glisser_b_ne_bouge_que_b_a_reste_identique", (a: DonneeDynamique) => {
  const P = plan([{ id: "w1", a: [100, 100], b: [100, 200], t: 12, isOutline: false }]);
  const aAvant: Pt = [...mur(P, "w1").a];
  const ctx = ctxDe(P);
  v5WallEndDragApply(ctx, "w1", "b", [250, 200], true);
  const w = mur(P, "w1");
  a(w.b[0] === 250 && w.b[1] === 200, `b doit avoir bougé exactement là où on l'a lâché, vu ${JSON.stringify(w.b)}`);
  a(JSON.stringify(w.a) === JSON.stringify(aAvant), `a doit rester BIT POUR BIT identique, vu ${JSON.stringify(w.a)} attendu ${JSON.stringify(aAvant)}`);
});

test("glisser_a_ne_bouge_que_a_b_reste_identique", (a: DonneeDynamique) => {
  const P = plan([{ id: "w1", a: [100, 100], b: [100, 200], t: 12, isOutline: false }]);
  const bAvant: Pt = [...mur(P, "w1").b];
  const ctx = ctxDe(P);
  v5WallEndDragApply(ctx, "w1", "a", [50, 60], true);
  const w = mur(P, "w1");
  a(w.a[0] === 50 && w.a[1] === 60, `a doit avoir bougé exactement là où on l'a lâché, vu ${JSON.stringify(w.a)}`);
  a(JSON.stringify(w.b) === JSON.stringify(bAvant), `b doit rester BIT POUR BIT identique, vu ${JSON.stringify(w.b)} attendu ${JSON.stringify(bAvant)}`);
});

test("l_extremite_glissee_devient_free", (a: DonneeDynamique) => {
  // A THROUGH-GOING wall (free absent): without `free:1`, `v5ThroughWall` would push the dropped
  // endpoint straight back out to the nearest barrier on the very next recompute, undoing the
  // placement the instant the gesture ends.
  const P = plan([{ id: "w1", a: [100, 100], b: [100, 200], t: 12, isOutline: false }]);
  a(!mur(P, "w1").free, "précondition : le mur ne doit pas être `free` avant le geste");
  const ctx = ctxDe(P);
  v5WallEndDragApply(ctx, "w1", "b", [250, 250], true);
  const w = mur(P, "w1");
  a(w.free === 1, `l'extrémité tirée doit rendre le mur \`free\`, vu ${JSON.stringify(w.free)}`);
  a(w.b[0] === 250 && w.b[1] === 250, `la position lâchée doit tenir même après le recalcul final, vu ${JSON.stringify(w.b)}`);
});

test("les_cellules_se_reconstruisent_a_la_fin_seulement", (a: DonneeDynamique) => {
  const P = plan([
    { id: "w1", a: [200, 0], b: [200, 150], t: 12, isOutline: false, free: 1 },
    { id: "w2", a: [200, 150], b: [200, 300], t: 12, isOutline: false, free: 1 },
  ]);
  v5RebuildCells(P);
  a(P.cells.length === 2, `précondition : deux pièces, vu ${P.cells.length}`);
  const cellsAvant = JSON.stringify(P.cells);
  const ctx = ctxDe(P);
  v5WallEndDragApply(ctx, "w1", "a", [200, 20], false);
  a(JSON.stringify(P.cells) === cellsAvant, "les cellules ne doivent pas bouger pendant une frame non finale");
  v5WallEndDragApply(ctx, "w1", "a", [200, 20], true);
  a(JSON.stringify(P.cells) !== cellsAvant, "la reconstruction finale doit, elle, refléter la nouvelle géométrie");
});

// ---------------------------------------------------------------------------------------------
//  v5SnapWallEnd: junction / segment / outline, EXACT, own endpoints excluded
// ---------------------------------------------------------------------------------------------
test("accroche_exacte_sur_l_extremite_d_un_autre_mur", (a: DonneeDynamique) => {
  const P = plan([
    { id: "w1", a: [100, 100], b: [100, 200], t: 12, isOutline: false },
    { id: "w2", a: [250, 250], b: [300, 250], t: 12, isOutline: false },
  ]);
  // 3px away from wall w2's own endpoint [300,250] at scale=1 (echelle) => 3cm away, within the
  // ~15px endpoint tolerance.
  const p = v5SnapWallEnd(P, "w1", 303, 250, 1);
  a(!!p, "un point à 3 unités d'une extrémité doit accrocher");
  a(!!p && p[0] === 300 && p[1] === 250, `l'accroche doit tomber EXACTEMENT sur l'extrémité visée, vu ${JSON.stringify(p)}`);
});

test("accroche_exacte_sur_le_segment_d_un_autre_mur", (a: DonneeDynamique) => {
  const P = plan([
    { id: "w1", a: [100, 100], b: [100, 200], t: 12, isOutline: false },
    { id: "w2", a: [250, 250], b: [350, 250], t: 12, isOutline: false },
  ]);
  // A point 3 units off the MIDDLE of w2's segment (nowhere near either endpoint): must land
  // exactly on the segment itself (the perpendicular foot), not merely "close".
  const p = v5SnapWallEnd(P, "w1", 300, 253, 1);
  a(!!p, "un point à 3 unités d'un segment doit accrocher");
  a(!!p && p[0] === 300 && p[1] === 250, `l'accroche doit tomber EXACTEMENT sur le segment, vu ${JSON.stringify(p)}`);
});

test("accroche_exacte_sur_le_contour", (a: DonneeDynamique) => {
  const P = plan([{ id: "w1", a: [100, 100], b: [100, 200], t: 12, isOutline: false }]);
  // 3 units off the TOP facade (y=0), away from any corner.
  const p = v5SnapWallEnd(P, "w1", 200, 3, 1);
  a(!!p, "un point à 3 unités de la façade doit accrocher");
  a(!!p && p[0] === 200 && p[1] === 0, `l'accroche doit tomber EXACTEMENT sur le contour, vu ${JSON.stringify(p)}`);
});

// LA PORTEE D'ACCROCHE SE MESURE EN PIXELS, DONC ELLE GRANDIT QUAND ON DEZOOME. Elle etait
// plafonnee a WALL (12 cm) par un `Math.min`, ce qui annulait le terme en pixels cense l'elargir:
// des que l'echelle passait sous 1,25 px/cm, c'est-a-dire a tout zoom de travail, il fallait viser
// a six pixels pres. Signale a l'usage: tirer le bout d'un mur contre une facade ne l'y accrochait
// pas. Le meme point, a la meme distance en centimetres, doit accrocher a echelle 0,4 alors qu'il
// est trop loin a echelle 3.
test("la_portee_d_accroche_grandit_quand_on_dezoome", (a: DonneeDynamique) => {
  const P = plan([{ id: "w1", a: [100, 100], b: [100, 200], t: 12, isOutline: false }]);
  const loinEnCm = 18;                       // au-dela de l'ancien plafond de 12 cm
  const dezoome = v5SnapWallEnd(P, "w1", 200, loinEnCm, 0.4);
  a(!!dezoome && dezoome[1] === 0,
    `a echelle 0,4 ce point est a 7 px de la facade et doit accrocher, vu ${JSON.stringify(dezoome)}`);
  const zoome = v5SnapWallEnd(P, "w1", 200, loinEnCm, 3);
  a(zoome === null,
    `a echelle 3 le meme point est a 54 px et ne doit rien accrocher, vu ${JSON.stringify(zoome)}`);
});

// LA CIBLE EST LA BANDE, PAS L'AXE. Un mur est une bande de 12 cm (60 pour un porteur), et l'oeil
// vise la bande: « je l'ai pose contre le mur » veut dire que le pointeur est a sa FACE, deja a une
// demi-epaisseur de l'axe auquel l'accroche se comparait. Mesure sur le vrai plan: la prise ne se
// declenchait qu'a 9 cm de l'axe, soit 3 cm PASSE la face interieure, donc lacher la ou le mur
// s'arrete visiblement ne faisait rien. Signale deux fois. Consequence directe et testable: a
// distance d'axe egale, un mur EPAIS accroche la ou un mur FIN n'accroche pas.
test("un_mur_epais_accroche_de_plus_loin_qu_un_mur_fin", (a: DonneeDynamique) => {
  const aDistance = 26;                       // cm depuis l'AXE du mur vise
  const fin = plan([
    { id: "w1", a: [40, 40], b: [40, 90], t: 12, isOutline: false },
    { id: "cible", a: [200, 100], b: [200, 200], t: 12, isOutline: false },
  ]);
  a(v5SnapWallEnd(fin, "w1", 200 + aDistance, 150, 1) === null,
    `a ${aDistance} cm de l'axe d'un mur de 12 cm, on est a 20 cm de sa face: pas d'accroche`);
  const epais = plan([
    { id: "w1", a: [40, 40], b: [40, 90], t: 12, isOutline: false },
    { id: "cible", a: [200, 100], b: [200, 200], t: 40, isOutline: false },
  ]);
  const p = v5SnapWallEnd(epais, "w1", 200 + aDistance, 150, 1);
  a(!!p && p[0] === 200,
    `le MEME point, contre un mur de 40 cm, n'est qu'a 6 cm de sa face et doit accrocher, vu ${JSON.stringify(p)}`);
});

// UN T COUPE LA BARRE QU'IL TOUCHE. Demande du proprietaire: amener le bout d'un mur sur un autre
// doit (a) les connecter et (b) couper le mur qui forme la barre du T, pour que ses deux moities
// deviennent des murs a part entiere avec leurs propres commandes. La connexion marchait deja par
// l'accroche; la coupe est la partie qui manquait.
test("un_bout_pose_au_milieu_d_un_mur_le_coupe_en_deux", (a: DonneeDynamique) => {
  const P = plan([
    { id: "barre", a: [200, 50], b: [200, 250], t: 12, isOutline: false },
    { id: "pied", a: [40, 150], b: [190, 150], t: 12, isOutline: false },
  ]);
  const cible = v5MurTraverse(P, [200, 150], ["pied"]);
  if (!a(!!cible && String(cible.id) === "barre", `la barre du T doit etre reconnue, vu ${cible && cible.id}`)) return;
  const r = v5WallSplitAtPoint(P, "barre", [200, 150]);
  if (!a("id" in r, `la coupe doit reussir, vu ${JSON.stringify(r)}`) || !("id" in r)) return;
  const barre = P.walls.find((w) => String(w.id) === "barre")!;
  const neuf = P.walls.find((w) => String(w.id) === String(r.id))!;
  a(barre.a[1] === 50 && barre.b[1] === 150, `la moitie haute doit aller de 50 a 150, vu ${JSON.stringify([barre.a, barre.b])}`);
  a(neuf.a[1] === 150 && neuf.b[1] === 250, `la moitie basse doit aller de 150 a 250, vu ${JSON.stringify([neuf.a, neuf.b])}`);
  a(barre.a[0] === 200 && neuf.b[0] === 200, "les deux moities doivent rester sur la meme droite");
});

// ET UN CONTACT PRES DU BOUT N'EST PAS UN T, c'est deux murs qui se rejoignent en coin. Couper la
// produirait un moignon de quelques centimetres que personne n'a demande.
test("un_contact_pres_du_bout_de_la_barre_n_est_pas_un_T", (a: DonneeDynamique) => {
  const P = plan([
    { id: "barre", a: [200, 50], b: [200, 250], t: 12, isOutline: false },
    { id: "pied", a: [40, 52], b: [190, 52], t: 12, isOutline: false },
  ]);
  a(v5MurTraverse(P, [200, 52], ["pied"]) === null,
    "un contact a 2 cm du bout de la barre ne doit pas la couper");
});

// UN JOINT N'EST PAS UN BOUT, et le rendu s'appuie la-dessus pour ne pas offrir de prise a une
// extremite deja tenue: tirer dessus dechirerait la jonction. Signale apres une coupe, ou les deux
// moities exhibaient le point de coupe comme un bout saisissable.
test("une_extremite_tenue_par_un_autre_mur_est_un_joint", (a: DonneeDynamique) => {
  const P = plan([
    { id: "barre", a: [200, 50], b: [200, 250], t: 12, isOutline: false },
    { id: "pied", a: [40, 150], b: [200, 150], t: 12, isOutline: false },
  ]);
  a(v5BoutJoint(P, "pied", "b") === true, "le bout pose sur la barre est un joint");
  a(v5BoutJoint(P, "pied", "a") === false, "l'autre bout, en plein air, n'en est pas un");
});

test("un_mur_n_accroche_jamais_sur_sa_propre_extremite_fixe", (a: DonneeDynamique) => {
  // Dragging w1's `b` back toward its OWN fixed end `a` ([100,100]) must NOT snap there (that
  // would collapse the wall to zero length the moment the hand got close): excluded by
  // `excludeWallId`.
  const P = plan([{ id: "w1", a: [100, 100], b: [100, 200], t: 12, isOutline: false }]);
  const p = v5SnapWallEnd(P, "w1", 103, 100, 1);
  a(p === null, `la propre extrémité fixe du mur ne doit jamais être une cible d'accroche, vu ${JSON.stringify(p)}`);
});

test("hors_de_portee_aucune_accroche", (a: DonneeDynamique) => {
  const P = plan([
    { id: "w1", a: [100, 100], b: [100, 200], t: 12, isOutline: false },
    { id: "w2", a: [250, 250], b: [300, 250], t: 12, isOutline: false },
  ]);
  const p = v5SnapWallEnd(P, "w1", 240, 150, 1);
  a(p === null, `un point loin de tout doit ne rien accrocher, vu ${JSON.stringify(p)}`);
});

// ---------------------------------------------------------------------------------------------
//  v5WallEndDrop: the full cascade (snap, then 45°, then the grid)
// ---------------------------------------------------------------------------------------------
// A big apartment, anchor DEAD CENTER: every point used below stays hundreds of cm from any
// wall/facade, so `v5SnapWallEnd` never fires and these three tests measure ONLY the
// direction/grid cascade (stages 4-5), never stage 1-3 by accident.
const OUTLINE_OUVERTE: Pt = [1000, 1000];

test("sans_accroche_la_direction_se_cale_sur_45_degres", (a: DonneeDynamique) => {
  const P = sanitizeV5Plan({
    outline: [[0, 0], [2000, 0], [2000, 2000], [0, 2000]],
    walls: [{ id: "w1", a: OUTLINE_OUVERTE, b: OUTLINE_OUVERTE, t: 12, isOutline: false }],
    openings: [], pieces: [], cells: [],
  })!;
  // Anchor at the apartment's center, a ROUGHLY horizontal drag (dx=97, dy=6, ~3.5° off axis,
  // nothing within reach to snap onto): the wall must come out EXACTLY horizontal, not 6 off.
  const p = v5WallEndDrop(P, "w1", OUTLINE_OUVERTE, 1097, 1006, 1, false, 5);
  a(p[1] === 1000, `un tracé quasi horizontal doit donner un mur EXACTEMENT horizontal, vu y=${p[1]}`);
  a(p[0] === 1095, `l'abscisse doit être calée sur la grille de 5, vu x=${p[0]}`);
});

test("alt_libere_l_angle", (a: DonneeDynamique) => {
  const P = sanitizeV5Plan({
    outline: [[0, 0], [2000, 0], [2000, 2000], [0, 2000]],
    walls: [{ id: "w1", a: OUTLINE_OUVERTE, b: OUTLINE_OUVERTE, t: 12, isOutline: false }],
    openings: [], pieces: [], cells: [],
  })!;
  // Same near-horizontal drag, but Alt held: no 45° constraint, the raw point (grid-rounded) wins.
  const p = v5WallEndDrop(P, "w1", OUTLINE_OUVERTE, 1097, 1006, 1, true, 5);
  a(p[1] === 1005, `Alt doit libérer l'angle (pas d'axe imposé), vu y=${p[1]}`);
  a(p[0] === 1095, `la grille s'applique quand même sous Alt, vu x=${p[0]}`);
});

test("ctrl_donne_le_centimetre_la_grille_par_defaut_donne_5cm", (a: DonneeDynamique) => {
  const P = sanitizeV5Plan({
    outline: [[0, 0], [2000, 0], [2000, 2000], [0, 2000]],
    walls: [{ id: "w1", a: OUTLINE_OUVERTE, b: OUTLINE_OUVERTE, t: 12, isOutline: false }],
    openings: [], pieces: [], cells: [],
  })!;
  const p5 = v5WallEndDrop(P, "w1", OUTLINE_OUVERTE, 1097, 1001, 1, false, 5);
  a(p5[0] === 1095, `pas de 5cm par défaut, vu x=${p5[0]}`);
  const p1 = v5WallEndDrop(P, "w1", OUTLINE_OUVERTE, 1097, 1001, 1, false, 1);
  a(p1[0] === 1097, `Ctrl/Cmd (step=1) doit donner le centimètre, vu x=${p1[0]}`);
});

test("une_jonction_a_portee_gagne_sur_la_direction_et_la_grille", (a: DonneeDynamique) => {
  const P = plan([
    { id: "w1", a: [0, 0], b: [0, 0], t: 12, isOutline: false },
    { id: "w2", a: [303, 6], b: [400, 6], t: 12, isOutline: false },
  ]);
  // The pointer sits close enough to w2's own endpoint [303,6] to snap (stage 1), even though it
  // is ALSO close to the horizontal axis from the anchor: the junction must win.
  const p = v5WallEndDrop(P, "w1", [0, 0], 305, 8, 1, false, 5);
  a(p[0] === 303 && p[1] === 6, `la jonction doit l'emporter sur la quantification d'angle, vu ${JSON.stringify(p)}`);
});

// ---------------------------------------------------------------------------------------------
//  THE `free` RULE: an endpoint dropped in open space stays exactly there
// ---------------------------------------------------------------------------------------------
test("lache_en_espace_libre_l_extremite_reste_exactement_la", (a: DonneeDynamique) => {
  // A wall running east-west, extended far into open space, away from every wall/facade: without
  // `free:1` (checked directly below), `v5ThroughWall` would shoot this endpoint straight back
  // to the nearest barrier (here, the far facade at x=400) the moment the gesture settles.
  const P = plan([{ id: "w1", a: [50, 150], b: [100, 150], t: 12, isOutline: false }]);
  const ctx = ctxDe(P);
  v5WallEndDragApply(ctx, "w1", "b", [180, 150], true);
  const w = mur(P, "w1");
  a(w.b[0] === 180 && w.b[1] === 150,
    `l'extrémité lâchée en espace libre doit rester EXACTEMENT là, vu ${JSON.stringify(w.b)} (pas la façade à x=400)`);
});

test("sans_le_marqueur_free_le_mur_traversant_s_etendrait_a_la_facade", (a: DonneeDynamique) => {
  // NEGATIVE CONTROL for the test above: a wall that is NOT free DOES get pushed out to the
  // facade by the ordinary geometry pipeline, proving `free` is really what holds the endpoint in
  // place, not some other accident of this fixture.
  const P = plan([{ id: "w1", a: [50, 150], b: [180, 150], t: 12, isOutline: false }]);
  a(!mur(P, "w1").free, "précondition : ce mur n'est pas `free`");
  // Re-settle without dragging: a through-going wall still gets extended to the facade by the
  // ordinary pipeline (the very one `v5WallEndDragApply` calls internally).
  v5ResoudreGeometrie(P, true);
  const w = mur(P, "w1");
  a(w.b[0] === 400, `un mur NON free doit s'étendre jusqu'à la façade (x=400), vu ${JSON.stringify(w.b)} — ceci prouve que \`free\` est bien ce qui protège le geste précédent`);
});

// ---------------------------------------------------------------------------------------------
console.log(`\n${ko ? `FAILURES ${ko}/${ok + ko}` : `OK ${ok}/${ok}`}`);
rates.forEach(n => console.log("  FAIL " + n));
process.exit(ko ? 1 : 0);
