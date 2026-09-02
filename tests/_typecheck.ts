#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSC = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
const passes = [
  ["--noEmit"],
  ["--noEmit", "-p", "tsconfig.outils.json"],
];

for (const args of passes) {
  const resultat = spawnSync(process.execPath, [TSC, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  process.stdout.write(resultat.stdout);
  process.stderr.write(resultat.stderr);
  if (resultat.error) throw resultat.error;
  if (resultat.status !== 0) {
    console.log("FAILURES 1/2");
    process.exit(resultat.status ?? 1);
  }
}

console.log("OK 2/2");
