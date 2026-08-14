#!/usr/bin/env node
// =============================================================================
//  INTERACTION SUITE — REAL MOUSE (CDP), REAL HIT-TESTING
// =============================================================================
// The other two suites dispatch synthetic PointerEvents: they BYPASS hit-testing, so they prove
// nothing about a real gesture. Here Chrome is driven by CDP (Input.dispatchMouseEvent /
// Input.dispatchKeyEvent): the browser picks its own target, sets up pointer capture, and
// gestures end (or don't) the way they would for a user.
//
//   node tests/interactions.ts [path/to/app.html]
//
// Six cases, all born from a PROVEN bug:
//   gesture_always_ends         a gesture that never ends kills session recording
//   view_gestures_never_persist a pan wrote the whole plan on every frame
//   remote_replace_during_drag  a remote replacement wiped out the local gesture
//   rail_chips_follow_cells     the rail announced 10 rooms when the plan had 11
//   opening_fields_round_trip   renaming a window emitted NO op at all
//   wheel_scrolls_panel_under_pointer_not_the_plan  the wheel over the open chat zoomed the plan
import type { VerdictSonde } from "./_types.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sanitizeState, applyOp } from "../live-worker/ops.ts";

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

// ---- test page: the seed clears localStorage then plants the plan there, on EVERY load ---------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-inter-"));
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
  await new Promise(r => setTimeout(r, 350));
  // shared probe: "is work still being saved?"
  await evaluate(`window.__saveWorks=function(tag){
    var before=localStorage.getItem("room-planner-v4")||"";
    var p=__plan.state.plan.pieces[0]; p.name="T-"+tag; __plan.save();
    var after=localStorage.getItem("room-planner-v4")||"";
    return after!==before && after.indexOf("T-"+tag)>=0;
  }; true`);
}

// ---- REAL mouse / REAL keyboard ---------------------------------------------------------------
const M = (type: string, x: VerdictSonde, y: VerdictSonde, extra?: Record<string, unknown>) => send("Input.dispatchMouseEvent", Object.assign({
  type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1,
  clickCount: 1, pointerType: "mouse",
}, extra || {}));
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function press(p: VerdictSonde) { await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 }); await M("mousePressed", p.x, p.y); await pause(20); }
async function moveTo(p: VerdictSonde, steps = 6, from: VerdictSonde) {
  const a = from || p;
  for (let i = 1; i <= steps; i++) {
    await M("mouseMoved", a.x + (p.x - a.x) * i / steps, a.y + (p.y - a.y) * i / steps);
    await pause(10);
  }
}
async function release(p: VerdictSonde) { await M("mouseReleased", p.x, p.y); await pause(80); }
async function click(p: VerdictSonde) { await press(p); await release(p); await pause(60); }
async function drag(from: VerdictSonde, to: VerdictSonde, steps = 10) { await press(from); await moveTo(to, steps, from); await release(to); }
async function key(k: string, code: string, text?: string, mods?: number) {
  await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: k, code, text, modifiers: mods || 0, windowsVirtualKeyCode: text ? text.charCodeAt(0) : 0 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, modifiers: mods || 0 });
  await pause(15);
}
async function typeText(s: VerdictSonde) { for (const ch of s) await send("Input.insertText", { text: ch }), await pause(8); }

// ---- micro-harness -----------------------------------------------------------------------------
const results: VerdictSonde[] = [];
let cur: VerdictSonde = null;
function ok(cond: unknown, msg?: string) { if (!cond) cur.fails.push(msg); return !!cond; }
async function test(name: string, fn: (...args: VerdictSonde[]) => VerdictSonde | Promise<VerdictSonde>) {
  cur = { name, fails: [] };
  await reload();
  try { await fn(); } catch (e) { cur.fails.push("EXCEPTION: " + (e && e.message || e)); }
  const jsErr = await evaluate(`JSON.stringify((JSON.parse(localStorage.getItem("plan-errors")||"[]")||[]).map(function(e){return e&&e.msg}))`);
  if (jsErr && jsErr !== "[]") cur.fails.push("erreurs JS: " + jsErr);
  results.push(cur);
  console.log(`  ${cur.fails.length ? "FAIL " : "ok   "} ${name}`);
  cur.fails.forEach((f: VerdictSonde) => console.log("        - " + f));
}

// CLIENT coordinates of an element's center (hit-testing stays with the browser).
const centerOf = (sel: VerdictSonde) => J(`(function(){var e=document.querySelector(${JSON.stringify(sel)});
  if(!e) return null; var r=e.getBoundingClientRect();
  return {x:r.left+r.width/2, y:r.top+r.height/2, w:r.width, h:r.height};})()`);
// CLIENT point of an APARTMENT point.
const aptPoint = (x: VerdictSonde, y: VerdictSonde) => J(`(function(){var s=__plan.aptToScreen(${x},${y});
  var r=document.getElementById("viewport").getBoundingClientRect();
  return {x:r.left+s.x, y:r.top+s.y};})()`);
const gestureState = () => J(`{active:__plan.gestureActive, armed:__plan.gestureArmed}`);

// =============================================================================
//  1. gesture_always_ends
// =============================================================================
// A gesture that never ends leaves `gestureActive` true FOREVER: save() bails out at the top on
// every call, nothing gets written or sent anymore, and the whole session's work vanishes on
// reload without a single message. We exercise the SEVEN entry points with a real mouse, then
// the three ways to end other than releasing (pointercancel, focus loss, watchdog), plus
// abandoning a dimension entry at the keyboard.
await test("gesture_always_ends", async () => {
  // --- the entry points, ended normally (release) ---
  const pid = await evaluate(`(function(){
    var p=__plan.state.plan.pieces.find(function(x){return x.w>=80&&x.h>=60&&!x.locked;})||__plan.state.plan.pieces[0];
    window.__pid=String(p.id); __plan.selReplace(String(p.id)); __plan.render(); __plan.openInspector();
    return String(p.id);})()`);

  const entries = [];
  entries.push(["glisser un meuble", await centerOf(`.piece[data-id="${pid}"]`), { dx: 40, dy: 30 }]);
  entries.push(["poignée de rotation", await centerOf(`.piece[data-id="${pid}"] .rot-handle`), { dx: 30, dy: 0 }]);
  entries.push(["poignée de redimension", await centerOf(`.piece[data-id="${pid}"] .rsz-handle[data-rsz="e"]`), { dx: 35, dy: 0 }]);
  entries.push(["glisser une ouverture", await centerOf(`.piece[data-op="1"]`), { dx: 25, dy: 25 }]);

  for (const [label, pt, d] of entries) {
    if (!ok(pt, `${label} : cible introuvable`)) continue;
    await drag(pt, { x: pt.x + d.dx, y: pt.y + d.dy });
    const g = await gestureState();
    ok(!g.active && !g.armed, `${label} : geste encore ouvert après relâchement ${JSON.stringify(g)}`);
    ok(await evaluate(`window.__saveWorks("${label.replace(/\W+/g, "")}")`), `${label} : l'enregistrement est mort après le geste`);
  }

  // --- multi-selection: GROUP drag ---
  await evaluate(`(function(){var L=__plan.state.plan.pieces.filter(function(p){return !p.locked && !__plan.TYPEMAP[p.type].wallMount && !__plan.TYPEMAP[p.type].opening;});
    __plan.selReplace(String(L[0].id)); __plan.selAdd(String(L[1].id)); window.__pid=String(L[0].id); __plan.render(); return __plan.selCount;})()`);
  {
    const pt = await centerOf(`.piece[data-id="${await evaluate("window.__pid")}"]`);
    await drag(pt, { x: pt.x + 30, y: pt.y + 20 });
    const g = await gestureState();
    ok(!g.active && !g.armed, "glisser de groupe : geste encore ouvert " + JSON.stringify(g));
    ok(await evaluate(`window.__saveWorks("groupe")`), "glisser de groupe : enregistrement mort");
  }

  // --- Walls mode: wall, outline vertex and outline edge (real click on the segmented control) ---
  await click(await centerOf("#btnModeWalls"));
  const wallPt = await centerOf(".v5hit-wall");
  if (ok(wallPt, "glisser un mur : aucune forme de touche de mur")) {
    await drag(wallPt, { x: wallPt.x + 20, y: wallPt.y + 20 });
    const g = await gestureState();
    ok(!g.active && !g.armed, "glisser un mur : geste encore ouvert " + JSON.stringify(g));
    ok(await evaluate(`window.__saveWorks("mur")`), "glisser un mur : enregistrement mort");
  }
  const vtxPt = await centerOf(".vtx");
  if (ok(vtxPt, "sommet du contour : poignée absente")) {
    await drag(vtxPt, { x: vtxPt.x + 15, y: vtxPt.y + 15 });
    const g = await gestureState();
    ok(!g.active && !g.armed, "sommet du contour : geste encore ouvert " + JSON.stringify(g));
    ok(await evaluate(`window.__saveWorks("sommet")`), "sommet du contour : enregistrement mort");
  }
  const edgePt = await centerOf(".edge");
  if (ok(edgePt, "arête du contour : poignée absente")) {
    await drag(edgePt, { x: edgePt.x + 12, y: edgePt.y + 12 });
    const g = await gestureState();
    ok(!g.active && !g.armed, "arête du contour : geste encore ouvert " + JSON.stringify(g));
    ok(await evaluate(`window.__saveWorks("arete")`), "arête du contour : enregistrement mort");
  }
  // trace a wall (the tool arms via a real click on the toolbar button)
  await click(await centerOf("#btnDrawWall"));
  {
    const coord = await J(`(function(){var c=__plan.state.plan.cells[0];
      var xs=c.poly.map(function(p){return p[0];}), ys=c.poly.map(function(p){return p[1];});
      return [Math.round((Math.min.apply(null,xs)+Math.max.apply(null,xs))/2), Math.round(Math.min.apply(null,ys)+30)];})()`);
    const a = await aptPoint(coord[0], coord[1]);
    await drag(a, { x: a.x + 60, y: a.y });
    const g = await gestureState();
    ok(!g.active && !g.armed, "tracer un mur : geste encore ouvert " + JSON.stringify(g));
  }
  await click(await centerOf("#btnModeFurn"));

  // --- pointercancel (a 2nd finger, a stylus lifting off, the compositor taking over) ---
  {
    const pt = await centerOf(`.piece[data-id="${pid}"]`);
    await press(pt); await moveTo({ x: pt.x + 40, y: pt.y + 10 }, 4, pt);
    ok((await gestureState()).active, "pointercancel : le geste devrait être ouvert avant l'annulation");
    await evaluate(`window.dispatchEvent(new PointerEvent("pointercancel",{bubbles:true})); true`);
    await pause(60);
    const g = await gestureState();
    ok(!g.active && !g.armed, "pointercancel : geste encore ouvert " + JSON.stringify(g));
    ok(await evaluate(`window.__saveWorks("cancel")`), "pointercancel : enregistrement mort");
    await M("mouseReleased", pt.x + 40, pt.y + 10);
  }

  // --- window losing focus (Alt+Tab mid-drag) ---
  {
    const pt = await centerOf(`.piece[data-id="${pid}"]`);
    await press(pt); await moveTo({ x: pt.x + 30, y: pt.y + 30 }, 4, pt);
    await evaluate(`window.dispatchEvent(new Event("blur")); true`);
    await pause(60);
    const g = await gestureState();
    ok(!g.active && !g.armed, "blur : geste encore ouvert " + JSON.stringify(g));
    ok(await evaluate(`window.__saveWorks("blur")`), "blur : enregistrement mort");
    await M("mouseReleased", pt.x + 30, pt.y + 30);
  }

  // --- watchdog: a gesture with zero sign of life is no longer a gesture ---
  {
    const pt = await centerOf(`.piece[data-id="${pid}"]`);
    await press(pt); await moveTo({ x: pt.x + 20, y: pt.y + 20 }, 3, pt);
    await evaluate(`__plan.ageGesture(); true`);              // ages the gesture by 8 s
    const saved = await evaluate(`window.__saveWorks("watchdog")`);
    ok(saved, "chien de garde : save() doit forcer la sortie d'un geste rassis, pas se taire");
    const g = await gestureState();
    ok(!g.active && !g.armed, "chien de garde : geste encore ouvert " + JSON.stringify(g));
    await M("mouseReleased", pt.x + 20, pt.y + 20);
  }

  // --- ABANDONING A DIMENSION ENTRY (the case that was killing the session) ---
  // Handle grabbed, a digit typed, mouse released WITHOUT Enter: the gesture must no longer
  // block anything, and the keyboard must no longer swallow digits typed elsewhere.
  {
    await evaluate(`__plan.selReplace(window.__pid); __plan.render(); __plan.openInspector(); true`);
    const h = await centerOf(`.piece[data-id="${await evaluate("window.__pid")}"] .rsz-handle[data-rsz="e"]`);
    if (ok(h, "saisie de cote : poignée est introuvable")) {
      await press(h); await moveTo({ x: h.x + 40, y: h.y }, 3, h);
      await key("1", "Digit1", "1");
      await M("mouseReleased", h.x + 40, h.y); await pause(80);
      ok(!(await gestureState()).active, "saisie de cote : le geste bloque encore l'enregistrement après le relâchement");
      ok(await evaluate(`window.__saveWorks("saisie")`), "saisie de cote abandonnée : enregistrement mort");
      // typing a name containing a digit in the inspector: the 2 must NOT be swallowed
      const nameBox = await centerOf("#iName");
      await click(nameBox);
      await evaluate(`document.getElementById("iName").value=""; true`);
      await typeText("Chambre 2");
      const v = await evaluate(`document.getElementById("iName").value`);
      ok(v === "Chambre 2", `le champ nom doit recevoir « Chambre 2 », il a reçu « ${v} »`);
      const g = await gestureState();
      ok(!g.active && !g.armed, "saisie de cote : le geste doit être refermé une fois le focus dans un champ " + JSON.stringify(g));
    }
  }
});

// =============================================================================
//  2. view_gestures_never_persist
// =============================================================================
// The view transform is NOT a change to the plan. Measured before the fix: a 40-movement pan =
// 40 serializations and 854,520 bytes written; 10 wheel notches = 10 writes. Each one rearmed
// the send and blocked remote adoption for 2.5 s.
await test("view_gestures_never_persist", async () => {
  await evaluate(`window.__w={n:0,bytes:0};
    (function(){var set=Storage.prototype.setItem;
      Storage.prototype.setItem=function(k,v){ if(String(k).indexOf("room-planner")===0){ window.__w.n++; window.__w.bytes+=String(v).length; } return set.apply(this,arguments); };})();
    true`);
  const before = await J(`{s:__plan.vScale, ox:document.querySelector(".v5layer").style.left}`);
  // pan with the right button, 40 movements
  await M("mouseMoved", 800, 500, { button: "none", buttons: 0 });
  await M("mousePressed", 800, 500, { button: "right", buttons: 2 });
  for (let i = 1; i <= 40; i++) { await M("mouseMoved", 800 + i * 4, 500 + i * 2, { button: "right", buttons: 2 }); await pause(6); }
  await M("mouseReleased", 960, 580, { button: "right", buttons: 0 });
  await pause(80);
  const pan = await J("window.__w");
  const moved = await J(`{ox:document.querySelector(".v5layer").style.left}`);
  ok(pan.n === 0, `panoramique : ${pan.n} écritures (${pan.bytes} octets) au lieu de 0`);
  ok(moved.ox !== before.ox, "panoramique : la vue n'a pas bougé, le test ne prouve rien");

  await evaluate(`window.__w.n=0; window.__w.bytes=0; true`);
  for (let i = 0; i < 10; i++) { await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 800, y: 500, deltaX: 0, deltaY: -120 }); await pause(20); }
  const zoom = await J("window.__w");
  const after = await J("{s:__plan.vScale}");
  ok(zoom.n === 0, `zoom : ${zoom.n} écritures (${zoom.bytes} octets) au lieu de 0`);
  ok(after.s > before.s, "zoom : l'échelle n'a pas changé, le test ne prouve rien");

  // "Fit" is also a VIEW command
  await evaluate(`window.__w.n=0; true`);
  await click(await centerOf("#btnFit"));
  ok((await J("window.__w")).n === 0, "Ajuster : la vue ne doit rien enregistrer");

  // ...and the counter itself does know how to count: a real furniture move does write.
  await evaluate(`window.__w.n=0; true`);
  const pt = await centerOf(".piece:not([data-op])");
  await drag(pt, { x: pt.x + 40, y: pt.y + 30 });
  ok((await J("window.__w")).n > 0, "un déplacement de meuble DOIT encore écrire (sinon le compteur ment)");
});

// =============================================================================
//  3. remote_replace_during_drag
// =============================================================================
// One household member drags the sofa, the other one does Ctrl+Z: before, the remote replacement
// used to apply mid-gesture, the dragged object became orphaned (the drag's closure held the old
// object) and the view would recrop.
await test("remote_replace_during_drag", async () => {
  const pid = await evaluate(`(function(){var p=__plan.state.plan.pieces.find(function(x){return !x.locked && !__plan.TYPEMAP[x.type].wallMount && !__plan.TYPEMAP[x.type].opening;});
    window.__pid=String(p.id); __plan.selReplace(window.__pid); __plan.render(); return window.__pid;})()`);
  const pt = await centerOf(`.piece[data-id="${pid}"]`);
  await press(pt);
  await moveTo({ x: pt.x + 50, y: pt.y + 20 }, 5, pt);
  await evaluate(`window.__held=__plan.pieceById(window.__pid); true`);
  const view0 = await J("{s:__plan.vScale, l:document.querySelector('.v5layer').style.left}");
  const pos0 = await J(`(function(){var p=__plan.pieceById(window.__pid); return {x:p.x,y:p.y};})()`);

  // remote op: COMPLETE replacement of the plan, mid-gesture
  await evaluate(`__plan.applyRemote({kind:"plan5.replace", plan:__plan.wire()}); true`);
  const q = await J("__plan.gestureQueued");
  ok(q.op === "plan5.replace", "le remplacement distant doit être MIS EN FILE pendant le geste, pas appliqué ni jeté (" + JSON.stringify(q) + ")");
  ok(await evaluate(`__plan.pieceById(window.__pid)===window.__held`), "l'objet traîné est devenu orphelin : la closure du glisser tient un objet hors du plan");
  const view1 = await J("{s:__plan.vScale, l:document.querySelector('.v5layer').style.left}");
  ok(view1.s === view0.s && view1.l === view0.l, "la vue a sauté pendant le geste " + JSON.stringify([view0, view1]));

  // the gesture keeps following the mouse
  await moveTo({ x: pt.x + 110, y: pt.y + 20 }, 5, { x: pt.x + 50, y: pt.y + 20 });
  const pos1 = await J(`(function(){var p=__plan.pieceById(window.__pid); return {x:p.x,y:p.y};})()`);
  ok(pos1.x !== pos0.x, "le meuble ne suit plus la souris après l'op distante");

  await release({ x: pt.x + 110, y: pt.y + 20 });
  await pause(120);
  const after = await J(`{queued:__plan.gestureQueued, g:__plan.gestureActive, cells:__plan.state.plan.cells.length, pieces:__plan.state.plan.pieces.length}`);
  ok(!after.queued.op && !after.queued.state, "la file doit être vidée à la fin du geste " + JSON.stringify(after.queued));
  ok(!after.g, "le geste doit être terminé");
  ok(after.cells > 0 && after.pieces > 0, "le plan doit avoir survécu au remplacement différé");

  // outside a gesture, a remote replacement does NOT recrop the view (keepView)
  await evaluate(`__plan.zoomAt ? 0 : 0; true`);
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 800, y: 500, deltaX: 0, deltaY: -240 });
  await pause(60);
  const v0 = await J("{s:__plan.vScale}");
  await evaluate(`__plan.applyRemote({kind:"plan5.replace", plan:__plan.wire()}); true`);
  await pause(60);
  const v1 = await J("{s:__plan.vScale}");
  ok(Math.abs(v1.s - v0.s) < 1e-9, `une op distante ne doit jamais recadrer la vue du destinataire (${v0.s} -> ${v1.s})`);
});

// =============================================================================
//  4. rail_chips_follow_cells
// =============================================================================
// The rail refreshed on NO wall edit whatsoever: 10 chips for 11 cells, stale areas, and a
// clickable ghost chip that framed a cell that no longer existed.
await test("rail_chips_follow_cells", async () => {
  const railMatchesModel = async (where: VerdictSonde) => {
    const v = await J(`(function(){
      var cells=__plan.state.plan.cells||[];
      return {chips:__plan.chipCount(), cells:cells.length,
              chipNames:__plan.chipNames(), cellNames:cells.map(function(c){return c.name;}),
              chipAreas:__plan.chipAreas(),
              cellAreas:cells.map(function(c){return __plan.fmtM2(__plan.v5SignedArea(c.poly));})};})()`);
    ok(v.chips === v.cells, `${where} : ${v.chips} puces pour ${v.cells} cellules`);
    ok(JSON.stringify(v.chipNames) === JSON.stringify(v.cellNames), `${where} : noms du rail périmés ${JSON.stringify(v.chipNames)}`);
    ok(JSON.stringify(v.chipAreas) === JSON.stringify(v.cellAreas), `${where} : surfaces du rail périmées ${JSON.stringify(v.chipAreas)}`);
    return v;
  };
  const start = await railMatchesModel("au chargement");

  // trace a partition with the mouse, across a cell
  await click(await centerOf("#btnModeWalls"));
  await click(await centerOf("#btnDrawWall"));
  const seg = await J(`(function(){var c=__plan.state.plan.cells.slice().sort(function(a,b){
      return Math.abs(__plan.v5SignedArea(b.poly))-Math.abs(__plan.v5SignedArea(a.poly));})[0];
    var xs=c.poly.map(function(p){return p[0];}), ys=c.poly.map(function(p){return p[1];});
    var y=Math.round((Math.min.apply(null,ys)+Math.max.apply(null,ys))/2);
    return {x0:Math.round(Math.min.apply(null,xs)), x1:Math.round(Math.max.apply(null,xs)), y:y};})()`);
  const a = await aptPoint(seg.x0, seg.y), b = await aptPoint(seg.x1, seg.y);
  await drag(a, b, 12);
  const grown = await railMatchesModel("après avoir tracé une cloison");
  ok(grown.cells === start.cells + 1, `la cloison doit créer une cellule (${start.cells} -> ${grown.cells})`);

  // delete the wall via the card (the traced wall stays selected)
  await click(await centerOf("#rcDel"));
  await pause(80);
  const shrunk = await railMatchesModel("après suppression du mur");
  ok(shrunk.cells === start.cells, `la suppression doit refusionner (${grown.cells} -> ${shrunk.cells})`);

  // the ACTIVE chip follows a click on a room label on the plan
  await click(await centerOf("#btnModeFurn"));
  const label = await J(`(function(){var els=[].slice.call(document.querySelectorAll(".ov-name"));
    if(!els.length) return null; var e=els[els.length-1]; var r=e.getBoundingClientRect();
    return {x:r.left+r.width/2, y:r.top+r.height/2, name:e.textContent};})()`);
  if (ok(label, "aucune étiquette de pièce sur le plan")) {
    await click(label);
    await pause(80);
    const act = await evaluate("__plan.activeChipName()");
    ok(act === label.name, `la puce active doit suivre la pièce cliquée (« ${label.name} » attendu, « ${act} » obtenu)`);
  }
});

// =============================================================================
//  5. opening_fields_round_trip
// =============================================================================
// An opening's wire shape was {id,wallId,t0,w,type,hinge,swing}: `name` and `h` weren't in it,
// even though the inspector lets you edit them. Renaming a window emitted ZERO ops, and setDim()
// wrote NaNs (p.x+p.w/2 on an object with neither x nor y).
await test("opening_fields_round_trip", async () => {
  const oid = await evaluate(`(function(){
    var o=(__plan.state.plan.openings||[]).find(function(x){return x.type==="window";})||__plan.state.plan.openings[0];
    window.__oid=String(o.id); return String(o.id);})()`);
  const pt = await centerOf(`.piece[data-id="${oid}"]`);
  if (!ok(pt, "ouverture introuvable à l'écran")) return;
  await click(pt);                       // real click: selection + inspector
  ok(await evaluate(`String(__plan.selId)===window.__oid`), "le clic doit sélectionner l'ouverture");

  // --- renaming at the keyboard, in the real field ---
  await evaluate(`__plan.shadowSync(); __plan.opLog(true); true`);
  await click(await centerOf("#iName"));
  await evaluate(`(function(){var e=document.getElementById("iName"); e.value=""; e.dispatchEvent(new Event("input",{bubbles:true}));})(); true`);
  await typeText("Fenetre cuisine");
  await evaluate(`__plan.forceDiff(); true`);
  const ops = await J(`__plan.opLog(false)`);
  const setOp = ops.filter((o: VerdictSonde) => o.kind === "opening.set" && String(o.opening.id) === oid).pop();
  ok(!!setOp, `renommer une ouverture doit émettre une op (ops vues : ${JSON.stringify(ops.map((o: VerdictSonde) => o.kind))})`);
  ok(setOp && setOp.opening.name === "Fenetre cuisine", "l'op doit porter le nom : " + JSON.stringify(setOp && setOp.opening));

  // --- depth (iH): neither NaN nor invented x/y ---
  // Depth is the object's thickness WITHIN its wall: it is bounded by that wall (js/21), not just
  // by the server bound. This case used to type 40 on a 12 cm wall; the value is therefore now
  // REFUSED, and the expectation "h === 40" was describing the defect instead of preventing it.
  // We type a depth the wall actually carries, derived from it so the case stays true if the test
  // plan changes. The refusal beyond the wall has its own test (garde-fous, profondeur_bornee_par_le_mur).
  const murT = await evaluate(`(function(){var o=__plan.v5OpeningById(window.__oid);
    var w=__plan.v5WallById(o.wallId); return Math.round(w.t);})()`);
  const prof = Math.max(1, murT - 4);
  await evaluate(`__plan.shadowSync(); __plan.opLog(true); true`);
  await click(await centerOf("#iH"));
  await evaluate(`(function(){var e=document.getElementById("iH"); e.value=""; e.dispatchEvent(new Event("input",{bubbles:true}));})(); true`);
  await typeText(String(prof));
  // Dimension fields no longer apply on every keystroke: they wait for a short typing pause
  // (numField, js/00), so that typing "3000" doesn't commit 3, then 30, then 300 along the way.
  await pause(400);
  await evaluate(`__plan.forceDiff(); true`);
  const ops2 = await J(`__plan.opLog(false)`);
  const hOp = ops2.filter((o: VerdictSonde) => o.kind === "opening.set" && String(o.opening.id) === oid).pop();
  const raw = await J(`(function(){var o=__plan.v5OpeningById(window.__oid);
    return {h:o.h, x:o.x, y:o.y, name:o.name, nan:(o.x!==undefined&&!isFinite(o.x))||(o.y!==undefined&&!isFinite(o.y))};})()`);
  ok(!raw.nan, "setDim() écrit encore des NaN sur une ouverture : " + JSON.stringify(raw));
  ok(raw.h === prof, `la profondeur saisie doit être appliquée (mur de ${murT} cm), h=` + raw.h);
  ok(hOp && hOp.opening.h === prof, "la profondeur doit traverser le fil : " + JSON.stringify(hOp && hOp.opening));

  // --- the REAL server accepts the op, and keeps it ---
  const wire = await J(`__plan.wire()`);
  let clean, applied;
  try { clean = sanitizeState(wire); } catch (e) { ok(false, "le serveur refuse l'état : " + (e && e.reason || e)); }
  if (clean) {
    try { applied = applyOp(JSON.parse(JSON.stringify(clean)), hOp); }
    catch (e) { ok(false, "le serveur refuse l'op d'ouverture : " + (e && e.reason || e)); }
    const stored = applied && (applied.openings || []).find(o => String(o.id) === oid);
    ok(stored && stored.name === "Fenetre cuisine" && stored.h === prof,
      "le plan partagé doit conserver name/h : " + JSON.stringify(stored));
    ok(stored && (stored.side === 0 || stored.side === 1), "side doit être une clé dépliée côté serveur : " + JSON.stringify(stored));
  }

  // --- and the edit survives a complete plan replacement ---
  await evaluate(`__plan.applyRemote({kind:"plan5.replace", plan:__plan.wire()}); true`);
  const back = await J(`(function(){var o=__plan.v5OpeningById(window.__oid); return o?{name:o.name,h:o.h}:null;})()`);
  ok(back && back.name === "Fenetre cuisine" && back.h === prof,
    "l'édition doit survivre à un remplacement de plan : " + JSON.stringify(back));
});

// =============================================================================
//  6. wheel_scrolls_panel_under_pointer_not_the_plan
// =============================================================================
// The chat message list lives INSIDE `#viewport` (html/02-scene.html), so its wheel events reach
// the viewport's own wheel listener by ordinary bubbling. Measured live, two people testing
// multiplayer together: the wheel over the OPEN chat panel zoomed the plan underneath it instead
// of scrolling the messages — the viewport's handler called `preventDefault()` unconditionally, on
// every target inside it. We force the chat panel open (a real one needs a live socket, irrelevant
// to this defect) and stuff it with more messages than fit, so there is something to scroll.
await test("wheel_scrolls_panel_under_pointer_not_the_plan", async () => {
  await evaluate(`(function(){
    var list = document.getElementById("chatList");
    document.getElementById("chatPanel").hidden = false;
    for (var i = 0; i < 40; i++) {
      var d = document.createElement("div");
      d.className = "chat-msg"; d.style.height = "24px"; d.textContent = "msg " + i;
      list.appendChild(d);
    }
    list.scrollTop = 0;
  })(); true`);
  const chatCenter = await J(`(function(){
    var r = document.getElementById("chatList").getBoundingClientRect();
    return {x: r.left + r.width / 2, y: r.top + r.height / 2};})()`);
  const scrollAvant = await J(`document.getElementById("chatList").scrollTop`);
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: chatCenter.x, y: chatCenter.y, deltaX: 0, deltaY: 120 });
  await pause(60);
  const scrollApres = await J(`document.getElementById("chatList").scrollTop`);
  ok(scrollApres !== scrollAvant,
    `la molette au-dessus du chat doit faire défiler la liste des messages, scrollTop ${scrollAvant} -> ${scrollApres}`);

  // The zoom behaviour over the PLAN ITSELF must stay exactly as it was: this is a routing fix,
  // never a removal of the zoom.
  const vScaleAvant = await J(`__plan.vScale`);
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 800, y: 500, deltaX: 0, deltaY: -120 });
  await pause(60);
  const vScaleApres = await J(`__plan.vScale`);
  ok(vScaleApres > vScaleAvant,
    `la molette au-dessus du plan doit toujours zoomer, vScale ${vScaleAvant} -> ${vScaleApres}`);
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
