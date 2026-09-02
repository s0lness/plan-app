#!/usr/bin/env node
// =============================================================================
//  "UNE AVANCÉE S'ARRÊTE SUR LE MUR DE LA PIÈCE" SUITE: REAL MOUSE (CDP)
// =============================================================================
// Owner's report, screenshots in hand: he pushes upward the facade section that forms the top wall
// of a small room, and "ça crée un trou", "la bissection à droite ne se fait pas au bon endroit".
//
// Measured on the reproduction below (a 900x700 outline whose top facade is cut at 350 and 550,
// partitions at 350 and at 560, pushed 200 cm up): the recess came out 200 cm wide (350..550) while
// the room is 210 cm wide (350..560), so its right corner landed 10 cm short of the room's own wall
// and the plan kept a 10 x 200 cm bite of OUTSIDE in the room's top right corner. The left
// partition falls exactly on the cut, and that side was already correct: that is why the defect is
// invisible when both cuts land right, and why this suite carries BOTH.
//
// The rule under test: the corner of the recess, which the gesture is creating anyway, is placed on
// the partition that bounds the room rather than on the facade's cut. The partition itself never
// moves sideways.
//
//   node tests/avancee-suit-la-piece-geste.ts [path/to/app.html]
//
// Real mouse (`Input.dispatchMouseEvent`), never a synthetic PointerEvent: AGENTS.md, "A click
// lands on what is visible".

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
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "plan-rev177.json"), "utf8"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-avancee-"));
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
async function drag(from: VerdictSonde, to: VerdictSonde, steps = 16) {
  await M("mouseMoved", from.x, from.y, { button: "none", buttons: 0 });
  await M("mousePressed", from.x, from.y);
  for (let i = 1; i <= steps; i++) {
    await M("mouseMoved", from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
    await pause(8);
  }
  await M("mouseReleased", to.x, to.y, { buttons: 0 });
}
/** WAIT FOR A CONDITION, NEVER FOR A DURATION (AGENTS.md): a longer sleep only moves the load
 * threshold where it fails again. */
// LE CRITERE EST LA CLOISON, PAS LA DISTANCE PARCOURUE. Ces cas epinglaient le sommet a
// `y === -200`, c'est-a-dire la distance exacte dont le glissement de la sonde avait pousse
// l'avancee. Sous barriere chargee, la souris synthetique s'arrete a -195 et le cas tombait alors
// que le coin etait au BON endroit, a x=540. On verifie donc ce que la regle promet: le coin haut
// est sur la cloison, et l'avancee est bien sortie du logement.
async function jusqua(cond: () => Promise<boolean>, quoi: string, ms = 40000) {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return true;
    if (Date.now() - t0 > ms) { cur.fails.push("délai dépassé en attendant: " + quoi); return false; }
    await pause(40);
  }
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
const contour = () => J(`__plan.state.plan.outline`);
const cellules = () => J(`(__plan.state.plan.cells||[]).map(function(c){return c.poly})`);
const cloisons = () => J(`__plan.state.plan.walls.filter(function(w){return !w.isOutline})
  .map(function(w){return {id:String(w.id),a:w.a,b:w.b}})`);
const ouvertures = () => J(`__plan.state.plan.openings.map(function(o){
  var w=__plan.state.plan.walls.filter(function(x){return String(x.id)===String(o.wallId)})[0];
  if(!w) return {id:String(o.id),orphelin:true};
  var L=Math.hypot(w.b[0]-w.a[0],w.b[1]-w.a[1])||1, t=o.t0/L;
  return {id:String(o.id),x:Math.round(w.a[0]+(w.b[0]-w.a[0])*t),y:Math.round(w.a[1]+(w.b[1]-w.a[1])*t)};})`);
const toastTexte = () => evaluate(`String(__plan.toastText||"")`);

/** The cell holding this point, as a polygon. */
async function celluleEn(x: number, y: number): Promise<number[][] | null> {
  const c = await J(`(function(){var c=__plan.cellAt(${x},${y}); return c?c.poly:null;})()`);
  return c;
}
/** A polygon's corners that are neither horizontal nor vertical turns: none is expected here. */
function coinsRentrants(poly: number[][]): number {
  let n = 0;
  for (let k = 0; k < poly.length; k++) {
    const p = poly[(k + poly.length - 1) % poly.length]!, q = poly[k]!, r = poly[(k + 1) % poly.length]!;
    const ux = q[0]! - p[0]!, uy = q[1]! - p[1]!, vx = r[0]! - q[0]!, vy = r[1]! - q[1]!;
    if (Math.abs(ux * vx + uy * vy) > 1) n++;      // le tour ne fait pas un angle droit
  }
  return n;
}

// THE REPRODUCTION, minimal: a 900x700 flat whose top facade is already cut at 350 and at 550, and
// two partitions bounding the middle room. `xd` is where the RIGHT partition sits: exactly on the
// cut (550), or 10 cm past it (560), or 10 cm before it (540).
async function seedPieceSousLaFacade(xd: number, fenetre?: boolean) {
  await evaluate(`__plan.setModel({outline:[[0,0],[350,0],[550,0],[900,0],[900,700],[0,700]],walls:[
    {id:"fA",a:[0,0],b:[350,0],t:12,isOutline:1},
    {id:"fB",a:[350,0],b:[550,0],t:12,isOutline:1},
    {id:"fC",a:[550,0],b:[900,0],t:12,isOutline:1},
    {id:"f1",a:[900,0],b:[900,700],t:12,isOutline:1},
    {id:"f2",a:[900,700],b:[0,700],t:12,isOutline:1},
    {id:"f3",a:[0,700],b:[0,0],t:12,isOutline:1},
    {id:"g",a:[350,0],b:[350,700],t:10},
    {id:"d",a:[${xd},0],b:[${xd},700],t:10}
  ],openings:${fenetre ? `[{id:"fenD",wallId:"fC",type:"window",t0:150,w:120,h:12,side:1}]` : "[]"},
  pieces:[],cells:[]}); true`);
  await jusqua(async () => (await cellules()).length === 3, "les trois pièces du plan de départ");
}

/** Grab the cut facade section by its move disc and push it 200 cm upward. */
async function pousserLaFacade(): Promise<boolean> {
  const survol = await aptPoint(450, 2);
  await M("mouseMoved", survol.x, survol.y, { button: "none", buttons: 0 });
  let rond: VerdictSonde = null;
  await jusqua(async () => !!(rond = await centerOf(".v5wmove")), "le bouton rond de la façade coupée");
  if (!ok(rond, "la façade coupée doit porter son bouton rond de déplacement")) return false;
  const p0 = await aptPoint(450, 0), p1 = await aptPoint(450, -200);
  await drag(rond, { x: rond.x + (p1.x - p0.x), y: rond.y + (p1.y - p0.y) }, 20);
  return await jusqua(async () => (await contour()).some((p: number[]) => p[1]! < -100), "l'avancée poussée vers le haut");
}

// LE DÉFAUT SIGNALÉ. La cloison est à 10 cm de la coupe: l'avancée doit s'arrêter SUR elle, pas
// sur la coupe, sinon la pièce garde une encoche de 10 x 200 cm d'extérieur dans son coin.
await test("l_avancee_va_chercher_la_cloison_a_dix_centimetres", async () => {
  await seedPieceSousLaFacade(560);
  if (!await pousserLaFacade()) return;
  const O = await contour();
  ok(!O.some((p: number[]) => Math.abs(p[0]! - 550) < 0.5 && p[1]! > -1),
    `aucun sommet ne doit rester sur la coupe à 550, vu ${JSON.stringify(O)}`);
  ok(O.some((p: number[]) => Math.abs(p[0]! - 560) < 0.5 && p[1]! < -100),
    `le coin haut de l'avancée doit être sur la cloison, à x=560, vu ${JSON.stringify(O)}`);
  const piece = await celluleEn(455, 300);
  if (!ok(piece, "la pièce du milieu doit exister")) return;
  ok(piece!.length === 4, `la pièce doit être un rectangle net, vue à ${piece!.length} sommets: ${JSON.stringify(piece)}`);
  ok(coinsRentrants(piece!) === 0, `aucun angle de travers dans la pièce, vue ${JSON.stringify(piece)}`);
  const xs = piece!.map((p) => p[0]!), ys = piece!.map((p) => p[1]!);
  ok(Math.min(...xs) === 350 && Math.max(...xs) === 560,
    `la pièce doit garder sa largeur de 350 à 560, vue ${JSON.stringify(piece)}`);
  ok(Math.min(...ys) === -200 && Math.max(...ys) === 700,
    `la pièce doit avoir grandi de 200 cm vers le haut, vue ${JSON.stringify(piece)}`);
});

// ET LA CLOISON N'A PAS BOUGÉ D'UN CENTIMÈTRE. C'est le coin de l'avancée qui va la chercher: faire
// glisser la cloison de 10 cm déplacerait sur 900 cm un mur que personne n'a touché.
await test("la_cloison_elle_meme_ne_bouge_pas", async () => {
  await seedPieceSousLaFacade(560);
  const avant = await cloisons();
  if (!await pousserLaFacade()) return;
  const apres = await cloisons();
  ok(JSON.stringify(apres) === JSON.stringify(avant),
    `les cloisons doivent être inchangées, vues ${JSON.stringify(avant)} puis ${JSON.stringify(apres)}`);
});

// L'AIMANT MARCHE DES DEUX CÔTÉS DE LA COUPE. Une cloison 10 cm AVANT elle rétrécit l'avancée
// jusqu'à elle, exactement de la même façon: le critère est la pièce, pas le sens de l'erreur.
await test("une_cloison_en_deca_de_la_coupe_retrecit_l_avancee", async () => {
  await seedPieceSousLaFacade(540);
  if (!await pousserLaFacade()) return;
  const O = await contour();
  ok(O.some((p: number[]) => Math.abs(p[0]! - 540) < 0.5 && p[1]! < -100),
    `le coin haut de l'avancée doit être sur la cloison, à x=540, vu ${JSON.stringify(O)}`);
  const piece = await celluleEn(450, 300);
  if (!ok(piece, "la pièce du milieu doit exister")) return;
  ok(piece!.length === 4 && coinsRentrants(piece!) === 0,
    `la pièce doit rester un rectangle net, vue ${JSON.stringify(piece)}`);
});

// GARDE DE NON-RÉGRESSION: quand la coupe tombe PILE sur la cloison, rien ne doit bouger. C'est le
// cas qui marchait déjà, et c'est lui qui rendait le défaut invisible.
await test("une_coupe_deja_sur_la_cloison_ne_bouge_pas", async () => {
  await seedPieceSousLaFacade(550);
  if (!await pousserLaFacade()) return;
  const O = await contour();
  ok(O.some((p: number[]) => Math.abs(p[0]! - 550) < 0.5 && p[1]! < -100),
    `le coin de l'avancée doit rester à 550, vu ${JSON.stringify(O)}`);
  ok(!O.some((p: number[]) => Math.abs(p[0]! - 560) < 0.5), `aucun sommet inventé à 560, vu ${JSON.stringify(O)}`);
  const piece = await celluleEn(450, 300);
  ok(piece && piece.length === 4 && coinsRentrants(piece) === 0,
    `la pièce doit être un rectangle net, vue ${JSON.stringify(piece)}`);
});

// UNE FENÊTRE DE LA FAÇADE VOISINE NE BOUGE PAS. Une ouverture désigne son mur et sa DISTANCE
// depuis `a`: le coin qui glisse est justement le `a` de la façade voisine, donc sans correction
// toutes ses fenêtres partent avec lui, en silence.
await test("la_fenetre_de_la_facade_voisine_reste_ou_elle_est", async () => {
  await seedPieceSousLaFacade(560, true);
  const avant = await ouvertures();
  if (!await pousserLaFacade()) return;
  const apres = await ouvertures();
  ok(apres.length === avant.length, `aucune ouverture ne doit disparaître, vu ${avant.length} puis ${apres.length}`);
  const a = avant.find((o: VerdictSonde) => o.id === "fenD"), b = apres.find((o: VerdictSonde) => o.id === "fenD");
  if (!ok(a && b && !b.orphelin, `la fenêtre doit rester sur un mur, vue ${JSON.stringify(apres)}`)) return;
  ok(Math.abs(b.x - a.x) < 2 && Math.abs(b.y - a.y) < 2,
    `la fenêtre de la façade voisine ne doit pas bouger, vue ${JSON.stringify(a)} puis ${JSON.stringify(b)}`);
});

// ET LA PIÈCE QUI CHANGE DE FORME LE DIT. Rien ne change de nature en silence dans ce dépôt: la
// pièce n'a pas la largeur qu'on lisait avant le geste, donc le chiffre est annoncé.
await test("la_piece_qui_change_de_forme_le_dit", async () => {
  await seedPieceSousLaFacade(560);
  if (!await pousserLaFacade()) return;
  const t = String(await toastTexte());
  ok(/10\s*cm/.test(t) && /partition/i.test(t), `le décalage doit être annoncé avec son chiffre, vu « ${t} »`);
});

// ET LE CAS ORDINAIRE NE BOUGE PAS D'UN POUCE. Pousser le haut d'un rectangle sur lequel une
// cloison vient buter ne crée aucun raccord, donc n'aimante rien: sinon les deux façades latérales
// se déplaceraient de côté à chaque glissement ordinaire.
await test("pousser_le_haut_d_un_rectangle_ne_deplace_aucune_facade_laterale", async () => {
  await evaluate(`__plan.setModel({outline:[[0,0],[900,0],[900,700],[0,700]],walls:[
    {id:"f0",a:[0,0],b:[900,0],t:12,isOutline:1},{id:"f1",a:[900,0],b:[900,700],t:12,isOutline:1},
    {id:"f2",a:[900,700],b:[0,700],t:12,isOutline:1},{id:"f3",a:[0,700],b:[0,0],t:12,isOutline:1},
    {id:"m",a:[450,0],b:[450,700],t:10}
  ],openings:[],pieces:[],cells:[]}); true`);
  await jusqua(async () => (await cellules()).length === 2, "les deux pièces du rectangle");
  const survol = await aptPoint(200, 2);
  await M("mouseMoved", survol.x, survol.y, { button: "none", buttons: 0 });
  let rond: VerdictSonde = null;
  await jusqua(async () => !!(rond = await centerOf(".v5wmove")), "le bouton rond de la façade du haut");
  if (!ok(rond, "bouton rond introuvable sur la façade du haut")) return;
  const p0 = await aptPoint(200, 0), p1 = await aptPoint(200, -100);
  await drag(rond, { x: rond.x + (p1.x - p0.x), y: rond.y + (p1.y - p0.y) }, 16);
  await jusqua(async () => (await contour()).some((p: number[]) => p[1]! < -50), "la façade poussée");
  const O = await contour();
  ok(O.length === 4, `le contour doit rester à quatre sommets, vu ${JSON.stringify(O)}`);
  const xs = O.map((p: number[]) => p[0]!).sort((a: number, b: number) => a - b);
  ok(xs[0] === 0 && xs[1] === 0 && xs[2] === 900 && xs[3] === 900,
    `aucune façade latérale ne doit se déplacer de côté, vu ${JSON.stringify(O)}`);
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
