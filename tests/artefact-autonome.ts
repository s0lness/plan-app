#!/usr/bin/env node
// =================================================================================================
//  IS THE ARTIFACT A SINGLE FILE, SELF-CONTAINED, AND NOT HEAVIER? (docs/reecriture.md, condition 6)
// =================================================================================================
//   node tests/artefact-autonome.ts                      # index.html against the LEGACY_CEILING bound
//   node tests/artefact-autonome.ts app.html             # another artifact, same bound
//   node tests/artefact-autonome.ts app.html --ref x.html   # explicit weight reference (file)
//   node tests/artefact-autonome.ts app.html --max 789975   # explicit weight bound (bytes)
//
// SINCE THE SWITCHOVER (batch E5c), the artifact measured by default is `index.html`, the SERVED
// file, produced from `src/ts`. The weight reference used to be `legacy/index.html`, the copy of
// the old client; that folder has left this repo (public), so the default bound is now
// `LEGACY_CEILING`, a constant frozen at that file's size at the moment of removal (see further
// down). `--ref` remains usable if a comparison file exists somewhere on disk.
//
// WHY THIS FILE, when `build.ts` already applies the three CSP guards at build time.
// Because a guard applied at build time proves the BUILDER is correct, not that the
// FILE is. The deliverable can be hand-edited, recopied, truncated, or produced by another
// chain (the `bun build` fallback documented in AGENTS.md). Here we do not reread the builder: we
// reread the delivered bytes, and above all we LOAD THE PAGE and count what it requests over the network.
//
// THE MEASUREMENT THAT REALLY MATTERS IS THE LAST ONE. The three CSP patterns catch the known shape
// of an external dependency (`<script src>`, `<link rel=stylesheet>`, `@import url`). They
// would catch NEITHER a `fetch()` at load time, NOR an `@font-face` pointing at a CDN, NOR a
// `background-image:url(https://…)` image, NOR a `new Worker(url)`. A real request counter, on the
// other hand, sees all of them, because it assumes nothing about the shape: it watches what goes out.
//
// The document itself (`file:///…/app.html`) is the ONLY request tolerated: it's the page. Any
// other, whatever its origin, is a dependency and fails the check.

import type { VerdictSonde } from "./_types.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

// Size in bytes of `legacy/index.html` (the old client, self-contained copy) at the moment that
// folder left the public repo. `legacy/` no longer exists here: without this constant, the
// default weight bound would have nothing left to measure itself against.
const LEGACY_CEILING = 778471;

const args = process.argv.slice(2);
const opt = (n: string, d: string | null) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const libres = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && /^--(ref|max)$/.test(args[i - 1])));

const APP = path.resolve(libres[0] || path.join(ROOT, "index.html"));
const REF = opt("--ref", null) ? path.resolve(opt("--ref", null)) : null;
const MAX = opt("--max", null) ? Number(opt("--max", null)) : null;

if (!fs.existsSync(APP)) { console.error("Artefact introuvable :", APP, "\n  => `node build.ts` d'abord."); process.exit(1); }

let echecs = 0;
const verdict = (ok: boolean, titre: string, detail: string) => {
  if (!ok) echecs++;
  console.log(`  ${ok ? "ok   " : "ÉCHEC"} ${titre.padEnd(46)} ${detail}`);
};

console.log(`\n=== ${path.relative(ROOT, APP) || APP} ===`);

// ---- 1. A SINGLE FILE, AND ITS WEIGHT ----------------------------------------------------------
const octets = fs.statSync(APP).size;
const octetsRef = REF && fs.existsSync(REF) ? fs.statSync(REF).size : null;
// Without --max or --ref (the default case, now that `legacy/` has left this repo), the bound
// falls back to LEGACY_CEILING rather than checking nothing at all.
const borne = MAX != null ? MAX : (octetsRef != null ? octetsRef : LEGACY_CEILING);

console.log(`  ---- poids`);
console.log(`       artefact  : ${octets.toLocaleString("fr-FR")} octets`);
if (octetsRef != null) console.log(`       référence : ${octetsRef.toLocaleString("fr-FR")} octets  (${path.relative(ROOT, REF)})`);
if (borne != null) {
  const ecart = octets - borne;
  verdict(octets <= borne, "ne pèse pas plus lourd que la référence",
    ecart <= 0 ? `${(-ecart).toLocaleString("fr-FR")} octets de MOINS (${(100 * (1 - octets / borne)).toFixed(1)} %)`
               : `DÉPASSE de ${ecart.toLocaleString("fr-FR")} octets`);
}

// ---- 2. THE THREE CSP GUARDS, PLUS THE CUT-TAG TRAP --------------------------------
// The same patterns as `build.ts`, reread here on the FILE and not on what a builder
// was about to write.
const texte = fs.readFileSync(APP, "utf8");
console.log(`  ---- gardes CSP`);
const GARDES: [RegExp, string][] = [
  [/<script[^>]+\bsrc=/i, "aucun <script src>"],
  [/<link[^>]+\brel=["']?stylesheet/i, "aucun <link rel=stylesheet>"],
  [/@import\s+url/i, "aucun @import url"],
];
for (const [motif, titre] of GARDES) {
  const m = motif.exec(texte);
  verdict(!m, titre, m ? `TROUVÉ : ${JSON.stringify(texte.slice(m.index, m.index + 70))}` : String(motif));
}

// The inline JS must not contain a script closing tag: it would cut the deliverable in two.
{
  const corps = texte.slice(texte.lastIndexOf("<script>") + 8, texte.lastIndexOf("</script>"));
  verdict(!/<\/script/i.test(corps), "aucune fin de balise script dans le JS", "le fichier ne peut pas être coupé en deux");
}

// ---- 3. WHAT THE PAGE REALLY REQUESTS OVER THE NETWORK ----------------------------------------------
if (!fs.existsSync(CHROME)) {
  console.log(`  ---- réseau`);
  console.log(`  ÉCHEC requêtes réseau au chargement            Chrome introuvable : ${CHROME}`);
  echecs++;
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-autonome-"));
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
      let t: VerdictSonde[] = [];
      try { t = fs.readFileSync(portFile, "utf8").split("\n"); } catch { t = []; }
      if (t[0] && /^[0-9]+$/.test(t[0].trim())) port = t[0].trim();
    }
    if (!port) await new Promise(r => setTimeout(r, 50));
  }
  if (!port) { chrome.kill(); console.error("Chrome n'a pas ouvert de port de débogage"); process.exit(1); }

  const cible = ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[]).find(t => t.type === "page");
  const ws = new WebSocket(cible.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));

  let id = 0; const pending = new Map<number, (message: ReturnType<typeof JSON.parse>) => void>();
  const requetes: VerdictSonde[] = [];   // everything the page requests
  const erreurs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    // `Network.requestWillBeSent` sees EVERYTHING: document, sub-resource, fetch, XHR, font, image,
    // worker. That's precisely why we listen to it rather than reread the HTML.
    if (m.method === "Network.requestWillBeSent") requetes.push({ url: m.params.request.url, type: m.params.type });
    if (m.method === "Network.webSocketCreated") requetes.push({ url: m.params.url, type: "WebSocket" });
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      erreurs.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
  };
  const send = (method: string, params?: VerdictSonde) => new Promise<ReturnType<typeof JSON.parse>>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const evaluate = async (expr: string) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");

  const url = "file:///" + APP.replace(/\\/g, "/");
  await send("Page.navigate", { url });
  for (let i = 0; i < 150; i++) {
    if (await evaluate("document.readyState") === "complete") break;
    await new Promise(r => setTimeout(r, 60));
  }
  // A dependency can fire AFTER load (font, probe, first sync `fetch`).
  // We let the page live for a while before concluding.
  await new Promise(r => setTimeout(r, 1500));

  const monte = await evaluate("!!document.querySelector('.app')");
  ws.close(); chrome.kill();
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch { /* Chrome releases it late */ }

  const externes = requetes.filter((r) => r.url !== url);
  console.log(`  ---- réseau (Chrome headless, file://)`);
  console.log(`       requêtes observées : ${requetes.length} (dont le document lui-même)`);
  verdict(externes.length === 0, "zéro requête hors du document",
    externes.length ? externes.map((r) => `${r.type} ${r.url.slice(0, 90)}`).join(" · ") : "aucune ressource externe");
  verdict(monte === true, "la page monte (.app présent)", monte === true ? "oui" : "NON");
  if (erreurs.length) console.log(`       note : ${erreurs.length} exception(s) JS au chargement (voir tests/boot-vierge.ts)`);
}

console.log(echecs ? `\nÉCHEC ${echecs} condition(s) de forme non tenue(s).\n`
                   : `\nOK ${5 + (borne != null ? 1 : 0)}/${5 + (borne != null ? 1 : 0)} : un seul fichier, autonome, pas plus lourd.\n`);
process.exit(echecs ? 1 : 0);
