#!/usr/bin/env node
// =============================================================================
//  "DISTRIBUTE SPACING EVENLY" SUITE — NO BROWSER (the computation is PURE)
// =============================================================================
// Usage request: "the same gap between the bed and the two nightstands".
//
// THE COMPUTATION IS A PURE FUNCTION (`src/ts/modele/repartir.ts`): it takes furniture and returns
// MOVES, it writes nothing. This is what lets it be proven here without Chrome, in
// milliseconds, and lets us cover the tricky cases (lock in the middle, ambiguous axis, rotated objects) that
// would cost a minute each behind a real mouse. What Chrome must prove, that the
// button exists, that it snaps, that it undoes in one step, belongs to the interface suites.
//
//   node tests/repartir-espacement.ts
//
//   le_lit_se_centre_entre_les_deux_chevets   the real case, the one from the request
//   les_extremes_ne_bougent_jamais            convention of every layout tool
//   l_ecart_se_mesure_entre_boites            10 cm of GAP, not 10 cm between centers
//   un_objet_tourne_compte_par_sa_boite       a rotation changes the footprint, hence the gap
//   axe_deduit_et_jamais_devine               vertical, horizontal, and refusal on a tie
//   verrou_au_milieu_refuse_au_lieu_de_bouger a silently ignored lock is a broken lock
//   deux_objets_ne_sont_pas_repartissables    a single gap: there's nothing to equalize
//   deja_reparti_ne_produit_aucun_deplacement no op for nothing (hence no undo step)
import type { DonneeDynamique } from "./_types.ts";
import { imposerEcart as imposerEcartReel, repartirEgalement as repartirEgalementReel } from "../src/ts/modele/repartir.ts";
import type { Repartition, RefusRepartition } from "../src/ts/modele/repartir.ts";
import { empilables } from "../src/ts/catalogue/catalogue.ts";
import type { Meuble } from "../src/ts/partage/plan.ts";

let ok = 0, ko = 0;
const cas: DonneeDynamique[] = [];
function test(nom: string, fn: (...args: DonneeDynamique[]) => DonneeDynamique | Promise<DonneeDynamique>) {
  const fails = [];
  try { fn((c: DonneeDynamique, m: DonneeDynamique) => { if (!c) fails.push(m); }); } catch (e) { fails.push("EXCEPTION: " + (e && e.stack || e)); }
  if (fails.length) { ko++; cas.push({ nom, fails }); } else ok++;
  console.log(`  ${fails.length ? "FAIL " : "ok   "} ${nom}`);
  fails.forEach(f => console.log("        - " + f));
}
const M = (id: string, x: number, y: number, w: DonneeDynamique, h: number, extra: Partial<Meuble> = {}): Meuble =>
  Object.assign({ id, type: "box", name: id, x, y, w, h, rot: 0, locked: false }, extra);
type VerdictRepartition = { ok: boolean; r?: Repartition; refus?: RefusRepartition };
const repartirEgalement = (pieces: Meuble[]): VerdictRepartition => repartirEgalementReel(pieces);
const imposerEcart = (...args: Parameters<typeof imposerEcartReel>): VerdictRepartition => imposerEcartReel(...args);
const dxDe = (r: DonneeDynamique, id: string) => (r.r.bouges.find((b: DonneeDynamique) => b.id === id) || { dx: 0 }).dx;
const dyDe = (r: DonneeDynamique, id: string) => (r.r.bouges.find((b: DonneeDynamique) => b.id === id) || { dy: 0 }).dy;

// ---------------------------------------------------------------------------------------------
test("le_lit_se_centre_entre_les_deux_chevets", (a: DonneeDynamique) => {
  // 45-wide nightstand at x=0, 160-wide bed at x=57, nightstand at x=245. Gaps: 12 then 28.
  const chevetG = M("cg", 0, 100, 45, 40);
  const lit = M("lit", 57, 60, 160, 200);
  const chevetD = M("cd", 245, 100, 45, 40);
  const r = repartirEgalement([chevetD, lit, chevetG]);   // input order DELIBERATELY shuffled
  a(r.ok, "la répartition doit aboutir");
  if (!r.ok) return;
  a(r.r.axe === "x", `l'axe doit être x, vu ${r.r.axe}`);
  a(JSON.stringify(r.r.ecartsAvant) === JSON.stringify([12, 28]),
    `les écarts d'avant doivent être [12, 28], vu ${JSON.stringify(r.r.ecartsAvant)}`);
  a(r.r.ecart === 20, `l'écart commun doit être 20, vu ${r.r.ecart}`);
  a(r.r.bouges.length === 1, `seul le lit doit bouger, vu ${JSON.stringify(r.r.bouges)}`);
  a(dxDe(r, "lit") === 8, `le lit doit se décaler de +8, vu ${dxDe(r, "lit")}`);
});

test("les_extremes_ne_bougent_jamais", (a: DonneeDynamique) => {
  const r = repartirEgalement([M("a", 0, 0, 10, 10), M("b", 30, 0, 10, 10), M("c", 200, 0, 10, 10)]);
  a(r.ok, "ok");
  if (!r.ok) return;
  a(!r.r.bouges.some(b => b.id === "a" || b.id === "c"),
    `ni le premier ni le dernier ne doivent bouger, vu ${JSON.stringify(r.r.bouges)}`);
});

test("l_ecart_se_mesure_entre_boites", (a: DonneeDynamique) => {
  // Three objects with different WIDTHS: if the gap were measured between CENTERS, the result
  // would depend on the widths and the gap would be uneven. It's the gap we equalize.
  const r = repartirEgalement([M("a", 0, 0, 100, 10), M("b", 150, 0, 10, 10), M("c", 300, 0, 40, 10)]);
  a(r.ok, "ok");
  if (!r.ok) return;
  // total free space = 300 - 100 - 10 = 190, two gaps -> 95 each
  a(r.r.ecart === 95, `écart attendu 95, vu ${r.r.ecart}`);
  const bx = 100 + 95;
  a(dxDe(r, "b") === +(bx - 150).toFixed(2), `b doit aller en x=${bx}, vu un delta de ${dxDe(r, "b")}`);
});

test("un_objet_tourne_compte_par_sa_boite", (a: DonneeDynamique) => {
  // A 100x10 object rotated 90 degrees takes up 10 of width: its box changes, hence the gap changes.
  const droit = repartirEgalement([M("a", 0, 0, 10, 10), M("b", 100, 0, 100, 10), M("c", 400, 0, 10, 10)]);
  const tourne = repartirEgalement([M("a", 0, 0, 10, 10), M("b", 100, 0, 100, 10, { rot: 90 }), M("c", 400, 0, 10, 10)]);
  a(droit.ok && tourne.ok, "les deux doivent aboutir");
  if (!droit.ok || !tourne.ok) return;
  a(droit.r.ecart !== tourne.r.ecart,
    `la rotation doit changer l'écart (droit ${droit.r.ecart}, tourné ${tourne.r.ecart})`);
  a(tourne.r.ecart === 190, `objet tourné : 400-10-... -> 190 attendu, vu ${tourne.r.ecart}`);
});

test("axe_deduit_et_jamais_devine", (a: DonneeDynamique) => {
  const vert = repartirEgalement([M("a", 0, 0, 10, 10), M("b", 0, 40, 10, 10), M("c", 0, 300, 10, 10)]);
  a(vert.ok && vert.r.axe === "y", `empilés verticalement -> axe y, vu ${vert.ok ? vert.r.axe : vert.refus}`);
  // Spread STRICTLY equal on both axes: we refuse instead of choosing at random.
  const carre = repartirEgalement([M("a", 0, 0, 10, 10), M("b", 40, 40, 10, 10), M("c", 90, 90, 10, 10)]);
  a(!carre.ok && carre.refus === "axe_ambigu",
    `étalement égal -> refus « axe_ambigu », vu ${carre.ok ? "ok" : carre.refus}`);
});

test("verrou_au_milieu_refuse_au_lieu_de_bouger", (a: DonneeDynamique) => {
  const r = repartirEgalement([
    M("a", 0, 0, 10, 10), M("b", 30, 0, 10, 10, { locked: true }), M("c", 300, 0, 10, 10),
  ]);
  a(!r.ok && r.refus === "verrou_au_milieu",
    `un verrou au milieu doit REFUSER, vu ${r.ok ? JSON.stringify(r.r.bouges) : r.refus}`);
  // But a lock that would NOT have had to move blocks nothing: it's already in place.
  const b = repartirEgalement([
    M("a", 0, 0, 10, 10), M("b", 100, 0, 10, 10, { locked: true }), M("c", 200, 0, 10, 10),
  ]);
  a(b.ok, `un verrou déjà en place ne doit rien bloquer, vu ${b.ok ? "ok" : b.refus}`);
});

test("deux_objets_ne_sont_pas_repartissables", (a: DonneeDynamique) => {
  const r = repartirEgalement([M("a", 0, 0, 10, 10), M("b", 100, 0, 10, 10)]);
  a(!r.ok && r.refus === "moins_de_trois",
    `deux objets = un seul écart, rien à égaliser, vu ${r.ok ? "ok" : r.refus}`);
});

test("deja_reparti_ne_produit_aucun_deplacement", (a: DonneeDynamique) => {
  const r = repartirEgalement([M("a", 0, 0, 10, 10), M("b", 100, 0, 10, 10), M("c", 200, 0, 10, 10)]);
  a(r.ok, "ok");
  if (!r.ok) return;
  a(r.r.bouges.length === 0,
    `déjà réparti -> aucun déplacement (donc aucun cran d'annulation), vu ${JSON.stringify(r.r.bouges)}`);
});

test("le_seche_linge_s_empile_sans_etre_signale", (a: DonneeDynamique) => {
  // The point of `empilables`: two objects at the SAME spot are an error ONLY if nobody
  // said they stack. The table is symmetric, so the order of arguments doesn't change anything.
  a(empilables("washer", "dryer"), "lave-linge + seche-linge s'empilent");
  a(empilables("dryer", "washer"), "et dans l'autre sens aussi");
  a(!empilables("washer", "bed"), "un lit ne s'empile pas sur un lave-linge");
  a(!empilables("dryer", "dryer"), "deux seche-linge ne s'empilent pas l'un sur l'autre");
});

test("imposer_un_ecart_pose_la_valeur_partout", (a: DonneeDynamique) => {
  // "Distribute" says "the same", it doesn't say WHICH. Typing 10 says which. Two operations.
  const r = imposerEcart([M("a", 0, 0, 50, 10), M("b", 80, 0, 50, 10), M("c", 300, 0, 50, 10)], 10);
  a(r.ok, "doit aboutir");
  if (!r.ok) return;
  a(r.r.ecart === 10, "l'ecart obtenu est celui demande, vu " + r.r.ecart);
  // a stays at 0..50; b goes to 60; c goes to 120.
  a(!r.r.bouges.some(x => x.id === "a"), "le PREMIER ne bouge pas : c'est le point d'appui");
  a(dxDe(r, "b") === -20, "b se cale a 10 cm de a, vu " + dxDe(r, "b"));
  a(dxDe(r, "c") === -180, "c se cale a 10 cm de b, vu " + dxDe(r, "c"));
});

test("imposer_un_ecart_garde_les_memes_refus", (a: DonneeDynamique) => {
  const deux = imposerEcart([M("a", 0, 0, 10, 10), M("b", 100, 0, 10, 10)], 10);
  a(!deux.ok && deux.refus === "moins_de_trois", "deux objets : rien a espacer");
  const verrou = imposerEcart([
    M("a", 0, 0, 10, 10), M("b", 100, 0, 10, 10, { locked: true }), M("c", 200, 0, 10, 10),
  ], 10);
  a(!verrou.ok && verrou.refus === "verrou_au_milieu",
    "un verrou qui devrait bouger REFUSE, comme pour la repartition");
  // But a lock in FIRST position doesn't get in the way: it doesn't move, it's the anchor point.
  const tete = imposerEcart([
    M("a", 0, 0, 10, 10, { locked: true }), M("b", 100, 0, 10, 10), M("c", 200, 0, 10, 10),
  ], 10);
  a(tete.ok, "un verrou en tete est le cas COURANT, il ne bloque rien");
});

// ---------------------------------------------------------------------------------------------
console.log(`\n${ko ? `FAILURES ${ko}/${ok + ko}` : `OK ${ok}/${ok}`}`);
cas.forEach(c => console.log("  FAIL " + c.nom));
process.exit(ko ? 1 : 0);
