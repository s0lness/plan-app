#!/usr/bin/env node
// =============================================================================
//  "THE WALL IS A TOOL, THE FLOOR IS A LASSO" SUITE: REAL MOUSE + KEYBOARD (CDP)
// =============================================================================
// Decision 0010. What this suite states, and each line of it is something the previous shape got
// wrong at least once:
//
//   outil_arme_par_le_bouton_et_par_w        the button and W arm the SAME state, `aria-pressed`
//                                            follows, and the layer wears the crosshair.
//   chaine_clic_clic_enchaine_les_segments   one click per corner draws a run of walls that SHARE
//                                            their endpoints exactly; the tool stays armed.
//   double_clic_termine_la_chaine            and leaves the tool armed for the next run.
//   echap_termine_puis_quitte_l_outil        first Escape ends the chain, second one disarms and
//                                            SAYS SO (G-13).
//   longueur_tapee_pose_le_point             digits then Enter place the arrival at that exact
//                                            length, in the direction aimed at.
//   le_sol_lasso_ne_trace_plus               dragging over empty space selects; it creates NO wall.
//   un_mur_selectionne_porte_trois_controles at most: the move disc and its two free ends. Nothing
//                                            at all on hover.
//   la_fiche_porte_couper_et_supprimer       Split and Delete live in the wall sheet; Square up
//                                            only shows on a crooked wall.
//   un_clic_net_sur_un_mur_n_ecrit_rien      AGENTS.md, "A PRESS-RELEASE WITHOUT MOVEMENT NEVER
//                                            WRITES": selecting a wall changes no geometry.
//
//   node tests/outil-mur-geste.ts [path/to/app.html]
//
// Real mouse (`Input.dispatchMouseEvent`), never a synthetic PointerEvent: AGENTS.md, "A click
// lands on what is visible", a synthetic event bypasses hit-testing and the capture-phase wiring
// the tool lives in.
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

// A SEEDED plan (not a blank profile): a blank profile opens the "configure your apartment"
// wizard instead of the ordinary canvas. The geometry is overridden per test through `setModel`.
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "plan-rev177.json"), "utf8"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-outilmur-"));
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

async function reload() {
  await send("Page.navigate", { url: "file:///" + htmlPath.replace(/\\/g, "/") });
  for (let i = 0; i < 200; i++) {
    let st = null;
    try { st = await evaluate("document.readyState + '|' + (window.__plan ? 1 : 0)"); } catch (_) {}
    if (st === "complete|1") break;
    await new Promise(r => setTimeout(r, 50));
  }
  await new Promise(r => setTimeout(r, 300));
}

// ---- REAL mouse and keyboard --------------------------------------------------------------------
const M = (type: string, x: VerdictSonde, y: VerdictSonde, extra?: Record<string, unknown>) => send("Input.dispatchMouseEvent", Object.assign({
  type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1,
  clickCount: 1, pointerType: "mouse",
}, extra || {}));
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function hover(p: VerdictSonde) { await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 }); await pause(60); }
async function press(p: VerdictSonde) { await hover(p); await M("mousePressed", p.x, p.y); await pause(20); }
async function moveTo(p: VerdictSonde, steps = 10, from: VerdictSonde) {
  const a = from || p;
  for (let i = 1; i <= steps; i++) {
    await M("mouseMoved", a.x + (p.x - a.x) * i / steps, a.y + (p.y - a.y) * i / steps);
    await pause(8);
  }
}
async function release(p: VerdictSonde) { await M("mouseReleased", p.x, p.y); await pause(90); }
async function click(p: VerdictSonde) { await press(p); await release(p); }
async function drag(from: VerdictSonde, to: VerdictSonde, steps = 14) { await press(from); await moveTo(to, steps, from); await release(to); }
/** A REAL double-click: the second press carries `clickCount: 2`, so `detail` is 2 as in a browser. */
async function doubleClick(p: VerdictSonde) {
  await click(p);
  await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 });
  await M("mousePressed", p.x, p.y, { clickCount: 2 });
  await M("mouseReleased", p.x, p.y, { clickCount: 2, buttons: 0 });
  await pause(120);
}
async function key(k: string, code: string) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, text: k.length === 1 ? k : undefined });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code });
  await pause(90);
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

const centerOf = (sel: VerdictSonde) => J(`(function(){var e=document.querySelector(${JSON.stringify(sel)});
  if(!e) return null; var r=e.getBoundingClientRect(); if(!r.width&&!r.height) return null;
  return {x:r.left+r.width/2, y:r.top+r.height/2};})()`);
const aptPoint = (x: VerdictSonde, y: VerdictSonde) => J(`(function(){var s=__plan.aptToScreen(${x},${y});
  var r=document.getElementById("viewport").getBoundingClientRect();
  return {x:r.left+s.x, y:r.top+s.y};})()`);
const armed = () => evaluate(`String(__plan.v5ui.draw)`);
const ariaArme = () => evaluate(`String(document.getElementById("btnDrawWall").getAttribute("aria-pressed"))`);
const murs = () => J(`__plan.plan.walls.filter(function(w){return !w.isOutline;})
  .map(function(w){return {id:String(w.id), a:w.a, b:w.b};})`);
const selWall = () => evaluate(`String(__plan.v5ui.selWall)`);
const poignees = () => J(`__plan.handleCount()`);
const visible = (sel: string) => evaluate(`String(!!document.querySelector(${JSON.stringify(sel)}) && !document.querySelector(${JSON.stringify(sel)}).hidden)`);
const nSel = () => evaluate(`String(__plan.selCount)`);
const empreinte = () => evaluate(`JSON.stringify(__plan.plan.walls)`);

/** The blank 420x360 rectangle every case starts from. */
async function rectangleVierge() {
  await evaluate(`__plan.setModel({outline:[[0,0],[420,0],[420,360],[0,360]],
    walls:[], openings:[], pieces:[], cells:[]}); true`);
  await pause(150);
}
async function armer() {
  if (await armed() !== "true") await click(await centerOf("#btnDrawWall"));
}

// =============================================================================
//  1. THE TOOL IS ARMED, AND IT SHOWS
// =============================================================================
await test("outil_arme_par_le_bouton_et_par_w", async () => {
  await rectangleVierge();
  ok(await armed() === "false", "au repos, l'outil n'est pas armé");
  await click(await centerOf("#btnDrawWall"));
  ok(await armed() === "true", "le bouton arme l'outil");
  ok(await ariaArme() === "true", "aria-pressed suit l'état armé");
  ok(await evaluate(`String(!!document.querySelector(".v5layer.drawing"))`) === "true",
    "le calque porte la classe qui met la croix en curseur");
  await key("w", "KeyW");
  ok(await armed() === "false", "W désarme le même état que le bouton");
  await key("w", "KeyW");
  ok(await armed() === "true", "et W le rearme");
  ok(await ariaArme() === "true", "aria-pressed suit W comme il suit le bouton");
});

// =============================================================================
//  2. THE CHAIN: ONE CLICK PER CORNER
// =============================================================================
await test("chaine_clic_clic_enchaine_les_segments", async () => {
  await rectangleVierge();
  await armer();
  await click(await aptPoint(200, 0));
  ok((await murs()).length === 0, "le premier clic ne crée aucun mur: il pose un départ");
  await click(await aptPoint(200, 150));
  ok((await murs()).length === 1, `le deuxième clic ferme le premier segment, vu ${(await murs()).length}`);
  await click(await aptPoint(300, 150));
  const deux = await murs();
  ok(deux.length === 2, `le troisième clic ferme le deuxième segment, vu ${deux.length}`);
  ok(await armed() === "true", "l'outil reste armé pendant toute la chaîne");
  // Le point d'arrivée d'un segment EST le départ du suivant, au centimètre près.
  const partage = deux.some((w: VerdictSonde) => Math.hypot(w.a[0] - 200, w.a[1] - 150) < 1 || Math.hypot(w.b[0] - 200, w.b[1] - 150) < 1);
  ok(partage, `les deux segments doivent partager le point (200,150), vu ${JSON.stringify(deux)}`);
});

// =============================================================================
//  3. DOUBLE-CLICK ENDS THE CHAIN, THE TOOL STAYS ARMED
// =============================================================================
await test("double_clic_termine_la_chaine_sans_quitter_l_outil", async () => {
  await rectangleVierge();
  await armer();
  await click(await aptPoint(200, 0));
  await doubleClick(await aptPoint(200, 150));
  const apres = await murs();
  ok(apres.length === 1, `un segment posé, pas deux, vu ${apres.length}`);
  ok(await armed() === "true", "le double-clic termine la chaîne, il ne range pas l'outil");
  // La chaîne est bien FERMÉE: le clic suivant repose un DÉPART, il ne prolonge rien.
  await click(await aptPoint(300, 200));
  ok((await murs()).length === 1, "le clic suivant repose un départ, il ne prolonge pas la chaîne fermée");
});

// =============================================================================
//  4. ESCAPE: FIRST THE CHAIN, THEN THE TOOL, AND IT SAYS SO
// =============================================================================
await test("echap_termine_la_chaine_puis_quitte_l_outil_et_le_dit", async () => {
  await rectangleVierge();
  await armer();
  await click(await aptPoint(200, 0));
  await key("Escape", "Escape");
  ok(await armed() === "true", "le premier Échap termine la chaîne, il ne quitte pas l'outil");
  await key("Escape", "Escape");
  ok(await armed() === "false", "le second Échap, sur un départ non posé, quitte l'outil");
  ok(await ariaArme() === "false", "et le bouton le dit");
  const dit = await evaluate(`String((document.querySelector(".app-toast")||{}).textContent||"")`);
  ok(/wall tool/i.test(String(dit)), `la sortie de l'outil se DIT (G-13), vu ${JSON.stringify(dit)}`);
  ok((await murs()).length === 0, "et rien n'a été écrit");
});

// =============================================================================
//  5. A TYPED LENGTH PLACES THE POINT
// =============================================================================
await test("longueur_tapee_pose_le_point_a_cette_longueur", async () => {
  await rectangleVierge();
  await armer();
  await click(await aptPoint(100, 100));
  await hover(await aptPoint(380, 100));        // direction: to the right
  await key("1", "Digit1"); await key("2", "Digit2"); await key("0", "Digit0");
  await key("Enter", "Enter");
  const apres = await murs();
  ok(apres.length === 1, `un mur posé par le clavier, vu ${apres.length}`);
  if (apres.length !== 1) return;
  const L = Math.hypot(apres[0].b[0] - apres[0].a[0], apres[0].b[1] - apres[0].a[1]);
  ok(Math.abs(L - 120) < 1, `le mur doit faire exactement 120 cm, vu ${L.toFixed(1)}`);
});

// =============================================================================
//  6. THE FLOOR IS A LASSO AGAIN, AND IT DRAWS NOTHING
// =============================================================================
await test("le_sol_lasso_et_ne_trace_plus", async () => {
  await rectangleVierge();
  await evaluate(`__plan.addRoomPiece("bed", 60, 60); __plan.addRoomPiece("chair", 220, 220); true`);
  await pause(150);
  ok(await armed() === "false", "précondition: l'outil n'est pas armé");
  const avant = await empreinte();
  await drag(await aptPoint(20, 20), await aptPoint(400, 340), 16);
  ok(await empreinte() === avant, "un glissement sur le sol ne crée AUCUN mur");
  ok(Number(await nSel()) >= 1, `le lasso doit attraper ce qu'il entoure, vu ${await nSel()} objet(s)`);
});

// =============================================================================
//  7. A SELECTED WALL CARRIES THREE CONTROLS AT MOST, AND HOVER CARRIES NONE
// =============================================================================
await test("un_mur_selectionne_porte_trois_controles_le_survol_aucun", async () => {
  await rectangleVierge();
  await armer();
  await click(await aptPoint(200, 60));
  await click(await aptPoint(200, 300));
  await key("Escape", "Escape"); await key("Escape", "Escape");   // chaîne close, outil rangé
  const liste = await murs();
  if (!ok(liste.length === 1, `précondition: un mur, vu ${liste.length}`)) return;

  await hover(await aptPoint(200, 180));
  const surSurvol = await poignees();
  ok(surSurvol.move === 0 && surSurvol.bout === 0,
    `au survol, AUCUNE poignée, vu ${JSON.stringify(surSurvol)}`);
  ok(await evaluate(`String(getComputedStyle(document.getElementById("viewport")).cursor)`) === "pointer",
    "mais le curseur annonce que le mur est cliquable");

  await click(await aptPoint(200, 180));
  ok(await selWall() === liste[0].id, `le clic sélectionne le mur, vu ${await selWall()}`);
  const surSelection = await poignees();
  ok(surSelection.move === 1, `une seule poignée de déplacement, vu ${surSelection.move}`);
  ok(surSelection.bout <= 2, `deux poignées de bout au plus, vu ${surSelection.bout}`);
  ok(surSelection.move + surSelection.bout <= 3,
    `trois contrôles AU PLUS sur un mur, vu ${JSON.stringify(surSelection)}`);
});

// =============================================================================
//  7bis. A SELECTED WALL SHOWS ITS LENGTH AND CLEARANCES (decision 0015, replaces D-held)
// =============================================================================
// WRITTEN, NOT RUN (owner tests browser suites himself): the D key is gone from the whole app;
// what used to show only while it was held (`drawWallGuides`, `gestes/guides.ts`) now shows at
// SELECTION, the same "at selection, not behind a key" rule furniture's own `.pdim` already
// follows. `.guides .glab` is the SAME container `drawGuides` uses for a piece of furniture's own
// alignment labels: the length ("240 cm" for a wall drawn 240 cm long) proves the overlay is the
// wall's own guide, not a stale one left by something else.
await test("un_mur_selectionne_affiche_sa_longueur_et_ses_degagements", async () => {
  await rectangleVierge();
  await armer();
  await click(await aptPoint(200, 60));
  await click(await aptPoint(200, 300));
  await key("Escape", "Escape"); await key("Escape", "Escape");
  const avant = await evaluate(`document.querySelectorAll(".guides .glab").length`);
  ok(avant === 0, `avant sélection, aucune cote affichée, vu ${avant}`);

  await click(await aptPoint(200, 180));
  await pause(50);
  const labels = await evaluate(`JSON.stringify([...document.querySelectorAll(".guides .glab")].map(e=>e.textContent))`);
  const liste: string[] = JSON.parse(labels);
  ok(liste.some((t) => t.includes("240 cm")), `la longueur du mur (240 cm) est affichée, vu ${labels}`);

  await key("Escape", "Escape");
  await pause(50);
  const apres = await evaluate(`document.querySelectorAll(".guides .glab").length`);
  ok(apres === 0, `la désélection efface la cote, vu ${apres}`);
});

// =============================================================================
//  8. THE SHEET CARRIES THE COMMANDS
// =============================================================================
await test("la_fiche_du_mur_porte_couper_supprimer_et_redresser_au_besoin", async () => {
  await rectangleVierge();
  await armer();
  await click(await aptPoint(200, 60));
  await click(await aptPoint(200, 300));
  await key("Escape", "Escape"); await key("Escape", "Escape");
  const avant = await murs();
  if (!ok(avant.length === 1, "précondition: un mur")) return;
  await click(await aptPoint(200, 180));
  ok(await visible("#rcSplit") === "true", "la fiche du mur porte « Split in two »");
  ok(await visible("#rcDel") === "true", "et « Delete wall »");
  ok(await visible("#rcSquare") === "false", "l'équerre reste cachée sur un mur qui est déjà droit");
  await click(await centerOf("#rcSplit"));
  await pause(150);
  ok((await murs()).length === 2, `couper depuis la fiche donne deux moitiés, vu ${(await murs()).length}`);
});

// =============================================================================
//  9. A CLEAN CLICK ON A WALL WRITES NOTHING (AGENTS.md)
// =============================================================================
await test("un_clic_net_sur_un_mur_n_ecrit_rien", async () => {
  await rectangleVierge();
  await armer();
  await click(await aptPoint(200, 60));
  await click(await aptPoint(200, 300));
  await key("Escape", "Escape"); await key("Escape", "Escape");
  const avant = await empreinte();
  const undoAvant = await evaluate(`String(__plan.histInfo().undo)`);
  await click(await aptPoint(200, 180));
  await click(await aptPoint(200, 180));
  ok(await empreinte() === avant, "deux clics nets ne changent pas un centimètre de géométrie");
  ok(await evaluate(`String(__plan.histInfo().undo)`) === undoAvant,
    "et ne poussent aucune entrée d'historique");
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
