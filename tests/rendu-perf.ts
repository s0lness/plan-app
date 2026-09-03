#!/usr/bin/env node
// =================================================================================================
//  CE QUE LE RENDU DOM COUTE, MESURE DANS UN VRAI NAVIGATEUR
// =================================================================================================
// Le lot P1 avait mesure les chemins PURS (geometrie, cellules) et les avait trouves bon marche.
// La vraie depense d'une image est ailleurs: dans le DOM. Le rendu reconciliait chaque meuble et
// chaque ouverture par un `container.querySelector(".piece[data-id=...]")`, soit ~230 requetes de
// selecteur par image sur le plan genere ici, et `drawHandles` refaisait trois `walls.find` plus
// un `find` par arete de contour a chaque image.
//
// Puis, une fois les requetes supprimees, la depense restante etait le travail lui-meme: une image
// de glisser bouge UN meuble et reecrivait les deux cents autres. Chaque tuile porte desormais une
// signature (`data-sig`) et n'est reecrite que si son dessin change.
//
//   node tests/rendu-perf.ts [chemin/vers/app.html]
//
//   rendu_complet_reste_sous_le_plafond   `render()` sur 200 meubles, 30 ouvertures, 12 murs
//   vue_pan_reste_sous_le_plafond         `panBy` (pan/zoom): le fond est cache, le reste reconcilie
//   image_de_glisser_reste_sous_le_plafond  ce que `gestes/meuble.ts` appelle par image
//   poignees_seules_restent_sous_le_plafond `drawHandles` avec un mur selectionne
//   le_dom_peint_est_inchange              l'empreinte du calque peint, invariante de l'optimisation
//   repeindre_a_chaud_vaut_repeindre_a_froid  modifier puis repeindre = repeindre a froid, a l'octet
//   selectionner_puis_deselectionner_se_voit  la selection change le dessin d'une tuile, pas le plan
//
// LES BORNES SONT LARGES, DELIBEREMENT. Cette machine fait tourner jusqu'a six worktrees a la
// fois: une borne serree echouerait sur le build du voisin, pas sur une regression. Ce qui est
// defendu ici est l'ORDRE DE GRANDEUR, les chiffres reels vivent dans le rapport du lot.
//
// LE PLAN EST GENERE, JAMAIS UN VRAI APPARTEMENT: un programme dit ce qu'il mesure, un fichier
// d'appartement dit seulement "ce jour-la".
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { VerdictSonde } from "./_types.ts";
import { ouvrirSonde, CHROME } from "./_navigateur.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_PATH = process.argv[2] || path.join(__dirname, "..", "index.html");
if (!fs.existsSync(APP_PATH)) { console.error("App file not found:", APP_PATH); process.exit(1); }
if (!fs.existsSync(CHROME)) { console.error("Chrome not found:", CHROME); process.exit(1); }

// =================================================================================================
//  LA SONDE: un seul chargement, toutes les mesures, un seul verdict
// =================================================================================================
// Une image de rendu se mesure a chaud, sur le meme DOM: relancer une page par mesure ferait payer
// a chacune un demarrage de navigateur different, donc comparerait des machines, pas du code.
const CORPS = `
  // ---- le plan genere -----------------------------------------------------------------------
  var SPAN_X = 1600, SPAN_Y = 1200;
  function planGenere() {
    var walls = [
      { id: "f1", a: [0, 0], b: [SPAN_X, 0], t: 20 },
      { id: "f2", a: [SPAN_X, 0], b: [SPAN_X, SPAN_Y], t: 20 },
      { id: "f3", a: [SPAN_X, SPAN_Y], b: [0, SPAN_Y], t: 20 },
      { id: "f4", a: [0, SPAN_Y], b: [0, 0], t: 20 }
    ];
    // 12 cloisons: 4 verticales entieres, 8 horizontales par tronçons. De vraies jonctions en T.
    for (var i = 1; i <= 4; i++) {
      walls.push({ id: "v" + i, a: [i * 320, 0], b: [i * 320, SPAN_Y], t: 12 });
    }
    for (var j = 0; j < 8; j++) {
      var x0 = (j % 4) * 320, y = (j < 4 ? 400 : 800);
      walls.push({ id: "h" + j, a: [x0, y], b: [x0 + 320, y], t: 12 });
    }
    // 30 ouvertures reparties sur les cloisons interieures.
    var openings = [];
    for (var k = 0; k < 30; k++) {
      var w = walls[4 + (k % 12)];
      var estPorte = (k % 3) !== 0;
      openings.push({
        id: "o" + k, wallId: w.id, t0: 60 + (Math.floor(k / 12) * 220),
        w: estPorte ? 80 : 120, h: 12, type: estPorte ? "door" : "window",
        side: (k % 2), name: "", hinge: (k % 2), swing: (k % 4 < 2) ? 1 : -1
      });
    }
    // 200 meubles: tailles variees (le rang de peinture trie sur l'aire), rotations variees.
    var TYPES = ["sofa3", "sofa2", "arm", "chair", "ottoman"];
    var pieces = [];
    for (var n = 0; n < 200; n++) {
      var t = TYPES[n % TYPES.length];
      var col = n % 20, lig = Math.floor(n / 20);
      pieces.push({
        id: "p" + n, type: t, name: "Objet " + n,
        x: 20 + col * 78, y: 20 + lig * 115,
        w: 40 + (n % 7) * 22, h: 40 + (n % 5) * 18,
        rot: (n % 8) * 45, locked: false
      });
    }
    return {
      outline: [[0, 0], [SPAN_X, 0], [SPAN_X, SPAN_Y], [0, SPAN_Y]],
      walls: walls, openings: openings, pieces: pieces
    };
  }

  var P = planGenere();
  __plan.seedPlan(P);
  __plan.fitView();

  // ---- l'instrument -------------------------------------------------------------------------
  function stats(t) {
    t = t.slice().sort(function (a, b) { return a - b; });
    return {
      med: Math.round(t[Math.floor(t.length / 2)] * 1000) / 1000,
      p95: Math.round(t[Math.min(t.length - 1, Math.floor(t.length * 0.95))] * 1000) / 1000
    };
  }
  function mesurer(n, f) {
    for (var c = 0; c < 5; c++) f(c);          // chauffe: le premier appel construit le DOM
    var t = [];
    for (var i = 0; i < n; i++) {
      var t0 = performance.now();
      f(i);
      t.push(performance.now() - t0);
    }
    return stats(t);
  }

  // (a) render() complet
  var rendu = mesurer(60, function () { __plan.render(); });

  // (b) pan: la vue bouge, le modele non (G-2)
  var vue = mesurer(60, function (i) { __plan.panBy((i % 2) ? 3 : -3, 1); });

  // (c) une image de glisser de meuble: exactement ce que gestes/meuble.ts appelle par image
  //     (la pose bouge, v5Touch marque le modele, render repeint).
  var cible = __plan.plan.pieces[0];
  var x0 = cible.x, y0 = cible.y;
  var glisser = mesurer(60, function (i) {
    cible.x = x0 + (i % 12);
    cible.y = y0 + (i % 7);
    __plan.v5Touch();
    __plan.render();
  });
  cible.x = x0; cible.y = y0;

  // (d) drawHandles seul, un mur selectionne
  __plan.ctx.ihm.selWall = "v2";
  __plan.render();
  var poignees = mesurer(60, function () { __plan.drawHandles(); });
  var compte = __plan.handleCount();
  __plan.ctx.ihm.selWall = null;

  // ---- la preuve d'equivalence --------------------------------------------------------------
  // Le calque REPEINT, normalise puis condense. Ce qui compte n'est pas le nombre mais son
  // invariance: le meme plan, la meme vue, doivent donner le meme DOM avant et apres.
  function empreinteCalque() {
    var c = document.querySelector(".v5layer");
    var s = (c ? c.outerHTML : "").replace(/\\s+/g, " ").trim();
    var h = 5381;
    for (var z = 0; z < s.length; z++) h = ((h * 33) ^ s.charCodeAt(z)) >>> 0;
    return { len: s.length, h: h, s: s };
  }
  // Le point de divergence, pas seulement le verdict: c'est lui qui NOMME la tuile restee vieille.
  function premiereDifference(x, y) {
    var i = 0; while (i < x.length && i < y.length && x[i] === y[i]) i++;
    return { i: i, chaud: x.slice(i, i + 160), froid: y.slice(i, i + 160) };
  }
  __plan.clearSel();
  __plan.setZoom(0.5);
  // ON PART D'UN CALQUE NEUF, et c'est ce qui rend les deux empreintes comparables OCTET PAR
  // OCTET. Un calque reconcilie garde l'ordre de CREATION de ses noeuds: l'etiquette d'une cellule
  // du plan par defaut, nee avant les 200 meubles, reste devant eux pour toujours. Cet ordre est
  // sans effet sur ce qui est peint (tout est en position absolue avec un z-index explicite), mais
  // il suffit a faire mentir une comparaison de chaines. Repartir de zero l'annule.
  var vieux = document.querySelector(".v5layer");
  if (vieux) vieux.remove();
  __plan.render();
  var froidInitial = empreinteCalque();

  // LA SECONDE EMPREINTE, celle que seul un cache peut casser. Une tuile qui n'est PAS remise a
  // jour ne se voit pas sur un rendu neuf: elle se voit quand on MODIFIE le plan puis qu'on
  // repeint. Le meme etat, repeint a chaud (par-dessus le DOM existant) et a froid (calque jete,
  // tout reconstruit), doit rendre exactement le meme DOM. Les modifications choisies ne creent ni
  // ne retirent d'attribut (deplacement, taille, rotation, nom, verrou): l'ordre des attributs
  // dans outerHTML reste donc comparable entre les deux chemins.
  var a = __plan.plan.pieces[3], b = __plan.plan.pieces[17], c2 = __plan.plan.pieces[42];
  a.x += 37; a.y -= 21;
  b.name = "Renomme";
  c2.w += 26; c2.rot = (c2.rot + 45) % 360; c2.locked = true;
  var o0 = __plan.plan.openings[5];
  o0.t0 += 15;
  __plan.v5Touch();
  __plan.render();
  var chaud = empreinteCalque();
  document.querySelector(".v5layer").remove();   // plus rien a reconcilier: tout est reconstruit
  __plan.render();
  var froid = empreinteCalque();

  // LA SELECTION PASSE PAR LA MEME PORTE, et c'est ce qui la rend fragile: elle ne change rien au
  // plan, seulement au dessin d'une tuile. Une signature qui l'oublierait laisserait le clic sans
  // effet visible, ce qu'aucune mesure de temps ne dirait.
  var idSel = String(__plan.plan.pieces[9].id);
  __plan.selReplace(idSel); __plan.render();
  var noeudSel = document.querySelector('.piece[data-id="' + __plan.cssId(idSel) + '"]');
  var marque = { sel: !!noeudSel && noeudSel.classList.contains("sel"), poignees: __plan.rszHandleCount(idSel) };
  // PUIS LE CAS QUI NE CHANGE RIEN D'AUTRE: passer la selection d'un objet a un autre. Le plan ne
  // bouge pas, le nombre de selectionnes ne bouge pas: SEULES les deux tuiles concernees changent
  // de dessin. C'est le champ propre a la tuile, et lui seul, qui les fait repeindre.
  var idAutre = String(__plan.plan.pieces[10].id);
  __plan.selReplace(idAutre); __plan.render();
  var noeudAutre = document.querySelector('.piece[data-id="' + __plan.cssId(idAutre) + '"]');
  marque.selLache = !!noeudSel && noeudSel.classList.contains("sel");
  marque.selPris = !!noeudAutre && noeudAutre.classList.contains("sel");
  __plan.clearSel(); __plan.render();
  marque.selApres = !!noeudSel && noeudSel.classList.contains("sel");
  marque.poigneesApres = __plan.rszHandleCount(idSel);

  return {
    rendu: rendu, vue: vue, glisser: glisser, poignees: poignees,
    compte: compte,
    stats: __plan.v5RenderStats(),
    nbMeubles: __plan.plan.pieces.length,
    nbOuvertures: __plan.plan.openings.length,
    nbMurs: __plan.plan.walls.length,
    nbCellules: __plan.plan.cells.length,
    domLen: froidInitial.len,
    domHash: froidInitial.h,
    chaudLen: chaud.len, chaudHash: chaud.h,
    froidLen: froid.len, froidHash: froid.h,
    ecart: premiereDifference(chaud.s, froid.s),
    marque: marque
  };
`;

// =================================================================================================
const sonde = ouvrirSonde(fs.readFileSync(APP_PATH, "utf8"));
const resultats: { nom: string; ok: boolean; detail: string }[] = [];
function verifier(nom: string, fn: () => string | true): void {
  let detail = "", ok = false;
  try { const r = fn(); if (r === true) ok = true; else detail = r; }
  catch (e) { detail = "check threw: " + String((e as Error)?.stack || e); }
  resultats.push({ nom, ok, detail });
  process.stdout.write((ok ? "  ok   " : "  FAIL ") + nom + "\n");
  if (!ok) process.stdout.write("       " + detail.replace(/\n/g, "\n       ") + "\n");
}

const v: VerdictSonde = await sonde.sonder("", CORPS);
sonde.fermer();

if (v.__noVerdict || v.__probeError || v.__parseError) {
  console.error("la sonde n'a rendu aucun verdict exploitable:\n" + JSON.stringify(v, null, 2).slice(0, 2000));
  process.exit(1);
}
if (Array.isArray(v["jsErrors"]) && (v["jsErrors"] as unknown[]).length) {
  console.error("l'app a journalise des erreurs JS: " + JSON.stringify(v["jsErrors"]));
  process.exit(1);
}

type Mesure = { med: number; p95: number };
const m = (cle: string): Mesure => v[cle] as unknown as Mesure;
const nb = (cle: string): number => Number(v[cle]);

console.log(`\n  plan genere: ${nb("nbMeubles")} meubles, ${nb("nbOuvertures")} ouvertures, `
  + `${nb("nbMurs")} murs, ${nb("nbCellules")} cellules`);
for (const cle of ["rendu", "vue", "glisser", "poignees"]) {
  console.log(`        ${cle.padEnd(9)} med ${String(m(cle).med).padStart(8)} ms   p95 ${String(m(cle).p95).padStart(8)} ms`);
}
console.log(`        calque peint: ${nb("domLen")} caracteres, empreinte ${nb("domHash")}`);
console.log(`        apres modification: a chaud ${nb("chaudHash")}, a froid ${nb("froidHash")}`);

// LES BORNES. Mesure du 2026-09-03, apres la signature par tuile: render 1,0 ms, pan 0,7 ms, image
// de glisser 1,4 ms, poignees 0,3 ms (medianes). Avant la signature, sur la meme machine et dans la
// meme heure: 3,1 / 2,5 / 4,0 / 0,4. Les plafonds ci-dessous sont bien au-dessus du chiffre AVANT:
// ils ne gardent pas le gain, ils gardent l'ordre de grandeur contre une regression franche (un
// querySelector qui revient, un tri par image). Ce qui garde le gain, c'est le rapport du lot; ce
// qui garde la JUSTESSE, c'est `repeindre_a_chaud_vaut_repeindre_a_froid`, plus bas.
verifier("rendu_complet_reste_sous_le_plafond", () =>
  m("rendu").med < 40 || `render() median doit rester sous 40 ms, vu ${m("rendu").med} ms`);
verifier("vue_pan_reste_sous_le_plafond", () =>
  m("vue").med < 40 || `un pan median doit rester sous 40 ms, vu ${m("vue").med} ms`);
verifier("image_de_glisser_reste_sous_le_plafond", () =>
  m("glisser").med < 60 || `une image de glisser doit rester sous 60 ms, vu ${m("glisser").med} ms`);
verifier("poignees_seules_restent_sous_le_plafond", () =>
  m("poignees").med < 10 || `drawHandles seul doit rester sous 10 ms, vu ${m("poignees").med} ms`);

// L'EQUIVALENCE. Le calque doit VRAIMENT etre peint (un DOM vide passerait toutes les bornes de
// temps du monde), et il doit contenir exactement ce que le plan annonce.
verifier("le_dom_peint_est_inchange", () => {
  const s = v["stats"] as unknown as { pieces: number; openings: number; bands: number; floors: number };
  const c = v["compte"] as unknown as { move: number; del: number; split: number };
  if (nb("domLen") < 10000) return `le calque doit etre peint, vu ${nb("domLen")} caracteres`;
  if (s.pieces !== 230) return `230 noeuds .piece attendus (200 meubles + 30 ouvertures), vu ${s.pieces}`;
  if (s.openings !== 30) return `30 ouvertures peintes attendues, vu ${s.openings}`;
  if (s.bands !== 12) return `12 bandes de cloison attendues, vu ${s.bands}`;
  if (c.move !== 1 || c.del !== 1 || c.split !== 1)
    return `un mur selectionne porte deplacer/supprimer/couper, vu ${JSON.stringify(c)}`;
  return true;
});

// CE QUE SEUL UN CACHE PEUT CASSER. Une tuile qui n'est pas remise a jour ne se voit pas sur un
// rendu neuf; elle se voit quand on modifie le plan puis qu'on repeint PAR-DESSUS le DOM existant.
// Un rendu a chaud et un rendu a froid du MEME etat doivent rendre le meme calque, a l'octet.
verifier("repeindre_a_chaud_vaut_repeindre_a_froid", () => {
  if (nb("chaudLen") < 10000) return `le calque doit etre peint, vu ${nb("chaudLen")} caracteres`;
  if (nb("chaudHash") !== nb("froidHash") || nb("chaudLen") !== nb("froidLen"))
    return `apres modification, le rendu a chaud (${nb("chaudLen")} car., ${nb("chaudHash")}) `
      + `differe du rendu a froid (${nb("froidLen")} car., ${nb("froidHash")}): une tuile n'a pas ete remise a jour`
      + "\n  ECART " + JSON.stringify(v["ecart"]);
  return true;
});

// SELECTIONNER NE CHANGE QUE LE DESSIN D'UNE TUILE, jamais le plan: c'est le cas que la signature
// a le plus de facilite a oublier, et le seul qu'aucune mesure de temps ne rattraperait.
verifier("selectionner_puis_deselectionner_se_voit", () => {
  const m = v["marque"] as unknown as {
    sel: boolean; poignees: number; selLache: boolean; selPris: boolean;
    selApres: boolean; poigneesApres: number;
  };
  if (!m.sel) return "la tuile selectionnee doit porter `.sel` apres un rendu";
  // 4 et non 8: a ce zoom la tuile est sous `RSZ_COMPACT_PX`, donc G-20 ne garde que les coins.
  if (m.poignees !== 4) return `4 poignees de redimension attendues (G-20, tuile compacte), vu ${m.poignees}`;
  if (m.selLache) return "changer de selection doit RETIRER `.sel` de la tuile lachee";
  if (!m.selPris) return "changer de selection doit POSER `.sel` sur la tuile prise";
  if (m.selApres) return "`.sel` doit partir au rendu qui suit la deselection";
  if (m.poigneesApres !== 0) return `0 poignee attendue apres deselection, vu ${m.poigneesApres}`;
  return true;
});

const ko = resultats.filter((r) => !r.ok).length;
console.log(`\n${ko ? `FAILURES ${ko}/${resultats.length}` : `OK ${resultats.length}/${resultats.length}`}`);
process.exit(ko ? 1 : 0);
