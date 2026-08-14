#!/usr/bin/env node
// =============================================================================
//  "CHAIR BACKREST" SUITE — REAL MOUSE (CDP), REAL HIT-TESTING
// =============================================================================
// The real-usage counterpart of tests/chaise-dossier.ts (the pure geometry suite): drags an
// actual chair against an actual table with the actual pointer, through the actual DOM, and
// reads back what the person would see. Usage report: "Quand je place une chaise contre une
// table, le dossier ne se met pas dans le bon sends" (the backrest ends up facing the wrong way).
//
//   node tests/chaise-dossier-geste.ts [path/to/app.html]
//
//   chaise_dock_gauche_regarde_la_table     drag onto the table's LEFT side: was rotated 180deg off
//   chaise_dock_droite_regarde_la_table     drag onto the table's RIGHT side: same, mirrored
//   chaise_dock_table_tournee_regarde_la_table   a table rotated 55deg: relative to the TABLE
//   chaise_clic_sans_mouvement_ne_bouge_rien     a press-release with no movement writes nothing
//   chaise_aller_retour_revient_exactement       dock, then drag back: G-5, position AND rotation
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-chaise-"));
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

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function reload() {
  await send("Page.navigate", { url: "file:///" + htmlPath.replace(/\\/g, "/") });
  for (let i = 0; i < 200; i++) {
    let st = null;
    try { st = await evaluate("document.readyState + '|' + (window.__plan ? 1 : 0)"); } catch (_) {}
    if (st === "complete|1") break;
    await pause(50);
  }
  await pause(300);
}

// ---- REAL mouse --------------------------------------------------------------------------------
const M = (type: string, x: VerdictSonde, y: VerdictSonde, extra?: Record<string, unknown>) => send("Input.dispatchMouseEvent", Object.assign({
  type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1,
  clickCount: 1, pointerType: "mouse",
}, extra || {}));
async function press(p: VerdictSonde) { await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 }); await M("mousePressed", p.x, p.y); await pause(20); }
async function moveTo(p: VerdictSonde, steps: number, from: VerdictSonde) {
  const a = from || p;
  for (let i = 1; i <= steps; i++) {
    await M("mouseMoved", a.x + (p.x - a.x) * i / steps, a.y + (p.y - a.y) * i / steps);
    await pause(8);
  }
}
async function release(p: VerdictSonde) { await M("mouseReleased", p.x, p.y); await pause(90); }
async function click(p: VerdictSonde) {
  await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 });
  await M("mousePressed", p.x, p.y);
  await M("mouseReleased", p.x, p.y, { buttons: 0 });
  await pause(70);
}
async function drag(from: VerdictSonde, to: VerdictSonde, steps = 16) { await press(from); await moveTo(to, steps, from); await release(to); }

// ---- micro-harness -------------------------------------------------------------------------------
const results: { name: string; fails: string[] }[] = [];
let cur: { name: string; fails: string[] } | null = null;
function ok(cond: unknown, msg?: string) { if (!cond) cur!.fails.push(msg || "assertion failed"); return !!cond; }
async function test(name: string, fn: () => Promise<void>) {
  cur = { name, fails: [] };
  await reload();
  try { await fn(); } catch (e) { cur.fails.push("EXCEPTION: " + (e && (e as Error).stack || e)); }
  const jsErr = await evaluate(`JSON.stringify((JSON.parse(localStorage.getItem("plan-errors")||"[]")||[]).map(function(e){return e&&e.msg}))`);
  if (jsErr && jsErr !== "[]") cur.fails.push("erreurs JS: " + jsErr);
  results.push(cur);
  console.log(`  ${cur.fails.length ? "FAIL " : "ok   "} ${name}`);
  cur.fails.forEach((f) => console.log("        - " + f));
}

// ---- helpers --------------------------------------------------------------------------------
const aptPoint = (x: number, y: number) => J(`(function(){var s=__plan.aptToScreen(${x},${y});
  var r=document.getElementById("viewport").getBoundingClientRect();
  return {x:r.left+s.x, y:r.top+s.y};})()`);
const pieceCenterScreen = (id: string) => J(`(function(){var e=document.querySelector('#canvas .piece[data-id="'+${JSON.stringify(id)}+'"]');
  if(!e) return null; var r=e.getBoundingClientRect();
  return {x:r.left+r.width/2, y:r.top+r.height/2};})()`);
const pose = (id: string) => J(`__plan.pieceAt(${JSON.stringify(id)})`);

/** A 600x400 open room, ONE table (id "tbl") at the given center/size/rotation, ONE chair
 *  (id "cha") parked far away in a corner, untouched by the table's snap radius. */
async function seed(tableX: number, tableY: number, tableW: number, tableH: number, tableRot: number) {
  await evaluate(`__plan.setModel({outline:[[0,0],[600,0],[600,400],[0,400]],
    walls:[{id:"wt",a:[0,0],b:[600,0],t:12},{id:"wr",a:[600,0],b:[600,400],t:12},
           {id:"wb",a:[600,400],b:[0,400],t:12},{id:"wl",a:[0,400],b:[0,0],t:12}],
    openings:[], cells:[],
    pieces:[
      {id:"tbl", type:"dining", name:"Table", x:${tableX - tableW / 2}, y:${tableY - tableH / 2},
       w:${tableW}, h:${tableH}, rot:${tableRot}, locked:false},
      {id:"cha", type:"chair", name:"Chaise", x:44.5, y:44.5, w:45, h:45, rot:0, locked:false}
    ]}); true`);
  await pause(200);
}
/** `dot`: cosine between the chair's own front (backrest at rot=0 is drawn at the TOP of the
 *  tile, icones.ts; the seat opens toward the BOTTOM) and the direction from the chair to the
 *  table. 1 = looking straight at it, -1 = backrest jammed against it. */
const facingDot = (id: string, tableId: string) => J(`(function(){
  var c=__plan.pieceAt(${JSON.stringify(id)}), t=__plan.pieceAt(${JSON.stringify(tableId)});
  var rad=(c.rot||0)*Math.PI/180, fx=-Math.sin(rad), fy=Math.cos(rad);
  var dx=t.cx-c.cx, dy=t.cy-c.cy, m=Math.hypot(dx,dy)||1;
  return fx*(dx/m)+fy*(dy/m);
})()`);

// =============================================================================================
//  1. LEFT and RIGHT are the pair that came out swapped (top/bottom were accidentally right,
//     see tests/chaise-dossier.ts): drag a real chair onto each side of an unrotated table and
//     read back the DOM's own idea of where it ended up.
// =============================================================================================
await test("chaise_dock_gauche_regarde_la_table", async () => {
  await seed(300, 200, 150, 90, 0);
  const from = await pieceCenterScreen("cha");
  const to = await aptPoint(300 - 75 - 15, 200);   // just left of the table's left edge
  await drag(from, to);
  const p = await pose("cha");
  ok(p.rot === 270, `attendu rot=270 (dos vers l'ouest, face vers la table), vu ${p.rot}`);
  const dot = await facingDot("cha", "tbl");
  ok(dot > 0.9, `la chaise doit regarder la table, cos=${dot}`);
});
await test("chaise_dock_droite_regarde_la_table", async () => {
  await seed(300, 200, 150, 90, 0);
  const from = await pieceCenterScreen("cha");
  const to = await aptPoint(300 + 75 + 15, 200);   // just right of the table's right edge
  await drag(from, to);
  const p = await pose("cha");
  ok(p.rot === 90, `attendu rot=90 (dos vers l'est, face vers la table), vu ${p.rot}`);
  const dot = await facingDot("cha", "tbl");
  ok(dot > 0.9, `la chaise doit regarder la table, cos=${dot}`);
});

// =============================================================================================
//  2. A ROTATED TABLE: the correct answer is relative to the TABLE, exactly the owner's report
//     ("the backrest doesn't end up facing the right way"), not a screen-relative coincidence.
// =============================================================================================
await test("chaise_dock_table_tournee_regarde_la_table", async () => {
  const rot = 55;
  await seed(300, 200, 150, 90, rot);
  // target a point straight out from the table's local "east" edge, in world coordinates
  const rad = rot * Math.PI / 180, ca = Math.cos(rad), sa = Math.sin(rad);
  const ox = 95 * ca, oy = 95 * sa;   // hw(75) + ~20cm reach, along the table's OWN +x axis
  const from = await pieceCenterScreen("cha");
  const to = await aptPoint(300 + ox, 200 + oy);
  await drag(from, to);
  const dot = await facingDot("cha", "tbl");
  ok(dot > 0.9, `table tournee de ${rot}deg : la chaise doit quand meme regarder la table, cos=${dot}`);
});

// =============================================================================================
//  3. A PRESS-RELEASE WITHOUT MOVEMENT NEVER WRITES, ANYWHERE (AGENTS.md). Docking is no
//     exception: a plain click on an already-docked chair must not spin it or move it.
// =============================================================================================
await test("chaise_clic_sans_mouvement_ne_bouge_rien", async () => {
  await seed(300, 200, 150, 90, 0);
  const from = await pieceCenterScreen("cha");
  await drag(from, await aptPoint(300 - 75 - 15, 200));
  const before = await pose("cha");
  const at = await pieceCenterScreen("cha");
  await click(at);
  const after = await pose("cha");
  ok(after.rot === before.rot && after.cx === before.cx && after.cy === before.cy,
    `un clic sans mouvement a change la chaise : avant ${JSON.stringify(before)}, apres ${JSON.stringify(after)}`);
});

// =============================================================================================
//  4. G-5, THE ROUND TRIP: dock the chair (a real move, position AND rotation both change), then
//     drag it back near its ORIGINAL spot in a second gesture. It must return EXACTLY, rotation
//     included: the chair-table snap must not turn "the round trip returns to the start" into a
//     one-way trip because it now also touches `rot`.
// =============================================================================================
await test("chaise_aller_retour_revient_exactement", async () => {
  await seed(300, 200, 150, 90, 0);
  const start = await pose("cha");
  // gesture 1: away, and far enough to dock (also clears the RETOUR_TOL*2 threshold)
  const from1 = await pieceCenterScreen("cha");
  await drag(from1, await aptPoint(300 - 75 - 15, 200));
  const docked = await pose("cha");
  ok(docked.rot === 270 && (docked.cx !== start.cx || docked.cy !== start.cy),
    `la chaise doit vraiment s'etre calee et deplacee, vu ${JSON.stringify(docked)}`);
  // gesture 2: back near the ORIGINAL spot
  const from2 = await pieceCenterScreen("cha");
  await drag(from2, await aptPoint(start.cx, start.cy));
  const back = await pose("cha");
  ok(back.cx === start.cx && back.cy === start.cy && back.rot === start.rot,
    `l'aller-retour doit revenir EXACTEMENT au depart ${JSON.stringify(start)}, vu ${JSON.stringify(back)}`);
});

// =============================================================================================
console.log(`\n${(() => { const bad = results.filter(r => r.fails.length).length;
  return bad ? `FAILURES ${bad}/${results.length}` : `OK ${results.length}/${results.length}`; })()}`);
const failed = results.filter(r => r.fails.length).length;
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
chrome.kill();
process.exit(failed ? 1 : 0);
