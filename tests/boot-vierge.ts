#!/usr/bin/env node
// BLANK boot + loading a real plan, under headless Chrome, no dependencies.
//
// Why this file exists: all of the regression suites seed a localStorage entry before loading
// the app. So none of them ever see the temporal-dead-zone initialization error, which only
// hits the very first load of a blank browser. This file has already caught three errors of
// this class; any reordering of src/manifest.json brings them back. Run it after every module
// move.
//
// Usage:
//   node tests/boot-vierge.ts [path/to/app.html] [--plan plan.json] [--png prefix]
// Exit: 0 if both passes are free of JS errors, 1 otherwise.

import type { VerdictSonde } from "./_types.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

type CibleCDP = { type: string; webSocketDebuggerUrl: string };
type ReponseCDP = ReturnType<typeof JSON.parse>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const args = process.argv.slice(2);
let APP: string | null = null, PLAN: string | null = null, PNG: string | null = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--plan") PLAN = path.resolve(args[++i]);
  else if (args[i] === "--png") PNG = path.resolve(args[++i]);
  else APP = path.resolve(args[i]);
}
APP = APP || path.join(__dirname, "..", "index.html");
if (!fs.existsSync(APP)) { console.error("Fichier app introuvable :", APP); process.exit(1); }
if (!fs.existsSync(CHROME)) { console.error("Chrome introuvable :", CHROME); process.exit(1); }

async function passe({ titre, seedJs, png }: { titre: string; seedJs: string; png?: string | null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-vierge-"));
  const profile = path.join(dir, "profile");
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
    "--no-default-browser-check", "--hide-scrollbars",
    "--user-data-dir=" + profile, "--remote-debugging-port=0",
    "--window-size=1680,1000", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const portFile = path.join(profile, "DevToolsActivePort");
  let port = null;
  for (let i = 0; i < 300 && !port; i++) {
    if (fs.existsSync(portFile)) {
      // The file can be LOCKED (EBUSY: Chrome still has it open), absent (ENOENT), or
      // truncated, especially since several Chrome instances start at the same time. We RETRY
      // until the timeout instead of throwing.
      let t: VerdictSonde[] = [];
      try { t = fs.readFileSync(portFile, "utf8").split("\n"); } catch { t = []; }
      if (t[0] && /^[0-9]+$/.test(t[0].trim())) port = t[0].trim();
    }
    if (!port) await new Promise(r => setTimeout(r, 50));
  }
  if (!port) { chrome.kill(); throw new Error("Chrome n'a pas ouvert de port de débogage"); }

  const cible = ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as CibleCDP[]).find(t => t.type === "page");
  const ws = new WebSocket(cible.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));

  let id = 0; const pending = new Map<number, (message: ReponseCDP) => void>(); const erreurs: VerdictSonde[] = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      erreurs.push("EXCEPTION " + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    }
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") erreurs.push("CONSOLE " + m.params.entry.text);
  };
  const send = (method: string, params?: VerdictSonde) => new Promise<ReponseCDP>(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const evaluate = async (expr: string) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");

  // The seed is laid down from a neighboring page on the SAME file:// origin, then we navigate
  // to the app as-is: it's the real deployed document being evaluated, not a test assembly.
  const seedPath = path.join(dir, "seed.html");
  fs.writeFileSync(seedPath, `<!doctype html><meta charset="utf-8"><script>${seedJs}</script>`, "utf8");
  await send("Page.navigate", { url: "file:///" + seedPath.replace(/\\/g, "/") });
  await new Promise(r => setTimeout(r, 400));
  erreurs.length = 0;

  await send("Page.navigate", { url: "file:///" + APP.replace(/\\/g, "/") });
  for (let i = 0; i < 150; i++) {
    if (await evaluate("document.readyState") === "complete") break;
    await new Promise(r => setTimeout(r, 60));
  }
  await new Promise(r => setTimeout(r, 1200));

  const etat = JSON.parse(await evaluate(`(function(){
    var ring=[]; try{ ring=(JSON.parse(localStorage.getItem('plan-errors')||'[]')||[]).map(function(e){return e&&e.msg}); }catch(_){}
    var rail=document.querySelector('.rail');
    return JSON.stringify({
      app: !!document.querySelector('.app'),
      railLargeur: rail?Math.round(rail.getBoundingClientRect().width):0,
      conteneurs: document.querySelectorAll('.aptroom, .v5layer').length,
      meubles: document.querySelectorAll('.piece').length,
      configVisible: !document.getElementById('setup').hidden,
      ring: ring });
  })()`) || "{}");

  if (png) {
    const r = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(png, Buffer.from(r.result.data, "base64"));
  }
  ws.close(); chrome.kill();

  const tout = erreurs.concat((etat.ring || []).map((m: VerdictSonde) => "RING " + m));
  console.log(`\n=== ${titre} ===`);
  console.log("  DOM     :", JSON.stringify({ app: etat.app, rail: etat.railLargeur, conteneurs: etat.conteneurs, meubles: etat.meubles, configVisible: etat.configVisible }));
  if (png) console.log("  capture :", png);
  console.log("  erreurs :", tout.length ? "" : "aucune");
  tout.forEach(x => console.log("    - " + x));
  return { ok: tout.length === 0 && etat.app === true, etat };
}

const r1 = await passe({
  titre: "démarrage VIERGE (aucun localStorage, aucun plan serveur)",
  seedJs: "try{localStorage.clear()}catch(e){}",
  png: PNG ? PNG + "-vierge.png" : null,
});
if (!r1.etat.configVisible) console.log("  NOTE : la modale de configuration ne s'est pas ouverte sur un profil vierge.");

let r2: { ok: boolean; etat?: ReponseCDP } = { ok: true };
if (PLAN) {
  const brut = JSON.parse(fs.readFileSync(PLAN, "utf8"));
  const st = brut.state || brut;
  r2 = await passe({
    titre: `chargement du plan ${path.basename(PLAN)}`,
    seedJs: `try{localStorage.clear();localStorage.setItem("room-planner-v4", ${JSON.stringify(JSON.stringify(st))});}catch(e){}`,
    png: PNG ? PNG + "-plan.png" : null,
  });
  if (r2.etat.meubles === 0) { console.log("  ECHEC : aucun meuble rendu pour ce plan."); r2.ok = false; }
}

const ok = r1.ok && r2.ok;
console.log(`\n${ok ? "OK" : "ECHEC"} : ${APP}`);
process.exit(ok ? 0 : 1);
