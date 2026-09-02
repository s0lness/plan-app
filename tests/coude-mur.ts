#!/usr/bin/env node
// =============================================================================
//  "WALL ELBOW" SUITE, PURE GEOMETRY, NO BROWSER
// =============================================================================
// A wall elbow starts as a data operation: split the selected interior wall at its midpoint while
// preserving every opening's absolute position. The real pointer threshold and hit targets live
// in tests/outil-mur-geste.ts.
//
//   node tests/coude-mur.ts
import type { DonneeDynamique } from "./_types.ts";
import { v5WallSplitAt, type ResultatDivisionMur } from "../src/ts/modele/edition.ts";
import type { Id, Mur, Ouverture, PlanV5, Pt } from "../src/ts/partage/plan.ts";

let ok = 0, ko = 0;
const rates: DonneeDynamique[] = [];
function test(nom: string, fn: (...args: DonneeDynamique[]) => DonneeDynamique) {
  const fails: string[] = [];
  // THE ASSERT RETURNS ITS VERDICT, and that is not cosmetic. Eight of the cases below are written
  // `if (!a(condition, "...")) return;` to stop before dereferencing something that does not exist.
  // With a helper that returned nothing, `!a(...)` was ALWAYS true: every one of those cases
  // returned at its first line and verified nothing at all, while printing `ok`. A suite that can
  // only fail by throwing is decorative.
  try { fn((c: DonneeDynamique, m: DonneeDynamique) => { if (!c) { fails.push(String(m)); return false; } return true; }); }
  catch (e) { fails.push("EXCEPTION: " + (e && (e as Error).stack || e)); }
  if (fails.length) { ko++; rates.push(nom); } else ok++;
  console.log(`  ${fails.length ? "FAIL " : "ok   "} ${nom}`);
  fails.forEach((f) => console.log("        - " + f));
}

function plan(walls: Mur[], openings: Ouverture[] = []): PlanV5 {
  return {
    outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
    walls, openings, pieces: [], cells: [],
  };
}
function mur(P: PlanV5, id: Id): Mur {
  const w = P.walls.find((x) => String(x.id) === String(id));
  if (!w) throw new Error(`mur ${id} introuvable`);
  return w;
}
function ouverture(P: PlanV5, id: Id): Ouverture {
  const o = P.openings.find((x) => String(x.id) === String(id));
  if (!o) throw new Error(`ouverture ${id} introuvable`);
  return o;
}
function longueur(w: Pick<Mur, "a" | "b">): number {
  return Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
}
function reussi(r: ResultatDivisionMur): r is Extract<ResultatDivisionMur, { id: Id }> {
  return "id" in r;
}
function position(P: PlanV5, o: Ouverture, distance: number): Pt {
  const w = mur(P, o.wallId);
  const L = longueur(w);
  return [w.a[0] + (w.b[0] - w.a[0]) * distance / L, w.a[1] + (w.b[1] - w.a[1]) * distance / L];
}
function extremitesOuverture(P: PlanV5, o: Ouverture): [Pt, Pt] {
  return [position(P, o, o.t0), position(P, o, o.t0 + o.w)];
}
function ouvertureDe(id: string, t0: number, w: number, name: string): Ouverture {
  return { id, wallId: "w1", t0, w, h: 12, type: "window", side: 0, name };
}

test("division_donne_deux_murs_colineaires_avec_un_point_commun", (a: DonneeDynamique) => {
  const P = plan([{ id: "w1", a: [40, 120], b: [360, 120], t: 12, isOutline: false }]);
  const r = v5WallSplitAt(P, "w1");
  if (!a(reussi(r), `la division doit réussir, vu ${JSON.stringify(r)}`) || !reussi(r)) return;
  const premier = mur(P, "w1"), second = mur(P, r.id);
  a(P.walls.length === 2, `deux murs attendus, vu ${P.walls.length}`);
  a(premier.b[0] === second.a[0] && premier.b[1] === second.a[1], "les deux moitiés doivent partager exactement leur jonction");
  a(premier.a[1] === premier.b[1] && second.a[1] === second.b[1], "les deux moitiés doivent rester colinéaires");
  a(premier.a[0] === 40 && premier.b[0] === 200 && second.b[0] === 360, `milieu géométrique incorrect: ${JSON.stringify(P.walls)}`);
});

test("la_longueur_totale_et_l_epaisseur_sont_conservees", (a: DonneeDynamique) => {
  const P = plan([{ id: "w1", a: [50, 40], b: [290, 220], t: 17, isOutline: false }]);
  const avant = longueur(P.walls[0]!);
  const r = v5WallSplitAt(P, "w1");
  if (!a(reussi(r), `division refusée: ${JSON.stringify(r)}`) || !reussi(r)) return;
  const somme = longueur(mur(P, "w1")) + longueur(mur(P, r.id));
  a(Math.abs(somme - avant) < 1e-9, `longueur ${avant} devenue ${somme}`);
  a(mur(P, "w1").t === 17 && mur(P, r.id).t === 17, "les deux moitiés doivent garder l'épaisseur de départ");
});

test("ouverture_premiere_moitie_garde_wallId_et_t0", (a: DonneeDynamique) => {
  const P = plan([{ id: "w1", a: [0, 100], b: [300, 100], t: 12, isOutline: false }], [
    ouvertureDe("o1", 25, 60, "First window"),
  ]);
  const r = v5WallSplitAt(P, "w1");
  a(reussi(r), `division refusée: ${JSON.stringify(r)}`);
  const o = ouverture(P, "o1");
  a(o.wallId === "w1", `wallId doit rester w1, vu ${o.wallId}`);
  a(o.t0 === 25, `t0 doit rester 25 cm, vu ${o.t0}`);
});

test("ouverture_seconde_moitie_change_de_mur_et_soustrait_la_demi_longueur", (a: DonneeDynamique) => {
  const P = plan([{ id: "w1", a: [0, 100], b: [300, 100], t: 12, isOutline: false }], [
    ouvertureDe("o2", 210, 50, "Second window"),
  ]);
  const r = v5WallSplitAt(P, "w1");
  if (!a(reussi(r), `division refusée: ${JSON.stringify(r)}`) || !reussi(r)) return;
  const o = ouverture(P, "o2");
  a(o.wallId === r.id, `wallId doit devenir ${r.id}, vu ${o.wallId}`);
  a(o.t0 === 60, `t0 doit devenir 210 - 150 = 60 cm, vu ${o.t0}`);
});

test("les_positions_absolues_des_ouvertures_ne_bougent_pas", (a: DonneeDynamique) => {
  const P = plan([{ id: "w1", a: [40, 30], b: [360, 270], t: 12, isOutline: false }], [
    ouvertureDe("o1", 30, 45, "First window"),
    ouvertureDe("o2", 260, 55, "Second window"),
  ]);
  const avant = new Map(P.openings.map((o) => [String(o.id), extremitesOuverture(P, o)]));
  const r = v5WallSplitAt(P, "w1");
  if (!a(reussi(r), `division refusée: ${JSON.stringify(r)}`)) return;
  for (const o of P.openings) {
    const p0 = avant.get(String(o.id))!;
    const p1 = extremitesOuverture(P, o);
    const ecart = Math.max(Math.hypot(p0[0][0] - p1[0][0], p0[0][1] - p1[0][1]), Math.hypot(p0[1][0] - p1[1][0], p0[1][1] - p1[1][1]));
    a(ecart < 1e-9, `${o.name} a bougé de ${ecart} cm: ${JSON.stringify(p0)} vers ${JSON.stringify(p1)}`);
  }
});

test("ouverture_a_cheval_refuse_et_la_nommee", (a: DonneeDynamique) => {
  const P = plan([{ id: "w1", a: [0, 100], b: [300, 100], t: 12, isOutline: false }], [
    ouvertureDe("o1", 130, 50, "Kitchen window"),
  ]);
  const avant = JSON.stringify(P);
  const r = v5WallSplitAt(P, "w1");
  a(!reussi(r), `la division doit être refusée, vu ${JSON.stringify(r)}`);
  if (!reussi(r)) a(r.refus.includes("Kitchen window"), `le refus doit nommer l'objet, vu ${r.refus}`);
  a(JSON.stringify(P) === avant, "un refus ne doit modifier aucun octet du plan");
});

test("mur_de_facade_refuse_meme_si_le_cache_est_verifie_par_la_geometrie", (a: DonneeDynamique) => {
  const P = plan([{ id: "ow1", a: [0, 0], b: [400, 0], t: 20, isOutline: true }]);
  const avant = JSON.stringify(P);
  const r = v5WallSplitAt(P, "ow1");
  a(!reussi(r), `la façade doit être refusée, vu ${JSON.stringify(r)}`);
  if (!reussi(r)) a(/facade/i.test(r.refus), `le refus doit dire facade, vu ${r.refus}`);
  a(JSON.stringify(P) === avant, "la façade doit rester intacte");
});

test("le_nouvel_id_porte_l_etiquette_du_device", (a: DonneeDynamique) => {
  const P = plan([{ id: "w19", a: [20, 100], b: [380, 100], t: 12, isOutline: false }]);
  const r = v5WallSplitAt(P, "w19");
  if (!a(reussi(r), `division refusée: ${JSON.stringify(r)}`) || !reussi(r)) return;
  a(/^w\d+-[a-z0-9]{4,8}$/.test(String(r.id)), `id créé sans étiquette de device: ${r.id}`);
});

test("diviser_deux_fois_produit_trois_murs_et_deux_ids_uniques", (a: DonneeDynamique) => {
  const P = plan([{ id: "w1", a: [0, 100], b: [320, 100], t: 12, isOutline: false }]);
  const r1 = v5WallSplitAt(P, "w1");
  if (!a(reussi(r1), `première division refusée: ${JSON.stringify(r1)}`) || !reussi(r1)) return;
  const r2 = v5WallSplitAt(P, "w1");
  if (!a(reussi(r2), `seconde division refusée: ${JSON.stringify(r2)}`) || !reussi(r2)) return;
  a(P.walls.length === 3, `trois murs attendus, vu ${P.walls.length}`);
  a(String(r1.id) !== String(r2.id), `les ids créés doivent être uniques, vu ${r1.id}`);
  a(mur(P, "w1").b[0] === 80, `la première moitié doit pouvoir être redécoupée, vu ${JSON.stringify(mur(P, "w1"))}`);
});

// Two coordinates already rounded to the hundredth of a centimetre can have a midpoint that is
// NOT: 40,01 and 361,02 meet at 200,515. Storing that unrounded would make this the only place in
// the model that does, and subtracting a half-length the split did not really use would slide
// every object on the second half by the difference. So the stored point is rounded, and the
// first half's length is derived FROM IT.
test("un_milieu_non_rond_est_arrondi_et_ne_deplace_rien", (a: DonneeDynamique) => {
  const P = plan(
    [{ id: "w1", a: [40.01, 120], b: [361.02, 120], t: 12, isOutline: false }],
    [ouvertureDe("o1", 250, 40, "Fenêtre")],
  );
  const avant = extremitesOuverture(P, ouverture(P, "o1"));
  const r = v5WallSplitAt(P, "w1");
  if (!a(reussi(r), `division refusée: ${JSON.stringify(r)}`) || !reussi(r)) return;
  const jonction = mur(P, "w1").b;
  a(Math.round(jonction[0] * 100) === jonction[0] * 100 && Math.round(jonction[1] * 100) === jonction[1] * 100,
    `la jonction stockée doit être arrondie comme toute coordonnée du modèle, vu ${JSON.stringify(jonction)}`);
  const apres = extremitesOuverture(P, ouverture(P, "o1"));
  a(Math.hypot(apres[0][0] - avant[0][0], apres[0][1] - avant[0][1]) < 0.005
    && Math.hypot(apres[1][0] - avant[1][0], apres[1][1] - avant[1][1]) < 0.005,
    `l'ouverture ne doit pas glisser sur le sol: ${JSON.stringify(avant)} puis ${JSON.stringify(apres)}`);
});

console.log(`\n${ko ? `FAILURES ${ko}/${ok + ko}` : `OK ${ok}/${ok}`}`);
rates.forEach((n) => console.log("  FAIL " + n));
process.exit(ko ? 1 : 0);
