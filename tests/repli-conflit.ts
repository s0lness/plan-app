#!/usr/bin/env node
// TWO DEVICES WRITE OVER THE FALLBACK AT THE SAME TIME. ONLY ONE CAN WIN, AND THE OTHER MUST KNOW IT.
//
// The system's only STRUCTURAL gap (docs/collab-etat-de-l-art.md, gap #1): there are two
// writers to the D1 row, the Durable Object (snapshot every 30 s) and the client through
// `PUT /api/plan` when realtime has fallen, and the PUT was BLIND. No revision in the
// body, deliberately lax shape guard, last writer wins. Two people falling back
// simultaneously therefore overwrote each other, silently.
//
// This bench replays exactly that, for real:
//   - a local HTTP server serves the application AND `/api/plan`, wired to the REAL Pages Function
//     over an in-memory SQLite database (tests/fake-d1.ts): the compare-and-swap is arbitrated
//     by the engine, not by a complacent simulation;
//   - no `/ws` exists: both tabs fall back, as if a Worker had gone down;
//   - during the conflict WINDOW, the server WITHHOLDS reads: neither can
//     learn about its neighbor's write before having attempted its own. This is the real case, framed.
//
// Two parts:
//   1. THE LOCK, without a browser: the Function's compare-and-swap, its atomicity, its explicit
//      refusal, and the legitimate writer that does not play compare-and-swap (the
//      Durable Object's snapshot, which writes the same row through its own binding).
//   2. THE TWO DEVICES, for real: who wins, what becomes of the loser's version, what the
//      chip and the banner say about it, and the fact that NO rewrite loop follows the refusal.
//
// Run:   node tests/repli-conflit.ts [path/to/app.html]
//        node tests/repli-conflit.ts --avant     (measuring the BEFORE: index.html and Function from HEAD)
// Exit:  0 if everything passes, 1 otherwise. In `--avant` mode we MEASURE and require nothing: the goal is to
//        show in black and white what the old code used to do.

import type { DonneeDynamique, VerdictSonde } from "./_types.ts";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { fakeD1 } from "./fake-d1.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const CONFLIT_KEY = "room-planner-v4-conflit";   // versions SET ASIDE by a revision refusal

const args = process.argv.slice(2);
const AVANT = args.includes("--avant");
const APP_ARG = args.find((a) => !a.startsWith("--"));

// ---- what's needed to measure the BEFORE: the application AND the Function as they are in HEAD ------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-conflit-"));
const gitShow = (p: VerdictSonde) => execFileSync("git", ["show", "HEAD:" + p],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });

let APP_SRC: VerdictSonde, planApi, LABEL;
if (AVANT) {
  LABEL = "AVANT (HEAD)";
  APP_SRC = gitShow("index.html");
  const f = path.join(tmpDir, "plan-head.ts");
  fs.writeFileSync(f, gitShow("functions/api/plan.ts"));
  planApi = await import(pathToFileURL(f).href);
} else {
  LABEL = "APRÈS (arbre de travail)";
  const APP_PATH = APP_ARG || path.join(ROOT, "index.html");
  if (!fs.existsSync(APP_PATH)) { console.error("App file not found:", APP_PATH); process.exit(1); }
  APP_SRC = fs.readFileSync(APP_PATH, "utf8");
  planApi = await import("../functions/api/plan.ts");
}
const { onRequestGet, onRequestPut } = planApi;
const REAL_PLAN = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "plan-rev177.json"), "utf8"));

// ---- assertions ---------------------------------------------------------------------------------
const results: VerdictSonde[] = [];
function check(name: string, cond: VerdictSonde, detail: string) {
  results.push({ name, pass: !!cond, detail: detail || "" });
  process.stdout.write((cond ? "  ok   " : "  FAIL ") + name + "\n");
  if (!cond) process.stdout.write("       " + (detail || "") + "\n");
}
// In BEFORE mode we record the finding without turning it into a failure: we MEASURE.
function mesure(name: string, cond: VerdictSonde, detail: string) {
  if (AVANT) { process.stdout.write("  " + (cond ? "oui " : "NON ") + " " + name
                                    + (detail ? "   [" + detail + "]" : "") + "\n"); return; }
  check(name, cond, detail);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const put = (env: VerdictSonde, state: VerdictSonde, rev: VerdictSonde, email?: string) => onRequestPut({
  request: new Request("https://plan.example.org/api/plan", {
    method: "PUT",
    headers: { "Content-Type": "application/json",
               "Cf-Access-Authenticated-User-Email": email || "a@example.com" },
    body: JSON.stringify(rev === undefined ? { state } : { state, rev }),
  }),
  env,
} as unknown as Parameters<typeof onRequestPut>[0]);

process.stdout.write("\n" + LABEL + "\n\n");
process.stdout.write("  --- 1. le verrou de révision, sans navigateur ---\n");

// =================================================================================================
//  1. THE FUNCTION'S COMPARE-AND-SWAP
// =================================================================================================
const S = (n: string) => ({ setupDone: true, model: "v5", outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
                    walls: [] as VerdictSonde[], openings: [] as VerdictSonde[], pieces: [] as VerdictSonde[], cells: [{ id: "c1", name: n }] });

{
  const d = fakeD1(null);
  // Bootstrap: the row does not exist, the client says "I have read nothing more than empty".
  const r0 = await put(d.env, S("amorce"), 0);
  mesure("une ligne absente s'amorce (rev 0 attendu -> insertion)",
    r0.status === 200 && d.store.row && d.store.row.rev === 1,
    "statut " + r0.status + " rev " + (d.store.row && d.store.row.rev));

  // TWO WRITERS ON THE SAME DATABASE: only one should take hold.
  const [rA, rB] = await Promise.all([
    put(d.env, S("Device A"), 1, "a@example.com"),
    put(d.env, S("Device B"), 1, "b@example.com"),
  ]);
  const codes = [rA.status, rB.status].sort().join("/");
  mesure("deux écritures sur la MÊME révision : une seule passe",
    codes === "200/409", "statuts " + codes);
  mesure("la ligne n'a avancé que d'UNE révision (pas d'écrasement du gagnant)",
    d.store.row.rev === 2, "rev = " + d.store.row.rev);

  // The refusal is EXPLICIT and carries enough to re-read, without a second round trip.
  const perdant = rA.status === 409 ? rA : rB;
  if (perdant.status === 409) {
    const body = await perdant.clone().json();
    mesure("le refus est un 409 qui porte la révision, l'auteur ET l'état gagnants",
      body.conflict === true && body.rev === 2 && !!body.updatedBy && !!body.data,
      JSON.stringify({ conflict: body.conflict, rev: body.rev, by: body.updatedBy,
                       data: !!body.data }));
    mesure("l'état rendu au perdant est bien celui qui a gagné",
      body.data && body.data.cells && body.data.cells[0]
        && body.data.cells[0].name === JSON.parse(d.store.row.data).cells[0].name,
      "rendu " + JSON.stringify(body.data && body.data.cells && body.data.cells[0]));
  } else {
    mesure("le refus est un 409 qui porte la révision, l'auteur ET l'état gagnants", false,
      "aucune écriture n'a été refusée : les deux ont été acceptées");
    mesure("l'état rendu au perdant est bien celui qui a gagné", false, "il n'y a pas eu de perdant");
  }

  // A revision STALE by several steps is refused too, and touches nothing.
  const revAvant = d.store.row.rev, dataAvant = d.store.row.data;
  const vieux = await put(d.env, S("très en retard"), 1);
  mesure("une révision périmée est refusée et ne touche pas la ligne",
    vieux.status === 409 && d.store.row.rev === revAvant && d.store.row.data === dataAvant,
    "statut " + vieux.status + " rev " + d.store.row.rev);

  // THE LEGITIMATE WRITER THAT DOES NOT PLAY COMPARE-AND-SWAP. The Durable Object's snapshot writes
  // this same row through its own binding, with no expected revision: it must not be blocked.
  const revDO = d.store.writeDirect(S("snapshot du temps réel"), "live");
  mesure("le snapshot du Durable Object (sans révision attendue) écrit toujours",
    revDO === 1 && d.store.row.updated_by === "live" && d.store.row.rev === revAvant + 1,
    "rev " + d.store.row.rev + " par " + d.store.row.updated_by);
  // ...and it moves the revision, so the next client PUT MUST be refused, not accepted.
  const apresDO = await put(d.env, S("client qui n a pas vu le snapshot"), revAvant);
  mesure("un client qui n'a pas vu ce snapshot est refusé (le trou ne se rouvre pas par là)",
    apresDO.status === 409, "statut " + apresDO.status);

  // A PUT WITHOUT a revision stays accepted: this is the old contract, for a tab not yet reloaded.
  const aveugle = await put(d.env, S("onglet d avant le deploiement"), undefined);
  mesure("un PUT sans révision reste accepté (ancien contrat, compatibilité)",
    aveugle.status === 200, "statut " + aveugle.status);

  // The SHAPE guard stays deliberately lax: tightening it here would kill the fallback.
  const murs = await put(d.env, { outline: [[0, 0]], walls: [], setupDone: true }, d.store.row.rev);
  const vieuxFormat = await put(d.env, { rooms: [], envelope: null, setupDone: true }, d.store.row.rev);
  mesure("les DEUX formes passent toujours (murs-seuls ET rooms[]) : le repli reste vivant",
    murs.status === 200 && vieuxFormat.status === 200,
    "murs=" + murs.status + " rooms=" + vieuxFormat.status);
  const nimporte = await put(d.env, { foo: 1 }, d.store.row.rev);
  mesure("et une forme inconnue reste refusée en 400 (pas en 409)",
    nimporte.status === 400, "statut " + nimporte.status);
}

// ---- UN EXÉCUTEUR QUI NE COMPTE PAS ------------------------------------------------------------
// `meta.changes` est ce d'où le compare-and-swap tire son verdict. Quand il manque, l'instruction
// a QUAND MÊME été exécutée : répondre 409 annonce un refus pour une écriture qui a peut-être
// abouti, et le client met alors de côté une version qui EST celle du serveur, allume la bannière
// « non enregistré » et cesse d'écrire. On relit la ligne au lieu de deviner.
{
  const d = fakeD1(null);
  // Le MÊME SQLite, la même arbitration : seul le compte disparaît de la réponse.
  const sansCompte: DonneeDynamique = { DB: { prepare: (sql: string) => {
    const st = d.env.DB.prepare(sql);
    return {
      bind(...a: DonneeDynamique[]) { st.bind(...a); return this; },
      first: () => st.first(),
      all: () => st.all(),
      run: async () => { await st.run(); return { success: true }; },
    };
  } } };

  const amorce = await put(sansCompte, S("amorce sans compte"), 0);
  mesure("sans meta.changes, une écriture qui A ABOUTI répond 200, pas 409",
    amorce.status === 200 && d.store.row && d.store.row.rev === 1,
    "statut " + amorce.status + " rev " + (d.store.row && d.store.row.rev));

  const perime = await put(sansCompte, S("révision périmée"), 0);
  mesure("sans meta.changes, une révision périmée reste refusée (la relecture tranche)",
    perime.status === 409 && d.store.row.rev === 1,
    "statut " + perime.status + " rev " + d.store.row.rev);

  const suite = await put(sansCompte, S("suite"), 1);
  mesure("et l'écriture suivante, légitime, passe aussi",
    suite.status === 200 && d.store.row.rev === 2,
    "statut " + suite.status + " rev " + d.store.row.rev);
}

// ---- UNE LIGNE ILLISIBLE EST UNE PANNE NOMMÉE, PAS UN PLAN VIDE --------------------------------
// `JSON.parse(row.data)` sans garde remontait en 500 muet. Répondre `{data:null}` serait pire : le
// client y lit « le foyer n'a pas encore de plan » et un appareil configuré écraserait alors les
// octets que personne n'a réussi à lire. Un 500 nommé garde le verrou d'amorçage fermé.
{
  const d = fakeD1(null);
  d.db.prepare("INSERT INTO plans(id,data,rev,updated_at,updated_by) VALUES('main','{\"outline\":[[0,0]',7,?1,'a@example.com')")
    .run(new Date().toISOString());
  const res = await onRequestGet({
    request: new Request("https://plan.example.org/api/plan"), env: d.env,
  } as unknown as Parameters<typeof onRequestGet>[0]);
  const corps = await res.clone().json();
  mesure("une ligne illisible répond 500 avec une raison, jamais un plan vide",
    res.status === 500 && corps.error === "plan_illisible" && corps.reason === "json",
    "statut " + res.status + " corps " + JSON.stringify(corps));
}

// =================================================================================================
//  2. TWO DEVICES, TWO REAL BROWSERS, REALTIME DOWN
// =================================================================================================
process.stdout.write("\n  --- 2. deux appareils écrivent en repli en même temps ---\n");

const db = fakeD1(REAL_PLAN, 1, "b@example.com");
const putLog: VerdictSonde[] = [];            // {who, rev, status, mark, t}
let gele: VerdictSonde = null;              // during the conflict window, reads return THIS response
const figerLectures = () => {
  const r = db.store.row;
  gele = { data: JSON.parse(r.data), rev: r.rev, updatedAt: r.updated_at, updatedBy: r.updated_by };
};

function pageHtml(email: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><script>
    window.__PLAN_TEST__ = 1;
    window.__WHO__ = ${JSON.stringify(email)};
    try { localStorage.clear(); } catch(e){}
  </script></head><body>` + APP_SRC + `</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + req.headers.host);
  if (url.pathname === "/api/plan") {
    const email = req.headers["x-who"]
      || (String(req.headers.referer || "").endsWith("/b") ? "b@example.com"
                                                           : "a@example.com");
    let body = "";
    for await (const c of req) body += c;
    // THE CONFLICT WINDOW: while it is open, READS return the row as it
    // was when it opened. This is exactly the situation we want: two devices on the
    // fallback that have not yet polled, so both believe they hold the latest revision.
    // (We freeze the RESPONSE instead of holding it back: a browser that already has a request
    // in flight to this address does not send a second one, so holding back the read also held back the write
    // and the scenario could not play out. Measured: the second device's PUT only arrived at the
    // reopening of reads.)
    if (req.method === "GET" && gele) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(gele));
      return;
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
    if (req.method === "PUT") {
      let rev = null, mark = "";
      try { const b = JSON.parse(body); rev = b.rev === undefined ? null : b.rev;
            mark = (b.state && b.state.cells || []).map((c: VerdictSonde) => c.name).join("|"); } catch (_) {}
      putLog.push({ who: email, rev, status: out.status, mark, t: Date.now() });
    }
    const text = await out.text();
    res.writeHead(out.status, { "Content-Type": out.headers.get("content-type") || "text/plain" });
    res.end(text);
    return;
  }
  if (url.pathname === "/a" || url.pathname === "/b") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageHtml(url.pathname === "/a" ? "a@example.com" : "b@example.com"));
    return;
  }
  res.writeHead(404); res.end("not found");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const PORT = (server.address() as { port: number }).port;

async function openBrowser(label: string, pathname: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-conflit-" + label + "-"));
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
  const send = (method: string, params?: VerdictSonde) => new Promise<ReturnType<typeof JSON.parse>>((r) => {
    const id = ++msgId; pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const evaluate = async (expr: string) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails)
      throw new Error(label + ": " + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const J = async (expr: string) => JSON.parse(await evaluate(`JSON.stringify(${expr})`));
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}${pathname}` });
  for (let i = 0; i < 150; i++) {
    if (await evaluate("document.readyState") === "complete") break;
    await sleep(60);
  }
  await sleep(400);
  const shot = async (name: string) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    const f = path.join(os.tmpdir(), `conflit-${label}-${name}.png`);
    fs.writeFileSync(f, Buffer.from(r.result.data, "base64"));
    return f;
  };
  return { label, evaluate, J, shot, close: () => { try { ws.close(); } catch (_) {} chrome.kill(); } };
}

// Renames the FIRST cell through the REAL interface path (field #rcName).
const renomme = (name: string) => `(function(){
  var c = window.__plan.plan.cells[0];
  window.__plan.selectCell(c.id);
  var f = document.getElementById("rcName");
  f.value = ${JSON.stringify(name)};
  f.dispatchEvent(new Event("input", { bubbles: true }));
  try { f.blur(); } catch(e) {}
  return c.id;
})()`;

const etat = `JSON.stringify({
  nom: window.__plan.plan.cells[0].name,
  rev: window.__plan.serverRev,
  puce: document.getElementById("syncChip").textContent,
  titre: document.getElementById("syncChip").title,
  bandeau: (function(){ var b=document.getElementById("bootNotice");
    return (b && !b.hidden) ? b.textContent : null; })(),
  recup: !!document.getElementById("conflitDl"),
  ecartees: (function(){ try {
    var l = JSON.parse(localStorage.getItem(${JSON.stringify(CONFLIT_KEY)}) || "[]");
    return l.map(function(e){ return { par:e.par, rev:e.rev,
      nom:(e.state && e.state.cells && e.state.cells[0]) ? e.state.cells[0].name : null }; });
  } catch(e) { return "illisible"; } })()
})`;

let A = null, B = null, code = 0;
const DEVICE_A = "Cloison posee par Device A";
const DEVICE_B = "Cloison posee par Device B";
try {
  // Device A first, ALONE: it adopts the household's plan (still in the old format), converts it and
  // publishes the walls-only shape. Device B then arrives on an already-converted plan: it adopts it without
  // republishing anything. So we start from a clean common base, with no bootstrap conflict.
  A = await openBrowser("device-a", "/a");
  await sleep(5000);
  const putsAvantB = putLog.length, revAvantB = db.store.row.rev;
  B = await openBrowser("device-b", "/b");
  await sleep(6000);

  // ---- ADOPTING IS NOT MODIFYING --------------------------------------------------------------
  // Device B starts on a plan it did not make: it falls in line with it, it does not REPUBLISH it. The
  // publish lock (`bootReconciled`, js/41) DELAYED the push instead of canceling it, so
  // a pending modification at the moment of adoption fired right after and sent back to the
  // server the very state it had just received: one extra revision for nothing, and the neighbor's
  // next PUT, which carried the PRIOR revision, refused with 409, "not saved" banner and version
  // set aside, with no real conflict existing at all.
  const bootB = putLog.slice(putsAvantB);
  mesure("l'appareil qui démarre ne republie pas le plan qu'il vient d'adopter",
    bootB.length === 0 && db.store.row.rev === revAvantB,
    "écritures pendant l'amorçage de Device B = " + JSON.stringify(bootB)
      + ", ligne D1 rev " + revAvantB + " -> " + db.store.row.rev);

  const lire = async (b: VerdictSonde) => JSON.parse(await b.evaluate(etat));
  const a0 = await lire(A), b0 = await lire(B);
  const rev0 = db.store.row.rev;
  // The chip can carry the TRANSIENT "modified by..." message (4 s after an adoption): what
  // matters here is that neither one announces realtime, and above all that both
  // devices start from the SAME revision as the row.
  const surLeRepli = (p: VerdictSonde) => p === "slow sync" || /^changed/.test(String(p));
  check("les deux appareils sont sur le repli D1 (temps réel tombé) et partagent la même base",
    surLeRepli(a0.puce) && surLeRepli(b0.puce) && a0.rev === rev0 && b0.rev === rev0,
    "puces " + JSON.stringify([a0.puce, b0.puce]) + " révisions "
      + JSON.stringify([a0.rev, b0.rev]) + " ligne " + rev0);
  process.stdout.write("       base commune : ligne D1 rev " + rev0
    + ", Device A rev " + a0.rev + ", Device B rev " + b0.rev + "\n");

  // ---- THE WINDOW: nobody learns of the other's write before having attempted their own -----
  figerLectures();
  const putsAvant = putLog.length;
  const t0 = Date.now();
  await A.evaluate(renomme(DEVICE_A));
  await sleep(400);                     // Device A goes first: its PUT arrives first
  await B.evaluate(renomme(DEVICE_B));
  await sleep(3000);                    // 1 s debounce + PUT + response, on both sides

  const fenetre = putLog.slice(putsAvant);
  const acceptes = fenetre.filter((p) => p.status === 200);
  const refuses = fenetre.filter((p) => p.status === 409);
  process.stdout.write("       écritures pendant la fenêtre : " + fenetre.length
    + " (" + acceptes.length + " acceptée(s), " + refuses.length + " refusée(s))\n");
  fenetre.forEach((p) => process.stdout.write("         +" + ((p.t - t0) / 1000).toFixed(1)
    + "s  " + p.who.split("@")[0] + "  rev=" + p.rev + "  -> " + p.status + "\n"));

  const ligne = String(db.store.row.data);
  const gagnant = ligne.indexOf(DEVICE_A) >= 0 ? "Device A" : (ligne.indexOf(DEVICE_B) >= 0 ? "Device B" : "?");
  process.stdout.write("       ligne D1 après la fenêtre : rev " + db.store.row.rev
    + ", écrite par " + db.store.row.updated_by + ", elle porte le travail de " + gagnant + "\n");

  mesure("la seconde écriture est REFUSÉE, pas acceptée par-dessus la première",
    acceptes.length === 1 && refuses.length >= 1,
    acceptes.length + " acceptée(s) et " + refuses.length + " refusée(s) : "
      + JSON.stringify(fenetre));
  mesure("la ligne D1 n'a avancé que d'une révision (le premier travail est intact)",
    db.store.row.rev === rev0 + 1 && ligne.indexOf(DEVICE_A) >= 0,
    "rev " + rev0 + " -> " + db.store.row.rev + ", porte Device A ? " + (ligne.indexOf(DEVICE_A) >= 0)
      + ", porte Device B ? " + (ligne.indexOf(DEVICE_B) >= 0));

  // What Device B sees AT THE MOMENT of the refusal, before any re-read.
  const bRefus = await lire(B);
  await B.shot("1-refus");
  mesure("le perdant SAIT : sa version est mise de côté sous sa propre clé",
    Array.isArray(bRefus.ecartees) && bRefus.ecartees.length === 1
      && bRefus.ecartees[0].nom === DEVICE_B,
    "mises de côté = " + JSON.stringify(bRefus.ecartees));
  mesure("le perdant SAIT : un bandeau le dit, avec de quoi récupérer sa version",
    !!bRefus.bandeau && /was not saved/.test(bRefus.bandeau) && bRefus.recup === true,
    "bandeau = " + JSON.stringify(bRefus.bandeau) + " bouton = " + bRefus.recup);

  // ---- WE REOPEN READS: both must converge, with no rewrite loop ---------
  const putsApresFenetre = putLog.length;
  gele = null;
  await sleep(8000);

  const a1 = await lire(A), b1 = await lire(B);
  const suite = putLog.slice(putsApresFenetre);
  process.stdout.write("       après réouverture des lectures : " + suite.length
    + " écriture(s), " + suite.filter((p) => p.status === 409).length + " refus\n");
  mesure("les deux écrans convergent sur le plan qui a gagné",
    a1.nom === DEVICE_A && b1.nom === DEVICE_A,
    "Device A voit " + JSON.stringify(a1.nom) + ", Device B voit " + JSON.stringify(b1.nom));
  mesure("le perdant a RELU, il n'a pas réécrit en boucle",
    suite.filter((p) => p.who === "b@example.com").length === 0,
    "écritures de Device B après le refus : "
      + JSON.stringify(suite.filter((p) => p.who === "b@example.com")));
  mesure("une seule version a été mise de côté, pas une par tentative",
    Array.isArray(b1.ecartees) && b1.ecartees.length === 1,
    "mises de côté = " + JSON.stringify(b1.ecartees));
  mesure("la puce ne ment plus une fois le plan du foyer relu",
    b1.puce === "slow sync" || /changed/.test(b1.puce), "puce = " + JSON.stringify(b1.puce));

  // ---- THE LOSER'S VERSION IS RECOVERABLE: Ctrl+Z brings it back to the screen ---------------------
  await B.evaluate(`(function(){ try{ document.activeElement.blur(); }catch(e){}
    window.dispatchEvent(new KeyboardEvent("keydown",
      { key:"z", ctrlKey:true, bubbles:true, cancelable:true })); })()`);
  // ON ATTEND LA CONDITION, PAS LE Ctrl+Z. Ce cas dormait 400 ms puis lisait le nom, et il est
  // tombe en barriere complete (« Device B voit Room 1 ») alors qu'il passe seul, deux fois de
  // suite: sous charge, l'annulation n'avait pas encore repeint. Allonger le sommeil ne ferait que
  // deplacer le seuil (AGENTS.md: attendre une CONDITION, jamais une duree).
  let bUndo = "";
  for (let i = 0; i < 60; i++) {
    bUndo = await B.evaluate("window.__plan.plan.cells[0].name");
    if (bUndo === DEVICE_B) break;
    await sleep(200);
  }
  mesure("Ctrl+Z ramène à l'écran la version qu'on lui a refusée",
    bUndo === DEVICE_B, "après Ctrl+Z, Device B voit " + JSON.stringify(bUndo));

  // ---- LIFE GOES ON: after the refusal, a new modification passes normally ----------
  await sleep(1200);
  await B.evaluate(`(function(){ try{ document.activeElement.blur(); }catch(e){}
    window.dispatchEvent(new KeyboardEvent("keydown",
      { key:"y", ctrlKey:true, bubbles:true, cancelable:true })); })()`);   // redo
  await sleep(600);
  const APRES = "Device B reprend la main";
  await B.evaluate(renomme(APRES));
  let vu = false;
  for (let i = 0; i < 12 && !vu; i++) { await sleep(1000); vu = String(db.store.row.data).indexOf(APRES) >= 0; }
  mesure("le verrou n'est pas un blocage : la modification SUIVANTE de Device B est publiée",
    vu, "ligne D1 = " + String(db.store.row.data).slice(0, 160));
  let recu = null;
  for (let i = 0; i < 10 && recu !== APRES; i++) { await sleep(1000); recu = await A.evaluate("window.__plan.plan.cells[0].name"); }
  mesure("et Device A la reçoit", recu === APRES, "Device A voit " + JSON.stringify(recu));
  await B.shot("2-apres");

  const errs = async (b: VerdictSonde) => b.evaluate(
    'JSON.stringify((JSON.parse(localStorage.getItem("plan-errors")||"[]")||[]).map(function(e){return e&&e.msg;}))');
  const ea = await errs(A), eb = await errs(B);
  mesure("aucune erreur JS journalisée", ea === "[]" && eb === "[]", "Device A=" + ea + " Device B=" + eb);
} catch (e) {
  process.stdout.write("ERREUR DE SCÉNARIO : " + (e && e.stack || e) + "\n");
  code = 1;
} finally {
  if (A) A.close();
  if (B) B.close();
  server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

const passed = results.filter((r) => r.pass).length;
if (AVANT) {
  process.stdout.write("\nMESURE terminée (mode --avant : aucun verdict, seulement des faits)\n");
  process.exit(code);
}
process.stdout.write("\n" + (passed === results.length && !code
  ? "OK " + passed + "/" + results.length
  : "FAILURES " + (results.length - passed) + "/" + results.length) + "\n");
process.exit(passed === results.length && !code ? 0 : 1);
