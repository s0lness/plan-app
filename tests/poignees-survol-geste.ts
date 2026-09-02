#!/usr/bin/env node
// =============================================================================
//  WALL HANDLES ON HOVER, REAL MOUSE THROUGH CDP
// =============================================================================
// The wall body is now a drawing surface. Moving and selecting a partition belongs to its visible
// move handle, including the facade variant which deliberately selects without moving geometry.
//
// ET UN BOUTON DE MUR RESTE ATTEIGNABLE. Deux défauts relevés sur le plan réel du propriétaire, et
// mesurés avant d'être corrigés:
//   - une ÉTIQUETTE DE PIÈCE se pose au pôle de sa cellule et captait le pointeur par-dessus les
//     commandes du mur (z-index 20 contre 9). Au zoom d'ajustement du plan réel à 77 objets,
//     2 disques de déplacement sur 22 étaient sous une étiquette, dont un recouvert entièrement
//     (32x17 px), 4 sur 22 en dézoomant de moitié. Le survol de l'étiquette EFFAÇAIT en plus les
//     poignées du mur visé;
//   - un MUR COURT ne recevait plus rien au-delà de son disque et de ses bouts: un seuil unique de
//     28 px retirait d'un coup la coupe, la croix ET les maillons. Sur le plan réel, au zoom
//     d'ajustement, la cloison de 47 cm (24,3 px) n'était ni coupable ni supprimable, et il fallait
//     zoomer de 15 % de plus pour la retrouver. Dézoomé de moitié: 3 murs sur 22.

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

/** TOUTES les boites de commande d'un mur, classe + rectangle: c'est sur les BOITES que se juge
 *  « deux boutons au meme pixel valent zero bouton », jamais sur la longueur du mur. */
const boitesMur = (id: string) => J(`Array.from(document.querySelectorAll('[data-w="'+${JSON.stringify(id)}+'"]'))
  .filter(function(e){return /v5w(move|end|mid|join)|v5wx/.test(e.className)})
  .map(function(e){var r=e.getBoundingClientRect();return{c:String(e.className),x:r.left,y:r.top,w:r.width,h:r.height}})`);

/** Un point DU MEUBLE qui n'est sous aucune boîte de commande du mur: c'est là que se juge « le
 *  meuble reste la cible visible », les pixels du bouton appartenant désormais au bouton. */
async function pointLibre(pid: string, wid: string): Promise<Point | null> {
  const r = await J(`(function(){var e=document.querySelector('.piece[data-id="'+${JSON.stringify(pid)}+'"]');
    if(!e)return null;var b=e.getBoundingClientRect();return{x:b.left,y:b.top,w:b.width,h:b.height}})()`);
  if (!r) return null;
  const bs = await boitesMur(wid);
  for (let i = 1; i <= 7; i++) for (let j = 1; j <= 7; j++) {
    const p = { x: r.x + r.w * i / 8, y: r.y + r.h * j / 8 };
    if (!bs.some((q: any) => p.x >= q.x - 1 && p.x <= q.x + q.w + 1 && p.y >= q.y - 1 && p.y <= q.y + q.h + 1)) return p;
  }
  return null;
}

interface Verdict { name: string; fails: string[] }
const results: Verdict[] = [];
let cur: Verdict;
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

// CE CAS EST RÉÉCRIT, PAS SUPPRIMÉ. Il pressait le CENTRE du meuble, qui tombait pile sur le
// disque de déplacement du mur: c'était sans conséquence tant que les commandes du mur vivaient
// SOUS les meubles. Elles passent maintenant au-dessus (un contrôle qu'un meuble peut recouvrir
// n'est pas un contrôle), donc ces quelques pixels-là appartiennent au bouton, et c'est le cas
// `le_bouton_du_mur_gagne_le_clic_sous_un_meuble` qui les tient. Ce que ce cas-ci protège n'a pas
// bougé d'un pouce: le CORPS du mur ne dispute rien au meuble peint dessus, partout ailleurs, et
// c'est « partout ailleurs » qui est la surface d'un meuble.
await test("meuble_sur_mur_reste_la_cible_visible", async () => {
  await seed(200, false, true);
  const setup = await J(`(function(){var p=__plan.addV5Piece("chair",70,150),vr=document.getElementById('viewport').getBoundingClientRect(),s=__plan.aptToScreen(p.x+p.w/2,p.y+p.h/2);
    return{pid:String(p.id),wid:"w1",px:vr.left+s.x,py:vr.top+s.y,locked:p.locked,mount:__plan.isWallMount(p.type)}})()`);
  await pause(100); await move(await apt(100, 100));
  ok((await handles(setup.wid)).length > 0, "précondition: le mur doit avoir ses poignées en mode par défaut");
  if (!ok(await center(`.piece[data-id="${setup.pid}"]`), "meuble superposé au mur absent")) return;
  const p = await pointLibre(setup.pid, setup.wid);
  if (!ok(p, "aucun point du meuble n'échappe aux boîtes de commande du mur")) return;
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

// TRACER DEPUIS LE CORPS D'UN MUR FORME UN T, DONC LE COUPE. Ce cas attendait deux murs et un mur
// d'origine intact: c'etait vrai tant qu'un T ne coupait rien. Depuis la demande du proprietaire
// (« relier un bout de mur a un autre doit connecter ces murs ET couper le mur qui forme la barre
// du T »), le mur de depart se scinde au point de contact. Ce qu'on verifie reste le meme: le corps
// est bien une ORIGINE DE DESSIN et non une prise pour deplacer le mur.
await test("corps_en_mode_par_defaut_dessine_un_nouveau_mur_et_coupe_le_T", async () => {
  await seed(200); await move(await apt(100, 120));
  ok((await handles("w1")).length > 0, "précondition: le survol par défaut doit révéler les poignées");
  const before = await wall("w1"), a = await apt(100, 130), b = await apt(260, 130);
  await drag(a, b);
  const murs = await evaluate(`__plan.state.plan.walls.filter(function(w){return !w.isOutline}).length`);
  ok(murs === 3, `le trace doit creer une cloison ET couper le mur de depart, vu ${murs} murs`);
  // Le mur d'origine est raccourci au point de contact, pas deplace: son depart n'a pas bouge.
  const apres = await wall("w1");
  ok(JSON.stringify(apres.a) === JSON.stringify(before.a),
    `le depart du mur d'origine ne doit pas bouger, ${JSON.stringify(before.a)} puis ${JSON.stringify(apres.a)}`);
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

await test("glisser_corps_dessine_un_nouveau_mur_et_coupe_le_T", async () => {
  await seed(); const before = await wall("w1"), a = await apt(100, 150), b = await apt(260, 150);
  await drag(a, b); const after = await wall("w1");
  const murs = await evaluate(`__plan.state.plan.walls.filter(function(w){return !w.isOutline}).length`);
  ok(murs === 3, `glisser depuis le corps doit dessiner une cloison ET couper le T, vu ${murs} murs`);
  ok(JSON.stringify(after.a) === JSON.stringify(before.a),
    "le corps ne doit pas DEPLACER le mur existant: son depart reste identique");
});

await test("facade_selectionnee_revele_le_contour_sans_commandes_interieures", async () => {
  await seed(); const id = await evaluate(`String(__plan.state.plan.walls.find(function(w){return w.isOutline}).id)`);
  await move(await apt(200, 0)); const h = await center(`.v5wmove[data-w="${id}"]`); if (!ok(h, "poignée de sélection de façade absente")) return;
  await click(h);
  ok(await evaluate(`String(__plan.v5ui.selWall)`) === id, "la poignée doit sélectionner la façade");
  ok(await center(`.edge[data-w="${id}"]`), "sélectionner la façade doit révéler sa bande de contour");
  // CE CAS EST REECRIT, PAS SUPPRIME. Il affirmait qu'une facade n'offre NI suppression NI coupe,
  // ce qui etait vrai tant qu'elle n'exposait que son bouton rond. Ce qu'il protege est la regle qui
  // n'a pas bouge: un mur de contour est DERIVE du contour, il ne se supprime pas
  // (`v5WallDeleteVerdict` verdict `facade`), donc aucune croix, jamais. Sa COUPE, elle, existe
  // maintenant, et `tests/facade-controles-geste.ts` la mesure.
  ok(await evaluate(`document.querySelector('.v5wx[data-w="${id}"]')===null`) === true, "une façade ne doit offrir aucune suppression");
});

// UN MUR COURT RÉTRÉCIT SES POIGNÉES, IL N'EN SUPPRIME PLUS. La priorité d'avant les faisait
// tomber sous 48 px, et c'est le défaut que le propriétaire a signalé: sur une cloison de 47 cm il
// ne restait qu'une poignée sur cinq, et l'élément sous la pointe du mur appartenait au mur VOISIN,
// donc viser un bout attrapait celui d'à côté. Les bouts sont ce que ce mur a de plus utile: ils ne
// disparaissent jamais, ils réduisent, et la position reste vraie.
await test("mur_court_garde_ses_bouts_et_aucune_poignee_ne_se_recouvre", async () => {
  // 30 cm: assez court pour que la reduction se declenche VRAIMENT a l'echelle de ce banc. A 60 cm
  // le mur n'etait plus court en PIXELS, donc rien ne retrecissait et le cas mesurait autre chose
  // que son nom.
  await seed(30); await move(await apt(100, 105)); const hs = await handles("w1");
  ok(hs.some((h: any) => h.c.includes("v5wmove")), "la poignée move doit toujours rester visible");
  ok(hs.filter((h: any) => h.c.includes("v5wend")).length === 2,
    `les DEUX bouts doivent rester, vu ${JSON.stringify(hs.map((h: any) => h.c))}`);
  // La boite de saisie fait 32 px a pleine taille, plus large que le disque de 20 qu'elle dessine:
  // rater la prise de deux pixels ne doit pas tomber sur le corps du mur, qui trace. Ce qu'on
  // verifie ici est donc qu'un mur court REDUIT ses boites, et surtout, plus bas, qu'aucune ne
  // recouvre une autre.
  ok(hs.every((h: any) => h.w < 32), `sur un mur court les poignées doivent avoir rétréci, vu ${JSON.stringify(hs.map((h: any) => Math.round(h.w)))}`);
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

// LE BOUTON D'UNE FACADE EST DE PREMIERE CLASSE, et c'est la demande du proprietaire mot pour mot:
// « s'il y a une fenetre a l'endroit du bouton, je dois pouvoir saisir le bouton ». Les commandes du
// contour n'avaient aucun z-index, donc elles passaient sous les ouvertures et la facade devenait
// insaisissable la ou une fenetre etait posee. Le bouton, lui, est au-dessus de tout ET il DEPLACE:
// c'est ce qui permet de bouger separement les deux moities d'une facade coupee.
await test("une_fenetre_ne_vole_pas_le_bouton_de_la_facade", async () => {
  await evaluate(`__plan.setModel({outline:[[0,0],[900,0],[900,600],[0,600]],walls:[
    {id:"o0",a:[0,0],b:[900,0],t:12,isOutline:1},{id:"o1",a:[900,0],b:[900,600],t:12,isOutline:1},
    {id:"o2",a:[900,600],b:[0,600],t:12,isOutline:1},{id:"o3",a:[0,600],b:[0,0],t:12,isOutline:1}
  ],openings:[{id:"fen",wallId:"o0",t0:390,w:120,h:12,type:"window",side:0,name:"Fenetre"}],
    pieces:[],cells:[]}); true`);
  await pause(250);
  // La fenetre est centree sur le MILIEU de la facade du haut, exactement la ou son bouton se pose.
  await move(await apt(450, 2)); await pause(300);
  const b = await center('.v5wmove[data-w="o0"]');
  if (!ok(b, "la facade doit offrir son bouton meme sous une fenetre")) return;
  // `closest`, pas `className`: le bouton contient desormais un SVG qui dessine son disque, donc
  // `elementFromPoint` rend ce SVG. Ce qui compte est que la pression ATTERRISSE dans le bouton.
  const dessus = await evaluate(`(function(){var e=document.elementFromPoint(${b.x},${b.y});
    return e && e.closest && e.closest(".v5wmove") ? "v5wmove" : (e ? String(e.tagName) : "rien");})()`);
  ok(dessus === "v5wmove", `le bouton doit gagner le test de clic, vu « ${dessus} »`);
  const avant = await evaluate(`JSON.stringify(__plan.state.plan.outline)`);
  await mouse("mousePressed", b);
  for (let i = 1; i <= 12; i++) { await mouse("mouseMoved", { x: b.x, y: b.y + 60 * i / 12 }, { buttons: 1 }); await pause(10); }
  await mouse("mouseReleased", { x: b.x, y: b.y + 60 });
  await pause(400);
  ok(await evaluate(`JSON.stringify(__plan.state.plan.outline)`) !== avant,
    "tirer le bouton d'une facade doit la deplacer, pas seulement la selectionner");
});

// =============================================================================
//  UNE ÉTIQUETTE DE PIÈCE NE VOLE PAS LE BOUTON D'UN MUR
// =============================================================================
// UNE CLOISON LIBRE AU MILIEU D'UNE PIÈCE: le pôle d'inaccessibilité de la cellule, donc le centre
// de son étiquette, tombe exactement sur le milieu du mur, donc sur son disque de déplacement.
// C'est la forme pure du cas mesuré sur le plan réel, où un couloir étroit met le nom de la pièce
// sur le mur qui le borde.
async function seedEtiquetteSurLeBouton(): Promise<void> {
  await evaluate(`__plan.setModel({outline:[[0,0],[420,0],[420,360],[0,360]],walls:[
    {id:"w1",a:[60,180],b:[360,180],t:12,free:1},
    {id:"o0",a:[0,0],b:[420,0],t:12,isOutline:1},{id:"o1",a:[420,0],b:[420,360],t:12,isOutline:1},
    {id:"o2",a:[420,360],b:[0,360],t:12,isOutline:1},{id:"o3",a:[0,360],b:[0,0],t:12,isOutline:1}
  ],openings:[],pieces:[],cells:[{id:"c1",name:"Salon salle a manger",floor:"plain",
    poly:[[0,0],[420,0],[420,360],[0,360]]}]});true`);
  await pause(150);
}
const recouvrement = () => J(`(function(){
  var m=document.querySelector('.v5wmove[data-w="w1"]'), e=document.querySelector('.ov-name[data-c]');
  if(!m||!e) return null;
  var a=m.getBoundingClientRect(), z=e.getBoundingClientRect();
  return {bouton:{g:a.left,d:a.right,h:a.top,b:a.bottom}, etiquette:{g:z.left,d:z.right,h:z.top,b:z.bottom},
    dx:Math.min(a.right,z.right)-Math.max(a.left,z.left), dy:Math.min(a.bottom,z.bottom)-Math.max(a.top,z.top)};
})()`);

await test("le_bouton_du_mur_gagne_le_clic_sous_une_etiquette_de_piece", async () => {
  await seedEtiquetteSurLeBouton();
  // On découvre les poignées LOIN de l'étiquette, pour que la précondition ne dépende pas du
  // défaut qu'on mesure.
  await move(await apt(90, 180));
  const b = await center('.v5wmove[data-w="w1"]');
  if (!ok(b, "précondition: survoler le mur doit révéler son disque de déplacement")) return;
  const r = await recouvrement();
  if (!ok(r && r.dx > 4 && r.dy > 4, `précondition: l'étiquette doit recouvrir le bouton, vu ${JSON.stringify(r)}`)) return;
  await move(b);
  ok((await handles("w1")).some((h: any) => h.c.includes("v5wmove")),
    "aller sur un bouton posé sous une étiquette ne doit pas effacer les poignées");
  // `closest`, pas `className`: le bouton contient un SVG qui dessine son disque.
  const dessus = await evaluate(`(function(){var e=document.elementFromPoint(${b.x},${b.y});
    return e&&e.closest ? (e.closest(".v5wmove") ? "v5wmove" : (e.closest(".ov-name") ? "ov-name" : String(e.tagName))) : "rien";})()`);
  ok(dessus === "v5wmove", `le bouton du mur doit gagner le test de clic, vu « ${dessus} »`);
  const avant = await wall("w1");
  await drag(b, { x: b.x, y: b.y + 60 });
  const apres = await wall("w1");
  ok(apres && Math.abs(apres.a[1] - avant.a[1]) > 5,
    `tirer ce bouton doit déplacer le mur, pas sélectionner la pièce, vu ${JSON.stringify({ avant, apres })}`);
});

await test("survoler_une_etiquette_n_efface_pas_le_mur_qui_est_dessous", async () => {
  await seedEtiquetteSurLeBouton();
  await move(await apt(90, 180));
  if (!ok((await handles("w1")).length, "précondition: le mur survolé doit avoir ses poignées")) return;
  const r = await recouvrement();
  if (!ok(r && r.etiquette.d - r.bouton.d > 8,
    `précondition: l'étiquette doit déborder du bouton, vu ${JSON.stringify(r)}`)) return;
  // Dans l'étiquette, en dehors de la boîte du bouton, et sur l'axe du mur.
  const p = { x: (r.etiquette.d + r.bouton.d) / 2, y: (r.bouton.h + r.bouton.b) / 2 };
  await move(p);
  const cible = await evaluate(`(function(){var e=document.elementFromPoint(${p.x},${p.y});
    return e&&e.closest ? (e.closest(".ov-name") ? "ov-name" : String(e.className||e.tagName)) : "rien";})()`);
  if (!ok(cible === "ov-name", `précondition: c'est bien l'étiquette qui reçoit le pointeur ici, vu « ${cible} »`)) return;
  ok((await handles("w1")).length > 0,
    "survoler l'étiquette posée sur un mur ne doit pas effacer les poignées de ce mur");
});

await test("une_etiquette_garde_son_clic_la_ou_aucun_bouton_ne_se_pose", async () => {
  // LE CORRECTIF NE DOIT RIEN PRENDRE À L'ÉTIQUETTE: elle renomme sa pièce partout où aucune
  // commande de mur ne se pose, ce qui est le cas de presque toute sa surface.
  await seedEtiquetteSurLeBouton();
  await move(await apt(90, 180));
  const r = await recouvrement();
  if (!ok(r && r.etiquette.d - r.bouton.d > 8, `précondition: étiquette débordante attendue, vu ${JSON.stringify(r)}`)) return;
  await evaluate(`__plan.gestes && 0; true`);
  await click({ x: (r.etiquette.d + r.bouton.d) / 2, y: (r.bouton.h + r.bouton.b) / 2 });
  ok(await evaluate(`String(__plan.v5ui.selCell)`) === "c1",
    `un clic sur l'étiquette doit encore choisir sa pièce, vu ${await evaluate("String(__plan.v5ui.selCell)")}`);
});

// =============================================================================
//  UN MUR TROP COURT EN PORTE MOINS, PAS ZÉRO
// =============================================================================
// Le seuil de 28 px retirait d'un coup la coupe, la croix et les maillons. Les paliers vont
// désormais du plus utile au moins utile: le disque de déplacement (aucune solution de rechange,
// le corps du mur trace), puis la croix (seul geste de pointage qui supprime, et seule de son côté
// de la normale, donc rien ne lui dispute sa place), puis la coupe (qui garde un seuil de
// LONGUEUR, parce que couper plus court laisse deux moitiés invisables), puis les bouts et les
// maillons, qui cèdent parce qu'ils ont, eux, une solution de rechange: zoomer.
async function seedMurCourt(cm = 30, pixels = 20): Promise<void> {
  await seed(cm);
  await evaluate(`__plan.setZoom(${pixels}/${cm}); true`);
  await pause(200);
}

await test("un_mur_sous_le_seuil_garde_son_deplacement_et_sa_croix", async () => {
  await seedMurCourt();
  await move(await apt(100, 95));
  const lenpx = await evaluate(`(function(){var w=__plan.v5WallById("w1");
    return Math.hypot(w.b[0]-w.a[0],w.b[1]-w.a[1])*__plan.viewTransform().scale;})()`);
  if (!ok(lenpx < 28, `précondition: le mur doit être SOUS le seuil, vu ${lenpx} px`)) return;
  const bs = await boitesMur("w1");
  const classes = bs.map((b: any) => b.c);
  ok(bs.some((b: any) => /v5wmove/.test(b.c)), `le disque de déplacement doit rester, vu ${JSON.stringify(classes)}`);
  ok(bs.some((b: any) => /v5wx/.test(b.c)),
    `la croix doit rester: supprimer est un geste sans solution de rechange, vu ${JSON.stringify(classes)}`);
  ok(!bs.some((b: any) => /v5wmid/.test(b.c)),
    `la coupe doit céder sous le seuil: deux moitiés de 10 px ne se visent plus, vu ${JSON.stringify(classes)}`);
});

await test("sous_le_seuil_aucun_bouton_n_en_recouvre_un_autre", async () => {
  // DEUX BOUTONS AU MÊME PIXEL VALENT ZÉRO BOUTON. Avant, le disque de déplacement et les deux
  // bouts se recouvraient dès que la boîte cessait de rétrécir (55 % à partir de 35 px), chacun
  // rendant l'autre inatteignable, et personne ne le voyait: le cas court de cette suite mesure un
  // mur de 30 cm qui fait encore 70 px à l'écran.
  await seedMurCourt();
  await move(await apt(100, 95));
  const bs = await boitesMur("w1");
  ok(bs.length >= 2, `un mur court doit garder PLUSIEURS commandes, vu ${JSON.stringify(bs.map((b: any) => b.c))}`);
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
    const a = bs[i], b = bs[j];
    const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    ok(!(dx > 0.5 && dy > 0.5), `${a.c} et ${b.c} se recouvrent de ${Math.round(dx)}x${Math.round(dy)} px`);
  }
});

await test("la_croix_d_un_mur_sous_le_seuil_le_supprime_vraiment", async () => {
  // UN BOUTON CONSERVÉ QUI NE MARCHE PAS NE VAUT PAS MIEUX QU'UN BOUTON ABSENT: on appuie dessus,
  // à la vraie souris, et on regarde le modèle.
  await seedMurCourt();
  await move(await apt(100, 95));
  const croix = await center('.v5wx[data-w="w1"]');
  if (!ok(croix, "la croix doit être présente sous le seuil")) return;
  await move(croix);
  await mouse("mousePressed", croix); await mouse("mouseReleased", croix);
  await pause(300);
  ok(await evaluate(`String(__plan.state.plan.walls.filter(function(w){return !w.isOutline}).length)`) === "0",
    "la croix d'un mur court doit le supprimer");
});

// =============================================================================
//  UN MEUBLE NE VOLE PAS LE BOUTON D'UN MUR, ET LE BOUTON NE VOLE PAS LE MEUBLE
// =============================================================================
// Troisième famille d'objets à qui s'applique la même règle, après le tapis puis l'étiquette de
// pièce: un contrôle qu'autre chose peut recouvrir n'est pas un contrôle. Mesure au zoom
// d'ajustement sur le plan réel à 77 objets: 18 boutons de mur sur 60 étaient sous un meuble,
// dont la croix de w13 sous la machine à laver, peinte en pâle et morte au clic; 0 après.
//
// MAIS UN MEUBLE N'EST PAS UNE ÉTIQUETTE: on le SAISIT. Monter les boutons au-dessus de lui sans
// rien d'autre déplacerait simplement le défaut, puisqu'un lit contre une cloison est le cas
// ordinaire d'un appartement. La règle est donc dissymétrique, et les trois cas ci-dessous en
// tiennent chacun un morceau: le bouton gagne LÀ OÙ IL EST PEINT, un meuble n'efface plus les
// poignées du mur qu'il recouvre, et un meuble n'en RÉVÈLE jamais.
//
// Mesuré sur le plan réel, vraie souris, 25 points de prise par meuble: en arrivant du sol libre,
// 0 point volé, aux deux zooms; en arrivant en TRAVERSANT la cloison, 143 sur 600 au zoom
// d'ajustement (24 % des points des 24 meubles exposés) et 370 sur 975 dézoomé de moitié, dont
// deux chaises plus petites qu'une boîte de bouton qui perdent tous les leurs. C'est le prix
// accepté, réversible d'un geste, et l'alternative mesurée était pire: qu'un meuble RÉVÈLE les
// commandes du mur qu'il recouvre rend ces mêmes meubles inatteignables par tous les chemins,
// ce que tient le troisième cas.

/** Une cloison verticale, et un meuble posé EXACTEMENT sur la croix de ce mur. La position de la
 *  croix est LUE à l'écran puis reconvertie en centimètres: on ne devine pas où elle tombe. */
async function seedMeubleSurLaCroix(): Promise<{ ax: number; ay: number } | null> {
  await seed(200);
  await move(await apt(100, 120));
  const croix = await center('.v5wx[data-w="w1"]');
  if (!croix) return null;
  const vrr = await J(`(function(){var r=document.getElementById("viewport").getBoundingClientRect();return{x:r.left,y:r.top}})()`);
  const a = await J(`__plan.screenToApt(${croix.x} - ${vrr.x}, ${croix.y} - ${vrr.y})`);
  await evaluate(`__plan.setModel({outline:[[0,0],[420,0],[420,360],[0,360]],walls:[
    {id:"w1",a:[100,80],b:[100,280],t:12,free:1},
    {id:"o0",a:[0,0],b:[420,0],t:12,isOutline:1},{id:"o1",a:[420,0],b:[420,360],t:12,isOutline:1},
    {id:"o2",a:[420,360],b:[0,360],t:12,isOutline:1},{id:"o3",a:[0,360],b:[0,0],t:12,isOutline:1}
  ],openings:[],pieces:[{id:"m1",type:"washer",name:"Machine a laver",
    x:${a.x - 30},y:${a.y - 30},w:60,h:60,rot:0,locked:false}],
    cells:[{id:"c1",name:"Buanderie",floor:"plain",poly:[[0,0],[420,0],[420,360],[0,360]]}]});true`);
  await pause(150);
  return a;
}
const recouvreCroix = () => J(`(function(){
  var b=document.querySelector('.v5wx[data-w="w1"]'), m=document.querySelector('.piece[data-id="m1"]');
  if(!b||!m) return null;
  var a=b.getBoundingClientRect(), z=m.getBoundingClientRect();
  return {dx:Math.min(a.right,z.right)-Math.max(a.left,z.left), dy:Math.min(a.bottom,z.bottom)-Math.max(a.top,z.top)};
})()`);

await test("le_bouton_du_mur_gagne_le_clic_sous_un_meuble", async () => {
  if (!ok(await seedMeubleSurLaCroix(), "croix introuvable au moment de poser le meuble")) return;
  ok(await evaluate(`__plan.isWallMount("washer")===false`) === true,
    "précondition: le meuble témoin doit être un meuble ordinaire, pas un objet de mur");
  // On découvre les poignées LOIN du meuble, pour que la précondition ne dépende pas du défaut.
  await move(await apt(100, 120));
  const b = await center('.v5wx[data-w="w1"]');
  if (!ok(b, "précondition: survoler le mur doit révéler sa croix")) return;
  const r = await recouvreCroix();
  if (!ok(r && r.dx > 8 && r.dy > 8, `précondition: le meuble doit recouvrir la croix, vu ${JSON.stringify(r)}`)) return;
  const dessus = await evaluate(`(function(){var e=document.elementFromPoint(${b.x},${b.y});
    return e&&e.closest ? (e.closest(".v5wx") ? "v5wx" : (e.closest(".piece") ? "piece" : String(e.tagName))) : "rien";})()`);
  ok(dessus === "v5wx", `la croix doit gagner le test de clic sous le meuble, vu « ${dessus} »`);
  // UN BOUTON CONSERVÉ QUI NE MARCHE PAS NE VAUT PAS MIEUX QU'UN BOUTON ABSENT.
  await move(b); await mouse("mousePressed", b); await mouse("mouseReleased", b); await pause(300);
  ok(await evaluate(`String(__plan.state.plan.walls.filter(function(w){return !w.isOutline}).length)`) === "0",
    "appuyer sur la croix peinte au-dessus du meuble doit vraiment supprimer le mur");
});

await test("traverser_un_meuble_n_efface_pas_les_poignees_du_mur", async () => {
  if (!ok(await seedMeubleSurLaCroix(), "croix introuvable au moment de poser le meuble")) return;
  await move(await apt(100, 120));
  if (!ok((await handles("w1")).length, "précondition: le mur survolé doit avoir ses poignées")) return;
  // Sur l'axe du mur, DANS le meuble, et en dehors de toute boîte de bouton: c'est le trajet
  // ordinaire entre la bande du mur et le bouton qu'on vise.
  const p = await apt(100, 160);
  const boites = await boitesMur("w1");
  if (!ok(!boites.some((q: any) => p.x >= q.x && p.x <= q.x + q.w && p.y >= q.y && p.y <= q.y + q.h),
    `précondition: le point de passage ne doit être sous aucun bouton, vu ${JSON.stringify(boites.map((q: any) => q.c))}`)) return;
  await move(p);
  const cible = await evaluate(`(function(){var e=document.elementFromPoint(${p.x},${p.y});
    return e&&e.closest&&e.closest('.piece[data-id="m1"]') ? "meuble" : "autre";})()`);
  if (!ok(cible === "meuble", `précondition: c'est bien le meuble qui reçoit le pointeur ici, vu « ${cible} »`)) return;
  ok((await handles("w1")).length > 0,
    "passer au-dessus d'un meuble en allant vers un bouton ne doit pas effacer les poignées du mur");
});

await test("un_meuble_ne_revele_jamais_les_poignees_du_mur_qu_il_recouvre", async () => {
  // LE CORRECTIF NE DOIT PAS DÉPLACER LE DÉFAUT. Si un meuble révélait les commandes du mur sous
  // lequel il est posé, venir prendre un lit collé à une cloison ferait apparaître un bouton sous
  // la main juste avant l'appui, et le bouton passe désormais AU-DESSUS. Un meuble RETIENT donc un
  // survol qu'on tenait déjà, il n'en DÉMARRE aucun.
  if (!ok(await seedMeubleSurLaCroix(), "croix introuvable au moment de poser le meuble")) return;
  // On arrive du sol libre, loin de tout mur, et on laisse expirer le masquage différé.
  await move(await apt(300, 300)); await pause(250);
  if (!ok((await toutesPoignees()).length === 0,
    `précondition: le sol libre ne doit révéler aucune poignée, vu ${JSON.stringify(await toutesPoignees())}`)) return;
  // Le milieu du mur, donc le disque de déplacement, mais recouvert par le meuble.
  const p = await apt(100, 180);
  await move(p);
  ok((await handles("w1")).length === 0,
    `venir sur un meuble ne doit révéler aucune poignée du mur qu'il recouvre, vu ${JSON.stringify(await handles("w1"))}`);
  const cible = await evaluate(`(function(){var e=document.elementFromPoint(${p.x},${p.y});
    return e&&e.closest&&e.closest('.piece[data-id="m1"]') ? "meuble" : "autre";})()`);
  ok(cible === "meuble", `le meuble doit garder le test de clic, vu « ${cible} »`);
  const avantMur = await wall("w1");
  const avant = await J(`(function(){var p=__plan.state.plan.pieces[0];return{x:p.x,y:p.y}})()`);
  await mouse("mousePressed", p);
  ok(await evaluate(`String(__plan.selId)`) === "m1", "l'appui doit sélectionner le meuble, pas le mur");
  for (let i = 1; i <= 12; i++) { await mouse("mouseMoved", { x: p.x, y: p.y + 90 * i / 12 }, { button: "left", buttons: 1 }); await pause(8); }
  await mouse("mouseReleased", { x: p.x, y: p.y + 90 }); await pause(200);
  const apres = await J(`(function(){var p=__plan.state.plan.pieces[0];return{x:p.x,y:p.y}})()`);
  const apresMur = await wall("w1");
  ok(apres.x !== avant.x || apres.y !== avant.y,
    `tirer là doit déplacer le MEUBLE, vu ${JSON.stringify({ avant, apres })}`);
  ok(apresMur && Math.abs(apresMur.a[0] - avantMur.a[0]) < 1,
    `tirer là ne doit pas déplacer le mur, vu ${JSON.stringify({ avantMur, apresMur })}`);
});

const bad = results.filter((r) => r.fails.length);
console.log("");
if (bad.length) { console.log(`FAILURES ${bad.length}/${results.length}:`); bad.forEach((r) => r.fails.forEach((f) => console.log(`  - ${r.name}: ${f}`))); }
else console.log(`OK ${results.length}/${results.length}`);
ws.close(); chrome.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
process.exit(bad.length ? 1 : 0);
