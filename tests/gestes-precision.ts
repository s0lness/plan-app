#!/usr/bin/env node
// =============================================================================
//  SUITE "GESTURE PRECISION" — REAL MOUSE (CDP), REAL HIT-TESTING
// =============================================================================
// Seven defects found by a real-usage session of 1,500 gestures, on the user's plan then on an
// apartment filled up to 300 objects. They all share the same root: what the screen shows and
// what the click grabs had stopped matching, and a round trip did not come back.
//
//   node tests/gestes-precision.ts [path/to/app.html]
//
//   cible_sous_le_curseur_a_300      at 300 objects, what moves is UNDER the cursor on press
//   aller_retour_idempotent          30 cm out, 30 cm back, six times: zero drift, snap or not
//   clic_sur_sommet_n_ecrit_rien     a click on an outline vertex used to rewrite the plan
//   clic_sur_meuble_ne_le_bouge_pas  a click on furniture flush against a wall shifted it 11 cm
//   pile_de_cinq_entierement_cyclee  the click cycle only went down two notches
//   gros_meuble_sous_petit_atteint   the counter under the hob was unreachable
//   echap_qui_quitte_les_murs_le_dit 16 walls clicked with no effect, without a word: Escape had switched modes
//   poignee_rotation_ne_vole_pas_le_centre_meuble_mince
//                                     the FIXED-PIXEL rotation handle, on a thin piece zoomed out, covered
//                                     the piece's own center: a dead-center press rotated instead of moving
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
// The repository's own demo apartment (`exemple-appartement.json`), used ONLY by the
// group-drag case below: it isolates the exact wall geometry that defect needs (a furniture
// group hugging several different walls by different margins) without depending on the
// household plan's incidental layout, which is tuned for the OTHER cases in this file. It used
// to be a separate hand-built fixture (`tests/fixtures/appartement-synthetique.json`); once the
// demo apartment shipped with the same kitchen corner (same wall ids, same furniture positions),
// keeping both was redundant, so the dedicated fixture was retired in favor of this one.
const SEED_APT = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "exemple-appartement.json"), "utf8")).state;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-precision-"));
const htmlPath = path.join(dir, "case.html");
fs.writeFileSync(htmlPath,
  `<!doctype html><html><head><meta charset="utf-8"><script>
window.__PLAN_TEST__=1;
try{ localStorage.clear(); localStorage.setItem("room-planner-v4", ${JSON.stringify(JSON.stringify(SEED))}); }catch(e){}
<\/script></head><body>` + fs.readFileSync(APP, "utf8") + "</body></html>",
  "utf8");
const htmlPathApt = path.join(dir, "case-apt.html");
fs.writeFileSync(htmlPathApt,
  `<!doctype html><html><head><meta charset="utf-8"><script>
window.__PLAN_TEST__=1;
try{ localStorage.clear(); localStorage.setItem("room-planner-v4", ${JSON.stringify(JSON.stringify(SEED_APT))}); }catch(e){}
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
// SEED_APT variant, for the one case that needs the demo apartment above.
async function reloadApt() { await navigateTo(htmlPathApt); }

// ---- REAL mouse ------------------------------------------------------------------------------
const M = (type: string, x: VerdictSonde, y: VerdictSonde, extra?: Record<string, unknown>) => send("Input.dispatchMouseEvent", Object.assign({
  type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1,
  clickCount: 1, pointerType: "mouse",
}, extra || {}));
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function click(p: VerdictSonde) {
  await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 });
  await M("mousePressed", p.x, p.y);
  await M("mouseReleased", p.x, p.y, { buttons: 0 });
  await pause(70);
}
async function drag(from: VerdictSonde, to: VerdictSonde, steps = 14) {
  await M("mouseMoved", from.x, from.y, { button: "none", buttons: 0 });
  await M("mousePressed", from.x, from.y);
  for (let i = 1; i <= steps; i++) {
    await M("mouseMoved", from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
    await pause(7);
  }
  await M("mouseReleased", to.x, to.y, { buttons: 0 });
  await pause(80);
}
const KEYS = {
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
};
async function key(name: string, mods?: VerdictSonde) {
  const k = KEYS[name as keyof typeof KEYS]
    || { key: name, code: "Key" + name.toUpperCase(), windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0), text: name };
  const base = Object.assign({}, k, { modifiers: mods || 0 });
  await send("Input.dispatchKeyEvent", Object.assign({ type: "text" in base && base.text ? "keyDown" : "rawKeyDown" }, base));
  await send("Input.dispatchKeyEvent", Object.assign({ type: "keyUp" }, base, { text: undefined }));
  await pause(60);
}

// ---- micro-harness -----------------------------------------------------------------------------
const results: VerdictSonde[] = [];
let cur: VerdictSonde = null;
function ok(cond: unknown, msg?: string) { if (!cond) cur.fails.push(msg); return !!cond; }
async function test(name: string, fn: (...args: VerdictSonde[]) => VerdictSonde | Promise<VerdictSonde>,
  reloadFn: () => Promise<void> = reload) {
  cur = { name, fails: [] };
  await reloadFn();
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
const wallsMode = (on: VerdictSonde) => evaluate(`__plan.wallsMode(${on ? "true" : "false"}); true`).then(() => pause(140));
const toastNow = () => evaluate(`String(__plan.toastText||"")`);
const poses = () => J(`(function(){var o={};__plan.plan.pieces.forEach(function(p){
  o[String(p.id)]=[p.x,p.y,p.w,p.h,p.rot||0];}); return o;})()`);
const parNom = (nom: VerdictSonde) => J(`(function(){var p=__plan.plan.pieces.filter(function(q){return q.name===${JSON.stringify(nom)};})[0];
  return p?{id:String(p.id),x:p.x,y:p.y,w:p.w,h:p.h,rot:p.rot||0}:null;})()`);
const posDe = (id: string) => J(`(function(){var p=__plan.pieceById(${JSON.stringify(id)});
  return p?{x:p.x,y:p.y,w:p.w,h:p.h,rot:p.rot||0}:null;})()`);
// The stack actually under the cursor, in PAINT order (data-paint), not DOM order:
// selection raises the element to z-index 50 and would skew the reading.
const pileAu = (x: VerdictSonde, y: VerdictSonde) => J(`(function(){var out=[];
  (document.elementsFromPoint(${x},${y})||[]).forEach(function(n){
    var pe=n.closest&&n.closest(".piece"); if(!pe||!pe.dataset.id) return;
    if(out.some(function(o){return o.id===pe.dataset.id;})) return;
    out.push({id:pe.dataset.id, z:+pe.dataset.paint||0});});
  out.sort(function(a,b){return b.z-a.z;}); return out;})()`);
const empreinte = () => evaluate(`(function(){var P=__plan.plan; return JSON.stringify({
  o:P.outline, w:P.walls.map(function(w){return [String(w.id),w.a,w.b];}),
  c:(P.cells||[]).length, g:(P.openings||[]).map(function(o){return [String(o.id),String(o.wallId),o.t0,o.w];}),
  p:P.pieces.map(function(p){return [String(p.id),p.x,p.y,p.w,p.h,p.rot||0];})});})()`);

// =============================================================================
//  1. cible_sous_le_curseur_a_300
// =============================================================================
// Measured on an apartment filled to 300 objects: out of 30 gestures, 20 moved an OTHER piece of
// furniture than the one aimed at ("I aimed at Homu, Rug 12 is what moved"). Paint order followed
// ARRAY order, so a 6 m2 rug added last covered everything underneath it. The rule enforced here
// is the one from the spec: WHAT MOVES IS UNDER THE CURSOR ON PRESS, and nothing else (a
// chair->table snap can bring along the chairs of the table that was grabbed).
await test("cible_sous_le_curseur_a_300", async () => {
  const cells = await J(`__plan.plan.cells.map(function(c){var b=__plan.bboxOfPoly(c.poly);
    return {minX:b.minX,minY:b.minY,maxX:b.maxX,maxY:b.maxY};})`);
  const TYPES = ["chair", "side", "ottoman", "plant", "shelf", "arm", "coffee", "desk", "placard", "rug", "biblio", "lamp", "armoire"];
  const combien = await J(`__plan.plan.pieces.length`);
  let ajout = "";
  for (let i = 0; i < 300 - combien; i++) {
    const c = cells[(i * 7) % cells.length];
    const x = Math.round(c.minX + 30 + ((i * 53) % Math.max(40, c.maxX - c.minX - 60)));
    const y = Math.round(c.minY + 30 + ((i * 31) % Math.max(40, c.maxY - c.minY - 60)));
    ajout += `__plan.addV5Piece(${JSON.stringify(TYPES[i % TYPES.length])},${x},${y});`;
  }
  await evaluate(`(function(){${ajout}__plan.clearSel();__plan.render();__plan.save();})(); true`);
  await pause(400);
  ok(await J(`__plan.plan.pieces.length`) >= 290, "l'appartement doit bien porter ~300 meubles");
  const vr = await J(`(function(){var r=document.getElementById("viewport").getBoundingClientRect();
    return {l:r.left,t:r.top,w:r.width,h:r.height};})()`);
  const ids = await J(`__plan.plan.pieces.filter(function(p){return !p.locked;}).map(function(p){return String(p.id);})`);
  const pas = Math.max(1, Math.floor(ids.length / 30));
  const ech = ids.filter((_: VerdictSonde, i: number) => i % pas === 0).slice(0, 30);
  let vises = 0, hors = 0, retours = 0, retoursExacts = 0;
  const fautes = [];
  for (const id of ech) {
    await evaluate("__plan.clearSel(); __plan.render(); true");
    const avant = await poses();
    const a = avant[id]; if (!a) continue;
    const A = { x: vr.l + 0, y: 0 };
    const s = await aptPoint(a[0] + a[2] / 2, a[1] + a[3] / 2);
    A.x = s.x; A.y = s.y;
    if (A.x < vr.l + 20 || A.x > vr.l + vr.w - 20 || A.y < vr.t + 20 || A.y > vr.t + vr.h - 20) continue;
    const B = { x: A.x + 90, y: A.y + 60 };
    if (B.x > vr.l + vr.w - 20 || B.y > vr.t + vr.h - 20) continue;
    vises++;
    const pile = await pileAu(Math.round(A.x), Math.round(A.y));
    await drag(A, B);
    const apres = await poses();
    const bouges = Object.keys(apres).filter(k => avant[k] && String(avant[k]) !== String(apres[k]));
    // Everything that moved must be UNDER THE CURSOR, except chairs snapped to the grabbed table.
    const sousCurseur = bouges.every(b => pile.some((q: VerdictSonde) => q.id === b)
      || (bouges.includes(pile[0] && pile[0].id) && /chair/.test("")));
    if (!bouges.every(b => pile.some((q: VerdictSonde) => q.id === b))) {
      // the only legitimate case outside the stack: chairs following the table actually grabbed
      const menees = bouges.filter(b => !pile.some((q: VerdictSonde) => q.id === b));
      const chaises = await J(`${JSON.stringify(menees)}.every(function(i){var p=__plan.pieceById(i);return p&&p.type==="chair";})`);
      const tableSaisie = pile.length && bouges.indexOf(pile[0].id) >= 0;
      if (!(chaises && tableSaisie)) { hors++; fautes.push({ vise: id, bouges, pile: pile.map((q: VerdictSonde) => q.id) }); }
    }
    // and a round trip must come back EXACTLY to the starting point
    const m = apres[id];
    if (m && String(m) !== String(a)) {
      retours++;
      const c2 = await aptPoint(m[0] + m[2] / 2, m[1] + m[3] / 2);
      await drag(c2, A);
      const fin = (await poses())[id];
      if (String(fin) === String(a)) retoursExacts++;
    }
  }
  ok(vises >= 20, `il faut au moins 20 gestes mesurables (${vises})`);
  ok(hors === 0, `${hors}/${vises} gestes ont déplacé un objet qui n'était PAS sous le curseur : ` + JSON.stringify(fautes.slice(0, 3)));
  ok(retoursExacts === retours, `l'aller-retour doit revenir exactement : ${retoursExacts}/${retours}`);
});

// =============================================================================
//  2. aller_retour_idempotent
// =============================================================================
// The most common step (30 cm) was the worst case: 62 exact returns out of 122. Three families.
//  - pure drift: "Chair" (45 cm wide) gained 1 cm PER CYCLE, snap off, without end: we rounded
//    the CENTER then re-derived the CORNER from it, and `Math.round` rounds .5 upward.
//  - oscillation: "Four (colonne)" did [+2,0] [-2,0] [+2,0]... indefinitely.
//  - entry jump: "Radiateur 3", placed straddling the facade, jumped 113 cm on the very first
//    gesture, in response to a push of 30.
await test("aller_retour_idempotent", async () => {
  const noms = ["Four (colonne)", "Chair", "Radiateur 3", "Homu", "Lit (160)"];
  for (const aimant of [true, false]) {
    await evaluate(`__plan.state.opts.snap=${aimant}; __plan.render(); true`);
    for (const nom of noms) {
      const p = await parNom(nom); if (!p) { ok(false, `meuble absent du plan de référence : ${nom}`); continue; }
      const dep = await posDe(p.id);
      let pires = null;
      for (let i = 0; i < 6; i++) {
        const a = await posDe(p.id);
        const A = await aptPoint(a.x + a.w / 2, a.y + a.h / 2);
        const B = await aptPoint(a.x + a.w / 2 + 30, a.y + a.h / 2);
        await drag(A, B, 10);
        const m = await posDe(p.id);
        await drag(await aptPoint(m.x + m.w / 2, m.y + m.h / 2), A, 10);
        const b = await posDe(p.id);
        if (b.x !== a.x || b.y !== a.y) pires = pires || { cycle: i + 1, de: [a.x, a.y], a: [b.x, b.y] };
      }
      const fin = await posDe(p.id);
      ok(!pires, `« ${nom} » (aimant ${aimant ? "on" : "off"}) ne revient pas : ${JSON.stringify(pires)}`);
      ok(fin.x === dep.x && fin.y === dep.y,
        `« ${nom} » (aimant ${aimant ? "on" : "off"}) a dérivé de ${dep.x},${dep.y} à ${fin.x},${fin.y}`);
    }
  }
});

// =============================================================================
//  3. clic_sur_sommet_n_ecrit_rien
// =============================================================================
// The click on the MIDDLE of a facade had been fixed; the one on a VERTEX still wrote. Measured:
// a single click on the top-left corner stretched a 90 cm partition three meters away, cut a room
// in two (9.6 m2 -> 7.7 + 1.9), made a radiator jump 114 cm, and saved all of it. We check EVERY
// vertex here, plus every endpoint of interior walls.
await test("clic_sur_sommet_n_ecrit_rien", async () => {
  await wallsMode(true);
  const avant = await empreinte();
  const lsAvant = await evaluate(`String((localStorage.getItem("room-planner-v4")||"").length)`);
  const sommets = await J(`[].slice.call(document.querySelectorAll(".v5layer .vtx")).map(function(e){
    var r=e.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2};})`);
  ok(sommets.length >= 4, "aucune poignée de sommet à cliquer");
  for (const s of sommets) {
    await click(s); await pause(120);
    ok((await empreinte()) === avant, `un clic sur un sommet du contour a modifié le plan (${JSON.stringify(s)})`);
  }
  ok(await evaluate(`String(__plan.histInfo().undo)`) === "0", "un clic net ne pousse rien dans l'historique");
  ok(await evaluate(`String((localStorage.getItem("room-planner-v4")||"").length)`) === lsAvant,
    "un clic net ne doit pas réécrire le plan enregistré");
  // The ENDPOINTS of interior walls, one click each.
  const bouts = await J(`(function(){var o=[];__plan.plan.walls.forEach(function(w){
    if(w.isOutline) return; o.push([w.a[0],w.a[1]]); o.push([w.b[0],w.b[1]]);}); return o;})()`);
  let casse = 0;
  for (const b of bouts) {
    const s = await aptPoint(b[0], b[1]);
    await click(s); await pause(90);
    if ((await empreinte()) !== avant) { casse++; break; }
  }
  ok(casse === 0, "un clic sur un bout de mur intérieur a modifié le plan");
});

// =============================================================================
//  4. clic_sur_meuble_ne_le_bouge_pas
// =============================================================================
// The cell bound kicked in on EVERY release, even with zero movement: a simple click moved
// "Baignoire 2" by 11 cm and "Machine a laver" by 8 cm, because they already bit into the 6 cm
// inset inherited from the converted plan.
await test("clic_sur_meuble_ne_le_bouge_pas", async () => {
  const avant = await empreinte();
  const ids = await J(`__plan.plan.pieces.filter(function(p){return !p.locked;}).map(function(p){return String(p.id);})`);
  let bouges = 0, testes = 0;
  for (const id of ids) {
    const a = await posDe(id); if (!a) continue;
    const s = await aptPoint(a.x + a.w / 2, a.y + a.h / 2);
    const vr = await J(`(function(){var r=document.getElementById("viewport").getBoundingClientRect();
      return {l:r.left,t:r.top,w:r.width,h:r.height};})()`);
    if (s.x < vr.l + 5 || s.x > vr.l + vr.w - 5 || s.y < vr.t + 5 || s.y > vr.t + vr.h - 5) continue;
    testes++;
    await click(s);
  }
  ok(testes >= 30, `il faut au moins 30 meubles cliquables (${testes})`);
  const apres = await empreinte();
  if (apres !== avant) {
    const A = JSON.parse(avant).p, B = JSON.parse(apres).p;
    A.forEach((r: VerdictSonde, i: number) => { if (String(r) !== String(B[i])) bouges++; });
  }
  ok(apres === avant, `${bouges} meubles ont bougé sous un simple clic`);
  ok(await evaluate(`String(__plan.histInfo().undo)`) === "0", "un clic net ne pousse rien dans l'historique");
});

// =============================================================================
//  5. pile_de_cinq_entierement_cyclee
// =============================================================================
// Five objects at the same point, twelve clicks: the cycle went "coffee plant coffee plant..."
// and NEVER reached the three underneath. Cause: `.piece.sel` raises the selected object to
// z-index 50, so the stack reordered on every click and the cycle key kept changing.
await test("pile_de_cinq_entierement_cyclee", async () => {
  const cell = await J(`(function(){var c=__plan.plan.cells[0];var b=__plan.bboxOfPoly(c.poly);
    var pl=null; return {x:Math.round((b.minX+b.maxX)/2), y:Math.round((b.minY+b.maxY)/2)};})()`);
  const ids = [];
  for (const ty of ["chair", "side", "ottoman", "plant", "coffee"]) {
    ids.push(await evaluate(`String(__plan.addV5Piece(${JSON.stringify(ty)},${cell.x},${cell.y}).id)`));
  }
  await evaluate(`(function(){${JSON.stringify(ids)}.forEach(function(id){var p=__plan.pieceById(id);
    p.x=${cell.x}-p.w/2; p.y=${cell.y}-p.h/2;}); __plan.clearSel(); __plan.render(); __plan.save();})(); true`);
  await pause(300);
  const S = await aptPoint(cell.x, cell.y);
  const vus: VerdictSonde[] = [];
  for (let i = 0; i < 12; i++) { await click(S); vus.push(await evaluate(`String(__plan.selId)`)); }
  const atteints = ids.filter(id => vus.includes(id));
  ok(atteints.length === 5, `le cycle du clic doit atteindre les 5 objets (${atteints.length}/5) ; vus : ${JSON.stringify(vus)}`);
  ok(/objects here/.test(await toastNow()), "descendre dans la pile doit se DIRE : " + JSON.stringify(await toastNow()));
  // and once the object underneath is selected, it IS the one the drag carries
  await evaluate(`__plan.selReplace(${JSON.stringify(ids[0])}); __plan.render(); true`);
  const avant = await poses();
  await drag(S, { x: S.x + 120, y: S.y });
  const apres = await poses();
  const bouges = Object.keys(apres).filter(k => avant[k] && String(avant[k]) !== String(apres[k]));
  ok(bouges.length === 1 && bouges[0] === ids[0],
    `le glisser doit emporter l'objet SÉLECTIONNÉ, pas un autre (${JSON.stringify(bouges)})`);
});

// =============================================================================
//  6. gros_meuble_sous_petit_atteint
// =============================================================================
// On the real plan, aiming at the middle of "Plan de travail 3" grabbed the "Plaque de cuisson"
// sitting on top of it, and aiming at the hob grabbed the "Refrigerateur": two large kitchen
// items were unreachable at the opening zoom. The small object MUST win the first click (it's
// the one you see), but the large one must stay reachable on the next click.
await test("gros_meuble_sous_petit_atteint", async () => {
  const gros = await parNom("Plan de travail 3");
  const petit = await parNom("Plaque de cuisson");
  ok(!!gros && !!petit, "le plan de référence doit porter le plan de travail et la plaque");
  if (!gros || !petit) return;
  const S = await aptPoint(petit.x + petit.w / 2, petit.y + petit.h / 2);
  await evaluate("__plan.clearSel(); __plan.render(); true");
  await click(S);
  ok(await evaluate(`String(__plan.selId)`) === petit.id, "le premier clic prend le petit objet, celui qu'on voit");
  await click(S);
  ok(await evaluate(`String(__plan.selId)`) === gros.id,
    `le second clic au même point doit atteindre le gros meuble en dessous (obtenu ${await evaluate("String(__plan.selId)")})`);
  // and it really MOVES, since it's selected
  const a = await posDe(gros.id);
  await drag(S, { x: S.x + 60, y: S.y });
  const b = await posDe(gros.id);
  ok(b.x !== a.x || b.y !== a.y, "le gros meuble sélectionné doit se déplacer au glisser suivant");
});

// =============================================================================
//  7. echap_qui_quitte_les_murs_le_dit
// =============================================================================
// Real session: after deleting a wall followed by Ctrl+Z, NO wall would select for 16
// consecutive clicks. The incident had been filed as "not reproducible". Cause: in Walls mode,
// Escape with no selection QUITS the mode, silently. The consequence is indistinguishable from
// a failure.
await test("echap_qui_quitte_les_murs_le_dit", async () => {
  await wallsMode(true);
  const murs = await J(`__plan.plan.walls.map(function(w){return {id:String(w.id),
    cx:(w.a[0]+w.b[0])/2, cy:(w.a[1]+w.b[1])/2};})`);
  const clicMur = async (m: VerdictSonde) => { await click(await aptPoint(m.cx, m.cy)); return evaluate(`String(__plan.v5ui.selWall)`); };
  ok(await clicMur(murs[1]) === murs[1].id, "témoin : un mur se sélectionne en mode Murs");
  await key("Escape");                       // 1st Escape: deselects
  ok(await evaluate(`String(__plan.v5ui.selWall)`) === "null", "le premier Échap désélectionne");
  ok(await evaluate(`String(!!document.querySelector("#btnModeWalls.pri"))`) === "true",
    "le premier Échap ne doit pas quitter le mode Murs");
  await key("Escape");                       // 2nd Escape: quits the mode, and SAYS so
  ok(await evaluate(`String(!!document.querySelector("#btnModeWalls.pri"))`) === "false",
    "le second Échap quitte bien le mode Murs");
  ok(/Furniture mode/.test(await toastNow()),
    "quitter le mode Murs doit se dire : " + JSON.stringify(await toastNow()));
  // and the "Walls" button really brings it back
  await click(await centerOf("#btnModeWalls")); await pause(200);
  ok(await clicMur(murs[2]) === murs[2].id, "le bouton « Murs » doit rendre les murs sélectionnables");
});

// =============================================================================
//  8. poignee_meuble_deportee_ne_teleporte_pas_le_coin
// =============================================================================
// THE SAME DEFECT AS FOR OPENINGS, AND ITS MOST COSTLY SITE. `rendu/meubles.ts` moves the four
// corners `RSZ_OUT_PX` = 6 px OUTWARD as soon as the thumbnail drops below `RSZ_COMPACT_PX` =
// 64 px, otherwise the handles eat it entirely (G-20). But `gestes/redimension.ts` derived w and
// h from the pointer's ABSOLUTE position relative to the anchor (`nw = dLocX * h.ux`), without
// remembering the grab: the corner TELEPORTED under the cursor on the first movement, so 6 px
// further than it actually was.
//
// Measured at the bench on the real plan, "Fit" scale 0.638 px/cm (6 px = 9.4 cm, rounded to 10
// by the grid): a 45x50 chair, corner moved 6 px then PUT BACK AT THE EXACT PIXEL, rendered
// 55x60 and retreated 10 cm on BOTH axes. ZERO exact round trips out of 19. At this zoom the
// 64 px threshold is worth 100 cm, so almost all of a real plan's furniture is affected.
//
// This case grabs the handle WHERE IT IS ACTUALLY PAINTED, which no suite did: it is the only
// way to see the defect, since grabbing it at the box's edge is precisely the position where it
// does not exist.
await test("poignee_meuble_deportee_ne_teleporte_pas_le_coin", async () => {
  // Snap off: the 5 cm grid quantizes the ABSOLUTE dimension, which is a different question.
  // We measure ONE thing here: does the corner follow the hand, and does the round trip return.
  await evaluate(`__plan.state.opts.snap=false; __plan.render(); true`); await pause(150);
  const S = await evaluate(`__plan.vScale`);
  const seuilCm = 64 / S;                              // below this size, the corners go outside
  const D = 12;                                        // px: a real gesture, well beyond the 3 px threshold
  const viseCm = D / S;
  // COMPACT furniture from the real plan (thumbnail under 64 px, so handles moved outward), NOT
  // ROTATED (a rotated piece's local axes aren't the screen's, that's not what's measured here),
  // and big enough to absorb the gesture without hitting `RSZ_MIN`.
  const cibles = await J(`(function(){var out=[];
    __plan.plan.pieces.forEach(function(p){
      if(p.locked || (p.rot||0) !== 0) return;
      if(Math.min(p.w,p.h) >= ${seuilCm}) return;
      if(Math.min(p.w,p.h) < ${viseCm} + 25) return;
      if(out.length < 6) out.push({id:String(p.id), nom:p.name||p.type});
    }); return out;})()`);
  ok(cibles.length >= 3, `le plan de référence doit porter des meubles compacts (${cibles.length} trouvés, seuil ${seuilCm.toFixed(0)} cm)`);

  let dehorsVu = 0, mesures = 0, bornes = [], mauvais = [];
  for (const c of cibles) {
    const a0 = await posDe(c.id);
    if (!a0) continue;
    // select the furniture: handles are only painted on selection (G-20)
    await evaluate(`__plan.selReplace(${JSON.stringify(c.id)}); __plan.render(); true`); await pause(160);
    // the "nw" handle AS IT IS ACTUALLY PAINTED, plus the box's edge to know if it sticks out
    const p = await J(`(function(){
      var e=document.querySelector('.piece[data-id="'+CSS.escape(${JSON.stringify(c.id)})+'"]');
      if(!e) return null;
      var h=e.querySelector('.rsz-handle[data-rsz="nw"]'); if(!h) return null;
      var rh=h.getBoundingClientRect(), re=e.getBoundingClientRect();
      if(!rh.width && !rh.height) return null;
      return {x:rh.left+rh.width/2, y:rh.top+rh.height/2, dehors:(rh.left+rh.width/2) < re.left - 1};})()`);
    if (!p) { ok(false, `« ${c.nom} » : aucune poignée « nw » peinte`); continue; }
    if (p.dehors) dehorsVu++;

    const depart = { x: p.x, y: p.y };
    // We SHRINK (the "nw" corner pushed inward): the furniture stays under 64 px for the whole
    // gesture, so the handle stays moved outward from start to finish. A gesture that ENLARGES
    // would cross the compactness threshold along the way, the handle would move back into the
    // box, and the return would measure that rendering jump instead of the defect.
    await drag(depart, { x: depart.x + D, y: depart.y + D }, 10);
    const a1 = await posDe(c.id);
    if (Math.abs((a1.w - a0.w) + viseCm) > 2 || Math.abs((a1.h - a0.h) + viseCm) > 2) {
      mauvais.push(`« ${c.nom} » ne suit pas la main : ${a0.w}×${a0.h} − ${viseCm.toFixed(1)} attendu, obtenu ${a1.w}×${a1.h}`);
    }
    // DID THE ANCHOR HOLD? The opposite corner is fixed, so the placement must move exactly by
    // the opposite of the size change. When `v5ClampPiece` bites (furniture flush against a
    // wall), it moves anyway: the round trip is then no longer a measure of the GRAB, it's a
    // measure of the BOUND, a completely different mechanism. We discard the case instead of
    // mixing the two.
    const ancreOk = Math.abs((a1.x - a0.x) + (a1.w - a0.w)) <= 1 && Math.abs((a1.y - a0.y) + (a1.h - a0.h)) <= 1;
    if (!ancreOk) { bornes.push(`${c.nom} (${a0.y}->${a1.y})`); continue; }
    mesures++;
    // and we put the handle back EXACTLY at the pixel it was grabbed from
    const p2 = await J(`(function(){
      var e=document.querySelector('.piece[data-id="'+CSS.escape(${JSON.stringify(c.id)})+'"]');
      if(!e) return null; var h=e.querySelector('.rsz-handle[data-rsz="nw"]'); if(!h) return null;
      var r=h.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2};})()`);
    if (!p2) { ok(false, `« ${c.nom} » : la poignée a disparu en cours de geste`); continue; }
    await drag(p2, depart, 10);
    const a2 = await posDe(c.id);
    if (a2.w !== a0.w || a2.h !== a0.h || a2.x !== a0.x || a2.y !== a0.y) {
      mauvais.push(`« ${c.nom} » ne revient pas : ${a0.w}×${a0.h} @${a0.x},${a0.y} -> [pendant ${a1.w}×${a1.h} @${a1.x},${a1.y}] -> ${a2.w}×${a2.h} @${a2.x},${a2.y}`);
    }
  }
  // Precondition: without it, the case would pass green while testing WIDE furniture, i.e.
  // the only kind where the defect doesn't exist.
  ok(dehorsVu >= 1, "précondition : au moins un meuble doit avoir sa poignée peinte HORS de la boîte (G-20)");
  ok(mesures >= 3, `précondition : au moins trois aller-retours mesurables (${mesures} ; écartés pour bornage : ${bornes.join(", ") || "aucun"})`);
  ok(mauvais.length === 0, mauvais.join(" | "));
});

// =============================================================================
//  9. clic_net_sur_poignee_de_meuble_n_ecrit_rien
// =============================================================================
// G-3 for the gesture that had forgotten it. `gestes/meuble.ts` and `gestes/ouverture.ts` push
// their undo notch ON THE FIRST REAL MOVEMENT; `startPieceResize` used to push it on
// `pointerdown`. Measured at the bench: a clean click on a "3-seat sofa" handle made
// `histInfo().undo` go from 0 to 1, size and placement unchanged. The first Ctrl+Z then visibly
// did nothing, and the second destroyed a real change, the worst of both worlds, since you press
// a second time precisely because the first did nothing.
await test("clic_net_sur_poignee_de_meuble_n_ecrit_rien", async () => {
  const S = await evaluate(`__plan.vScale`);
  const cible = await J(`(function(){var r=null;
    __plan.plan.pieces.forEach(function(p){ if(!r && !p.locked && p.w*${S} > 40) r={id:String(p.id), nom:p.name||p.type}; });
    return r;})()`);
  ok(!!cible, "le plan de référence doit porter un meuble redimensionnable");
  if (!cible) return;
  await evaluate(`__plan.selReplace(${JSON.stringify(cible.id)}); __plan.render(); true`); await pause(180);
  const avant = await posDe(cible.id);
  const undoAvant = await evaluate(`String(__plan.histInfo().undo)`);
  const poignees = await J(`(function(){var out=[];
    var e=document.querySelector('.piece[data-id="'+CSS.escape(${JSON.stringify(cible.id)})+'"]');
    if(!e) return out;
    e.querySelectorAll('.rsz-handle').forEach(function(h){
      if(h.style.display==="none") return;
      var r=h.getBoundingClientRect(); if(!r.width && !r.height) return;
      out.push({k:h.dataset.rsz, x:r.left+r.width/2, y:r.top+r.height/2});});
    return out;})()`);
  ok(poignees.length >= 4, `des poignées doivent être peintes (${poignees.length})`);
  for (const h of poignees) {
    await click({ x: h.x, y: h.y }); await pause(90);
    const undoApres = await evaluate(`String(__plan.histInfo().undo)`);
    ok(undoApres === undoAvant,
      `un clic NET sur la poignée « ${h.k} » a poussé un cran d'annulation : ${undoAvant} -> ${undoApres}`);
    const apres = await posDe(cible.id);
    ok(apres.w === avant.w && apres.h === avant.h && apres.x === avant.x && apres.y === avant.y,
      `un clic NET sur « ${h.k} » a modifié le meuble : ${avant.w}×${avant.h} @${avant.x},${avant.y} -> ${apres.w}×${apres.h} @${apres.x},${apres.y}`);
  }
});

// =============================================================================
//  10. poignee_rotation_ne_vole_pas_le_centre_meuble_mince
// =============================================================================
// THIS IS THE DIRECT CASE FOR THE DEFECT THAT CASE #1 ONLY CAUGHT INCIDENTALLY (its round trip
// re-selects the piece before the return drag, which is what exposed the handle without either
// test naming it). `.rot-handle` floats ~24 screen PIXELS above the piece's center, in FIXED
// pixels, and it is only painted once the piece is the PRIMARY selection. For a THIN piece at a
// zoomed-out scale, that fixed reach comes within, or even past, the piece's own geometric center.
// `e.target` is real DOM hit-testing: it knows nothing about the piece's APARTMENT box, only about
// what is painted on top at that pixel, so a press aimed dead-center on an ALREADY-SELECTED thin
// piece can land on `span.rot-handle` and start a no-op rotation instead of a drag.
//
// MEASURED at the bench (`fitView()` on the household plan, scale ~0.517): among the plan's several
// 13 cm-thick radiators, the 88 cm-wide ones sit RIGHT AT the edge (the handle's nearest reach is
// under one screen pixel from center, too razor-thin to make a deterministic automated case), but
// the 49 cm-wide one is solidly inside the handle's painted area at its EXACT geometric
// center — `document.elementsFromPoint` returns `.rot-handle` there, reliably. That is the target
// picked here, by its own dimensions rather than by name (the fixture carries several
// "Radiateur"/"Radiateur N", not all of them reproduce this).
await test("poignee_rotation_ne_vole_pas_le_centre_meuble_mince", async () => {
  const cible = await J(`(function(){var p=__plan.plan.pieces.filter(function(q){
    return q.h===13 && q.w===49 && !q.locked;})[0];
    return p ? {id:String(p.id), nom:p.name} : null;})()`);
  ok(!!cible, "le plan de référence doit porter un radiateur mince de 49×13 cm");
  if (!cible) return;
  await evaluate(`__plan.selReplace(${JSON.stringify(cible.id)}); __plan.render(); true`);
  await pause(160);
  // Precondition: the handle really is painted, and really does cover the piece's own exact
  // center (otherwise the case tests nothing, or tests a different, unrelated defect).
  const a0 = await posDe(cible.id);
  const A0 = await aptPoint(a0.x + a0.w / 2, a0.y + a0.h / 2);   // pixel exact du centre du meuble
  const surLaPoignee = await J(`(function(){
    var top = document.elementsFromPoint(${A0.x}, ${A0.y})[0];
    return !!(top && top.dataset && top.dataset.rot);})()`);
  ok(surLaPoignee, "précondition : la poignée de rotation doit recouvrir le centre exact du meuble");

  const a = await posDe(cible.id);
  const A = await aptPoint(a.x + a.w / 2, a.y + a.h / 2);   // pixel exact du centre du meuble
  const B = { x: A.x + 40, y: A.y + 10 };
  await drag(A, B, 10);
  const b = await posDe(cible.id);
  ok(b.x !== a.x || b.y !== a.y,
    `un appui dead-center sur un meuble mince déjà sélectionné doit le DÉPLACER, pas le faire pivoter : ` +
    `avant ${a.x},${a.y}@${a.rot}° après ${b.x},${b.y}@${b.rot}°`);
  ok(b.rot === a.rot, `le glisser depuis le centre ne doit pas tourner le meuble : ${a.rot}° -> ${b.rot}°`);

  // et l'aller-retour revient exactement, sélection toujours active (la poignée est donc
  // toujours peinte pour ce second appui, comme dans le cas #1)
  const C = await aptPoint(b.x + b.w / 2, b.y + b.h / 2);
  await drag(C, A, 10);
  const c = await posDe(cible.id);
  ok(c.x === a.x && c.y === a.y && c.rot === a.rot,
    `l'aller-retour ne revient pas exactement : ${a.x},${a.y}@${a.rot}° -> ${c.x},${c.y}@${c.rot}°`);
});

// =============================================================================
//  11. groupe_de_meubles_bouge_d_un_seul_bloc
// =============================================================================
// Real-usage repro (kitchen area of a demo apartment, a lasso over 6 furniture + 4 openings, then
// dragged and dragged back): each piece of furniture was clamped INDEPENDENTLY at release, so a
// piece with little clearance to a wall (here the TV unit, ~4 cm before the partition) stopped
// short while the rest of the group kept going. Measured on the exact scenario replayed here:
// forward request (+90,+60) landed as sink +90,+96 (drifted 36 cm past the group), TV unit +4,+60
// (barely moved), everyone else +90,+60 — the SHAPE of the selection broke.
// THE RULE (`deltaScaleMax`, gestes/contraintes.ts): a group of FURNITURE moves as ONE — the
// largest fraction of the requested delta every selected piece can accept, shared, applied to
// ALL of them — never each piece projected to its own nearest valid spot. Openings are excluded
// from the check: they keep their own (different, allowed) wall-sliding behaviour, already
// covered by tests/run.ts:523.
// Uses SEED_APT (the repository's demo apartment, not the household plan): this specific wall
// geometry — fridge/worktop/sink/hob/oven/TV unit lined up against the kitchen's walls with
// uneven clearances — is what produces the divergence; it does not occur by accident in the
// household plan's own kitchen layout, tuned for the other cases in this file.
await test("groupe_de_meubles_bouge_d_un_seul_bloc", async () => {
  const furnitureIds = ["p1", "p2", "p3", "p4", "p5", "p6"];
  const openingIds = ["o2", "o8", "o10", "o15"];
  await evaluate(`(function(){__plan.clearSel();
    ${JSON.stringify(furnitureIds.concat(openingIds))}.forEach(function(id){__plan.selAdd(id);});
    __plan.render(); true;})()`);
  await pause(150);
  ok(await evaluate(`String(__plan.selDump().modele.length)`) === String(furnitureIds.length + openingIds.length),
    "précondition : les 6 meubles et les 4 ouvertures doivent tous être sélectionnés");

  const before: Record<string, VerdictSonde> = {};
  for (const id of furnitureIds) before[id] = await posDe(id);

  // drag the group by (+90,+60) diagonally-and-deep enough to hit the tightest member's limit,
  // grabbing the fridge (primary), same numbers as the real-usage measurement.
  const p0 = before["p1"];
  const S0 = await aptPoint(p0.x + p0.w / 2, p0.y + p0.h / 2);
  const scale = await evaluate("__plan.vScale");
  await drag(S0, { x: S0.x + 90 * scale, y: S0.y + 300 * scale }, 16);

  const after: Record<string, VerdictSonde> = {};
  for (const id of furnitureIds) after[id] = await posDe(id);
  const deltas = furnitureIds.map((id) => `${after[id].x - before[id].x},${after[id].y - before[id].y}`);
  ok(new Set(deltas).size === 1,
    `le groupe doit bouger d'UN SEUL bloc, tous les meubles avec le même delta : ${JSON.stringify(furnitureIds.map((id, i) => [id, deltas[i]]))}`);
  ok(/does not fit there/.test(await toastNow()),
    "un geste de groupe réduit doit se DIRE (banner de geste), une seule fois pour tout le groupe : " + JSON.stringify(await toastNow()));

  // and the round trip: FROM wherever the group landed, back TO the original screen point (not
  // "by the same pixel delta", since the forward leg may not have moved the full ask) returns
  // every piece of FURNITURE exactly where it started.
  const mid = await posDe("p1");
  const Smid = await aptPoint(mid.x + mid.w / 2, mid.y + mid.h / 2);
  await drag(Smid, S0, 16);
  for (const id of furnitureIds) {
    const a = before[id], b = await posDe(id);
    ok(a.x === b.x && a.y === b.y,
      `« ${id} » ne revient pas exactement à sa place de départ : ${a.x},${a.y} -> ${b.x},${b.y}`);
  }
}, reloadApt);

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
