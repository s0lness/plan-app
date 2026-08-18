#!/usr/bin/env node
// =============================================================================
//  ONE BROWSER PER SUITE — the shared probe of every "seed + app + verdict" suite
// =============================================================================
// Six suites had each written their OWN copy of the same harness: build a page, `spawnSync` a
// whole Chrome on it with `--dump-dom` and a brand new profile on disk, read the verdict back out
// of `<html data-plan-test="…">`. Counted on 2026-08-17: `model-v5-*` 54 cases, `run` 29,
// `collab-annuler` 34, `deux-appareils` 24, `collab-accuses` 13, `curseur-dire-deux-appareils` 5.
// **159 COLD STARTS per barrier run**, six copies of the same three bugs.
//
// WHY IT COLLAPSED, and it is not the flags. On a quiet machine a cold start costs about 0,6 s
// and nobody notices. Measured the same day with the workstation at ~50% CPU (six agent
// sessions), a bare headless start took 10 to 40 s, and every copy passed a FIXED
// `timeout: 90000` to spawnSync. Past that bound Chrome was killed before the page had rendered,
// no verdict came back, and a whole suite reported `0/11` in 1733 s. Not one of those failures
// said anything about the code. Benchmarked and eliminated on the way: the Chrome flags
// (the same configuration measured 9,7 s then 39,5 s on two consecutive runs, so the spread
// between two identical runs is larger than the spread between configurations).
//
// WHAT THIS MODULE DOES INSTEAD
// - ONE Chrome for the whole suite, driven over CDP (same plumbing as tests/interactions.ts).
//   A case is a `Page.navigate`, not a process.
// - THE VERDICT IS A CONDITION, NOT A DURATION, which is the rule AGENTS.md already states for
//   the rest of the repository. `data-plan-case` carries the case's nonce and is written LAST, so
//   a verdict left on screen by the previous page can never be read as this one's.
// - A bound remains, because a hang must fail rather than wait forever, but it CALIBRATES ITSELF
//   on the suite's own median (twelve times it, never under a minute): a machine three times
//   slower gets three times the room instead of a wave of phantom failures.
//
// ISOLATION IS UNCHANGED. It never came from the fresh profile: the seed's own
// `localStorage.clear()` / `sessionStorage.clear()` is what empties the state, and it still runs
// first on every load, before the app parses.
//
// `--virtual-time-budget` goes away with the per-case process, and that changes nothing
// observable: every probe is armed on `setTimeout(run, 0)`, so it is the very first timer either
// way, and no probe body in the repository contains a timer of its own (checked suite by suite).
// Virtual time never reordered timers, it only ran them sooner.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { VerdictSonde } from "./_types.ts";

export const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

// The ONE cold start of the suite. Generous on purpose: this is the only place a loaded machine
// pays for launching a browser, and paying it twice (a wrong verdict, then a rerun) costs more.
const DELAI_DEMARRAGE = 180_000;
// Floor of the per-case bound; above it, the bound follows the suite's own median.
const DELAI_CAS_MIN = 60_000;

type CibleCDP = { type: string; webSocketDebuggerUrl: string };
type ReponseCDP = {
  id?: number;
  result?: { result?: { value?: unknown }; exceptionDetails?: unknown; [cle: string]: unknown };
  [cle: string]: unknown;
};

export interface Sonde {
  /** Loads `seed + app + probe` in the SHARED browser and returns the probe's verdict. */
  sonder(seedJs: string, probeBody: string): Promise<VerdictSonde>;
  /** Closes the browser and erases the run folder. Idempotent; also runs on process exit. */
  fermer(): void;
  /** The folder this probe writes its pages into (some suites put fixtures next to them). */
  readonly dossier: string;
}

const dormir = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export function ouvrirSonde(appSrc: string): Sonde {
  const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "plan-sonde-"));
  let chrome: ChildProcess | null = null;
  let ws: WebSocket | null = null;
  let sortieChrome = "";          // what the browser said when it died, kept for the verdict
  let noProfil = 0, noCas = 0, msgId = 0;
  const pending = new Map<number, (m: ReponseCDP) => void>();
  const durees: number[] = [];

  function envoyer(method: string, params?: Record<string, unknown>): Promise<ReponseCDP> {
    const socket = ws;
    if (!socket) return Promise.reject(new Error("no CDP socket"));
    const id = ++msgId;
    return new Promise<ReponseCDP>((res, rej) => {
      // A socket that dies mid-call must REJECT, never hang: the case would otherwise sit out its
      // whole bound before saying anything, which is the failure mode this module exists to remove.
      const mort = setTimeout(() => { if (pending.delete(id)) rej(new Error("CDP socket closed")); }, DELAI_CAS_MIN);
      pending.set(id, (m) => { clearTimeout(mort); res(m); });
      try { socket.send(JSON.stringify({ id, method, params: params || {} })); }
      catch (e) { clearTimeout(mort); pending.delete(id); rej(e as Error); }
    });
  }

  async function evaluer(expression: string): Promise<unknown> {
    const r = await envoyer("Runtime.evaluate", { expression, returnByValue: true });
    const d = r.result || {};
    if (d.exceptionDetails) throw new Error("EVAL: " + JSON.stringify(d.exceptionDetails));
    return d.result ? (d.result as { value?: unknown }).value : undefined;
  }

  async function attendrePort(fichier: string): Promise<string> {
    const fin = Date.now() + DELAI_DEMARRAGE;
    while (Date.now() < fin) {
      if (chrome && chrome.exitCode !== null) throw new Error("Chrome exited (" + chrome.exitCode + "): " + sortieChrome.slice(0, 400));
      // The file can be LOCKED (EBUSY: Chrome still holds it), absent (ENOENT) or truncated, all
      // the more so when several Chromes start at once. We RETRY instead of throwing.
      try {
        const t = fs.readFileSync(fichier, "utf8").split("\n");
        if (t[0] && /^[0-9]+$/.test(t[0].trim())) return t[0].trim();
      } catch (_) { /* pas encore là */ }
      await dormir(50);
    }
    throw new Error("no DevToolsActivePort after " + (DELAI_DEMARRAGE / 1000) + " s: " + sortieChrome.slice(0, 400));
  }

  async function ouvrirNavigateur(): Promise<void> {
    const profil = path.join(RUN_DIR, "profil-" + (++noProfil));
    sortieChrome = "";
    chrome = spawn(CHROME, [
      "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
      "--no-default-browser-check", "--hide-scrollbars",
      "--user-data-dir=" + profil, "--remote-debugging-port=0",
      "--window-size=1680,1000", "about:blank",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    // A pipe nobody reads FILLS UP and blocks the browser. We keep only the tail, for the verdict.
    const avaler = (b: Buffer): void => { sortieChrome = (sortieChrome + b.toString("utf8")).slice(-4000); };
    chrome.stdout?.on("data", avaler);
    chrome.stderr?.on("data", avaler);

    const port = await attendrePort(path.join(profil, "DevToolsActivePort"));
    const cibles = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as CibleCDP[];
    const page = cibles.find(t => t.type === "page");
    if (!page) throw new Error("no page target");
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => {
      socket.onopen = () => res();
      socket.onerror = () => rej(new Error("CDP socket refused"));
    });
    socket.onmessage = (ev: MessageEvent) => {
      let m: ReponseCDP;
      try { m = JSON.parse(String(ev.data)); } catch (_) { return; }
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id)!; pending.delete(m.id); p(m); }
    };
    socket.onclose = () => { if (ws === socket) ws = null; };
    ws = socket;
    await envoyer("Page.enable");
    await envoyer("Runtime.enable");
  }

  function fermerNavigateur(): void {
    try { ws?.close(); } catch (_) { /* déjà mort */ }
    ws = null;
    // BY PID, never by name: `taskkill /IM chrome.exe` kills the owner's own browsing session.
    try { chrome?.kill(); } catch (_) { /* déjà mort */ }
    chrome = null;
  }

  async function assurerNavigateur(): Promise<void> {
    if (ws && chrome && chrome.exitCode === null) return;
    fermerNavigateur();
    await ouvrirNavigateur();
  }

  function limiteCas(): number {
    if (!durees.length) return DELAI_CAS_MIN;
    const t = durees.slice().sort((a, b) => a - b);
    const mediane = t[Math.floor(t.length / 2)] as number;
    return Math.max(DELAI_CAS_MIN, Math.round(12 * mediane));
  }

  function pageDuCas(nonce: string, seedJs: string, probeBody: string): string {
    const seed = `<!doctype html><html><head><meta charset="utf-8"><script>
    window.__PLAN_TEST__ = 1;
    // THIS is what isolates one case from the next, now that the browser is shared. It ran on
    // every load before too; the fresh profile it used to sit in was never what did the work.
    try { localStorage.clear(); sessionStorage.clear(); } catch(e){}
    ${seedJs || ""}
  </script></head><body>`;

    const probe = `<script>(function(){
    function emit(o){ try{
      document.documentElement.dataset.planTest = JSON.stringify(o);
      // Written LAST, and it is what the harness waits on: a verdict from the previous page can
      // never be mistaken for this one's, whatever the navigation timing.
      document.documentElement.dataset.planCase = ${JSON.stringify(nonce)};
    }catch(e){} }
    function run(){
      try {
        var errs = [];
        try { errs = JSON.parse(localStorage.getItem("plan-errors")||"[]")||[]; } catch(e){}
        // The body is run INSIDE an async function and its result is awaited, so a probe may use
        // await freely. tests/collab-accuses.ts needs it: its bench drives the REAL server from
        // live-worker/ over promise-based storage, so its cases cannot be written synchronously.
        // A synchronous probe is unaffected, it simply settles one microtask later, and the
        // harness waits on the verdict as a condition anyway.
        // No backtick in this comment: it lives inside a template literal and would close it.
        Promise.resolve((async function(){ ${probeBody} })()).then(function(__out){
          __out = __out || {};
          __out.jsErrors = errs.map(function(e){ return e && e.msg; });
          emit(__out);
        }, function(e){
          emit({ __probeError: String(e && e.stack || e) });
        });
      } catch(e) {
        emit({ __probeError: String(e && e.stack || e) });
      }
    }
    setTimeout(run, 0);
  })();</script></body></html>`;

    return seed + appSrc + probe;
  }

  async function sonderUneFois(nonce: string, htmlPath: string): Promise<VerdictSonde> {
    await assurerNavigateur();
    await envoyer("Page.navigate", { url: "file:///" + htmlPath.replace(/\\/g, "/") });

    const lecture = `(function(){var d=document.documentElement.dataset;`
      + `return d.planCase===${JSON.stringify(nonce)} ? (d.planTest||"") : "";})()`;
    const limite = limiteCas();
    const fin = Date.now() + limite;
    let attente = 10;
    while (Date.now() < fin) {
      if (chrome && chrome.exitCode !== null) throw new Error("Chrome died mid-case: " + sortieChrome.slice(0, 400));
      let brut: unknown = "";
      // While the navigation commits, the execution context is replaced and an evaluate can
      // throw. That is expected, not a failure: we keep polling.
      try { brut = await evaluer(lecture); } catch (_) { brut = ""; }
      if (typeof brut === "string" && brut) {
        try { return JSON.parse(brut) as VerdictSonde; }
        catch (e) { return { __parseError: String(e), __raw: brut.slice(0, 400) }; }
      }
      await dormir(attente);
      if (attente < 100) attente += 10;
    }
    return {
      __noVerdict: true,
      __stdoutHead: "no verdict after " + Math.round(limite / 1000) + " s (app failed to boot?)",
      __stderr: sortieChrome.slice(-600),
    };
  }

  async function sonder(seedJs: string, probeBody: string): Promise<VerdictSonde> {
    const nonce = "cas-" + (++noCas);
    const htmlPath = path.join(RUN_DIR, nonce + ".html");
    fs.writeFileSync(htmlPath, pageDuCas(nonce, seedJs, probeBody), "utf8");

    const debut = Date.now();
    try {
      const v = await sonderUneFois(nonce, htmlPath);
      durees.push(Date.now() - debut);
      return v;
    } catch (e) {
      // A browser that died takes ONE relaunch, and one only: retrying forever would turn a broken
      // machine into a suite that never ends, which is the very failure this module removes.
      fermerNavigateur();
      try {
        const v = await sonderUneFois(nonce, htmlPath);
        durees.push(Date.now() - debut);
        return v;
      } catch (e2) {
        return { __noVerdict: true, __stdoutHead: "browser lost twice: " + String(e), __stderr: String(e2) };
      }
    }
  }

  function fermer(): void {
    fermerNavigateur();
    try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch (_) { /* déjà parti */ }
  }
  process.on("exit", fermerNavigateur);

  return { sonder, fermer, dossier: RUN_DIR };
}
