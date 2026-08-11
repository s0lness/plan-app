#!/usr/bin/env node
// =============================================================================
//  SUITE "WORK LOSS" — REAL MOUSE (CDP), REAL HIT-TESTING
// =============================================================================
// Seven regressions born from two real-usage sessions. All of them have in common that they
// destroyed work IN SILENCE: nothing on screen said that something had just gone wrong. Each
// case is replayed with the browser's mouse (Input.dispatchMouseEvent), so through real
// hit-testing, real pointer capture and real listeners.
//
//   node tests/gestes-perte-de-travail.ts [path/to/app.html]
//
//   tracer_gagne_sur_les_poignees   starting a trace ON a wall dragged the FACADE (15.1 m2 -> 0.8)
//   mur_traversant_reste_entier     a wall crossed off its middle was cut in two on drag
//   meuble_trop_grand_ne_saute_pas  a too-wide sofa jumped 372 cm outside the dwelling
//   pas_de_mur_en_double            two strokes at the same spot = one more invisible wall
//   echap_annule_le_geste           Escape did nothing, except clear the selection under the finger
//   pose_ne_sempile_pas             ten palette clicks = ten pieces of furniture at the same pixel
//   poignee_plus_ne_vole_pas        the "+" covered the center of every facade
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-gestes-"));
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
      // The file can be LOCKED (EBUSY: Chrome still has it open), absent (ENOENT) or
      // truncated, all the more so when several Chromes start at the same time. We RETRY
      // until the timeout instead of throwing.
      let t: VerdictSonde[] = [];
      try { t = fs.readFileSync(portFile, "utf8").split("\n"); } catch { t = []; }
      if (t[0] && /^[0-9]+$/.test(t[0].trim())) return t[0].trim();
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("no DevToolsActivePort");
}
const port = await waitPort();
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as CibleCDP[];
const page = list.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => (ws.onopen = r));

let msgId = 0;
const pending = new Map<number, (message: ReponseCDP) => void>();
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m); }
};
function send(method: string, params?: Record<string, unknown>) {
  const id = ++msgId;
  return new Promise<ReponseCDP>(res => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); });
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
    if (st === "complete|1") break;
    await new Promise(r => setTimeout(r, 50));
  }
  await new Promise(r => setTimeout(r, 300));
}

// ---- REAL mouse / REAL keyboard ---------------------------------------------------------------
const M = (type: string, x: VerdictSonde, y: VerdictSonde, extra?: Record<string, unknown>) => send("Input.dispatchMouseEvent", Object.assign({
  type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1,
  clickCount: 1, pointerType: "mouse",
}, extra || {}));
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function press(p: VerdictSonde) { await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 }); await M("mousePressed", p.x, p.y); await pause(20); }
async function moveTo(p: VerdictSonde, steps = 8, from: VerdictSonde) {
  const a = from || p;
  for (let i = 1; i <= steps; i++) {
    await M("mouseMoved", a.x + (p.x - a.x) * i / steps, a.y + (p.y - a.y) * i / steps);
    await pause(8);
  }
}
async function release(p: VerdictSonde) { await M("mouseReleased", p.x, p.y); await pause(80); }
async function click(p: VerdictSonde, clickCount?: number) {
  await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 });
  await M("mousePressed", p.x, p.y, { clickCount: clickCount || 1 });
  await M("mouseReleased", p.x, p.y, { clickCount: clickCount || 1, buttons: 0 });
  await pause(60);
}
async function drag(from: VerdictSonde, to: VerdictSonde, steps = 12) { await press(from); await moveTo(to, steps, from); await release(to); }
async function key(k: string, code: string, vk: VerdictSonde) {
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk || 0 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk || 0 });
  await pause(40);
}

// ---- micro-harness -----------------------------------------------------------------------------
const results: VerdictSonde[] = [];
let cur: VerdictSonde = null;
function ok(cond: unknown, msg?: string) { if (!cond) cur.fails.push(msg); return !!cond; }
async function test(name: string, fn: (...args: VerdictSonde[]) => VerdictSonde | Promise<VerdictSonde>) {
  cur = { name, fails: [] };
  await reload();
  try { await fn(); } catch (e) { cur.fails.push("EXCEPTION: " + (e && e.stack || e)); }
  const jsErr = await evaluate(`JSON.stringify((JSON.parse(localStorage.getItem("plan-errors")||"[]")||[]).map(function(e){return e&&e.msg}))`);
  if (jsErr && jsErr !== "[]") cur.fails.push("erreurs JS: " + jsErr);
  results.push(cur);
  console.log(`  ${cur.fails.length ? "FAIL " : "ok   "} ${name}`);
  cur.fails.forEach((f: VerdictSonde) => console.log("        - " + f));
}

const centerOf = (sel: VerdictSonde) => J(`(function(){var e=document.querySelector(${JSON.stringify(sel)});
  if(!e) return null; var r=e.getBoundingClientRect(); if(!r.width&&!r.height) return null;
  return {x:r.left+r.width/2, y:r.top+r.height/2, w:r.width, h:r.height};})()`);
const aptPoint = (x: VerdictSonde, y: VerdictSonde) => J(`(function(){var s=__plan.aptToScreen(${x},${y});
  var r=document.getElementById("viewport").getBoundingClientRect();
  return {x:r.left+s.x, y:r.top+s.y};})()`);
const plan = () => J(`(function(){var P=__plan.plan;
  return {outline:P.outline, cells:P.cells.length,
          walls:P.walls.filter(function(w){return !w.isOutline;}).map(function(w){return {id:w.id,a:w.a,b:w.b};})};})()`);
// Installs an outline + our own walls, in apartment cm, then switches to Walls mode.
async function seedModel(walls: VerdictSonde, pieces?: VerdictSonde) {
  await evaluate(`__plan.setModel({outline:[[0,0],[420,0],[420,360],[0,360]],
    walls:${JSON.stringify(walls || [])}, openings:[], pieces:${JSON.stringify(pieces || [])}, cells:[]}); true`);
  await pause(150);
}
const wallsMode = (on: VerdictSonde) => evaluate(`__plan.wallsMode(${on ? "true" : "false"}); true`).then(() => pause(80));
const armDraw = async () => {
  if (await evaluate(`String(__plan.v5ui.draw)`) !== "true") await click(await centerOf("#btnDrawWall"));
  return await evaluate(`String(__plan.v5ui.draw)`) === "true";
};

// =============================================================================
//  1. tracer_gagne_sur_les_poignees
// =============================================================================
// The button's tooltip says "drag from one wall to another". A facade handle (`.edge`, 12 px
// wide on screen) cut off its pointerdown's propagation: the trace never reached v5StartDraw
// and the user DRAGGED the FACADE instead. Measured: 15.1 m2 reduced to a 20 cm strip, without
// a word. An ARMED tool must win over every handle.
await test("tracer_gagne_sur_les_poignees", async () => {
  await wallsMode(true);
  for (const dy of [0, 3, 6, 20]) {
    await seedModel([]);
    ok(await armDraw(), `départ à ${dy} cm : l'outil de tracé ne s'arme pas`);
    const cible = await evaluate(`(function(){var p=__plan.aptToScreen(140,${dy});
      var r=document.getElementById("viewport").getBoundingClientRect();
      var e=document.elementFromPoint(r.left+p.x, r.top+p.y); return e?String(e.className||e.tagName):"";})()`);
    await drag(await aptPoint(140, dy), await aptPoint(140, 340), 14);
    const P = await plan();
    ok(P.walls.length === 1, `départ à ${dy} cm du mur (sur « ${cible} ») : ${P.walls.length} cloison(s) tracée(s) au lieu d'une`);
    ok(JSON.stringify(P.outline) === JSON.stringify([[0, 0], [420, 0], [420, 360], [0, 360]]),
      `départ à ${dy} cm : le contour a été traîné -> ${JSON.stringify(P.outline)}`);
  }
  // The "+" at the middle of a facade doesn't steal the trace either.
  await seedModel([]);
  ok(await armDraw(), "l'outil de tracé ne s'arme pas (départ sur le « + »)");
  const mid = await centerOf(".v5layer .mid");
  if (ok(mid, "poignée « + » absente")) {
    await drag({ x: mid.x, y: mid.y }, await aptPoint(210, 340), 14);
    const P = await plan();
    ok(P.walls.length === 1, `départ sur le « + » : ${P.walls.length} cloison(s) au lieu d'une`);
    ok(P.outline.length === 4, `départ sur le « + » : un angle a été inséré (${P.outline.length} sommets)`);
  }
});

// =============================================================================
//  2. mur_traversant_reste_entier
// =============================================================================
// v5ThroughWall used to cast its ray from the wall's MIDDLE and stop at the first crossing:
// any wall crossed anywhere other than exactly at its middle was truncated on the next drag.
// [210,0]->[210,360] became [250,100]->[250,360], the top half vanished, 4 rooms became 3,
// silently. We prove the OFF-CENTER crossing, the MULTIPLE crossing, the centered cross, and
// we check that a real T-junction still holds.
await test("mur_traversant_reste_entier", async () => {
  await wallsMode(true);
  const dragWall = async (atX: VerdictSonde, atY: VerdictSonde, toX: VerdictSonde, toY: VerdictSonde) => {
    await drag(await aptPoint(atX, atY), await aptPoint(toX, toY), 14);
  };
  // --- OFF-CENTER crossing (the case from the report) ---
  await seedModel([{ id: "w1", a: [210, 0], b: [210, 360], t: 12 },
                   { id: "w2", a: [0, 100], b: [420, 100], t: 12 }]);
  const before = await plan();
  ok(before.cells === 4, "départ : 4 pièces attendues, " + before.cells);
  await dragWall(210, 280, 250, 280);      // grabbed in its BOTTOM QUARTER
  const after = await plan();
  const w1 = after.walls.find((w: VerdictSonde) => w.id === "w1");
  ok(after.cells === 4, `un mur traversant glissé ne doit pas faire disparaître de pièce (4 -> ${after.cells})`);
  ok(w1 && Math.abs(w1.a[1] - 0) < 1 && Math.abs(w1.b[1] - 360) < 1,
    "le mur doit rester entier sur toute sa hauteur : " + JSON.stringify(w1));

  // --- MULTIPLE crossings (two walls cross it, none at its middle) ---
  await seedModel([{ id: "w1", a: [210, 0], b: [210, 360], t: 12 },
                   { id: "w2", a: [0, 90], b: [420, 90], t: 12 },
                   { id: "w3", a: [0, 300], b: [420, 300], t: 12 }]);
  const m0 = await plan();
  ok(m0.cells === 6, "départ (croisements multiples) : 6 pièces attendues, " + m0.cells);
  await dragWall(210, 200, 260, 200);
  const m1 = await plan();
  const mw = m1.walls.find((w: VerdictSonde) => w.id === "w1");
  ok(m1.cells === 6, `croisements multiples : 6 pièces attendues après le glissement, ${m1.cells}`);
  ok(mw && Math.abs(mw.a[1] - 0) < 1 && Math.abs(mw.b[1] - 360) < 1,
    "croisements multiples : le mur doit rester entier " + JSON.stringify(mw));

  // --- CENTERED cross (the only case that used to work: it must keep working) ---
  await seedModel([{ id: "w1", a: [210, 0], b: [210, 360], t: 12 },
                   { id: "w2", a: [0, 180], b: [420, 180], t: 12 }]);
  await dragWall(210, 60, 250, 60);
  const x1 = await plan();
  const xw = x1.walls.find((w: VerdictSonde) => w.id === "w1");
  ok(x1.cells === 4, `croix centrée : 4 pièces attendues, ${x1.cells}`);
  ok(xw && Math.abs(xw.a[1] - 0) < 1 && Math.abs(xw.b[1] - 360) < 1,
    "croix centrée : le mur doit rester entier " + JSON.stringify(xw));

  // --- T-junction: a wall that DIES on another must not start crossing through it ---
  await seedModel([{ id: "w1", a: [210, 0], b: [210, 360], t: 12 },
                   { id: "w2", a: [210, 180], b: [420, 180], t: 12 }]);
  const t0 = await plan();
  const tw = t0.walls.find((w: VerdictSonde) => w.id === "w2");
  ok(tw && Math.abs(tw.a[0] - 210) < 1 && Math.abs(tw.b[0] - 420) < 1,
    "jonction en T : le mur doit s'arrêter sur l'autre, pas le traverser " + JSON.stringify(tw));
  ok(t0.cells === 3, `jonction en T : 3 pièces attendues, ${t0.cells}`);
  await dragWall(300, 180, 300, 230);      // dragging the T's branch
  const t1 = await plan();
  const tw1 = t1.walls.find((w: VerdictSonde) => w.id === "w2");
  ok(t1.cells === 3, `jonction en T après glissement : 3 pièces attendues, ${t1.cells}`);
  ok(tw1 && Math.abs(tw1.a[0] - 210) < 1 && Math.abs(tw1.b[0] - 420) < 1,
    "jonction en T après glissement : la branche doit rester accrochée " + JSON.stringify(tw1));
});

// =============================================================================
//  3. meuble_trop_grand_ne_saute_pas
// =============================================================================
// clampCenterToInset pushed the 4 corners inward over 4 iterations: when the object is bigger
// than the cell, the opposing pushes DIVERGE. A sofa (220 cm) dropped in a 170 cm hallway
// followed the mouse for the whole gesture then jumped 372 cm, outside the dwelling, where it
// was no longer grabbable nor recoverable by "Fit". Twin symptom: a bed too big for its bedroom
// became completely immobile, every drag getting reset to the origin.
await test("meuble_trop_grand_ne_saute_pas", async () => {
  // 170 cm hallway on the left, 220 cm sofa inside it
  await seedModel([{ id: "w1", a: [170, 0], b: [170, 360], t: 12 }],
                  [{ id: "p1", type: "sofa3", name: "Canapé", x: 105, y: 12, w: 220, h: 95, rot: 0 }]);
  await wallsMode(false);
  await evaluate(`__plan.clearToast(); true`);
  const posOf = () => J(`(function(){var p=__plan.pieceById("p1");
    return {cx:Math.round(p.x+p.w/2), cy:Math.round(p.y+p.h/2)};})()`);
  for (const cible of [{ x: 85, y: 180 }, { x: 150, y: 300 }, { x: 30, y: 60 }]) {
    const p0 = await posOf();
    const from = await aptPoint(p0.cx, p0.cy), to = await aptPoint(cible.x, cible.y);
    await press(from); await moveTo(to, 8, from);
    const pendant = await posOf();
    await release(to);
    const apres = await posOf();
    const saut = Math.round(Math.hypot(apres.cx - pendant.cx, apres.cy - pendant.cy));
    ok(saut <= 6, `lâché sur (${cible.x},${cible.y}) : saut de ${saut} cm au relâchement `
      + `(sous la souris ${JSON.stringify(pendant)}, après ${JSON.stringify(apres)})`);
  }
  const fin = await J(`(function(){var p=__plan.pieceById("p1");
    return {hit:__plan.pieceHit("p1"), cell:(__plan.cellAt(p.x+p.w/2,p.y+p.h/2)||{}).name||null,
            toast:__plan.toastText};})()`);
  ok(fin.hit.rendered && fin.hit.hit, "le meuble doit rester attrapable à la souris : " + JSON.stringify(fin.hit));
  ok(fin.cell !== null, "le meuble doit rester dans une pièce, pas « Hors pièce »");
  ok(/sticks out/.test(String(fin.toast || "")), "le débordement doit être DIT à l'écran, toast = " + JSON.stringify(fin.toast));

  // --- the bed too big for the bedroom stays MOVABLE ---
  await seedModel([{ id: "w1", a: [180, 0], b: [180, 360], t: 12 },
                   { id: "w2", a: [0, 200], b: [180, 200], t: 12 }],
                  [{ id: "p2", type: "bed", name: "Lit", x: 10, y: 10, w: 160, h: 210, rot: 0 }]);
  await wallsMode(false);
  const b0 = await J(`(function(){var p=__plan.pieceById("p2"); return {x:p.x,y:p.y};})()`);
  const c0 = await J(`(function(){var p=__plan.pieceById("p2"); return {cx:p.x+p.w/2, cy:p.y+p.h/2};})()`);
  await drag(await aptPoint(c0.cx, c0.cy), await aptPoint(c0.cx + 30, c0.cy + 20), 8);
  const b1 = await J(`(function(){var p=__plan.pieceById("p2"); return {x:p.x,y:p.y};})()`);
  ok(b1.x !== b0.x || b1.y !== b0.y,
    `un meuble trop grand pour sa pièce doit quand même se déplacer (${JSON.stringify(b0)} -> ${JSON.stringify(b1)})`);
});

// =============================================================================
//  4. pas_de_mur_en_double
// =============================================================================
// Tracing the same partition twice created a second wall EXACTLY overlapping the first, hence
// invisible: "Delete wall" removed one, the partition stayed painted, the cell count became
// wrong, and the user concluded the button was broken.
await test("pas_de_mur_en_double", async () => {
  await seedModel([]);
  await wallsMode(true);
  const a = await aptPoint(210, 20), b = await aptPoint(210, 340);
  for (let k = 0; k < 2; k++) { ok(await armDraw(), "l'outil de tracé ne s'arme pas"); await drag(a, b, 14); }
  const P = await plan();
  ok(P.walls.length === 1, `deux traits au même endroit = un seul mur, obtenu ${P.walls.length}`);
  ok((await evaluate(`String(__plan.dupWalls())`)) === "0", "aucun mur superposé ne doit subsister");
  ok(/already there/.test(String(await evaluate(`String(__plan.toastText)`))), "le refus doit être DIT à l'écran");
  // and deletion does make the partition disappear, in a single click
  await click(await aptPoint(210, 120));
  const del = await centerOf("#rcDel");
  if (ok(del, "bouton « Supprimer le mur » absent")) {
    await click(del); await pause(120);
    const Q = await plan();
    ok(Q.walls.length === 0 && Q.cells === 1, `un seul clic doit refusionner (${JSON.stringify(Q.walls)}, ${Q.cells} cellule(s))`);
  }
  // a plan that ARRIVES with a duplicate (import, old plan, badly-woken peer) gets cleaned up
  await seedModel([{ id: "w1", a: [210, 0], b: [210, 360], t: 12 },
                   { id: "w2", a: [210, 0], b: [210, 360], t: 12 }]);
  const R = await plan();
  ok(R.walls.length === 1, "un doublon reçu doit être purgé à l'assainissement, murs = " + R.walls.length);
});

// =============================================================================
//  5. echap_annule_le_geste
// =============================================================================
// Escape in the middle of a drag did NOTHING to the gesture (the furniture kept following the
// mouse and the move got recorded on release) and cleared the selection under the finger.
await test("echap_annule_le_geste", async () => {
  await seedModel([{ id: "w1", a: [210, 0], b: [210, 360], t: 12 }],
                  [{ id: "p1", type: "coffee", name: "Table basse", x: 40, y: 40, w: 110, h: 60, rot: 0 }]);
  await wallsMode(false);
  const posOf = () => J(`(function(){var p=__plan.pieceById("p1"); return {x:p.x,y:p.y};})()`);
  const p0 = await posOf();
  const c0 = await J(`(function(){var p=__plan.pieceById("p1"); return {cx:p.x+p.w/2, cy:p.y+p.h/2};})()`);
  const from = await aptPoint(c0.cx, c0.cy);
  await press(from);
  await moveTo({ x: from.x + 70, y: from.y + 40 }, 6, from);
  const bouge = await posOf();
  ok(bouge.x !== p0.x || bouge.y !== p0.y, "le meuble doit bien suivre la souris avant Échap");
  await key("Escape", "Escape", 27);
  const apresEsc = await posOf();
  const g = await J(`{active:__plan.gestureActive, armed:__plan.gestureArmed, sel:__plan.selCount}`);
  ok(apresEsc.x === p0.x && apresEsc.y === p0.y,
    `Échap doit remettre le meuble où il était (${JSON.stringify(p0)} -> ${JSON.stringify(apresEsc)})`);
  ok(!g.armed && !g.active, "Échap doit terminer le geste " + JSON.stringify(g));
  ok(g.sel >= 1, "Échap ne doit pas désélectionner sous le doigt (sélection = " + g.sel + ")");
  // the furniture no longer follows the mouse, and the release doesn't record the move
  await moveTo({ x: from.x + 150, y: from.y + 90 }, 6, { x: from.x + 70, y: from.y + 40 });
  await release({ x: from.x + 150, y: from.y + 90 });
  const fin = await posOf();
  ok(fin.x === p0.x && fin.y === p0.y, "après Échap, plus rien ne doit bouger " + JSON.stringify(fin));

  // --- Escape during a WALL DRAG ---
  await wallsMode(true);
  const w0 = await plan();
  const wf = await aptPoint(210, 200);
  await press(wf); await moveTo({ x: wf.x + 80, y: wf.y }, 6, wf);
  await key("Escape", "Escape", 27);
  const w1 = await plan();
  ok(JSON.stringify(w1.walls) === JSON.stringify(w0.walls),
    `Échap doit remettre le mur en place ${JSON.stringify(w0.walls)} -> ${JSON.stringify(w1.walls)}`);
  await release({ x: wf.x + 80, y: wf.y });

  // --- Escape during a TRACE: no partition created ---
  ok(await armDraw(), "l'outil de tracé ne s'arme pas");
  const da = await aptPoint(60, 40);
  await press(da); await moveTo(await aptPoint(60, 320), 6, da);
  await key("Escape", "Escape", 27);
  await release(await aptPoint(60, 320));
  const w2 = await plan();
  ok(w2.walls.length === w0.walls.length,
    `Échap pendant un tracé ne doit créer aucun mur (${w0.walls.length} -> ${w2.walls.length})`);
});

// =============================================================================
//  6. pose_ne_sempile_pas
// =============================================================================
// Ten clicks in 195 ms created ten pieces of furniture exactly overlapping: the screen showed
// one, the furniture list counted ten, the occupied area was lying. And a double-click placed
// two. PLACEMENT became a DRAG-AND-DROP (clicking a thumbnail ARMS it, the gesture on the plan
// places it): the question stays the same, do ten placements at the SAME point make ten visible
// objects?
await test("pose_ne_sempile_pas", async () => {
  await seedModel([]);
  await wallsMode(false);
  const pal = await J(`(function(){var el;var types=['sofa3','sofa2','arm','ottoman','dining','chair','coffee','side','biblio','shelf','bed','armoire','placard','desk','langer'];for(var i=0;i<types.length;i++){var e=document.querySelector('#palette .pitem[data-type="'+types[i]+'"]');if(e&&!e.classList.contains('phide')){el=e;break;}}if(!el)return null;el.scrollIntoView({block:'center'});var rect=el.getBoundingClientRect();if(!rect.width||!rect.height)return null;return{x:rect.left+rect.width/2,y:rect.top+rect.height/2,w:rect.width,h:rect.height};})()`);

  if (!ok(pal, "meuble ordinaire non trouvé")) return;
  const centre = await aptPoint(210, 180);
  const n0 = await evaluate(`__plan.plan.pieces.length`);
  // ten DRAG-AND-DROPS from the palette, all released on the SAME pixel
  for (let i = 0; i < 10; i++) await drag(pal, centre, 6);
  await pause(400);
  const st = await J(`(function(){var L=__plan.plan.pieces.slice(-10), pts={};
    L.forEach(function(p){ pts[p.x+"/"+p.y]=1; });
    return {added:L.length, distinct:Object.keys(pts).length};})()`);
  const n1 = await evaluate(`__plan.plan.pieces.length`);
  ok(n1 === n0 + 10, `dix glissers-déposers doivent poser dix objets (${n0} -> ${n1})`);
  ok(st.distinct === 10, "dix objets posés d'affilée ne doivent pas s'empiler : " + JSON.stringify(st));

  // a DOUBLE-click on a thumbnail is ONE gesture: it ARMS once, it places nothing by itself
  const n2 = await evaluate(`__plan.plan.pieces.length`);
  await click(pal, 1); await click(pal, 2);
  await pause(200);
  const arme = await J(`({t:__plan.poseArme, vignettes:__plan.paletteArmed(), posing:__plan.posing})`);
  const n3 = await evaluate(`__plan.plan.pieces.length`);
  ok(n3 === n2, `un double-clic sur la palette ne pose RIEN par lui-même (${n2} -> ${n3})`);
  ok(!!arme.t && arme.vignettes.length === 1 && arme.posing,
    "un double-clic doit laisser la pose ARMÉE une seule fois : " + JSON.stringify(arme));

  // ...and the next click on the plan places ONE object, exactly under the pointer
  await click(centre);
  await pause(250);
  const n4 = await evaluate(`__plan.plan.pieces.length`);
  const apres = await J(`({arme:__plan.poseArme, posing:__plan.posing})`);
  ok(n4 === n3 + 1, `le clic sur le plan pose UN objet (${n3} -> ${n4})`);
  ok(!apres.arme && !apres.posing, "la pose armée se consomme : " + JSON.stringify(apres));
});

// =============================================================================
//  7. poignee_plus_ne_vole_pas
// =============================================================================
// The "+" used to sit at the exact center of every facade, ON TOP of the wall: a click meant to
// select the facade inserted a corner instead, and the global recalculation that followed
// rewrote the whole plan. It now lives 18 px OUTSIDE the outline. The contract, in three lines:
//   - the center of a facade belongs to the FACADE (the "+" is no longer there);
//   - a clean CLICK on the facade selects it and changes NOTHING;
//   - a DRAG moves the facade, and a click on the "+" inserts the corner.
await test("poignee_plus_ne_vole_pas", async () => {
  // 1) On the template's REAL plan (it has its derived facade walls): a clean CLICK at the
  //    center of a facade SELECTS it and changes strictly nothing.
  await wallsMode(true);
  const avant = await J(`(function(){var P=__plan.plan; return JSON.stringify({o:P.outline,
    w:P.walls.map(function(w){return [String(w.id),w.a,w.b];}), c:P.cells.length,
    p:P.pieces.map(function(p){return [String(p.id),p.x,p.y];})});})()`);
  const eb = await centerOf(".v5layer .edge");
  if (ok(eb, "bande de façade absente")) {
    await click({ x: eb.x, y: eb.y });
    await pause(200);
    const apres = await J(`(function(){var P=__plan.plan; return JSON.stringify({o:P.outline,
      w:P.walls.map(function(w){return [String(w.id),w.a,w.b];}), c:P.cells.length,
      p:P.pieces.map(function(p){return [String(p.id),p.x,p.y];})});})()`);
    ok(apres === avant, "un clic sur une façade ne doit RIEN changer au plan");
    ok(await evaluate(`String(!!__plan.v5ui.selWall)`) === "true",
      "un clic sur une façade doit la SÉLECTIONNER");
    ok(await evaluate(`String(__plan.v5WallById(__plan.v5ui.selWall).isOutline)`) === "true",
      "le mur sélectionné doit être la FAÇADE cliquée");
  }
  // 2) The "+" no longer covers the center of the facades.
  await seedModel([]);
  await wallsMode(true);
  const promesses = await J(`__plan.midHandlePoints()`);
  ok(promesses.length === 4, "quatre façades attendues, " + promesses.length);
  ok(promesses.every((p: VerdictSonde) => !/(^|\s)mid(\s|$)/.test(p.at || "")),
    "le centre d'une façade ne doit plus être recouvert par le « + » : " + JSON.stringify(promesses.map((p: VerdictSonde) => p.at)));
  // DRAGGING from the center of the facade = moving the facade (what the tooltip says).
  await seedModel([]);
  await wallsMode(true);
  const b1 = (await plan()).outline;
  const eb2 = await centerOf(".v5layer .edge");
  if (ok(eb2, "bande de façade absente (2)")) {
    await drag({ x: eb2.x, y: eb2.y }, { x: eb2.x, y: eb2.y + 70 }, 12);
    const a1 = (await plan()).outline;
    ok(a1.length === b1.length,
      `un glisser de façade ne doit PAS insérer d'angle (${b1.length} -> ${a1.length} sommets)`);
    ok(JSON.stringify(a1) !== JSON.stringify(b1),
      "un glisser de façade doit la déplacer : " + JSON.stringify(a1));
  }
  // A clean CLICK on the "+" = inserting a corner (the handle stays reachable, moved outside).
  await seedModel([]);
  await wallsMode(true);
  const b2 = (await plan()).outline;
  const mid2 = await centerOf(".v5layer .mid");
  if (ok(mid2, "poignée « + » absente (2)")) {
    await click({ x: mid2.x, y: mid2.y });
    await pause(120);
    const a2 = (await plan()).outline;
    ok(a2.length === b2.length + 1,
      `un clic net sur le « + » doit insérer un angle (${b2.length} -> ${a2.length} sommets)`);
  }
});

// ---- verdict -----------------------------------------------------------------------------------
const bad = results.filter(r => r.fails.length);
console.log("");
if (bad.length) {
  console.log(`FAILURES ${bad.length}/${results.length}:`);
  bad.forEach(r => r.fails.forEach((f: VerdictSonde) => console.log(`  - ${r.name}: ${f}`)));
} else {
  console.log(`OK ${results.length}/${results.length}`);
}
ws.close(); chrome.kill();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
process.exit(bad.length ? 1 : 0);
