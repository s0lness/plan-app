#!/usr/bin/env node
// =============================================================================
//  SUITE "ORDINARY USAGE" — REAL MOUSE (CDP), REAL HIT-TESTING
// =============================================================================
// Nine defects found by real-usage sessions (about 1,500 gestures on the user's plan, then a
// two-browser session). They have in common that they betray the most basic promise: LOOKING
// changes nothing, REPEATING a gesture gives the same result, and when something can't be done,
// it IS SAID.
//
//   node tests/gestes-usage-reel.ts [path/to/app.html]
//
//   selection_facade_ne_modifie_rien   a click on a facade used to rewrite the whole plan
//   outil_arme_ne_deforme_aucun_mur    a click, tool armed, lengthened a wall 3 m away
//   mur_supprime_se_retrace            the snap glued the new stroke onto the neighboring partition
//   porte_garde_sa_largeur             an 80 cm door got shaved down to 43, permanently
//   aller_retour_revient_au_depart     the 5 cm grid moved any off-grid furniture away
//   objets_superposes_atteignables     the object underneath got 0% of clicks
//   petit_objet_se_deplace             8 handles covered a 29 px chair
//   meme_message_pas_huit_fois         22 banners in 371 s, 8 of them the same
//   facade_refuse_sa_suppression       deleting a facade said nothing at all
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-usage-"));
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

async function reload() {
  await send("Page.navigate", { url: "file:///" + htmlPath.replace(/\\/g, "/") });
  for (let i = 0; i < 200; i++) {
    let st = null;
    try { st = await evaluate("document.readyState + '|' + (window.__plan ? 1 : 0)"); } catch (_) {}
    if (st === "complete|1") break;
    await new Promise(r => setTimeout(r, 50));
  }
  await new Promise(r => setTimeout(r, 350));
}

// ---- REAL mouse ------------------------------------------------------------------------------
const M = (type: string, x: VerdictSonde, y: VerdictSonde, extra?: Record<string, unknown>) => send("Input.dispatchMouseEvent", Object.assign({
  type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1,
  clickCount: 1, pointerType: "mouse",
}, extra || {}));
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function press(p: VerdictSonde) { await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 }); await M("mousePressed", p.x, p.y); await pause(20); }
async function moveTo(p: VerdictSonde, steps = 8, from: VerdictSonde) {
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
  return {x:r.left+r.width/2, y:r.top+r.height/2, w:r.width, h:r.height};})()`);
const aptPoint = (x: VerdictSonde, y: VerdictSonde) => J(`(function(){var s=__plan.aptToScreen(${x},${y});
  var r=document.getElementById("viewport").getBoundingClientRect();
  return {x:r.left+s.x, y:r.top+s.y};})()`);
const toastNow = () => evaluate(`String(__plan.toastText||"")`);
const selectFacade = async () => {
  const m = await J(`(function(){var w=__plan.plan.walls.find(function(x){return x.isOutline});return{x:(w.a[0]+w.b[0])/2,y:(w.a[1]+w.b[1])/2,id:String(w.id)}})()`);
  const p = await aptPoint(m.x, m.y); await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 }); await pause(120);
  const h = await centerOf(`.v5wmove[data-w="${m.id}"]`); if (h) await click(h); await pause(120);
};
// Canonical fingerprint of the plan: everything that must stay identical when we only LOOK.
const empreinte = () => evaluate(`(function(){var P=__plan.plan; return JSON.stringify({
  o:P.outline, w:P.walls.map(function(w){return [String(w.id),w.a,w.b];}),
  c:(P.cells||[]).length, g:(P.openings||[]).map(function(o){return [String(o.id),String(o.wallId),o.t0,o.w];}),
  p:P.pieces.map(function(p){return [String(p.id),p.x,p.y,p.w,p.h,p.rot||0];})});})()`);
const pose = (id: string) => J(`__plan.pieceAt(${JSON.stringify(id)})`);
const pieceRect = (id: string) => J(`(function(){var e=document.querySelector('#canvas .piece[data-id="'+${JSON.stringify(id)}+'"]');
  if(!e) return null; var r=e.getBoundingClientRect();
  return {x:r.left+r.width/2, y:r.top+r.height/2, w:r.width, h:r.height};})()`);

// =============================================================================
//  1. selection_facade_ne_modifie_rien
// =============================================================================
// A CLICK on the real plan's left facade cut the wall in two, added a vertex to the outline,
// lengthened a kitchen partition by 90 cm, took the apartment from 10 to 11 rooms, moved 16
// pieces of furniture and 3 openings, without a word. The corner-insertion "+" covered the exact
// center of every facade, and the insertion triggered a global recalculation.
await test("selection_facade_ne_modifie_rien", async () => {
  await selectFacade();
  const avant = await empreinte();
  const bandes = await J(`[].slice.call(document.querySelectorAll(".v5layer .edge")).map(function(e){
    var r=e.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2};})`);
  ok(bandes.length >= 3, "aucune bande de façade à cliquer");
  for (const b of bandes) {
    await click(b);
    await pause(120);
    ok((await empreinte()) === avant, `un clic sur une façade a modifié le plan (${JSON.stringify(b)})`);
    ok(await evaluate(`String(!!__plan.v5ui.selWall)`) === "true", "la façade cliquée doit être sélectionnée");
  }
  // The "+" is no longer on the facade: the middle point belongs to the strip.
  const promesses = await J(`__plan.midHandlePoints()`);
  ok(promesses.every((p: VerdictSonde) => !/(^|\s)mid(\s|$)/.test(p.at || "")),
    "le « + » recouvre encore le centre d'une façade : " + JSON.stringify(promesses.map((p: VerdictSonde) => p.at)));
});

// =============================================================================
//  2. outil_arme_ne_deforme_aucun_mur
// =============================================================================
// With the "trace a wall" tool armed, a simple CLICK (not a drag) on a facade created nothing
// but lengthened a partition by 90 cm three meters away: the capture-phase listener only
// intercepted the "+", not the facade strip, and a click on the strip triggered a
// v5AfterGeometry(true), hence a re-traversal of every wall.
await test("outil_arme_ne_deforme_aucun_mur", async () => {
  await selectFacade();
  const avant = await empreinte();
  if (!ok(await evaluate(`String(!document.getElementById("btnDrawWall").hidden)`) === "true",
    "le bouton de tracé est masqué")) return;
  const cibles = await J(`[].slice.call(document.querySelectorAll(".v5layer .edge,.v5layer .mid,.v5layer .vtx"))
    .map(function(e){ var r=e.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}; }).slice(0,8)`);
  // THE TOOL NOW STAYS ARMED ACROSS WALLS (2026-08-14, AGENTS.md "the tool disarms after every
  // wall"): arming it ONCE before the loop is the real usage now. Re-clicking the button on every
  // iteration, as this test used to, would DISARM it instead of "(re)arming" it, and the second
  // iteration onward would exercise ordinary handle clicks rather than the armed-tool path this
  // test is named for.
  await click(await centerOf("#btnDrawWall"));
  if (await evaluate(`String(__plan.v5ui.draw)`) !== "true") { ok(false, "l'outil ne s'arme pas"); return; }
  for (const c of cibles) {
    ok(await evaluate(`String(__plan.v5ui.draw)`) === "true", "l'outil de tracé s'est désarmé tout seul entre deux cibles");
    await click(c);
    await pause(150);
    ok((await empreinte()) === avant,
      `outil armé : un simple clic en ${JSON.stringify(c)} a modifié le plan`);
  }
});

// =============================================================================
//  3. mur_supprime_se_retrace
// =============================================================================
// The trace's snap was expressed in pixels: at "Fit" zoom it was worth ~18 cm in apartment
// coordinates and jumped clean over the real gap between two parallel partitions. Deleting one
// and retracing it became impossible: the stroke stuck to the other one and the duplicate
// refusal said "this partition is already there".
await test("mur_supprime_se_retrace", async () => {
  const w = await J(`(function(){var x=__plan.plan.walls.filter(function(w){return !w.isOutline;})[0];
    return {id:String(x.id), a:x.a, b:x.b};})()`);
  if (!ok(w, "aucune cloison intérieure dans le gabarit")) return;
  const n0 = await J(`__plan.plan.walls.length`);
  await evaluate(`__plan.delWall(${JSON.stringify(w.id)})`);
  await pause(250);
  ok(await J(`__plan.plan.walls.length`) === n0 - 1, "la cloison n'a pas été supprimée");
  // we retrace it EXACTLY at the same coordinates, with the mouse, tool armed
  await click(await centerOf("#btnDrawWall"));
  ok(await evaluate(`String(__plan.v5ui.draw)`) === "true", "l'outil de tracé ne s'arme pas");
  await drag(await aptPoint(w.a[0], w.a[1]), await aptPoint(w.b[0], w.b[1]), 20);
  await pause(300);
  // CE QUI COMPTE EST QUE LA CLOISON SOIT REVENUE, PAS LE COMPTE. Depuis qu'un T coupe la barre
  // qu'il touche, retracer une cloison entre deux murs peut aussi couper l'un d'eux, donc le total
  // grandit de plus d'un. On verifie donc la seule chose que ce cas a toujours voulu dire: un mur
  // occupe de nouveau exactement ce segment.
  const n1 = await J(`__plan.plan.walls.length`);
  const revenu = await J(`(function(){var A=${JSON.stringify(w.a)}, B=${JSON.stringify(w.b)};
    return __plan.plan.walls.some(function(x){
      var ok1 = Math.hypot(x.a[0]-A[0],x.a[1]-A[1]) < 3 && Math.hypot(x.b[0]-B[0],x.b[1]-B[1]) < 3;
      var ok2 = Math.hypot(x.a[0]-B[0],x.a[1]-B[1]) < 3 && Math.hypot(x.b[0]-A[0],x.b[1]-A[1]) < 3;
      return ok1 || ok2; });})()`);
  ok(revenu, `retracer la cloison au même endroit doit la recréer (${n0 - 1} -> ${n1} murs, toast « ${await toastNow()} »)`);
});

// =============================================================================
//  4. porte_garde_sa_largeur
// =============================================================================
// Dragging an 80 cm door onto a 43 cm wall shaved it down to 43, and bringing it back home never
// gave it back its 80 cm: the desired width no longer existed anywhere. Since the server refuses
// any unknown key, we can't stash it on the side: we REFUSE the drop, and we say so.
await test("porte_garde_sa_largeur", async () => {
  const op = await J(`(function(){var o=(__plan.plan.openings||[]).filter(function(o){
      return o.type==="door"||o.type==="window";}).sort(function(a,b){return b.w-a.w;})[0];
    return o?{id:String(o.id), w:o.w, wallId:String(o.wallId)}:null;})()`);
  if (!ok(op, "aucune ouverture dans le gabarit")) return;
  // the SHORTEST wall in the plan, strictly shorter than the opening
  const court = await J(`(function(){var s=__plan.plan.walls.map(function(w){
      return {id:String(w.id), L:Math.hypot(w.b[0]-w.a[0],w.b[1]-w.a[1]),
              cx:(w.a[0]+w.b[0])/2, cy:(w.a[1]+w.b[1])/2};})
    .filter(function(m){return m.L < ${op.w};}).sort(function(a,b){return a.L-b.L;})[0];
    return s||null;})()`);
  if (!ok(court, `aucun mur plus court que ${op.w} cm dans le gabarit`)) return;
  const b0 = await J(`__plan.v5OpeningPose(${JSON.stringify(op.id)})`);
  await drag(await aptPoint(b0.cx, b0.cy), await aptPoint(court.cx, court.cy), 22);
  await pause(250);
  const apres = await J(`(function(){var o=__plan.v5OpeningById(${JSON.stringify(op.id)});
    return {w:o.w, wallId:String(o.wallId)};})()`);
  ok(apres.w === op.w, `la largeur voulue doit survivre au dépôt (${op.w} -> ${apres.w} cm)`);
  ok(apres.wallId !== court.id, `le dépôt sur un mur de ${Math.round(court.L)} cm doit être refusé`);
  ok(/too short/i.test(await toastNow()), "le refus doit être DIT à l'écran, message vu : « " + (await toastNow()) + " »");
});

// =============================================================================
//  5. aller_retour_revient_au_depart
// =============================================================================
// The snap rounded the ABSOLUTE position on a 5 cm grid: furniture off the grid (converted plan)
// got shifted away on the very first gesture and its original spot became unreachable.
// The grid now counts STEPS from the gesture's starting point.
await test("aller_retour_revient_au_depart", async () => {
  const ids = await J(`__plan.plan.pieces.filter(function(p){return !p.locked && p.type!=="chair"
    && !__plan.isWallMount(p.type);}).slice(0,8).map(function(p){return String(p.id);})`);
  if (!ok(ids.length >= 3, "pas assez de meubles dans le gabarit")) return;
  let exacts = 0, total = 0;
  for (const id of ids) {
    const A = await pieceRect(id); if (!A) continue;
    const av = await pose(id);
    await drag({ x: A.x, y: A.y }, { x: A.x + 90, y: A.y + 60 }, 18);
    const mid = await pieceRect(id);
    if (!mid || (await pose(id)).cx === av.cx && (await pose(id)).cy === av.cy) continue;
    await drag({ x: mid.x, y: mid.y }, { x: A.x, y: A.y }, 18);
    const ap = await pose(id);
    total++;
    if (ap.cx === av.cx && ap.cy === av.cy) exacts++;
    else cur.fails.push(`aller-retour inexact pour ${id} : ${av.cx},${av.cy} -> ${ap.cx},${ap.cy}`);
  }
  ok(total >= 3, "trop peu de meubles réellement déplaçables : " + total);
  ok(exacts === total, `retour exact attendu partout : ${exacts}/${total}`);
});

// =============================================================================
//  6. objets_superposes_atteignables
// =============================================================================
// The real plan contains two sconces exactly overlapping, and stacking is normal (a hob on a
// counter, a rug under a sofa). The one on top got 100% of clicks: believing they were regrabbing
// something, the tester moved a washing machine 74 cm without noticing.
await test("objets_superposes_atteignables", async () => {
  // we stack two pieces of furniture at the same point, then click twice at the same spot
  const a = await J(`__plan.addRoomPiece("chair", 150, 150)`);
  const b = await J(`__plan.addRoomPiece("chair", 150, 150)`);
  if (!ok(a && b, "impossible d'empiler deux meubles")) return;
  await evaluate(`__plan.clearSel(); __plan.render(); true`);
  await pause(120);
  const pt = await pieceRect(String(b.id));
  if (!ok(pt, "le meuble empilé n'est pas rendu")) return;
  await click(pt); await pause(120);
  const sel1 = await evaluate(`String(__plan.selId)`);
  await click(pt); await pause(120);
  const sel2 = await evaluate(`String(__plan.selId)`);
  ok(sel1 !== sel2, `recliquer au même endroit doit descendre d'un cran (${sel1} puis ${sel2})`);
  ok(/objects here/i.test(await toastNow()), "la pile doit être ANNONCÉE, message vu : « " + (await toastNow()) + " »");
});

// =============================================================================
//  7. petit_objet_se_deplace
// =============================================================================
// A 45x50 cm chair measures ~29 px at the opening zoom. Its eight resize handles covered its own
// thumbnail: aiming at its center to MOVE it grabbed a handle instead. Below the threshold, only
// the four corners remain, moved outside the box.
await test("petit_objet_se_deplace", async () => {
  const p = await J(`__plan.addRoomPiece("chair", 200, 200)`);
  if (!ok(p, "impossible de poser une chaise")) return;
  const id = String(p.id);
  for (const zoom of [1, 0.6, 0.35]) {
    await evaluate(`__plan.setZoom ? __plan.setZoom(${zoom}) : (function(){ __plan.fitView(); return 1; })()`);
    await evaluate(`__plan.selReplace(${JSON.stringify(id)}); __plan.render(); true`);
    await pause(150);
    const r = await pieceRect(id);
    if (!ok(r, "chaise non rendue")) continue;
    const sous = await evaluate(`String((document.elementFromPoint(${r.x},${r.y})||{}).className||"")`);
    ok(!/rsz-handle|rot-handle/.test(sous),
      `vignette ${Math.round(r.w)}x${Math.round(r.h)} px : le centre est recouvert par « ${sous} »`);
    const av = await pose(id);
    await drag({ x: r.x, y: r.y }, { x: r.x + 40, y: r.y + 30 }, 12);
    await pause(150);
    const ap = await pose(id);
    ok(ap.cx !== av.cx || ap.cy !== av.cy,
      `vignette ${Math.round(r.w)}x${Math.round(r.h)} px : la chaise n'a pas bougé`);
    const dim = await J(`(function(){var q=__plan.plan.pieces.find(function(z){return String(z.id)===${JSON.stringify(id)};});
      return {w:q.w,h:q.h};})()`);
    ok(dim.w === 45 && dim.h === 50,
      `vignette ${Math.round(r.w)}x${Math.round(r.h)} px : la chaise a été REDIMENSIONNÉE (${dim.w}x${dim.h})`);
  }
  // a large piece of furniture keeps its eight handles
  const g = await J(`__plan.addRoomPiece("sofa3", 260, 260)`);
  await evaluate(`__plan.fitView(); __plan.selReplace(${JSON.stringify(String(g.id))}); __plan.render(); true`);
  await pause(150);
  const rg = await pieceRect(String(g.id));
  const n = await J(`__plan.rszHandleCount(${JSON.stringify(String(g.id))})`);
  ok(n === (Math.min(rg.w, rg.h) < 64 ? 4 : 8),
    `un meuble de ${Math.round(rg.w)}x${Math.round(rg.h)} px doit garder ses poignées, vu ${n}`);
});

// =============================================================================
//  8. meme_message_pas_huit_fois
// =============================================================================
// 22 banners in 371 s, 8 of them "Rug 17 is bigger than the room". A warning repeated eight
// times no longer informs, it drowns out the others.
await test("meme_message_pas_huit_fois", async () => {
  const n = await J(`(function(){var vus=0;
    for(var i=0;i<8;i++){ if(__plan.emitToast("Le même message")) vus++; }
    return vus;})()`);
  ok(n === 1, `huit émissions du MÊME message doivent donner un seul bandeau, vu ${n}`);
  const m = await J(`(function(){var vus=0;
    for(var i=0;i<4;i++){ if(__plan.emitToast("Message "+i)) vus++; }
    return vus;})()`);
  ok(m === 4, `quatre messages DIFFÉRENTS doivent tous passer, vu ${m}`);
});

// =============================================================================
//  9. facade_refuse_sa_suppression
// =============================================================================
// A facade is DERIVED from the outline: deleting it would take its windows with it and leave
// the wall standing. The interface already refused, but silently, and the room card still
// offered a red "Delete wall" button.
await test("facade_refuse_sa_suppression", async () => {
  const f = await J(`(function(){var w=__plan.plan.walls.filter(function(w){return w.isOutline;})[0];
    return w?String(w.id):null;})()`);
  if (!ok(f, "aucun mur de façade")) return;
  ok(await J(`__plan.canDeleteWall(${JSON.stringify(f)})`) === false,
    "le modèle doit refuser la suppression d'une façade");
  const n0 = await J(`__plan.plan.walls.length`);
  const o0 = await J(`(__plan.plan.openings||[]).length`);
  await evaluate(`__plan.delWall(${JSON.stringify(f)})`);
  await pause(200);
  ok(await J(`__plan.plan.walls.length`) === n0, "une façade ne doit pas disparaître");
  ok(await J(`(__plan.plan.openings||[]).length`) === o0, "ses ouvertures ne doivent pas disparaître");
  ok(/facade/i.test(await toastNow()), "le refus doit être DIT, message vu : « " + (await toastNow()) + " »");
  // and the room card doesn't offer an impossible action
  const del = await J(`(function(){var b=document.getElementById("rcDel");
    return {cardHidden:document.getElementById("roomCard").hidden,hidden:!!b.hidden, disabled:!!b.disabled, txt:String(b.textContent||"")};})()`);
  ok(del.cardHidden || del.hidden || del.disabled, "le bouton « Supprimer le mur » ne doit pas être actionnable sur une façade");
});

// =============================================================================
//  10. geste_sans_effet_dit_pourquoi
// =============================================================================
// The bound keeps furniture in ITS cell. Placed against the wall, a LONG drag leaves it EXACTLY
// where it was: measured on the real plan, a 45x50 cm chair didn't move by a single centimeter,
// four drags in a row, in total silence. Nothing said the space was missing, so the user kept
// trying. And since the gesture is deliberate, the message comes back on EVERY attempt.
await test("geste_sans_effet_dit_pourquoi", async () => {
  await evaluate(`__plan.fitView(); true`); await pause(150);
  const p = await J(`__plan.addRoomPiece("chair", 200, 200)`);
  if (!ok(p, "impossible de poser une chaise")) return;
  const id = String(p.id);
  // we first push it AGAINST the edge, then insist: the following attempts change nothing
  const dits = [];
  let bloque = 0;
  for (let k = 0; k < 6; k++) {
    await evaluate(`__plan.selReplace(${JSON.stringify(id)}); __plan.render(); true`);
    await pause(120);
    const r = await pieceRect(id);
    if (!r) break;
    await evaluate(`__plan.clearToast(); true`);
    const av = await pose(id);
    await drag({ x: r.x, y: r.y }, { x: r.x - 260, y: r.y - 180 }, 14);
    await pause(220);
    const ap = await pose(id);
    const fige = (ap.cx === av.cx && ap.cy === av.cy);
    // ON ATTEND LE BANDEAU, PAS UNE DURÉE. Ce cas lisait le message juste après une pause fixe de
    // 220 ms et voyait « » sous barrière chargée, où tout est trois fois plus lent : le geste
    // était bien refusé, la phrase n'était simplement pas encore peinte. Allonger la pause ne
    // ferait que déplacer le seuil (AGENTS.md, « attendre une CONDITION, jamais une durée »).
    if (fige) {
      bloque++;
      let dit = "";
      for (let i = 0; i < 60 && !dit; i++) { dit = String((await toastNow()) || ""); if (!dit) await pause(50); }
      dits.push(dit);
    }
  }
  ok(bloque >= 2, `le geste doit finir par ne plus rien changer (bloqué ${bloque} fois sur 6)`);
  // THREE LEGITIMATE EXPLANATIONS, NOT TWO. G-13 requires that a gesture with no effect SAY WHY;
  // it does not require which of the reasons. Since the bound places the object AGAINST the
  // limit instead of catapulting it there, a chair dragged far outside the room comes back "as
  // close as possible", which is the third message, and the most accurate of the three in this
  // case. The assertion only listed two and so turned an improvement red.
  ok(dits.length && dits.every(t => /any further|sticks out|as close as possible/i.test(t || "")),
    "chaque geste sans effet doit dire pourquoi, messages vus : " + JSON.stringify(dits));
});

// =============================================================================
//  11. clic_net_sur_un_groupe_ne_borne_personne
// =============================================================================
// G-4 HAD NEVER BEEN CARRIED OVER TO THE GROUP. The solo branch of `gestes/meuble.ts` keeps its
// end-of-gesture bound behind `moved` ("picking furniture up doesn't move it"); the GROUP branch
// called `v5ClampPiece` on ALL its members on every `pointerup`, including on a clean click. A
// lasso grabs 5 to 11 objects on a real plan: a single click bounded all of them at once, and
// converted furniture (straddling a wall, overflowing a facade) is precisely what the bound moves.
await test("clic_net_sur_un_groupe_ne_borne_personne", async () => {
  // a lasso over a dense area, then a CLEAN click on a member: nothing must move
  const bb = await J(`(function(){var xs=[],ys=[];(__plan.plan.outline||[]).forEach(function(p){xs.push(p[0]);ys.push(p[1]);});
    return {minX:Math.min.apply(null,xs), maxX:Math.max.apply(null,xs), minY:Math.min.apply(null,ys), maxY:Math.max.apply(null,ys)};})()`);
  const a = await aptPoint(bb.minX + 5, bb.minY + 5);
  const b = await aptPoint(bb.maxX - 5, bb.maxY - 5);
  await evaluate(`__plan.clearSel(); __plan.render(); true`); await pause(120);
  // THE LASSO NOW LIVES UNDER SHIFT. An ordinary drag over empty space draws a wall, because
  // drawing is no longer a mode you can be stranded in. `modifiers: 8` is Shift for CDP, and it
  // must be on every event of the gesture, not only the press: the handler reads the modifier of
  // the event it is given.
  await M("mouseMoved", a.x, a.y, { button: "none", buttons: 0, modifiers: 8 });
  await M("mousePressed", a.x, a.y, { modifiers: 8 });
  for (let i = 1; i <= 12; i++) {
    await M("mouseMoved", a.x + (b.x - a.x) * i / 12, a.y + (b.y - a.y) * i / 12, { modifiers: 8 });
    await pause(8);
  }
  await M("mouseReleased", b.x, b.y, { buttons: 0, modifiers: 8 }); await pause(90);
  const sel = await J(`[].slice.call(document.querySelectorAll(".piece.sel")).map(function(e){return String(e.dataset.id);})`);
  ok(sel.length >= 3, `le lasso doit prendre plusieurs objets (${sel.length})`);
  if (sel.length < 3) return;

  const avant = await J(`(function(){var o={};__plan.plan.pieces.forEach(function(p){o[String(p.id)]=[p.x,p.y];});return o;})()`);
  const undoAvant = await evaluate(`String(__plan.histInfo().undo)`);
  // we click AT THE CENTER of a member, with zero movement
  const cible = await J(`(function(){var r=null;
    __plan.plan.pieces.forEach(function(p){ if(!r && ${JSON.stringify(sel)}.indexOf(String(p.id))>=0) r={id:String(p.id),x:p.x+p.w/2,y:p.y+p.h/2}; });
    return r;})()`);
  ok(!!cible, "un membre du groupe doit être cliquable");
  if (!cible) return;
  await click(await aptPoint(cible.x, cible.y)); await pause(150);

  const apres = await J(`(function(){var o={};__plan.plan.pieces.forEach(function(p){o[String(p.id)]=[p.x,p.y];});return o;})()`);
  const bouges = [];
  for (const id of Object.keys(avant)) {
    const p = avant[id], q = apres[id];
    if (!q) continue;
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d > 0.5) bouges.push(`${id} de ${d.toFixed(1)} cm`);
  }
  ok(bouges.length === 0, `un clic NET sur un groupe a déplacé ${bouges.length} objet(s) : ${bouges.slice(0, 6).join(", ")}`);
  ok((await evaluate(`String(__plan.histInfo().undo)`)) === undoAvant, "et il n'écrit rien dans l'historique (G-3)");
});

// =============================================================================
//  12. applique_glissee_le_long_du_mur_revient
// =============================================================================
// SAME ROOT AS THE OPENING HANDLE: the position is ABSOLUTE, the grab isn't remembered.
// `v5MoveOpeningTo` sets `op.t0 = tc - op.w/2`, meaning it RECENTERS the object under the
// cursor. Grabbing a sconce by its edge therefore makes it jump under the hand, and above all
// the return reproduces the CURSOR, not `t0`: the residual gap equals the difference between
// the stored integer `t0` and the grab pixel converted to cm. Measured in real usage: 57 exact
// round trips out of 73, fourteen of the sixteen gaps under 0.6 cm. At the bench on the real
// plan, OFF-CENTER grab: 11/57.
//
// This case deliberately grabs the object OFF its center, which no suite did: grabbed dead
// center, the defect is invisible.
await test("applique_glissee_le_long_du_mur_revient", async () => {
  const murs = await J(`(function(){var o={};__plan.plan.openings.forEach(function(q){
    o[String(q.wallId)] = (o[String(q.wallId)]||0)+1;}); return o;})()`);
  // We take a wall-mounted object ALONE on its wall: anti-overlap alignment (which settles the
  // side using the DIRECTION of the last movement) is a completely different mechanism, measured
  // separately.
  const cibles = await J(`__plan.plan.openings
    .filter(function(q){return (q.type==="sconce"||q.type==="plug"||q.type==="rj45")
      && ${JSON.stringify(murs)}[String(q.wallId)] === 1;})
    .slice(0,4).map(function(q){return {id:String(q.id), nom:q.name||q.type};})`);
  ok(cibles.length >= 1, `le plan de référence doit porter un objet mural seul sur son mur (${cibles.length})`);

  const geo = (id: string) => J(`(function(){
    var o=__plan.v5OpeningById(${JSON.stringify(String(id))}); if(!o) return null;
    var w=__plan.v5WallById(o.wallId); if(!w) return null;
    var L=Math.hypot(w.b[0]-w.a[0], w.b[1]-w.a[1])||1;
    var ux=(w.b[0]-w.a[0])/L, uy=(w.b[1]-w.a[1])/L, t=o.t0+o.w/2;
    return {t0:o.t0, w:o.w, wallId:String(o.wallId), cx:w.a[0]+ux*t, cy:w.a[1]+uy*t, ux:ux, uy:uy};})()`);
  const S = await evaluate(`__plan.vScale`);
  const mauvais = [];
  for (const c of cibles) {
    const g0 = await geo(c.id); if (!g0) continue;
    // OFF-CENTER GRAB: one third of the width from the center, like a real hand.
    const f = g0.w / 3;
    const dep = await aptPoint(g0.cx + g0.ux * f, g0.cy + g0.uy * f);
    const D = 24;                                        // cm along the wall
    await drag(dep, { x: dep.x + g0.ux * D * S, y: dep.y + g0.uy * D * S }, 10);
    const g1 = await geo(c.id); if (!g1) continue;
    // return: we start again from the SAME relative point of the box, and set it back at the starting pixel
    const dep2 = await aptPoint(g1.cx + g1.ux * f, g1.cy + g1.uy * f);
    await drag(dep2, dep, 10);
    const g2 = await geo(c.id); if (!g2) continue;
    if (String(g2.wallId) !== String(g0.wallId)) { mauvais.push(`« ${c.nom} » a changé de mur`); continue; }
    if (Math.abs(g2.t0 - g0.t0) > 0.05) {
      mauvais.push(`« ${c.nom} » ne revient pas : t0 ${g0.t0} -> [${g1.t0}] -> ${g2.t0} (RÉSIDU ${(g2.t0 - g0.t0).toFixed(2)} cm)`);
    }
  }
  ok(mauvais.length === 0, mauvais.join(" | "));
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
