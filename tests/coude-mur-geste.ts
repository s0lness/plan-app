#!/usr/bin/env node
// =============================================================================
//  "WALL ELBOW" SUITE, REAL MOUSE THROUGH CDP
// =============================================================================
// The pure sibling tests/coude-mur.ts covers the split itself. This suite proves that the visible
// midpoint handle receives a real mouse drag, stays away from the wall's own drag band, and writes
// nothing on a press-release without movement.
//
//   node tests/coude-mur-geste.ts [path/to/app.html]
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-coude-mur-"));
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
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("no DevToolsActivePort");
}
const port = await waitPort();
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as CibleCDP[];
const page = list.find((t) => t.type === "page")!;
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let msgId = 0;
const pending = new Map<number, (message: ReponseCDP) => void>();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id)!; pending.delete(m.id); p(m); }
};
function send(method: string, params?: Record<string, unknown>) {
  const id = ++msgId;
  return new Promise<ReponseCDP>((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); });
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
    if (st === "complete|1") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("application non prête");
}

const M = (type: string, x: VerdictSonde, y: VerdictSonde, extra?: Record<string, unknown>) => send("Input.dispatchMouseEvent", Object.assign({
  type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1,
  clickCount: 1, pointerType: "mouse",
}, extra || {}));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function click(p: VerdictSonde) {
  await M("mouseMoved", p.x, p.y, { button: "none", buttons: 0 });
  await M("mousePressed", p.x, p.y);
  await M("mouseReleased", p.x, p.y, { buttons: 0 });
  await pause(80);
}
async function drag(from: VerdictSonde, to: VerdictSonde, steps = 14) {
  await M("mouseMoved", from.x, from.y, { button: "none", buttons: 0 });
  await M("mousePressed", from.x, from.y);
  for (let i = 1; i <= steps; i++) {
    await M("mouseMoved", from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
    await pause(8);
  }
  await M("mouseReleased", to.x, to.y, { buttons: 0 });
  await pause(100);
}

const results: VerdictSonde[] = [];
let cur: VerdictSonde = null;
function ok(cond: unknown, msg?: string) { if (!cond) cur.fails.push(msg); return !!cond; }
async function test(name: string, fn: () => Promise<void>) {
  cur = { name, fails: [] };
  await reload();
  try { await fn(); } catch (e) { cur.fails.push("EXCEPTION: " + (e && (e as Error).stack || e)); }
  const jsErr = await evaluate(`JSON.stringify((JSON.parse(localStorage.getItem("plan-errors")||"[]")||[]).map(function(e){return e&&e.msg}))`);
  if (jsErr && jsErr !== "[]") cur.fails.push("erreurs JS: " + jsErr);
  results.push(cur);
  console.log(`  ${cur.fails.length ? "FAIL " : "ok   "} ${name}`);
  cur.fails.forEach((f: VerdictSonde) => console.log("        - " + f));
}

const centerOf = (sel: string) => J(`(function(){var e=document.querySelector(${JSON.stringify(sel)});
  if(!e) return null; var r=e.getBoundingClientRect(); if(!r.width&&!r.height) return null;
  return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
const aptPoint = (x: number, y: number) => J(`(function(){var s=__plan.aptToScreen(${x},${y});
  var r=document.getElementById("viewport").getBoundingClientRect(); return {x:r.left+s.x,y:r.top+s.y};})()`);
const mur = (id: string) => J(`(function(){var w=__plan.v5WallById(${JSON.stringify(id)}); return w?{a:w.a,b:w.b,free:w.free||0}:null;})()`);
const mursInterieurs = () => J(`__plan.state.plan.walls.filter(function(w){return !w.isOutline}).map(function(w){return {id:String(w.id),a:w.a,b:w.b}})`);
const undoCount = () => evaluate(`String(__plan.histInfo().undo)`);

async function seedUnMur() {
  await evaluate(`__plan.setModel({outline:[[0,0],[420,0],[420,360],[0,360]],
    walls:[{id:"w1",a:[100,50],b:[100,250],t:12,free:1}],openings:[],pieces:[],cells:[]}); true`);
  await pause(100);
  const p = await aptPoint(100, 150); await M("mouseMoved", p.x, p.y); await pause(100);
}

// LE "+" COUPE AU CLIC. Il glissait, autrefois, pour couper ET placer l'articulation d'un seul
// geste. Demande du propriétaire, mot pour mot: « j'appuie sur plus, ça me scinde le mur en deux et
// ça me recrée les mêmes boutons au milieu des deux autres partitions ». Ce cas énonce donc la
// règle telle qu'elle est maintenant, au lieu de l'ancienne.
await test("clic_sur_plus_scinde_le_mur_en_deux_moities_jointes", async () => {
  await seedUnMur();
  const h = await centerOf('.v5wmid[data-w="w1"]');
  if (!ok(h, "la poignée de coupe doit exister sur le mur survolé")) return;
  // `closest`, pas `classList`: le bouton contient un SVG qui dessine son disque, donc
  // `elementFromPoint` rend ce SVG. Ce qui compte est que la pression atterrisse DANS le bouton.
  const hit = await evaluate(`!!document.elementFromPoint(${h.x},${h.y})?.closest(".v5wmid")`);
  ok(hit === true, "le centre visible de la poignée doit être réellement atteignable");
  const avant = await mursInterieurs();
  ok(avant.length === 1, `un mur intérieur attendu avant le geste, vu ${avant.length}`);
  await click(h);
  const apres = await mursInterieurs();
  if (!ok(apres.length === 2, `le clic doit créer deux murs, vu ${apres.length}`)) return;
  const premier = apres.find((w: VerdictSonde) => w.id === "w1");
  const second = apres.find((w: VerdictSonde) => w.id !== "w1");
  if (!ok(premier && second, `deux moitiés introuvables: ${JSON.stringify(apres)}`)) return;
  ok(premier.b[0] === second.a[0] && premier.b[1] === second.a[1],
    `les deux moitiés doivent partager exactement leur jonction, vu ${JSON.stringify(apres)}`);
  // ET LA COUPE NE DÉPLACE RIEN. Le mur d'origine allait de a à b; les deux moitiés bout à bout
  // doivent couvrir exactement le même segment, sinon la coupe a bougé la maçonnerie.
  ok(premier.a[0] === avant[0].a[0] && premier.a[1] === avant[0].a[1],
    `la première moitié doit garder le départ du mur, vu ${JSON.stringify(premier.a)}`);
  ok(second.b[0] === avant[0].b[0] && second.b[1] === avant[0].b[1],
    `la seconde moitié doit garder l'arrivée du mur, vu ${JSON.stringify(second.b)}`);
});

await test("poignee_move_deplace_le_mur_entier_sans_creer_de_coude", async () => {
  await seedUnMur();
  const avant = await mur("w1");
  const centre = await centerOf('.v5wmove[data-w="w1"]');
  if (!ok(avant && centre, "mur ou poignée move introuvable")) return;
  const h = await centerOf('.v5wmid[data-w="w1"]');
  if (!ok(h, "poignée de coude introuvable")) return;
  ok(Math.hypot(h.x - centre.x, h.y - centre.y) > 15, `la poignée de coude doit être décalée de move, vu ${JSON.stringify({ h, centre })}`);
  await drag(centre, { x: centre.x + 60, y: centre.y });
  const apres = await mur("w1");
  if (!ok(apres, "le mur a disparu")) return;
  const da = Math.hypot(apres.a[0] - avant.a[0], apres.a[1] - avant.a[1]);
  const db = Math.hypot(apres.b[0] - avant.b[0], apres.b[1] - avant.b[1]);
  ok(da > 10 && db > 10, `les deux extrémités doivent bouger, vu da=${da} db=${db}`);
  ok(Math.abs(da - db) < 5, `le mur entier doit garder le même décalage aux deux bouts, vu da=${da} db=${db}`);
  ok((await mursInterieurs()).length === 1, "attraper move ne doit pas diviser le mur");
});

// LE "+" EST UN BOUTON, DONC IL AGIT UNE FOIS. La règle « un appui-relâché sans mouvement n'écrit
// rien » vise la GÉOMÉTRIE: cliquer un mur, un sommet ou une arête de contour ne doit que
// sélectionner. Un bouton posé à côté du mur, comme la croix qui supprime depuis toujours, agit au
// clic. Ce qu'on vérifie ici, c'est qu'il agit UNE SEULE FOIS: un mur créé, une entrée d'historique,
// et un Ctrl+Z qui rend exactement le plan d'avant.
await test("le_plus_agit_une_fois_et_un_seul_ctrl_z_le_defait", async () => {
  await seedUnMur();
  const h = await centerOf('.v5wmid[data-w="w1"]');
  if (!ok(h, "poignée de coupe introuvable")) return;
  // A5: `serialize()` n'ecrit plus jamais `_report` (bloc de DIAGNOSTIC de la detection des
  // cellules, jamais cense etre persiste); comparer sa sortie octet pour octet suffit desormais,
  // plus besoin de le retirer a la main avant de comparer.
  const versJSON = `(function(){return JSON.stringify(__plan.serialize());})()`;
  const avantPlan = await evaluate(versJSON);
  const avantUndo = await undoCount();
  const avantNombre = (await mursInterieurs()).length;
  await click(h);
  ok((await mursInterieurs()).length === avantNombre + 1, "le clic doit créer exactement un mur");
  ok(Number(await undoCount()) === Number(avantUndo) + 1, "le clic doit ajouter exactement une entrée d'historique");
  await evaluate(`__plan.undo(); true`); await pause(250);
  ok((await mursInterieurs()).length === avantNombre, "un seul Ctrl+Z doit défaire la coupe");
  const apresPlan = await evaluate(versJSON);
  let ou = "";
  if (apresPlan !== avantPlan) {
    let i = 0; while (i < avantPlan.length && avantPlan[i] === apresPlan[i]) i++;
    ou = ` (a partir de l'octet ${i} : avant=${avantPlan.slice(i - 40, i + 60)} | apres=${apresPlan.slice(i - 40, i + 60)})`;
  }
  ok(apresPlan === avantPlan, "après ce Ctrl+Z le plan doit être identique octet pour octet" + ou);
});

// A v5 wall is THROUGH-RUNNING by default: each end is pushed to the first geometry beyond it. The
// elbow's joint sits in open space and IS an end of both halves, so the split has no choice but to
// turn both of them into FREE partitions, whose outer ends stop following the outline too. That is
// a change in what the wall IS, and this application never changes that without a word.
await test("passer_un_mur_traversant_en_libre_se_dit", async () => {
  await evaluate(`__plan.setModel({outline:[[0,0],[420,0],[420,360],[0,360]],
    walls:[{id:"w1",a:[100,50],b:[100,250],t:12}],openings:[],pieces:[],cells:[]}); true`);
  await pause(100);
  const p = await aptPoint(100, 150); await M("mouseMoved", p.x, p.y); await pause(100);
  const h = await centerOf('.v5wmid[data-w="w1"]');
  if (!ok(h, "poignée de coude introuvable sur un mur traversant")) return;
  await evaluate(`(function(){var e=document.querySelector(".app-toast"); if(e) e.remove();})(); true`);
  await drag(h, { x: h.x + 75, y: h.y });
  await pause(120);
  const dit = await evaluate(`(function(){var e=document.querySelector(".app-toast");
    return (e && !e.hidden) ? e.textContent : "";})()`);
  ok(/free partition/i.test(String(dit)),
    `le passage en cloison libre doit être annoncé, bandeau vu: ${JSON.stringify(dit)}`);
});

const bad = results.filter((r) => r.fails.length);
console.log("");
if (bad.length) {
  console.log(`FAILURES ${bad.length}/${results.length}:`);
  bad.forEach((r) => r.fails.forEach((f: VerdictSonde) => console.log(`  - ${r.name}: ${f}`)));
} else console.log(`OK ${results.length}/${results.length}`);
ws.close(); chrome.kill();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
process.exit(bad.length ? 1 : 0);
