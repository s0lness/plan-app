#!/usr/bin/env node
// =============================================================================
//  "RESIZE AN OPENING BY THE HANDLE" SUITE: REAL MOUSE (CDP)
// =============================================================================
// Usage request: "i should be able to resize windows". Furniture resizes by
// handles; an opening could only be changed through the "Width" field in the sheet.
//
// What is held here, and why:
//   - TWO handles, at both ends, that lengthen ALONG THE WALL;
//   - the OPPOSITE edge does not move by a centimeter (edge-based resizing): what is under
//     the cursor is what moves, as everywhere else in this application;
//   - the THREE bounds are held AND STATED: the wall, neighbors of the same family ON THE SAME
//     FACE (v5OpeningSameSlot, the back-to-back rule), and the server validator (1..600 cm);
//   - a 10 cm plug socket stays grabbable: under 64 px the handles come out of the box, as for
//     furniture;
//   - DEPTH has no handle (it belongs to the wall);
//   - a single undo step per gesture, Escape restores the exact prior dimension, a clean click writes nothing.
//
//   node tests/ouverture-redim.ts [chemin/vers/app.html]
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-opredim-"));
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
        // The file can be LOCKED (EBUSY: Chrome still has it open), missing (ENOENT), or
        // truncated, especially since several Chrome instances start at once. We RETRY
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

// ---- REAL mouse / REAL keyboard ----------------------------------------------------------------
const M = (type: string, x: VerdictSonde, y: VerdictSonde, extra?: Record<string, unknown>) => send("Input.dispatchMouseEvent", Object.assign({
  type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1,
  clickCount: 1, pointerType: "mouse",
}, extra || {}));
async function drag(from: VerdictSonde, to: VerdictSonde, steps = 14) {
  await M("mouseMoved", from.x, from.y, { button: "none", buttons: 0 });
  await M("mousePressed", from.x, from.y);
  for (let i = 1; i <= steps; i++) {
    await M("mouseMoved", from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
    await pause(9);
  }
  await M("mouseReleased", to.x, to.y, { buttons: 0 });
  await pause(160);
}
async function key(k: string, code: string, vk: VerdictSonde, mods?: number) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk || 0, modifiers: mods || 0 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk || 0, modifiers: mods || 0 });
  await pause(150);
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

// ---- the test apartment ----------------------------------------------------------------------
// An L x 360 rectangle cut by ONE horizontal partition at y=180: a straight wall, of chosen length,
// whose BOTH faces are habitable (so back-to-back makes sense).
async function seedModel(L?: VerdictSonde) {
  const l = L || 420;
  await evaluate(`__plan.setModel({outline:[[0,0],[${l},0],[${l},360],[0,360]],
    walls:[{id:"wA", a:[0,180], b:[${l},180], t:10, isOutline:false}],
    openings:[], pieces:[], cells:[]}); true`);
  await pause(180);
}
const geom = (id: string) => J(`__plan.openingGeom(${JSON.stringify(String(id))})`);
const poignees = (id: string) => J(`__plan.openingHandles(${JSON.stringify(String(id))})`);
const toast = () => evaluate(`__plan.toastText`);
const undoDepth = () => J(`__plan.histInfo().undo`);
// screen x per centimeter of wall (the test wall is horizontal, a->b toward +x)
const pxParCm = () => evaluate(`__plan.vScale`);
const poseFenetre = (ax: VerdictSonde, ay: VerdictSonde, type?: string) => J(`__plan.v5PlaceAt(${JSON.stringify(type || "window")},${ax},${ay})`);

console.log("\n=== LES POIGNÉES ===");

// =============================================================================
//  1. deux_poignees_sur_l_ouverture_selectionnee
// =============================================================================
await test("deux_poignees_sur_l_ouverture_selectionnee", async () => {
  await seedModel();
  const o = await poseFenetre(200, 186);
  await pause(200);
  const h = await poignees(o.id);
  ok(h.length === 2, `deux poignées attendues, ${h.length}`);
  ok(h.some((x: VerdictSonde) => x.end === "lo") && h.some((x: VerdictSonde) => x.end === "hi"), "une par extrémité : " + JSON.stringify(h.map((x: VerdictSonde) => x.end)));
  // outside selection: none
  await evaluate(`__plan.clearSel(); __plan.render(); true`); await pause(150);
  ok((await J(`(function(){return document.querySelectorAll('.piece[data-op="1"] .rsz-handle').length;})()`)) === 0,
    "rien de sélectionné : aucune poignée dans le DOM");
  // Re-selecting always restores the handles. Structural controls never freeze openings.
  await evaluate(`__plan.selReplace(${JSON.stringify(String(o.id))}); __plan.render(); true`);
  await pause(180);
  ok((await J(`(function(){return document.querySelectorAll('.piece[data-op="1"] .rsz-handle').length;})()`)) === 2,
    "une ouverture sélectionnée garde toujours ses deux poignées");
});

// =============================================================================
//  2. allonger_par_un_bord_l_autre_ne_bouge_pas
// =============================================================================
// The central arbitration: the grabbed edge follows the hand, the opposite edge is FIXED. We measure it
// from both sides: by "hi", t0 does not move; by "lo", t0+w does not move.
await test("allonger_par_un_bord_l_autre_ne_bouge_pas", async () => {
  await seedModel();
  const o = await poseFenetre(200, 186);
  await pause(200);
  const S = await pxParCm();
  const a0 = await geom(o.id);
  let h = (await poignees(o.id)).find((x: VerdictSonde) => x.end === "hi");
  await drag(h, { x: h.x + 60 * S, y: h.y });          // +60 cm toward b
  const a1 = await geom(o.id);
  ok(a1.t0 === a0.t0, `par « hi », t0 est FIGÉ : ${a0.t0} -> ${a1.t0}`);
  ok(Math.abs(a1.w - (a0.w + 60)) <= 6, `et la largeur suit la main : ${a0.w} -> ${a1.w} (visé ${a0.w + 60})`);

  h = (await poignees(o.id)).find((x: VerdictSonde) => x.end === "lo");
  const b0 = await geom(o.id);
  await drag(h, { x: h.x - 40 * S, y: h.y });          // -40 cm toward a: we LENGTHEN from the left
  const b1 = await geom(o.id);
  ok(Math.abs((b0.t0 + b0.w) - (b1.t0 + b1.w)) < 0.05,
    `par « lo », le bord opposé est FIGÉ : ${(b0.t0 + b0.w).toFixed(2)} -> ${(b1.t0 + b1.w).toFixed(2)}`);
  ok(Math.abs(b1.w - (b0.w + 40)) <= 6, `et la largeur suit : ${b0.w} -> ${b1.w} (visé ${b0.w + 40})`);
  ok(b1.h === b0.h, `la PROFONDEUR ne bouge pas : ${b0.h} -> ${b1.h}`);
});

console.log("\n=== LES BORNES, TENUES ET DITES ===");

// =============================================================================
//  3. bute_sur_un_voisin_de_la_meme_face_et_le_dit
// =============================================================================
await test("bute_sur_un_voisin_de_la_meme_face_et_le_dit", async () => {
  await seedModel();
  const a = await poseFenetre(100, 186);
  const b = await poseFenetre(300, 186);
  await pause(220);
  const S = await pxParCm();
  const av = await geom(a.id), vb = await geom(b.id);
  const lim = await J(`__plan.openingLimits(${JSON.stringify(String(a.id))})`);
  ok(lim.hiQui, "le voisin est vu comme borne : " + JSON.stringify(lim));
  await evaluate(`__plan.clearToast(); true`);
  const h = (await poignees(a.id)).find((x: VerdictSonde) => x.end === "hi");
  await drag(h, { x: h.x + 400 * S, y: h.y });          // well beyond the neighbor
  const ap = await geom(a.id), apb = await geom(b.id);
  ok(Math.abs((ap.t0 + ap.w) - vb.t0) < 0.6,
    `la fenêtre s'arrête PILE au voisin : bord ${(ap.t0 + ap.w).toFixed(1)}, voisin à ${vb.t0}`);
  ok(ap.t0 + ap.w <= vb.t0 + 0.05, "aucun recouvrement");
  ok(apb.t0 === vb.t0 && apb.w === vb.w, "et le voisin n'a pas bougé");
  const t = await toast();
  ok(!!t && /runs into/.test(t), `et ça se DIT, en nommant le voisin : ${JSON.stringify(t)}`);
  ok(av.w > 0, `(la fenêtre saisie avait bien une largeur de départ : ${av.w})`);
  // A neighbor on the OTHER face does not bound (back-to-back rule, already shipped)
  await seedModel();
  const c = await poseFenetre(100, 186, "plug");
  const d = await poseFenetre(300, 174, "plug");        // OPPOSITE face
  await pause(200);
  const l2 = await J(`__plan.openingLimits(${JSON.stringify(String(c.id))})`);
  const gd = await geom(d.id);
  ok(!l2.hiQui, `un objet de l'AUTRE face ne borne pas : ${JSON.stringify({ l2, gd })}`);
});

// =============================================================================
//  4. bute_sur_le_bout_du_mur_et_le_dit
// =============================================================================
await test("bute_sur_le_bout_du_mur_et_le_dit", async () => {
  await seedModel();
  const o = await poseFenetre(340, 186);
  await pause(200);
  const S = await pxParCm();
  const L = (await J(`__plan.openingLimits(${JSON.stringify(String(o.id))})`)).L;
  await evaluate(`__plan.clearToast(); true`);
  const h = (await poignees(o.id)).find((x: VerdictSonde) => x.end === "hi");
  await drag(h, { x: h.x + 500 * S, y: h.y });
  const g = await geom(o.id);
  ok(Math.abs((g.t0 + g.w) - L) < 0.6, `le bord s'arrête au bout du mur : ${(g.t0 + g.w).toFixed(1)} / ${L}`);
  const t = await toast();
  ok(!!t && /This wall is/.test(t), `et le bandeau donne la longueur du mur : ${JSON.stringify(t)}`);
});

// =============================================================================
//  5. bute_sur_la_borne_du_serveur_600
// =============================================================================
// `OPENING_W_MAX = 600` (live-worker/ops.ts). Exceeding it is a REFUSED op, hence a LOST
// modification: the handle stops before that, and says so. A 900 cm wall so only this bound plays.
await test("bute_sur_la_borne_du_serveur_600", async () => {
  await seedModel(900);
  const o = await poseFenetre(300, 186);
  await pause(220);
  const S = await pxParCm();
  await evaluate(`__plan.clearToast(); true`);
  const h = (await poignees(o.id)).find((x: VerdictSonde) => x.end === "hi");
  await drag(h, { x: h.x + 800 * S, y: h.y }, 20);
  const g = await geom(o.id);
  ok(g.w <= 600.01, `jamais plus de 600 cm : obtenu ${g.w}`);
  ok(g.w >= 595, `et on y arrive vraiment : ${g.w}`);
  const t = await toast();
  ok(!!t && /600/.test(t), `et la borne est DITE : ${JSON.stringify(t)}`);
});

// =============================================================================
//  6. jamais_moins_que_la_largeur_minimale
// =============================================================================
await test("jamais_moins_que_la_largeur_minimale", async () => {
  await seedModel();
  const o = await poseFenetre(200, 186);
  await pause(200);
  const S = await pxParCm();
  const g0 = await geom(o.id);
  await evaluate(`__plan.clearToast(); true`);
  const h = (await poignees(o.id)).find((x: VerdictSonde) => x.end === "hi");
  await drag(h, { x: h.x - 300 * S, y: h.y }, 20);      // we cross past the other edge
  const g = await geom(o.id);
  ok(g.w >= 5 && g.w <= 6, `la largeur plancher est tenue : ${g.w}`);
  ok(g.t0 === g0.t0, `et le bord figé n'a toujours pas bougé : ${g0.t0} -> ${g.t0}`);
  const t = await toast();
  ok(!!t && /narrower than 5 cm/.test(t), `et ça se dit : ${JSON.stringify(t)}`);
});

console.log("\n=== LE GESTE ===");

// =============================================================================
//  7. un_seul_cran_d_annulation_par_geste
// =============================================================================
await test("un_seul_cran_d_annulation_par_geste", async () => {
  await seedModel();
  const o = await poseFenetre(200, 186);
  await pause(220);
  const S = await pxParCm();
  const av = await geom(o.id);
  const u0 = await undoDepth();
  const h = (await poignees(o.id)).find((x: VerdictSonde) => x.end === "hi");
  await drag(h, { x: h.x + 60 * S, y: h.y }, 18);       // 18 moves: ONE single undo step
  const u1 = await undoDepth();
  ok(u1 === u0 + 1, `un seul cran pour tout le geste : ${u0} -> ${u1}`);
  const ap = await geom(o.id);
  ok(ap.w !== av.w, "la largeur a bien changé");
  await key("z", "KeyZ", 90, 2);                        // Ctrl+Z
  await pause(200);
  const re = await geom(o.id);
  ok(re.w === av.w && re.t0 === av.t0, `et Ctrl+Z rend la cote d'avant : ${JSON.stringify({ av, re })}`);
});

// =============================================================================
//  8. echap_rend_exactement_la_cote_d_avant
// =============================================================================
await test("echap_rend_exactement_la_cote_d_avant", async () => {
  await seedModel();
  const o = await poseFenetre(200, 186);
  await pause(220);
  const S = await pxParCm();
  const av = await geom(o.id);
  const h = (await poignees(o.id)).find((x: VerdictSonde) => x.end === "hi");
  await M("mouseMoved", h.x, h.y, { button: "none", buttons: 0 });
  await M("mousePressed", h.x, h.y);
  await M("mouseMoved", h.x + 40 * S, h.y); await pause(120);
  const pendant = await geom(o.id);
  ok(pendant.w > av.w, `la largeur suit PENDANT le geste : ${av.w} -> ${pendant.w}`);
  ok((await evaluate(`__plan.rszReadout()`)) !== null, "et la cote vivante s'affiche");
  await key("Escape", "Escape", 27);
  await M("mouseReleased", h.x + 40 * S, h.y, { buttons: 0 });
  await pause(220);
  const ap = await geom(o.id);
  ok(ap.w === av.w && ap.t0 === av.t0, `Échap rend EXACTEMENT la cote d'avant : ${JSON.stringify({ av, ap })}`);
  ok((await J(`__plan.gestureArmed`)) === false, "et le geste est bien terminé (aucun geste armé)");
  ok((await evaluate(`__plan.rszReadout()`)) === null, "la cote vivante est retirée");
});

// =============================================================================
//  9. un_clic_net_sur_la_poignee_n_ecrit_rien
// =============================================================================
// Same rule as everywhere: as long as the pointer has not moved, nothing is pushed to history
// and nothing is recomputed.
await test("un_clic_net_sur_la_poignee_n_ecrit_rien", async () => {
  await seedModel();
  const o = await poseFenetre(200, 186);
  await pause(220);
  const av = await geom(o.id);
  const u0 = await undoDepth();
  const h = (await poignees(o.id)).find((x: VerdictSonde) => x.end === "hi");
  await M("mouseMoved", h.x, h.y, { button: "none", buttons: 0 });
  await M("mousePressed", h.x, h.y);
  await M("mouseReleased", h.x, h.y, { buttons: 0 });
  await pause(220);
  const ap = await geom(o.id);
  ok(ap.w === av.w && ap.t0 === av.t0, `rien n'a bougé : ${JSON.stringify({ av, ap })}`);
  ok((await undoDepth()) === u0, "et aucun cran d'annulation n'a été poussé");
});

// =============================================================================
//  10. une_prise_de_10_cm_reste_attrapable
// =============================================================================
// A plug socket is 10 cm, i.e. ~6 px: two 9 px handles placed on its edges would cover it
// entirely. Under 64 px, they come OUT of the box (same rule as furniture, js/12).
await test("une_prise_de_10_cm_reste_attrapable", async () => {
  await seedModel();
  const p = await poseFenetre(200, 186, "plug");
  await pause(220);
  const h = await poignees(p.id);
  ok(h.length === 2, `deux poignées, ${h.length}`);
  ok(h.every((x: VerdictSonde) => x.dehors), "sur une si petite ouverture, les DEUX poignées sont hors de la boîte : " + JSON.stringify(h));
  const centre = await J(`(function(){var e=document.querySelector('.piece[data-op="1"][data-id="'+${JSON.stringify(String(p.id))}+'"]');
    var r=e.getBoundingClientRect(); var c={x:r.left+r.width/2, y:r.top+r.height/2};
    var top=document.elementFromPoint(c.x,c.y);
    return {surPoignee:!!(top&&top.classList&&top.classList.contains("rsz-handle")),
            surLObjet:!!(top&&top.closest&&top.closest('.piece[data-op="1"]')), c:c};})()`);
  ok(!centre.surPoignee, "le centre de la prise n'est pas mangé par une poignée");
  ok(centre.surLObjet, "et il tombe bien sur la prise elle-même : " + JSON.stringify(centre));
  // a LARGE opening, though, keeps its handles on the edge
  await seedModel(900);
  const g = await poseFenetre(300, 186);
  await evaluate(`__plan.setInspectorDim("w",500); true`); await pause(400);
  const hg = await poignees(g.id);
  ok(hg.length === 2 && hg.every((x: VerdictSonde) => !x.dehors),
    "au-dessus du seuil, les poignées restent sur le bord : " + JSON.stringify(hg));
});

// =============================================================================
//  11. la_nouvelle_largeur_part_sur_le_fil
// =============================================================================
// A modified field that does not cross the network is a lost modification with no visible error.
// `w` is already a key known to the server (OPENING_KEYS): we verify that an `opening.set` carries it.
await test("la_nouvelle_largeur_part_sur_le_fil", async () => {
  await seedModel();
  const o = await poseFenetre(200, 186);
  await pause(220);
  const S = await pxParCm();
  await evaluate(`__plan.shadowSync(); __plan.outLog(true); true`);
  const h = (await poignees(o.id)).find((x: VerdictSonde) => x.end === "hi");
  await drag(h, { x: h.x + 60 * S, y: h.y });
  await evaluate(`__plan.forceDiff(); true`); await pause(150);
  const out = await J(`__plan.outLog(false)`);
  const g = await geom(o.id);
  const op = out.filter((m: VerdictSonde) => m && m.op && m.op.kind === "opening.set")
    .map((m: VerdictSonde) => m.op).filter((x: VerdictSonde) => x.opening && x.opening.w !== undefined);
  ok(op.length >= 1, "un opening.set portant `w` est émis : " + JSON.stringify(out.map((m: VerdictSonde) => m && m.op && m.op.kind)));
  if (op.length) ok(Math.abs(op[op.length - 1].opening.w - g.w) < 0.05,
    `et il porte la largeur COURANTE : ${op[op.length - 1].opening.w} / ${g.w}`);
});

// =============================================================================
//  12. poignee_deportee_ne_teleporte_pas_le_bord
// =============================================================================
// THE HOLE THIS SUITE HAD. Eleven cases checked the bounds, the fixed edge and the messages, and
// NONE grabbed the handle where it is PAINTED: they grabbed it at the edge of the box, i.e.
// in the one position where the defect is not visible.
//
// G-20 offsets the four corners (and both ends of an opening) by `RSZ_OUT_PX` = 6 px TO THE
// OUTSIDE as soon as the object is short on screen, otherwise the handles eat into its thumbnail. The
// gesture, though, derived the width from the pointer's ABSOLUTE position (`want = t - fixed`)
// without memorizing the grab point: the edge TELEPORTED under the cursor on the first move, i.e. 6 px
// further than it was. Measured on the bench on the real plan, "Fit" scale 0.638 px/cm: a 70 cm
// window dragged by 30 cm gave 110 cm instead of 100, and the handle PUT BACK AT THE EXACT PIXEL
// rendered 80 cm instead of 70. Residual 10 cm at every contact, 3 exact round trips out of 21 in real usage.
// The check that named the cause: zoomed in, the opening exceeds 64 px, the handle goes back
// inside the box, and both the jump and the residual fall to 0.0.
//
// This is G-19 betrayed by G-20: "what is under the cursor is what moves" cannot hold if
// the gesture believes the cursor is on the edge while the render put it somewhere else.
await test("poignee_deportee_ne_teleporte_pas_le_bord", async () => {
  // A LONG wall, hence a small scale: the 80 cm door measures less than 64 px and its handle
  // comes out of the box, exactly as at the opening zoom level of the real plan.
  await seedModel(4000);
  const o = await poseFenetre(2000, 186, "door");
  await pause(220);
  // Snap turned off: the 5 cm grid quantizes the ABSOLUTE width, which is a separate question.
  // Here we measure ONE thing: is the hand followed, and does the round trip come back.
  await evaluate(`__plan.state.opts.snap=false; __plan.render(); true`); await pause(150);
  const S = await pxParCm();
  const a0 = await geom(o.id);
  // Preconditions: without them, the case could pass green while testing a WIDE opening,
  // i.e. the one case where the defect does not exist.
  ok(a0.w * S < 64, `précondition : l'ouverture doit être COURTE à l'écran (${(a0.w * S).toFixed(1)} px, seuil 64)`);
  const h0 = (await poignees(o.id)).find((x: VerdictSonde) => x.end === "hi");
  ok(h0 && h0.dehors === true, "précondition : la poignée doit être peinte HORS de la boîte (G-20)");
  if (!h0) return;

  const depart = { x: h0.x, y: h0.y };
  const D = 60;                                        // what the hand asks for, in cm
  await drag(depart, { x: depart.x + D * S, y: depart.y });
  const a1 = await geom(o.id);
  ok(Math.abs(a1.w - (a0.w + D)) <= 1.5,
    `la largeur suit la MAIN : ${a0.w} + ${D} attendu, obtenu ${a1.w} ` +
    `(saut NON DEMANDÉ ${(a1.w - a0.w - D).toFixed(1)} cm ; 6 px = ${(6 / S).toFixed(1)} cm)`);
  ok(a1.t0 === a0.t0, `et le bord opposé reste figé : ${a0.t0} -> ${a1.t0}`);

  // We put the handle back EXACTLY at the pixel it was taken from: everything must return.
  const h1 = (await poignees(o.id)).find((x: VerdictSonde) => x.end === "hi");
  if (!h1) { ok(false, "la poignée a disparu en cours de geste"); return; }
  await drag({ x: h1.x, y: h1.y }, depart);
  const a2 = await geom(o.id);
  ok(Math.abs(a2.w - a0.w) <= 0.5,
    `poignée REPOSÉE AU PIXEL EXACT : largeur ${a0.w} attendue, obtenue ${a2.w} (RÉSIDU ${(a2.w - a0.w).toFixed(1)} cm)`);
  ok(Math.abs(a2.t0 - a0.t0) <= 0.5,
    `poignée REPOSÉE AU PIXEL EXACT : t0 ${a0.t0} attendu, obtenu ${a2.t0}`);
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
