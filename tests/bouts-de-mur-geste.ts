#!/usr/bin/env node
// =============================================================================
//  "WALL ENDPOINT HANDLES" SUITE — REAL MOUSE (CDP), end to end
// =============================================================================
// Owner's report, verbatim: "j'aimerais aussi pouvoir choper les extrémités des murs et pouvoir
// étendre et relier à d'autres murs. parfois je fais un mur mais je me rate, je voulais le faire
// plus long, et là je dois le delete et recommencer." `tests/bouts-de-mur.ts` proves the PURE
// snap/direction/grid cascade and the mutation itself; this suite proves the two things only a
// real browser can prove:
//   1. the new handle is actually HITTABLE at working zoom (a headless test can call the
//      exported function directly and prove nothing about whether a real finger can land on it);
//   2. clicking the wall's own BODY still drags the WHOLE wall, not an endpoint — the two hit
//      targets sit right next to each other and must not steal each other's clicks, the exact
//      shape of the "+".18px-outward and "delete cross" bugs this codebase has already been bitten
//      by (AGENTS.md, "G-15" and "G-15-BIS").
// It ALSO covers "a press-release without movement writes nothing" end to end: that invariant is
// enforced inside the real gesture (`armGesture`/`pushHistory`), which this repository never
// drives outside a real browser (every other `*-geste.ts` suite does the same for its own tool).
//
// Real mouse (`Input.dispatchMouseEvent`), never a synthetic PointerEvent: AGENTS.md, "A click
// lands on what is visible" — a synthetic event bypasses hit-testing and the capture-phase wiring
// this feature lives in.
//
//   node tests/bouts-de-mur-geste.ts [path/to/app.html]
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
// wizard instead of the ordinary canvas, and every test here overrides the geometry anyway
// through `__plan.setModel(...)` once the app has booted.
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "plan-rev177.json"), "utf8"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-boutsdemur-"));
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
const wallRect = (id: string) => J(`(function(){var e=document.querySelector('[data-w="'+${JSON.stringify(id)}+'"]');
  if(!e) return null; var r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
const mur = (id: string) => J(`(function(){var w=__plan.v5WallById(${JSON.stringify(id)}); return w?{a:w.a,b:w.b,free:w.free||0}:null;})()`);
const undoCount = () => evaluate(`String(__plan.histInfo().undo)`);
const selWall = () => evaluate(`String(__plan.v5ui.selWall)`);

/** A single interior wall, isolated, far from the outline: (100,50)->(100,250). `free` matters:
 * a NON-free wall is deliberately used by test 1 (it proves the endpoint drag ITSELF sets the
 * flag), while test 2 needs a `free` wall so its own perpendicular translation is not ALSO
 * re-extended to the facades by the ordinary through-going pipeline — that pre-existing
 * behavior is real and correct, but it is orthogonal to what test 2 measures. */
async function seedUnMur(free?: boolean) {
  await evaluate(`__plan.setModel({outline:[[0,0],[420,0],[420,360],[0,360]],
    walls:[{id:"w1", a:[100,50], b:[100,250], t:12${free ? ", free:1" : ""}}], openings:[], pieces:[], cells:[]}); true`);
  await pause(150);
  await evaluate(`__plan.wallsMode(true); true`);
  await pause(80);
}

// =============================================================================
//  1. the handle is HITTABLE, and dragging it lengthens the wall
// =============================================================================
await test("poignee_bout_atteignable_glisser_allonge_le_mur", async () => {
  await seedUnMur();
  // Select the wall first (a clean click on its body): the endpoint handles only exist for the
  // SELECTED wall (`rendu/calque.ts`'s `drawHandles`).
  await click(await aptPoint(100, 150));
  ok(await selWall() === "w1", "le mur w1 doit être sélectionné avant que ses poignées existent");

  const avant = await mur("w1");
  if (!ok(avant, "mur w1 introuvable")) return;
  const Lavant = Math.hypot(avant.b[0] - avant.a[0], avant.b[1] - avant.a[1]);

  const hb = await centerOf('.v5wend[data-w="w1"][data-bout="b"]');
  ok(!!hb, "la poignée d'extrémité (bout b) doit exister et être rendue au clic");
  if (!hb) return;
  // Real screen position of `b` itself: the handle must sit ON it, not merely "near" it.
  const bScreen = await aptPoint(avant.b[0], avant.b[1]);
  ok(Math.hypot(hb.x - bScreen.x, hb.y - bScreen.y) < 3,
    `la poignée doit être centrée EXACTEMENT sur l'extrémité, vu poignée=${JSON.stringify(hb)} b=${JSON.stringify(bScreen)}`);

  // Drag it straight down, well past its current position: extending the wall, in open space.
  await drag(hb, await aptPoint(100, 340));
  await pause(150);

  const apres = await mur("w1");
  if (!ok(apres, "le mur a disparu après le geste")) return;
  const Lapres = Math.hypot(apres.b[0] - apres.a[0], apres.b[1] - apres.a[1]);
  ok(Lapres > Lavant + 50, `le mur doit s'être ALLONGÉ nettement, vu ${Lavant.toFixed(1)} -> ${Lapres.toFixed(1)} cm`);
  ok(apres.a[0] === avant.a[0] && apres.a[1] === avant.a[1],
    `l'autre extrémité (a) ne doit pas avoir bougé, vu ${JSON.stringify(apres.a)} attendu ${JSON.stringify(avant.a)}`);
  ok(apres.free === 1, `l'extrémité tirée doit rendre le mur \`free\`, vu ${apres.free}`);
});

// =============================================================================
//  2. clicking the wall's own BODY still drags the WHOLE wall, not one endpoint
// =============================================================================
await test("clic_sur_le_corps_du_mur_deplace_tout_le_mur_pas_une_extremite", async () => {
  await seedUnMur(true);
  await click(await aptPoint(100, 150));
  ok(await selWall() === "w1", "le mur w1 doit être sélectionné");
  const avant = await mur("w1");
  if (!ok(avant, "mur w1 introuvable")) return;

  // The wall's own drag band (`[data-w]`), at its MIDPOINT — well clear of either endpoint
  // handle, which sit 100 cm away at either end.
  const p0 = await wallRect("w1");
  if (!ok(p0, "bande de mur introuvable (data-w)")) return;
  await drag(p0, { x: p0.x + 60, y: p0.y });
  await pause(150);

  const apres = await mur("w1");
  if (!ok(apres, "le mur a disparu")) return;
  const da = Math.hypot(apres.a[0] - avant.a[0], apres.a[1] - avant.a[1]);
  const db = Math.hypot(apres.b[0] - avant.b[0], apres.b[1] - avant.b[1]);
  ok(da > 10 && db > 10,
    `un clic sur le CORPS du mur doit déplacer les DEUX extrémités (glissement perpendiculaire), vu Δa=${da.toFixed(1)} Δb=${db.toFixed(1)}`);
  // A whole-wall drag is a perpendicular OFFSET: both ends move by (about) the same amount.
  ok(Math.abs(da - db) < 5, `les deux extrémités doivent se déplacer du MÊME décalage (glissement, pas étirement), vu Δa=${da.toFixed(1)} Δb=${db.toFixed(1)}`);
});

// =============================================================================
//  3. a press-release without movement on the handle writes NOTHING
// =============================================================================
await test("clic_sans_glissement_sur_la_poignee_n_ecrit_rien", async () => {
  await seedUnMur();
  await click(await aptPoint(100, 150));
  ok(await selWall() === "w1", "le mur w1 doit être sélectionné");

  const hb = await centerOf('.v5wend[data-w="w1"][data-bout="b"]');
  if (!ok(hb, "poignée introuvable")) return;
  const avantPlan = await evaluate(`JSON.stringify(__plan.serialize())`);
  const avantUndo = await undoCount();

  await click(hb);
  await pause(120);

  ok(await undoCount() === avantUndo, "un clic sans glissement sur la poignée ne doit pousser AUCUNE entrée d'historique");
  const apresPlan = await evaluate(`JSON.stringify(__plan.serialize())`);
  ok(apresPlan === avantPlan, "le plan doit rester OCTET POUR OCTET identique après un clic sans glissement sur la poignée");
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
