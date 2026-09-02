#!/usr/bin/env node
// =============================================================================
//  "WALL FACES . PLACEMENT . CLIPBOARD" SUITE: REAL MOUSE, REAL KEYBOARD, REAL FINGER (CDP)
// =============================================================================
// Three real usage requests, all checked through the browser's real hit-testing.
//
//  A. THE WALL FACE MATTERS. Two back-to-back outlets in the same partition wall (one in the
//     bedroom, the other in the living room) were IMPOSSIBLE: the 1-D non-overlap rule was
//     computed per wall and per family, never per face, and the object being placed was pushed
//     10cm away without a word. A DOOR or a WINDOW, on the other hand, is a THROUGH opening: it
//     keeps interfering on both faces. And "Change side" toward an already occupied face is
//     REFUSED out loud (it's the only gesture capable of stacking two fixtures on the same face).
//
//  B. PLACEMENT IS A DRAG-AND-DROP. A click on a thumbnail used to make the object appear at the
//     cursor's last known position, somewhere other than under the hand. A click now ARMS the
//     placement (like "Draw a wall"), and the next gesture on the plan performs it, under the
//     pointer, with the same preview as a drag. This is also the TOUCH path.
//
//  C. COPY / CUT / PASTE from the keyboard, on a multi-selection, keeping the relative
//     layout, with a SINGLE undo step per paste.
//
//   node tests/faces-pose-copie.ts [path/to/app.html]
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-faces-"));
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
      try {
        // The file can be LOCKED (EBUSY: Chrome still has it open), absent (ENOENT), or
        // truncated, especially since several Chrome instances start at the same time. We RETRY
        // until the timeout instead of throwing.
        let t: VerdictSonde[] = [];
        try { t = fs.readFileSync(portFile, "utf8").split("\n"); } catch { t = []; }
        if (t[0] && /^[0-9]+$/.test(t[0].trim())) return t[0].trim();
      } catch (_) {}
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

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function reload() {
  await send("Page.navigate", { url: "file:///" + htmlPath.replace(/\\/g, "/") });
  for (let i = 0; i < 200; i++) {
    let st = null;
    try { st = await evaluate("document.readyState + '|' + (window.__plan ? 1 : 0)"); } catch (_) {}
    if (st === "complete|1") break;
    await pause(50);
  }
  await pause(300);
}

// ---- REAL mouse / REAL keyboard / REAL finger ---------------------------------------------------
const M = (type: string, x: VerdictSonde, y: VerdictSonde, extra?: Record<string, unknown>) => send("Input.dispatchMouseEvent", Object.assign({
  type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1,
  clickCount: 1, pointerType: "mouse",
}, extra || {}));
async function moveMouse(p: VerdictSonde) { await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 }); await pause(40); }
async function drag(from: VerdictSonde, to: VerdictSonde, steps = 12) {
  await moveMouse(from);
  await M("mousePressed", from.x, from.y);
  for (let i = 1; i <= steps; i++) {
    await M("mouseMoved", from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
    await pause(8);
  }
  await M("mouseReleased", to.x, to.y, { buttons: 0 });
  await pause(120);
}
async function click(p: VerdictSonde, mods?: number) {
  await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0, modifiers: mods || 0 });
  await M("mousePressed", p.x, p.y, { modifiers: mods || 0 });
  await M("mouseReleased", p.x, p.y, { buttons: 0, modifiers: mods || 0 });
  await pause(80);
}
async function key(k: string, code: string, vk: VerdictSonde, mods?: number) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk || 0, modifiers: mods || 0 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk || 0, modifiers: mods || 0 });
  await pause(140);
}
const ctrl = (k: string, code: string, vk: VerdictSonde) => key(k, code, vk, 2);
async function tap(x: VerdictSonde, y: VerdictSonde) {
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  await pause(40);
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await pause(200);
}

// ---- micro-harness ------------------------------------------------------------------------------
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
const palette = (type: string) => J(`(function(){var it=document.querySelector('#palette .pitem[data-type=${JSON.stringify(type)}]');
  if(!it) return null; it.scrollIntoView({block:"center"}); var r=it.getBoundingClientRect();
  return {x:r.left+r.width/2, y:r.top+r.height/2};})()`);
const centreEcran = (id: string) => J(`(function(){var e=document.querySelector('.piece[data-id="'+${JSON.stringify(String(id))}+'"]');
  if(!e) return null; var r=e.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2};})()`);
const toast = () => evaluate(`__plan.toastText`);
const pieces = () => J(`__plan.plan.pieces.map(function(p){return {id:String(p.id),type:p.type,name:p.name,
  x:p.x,y:p.y,w:p.w,h:p.h,rot:p.rot||0,locked:!!p.locked};})`);
const ouvertures = () => J(`__plan.plan.openings.map(function(o){return {id:String(o.id),wall:String(o.wallId),
  t0:Math.round(o.t0),w:Math.round(o.w),type:o.type,side:o.side,name:o.name};})`);

// A test apartment: 420 x 360, cut in two by ONE horizontal partition wall at y=180. Both
// faces of this partition are habitable, which is all it takes to talk about back-to-back.
const MUR = [{ id: "wA", a: [0, 180], b: [420, 180], t: 10, isOutline: false }];
async function seedModel(pieces: VerdictSonde) {
  await evaluate(`__plan.setModel({outline:[[0,0],[420,0],[420,360],[0,360]],
    walls:${JSON.stringify(MUR)}, openings:[], pieces:${JSON.stringify(pieces || [])}, cells:[]}); true`);
  await pause(150);
}
// Do two objects on the SAME face overlap? (the question the model must forbid)
function empilesMemeFace(l: VerdictSonde) {
  const bad = [];
  for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
    const a = l[i], b = l[j];
    if (a.wall !== b.wall) continue;
    if (a.type !== b.type) continue;
    if (a.side !== b.side) continue;
    if (a.t0 < b.t0 + b.w && a.t0 + a.w > b.t0) bad.push([a.t0 + "/" + a.side, b.t0 + "/" + b.side]);
  }
  return bad;
}

console.log("\n=== A. LA FACE DU MUR COMPTE ===");

// =============================================================================
//  1. deux_prises_dos_a_dos
// =============================================================================
// Measured BEFORE on the real plan: an outlet placed exactly across from another used to land
// 10cm further away (t0 245 requested -> 235 obtained), without a word. An outlet is SCREWED ONTO
// a face: two faces, two surfaces, no interference.
await test("deux_prises_dos_a_dos", async () => {
  await seedModel([]);
  const pal = await palette("plug");
  if (!ok(pal, "vignette « prise » introuvable")) return;
  await drag(pal, await aptPoint(200, 192), 10);          // BOTTOM face
  await drag(await palette("plug"), await aptPoint(200, 168), 10);   // TOP face, same spot
  const O = await ouvertures();
  ok(O.length === 2, `deux prises attendues, ${O.length} obtenue(s)`);
  if (O.length === 2) {
    ok(O[0].side !== O[1].side, `les deux prises doivent être sur des faces DIFFÉRENTES : ${JSON.stringify(O)}`);
    ok(Math.abs(O[0].t0 - O[1].t0) <= 1,
      `dos à dos : la seconde prise doit rester au MÊME endroit (t0 ${O[0].t0} vs ${O[1].t0})`);
  }
  ok(empilesMemeFace(O).length === 0, "aucun empilement sur une même face : " + JSON.stringify(empilesMemeFace(O)));
});

// =============================================================================
//  2. deux_percements_se_genent_des_deux_cotes
// =============================================================================
// A door and a window GO THROUGH the wall: they occupy the opening, not a surface. Allowing them
// back-to-back would create an impossible hole. The face doesn't free them from anything.
await test("deux_percements_se_genent_des_deux_cotes", async () => {
  await seedModel([]);
  await drag(await palette("window"), await aptPoint(200, 192), 10);
  await drag(await palette("window"), await aptPoint(200, 168), 10);
  const O = await ouvertures();
  ok(O.length === 2, `deux fenêtres attendues, ${O.length}`);
  if (O.length === 2) {
    const a = O[0], b = O[1];
    ok(!(a.t0 < b.t0 + b.w && a.t0 + a.w > b.t0),
      `deux percements ne doivent JAMAIS se recouvrir, même sur deux faces : ${JSON.stringify(O)}`);
  }
});

// =============================================================================
//  3. glissement_accepte_le_dos_a_dos
// =============================================================================
// Sliding along the wall goes through the same arbiter as placement: it had to line up with it.
await test("glissement_accepte_le_dos_a_dos", async () => {
  await seedModel([]);
  await drag(await palette("plug"), await aptPoint(120, 192), 10);   // A, bottom face, t ~ 120
  await drag(await palette("plug"), await aptPoint(300, 168), 10);   // B, top face, far away
  let O = await ouvertures();
  if (!ok(O.length === 2, `deux prises attendues, ${O.length}`)) return;
  const b = O.find((o: VerdictSonde) => o.side !== O.find((x: VerdictSonde) => x.t0 < 200).side) || O[1];
  const cible = O.find((o: VerdictSonde) => o.t0 < 200);
  const el = await centreEcran(b.id);
  if (!ok(el, "la prise à glisser n'est pas rendue")) return;
  await drag(el, await aptPoint(cible.t0 + cible.w / 2, b.side === 0 ? 192 : 168), 14);
  O = await ouvertures();
  const apres = O.find((o: VerdictSonde) => o.id === b.id);
  ok(Math.abs(apres.t0 - cible.t0) <= 2,
    `glissée pile en face de l'autre, la prise doit y RESTER (t0 ${apres.t0}, visé ${cible.t0})`);
  ok(empilesMemeFace(O).length === 0, "aucun empilement sur une même face");
});

// =============================================================================
//  4. bascule_vers_une_face_occupee_est_refusee_et_le_dit
// =============================================================================
// Since back-to-back has been allowed, "Change side" is the ONLY gesture capable of stacking two
// fixtures on the same face. We refuse, we name the culprit, and we move NOTHING: the button only
// talks about the face, it has no reason to slide the object along the wall.
await test("bascule_vers_une_face_occupee_est_refusee_et_le_dit", async () => {
  await seedModel([]);
  await drag(await palette("plug"), await aptPoint(200, 192), 10);
  await drag(await palette("plug"), await aptPoint(200, 168), 10);
  let O = await ouvertures();
  if (!ok(O.length === 2, `deux prises attendues, ${O.length}`)) return;
  const cible = O[1];
  await evaluate(`__plan.clearToast()`);
  const r = await J(`__plan.clickFlipSide(${JSON.stringify(cible.id)})`);
  ok(r.clicked, "le bouton « Changer de côté » doit être offert");
  O = await ouvertures();
  const apres = O.find((o: VerdictSonde) => o.id === cible.id);
  ok(apres.side === cible.side, `la face ne doit PAS changer (${cible.side} -> ${apres.side})`);
  ok(apres.t0 === cible.t0, `et l'objet ne doit pas bouger d'un centimètre (t0 ${cible.t0} -> ${apres.t0})`);
  const t = await toast();
  ok(!!t && /already taken/.test(t), "le refus doit être DIT à l'écran, il ne l'est pas : " + JSON.stringify(t));
  ok(empilesMemeFace(O).length === 0, "aucun empilement sur une même face");
});

// =============================================================================
//  5. bascule_reste_possible_quand_la_face_est_libre
// =============================================================================
await test("bascule_reste_possible_quand_la_face_est_libre", async () => {
  await seedModel([]);
  await drag(await palette("plug"), await aptPoint(200, 192), 10);
  const O0 = await ouvertures();
  if (!ok(O0.length === 1, `une prise attendue, ${O0.length}`)) return;
  const r = await J(`__plan.clickFlipSide(${JSON.stringify(O0[0].id)})`);
  ok(r.clicked, "le bouton doit être offert");
  const O1 = await ouvertures();
  ok(O1[0].side !== O0[0].side, `la face doit changer quand l'autre est libre (${O0[0].side} -> ${O1[0].side})`);
  ok(O1[0].t0 === O0[0].t0, "et l'objet ne bouge pas le long du mur");
});

console.log("\n=== B. LA POSE EST UN GLISSER-DÉPOSER ===");

// =============================================================================
//  6. glisser_deposer_pose_sous_le_point_de_depose
// =============================================================================
await test("glisser_deposer_pose_sous_le_point_de_depose", async () => {
  await seedModel([]);
  const pal = await palette("chair");
  const cible = { x: 210, y: 90 };
  await drag(pal, await aptPoint(cible.x, cible.y), 10);
  const P = await pieces();
  ok(P.length === 1, `un meuble attendu, ${P.length}`);
  if (P.length) {
    const c = { x: P[0].x + P[0].w / 2, y: P[0].y + P[0].h / 2 };
    ok(Math.abs(c.x - cible.x) <= 6 && Math.abs(c.y - cible.y) <= 6,
      `le meuble doit atterrir SOUS le point de dépose (visé ${JSON.stringify(cible)}, obtenu ${JSON.stringify(c)})`);
  }
  const restes = await J(`document.querySelectorAll(".place-ghost,.place-wall-hl,.place-say").length`);
  ok(restes === 0, `l'aperçu doit disparaître à la fin du geste (${restes} restant(s))`);
});

// =============================================================================
//  7. l_apercu_dit_a_l_avance_ce_qui_sera_refuse
// =============================================================================
// A wall-mounted object released far from any wall does not get placed. The ghost must say so
// BEFORE release (dashed outline, on-screen message, no highlighted segment) and turn solid as
// soon as a wall is within reach. We read the COMPUTED properties, never the styles as written:
// that's exactly where the "you see nothing before releasing" regression was visible (an invalid
// `background` value is accepted by the style API and DROPPED by the engine, cf. tests/apercu-pose.ts).
await test("l_apercu_dit_a_l_avance_ce_qui_sera_refuse", async () => {
  await seedModel([]);
  const pal = await palette("plug");
  const loin = await aptPoint(210, 60), surMur = await aptPoint(210, 190);
  const etat = () => J(`(function(){
    var g=document.querySelector(".place-ghost");
    var h=document.querySelector(".place-wall-hl"), s=document.querySelector(".place-say");
    if(!g) return {fantome:0};
    var cs=getComputedStyle(g);
    return {fantome:1, refuse:g.classList.contains("refuse"), style:cs.borderTopStyle,
            fond:cs.backgroundColor, icone:!!g.querySelector("svg.picon"),
            dit:(s&&!s.hidden)?s.textContent:null,
            mur:!!(h&&!h.hidden)};})()`);
  await moveMouse(pal);
  await M("mousePressed", pal.x, pal.y);
  await M("mouseMoved", loin.x, loin.y); await pause(80);
  const a = await etat();
  ok(a.fantome === 1 && a.refuse && a.style === "dashed" && !a.mur && !!a.dit,
    "loin de tout mur, l'aperçu doit être visiblement REFUSÉ et le DIRE : " + JSON.stringify(a));
  await M("mouseMoved", surMur.x, surMur.y); await pause(80);
  const b = await etat();
  ok(b.fantome === 1 && !b.refuse && b.style === "solid" && b.mur && !b.dit,
    "au contact d'un mur, l'aperçu doit être PLEIN et le mur surligné : " + JSON.stringify(b));
  ok(b.icone && b.fond !== "rgba(0, 0, 0, 0)",
    "et il montre l'OBJET, avec un fond réellement peint : " + JSON.stringify(b));
  await M("mouseReleased", surMur.x, surMur.y, { buttons: 0 });
  await pause(150);
  ok((await ouvertures()).length === 1, "et le lâcher pose bien l'objet");
});

// =============================================================================
//  8. clic_sur_la_vignette_arme_la_pose
// =============================================================================
// A click no longer makes the object appear somewhere other than under the hand: it ARMS.
// The thumbnail shows it, the cursor shows it, a banner says it, Escape abandons it.
await test("clic_sur_la_vignette_arme_la_pose", async () => {
  await seedModel([]);
  await evaluate(`__plan.setCursorApt(50,50)`);   // a "last cursor" elsewhere, on purpose
  await click(await palette("chair"));
  const arme = await J(`({t:__plan.poseArme, vignettes:__plan.paletteArmed(), posing:__plan.posing})`);
  ok((await pieces()).length === 0, "un clic sur la vignette ne pose RIEN");
  ok(arme.t === "chair" && arme.vignettes.length === 1 && arme.posing,
    "il ARME la pose, et ça se voit : " + JSON.stringify(arme));
  const t = await toast();
  ok(!!t && /plan to place/.test(t), "et ça se DIT : " + JSON.stringify(t));

  // the next click on the plan places under the pointer, not at the last known cursor
  await click(await aptPoint(300, 90));
  const P = await pieces();
  ok(P.length === 1, `un meuble attendu après le clic sur le plan, ${P.length}`);
  if (P.length) {
    const c = { x: P[0].x + P[0].w / 2, y: P[0].y + P[0].h / 2 };
    ok(Math.abs(c.x - 300) <= 6 && Math.abs(c.y - 90) <= 6,
      `posé sous le pointeur, pas ailleurs : ${JSON.stringify(c)}`);
  }
  ok(!(await evaluate(`__plan.poseArme`)), "la pose armée se consomme");

  // Escape abandons it, and says so
  await click(await palette("chair"));
  await evaluate(`__plan.clearToast()`);
  await key("Escape", "Escape", 27);
  ok(!(await evaluate(`__plan.poseArme`)) && !(await evaluate(`__plan.posing`)), "Échap désarme");
  const t2 = await toast();
  ok(!!t2 && /cancelled/.test(t2), "et Échap le DIT : " + JSON.stringify(t2));
  ok((await pieces()).length === 1, "et rien de plus n'a été posé");
});

// =============================================================================
//  9. chemin_tactile_pose_sous_le_doigt
// =============================================================================
// The phone is a REAL use case (furnishing the apartment while walking through it). Dragging with
// a finger from the drawer would require closing the drawer mid-gesture: so we keep two taps,
// thumbnail then location. Nothing lands "at the center of the view" anymore.
await test("chemin_tactile_pose_sous_le_doigt", async () => {
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await reload();
  await seedModel([]);
  ok(await evaluate(`__plan.COARSE`), "le pointeur doit être vu comme GROSSIER (tactile)");
  const btn = await J(`(function(){var e=document.getElementById("btnRail");var r=e.getBoundingClientRect();
    return {x:r.left+r.width/2, y:r.top+r.height/2};})()`);
  await tap(btn.x, btn.y);
  ok(await evaluate(`document.querySelector(".app").classList.contains("rail-open")`), "le tiroir doit s'ouvrir");
  const vign = await palette("chair");
  await tap(vign.x, vign.y);
  ok((await pieces()).length === 0, "toucher la vignette ne pose RIEN");
  ok(!(await evaluate(`document.querySelector(".app").classList.contains("rail-open")`)),
    "le tiroir se referme pour qu'on VOIE où l'on pose");
  ok(await evaluate(`__plan.poseArme`) === "chair", "la pose est armée");
  const t = await toast();
  ok(!!t && /Tap the plan/.test(t), "et le message est celui du doigt : " + JSON.stringify(t));

  const centreVue = await J(`(function(){var c=__plan.viewCenterApt();return {x:Math.round(c.x),y:Math.round(c.y)};})()`);
  const doigt = await aptPoint(100, 90);
  await tap(doigt.x, doigt.y);
  const P = await pieces();
  ok(P.length === 1, `un meuble attendu, ${P.length}`);
  if (P.length) {
    const c = { x: P[0].x + P[0].w / 2, y: P[0].y + P[0].h / 2 };
    ok(Math.abs(c.x - 100) <= 8 && Math.abs(c.y - 90) <= 8,
      `posé SOUS LE DOIGT (visé 100/90, obtenu ${JSON.stringify(c)})`);
    ok(Math.hypot(c.x - centreVue.x, c.y - centreVue.y) > 20,
      "et surtout PAS au centre de la vue : " + JSON.stringify({ c, centreVue }));
  }
  await send("Emulation.clearDeviceMetricsOverride");
  await send("Emulation.setTouchEmulationEnabled", { enabled: false });
});

// =============================================================================
//  10. la_cale_des_panneaux_n_avale_aucun_clic
// =============================================================================
// `.side-panels>*{pointer-events:auto}` made the SPACER clickable. It takes up the whole
// remaining height of the column: a 238px strip to the right of the plan received nothing on a
// desktop screen, and on a phone (full-width column) it was the ENTIRE PLAN.
await test("la_cale_des_panneaux_n_avale_aucun_clic", async () => {
  await seedModel([]);
  const morts = await J(`(function(){
    var vr=document.getElementById("viewport").getBoundingClientRect(), n=0, ex=null;
    for(var fx=0.05; fx<=0.97; fx+=0.06) for(var fy=0.1; fy<=0.92; fy+=0.1){
      var e=document.elementFromPoint(vr.left+vr.width*fx, vr.top+vr.height*fy);
      var c=e?String(e.className||""):"";
      if(c.indexOf("side-spacer")>=0||c.indexOf("side-panels")>=0){ n++; ex=ex||c; }
    }
    return {n:n, ex:ex};})()`);
  ok(morts.n === 0, `aucun point du plan ne doit tomber sur la cale (${morts.n} points morts, ex. « ${morts.ex} »)`);
  // and a click on that strip does select the piece of furniture sitting there
  await evaluate(`__plan.addRoomPiece("chair", 400, 60)`);
  await pause(120);
  const P = await pieces();
  const el = await centreEcran(P[P.length - 1].id);
  await click(el);
  ok(await evaluate(`__plan.selCount`) === 1, "un meuble posé sous l'ancienne zone morte doit se sélectionner au clic");
});

console.log("\n=== C. COPIER / COUPER / COLLER ===");

const TROIS = [
  { id: "pa", type: "chair", name: "Chaise", x: 40, y: 40, w: 45, h: 45, rot: 0 },
  { id: "pb", type: "chair", name: "Chaise 2", x: 100, y: 40, w: 45, h: 45, rot: 0 },
  { id: "pc", type: "dining", name: "Table", x: 40, y: 95, w: 120, h: 60, rot: 0 },
];

// =============================================================================
//  11. copier_coller_sous_le_curseur
// =============================================================================
await test("copier_coller_sous_le_curseur", async () => {
  await seedModel(TROIS);
  await click(await centreEcran("pa"));
  ok(await evaluate(`__plan.selCount`) === 1, "la chaise doit être sélectionnée");
  await ctrl("c", "KeyC", 67);
  const clip = await J(`__plan.clipInfo()`);
  ok(clip && clip.n === 1, "le presse-papiers doit porter 1 objet : " + JSON.stringify(clip));
  await moveMouse(await aptPoint(300, 280));
  await ctrl("v", "KeyV", 86);
  const P = await pieces();
  ok(P.length === 4, `un objet de plus attendu (3 -> ${P.length})`);
  const neuf = P.find((p: VerdictSonde) => !TROIS.some(q => q.id === p.id));
  if (ok(neuf, "aucun objet neuf")) {
    ok(Math.abs(neuf.x + neuf.w / 2 - 300) <= 6 && Math.abs(neuf.y + neuf.h / 2 - 280) <= 6,
      `la copie doit atterrir SOUS LE CURSEUR : ${JSON.stringify({ x: neuf.x + neuf.w / 2, y: neuf.y + neuf.h / 2 })}`);
    ok(neuf.type === "chair" && neuf.w === 45 && neuf.h === 45, "et garder son type et ses cotes");
    ok(String(neuf.id) !== "pa", "avec un identifiant NEUF");
    ok(/-[a-z0-9]+$/.test(String(neuf.id)),
      `identifiant fabriqué par la fabrique à étiquette d'appareil : ${neuf.id}`);
  }
  ok(await evaluate(`__plan.selCount`) === 1, "la copie devient la sélection");
});

// =============================================================================
//  12. coller_conserve_la_disposition_relative
// =============================================================================
await test("coller_conserve_la_disposition_relative", async () => {
  await seedModel(TROIS);
  await click(await centreEcran("pa"));
  await click(await centreEcran("pb"), 2);
  await click(await centreEcran("pc"), 2);
  ok(await evaluate(`__plan.selCount`) === 3, "trois objets sélectionnés");
  await ctrl("c", "KeyC", 67);
  await moveMouse(await aptPoint(210, 270));
  await ctrl("v", "KeyV", 86);
  const P = await pieces();
  ok(P.length === 6, `trois objets de plus attendus (3 -> ${P.length})`);
  const rel = (l: VerdictSonde) => {
    const cx = l.reduce((s: VerdictSonde, p: VerdictSonde) => s + p.x + p.w / 2, 0) / l.length;
    const cy = l.reduce((s: VerdictSonde, p: VerdictSonde) => s + p.y + p.h / 2, 0) / l.length;
    return l.map((p: VerdictSonde) => [Math.round(p.x + p.w / 2 - cx), Math.round(p.y + p.h / 2 - cy)]);
  };
  const src = rel(P.filter((p: VerdictSonde) => TROIS.some(q => q.id === p.id)));
  const cop = rel(P.filter((p: VerdictSonde) => !TROIS.some(q => q.id === p.id)));
  const memeDispo = src.length === cop.length &&
    src.every((v: VerdictSonde, i: number) => Math.abs(v[0] - cop[i][0]) <= 1 && Math.abs(v[1] - cop[i][1]) <= 1);
  ok(memeDispo, `la disposition relative doit être IDENTIQUE (à 1 cm d'arrondi près) :\n          ${JSON.stringify(src)}\n          ${JSON.stringify(cop)}`);
  ok(await evaluate(`__plan.selCount`) === 3, "les trois copies deviennent la sélection");
});

// =============================================================================
//  13. un_seul_cran_d_annulation_par_collage
// =============================================================================
await test("un_seul_cran_d_annulation_par_collage", async () => {
  await seedModel(TROIS);
  await click(await centreEcran("pa"));
  await click(await centreEcran("pb"), 2);
  await click(await centreEcran("pc"), 2);
  await ctrl("c", "KeyC", 67);
  await moveMouse(await aptPoint(280, 270));
  await ctrl("v", "KeyV", 86);
  ok((await pieces()).length === 6, "trois copies posées");
  await ctrl("z", "KeyZ", 90);
  const P = await pieces();
  ok(P.length === 3, `UN seul Ctrl+Z doit défaire TOUT le collage (${P.length} objets restants)`);
  ok(TROIS.every(t => P.some((p: VerdictSonde) => p.id === t.id)), "et ne toucher à rien d'autre");
});

// =============================================================================
//  14. couper_puis_coller
// =============================================================================
await test("couper_puis_coller", async () => {
  await seedModel(TROIS);
  await click(await centreEcran("pc"));
  await ctrl("x", "KeyX", 88);
  let P = await pieces();
  ok(P.length === 2 && !P.some((p: VerdictSonde) => p.id === "pc"), `Ctrl+X retire l'objet (${P.length} restants)`);
  await moveMouse(await aptPoint(300, 280));
  await ctrl("v", "KeyV", 86);
  P = await pieces();
  ok(P.length === 3, `Ctrl+V le repose (${P.length})`);
  const neuf = P.find((p: VerdictSonde) => p.id !== "pa" && p.id !== "pb");
  ok(neuf && neuf.type === "dining" && neuf.w === 120 && neuf.h === 60, "avec son type et ses cotes : " + JSON.stringify(neuf));
});

// =============================================================================
//  15. verrouille_colle_deverrouille_et_le_dit
// =============================================================================
// A locked object can be copied (it's a copy, not a modification), but the copy is born
// UNLOCKED: it has just landed, it's being placed. Silent, this would be an
// immovable object with no explanation.
await test("verrouille_colle_deverrouille_et_le_dit", async () => {
  await seedModel([Object.assign({}, TROIS[0], { locked: true })]);
  await click(await centreEcran("pa"));
  await ctrl("c", "KeyC", 67);
  await moveMouse(await aptPoint(300, 280));
  await evaluate(`__plan.clearToast()`);
  await ctrl("v", "KeyV", 86);
  const P = await pieces();
  const neuf = P.find((p: VerdictSonde) => p.id !== "pa");
  ok(!!neuf, "la copie doit exister");
  if (neuf) ok(neuf.locked === false, "la copie ne doit PAS être verrouillée");
  const t = await toast();
  ok(!!t && /UNLOCKED/.test(t), "et ça doit être DIT : " + JSON.stringify(t));
});

// =============================================================================
//  16. ctrl_c_dans_un_champ_reste_du_texte
// =============================================================================
await test("ctrl_c_dans_un_champ_reste_du_texte", async () => {
  await seedModel(TROIS);
  await click(await centreEcran("pa"));
  await evaluate(`(function(){var f=document.getElementById("iName"); f.focus(); f.select(); return f.value;})()`);
  await ctrl("c", "KeyC", 67);
  ok((await J(`__plan.clipInfo()`)) === null,
    "un Ctrl+C dans le champ de nom ne doit RIEN mettre dans le presse-papiers de meubles");
  ok(await evaluate(`document.activeElement && document.activeElement.id`) === "iName",
    "et le champ garde le focus");
  // Ctrl+X must not delete the furniture under the input field either
  await ctrl("x", "KeyX", 88);
  ok((await pieces()).length === 3, "et Ctrl+X dans un champ ne supprime aucun meuble");
});

// =============================================================================
//  17. objet_mural_colle_sur_le_mur_le_plus_proche
// =============================================================================
// A wall-mounted object belongs to a WALL, not to a point: pasting it means attaching it to the
// wall closest to the paste point, exactly like a drag. Far from any wall, it's refused, and said.
await test("objet_mural_colle_sur_le_mur_le_plus_proche", async () => {
  await seedModel([]);
  await drag(await palette("plug"), await aptPoint(120, 192), 10);
  const O0 = await ouvertures();
  if (!ok(O0.length === 1, "la prise de départ n'est pas posée")) return;
  await evaluate(`__plan.selReplace(${JSON.stringify(O0[0].id)})`);
  await ctrl("c", "KeyC", 67);
  const clip = await J(`__plan.clipInfo()`);
  ok(clip && clip.muraux === 1, "le presse-papiers doit porter un objet MURAL : " + JSON.stringify(clip));
  // a) near a wall: attached, width kept
  await moveMouse(await aptPoint(320, 188));
  await ctrl("v", "KeyV", 86);
  let O = await ouvertures();
  ok(O.length === 2, `une ouverture de plus attendue (${O.length})`);
  const neuf = O.find((o: VerdictSonde) => o.id !== O0[0].id);
  if (neuf) {
    ok(neuf.wall === "wA", "collée sur le mur le plus proche : " + neuf.wall);
    ok(Math.abs(neuf.t0 + neuf.w / 2 - 320) <= 6, `au point de collage (t=${neuf.t0 + neuf.w / 2})`);
    ok(neuf.w === O0[0].w, "avec sa largeur d'origine");
  }
  // b) far from any wall: REJECTION announced
  await moveMouse(await aptPoint(210, 60));
  await evaluate(`__plan.clearToast()`);
  await ctrl("v", "KeyV", 86);
  O = await ouvertures();
  ok(O.length === 2, `loin de tout mur, rien ne doit être collé (${O.length})`);
  const t = await toast();
  ok(!!t && /no wall/.test(t), "et le refus doit être DIT : " + JSON.stringify(t));
});

// =============================================================================
//  18. le_presse_papiers_systeme_traverse_les_onglets
// =============================================================================
// Ctrl+C ALSO writes JSON to the system clipboard (best-effort: insecure context, permission
// refused, the internal copy has already succeeded). On read we use ONLY the `paste`
// event, which requires no permission and therefore cannot pop up a dialog box.
await test("le_presse_papiers_systeme_traverse_les_onglets", async () => {
  await seedModel([]);
  const charge = JSON.stringify({
    app: "plan-2d", kind: "meubles", v: 1,
    items: [{ mural: false, dx: -30, dy: 0, type: "chair", name: "Chaise", w: 45, h: 45, rot: 0 },
            { mural: false, dx: 30, dy: 0, type: "chair", name: "Chaise", w: 45, h: 45, rot: 0 }],
  });
  await moveMouse(await aptPoint(210, 90));
  const r = await evaluate(`(function(){
    var dt=new DataTransfer(); dt.setData("text/plain", ${JSON.stringify(charge)});
    var e=new ClipboardEvent("paste",{bubbles:true,cancelable:true,clipboardData:dt});
    document.body.dispatchEvent(e); return 1;})()`);
  await pause(200);
  const P = await pieces();
  ok(P.length === 2, `deux meubles attendus depuis le presse-papiers système (${P.length})`);
  if (P.length === 2) {
    const d = Math.abs((P[0].x + P[0].w / 2) - (P[1].x + P[1].w / 2));
    ok(Math.abs(d - 60) <= 2, `l'écart des deux copies doit être conservé (${d} cm au lieu de 60)`);
  }
  // a foreign payload does not pretend to work
  await evaluate(`__plan.clipReset()`);
  await evaluate(`__plan.clearToast()`);
  await evaluate(`(function(){
    var dt=new DataTransfer(); dt.setData("text/plain","bonjour");
    document.body.dispatchEvent(new ClipboardEvent("paste",{bubbles:true,cancelable:true,clipboardData:dt}));})()`);
  await pause(150);
  ok((await pieces()).length === 2, "un texte quelconque ne pose rien");
  const t = await toast();
  ok(!!t && /Nothing to paste/.test(t), "et il le DIT : " + JSON.stringify(t));
});

// ---- verdict ------------------------------------------------------------------------------------
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
