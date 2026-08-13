#!/usr/bin/env node
// =============================================================================
//  "GESTES AMIS" SUITE — REAL MOUSE + KEYBOARD (CDP), two affordances nobody could guess
// =============================================================================
// Two requests from a real user of the app.
//
//   node tests/geste-ami.ts [path/to/app.html]
//
//   ctrl_glisse_meuble_au_centimetre   Ctrl/Cmd held during a drag: the 5 cm grid steps down to
//                                      the whole centimeter. Negative control: the SAME drag,
//                                      same distance, WITHOUT the modifier, lands on the grid.
//   d_tenu_montre_les_cotes_du_choisi  D held (nothing selected): dimensions of the object under
//                                      the pointer, ephemeral, nothing written, nothing saved.
//   d_tenu_privilegie_la_selection     a selection wins over the pointer: guides appear even when
//                                      the pointer sits over open floor.
//   d_relache_efface_les_guides        release: the guides disappear, and only the guides — no
//                                      trace in the model.
//
// Plus a THIRD real-user request, on the SAME modifier: holding Ctrl/Cmd BEFORE pressing (the
// natural gesture) used to start no drag at all, only a selection toggle, because the modifier
// was read at `pointerdown`. The decision now defers to the release, same pattern as the
// stacked-pick rule ("a completed click moves down one step").
//
//   ctrl_presse_avant_glisse_deplace_sans_toggle   Ctrl/Cmd held BEFORE the press, then a real
//                                      drag: the piece moves, grid suppressed, and the selection
//                                      is left exactly as it was (no toggle fires).
//   ctrl_clic_sans_glisser_bascule_la_selection    Ctrl/Cmd press-then-release with NO movement:
//                                      the OLD behavior, unchanged — a toggle, and nothing written.
//   ctrl_clic_deux_fois_desactive_la_selection     the same click twice in a row toggles the
//                                      piece back OUT of the selection.
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
// The household's real converted plan (v4 on disk, migrated to v5 on load): reused from
// gestes-precision.ts, which already proves "Homu" clean of alignment-snap interference at a
// 30 cm nudge in +x — the same piece, a smaller nudge, in the same direction, stays clean too.
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "plan-reel-77.json"), "utf8"));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-geste-ami-"));
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

async function navigateTo(path_: string) {
  await send("Page.navigate", { url: "file:///" + path_.replace(/\\/g, "/") });
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
async function reload() { await navigateTo(htmlPath); }

// ---- REAL mouse, WITH modifiers (Ctrl=2, Meta=4 per CDP's bitmask) ----------------------------
const M = (type: string, x: VerdictSonde, y: VerdictSonde, extra?: Record<string, unknown>) => send("Input.dispatchMouseEvent", Object.assign({
  type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1,
  clickCount: 1, pointerType: "mouse",
}, extra || {}));
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function drag(from: VerdictSonde, to: VerdictSonde, opts?: { steps?: number; modifiers?: number }) {
  const steps = (opts && opts.steps) || 14, mods = (opts && opts.modifiers) || 0;
  // THE PRESS ITSELF CARRIES NO MODIFIER, DELIBERATELY: this helper exercises the case where the
  // modifier is grabbed MID-DRAG, once the gesture is already under way (the modifier is applied
  // only on the MOVE steps and the release). `dragCtrlDown`, below, exercises the OTHER case, the
  // modifier already held at `pointerdown`.
  await M("mouseMoved", from.x, from.y, { button: "none", buttons: 0 });
  await M("mousePressed", from.x, from.y);
  for (let i = 1; i <= steps; i++) {
    await M("mouseMoved", from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps, { modifiers: mods });
    await pause(7);
  }
  await M("mouseReleased", to.x, to.y, { buttons: 0, modifiers: mods });
  await pause(80);
}
// Ctrl/Cmd ALREADY HELD AT `pointerdown`, throughout the press, every move step, and the release:
// `gestes/meuble.ts` defers the toggle-vs-drag decision to the release (the stacked-pick pattern),
// so this must now arm and complete an ordinary drag, grid suppressed, instead of a no-op toggle.
async function dragCtrlDown(from: VerdictSonde, to: VerdictSonde, opts?: { steps?: number; modifiers?: number }) {
  const steps = (opts && opts.steps) || 14, mods = (opts && opts.modifiers) || 2;
  await M("mouseMoved", from.x, from.y, { button: "none", buttons: 0, modifiers: mods });
  await M("mousePressed", from.x, from.y, { modifiers: mods });
  for (let i = 1; i <= steps; i++) {
    await M("mouseMoved", from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps, { modifiers: mods });
    await pause(7);
  }
  await M("mouseReleased", to.x, to.y, { buttons: 0, modifiers: mods });
  await pause(80);
}
// Ctrl/Cmd held for a PLAIN CLICK: press then release at the exact same point, no movement at all.
async function clicCtrl(p: VerdictSonde, opts?: { modifiers?: number }) {
  const mods = (opts && opts.modifiers) || 2;
  await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0, modifiers: mods });
  await M("mousePressed", p.x, p.y, { modifiers: mods });
  await pause(20);
  await M("mouseReleased", p.x, p.y, { buttons: 0, modifiers: mods });
  await pause(80);
}
async function hover(p: VerdictSonde) {
  await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 });
  await pause(60);
}
// Held-key dispatch: keyDown WITHOUT the matching keyUp, so the caller decides when to release
// (unlike gestes-precision.ts's `key()`, which presses AND releases in one call).
function kd(name: string, mods?: number) {
  return send("Input.dispatchKeyEvent", {
    type: "rawKeyDown", key: name, code: "Key" + name.toUpperCase(),
    windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0), modifiers: mods || 0,
  });
}
function ku(name: string, mods?: number) {
  return send("Input.dispatchKeyEvent", {
    type: "keyUp", key: name, code: "Key" + name.toUpperCase(),
    windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0), modifiers: mods || 0,
  });
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

const aptPoint = (x: VerdictSonde, y: VerdictSonde) => J(`(function(){var s=__plan.aptToScreen(${x},${y});
  var r=document.getElementById("viewport").getBoundingClientRect();
  return {x:r.left+s.x, y:r.top+s.y};})()`);
const parNom = (nom: VerdictSonde) => J(`(function(){var p=__plan.plan.pieces.filter(function(q){return q.name===${JSON.stringify(nom)};})[0];
  return p?{id:String(p.id),x:p.x,y:p.y,w:p.w,h:p.h,rot:p.rot||0}:null;})()`);
const posDe = (id: string) => J(`(function(){var p=__plan.pieceById(${JSON.stringify(id)});
  return p?{x:p.x,y:p.y,w:p.w,h:p.h,rot:p.rot||0}:null;})()`);
const empreinte = () => evaluate(`(function(){var P=__plan.plan; return JSON.stringify({
  o:P.outline, w:P.walls.map(function(w){return [String(w.id),w.a,w.b];}),
  c:(P.cells||[]).length, g:(P.openings||[]).map(function(o){return [String(o.id),String(o.wallId),o.t0,o.w];}),
  p:P.pieces.map(function(p){return [String(p.id),p.x,p.y,p.w,p.h,p.rot||0];})});})()`);
const nGuides = () => evaluate(`document.querySelectorAll(".guides").length`);
const nUndo = () => evaluate(`String(__plan.histInfo().undo)`);
const stockage = () => evaluate(`localStorage.getItem("room-planner-v4")||""`);

// =============================================================================
//  1. ctrl_glisse_meuble_au_centimetre
// =============================================================================
// Request: hold Ctrl (or Cmd on a Mac) during a drag, and the 5 cm grid steps down to the whole
// centimeter. The negative control (same distance, no modifier) proves the grid was really ON,
// and that it is really the MODIFIER, not the distance, that made the difference.
await test("ctrl_glisse_meuble_au_centimetre", async () => {
  await evaluate(`__plan.state.opts.snap = true; __plan.render(); true`);
  await evaluate(`__plan.clearSel(); __plan.render(); true`);
  const p = await parNom("Homu");
  ok(!!p, "le plan de référence doit porter « Homu »");
  if (!p) return;
  const scale = await evaluate("__plan.vScale");
  const A = await aptPoint(p.x + p.w / 2, p.y + p.h / 2);

  // Negative control FIRST, on the untouched piece: 7 cm asked, no modifier, must land on 5.
  const B0 = { x: A.x + 7 * scale, y: A.y };
  await drag(A, B0);
  const apresLibre = await posDe(p.id);
  ok(apresLibre.x - p.x === 5, `témoin (sans Ctrl) : 7 cm demandés doivent tomber sur 5, vu un delta de ${apresLibre.x - p.x}`);

  // Same request, Ctrl held THROUGHOUT the drag (CDP modifiers bitmask, Ctrl=2): whole centimeter.
  const A2 = await aptPoint(apresLibre.x + apresLibre.w / 2, apresLibre.y + apresLibre.h / 2);
  const B1 = { x: A2.x + 7 * scale, y: A2.y };
  await drag(A2, B1, { modifiers: 2 });
  const apresCtrl = await posDe(p.id);
  const delta = apresCtrl.x - apresLibre.x;
  ok(delta === 7, `Ctrl tenu : 7 cm demandés doivent tomber EXACTEMENT sur 7, vu un delta de ${delta}`);
  ok(delta !== 5 && delta !== 10, `le résultat ne doit pas retomber sur un multiple de 5 (vu ${delta})`);
});

// =============================================================================
//  2. d_tenu_montre_les_cotes_du_choisi
// =============================================================================
// Request: hold D to SEE the live dimensions without moving anything. Nothing selected: the
// object under the pointer. Ephemeral DOM only — no history entry, no local write.
await test("d_tenu_montre_les_cotes_du_choisi", async () => {
  await evaluate(`__plan.clearSel(); __plan.render(); true`);
  const p = await parNom("Homu");
  ok(!!p, "le plan de référence doit porter « Homu »");
  if (!p) return;
  const S = await aptPoint(p.x + p.w / 2, p.y + p.h / 2);
  await hover(S);

  const avantEmpreinte = await empreinte();
  const avantStockage = await stockage();
  const avantUndo = await nUndo();
  ok((await nGuides()) === 0, "précondition : aucune cote affichée avant d'appuyer sur D");

  await kd("d");
  await pause(150);
  ok((await nGuides()) > 0, "D tenu doit afficher les cotes de l'objet sous le curseur");
  ok(await evaluate(`String(__plan.selId)`) === "null", "D ne doit PAS sélectionner l'objet");
  ok((await empreinte()) === avantEmpreinte, "D tenu ne doit RIEN écrire dans le plan");
  ok((await stockage()) === avantStockage, "D tenu ne doit RIEN enregistrer localement");
  ok((await nUndo()) === avantUndo, "D tenu ne doit pousser aucune entrée d'annulation");

  await ku("d");
  await pause(150);
  ok((await nGuides()) === 0, "relâcher D doit effacer les cotes");
});

// =============================================================================
//  3. d_tenu_privilegie_la_selection
// =============================================================================
// A selection wins over the pointer: hovering OPEN FLOOR (nothing there to hit-test) still shows
// guides, because the selected piece is what's shown, not whatever sits under the cursor.
await test("d_tenu_privilegie_la_selection", async () => {
  const p = await parNom("Homu");
  ok(!!p, "le plan de référence doit porter « Homu »");
  if (!p) return;
  await evaluate(`__plan.selReplace(${JSON.stringify(p.id)}); __plan.render(); true`);
  await pause(120);
  // A point just inside the viewport's own corner: "Fit" leaves a padded margin around the
  // plan, so this is blank canvas, well outside the outline, with nothing for a pointer
  // hit-test to find.
  const dehors = await J(`(function(){var r=document.getElementById("viewport").getBoundingClientRect();
    return {x:r.left+8, y:r.top+8};})()`);
  await hover(dehors);

  await kd("d");
  await pause(150);
  ok((await nGuides()) > 0, "la sélection doit l'emporter même si le curseur est hors du plan");
  await ku("d");
  await pause(120);
});

// =============================================================================
//  4. ctrl_presse_avant_glisse_deplace_sans_toggle
// =============================================================================
// Request: hold Ctrl (or Cmd) THEN press and drag, the natural order. Before this fix, holding
// the modifier at `pointerdown` toggled the selection and armed no drag at all; a user who did
// this got nothing but a selection flip and a piece that never moved. `gestes/meuble.ts` now
// defers the decision to the release: a real drag moves the piece (grid suppressed) and the
// selection is left exactly as it was, the toggle never fires.
await test("ctrl_presse_avant_glisse_deplace_sans_toggle", async () => {
  await evaluate(`__plan.state.opts.snap = true; __plan.render(); true`);
  await evaluate(`__plan.clearSel(); __plan.render(); true`);
  const p = await parNom("Homu");
  ok(!!p, "le plan de référence doit porter « Homu »");
  if (!p) return;
  const scale = await evaluate("__plan.vScale");

  // Select it first with an ORDINARY (unmodified) drag: this is what proves the toggle never
  // fires below (a toggle would flip Homu back OUT of a selection it already belongs to).
  const A0 = await aptPoint(p.x + p.w / 2, p.y + p.h / 2);
  await drag(A0, { x: A0.x + 3 * scale, y: A0.y });
  const apresPlain = await posDe(p.id);
  const selAvant = await J(`__plan.selDump().modele`);
  ok(JSON.stringify(selAvant) === JSON.stringify([String(p.id)]),
    `précondition : Homu doit être seul sélectionné après le glissé témoin, vu ${JSON.stringify(selAvant)}`);

  // Ctrl/Cmd HELD BEFORE THE PRESS (unlike test 1's "grabbed mid-drag"): must still arm and
  // complete an ordinary drag, whole-centimeter, not a toggle.
  const A = await aptPoint(apresPlain.x + apresPlain.w / 2, apresPlain.y + apresPlain.h / 2);
  const B = { x: A.x + 7 * scale, y: A.y };
  await dragCtrlDown(A, B);
  const apres = await posDe(p.id);
  const delta = apres.x - apresPlain.x;
  ok(delta === 7, `Ctrl tenu AVANT le clic : 7 cm demandés doivent tomber EXACTEMENT sur 7, vu un delta de ${delta}`);
  ok(delta !== 5 && delta !== 10, `le résultat ne doit pas retomber sur un multiple de 5 (vu ${delta})`);

  const selApres = await J(`__plan.selDump().modele`);
  ok(JSON.stringify(selApres) === JSON.stringify(selAvant),
    `la sélection ne doit pas être touchée par le glissé (pas de toggle) : avant ${JSON.stringify(selAvant)}, après ${JSON.stringify(selApres)}`);
});

// =============================================================================
//  5. ctrl_clic_sans_glisser_bascule_la_selection
// =============================================================================
// Request's negative control: Ctrl/Cmd press-then-release with NO movement at all must keep
// doing exactly what it did before this fix — TOGGLE the selection, move nothing, write nothing.
await test("ctrl_clic_sans_glisser_bascule_la_selection", async () => {
  await evaluate(`__plan.clearSel(); __plan.render(); true`);
  const p = await parNom("Homu");
  ok(!!p, "le plan de référence doit porter « Homu »");
  if (!p) return;
  const S = await aptPoint(p.x + p.w / 2, p.y + p.h / 2);

  const avantEmpreinte = await empreinte();
  const avantStockage = await stockage();
  const avantUndo = await nUndo();
  ok(!(await evaluate(`__plan.isSel(${JSON.stringify(String(p.id))})`)), "précondition : Homu non sélectionné");

  await clicCtrl(S);

  ok(await evaluate(`__plan.isSel(${JSON.stringify(String(p.id))})`),
    "Ctrl+clic sans glissé doit SÉLECTIONNER (toggle) la pièce");
  const apres = await posDe(p.id);
  ok(apres.x === p.x && apres.y === p.y, "Ctrl+clic sans glissé ne doit RIEN déplacer");
  ok((await empreinte()) === avantEmpreinte, "Ctrl+clic sans glissé ne doit RIEN écrire dans le plan");
  ok((await stockage()) === avantStockage, "Ctrl+clic sans glissé ne doit RIEN changer au contenu enregistré");
  ok((await nUndo()) === avantUndo, "Ctrl+clic sans glissé ne doit pousser aucune entrée d'annulation");
});

// =============================================================================
//  6. ctrl_clic_deux_fois_desactive_la_selection
// =============================================================================
// The same Ctrl+click, twice in a row on the same piece: the second one toggles it back OUT.
await test("ctrl_clic_deux_fois_desactive_la_selection", async () => {
  await evaluate(`__plan.clearSel(); __plan.render(); true`);
  const p = await parNom("Homu");
  ok(!!p, "le plan de référence doit porter « Homu »");
  if (!p) return;
  const S = await aptPoint(p.x + p.w / 2, p.y + p.h / 2);

  await clicCtrl(S);
  ok(await evaluate(`__plan.isSel(${JSON.stringify(String(p.id))})`), "premier Ctrl+clic doit sélectionner");

  await clicCtrl(S);
  ok(!(await evaluate(`__plan.isSel(${JSON.stringify(String(p.id))})`)),
    "second Ctrl+clic sur la même pièce doit la DÉSÉLECTIONNER");
  ok((await evaluate(`String(__plan.selId)`)) === "null", "plus rien ne doit rester sélectionné (pièce unique)");
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
