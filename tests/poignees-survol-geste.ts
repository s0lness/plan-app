#!/usr/bin/env node
// =============================================================================
//  WALL HANDLES ON HOVER, REAL MOUSE THROUGH CDP
// =============================================================================
// The wall body is now a drawing surface. Moving and selecting a partition belongs to its visible
// move handle, including the facade variant which deliberately selects without moving geometry.

import type { VerdictSonde } from "./_types.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

type CibleCDP = { type: string; webSocketDebuggerUrl: string };
type ReponseCDP = { id?: number; result?: { result?: { value?: unknown }; exceptionDetails?: unknown } };
type Point = { x: number; y: number };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const APP = process.argv[2] || path.join(__dirname, "..", "index.html");
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "plan-rev177.json"), "utf8"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-poignees-survol-"));
const htmlPath = path.join(dir, "case.html");
fs.writeFileSync(htmlPath, `<!doctype html><html><head><meta charset="utf-8"><script>
window.__PLAN_TEST__=1; try{localStorage.clear();localStorage.setItem("room-planner-v4",${JSON.stringify(JSON.stringify(SEED))})}catch(e){}
<\/script></head><body>${fs.readFileSync(APP, "utf8")}</body></html>`, "utf8");

const profile = path.join(dir, "profile");
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  "--no-default-browser-check", "--hide-scrollbars", "--user-data-dir=" + profile,
  "--remote-debugging-port=0", "--window-size=1680,1000", "about:blank"],
  { stdio: ["ignore", "pipe", "pipe"] });
const portFile = path.join(profile, "DevToolsActivePort");
for (let i = 0; i < 300 && !fs.existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 50));
if (!fs.existsSync(portFile)) throw new Error("no DevToolsActivePort");
const port = fs.readFileSync(portFile, "utf8").split("\n")[0]!.trim();
const cibles = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as CibleCDP[];
const page = cibles.find((t) => t.type === "page")!;
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let msgId = 0;
const pending = new Map<number, (m: ReponseCDP) => void>();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id)!; pending.delete(m.id); p(m); } };
function send(method: string, params: Record<string, unknown> = {}) {
  const id = ++msgId;
  return new Promise<ReponseCDP>((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expr: string): Promise<any> {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error("EVAL: " + JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}
const J = async (expr: string) => JSON.parse(await evaluate(`JSON.stringify(${expr})`));
await send("Page.enable"); await send("Runtime.enable");

async function reload() {
  await send("Page.navigate", { url: "file:///" + htmlPath.replace(/\\/g, "/") });
  for (let i = 0; i < 200; i++) {
    let ready = ""; try { ready = await evaluate("document.readyState+'|'+(window.__plan?1:0)"); } catch (_) {}
    if (ready === "complete|1") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("application non prête");
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mouse = (type: string, p: Point, extra: Record<string, unknown> = {}) => send("Input.dispatchMouseEvent", {
  type, x: p.x, y: p.y, button: type === "mouseMoved" ? "none" : "left",
  buttons: type === "mousePressed" ? 1 : 0, clickCount: 1, pointerType: "mouse", ...extra,
});
async function move(p: Point) { await mouse("mouseMoved", p); await pause(90); }
async function click(p: Point) { await move(p); await mouse("mousePressed", p); await mouse("mouseReleased", p); await pause(100); }
async function drag(a: Point, b: Point) {
  await move(a); await mouse("mousePressed", a);
  for (let i = 1; i <= 14; i++) { await mouse("mouseMoved", { x: a.x + (b.x - a.x) * i / 14, y: a.y + (b.y - a.y) * i / 14 }, { buttons: 1 }); await pause(8); }
  await mouse("mouseReleased", b); await pause(150);
}

const center = (selector: string) => J(`(function(){var e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;var r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
const apt = (x: number, y: number) => J(`(function(){var p=__plan.aptToScreen(${x},${y}),r=document.getElementById("viewport").getBoundingClientRect();return{x:r.left+p.x,y:r.top+p.y}})()`);
const wall = (id: string) => J(`(function(){var w=__plan.v5WallById(${JSON.stringify(id)});return w?{a:w.a,b:w.b,isOutline:!!w.isOutline}:null})()`);
const handles = (id: string) => J(`Array.from(document.querySelectorAll('[data-w="'+${JSON.stringify(id)}+'"]')).filter(function(e){return /v5w(move|end|mid)|v5wx/.test(e.className)}).map(function(e){var r=e.getBoundingClientRect();return{c:e.className,x:r.left,y:r.top,w:r.width,h:r.height}})`);

/** TOUTES les poignees presentes, quelle que soit leur classe: c'est ce qui rend le garde
 *  ci-dessous insensible au nom qu'on donnera a la prochaine. */
const toutesPoignees = () => J(`Array.from(document.querySelectorAll(".vtx,.mid,.edge,[class^=v5w]"))
  .filter(function(e){ return !/v5wall|v5wband/.test(e.className); })
  .map(function(e){ return e.className + ":" + (e.dataset.w || ""); })`);

const results: VerdictSonde[] = [];
let cur: VerdictSonde;
function ok(cond: unknown, msg: string) { if (!cond) cur.fails.push(msg); return !!cond; }
async function test(name: string, fn: () => Promise<void>) {
  cur = { name, fails: [] }; await reload();
  try { await fn(); } catch (e) { cur.fails.push("EXCEPTION: " + ((e as Error)?.stack || e)); }
  results.push(cur); console.log(`  ${cur.fails.length ? "FAIL " : "ok   "} ${name}`);
  cur.fails.forEach((f) => console.log("        - " + f));
}
async function seed(length = 200, withPiece = false, wallDoesNotCutCells = false) {
  await evaluate(`__plan.setModel({outline:[[0,0],[420,0],[420,360],[0,360]],walls:[
    {id:"w1",a:[100,80],b:[100,${80 + length}],t:12,free:1${wallDoesNotCutCells ? ",isOutline:1" : ""}},
    {id:"o0",a:[0,0],b:[420,0],t:12,isOutline:1},{id:"o1",a:[420,0],b:[420,360],t:12,isOutline:1},
    {id:"o2",a:[420,360],b:[0,360],t:12,isOutline:1},{id:"o3",a:[0,360],b:[0,0],t:12,isOutline:1}
  ],openings:[],pieces:${withPiece ? `[{id:"p1",type:"chair",name:"Chair",x:70,y:150,w:60,h:60,rot:0,locked:false}]` : "[]"},
    cells:[{id:"c1",name:"Room",floor:"plain",poly:[[0,0],[420,0],[420,360],[0,360]]}]});true`);
  await pause(120);
}

await test("survol_par_defaut_et_trajet_vers_poignee_conservent_les_poignees", async () => {
  await seed(200); await move(await apt(100, 120));
  ok((await handles("w1")).some((h: any) => h.c.includes("v5wmove")), "le mode par défaut doit révéler move au survol du mur");
  const h = await center('.v5wmove[data-w="w1"]'); if (!h) return;
  await move(h);
  ok((await handles("w1")).length > 0, "passer du mur à une poignée doit conserver les poignées en mode par défaut");
});

await test("meuble_sur_mur_reste_la_cible_visible", async () => {
  await seed(200, false, true);
  const setup = await J(`(function(){var p=__plan.addV5Piece("chair",70,150),vr=document.getElementById('viewport').getBoundingClientRect(),s=__plan.aptToScreen(p.x+p.w/2,p.y+p.h/2);
    return{pid:String(p.id),wid:"w1",px:vr.left+s.x,py:vr.top+s.y,locked:p.locked,mount:__plan.isWallMount(p.type)}})()`);
  await pause(100); await move(await apt(100, 100));
  ok((await handles(setup.wid)).length > 0, "précondition: le mur doit avoir ses poignées en mode par défaut");
  const p = { x: setup.px, y: setup.py }; if (!ok(await center(`.piece[data-id="${setup.pid}"]`), "meuble superposé au mur absent")) return;
  await move(p);
  ok(await evaluate(`document.elementFromPoint(${p.x},${p.y})?.closest('.piece[data-id="${setup.pid}"]')!==null`) === true,
    "le meuble peint au-dessus du mur doit gagner le hit test");
  const before = await J(`(function(){var p=__plan.state.plan.pieces.find(function(x){return String(x.id)===${JSON.stringify(setup.pid)}});return{x:p.x,y:p.y}})()`);
  await mouse("mousePressed", p);
  ok(!setup.locked && !setup.mount, `le meuble de contrôle doit être déplaçable, vu ${JSON.stringify(setup)}`);
  ok(await evaluate(`String(__plan.selId)`) === setup.pid, "le pointerdown visible doit sélectionner le meuble");
  for (let i = 1; i <= 10; i++) { await mouse("mouseMoved", { x: p.x + 120 * i / 10, y: p.y }, { button: "left", buttons: 1 }); await pause(8); }
  const after = await J(`(function(){var p=__plan.state.plan.pieces.find(function(x){return String(x.id)===${JSON.stringify(setup.pid)}});return{x:p.x,y:p.y}})()`);
  ok(after.x !== before.x || after.y !== before.y, `le glissement doit déplacer le meuble, vu ${JSON.stringify({ before, after })}`);
  await mouse("mouseReleased", { x: p.x + 120, y: p.y }); await pause(120);
  ok(await wall(setup.wid) !== null, "le mur sous le meuble ne doit pas être remplacé par le geste");
});

await test("corps_en_mode_par_defaut_dessine_un_nouveau_mur", async () => {
  await seed(200); await move(await apt(100, 120));
  ok((await handles("w1")).length > 0, "précondition: le survol par défaut doit révéler les poignées");
  const before = await wall("w1"), a = await apt(100, 130), b = await apt(260, 130);
  await drag(a, b);
  ok(await evaluate(`__plan.state.plan.walls.filter(function(w){return !w.isOutline}).length`) === 2, "le corps doit rester une origine de dessin en mode par défaut");
  ok(JSON.stringify(await wall("w1")) === JSON.stringify(before), "dessiner depuis le corps ne doit pas déplacer le mur existant");
});

await test("clic_propre_sur_corps_par_defaut_n_ecrit_rien", async () => {
  await seed(200); const p = await apt(100, 130); await move(p);
  ok((await handles("w1")).length > 0, "précondition: le survol par défaut doit révéler les poignées");
  const before = await evaluate(`JSON.stringify(__plan.serialize())`), undo = await evaluate(`String(__plan.histInfo().undo)`);
  await click(p);
  ok(await evaluate(`__plan.state.plan.walls.filter(function(w){return !w.isOutline}).length`) === 1, "un clic trop court ne doit créer aucun mur");
  ok(await evaluate(`String(__plan.histInfo().undo)`) === undo, "un clic propre sur le corps ne doit ajouter aucun historique");
  ok(await evaluate(`JSON.stringify(__plan.serialize())`) === before, "un clic propre sur le corps doit laisser le plan octet pour octet identique");
});

await test("supprimer_le_mur_survole_efface_ses_poignees", async () => {
  await seed(200); await move(await apt(100, 120));
  ok((await handles("w1")).length > 0, "précondition: les poignées du mur survolé doivent être peintes");
  await evaluate(`__plan.delWall("w1");true`); await pause(120);
  ok(await wall("w1") === null, "le mur survolé doit être supprimé");
  ok((await handles("w1")).length === 0, "un hoverWall périmé ne doit peindre aucune poignée fantôme");
});

await test("survol_et_trajet_vers_poignee_conservent_les_poignees", async () => {
  await seed(); const p = await apt(100, 180); await move(p);
  const cible = await evaluate(`(function(){var e=document.elementFromPoint(${p.x},${p.y});return e?e.tagName+"."+e.className+"|"+(e.getAttribute("data-w")||""):"none"})()`);
  ok((await handles("w1")).some((h: any) => h.c.includes("v5wmove")), `survoler la bande doit révéler la poignée de déplacement, cible=${cible}`);
  const h = await center('.v5wmove[data-w="w1"]'); if (!h) return;
  await move(h);
  ok((await handles("w1")).some((x: any) => x.c.includes("v5wmove")), "passer de la bande à sa poignée ne doit pas faire disparaître les poignées");
});

await test("clic_propre_move_selectionne_sans_ecrire", async () => {
  await seed(); await move(await apt(100, 180)); const h = await center('.v5wmove[data-w="w1"]');
  if (!ok(h, "poignée move absente")) return;
  const before = await evaluate(`JSON.stringify(__plan.serialize())`), undo = await evaluate(`String(__plan.histInfo().undo)`);
  await click(h);
  ok(await evaluate(`String(__plan.v5ui.selWall)`) === "w1", "un clic propre doit sélectionner le mur");
  ok(await evaluate(`String(__plan.histInfo().undo)`) === undo, "un clic propre ne doit pas ajouter d'historique");
  ok(await evaluate(`JSON.stringify(__plan.serialize())`) === before, "un clic propre doit laisser le plan octet pour octet identique");
});

await test("glisser_move_deplace_les_deux_bouts_du_meme_delta", async () => {
  await seed(); await move(await apt(100, 180)); const h = await center('.v5wmove[data-w="w1"]'), before = await wall("w1");
  if (!ok(h && before, "mur ou poignée move absent")) return;
  await drag(h, { x: h.x + 70, y: h.y }); const after = await wall("w1");
  const da = [after.a[0] - before.a[0], after.a[1] - before.a[1]], db = [after.b[0] - before.b[0], after.b[1] - before.b[1]];
  ok(Math.hypot(...da) > 10, "le mur entier doit se déplacer");
  ok(Math.hypot(da[0] - db[0], da[1] - db[1]) < 1, `les deux bouts doivent avoir le même delta, vu ${JSON.stringify({ da, db })}`);
});

await test("glisser_corps_dessine_un_nouveau_mur", async () => {
  await seed(); const before = await wall("w1"), a = await apt(100, 150), b = await apt(260, 150);
  await drag(a, b); const after = await wall("w1");
  ok(await evaluate(`__plan.state.plan.walls.filter(function(w){return !w.isOutline}).length`) === 2, "glisser depuis le corps doit dessiner une nouvelle cloison");
  ok(JSON.stringify(after) === JSON.stringify(before), "le corps ne doit plus déplacer le mur existant");
});

await test("facade_selectionnee_revele_le_contour_sans_commandes_interieures", async () => {
  await seed(); const id = await evaluate(`String(__plan.state.plan.walls.find(function(w){return w.isOutline}).id)`);
  await move(await apt(200, 0)); const h = await center(`.v5wmove[data-w="${id}"]`); if (!ok(h, "poignée de sélection de façade absente")) return;
  await click(h);
  ok(await evaluate(`String(__plan.v5ui.selWall)`) === id, "la poignée doit sélectionner la façade");
  ok(await center(`.edge[data-w="${id}"]`), "sélectionner la façade doit révéler sa bande de contour");
  ok(await evaluate(`document.querySelector('.v5wx[data-w="${id}"],.v5wmid[data-w="${id}"]')===null`) === true, "une façade ne doit offrir ni suppression ni coude");
});

// UN MUR COURT RÉTRÉCIT SES POIGNÉES, IL N'EN SUPPRIME PLUS. La priorité d'avant les faisait
// tomber sous 48 px, et c'est le défaut que le propriétaire a signalé: sur une cloison de 47 cm il
// ne restait qu'une poignée sur cinq, et l'élément sous la pointe du mur appartenait au mur VOISIN,
// donc viser un bout attrapait celui d'à côté. Les bouts sont ce que ce mur a de plus utile: ils ne
// disparaissent jamais, ils réduisent, et la position reste vraie.
await test("mur_court_garde_ses_bouts_et_aucune_poignee_ne_se_recouvre", async () => {
  await seed(60); await move(await apt(100, 110)); const hs = await handles("w1");
  ok(hs.some((h: any) => h.c.includes("v5wmove")), "la poignée move doit toujours rester visible");
  ok(hs.filter((h: any) => h.c.includes("v5wend")).length === 2,
    `les DEUX bouts doivent rester, vu ${JSON.stringify(hs.map((h: any) => h.c))}`);
  ok(hs.every((h: any) => h.w <= 20 && h.h <= 20), "sur un mur court les poignées doivent avoir rétréci");
  for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) {
    const a = hs[i], b = hs[j], overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    ok(!overlap, `deux poignées visibles se recouvrent: ${a.c} et ${b.c}`);
  }
});

// UNE LISTE DE NETTOYAGE TENUE A LA MAIN SE FAIT OUBLIER, et c'est arrive: `.v5wjoin` manquait
// dans le selecteur qui retire les poignees avant de les redessiner, donc les "-" de fusion ne
// partaient jamais et survivaient meme a la suppression de leur mur. Le proprietaire a vu deux "-"
// flotter en plein vide. Ce cas ne teste pas une classe, il teste le MODE DE PANNE: apres avoir
// supprime le mur survole, il ne doit rester aucune poignee, quel que soit son nom.
await test("supprimer_un_mur_ne_laisse_aucune_poignee_fantome", async () => {
  await seed(200);
  await move(await apt(100, 150));
  // ON COUPE D'ABORD, sinon aucun "-" n'existe et le garde ne prouverait rien: c'est la coupe qui
  // cree une jonction fusionnable, donc le controle de fusion qui a fui.
  const plus = await center('.v5wmid[data-w="w1"]');
  if (!ok(plus, "poignee de coupe introuvable")) return;
  await move(plus); await pause(120);
  await mouse("mousePressed", plus); await mouse("mouseReleased", plus);
  await pause(300);
  await move(await apt(100, 120)); await pause(250);
  ok((await toutesPoignees()).some((c: string) => c.startsWith("v5wjoin")),
    `precondition: la coupe doit faire apparaitre un "-", vu ${JSON.stringify(await toutesPoignees())}`);
  // Supprime par le VRAI geste, la croix du mur survole, pas par une API de sonde.
  const croix = await center('.v5wx[data-w="w1"]');
  if (!ok(croix, "croix de suppression introuvable")) return;
  await move(croix); await pause(120);
  await mouse("mousePressed", croix); await mouse("mouseReleased", croix);
  await pause(300);
  ok(await evaluate(`String(__plan.state.plan.walls.filter(function(w){return !w.isOutline}).length)`) === "1",
    "precondition: la croix doit avoir supprime une des deux moities");
  await move(await apt(360, 40));
  await pause(250);
  const restantes = await toutesPoignees();
  ok(restantes.length === 0, `aucune poignee ne doit survivre au mur supprime, vu ${JSON.stringify(restantes)}`);
});

const bad = results.filter((r) => r.fails.length);
console.log("");
if (bad.length) { console.log(`FAILURES ${bad.length}/${results.length}:`); bad.forEach((r) => r.fails.forEach((f) => console.log(`  - ${r.name}: ${f}`))); }
else console.log(`OK ${results.length}/${results.length}`);
ws.close(); chrome.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
process.exit(bad.length ? 1 : 0);
