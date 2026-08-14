#!/usr/bin/env node
// =============================================================================
//  "WALL TOOL" SUITE — REAL MOUSE + REAL KEYBOARD (CDP), REAL HIT-TESTING
// =============================================================================
// Three complaints from the owner, verbatim: "walls don't work."
//
//   node tests/mur-outil-geste.ts [path/to/app.html]
//
//   outil_reste_arme_et_le_quatrieme_mur_partage_le_sommet
//     the tool used to disarm after every single wall (`v5SetDraw(ctx,false)` in `up()`):
//     drawing a room meant re-clicking "Draw a wall" between every segment. Now it stays armed
//     until a DELIBERATE act disarms it, and starting a new wall near an existing wall's
//     endpoint snaps onto that EXACT point (closing a room).
//   mur_trace_garde_sa_longueur_tracee
//     a wall drawn by hand used to extend itself to the first barrier (`v5ThroughWall`, the
//     historical default for a wall REBUILT from the outline, wrong for a hand-drawn stub): it
//     now keeps the ends it was drawn with (`free:1`).
//   d_tenu_sur_un_mur_affiche_des_guides_et_n_ecrit_rien
//     hold `D` on a wall shows its length and its distance to what surrounds it, exactly like
//     furniture: a LOOK, never a WRITE (no history, no save, no op).
//
// Real mouse (`Input.dispatchMouseEvent`), never a synthetic PointerEvent: a synthetic event
// bypasses hit-testing and the capture-phase wiring, and would prove nothing about the real
// tool button (AGENTS.md, "Gestures: ONE exit point" / "A click lands on what is visible").
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-mur-outil-"));
const htmlPath = path.join(dir, "case.html");
fs.writeFileSync(htmlPath,
  `<!doctype html><html><head><meta charset="utf-8"><script>
window.__PLAN_TEST__=1;
// A SEEDED plan (not a blank profile): a blank profile opens the "configure your apartment"
// wizard instead of the ordinary canvas, and every test here overrides the geometry anyway
// through \`__plan.setModel(...)\` once the app has booted.
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

// ---- REAL mouse / REAL keyboard ---------------------------------------------------------------
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
async function drag(from: VerdictSonde, to: VerdictSonde, steps = 12) { await press(from); await moveTo(to, steps, from); await release(to); }
// SEPARATE down/up (unlike the usual one-shot `key()` helper elsewhere): a HELD key is exactly
// what this suite needs to test (the "D" guides must appear WHILE it is down, and disappear once
// it is up), so the two halves cannot be collapsed into one call here.
async function keyDown(k: string, code: string, vk: number) {
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk });
}
async function keyUp(k: string, code: string, vk: number) {
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
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
  return {x:r.left+r.width/2, y:r.top+r.height/2};})()`);
const aptPoint = (x: VerdictSonde, y: VerdictSonde) => J(`(function(){var s=__plan.aptToScreen(${x},${y});
  var r=document.getElementById("viewport").getBoundingClientRect();
  return {x:r.left+s.x, y:r.top+s.y};})()`);
const interiorWalls = () => J(`__plan.plan.walls.filter(function(w){return !w.isOutline;})
  .map(function(w){return {id:String(w.id), a:w.a, b:w.b, free:w.free||0};})`);
const undoCount = () => evaluate(`String(__plan.histInfo().undo)`);
const armed = () => evaluate(`String(__plan.v5ui.draw)`);
// Installs the default blank apartment (no interior walls) and switches to Walls mode.
async function seedBlank() {
  await evaluate(`__plan.setModel({outline:[[0,0],[420,0],[420,360],[0,360]],
    walls:[], openings:[], pieces:[], cells:[]}); true`);
  await pause(150);
  await evaluate(`__plan.wallsMode(true); true`);
  await pause(80);
}
const armDraw = async () => {
  if (await armed() !== "true") await click(await centerOf("#btnDrawWall"));
  return await armed() === "true";
};

// =============================================================================
//  1. outil_reste_arme_et_le_quatrieme_mur_partage_le_sommet
// =============================================================================
// Draws three walls in a row with ONE click on the tool button, then a fourth starting exactly
// on the third's own endpoint: it must land there EXACTLY, not merely on the same axis as it.
await test("outil_reste_arme_et_le_quatrieme_mur_partage_le_sommet", async () => {
  await seedBlank();
  ok(await armDraw(), "l'outil de tracé ne s'arme pas");

  // Wall A: alone, away from anything else (80,80)->(80,200).
  await drag(await aptPoint(80, 80), await aptPoint(80, 200), 14);
  ok(await armed() === "true", "l'outil s'est désarmé après le premier mur");
  const apres1 = await interiorWalls();
  ok(apres1.length === 1, `un premier mur tracé doit donner 1 mur, vu ${apres1.length}`);

  // Wall B: unrelated, (200,80)->(280,80). STILL no click on the tool button.
  await drag(await aptPoint(200, 80), await aptPoint(280, 80), 14);
  ok(await armed() === "true", "l'outil s'est désarmé après le deuxième mur");
  const apres2 = await interiorWalls();
  ok(apres2.length === 2, `deux murs tracés sans réarmer doivent donner 2 murs, vu ${apres2.length}`);

  // Wall C: starts exactly where B ended, (280,80)->(280,200). STILL no click.
  await drag(await aptPoint(280, 80), await aptPoint(280, 200), 14);
  ok(await armed() === "true", "l'outil s'est désarmé après le troisième mur");
  const apres3 = await interiorWalls();
  ok(apres3.length === 3, `trois murs tracés SANS réarmer l'outil doivent donner 3 murs, vu ${apres3.length}`);

  // Wall D, the FOURTH: starts exactly where C ended, (280,200), and is dragged DIAGONALLY
  // (off-axis from its own start) toward wall A's own start point, (80,80). Still no click on the
  // tool button anywhere in this test: this is the owner's actual complaint, drawing a room
  // without having to re-click "Draw a wall" between every segment.
  //
  // WHY OFF-AXIS, DELIBERATELY: the drawing tool locks a stroke to horizontal/vertical by
  // default (Alt = free). A wall's START point already snapped onto an existing vertex before
  // this batch (`v5SnapPoint` checks vertices before edges/the grid); what did NOT, until now,
  // was the END point, because the orthogonal lock used to collapse it onto ONE axis of the
  // start point FIRST, so an existing joint that was not exactly on that axis got missed by a
  // few centimeters (a "nearly touching" corner). Dragging from (280,200) to near (80,80) —
  // dx=-200, dy=-120, neither zero — is exactly the case that used to fail: the orthogonal
  // constraint would have kept the wall's end at y=200 (or x=280), a few dozen cm from A's real
  // corner, not on it.
  await drag(await aptPoint(280, 200), await aptPoint(82, 78), 14);
  const apres4 = await interiorWalls();
  ok(apres4.length === 4, `un quatrième mur, toujours sans réarmer, doit donner 4 murs, vu ${apres4.length}`);

  const [wA, wB, wC, wD] = [apres1[0], apres2[1], apres3[2], apres4[3]];
  ok(!!(wA && wB && wC && wD), "les quatre murs doivent tous exister");
  if (wA && wB && wC && wD) {
    ok(JSON.stringify(wD.a) === JSON.stringify(wC.b),
      `le 4e mur doit démarrer EXACTEMENT là où le 3e finit, vu ${JSON.stringify(wD.a)} contre ${JSON.stringify(wC.b)}`);
    ok(JSON.stringify(wC.a) === JSON.stringify(wB.b),
      `le 3e mur démarrait déjà EXACTEMENT là où le 2e finit, vu ${JSON.stringify(wC.a)} contre ${JSON.stringify(wB.b)}`);
    ok(JSON.stringify(wD.b) === JSON.stringify(wA.a),
      `le 4e mur, tracé EN DIAGONALE (hors axe) vers le coin du 1er, doit finir EXACTEMENT dessus, `
      + `vu ${JSON.stringify(wD.b)} contre ${JSON.stringify(wA.a)}`);
  }
});

// =============================================================================
//  2. mur_trace_garde_sa_longueur_tracee
// =============================================================================
// A 80 cm stub, drawn far from any barrier, must stay 80 cm: before, `v5ThroughWall` always
// extended it to the first wall or facade it could reach (here, the full ~360 cm of the
// apartment's height).
await test("mur_trace_garde_sa_longueur_tracee", async () => {
  await seedBlank();
  ok(await armDraw(), "l'outil de tracé ne s'arme pas");
  await drag(await aptPoint(150, 150), await aptPoint(150, 230), 14);
  const murs = await interiorWalls();
  ok(murs.length === 1, `un seul mur doit être créé, vu ${murs.length}`);
  const w = murs[0];
  if (ok(w, "aucun mur créé")) {
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    ok(Math.abs(L - 80) <= 5, `le mur doit garder ~80 cm (tracé), vu ${L.toFixed(1)} cm (${JSON.stringify(w)})`);
    ok(w.a[1] > 100 && w.b[1] < 300,
      `le mur ne doit PAS s'être allongé jusqu'aux façades (haut=0, bas=360), vu ${JSON.stringify(w)}`);
    ok(w.free === 1, `un mur tracé à la main doit être \`free\`, vu ${JSON.stringify(w)}`);
  }
});

// =============================================================================
//  3. d_tenu_sur_un_mur_affiche_des_guides_et_n_ecrit_rien
// =============================================================================
// Same LOOK-never-WRITE promise `drawGuides` already gives furniture (AGENTS.md, "Hold D on a
// wall, like on furniture"): the guides appear while the key is down and vanish once it is up,
// and the plan is byte-identical before and after (nothing pushed to history, nothing saved).
await test("d_tenu_sur_un_mur_affiche_des_guides_et_n_ecrit_rien", async () => {
  await evaluate(`__plan.setModel({outline:[[0,0],[420,0],[420,360],[0,360]],
    walls:[{id:"w1", a:[100,50], b:[100,300], t:12}], openings:[], pieces:[], cells:[]}); true`);
  await pause(150);
  await evaluate(`__plan.wallsMode(true); true`);
  await pause(80);

  // Select the wall with a clean click (G-3: selecting never writes).
  await click(await aptPoint(100, 175));
  ok(await evaluate(`String(__plan.v5ui.selWall)`) === "w1", "le mur w1 doit être sélectionné");

  const avant = await evaluate(`JSON.stringify(__plan.serialize())`);
  const undoAvant = await undoCount();
  ok((await J(`[].slice.call(document.querySelectorAll(".guides")).length`)) === 0,
    "précondition : aucun guide affiché avant D");

  await keyDown("d", "KeyD", 68);
  await pause(120);
  const pendant = await J(`[].slice.call(document.querySelectorAll(".guides .gline,.guides .glab")).length`);
  ok(pendant > 0, `D tenu sur un mur doit afficher des guides, vu ${pendant} élément(s)`);
  const texte = await J(`[].slice.call(document.querySelectorAll(".guides .glab")).map(function(e){return e.textContent;}).join(" | ")`);
  ok(/250/.test(String(texte)), `la longueur du mur (250 cm) doit apparaître dans un des chips, vu "${texte}"`);

  await keyUp("d", "KeyD", 68);
  await pause(120);
  const apresRelache = await J(`[].slice.call(document.querySelectorAll(".guides")).length`);
  ok(apresRelache === 0, `relâcher D doit effacer les guides, vu ${apresRelache} conteneur(s) restant`);

  const apres = await evaluate(`JSON.stringify(__plan.serialize())`);
  ok(apres === avant, "le plan doit rester OCTET POUR OCTET identique avant/après D tenu");
  ok(await undoCount() === undoAvant, "D tenu ne doit rien pousser dans l'historique");
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
