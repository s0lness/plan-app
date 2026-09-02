#!/usr/bin/env node
// =============================================================================
//  "DOUBLE-CLICK ON THE LABEL = RENAME" SUITE: REAL MOUSE (CDP)
// =============================================================================
// Usage request: "I want to change the name of a piece of furniture or a room by
// double-clicking on the label (except when the name is empty)".
//
// The gesture was ALREADY TAKEN: double-clicking on a piece of furniture rotates it by 90 degrees,
// and on a door it flips the leaf. The request doesn't say "double-click on the object", it says
// "on the label": those are two different TARGETS, so the two gestures can coexist. That is what
// this suite locks down, both ways.
//
// The "except when the name is empty" is NOT a condition written in the code, and that is
// deliberate: the label is only painted if a name has been CHOSEN (R-3, `isChosenName`). An
// object that still carries its catalog label has no label at all, so there is nothing to
// double-click. The `sans_nom_choisi_il_n_y_a_pas_d_etiquette` case measures exactly that: if one
// day the label starts showing for everyone, this test falls BEFORE the gesture starts
// renaming objects that were never named.
//
//   node tests/etiquette-renommer.ts [path/to/app.html]
//
//   double_clic_etiquette_ouvre_le_champ_de_nom      focus in #iName, text SELECTED
//   double_clic_etiquette_ne_fait_pas_pivoter        the angle doesn't move (that's the other gesture)
//   double_clic_sur_le_corps_pivote_toujours         control: the old gesture survives intact
//   sans_nom_choisi_il_n_y_a_pas_d_etiquette         nothing to target while the name comes from the catalog
//   double_clic_nom_de_piece_ouvre_son_champ         same gesture on a cell -> #rcName
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
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "plan-reel-77.json"), "utf8"));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-renom-"));
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
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
await send("Page.enable");
await send("Runtime.enable");

const M = (type: string, x: VerdictSonde, y: VerdictSonde, extra?: Record<string, unknown>) => send("Input.dispatchMouseEvent", Object.assign({
  type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1,
  clickCount: 1, pointerType: "mouse",
}, extra || {}));

/**
 * A REAL DOUBLE-CLICK, NOT A `dispatchEvent("dblclick")`. Chrome only synthesizes the
 * `dblclick` event on the SECOND press/release pair carrying `clickCount:2`: sending two clicks at
 * `clickCount:1` produces NOTHING, and the test would pass green while measuring no gesture at all.
 */
async function dbl(x: VerdictSonde, y: VerdictSonde) {
  await M("mousePressed", x, y, { clickCount: 1 });
  await M("mouseReleased", x, y, { clickCount: 1 });
  await pause(30);
  await M("mousePressed", x, y, { clickCount: 2 });
  await M("mouseReleased", x, y, { clickCount: 2 });
  await pause(160);
}

async function reload() {
  await send("Page.navigate", { url: "file:///" + htmlPath.replace(/\\/g, "/") });
  for (let i = 0; i < 200; i++) {
    let st = null;
    try { st = await evaluate("document.readyState + '|' + (window.__plan ? 1 : 0)"); } catch (_) {}
    if (st === "complete|1") break;
    await pause(50);
  }
  await pause(350);
  await evaluate("__plan.fitView(); true");
  await pause(180);
}

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

/** Places a piece of furniture AT THE CENTER OF THE VIEW and gives it a TYPED name (so a label gets painted). */
const NOM = "Canape du salon";
async function poserNomme(type: string) {
  return J(`(function(){
    var c = __plan.viewCenterApt();
    var p = __plan.addV5Piece(${JSON.stringify(type)}, c.x, c.y);
    p.name = ${JSON.stringify(NOM)};
    __plan.render();
    return { id: String(p.id), rot: p.rot || 0 };
  })()`);
}
/** Screen box of a piece of furniture's label, or null if it isn't painted. */
const boiteEtiquette = (id: string) => J(`(function(){
  var el = document.querySelector('.piece[data-id="' + __plan.cssId(${JSON.stringify(id)}) + '"] .plabel');
  if (!el) return null;
  var cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return null;
  var r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
})()`);
const focusDump = () => J(`(function(){
  var a = document.activeElement || {};
  var r = a.getBoundingClientRect ? a.getBoundingClientRect() : null;
  return {
    id: a.id || "",
    cls: String(a.className || ""),
    val: typeof a.value === "string" ? a.value : null,
    s0: typeof a.selectionStart === "number" ? a.selectionStart : -1,
    s1: typeof a.selectionEnd === "number" ? a.selectionEnd : -1,
    cx: r ? r.left + r.width / 2 : null,
    cy: r ? r.top + r.height / 2 : null,
    dansViewport: !!(a.closest && a.closest("#viewport"))
  };
})()`);
const rotDe = (id: string) => J(`(function(){
  var p = (__plan.plan.pieces || []).filter(function(q){ return String(q.id) === ${JSON.stringify(id)}; })[0];
  return p ? (p.rot || 0) : null;
})()`);

// ---------------------------------------------------------------------------------------------
await test("double_clic_etiquette_ouvre_le_champ_de_nom", async () => {
  const p = await poserNomme("sofa3");
  const b = await boiteEtiquette(p.id);
  if (!ok(b, "l'étiquette du meuble nommé n'est pas peinte : rien à double-cliquer")) return;
  await dbl(b.x, b.y);
  const f = await focusDump();
  // THE FIELD IS ON THE LABEL, not in the panel: that's the whole request.
  ok(/label-edit/.test(f.cls), `le champ doit être le champ EN LIGNE, vu ${JSON.stringify(f.cls)}`);
  ok(f.dansViewport, "et il doit vivre dans le viewport (sinon un rendu le détruirait sous les doigts)");
  ok(f.val === NOM, `le champ doit porter le nom courant, vu ${JSON.stringify(f.val)}`);
  // SELECTED, not just focused: otherwise typing ADDS to the name instead of replacing it, and
  // renaming "Canape du salon" would require erasing 16 characters by hand.
  ok(f.s0 === 0 && f.s1 === NOM.length,
    `le texte doit être sélectionné en entier, vu ${f.s0}..${f.s1} sur ${NOM.length}`);
  // LANDS ON THE LABEL, not just anywhere: within 30px of the double-clicked spot.
  ok(f.cx !== null && Math.hypot(f.cx - b.x, f.cy - b.y) < 30,
    `le champ doit se poser SUR l'étiquette (${b.x.toFixed(0)},${b.y.toFixed(0)}), vu (${f.cx},${f.cy})`);
});

await test("double_clic_etiquette_ne_fait_pas_pivoter", async () => {
  const p = await poserNomme("sofa3");
  const b = await boiteEtiquette(p.id);
  if (!ok(b, "étiquette absente")) return;
  const avant = await rotDe(p.id);
  await dbl(b.x, b.y);
  const apres = await rotDe(p.id);
  ok(apres === avant, `l'angle ne doit pas bouger (renommer n'est pas pivoter), ${avant}° -> ${apres}°`);
});

await test("double_clic_sur_le_corps_pivote_toujours", async () => {
  // CONTROL. The new gesture must not have eaten the old one: on the BODY of the object, away
  // from its label, double-click still rotates it by 90 degrees.
  const p = await poserNomme("sofa3");
  const b = await J(`(function(){
    var el = document.querySelector('.piece[data-id="' + __plan.cssId(${JSON.stringify(p.id)}) + '"]');
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width * 0.12, y: r.top + r.height * 0.5 };
  })()`);
  const avant = await rotDe(p.id);
  await dbl(b.x, b.y);
  const apres = await rotDe(p.id);
  ok(((apres - avant) % 360 + 360) % 360 === 90, `le corps doit pivoter de 90°, ${avant}° -> ${apres}°`);
});

await test("sans_nom_choisi_il_n_y_a_pas_d_etiquette", async () => {
  // A piece of furniture that still carries its type's label writes NOTHING onto the plan (R-3),
  // so the gesture's target doesn't exist. This is where the "except when the name is empty" lives.
  const p = await J(`(function(){
    var c = __plan.viewCenterApt();
    var q = __plan.addV5Piece("sofa3", c.x, c.y);
    __plan.render();
    return { id: String(q.id), name: q.name };
  })()`);
  ok(p.name === (await J(`__plan.TYPEMAP["sofa3"].name`)),
    `le meuble neuf doit porter le libellé du catalogue, vu ${JSON.stringify(p.name)}`);
  const b = await boiteEtiquette(p.id);
  ok(b === null, "un nom venu du catalogue ne doit peindre AUCUNE étiquette");
});

await test("double_clic_nom_de_piece_ouvre_son_champ", async () => {
  // WE DO NOT TAKE "THE FIRST CELL". Measured: the name of cell 0 of the real plan is
  // COVERED by a piece of furniture, so the double-click there hits the furniture and not the
  // name, which is the correct behavior, and a test that ignores it measures something other than
  // what it claims to. We look for the first room name that is actually ON TOP of the stack at its
  // center.
  const c = await J(`(function(){
    var cells = __plan.plan.cells || [];
    for (var i = 0; i < cells.length; i++) {
      var el = document.querySelector('.ov-name[data-c="' + __plan.cssId(String(cells[i].id)) + '"]');
      if (!el) continue;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      var x = r.left + r.width / 2, y = r.top + r.height / 2;
      var top = document.elementFromPoint(x, y);
      if (top && top.closest && top.closest('.ov-name[data-c]') === el) {
        return { x: x, y: y, name: cells[i].name };
      }
    }
    return null;
  })()`);
  if (!ok(c, "aucune étiquette de cellule peinte")) return;
  await dbl(c.x, c.y);
  const f = await focusDump();
  ok(/label-edit/.test(f.cls), `le champ doit être le champ EN LIGNE, vu ${JSON.stringify(f.cls)}`);
  ok(f.val === c.name, `le champ doit porter le nom de la pièce, vu ${JSON.stringify(f.val)}`);
  ok(f.s0 === 0 && f.s1 === String(c.name).length,
    `le nom de la pièce doit être sélectionné en entier, vu ${f.s0}..${f.s1}`);
  ok(f.cx !== null && Math.hypot(f.cx - c.x, f.cy - c.y) < 30,
    `le champ doit se poser SUR le nom de la pièce, vu (${f.cx},${f.cy})`);
});

await test("taper_puis_entree_renomme_vraiment", async () => {
  // The field is useless if it doesn't write: we type a name and check the MODEL, not the screen.
  const p = await poserNomme("sofa3");
  const b = await boiteEtiquette(p.id);
  if (!ok(b, "étiquette absente")) return;
  await dbl(b.x, b.y);
  if (!ok(/label-edit/.test((await focusDump()).cls), "champ en ligne attendu")) return;
  for (const ch of "Lit rouge") {
    await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
    await send("Input.dispatchKeyEvent", { type: "keyUp" });
  }
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await pause(220);
  const nom = await J(`(function(){
    var q = (__plan.plan.pieces || []).filter(function(z){ return String(z.id) === ${JSON.stringify(p.id)}; })[0];
    return q ? q.name : null;
  })()`);
  ok(nom === "Lit rouge", `le modèle doit porter le nom tapé, vu ${JSON.stringify(nom)}`);
  const reste = await J(`document.querySelectorAll(".label-edit").length`);
  ok(reste === 0, `le champ doit se refermer après Entrée, vu ${reste} encore ouvert(s)`);
});

// ---------------------------------------------------------------------------------------------
const rates = results.filter(r => r.fails.length);
console.log(`\n${rates.length ? `FAILURES ${rates.length}/${results.length}` : `OK ${results.length}/${results.length}`}`);
rates.forEach(r => console.log("  FAIL " + r.name));
try { ws.close(); } catch (_) {}
try { chrome.kill(); } catch (_) {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
process.exit(rates.length ? 1 : 0);
