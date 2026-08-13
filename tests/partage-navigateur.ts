#!/usr/bin/env node
// THE SHARE BUTTON, IN A REAL BROWSER, ON THE HOUSEHOLD DOOR.
//
// Reported: "the share button doesn't work." Reproduced: a tab in local-only mode hit
// `if (!SYNC_ON || !estMenage()) return;` in `ouvrirPartage()` (src/ts/panneaux/partage.ts) and
// returned SILENTLY — no panel, no message, no error, nothing on screen to explain why nothing
// happened. `tests/partage-fil.ts` only ever exercised the panel's PURE functions; nothing in the
// suite ever actually clicked Share in a browser, which is exactly how this shipped.
//
// This suite closes that hole, against the SAME kind of rig `tests/porte-invitee.ts` uses (a local
// HTTP server forwarding to the REAL Pages Functions over an in-memory D1, `tests/fake-d1.ts`), but
// on the HOUSEHOLD door this time, not the guest one: `Host` is forced to a hostname that IS in
// `HOUSEHOLD_HOSTS`, so `porteDe()` returns `"foyer"` and `estMenage()` is true.
//
// Proves:
//   1. On the household door, clicking a plan row's "Share" button opens the dialog, "Create a
//      link" produces a real link, and the server actually received the `POST /api/invites`.
//   2. `plan-porte-locale` (written when a tab discovers the guest door with no invitation, see
//      `src/ts/fil/invite.ts`) is a GUESS, not a life sentence: seeded before load, it survives
//      long enough to freeze THIS tab's mode as local-only (by design — a mode never reverts mid-
//      tab), but a boot read that SUCCEEDS proves the origin does serve a household plan, and
//      clears the flag for the NEXT visit. Reloading (keeping storage, like `porte-invitee.ts`'s
//      `/revisite`) lands on the household door normally: the Invite button is back, Share works.
//   3. On that SAME local-only tab, before the reload, clicking Share is not silent: a toast names
//      the reason ("this tab is not connected to the household plan"), and the dialog stays shut.
//
// Run:   node tests/partage-navigateur.ts [path-to-app-html]
// Exit:  0 if everything passes, 1 otherwise.

import type { VerdictSonde } from "./_types.ts";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { onRequestGet as invitesGet, onRequestPost as invitesPost, onRequestDelete as invitesDelete } from "../functions/api/invites.ts";
import { onRequestGet as planGet, onRequestPut as planPut } from "../functions/api/plan.ts";
import { onRequestGet as plansGet } from "../functions/api/plans.ts";
import { fakeD1 } from "./fake-d1.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const APP_PATH = process.argv[2] || path.join(__dirname, "..", "index.html");
const HOTE_MENAGE = "menage.example.com";
const HOTE_INVITE = "share.example.com";   // GUEST_HOST: never served here, only reflected in guestHost()
const HOUSEHOLD_HOSTS_ENV = { HOUSEHOLD_HOSTS: HOTE_MENAGE, GUEST_HOST: HOTE_INVITE };
// The suite always serves over real http(s) (`SYNC_ON` true), so it can only reach `ouvrirPartage`'s
// SECOND silent-return reason (`!estMenage()`); the first (`!SYNC_ON`, file:// / the embedded
// artifact) is covered by reading the source, not a browser here — there is no `SYNC_ON`-false
// door this rig can serve.
const MSG_PAS_MENAGE = "This tab is not connected to the household plan: there is nothing to share from here.";

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

// ---- a browser driven over CDP (verbatim rig from tests/porte-invitee.ts) ----------------------
async function openBrowser(label: string, url: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "partage-nav-" + label + "-"));
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
  //  RIG: the REAL invite(s) + plan Functions, over an in-memory D1, on the HOUSEHOLD door.
  // ============================================================================================
  const { db, env: envBase } = fakeD1(null);
  const env = { ...envBase, ...HOUSEHOLD_HOSTS_ENV };
  const now = new Date().toISOString();

  // A fresh-but-named household plan: not yet drawn (`data` null, exactly what a household that
  // completed plan creation but hasn't opened the wizard would have), but a real row, because
  // `POST /api/invites` requires `SELECT 1 FROM plans WHERE id=?1` to find one.
  db.prepare("INSERT INTO plans(id,data,rev,updated_at,updated_by,name) VALUES(?1,?2,1,?3,?4,?5)")
    .run("main", JSON.stringify(null), now, "sylve@example.com", "Chez nous");

  let inviteCreateCount = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://" + req.headers.host);
    let body = "";
    for await (const c of req) body += c;
    // THE HOST IS ALWAYS FORCED TO THE HOUSEHOLD HOSTNAME, whatever the browser actually sent
    // (127.0.0.1:PORT): this suite tests one door only, exactly like `porte-invitee.ts` always
    // forces the guest hostname for the door it tests.
    const requete = new Request("https://" + HOTE_MENAGE + url.pathname + url.search, {
      method: req.method,
      headers: { "content-type": "application/json", "Host": HOTE_MENAGE, ...(req.headers.cookie ? { Cookie: String(req.headers.cookie) } : {}) },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    let out: Response | null = null;
    try {
      if (url.pathname === "/api/invites" && req.method === "GET") {
        out = await invitesGet({ request: requete, env } as unknown as Parameters<typeof invitesGet>[0]);
      } else if (url.pathname === "/api/invites" && req.method === "POST") {
        inviteCreateCount++;
        out = await invitesPost({ request: requete, env } as unknown as Parameters<typeof invitesPost>[0]);
      } else if (url.pathname === "/api/invites" && req.method === "DELETE") {
        out = await invitesDelete({ request: requete, env } as unknown as Parameters<typeof invitesDelete>[0]);
      } else if (url.pathname === "/api/plan" && req.method === "GET") {
        out = await planGet({ request: requete, env } as unknown as Parameters<typeof planGet>[0]);
      } else if (url.pathname === "/api/plan" && req.method === "PUT") {
        out = await planPut({ request: requete, env } as unknown as Parameters<typeof planPut>[0]);
      } else if (url.pathname === "/api/plans" && req.method === "GET") {
        out = await plansGet({ request: requete, env } as unknown as Parameters<typeof plansGet>[0]);
      } else if (url.pathname === "/" || url.pathname === "/porte-locale" || url.pathname === "/revisite") {
        // `/` REPART D'UN STOCKAGE VIDE. `/porte-locale` efface PUIS sème le drapeau AVANT que
        // l'appli ne démarre, pour rejouer « une visite précédente a découvert la porte invitée ».
        // `/revisite` GARDE le stockage tel quel : la seule façon de rejouer une visite SUIVANTE
        // sur la même origine (même schéma que `tests/porte-invitee.ts`).
        const efface = url.pathname === "/revisite" ? "" : "try { localStorage.clear(); } catch(e){}";
        const seme = url.pathname === "/porte-locale"
          ? "try { localStorage.setItem('plan-porte-locale','1'); } catch(e){}" : "";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><head><meta charset="utf-8"><script>
          window.__PLAN_TEST__ = 1;
          ${efface}
          ${seme}
        </script></head><body>` + APP_SRC + `</body></html>`);
        return;
      } else {
        res.writeHead(404); res.end("not found"); return;
      }
    } catch (e) { res.writeHead(500); res.end(String(e)); return; }
    const text = await out.text();
    const headers: Record<string, string> = { "Content-Type": out.headers.get("content-type") || "text/plain" };
    res.writeHead(out.status, headers);
    res.end(text);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const PORT = (server.address() as { port: number }).port;
  const URL_OF = (p: string) => `http://127.0.0.1:${PORT}${p}`;

  // ============================================================================================
  //  1. ON THE HOUSEHOLD DOOR, SHARE WORKS: dialog opens, a link is created, the server sees it.
  //     This is the case that would have caught the report: nothing here ever exercised a real
  //     click before.
  // ============================================================================================
  const A = await openBrowser("menage", URL_OF("/"));
  opened.push(A);
  const booteA = await attendre(async () => (await A.evaluate(`typeof window.__plan`)) === "object");
  check("le planificateur démarre sur la porte du foyer", booteA,
    "vu typeof window.__plan = " + await A.evaluate(`typeof window.__plan`));

  await A.evaluate(`document.getElementById("btnPlans").click()`);
  const listeChargee = await attendre(async () => (await A.evaluate(`!!document.querySelector(".pshare")`)) === true);
  check("le panneau Plans liste le plan « main » avec son bouton Share", listeChargee,
    "vu " + await A.evaluate(`document.getElementById("plansList").innerHTML.slice(0,200)`));

  await A.evaluate(`document.querySelector('.pshare[data-id="main"]').click()`);
  const dlgOuvert = await attendre(async () => (await A.evaluate(`(document.getElementById("shareDlg")||{}).hidden`)) === false);
  check("cliquer Share ouvre le panneau de partage", dlgOuvert,
    "vu hidden=" + await A.evaluate(`(document.getElementById("shareDlg")||{}).hidden`));

  await A.evaluate(`document.getElementById("shareCreate").click()`);
  const lienCree = await attendre(async () => {
    const v = await A.evaluate(`(document.getElementById("shareNewLink")||{}).value`);
    return typeof v === "string" && v.length > 0;
  });
  const lienVu = await A.evaluate(`(document.getElementById("shareNewLink")||{}).value`);
  check("« Create a link » produit un lien affiché, déjà sélectionné", lienCree, "vu " + JSON.stringify(lienVu));
  check("le lien porte le GUEST_HOST configuré", typeof lienVu === "string" && lienVu.indexOf("https://" + HOTE_INVITE + "/#k=") === 0,
    "vu " + JSON.stringify(lienVu));
  check("le serveur a bien reçu le POST /api/invites (pas seulement l'écran qui change)",
    inviteCreateCount === 1, inviteCreateCount + " POST(s) reçu(s)");

  const errsA = await A.evaluate(`JSON.stringify((JSON.parse(localStorage.getItem("plan-errors")||"[]")||[]).map(function(e){return e&&e.msg;}))`);
  check("aucune erreur JS pendant tout le scénario de partage", errsA === "[]", "vu " + errsA);

  // ============================================================================================
  //  2 & 3. THE STALE LOCAL-ONLY GUESS: silent no longer (defect 1), and self-healing (defect 2).
  // ============================================================================================
  // `plan-porte-locale` is seeded BEFORE the app ever boots, exactly as it would be after an
  // earlier visit mistakenly discovered the guest door. This tab is STILL the household door
  // (Host matches HOUSEHOLD_HOSTS) — the flag is simply WRONG for this origin.
  const B = await openBrowser("guerison", URL_OF("/porte-locale"));
  opened.push(B);
  const flagEffaceApresLecture = await attendre(async () =>
    (await B.evaluate(`localStorage.getItem("plan-porte-locale")`)) === null);
  check("un boot qui réussit efface le drapeau local-seul périmé (auto-guérison)", flagEffaceApresLecture,
    "vu " + await B.evaluate(`localStorage.getItem("plan-porte-locale")`));

  // THIS TAB's mode does not revert mid-life (by design, `drapeaux.ts`): the Invite button stays
  // hidden for the rest of THIS session even though the flag that caused it is already gone.
  const btnInviteEncoreCache = await B.evaluate(`(document.getElementById("btnInvite")||{}).hidden`);
  check("le bouton Invite reste caché pour LE RESTE DE CET onglet (le mode ne change pas en cours de vie)",
    btnInviteEncoreCache === true, "vu hidden=" + btnInviteEncoreCache);

  // Defect 1: clicking Share on this tab must not be silent. `.click()` on the hidden button
  // exercises `ouvrirPartage()` exactly as a stale/regressed visibility rule would let a real
  // pointer reach it — the point being to prove the FUNCTION says why, not that the button is
  // reachable by mouse today.
  await B.evaluate(`document.getElementById("btnInvite").click()`);
  const toastVu = await attendre(async () => !!(await B.evaluate(`window.__plan.toastText`)));
  const texteToast = await B.evaluate(`window.__plan.toastText`);
  check("cliquer Share sur un onglet non rattaché au foyer AFFICHE un message, jamais le silence",
    toastVu, "vu toastText=" + JSON.stringify(texteToast));
  check("le message dit exactement pourquoi (onglet non rattaché au plan du foyer)",
    texteToast === MSG_PAS_MENAGE, "attendu " + JSON.stringify(MSG_PAS_MENAGE) + ", vu " + JSON.stringify(texteToast));
  const dlgResteFerme = await B.evaluate(`(document.getElementById("shareDlg")||{}).hidden`);
  check("le panneau de partage ne s'ouvre pas", dlgResteFerme === true, "vu hidden=" + dlgResteFerme);

  // Defect 2, the other half: reload the SAME tab (same storage, `/revisite`, exactly like
  // `porte-invitee.ts`'s own "second visit" case). The flag is gone, so THIS new page load starts
  // fresh on the household door, and Share works normally: this is the self-healing path.
  await B.evaluate(`location.href = "/revisite"`);
  const rebooteB = await attendre(async () => (await B.evaluate(`typeof window.__plan`)) === "object");
  check("après rechargement (drapeau parti), le planificateur redémarre normalement", rebooteB,
    "vu typeof window.__plan = " + await B.evaluate(`typeof window.__plan`));
  const btnInviteRevenu = await attendre(async () => (await B.evaluate(`(document.getElementById("btnInvite")||{}).hidden`)) === false);
  check("le bouton Invite est de nouveau visible : la porte du foyer a guéri", btnInviteRevenu,
    "vu hidden=" + await B.evaluate(`(document.getElementById("btnInvite")||{}).hidden`));

  await B.evaluate(`document.getElementById("btnInvite").click()`);
  const dlgOuvertApresGuerison = await attendre(async () => (await B.evaluate(`(document.getElementById("shareDlg")||{}).hidden`)) === false);
  check("Share fonctionne normalement après auto-guérison (plus aucun message d'impossibilité)", dlgOuvertApresGuerison,
    "vu hidden=" + await B.evaluate(`(document.getElementById("shareDlg")||{}).hidden`));
  const nomPlanAffiche = await B.evaluate(`(document.getElementById("sharePlanName")||{}).textContent`);
  check("le panneau affiche bien le plan du foyer", nomPlanAffiche === "Chez nous" || nomPlanAffiche === "main",
    "vu " + JSON.stringify(nomPlanAffiche));

  server.close();
} catch (e) {
  process.stdout.write("ERREUR DE SCÉNARIO : " + (e && (e as Error).stack || e) + "\n");
  code = 1;
} finally {
  opened.forEach((b) => b.close());
}

const passed = results.filter((r) => r.pass).length;
process.stdout.write("\n" + (passed === results.length && !code
  ? "OK " + passed + "/" + results.length
  : "FAILURES " + (results.length - passed) + "/" + results.length) + "\n");
process.exit(passed === results.length && !code ? 0 : 1);
