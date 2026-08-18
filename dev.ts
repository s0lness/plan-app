#!/usr/bin/env node
// =================================================================================================
//  THE FAST LOOP FOR A HUMAN: build on save, serve on localhost, seed a real floor plan
// =================================================================================================
//
//   node dev.ts                      # http://127.0.0.1:5177, the household's real flat seeded
//   node dev.ts --plan mon.json      # seed some other exported plan instead
//   node dev.ts --port 5200          # another port
//
// WHY THIS EXISTS. Verifying a gesture used to mean running a browser suite, which answers "does
// the assertion hold" and never "does this feel right". The owner reported four defects in one
// sitting that every suite had called green, because a suite measures what it was told to measure.
// A human needs to open the thing, on his own flat, and try. This server is that loop: save a file
// in `src/`, the deliverable rebuilds in about a tenth of a second, press F5.
//
// IT IS DELIBERATELY OFFLINE, AND IT SAYS SO. `/api/plan` answers 404 here, on purpose. The client
// treats a failed boot read as "the household plan has not been seen yet" and therefore NEVER
// publishes (`bootReconciled`, see AGENTS.md): nothing you try in this sandbox can reach the shared
// flat or the other person's screen. The sync chip will read "hors ligne", and that is the truth,
// not a lie the chip is telling. Local saves still work, so your sandbox survives a reload.
//
// THE SEED IS PLANTED ONCE. On the first load the page copies the plan into `localStorage`; after
// that your own edits are what persists, exactly as in the real app. `?reset=1` plants it again.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n: string, d: string): string => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d; };

const PORT = Number(opt("--port", "5177")) || 5177;
const APP = path.join(__dirname, "index.html");
// The household's real flat, 77 objects, already in the repository for the test suites. It is the
// only seed worth iterating on: a two-room toy hides every defect that comes from density.
const PLAN = path.resolve(opt("--plan", path.join(__dirname, "tests", "fixtures", "plan-reel-77.json")));

if (!fs.existsSync(PLAN)) { console.error("Plan introuvable : " + PLAN); process.exit(1); }

// ---- build ---------------------------------------------------------------------------------
let derniereErreur = "";
function construire(): boolean {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, "build.ts")], { encoding: "utf8" });
  const ok = r.status === 0;
  derniereErreur = ok ? "" : ((r.stdout || "") + (r.stderr || "")).slice(-2000);
  const quand = new Date().toTimeString().slice(0, 8);
  process.stdout.write(ok
    ? `  ${quand}  construit en ${Date.now() - t0} ms\n`
    : `  ${quand}  ÉCHEC DE BUILD\n${derniereErreur}\n`);
  return ok;
}

// ---- watch ---------------------------------------------------------------------------------
// One debounce for the whole tree: an editor writing a file often touches it two or three times,
// and `esbuild` is fast enough that a burst would otherwise rebuild three times for one save.
let minuterie: ReturnType<typeof setTimeout> | null = null;
function surveiller(): void {
  const racine = path.join(__dirname, "src");
  fs.watch(racine, { recursive: true }, (_type, nom) => {
    if (nom && !/\.(ts|css|html|json)$/.test(String(nom))) return;
    if (minuterie) clearTimeout(minuterie);
    minuterie = setTimeout(() => { minuterie = null; construire(); }, 60);
  });
}

// ---- serve ---------------------------------------------------------------------------------
// The seed runs BEFORE the application script, exactly as the test harness does it, so the app
// boots on a real flat instead of the setup wizard.
function page(reset: boolean): string {
  const plan = fs.readFileSync(PLAN, "utf8");
  const amorce = `<!doctype html><html><head><meta charset="utf-8"><title>plan (dev)</title><script>
    try {
      if (${reset ? "true" : "false"}) localStorage.removeItem("room-planner-v4");
      if (!localStorage.getItem("room-planner-v4")) {
        localStorage.setItem("room-planner-v4", ${JSON.stringify(plan)});
      }
    } catch (e) {}
  </script></head><body>`;
  return amorce + fs.readFileSync(APP, "utf8") + "</body></html>";
}

const serveur = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  // OFFLINE ON PURPOSE: see the header. A 404 here is what keeps this sandbox from ever touching
  // the shared flat, and it is also what the chip honestly reports.
  if (url.pathname.startsWith("/api/")) { res.writeHead(404, { "content-type": "text/plain" }); res.end("dev: hors ligne"); return; }
  if (url.pathname === "/plan.json") { res.writeHead(200, { "content-type": "application/json" }); res.end(fs.readFileSync(PLAN)); return; }
  if (derniereErreur) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Le build a échoué, donc la page servie serait périmée :\n\n" + derniereErreur);
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(page(url.searchParams.get("reset") === "1"));
});

if (!construire()) process.stdout.write("  (le serveur démarre quand même : corrigez, il reconstruira tout seul)\n");
surveiller();
// 127.0.0.1, never the default: `listen(port)` alone binds every interface, so the sandbox would
// be reachable by anyone on the same WiFi. A dev server is single-user and single-machine.
serveur.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(
    `\n  plan (dev) : http://127.0.0.1:${PORT}\n` +
    `  plan semé  : ${path.relative(__dirname, PLAN).replace(/\\/g, "/")}\n` +
    `  hors ligne : rien ne part vers le plan partagé. ?reset=1 replante le plan.\n` +
    `  À chaque enregistrement dans src/, le livrable est reconstruit : F5 suffit.\n\n`);
});
