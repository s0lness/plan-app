#!/usr/bin/env node
// SHARED HARNESS for the `model-v5-*.ts` suites (the walls-only model: outline + walls -> cells).
//
// This file contains NO check of its own: it only carries what's needed to write one. Same shape
// as tests/run.ts (seed + verbatim app + probe, under headless Chrome, verdict read back from
// `<html data-plan-test="...">`). No suite touches the old v4 path: everything goes through the
// additive window.__plan API (buildV5FromV4 / detectCells / cellAt / wallsOf / renderV5 / setModel).
//
// Each suite is its own PROCESS, discovered as-is by tests/all.ts. Do not launch them by
// hand: the launcher gives each one a private %TEMP% and kills the Chrome tree living inside it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ControleSonde, ResultatTest, VerdictSonde } from "./_types.ts";


const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- config -----------------------------------------------------------------
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
// Default source: the REBUILT deliverable of the repo (`node build.ts` from src/).
// The old monolithic Claude-job working copy remains usable as an explicit argument.
const DEFAULT_APP = path.join(__dirname, "..", "index.html");
const APP_PATH = process.argv[2] || DEFAULT_APP;
const V4_KEY = "room-planner-v4";

if (!fs.existsSync(APP_PATH)) { console.error("App file not found:", APP_PATH); process.exit(1); }
if (!fs.existsSync(CHROME)) { console.error("Chrome not found:", CHROME); process.exit(1); }

const APP_SRC = fs.readFileSync(APP_PATH, "utf8");

// ---- harness ----------------------------------------------------------------
let RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "plan-v5-"));

function runProbe(name: string, seedJs: string, probeBody: string): VerdictSonde {
  const caseDir = fs.mkdtempSync(path.join(RUN_DIR, "c-"));
  const htmlPath = path.join(caseDir, "case.html");
  const profileDir = path.join(caseDir, "profile");

  const seed = `<!doctype html><html><head><meta charset="utf-8"><script>
    window.__PLAN_TEST__ = 1;
    // The WALLS-ONLY model is the ONLY model: a plan seeded here in the old format is read and
    // converted at load time, exactly as it is for the user.
    try { localStorage.clear(); } catch(e){}
    ${seedJs || ""}
  </script></head><body>`;

  const probe = `<script>(function(){
    function emit(o){ try{ document.documentElement.dataset.planTest = JSON.stringify(o); }catch(e){} }
    function run(){
      try {
        var errs = [];
        try { errs = JSON.parse(localStorage.getItem("plan-errors")||"[]")||[]; } catch(e){}
        var __out = (function(){ ${probeBody} })();
        __out = __out || {};
        __out.jsErrors = errs.map(function(e){ return e && e.msg; });
        emit(__out);
      } catch(e) {
        emit({ __probeError: String(e && e.stack || e) });
      }
    }
    setTimeout(run, 0);
  })();</script></body></html>`;

  fs.writeFileSync(htmlPath, seed + APP_SRC + probe, "utf8");

  const args = [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--no-first-run", "--no-default-browser-check",
    "--user-data-dir=" + profileDir,
    "--virtual-time-budget=8000",
    "--run-all-compositor-stages-before-draw",
    "--dump-dom",
    "file:///" + htmlPath.replace(/\\/g, "/"),
  ];
  const res = spawnSync(CHROME, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
  const stdout = res.stdout || "";

  const m = stdout.match(/<html[^>]*\bdata-plan-test="([^"]*)"/i);
  if (!m) {
    return { __noVerdict: true, __stdoutHead: stdout.slice(0, 600), __stderr: (res.stderr || "").slice(0, 600) };
  }
  const raw = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");
  try { return JSON.parse(raw); }
  catch (e) { return { __parseError: String(e), __raw: raw.slice(0, 400) }; }
}

// ---- assertion plumbing -----------------------------------------------------
const results: ResultatTest[] = [];
function test(name: string, seedJs: string, probeBody: string, check: ControleSonde): void {
  let pass = false, detail = "";
  const v = runProbe(name, seedJs, probeBody);
  if (v.__noVerdict) { detail = "no verdict emitted (app failed to boot?)\n  stdout: " + (v.__stdoutHead || "") + "\n  stderr: " + (v.__stderr || ""); }
  else if (v.__probeError) { detail = "probe threw: " + v.__probeError; }
  else if (v.__parseError) { detail = "verdict parse error: " + v.__parseError + " raw=" + v.__raw; }
  else if (v.jsErrors && v.jsErrors.length) { detail = "app logged JS error(s): " + JSON.stringify(v.jsErrors); }
  else {
    try { const r = check(v); if (r === true) pass = true; else detail = r || "assertion returned falsy"; }
    catch (e) { detail = "check threw: " + String(e && e.stack || e); }
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
  try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch (e) {}
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

