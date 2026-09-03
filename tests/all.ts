#!/usr/bin/env node
// LA BARRIÈRE, EN UNE COMMANDE: `node tests/all.ts` (une vingtaine de secondes).
//
// Le typage d'abord (les deux configs), puis les six suites sans navigateur, en séquence.
// Une ligne par suite, code de sortie non nul dès qu'une échoue. Rien d'autre: pas de
// priorité basse, pas de permis, pas de seconde chance, pas de tranches, pas de navigateur.
// Les gestes se vérifient dans Chrome, par le propriétaire (décision 0023).

import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSC = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");

const etapes: Array<{ nom: string; args: string[] }> = [
  { nom: "typage src", args: [TSC, "--noEmit"] },
  { nom: "typage outils", args: [TSC, "--noEmit", "-p", "tsconfig.outils.json"] },
  { nom: "tests/rapide.ts", args: ["tests/rapide.ts"] },
  { nom: "tests/compat-donnees.ts", args: ["tests/compat-donnees.ts"] },
  { nom: "tests/harnais-graine.ts", args: ["tests/harnais-graine.ts"] },
  { nom: "tests/porte.ts", args: ["tests/porte.ts"] },
  { nom: "tests/invitation.ts", args: ["tests/invitation.ts"] },
  { nom: "live-worker/test-local.ts", args: ["live-worker/test-local.ts"] },
];

let echecs = 0;
const debut = Date.now();
for (const etape of etapes) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, etape.args, { cwd: ROOT, encoding: "utf8" });
  const secondes = ((Date.now() - t0) / 1000).toFixed(1);
  const sortie = (r.stdout || "") + (r.stderr || "");
  const derniere = sortie.trimEnd().split("\n").pop()?.trim() ?? "";
  const ok = r.status === 0;
  if (!ok) echecs++;
  console.log(`${ok ? "ok  " : "ÉCHEC"} ${etape.nom.padEnd(26)} ${secondes.padStart(6)} s  ${ok ? derniere : ""}`);
  if (!ok) process.stdout.write(sortie.endsWith("\n") ? sortie : sortie + "\n");
}
console.log(`\n${echecs ? `ÉCHEC ${echecs}/${etapes.length}` : `OK ${etapes.length}/${etapes.length}`} en ${((Date.now() - debut) / 1000).toFixed(1)} s`);
process.exit(echecs ? 1 : 0);
