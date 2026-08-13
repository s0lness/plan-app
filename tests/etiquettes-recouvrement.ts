#!/usr/bin/env node
// =============================================================================
//  LES ÉTIQUETTES DE PIÈCE NE SE RECOUVRENT PAS — VRAIE PAGE, VRAI DOM
// =============================================================================
// Défaut remonté avec une capture : une étiquette de meuble peinte par-dessus le nom d'une pièce,
// un autre nom de pièce tombant sur un appareil, un troisième sur une zone hachurée. Les deux
// familles d'étiquettes étaient disposées INDÉPENDAMMENT, chacune ignorant l'autre.
// `rendu/etiquettes-disposition.ts` corrige la disposition, `tests/etiquettes-disposition.ts`
// prouve le calcul sans navigateur, et cette suite-ci prouve que ça tient une fois le vrai CSS,
// les vraies polices et les vraies métriques de texte dans la boucle.
//
// LE PLAN EST INVENTÉ, ET C'EST DÉLIBÉRÉ. Le défaut a été observé sur le vrai logement du
// propriétaire, et c'est exactement pour ça que ce plan-là ne peut pas être ici : ce dépôt est
// PUBLIC, et publier la disposition intérieure d'un logement pièce par pièce, c'est publier chez
// quelqu'un. Le défaut ne tient pas à CE logement, il tient à des étiquettes qui se disputent la
// même place : `fixtures/plan-etiquettes-dense.json` est donc un plan fabriqué, dix salles et
// soixante objets posés AUTOUR du centre de chaque salle, là où l'étiquette veut aller.
//
//   node tests/etiquettes-recouvrement.ts [path/to/app.html]
//
//   aucune_etiquette_ne_chevauche_une_autre    every visible room/furniture label, pairwise
//   la_plupart_des_pieces_gardent_leur_nom     the fix must not be "drop everything": most rooms
//                                               still show a name (only genuinely crowded ones may
//                                               yield)
//   deux_rendus_produisent_les_memes_boites    determinism: reload from scratch, same boxes
import type { VerdictSonde } from "./_types.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

type CibleCDP = { type: string; webSocketDebuggerUrl: string };
type ReponseCDP = {
  id?: number;
  result?: { result?: { value?: unknown }; exceptionDetails?: { exception?: unknown }; [cle: string]: unknown };
  [cle: string]: unknown;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const APP = process.argv[2] || path.join(__dirname, "..", "index.html");
// The owner's real 103 m2 apartment, 10 rooms (D1 backup 2026-08-13), already walls-only (v5):
// exactly the shape `room-planner-v4` holds in production (the key name is historical).
const PLAN_DENSE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "plan-etiquettes-dense.json"), "utf8"));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-etiq-"));
const htmlPath = path.join(dir, "case.html");
fs.writeFileSync(htmlPath,
  `<!doctype html><html><head><meta charset="utf-8"><script>
window.__PLAN_TEST__=1;
try{ localStorage.clear(); localStorage.setItem("room-planner-v4", ${JSON.stringify(JSON.stringify(PLAN_DENSE))}); }catch(e){}
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
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("no page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });

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
async function evaluate(expr: string): Promise<unknown> {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  const d = r.result || {};
  if (d.exceptionDetails) throw new Error("EVAL: " + JSON.stringify(d.exceptionDetails.exception || d.exceptionDetails));
  return d.result ? d.result.value : undefined;
}
const J = async <T,>(expr: string): Promise<T> => JSON.parse(String(await evaluate(`JSON.stringify(${expr})`)));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
await send("Page.enable");
await send("Runtime.enable");

async function reload(): Promise<void> {
  await send("Page.navigate", { url: "file:///" + htmlPath.replace(/\\/g, "/") });
  for (let i = 0; i < 200; i++) {
    let st: unknown = null;
    try { st = await evaluate("document.readyState + '|' + (window.__plan ? 1 : 0)"); } catch { /* not ready */ }
    if (st === "complete|1") break;
    await pause(50);
  }
  await pause(350);
  await evaluate("__plan.fitView(); true");
  await pause(150);
}

// Every VISIBLE label box: room names (`.ov-name`, absent from the DOM entirely when
// `disposerEtiquettesCellules` drops one) and furniture names (`.piece .plabel`, present but
// `display:none` when R-2/R-3 (no name on a wall-mounted object, only a CHOSEN furniture name)
// or R-6 (no room in the tile) silences it — a zero-size rect filters those out for free).
interface Boite { famille: string; id: string; texte: string; x: number; y: number; w: number; h: number }
interface Mesure { boites: Boite[]; chevauchements: Array<{ a: Boite; b: Boite; dx: number; dy: number }>; etiquettesCellules: number; nbCellules: number }
async function mesurer(): Promise<Mesure> {
  return J<Mesure>(`(function(){
    function boites(){
      var out = [];
      document.querySelectorAll(".ov-name[data-c]").forEach(function(el){
        var r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) out.push({ famille: "cellule", id: el.dataset.c, texte: el.textContent, x: r.left, y: r.top, w: r.width, h: r.height });
      });
      document.querySelectorAll(".piece .plabel").forEach(function(el){
        var r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          var piece = el.closest(".piece");
          out.push({ famille: "meuble", id: piece ? piece.dataset.id : "?", texte: el.textContent, x: r.left, y: r.top, w: r.width, h: r.height });
        }
      });
      return out;
    }
    // LES OBJETS EUX-MEMES, PAS SEULEMENT LEURS ETIQUETTES. Le defaut rapporte incluait un nom de
    // piece pose sur un APPAREIL, pas seulement sur un autre texte. Une suite qui ne compare que
    // les etiquettes entre elles laisse passer exactement la moitie de ce qui a ete signale : sans
    // le correctif, « Room 5 » se peint sur un meuble et personne ne le voit.
    function objets(){
      var out = [];
      document.querySelectorAll("#canvas .piece").forEach(function(el){
        var r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) out.push({ famille: "objet", id: el.dataset.id || "?", texte: "", x: r.left, y: r.top, w: r.width, h: r.height });
      });
      return out;
    }
    var b = boites();
    var obj = objets();
    var TOL = 2;
    var chevauchements = [];
    function croise(A, B){
      var dx = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
      var dy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
      return (dx > TOL && dy > TOL) ? { a: A, b: B, dx: dx, dy: dy } : null;
    }
    for (var i = 0; i < b.length; i++) {
      for (var j = i + 1; j < b.length; j++) {
        var c = croise(b[i], b[j]); if (c) chevauchements.push(c);
      }
    }
    // Un nom de MEUBLE vit a l'interieur de son propre objet : seuls les noms de PIECE sont
    // compares aux objets.
    for (var i2 = 0; i2 < b.length; i2++) {
      if (b[i2].famille !== "cellule") continue;
      for (var k = 0; k < obj.length; k++) {
        var c2 = croise(b[i2], obj[k]); if (c2) chevauchements.push(c2);
      }
    }
    return {
      boites: b, chevauchements: chevauchements,
      etiquettesCellules: document.querySelectorAll(".ov-name[data-c]").length,
      nbCellules: __plan.plan.cells.length,
    };
  })()`);
}

// ---- micro-harness -----------------------------------------------------------------------------
const results: { name: string; fails: string[] }[] = [];
function ok(cur: { fails: string[] }, cond: unknown, msg?: string) { if (!cond) cur.fails.push(msg || "assertion failed"); return !!cond; }
async function test(name: string, fn: (cur: { fails: string[] }) => Promise<void>) {
  const cur = { name, fails: [] as string[] };
  try { await fn(cur); } catch (e) { cur.fails.push("EXCEPTION: " + ((e as Error)?.stack || String(e))); }
  results.push(cur);
  console.log(`  ${cur.fails.length ? "FAIL " : "ok   "} ${name}`);
  cur.fails.forEach((f) => console.log("        - " + f));
}

await test("aucune_etiquette_ne_chevauche_une_autre", async (cur) => {
  await reload();
  const v = await mesurer();
  ok(cur, v.boites.length >= 5, "trop peu d'étiquettes visibles pour un test valable, vu " + v.boites.length);
  if (v.chevauchements.length) {
    const pire = v.chevauchements[0]!;
    ok(cur, false, v.chevauchements.length + " chevauchement(s), ex.: \""
      + pire.a.texte + "\" (" + pire.a.famille + ") vs \"" + pire.b.texte + "\" (" + pire.b.famille + "), "
      + Math.round(pire.dx) + "x" + Math.round(pire.dy) + "px de recouvrement");
  }
});

await test("la_plupart_des_pieces_gardent_leur_nom", async (cur) => {
  // The fix must YIELD on real overlap, not empty the canvas: on this apartment, at least 7 of
  // the 10 rooms must still show a name (the tiniest, most crowded ones may legitimately drop).
  await reload();
  const v = await mesurer();
  ok(cur, v.nbCellules === 10, "la maquette attendue a 10 pièces, vu " + v.nbCellules);
  ok(cur, v.etiquettesCellules >= 7, "trop d'étiquettes de pièce silencieuses: " + v.etiquettesCellules + "/" + v.nbCellules
    + " (la disposition doit céder au cas par cas, pas vider le plan)");
});

await test("deux_rendus_produisent_les_memes_boites", async (cur) => {
  // TWO independent boots (fresh navigation, fresh localStorage read, fresh render each time):
  // the placement must depend on nothing but the plan itself, never on timing or leftover state.
  await reload();
  const v1 = await mesurer();
  await reload();
  const v2 = await mesurer();
  const empreinte = (v: Mesure) => JSON.stringify(v.boites.map((b) => [b.famille, b.id, Math.round(b.x), Math.round(b.y)]).sort());
  const e1 = empreinte(v1), e2 = empreinte(v2);
  ok(cur, e1.length > 2, "aucune boîte mesurée au premier rendu");
  ok(cur, e1 === e2, "deux rendus indépendants ont produit des boîtes différentes:\n  " + e1 + "\n  " + e2);
});

// ---- verdict -------------------------------------------------------------------------------
const bad = results.filter((r) => r.fails.length);
console.log("");
if (bad.length) {
  console.log(`FAILURES ${bad.length}/${results.length}:`);
  bad.forEach((r) => r.fails.forEach((f) => console.log(`  - ${r.name}: ${f}`)));
} else {
  console.log(`OK ${results.length}/${results.length}`);
}
ws.close(); chrome.kill();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(bad.length ? 1 : 0);
