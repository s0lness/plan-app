#!/usr/bin/env node
// =============================================================================
//  "LE SOL SUIT LA MAIN" SUITE — REAL MOUSE (CDP)
// =============================================================================
// Owner's report: "when i move a facade the ground underneath lags behind significantly".
//
// The walls followed the hand frame by frame, but the FLOOR is painted from the CELLS
// (`renderFond`), and the cells were rebuilt only on release (`if (final) v5RebuildCells(P)` in
// `v5ResoudreGeometrie`). So the background stayed frozen for the whole gesture, then jumped.
// Measured on the real plan (22 walls, 10 cells), a facade pushed from 1090 to 1320 cm: the model
// followed live, 60 fps held, while the painted surface stayed at g=1098 d=1269 through all 20
// steps of the slide, then jumped to g=659 d=1089 on release. The guard saved 0,40 ms of median
// (0,7 ms p90) on a 16,7 ms frame budget: it paid for nothing.
//
// TWO CASES, and the second is the hard one:
//   1. le_sol_suit_la_facade_pendant_le_glissement    the painted floor moves DURING the gesture,
//      sits exactly under the outline, and does not JUMP on release.
//   2. un_nom_saisi_survit_a_une_piece_balayee        rebuilding every frame makes the plan cross
//      every INTERMEDIATE state; a room swept by a wall merges with its neighbour and one of the
//      two names is dropped, for good, even though the geometry comes back exactly where it was.
//      Names are therefore matched from a PHOTO of the cells taken at the start of the gesture
//      (`modele/photo-cellules.ts`), never from the previous frame.
//
//   node tests/sol-suit-la-main-geste.ts [path/to/app.html]
//
// Real mouse (`Input.dispatchMouseEvent`), never a synthetic PointerEvent: AGENTS.md, "A click
// lands on what is visible". Every wait is on a CONDITION or on the app's own paint, never on a
// duration meant to "be enough".

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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-sol-suit-"));
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

// WHAT IS PAINTED, and what the model says at the same instant. The floor is the set of cell
// polygons in the floors layer (`svg.v5svg-sol`, direct children: the `<rect>` under `<g>` are the
// grid, the patterns live in `<defs>`); `contourHaut` is where the MODEL's outline says the top of
// the flat is, converted to the same coordinates. The two must agree, at every instant.
const etatPeint = () => J(`(function(){
  var vp=document.getElementById("viewport").getBoundingClientRect();
  var ps=document.querySelectorAll("svg.v5svg-sol > polygon");
  var h=1e9,b=-1e9,g=1e9,d=-1e9,n=0;
  for(var i=0;i<ps.length;i++){var r=ps[i].getBoundingClientRect();
    if(r.width<1&&r.height<1) continue;
    n++; h=Math.min(h,r.top-vp.top); b=Math.max(b,r.bottom-vp.top);
    g=Math.min(g,r.left-vp.left); d=Math.max(d,r.right-vp.left);}
  var O=__plan.state.plan.outline||[], ys=[];
  for(var k=0;k<O.length;k++) ys.push(__plan.aptToScreen(O[k][0],O[k][1]).y);
  return {sols:n, solHaut:Math.round(h), solBas:Math.round(b), solG:Math.round(g), solD:Math.round(d),
          contourHaut:Math.round(Math.min.apply(null,ys)),
          cellules:(__plan.state.plan.cells||[]).map(function(c){return {id:String(c.id),nom:c.name};})};})()`);

// A plain rectangle: one facade to push, one floor to watch. Nothing else in the way.
async function seedRectangle() {
  await evaluate(`__plan.setModel({outline:[[0,0],[900,0],[900,600],[0,600]],walls:[
    {id:"f0",a:[0,0],b:[900,0],t:12,isOutline:1},{id:"f1",a:[900,0],b:[900,600],t:12,isOutline:1},
    {id:"f2",a:[900,600],b:[0,600],t:12,isOutline:1},{id:"f3",a:[0,600],b:[0,0],t:12,isOutline:1}
  ],openings:[],pieces:[],cells:[]}); true`);
  await pause(150);
}

// Two rooms separated by ONE partition: the shape where a sweep can make a room disappear into its
// neighbour, then give it back.
async function seedDeuxPieces() {
  await evaluate(`__plan.setModel({outline:[[0,0],[900,0],[900,600],[0,600]],walls:[
    {id:"f0",a:[0,0],b:[900,0],t:12,isOutline:1},{id:"f1",a:[900,0],b:[900,600],t:12,isOutline:1},
    {id:"f2",a:[900,600],b:[0,600],t:12,isOutline:1},{id:"f3",a:[0,600],b:[0,0],t:12,isOutline:1},
    {id:"m1",a:[0,300],b:[900,300],t:12,isOutline:0}
  ],openings:[],pieces:[],cells:[]}); true`);
  await pause(150);
}

// LE SOL SUIT LA MAIN. The floor must move DURING the drag, stay exactly under the outline while it
// moves, and above all NOT JUMP on release: the jump is the defect, seen from the screen.
await test("le_sol_suit_la_facade_pendant_le_glissement", async () => {
  await seedRectangle();
  const depart = await etatPeint();
  if (!ok(depart.sols === 1, `un seul sol attendu au départ, vu ${depart.sols}`)) return;
  ok(Math.abs(depart.solHaut - depart.contourHaut) <= 3,
    `au repos le sol est déjà sous la façade, vu sol=${depart.solHaut} contour=${depart.contourHaut}`);
  const survol = await aptPoint(450, 2);
  await M("mouseMoved", survol.x, survol.y, { button: "none", buttons: 0 }); await pause(250);
  const rond = await centerOf(".v5wmove");
  if (!ok(rond, "la façade du haut doit porter son bouton rond de déplacement")) return;
  await M("mouseMoved", rond.x, rond.y, { button: "none", buttons: 0 });
  await M("mousePressed", rond.x, rond.y);
  for (let i = 1; i <= 8; i++) { await M("mouseMoved", rond.x, rond.y + 60 * i / 8); await pause(8); }
  const mi = await etatPeint();
  for (let i = 1; i <= 8; i++) { await M("mouseMoved", rond.x, rond.y + 60 + 60 * i / 8); await pause(8); }
  const fin = await etatPeint();
  await M("mouseReleased", rond.x, rond.y + 120, { buttons: 0 });
  await pause(150);
  const apres = await etatPeint();

  // 1. La façade a vraiment bougé, sinon le cas passerait en ne mesurant rien.
  ok(fin.contourHaut - depart.contourHaut > 40,
    `la façade doit avoir été poussée, contour ${depart.contourHaut} -> ${fin.contourHaut}`);
  // 2. Le sol a bougé PENDANT le geste, et progressivement.
  ok(mi.solHaut - depart.solHaut > 10,
    `le sol doit avoir suivi dès la première moitié du glissement, ${depart.solHaut} -> ${mi.solHaut}`);
  ok(fin.solHaut - mi.solHaut > 10,
    `le sol doit continuer de suivre, ${mi.solHaut} -> ${fin.solHaut}`);
  // 3. Il est SOUS le mur pendant tout le geste: ni trou blanc, ni décalage.
  ok(Math.abs(mi.solHaut - mi.contourHaut) <= 3,
    `à mi-geste le sol doit être sous la façade, vu sol=${mi.solHaut} contour=${mi.contourHaut}`);
  ok(Math.abs(fin.solHaut - fin.contourHaut) <= 3,
    `en fin de geste le sol doit être sous la façade, vu sol=${fin.solHaut} contour=${fin.contourHaut}`);
  // 4. ET LE RELÂCHEMENT NE SAUTE PAS. C'est le défaut vu par le propriétaire: tout le rattrapage
  //    avait lieu d'un coup, au relâchement.
  ok(Math.abs(apres.solHaut - fin.solHaut) <= 3,
    `le relâchement ne doit rien rattraper, sol ${fin.solHaut} -> ${apres.solHaut}`);
});

// ET AUCUN NOM NE SE PERD EN CHEMIN. Le mur balaie la pièce du bas jusqu'à la façade (les deux
// pièces n'en font plus qu'une), puis revient: la géométrie revient exactement où elle était, donc
// le nom saisi doit revenir avec elle. Sans la photo d'avant-geste, l'appariement se fait d'un état
// intermédiaire au suivant: la fusion ne garde qu'un nom des deux, et le second est perdu pour de
// bon.
await test("un_nom_saisi_survit_a_une_piece_balayee_puis_rouverte", async () => {
  await seedDeuxPieces();
  const avant = await etatPeint();
  if (!ok(avant.cellules.length === 2, `deux pièces attendues, vu ${JSON.stringify(avant.cellules)}`)) return;
  // La pièce du BAS, celle que le mur va balayer: les cellules sont ordonnées haut vers bas.
  const bas = avant.cellules[1];
  await evaluate(`(function(){__plan.selectCell(${JSON.stringify(bas.id)});
    var f=document.getElementById("rcName"); f.focus(); f.value="Chambre d'Elise";
    f.dispatchEvent(new Event("input",{bubbles:true})); f.blur(); return true;})()`);
  await pause(150);
  const nomDe = (e: VerdictSonde, i: number) => (e.cellules[i] || {}).nom;
  ok(nomDe(await etatPeint(), 1) === "Chambre d'Elise", "le nom saisi doit être posé avant le geste");

  // Le bouton rond de la cloison, puis un aller-retour: jusqu'à la façade du bas, et retour.
  const surMur = await aptPoint(450, 300);
  await M("mouseMoved", surMur.x, surMur.y, { button: "none", buttons: 0 }); await pause(250);
  const rond = await centerOf(".v5wmove");
  if (!ok(rond, "la cloison doit porter son bouton rond de déplacement")) return;
  const haut = await aptPoint(450, 300), bas600 = await aptPoint(450, 600);
  const course = bas600.y - haut.y;
  await M("mouseMoved", rond.x, rond.y, { button: "none", buttons: 0 });
  await M("mousePressed", rond.x, rond.y);
  for (let i = 1; i <= 12; i++) { await M("mouseMoved", rond.x, rond.y + course * i / 12); await pause(8); }
  const balaye = await etatPeint();
  for (let i = 11; i >= 0; i--) { await M("mouseMoved", rond.x, rond.y + course * i / 12); await pause(8); }
  await M("mouseReleased", rond.x, rond.y, { buttons: 0 });
  await pause(200);
  const apres = await etatPeint();

  // Le cas ne vaut que si le balayage a VRAIMENT fait disparaître la pièce du bas: sinon il ne
  // mesure pas ce qu'il annonce.
  ok(balaye.cellules.length === 1,
    `le balayage doit faire fusionner les deux pièces, vu ${JSON.stringify(balaye.cellules)}`);
  ok(apres.cellules.length === 2,
    `la pièce doit se rouvrir au retour, vu ${JSON.stringify(apres.cellules)}`);
  ok(apres.cellules.some((c: VerdictSonde) => c.nom === "Chambre d'Elise"),
    `le nom saisi doit survivre à l'aller-retour, vu ${JSON.stringify(apres.cellules)}`);
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
