#!/usr/bin/env node
// =============================================================================
//  CURSOR CHAT ("/") — REAL MOUSE, REAL KEYBOARD, REAL DOM (CDP)
// =============================================================================
// FigJam-style: press "/", a small box appears attached to the pointer and follows it; Enter or
// Escape closes it. This suite proves the LOCAL half, with a real browser and real key events:
// the box opens, it tracks the pointer, it closes on Escape, a plain text field steals none of
// this, and a whole chat exchange leaves the plan byte-identical (nothing written, nothing to
// undo). The WIRE half (what a peer sees while typing, and when the box closes) is covered by
// `tests/curseur-dire-deux-appareils.ts`, in the style of `tests/deux-appareils.ts`.
//
//   node tests/curseur-dire.ts [path/to/app.html]
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-dire-"));
const APP_SRC = fs.readFileSync(APP, "utf8");
const URL_SEEDED = (() => {
  const p = path.join(dir, "seeded.html");
  fs.writeFileSync(p,
    `<!doctype html><html><head><meta charset="utf-8"><script>
window.__PLAN_TEST__=1;
try{ localStorage.clear(); localStorage.setItem("room-planner-v4", ${JSON.stringify(JSON.stringify(SEED))}); }catch(e){}
<\/script></head><body>` + APP_SRC + "</body></html>", "utf8");
  return "file:///" + p.replace(/\\/g, "/");
})();

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
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let msgId = 0;
const pending = new Map<number, (message: ReponseCDP) => void>();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m); }
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
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
await send("Page.enable");
await send("Runtime.enable");

async function goTo(url: string) {
  await send("Page.navigate", { url });
  for (let i = 0; i < 250; i++) {
    let st = null;
    try { st = await evaluate("document.readyState + '|' + (window.__plan ? 1 : 0)"); } catch (_) { /* not ready yet */ }
    if (st === "complete|1") break;
    await pause(50);
  }
  await pause(350);
}
const clearViewport = () => send("Emulation.clearDeviceMetricsOverride");

// ---- REAL mouse / REAL keyboard --------------------------------------------------------------
const M = (type: string, x: VerdictSonde, y: VerdictSonde, extra?: Record<string, unknown>) => send("Input.dispatchMouseEvent", Object.assign({
  type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1,
  clickCount: 1, pointerType: "mouse",
}, extra || {}));
async function moveTo(x: VerdictSonde, y: VerdictSonde) {
  await M("mouseMoved", x, y, { button: "none", buttons: 0 });
  await pause(30);
}
async function key(k: string, extra?: Record<string, unknown>) {
  await send("Input.dispatchKeyEvent", Object.assign({ type: "keyDown", key: k, unmodifiedText: k, text: k }, extra || {}));
  await send("Input.dispatchKeyEvent", Object.assign({ type: "keyUp", key: k }, extra || {}));
}
// bare "Escape"/"Enter": no printable text, otherwise Chrome would insert the key's name.
async function keySpecial(k: string) {
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k });
}
async function taperTexte(s: string) {
  const envois = [];
  for (const ch of s) {
    envois.push(send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, key: ch }));
    envois.push(send("Input.dispatchKeyEvent", { type: "keyUp", key: ch }));
  }
  await Promise.all(envois);
  await pause(60);
}
const centerOf = (sel: VerdictSonde) => J(`(function(){var e=document.querySelector(${JSON.stringify(sel)});
  if(!e) return null; var r=e.getBoundingClientRect(); if(!r.width) return null;
  return {x:r.left+r.width/2, y:r.top+r.height/2, w:Math.round(r.width), h:Math.round(r.height)};})()`);
// `say-box`'s own state: === true / === false against `hidden`, NEVER `!hidden` — an ABSENT
// element must read as null, not silently as "not hidden" (tests/porte-invitee.ts's own
// convention, carried here since the box is created/removed by script, not static markup).
const etatBoite = () => J(`(function(){var e=document.querySelector(".say-box");
  if(!e) return {hidden:null, value:null, transform:null, focused:false};
  return {hidden: e.hidden, value: e.value, transform: e.style.transform, focused: document.activeElement===e};})()`);

// ---- micro-harness ------------------------------------------------------------------------------
const results: VerdictSonde[] = [];
let cur: VerdictSonde = null;
function ok(cond: unknown, msg?: string) { if (!cond) cur.fails.push(msg); return !!cond; }
async function test(name: string, fn: (...args: VerdictSonde[]) => VerdictSonde | Promise<VerdictSonde>) {
  cur = { name, fails: [] };
  await clearViewport();
  await goTo(URL_SEEDED);
  try { await fn(); } catch (e) { cur.fails.push("EXCEPTION: " + (e && e.message || e)); }
  const jsErr = await evaluate(`JSON.stringify((JSON.parse(localStorage.getItem("plan-errors")||"[]")||[]).map(function(e){return e&&e.msg}))`);
  if (jsErr && jsErr !== "[]") cur.fails.push("erreurs JS: " + jsErr);
  results.push(cur);
  console.log(`  ${cur.fails.length ? "FAIL " : "ok   "} ${name}`);
  cur.fails.forEach((f: VerdictSonde) => console.log("        - " + f));
}

// =============================================================================
//  1. "/" opens the box, near the pointer
// =============================================================================
await test("slash_ouvre_la_boite_pres_du_curseur", async () => {
  const vp = await centerOf("#viewport");
  ok(vp, "le viewport doit etre visible");
  await moveTo(vp.x - 200, vp.y - 100);
  ok((await etatBoite()).hidden === true, "la boite ne doit pas exister avant '/'");
  await key("/");
  await pause(60);
  const e = await etatBoite();
  ok(e.hidden === false, "'/' doit ouvrir la boite, vu " + JSON.stringify(e));
  ok(e.focused === true, "la boite doit recevoir le focus tout de suite, on tape sans cliquer");
  ok(e.value === "", "la boite s'ouvre vide");
});

// =============================================================================
//  2. the box follows the pointer while open
// =============================================================================
await test("la_boite_suit_le_pointeur", async () => {
  const vp = await centerOf("#viewport");
  await moveTo(vp.x - 200, vp.y - 100);
  await key("/");
  await pause(60);
  const avant = await etatBoite();
  await moveTo(vp.x + 150, vp.y + 120);
  await pause(60);
  const apres = await etatBoite();
  ok(apres.hidden === false, "la boite doit rester ouverte pendant qu'on bouge la souris");
  ok(apres.transform !== avant.transform,
    `la position affichee doit suivre le pointeur : avant=${avant.transform} apres=${apres.transform}`);
});

// =============================================================================
//  3. Escape closes it
// =============================================================================
await test("echap_ferme_la_boite", async () => {
  const vp = await centerOf("#viewport");
  await moveTo(vp.x, vp.y);
  await key("/");
  await pause(60);
  await taperTexte("salut");
  ok((await etatBoite()).value === "salut", "le texte doit s'afficher pendant la frappe");
  await keySpecial("Escape");
  await pause(60);
  const e = await etatBoite();
  ok(e.hidden === true, "Echap doit fermer la boite, vu " + JSON.stringify(e));
  ok(e.value === "", "et vider son texte");
});

// =============================================================================
//  4. "/" typed inside an ORDINARY field does not open the box
// =============================================================================
await test("slash_dans_un_champ_ordinaire_n_ouvre_rien", async () => {
  await evaluate(`(function(){var i=document.createElement("input"); i.type="text";
    i.id="champTemoin"; document.body.appendChild(i); i.focus();})()`);
  await pause(30);
  ok(await J(`document.activeElement && document.activeElement.id==="champTemoin"`),
    "le champ temoin doit avoir le focus avant l'essai");
  await key("/");
  await pause(60);
  const champ = await J(`document.getElementById("champTemoin").value`);
  ok(champ === "/", "le '/' doit atterrir DANS le champ comme un caractere ordinaire, vu " + JSON.stringify(champ));
  ok((await etatBoite()).hidden === true, "et ne doit PAS ouvrir la boite de discussion");
});

// =============================================================================
//  5. A WHOLE EXCHANGE LEAVES THE PLAN BYTE-IDENTICAL
// =============================================================================
await test("un_echange_de_chat_ne_modifie_pas_le_plan", async () => {
  const vp = await centerOf("#viewport");
  const avant = await J(`JSON.stringify(__plan.state.plan)`);
  await moveTo(vp.x - 100, vp.y - 50);
  await key("/");
  await pause(60);
  await taperTexte("un message qui ne doit rien ecrire");
  await moveTo(vp.x + 80, vp.y + 40);
  await pause(60);
  await keySpecial("Enter");
  await pause(60);
  const apres = await J(`JSON.stringify(__plan.state.plan)`);
  ok(apres === avant, "le plan doit rester BYTE-IDENTIQUE apres tout l'echange (rien a annuler)");
  ok((await etatBoite()).hidden === true, "Entree doit aussi fermer la boite");
});

// ---- verdict -----------------------------------------------------------------------------------
const bad = results.filter((r) => r.fails.length);
console.log("");
if (bad.length) {
  console.log(`FAILURES ${bad.length}/${results.length}:`);
  bad.forEach((r) => r.fails.forEach((f: VerdictSonde) => console.log(`  - ${r.name}: ${f}`)));
} else {
  console.log(`OK ${results.length}/${results.length}`);
}
ws.close(); chrome.kill();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
process.exit(bad.length ? 1 : 0);
