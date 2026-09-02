#!/usr/bin/env node
// =============================================================================
//  INTERFACE GUARDRAILS: REAL MOUSE, REAL KEYBOARD, REAL HIT-TESTING (CDP)
// =============================================================================
// Two real-usage sessions made the same complaint: "nothing ever tells me when something has
// gone wrong". Each case below was born from an observed defect, and checks BOTH halves: the
// application does not do the bad thing, AND it says so.
//
//   node tests/garde-fous.ts [path/to/app.html]
//
//   champs_de_dimension        clearing / typing letters / 1 / -50 / 3000 placed the furniture at
//                              5 or 10 cm silently; three bounds contradicted each other
//   assistant_ne_ment_pas      the form showed 5 x 4000 and built 100 x 3000
//   hidden_veut_dire_cache     two blocks marked `hidden` still got painted (class rule)
//   panneaux_jamais_superposes the room card covered Width, Depth and the 4 actions
//   fiche_suit_le_plan         the card showed a stale area, sometimes of a merged room
//   surfaces_au_meme_format    "15.1 m2", "15,12 m2" and "SURFACE 15,12 M2" for the same number
//   menu_toujours_atteignable  the only access to Save was at y=2999 in a window of 849
//   recadrage_au_redimension   the plan ran off screen on rotation, with nothing to say so
//   stockage_refuse_le_dit     the write exception was swallowed: no banner, no chip
//   profondeur_bornee_par_le_mur  "Depth" accepted 200 on a 10 cm wall, silently, and
//                              painted a 2 m white hole through both rooms
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-garde-"));
const APP_SRC = fs.readFileSync(APP, "utf8");
const mkPage = (name: string, seed: VerdictSonde) => {
  const p = path.join(dir, name + ".html");
  fs.writeFileSync(p,
    `<!doctype html><html><head><meta charset="utf-8"><script>
window.__PLAN_TEST__=1;
try{ localStorage.clear(); ${seed ? `localStorage.setItem("room-planner-v4", ${JSON.stringify(JSON.stringify(seed))});` : ""} }catch(e){}
<\/script></head><body>` + APP_SRC + "</body></html>", "utf8");
  return "file:///" + p.replace(/\\/g, "/");
};
const URL_SEEDED = mkPage("seeded", SEED);
const URL_BLANK = mkPage("blank", null);
// Walls-only plan built for ONE question: the depth of an opening against the thickness of its
// wall. Two partitions of DIFFERENT thicknesses (10 and 24 cm), one window on each, so that
// the field's bound has to change from one selection to the next.
const URL_MURS_MINCES = mkPage("murs-minces", {
  model: "v5", setupDone: true,
  plan: {
    outline: [[0, 0], [600, 0], [600, 300], [0, 300]],
    walls: [{ id: "wmince", a: [200, 0], b: [200, 300], t: 10, isOutline: false },
            { id: "wepais", a: [400, 0], b: [400, 300], t: 24, isOutline: false }],
    openings: [{ id: "oMince", wallId: "wmince", t0: 110, w: 80, h: 10, type: "window", side: 0, name: "Fenetre mince" },
               { id: "oEpais", wallId: "wepais", t0: 110, w: 80, h: 24, type: "window", side: 0, name: "Fenetre epaisse" }],
    pieces: [], cells: [],
  },
});

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
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
await send("Page.enable");
await send("Runtime.enable");

async function goTo(url: string) {
  await send("Page.navigate", { url });
  for (let i = 0; i < 250; i++) {
    let st = null;
    try { st = await evaluate("document.readyState + '|' + (window.__plan ? 1 : 0)"); } catch (_) {}
    if (st === "complete|1") break;
    await pause(50);
  }
  await pause(350);
}
async function viewport(w: VerdictSonde, h: number, mobile: VerdictSonde) {
  await send("Emulation.setDeviceMetricsOverride",
    { width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile, screenWidth: w, screenHeight: h,
      screenOrientation: { type: w > h ? "landscapePrimary" : "portraitPrimary", angle: w > h ? 90 : 0 } });
  await pause(300);
}
const clearViewport = () => send("Emulation.clearDeviceMetricsOverride");

// ---- REAL mouse / REAL keyboard ---------------------------------------------------------------
const M = (type: string, x: VerdictSonde, y: VerdictSonde, extra?: Record<string, unknown>) => send("Input.dispatchMouseEvent", Object.assign({
  type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1,
  clickCount: 1, pointerType: "mouse",
}, extra || {}));
async function click(p: VerdictSonde) {
  await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 });
  await M("mousePressed", p.x, p.y); await M("mouseReleased", p.x, p.y); await pause(60);
}
async function drag(from: VerdictSonde, to: VerdictSonde, steps = 12) {
  await M("mouseMoved", from.x, from.y, { button: "none", buttons: 0 });
  await M("mousePressed", from.x, from.y);
  for (let i = 1; i <= steps; i++) {
    await M("mouseMoved", from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
    await pause(8);
  }
  await M("mouseReleased", to.x, to.y); await pause(80);
}
async function wheel(p: VerdictSonde, dy: number) {
  await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 });
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, deltaX: 0, deltaY: dy,
    button: "none", buttons: 0, pointerType: "mouse" });
  await pause(40);
}
// ---- VERIFIED KEYBOARD INPUT -------------------------------------------------------------------
// `numField` (js/00) only applies a value after a 220 ms TYPING PAUSE, on purpose: typing
// "3000" must not commit 3, then 30, then 300 along the way. The instrument itself used to wait
// for a full CDP round trip BETWEEN TWO KEYSTROKES: under load (8 suites in parallel, low
// priority) that round trip exceeds 220 ms, the intermediate value gets COMMITTED, and the input
// is TRUNCATED, "9999" left only "99", "200" only "2". The case then believed it was measuring a
// bound. Two fixes, inseparable:
//   1. keystrokes go out IN A BURST, with no round trip between them: the browser processes
//      them back to back and the typing pause can no longer slip in between;
//   2. the input is READ BACK: when the caller says what value the field must carry once the
//      input has settled, we check it, put the field back in its starting state and START OVER
//      as long as it isn't there, and end up SAYING what the field actually carried.
async function frapper(s: VerdictSonde) {
  const envois = [];
  for (const ch of s) {
    envois.push(send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, key: ch }));
    envois.push(send("Input.dispatchKeyEvent", { type: "keyUp", key: ch }));
  }
  await Promise.all(envois);
}
const valeurDuChampVise = () => evaluate(`(function(){var e=document.activeElement;
  return (e && "value" in e) ? String(e.value) : null;})()`);
// opt.attendu  : the value the field MUST carry once the input has settled (numField can rewrite
//                it itself: a refusal hands control back to the last valid value).
// opt.remettre : how to put the field back in its STARTING state before starting over (a
//                truncated input has already committed a value: retyping without resetting
//                would measure something else).
async function typeText(s: VerdictSonde, opt?: VerdictSonde) {
  const o = opt || {};
  for (let essai = 1; ; essai++) {
    await frapper(s);
    await pause(340);   // > numField's typing pause (220 ms): the value has had time to settle
    if (o.attendu == null) return;
    const vu = await valeurDuChampVise();
    if (vu === o.attendu) return;
    if (essai >= 5) {
      ok(false, `saisie « ${s} » : après ${essai} tentatives le champ porte ${JSON.stringify(vu)} `
        + `au lieu de ${JSON.stringify(o.attendu)} (saisie tronquée par la charge, ou le client ne `
        + `réagit plus comme attendu à cette valeur)`);
      return;
    }
    if (o.remettre) await o.remettre(); else await selectAll();
  }
}
async function selectAll() {
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  await pause(20);
}
async function blurField() {
  await evaluate(`document.activeElement && document.activeElement.blur()`); await pause(120);
}
const centerOf = (sel: VerdictSonde) => J(`(function(){var e=document.querySelector(${JSON.stringify(sel)});
  if(!e) return null; var r=e.getBoundingClientRect(); if(!r.width) return null;
  return {x:r.left+r.width/2, y:r.top+r.height/2, w:Math.round(r.width), h:Math.round(r.height)};})()`);
const aptPoint = (x: VerdictSonde, y: VerdictSonde) => J(`(function(){var s=__plan.aptToScreen(${x},${y});
  var r=document.getElementById("viewport").getBoundingClientRect();
  return {x:r.left+s.x, y:r.top+s.y};})()`);
// Does the text visible on screen contain enough to understand what was just refused?
const screenSays = (re: VerdictSonde) => J(`${re}.test(document.body.innerText)`);

// ---- micro-harness -----------------------------------------------------------------------------
const results: VerdictSonde[] = [];
let cur: VerdictSonde = null;
function ok(cond: unknown, msg?: string) { if (!cond) cur.fails.push(msg); return !!cond; }
async function test(name: string, url: string, fn: (...args: VerdictSonde[]) => VerdictSonde | Promise<VerdictSonde>) {
  cur = { name, fails: [] };
  await clearViewport();
  await goTo(url);
  try { await fn(); } catch (e) { cur.fails.push("EXCEPTION: " + (e && e.message || e)); }
  const jsErr = await evaluate(`JSON.stringify((JSON.parse(localStorage.getItem("plan-errors")||"[]")||[]).map(function(e){return e&&e.msg}))`);
  if (jsErr && jsErr !== "[]") cur.fails.push("erreurs JS: " + jsErr);
  results.push(cur);
  console.log(`  ${cur.fails.length ? "FAIL " : "ok   "} ${name}`);
  cur.fails.forEach((f: VerdictSonde) => console.log("        - " + f));
}

// =============================================================================
//  1. champs_de_dimension
// =============================================================================
// On a 180 cm bed: typing text emptied the field and placed the furniture AT 10 CM silently;
// "1" displayed 1 and stored 5; "-50" displayed -50 and stored 5; "3000" went through a 12 m
// dwelling and the furniture ended up outside every cell. Three bounds contradicted each other:
// the HTML attribute (min=10), the JS clamp (5..3000) and the server validator (1..3000).
// The rule: NOTHING applies until the value is valid, and a refusal IS SEEN.
await test("champs_de_dimension", URL_SEEDED, async () => {
  const p = await J(`(function(){var P=__plan.state.plan,b=null;
    P.pieces.forEach(function(q){ if(!q.locked && !(__plan.TYPEMAP[q.type].opening||__plan.TYPEMAP[q.type].wallMount)
      && (!b||q.w*q.h>b.w*b.h)) b=q; });
    __plan.selReplace(String(b.id)); __plan.render(); __plan.openInspector();
    return {id:String(b.id), w:b.w, h:b.h, name:b.name};})()`);
  const champ = await centerOf("#iW");
  ok(champ, "le champ Largeur doit être visible");
  const lu = () => J(`({champ:document.getElementById("iW").value,
    plan:__plan.pieceById(${JSON.stringify(p.id)}).w,
    marque:(function(){var b=document.getElementById("iW").closest(".in");
      return b.classList.contains("bad")?"refus":(b.classList.contains("pending")?"attente":"");})()})`);

  // 1. an incomplete input ("1" before "180") applies NOTHING and it shows
  await click(champ); await selectAll(); await typeText("1");
  let e = await lu();
  ok(e.plan === p.w, `« 1 » ne doit RIEN appliquer : le plan est passé à ${e.plan} cm`);
  ok(e.marque === "attente", `« 1 » doit marquer le champ en attente, marque=${JSON.stringify(e.marque)}`);

  // 2. leaving the field on a too-small value: explicit REFUSAL + revert to the last value
  await blurField();
  e = await lu();
  ok(e.plan === p.w && String(e.champ) === String(p.w),
    `un départ sur « 1 » doit refuser et revenir à ${p.w} : écran=${e.champ} plan=${e.plan}`);
  ok(await screenSays("/between 10 and/i"), "le refus doit être DIT à l'écran (bornes en toutes lettres)");

  // Put WIDTH back in its starting state: an input truncated by load has already committed
  // an intermediate value, retyping over it would no longer measure the same thing.
  const remettreW = async () => {
    await evaluate(`(function(){var q=__plan.pieceById(${JSON.stringify(p.id)}); q.w=${p.w};
      __plan.save(); __plan.render(); __plan.selReplace(${JSON.stringify(p.id)}); __plan.openInspector();})(); true`);
    await pause(150);
    await click(await centerOf("#iW")); await selectAll();
  };

  // 3. a value definitively out of bounds is refused RIGHT AWAY, without waiting
  for (const bad of ["-50", "3000"]) {
    await click(champ); await selectAll();
    await typeText(bad, { attendu: String(p.w), remettre: remettreW });
    e = await lu();
    ok(e.plan === p.w, `« ${bad} » ne doit jamais atteindre le plan (plan=${e.plan})`);
    ok(String(e.champ) === String(p.w),
      `« ${bad} » doit rendre la main sur la dernière valeur valide, écran=${e.champ}`);
  }

  // 4. a valid value applies, as before
  await click(champ); await selectAll(); await typeText("160", { attendu: "160" });
  e = await lu();
  ok(e.plan === 160 && String(e.champ) === "160", `une valeur valide doit s'appliquer : ${JSON.stringify(e)}`);

  // 5. THE THREE BOUNDS SAY THE SAME THING: HTML attribute = applied bound = server bound.
  //    The upper bound follows the dwelling: furniture cannot be longer than the apartment.
  const bornes = await J(`(function(){var b=__plan.aptBBox();
    return {min:+document.getElementById("iW").min, max:+document.getElementById("iW").max,
            plusGrandCote:Math.round(Math.max(b.w,b.l))};})()`);
  ok(bornes.min === 10, "l'attribut min doit valoir 10 (le serveur accepte 1, on est plus strict)");
  ok(bornes.max === Math.min(3000, bornes.plusGrandCote),
    `l'attribut max doit suivre le logement (${bornes.plusGrandCote} cm), il vaut ${bornes.max}`);
  ok(bornes.max <= 3000, "et ne jamais dépasser la borne serveur PIECE_WH_MAX=3000");

  // 6. Depth follows the same rule (every field in the family, not just Width)
  const champH = await centerOf("#iH");
  const remettreH = async () => {
    await evaluate(`(function(){var q=__plan.pieceById(${JSON.stringify(p.id)}); q.h=${p.h};
      __plan.save(); __plan.render(); __plan.selReplace(${JSON.stringify(p.id)}); __plan.openInspector();})(); true`);
    await pause(150);
    await click(await centerOf("#iH")); await selectAll();
  };
  await click(champH); await selectAll();
  await typeText("9999", { attendu: String(p.h), remettre: remettreH });
  const eh = await J(`({champ:document.getElementById("iH").value,
    plan:__plan.pieceById(${JSON.stringify(p.id)}).h})`);
  ok(eh.plan === p.h && String(eh.champ) === String(p.h),
    `Profondeur doit refuser 9999 comme Largeur : ${JSON.stringify(eh)}`);
});

// =============================================================================
//  2. assistant_ne_ment_pas
// =============================================================================
// The form showed width 5 and length 4000, announced "30.0 m2", and the application built
// 100 x 3000. The values were clamped silently and the fields never updated to match.
await test("assistant_ne_ment_pas", URL_BLANK, async () => {
  ok(await J(`!document.getElementById("setup").hidden`), "l'assistant doit être ouvert sur une page vierge");
  await click(await centerOf("#suW")); await selectAll(); await typeText("5");
  await click(await centerOf("#suL")); await selectAll(); await typeText("4000");
  await blurField();
  const vu = await J(`({w:document.getElementById("suW").value, l:document.getElementById("suL").value,
                        aire:document.getElementById("setupArea").textContent})`);
  ok(await screenSays("/between 100 and 3000/i"), "les valeurs refusées doivent être DITES");
  await click(await centerOf("#setupStart"));
  const fait = await J(`(function(){var b=__plan.aptBBox();
    return {w:Math.round(b.w), l:Math.round(b.l)};})()`);
  ok(String(vu.w) === String(fait.w) && String(vu.l) === String(fait.l),
    `le formulaire doit dire ce que l'application fabrique : montré ${vu.w}×${vu.l}, fabriqué ${fait.w}×${fait.l}`);
  ok(fait.w >= 100 && fait.l >= 100 && fait.w <= 3000 && fait.l <= 3000,
    `un contour de logement plausible, pas un trait : ${fait.w}×${fait.l}`);
});

// =============================================================================
//  3. hidden_veut_dire_cache
// =============================================================================
// `[hidden]` (zero specificity) was beaten by a CLASS rule: "Notch width / depth" displayed on
// the Rectangle shape as soon as the wizard opened, and "From the corner", reserved for
// openings, was painted on the inspector of every ordinary piece of furniture.
// We check the CAUSE (no `[hidden]` painted, wherever it is), not the two symptoms.
await test("hidden_veut_dire_cache", URL_BLANK, async () => {
  const scan = () => J(`(function(){var out=[];
    document.querySelectorAll("[hidden]").forEach(function(e){
      if(getComputedStyle(e).display!=="none") out.push(e.id||e.className);});
    return out;})()`);
  let peints = await scan();
  ok(peints.length === 0, "assistant ouvert : éléments `hidden` pourtant peints " + JSON.stringify(peints));
  ok(await J(`getComputedStyle(document.getElementById("notchRow")).display==="none"`),
    "« Largeur de l'encoche » ne doit pas s'afficher sur la forme Rectangle");

  await click(await centerOf("#setupStart"));
  peints = await scan();
  ok(peints.length === 0, "plan ouvert : éléments `hidden` pourtant peints " + JSON.stringify(peints));

  // an ORDINARY piece of furniture: "From the corner" has no business there
  const id = await evaluate(`(function(){var p=__plan.addRoomPiece("sofa3",120,120);
    __plan.selReplace(String(p.id)); __plan.render(); __plan.openInspector(); return String(p.id);})()`);
  ok(id, "un meuble doit pouvoir être posé");
  const row = await J(`(function(){var e=document.getElementById("iWallRow");
    return {hidden:!!e.hidden, display:getComputedStyle(e).display,
            w:Math.round(e.getBoundingClientRect().width)};})()`);
  ok(row.hidden && row.display === "none" && row.w === 0,
    "« Depuis l'angle » est peint sur un meuble ordinaire : " + JSON.stringify(row));
  peints = await scan();
  ok(peints.length === 0, "inspecteur ouvert : éléments `hidden` pourtant peints " + JSON.stringify(peints));
});

// =============================================================================
//  4. panneaux_jamais_superposes
// =============================================================================
// The two panels were anchored to the same corner: the room card sat on top of the inspector
// and hid Width, Depth and the four action buttons (checked with `elementFromPoint`).
// And the card had no close button at all.
await test("panneaux_jamais_superposes", URL_SEEDED, async () => {
  for (const [nom, w, h] of ([["bureau 1680×1000", 1680, 1000], ["bureau 800×600", 800, 600],
                             ["iPhone portrait", 390, 844], ["iPhone paysage", 844, 390]] as [string, number, number][])) {
    await viewport(w, h, w < 900);
    await evaluate(`(function(){var P=__plan.state.plan;
      var p=P.pieces.filter(function(q){return !q.locked
        && !(__plan.TYPEMAP[q.type].opening||__plan.TYPEMAP[q.type].wallMount);})[0];
      __plan.selReplace(String(p.id)); __plan.render(); __plan.openInspector();
      __plan.selectCell(P.cells[0].id);
      document.getElementById("roomCard").hidden=false; })()`);
    await pause(250);
    const r = await J(`(function(){
      var i=document.getElementById("inspector"), c=document.getElementById("roomCard");
      var ri=i.getBoundingClientRect(), rc=c.getBoundingClientRect();
      var chevauche=!(ri.right<=rc.left||rc.right<=ri.left||ri.bottom<=rc.top||rc.bottom<=ri.top);
      var bloques=[];
      ["iW","iH","iDel","iDup","iLock","iRot90"].forEach(function(id){
        var e=document.getElementById(id); if(!e||e.hidden) return;
        var b=e.getBoundingClientRect(); if(b.width<1){ bloques.push(id+":invisible"); return; }
        var top=document.elementFromPoint(b.left+b.width/2, b.top+b.height/2);
        if(top!==e && !(top&&top.contains&&top.contains(e))) bloques.push(id+":recouvert");});
      return {ouverts:(!i.hidden&&!c.hidden), chevauche:chevauche, bloques:bloques};})()`);
    ok(r.ouverts, `[${nom}] les deux panneaux doivent être ouverts pour que le test ait un sens`);
    ok(!r.chevauche, `[${nom}] l'inspecteur et la fiche se recouvrent`);
    ok(r.bloques.length === 0, `[${nom}] champs ou actions inatteignables : ${JSON.stringify(r.bloques)}`);
  }
  await viewport(1680, 1000, false);
  // and the card closes VISIBLY
  const x = await centerOf("#rcClose");
  ok(x, "la fiche de pièce doit porter un bouton de fermeture visible");
  if (x) { await click(x); ok(await J(`document.getElementById("roomCard").hidden===true`), "la croix doit fermer la fiche"); }
});

// =============================================================================
//  5. fiche_suit_le_plan
// =============================================================================
// The card was only resynced by a SELECTION, never by a render: after moving a facade, the
// toolbar said 13.7 m2, the rail chip 13.7 m2 and the card 15.12 m2. Worse, after merging two
// cells it still showed a room that no longer existed.
await test("fiche_suit_le_plan", URL_BLANK, async () => {
  await click(await centerOf("#setupStart"));            // 420 x 360
  await click(await centerOf("#btnFit"));
  await click(await centerOf("#canvas .v5layer .ov-name"));
  const lu = () => J(`({barre:document.getElementById("areaChip").textContent,
    puce:(document.querySelector("#roomsList .room-chip .rc-area")||{}).textContent,
    fiche:document.getElementById("rcArea").textContent,
    nom:document.getElementById("rcName").value})`);
  const nombre = (s: VerdictSonde) => (String(s).match(/(\d+),(\d+)\s*m²/) || [])[0] || null;
  const avant = await lu();
  ok(nombre(avant.fiche) && nombre(avant.fiche) === nombre(avant.puce),
    "au départ déjà, les trois surfaces doivent coïncider : " + JSON.stringify(avant));

  // pull the top facade downward: the area CHANGES
  const p = await aptPoint(105, 0); await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 }); await pause(120);
  const f = await centerOf(".v5wmove"); if (f) await click(f); await pause(100);
  const edge = await centerOf(".edge");
  if (ok(edge, "la façade sélectionnée doit révéler son arête")) await drag(edge, { x: edge.x, y: edge.y + 70 }, 14);
  const apres = await lu();
  ok(nombre(apres.fiche) !== nombre(avant.fiche),
    "la surface doit avoir changé après le déplacement de la façade : " + JSON.stringify(apres));
  ok(nombre(apres.fiche) === nombre(apres.puce),
    "la fiche et la puce du rail doivent dire la MÊME surface : " + JSON.stringify(apres));
  ok(String(apres.barre).indexOf(nombre(apres.fiche)) >= 0,
    "et la barre d'outils aussi : " + JSON.stringify(apres));

  // merging two cells: the card must no longer point at a room that's gone
  const fusion = await J(`(function(){
    var P=__plan.state.plan;
    var a=P.outline, w=__plan.addWall([Math.round((a[0][0]+a[1][0])/2), a[0][1]],
                                      [Math.round((a[3][0]+a[2][0])/2), a[3][1]]);
    __plan.render();
    var cells=__plan.state.plan.cells;
    if(cells.length<2) return {assez:false, cells:cells.length};
    __plan.selectCell(cells[1].id);
    var visee=cells[1].name;
    __plan.delWall(w && w.id ? w.id : (P.walls[P.walls.length-1]||{}).id);
    __plan.render();
    return {assez:true, visee:visee, restantes:__plan.state.plan.cells.map(function(c){return c.name;}),
            fiche:document.getElementById("rcName").value,
            surfaceFiche:document.getElementById("rcArea").textContent,
            surfacePuce:(document.querySelector("#roomsList .room-chip .rc-area")||{}).textContent};})()`);
  if (fusion.assez) {
    ok(fusion.restantes.indexOf(fusion.fiche) >= 0,
      `la fiche désigne « ${fusion.fiche} », qui n'existe plus (restantes ${JSON.stringify(fusion.restantes)})`);
    ok(nombre(fusion.surfaceFiche) === nombre(fusion.surfacePuce),
      "après fusion, fiche et rail doivent encore coïncider : " + JSON.stringify(fusion));
  }
});

// =============================================================================
//  6. surfaces_au_meme_format
// =============================================================================
// The same number was written three different ways a few pixels apart: "15.1 m2" (chip), "15,12 m2"
// (card) and "total 15.1 m2" (toolbar), and `text-transform:uppercase` displayed "SURFACE 15,12 M2".
await test("surfaces_au_meme_format", URL_BLANK, async () => {
  await click(await centerOf("#setupStart"));
  await click(await centerOf("#canvas .v5layer .ov-name"));
  const v = await J(`({barre:document.getElementById("areaChip").textContent,
    puce:document.querySelector("#roomsList .room-chip .rc-area").textContent,
    fiche:document.getElementById("rcArea").textContent,
    casse:getComputedStyle(document.getElementById("rcArea")).textTransform,
    apercu:document.getElementById("setupArea").textContent})`);
  const m2 = /^\d+,\d\sm²$/;
  ok(m2.test(v.puce), "la puce du rail doit écrire « 15,1 m² » : " + JSON.stringify(v.puce));
  ok(m2.test(String(v.fiche).replace(/^Area\s+/, "")), "la fiche aussi : " + JSON.stringify(v.fiche));
  ok(m2.test(String(v.barre).replace(/^total\s+/, "").replace(/\s*·.*$/, "")),
    "la barre d'outils aussi : " + JSON.stringify(v.barre));
  ok(m2.test(v.apercu), "et l'aperçu de l'assistant aussi : " + JSON.stringify(v.apercu));
  ok(v.casse !== "uppercase", "« M² » n'est pas une unité : la surface ne se met pas en capitales");
  const n = (s: VerdictSonde) => (String(s).match(/(\d+,\d)\s*m²/) || [])[1];
  ok(n(v.puce) === n(v.fiche) && n(v.puce) === n(v.barre),
    "et les trois doivent afficher le MÊME nombre : " + JSON.stringify(v));
});

// =============================================================================
//  7. menu_toujours_atteignable
// =============================================================================
// The "..." button is the ONLY access to Save, Load, Furniture list, PNG, PDF, Print, Help and
// Clear. It was measured at y=2999 px in a window of 849 px: 18 notches of scroll wheel.
await test("menu_toujours_atteignable", URL_SEEDED, async () => {
  for (const [w, h] of [[1680, 1000], [1200, 700], [1000, 620]]) {
    await viewport(w, h, false);
    const b = await centerOf("#btnMenu");
    ok(b && b.y > 0 && b.y < h, `[${w}×${h}] le bouton « ⋯ » est hors écran : ${JSON.stringify(b)}`);
    const dessus = await J(`(function(){var e=document.getElementById("btnMenu");
      var r=e.getBoundingClientRect();
      var top=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
      return !!(top && (top===e || e.contains(top)));})()`);
    ok(dessus, `[${w}×${h}] le bouton « ⋯ » est recouvert par autre chose`);
  }
  await viewport(1680, 1000, false);
  // it stays at the bottom edge EVEN after scrolling the palette from end to end
  for (let i = 0; i < 25; i++) await wheel({ x: 130, y: 500 }, 300);
  const apres = await centerOf("#btnMenu");
  ok(apres && apres.y > 0 && apres.y < 1000,
    "après avoir déroulé toute la palette, « ⋯ » doit toujours être visible : " + JSON.stringify(apres));
  await click(apres);
  ok(await J(`!document.getElementById("footMenu").hidden`), "et il doit ouvrir le menu");
});

// =============================================================================
//  8. recadrage_au_redimension
// =============================================================================
// iPhone portrait -> landscape: half the plan went under the bottom edge. Desktop 1680x1000 ->
// 900x700: 544 px of overflow to the right. "Fit" fixed it, but nothing suggested it.
// The rule: we recrop when the RESIZE broke the framing (the plan fit before, not after), and
// NEVER the view of someone who had deliberately zoomed in on a detail.
await test("recadrage_au_redimension", URL_SEEDED, async () => {
  await viewport(390, 844, true);
  await evaluate(`__plan.fitView()`); await pause(200);
  ok((await J(`__plan.viewFits()`)).fits, "portrait : le plan doit tenir après Ajuster");
  await viewport(844, 390, true);
  ok((await J(`__plan.viewFits()`)).fits, "après rotation, le plan doit tenir encore : "
    + JSON.stringify(await J(`__plan.viewFits()`)));

  for (const [w, h] of [[1680, 1000], [900, 700], [520, 900], [380, 720]]) {
    await viewport(w, h, w < 900);
    const f = await J(`__plan.viewFits()`);
    ok(f.fits, `[${w}×${h}] le plan sort de l'écran : ${JSON.stringify(f)}`);
    const dep = await J(`({sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth,
                           sh:document.documentElement.scrollHeight, ch:document.documentElement.clientHeight})`);
    ok(dep.sw <= dep.cw + 1 && dep.sh <= dep.ch + 1,
      `[${w}×${h}] la page elle-même défile : ${JSON.stringify(dep)}`);
  }

  // and the view of someone who has deliberately zoomed in is NOT reset
  await viewport(1680, 1000, false);
  await evaluate(`__plan.fitView()`); await pause(150);
  const vp = await centerOf("#viewport");
  for (let i = 0; i < 10; i++) await wheel({ x: vp.x, y: vp.y }, -240);   // REAL wheel: zooming in
  const zoom = await J(`__plan.viewTransform()`);
  ok(!(await J(`__plan.viewFits()`)).fits, "témoin : après un zoom, le plan ne tient plus (c'est voulu)");
  await viewport(1500, 900, false);
  const apres = await J(`__plan.viewTransform()`);
  ok(apres.scale === zoom.scale, `un zoom volontaire ne doit pas être repris : ${zoom.scale} -> ${apres.scale}`);
});

// =============================================================================
//  9. stockage_refuse_le_dit
// =============================================================================
// Private browsing, cookies blocked, quota at zero: `setItem` THROWS, and the exception was
// swallowed by a silent `catch(e){}`. No banner, no chip, no log: the person would work for an
// hour believing they were saving.
await test("stockage_refuse_le_dit", URL_SEEDED, async () => {
  await evaluate(`(function(){ var real=Storage.prototype.setItem;
    Storage.prototype.setItem=function(){ var e=new Error("QuotaExceededError");
      e.name="QuotaExceededError"; throw e; };
    window.__restore=function(){ Storage.prototype.setItem=real; }; })()`);
  await evaluate(`(function(){ __plan.state.plan.pieces[0].name="Ecriture refusee"; __plan.save(); })()`);
  await pause(250);
  ok(await screenSays("/cannot save/i"),
    "un stockage refusé doit être DIT (message à l'écran)");
  const puce = await J(`(function(){var c=document.getElementById("storeChip");
    return {existe:!!c, visible:!!(c && !c.hidden && c.offsetParent!==null),
            texte:c?c.textContent:null, titre:c?c.title:null};})()`);
  ok(puce.visible, "et une puce PERSISTANTE doit rester dans la barre d'outils : " + JSON.stringify(puce));
  ok(/private browsing|storage full/i.test(puce.titre || ""),
    "la puce doit expliquer quoi en penser : " + JSON.stringify(puce.titre));

  // storage comes back: the chip must turn itself off
  await evaluate(`window.__restore()`);
  await evaluate(`(function(){ __plan.state.plan.pieces[0].name="Ecriture revenue"; __plan.save(); })()`);
  await pause(250);
  ok(await J(`document.getElementById("storeChip").hidden===true`),
    "le stockage revenu, la puce doit disparaître");
});

// =============================================================================
//  10. profondeur_bornee_par_le_mur
// =============================================================================
// "Depth" (the `h` key) is the object's thickness WITHIN its wall, and the box is centered on
// the wall's median line (v5OpeningBox): an opening repaints the floor underneath it. The field
// accepted 1..200 with no connection whatsoever to the load-bearing wall: on a 10 cm partition,
// typing 200 was accepted silently and painted a two-meter white hole THROUGH BOTH ROOMS
// (measured: a box 455 px tall for a wall of 23 px). So the bound is the WALL'S THICKNESS,
// it follows the selection, and the refusal says where it comes from.
await test("profondeur_bornee_par_le_mur", URL_MURS_MINCES, async () => {
  const lu = (id: string) => J(`(function(){var o=__plan.v5OpeningById(${JSON.stringify(id)});
    var w=__plan.v5WallById(o.wallId); var e=document.getElementById("iH");
    var el=document.querySelector('.piece[data-op="1"][data-id="'+${JSON.stringify(id)}+'"]');
    return {h:o.h, murT:w.t, champ:e.value, attrMin:+e.min, attrMax:+e.max,
            boitePx:el?Math.round(parseFloat(el.style.height)):null,
            murPx:Math.round(w.t*__plan.vScale)};})()`);
  const choisir = (id: string) => evaluate(`(function(){__plan.selReplace(${JSON.stringify(id)});
    __plan.render(); __plan.openInspector();})(); true`);

  // 1. THE DISPLAYED BOUND IS THE WALL'S, AND IT CHANGES WITH THE SELECTION
  await choisir("oMince");
  let e = await lu("oMince");
  ok(e.attrMax === e.murT, `sur un mur de ${e.murT} cm, l'attribut max doit valoir ${e.murT}, il vaut ${e.attrMax}`);
  ok(e.attrMin === 1, `l'attribut min doit rester 1 (une prise fait 6 cm de profondeur), il vaut ${e.attrMin}`);
  await choisir("oEpais");
  let f = await lu("oEpais");
  ok(f.attrMax === f.murT && f.murT !== e.murT,
    `la borne doit suivre l'ouverture SÉLECTIONNÉE (${e.murT} cm puis ${f.murT} cm), max=${f.attrMax}`);

  // 2. 200 ON A WALL OF 10: REFUSED, SAID, AND THE PLAN IS NOT TOUCHED
  await choisir("oMince");
  const champ = await centerOf("#iH");
  ok(champ, "le champ Profondeur doit être visible");
  // The input is READ BACK: "200" must hand control back to 10 (the last valid value). Under
  // load, the instrument used to let numField commit "2" along the way and the case would then
  // measure a truncated input, not a bound, exactly the "h=2" failure noted in AGENTS.md.
  const remettreProf = async () => {
    await evaluate(`(function(){var o=__plan.v5OpeningById("oMince"); o.h=10;
      __plan.save(); __plan.render(); __plan.selReplace("oMince"); __plan.openInspector();})(); true`);
    await pause(150);
    await click(await centerOf("#iH")); await selectAll();
  };
  await click(champ); await selectAll();
  await typeText("200", { attendu: "10", remettre: remettreProf });
  e = await lu("oMince");
  ok(e.h === 10, `200 ne doit jamais atteindre le plan sur un mur de 10 cm : h=${e.h}`);
  ok(String(e.champ) === "10", `le champ doit rendre la main sur la dernière valeur valide, écran=${e.champ}`);
  ok(await screenSays("/between 1 and 10 cm/i"), "le refus doit DIRE la borne");
  ok(await screenSays("/wall is 10 cm thick/i"), "le refus doit dire D'OÙ vient la borne (le mur)");
  ok(await screenSays("/through both rooms/i"), "et POURQUOI elle existe");

  // 3. THE PAINTED HOLE NEVER OVERFLOWS THE WALL (the visible half of the defect)
  ok(Math.abs(e.boitePx - e.murPx) <= 2,
    `la boîte peinte doit tenir dans le mur : ${e.boitePx} px pour un mur de ${e.murPx} px`);

  // 4. A SENSIBLE VALUE GOES THROUGH (we bound, we don't freeze)
  await click(champ); await selectAll(); await typeText("6", { attendu: "6" });
  e = await lu("oMince");
  ok(e.h === 6 && String(e.champ) === "6", `6 cm sur un mur de 10 doit s'appliquer : ${JSON.stringify(e)}`);

  // 5. THE ARRIVAL WALL CAN BE THINNER: the depth follows it, and it is said.
  //    (a wall's thickness isn't edited in the interface: the only gesture that changes an
  //     opening's load-bearing wall is moving it, and that's where the case happens)
  const bouge = await J(`__plan.dragOpeningTo("oEpais", 200, 150)`);
  ok(bouge && String(bouge.wallId) === "wmince", `l'ouverture doit changer de mur : ${JSON.stringify(bouge)}`);
  ok(bouge && bouge.h === 10, `la profondeur doit suivre le mur d'arrivée (24 -> 10) : h=${bouge && bouge.h}`);
  ok(bouge && bouge.aminci, "et l'amincissement doit être ANNONCÉ, jamais subi en silence");

  // 6. NOTHING GOES OUT TO THE SERVER THAT WOULD EXCEED ITS WALL
  const horsBornes = await J(`(function(){var P=__plan.state.plan;
    return (P.openings||[]).filter(function(o){var w=__plan.v5WallById(o.wallId);
      return w && o.h>Math.round(w.t);}).map(function(o){return o.id+":"+o.h;});})()`);
  ok(horsBornes.length === 0, "aucune ouverture ne doit dépasser son mur : " + JSON.stringify(horsBornes));
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
