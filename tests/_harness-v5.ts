#!/usr/bin/env node
// SHARED HARNESS for the `model-v5-*.ts` suites (the walls-only model: outline + walls -> cells).
//
// This file contains NO check of its own: it only carries what's needed to write one. Seed +
// verbatim app + probe, in headless Chrome, verdict read back from `<html data-plan-test="…">`.
// No suite touches the old v4 path: everything goes through the additive window.__plan API
// (buildV5FromV4 / detectCells / cellAt / wallsOf / renderV5 / setModel).
//
// Each suite is its own PROCESS, discovered as-is by tests/all.ts. Do not launch them by
// hand: the launcher gives each one a private %TEMP% and kills the Chrome tree living inside it.
//
// THE BROWSER ITSELF LIVES IN `_navigateur.ts`, shared with the five other suites that had each
// copied this harness: ONE Chrome per suite instead of one per case, and a verdict awaited as a
// CONDITION instead of a fixed 90 s. Read that file for the measurements and the why.
//
// `test()` and `runProbe()` are therefore ASYNC. A call site that forgets its `await` reads a
// Promise as a verdict, and `tests/` sits outside `tsconfig.json`'s `include`, so nothing says
// no: that exact slip cost `repli_d1_le_pair_adopte_le_changement` a false failure during this
// rewrite. Typing the test folder is worth doing, and is its own batch.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ControleSonde, ResultatTest, VerdictSonde } from "./_types.ts";
import { ouvrirSonde, CHROME } from "./_navigateur.ts";


const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- config -----------------------------------------------------------------
// Default source: the REBUILT deliverable of the repo (`node build.ts` from src/).
const DEFAULT_APP = path.join(__dirname, "..", "index.html");
const APP_PATH = process.argv[2] || DEFAULT_APP;
const V4_KEY = "room-planner-v4";

if (!fs.existsSync(APP_PATH)) { console.error("App file not found:", APP_PATH); process.exit(1); }
if (!fs.existsSync(CHROME)) { console.error("Chrome not found:", CHROME); process.exit(1); }

const sonde = ouvrirSonde(fs.readFileSync(APP_PATH, "utf8"));

async function runProbe(name: string, seedJs: string, probeBody: string): Promise<VerdictSonde> {
  return sonde.sonder(seedJs, probeBody);
}

// ---- assertion plumbing -----------------------------------------------------
const results: ResultatTest[] = [];
async function test(name: string, seedJs: string, probeBody: string, check: ControleSonde): Promise<void> {
  let pass = false, detail = "";
  const v = await runProbe(name, seedJs, probeBody);
  if (v.__noVerdict) { detail = "no verdict emitted (app failed to boot?)\n  stdout: " + (v.__stdoutHead || "") + "\n  stderr: " + (v.__stderr || ""); }
  else if (v.__probeError) { detail = "probe threw: " + v.__probeError; }
  else if (v.__parseError) { detail = "verdict parse error: " + v.__parseError + " raw=" + v.__raw; }
  else if (v.jsErrors && v.jsErrors.length) { detail = "app logged JS error(s): " + JSON.stringify(v.jsErrors); }
  else {
    try { const r = check(v); if (r === true) pass = true; else detail = r || "assertion returned falsy"; }
    catch (e) { detail = "check threw: " + String(e && (e as Error).stack || e); }
  }
  results.push({ name, pass, detail, verdict: v });
  process.stdout.write((pass ? "  ok   " : "  FAIL ") + name + "\n");
  if (!pass) process.stdout.write("       " + detail.replace(/\n/g, "\n       ") + "\n");
}
const near = (a: number, b: number, tol?: number): boolean => Math.abs(a - b) <= (tol == null ? 1 : tol);
function expect(cond: unknown, msg: string): true { if (!cond) throw new Error(msg); return true; }
function seedV4(state: unknown): string {
  return `try{ localStorage.setItem(${JSON.stringify(V4_KEY)}, ${JSON.stringify(JSON.stringify(state))}); }catch(e){}`;
}

// The OWNER'S REAL PLAN (D1 rev 177, 8 rooms + envelope), embedded so the suite is hermetic.
const REAL_PLAN = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "plan-rev177.json"), "utf8"));

// A minimal v5 plan served to most editing, wire and old-plan-reading tests:
// 600x400, one partition wall in the middle, the 4 facades present as walls (isOutline is DERIVED
// by sanitizeV5Plan).
const SEED_PLAN = `{
  outline:[[0,0],[600,0],[600,400],[0,400]],
  walls:[{id:"w1", a:[300,0], b:[300,400], t:12},
         {id:"wt", a:[0,0], b:[600,0], t:12},
         {id:"wr", a:[600,0], b:[600,400], t:12},
         {id:"wb", a:[600,400], b:[0,400], t:12},
         {id:"wl", a:[0,400], b:[0,0], t:12}],
  openings:[], pieces:[], cells:[] }`;

// ---- the suite's verdict --------------------------------------------------------------------
// `extras`: a way to print, before the verdict, the facts a suite must state explicitly.
export function report(extras?: (resultats: typeof results) => void) {
  sonde.fermer();
  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  process.stdout.write("\n");
  if (typeof extras === "function") extras(results);
  if (passed === total) {
    process.stdout.write("OK " + passed + "/" + total + "\n");
    process.exit(0);
  } else {
    process.stdout.write("FAILURES " + (total - passed) + "/" + total + ":\n");
    results.filter(r => !r.pass).forEach(r => process.stdout.write("  - " + r.name + ": " + r.detail.split("\n")[0] + "\n"));
    process.exit(1);
  }
}

export { runProbe, test, near, expect, seedV4, results, REAL_PLAN, SEED_PLAN, APP_PATH };
