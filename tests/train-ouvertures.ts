#!/usr/bin/env node
// =============================================================================
//  "SEVERAL OPENINGS ON THE SAME WALL MOVE AS A TRAIN" SUITE — REAL MOUSE (CDP)
// =============================================================================
// Usage report: "selecting and moving several windows on the same wall does not move them
// as a train, it messes them up".
//
// THE ROOT WAS NOT IN THE MOVE, IT WAS IN THE SELECTION. `v5StartOpeningDrag`
// called `selReplace(ctx, op.id)` UNCONDITIONALLY: grabbing an already-selected opening
// shrank the selection to itself alone. The other windows therefore did not move, then the
// same-family overlap rule PUSHED them as the dragged one passed by. They
// moved, but pushed, not moved along: hence the disorder, not "nothing moves".
// Furniture already had its guard (`groupDrag`, gestes/meuble.ts). Openings never had it.
//
// WHAT "AS A TRAIN" MEANS HERE, and it is a decision, not an obvious fact: a SHARED shift
// along the wall, bounded by the MOST constrained car. A train that hits a stop stops WHOLE. Letting
// the first window snap to the stop while the others keep going would crush the gaps,
// that is, exactly the disorder being fixed. It's furniture rule G-13, applied
// to the group instead of the individual.
//
//   node tests/train-ouvertures.ts [path/to/app.html]
//
//   trois_fenetres_gardent_leurs_ecarts      the gaps are EXACTLY those from the start
//   le_train_qui_bute_s_arrete_entier        the stop crushes no gap
//   aller_retour_du_train_est_exact          coming back restores the starting t0, to the cm
//   echap_rend_le_train_entier               G-12 on every car, not just the head
//   une_seule_ouverture_garde_son_geste      CONTROL: the plain drag has not changed
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-train-"));
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
const ECHAP = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 };

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

/**
 * The wall carrying the MOST openings of the same family, and three of them. We do not hardcode
 * a wall identifier: the reference plan can evolve, the SCENARIO must not.
 */
const troisSurUnMur = () => J(`(function(){
  var P = __plan.plan, par = {};
  (P.openings || []).forEach(function(o){ (par[o.wallId] = par[o.wallId] || []).push(o); });
  var best = null;
  Object.keys(par).forEach(function(k){
    var l = par[k].filter(function(o){ return o.type === "window" || o.type === "door" || o.type === "sdoor"; });
    if (l.length >= 3 && (!best || l.length > best.length)) best = l;
  });
  if (!best) return null;
  best.sort(function(a,b){ return a.t0 - b.t0; });
  var trois = best.slice(0, 3);
  var w = (P.walls || []).filter(function(q){ return String(q.id) === String(trois[0].wallId); })[0];
  return {
    wallId: String(trois[0].wallId),
    len: Math.hypot(w.b[0]-w.a[0], w.b[1]-w.a[1]),
    ids: trois.map(function(o){ return String(o.id); }),
    t0: trois.map(function(o){ return o.t0; }),
    w: trois.map(function(o){ return o.w; })
  };
})()`);

const lireT0 = (ids: string[]) => J(`(function(){
  var P = __plan.plan, ids = ${JSON.stringify(ids)};
  return ids.map(function(id){
    var o = (P.openings || []).filter(function(q){ return String(q.id) === id; })[0];
    return o ? o.t0 : null;
  });
})()`);

const selectionner = (ids: string[]) => evaluate(`(function(){
  __plan.clearSel();
  var ids = ${JSON.stringify(ids)};
  ids.forEach(function(id){ __plan.selAdd(id); });
  __plan.render();
  return __plan.selCount;
})()`);

/** Screen point of the CENTER of an opening (it's painted as `.piece[data-op="1"]`). */
const centreEcran = (id: string) => J(`(function(){
  var el = document.querySelector('.piece[data-op="1"][data-id="' + __plan.cssId(${JSON.stringify(id)}) + '"]');
  if (!el) return null;
  var r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);

/**
 * THE TRAIN'S REAL MARGIN, in both directions. The reference plan is a REAL plan: the three
 * openings on the same wall can very well be wedged between two unselected neighbors.
 * A test that blindly pushes "25 cm" would then measure the stop, not the train, and it would be right
 * to go red. So we compute how much the train CAN move before asking it to.
 */
const margeTrain = (ids: string[], wallId: string) => J(`(function(){
  var P = __plan.plan, ids = ${JSON.stringify(ids)}, wid = ${JSON.stringify(wallId)};
  var w = (P.walls || []).filter(function(q){ return String(q.id) === wid; })[0];
  var L = Math.hypot(w.b[0]-w.a[0], w.b[1]-w.a[1]);
  var sel = ids.map(function(id){
    return (P.openings || []).filter(function(q){ return String(q.id) === id; })[0];
  });
  var autres = (P.openings || []).filter(function(q){
    return String(q.wallId) === wid && ids.indexOf(String(q.id)) < 0;
  });
  var plus = Infinity, moins = Infinity;
  sel.forEach(function(m){
    plus = Math.min(plus, L - (m.t0 + m.w));
    moins = Math.min(moins, m.t0);
    autres.forEach(function(q){
      if (q.t0 + q.w <= m.t0 + 0.01) moins = Math.min(moins, m.t0 - (q.t0 + q.w));
      else if (q.t0 >= m.t0 + m.w - 0.01) plus = Math.min(plus, q.t0 - (m.t0 + m.w));
    });
  });
  return { plus: Math.max(0, plus), moins: Math.max(0, moins) };
})()`);

/** Unit vector of the wall, in screen PIXELS (to push the train along its wall). */
const axeEcran = (wallId: string) => J(`(function(){
  var w = (__plan.plan.walls || []).filter(function(q){ return String(q.id) === ${JSON.stringify(wallId)}; })[0];
  if (!w) return null;
  var a = __plan.aptToScreen(w.a[0], w.a[1]), b = __plan.aptToScreen(w.b[0], w.b[1]);
  var dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
  return { ux: dx / L, uy: dy / L, pxParCm: L / Math.hypot(w.b[0]-w.a[0], w.b[1]-w.a[1]) };
})()`);

async function glisser(from: VerdictSonde, dxPx: number, dyPx: number, pas = 14) {
  await M("mousePressed", from.x, from.y, { clickCount: 1 });
  await pause(40);
  for (let k = 1; k <= pas; k++) {
    await M("mouseMoved", from.x + dxPx * k / pas, from.y + dyPx * k / pas);
    await pause(12);
  }
  return { x: from.x + dxPx, y: from.y + dyPx };
}
const relacher = (p: VerdictSonde) => M("mouseReleased", p.x, p.y, { clickCount: 1 }).then(() => pause(180));

const ecarts = (t: VerdictSonde) => t.slice(1).map((v: VerdictSonde, i: number) => +(v - t[i]).toFixed(2));

// ---------------------------------------------------------------------------------------------
await test("trois_fenetres_gardent_leurs_ecarts", async () => {
  const g = await troisSurUnMur();
  if (!ok(g, "le plan de référence doit porter trois ouvertures sur un même mur")) return;
  await selectionner(g.ids);
  const avant = await lireT0(g.ids);
  const ax = await axeEcran(g.wallId);
  const c = await centreEcran(g.ids[1]);                 // we take the MIDDLE one
  if (!ok(c && ax, "l'ouverture du milieu doit être peinte")) return;
  const marge = await margeTrain(g.ids, g.wallId);
  const sens = marge.plus >= marge.moins ? 1 : -1;
  const place = Math.max(marge.plus, marge.moins);
  if (!ok(place > 8, `le train doit avoir de la place quelque part, vu ${JSON.stringify(marge)}`)) return;
  const dCm = Math.min(25, place - 2), dpx = sens * dCm * ax.pxParCm;
  const fin = await glisser(c, ax.ux * dpx, ax.uy * dpx);
  await relacher(fin);
  const apres = await lireT0(g.ids);
  ok(apres.every((v: VerdictSonde) => v !== null), "les trois doivent toujours exister");
  const ea = ecarts(avant), eb = ecarts(apres);
  ok(JSON.stringify(ea) === JSON.stringify(eb),
    `les écarts doivent être IDENTIQUES, ${JSON.stringify(ea)} -> ${JSON.stringify(eb)}`);
  const bouge = apres.map((v: VerdictSonde, i: number) => +(v - avant[i]).toFixed(1));
  ok(bouge.every((v: VerdictSonde) => Math.abs(v - bouge[0]) < 1.5),
    `les trois doivent bouger du MÊME décalage, vu ${JSON.stringify(bouge)}`);
  ok(Math.abs(bouge[0]) > 5, `et le train doit vraiment avoir avancé (marge ${JSON.stringify(marge)}, demandé ${dCm} cm), vu ${bouge[0]} cm`);
});

await test("le_train_qui_bute_s_arrete_entier", async () => {
  const g = await troisSurUnMur();
  if (!ok(g, "fixture")) return;
  await selectionner(g.ids);
  const avant = await lireT0(g.ids);
  const ax = await axeEcran(g.wallId);
  const c = await centreEcran(g.ids[1]);
  if (!ok(c && ax, "peinte")) return;
  // We push WELL past the end of the wall: the stop is guaranteed.
  const dpx = g.len * 2 * ax.pxParCm;
  const fin = await glisser(c, ax.ux * dpx, ax.uy * dpx, 20);
  await relacher(fin);
  const apres = await lireT0(g.ids);
  const ea = ecarts(avant), eb = ecarts(apres);
  ok(JSON.stringify(ea) === JSON.stringify(eb),
    `à la butée les écarts doivent tenir, ${JSON.stringify(ea)} -> ${JSON.stringify(eb)}`);
  ok(apres.every((v: VerdictSonde, i: number) => v + g.w[i] <= g.len + 0.5 && v >= -0.5),
    `et personne ne sort du mur (len=${Math.round(g.len)}), vu ${JSON.stringify(apres)}`);
});

await test("aller_retour_du_train_est_exact", async () => {
  const g = await troisSurUnMur();
  if (!ok(g, "fixture")) return;
  await selectionner(g.ids);
  const avant = await lireT0(g.ids);
  const ax = await axeEcran(g.wallId);
  const c = await centreEcran(g.ids[1]);
  if (!ok(c && ax, "peinte")) return;
  const marge = await margeTrain(g.ids, g.wallId);
  const sens = marge.plus >= marge.moins ? 1 : -1;
  const place = Math.max(marge.plus, marge.moins);
  if (!ok(place > 8, `place nécessaire, vu ${JSON.stringify(marge)}`)) return;
  const dpx = sens * Math.min(20, place - 2) * ax.pxParCm;
  let fin = await glisser(c, ax.ux * dpx, ax.uy * dpx);
  await relacher(fin);
  // WITHOUT THIS LINE THE CASE PASSES FOR NOTHING: if the cars never move, "they return to
  // their spot" is true by construction. So we require that the THERE trip really moved all three.
  const aller = await lireT0(g.ids);
  ok(aller.every((v: VerdictSonde, i: number) => Math.abs(v - avant[i]) > 3),
    `l'aller doit déplacer LES TROIS, ${JSON.stringify(avant)} -> ${JSON.stringify(aller)}`);
  const c2 = await centreEcran(g.ids[1]);
  fin = await glisser(c2, -ax.ux * dpx, -ax.uy * dpx);
  await relacher(fin);
  const apres = await lireT0(g.ids);
  const ecart = apres.map((v: VerdictSonde, i: number) => Math.abs(v - avant[i]));
  ok(ecart.every((v: VerdictSonde) => v <= 1),
    `l'aller-retour doit rendre les t0 du départ (±1 cm), ${JSON.stringify(avant)} -> ${JSON.stringify(apres)}`);
});

await test("echap_rend_le_train_entier", async () => {
  const g = await troisSurUnMur();
  if (!ok(g, "fixture")) return;
  await selectionner(g.ids);
  const avant = await lireT0(g.ids);
  const ax = await axeEcran(g.wallId);
  const c = await centreEcran(g.ids[1]);
  if (!ok(c && ax, "peinte")) return;
  const marge = await margeTrain(g.ids, g.wallId);
  const sens = marge.plus >= marge.moins ? 1 : -1;
  const dpx = sens * Math.min(30, Math.max(marge.plus, marge.moins)) * ax.pxParCm;
  const fin = await glisser(c, ax.ux * dpx, ax.uy * dpx);
  // SAME TRAP as the round trip: if the cars never moved, Escape has nothing to restore and
  // the case would pass without measuring anything. We confirm the move BEFORE canceling.
  const pendant = await lireT0(g.ids);
  ok(pendant.every((v: VerdictSonde, i: number) => Math.abs(v - avant[i]) > 3),
    `le train doit avoir bougé avant Échap, ${JSON.stringify(avant)} -> ${JSON.stringify(pendant)}`);
  // Escape DURING the gesture: the whole train must come back, not just the head.
  await send("Input.dispatchKeyEvent", Object.assign({ type: "rawKeyDown" }, ECHAP));
  await send("Input.dispatchKeyEvent", Object.assign({ type: "keyUp" }, ECHAP));
  await pause(160);
  await relacher(fin);
  const apres = await lireT0(g.ids);
  ok(JSON.stringify(avant) === JSON.stringify(apres),
    `Échap doit tout rendre, ${JSON.stringify(avant)} -> ${JSON.stringify(apres)}`);
});

await test("une_seule_ouverture_garde_son_geste", async () => {
  // CONTROL. The train must not have eaten the plain drag: a single selected
  // opening always moves, and it alone.
  const g = await troisSurUnMur();
  if (!ok(g, "fixture")) return;
  await evaluate(`__plan.selReplace(${JSON.stringify(g.ids[1])}); __plan.render(); true`);
  const avant = await lireT0(g.ids);
  const ax = await axeEcran(g.wallId);
  const c = await centreEcran(g.ids[1]);
  if (!ok(c && ax, "peinte")) return;
  const marge = await margeTrain([g.ids[1]], g.wallId);
  const sens = marge.plus >= marge.moins ? 1 : -1;
  const place = Math.max(marge.plus, marge.moins);
  if (!ok(place > 6, `place nécessaire, vu ${JSON.stringify(marge)}`)) return;
  const dpx = sens * Math.min(18, place - 2) * ax.pxParCm;
  const fin = await glisser(c, ax.ux * dpx, ax.uy * dpx);
  await relacher(fin);
  const apres = await lireT0(g.ids);
  ok(Math.abs(apres[1] - avant[1]) > 3, `celle qu'on tire doit bouger, ${avant[1]} -> ${apres[1]}`);
  ok(Math.abs(apres[0] - avant[0]) < 0.6 && Math.abs(apres[2] - avant[2]) < 0.6,
    `et les deux autres ne doivent PAS bouger, ${JSON.stringify(avant)} -> ${JSON.stringify(apres)}`);
});

// ---------------------------------------------------------------------------------------------
const rates = results.filter(r => r.fails.length);
console.log(`\n${rates.length ? `FAILURES ${rates.length}/${results.length}` : `OK ${results.length}/${results.length}`}`);
rates.forEach(r => console.log("  FAIL " + r.name));
try { ws.close(); } catch (_) {}
try { chrome.kill(); } catch (_) {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
process.exit(rates.length ? 1 : 0);
