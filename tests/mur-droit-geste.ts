#!/usr/bin/env node
// =============================================================================
//  "UN MUR DE TRAVERS SE REDRESSE, ET SEULEMENT LUI": VRAIE SOURIS (CDP)
// =============================================================================
// Signalé par le propriétaire: « the vertical wall on the right is slightly off, i want a way to
// make it perpendicular », puis « automatiquement », puis « it should snap ».
//
// CE QUI EST MESURÉ, ET POURQUOI UN AIMANT NE POUVAIT PAS SUFFIRE. Sur son plan réel (22 murs),
// deux murs ne sont ni horizontaux ni verticaux: `w3` (154 cm, 0,373°) et `w7` (146 cm, 0,392°),
// soit 1 cm de décalage au bout de chacun. Et leurs quatre bouts sont des JONCTIONS, donc
// `v5BoutJoint` leur retire toute poignée de bout: survolés, ils ne rendent que le disque qui
// déplace, le « + » qui coupe et la croix qui supprime. Aucun geste de ces murs-là ne pouvait
// fixer leur direction, donc aucun aimant posé sur un geste n'avait de prise.
//
// La réponse est un BOUTON qui n'existe que sur un mur de travers (`v5MurDeTravers`) et le
// redresse au clic. Ce que cette suite vérifie: il redresse vraiment les deux murs du VRAI plan,
// il ne pousse pas les murs voisins dans le vide, il ne s'affiche ni sur un mur d'équerre ni sur
// une oblique voulue, il le DIT, il s'annule, et rien ne se redresse tout seul au chargement.
//
//   node tests/mur-droit-geste.ts [chemin/vers/app.html]
//   PLAN_PNG=C:\tmp node tests/mur-droit-geste.ts     # capture du bouton sous la main
//
// Vraie souris (`Input.dispatchMouseEvent`), jamais un PointerEvent synthétique, et on attend une
// CONDITION, jamais une durée.

import type { VerdictSonde } from "./_types.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

type CibleCDP = { type: string; webSocketDebuggerUrl: string };
type ValeurPage = ReturnType<typeof JSON.parse>;
type ReponseCDP = {
  id?: number;
  result?: { result?: { value?: unknown }; exceptionDetails?: { exception?: unknown }; [cle: string]: unknown };
  [cle: string]: unknown;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const APP = process.argv[2] || path.join(__dirname, "..", "index.html");
const PNG = process.env["PLAN_PNG"] || "";
// LE VRAI PLAN, pas une figure de laboratoire: `w3` et `w7` y sont, de travers, depuis la
// conversion de l'ancien format.
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "plan-reel-77.json"), "utf8"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-mur-droit-"));
const htmlPath = path.join(dir, "case.html");
fs.writeFileSync(htmlPath,
  `<!doctype html><html><head><meta charset="utf-8"><script>
window.__PLAN_TEST__=1;
try{ localStorage.clear(); localStorage.setItem("room-planner-v4", ${JSON.stringify(JSON.stringify(SEED))}); }catch(e){}
<\/script></head><body>` + fs.readFileSync(APP, "utf8") + "</body></html>",
  "utf8");

const profile = path.join(dir, "profile");
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  "--no-default-browser-check", "--hide-scrollbars",
  "--user-data-dir=" + profile, "--remote-debugging-port=0",
  "--window-size=1680,1000", "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });

const portFile = path.join(profile, "DevToolsActivePort");
async function waitPort() {
  for (let i = 0; i < 300; i++) {
    if (fs.existsSync(portFile)) {
      let t: VerdictSonde[] = [];
      try { t = fs.readFileSync(portFile, "utf8").split("\n"); } catch { t = []; }
      if (t[0] && /^[0-9]+$/.test(t[0].trim())) return t[0].trim();
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("no DevToolsActivePort");
}
const port = await waitPort();
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as CibleCDP[];
const page = list.find((t) => t.type === "page")!;
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let msgId = 0;
const pending = new Map<number, (message: ReponseCDP) => void>();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id)!; pending.delete(m.id); p(m); }
};
function send(method: string, params?: Record<string, unknown>) {
  const id = ++msgId;
  return new Promise<ReponseCDP>((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); });
}
async function evaluate(expr: string): Promise<ValeurPage> {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  const d = r.result || {};
  if (d.exceptionDetails) throw new Error("EVAL: " + JSON.stringify(d.exceptionDetails.exception || d.exceptionDetails));
  return d.result ? d.result.value : undefined;
}
const J = async (expr: string) => JSON.parse(await evaluate(`JSON.stringify(${expr})`));
await send("Page.enable");
await send("Runtime.enable");

async function reload() {
  await send("Page.navigate", { url: "file:///" + htmlPath.replace(/\\/g, "/") });
  for (let i = 0; i < 200; i++) {
    let st = null;
    try { st = await evaluate("document.readyState + '|' + (window.__plan ? 1 : 0)"); } catch (_) {}
    if (st === "complete|1") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("application non prête");
}

const M = (type: string, x: VerdictSonde, y: VerdictSonde, extra?: Record<string, unknown>) => send("Input.dispatchMouseEvent", Object.assign({
  type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1,
  clickCount: 1, pointerType: "mouse",
}, extra || {}));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ON ATTEND UNE CONDITION, JAMAIS UNE DURÉE (AGENTS.md). Rend ce que la sonde a fini par voir. */
async function attendre<T>(sonde: () => Promise<T>, tenu: (v: T) => boolean, ms = 5000): Promise<T> {
  const t0 = Date.now();
  let v = await sonde();
  while (!tenu(v) && Date.now() - t0 < ms) { await pause(25); v = await sonde(); }
  return v;
}

const results: VerdictSonde[] = [];
let cur: VerdictSonde = null;
function ok(cond: unknown, msg?: string) { if (!cond) cur.fails.push(msg); return !!cond; }
async function test(name: string, fn: () => Promise<void>) {
  cur = { name, fails: [] };
  await reload();
  try { await fn(); } catch (e) { cur.fails.push("EXCEPTION: " + (e && (e as Error).stack || e)); }
  const jsErr = await evaluate(`JSON.stringify((JSON.parse(localStorage.getItem("plan-errors")||"[]")||[]).map(function(e){return e&&e.msg}))`);
  if (jsErr && jsErr !== "[]") cur.fails.push("erreurs JS: " + jsErr);
  results.push(cur);
  console.log(`  ${cur.fails.length ? "FAIL " : "ok   "} ${name}`);
  cur.fails.forEach((f: VerdictSonde) => console.log("        - " + f));
}

const centerOf = (sel: string) => J(`(function(){var e=document.querySelector(${JSON.stringify(sel)});
  if(!e) return null; var r=e.getBoundingClientRect(); if(!r.width&&!r.height) return null;
  return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
const aptPoint = (x: number, y: number) => J(`(function(){var s=__plan.aptToScreen(${x},${y});
  var r=document.getElementById("viewport").getBoundingClientRect(); return {x:r.left+s.x,y:r.top+s.y};})()`);

/** L'ÉCART À L'ÉQUERRE de chaque mur, en degrés, mesuré sur le MODÈLE et pas sur l'écran. */
const ecarts = () => J(`(function(){var o={};__plan.state.plan.walls.forEach(function(w){
  var dx=w.b[0]-w.a[0], dy=w.b[1]-w.a[1], h=Math.abs(dx)>=Math.abs(dy);
  o[String(w.id)]=Math.round(Math.abs(Math.atan2(h?dy:dx, h?Math.abs(dx):Math.abs(dy))*180/Math.PI)*1000)/1000;});
  return o;})()`);
const mur = (id: string) => J(`(function(){var w=__plan.state.plan.walls.filter(function(x){return String(x.id)===${JSON.stringify(id)}})[0];
  return w?{a:w.a,b:w.b,free:!!w.free}:null;})()`);
const boutons = () => J(`__plan.handleCount()`);

/**
 * SURVOLER LE MUR RÉVÈLE SES BOUTONS, exactement comme à la main: les poignées ne sont peintes
 * que pour le mur sous le pointeur (`brancherSurvolMurs`). On vise le MILIEU du mur, là où la
 * bande se saisit, puis on attend que le bouton demandé existe.
 */
async function survolerEtTrouver(id: string, sel: string) {
  const w = await mur(id);
  if (!w) return null;
  // PLUSIEURS POINTS LE LONG DU MUR, et ce n'est pas de la superstition: un MEUBLE retient le
  // survol d'un mur mais n'en DÉMARRE jamais un (`brancherSurvolMurs`, `rendu/calque.ts`), et sur
  // le plan réel à 47 objets, le milieu d'une cloison est souvent occupé. On cherche donc un point
  // du mur qui soit libre, exactement comme la main le ferait.
  for (const f of [0.5, 0.35, 0.65, 0.2, 0.8]) {
    const p = await aptPoint(w.a[0] + (w.b[0] - w.a[0]) * f, w.a[1] + (w.b[1] - w.a[1]) * f);
    await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 });
    const v = await attendre(() => centerOf(`.v5wmove[data-w="${id}"]`), (q) => !!q, 900);
    if (!v) continue;
    return sel === ".v5wmove" ? v : await attendre(() => centerOf(`${sel}[data-w="${id}"]`), (q) => !!q, 900);
  }
  return null;
}

/** Un CLIC franc, sans un pixel de déplacement: le bouton agit au clic, comme le « + ». */
async function cliquer(p: VerdictSonde) {
  await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 });
  await M("mousePressed", p.x, p.y);
  await M("mouseReleased", p.x, p.y, { buttons: 0 });
}

// LE CAS DU PROPRIÉTAIRE, SUR SON VRAI PLAN. `w3` et `w7` sont à 0,373° et 0,392°, chacun avec 1 cm
// de décalage au bout; deux clics et le mur vertical de droite est droit. Et les deux murs
// horizontaux qui s'appuyaient dessus (`w4`, `w6`) le rejoignent tout seuls, parce qu'ils sont
// TRAVERSANTS: personne n'est laissé dans le vide.
await test("les_deux_murs_de_travers_du_vrai_plan_se_redressent", async () => {
  const avant = await attendre(ecarts, (e) => !!e["w3"]);
  ok(avant["w3"] > 0.3 && avant["w3"] < 0.5, `w3 doit partir de travers (~0,373°), vu ${avant["w3"]}`);
  ok(avant["w7"] > 0.3 && avant["w7"] < 0.5, `w7 doit partir de travers (~0,392°), vu ${avant["w7"]}`);
  for (const id of ["w3", "w7"]) {
    const bouton = await survolerEtTrouver(id, ".v5wdroit");
    if (!ok(bouton, `${id} de travers doit porter l'équerre`)) continue;
    if (PNG && id === "w3") {
      const shot = await send("Page.captureScreenshot", {
        format: "png",
        clip: { x: bouton.x - 130, y: bouton.y - 60, width: 260, height: 120, scale: 4 },
      });
      fs.writeFileSync(path.join(PNG, "equerre-sous-la-main.png"),
        Buffer.from(String((shot.result as { data: string }).data), "base64"));
    }
    await cliquer(bouton);
    const apres = await attendre(ecarts, (e) => e[id] === 0);
    ok(apres[id] === 0, `${id} doit être d'équerre après le clic, vu ${apres[id]}°`);
  }
  const fin = await ecarts();
  ok(fin["w3"] === 0 && fin["w7"] === 0, `les deux murs doivent être droits, vu w3=${fin["w3"]}° w7=${fin["w7"]}°`);
  const w3 = await mur("w3"), w7 = await mur("w7"), w4 = await mur("w4"), w6 = await mur("w6");
  ok(w3.a[0] === w3.b[0] && w7.a[0] === w7.b[0],
    `le mur vertical de droite doit tenir sur un seul x, vu ${JSON.stringify([w3, w7])}`);
  ok(Math.abs(w4.a[0] - w3.b[0]) <= 1, `w4 doit rejoindre la nouvelle droite, vu ${JSON.stringify(w4)}`);
  ok(Math.abs(w6.a[0] - w7.b[0]) <= 1, `w6 doit rejoindre la nouvelle droite, vu ${JSON.stringify(w6)}`);
  // ET LE MUR REDRESSÉ NE S'ENFUIT PAS. Traversant, son bout tout juste déplacé ne touche plus rien
  // pendant une image et `v5ThroughWall` l'envoyait jusqu'à la façade (mesuré: 154 cm -> 716 cm).
  ok(Math.abs(w3.b[1] - w3.a[1]) < 200, `w3 doit garder sa longueur, vu ${JSON.stringify(w3)}`);
});

// UN MUR D'ÉQUERRE NE PORTE PAS L'ÉQUERRE, et un défaut invisible non plus. `w2` est à 0,003°, soit
// 0,1 mm sur 164 cm: sans le plancher de 0,5 cm il porterait le bouton, et un bouton posé sur un
// défaut qu'on ne voit pas est du bruit.
await test("ni_un_mur_droit_ni_un_defaut_invisible_ne_portent_l_equerre", async () => {
  await attendre(ecarts, (e) => !!e["w3"]);
  for (const id of ["w4", "w5", "w2"]) {
    // La poignée de déplacement PROUVE que le survol a bien pris: sans elle, un « zéro équerre »
    // ne mesurerait que l'absence de survol.
    ok(await survolerEtTrouver(id, ".v5wmove"), `le survol de ${id} doit révéler ses poignées`);
    const n = await boutons();
    ok(n.droit === 0, `${id} ne doit porter aucune équerre, vu ${JSON.stringify(n)}`);
  }
  const e = await ecarts();
  ok(e["w2"] > 0 && e["w2"] < 0.01, `w2 doit rester le cas limite mesuré (0,003°), vu ${e["w2"]}`);
});

// UNE OBLIQUE VOULUE RESTE TENABLE. Le bouton ne retire AUCUN angle, à la différence d'un aimant:
// il se contente de ne pas exister. Mesuré ici sur le seuil, 1,9° contre 2,1°, et sur un pan coupé.
await test("une_oblique_voulue_ne_porte_pas_l_equerre", async () => {
  const poser = async (deg: number, L = 300) => {
    const rad = deg * Math.PI / 180;
    await evaluate(`__plan.setModel({outline:[[0,-800],[1600,-800],[1600,800],[0,800]],walls:[
      {id:"ob",a:[100,0],b:[${(100 + L * Math.cos(rad)).toFixed(2)},${(L * Math.sin(rad)).toFixed(2)}],t:12,isOutline:0,free:1}
    ],openings:[],pieces:[],cells:[]}); true`);
    await attendre(() => mur("ob"), (w) => !!w);
    ok(await survolerEtTrouver("ob", ".v5wmove"), `le survol du mur à ${deg}° doit révéler ses poignées`);
    return (await boutons()).droit;
  };
  ok(await poser(1) === 1, "à 1° du droit sur 300 cm (5,2 cm de bout), l'équerre doit être offerte");
  ok(await poser(1.9) === 1, "à 1,9° sur 300 cm (9,9 cm), encore offerte");
  ok(await poser(2.1) === 0, "à 2,1° sur 300 cm (11,0 cm), l'oblique est un choix: aucune équerre");
  ok(await poser(10) === 0, "à 10°, aucune équerre");
  ok(await poser(45) === 0, "un pan coupé à 45° ne doit jamais porter d'équerre");
  // ET LE SECOND PLAFOND, celui du DÉPLACEMENT: 1° sur 12 m, c'est 21 cm de bout, soit presque deux
  // épaisseurs de mur. Corriger de plus que la maçonnerie elle-même n'est plus une correction, et ça
  // ne se déclenche pas depuis un petit disque.
  ok(await poser(1, 1200) === 0, "à 1° mais 21 cm de bout, le déplacement dépasse l'épaisseur du mur: aucune équerre");
  ok(await poser(0.5, 1200) === 1, "à 0,5° sur 12 m (10,5 cm), le déplacement tient dans l'épaisseur: offerte");
});

// RIEN NE SE REDRESSE EN SILENCE, ET RIEN NE SE REDRESSE EN MASSE. Le plan réel se charge, on ne
// touche à rien, et les deux murs de travers sont TOUJOURS de travers: aucune passe au chargement,
// aucune renormalisation dans `v5ThroughWall`. C'est la règle d'AGENTS.md, née d'un clic qui
// réécrivait le plan.
await test("rien_ne_se_redresse_tout_seul", async () => {
  const e0 = await attendre(ecarts, (e) => !!e["w3"]);
  ok(e0["w3"] > 0.3 && e0["w7"] > 0.3, `au chargement les deux murs restent de travers, vu ${JSON.stringify([e0["w3"], e0["w7"]])}`);
  // ET UN VRAI GESTE DE GÉOMÉTRIE AILLEURS NE LES REDRESSE PAS DAVANTAGE. On pousse `w15`, à
  // l'autre bout du logement, ce qui fait passer tout le plan par `v5ResoudreGeometrie`: c'est là
  // qu'une passe de masse se cacherait, et c'est exactement le contrôle négatif de ce cas.
  const combien = () => evaluate("__plan.state.plan.walls.length");
  const n0 = await combien();
  const plus = await survolerEtTrouver("w15", ".v5wmid");
  if (!ok(plus, "le « + » de w15 est introuvable")) return;
  await cliquer(plus);
  const n1 = await attendre(combien, (n) => n > n0);
  ok(n1 > n0, `la coupe doit vraiment avoir eu lieu, vu ${n0} murs puis ${n1}`);
  const e1 = await ecarts();
  ok(e1["w3"] === e0["w3"] && e1["w7"] === e0["w7"],
    `un geste de géométrie ailleurs ne redresse rien, vu ${JSON.stringify([e1["w3"], e1["w7"]])} au lieu de ${JSON.stringify([e0["w3"], e0["w7"]])}`);
});

// LE REDRESSEMENT SE DIT, AVEC SES DEUX CHIFFRES. Un déplacement d'1 cm est indistinguable d'un clic
// qui n'a rien fait: sans message, le bouton a l'air mort.
await test("le_redressement_le_dit_avec_ses_chiffres", async () => {
  await attendre(ecarts, (e) => !!e["w3"]);
  const bouton = await survolerEtTrouver("w3", ".v5wdroit");
  if (!ok(bouton, "l'équerre de w3 est introuvable")) return;
  await cliquer(bouton);
  const txt = await attendre(() => evaluate("__plan.toastText"), (t) => !!t && String(t).indexOf("squared up") >= 0);
  ok(txt && String(txt).indexOf("squared up") >= 0, `le redressement doit être annoncé, vu ${JSON.stringify(txt)}`);
  ok(txt && /0\.3[0-9]°/.test(String(txt)), `le message doit porter l'écart corrigé, vu ${JSON.stringify(txt)}`);
  ok(txt && /1\.0 cm/.test(String(txt)), `le message doit porter le déplacement, vu ${JSON.stringify(txt)}`);
});

// UN ALLER-RETOUR REVIENT AU POINT DE DÉPART. Le redressement passe par l'historique ordinaire,
// donc Ctrl+Z rend le mur exactement comme il était, virgule comprise.
await test("le_redressement_s_annule", async () => {
  const avant = await attendre(ecarts, (e) => !!e["w3"]);
  const geo = await mur("w3");
  const bouton = await survolerEtTrouver("w3", ".v5wdroit");
  if (!ok(bouton, "l'équerre de w3 est introuvable")) return;
  await cliquer(bouton);
  ok((await attendre(ecarts, (e) => e["w3"] === 0))["w3"] === 0, "w3 doit d'abord être redressé");
  await evaluate("__plan.undo(); true");
  const apres = await attendre(ecarts, (e) => e["w3"] !== 0);
  ok(apres["w3"] === avant["w3"], `Ctrl+Z doit rendre l'écart exact, vu ${apres["w3"]} au lieu de ${avant["w3"]}`);
  const geo2 = await mur("w3");
  ok(JSON.stringify(geo2.a) === JSON.stringify(geo.a) && JSON.stringify(geo2.b) === JSON.stringify(geo.b),
    `et la géométrie exacte, vu ${JSON.stringify(geo2)} au lieu de ${JSON.stringify(geo)}`);
});

const bad = results.filter((r) => r.fails.length);
console.log("");
if (bad.length) {
  console.log(`FAILURES ${bad.length}/${results.length}:`);
  bad.forEach((r) => r.fails.forEach((f: VerdictSonde) => console.log(`  - ${r.name}: ${f}`)));
} else console.log(`OK ${results.length}/${results.length}`);
ws.close(); chrome.kill();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
process.exit(bad.length ? 1 : 0);
