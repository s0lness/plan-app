#!/usr/bin/env node
// END-TO-END PROOF OF THE D1 FALLBACK, two real browsers, realtime DOWN.
//
// The REST fallback (functions/api/plan.ts + src/js/41-sync-rest.js) is the ONLY net when the
// realtime Worker does not respond. Its PUT used to refuse any walls-only state
// (`!Array.isArray(st.rooms)`): no modification crossed over, yet the chip announced
// "slow sync: sync deferred", and the two people diverged until
// reconnection overwrote one of them. This test replays the outage for real:
//
//   - a local HTTP server serves the application AND `/api/plan`, wired to the REAL Function
//     (functions/api/plan.ts) over an in-memory D1;
//   - it exposes NO `/ws`: the WebSocket fails, exactly like a downed Worker, so
//     both tabs fall back. `location.protocol` is http: so SYNC_ON is true
//     (under file://, sync is disabled and none of this exists);
//   - a household member renames a cell; the other, in another browser, must see it arrive;
//   - the sync chip must tell the truth on both sides.
//
// Run:   node tests/repli-d1-live.ts [path-to-app-html]
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

if (!fs.existsSync(APP_PATH)) { console.error("App file not found:", APP_PATH); process.exit(1); }
if (!fs.existsSync(CHROME)) { console.error("Chrome not found:", CHROME); process.exit(1); }

const APP_SRC = fs.readFileSync(APP_PATH, "utf8");
const REAL_PLAN = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "plan-rev177.json"), "utf8"));

// ---- server: the app, and /api/plan served by the REAL Pages Function -------------------------
// The database is a REAL SQLite (tests/fake-d1.ts): the PUT's compare-and-swap is arbitrated by the
// engine, not by a complacent simulation.
const db = fakeD1(null);
function pageHtml(email: string, blank: boolean) {
  // `blank` = NEW device: no localStorage, so the application starts on the default
  // apartment (420x360) and only learns the real plan by adopting it from the server.
  const seed = blank ? "" :
    `localStorage.setItem(${JSON.stringify(V4_KEY)}, ${JSON.stringify(JSON.stringify(REAL_PLAN))});`;
  return `<!doctype html><html><head><meta charset="utf-8"><script>
    window.__PLAN_TEST__ = 1;
    window.__WHO__ = ${JSON.stringify(email)};
    try { localStorage.clear(); ${seed} } catch(e){}
  </script></head><body>` + APP_SRC + `</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + req.headers.host);
  if (url.pathname === "/api/plan") {
    // The client has no control over this header (Access sets it): we set it here, as in prod.
    const email = url.searchParams.get("who") || req.headers["x-who"] || "a@example.com";
    let body = "";
    for await (const c of req) body += c;
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
    } catch (e) {
      res.writeHead(500); res.end(String(e)); return;
    }
    const text = await out.text();
    res.writeHead(out.status, { "Content-Type": out.headers.get("content-type") || "text/plain" });
    res.end(text);
    return;
  }
  // /a and /b: the same application, two "devices" (two distinct Chrome profiles).
  // /c: the other household member's phone, never opened before (or cleared of its cache).
  if (url.pathname === "/a" || url.pathname === "/b" || url.pathname === "/c") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageHtml(url.pathname === "/a" ? "a@example.com" : "b@example.com",
                     url.pathname === "/c"));
    return;
  }
  res.writeHead(404); res.end("not found");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const PORT = (server.address() as { port: number }).port;

// ---- a browser driven over CDP ---------------------------------------------------------------
async function openBrowser(label: string, pathname: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-repli-" + label + "-"));
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
    if (!port) await new Promise((r) => setTimeout(r, 50));
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
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}${pathname}` });
  for (let i = 0; i < 150; i++) {
    if (await evaluate("document.readyState") === "complete") break;
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 500));
  const shot = async (name: string) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    const f = path.join(os.tmpdir(), `repli-${label}-${name}.png`);
    fs.writeFileSync(f, Buffer.from(r.result.data, "base64"));
    return f;
  };
  return { label, evaluate, shot, close: () => { try { ws.close(); } catch (_) {} chrome.kill(); } };
}

// ---- assertions --------------------------------------------------------------------------------
const results: VerdictSonde[] = [];
function check(name: string, cond: VerdictSonde, detail: string) {
  results.push({ name, pass: !!cond, detail: detail || "" });
  process.stdout.write((cond ? "  ok   " : "  FAIL ") + name + "\n");
  if (!cond) process.stdout.write("       " + (detail || "") + "\n");
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jsErrors = (b: VerdictSonde) => b.evaluate('JSON.stringify((JSON.parse(localStorage.getItem("plan-errors")||"[]")||[]).map(function(e){return e&&e.msg;}))');

// ---- BARRIER: let a device that just arrived finish announcing itself --------------------
// A device that STARTS arms its push before having read the household's plan; the
// `bootReconciled` lock DELAYS it, it does not cancel it. So it republishes the state it just adopted,
// and the D1 row advances one more step, one to two seconds after it opens. As long as the
// neighbor has not RE-READ this revision, its next write is refused with 409, this is the
// intended behavior of gap #1, but it is not what this bench measures, and it made it
// fail one time out of two. So we wait for the row to go quiet, then for one full
// polling cycle (POLL_EVERY = 4 s) so the neighbor has adopted the current revision.
async function ligneCalme() {
  const rev = () => (db.store.row ? db.store.row.rev : 0);
  let last = rev(), stable = 0;
  for (let i = 0; i < 80 && stable < 1500; i++) {
    await sleep(250);
    const r = rev();
    if (r === last) stable += 250; else { last = r; stable = 0; }
  }
  await sleep(5000);   // one full polling round at the other devices
}

let A: VerdictSonde = null, B = null, C = null, code = 0;
try {
  // ---- 1. Device A opens the plan. NO /ws exists: realtime is down. -------------------
  A = await openBrowser("device-a", "/a");
  await sleep(2500);   // syncBoot (GET) + bootstrap of the shared plan (PUT)
  const a0 = JSON.parse(await A.evaluate(`JSON.stringify({
    syncOn: (function(){ try { return !document.getElementById("syncChip").hidden; } catch(e){ return false; } })(),
    wsLive: !!(window.__plan && window.__plan.state && false),
    chip: document.getElementById("syncChip").textContent,
    chipTitle: document.getElementById("syncChip").title,
    cells: window.__plan.plan.cells.length,
    firstCell: window.__plan.plan.cells[0].name
  })`));
  check("le temps réel est bien tombé et le repli D1 a pris la main (puce « sync lent »)",
    a0.syncOn === true && a0.chip === "slow sync",
    "puce=" + JSON.stringify(a0.chip) + " visible=" + a0.syncOn);
  check("le repli a AMORCÉ le plan partagé (l'ancien garde refusait ce PUT en 400)",
    db.store.row !== null && db.store.row.rev >= 1,
    "ligne D1 = " + JSON.stringify(db.store.row && { rev: db.store.row.rev, by: db.store.row.updated_by }));
  const seededRev = db.store.row ? db.store.row.rev : 0;
  await A.shot("1-device-a-boot");

  // ---- 2. Device B opens the plan on another device and adopts the shared state -------------------
  B = await openBrowser("device-b", "/b");
  await sleep(2500);
  const b0 = JSON.parse(await B.evaluate(`JSON.stringify({
    chip: document.getElementById("syncChip").textContent,
    cells: window.__plan.plan.cells.length,
    firstCell: window.__plan.plan.cells[0].name
  })`));
  check("le second appareil adopte le plan partagé au démarrage",
    b0.cells === a0.cells, "cellules " + b0.cells + " au lieu de " + a0.cells);
  check("sa puce dit elle aussi la vérité (« sync lent », pas « sync ✓ »)",
    b0.chip === "slow sync", "puce=" + JSON.stringify(b0.chip));

  // ---- 3. Device A renames a cell. The change MUST cross over. -----------------------------
  await ligneCalme();
  const revAvantRenom = db.store.row ? db.store.row.rev : 0;
  const NEW_NAME = "Repli D1 vivant";
  await A.evaluate(`(function(){
    var c = window.__plan.plan.cells[0];
    window.__plan.selectCell(c.id);
    var f = document.getElementById("rcName");
    f.value = ${JSON.stringify(NEW_NAME)};
    f.dispatchEvent(new Event("input", { bubbles: true }));   // the REAL rename path
  })()`);
  await sleep(2000);   // PUT debounce (1 s) + margin
  const putRev = db.store.row ? db.store.row.rev : 0;
  check("l'écriture de Device A atteint la base (le PUT est accepté)",
    putRev > revAvantRenom && String(db.store.row.data).indexOf(NEW_NAME) >= 0,
    "rev " + revAvantRenom + " -> " + putRev);
  await A.shot("2-device-a-renomme");

  // ---- 4. Device B sees it arrive (4 s polling) --------------------------------------------------
  let seen = null;
  for (let i = 0; i < 12 && seen !== NEW_NAME; i++) {
    await sleep(1000);
    seen = await B.evaluate(`window.__plan.plan.cells[0].name`);
  }
  check("le changement TRAVERSE jusqu'au second appareil, temps réel tombé",
    seen === NEW_NAME, "nom vu par Device B : " + JSON.stringify(seen) + " au lieu de " + JSON.stringify(NEW_NAME));
  const b1 = JSON.parse(await B.evaluate(`JSON.stringify({
    chip: document.getElementById("syncChip").textContent,
    title: document.getElementById("syncChip").title,
    label: (function(){ var n=[].slice.call(document.querySelectorAll("#canvas .v5layer .ov-name"))
              .map(function(e){ return e.textContent; }); return n; })()
  })`));
  check("le nom reçu est bien PEINT sur le plan de Device B",
    b1.label.indexOf(NEW_NAME) >= 0, "étiquettes = " + JSON.stringify(b1.label));
  check("la puce de Device B ne ment pas après réception",
    b1.chip === "slow sync" || /changed/.test(b1.chip), "puce=" + JSON.stringify(b1.chip));
  await B.shot("3-device-b-recoit");

  // ---- 5. Return trip: Device B renames in turn, Device A must receive it ----------------------------
  const BACK = "Vu par Device A";
  await B.evaluate(`(function(){
    var c = window.__plan.plan.cells[0];
    window.__plan.selectCell(c.id);
    var f = document.getElementById("rcName");
    f.value = ${JSON.stringify(BACK)};
    f.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  let back = null;
  for (let i = 0; i < 12 && back !== BACK; i++) {
    await sleep(1000);
    back = await A.evaluate(`window.__plan.plan.cells[0].name`);
  }
  check("le repli fonctionne dans les DEUX sens", back === BACK,
    "nom vu par Device A : " + JSON.stringify(back));
  await A.shot("4-device-a-recoit");

  // ---- 6. does the chip lie when the write itself fails? -----------------------------------
  // We break the PUT server-side (503): the read keeps passing. The chip must stop
  // announcing a deferred sync and say "not saved".
  const realPut = db.env.DB.prepare;
  let brokenPut = true;
  db.env.DB.prepare = ((sql) => {
    const st = realPut(sql);
    if (brokenPut && /INSERT INTO plans/.test(sql)) {
      return { bind() { return this; }, async run() { throw new Error("D1 down"); }, async first() { return null; } };
    }
    return st;
  }) as typeof db.env.DB.prepare;
  await A.evaluate(`(function(){
    var c = window.__plan.plan.cells[0];
    window.__plan.selectCell(c.id);
    var f = document.getElementById("rcName");
    f.value = "Perdu si personne ne le dit";
    f.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  // The chip's TEXT and its TITLE are read IN ONE GO, and the wait covers BOTH.
  // Reading them in two round trips let the chip flip between the two reads: `_writeChip`
  // (js/41) resets the title to the GENERIC one ("Changes kept locally...") for ANY "off" state,
  // and only going through `setSyncChip("unsaved")` then writes the specific title. A GET poll
  // landing under load would therefore repaint "offline" right after the text was read, and the case
  // would go red on a title that was no longer that of the measured state.
  const lirePuce = async () => JSON.parse(await A.evaluate(`JSON.stringify({
    texte: document.getElementById("syncChip").textContent,
    titre: document.getElementById("syncChip").title })`));
  const puceDit = (p: VerdictSonde) => p.texte === "not saved" && /could not be sent/.test(p.titre || "");
  let puce = { texte: null as VerdictSonde, titre: null as VerdictSonde };
  for (let i = 0; i < 60; i++) {
    puce = await lirePuce();
    if (puceDit(puce)) break;
    await sleep(500);
  }
  check("écriture cassée, lecture saine : la puce le DIT au lieu d'annoncer « sync lent »",
    puce.texte === "not saved",
    "puce=" + JSON.stringify(puce.texte) + " (le sondage GET, lui, réussit toutes les 4 s)");
  check("la puce explique quoi en penser", /could not be sent/.test(puce.titre || ""),
    "title=" + JSON.stringify(puce.titre) + " · lu dans le MÊME instantané que le texte "
      + JSON.stringify(puce.texte));
  await A.shot("5-non-enregistre");

  // ---- 7. the database comes back: the chip must recover on its own -------------------------------
  // The assertion requires TWO things, so the wait covers BOTH. The two do not happen
  // at the same moment: the chip recovers on a GET poll, the resending of the modification waits for the
  // next PUT. Waiting on the chip alone evaluated the second half too early and, under load, this case
  // went red on "does the row contain the modification? false" even though it would pass on its own shortly after.
  brokenPut = false;
  const MODIF_RENVOYEE = "Perdu si personne ne le dit";
  const modifDansLaLigne = () =>
    !!db.store.row && String(db.store.row.data).indexOf(MODIF_RENVOYEE) >= 0;
  let chipBack = null, repartie = false;
  for (let i = 0; i < 60 && !(chipBack === "slow sync" && repartie); i++) {
    await sleep(500);
    chipBack = await A.evaluate(`document.getElementById("syncChip").textContent`);
    repartie = modifDansLaLigne();
  }
  check("la base revenue, la puce repasse à « sync lent » (et la modif repart)",
    chipBack === "slow sync" && repartie,
    "après 30 s d'attente des DEUX conditions : puce=" + JSON.stringify(chipBack)
      + (chipBack === "slow sync" ? " (rétablie)" : " (PAS rétablie)")
      + " · la modification est-elle repartie dans la ligne D1 ? " + repartie);

  // ---- 8. A PERSONAL SETTING DOES NOT CROSS OVER, EITHER WAY -------------------------------
  // Device A unchecks "Lighting" to see clearly. This is not a modification of the plan: it must
  // neither go into the D1 row, nor turn off Device B's fixtures. The D1 fallback is the ONLY
  // path here (no /ws), it's exactly the one settings used to travel through.
  await A.evaluate(`window.__plan.setLayer("light", false)`);
  const CROSS = "Cellule apres reglage";
  await A.evaluate(`(function(){
    var c = window.__plan.plan.cells[0];
    window.__plan.selectCell(c.id);
    var f = document.getElementById("rcName");
    f.value = ${JSON.stringify(CROSS)};
    f.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  let crossed = null;
  for (let i = 0; i < 12 && crossed !== CROSS; i++) {
    await sleep(1000);
    crossed = await B.evaluate(`window.__plan.plan.cells[0].name`);
  }
  check("le PLAN traverse toujours (témoin du cas suivant)", crossed === CROSS,
    "nom vu par Device B : " + JSON.stringify(crossed));
  const rowText = String(db.store.row.data);
  check("la ligne du plan partagé ne contient AUCUN réglage personnel",
    rowText.indexOf("layLight") < 0 && rowText.indexOf("collapsedCats") < 0
      && JSON.parse(rowText).opts === undefined,
    "la ligne D1 porte encore des options : " + rowText.slice(0, 200));
  const bLight = await B.evaluate(`JSON.stringify({
    opt: window.__plan.opts().layLight, box: document.getElementById("optLayLight").checked })`);
  check("les luminaires de Device B restent allumés (le réglage de Device A ne traverse pas)",
    JSON.parse(bLight).opt !== false && JSON.parse(bLight).box === true, "Device B : " + bLight);
  const aLight = await A.evaluate(`JSON.stringify({ opt: window.__plan.opts().layLight })`);
  check("et Device A, lui, garde bien SON réglage", JSON.parse(aLight).opt === false, "Device A : " + aLight);

  // reverse direction: Device B turns off labels, Device A must see nothing change.
  await B.evaluate(`(function(){ var el=document.getElementById("optLabels");
    el.checked=false; el.dispatchEvent(new Event("change",{bubbles:true})); })()`);
  const BACK2 = "Cellule apres reglage de Device B";
  await B.evaluate(`(function(){
    var c = window.__plan.plan.cells[0];
    window.__plan.selectCell(c.id);
    var f = document.getElementById("rcName");
    f.value = ${JSON.stringify(BACK2)};
    f.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  let back2 = null;
  for (let i = 0; i < 12 && back2 !== BACK2; i++) {
    await sleep(1000);
    back2 = await A.evaluate(`window.__plan.plan.cells[0].name`);
  }
  const aLabels = await A.evaluate(`JSON.stringify({ opt: window.__plan.opts().labels,
    box: document.getElementById("optLabels").checked })`);
  check("dans l'autre sens non plus : les étiquettes de Device A restent affichées",
    back2 === BACK2 && JSON.parse(aLabels).opt !== false && JSON.parse(aLabels).box === true,
    "plan reçu ? " + (back2 === BACK2) + " Device A : " + aLabels);

  // ---- 9. DEVICE B'S NEW PHONE: the view is reframed on the adopted plan -------------------
  // Without reframing, the apartment (far bigger than the default 420x360) arrives at the
  // default scale, overflows the viewport, and you have to go looking for "Fit".
  C = await openBrowser("neuf", "/c");
  await sleep(3000);   // syncBoot (GET) + adoption
  const c0 = JSON.parse(await C.evaluate(`JSON.stringify({
    cells: window.__plan.plan.cells.length,
    bbox: window.__plan.aptBBox(),
    fits: window.__plan.viewFits(),
    view: window.__plan.viewTransform() })`));
  check("l'appareil neuf adopte bien le plan du foyer", c0.cells > 1,
    "cellules = " + c0.cells);
  check("et la vue est RECADRÉE dessus : le plan tient dans l'écran",
    c0.fits.fits === true,
    "plan " + Math.round(c0.bbox.w) + "x" + Math.round(c0.bbox.l) + " cm, débordement = "
      + JSON.stringify(c0.fits));
  await C.shot("6-appareil-neuf");

  // a LATER adoption must not touch the view again: Device B pans its own, Device A edits.
  await ligneCalme();   // the new phone also republishes what it just adopted
  const cPanned = JSON.parse(await C.evaluate(`JSON.stringify(window.__plan.panBy(-150, 80))`));
  const LATER = "Modif pendant qu on travaille";
  await A.evaluate(`(function(){
    var c = window.__plan.plan.cells[0];
    window.__plan.selectCell(c.id);
    var f = document.getElementById("rcName");
    f.value = ${JSON.stringify(LATER)};
    f.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  let cSeen = null;
  for (let i = 0; i < 12 && cSeen !== LATER; i++) {
    await sleep(1000);
    cSeen = await C.evaluate(`window.__plan.plan.cells[0].name`);
  }
  const cAfter = JSON.parse(await C.evaluate(`JSON.stringify(window.__plan.viewTransform())`));
  check("une adoption ULTÉRIEURE ne fait pas sauter la vue de qui travaille",
    cSeen === LATER && cAfter.scale === cPanned.scale && cAfter.ox === cPanned.ox
      && cAfter.oy === cPanned.oy,
    "adoption reçue ? " + (cSeen === LATER) + " vue " + JSON.stringify(cPanned) + " -> "
      + JSON.stringify(cAfter));

  // ---- 10. no JS error on either side -------------------------------------------------
  const ea = await jsErrors(A), eb = await jsErrors(B), ec = await jsErrors(C);
  check("aucune erreur JS journalisée", ea === "[]" && eb === "[]" && ec === "[]",
    "Device A=" + ea + " Device B=" + eb + " neuf=" + ec);
} catch (e) {
  process.stdout.write("ERREUR DE SCÉNARIO : " + (e && e.stack || e) + "\n");
  code = 1;
} finally {
  if (A) A.close();
  if (B) B.close();
  if (C) C.close();
  server.close();
}

const passed = results.filter((r) => r.pass).length;
process.stdout.write("\n" + (passed === results.length && !code
  ? "OK " + passed + "/" + results.length
  : "FAILURES " + (results.length - passed) + "/" + results.length) + "\n");
process.exit(passed === results.length && !code ? 0 : 1);
