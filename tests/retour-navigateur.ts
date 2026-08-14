#!/usr/bin/env node
// THE FEEDBACK BUTTON, IN A REAL BROWSER, ON BOTH DOORS.
//
// Same rig style as tests/partage-navigateur.ts (a local HTTP server forwarding to the REAL Pages
// Functions over an in-memory D1, tests/fake-d1.ts) and tests/porte-invitee.ts (the guest door
// scenario, `#k=` redemption). Two separate local servers, one per door, so `porteDe()` sees a
// consistent `Host` on every request without threading per-tab state through one dispatcher.
//
// Proves:
//   1. On the household door: clicking Feedback opens the dialog, typing and Send actually reach
//      the server (counted server-side, not just read off the screen), and the dialog closes.
//   2. On the guest door: the same round trip works, and the row is attributed to the door
//      ("invite") and the guest's already-known name, never an email.
//   3. THE ONE THING THIS FEATURE MUST NEVER DO: on a failing request, the typed text stays in
//      the field (never cleared), and the dialog stays open so the person can retry or copy it.
//
// Run:   node tests/retour-navigateur.ts [path-to-app-html]
// Exit:  0 if everything passes, 1 otherwise.

import type { VerdictSonde } from "./_types.ts";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { onRequestPost as retour } from "../functions/api/feedback.ts";
import { onRequestGet as planGet } from "../functions/api/plan.ts";
import { onRequestPost as invitePost } from "../functions/api/invite.ts";
import { fakeD1 } from "./fake-d1.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const APP_PATH = process.argv[2] || path.join(__dirname, "..", "index.html");
const HOTE_MENAGE = "menage.example.com";
const HOTE_INVITE = "share.example.com";

// A marker text, never a real report: the household server treats it specially (500, without
// ever calling the real route) so the "preserved on failure" case is exercised against the SAME
// dialog and the SAME send path a real network hiccup would take, without needing to fake the
// network itself.
const TEXTE_FORCE_ECHEC = "__FORCER_ECHEC_TEST__ le mur ne se redimensionne pas";

if (!fs.existsSync(APP_PATH)) { console.error("App file not found:", APP_PATH); process.exit(1); }
if (!fs.existsSync(CHROME)) { console.error("Chrome not found:", CHROME); process.exit(1); }

const APP_SRC = fs.readFileSync(APP_PATH, "utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: VerdictSonde[] = [];
function check(name: string, cond: VerdictSonde, detail?: string) {
  results.push({ name, pass: !!cond });
  process.stdout.write((cond ? "  ok   " : "  FAIL ") + name + "\n");
  if (!cond) process.stdout.write("       " + (detail || "") + "\n");
}
async function attendre(cond: () => Promise<boolean>, ms = 8000, pas = 100): Promise<boolean> {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (await cond()) return true; await sleep(pas); }
  return false;
}

// ---- a browser driven over CDP (verbatim rig from tests/partage-navigateur.ts) -----------------
async function openBrowser(label: string, url: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retour-nav-" + label + "-"));
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
  // `?? null` PARCE QU'UN ELEMENT ABSENT VAUT `undefined`, ET QUE `JSON.stringify(undefined)` REND
  // LA CHAINE "undefined", QUE `JSON.parse` REFUSE. Les lectures de cette suite sont gardees
  // (`(document.getElementById("x")||{}).hidden`) pour ne pas lever pendant une navigation ; sans
  // ce `?? null` la garde ne fait que deplacer la panne, d'une exception dans la page a une
  // exception ici. Une valeur absente doit arriver comme `null`, pas faire tomber le scenario.
  const J = async (expr: string) => JSON.parse(await evaluate(`JSON.stringify((${expr}) ?? null)`));
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
  //  RIG A: the HOUSEHOLD door. `/api/plan` (boot) and `/api/feedback` (the point of this suite).
  // ============================================================================================
  const { db: dbA, env: envBaseA } = fakeD1(null);
  const envA = { ...envBaseA, HOUSEHOLD_HOSTS: HOTE_MENAGE, GUEST_HOST: HOTE_INVITE };
  const now = new Date().toISOString();
  dbA.prepare("INSERT INTO plans(id,data,rev,updated_at,updated_by,name) VALUES(?1,?2,1,?3,?4,?5)")
    .run("main", JSON.stringify(null), now, "sylve@example.com", "Chez nous");

  let feedbackPostCount = 0;
  const feedbackLog: VerdictSonde[] = [];

  const serverA = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://" + req.headers.host);
    let body = "";
    for await (const c of req) body += c;
    const requete = new Request("https://" + HOTE_MENAGE + url.pathname + url.search, {
      method: req.method,
      headers: { "content-type": "application/json", "Host": HOTE_MENAGE, ...(req.headers.cookie ? { Cookie: String(req.headers.cookie) } : {}) },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    let out: Response | null = null;
    try {
      if (url.pathname === "/api/plan" && req.method === "GET") {
        out = await planGet({ request: requete, env: envA } as unknown as Parameters<typeof planGet>[0]);
      } else if (url.pathname === "/api/feedback" && req.method === "POST") {
        feedbackPostCount++;
        // THE FORCED FAILURE: recognized by content, never by a header the app wouldn't send. The
        // real route (functions/api/feedback.ts) is deliberately NOT called for this one body, so
        // this proves the CLIENT's own failure handling, not a coincidence of server validation.
        let vu: DonneeDynamiqueLocale = {};
        try { vu = JSON.parse(body); } catch {}
        feedbackLog.push({ texte: vu.texte, contact: vu.contact });
        if (vu.texte === TEXTE_FORCE_ECHEC) { res.writeHead(500); res.end("forced failure (test)"); return; }
        out = await retour({ request: requete, env: envA } as unknown as Parameters<typeof retour>[0]);
      } else if (url.pathname === "/" || url.pathname === "/revisite") {
        const efface = url.pathname === "/" ? "try { localStorage.clear(); } catch(e){}" : "";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><head><meta charset="utf-8"><script>
          window.__PLAN_TEST__ = 1;
          ${efface}
        </script></head><body>` + APP_SRC + `</body></html>`);
        return;
      } else {
        res.writeHead(404); res.end("not found"); return;
      }
    } catch (e) { res.writeHead(500); res.end(String(e)); return; }
    const text = await out.text();
    res.writeHead(out.status, { "Content-Type": out.headers.get("content-type") || "text/plain" });
    res.end(text);
  });
  await new Promise<void>((resolve) => serverA.listen(0, "127.0.0.1", () => resolve()));
  const PORT_A = (serverA.address() as { port: number }).port;
  const URL_A = (p: string) => `http://127.0.0.1:${PORT_A}${p}`;

  // ============================================================================================
  //  1. HOUSEHOLD DOOR: open, type, Send — the server actually receives the row.
  // ============================================================================================
  const A = await openBrowser("menage", URL_A("/"));
  opened.push(A);
  const bootA = await attendre(async () => (await A.evaluate(`typeof window.__plan`)) === "object");
  check("le planificateur démarre sur la porte du foyer", bootA,
    "vu typeof window.__plan = " + await A.evaluate(`typeof window.__plan`));

  const btnVisible = await A.J(`(function(){var b=document.getElementById("btnFeedback");return {present:!!b,hidden:b&&b.hidden};})()`);
  check("le bouton Feedback existe et n'est PAS caché sur la porte du foyer",
    btnVisible.present && btnVisible.hidden === false, "vu " + JSON.stringify(btnVisible));

  await A.evaluate(`document.getElementById("btnFeedback").click()`);
  const dlgOuvert = await attendre(async () => (await A.evaluate(`(document.getElementById("retourDlg")||{}).hidden`)) === false);
  check("cliquer Feedback ouvre le panneau", dlgOuvert,
    "vu hidden=" + await A.evaluate(`(document.getElementById("retourDlg")||{}).hidden`));

  const TEXTE_REEL = "Le mur ne revient pas à sa place après un glisser.";
  await A.evaluate(`(function(){
    var t = document.getElementById("retourText"); t.value = ${JSON.stringify(TEXTE_REEL)};
    var c = document.getElementById("retourContact"); c.value = "marie@example.com";
  })()`);
  await A.evaluate(`document.getElementById("retourSend").click()`);
  const envoye = await attendre(async () => feedbackPostCount >= 1);
  check("le serveur a bien reçu le POST /api/feedback (pas seulement l'écran qui change)",
    envoye, feedbackPostCount + " POST(s) reçu(s)");
  check("le corps envoyé porte le texte tapé", feedbackLog[0] && feedbackLog[0].texte === TEXTE_REEL,
    "vu " + JSON.stringify(feedbackLog[0]));

  const ligneServeur = dbA.prepare("SELECT * FROM feedback ORDER BY id DESC LIMIT 1").get() as DonneeDynamiqueLocale;
  check("la ligne écrite en base porte le bon texte, la bonne porte et le bon plan",
    ligneServeur && ligneServeur.texte === TEXTE_REEL && ligneServeur.porte === "foyer" && ligneServeur.plan_id === "main",
    "vu " + JSON.stringify(ligneServeur));

  const dlgFerme = await attendre(async () => (await A.evaluate(`(document.getElementById("retourDlg")||{}).hidden`)) === true, 3000);
  check("le panneau se referme après un envoi réussi", dlgFerme,
    "vu hidden=" + await A.evaluate(`(document.getElementById("retourDlg")||{}).hidden`));

  const errsA = await A.evaluate(`JSON.stringify((JSON.parse(localStorage.getItem("plan-errors")||"[]")||[]).map(function(e){return e&&e.msg;}))`);
  check("aucune erreur JS pendant tout le scénario", errsA === "[]", "vu " + errsA);

  // ============================================================================================
  //  2. THE ONE THING THIS FEATURE MUST NEVER DO: on a failing request, the text SURVIVES.
  // ============================================================================================
  await A.evaluate(`document.getElementById("btnFeedback").click()`);
  await attendre(async () => (await A.evaluate(`(document.getElementById("retourDlg")||{}).hidden`)) === false);
  await A.evaluate(`(function(){ (document.getElementById("retourText")||{}).value = ${JSON.stringify(TEXTE_FORCE_ECHEC)}; })()`);
  const avantEnvoi = feedbackPostCount;
  await A.evaluate(`document.getElementById("retourSend").click()`);
  const echecVu = await attendre(async () => feedbackPostCount > avantEnvoi);
  check("le serveur a bien reçu la tentative qui va échouer", echecVu, feedbackPostCount + " POST(s)");

  const hintErreur = await attendre(async () => {
    const t = await A.evaluate(`(document.getElementById("retourHint")||{}).textContent`);
    return typeof t === "string" && t.length > 0 && t !== "Sending…";
  });
  const texteHint = await A.evaluate(`(document.getElementById("retourHint")||{}).textContent`);
  check("un envoi qui échoue affiche un message, jamais le silence", hintErreur, "vu " + JSON.stringify(texteHint));

  const texteEncoreLa = await A.evaluate(`(document.getElementById("retourText")||{}).value`);
  check("LE TEXTE TAPÉ EST TOUJOURS DANS LE CHAMP APRÈS UN ÉCHEC (rien n'est jamais perdu)",
    texteEncoreLa === TEXTE_FORCE_ECHEC, "vu " + JSON.stringify(texteEncoreLa));
  const dlgResteOuvert = await A.evaluate(`(document.getElementById("retourDlg")||{}).hidden`);
  check("le panneau reste ouvert après un échec (pas de fermeture qui ferait croire que c'est parti)",
    dlgResteOuvert === false, "vu hidden=" + dlgResteOuvert);

  const compteApresEchec = (dbA.prepare("SELECT COUNT(*) AS n FROM feedback").get() as DonneeDynamiqueLocale).n;
  check("la tentative forcée en échec n'a écrit AUCUNE ligne côté serveur",
    compteApresEchec === 1, "vu " + compteApresEchec + " ligne(s) en base");

  // ============================================================================================
  //  RIG B: the GUEST door. Redeem a link and go through the name step (design edge 20, corrected
  //  2026-08-14: a name known for the TOKEN no longer skips the step for a DIFFERENT device — this
  //  browser has never named itself before, so it must be asked, same as any real first visit),
  //  then the same round trip: the row must be attributed to "invite" and to the guest's OWN name,
  //  never an email.
  // ============================================================================================
  const { db: dbB, env: envBaseB } = fakeD1(null);
  const envB = { ...envBaseB, HOUSEHOLD_HOSTS: HOTE_MENAGE, GUEST_HOST: HOTE_INVITE };
  dbB.prepare("INSERT INTO plans(id,data,rev,updated_at,updated_by,name) VALUES(?1,?2,1,?3,?4,?5)")
    .run("appartement", JSON.stringify({ outline: [], walls: [], openings: [], pieces: [], cells: [] }),
      now, "sylve@example.com", "Chez nous");
  const jeton = (etiquette: string) => (etiquette + "-".repeat(22)).slice(0, 22);
  const dansTrenteJours = new Date(Date.now() + 30 * 86_400_000).toISOString();
  dbB.prepare(
    "INSERT INTO invites(token,plan_id,role,created_at,created_by,expires_at,revoked,uses,last_used_at,last_name,last_guest_id) " +
    "VALUES(?1,'appartement','edit',?2,'sylve@example.com',?3,0,0,NULL,NULL,NULL)"
  ).run(jeton("nomme1"), now, dansTrenteJours);

  let feedbackPostCountB = 0;
  const serverB = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://" + req.headers.host);
    let body = "";
    for await (const c of req) body += c;
    const requete = new Request("https://" + HOTE_INVITE + url.pathname + url.search, {
      method: req.method,
      headers: { "content-type": "application/json", "Host": HOTE_INVITE, ...(req.headers.cookie ? { Cookie: String(req.headers.cookie) } : {}) },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    let out: Response | null = null;
    try {
      if (url.pathname === "/api/invite" && req.method === "POST") {
        out = await invitePost({ request: requete, env: envB } as unknown as Parameters<typeof invitePost>[0]);
      } else if (url.pathname === "/api/plan" && req.method === "GET") {
        out = await planGet({ request: requete, env: envB } as unknown as Parameters<typeof planGet>[0]);
      } else if (url.pathname === "/api/feedback" && req.method === "POST") {
        feedbackPostCountB++;
        out = await retour({ request: requete, env: envB } as unknown as Parameters<typeof retour>[0]);
      } else if (url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><head><meta charset="utf-8"><script>
          window.__PLAN_TEST__ = 1;
          try { localStorage.clear(); } catch(e){}
        </script></head><body>` + APP_SRC + `</body></html>`);
        return;
      } else {
        res.writeHead(404); res.end("not found"); return;
      }
    } catch (e) { res.writeHead(500); res.end(String(e)); return; }
    const text = await out.text();
    const headers: Record<string, string> = { "Content-Type": out.headers.get("content-type") || "text/plain" };
    const setCookie = out.headers.get("set-cookie");
    if (setCookie) headers["Set-Cookie"] = setCookie;
    res.writeHead(out.status, headers);
    res.end(text);
  });
  await new Promise<void>((resolve) => serverB.listen(0, "127.0.0.1", () => resolve()));
  const PORT_B = (serverB.address() as { port: number }).port;
  const URL_B = (p: string) => `http://127.0.0.1:${PORT_B}${p}`;

  const B = await openBrowser("invite", URL_B("/#k=" + jeton("nomme1")));
  opened.push(B);
  const dlgNomOuvert = await attendre(async () => (await B.evaluate(`(document.getElementById("inviteNameDlg")||{}).hidden`)) === false);
  check("un appareil qui n'a jamais choisi de nom voit l'étape du nom", dlgNomOuvert);
  await B.evaluate(`(function(){
    var i = document.getElementById("inviteNameInput");
    i.value = "Marie"; i.dispatchEvent(new Event("input", {bubbles:true}));
  })()`);
  await attendre(async () => (await B.evaluate(`(document.getElementById("inviteNameJoin")||{}).disabled`)) === false);
  await B.evaluate(`document.getElementById("inviteNameJoin").click()`);
  const bootB = await attendre(async () => (await B.evaluate(`typeof window.__plan`)) === "object");
  check("le planificateur démarre sur la porte invité une fois le nom choisi", bootB,
    "vu typeof window.__plan = " + await B.evaluate(`typeof window.__plan`));

  const btnVisibleB = await B.J(`(function(){var b=document.getElementById("btnFeedback");return {present:!!b,hidden:b&&b.hidden};})()`);
  check("le bouton Feedback est AUSSI visible côté invité", btnVisibleB.present && btnVisibleB.hidden === false,
    "vu " + JSON.stringify(btnVisibleB));

  await B.evaluate(`document.getElementById("btnFeedback").click()`);
  await attendre(async () => (await B.evaluate(`(document.getElementById("retourDlg")||{}).hidden`)) === false);
  const TEXTE_INVITE = "La fenêtre de la cuisine ne s'ouvre pas dans le bon sens.";
  await B.evaluate(`(function(){ (document.getElementById("retourText")||{}).value = ${JSON.stringify(TEXTE_INVITE)}; })()`);
  await B.evaluate(`document.getElementById("retourSend").click()`);
  const envoyeB = await attendre(async () => feedbackPostCountB >= 1);
  check("le serveur a reçu le POST /api/feedback côté invité", envoyeB, feedbackPostCountB + " POST(s)");

  const ligneServeurB = dbB.prepare("SELECT * FROM feedback ORDER BY id DESC LIMIT 1").get() as DonneeDynamiqueLocale;
  check("la ligne invité porte porte='invite', le bon plan, et le nom (jamais un e-mail)",
    ligneServeurB && ligneServeurB.porte === "invite" && ligneServeurB.plan_id === "appartement" &&
    ligneServeurB.who === "Marie" && !String(ligneServeurB.who).includes("@"),
    "vu " + JSON.stringify(ligneServeurB));

  const errsB = await B.evaluate(`JSON.stringify((JSON.parse(localStorage.getItem("plan-errors")||"[]")||[]).map(function(e){return e&&e.msg;}))`);
  check("aucune erreur JS côté invité", errsB === "[]", "vu " + errsB);

  serverA.close();
  serverB.close();
} catch (e) {
  process.stdout.write("ERREUR DE SCÉNARIO : " + (e && (e as Error).stack || e) + "\n");
  code = 1;
} finally {
  opened.forEach((b) => b.close());
}

interface DonneeDynamiqueLocale { [k: string]: unknown }

const passed = results.filter((r) => r.pass).length;
process.stdout.write("\n" + (passed === results.length && !code
  ? "OK " + passed + "/" + results.length
  : "FAILURES " + (results.length - passed) + "/" + results.length) + "\n");
process.exit(passed === results.length && !code ? 0 : 1);
