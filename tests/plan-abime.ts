#!/usr/bin/env node
// THE HOUSEHOLD'S PLAN CANNOT BE OVERWRITTEN BY A DEVICE THAT DOESN'T KNOW WHAT IT HAS.
//
// Two defects combined into a silent data loss:
//
//   1. an UNREADABLE local save (interrupted write, truncated JSON, unknown version) made
//      the DEFAULT apartment start up while believing itself configured (`setupDone = hadSaved`), with no
//      message and without even opening the setup assistant; the first save overwrote the damaged content
//      (6,040 bytes -> 1,692) with no backup copy;
//   2. the push to the shared plan is debounced by ONE second and did not wait for the response of the
//      bootstrap GET. The PUT is blind (no `rev` in the body, last writer wins).
//
// So: on a slow connection, a modification made within the first second published
// the default apartment OVER the household's plan, and polling then redistributed it to
// other devices. This test sets up the real rig (local HTTP server + the REAL Pages Function
// over an in-memory D1, GET deliberately slow) and proves it both ways.
//
// Run:   node tests/plan-abime.ts [path-to-app-html]
// Exit:  0 if everything passes, 1 otherwise.

import type { VerdictSonde } from "./_types.ts";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { onRequestGet, onRequestPut } from "../functions/api/plan.ts";
import { fakeD1 } from "./fake-d1.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const APP_PATH = process.argv[2] || path.join(__dirname, "..", "index.html");
const V4_KEY = "room-planner-v4";
// The bootstrap GET responds in 3 s: this is a slow mobile connection, not a lab-only case.
// The push, meanwhile, fires 1 s after the last modification.
const GET_DELAY = 3000;

if (!fs.existsSync(APP_PATH)) { console.error("App file not found:", APP_PATH); process.exit(1); }
if (!fs.existsSync(CHROME)) { console.error("Chrome not found:", CHROME); process.exit(1); }

const APP_SRC = fs.readFileSync(APP_PATH, "utf8");
// The HOUSEHOLD's plan, as it already is in the database when the damaged device wakes up.
const HOUSEHOLD = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "plan-rev177.json"), "utf8"));
const HOUSEHOLD_ROOMS = HOUSEHOLD.rooms.length;
const HOUSEHOLD_MARK = String(HOUSEHOLD.rooms[0].name || "");

// The in-memory D1 (a REAL SQLite, see tests/fake-d1.ts) is ALREADY populated with the household's plan,
// at revision 7 written by the other household member.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: VerdictSonde[] = [];
function check(name: string, cond: VerdictSonde, detail: string) {
  results.push({ name, pass: !!cond });
  process.stdout.write((cond ? "  ok   " : "  FAIL ") + name + "\n");
  if (!cond) process.stdout.write("       " + (detail || "") + "\n");
}
// Is the household's plan STILL in the D1 row?
function householdIntact(db: VerdictSonde) {
  const raw = String(db.store.row && db.store.row.data || "");
  return raw.indexOf(HOUSEHOLD_MARK) >= 0;
}

// ---- a browser driven over CDP ---------------------------------------------------------------
async function openBrowser(label: string, url: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-abime-" + label + "-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
    "--no-default-browser-check", "--hide-scrollbars",
    "--user-data-dir=" + path.join(dir, "profile"),
    "--remote-debugging-port=0", "--window-size=1400,900", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const portFile = path.join(dir, "profile", "DevToolsActivePort");
  let port = null;
  for (let i = 0; i < 200 && !port; i++) {
    if (fs.existsSync(portFile)) {
      // The file can be LOCKED (EBUSY: Chrome still has it open), missing (ENOENT), or
      // truncated, especially since several Chrome instances start at once. We RETRY
      // until the timeout instead of throwing.
      let t: VerdictSonde[] = [];
      try { t = fs.readFileSync(portFile, "utf8").split("\n"); } catch { t = []; }
      if (t[0] && /^[0-9]+$/.test(t[0].trim())) port = t[0].trim();
    }
    if (!port) await sleep(50);
  }
  if (!port) throw new Error(label + ": no DevToolsActivePort");
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
  const target = list.find((t) => t.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let msgId = 0;
  const pending = new Map<number, (message: ReturnType<typeof JSON.parse>) => void>();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method: string, params?: VerdictSonde) => new Promise<ReturnType<typeof JSON.parse>>((res) => {
    const id = ++msgId; pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const evaluate = async (expr: string) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(label + ": " + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const J = async (expr: string) => JSON.parse(await evaluate(`JSON.stringify(${expr})`));
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url });
  return { label, evaluate, J, send,
           close: () => { try { ws.close(); } catch (_) {} chrome.kill(); } };
}

let code = 0;
const opened = [];
try {
  // ============================================================================================
  //  RIG: the household's plan is in the database; the GET takes 3 s; pages seed whatever we want.
  // ============================================================================================
  const db = fakeD1(HOUSEHOLD, 7, "b@example.com");
  const seeds = new Map();   // pathname -> RAW string written to room-planner-v4 (or null)
  // The INVARIANT, measured SERVER-SIDE and independent of any test clock: no PUT must
  // arrive from a device whose bootstrap read has not yet responded. Each device is
  // recognized by its tab's `Referer`; only ITS FIRST read is slow (subsequent polls
  // respond right away, otherwise any normal write would fall inside the window).
  // The LOG of all PUTs serves the second guardrail: no payload has ever carried a
  // plan that this device was not allowed to publish.
  const bootPending = new Map();   // device -> is its bootstrap read still in flight?
  const seenGet = new Set();
  const violations: VerdictSonde[] = [];
  const putLog: VerdictSonde[] = [];
  const tagOf = (req: VerdictSonde) => { try { return new URL(req.headers.referer || "http://x/?").pathname; }
                           catch (_) { return "?"; } };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://" + req.headers.host);
    if (url.pathname === "/api/plan") {
      const email = req.headers["x-who"] || "a@example.com";
      const tag = tagOf(req);
      let body = "";
      for await (const c of req) body += c;
      if (req.method === "PUT") {
        putLog.push({ tag, body });
        if (bootPending.get(tag)) violations.push({ tag, body: body.slice(0, 180) });
      }
      if (req.method === "GET" && !seenGet.has(tag)) {   // the FIRST read, over a slow line
        seenGet.add(tag); bootPending.set(tag, true);
        await sleep(GET_DELAY);
        bootPending.set(tag, false);
      }
      const request = new Request("https://plan.example.org/api/plan", {
        method: req.method,
        headers: { "Content-Type": "application/json", "Cf-Access-Authenticated-User-Email": String(email) },
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
      let out;
      try {
        out = req.method === "PUT"
          ? await onRequestPut({ request, env: db.env } as unknown as Parameters<typeof onRequestPut>[0])
          : await onRequestGet({ request, env: db.env } as unknown as Parameters<typeof onRequestGet>[0]);
      } catch (e) { res.writeHead(500); res.end(String(e)); return; }
      const text = await out.text();
      res.writeHead(out.status, { "Content-Type": out.headers.get("content-type") || "text/plain" });
      res.end(text);
      return;
    }
    if (seeds.has(url.pathname)) {
      const raw = seeds.get(url.pathname);
      const seed = raw == null ? "" : `localStorage.setItem(${JSON.stringify(V4_KEY)}, ${JSON.stringify(raw)});`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><script>
        window.__PLAN_TEST__ = 1;
        try { localStorage.clear(); ${seed} } catch(e){}
      </script></head><body>` + APP_SRC + `</body></html>`);
      return;
    }
    res.writeHead(404); res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const PORT = (server.address() as { port: number }).port;
  const URL_OF = (p: VerdictSonde) => `http://127.0.0.1:${PORT}${p}`;

  // ============================================================================================
  //  1. AN UNREADABLE LOCAL SAVE DOES NOT PASS FOR A PLAN
  // ============================================================================================
  // The real blob, cut at 60%: exactly what an interrupted write leaves behind.
  const REAL = JSON.stringify({ app: "room-planner", state: HOUSEHOLD });
  const TRUNCATED = REAL.slice(0, Math.floor(REAL.length * 0.6));
  seeds.set("/abime", TRUNCATED);
  const A = await openBrowser("abime", URL_OF("/abime"));
  opened.push(A);

  // We modify EARLY, while the bootstrap GET is still in flight.
  await sleep(700);
  const early = await A.J(`(function(){
    return {setupDone:window.__plan.state.setupDone,
            assistant:!document.getElementById("setup").hidden,
            dit:/unreadable/i.test(document.body.innerText),
            rescapee:Object.keys(localStorage).filter(function(k){return /illisible/.test(k);}),
            cellules:window.__plan.plan.cells.length};})()`);
  check("un enregistrement illisible ne fait plus croire à l'application qu'elle est configurée",
    early.setupDone !== true, "setupDone=" + early.setupDone);
  check("le contenu abîmé est mis de côté sous sa propre clé, intact",
    early.rescapee.length > 0, "clés de secours = " + JSON.stringify(early.rescapee));
  check("et l'écran le DIT (assistant ouvert ou bandeau d'alerte)",
    early.dit === true || early.assistant === true,
    "assistant=" + early.assistant + " message=" + early.dit);

  // The modification made BEFORE the server responded: this is THE gesture that published the defect.
  await A.evaluate(`(function(){ var P=window.__plan.plan;
    P.cells[0].name="Modif faite pendant le chargement"; window.__plan.save(); })()`);
  await sleep(GET_DELAY + 2500);          // the GET responds, adoption happens, everything settles
  check("aucun envoi n'est parti pendant que la lecture d'amorçage était encore en vol",
    violations.length === 0,
    violations.length + " PUT reçu(s) alors que le GET d'amorçage n'avait pas répondu : "
      + JSON.stringify(violations.slice(0, 1)));

  // And once the household's plan arrives, it is ADOPTED (not overwritten).
  const adopted = await A.J(`(function(){ return {cellules:window.__plan.plan.cells.length,
    setupDone:window.__plan.state.setupDone};})()`);
  check("le plan du foyer arrive et est adopté par l'appareil abîmé",
    adopted.cellules > 1, "cellules après adoption = " + adopted.cellules);
  check("le plan partagé n'a jamais reçu l'appartement par défaut",
    householdIntact(db),
    "ligne D1 = " + String(db.store.row.data).slice(0, 200));

  // ============================================================================================
  //  2. SAME GUARDRAIL WITH A LOCAL PLAN THAT IS PERFECTLY READABLE BUT STALE
  // ============================================================================================
  // This device has a valid plan locally (so setupDone=true, so publishable): this is the
  // NORMAL case. It must not publish either before reading what is on the other side, otherwise it overwrites
  // the household with its own stale version on the first keystroke.
  const STALE = JSON.stringify({ app: "room-planner", state: {
    setupDone: true,
    rooms: [{ id: 1, name: "Vieux plan de cet appareil", floor: "parquet", ax: 0, ay: 0,
              room: { poly: [[0, 0], [300, 0], [300, 250], [0, 250]] }, pieces: [] }],
    envelope: null } });
  seeds.set("/perime", STALE);
  const violBefore = violations.length;
  const B = await openBrowser("perime", URL_OF("/perime"));
  opened.push(B);
  await sleep(700);
  const bSetup = await B.J(`window.__plan.state.setupDone`);
  check("l'appareil au plan périmé se sait bien configuré (témoin : il aurait le droit de publier)",
    bSetup === true, "setupDone=" + bSetup);
  await B.evaluate(`(function(){ var P=window.__plan.plan;
    P.cells[0].name="Frappe dans la premiere seconde"; window.__plan.save(); })()`);
  await sleep(GET_DELAY + 2500);
  check("une frappe dans la première seconde ne publie rien avant la réponse du serveur",
    violations.length === violBefore,
    (violations.length - violBefore) + " PUT pendant un GET en vol : " + JSON.stringify(violations.slice(violBefore, violBefore + 2)));
  const bAfter = await B.J(`(function(){ return {cellules:window.__plan.plan.cells.length,
    noms:window.__plan.plan.cells.map(function(c){return c.name;}).slice(0,3)};})()`);
  check("après la réponse, c'est le plan du FOYER qui règne sur cet appareil",
    bAfter.cellules > 1, "cellules = " + bAfter.cellules + " " + JSON.stringify(bAfter.noms));
  check("et le plan partagé n'a JAMAIS porté le vieux plan de cet appareil",
    putLog.every((p) => p.body.indexOf("Vieux plan de cet appareil") < 0) && householdIntact(db),
    "ligne D1 = " + String(db.store.row.data).slice(0, 200));
  // The decisive guardrail, over the WHOLE session: not a single payload carried the outline of
  // the default apartment. This is the PUT that destroyed the household's plan and then
  // propagated to the other device through polling.
  const defaultPuts = putLog.filter((p) => p.body.indexOf('[[0,0],[420,0],[420,360],[0,360]]') >= 0);
  check("aucune charge utile n'a JAMAIS porté l'appartement par défaut (420 × 360)",
    defaultPuts.length === 0,
    defaultPuts.length + " PUT sur " + putLog.length + " portaient le contour par défaut, envoyé(s) par "
      + JSON.stringify(defaultPuts.map((p) => p.tag)));

  // ============================================================================================
  //  3. THE LOCK DOES NOT BLOCK NORMAL LIFE: after the response, we publish
  // ============================================================================================
  const putsBeforeEdit = db.store.puts;
  await B.evaluate(`(function(){ var P=window.__plan.plan;
    P.cells[0].name="Renomme apres reconciliation"; window.__plan.save(); })()`);
  let seen = false;
  for (let i = 0; i < 12 && !seen; i++) {
    await sleep(1000);
    seen = String(db.store.row.data).indexOf("Renomme apres reconciliation") >= 0;
  }
  check("une fois réconcilié, l'appareil publie normalement (le verrou n'est pas un blocage)",
    seen && db.store.puts > putsBeforeEdit,
    "écritures = " + (db.store.puts - putsBeforeEdit) + ", ligne = " + String(db.store.row.data).slice(0, 160));

  // ============================================================================================
  //  4. no JS error on either side
  // ============================================================================================
  const errs = async (b: VerdictSonde) => b.evaluate('JSON.stringify((JSON.parse(localStorage.getItem("plan-errors")||"[]")||[]).map(function(e){return e&&e.msg;}))');
  const ea = await errs(A), eb = await errs(B);
  check("aucune erreur JS journalisée", ea === "[]" && eb === "[]", "abîmé=" + ea + " périmé=" + eb);

  server.close();
} catch (e) {
  process.stdout.write("ERREUR DE SCÉNARIO : " + (e && e.stack || e) + "\n");
  code = 1;
} finally {
  opened.forEach((b) => b.close());
}

const passed = results.filter((r) => r.pass).length;
process.stdout.write("\n" + (passed === results.length && !code
  ? "OK " + passed + "/" + results.length
  : "FAILURES " + (results.length - passed) + "/" + results.length) + "\n");
process.exit(passed === results.length && !code ? 0 : 1);
