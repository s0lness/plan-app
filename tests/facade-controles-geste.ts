#!/usr/bin/env node
// =============================================================================
//  "A FACADE ONLY SHOWED ITS ROUND BUTTON" SUITE: REAL MOUSE (CDP)
// =============================================================================
// Hovering an interior partition gives five controls: the move disc, the "+" that splits, the "×"
// that deletes, the two endpoint handles, and the link that welds. Hovering a FACADE gave ONE, the
// move disc. Measured: a probe hovering a facade and looking for `.v5wmid` found nothing.
//
// Owner's request, verbatim: « les murs de façade ont un bouton de saisie; quand un autre mur coupe
// une façade je veux que les deux moitiés aient ce bouton en leur centre », and « je peux resize un
// mur de façade comme je veux, donc je devrais aussi pouvoir le couper ».
//
// A hovered facade therefore carries its "+" (which cuts it into two independently movable halves,
// `v5CouperContour`) and its weld link (which removes the flat outline vertex between two collinear
// halves). TWO EXCEPTIONS, both deliberate:
//   - NO delete cross: an outline wall is DERIVED from the outline, it cannot be deleted
//     (`v5WallDeleteVerdict` verdict `facade`);
//   - NO endpoint handles: a facade's ends are the outline's CORNERS, which already carry their own
//     `.vtx` handle. Two controls on the same pixel cancel each other out.
// And the facade's "+" sits INSIDE the flat, because the outline's own corner-insertion "+"
// (`.mid`, G-15) is already 18 px OUTSIDE the same edge. Both must stay reachable, which is
// measured here by `elementFromPoint`, not by counting rectangles.
//
//   node tests/facade-controles-geste.ts [path/to/app.html]
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-facade-controles-"));
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
  await pause(120);
}
async function drag(from: VerdictSonde, to: VerdictSonde, steps = 14) {
  await M("mouseMoved", from.x, from.y, { button: "none", buttons: 0 });
  await M("mousePressed", from.x, from.y);
  for (let i = 1; i <= steps; i++) {
    await M("mouseMoved", from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
    await pause(8);
  }
  await M("mouseReleased", to.x, to.y, { buttons: 0 });
  await pause(120);
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
const rectOf = (sel: string) => J(`(function(){var e=document.querySelector(${JSON.stringify(sel)});
  if(!e) return null; var r=e.getBoundingClientRect();
  return {x:r.left,y:r.top,w:r.width,h:r.height};})()`);
const compte = (sel: string) => evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const aptPoint = (x: number, y: number) => J(`(function(){var s=__plan.aptToScreen(${x},${y});
  var r=document.getElementById("viewport").getBoundingClientRect(); return {x:r.left+s.x,y:r.top+s.y};})()`);
const contour = () => J(`__plan.state.plan.outline`);
const mursContour = () => J(`__plan.state.plan.walls.filter(function(w){return !!w.isOutline})
  .map(function(w){return {id:String(w.id),a:w.a,b:w.b}})`);
// Where each opening SITS, in apartment centimetres, read THROUGH its wall: an opening that changes
// wall without moving on the floor is a silent re-homing, which is exactly what has to be caught.
const ouvertures = () => J(`__plan.state.plan.openings.map(function(o){
  var w=__plan.state.plan.walls.filter(function(x){return String(x.id)===String(o.wallId)})[0];
  if(!w) return {id:String(o.id),orphelin:true};
  var L=Math.hypot(w.b[0]-w.a[0],w.b[1]-w.a[1])||1, t=(o.t0+o.w/2)/L;
  return {id:String(o.id),x:Math.round(w.a[0]+(w.b[0]-w.a[0])*t),y:Math.round(w.a[1]+(w.b[1]-w.a[1])*t)};})`);
/** Is THIS element the one a click at its own centre would reach? The only honest reachability. */
const atteignable = (sel: string) => evaluate(`(function(){
  var e=document.querySelector(${JSON.stringify(sel)}); if(!e) return "absent";
  var r=e.getBoundingClientRect(); var t=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
  return (t===e || e.contains(t)) ? "oui" : ("vole par " + (t?t.className||t.tagName:"rien"));})()`);
const survoler = async (x: number, y: number) => {
  const p = await aptPoint(x, y);
  await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 });
  await pause(250);
  return p;
};

/** A plain 900x600 rectangle, no partitions: four facades, four right-angle corners. */
async function seedRectangle() {
  await evaluate(`__plan.setModel({outline:[[0,0],[900,0],[900,600],[0,600]],walls:[
    {id:"f0",a:[0,0],b:[900,0],t:12,isOutline:1},{id:"f1",a:[900,0],b:[900,600],t:12,isOutline:1},
    {id:"f2",a:[900,600],b:[0,600],t:12,isOutline:1},{id:"f3",a:[0,600],b:[0,0],t:12,isOutline:1}
  ],openings:[],pieces:[],cells:[]}); true`);
  await pause(150);
}

/** The same rectangle whose TOP facade is already cut in two, one window on each half. */
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

// A HOVERED FACADE SHOWS ITS "+", AND STILL NOT ITS CROSS NOR ITS ENDS. The measurement that opened
// this batch: hovering a facade and looking for `.v5wmid` found nothing at all.
await test("une_facade_survolee_offre_sa_coupe_jamais_sa_croix_ni_ses_bouts", async () => {
  await seedRectangle();
  await survoler(450, 2);
  ok(await centerOf('.v5wmove[data-w="f0"]'), "la façade doit garder son bouton rond de déplacement");
  ok(await centerOf('.v5wmid[data-w="f0"]'), "la façade survolée doit offrir son « + » de coupe");
  ok(await compte('.v5wx[data-w="f0"]') === 0, "une façade ne se supprime pas: aucune croix");
  ok(await compte('.v5wend[data-w="f0"]') === 0,
    "les bouts d'une façade sont les coins du contour, qui ont déjà leur poignée: aucune poignée de bout");
  ok(await compte('.v5wjoin[data-w="f0"]') === 0,
    "aux angles droits d'un rectangle il n'y a rien à ressouder: aucun maillon");
});

// THE FACADE'S "+" AND THE OUTLINE'S "+" ARE TWO CONTROLS, AND BOTH ARE REACHABLE. The outline's
// corner insertion sits 18 px OUTSIDE the edge (G-15); the facade's split therefore sits INSIDE.
// Counting two rectangles proves nothing: what is measured is that a click at each one's own centre
// actually lands on it.
await test("les_deux_plus_d_une_facade_ne_se_marchent_pas_dessus", async () => {
  await seedRectangle();
  await survoler(450, 2);
  const bouton = await centerOf('.v5wmove[data-w="f0"]');
  if (!ok(bouton, "bouton rond introuvable")) return;
  await click(bouton);                       // sélectionner la façade révèle la bande et les « + » du contour
  await survoler(450, 2);
  const coupe = await rectOf('.v5wmid[data-w="f0"]');
  const insertion = await rectOf(".mid");
  if (!ok(coupe && insertion, `les deux « + » doivent être présents, vu coupe=${JSON.stringify(coupe)} insertion=${JSON.stringify(insertion)}`)) return;
  const chevauche = coupe.x < insertion.x + insertion.w && insertion.x < coupe.x + coupe.w
    && coupe.y < insertion.y + insertion.h && insertion.y < coupe.y + coupe.h;
  ok(!chevauche, `les deux « + » ne doivent pas se recouvrir, vu ${JSON.stringify(coupe)} et ${JSON.stringify(insertion)}`);
  ok(await atteignable('.v5wmid[data-w="f0"]') === "oui", `le « + » de la façade doit être atteignable, vu ${await atteignable('.v5wmid[data-w="f0"]')}`);
  ok(await atteignable(".mid") === "oui", `le « + » d'insertion de coin doit rester atteignable, vu ${await atteignable(".mid")}`);
  // Et le « + » de la façade est du côté INTÉRIEUR, l'autre restant dehors.
  const mur = await aptPoint(450, 0);
  ok(coupe.y + coupe.h / 2 > mur.y, "le « + » de la façade se pose vers l'intérieur du logement");
  ok(insertion.y + insertion.h / 2 < mur.y, "le « + » d'insertion de coin reste à l'extérieur");
});

// AND IT REALLY CUTS: two halves, each with its own grab button at ITS OWN centre. Owner's words:
// « quand un autre mur coupe une façade je veux que les deux moitiés aient ce bouton en leur
// centre ». Cutting a facade is inserting an outline vertex, never splitting a stored wall.
await test("le_plus_d_une_facade_la_coupe_en_deux_moities_saisissables", async () => {
  await seedRectangle();
  await survoler(450, 2);
  const plus = await centerOf('.v5wmid[data-w="f0"]');
  if (!ok(plus, "« + » de coupe introuvable sur la façade")) return;
  await click(plus);
  await pause(200);
  const O = await contour();
  ok(O.length === 5, `le contour doit gagner un sommet, vu ${JSON.stringify(O)}`);
  ok((await mursContour()).length === 5, `il doit y avoir cinq façades, vu ${JSON.stringify(await mursContour())}`);
  ok(O.some((p: VerdictSonde) => Math.abs(p[0] - 450) < 1 && Math.abs(p[1]) < 1),
    `le sommet doit être au milieu de la façade, vu ${JSON.stringify(O)}`);
  // Chaque moitié porte SON bouton, en SON centre: on les attrape l'une après l'autre.
  const gauche = await survoler(225, 2);
  const bG = await centerOf(".v5wmove");
  if (!ok(bG, "la moitié gauche doit porter son bouton")) return;
  ok(Math.abs(bG.x - gauche.x) < 14 && Math.abs(bG.y - gauche.y) < 14,
    `le bouton de la moitié gauche doit être en son centre, vu ${JSON.stringify(bG)} attendu ${JSON.stringify(gauche)}`);
  const droite = await survoler(675, 2);
  const bD = await centerOf(".v5wmove");
  if (!ok(bD, "la moitié droite doit porter son bouton")) return;
  ok(Math.abs(bD.x - droite.x) < 14 && Math.abs(bD.y - droite.y) < 14,
    `le bouton de la moitié droite doit être en son centre, vu ${JSON.stringify(bD)} attendu ${JSON.stringify(droite)}`);
  // Et une moitié se pousse toute seule: c'est ce que « comme si c'était deux façades » veut dire.
  await drag(bD, { x: bD.x, y: bD.y + 90 }, 14);
  await pause(200);
  const O2 = await contour();
  ok(O2.filter((p: VerdictSonde) => p[1] > 20 && p[1] < 400).length >= 2,
    `la moitié droite doit avoir bougé seule, vu ${JSON.stringify(O2)}`);
  ok(O2.some((p: VerdictSonde) => Math.abs(p[0]) < 1 && Math.abs(p[1]) < 1),
    `le coin haut-gauche ne doit pas avoir bougé, vu ${JSON.stringify(O2)}`);
});

// THE LINK ONLY EXISTS ON A FLAT VERTEX, and welding two halves back MUST NOT COST A WINDOW. That
// second half is the data loss this batch opened with: removing an outline vertex used to delete
// every opening carried by the edge that disappeared, in silence.
await test("le_maillon_ressoude_les_deux_moities_sans_perdre_de_fenetre", async () => {
  await seedFacadeCoupee();
  const avant = await ouvertures();
  await survoler(225, 2);
  ok(await compte('.v5wjoin[data-w="f0"]') === 1,
    `la moitié gauche doit offrir UN maillon, au sommet plat, vu ${await compte('.v5wjoin[data-w="f0"]')}`);
  const maillon = await centerOf('.v5wjoin[data-w="f0"]');
  if (!ok(maillon, "maillon de ressoudure introuvable")) return;
  ok(await atteignable('.v5wjoin[data-w="f0"]') === "oui", `le maillon doit être atteignable, vu ${await atteignable('.v5wjoin[data-w="f0"]')}`);
  await click(maillon);
  await pause(250);
  const O = await contour();
  ok(O.length === 4, `le contour doit retomber à quatre sommets, vu ${JSON.stringify(O)}`);
  ok((await mursContour()).length === 4, `il doit rester quatre façades, vu ${JSON.stringify(await mursContour())}`);
  const apres = await ouvertures();
  ok(apres.length === avant.length, `aucune fenêtre ne doit disparaître, vu ${avant.length} puis ${apres.length}`);
  for (const t of avant) {
    const o = apres.find((q: VerdictSonde) => q.id === t.id);
    if (!ok(o && !o.orphelin, `${t.id} a disparu ou n'a plus de mur, vu ${JSON.stringify(apres)}`)) continue;
    ok(Math.abs(o.x - t.x) < 2 && Math.abs(o.y - t.y) < 2,
      `${t.id} doit rester exactement où elle était: ${JSON.stringify(t)} puis ${JSON.stringify(o)}`);
  }
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
