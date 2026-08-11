#!/usr/bin/env node
// build.ts — recomposes src/ into a single, self-contained HTML file.
//
// No network, no RUNTIME dependency: CSS inline in <style>, JS inline in <script>, zero
// <script src>, zero CDN. The deliverable stays ONE single file, served as-is by Cloudflare
// Pages (static root, no build step on the Cloudflare side).
//
// Usage:
//   node build.ts                 writes index.html          THE DELIVERABLE: TYPED client (src/ts, esbuild)
//   node build.ts --dev           writes index.dev.html      (inline sourcemap, no minification)
//   node build.ts --out X.html    writes elsewhere (useful for comparisons)
//   node build.ts --check         rewrites nothing; exits 1 if the output differs from the source
//
// The typed client is the ONLY client source. `legacy/index.html` remains a self-contained,
// servable archive, but its source has left the repo: see legacy/README.md and the git history.
// Both package.json packages remain BUILD tools; none of them land in the deliverable, and the
// "module outside src/ts" guard below checks that on EVERY build.
//
// The concatenation order of the CSS and the HTML is kept by hand in src/manifest.json. `src/ts`
// has no manifest: the import graph makes the order.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, "src");

const args = process.argv.slice(2);
let sortie = null;
let check = false, dev = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") sortie = path.resolve(args[++i]);
  else if (args[i] === "--check") check = true;
  else if (args[i] === "--dev") dev = true;
  else if (args[i] === "--next" || args[i] === "--legacy") {
    // These flags must not be silently ignored: they would pretend to select another client source.
    console.error(`${args[i]} n'existe plus : src/js a été retiré du dépôt, le client typé est le seul.`);
    console.error("  legacy/index.html reste servable telle quelle ; son source se retrouve dans l'historique git.");
    process.exit(1);
  }
  else { console.error(`Option inconnue : ${args[i]}`); process.exit(1); }
}
// `index.dev.html` is a debugging artifact, never committed (.gitignore).
sortie = sortie || path.join(ROOT, dev ? "index.dev.html" : "index.html");

interface Manifeste { head: string; css: string[]; html: string[] }
const manifeste: Manifeste = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));

function lire(rel: string): string {
  const p = path.join(SRC, rel);
  if (!fs.existsSync(p)) {
    console.error(`\x1b[31mModule manquant\x1b[0m : src/${rel} (référencé par src/manifest.json)`);
    process.exit(1);
  }
  let t = fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  if (t.length && !t.endsWith("\n")) t += "\n";   // a module must end with a line break
  return t;
}

// Modules present on disk but absent from the manifest: they would not get bundled in.
// We refuse rather than produce a silently amputated index.html.
{
  const listes = new Set([manifeste.head, ...manifeste.css, ...manifeste.html]);
  const surDisque = [];
  for (const dossier of [".", "css", "html"]) {
    const d = path.join(SRC, dossier);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!/\.(css|html)$/.test(f)) continue;
      surDisque.push(dossier === "." ? f : `${dossier}/${f}`);
    }
  }
  const orphelins = surDisque.filter(f => !listes.has(f));
  if (orphelins.length) {
    console.error(`\x1b[31mModules hors manifeste\x1b[0m : ${orphelins.join(", ")}`);
    console.error(`  => ajoutez-les à src/manifest.json (à la bonne position : l'ordre compte).`);
    process.exit(1);
  }
}

// The envelope: these five lines don't live in src/ because they only exist in the
// hosted file (the working copy of the Claude job lacks them).
const PREAMBULE = [
  "<!doctype html>",
  '<html lang="fr">',
  "<head>",
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">',
  "",
].join("\n");

// The JS is the esbuild bundle of src/ts. The CSS and the HTML stay concatenated in the order of
// the manifest: they're fragments of the same deliverable, not runtime dependencies.
async function bundleTs() {
  let esbuild;
  try { esbuild = await import("esbuild"); }
  catch {
    console.error(`\x1b[31mesbuild introuvable\x1b[0m : lancez \`npm install\` (outil de build, pas de dépendance à l'exécution).`);
    console.error(`  Repli documenté si npm devient un problème : bun build src/ts/main.ts --target=browser --format=iife.`);
    process.exit(1);
  }
  const entree = path.join(SRC, "ts", "main.ts");
  if (!fs.existsSync(entree)) { console.error(`\x1b[31mPoint d'entrée manquant\x1b[0m : src/ts/main.ts`); process.exit(1); }
  const t0 = Date.now();
  let r;
  try {
    r = await esbuild.build({
      entryPoints: [entree],
      absWorkingDir: ROOT,     // metafile paths are relative to THIS folder, whatever the cwd
      bundle: true, write: false, metafile: true,
      format: "iife",          // a closure: nothing leaks into window
      platform: "browser", target: "es2019",
      minify: !dev,
      sourcemap: dev ? "inline" : false,
      legalComments: "none",
      logLevel: "warning",
    });
  } catch {
    // esbuild already said everything on stderr: no Node stack trace piled on top.
    console.error(`\x1b[31mLe bundle de src/ts a échoué\x1b[0m : le livrable n'a pas été écrit.`);
    process.exit(1);
  }
  // NO DEPENDENCY IN THE ARTIFACT. esbuild says exactly which files it read:
  // anything that doesn't come from src/ts is a runtime dependency, hence a refusal.
  const intrus = Object.keys(r.metafile.inputs)
    .map(p => path.resolve(ROOT, p))
    .filter(p => !p.startsWith(path.join(SRC, "ts") + path.sep));
  if (intrus.length) {
    console.error(`\x1b[31mModule hors src/ts dans le bundle\x1b[0m : ${intrus.map(p => path.relative(ROOT, p)).join(", ")}`);
    console.error(`  => le livrable doit rester autonome : aucune dépendance ne voyage dans index.html.`);
    process.exit(1);
  }
  if (r.outputFiles.length !== 1) { console.error(`\x1b[31mesbuild a produit ${r.outputFiles.length} fichiers\x1b[0m, il en faut UN.`); process.exit(1); }
  let js = r.outputFiles[0].text;
  if (js.length && !js.endsWith("\n")) js += "\n";
  return { js, ms: Date.now() - t0, modules: Object.keys(r.metafile.inputs).length };
}

const bundle = await bundleTs();
const corpsJs = bundle.js;

const html =
  PREAMBULE +
  lire(manifeste.head) +
  "<style>\n" +
  manifeste.css.map(lire).join("") +
  "</style>\n" +
  "</head>\n" +
  "<body>\n" +
  manifeste.html.map(lire).join("") +
  "<script>\n" +
  corpsJs +
  "</script>\n" +
  "\n</body>\n</html>\n";

// Guard: a `</scr`+`ipt` in the JS would close the tag and cut the application in two.
if (/<\/script/i.test(corpsJs)) {
  console.error(`\x1b[31mFin de balise script dans le JS\x1b[0m : le livrable serait coupé en deux.`);
  process.exit(1);
}

// Guard: the deliverable must stay self-contained.
for (const motif of [/<script[^>]+\bsrc=/i, /<link[^>]+\brel=["']?stylesheet/i, /@import\s+url/i]) {
  if (motif.test(html)) {
    console.error(`\x1b[31mRessource externe détectée\x1b[0m (${motif}) : le fichier doit rester autonome.`);
    process.exit(1);
  }
}

const nom = path.relative(ROOT, sortie) || sortie;

if (check) {
  const actuel = fs.existsSync(sortie) ? fs.readFileSync(sortie, "utf8").replace(/\r\n/g, "\n") : "";
  if (actuel === html) { console.log(`\x1b[32m${nom} à jour\x1b[0m`); process.exit(0); }
  const a = html.split("\n"), b = actuel.split("\n");
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  console.error(`\x1b[31m${nom} diffère de src/\x1b[0m — première divergence ligne ${i + 1}`);
  console.error(`  attendu : ${JSON.stringify(a[i])}`);
  console.error(`  actuel  : ${JSON.stringify(b[i])}`);
  process.exit(1);
}

fs.writeFileSync(sortie, html, "utf8");
const n = html.split("\n").length - 1;
console.log(`\x1b[32mConstruit\x1b[0m : ${nom} (${n} lignes, ${html.length} octets, ` +
  `${manifeste.css.length} css + ${manifeste.html.length} html + ` +
  `${bundle.modules} ts → ${bundle.js.length} octets de JS en ${bundle.ms} ms${dev ? ", sourcemap inline" : ", minifié"})`);
