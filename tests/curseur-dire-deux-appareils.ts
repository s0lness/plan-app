#!/usr/bin/env node
// =============================================================================
//  CURSOR CHAT ("/"): THE WIRE HALF, TWO DEVICES BEHIND A SINGLE ADDRESS
// =============================================================================
// Same harness as `tests/deux-appareils.ts` (one headless page per case, the server simulated
// through `window.__plan.wsFeed`/`outLog`): A is THIS page, B is simulated by feeding back what
// A would receive from a peer. Covers what `tests/curseur-dire.ts` (real CDP, real keyboard)
// cannot: what actually crosses the wire, and what a PEER's screen does with it.
//
//   node tests/curseur-dire-deux-appareils.ts [path/to/app.html]
//
// Exit 0 if everything passes, 1 otherwise.

import type { VerdictSonde } from "./_types.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ouvrirSonde, CHROME } from "./_navigateur.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_PATH = process.argv[2] || path.join(__dirname, "..", "index.html");
const V4_KEY = "room-planner-v4";

if (!fs.existsSync(APP_PATH)) { console.error("App file not found:", APP_PATH); process.exit(1); }
if (!fs.existsSync(CHROME)) { console.error("Chrome not found:", CHROME); process.exit(1); }
const APP_SRC = fs.readFileSync(APP_PATH, "utf8");
const REAL_PLAN = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "plan-rev177.json"), "utf8"));

// ---- harness: ONE Chrome for the whole suite, see tests/_navigateur.ts for the why ------------
const sonde = ouvrirSonde(APP_SRC);
async function runProbe(seedJs: string, probeBody: string): Promise<VerdictSonde> {
  return sonde.sonder(seedJs, probeBody);
}
const results: VerdictSonde[] = [];
async function test(name: string, seedJs: string, probeBody: string, check: (...args: VerdictSonde[]) => VerdictSonde | Promise<VerdictSonde>): Promise<void> {
  let pass = false, detail = "";
  const v = await runProbe(seedJs, probeBody);
  if (v.__noVerdict) detail = "aucun verdict (l'app n'a pas démarré ?)\n  stdout: " + (v.__stdoutHead || "") + "\n  stderr: " + (v.__stderr || "");
  else if (v.__probeError) detail = "la sonde a levé : " + v.__probeError;
  else if (v.__parseError) detail = "verdict illisible : " + v.__parseError + " raw=" + v.__raw;
  else if (v.jsErrors && v.jsErrors.length) detail = "erreur JS dans l'app : " + JSON.stringify(v.jsErrors);
  else {
    try { const r = check(v); if (r === true) pass = true; else detail = r || "assertion fausse"; }
    catch (e) { detail = String(e && e.message || e); }
  }
  results.push({ name, pass, detail });
  process.stdout.write((pass ? "  ok   " : "  FAIL ") + name + "\n");
  if (!pass) process.stdout.write("       " + detail.replace(/\n/g, "\n       ") + "\n");
}
function expect(cond: VerdictSonde, msg: string) { if (!cond) throw new Error(msg); return true; }
const seedV4 = (st: VerdictSonde) => `try{ localStorage.setItem(${JSON.stringify(V4_KEY)}, ${JSON.stringify(JSON.stringify(st))}); }catch(e){}`;
const SEED = seedV4(REAL_PLAN);

// Device A ("aaaaaa", the household member on this page) and a household peer ("bbbbbb") for the
// second device, same shape as `tests/deux-appareils.ts`'s own HELLO.
const HELLO = `window.__plan.wsForceOpen(true);
  window.__plan.wsFeed({ t:"hello",
    you:{ email:"a@example.com", color:"#1f6f78", tag:"aaaaaa" },
    peers:[ {email:"a@example.com", color:"#1f6f78", tag:"aaaaaa"},
            {email:"device.b@example.com", color:"#b04a3d", tag:"bbbbbb"} ],
    state:null, rev:1, fp:"x", chat:[] });`;

// A message A ACTUALLY EMITTED (captured live, not hand-built), relabelled as if it had arrived
// from device "bbbbbb": the SERVER stamps `tag`/`by`/`name`, the client never sends its own, a
// captured outgoing `cursor` message therefore carries none of them yet.
const commeUnPair = `function commeUnPair(m){
    return Object.assign({}, m, { tag:"bbbbbb", by:"device.b@example.com", name:"", guest:false });
  }`;

// =============================================================================
//  1. A TYPES: the wire carries the text, LETTER BY LETTER, at the cursor's own cadence
// =============================================================================
await test("a_emet_son_texte_lettre_par_lettre_sur_le_fil_curseur", SEED, `
  ${HELLO}
  window.__plan.setCursorApt(120, 80);
  window.__plan.outLog(true);
  ["b","bo","bon"].forEach(function(s){ window.__plan.direTexte(s); window.__plan.direFlush(); });
  var out = window.__plan.outLog(false).filter(function(m){ return m && m.t === "cursor"; });
  return { n: out.length, says: out.map(function(m){ return m.say; }),
           x: out[0] && out[0].x, y: out[0] && out[0].y, room: out[0] && out[0].room };
`, (v: VerdictSonde) => expect(v.n === 3, "trois frappes doivent produire trois messages cursor, vu " + v.n)
     && expect(JSON.stringify(v.says) === JSON.stringify(["b", "bo", "bon"]),
        "chaque message doit porter le texte COURANT au moment de l'envoi, vu " + JSON.stringify(v.says))
     && expect(v.x === 120 && v.y === 80, "la position doit être celle du curseur, pas une valeur inventée, vu " + JSON.stringify(v))
     && expect(!!v.room, "le message reste un curseur ordinaire (room posé), rien de spécial à ajouter côté serveur"));

// =============================================================================
//  2. B SEES IT: the SAME messages, fed back as if from the OTHER device, paint the bubble
// =============================================================================
await test("b_voit_le_texte_de_a_apparaitre_lettre_par_lettre", SEED, `
  ${HELLO}
  window.__plan.setCursorApt(120, 80);
  window.__plan.outLog(true);
  ["b","bo","bon"].forEach(function(s){ window.__plan.direTexte(s); window.__plan.direFlush(); });
  var out = window.__plan.outLog(false).filter(function(m){ return m && m.t === "cursor"; });
  ${commeUnPair}
  var vus = out.map(function(m){
    window.__plan.wsFeed(commeUnPair(m));
    var curs = window.__plan.peerCursors();
    return curs.length === 1 ? { say: curs[0].say, sayHidden: curs[0].sayHidden } : null;
  });
  return { vus: vus };
`, (v: VerdictSonde) => expect(v.vus.every((x: VerdictSonde) => x), "à chaque frappe le pair doit être présent avec une bulle, vu " + JSON.stringify(v.vus))
     && expect(v.vus[0].say === "b" && v.vus[1].say === "bo" && v.vus[2].say === "bon",
        "le texte affiché chez B doit suivre A LETTRE PAR LETTRE, vu " + JSON.stringify(v.vus))
     && expect(v.vus.every((x: VerdictSonde) => x.sayHidden === false),
        "la bulle doit rester visible tant que du texte arrive, vu " + JSON.stringify(v.vus)));

// =============================================================================
//  3. B SEES IT DISAPPEAR: A dismisses (Escape/Enter/blur -> `direArreter`), the bubble hides
// =============================================================================
await test("b_voit_le_texte_disparaitre_quand_a_ferme_sa_boite", SEED, `
  ${HELLO}
  window.__plan.setCursorApt(120, 80);
  ${commeUnPair}
  // A speaks first, B sees it (established fact this case starts from).
  window.__plan.outLog(true);
  window.__plan.direTexte("salut");
  window.__plan.direFlush();
  var m1 = window.__plan.outLog(false).filter(function(m){ return m && m.t === "cursor"; }).pop();
  window.__plan.wsFeed(commeUnPair(m1));
  var avant = window.__plan.peerCursors()[0];
  // A dismisses the box (Escape/Enter/blur all funnel into direArreter, fil/dire.ts).
  window.__plan.outLog(true);
  window.__plan.direArreter();
  var m2 = window.__plan.outLog(false).filter(function(m){ return m && m.t === "cursor"; }).pop();
  window.__plan.wsFeed(commeUnPair(m2));
  var apres = window.__plan.peerCursors()[0];
  return { sayExplicite: m2 && ("say" in m2) && m2.say, avant: { say: avant.say, sayHidden: avant.sayHidden },
           apres: { say: apres.say, sayHidden: apres.sayHidden } };
`, (v: VerdictSonde) => expect(v.avant.say === "salut" && v.avant.sayHidden === false, "avant fermeture, B doit voir le texte, vu " + JSON.stringify(v.avant))
     && expect(v.sayExplicite === null, "la fermeture doit envoyer say:null EXPLICITEMENT (pas juste l'omettre), vu " + JSON.stringify(v.sayExplicite))
     && expect(v.apres.sayHidden === true, "et B doit voir la bulle disparaître, vu " + JSON.stringify(v.apres)));

// =============================================================================
//  4. NOTHING IS WRITTEN: A whole exchange (A speaks, B receives, A dismisses) leaves the plan
//     byte-identical, nothing to save, nothing to undo.
// =============================================================================
await test("un_echange_complet_ne_modifie_pas_le_plan", SEED, `
  ${HELLO}
  window.__plan.setCursorApt(120, 80);
  ${commeUnPair}
  var avant = JSON.stringify(window.__plan.state.plan);
  window.__plan.outLog(true);
  window.__plan.direTexte("un message ephemere");
  window.__plan.direFlush();
  var m1 = window.__plan.outLog(false).filter(function(x){ return x && x.t === "cursor"; }).pop();
  window.__plan.wsFeed(commeUnPair(m1));   // B receives it
  window.__plan.direArreter();             // A dismisses
  var apres = JSON.stringify(window.__plan.state.plan);
  return { avant: avant, apres: apres, egal: avant === apres };
`, (v: VerdictSonde) => expect(v.egal === true, "le plan doit rester byte-identique apres tout l'echange"));

// =============================================================================
//  5. THE XSS AUDIT: a peer's cursor-chat text renders as TEXT, never as markup
// =============================================================================
const CHARGE_UTILE = "<img src=x onerror=alert(document.cookie)>";
await test("xss_texte_de_curseur_du_pair_s_affiche_en_texte", SEED, `
  ${HELLO}
  window.__plan.wsFeed({ t:"cursor", by:"device.b@example.com", tag:"bbbbbb", room:"__apt__",
    x:100, y:100, say:${JSON.stringify(CHARGE_UTILE)} });
  var el = document.querySelector("#peerCursors .pc-say");
  return { texte: el && el.textContent, html: el && el.innerHTML,
           nbImg: document.querySelectorAll("#peerCursors img").length };
`, (v: VerdictSonde) => expect(v.texte === CHARGE_UTILE, "le texte doit survivre TEL QUEL dans .textContent, vu " + JSON.stringify(v.texte))
     && expect(v.nbImg === 0, "aucune balise <img> ne doit avoir ete instanciee, vu " + v.nbImg)
     && expect(!/<img[\\s>]/i.test(v.html || ""), "aucune balise <img> brute dans le HTML resultant, vu " + JSON.stringify(v.html)));

// ---- verdict ---------------------------------------------------------------------------------
sonde.fermer();
const bad = results.filter((r) => !r.pass);
console.log("");
if (bad.length) { console.log(`FAILURES ${bad.length}/${results.length}`); process.exitCode = 1; }
else console.log(`OK ${results.length}/${results.length}`);
