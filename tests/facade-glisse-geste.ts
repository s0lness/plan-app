#!/usr/bin/env node
// =============================================================================
//  "A FACADE SLIDES, IT NEVER BENDS" SUITE — REAL MOUSE (CDP)
// =============================================================================
// Owner's report, screenshot in hand: after cutting the top facade in two and pushing the left half
// down, the outline came out BENT. The right half, whose left end had moved and whose right end had
// not, ran diagonally across the top of the flat with its window askew on it.
//
// A facade is a straight run of masonry. Pushing one half translates it; the other half keeps its
// direction, and the two are joined by a RIGHT-ANGLE connector, exactly as a partition pushed off a
// junction grows a bridge instead of tearing it (decision record 0007). The two ways to bend the
// outline are covered here: pushing a facade half, and dragging a corner.
//
//   node tests/facade-glisse-geste.ts [path/to/app.html]
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-coude-mur-"));
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
async function click(p: VerdictSonde) {
  await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 });
  await M("mousePressed", p.x, p.y);
  await M("mouseReleased", p.x, p.y, { buttons: 0 });
  await pause(80);
}
async function drag(from: VerdictSonde, to: VerdictSonde, steps = 14) {
  await M("mouseMoved", from.x, from.y, { button: "none", buttons: 0 });
  await M("mousePressed", from.x, from.y);
  for (let i = 1; i <= steps; i++) {
    await M("mouseMoved", from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
    await pause(8);
  }
  await M("mouseReleased", to.x, to.y, { buttons: 0 });
  await pause(100);
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
const mur = (id: string) => J(`(function(){var w=__plan.v5WallById(${JSON.stringify(id)}); return w?{a:w.a,b:w.b,free:w.free||0}:null;})()`);
const mursInterieurs = () => J(`__plan.state.plan.walls.filter(function(w){return !w.isOutline}).map(function(w){return {id:String(w.id),a:w.a,b:w.b}})`);
const undoCount = () => evaluate(`String(__plan.histInfo().undo)`);

const contour = () => J(`__plan.state.plan.outline`);
const mursContour = () => J(`__plan.state.plan.walls.filter(function(w){return !!w.isOutline})
  .map(function(w){return {id:String(w.id),a:w.a,b:w.b}})`);
// Where each opening SITS, in apartment centimetres, read through its wall: an opening that changes
// wall without moving on screen is a silent re-homing, which is precisely what has to be caught.
const ouvertures = () => J(`__plan.state.plan.openings.map(function(o){
  var w=__plan.state.plan.walls.filter(function(x){return String(x.id)===String(o.wallId)})[0];
  if(!w) return {id:String(o.id),orphelin:true};
  var L=Math.hypot(w.b[0]-w.a[0],w.b[1]-w.a[1])||1, t=o.t0/L;
  return {id:String(o.id),x:Math.round(w.a[0]+(w.b[0]-w.a[0])*t),y:Math.round(w.a[1]+(w.b[1]-w.a[1])*t)};})`);
// An OBLIQUE outline edge: neither horizontal nor vertical. On this flat there is no such thing, so
// one appearing is the bend itself.
function obliques(O: VerdictSonde): number[][][] {
  const r: number[][][] = [];
  for (let i = 0; i < O.length; i++) {
    const a = O[i], b = O[(i + 1) % O.length];
    if (Math.abs(b[0] - a[0]) > 0.5 && Math.abs(b[1] - a[1]) > 0.5) r.push([a, b]);
  }
  return r;
}

// A rectangle whose TOP facade is already cut in two, with one window on each half: exactly the
// shape the owner had on screen when the top facade came out bent.
async function seedFacadeCoupee() {
  await evaluate(`__plan.setModel({outline:[[0,0],[450,0],[900,0],[900,600],[0,600]],walls:[
    {id:"f0",a:[0,0],b:[450,0],t:12,isOutline:1},{id:"f0b",a:[450,0],b:[900,0],t:12,isOutline:1},
    {id:"f1",a:[900,0],b:[900,600],t:12,isOutline:1},
    {id:"f2",a:[900,600],b:[0,600],t:12,isOutline:1},{id:"f3",a:[0,600],b:[0,0],t:12,isOutline:1}
  ],openings:[{id:"fenG",wallId:"f0",type:"window",t0:150,w:120,h:12,side:1},
              {id:"fenD",wallId:"f0b",type:"window",t0:200,w:120,h:12,side:1}],
  pieces:[],cells:[]}); true`);
  await pause(150);
}

// A FACADE SLIDES, IT NEVER BENDS. Owner's report, with the screenshot: after cutting the top
// facade and pushing the left half down, the RIGHT half came out oblique, running from the moved
// end to the untouched corner, its windows askew across it. A half that is pushed has to translate,
// and the half that stays has to keep its direction: the two are joined by a right-angle connector,
// which is the outline version of the junction bridge for partitions (decision record 0007).
await test("pousser_une_moitie_de_facade_la_fait_glisser_sans_plier", async () => {
  await seedFacadeCoupee();
  ok(obliques(await contour()).length === 0, "le contour de départ ne doit porter aucune arête oblique");
  const survol = await aptPoint(225, 2);
  await M("mouseMoved", survol.x, survol.y, { button: "none", buttons: 0 }); await pause(250);
  const rond = await centerOf(".v5wmove");
  if (!ok(rond, "la moitié gauche doit porter son bouton rond de déplacement")) return;
  await drag(rond, { x: rond.x, y: rond.y + 100 }, 16);
  await pause(200);
  const O = await contour();
  const obl = obliques(O);
  ok(obl.length === 0, `aucune façade ne doit devenir oblique, vu ${JSON.stringify(obl)}`);
  // The pushed half really moved, so the case is not passing because nothing happened.
  const bougee = O.filter((p: VerdictSonde) => p[1] > 20 && p[1] < 400);
  ok(bougee.length >= 2, `la moitié poussée doit avoir bougé, contour vu ${JSON.stringify(O)}`);
  // And the connector is VERTICAL, at the cut, joining the two levels.
  const raccord = O.filter((p: VerdictSonde, k: number) => {
    const q = O[(k + 1) % O.length];
    return Math.abs(p[0] - q[0]) < 0.5 && Math.abs(p[1] - q[1]) > 20 && p[0] > 10 && p[0] < 890;
  });
  ok(raccord.length === 1, `un raccord à angle droit est attendu au point de coupe, vu ${JSON.stringify(O)}`);
});

// THE CONNECTOR IS A WALL, AND NOBODY LOSES A WINDOW ALONG THE WAY. Leaving `v5SyncOutlineWalls` to
// invent the new edge makes it fall back on the first free outline wall, which shifts every facade
// downstream by one AND takes their openings with them (the failure measured on the facade cut).
await test("le_raccord_porte_un_mur_et_chaque_fenetre_reste_sur_sa_moitie", async () => {
  await seedFacadeCoupee();
  const avant = await ouvertures();
  const nAvant = (await mursContour()).length;
  const survol = await aptPoint(225, 2);
  await M("mouseMoved", survol.x, survol.y, { button: "none", buttons: 0 }); await pause(250);
  const rond = await centerOf(".v5wmove");
  if (!ok(rond, "bouton rond introuvable")) return;
  await drag(rond, { x: rond.x, y: rond.y + 100 }, 16);
  await pause(200);
  const murs = await mursContour();
  ok(murs.length === nAvant + 1, `le raccord doit ajouter exactement un mur de façade, vu ${nAvant} puis ${murs.length}`);
  const vertical = murs.filter((w: VerdictSonde) => Math.abs(w.a[0] - w.b[0]) < 0.5
    && Math.abs(w.a[1] - w.b[1]) > 20 && w.a[0] > 10 && w.a[0] < 890);
  ok(vertical.length === 1, `un mur de façade vertical est attendu au raccord, vu ${JSON.stringify(murs)}`);
  const apres = await ouvertures();
  ok(apres.length === avant.length, `aucune ouverture ne doit disparaître, vu ${avant.length} puis ${apres.length}`);
  const g = apres.find((o: VerdictSonde) => o.id === "fenG");
  const d = apres.find((o: VerdictSonde) => o.id === "fenD");
  if (!ok(g && d && !g.orphelin && !d.orphelin, `les deux fenêtres doivent rester sur un mur, vu ${JSON.stringify(apres)}`)) return;
  ok(Math.abs(g.x - 150) < 6 && g.y > 20, `la fenêtre de la moitié poussée doit descendre avec elle, vue ${JSON.stringify(g)}`);
  ok(Math.abs(d.x - 650) < 6 && Math.abs(d.y) < 6, `la fenêtre de la moitié immobile ne doit pas bouger, vue ${JSON.stringify(d)}`);
});

// LOOKING CHANGES NOTHING, corner insertion included. A press-release without movement on a facade
// only selects it, so the outline must come back byte for byte: otherwise every click on a wall
// would fatten the polygon with an invisible corner.
await test("un_clic_net_sur_une_facade_n_insere_aucun_coin", async () => {
  await seedFacadeCoupee();
  const avant = JSON.stringify(await contour());
  const nAvant = (await mursContour()).length;
  const survol = await aptPoint(225, 2);
  await M("mouseMoved", survol.x, survol.y, { button: "none", buttons: 0 }); await pause(250);
  const rond = await centerOf(".v5wmove");
  if (!ok(rond, "bouton rond introuvable")) return;
  await click(rond);
  await pause(150);
  ok(JSON.stringify(await contour()) === avant, `le contour doit être inchangé, vu ${JSON.stringify(await contour())}`);
  ok((await mursContour()).length === nAvant, "un clic net ne doit créer aucun mur de façade");
});

// A PERPENDICULAR NEIGHBOUR JUST GROWS. Pushing the top edge of a plain rectangle shortens the two
// side facades and that is all: inserting a corner there would multiply the vertices on every
// ordinary drag, which is the common case.
await test("pousser_une_facade_de_rectangle_n_ajoute_aucun_sommet", async () => {
  await evaluate(`__plan.setModel({outline:[[0,0],[900,0],[900,600],[0,600]],walls:[
    {id:"f0",a:[0,0],b:[900,0],t:12,isOutline:1},{id:"f1",a:[900,0],b:[900,600],t:12,isOutline:1},
    {id:"f2",a:[900,600],b:[0,600],t:12,isOutline:1},{id:"f3",a:[0,600],b:[0,0],t:12,isOutline:1}
  ],openings:[],pieces:[],cells:[]}); true`);
  await pause(150);
  const survol = await aptPoint(450, 2);
  await M("mouseMoved", survol.x, survol.y, { button: "none", buttons: 0 }); await pause(250);
  const rond = await centerOf(".v5wmove");
  if (!ok(rond, "bouton rond introuvable sur la façade du haut")) return;
  await drag(rond, { x: rond.x, y: rond.y + 80 }, 14);
  await pause(200);
  const O = await contour();
  ok(O.length === 4, `le contour doit rester à quatre sommets, vu ${JSON.stringify(O)}`);
  ok(obliques(O).length === 0, `aucune arête oblique, vu ${JSON.stringify(obliques(O))}`);
  ok(O.filter((p: VerdictSonde) => p[1] > 20).length === 4, `la façade doit avoir glissé, vu ${JSON.stringify(O)}`);
});

// AND A ROUND TRIP RETURNS TO THE STARTING POINT. Pushing a half and bringing it back leaves two
// vertices on the same spot; kept, the outline would gather an invisible corner per round trip.
await test("aller_retour_sur_une_moitie_ne_laisse_pas_de_sommet_double", async () => {
  await seedFacadeCoupee();
  const nAvant = (await contour()).length;
  const survol = await aptPoint(225, 2);
  await M("mouseMoved", survol.x, survol.y, { button: "none", buttons: 0 }); await pause(250);
  const rond = await centerOf(".v5wmove");
  if (!ok(rond, "bouton rond introuvable")) return;
  await M("mouseMoved", rond.x, rond.y, { button: "none", buttons: 0 });
  await M("mousePressed", rond.x, rond.y);
  for (let i = 1; i <= 10; i++) { await M("mouseMoved", rond.x, rond.y + 90 * i / 10); await pause(8); }
  for (let i = 10; i >= 0; i--) { await M("mouseMoved", rond.x, rond.y + 90 * i / 10); await pause(8); }
  await M("mouseReleased", rond.x, rond.y, { buttons: 0 });
  await pause(250);
  const O = await contour();
  ok(O.length === nAvant, `le contour doit retrouver ses ${nAvant} sommets, vu ${JSON.stringify(O)}`);
  for (let i = 0; i < O.length; i++) {
    const a = O[i], b = O[(i + 1) % O.length];
    ok(Math.hypot(b[0] - a[0], b[1] - a[1]) > 1, `aucun sommet double attendu, vu ${JSON.stringify(O)}`);
  }
});

// AND A CORNER STAYS ON ITS AXES. The other way to bend the outline was to drag a vertex anywhere:
// the two edges resting on it then tilted. A dragged corner now carries its neighbours along the
// constant axis of each shared edge, so the shape steps at right angles instead of pivoting.
await test("tirer_un_sommet_ne_rend_aucune_facade_oblique", async () => {
  await seedFacadeCoupee();
  const survol = await aptPoint(225, 2);
  await M("mouseMoved", survol.x, survol.y, { button: "none", buttons: 0 }); await pause(250);
  const rond = await centerOf(".v5wmove");
  if (rond) { await click(rond); await pause(250); }
  const coin = await centerOf(".vtx");
  if (!ok(coin, "aucune poignée de sommet visible sur le contour sélectionné")) return;
  await drag(coin, { x: coin.x + 90, y: coin.y + 70 }, 16);
  await pause(250);
  const O = await contour();
  const obl = obliques(O);
  ok(obl.length === 0, `tirer un sommet ne doit rendre aucune arête oblique, vu ${JSON.stringify(obl)}`);
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
