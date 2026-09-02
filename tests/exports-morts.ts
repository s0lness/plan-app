#!/usr/bin/env node
// =============================================================================
//  "NO EXPORT WITHOUT A CALLER" SUITE: NO BROWSER
// =============================================================================
// WHY IT EXISTS, AND IT'S A CONFESSION. Twice in the same day I shipped a utility
// with its intent comment, and NO caller:
//
//   . `empilables()` ("the dryer sits on top of the washer"), written for an overlap rule
//     that did not exist yet;
//   . `renommageEnCours()` ("so gestures don't trample the input field"), never called,
//     and unnecessary since the keydown's `stopPropagation` already protected it.
//
// Both were found because I was asked "are you sure everything is done?" That's not
// a control, it's luck. THE REAL DANGER IS NOT DEAD CODE, it's that it reads like
// live code: an exported, documented guard that's never called gives the impression that
// something is protected. That's worse than its absence.
//
// WHAT THIS SUITE IS NOT: a general dead-code detector. It only looks at what is
// EXPORTED from `src/ts` and never named anywhere but its own file. A symbol used
// only locally doesn't need to be exported; a symbol exported and used nowhere doesn't need
// to exist.
//
//   node tests/exports-morts.ts
import type { DonneeDynamique } from "./_types.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src", "ts");

/**
 * THE ENTRY POINTS, which by definition have no caller WITHIN the repo.
 * Each exemption carries its own reason: a list of exemptions without a reason becomes a rug again.
 */
const PORTES = new Map([
  ["src/ts/main.ts", "point d'entrée de l'application : appelé par le bundle, pas par un module"],
  ["src/ts/sonde.ts", "surface de test exposée sur `window.__plan` : lue par les suites, pas importée"],
  ["src/ts/sonde-fil.ts", "idem, partie fil"],
  ["src/ts/sonde-gestes.ts", "idem, partie gestes"],
  ["src/ts/sonde-config.ts", "idem, partie configuration"],
  ["src/ts/sonde-donnees.ts", "idem, partie données"],
  ["src/ts/sonde-export.ts", "idem, partie export"],
  ["src/ts/sonde-flow.ts", "idem, partie circulation"],
  ["src/ts/sonde-panneaux.ts", "idem, partie panneaux"],
]);

function fichiers(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && e.name !== "dist") out.push(...fichiers(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}
const rel = (p: string) => path.relative(ROOT, p).replace(/\\/g, "/");

// All the code that might NEED an export: the modules, and the suites (a utility
// proven by a test is alive, even if the application doesn't call it yet).
const sources = [
  ...fichiers(SRC),
  ...fichiers(path.join(ROOT, "tests")),
  ...fichiers(path.join(ROOT, "live-worker")),
  ...fichiers(path.join(ROOT, "functions")),
];
const texte = new Map(sources.map((p) => [p, fs.readFileSync(p, "utf8")]));

// `export function X` / `export const X` / `export class X`. TYPES are out of scope: they
// disappear at compile time, and `tsc --noEmit` with `noUnusedLocals` already covers their usage.
const DECL = /^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

const morts: DonneeDynamique[] = [];
for (const f of fichiers(SRC)) {
  const r = rel(f);
  if (PORTES.has(r)) continue;
  const src = texte.get(f);
  for (const m of src.matchAll(DECL)) {
    const nom = m[1];
    let vu = false;
    for (const [autre, contenu] of texte) {
      if (autre === f) continue;
      // Whole word: `tr` must not be found inside `strHash`.
      if (new RegExp("\\b" + nom.replace(/\$/g, "\\$") + "\\b").test(contenu)) { vu = true; break; }
    }
    if (!vu) morts.push(`${r} → ${nom}`);
  }
}

// ---- NO SUITE OUTSIDE THE BARRIER -----------------------------------------------------------
// SAME DISEASE AS DEAD CODE, but worse: `tests/artefact-autonome.ts` existed, passed
// 6/6, and the barrier did NOT launch it. Six checks on the deliverable itself (a single
// file, zero network request) were sleeping in the repo while everything else was green.
// The repo already says "a green obtained by removing a suite from the list is a lie": a
// suite that was never REGISTERED is the same lie, without even the decision to remove it.
const AIDES = new Set(["all.ts", "fake-d1.ts"]);
const suitesSurDisque = fs.readdirSync(path.join(ROOT, "tests"))
  .filter((f) => f.endsWith(".ts") && !AIDES.has(f) && !f.startsWith("_"));
const inscrites = fs.readFileSync(path.join(ROOT, "tests", "all.ts"), "utf8");

// WE LOOK FOR THE REGISTRATION LINE, NOT THE NAME. First version: `includes('"tests/X"')` over
// the whole file, and the negative control stayed GREEN when the suite was removed from `SUITES`,
// because its name ALSO appears in the LEGACY table. A guard that looks for a name somewhere in a
// file does not verify registration, it verifies mention.
const lancee = (f: DonneeDynamique) => new RegExp('f:\\s*"tests/' + f.replace(/[.]/g, "[.]") + '"').test(inscrites);
const oubliees = suitesSurDisque.filter((f) => !lancee(f));

if (oubliees.length) {
  console.log("  FAIL  aucune_suite_hors_barriere");
  console.log("        - " + oubliees.length + " suite(s) sur le disque que la barriere ne lance PAS :");
  oubliees.forEach((f) => console.log("            tests/" + f));
  console.log("          Une suite jamais inscrite ment exactement comme une suite retiree.");
  console.log("\nFAILURES 1/2");
  console.log("  FAIL aucune_suite_hors_barriere");
  process.exit(1);
}
console.log("  ok    aucune_suite_hors_barriere");

// ---- THE KNOWN DEBT, FROZEN ---------------------------------------------------------------
// The repo carried 99 of them before this suite existed. Turning them all red at once would not
// have cleaned up the code: it would have made the barrier unusable, and a barrier you work
// around no longer measures anything.
//
// The freeze is a RATCHET, not a rug: a NEW dead export brings the suite down, and a list
// entry that comes back to life brings it down TOO. The list can therefore only SHRINK: you
// can neither add debt, nor forget to remove some.
const CHEMIN_GEL = path.join(__dirname, "fixtures", "exports-morts-connus.json");
const gel = JSON.parse(fs.readFileSync(CHEMIN_GEL, "utf8"));
const connus = new Set(gel.morts || []);

if (process.argv.includes("--figer")) {
  fs.writeFileSync(CHEMIN_GEL, JSON.stringify({
    quoi: "Exports de src/ts que personne n'appelle. Dette ANTERIEURE a tests/exports-morts.ts.",
    regle: "Cette liste ne peut que RETRECIR. Refiger pour faire taire la suite, c'est rendre la suite inutile.",
    morts: morts.slice().sort(),
  }, null, 2) + "\n", "utf8");
  console.log("empreinte gelee : " + morts.length + " exports morts connus");
  process.exit(0);
}

const nouveaux = morts.filter((d) => !connus.has(d));
const gueris = [...connus].filter((d) => !morts.includes(d));

if (nouveaux.length || gueris.length) {
  console.log("  FAIL  aucun_export_sans_appelant");
  if (nouveaux.length) {
    console.log("        - " + nouveaux.length + " export(s) NOUVEAU(X) que personne n'appelle :");
    nouveaux.forEach((d) => console.log("            " + d));
    console.log("          Soit on les branche, soit on les retire. Un garde que personne n'appelle");
    console.log("          ne protege rien : il fait croire que quelque chose est protege.");
  }
  if (gueris.length) {
    console.log("        - " + gueris.length + " entree(s) de la dette ne sont plus mortes.");
    console.log("          Le cliquet doit descendre : node tests/exports-morts.ts --figer");
    gueris.forEach((d) => console.log("            " + d));
  }
  console.log("\nFAILURES 1/2");
  console.log("  FAIL aucun_export_sans_appelant");
  process.exit(1);
}
console.log("  ok    aucun_export_sans_appelant  (dette gelee : " + connus.size + ")");
console.log("\nOK 2/2");
