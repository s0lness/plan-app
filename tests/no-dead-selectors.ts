#!/usr/bin/env node
// STATIC TEST `no_dead_selectors`: every class in `src/css/` must have a consumer in
// `src/ts/` or `src/html/`.
//
// R-19, and its already-known limit: "the suite that hunts down dead selectors only covers
// CLASSES, not IDs".
//
// Usage:  node tests/no-dead-selectors.ts [--dette]
//   no option: fails as long as a class has no consumer;
//   --dette   : does not fail, only prints the count and the list.

import type { DonneeDynamique } from "./_types.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "src");
const DETTE = process.argv.includes("--dette");

// No exceptions. The day a class is truly built on the fly, it comes here WITH
// its reason, as in the original suite.
const EXCEPTIONS = new Map([]);

const lire = (dir: string, ext: DonneeDynamique) => {
  const p = path.join(SRC, dir);
  const out: DonneeDynamique[] = [];
  const marcher = (d: DonneeDynamique, prefixe: DonneeDynamique) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (f.name.startsWith(".")) continue;
      const abs = path.join(d, f.name);
      if (f.isDirectory()) { marcher(abs, prefixe + f.name + "/"); continue; }
      if (ext && !f.name.endsWith(ext)) continue;
      out.push({ file: prefixe + f.name, text: fs.readFileSync(abs, "utf8") });
    }
  };
  marcher(p, dir + "/");
  return out;
};

const cssFiles = lire("css", ".css");
const useFiles = [...lire("ts", ".ts"), ...lire("html", ".html")];
const haystack = useFiles.map((f) => f.text).join("\n");

const stripComments = (s: DonneeDynamique) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const CLASS_RE = /\.(-?[A-Za-z_][\w-]*)/g;

const found = new Map();
for (const { file, text } of cssFiles) {
  const body = stripComments(text);
  for (const chunk of body.split("}")) {
    const sel = chunk.split("{")[0];
    if (!sel) continue;
    let m;
    CLASS_RE.lastIndex = 0;
    while ((m = CLASS_RE.exec(sel))) {
      const cls = m[1];
      if (!found.has(cls)) found.set(cls, new Set());
      found.get(cls).add(file);
    }
  }
}

const dead = [];
for (const [cls, files] of [...found].sort()) {
  if (EXCEPTIONS.has(cls)) continue;
  const re = new RegExp("(?<![\\w-])" + cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w-])");
  if (!re.test(haystack)) dead.push({ cls, files: [...files].join(", ") });
}

if (dead.length) {
  console.log("");
  for (const d of dead) console.log(`  SANS PRENEUR  .${d.cls}  (${d.files})`);
}
const ok = found.size - dead.length;
console.log(`\n${found.size} classes CSS examinées · ${ok} posées par src/ts ou src/html · ${dead.length} pas encore portées`);
if (!dead.length) {
  console.log("  ok   no_dead_selectors\n\nOK 1/1");
  process.exit(0);
}
if (DETTE) { console.log("(--dette : suivi d'avancement, pas un verdict)"); process.exit(0); }
console.log(`\nno_dead_selectors : ÉCHEC — ${dead.length} classe(s) sans preneur dans src/ts`);
process.exit(1);
