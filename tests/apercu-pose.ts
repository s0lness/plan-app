#!/usr/bin/env node
// =============================================================================
//  "YOU SEE WHAT YOU'RE PLACING" SUITE: REAL MOUSE, REAL FINGER (CDP)
// =============================================================================
// Regression as measured: "when drag & dropping i should see the object moving around the screen
// with my mouse to better aim to where i'm going, right now i don't see anything until i release".
//
// The cause, measured headless and not guessed at: the placement ghost was setting
// `ghost.style.background = t.color + "55"`, and `t.color` holds `var(--seat)` (the catalog carries
// CSS custom properties, not hex colors). The resulting string, `var(--seat)55`, is NOT a valid CSS
// color: the browser IGNORES it. `getComputedStyle(ghost).backgroundColor` therefore came out as
// `rgba(0, 0, 0, 0)`: all that was left was a one-pixel, transparent sliver, on top of a loaded plan.
// The preview existed, it was just invisible.
//
// What is locked down here:
//   - the ghost has a background that is REALLY painted (the regression, measured on the computed property);
//   - it shows the OBJECT (the same icon as the plan), at the right size and orientation;
//   - it FOLLOWS the pointer during the gesture, mouse and finger alike;
//   - for a wall-mounted object, the TARGETED WALL and FACE are visible;
//   - an impossible placement SAYS SO, on screen, before release;
//   - an object ALREADY PLACED (furniture or opening) also moves while being dragged.
//
//   node tests/apercu-pose.ts [path/to/app.html]
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-apercu-"));
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

// ---- REAL mouse / REAL finger ------------------------------------------------------------------
const M = (type: string, x: VerdictSonde, y: VerdictSonde, extra?: Record<string, unknown>) => send("Input.dispatchMouseEvent", Object.assign({
  type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1,
  clickCount: 1, pointerType: "mouse",
}, extra || {}));
const moveMouse = async (p: VerdictSonde) => { await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 }); await pause(60); };
async function click(p: VerdictSonde) {
  await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 });
  await M("mousePressed", p.x, p.y);
  await M("mouseReleased", p.x, p.y, { buttons: 0 });
  await pause(120);
}
const touch = (type: string, pts: VerdictSonde) => send("Input.dispatchTouchEvent", { type, touchPoints: pts || [] });

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
const toast = () => evaluate(`__plan.toastText`);

// ---- WHAT THE SCREEN REALLY SHOWS -------------------------------------------------------------
// We read the COMPUTED properties, not the styles as written: that's exactly where the regression
// was visible (an invalid CSS value is accepted by the API and dropped by the engine).
const fantome = () => J(`(function(){
  var g=document.querySelector(".place-ghost");
  if(!g) return {present:false};
  var cs=getComputedStyle(g), r=g.getBoundingClientRect();
  var ico=g.querySelector("svg.picon");
  var say=document.querySelector(".place-say"), hl=document.querySelector(".place-wall-hl");
  return {present:true, cache:!!g.hidden || cs.display==="none",
    x:+r.left.toFixed(1), y:+r.top.toFixed(1), w:+r.width.toFixed(1), h:+r.height.toFixed(1),
    cx:+(r.left+r.width/2).toFixed(1), cy:+(r.top+r.height/2).toFixed(1),
    fond:cs.backgroundColor, bord:cs.borderTopColor, opacite:+cs.opacity, transform:cs.transform,
    icone:ico?ico.getAttribute("viewBox"):null, arc:!!g.querySelector("svg.darc"),
    refuse:g.classList.contains("refuse"),
    dit:(say&&!say.hidden)?say.textContent:null,
    mur:(hl&&!hl.hidden)?{len:parseFloat(hl.style.width||"0"), couleur:getComputedStyle(hl).borderTopColor,
                          tr:hl.style.transform}:null};})()`);
// alpha of the computed background: 0 = nothing painted (the bug), >0 = a really visible surface
const alphaDe = (c: VerdictSonde) => {
  const m = /rgba?\(([^)]+)\)/.exec(String(c || ""));
  if (!m) return 0;
  const p = m[1].split(",").map(s => parseFloat(s));
  return p.length < 4 ? 1 : p[3];
};
const angleDe = (tr: VerdictSonde) => {
  const m = /matrix\(([^)]+)\)/.exec(String(tr || ""));
  if (!m) return 0;
  const p = m[1].split(",").map(s => parseFloat(s));
  return ((Math.round(Math.atan2(p[1], p[0]) * 180 / Math.PI) % 360) + 360) % 360;
};

// ---- WAIT FOR A STATE, NEVER A DURATION --------------------------------------------------------
// A fixed pause measures the machine's speed, not the product: under load (8 suites in parallel,
// low priority), 120ms was no longer enough for the ghost to get painted and the case would go
// red, then pass again running solo. We PROBE the real state until it's reached, with a generous
// deadline; on timeout we return the LAST state seen, so the assertion can say what was missing.
async function jusqua(lire: VerdictSonde, cond: VerdictSonde, ms = 10000, pas = 40) {
  const t0 = Date.now();
  let vu = await lire();
  while (!cond(vu)) {
    if (Date.now() - t0 > ms) return vu;
    await pause(pas);
    vu = await lire();
  }
  return vu;
}
const fantomeQuand = (cond: VerdictSonde, ms?: number) => jusqua(fantome, cond, ms);
// Targeting something that is STILL MOVING (a drawer mid-opening) gives stale coordinates:
// we wait until it's there AND has stopped moving before touching it.
async function cibleStable(lire: VerdictSonde, ms = 10000) {
  const t0 = Date.now();
  let avant = null;
  for (;;) {
    const v = await lire();
    if (v && avant && Math.abs(v.x - avant.x) < 0.5 && Math.abs(v.y - avant.y) < 0.5) return v;
    if (Date.now() - t0 > ms) return v || avant;
    avant = v;
    await pause(60);
  }
}

// A test apartment: 420 x 360, cut by ONE horizontal partition wall at y=180.
const MUR = [{ id: "wA", a: [0, 180], b: [420, 180], t: 10, isOutline: false }];
async function seedModel() {
  await evaluate(`__plan.setModel({outline:[[0,0],[420,0],[420,360],[0,360]],
    walls:${JSON.stringify(MUR)}, openings:[], pieces:[], cells:[]}); true`);
  await pause(180);
}

console.log("\n=== LE FANTÔME DE POSE ===");

// =============================================================================
//  1. le_fantome_a_un_fond_reellement_peint
// =============================================================================
// THE regression, on the computed property. `var(--seat)55` is ignored by the engine: the
// background fell back to `rgba(0, 0, 0, 0)` and all that was left was a one-pixel sliver.
await test("le_fantome_a_un_fond_reellement_peint", async () => {
  await seedModel();
  const pal = await palette("sofa3");
  const cible = await aptPoint(200, 90);
  await moveMouse(pal);
  await M("mousePressed", pal.x, pal.y);
  await M("mouseMoved", (pal.x + cible.x) / 2, (pal.y + cible.y) / 2);
  await pause(120);
  const g = await fantome();
  if (!ok(g.present && !g.cache, "un fantôme doit exister PENDANT le geste : " + JSON.stringify(g))) return;
  ok(alphaDe(g.fond) > 0.05, `le fond doit être RÉELLEMENT peint, obtenu ${g.fond}`);
  ok(alphaDe(g.bord) > 0.5, `le bord doit être coloré, obtenu ${g.bord}`);
  ok(g.opacite > 0.5, `le fantôme ne doit pas être quasi transparent, opacité ${g.opacite}`);
  await M("mouseReleased", cible.x, cible.y, { buttons: 0 });
  await pause(200);
});

// =============================================================================
//  2. le_fantome_montre_l_objet_a_la_bonne_taille
// =============================================================================
// "not an abstract rectangle": the ghost carries the SAME icon as the plan (same viewBox), and its
// box has exactly the catalog's dimensions at the current scale.
await test("le_fantome_montre_l_objet_a_la_bonne_taille", async () => {
  await seedModel();
  const S = await evaluate(`__plan.vScale`);
  const cat = await J(`(function(){var t=__plan.TYPEMAP.sofa3; return {w:t.w,h:t.h};})()`);
  const pal = await palette("sofa3");
  const cible = await aptPoint(200, 90);
  await moveMouse(pal);
  await M("mousePressed", pal.x, pal.y);
  await M("mouseMoved", cible.x, cible.y);
  await pause(120);
  const g = await fantome();
  if (!ok(g.present && !g.cache, "fantôme absent")) return;
  ok(g.icone === `0 0 ${cat.w} ${cat.h}`, `l'icône du plan, pas une boîte : viewBox ${JSON.stringify(g.icone)}`);
  ok(Math.abs(g.w - cat.w * S) <= 3, `largeur ${g.w}px pour ${cat.w}cm x ${S.toFixed(3)} = ${(cat.w * S).toFixed(1)}px`);
  ok(Math.abs(g.h - cat.h * S) <= 3, `profondeur ${g.h}px pour ${cat.h}cm x ${S.toFixed(3)} = ${(cat.h * S).toFixed(1)}px`);
  ok(Math.abs(g.cx - cible.x) <= 2 && Math.abs(g.cy - cible.y) <= 2,
    `centré SOUS le pointeur : fantôme ${g.cx}/${g.cy}, pointeur ${cible.x}/${cible.y}`);
  await M("mouseReleased", cible.x, cible.y, { buttons: 0 });
  await pause(200);
});

// =============================================================================
//  3. le_fantome_suit_le_pointeur
// =============================================================================
// "i don't see anything until i release": the ghost must move on EVERY movement, not
// appear only on release. We measure its box at three distinct instants of the same gesture.
await test("le_fantome_suit_le_pointeur", async () => {
  await seedModel();
  const pal = await palette("arm");
  const a = await aptPoint(80, 80), b = await aptPoint(220, 90), c = await aptPoint(340, 100);
  await moveMouse(pal);
  await M("mousePressed", pal.x, pal.y);
  const vus = [];
  for (const p of [a, b, c]) {
    await M("mouseMoved", p.x, p.y);
    await pause(90);
    const g = await fantome();
    vus.push({ vise: p, g: { cx: g.cx, cy: g.cy, cache: g.cache } });
  }
  vus.forEach((v, i) => {
    ok(!v.g.cache, `étape ${i + 1} : le fantôme est peint`);
    ok(Math.abs(v.g.cx - v.vise.x) <= 2 && Math.abs(v.g.cy - v.vise.y) <= 2,
      `étape ${i + 1} : le fantôme est SOUS le pointeur (${JSON.stringify(v)})`);
  });
  ok(vus[0].g.cx !== vus[2].g.cx, "il a réellement bougé entre le début et la fin du geste");
  await M("mouseReleased", c.x, c.y, { buttons: 0 });
  await pause(200);
});

// =============================================================================
//  4. objet_mural_le_mur_et_la_face_se_voient
// =============================================================================
// A window's ghost snaps to the wall, rotates like it, and the TARGETED SEGMENT is highlighted.
// The orientation announced during the gesture must be that of the opening that actually gets placed.
await test("objet_mural_le_mur_et_la_face_se_voient", async () => {
  await seedModel();
  const pal = await palette("window");
  const surMur = await aptPoint(200, 186);       // the BOTTOM face of the y=180 partition
  await moveMouse(pal);
  await M("mousePressed", pal.x, pal.y);
  await M("mouseMoved", surMur.x, surMur.y);
  await pause(150);
  const g = await fantome();
  if (!ok(g.present && !g.cache, "fantôme absent")) return;
  ok(!g.refuse, "sur un mur, le fantôme n'est pas en refus");
  ok(g.mur && g.mur.len > 20, `le MUR visé est surligné (${JSON.stringify(g.mur)})`);
  ok(alphaDe(g.mur && g.mur.couleur) > 0.5, `et le surlignage a une couleur : ${g.mur && g.mur.couleur}`);
  const rotFantome = angleDe(g.transform);
  await M("mouseReleased", surMur.x, surMur.y, { buttons: 0 });
  await pause(250);
  const pose = await J(`(function(){var P=__plan.plan, o=P.openings[P.openings.length-1];
    return o?__plan.v5OpeningPose(o.id):null;})()`);
  if (!ok(pose, "une ouverture doit avoir été posée")) return;
  ok(rotFantome === pose.rot,
    `l'orientation annoncée est celle obtenue : fantôme ${rotFantome}°, posée ${pose.rot}°`);
  ok((await fantome()).present === false, "et le fantôme disparaît au lâcher");
});

// =============================================================================
//  5. une_pose_impossible_le_dit_avant_le_lacher
// =============================================================================
await test("une_pose_impossible_le_dit_avant_le_lacher", async () => {
  await seedModel();
  const pal = await palette("plug");
  const auLarge = await aptPoint(210, 90);       // far from any wall
  await moveMouse(pal);
  await M("mousePressed", pal.x, pal.y);
  await M("mouseMoved", auLarge.x, auLarge.y);
  await pause(150);
  const g = await fantome();
  if (!ok(g.present && !g.cache, "fantôme absent")) return;
  ok(g.refuse, "loin de tout mur, le fantôme est en état REFUSÉ");
  ok(!!g.dit && /wall/i.test(g.dit), `et il DIT pourquoi, à l'écran : ${JSON.stringify(g.dit)}`);
  ok(!g.mur, "aucun mur n'est surligné");
  await M("mouseReleased", auLarge.x, auLarge.y, { buttons: 0 });
  await pause(200);
  ok((await J(`__plan.plan.openings.length`)) === 0, "et rien n'est posé");
});

// =============================================================================
//  6. la_pose_armee_montre_le_fantome_avant_l_appui
// =============================================================================
// An ARMED placement is a placement IN PROGRESS: between clicking the thumbnail and pressing on
// the plan, the cursor used to cross the plan without showing anything. The ghost now follows as
// soon as it's armed, and stays hidden while over the rail (there's nothing to target there).
await test("la_pose_armee_montre_le_fantome_avant_l_appui", async () => {
  await seedModel();
  await click(await palette("dining"));
  await pause(150);
  ok(await evaluate(`__plan.poseArme`) === "dining", "la pose est armée");
  const surRail = await J(`(function(){var r=document.querySelector(".rail").getBoundingClientRect();
    return {x:r.left+r.width/2, y:r.top+r.height/2};})()`);
  await moveMouse(surRail);
  ok((await fantome()).cache, "sur le rail : rien à viser, rien à montrer");
  const p = await aptPoint(180, 90);
  await moveMouse(p);
  await pause(120);
  const g = await fantome();
  ok(g.present && !g.cache, "au-dessus du plan, SANS appuyer : le fantôme est là");
  ok(!!g.icone, "et il montre l'objet");
  ok(Math.abs(g.cx - p.x) <= 2 && Math.abs(g.cy - p.y) <= 2, "sous le pointeur");
  // Escape disarms it and the ghost leaves with it.
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await pause(150);
  ok((await fantome()).present === false, "Échap emporte le fantôme avec la pose armée");
});

// =============================================================================
//  7. au_doigt_le_fantome_suit_aussi
// =============================================================================
// With a finger there is no dragging out of the drawer: you touch the thumbnail (that ARMS it)
// then touch the plan. The ghost must follow the finger exactly as it follows the mouse.
await test("au_doigt_le_fantome_suit_aussi", async () => {
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await reload();
  await seedModel();
  const btn = await J(`(function(){var e=document.getElementById("btnRail");var r=e.getBoundingClientRect();
    return {x:r.left+r.width/2, y:r.top+r.height/2};})()`);
  await touch("touchStart", [{ x: btn.x, y: btn.y, id: 1 }]); await pause(40);
  await touch("touchEnd", []);
  // the drawer must open before a thumbnail can be targeted: we WAIT for it
  const vign = await cibleStable(() => palette("arm"));
  ok(!!vign, "le tiroir s'ouvre au doigt et montre le catalogue");
  await touch("touchStart", [{ x: vign.x, y: vign.y, id: 1 }]); await pause(40);
  await touch("touchEnd", []);
  const arme = await jusqua(() => evaluate(`__plan.poseArme`), (v: VerdictSonde) => v === "arm");
  ok(arme === "arm", `toucher la vignette ARME la pose (poseArme=${JSON.stringify(arme)})`);
  const a = await aptPoint(120, 90), b = await aptPoint(260, 120);
  // The drawer closes AFTER arming: touching while it still covers the target means
  // touching the rail ("nothing to target, nothing to show") and not the plan. We wait for it to clear.
  const surLePlan = (p: VerdictSonde) => J(`(function(){var e=document.elementFromPoint(${p.x.toFixed(1)},${p.y.toFixed(1)});
    return !!e && !e.closest(".rail");})()`);
  const degage = await jusqua(() => surLePlan(a), (v: VerdictSonde) => v === true);
  ok(degage === true, "le tiroir se referme et rend le plan visable après l'armement");
  await touch("touchStart", [{ x: a.x, y: a.y, id: 1 }]);
  const g1 = await fantomeQuand((g: VerdictSonde) => g.present && !g.cache);
  ok(g1.present && !g1.cache,
    `au premier contact, le fantôme est peint (dernier état vu : ${JSON.stringify(g1)})`);
  ok(!!g1.icone, "et il montre l'objet, pas une boîte");
  ok(alphaDe(g1.fond) > 0.05, `avec un fond réellement peint (${g1.fond})`);
  await touch("touchMove", [{ x: b.x, y: b.y, id: 1 }]);
  const g2 = await fantomeQuand((g: VerdictSonde) => Math.abs(g.cx - b.x) <= 3 && Math.abs(g.cy - b.y) <= 3);
  ok(Math.abs(g2.cx - b.x) <= 3 && Math.abs(g2.cy - b.y) <= 3,
    `le fantôme suit le DOIGT (${JSON.stringify({ g2: [g2.cx, g2.cy], doigt: [b.x, b.y] })})`);
  await touch("touchEnd", []);
  const pose = await jusqua(() => J(`__plan.plan.pieces.length`), (n: number) => n === 1);
  ok(pose === 1, `et le lâcher pose bien l'objet (pieces.length=${pose})`);
  const g3 = await fantomeQuand((g: VerdictSonde) => g.present === false);
  ok(g3.present === false, `le fantôme est nettoyé (dernier état vu : ${JSON.stringify(g3)})`);
  await send("Emulation.clearDeviceMetricsOverride");
  await send("Emulation.setTouchEmulationEnabled", { enabled: false });
});

console.log("\n=== VISER, C'EST AUSSI DÉPLACER CE QUI EST DÉJÀ POSÉ ===");

// =============================================================================
//  8. un_meuble_deja_pose_bouge_pendant_le_glisser
// =============================================================================
// Same need (targeting): there's no ghost here, it's the object itself that follows the hand. We
// measure it IN THE MIDDLE of the gesture, never at release.
await test("un_meuble_deja_pose_bouge_pendant_le_glisser", async () => {
  await seedModel();
  const p = await J(`__plan.addV5Piece("arm",100,60)`);
  await pause(200);
  const boite = () => J(`(function(){var e=document.querySelector('.piece[data-id="'+${JSON.stringify(String(p.id))}+'"]');
    if(!e) return null; var r=e.getBoundingClientRect(); return {x:+r.left.toFixed(1), y:+r.top.toFixed(1)};})()`);
  const depart = await J(`(function(){var e=document.querySelector('.piece[data-id="'+${JSON.stringify(String(p.id))}+'"]');
    var r=e.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2};})()`);
  const b0 = await boite();
  await moveMouse(depart);
  await M("mousePressed", depart.x, depart.y);
  await M("mouseMoved", depart.x + 40, depart.y + 25); await pause(90);
  const b1 = await boite();
  await M("mouseMoved", depart.x + 90, depart.y + 55); await pause(90);
  const b2 = await boite();
  ok(b1 && Math.hypot(b1.x - b0.x, b1.y - b0.y) > 10,
    `le meuble a bougé PENDANT le geste (${JSON.stringify({ b0, b1 })})`);
  ok(b2 && Math.hypot(b2.x - b1.x, b2.y - b1.y) > 10,
    `et il continue de suivre (${JSON.stringify({ b1, b2 })})`);
  await M("mouseReleased", depart.x + 90, depart.y + 55, { buttons: 0 });
  await pause(200);
});

// =============================================================================
//  9. une_ouverture_deja_posee_bouge_pendant_le_glisser
// =============================================================================
await test("une_ouverture_deja_posee_bouge_pendant_le_glisser", async () => {
  await seedModel();
  const o = await J(`__plan.v5PlaceAt("window",120,186)`);
  await pause(200);
  const boite = () => J(`(function(){var e=document.querySelector('.piece[data-op="1"][data-id="'+${JSON.stringify(String(o.id))}+'"]');
    if(!e) return null; var r=e.getBoundingClientRect(); return {x:+r.left.toFixed(1), y:+r.top.toFixed(1)};})()`);
  const depart = await J(`(function(){var e=document.querySelector('.piece[data-op="1"][data-id="'+${JSON.stringify(String(o.id))}+'"]');
    var r=e.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2};})()`);
  const b0 = await boite();
  await moveMouse(depart);
  await M("mousePressed", depart.x, depart.y);
  await M("mouseMoved", depart.x + 60, depart.y); await pause(90);
  const b1 = await boite();
  ok(b1 && Math.abs(b1.x - b0.x) > 10, `l'ouverture glisse le long du mur PENDANT le geste (${JSON.stringify({ b0, b1 })})`);
  await M("mouseReleased", depart.x + 60, depart.y, { buttons: 0 });
  await pause(200);
});

// =============================================================================
//  10. un_glisser_relache_hors_du_plan_le_dit
// =============================================================================
// A drag started from the palette, walked over the plan and then released ELSEWHERE (the toolbar),
// used to place nothing IN SILENCE. A plain CLICK on the thumbnail goes through the same code
// (the pointer never left the rail) and has nothing to announce: it ARMS the placement, and says so itself.
await test("un_glisser_relache_hors_du_plan_le_dit", async () => {
  await seedModel();
  const pal = await palette("chair");
  const surPlan = await aptPoint(200, 90);
  // the rail's header: solidly outside the plan (>40px), and it isn't a thumbnail
  const barre = await J(`(function(){var r=document.querySelector(".brand").getBoundingClientRect();
    return {x:r.left+r.width/2, y:r.top+r.height/2};})()`);
  await moveMouse(pal);
  await M("mousePressed", pal.x, pal.y);
  await M("mouseMoved", surPlan.x, surPlan.y); await pause(90);
  await M("mouseMoved", barre.x, barre.y); await pause(90);
  const g = await fantome();
  ok(g.refuse, "sorti du plan, le fantôme annonce le refus");
  ok(!!g.dit && /plan/i.test(g.dit), `et il l'écrit : ${JSON.stringify(g.dit)}`);
  await M("mouseReleased", barre.x, barre.y, { buttons: 0 });
  await pause(200);
  ok((await J(`__plan.plan.pieces.length`)) === 0, "rien n'est posé");
  const t = await toast();
  ok(!!t && /outside the plan/i.test(t), `et le bandeau le dit : ${JSON.stringify(t)}`);

  // a plain CLICK, on the other hand, arms it and complains about nothing
  await evaluate(`__plan.clearToast(); true`);
  await click(await palette("chair"));
  await pause(180);
  ok(await evaluate(`__plan.poseArme`) === "chair", "un clic simple ARME la pose");
  const t2 = await toast();
  ok(!t2 || !/outside the plan/i.test(t2), `et ne parle pas de renoncement : ${JSON.stringify(t2)}`);
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
