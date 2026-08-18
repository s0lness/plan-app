#!/usr/bin/env node
// ONE AIM-BASED EDITING MODEL, REAL MOUSE AND FINGER THROUGH CDP.
// The target under the pointer, plus Shift for the lasso, is the whole interaction contract.

import type { VerdictSonde } from "./_types.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

type Cible = { type: string; webSocketDebuggerUrl: string };
type Reponse = { id?: number; result?: { result?: { value?: unknown }; exceptionDetails?: unknown } };
type Point = { x: number; y: number };
const ici = path.dirname(fileURLToPath(import.meta.url));
const app = process.argv[2] || path.join(ici, "..", "index.html");
const seedInitial = JSON.parse(fs.readFileSync(path.join(ici, "fixtures", "plan-rev177.json"), "utf8"));
const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "plan-sans-mode-"));
const pagePath = path.join(dossier, "case.html");
fs.writeFileSync(pagePath, `<!doctype html><html><head><meta charset="utf-8"><script>
window.__PLAN_TEST__=1;try{localStorage.clear();localStorage.setItem("room-planner-v4",${JSON.stringify(JSON.stringify(seedInitial))})}catch(e){}<\/script></head><body>${fs.readFileSync(app, "utf8")}</body></html>`, "utf8");
const profil = path.join(dossier, "profil");
const chrome = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--user-data-dir=" + profil, "--remote-debugging-port=0", "--window-size=1680,1000", "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
const portPath = path.join(profil, "DevToolsActivePort");
for (let i = 0; i < 300 && !fs.existsSync(portPath); i++) await new Promise(r => setTimeout(r, 50));
if (!fs.existsSync(portPath)) throw new Error("no DevToolsActivePort");
const port = fs.readFileSync(portPath, "utf8").split("\n")[0]!.trim();
const cibles = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Cible[];
const cible = cibles.find(c => c.type === "page")!;
const ws = new WebSocket(cible.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let no = 0;
const attentes = new Map<number, (m: Reponse) => void>();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && attentes.has(m.id)) { const f = attentes.get(m.id)!; attentes.delete(m.id); f(m); } };
function send(method: string, params: Record<string, unknown> = {}) {
  const id = ++no; return new Promise<Reponse>(resolve => { attentes.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
}
async function evaluer(expression: string): Promise<any> {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error("EVAL: " + JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}
const lire = async (expression: string) => JSON.parse(await evaluer(`JSON.stringify(${expression})`));
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
await send("Page.enable"); await send("Runtime.enable");
async function recharger() {
  await send("Page.navigate", { url: "file:///" + pagePath.replace(/\\/g, "/") });
  for (let i = 0; i < 200; i++) {
    let pret = ""; try { pret = await evaluer("document.readyState+'|'+(window.__plan?1:0)"); } catch (_) {}
    if (pret === "complete|1") return; await pause(50);
  }
  throw new Error("application non prête");
}
const souris = (type: string, p: Point, extra: Record<string, unknown> = {}) => send("Input.dispatchMouseEvent", {
  type, x: p.x, y: p.y, button: type === "mouseMoved" ? "none" : "left",
  buttons: type === "mousePressed" ? 1 : 0, clickCount: 1, pointerType: "mouse", ...extra,
});
async function pointer(p: Point) { await souris("mouseMoved", p); await pause(100); }
async function cliquer(p: Point) { await pointer(p); await souris("mousePressed", p); await souris("mouseReleased", p); await pause(120); }
async function glisser(a: Point, b: Point, modifiers = 0) {
  await pointer(a); await souris("mousePressed", a, { modifiers });
  for (let i = 1; i <= 14; i++) { await souris("mouseMoved", { x: a.x + (b.x - a.x) * i / 14, y: a.y + (b.y - a.y) * i / 14 }, { buttons: 1, modifiers }); await pause(8); }
  await souris("mouseReleased", b, { modifiers }); await pause(160);
}
const centre = (selecteur: string) => lire(`(function(){var e=document.querySelector(${JSON.stringify(selecteur)});if(!e)return null;var r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
const apt = (x: number, y: number) => lire(`(function(){var p=__plan.aptToScreen(${x},${y}),r=document.getElementById("viewport").getBoundingClientRect();return{x:r.left+p.x,y:r.top+p.y}})()`);
const mur = (id: string) => lire(`(function(){var w=__plan.v5WallById(${JSON.stringify(id)});return w?{a:w.a,b:w.b,isOutline:!!w.isOutline}:null})()`);
const verdicts: VerdictSonde[] = [];
let courant: VerdictSonde;
function ok(v: unknown, message: string) { if (!v) courant.fails.push(message); return !!v; }
async function test(name: string, fn: () => Promise<void>) {
  courant = { name, fails: [] }; await recharger();
  try { await fn(); } catch (e) { courant.fails.push("EXCEPTION: " + ((e as Error)?.stack || e)); }
  verdicts.push(courant); console.log(`  ${courant.fails.length ? "FAIL " : "ok   "} ${name}`);
  courant.fails.forEach(f => console.log("        - " + f));
}
async function semer(meuble = false) {
  await evaluer(`__plan.setModel({outline:[[0,0],[420,0],[420,360],[0,360]],walls:[
    {id:"w1",a:[${meuble ? "100,80" : "210,0"}],b:[${meuble ? "100,280" : "210,360"}],t:12,free:1${meuble ? ",isOutline:1" : ""}},
    {id:"o0",a:[0,0],b:[420,0],t:12,isOutline:1},{id:"o1",a:[420,0],b:[420,360],t:12,isOutline:1},
    {id:"o2",a:[420,360],b:[0,360],t:12,isOutline:1},{id:"o3",a:[0,360],b:[0,0],t:12,isOutline:1}
  ],openings:[],pieces:[],
    cells:${meuble ? '[{id:"c1",name:"Room",floor:"plain",poly:[[0,0],[420,0],[420,360],[0,360]]}]' : "[]"}});true`);
  await pause(160);
}
const sansMode = () => evaluer(`!document.getElementById("btnModeFurn")&&!document.getElementById("btnModeWalls")&&!document.getElementById("wallsHint")&&!document.querySelector(".v5layer.editing,.v5layer.cellpick")`);

await test("survol_poignees_et_transformations", async () => {
  await semer(); ok(await sansMode(), "les commandes et classes du mode Walls doivent avoir disparu");
  await pointer(await apt(210, 180)); const h = await centre('.v5wmove[data-w="w1"]'); if (!ok(h, "move absent au survol")) return;
  await cliquer(h); ok(await evaluer(`String(__plan.v5ui.selWall)`) === "w1", "move doit sélectionner");
  const avant = await mur("w1"); await glisser(h, { x: h.x + 50, y: h.y }); const apres = await mur("w1");
  ok(apres.a[0] !== avant.a[0], "move doit déplacer le mur"); await pointer(await apt(apres.a[0], 180));
  ok(await centre('.v5wend[data-w="w1"]'), "les extrémités doivent apparaître");
  ok(await centre('.v5wmid[data-w="w1"]'), "le coude doit apparaître");
});

await test("sol_corps_shift_et_doigt", async () => {
  await semer(); ok(await sansMode(), "aucun mode ne doit armer le dessin");
  let n = await evaluer(`__plan.state.plan.walls.filter(function(w){return !w.isOutline}).length`);
  await glisser(await apt(70, 80), await apt(160, 80)); ok(await evaluer(`__plan.state.plan.walls.filter(function(w){return !w.isOutline}).length`) === ++n, "le sol doit dessiner");
  await glisser(await apt(210, 210), await apt(330, 210)); ok(await evaluer(`__plan.state.plan.walls.filter(function(w){return !w.isOutline}).length`) === ++n, "le corps du mur doit dessiner");
  await glisser(await apt(50, 250), await apt(170, 330), 8); ok(await evaluer(`__plan.state.plan.walls.filter(function(w){return !w.isOutline}).length`) === n, "Shift doit lasser");
  const a = await apt(80, 300), avant = await lire(`__plan.viewTransform()`);
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: a.x, y: a.y, id: 1 }] });
  await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: a.x + 90, y: a.y, id: 1 }] });
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await pause(150);
  const apres = await lire(`__plan.viewTransform()`); ok(apres.ox !== avant.ox || apres.oy !== avant.oy, "un doigt doit déplacer la vue");
});

await test("meuble_sur_mur_toujours_deplacable", async () => {
  await semer(true); ok(await sansMode(), "aucun mode ne doit pouvoir geler le mobilier");
  const id = await evaluer(`String(__plan.addV5Piece("chair",70,150).id)`); await pause(100);
  const p = await centre(`.piece[data-id="${id}"]`); if (!ok(p, "meuble absent")) return;
  const avant = await lire(`(function(){var p=__plan.state.plan.pieces.find(function(x){return String(x.id)===${JSON.stringify(id)}});return{x:p.x,y:p.y}})()`);
  const cible = await evaluer(`document.elementFromPoint(${p.x},${p.y})?.closest(".piece")?.dataset.id||""`);
  await glisser(p, { x: p.x + 120, y: p.y }); const apres = await lire(`(function(){var p=__plan.state.plan.pieces.find(function(x){return String(x.id)===${JSON.stringify(id)}});return{x:p.x,y:p.y}})()`);
  ok(apres.x !== avant.x || apres.y !== avant.y, `le meuble superposé au mur doit bouger, cible=${cible}, sélection=${await evaluer("String(__plan.selId)")}, avant=${JSON.stringify(avant)}, après=${JSON.stringify(apres)}`);
});

await test("nom_selectionne_piece_et_ouvre_fiche", async () => {
  await semer(); ok(await sansMode(), "le nom doit être cliquable sans cellpick");
  const p = await centre('.ov-name[data-c]'); if (!ok(p, "nom de pièce absent")) return;
  const id = await evaluer(`document.querySelector(".ov-name[data-c]").dataset.c`); await cliquer(p);
  ok(await evaluer(`String(__plan.v5ui.selCell)`) === String(id), "le nom doit sélectionner la pièce");
  ok(await evaluer(`document.getElementById("roomCard").hidden`) === false, "le nom doit ouvrir la fiche");
});

await test("facade_selectionnee_revele_puis_range_contour", async () => {
  await semer(); ok(await sansMode(), "la façade doit remplacer le mode comme porte d'entrée du contour");
  const id = await evaluer(`String(__plan.state.plan.walls.find(function(w){return w.isOutline}).id)`);
  await pointer(await apt(180, 0)); const h = await centre(`.v5wmove[data-w="${id}"]`); if (!ok(h, "sélection de façade absente")) return;
  await cliquer(h); ok(await evaluer(`String(__plan.v5ui.selWall)`) === id, "la façade doit être sélectionnée");
  ok(await evaluer(`document.querySelectorAll(".edge,.mid,.vtx").length`) > 0, "la façade sélectionnée doit révéler le contour");
  await cliquer(await apt(80, 180)); ok(await evaluer(`document.querySelectorAll(".edge,.mid,.vtx").length`) === 0, "un clic vide doit ranger le contour");
});

await test("escape_annule_geste_et_ferme_fiche", async () => {
  await semer(); ok(await sansMode(), "Escape ne doit plus changer de mode");
  const n = await evaluer(`__plan.state.plan.walls.filter(function(w){return !w.isOutline}).length`), a = await apt(70, 90), b = await apt(160, 90);
  await pointer(a); await souris("mousePressed", a); await souris("mouseMoved", b, { buttons: 1 });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  await souris("mouseReleased", b); await pause(120); ok(await evaluer(`__plan.state.plan.walls.filter(function(w){return !w.isOutline}).length`) === n, "Escape doit annuler le mur en cours");
  const nom = await centre('.ov-name[data-c]'); if (!nom) return; await cliquer(nom);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" }); await pause(100);
  ok(await evaluer(`document.getElementById("roomCard").hidden`) === true, "Escape doit fermer la fiche");
});

const rouges = verdicts.filter(v => v.fails.length);
console.log("");
if (rouges.length) { console.log(`FAILURES ${rouges.length}/${verdicts.length}:`); rouges.forEach(v => v.fails.forEach(f => console.log(`  - ${v.name}: ${f}`))); }
else console.log(`OK ${verdicts.length}/${verdicts.length}`);
ws.close(); chrome.kill(); try { fs.rmSync(dossier, { recursive: true, force: true }); } catch (_) {}
process.exit(rouges.length ? 1 : 0);
