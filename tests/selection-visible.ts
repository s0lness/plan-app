#!/usr/bin/env node
// =============================================================================
//  "WHAT YOU SELECT IS VISIBLE" SUITE — REAL MOUSE (CDP)
// =============================================================================
// Two usage reports, one single root: the selection rectangle said nothing.
//
//  1. "when I select several windows, they don't show up as active". This was not
//     a style defect: the lasso was NOT selecting them. `piecesInClientRect` (js/22) resolved
//     each node through `pieceById`, which only knows FURNITURE; windows, doors, sconces and
//     outlets live in `plan.openings` and were silently dropped. Measured on the real plan:
//     47 objects caught by a full-screen lasso, 0 openings.
//  2. "I want to see what I'm grabbing before I release". Marking only happened on release,
//     so you dragged blind. It is now applied ON EVERY FRAME, on only the nodes that
//     change state, without ever touching `selIds`, `render()` or `save()`.
//
//   node tests/selection-visible.ts [path/to/app.html]
//
//   lasso_attrape_aussi_les_ouvertures   windows, doors, sconces and outlets enter the lasso
//   une_ouverture_selectionnee_se_voit   the marker exists and overflows the box, even at 10 cm
//   marquage_vif_pendant_le_geste        what is under the rectangle is marked before release
//   rien_ne_s_ecrit_pendant_le_geste     neither selection nor saved plan, until release
//   glisser_et_shift_glisser_sont_distincts  ordinary drag draws; Shift+drag selects
//   shift_ctrl_lasso_montre_le_cumul     adding to an existing selection is visible during the gesture
//   echap_rend_tout_a_l_etat_d_avant     Escape cancels instead of committing, no orphan marks
//   la_selection_ne_reordonne_pas_la_pile  the paint rank does not move (recent fix)
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-selvis-"));
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
      // The file can be LOCKED (EBUSY: Chrome still has it open), missing (ENOENT), or
      // truncated, especially since several Chrome instances start at once. We RETRY
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

const M = (type: string, x: VerdictSonde, y: VerdictSonde, extra?: Record<string, unknown>) => send("Input.dispatchMouseEvent", Object.assign({
  type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1,
  clickCount: 1, pointerType: "mouse",
}, extra || {}));
const ECHAP = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 };
async function echap() {
  await send("Input.dispatchKeyEvent", Object.assign({ type: "rawKeyDown" }, ECHAP));
  await send("Input.dispatchKeyEvent", Object.assign({ type: "keyUp" }, ECHAP));
  await pause(120);
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

const dump = () => J(`__plan.selDump()`);
// The name field can keep focus after a selection: keyboard input would go into the field and
// Escape would never reach the gesture. We return focus to the page before each keyboard scenario.
const repos = async () => {
  await evaluate(`(function(){document.activeElement&&document.activeElement.blur();
    __plan.clearSel(); __plan.render(); return 1;})()`);
  await pause(150);
};
// An EMPTY starting point: pressing on furniture starts a drag, not a lasso.
const departVide = () => J(`(function(){
  var vr=document.getElementById("viewport").getBoundingClientRect();
  for(var fy=0.05; fy<0.5; fy+=0.02) for(var fx=0.05; fx<0.5; fx+=0.02){
    var x=vr.left+fx*vr.width, y=vr.top+fy*vr.height;
    var t=document.elementFromPoint(x,y);
    if(t && !t.closest(".piece") && !t.closest(".vtx,.mid,.edge,.v5wx") && !t.closest(".ov-name"))
      return {x:Math.round(x), y:Math.round(y)};
  }
  return null;})()`);
const coinBas = () => J(`(function(){var r=document.getElementById("viewport").getBoundingClientRect();
  return {x:Math.round(r.left+r.width-20), y:Math.round(r.top+r.height*0.7)};})()`);
const aptPoint = (x: VerdictSonde, y: VerdictSonde) => J(`(function(){var s=__plan.aptToScreen(${x},${y});
  var r=document.getElementById("viewport").getBoundingClientRect(); return {x:r.left+s.x, y:r.top+s.y};})()`);

// =============================================================================
//  1. glisser_et_shift_glisser_sont_distincts
// =============================================================================
await test("glisser_et_shift_glisser_sont_distincts", async () => {
  const preparer = async () => {
    await evaluate(`(function(){var type=__plan.plan.pieces[0].type;
      __plan.setModel({outline:[[0,0],[420,0],[420,360],[0,360]],walls:[],openings:[],pieces:[],cells:[]});
      __plan.addV5Piece(type,180,150); __plan.clearSel(); __plan.fitView(); return true;})()`);
    await pause(180);
  };
  await preparer();
  let A = await aptPoint(60, 60), B = await aptPoint(340, 280);
  const mursAvant = await J(`__plan.plan.walls.filter(function(w){return !w.isOutline;}).length`);
  await M("mouseMoved", A.x, A.y, { button: "none", buttons: 0 });
  await M("mousePressed", A.x, A.y);
  await M("mouseMoved", B.x, B.y); await pause(200);
  await M("mouseReleased", B.x, B.y, { buttons: 0 }); await pause(220);
  const sansShift = await dump();
  const mursApres = await J(`__plan.plan.walls.filter(function(w){return !w.isOutline;}).length`);
  ok(mursApres === mursAvant + 1, `un glisser sans Shift doit créer un mur, vu ${mursAvant} puis ${mursApres}`);
  ok(sansShift.modele.length === 0, `un glisser sans Shift ne doit rien sélectionner, vu ${sansShift.modele.length} objet(s)`);

  await reload(); await preparer();
  A = await aptPoint(60, 60); B = await aptPoint(340, 280);
  const mursAvantShift = await J(`__plan.plan.walls.filter(function(w){return !w.isOutline;}).length`);
  await M("mouseMoved", A.x, A.y, { button: "none", buttons: 0, modifiers: 8 });
  await M("mousePressed", A.x, A.y, { modifiers: 8 });
  await M("mouseMoved", B.x, B.y, { modifiers: 8 }); await pause(200);
  await M("mouseReleased", B.x, B.y, { buttons: 0, modifiers: 8 }); await pause(220);
  const avecShift = await dump();
  const mursApresShift = await J(`__plan.plan.walls.filter(function(w){return !w.isOutline;}).length`);
  ok(avecShift.modele.length > 0, "Shift+glisser doit sélectionner au moins un objet");
  ok(mursApresShift === mursAvantShift, `Shift+glisser ne doit créer aucun mur, vu ${mursAvantShift} puis ${mursApresShift}`);
});

// =============================================================================
//  2. lasso_attrape_aussi_les_ouvertures
// =============================================================================
await test("lasso_attrape_aussi_les_ouvertures", async () => {
  await repos();
  const A = await departVide(), B = await coinBas();
  ok(A, "il faut un point de départ vide pour tracer un rectangle");
  if (!A) return;
  await M("mouseMoved", A.x, A.y, { button: "none", buttons: 0, modifiers: 8 });
  await M("mousePressed", A.x, A.y, { modifiers: 8 });
  await M("mouseMoved", B.x, B.y, { modifiers: 8 }); await pause(200);
  await M("mouseReleased", B.x, B.y, { buttons: 0, modifiers: 8 }); await pause(220);
  const d = await dump();
  const ouv = d.familles.filter((f: VerdictSonde) => f === "ouverture").length;
  const meu = d.familles.filter((f: VerdictSonde) => f === "meuble").length;
  ok(meu > 0, "le lasso doit prendre du mobilier");
  ok(ouv > 0, `le lasso doit prendre les OUVERTURES ; il en a pris ${ouv} sur ${d.modele.length} objets`);
  ok(d.manquants.length === 0, "des objets sélectionnés ne portent AUCUNE marque à l'écran : " + JSON.stringify(d.manquants));
  ok(d.enTrop.length === 0, "des objets portent la marque sans être sélectionnés : " + JSON.stringify(d.enTrop));
  // and the follow-up stays consistent: deletion takes both families with it
  const avant = await J(`({p:__plan.plan.pieces.length, o:__plan.plan.openings.length})`);
  await evaluate(`__plan.delSel(); true`); await pause(150);
  const apres = await J(`({p:__plan.plan.pieces.length, o:__plan.plan.openings.length})`);
  ok(avant.p - apres.p === meu && avant.o - apres.o === ouv,
    `supprimer la sélection doit retirer ${meu} meubles et ${ouv} ouvertures ; retirés : ${avant.p - apres.p} et ${avant.o - apres.o}`);
});

// =============================================================================
//  3. une_ouverture_selectionnee_se_voit
// =============================================================================
// An opening is drawn INSIDE the wall, often thin and dark: the marker must overflow its
// box, otherwise it disappears under the wall band. We verify it on the smallest one in the catalog
// (a 10x6 cm outlet, a few pixels at "Fit" scale) and at a close zoom.
await test("une_ouverture_selectionnee_se_voit", async () => {
  for (const type of ["window", "door", "sconce", "plug"]) {
    for (const z of [null, 1.8]) {
      if (z) { await evaluate(`__plan.setZoom(${z}); true`); await pause(150); }
      // The two reads are separated by a REAL frame: queried in the same task as a
      // class change, Chrome returns a `box-shadow` still unresolved (the `var()` are worth zero).
      const id = await evaluate(`(function(){
        var o=__plan.plan.openings.filter(function(x){return x.type===${JSON.stringify(type)};})[0];
        if(!o) return ""; __plan.clearSel(); __plan.render(); return String(o.id);})()`);
      if (!id) continue;
      await pause(120);
      const lire = () => J(`(function(){
        var el=document.querySelector('.piece[data-op="1"][data-id="'+CSS.escape(${JSON.stringify(id)})+'"]');
        if(!el) return null; var b=el.getBoundingClientRect();
        return {ombre:getComputedStyle(el).boxShadow, marque:el.classList.contains("sel"),
                w:Math.round(b.width), h:Math.round(b.height)};})()`);
      const libre = await lire();
      if (!libre) continue;
      await evaluate(`__plan.selReplace(${JSON.stringify(id)}); __plan.render(); true`);
      await pause(120);
      const pris = await lire();
      const r = { marque: pris.marque, libre: libre.ombre, pris: pris.ombre, w: pris.w, h: pris.h };
      const ou = (z ? "zoom 1.8" : "ajuster") + " / " + type;
      ok(r.marque, `${ou} : l'ouverture sélectionnée ne porte pas la classe de sélection`);
      ok(r.pris !== r.libre && r.pris !== "none",
        `${ou} : rien ne distingue l'ouverture sélectionnée de l'ouverture libre (${r.pris})`);
      // the marker OVERFLOWS: two 2 px rings, so at least 4 px outside the box
      const rayon = (r.pris.match(/(\d+(?:\.\d+)?)px/g) || []).map(parseFloat).sort((a: VerdictSonde, b: VerdictSonde) => b - a)[0] || 0;
      ok(rayon >= 4, `${ou} : le marqueur ne déborde que de ${rayon}px, invisible sur une boîte de ${r.w}×${r.h}px`);
    }
    await evaluate(`__plan.fitView(); true`); await pause(120);
  }
});

// =============================================================================
//  4. marquage_vif_pendant_le_geste
// =============================================================================
await test("marquage_vif_pendant_le_geste", async () => {
  await repos();
  const A = await departVide(), B = await coinBas();
  if (!ok(A, "point de départ vide introuvable")) return;
  await M("mouseMoved", A.x, A.y, { button: "none", buttons: 0, modifiers: 8 });
  await M("mousePressed", A.x, A.y, { modifiers: 8 });
  await M("mouseMoved", A.x + (B.x - A.x) * 0.5, A.y + (B.y - A.y) * 0.5, { modifiers: 8 }); await pause(180);
  const mi = await dump();
  await M("mouseMoved", B.x, B.y, { modifiers: 8 }); await pause(180);
  const plein = await dump();
  ok(mi.bandeVive === true, "la sonde doit voir un lasso en cours");
  ok(mi.ecran.length > 0, "à mi-geste, rien n'est marqué : on tire encore à l'aveugle");
  ok(plein.ecran.length > mi.ecran.length,
    `le marquage doit grandir avec le rectangle (${mi.ecran.length} puis ${plein.ecran.length})`);
  ok(plein.modele.length === 0, "la SÉLECTION ne doit pas bouger tant qu'on n'a pas relâché");
  ok(plein.famillesEcran.indexOf("ouverture") >= 0, "les ouvertures doivent se marquer elles aussi pendant le geste");
  // shrinking unmarks
  await M("mouseMoved", A.x + 90, A.y + 70, { modifiers: 8 }); await pause(180);
  const petit = await dump();
  ok(petit.ecran.length < plein.ecran.length,
    `rétrécir le rectangle doit démarquer (${plein.ecran.length} puis ${petit.ecran.length})`);
  // and release gives EXACTLY what was marked
  await M("mouseMoved", B.x, B.y, { modifiers: 8 }); await pause(180);
  const avantLache = await dump();
  await M("mouseReleased", B.x, B.y, { buttons: 0, modifiers: 8 }); await pause(220);
  const apres = await dump();
  ok(JSON.stringify(avantLache.ecran) === JSON.stringify(apres.modele),
    "ce qui était marqué au dernier instant du geste doit être exactement la sélection obtenue");
  ok(apres.manquants.length === 0 && apres.enTrop.length === 0,
    "après le relâchement, l'écran et le modèle doivent coïncider exactement");
});

// =============================================================================
//  5. rien_ne_s_ecrit_pendant_le_geste
// =============================================================================
// Rendering is the code's crossroads, and a pan has already cost 40 serializations and 854 KB
// of writes. Live marking is a CLASS write on the nodes concerned: neither `selIds`, nor
// `render()`, nor `save()`. We measure it on the saved plan, byte for byte.
await test("rien_ne_s_ecrit_pendant_le_geste", async () => {
  await repos();
  const A = await departVide(), B = await coinBas();
  if (!ok(A, "point de départ vide introuvable")) return;
  const empreinte = () => evaluate(`(function(){var s=localStorage.getItem("room-planner-v4")||"";
    var h=0; for(var i=0;i<s.length;i++){ h=(h*31+s.charCodeAt(i))>>>0; } return s.length+":"+h;})()`);
  const avant = await empreinte();
  await M("mouseMoved", A.x, A.y, { button: "none", buttons: 0, modifiers: 8 });
  await M("mousePressed", A.x, A.y, { modifiers: 8 });
  for (let i = 1; i <= 8; i++) {
    await M("mouseMoved", A.x + (B.x - A.x) * i / 8, A.y + (B.y - A.y) * i / 8, { modifiers: 8 });
    await pause(30);
  }
  await pause(150);
  const pendant = await empreinte();
  const d = await dump();
  ok(pendant === avant, `le plan enregistré a changé PENDANT le geste (${avant} -> ${pendant})`);
  ok(d.modele.length === 0, "la sélection ne doit rien enregistrer avant le relâchement");
  ok(d.ecran.length > 0, "…mais le marquage vif, lui, doit bien être là");
  await M("mouseReleased", B.x, B.y, { buttons: 0, modifiers: 8 }); await pause(200);
});

// =============================================================================
//  6. shift_ctrl_lasso_montre_le_cumul
// =============================================================================
await test("shift_ctrl_lasso_montre_le_cumul", async () => {
  await repos();
  const A = await departVide(), B = await coinBas();
  if (!ok(A, "point de départ vide introuvable")) return;
  const deja = await J(`(function(){var ids=[String(__plan.plan.pieces[0].id), String(__plan.plan.pieces[1].id)];
    ids.forEach(function(i){ __plan.selAdd(i); }); __plan.render();
    document.activeElement&&document.activeElement.blur(); return ids;})()`);
  await pause(150);
  await M("mouseMoved", A.x, A.y, { button: "none", buttons: 0, modifiers: 10 });
  await M("mousePressed", A.x, A.y, { modifiers: 10 });
  await M("mouseMoved", (A.x + B.x) / 2, (A.y + B.y) / 2, { modifiers: 10 }); await pause(200);
  const pendant = await dump();
  ok(deja.every((id: string) => pendant.ecran.indexOf(id) >= 0),
    "Ctrl+lasso : les objets DÉJÀ sélectionnés doivent rester marqués pendant le geste");
  ok(pendant.ecran.length > deja.length, "Ctrl+lasso : le cumul doit se voir grandir");
  await M("mouseReleased", (A.x + B.x) / 2, (A.y + B.y) / 2, { buttons: 0, modifiers: 10 }); await pause(220);
  const apres = await dump();
  ok(deja.every((id: string) => apres.modele.indexOf(id) >= 0), "Ctrl+lasso : la sélection d'avant doit être CONSERVÉE");
  ok(apres.manquants.length === 0 && apres.enTrop.length === 0, "écran et modèle doivent coïncider après un Ctrl+lasso");

  // AND THE OTHER HALF OF THE RULE, which is what makes the first half mean anything: a lasso
  // WITHOUT the cumulative modifier REPLACES the selection. This assertion used to be written on a
  // lasso with no modifier at all; that gesture now draws a wall, so the rule is restated on its
  // new base, Shift alone. Deleting it rather than restating it would have quietly dropped the
  // guard that says the two modifiers do different things.
  await M("mouseMoved", A.x, A.y, { button: "none", buttons: 0, modifiers: 8 });
  await M("mousePressed", A.x, A.y, { modifiers: 8 });
  await M("mouseMoved", A.x + 60, A.y + 50, { modifiers: 8 }); await pause(180);
  await M("mouseReleased", A.x + 60, A.y + 50, { buttons: 0, modifiers: 8 }); await pause(200);
  const remplace = await dump();
  ok(!deja.every((id: string) => remplace.modele.indexOf(id) >= 0),
    "Maj seul : un lasso REMPLACE la sélection, il ne l'ajoute pas");
});

// =============================================================================
//  7. echap_rend_tout_a_l_etat_d_avant
// =============================================================================
// Before: Escape canceled nothing. `escapeActiveGesture` (js/03) still called the gesture's
// exit, which COMMITTED the rectangle's selection: Escape selected instead of canceling.
await test("echap_rend_tout_a_l_etat_d_avant", async () => {
  await repos();
  const A = await departVide(), B = await coinBas();
  if (!ok(A, "point de départ vide introuvable")) return;
  const un = await evaluate(`(function(){var id=String(__plan.plan.pieces[0].id);
    __plan.selAdd(id); __plan.render(); document.activeElement&&document.activeElement.blur(); return id;})()`);
  await pause(150);
  const avant = await dump();
  await M("mouseMoved", A.x, A.y, { button: "none", buttons: 0, modifiers: 8 });
  await M("mousePressed", A.x, A.y, { modifiers: 8 });
  await M("mouseMoved", B.x, B.y, { modifiers: 8 }); await pause(200);
  const pendant = await dump();
  ok(pendant.ecran.length > 1, "le marquage vif doit être là avant qu'on appuie sur Échap");
  await echap();
  const apresEchap = await dump();
  ok(JSON.stringify(apresEchap.modele) === JSON.stringify(avant.modele),
    `Échap doit rendre la sélection d'avant (${JSON.stringify(avant.modele)}), obtenue : ${JSON.stringify(apresEchap.modele)}`);
  ok(JSON.stringify(apresEchap.ecran) === JSON.stringify(avant.ecran),
    `Échap ne doit laisser AUCUNE marque orpheline : ${apresEchap.ecran.length} marqué(s) pour ${avant.ecran.length} attendu(s)`);
  ok(apresEchap.bandeVive === false, "après Échap, plus aucun lasso ne doit être en cours");
  ok(await evaluate(`String(document.getElementById("rubber").hidden)`) === "true", "le rectangle doit être refermé");
  // the release that follows must commit NOTHING
  await M("mouseReleased", B.x, B.y, { buttons: 0, modifiers: 8 }); await pause(200);
  const fin = await dump();
  ok(JSON.stringify(fin.modele) === JSON.stringify(avant.modele),
    `le relâchement après Échap ne doit rien valider, obtenu : ${fin.modele.length} objet(s)`);
  ok(fin.modele.indexOf(un) >= 0, "l'objet sélectionné avant le geste doit toujours l'être");
});

// =============================================================================
//  8. la_selection_ne_reordonne_pas_la_pile
// =============================================================================
// Recent fix not to break: painting goes from the LARGEST to the smallest and `stackedAt` sorts
// on `data-paint`, precisely because `.piece.sel` bumps to `z-index:50`. Live marking sets the
// SAME class: it must therefore change nothing about the paint rank, neither during nor after.
await test("la_selection_ne_reordonne_pas_la_pile", async () => {
  await repos();
  const rangs = () => J(`(function(){var o={};
    document.querySelectorAll(".piece").forEach(function(e){ o[e.dataset.id]=e.dataset.paint; }); return o;})()`);
  const avant = await rangs();
  const A = await departVide(), B = await coinBas();
  if (!ok(A, "point de départ vide introuvable")) return;
  await M("mouseMoved", A.x, A.y, { button: "none", buttons: 0, modifiers: 8 });
  await M("mousePressed", A.x, A.y, { modifiers: 8 });
  await M("mouseMoved", B.x, B.y, { modifiers: 8 }); await pause(200);
  const pendant = await rangs();
  ok(JSON.stringify(pendant) === JSON.stringify(avant), "le rang de peinture a changé PENDANT le marquage vif");
  await M("mouseReleased", B.x, B.y, { buttons: 0, modifiers: 8 }); await pause(220);
  const apres = await rangs();
  ok(JSON.stringify(apres) === JSON.stringify(avant), "le rang de peinture a changé après la sélection");
  // decreasing by area, and openings stay below
  const ordre = await J(`(function(){
    var lst=[...document.querySelectorAll(".piece:not([data-op])")].map(function(e){
      var p=__plan.pieceById(e.dataset.id); return {paint:+e.dataset.paint, a:p?(p.w*p.h):0};});
    lst.sort(function(x,y){return x.paint-y.paint;});
    var ok=true; for(var i=1;i<lst.length;i++) if(lst[i].a>lst[i-1].a) ok=false;
    var ouv=[...document.querySelectorAll('.piece[data-op="1"]')].every(function(e){return e.dataset.paint==="-1";});
    return {decroissant:ok, ouverturesDessous:ouv};})()`);
  ok(ordre.decroissant, "la peinture doit rester du plus GRAND au plus petit");
  ok(ordre.ouverturesDessous, "les ouvertures doivent rester au rang -1 (toujours sous le mobilier)");
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
