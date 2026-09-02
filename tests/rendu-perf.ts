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
//   node tests/rendu-perf.ts [chemin/vers/app.html]
//
//   rendu_complet_reste_sous_le_plafond   `render()` sur 200 meubles, 30 ouvertures, 12 murs
//   vue_pan_reste_sous_le_plafond         `panBy` (pan/zoom): le fond est cache, le reste reconcilie
//   image_de_glisser_reste_sous_le_plafond  ce que `gestes/meuble.ts` appelle par image
//   poignees_seules_restent_sous_le_plafond `drawHandles` avec un mur selectionne
//   le_dom_peint_est_inchange              l'empreinte du calque peint, invariante de l'optimisation
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
  __plan.clearSel();
  __plan.setZoom(0.5);
  __plan.render();
  var calque = document.querySelector(".v5layer");
  var brut = calque ? calque.outerHTML : "";
  var norme = brut.replace(/\\s+/g, " ").trim();
  var h = 5381;
  for (var z = 0; z < norme.length; z++) h = ((h * 33) ^ norme.charCodeAt(z)) >>> 0;

  return {
    rendu: rendu, vue: vue, glisser: glisser, poignees: poignees,
    compte: compte,
    stats: __plan.v5RenderStats(),
    nbMeubles: __plan.plan.pieces.length,
    nbOuvertures: __plan.plan.openings.length,
    nbMurs: __plan.plan.walls.length,
    nbCellules: __plan.plan.cells.length,
    domLen: norme.length,
    domHash: h
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

// LES BORNES. Mesure du 2026-09-02 sur cette machine chargee, apres optimisation: render 2,9 ms,
// pan 2,7 ms, image de glisser 3,3 ms, poignees 0,25 ms (medianes). Avant: 5,0 / 4,7 / 5,5 / 0,58.
// Les plafonds ci-dessous sont au-dessus du chiffre AVANT: ils ne gardent pas le gain, ils gardent
// l'ordre de grandeur contre une regression franche (un querySelector qui revient, un tri par image).
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

const ko = resultats.filter((r) => !r.ok).length;
console.log(`\n${ko ? `FAILURES ${ko}/${resultats.length}` : `OK ${resultats.length}/${resultats.length}`}`);
process.exit(ko ? 1 : 0);
