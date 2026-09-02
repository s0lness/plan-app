#!/usr/bin/env node
// =============================================================================
//  "A JUNCTION MUST HOLD WHEN A WALL IS MOVED" SUITE: REAL MOUSE (CDP), end to end
// =============================================================================
// Owner's exact case: draw wall segments separately, connect them end to end into two rooms
// (the segment tool stays armed across walls, snapping onto the previous wall's own endpoint),
// turn the tool off, then drag the shared wall. Before the two fixes in this batch:
//   1. the render cache never rebuilt the walls' clickable hit band when the draw tool was
//      turned off (`rendu/calque.ts`'s `sig` did not include `ctx.ihm.draw`): the drag never
//      even STARTED, because there was nothing to click on. `armed_desarme_par_bouton_...`
//      below asserts the walls actually MOVED, not just "nothing tore because nothing moved".
//   2. once the drag could start, a follower COLLINEAR with the dragged wall (exactly what two
//      strokes forming a straight run produce) fell off: the line-intersection formula that used
//      to compute its new position degenerates on parallel lines (see
//      `tests/jonction-glisser-mur.ts` for the pure repro of that one).
//
//   node tests/jonction-glisser-mur-geste.ts [path/to/app.html]
//
// Real mouse (`Input.dispatchMouseEvent`), never a synthetic PointerEvent: AGENTS.md, "A click
// lands on what is visible", a synthetic event bypasses hit-testing and the capture-phase wiring
// this fix lives in.
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

// A SEEDED plan (not a blank profile): a blank profile opens the "configure your apartment"
// wizard instead of the ordinary canvas, and this suite overrides the geometry anyway through
// `__plan.setModel(...)` once the app has booted (`dessinerTroisMurs`, below).
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "plan-rev177.json"), "utf8"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-jonction-"));
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

// ---- REAL mouse ---------------------------------------------------------------------------------
const M = (type: string, x: VerdictSonde, y: VerdictSonde, extra?: Record<string, unknown>) => send("Input.dispatchMouseEvent", Object.assign({
  type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1,
  clickCount: 1, pointerType: "mouse",
}, extra || {}));
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function press(p: VerdictSonde) { await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 }); await M("mousePressed", p.x, p.y); await pause(20); }
async function moveTo(p: VerdictSonde, steps = 10, from: VerdictSonde) {
  const a = from || p;
  for (let i = 1; i <= steps; i++) {
    await M("mouseMoved", a.x + (p.x - a.x) * i / steps, a.y + (p.y - a.y) * i / steps);
    await pause(8);
  }
}
async function release(p: VerdictSonde) { await M("mouseReleased", p.x, p.y); await pause(80); }
async function click(p: VerdictSonde) {
  await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 });
  await M("mousePressed", p.x, p.y);
  await M("mouseReleased", p.x, p.y, { buttons: 0 });
  await pause(80);
}
async function drag(from: VerdictSonde, to: VerdictSonde, steps = 14) { await press(from); await moveTo(to, steps, from); await release(to); }

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
  return {x:r.left+r.width/2, y:r.top+r.height/2};})()`);
const aptPoint = (x: VerdictSonde, y: VerdictSonde) => J(`(function(){var s=__plan.aptToScreen(${x},${y});
  var r=document.getElementById("viewport").getBoundingClientRect();
  return {x:r.left+s.x, y:r.top+s.y};})()`);
const armed = () => evaluate(`String(__plan.v5ui.draw)`);
const interiorWalls = () => J(`__plan.plan.walls.filter(function(w){return !w.isOutline;})
  .map(function(w){return {id:String(w.id), a:w.a, b:w.b};})`);
const cellCount = () => evaluate(`String(__plan.plan.cells.length)`);
const undoCount = () => evaluate(`String(__plan.histInfo().undo)`);

/**
 * Draws the owner's exact shape: three hand-drawn walls, corner to corner, carving the 420x360
 * default apartment into two rooms. Returns the three walls in drawing order.
 */
async function dessinerTroisMurs(): Promise<VerdictSonde[]> {
  await evaluate(`__plan.setModel({outline:[[0,0],[420,0],[420,360],[0,360]],
    walls:[], openings:[], pieces:[], cells:[]}); true`);
  await pause(150);
  if (await armed() !== "true") await click(await centerOf("#btnDrawWall"));
  // CLICK-CLICK, and the chain is what makes the three walls SHARE their endpoints exactly: each
  // click closes a segment and reopens the next one at that same point (decision 0010). The tool
  // is left armed with the chain open on purpose; the caller disarms it through the button, which
  // is the path bug #1 lived in.
  await click(await aptPoint(200, 0));     // wA starts
  await click(await aptPoint(200, 150));   // wA closes, wB starts here
  await click(await aptPoint(300, 150));   // wB closes, wC starts here
  await click(await aptPoint(300, 360));   // wC closes on the bottom facade (apartment is 420x360)
  return interiorWalls();
}
const near = (p: VerdictSonde, q: VerdictSonde) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1;
const murTouchant = (murs: VerdictSonde[], pt: VerdictSonde, exclu: VerdictSonde) =>
  murs.find((w: VerdictSonde) => w.id !== exclu && (near(w.a, pt) || near(w.b, pt)));

// =============================================================================
//  1. THE OWNER'S CASE: drag the shared wall, junctions hold, the room survives
// =============================================================================
await test("trois_murs_relies_bout_a_bout_le_glissement_garde_les_jonctions", async () => {
  const avant = await dessinerTroisMurs();
  ok(avant.length === 3, `précondition : trois murs tracés, vu ${avant.length}`);
  ok(await cellCount() === "2", `précondition : deux pièces avant tout glissement, vu ${await cellCount()}`);
  const wB = avant.find((w: VerdictSonde) => near(w.a, [200, 150]) && near(w.b, [300, 150]));
  ok(!!wB, `le mur partagé (wB) doit exister tel que dessiné, vu ${JSON.stringify(avant)}`);
  const wA = murTouchant(avant, [200, 150], wB.id);
  const wC = murTouchant(avant, [300, 150], wB.id);
  ok(!!wA && !!wC, "les deux voisins de wB doivent exister");

  // Turn the drawing tool OFF via the BUTTON (bug #1's exact path), then drag wB's midpoint.
  await click(await centerOf("#btnDrawWall"));
  ok(await armed() === "false", "l'outil doit être désarmé avant le glissement");

  const mi = await aptPoint(250, 150), mf = await aptPoint(250, 190);
  // A WALL IS SELECTED BY CLICKING IT, and only then does it carry its move handle (decision 0010).
  await click(mi); await pause(80);
  const poignee = await centerOf(`.v5wmove[data-w="${wB.id}"]`);
  ok(!!poignee, "la poignée move du mur doit être atteignable une fois l'outil éteint");
  if (!poignee) return;
  await drag(poignee, mf);
  await pause(150);

  const apres = await interiorWalls();
  const parId = (id: VerdictSonde) => apres.find((w: VerdictSonde) => w.id === id);
  const wBApres = parId(wB.id), wAApres = parId(wA.id), wCApres = parId(wC.id);
  ok(!near(wBApres.a, wB.a) || !near(wBApres.b, wB.b),
    `le mur glissé doit réellement avoir bougé, vu avant=${JSON.stringify(wB)} après=${JSON.stringify(wBApres)}`);
  ok(near(wAApres.b, wBApres.a) || near(wAApres.a, wBApres.a),
    `wA doit rester soudé au nouveau coin de wB, vu wA=${JSON.stringify(wAApres)} wB=${JSON.stringify(wBApres)}`);
  ok(near(wCApres.a, wBApres.b) || near(wCApres.b, wBApres.b),
    `wC doit rester soudé à l'autre coin de wB, vu wC=${JSON.stringify(wCApres)} wB=${JSON.stringify(wBApres)}`);
  ok(await cellCount() === "2", `la pièce ne doit pas avoir disparu après le glissement, vu ${await cellCount()} cellule(s)`);
});

// =============================================================================
//  2. ONE Ctrl+Z RESTORES EVERYTHING THE DRAG MOVED, IN ONE STEP
// =============================================================================
await test("un_seul_ctrl_z_restaure_les_trois_murs", async () => {
  const avant = await dessinerTroisMurs();
  const wB = avant.find((w: VerdictSonde) => near(w.a, [200, 150]) && near(w.b, [300, 150]));
  await click(await centerOf("#btnDrawWall"));
  const undoAvant = await undoCount();

  const mi = await aptPoint(250, 150), mf = await aptPoint(250, 190);
  // A WALL IS SELECTED BY CLICKING IT, and only then does it carry its move handle (decision 0010).
  await click(mi); await pause(80);
  const poignee = await centerOf(`.v5wmove[data-w="${wB.id}"]`);
  if (!ok(poignee, "poignée move introuvable")) return;
  await drag(poignee, mf);
  await pause(150);
  const pendant = await interiorWalls();
  ok(JSON.stringify(pendant) !== JSON.stringify(avant), "précondition : le glissement a bien changé la géométrie");
  const undoApresGlissement = await undoCount();
  ok(Number(undoApresGlissement) === Number(undoAvant) + 1,
    `un geste de glissement, même avec des voisins qui bougent, doit pousser UNE seule entrée d'historique, vu ${undoAvant} -> ${undoApresGlissement}`);

  await evaluate(`__plan.undo(); true`);
  await pause(150);
  const apresUndo = await interiorWalls();
  const tri = (l: VerdictSonde[]) => [...l].sort((x: VerdictSonde, y: VerdictSonde) => String(x.id).localeCompare(String(y.id)));
  ok(JSON.stringify(tri(apresUndo)) === JSON.stringify(tri(avant)),
    `un seul Ctrl+Z doit restaurer les TROIS murs à l'identique, vu\n  avant=${JSON.stringify(tri(avant))}\n  après=${JSON.stringify(tri(apresUndo))}`);
  ok(await cellCount() === "2", `deux pièces après restauration, vu ${await cellCount()}`);
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
