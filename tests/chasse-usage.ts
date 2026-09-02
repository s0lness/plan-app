#!/usr/bin/env node
// =============================================================================
//  "CHASSE USAGE" SUITE: REAL MOUSE + KEYBOARD (CDP), real hit-testing
// =============================================================================
// Two defects found by a long ordinary-use hunt (round trips, repeats, the newest gestures,
// undo/redo chains, Escape/blur/off-canvas, and a 300-object plan), on the invented demo
// apartment (`exemple-appartement.json`, "belongs to no one"). Same family as
// `gestes-usage-reel.ts`: LOOKING changes nothing, REPEATING a gesture gives the same result.
//
//   node tests/chasse-usage.ts [path/to/app.html]
//
//   mur_re_glisse_apres_selection_ne_le_supprime_pas   grabbing a SELECTED wall again by its own
//                                                       center used to hit its delete cross instead
//                                                       of its drag band: the wall vanished.
//   escape_pendant_glisser_ne_gaspille_pas_un_ctrl_z   pushHistory() on the first real movement,
//                                                       then Escape restoring the exact same state,
//                                                       left a no-op entry: the next Ctrl+Z did
//                                                       nothing, and the real previous action needed
//                                                       a SECOND one to reach.
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
// The invented demo apartment (public, belongs to no one): 13 walls incl. one full-height
// interior partition, exactly what "grab a wall a second time" needs.
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "exemple-appartement.json"), "utf8"));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-chasseusage-"));
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
      let t: string[] = [];
      try { t = fs.readFileSync(portFile, "utf8").split("\n"); } catch { t = []; }
      if (t[0] && /^[0-9]+$/.test(t[0].trim())) return t[0].trim();
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("no DevToolsActivePort");
}
const port = await waitPort();
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as CibleCDP[];
const page = list.find(t => t.type === "page")!;
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => (ws.onopen = r));

let msgId = 0;
const pending = new Map<number, (message: ReponseCDP) => void>();
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id)!; pending.delete(m.id); p(m); }
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
  await evaluate("__plan.fitView(); true");
  await new Promise(r => setTimeout(r, 150));
}

// ---- REAL mouse + keyboard ---------------------------------------------------------------------
const M = (type: string, x: VerdictSonde, y: VerdictSonde, extra?: Record<string, unknown>) => send("Input.dispatchMouseEvent", Object.assign({
  type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1,
  clickCount: 1, pointerType: "mouse",
}, extra || {}));
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function press(p: VerdictSonde) { await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 }); await M("mousePressed", p.x, p.y); await pause(20); }
async function moveTo(p: VerdictSonde, steps = 8, from: VerdictSonde) {
  const a = from || p;
  for (let i = 1; i <= steps; i++) { await M("mouseMoved", a.x + (p.x - a.x) * i / steps, a.y + (p.y - a.y) * i / steps); await pause(8); }
}
async function release(p: VerdictSonde) { await M("mouseReleased", p.x, p.y); await pause(90); }
async function drag(from: VerdictSonde, to: VerdictSonde, steps = 16) { await press(from); await moveTo(to, steps, from); await release(to); }
async function click(p: VerdictSonde) { await press(p); await release(p); }
async function key(k: string, code: string, type: "keyDown" | "keyUp") { await send("Input.dispatchKeyEvent", { type, key: k, code }); }

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

const wallRect = (id: string) => J(`(function(){var w=__plan.v5WallById(${JSON.stringify(id)});if(!w)return null;
  var p=__plan.aptToScreen(w.a[0]+.2*(w.b[0]-w.a[0]),w.a[1]+.2*(w.b[1]-w.a[1])),r=document.getElementById("viewport").getBoundingClientRect();
  return {x:r.left+p.x,y:r.top+p.y};})()`);
const moveRect = (id: string) => J(`(function(){var e=document.querySelector('.v5wmove[data-w="'+${JSON.stringify(id)}+'"]');
  if(!e) return null; var r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
const pieceRect = (id: string) => J(`(function(){var e=document.querySelector('#canvas .piece[data-id="'+${JSON.stringify(id)}+'"]');
  if(!e) return null; var r=e.getBoundingClientRect();
  return {x:r.left+r.width/2, y:r.top+r.height/2};})()`);
const pose = (id: string) => J(`__plan.pieceAt(${JSON.stringify(id)})`);
const undoCount = async () => Number(await evaluate(`String(__plan.histInfo().undo)`));

// =============================================================================
//  1. mur_re_glisse_apres_selection_ne_le_supprime_pas
// =============================================================================
// The delete "x" of the SELECTED wall (painted by the handle pass of rendu/calque.ts) used to sit dead-center on
// the wall's own segment. Selecting a wall by dragging it once, then reaching for the SAME spot
// to nudge it again, hit the delete cross
// instead, the wall vanished, silently (no toast: the layer's own early return hands the event to
// `.v5wx` before the wall-drag gesture is ever armed).
await test("mur_re_glisse_apres_selection_ne_le_supprime_pas", async () => {
  const w = await J(`(function(){var x=__plan.plan.walls.filter(function(w){return !w.isOutline;})[0];
    return x?{id:String(x.id), a:x.a, b:x.b}:null;})()`);
  if (!ok(w, "aucune cloison intérieure dans le gabarit")) return;
  const n0 = await J(`__plan.plan.walls.length`);

  // Reveal and select through the midpoint handle, then use that same dedicated target twice.
  const bande = await wallRect(w.id);
  if (!ok(bande, "centre du mur introuvable")) return;
  await M("mouseMoved", bande.x, bande.y, { button: "none", buttons: 0 }); await pause(120);
  let p0 = await moveRect(w.id);
  if (!ok(p0, "poignée move introuvable")) return;
  await click(p0); p0 = await moveRect(w.id);
  await drag(p0, { x: p0.x + 30, y: p0.y + 30 }, 16);
  await pause(150);
  ok(await J(`__plan.plan.walls.length`) === n0, "le premier geste ne doit ni créer ni supprimer de mur");
  const w1 = await J(`(function(){var x=__plan.v5WallById(${JSON.stringify(w.id)}); return x?{a:x.a,b:x.b}:null;})()`);
  if (!ok(w1, "la cloison a disparu après le premier geste (déjà anormal)")) return;
  const moved = (w1.a[0] !== w.a[0] || w1.a[1] !== w.a[1] || w1.a[0] !== w1.b[0]);
  if (!ok(moved || w1.a[0] !== w.a[0], "précondition: le premier geste doit déplacer la cloison")) return;

  // Second grab, from the wall's OWN rendered center (the natural "adjust it again" gesture).
  const p1 = await moveRect(w.id);
  if (!ok(p1, "poignée move introuvable après le premier geste")) return;
  await drag(p1, { x: p1.x - 30, y: p1.y - 30 }, 16);
  await pause(150);

  ok(await J(`__plan.plan.walls.length`) === n0,
    `re-glisser une cloison SÉLECTIONNÉE depuis son propre centre ne doit pas la supprimer (${n0} -> ${await J(`__plan.plan.walls.length`)})`);
  const w2 = await J(`(function(){var x=__plan.v5WallById(${JSON.stringify(w.id)}); return x?{a:x.a,b:x.b}:null;})()`);
  ok(!!w2, "la cloison doit toujours exister après le second geste");
});

// =============================================================================
//  2. escape_pendant_glisser_ne_gaspille_pas_un_ctrl_z
// =============================================================================
// `pushHistory()` falls on a gesture's FIRST real movement (G-3), not on `pointerdown`. Escape
// then restores the pre-gesture position through the gesture's own `cancel`, but the snapshot
// pushed at the first movement used to stay on the undo stack: it now describes EXACTLY the
// current state, so the next Ctrl+Z did nothing visible, and the actual previous action needed a
// SECOND Ctrl+Z to reach.
await test("escape_pendant_glisser_ne_gaspille_pas_un_ctrl_z", async () => {
  const ids: string[] = await J(`__plan.plan.pieces.filter(function(p){return !p.locked && !__plan.isWallMount(p.type);}).slice(0,2).map(function(p){return String(p.id);})`);
  if (!ok(ids.length === 2, "il faut deux meubles distincts dans le gabarit")) return;
  const [idPrev, idEscaped] = ids;

  // A REAL prior action, the one a single Ctrl+Z must reach: move idPrev by a clean amount.
  const R0 = await pieceRect(idPrev);
  if (!ok(R0, "premier meuble non rendu")) return;
  const avPrev = await pose(idPrev);
  await drag(R0, { x: R0.x + 70, y: R0.y + 45 }, 14);
  await pause(150);
  const apPrev = await pose(idPrev);
  if (!ok(apPrev.cx !== avPrev.cx || apPrev.cy !== avPrev.cy, "précondition: l'action précédente doit avoir un effet réel")) return;
  const undoAvantEscape = await undoCount();

  // The gesture that gets Escaped: real movement, then Escape before release.
  const R1 = await pieceRect(idEscaped);
  if (!ok(R1, "second meuble non rendu")) return;
  await press(R1);
  await moveTo({ x: R1.x + 90, y: R1.y + 60 }, 10, R1);
  await pause(60);
  await key("Escape", "Escape", "keyDown");
  await pause(150);
  ok((await undoCount()) === undoAvantEscape,
    "Escape mid-drag ne doit ajouter AUCUNE entrée d'annulation (ni en laisser une orpheline)");

  // ONE Ctrl+Z must now undo the REAL previous action (idPrev's move), not a no-op.
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key:"z", ctrlKey:true, bubbles:true, cancelable:true })); true`);
  await pause(250);
  const apresUnCtrlZ = await pose(idPrev);
  ok(apresUnCtrlZ.cx === avPrev.cx && apresUnCtrlZ.cy === avPrev.cy,
    `un SEUL Ctrl+Z doit défaire l'action réelle précédente, vu ${idPrev} à ${apresUnCtrlZ.cx},${apresUnCtrlZ.cy} attendu ${avPrev.cx},${avPrev.cy}`);
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
