#!/usr/bin/env node
// THE GUEST DOOR, IN A REAL BROWSER (docs/decisions/0004-partage-par-lien.md, batch 3).
//
// `SYNC_ON` requires http(s), so this spins up a local HTTP server (like tests/plan-abime.ts) that
// serves the built `index.html` plus the REAL `functions/api/invite.ts` and `functions/api/plan.ts`
// over an in-memory D1 (tests/fake-d1.ts), on the "invite" door (`Host: share.example.com`). `/ws`
// is deliberately NOT served: none of what this suite proves needs a live socket, and letting the
// WebSocket constructor fail against a plain HTTP response is exactly what production does too
// when the Durable Object is unreachable.
//
// Proves, against the SAME rig used throughout:
//   1. a `#k=` link is captured (stored) and stripped from the address bar;
//   2. the name step blocks an empty name (Join stays disabled) and accepts a typed one;
//   3. a dead-end link shows the FULL-SCREEN dead end, and the planner never boots at all
//      (`window.__plan` stays undefined: `installerSonde` lives inside `amorcer()`, which
//      `preparerAccueil()` never lets run);
//   4. local-only mode NEVER issues a PUT, and says so on the chip — never one of the five
//      ordinary sync states.
//
// Run:   node tests/porte-invitee.ts [path-to-app-html]
// Exit:  0 if everything passes, 1 otherwise.

import type { VerdictSonde } from "./_types.ts";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { onRequestPost as invitePost } from "../functions/api/invite.ts";
import { onRequestGet as planGet, onRequestPut as planPut } from "../functions/api/plan.ts";
import { fakeD1 } from "./fake-d1.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const APP_PATH = process.argv[2] || path.join(__dirname, "..", "index.html");
const HOTE_INVITE = "share.example.com";
const HOUSEHOLD_HOSTS_ENV = { HOUSEHOLD_HOSTS: "plan.example.com", GUEST_HOST: HOTE_INVITE };

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

// ---- a browser driven over CDP (verbatim rig from tests/plan-abime.ts) -------------------------
async function openBrowser(label: string, url: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "porte-invitee-" + label + "-"));
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
  //  RIG: the REAL invite + plan Functions, over an in-memory D1, on the "invite" door.
  // ============================================================================================
  const { db, env: envBase } = fakeD1(null);
  const env = { ...envBase, ...HOUSEHOLD_HOSTS_ENV };
  const now = new Date().toISOString();
  const dansTrenteJours = new Date(Date.now() + 30 * 86_400_000).toISOString();

  db.prepare("INSERT INTO plans(id,data,rev,updated_at,updated_by,name) VALUES(?1,?2,1,?3,?4,?5)")
    .run("appartement", JSON.stringify({ outline: [], walls: [], openings: [], pieces: [], cells: [] }),
      now, "sylve@example.com", "Chez nous");

  const jeton = (etiquette: string) => (etiquette + "-".repeat(22)).slice(0, 22);
  const insereInvite = (token: string, lastName: string | null, lastGuestId: string | null = null) => {
    db.prepare(
      "INSERT INTO invites(token,plan_id,role,created_at,created_by,expires_at,revoked,uses,last_used_at,last_name,last_guest_id) " +
      "VALUES(?1,'appartement','edit',?2,'sylve@example.com',?3,0,0,NULL,?4,?5)"
    ).run(jeton(token), now, dansTrenteJours, lastName, lastGuestId);
  };
  // `lastGuestId` deliberately does NOT match anything a freshly-opened browser will ever generate
  // for itself (`plan-guest-id` is random per profile): this row represents a name recorded by
  // SOME OTHER device, exactly like the owner naming himself before a friend opens the same link.
  insereInvite("nomme1", "Marie", "un-autre-appareil-1234");
  insereInvite("anonyme1", null);      // never named by anyone: the name step must show
  // "invalide1" is NEVER inserted: an unknown token, the ordinary dead end.

  let putCount = 0;
  const putLog: VerdictSonde[] = [];

  const server = http.createServer(async (req, res) => {
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
        out = await invitePost({ request: requete, env } as unknown as Parameters<typeof invitePost>[0]);
      } else if (url.pathname === "/api/plan" && req.method === "GET") {
        out = await planGet({ request: requete, env } as unknown as Parameters<typeof planGet>[0]);
      } else if (url.pathname === "/api/plan" && req.method === "PUT") {
        putCount++; putLog.push({ body: body.slice(0, 300) });
        out = await planPut({ request: requete, env } as unknown as Parameters<typeof planPut>[0]);
      } else if (url.pathname === "/" || url.pathname === "/revisite") {
        // `/` REPART D'UN STOCKAGE VIDE, `/revisite` GARDE CELUI D'AVANT. Même origine, donc même
        // `localStorage` : c'est la seule façon de rejouer une DEUXIÈME visite, puisque la page
        // servie sur `/` efface le stockage à chaque navigation (ce qui est voulu pour isoler les
        // scénarios, et ce qui rendait un simple `location.reload()` incapable de rien prouver).
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
    const headers: Record<string, string> = { "Content-Type": out.headers.get("content-type") || "text/plain" };
    const setCookie = out.headers.get("set-cookie");
    if (setCookie) headers["Set-Cookie"] = setCookie;
    res.writeHead(out.status, headers);
    res.end(text);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const PORT = (server.address() as { port: number }).port;
  const URL_OF = (p: string) => `http://127.0.0.1:${PORT}${p}`;

  // ============================================================================================
  //  1. A #k= LINK IS CAPTURED, STORED, AND STRIPPED — and a name known for the token but NOT for
  //     THIS DEVICE does not skip the step (docs/decisions/0004-partage-par-lien.md, edge 20,
  //     corrected 2026-08-14). Confirmed live, two people testing multiplayer together: the owner
  //     named himself, his friend opened the SAME link right after and silently became him on both
  //     screens. `nomme1`'s row already carries `last_name="Marie"`, recorded by a `guestId` this
  //     freshly-opened browser cannot possibly have (it generates its own, at random, on first use).
  // ============================================================================================
  const A = await openBrowser("nomme", URL_OF("/#k=" + jeton("nomme1")));
  opened.push(A);
  const capture = await attendre(async () => (await A.evaluate(`location.hash`)) === "");
  check("le # est retiré de la barre d'adresse", capture, "hash = " + await A.evaluate("location.hash"));
  const jetonStocke = await A.evaluate(`localStorage.getItem("plan-invite-token")`);
  check("le jeton est mémorisé en localStorage", jetonStocke === jeton("nomme1"), "vu " + JSON.stringify(jetonStocke));

  const dlgOuvertA = await attendre(async () => (await A2Hidden(A, "inviteNameDlg")) === false);
  check("un nom déjà connu POUR LE JETON mais pas pour CET APPAREIL ne saute PAS l'étape du nom", dlgOuvertA);
  const champVideA = await A.J(`(document.getElementById("inviteNameInput")||{}).value`);
  check("le champ n'est jamais pré-rempli avec le nom mémorisé pour un AUTRE appareil",
    champVideA === "", "vu " + JSON.stringify(champVideA));

  await A.evaluate(`(function(){
    var i = document.getElementById("inviteNameInput");
    i.value = "Julien"; i.dispatchEvent(new Event("input", {bubbles:true}));
  })()`);
  const rempliActiveA = await attendre(async () =>
    (await A.J(`(document.getElementById("inviteNameJoin")||{}).disabled`)) === false);
  check("le bouton Join s'active une fois un nom saisi (deuxième appareil)", rempliActiveA);
  await A.evaluate(`document.getElementById("inviteNameJoin").click()`);

  const trim = await attendre(async () => (await A.J(`(function(){
    var g=document.getElementById("btnGuestName");
    return {guestBtn: g && !g.hidden, plans: !document.getElementById("btnPlans") || (document.getElementById("btnPlans")||{}).hidden,
            imp: !document.getElementById("btnImport") || (document.getElementById("btnImport")||{}).hidden};})()`)).guestBtn);
  const trimme = await A.J(`(function(){
    var g=document.getElementById("btnGuestName");
    return {guestBtn: g && !g.hidden, plans: !document.getElementById("btnPlans") || (document.getElementById("btnPlans")||{}).hidden,
            imp: !document.getElementById("btnImport") || (document.getElementById("btnImport")||{}).hidden};})()`);
  check("une fois SON PROPRE nom choisi, le bouton 'Name…' apparaît",
    trim, "vu " + JSON.stringify(trimme));
  check("le panneau Plans est masqué pour un invité", trimme.plans, "vu " + JSON.stringify(trimme));
  check("« Charger un plan… » est masqué pour un invité", trimme.imp, "vu " + JSON.stringify(trimme));

  const nomStockeA = await attendre(async () =>
    (await A.evaluate(`localStorage.getItem("plan-invite-nom")`)) === "Julien");
  check("le nom TAPÉ par ce deuxième appareil est mémorisé, jamais celui de l'autre",
    nomStockeA, "vu " + JSON.stringify(await A.evaluate(`localStorage.getItem("plan-invite-nom")`)));

  const planteur = await A.evaluate(`JSON.stringify((JSON.parse(localStorage.getItem("plan-errors")||"[]")||[]).map(function(e){return e&&e.msg;}))`);
  check("aucune erreur JS sur le chemin d'accueil du deuxième appareil", planteur === "[]", "vu " + planteur);

  // ============================================================================================
  //  2. THE NAME STEP BLOCKS AN EMPTY NAME
  // ============================================================================================
  const B = await openBrowser("anonyme", URL_OF("/#k=" + jeton("anonyme1")));
  opened.push(B);
  const dlgOuvert = await attendre(async () => (await A2Hidden(B, "inviteNameDlg")) === false);
  check("un invité JAMAIS nommé voit l'étape du nom", dlgOuvert);
  const videDesactive = await B.J(`(document.getElementById("inviteNameJoin")||{}).disabled`);
  check("le bouton Join reste désactivé tant que le champ est vide", videDesactive === true, "disabled=" + videDesactive);

  await B.evaluate(`(function(){
    var i = document.getElementById("inviteNameInput");
    i.value = "Julien"; i.dispatchEvent(new Event("input", {bubbles:true}));
  })()`);
  // ON ATTEND LA CONDITION, PAS UNE DUREE, et surtout pas « rien ». Le gestionnaire `input` qui
  // reactive le bouton tourne dans la page, apres que CDP a rendu la main : lire `disabled` dans
  // la foulee marchait sur une machine au repos et tombait sous charge, en signalant
  // « disabled=true » comme si le produit etait casse. C'est la regle du depot (AGENTS.md) :
  // attendre une CONDITION partout, jamais une duree, sinon on ne fait que deplacer le seuil ou
  // ca retombe.
  const rempliActive = await attendre(async () =>
    (await B.J(`(document.getElementById("inviteNameJoin")||{}).disabled`)) === false);
  check("le bouton Join s'active une fois un nom saisi", rempliActive,
    "disabled=" + await B.J(`(document.getElementById("inviteNameJoin")||{}).disabled`));

  await B.evaluate(`document.getElementById("inviteNameJoin").click()`);
  const dlgFerme = await attendre(async () => (await A2Hidden(B, "inviteNameDlg")) === true);
  check("Join ferme l'étape du nom", dlgFerme);
  const nomStocke = await attendre(async () =>
    (await B.evaluate(`localStorage.getItem("plan-invite-nom")`)) === "Julien");
  check("le nom saisi est mémorisé", nomStocke,
    "vu " + JSON.stringify(await B.evaluate(`localStorage.getItem("plan-invite-nom")`)));

  // ============================================================================================
  //  3. A DEAD-END LINK SHOWS THE FULL SCREEN, AND NO PLANNER BOOTS AT ALL
  // ============================================================================================
  const C = await openBrowser("mort", URL_OF("/#k=" + jeton("invalide1")));
  opened.push(C);
  const impasse = await attendre(async () => (await A2Hidden(C, "inviteDeadEnd")) === false);
  check("un jeton inconnu affiche l'écran plein, jamais de bandeau", impasse);
  const rienDerriere = await C.J(`(function(){
    return {plan: typeof window.__plan, setupHidden: (document.getElementById("setup")||{}).hidden};})()`);
  check("le planificateur n'a jamais démarré derrière l'impasse (window.__plan reste undefined)",
    rienDerriere.plan === "undefined", "vu " + JSON.stringify(rienDerriere));
  const sansSauvegarde = await C.J(`(document.getElementById("inviteDeadEndSaved")||{}).hidden`);
  check("la première rédemption ratée ne prétend rien sur une sauvegarde (rien n'a jamais été édité)",
    sansSauvegarde === true, "vu hidden=" + sansSauvegarde);

  // ============================================================================================
  //  4. LOCAL-ONLY MODE NEVER ISSUES A PUT, AND SAYS SO ON THE CHIP
  // ============================================================================================
  const putsAvant = putCount;
  const D = await openBrowser("seul", URL_OF("/"));   // no hash, no stored token: a stranger
  opened.push(D);
  const local = await attendre(async () => (await D.evaluate(`(document.getElementById("syncChip")||{}).textContent`)) === "local only");
  check("le chip affiche « local only » pour un visiteur sans invitation", local,
    "vu " + await D.evaluate(`(document.getElementById("syncChip")||{}).textContent`));
  const banniere = await D.J(`!(document.getElementById("localBanner")||{}).hidden`);
  check("le bandeau local (export mis en avant) est visible", banniere);
  // LE CAS EXACT REMONTE PAR UN VISITEUR : « Plans… », puis Create, puis
  // «⁠Could not create the plan (403)⁠». Le serveur avait raison (`/api/plans` est fermé sur cette
  // porte) ; c'est l'écran qui proposait un bouton qui ne peut pas marcher là. Le rognage ne
  // tournait que pour un invité MUNI d'un lien, pas pour le bac à sable.
  const commandesFoyer = await D.J(`JSON.stringify({
    plans: (document.getElementById("btnPlans")||{}).hidden,
    charger: (document.getElementById("btnImport")||{}).hidden,
    invite: (document.getElementById("btnInvite")||{}).hidden})`);
  check("le bac a sable ne propose ni « Plans… », ni « Charger un plan… », ni « Invite »",
    commandesFoyer === '{"plans":true,"charger":true,"invite":true}', "vu " + commandesFoyer);

  const assistantOuvert = await D.J(`!(document.getElementById("setup")||{}).hidden`);
  check("l'assistant de configuration s'ouvre comme sous file:// (aucun serveur ici non plus)", assistantOuvert);

  // A real edit, exactly like a household device would make: must NEVER reach the server.
  await D.evaluate(`(function(){
    window.__plan.plan.cells[0] && (window.__plan.plan.cells[0].name = "Salon local seul");
    window.__plan.save();
  })()`);
  await sleep(2500);   // longer than the 1 s push debounce
  check("aucun PUT n'est jamais parti en mode local seul", putCount === putsAvant,
    (putCount - putsAvant) + " PUT reçu(s) : " + JSON.stringify(putLog.slice(-2)));
  const chipEncoreLocal = await D.evaluate(`(document.getElementById("syncChip")||{}).textContent`);
  check("le chip reste « local only » après l'édition (jamais « slow sync » ni « offline »)",
    chipEncoreLocal === "local only", "vu " + chipEncoreLocal);

  const errsD = await D.evaluate(`JSON.stringify((JSON.parse(localStorage.getItem("plan-errors")||"[]")||[]).map(function(e){return e&&e.msg;}))`);
  check("aucune erreur JS en mode local seul", errsD === "[]", "vu " + errsD);

  // ============================================================================================
  //  5. LA DEUXIÈME VISITE RETROUVE SON TRAVAIL (et ne l'écrase pas)
  // ============================================================================================
  // Le mode local-seul se découvre APRÈS coup, sur le 403 de l'amorçage, alors qu'`amorcer()` a
  // déjà lu le stockage de façon SYNCHRONE. Sans le drapeau `plan-porte-locale`, cette deuxième
  // visite lisait la clé du FOYER, affichait un appartement vide à la place du plan ci-dessus,
  // puis l'écrasait à la première modification : une perte silencieuse, sur les seules données que
  // ce visiteur possède. Ici on recharge le MÊME onglet, donc le même stockage.
  await D.evaluate(`location.href = "/revisite"`);
  const revenu = await attendre(async () =>
    (await D.evaluate(`(document.getElementById("syncChip")||{}).textContent`)) === "local only");
  check("après rechargement, le visiteur est encore en local seul", revenu,
    "vu " + await D.evaluate(`(document.getElementById("syncChip")||{}).textContent`));
  const nomCellule = await D.evaluate(
    `(function(){var c=window.__plan&&window.__plan.plan&&window.__plan.plan.cells[0];return c?String(c.name):"(pas de cellule)";})()`);
  check("le plan dessiné à la visite précédente est TOUJOURS là", nomCellule === "Salon local seul",
    "attendu « Salon local seul », vu " + JSON.stringify(nomCellule));
  const errsD2 = await D.evaluate(`JSON.stringify((JSON.parse(localStorage.getItem("plan-errors")||"[]")||[]).map(function(e){return e&&e.msg;}))`);
  check("aucune erreur JS à la deuxième visite", errsD2 === "[]", "vu " + errsD2);

  server.close();
} catch (e) {
  process.stdout.write("ERREUR DE SCÉNARIO : " + (e && (e as Error).stack || e) + "\n");
  code = 1;
} finally {
  opened.forEach((b) => b.close());
}

/**
 * `hidden` de l'element, ou `null` s'il n'existe pas ENCORE. Les trois etats comptent, et c'est
 * pour ca que les appelants comparent a `=== false` ou `=== true` plutot que d'ecrire `!hidden`.
 *
 * Mesure : le harnais serialise `(expr) ?? null` pour qu'un element absent ne fasse plus tomber le
 * scenario. Bien. Mais `!null` vaut `true`, donc `!(await A2Hidden(...))` repondait « visible »
 * pour un element qui n'etait PAS ENCORE dans la page : l'attente se terminait aussitot, le test
 * attaquait un dialogue inexistant, et signalait « le bouton reste desactive : disabled=null »
 * comme si le produit etait casse. Une garde qui transforme un plantage en reponse FAUSSE mais
 * plausible est pire que le plantage : elle accuse quelqu'un d'autre.
 */
async function A2Hidden(b: { J: (e: string) => Promise<VerdictSonde> }, id: string): Promise<boolean> {
  return b.J(`(document.getElementById(${JSON.stringify(id)})||{}).hidden`) as unknown as Promise<boolean>;
}

const passed = results.filter((r) => r.pass).length;
process.stdout.write("\n" + (passed === results.length && !code
  ? "OK " + passed + "/" + results.length
  : "FAILURES " + (results.length - passed) + "/" + results.length) + "\n");
process.exit(passed === results.length && !code ? 0 : 1);
