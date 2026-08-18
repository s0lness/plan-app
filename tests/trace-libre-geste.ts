#!/usr/bin/env node
// =============================================================================
//  "FREEHAND WALL TRACE" SUITE — REAL MOUSE (CDP), REAL HIT-TESTING
// =============================================================================
// The pure pipeline (simplify/straighten/free-ends) is `tests/trace-libre.ts`, no browser. This
// suite proves the GESTURE around it: a real mouse draws an L with the "Freehand" tool armed,
// through `#btnDrawWallFree` (never a synthetic PointerEvent, which bypasses hit-testing and
// would prove nothing about the real tool button / capture-phase wiring, AGENTS.md "Gestures:
// ONE exit point" and "A click lands on what is visible").
//
//   node tests/trace-libre-geste.ts [path/to/app.html]
//
//   trace_libre_en_l_fait_deux_murs_partages   drawing an L makes 2 walls, exact shared corner,
//                                               both loose ends `free`, ONE Ctrl+Z removes both
//   clic_net_outil_libre_arme_ne_cree_rien     a press-release without movement creates nothing
//   trace_libre_equerre_maladroite_devient_un_angle_droit
//                                               2026-08-15: the owner's own defect, real mouse.
//                                               An L drawn ~15deg off axis on BOTH legs (past the
//                                               OLD 12deg tolerance) still comes out an EXACT
//                                               right angle, exact shared corner
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-tracelibre-"));
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
  await new Promise(r => setTimeout(r, 350));
  await evaluate("__plan.fitView(); true");
  await new Promise(r => setTimeout(r, 150));
}

// ---- REAL mouse ---------------------------------------------------------------------------
const M = (type: string, x: VerdictSonde, y: VerdictSonde, extra?: Record<string, unknown>) => send("Input.dispatchMouseEvent", Object.assign({
  type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1,
  clickCount: 1, pointerType: "mouse",
}, extra || {}));
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function click(p: VerdictSonde) {
  await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 });
  await M("mousePressed", p.x, p.y);
  await M("mouseReleased", p.x, p.y, { buttons: 0 });
  await pause(80);
}
/** Presses at points[0], moves through every following waypoint (several real steps each,
 * so the gesture's pointermove handler really sees a MULTI-POINT path, not one hop), releases
 * at the last point. */
async function tracePath(points: VerdictSonde[], stepsParTroncon = 8) {
  const p0 = points[0];
  await M("mouseMoved", p0.x, p0.y, { button: "none", buttons: 0 });
  await M("mousePressed", p0.x, p0.y);
  await pause(20);
  for (let leg = 1; leg < points.length; leg++) {
    const from = points[leg - 1], to = points[leg];
    for (let i = 1; i <= stepsParTroncon; i++) {
      await M("mouseMoved", from.x + (to.x - from.x) * i / stepsParTroncon, from.y + (to.y - from.y) * i / stepsParTroncon);
      await pause(10);
    }
  }
  const last = points[points.length - 1];
  await M("mouseReleased", last.x, last.y, { buttons: 0 });
  await pause(120);
}

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

const centerOf = (sel: VerdictSonde) => J(`(function(){var e=document.querySelector(${JSON.stringify(sel)});
  if(!e) return null; var r=e.getBoundingClientRect();
  return {x:r.left+r.width/2, y:r.top+r.height/2};})()`);
const aptPoint = (x: VerdictSonde, y: VerdictSonde) => J(`(function(){var s=__plan.aptToScreen(${x},${y});
  var r=document.getElementById("viewport").getBoundingClientRect();
  return {x:r.left+s.x, y:r.top+s.y};})()`);
const wallIds = () => J(`__plan.plan.walls.map(function(w){return String(w.id);})`);
const undoCount = () => evaluate(`String(__plan.histInfo().undo)`);

// The largest cell's bbox, so the stroke lands well inside a real room, clear of every wall.
async function largestCellBBox() {
  return J(`(function(){var c=__plan.plan.cells.slice().sort(function(a,b){
      return Math.abs(__plan.v5SignedArea(b.poly))-Math.abs(__plan.v5SignedArea(a.poly));})[0];
    var b=__plan.bboxOfPoly(c.poly); return {minX:b.minX,minY:b.minY,maxX:b.maxX,maxY:b.maxY};})()`);
}

// =============================================================================
//  1. trace_libre_en_l_fait_deux_murs_partages
// =============================================================================
await test("trace_libre_en_l_fait_deux_murs_partages", async () => {
  const bbox = await largestCellBBox();
  const leg = Math.max(40, Math.min(110, (bbox.maxX - bbox.minX) / 3, (bbox.maxY - bbox.minY) / 3));
  ok(leg >= 30, `précondition : la plus grande pièce doit avoir la place pour un L (leg=${leg})`);
  const A = { x: bbox.minX + 40, y: bbox.minY + 40 };
  const B = { x: A.x + leg, y: A.y };
  const C = { x: B.x, y: B.y + leg };

  const avant = await wallIds();
  const undoAvant = await undoCount();

  await click(await centerOf("#btnDrawWallFree"));
  ok(await evaluate(`String(__plan.v5ui.drawFree)`) === "true", "l'outil trace libre doit s'armer au clic");
  const sA = await aptPoint(A.x, A.y), sB = await aptPoint(B.x, B.y), sC = await aptPoint(C.x, C.y);
  await tracePath([sA, sB, sC]);

  const apres = await wallIds();
  const nouveaux = apres.filter((id: string) => avant.indexOf(id) < 0);
  ok(nouveaux.length === 2, `un trace en L doit créer exactement 2 murs, vu ${nouveaux.length} (${JSON.stringify(nouveaux)})`);
  // THE DEFAULT CHANGED (2026-08-14, AGENTS.md "the tool disarms after every wall"): the owner's
  // complaint applied equally to the freehand tool. It now STAYS ARMED after a stroke, exactly
  // like the single-segment tool (`tests/mur-outil-geste.ts` covers that one) — disarming is a
  // deliberate act (the button again or Escape), not automatic on release.
  ok(await evaluate(`String(__plan.v5ui.drawFree)`) === "true", "l'outil trace libre doit rester armé après le trait");

  if (nouveaux.length === 2) {
    const murs = await J(`${JSON.stringify(nouveaux)}.map(function(id){var w=__plan.v5WallById(id);
      return {id:id, a:w.a, b:w.b, free:w.free||0};})`);
    const [m0, m1] = murs;
    ok(Math.abs(m0.a[0] - A.x) <= 15 && Math.abs(m0.a[1] - A.y) <= 15,
      `le premier mur doit démarrer près du point pressé, vu ${JSON.stringify(m0.a)} attendu proche de ${JSON.stringify(A)}`);
    ok(Math.abs(m1.b[0] - C.x) <= 15 && Math.abs(m1.b[1] - C.y) <= 15,
      `le second mur doit finir près du point relâché, vu ${JSON.stringify(m1.b)} attendu proche de ${JSON.stringify(C)}`);
    ok(m0.b[0] === m1.a[0] && m0.b[1] === m1.a[1],
      `les deux murs doivent partager EXACTEMENT le même sommet au coin, vu ${JSON.stringify(m0.b)} vs ${JSON.stringify(m1.a)}`);
    ok(m0.a[1] === m0.b[1], `le premier troncon (horizontal) doit être parfaitement droit, vu ${JSON.stringify(m0)}`);
    ok(m1.a[0] === m1.b[0], `le second troncon (vertical) doit être parfaitement droit, vu ${JSON.stringify(m1)}`);
    ok(m0.free === 1, "le premier mur (bout libre du trait) doit être `free`");
    ok(m1.free === 1, "le second mur (bout libre du trait) doit être `free`");
  }

  const undoApres = await undoCount();
  ok(undoApres === String(Number(undoAvant) + 1), `le trait entier doit pousser UN SEUL cran d'annulation, vu ${undoAvant} -> ${undoApres}`);

  // ONE Ctrl+Z removes the WHOLE chain, not one wall at a time.
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown",
    { key:"z", ctrlKey:true, bubbles:true, cancelable:true })); true`);
  await pause(250);
  const apresUndo = (await wallIds()).slice().sort();
  ok(JSON.stringify(apresUndo) === JSON.stringify(avant.slice().sort()),
    `un seul Ctrl+Z doit retirer TOUTE la chaîne, vu ${JSON.stringify(apresUndo)} attendu ${JSON.stringify(avant)}`);
});

// =============================================================================
//  2. trace_libre_equerre_maladroite_devient_un_angle_droit
// =============================================================================
// The owner's OWN defect, reproduced with a REAL mouse (never a synthetic PointerEvent, which
// bypasses hit-testing and would prove nothing about the real capture-phase wiring): an L drawn
// ~15deg off axis on BOTH legs, comfortably past the OLD 12deg tolerance that let a badly-drawn
// corner through unstraightened. It must still come out as a TRUE right angle: both walls
// exactly horizontal/vertical, sharing one exact point.
await test("trace_libre_equerre_maladroite_devient_un_angle_droit", async () => {
  const bbox = await largestCellBBox();
  const leg = Math.max(40, Math.min(90, (bbox.maxX - bbox.minX) / 3, (bbox.maxY - bbox.minY) / 3));
  ok(leg >= 30, `précondition : la plus grande pièce doit avoir la place pour un L maladroit (leg=${leg})`);
  const derive = leg * Math.tan(15 * Math.PI / 180); // ~15deg off axis on each leg
  const A = { x: bbox.minX + 40, y: bbox.minY + 40 };
  const B = { x: A.x + leg, y: A.y + derive };        // ~15deg off HORIZONTAL, not axis-aligned
  const C = { x: B.x - derive, y: B.y + leg };         // ~15deg off VERTICAL, not axis-aligned

  const avant = await wallIds();
  await click(await centerOf("#btnDrawWallFree"));
  ok(await evaluate(`String(__plan.v5ui.drawFree)`) === "true", "l'outil trace libre doit s'armer au clic");
  const sA = await aptPoint(A.x, A.y), sB = await aptPoint(B.x, B.y), sC = await aptPoint(C.x, C.y);
  await tracePath([sA, sB, sC]);

  const apres = await wallIds();
  const nouveaux = apres.filter((id: string) => avant.indexOf(id) < 0);
  ok(nouveaux.length === 2, `une équerre maladroite doit créer exactement 2 murs, vu ${nouveaux.length} (${JSON.stringify(nouveaux)})`);
  if (nouveaux.length === 2) {
    const murs = await J(`${JSON.stringify(nouveaux)}.map(function(id){var w=__plan.v5WallById(id);
      return {id:id, a:w.a, b:w.b};})`);
    const [m0, m1] = murs;
    ok(m0.b[0] === m1.a[0] && m0.b[1] === m1.a[1],
      `les deux murs doivent partager EXACTEMENT le même coin, vu ${JSON.stringify(m0.b)} vs ${JSON.stringify(m1.a)}`);
    ok(m0.a[1] === m0.b[1], `le premier mur (tracé ~15deg hors axe) doit être PARFAITEMENT horizontal, vu ${JSON.stringify(m0)}`);
    ok(m1.a[0] === m1.b[0], `le second mur (tracé ~15deg hors axe) doit être PARFAITEMENT vertical, vu ${JSON.stringify(m1)}`);
    // perpendicularity, measured directly rather than assumed from the two axis checks above:
    // dot product of the two wall vectors must be exactly zero.
    const v0x = m0.b[0] - m0.a[0], v0y = m0.b[1] - m0.a[1];
    const v1x = m1.b[0] - m1.a[0], v1y = m1.b[1] - m1.a[1];
    ok(v0x * v1x + v0y * v1y === 0, `les deux murs doivent être EXACTEMENT perpendiculaires, produit scalaire vu ${v0x * v1x + v0y * v1y}`);
  }
});

// =============================================================================
//  3. clic_net_outil_libre_arme_ne_cree_rien
// =============================================================================
// "A press-release without movement never writes, anywhere" (AGENTS.md): with the freehand
// tool armed, a plain click must create nothing and push nothing into history, same as the
// single-segment tool.
await test("clic_net_outil_libre_arme_ne_cree_rien", async () => {
  const bbox = await largestCellBBox();
  const P = await aptPoint((bbox.minX + bbox.maxX) / 2, (bbox.minY + bbox.maxY) / 2);

  await click(await centerOf("#btnDrawWallFree"));
  ok(await evaluate(`String(__plan.v5ui.drawFree)`) === "true", "précondition : l'outil doit être armé");
  const avant = await wallIds();
  const undoAvant = await undoCount();

  await click(P);

  const apres = await wallIds();
  ok(JSON.stringify(apres.slice().sort()) === JSON.stringify(avant.slice().sort()),
    `un clic net avec l'outil armé ne doit créer AUCUN mur, vu ${apres.length} contre ${avant.length}`);
  ok(await undoCount() === undoAvant, "un clic net ne pousse rien dans l'historique");
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
