#!/usr/bin/env node
// Regression suite for the COLLABORATION WIRE, client side.
//
// It covers what the server batch (live-worker/, already deployed) made possible, and what the
// client must do with it:
//   - adoption is decided on the CONTENT FINGERPRINT (`fp`), never on a counter;
//   - `state` (sync / d1_adopt) and `conflict` are received and SAID in plain language;
//   - `pong` carries the fingerprint: a disagreement triggers a `sync`, without looping;
//   - entity ids carry a device tag (no more collision between two devices);
//   - ops are FIELD-BY-FIELD diffs, and a received partial op MERGES;
//   - the outgoing mirror describes the SERVER, not the local state;
//   - a fresh household publishes its first plan;
//   - UNDO only undoes its own author's work.
//
// Same harness as tests/model-v5.ts: one page per case, under headless Chrome, verdict read back
// from <html data-plan-test="...">. The REAL server validator (live-worker/ops.ts) is imported here:
// ops emitted by the client are replayed through it, rather than redescribed by hand.
//
// Run:   node tests/collab-annuler.ts [path-to-app.html]
// Exit:  0 if everything passes, 1 otherwise.

import type { VerdictSonde } from "./_types.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyOp, sanitizeState, planFp } from "../live-worker/ops.ts";
import { ouvrirSonde, CHROME } from "./_navigateur.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_PATH = process.argv[2] || path.join(__dirname, "..", "index.html");
const V4_KEY = "room-planner-v4";

if (!fs.existsSync(APP_PATH)) { console.error("App file not found:", APP_PATH); process.exit(1); }
if (!fs.existsSync(CHROME)) { console.error("Chrome not found:", CHROME); process.exit(1); }
const APP_SRC = fs.readFileSync(APP_PATH, "utf8");
const REAL_PLAN = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "plan-rev177.json"), "utf8"));

// ---- harness -----------------------------------------------------------------------------------
// THE BROWSER ITSELF LIVES IN `_navigateur.ts`, shared with the five other suites that had each
// copied this same page-per-case harness: ONE Chrome for the whole suite instead of one cold start
// per case. See that file for the measurements and the why.
const sonde = ouvrirSonde(APP_SRC);
async function runProbe(seedJs: string, probeBody: string): Promise<VerdictSonde> {
  return sonde.sonder(seedJs, probeBody);
}
const results: VerdictSonde[] = [];
async function test(name: string, seedJs: string, probeBody: string, check: (...args: VerdictSonde[]) => VerdictSonde | Promise<VerdictSonde>): Promise<void> {
  let pass = false, detail = "";
  const v = await runProbe(seedJs, probeBody);
  if (v.__noVerdict) detail = "aucun verdict (l'application n'a pas démarré ?)\n  " + v.__stdoutHead + "\n  " + v.__stderr;
  else if (v.__probeError) detail = "la sonde a levé : " + v.__probeError;
  else if (v.__parseError) detail = "verdict illisible : " + v.__parseError + " raw=" + v.__raw;
  else if (v.jsErrors && v.jsErrors.length) detail = "erreur JS journalisée : " + JSON.stringify(v.jsErrors);
  else {
    try { const r = check(v); if (r === true) pass = true; else detail = r || "assertion fausse"; }
    catch (e) { detail = "la vérification a levé : " + String(e && e.message || e); }
  }
  results.push({ name, pass, detail });
  process.stdout.write((pass ? "  ok   " : "  FAIL ") + name + "\n");
  if (!pass) process.stdout.write("       " + detail.replace(/\n/g, "\n       ") + "\n");
}
function expect(cond: VerdictSonde, msg: string) { if (!cond) throw new Error(msg); return true; }
const seedV4 = (st: VerdictSonde) => `try{ localStorage.setItem(${JSON.stringify(V4_KEY)}, ${JSON.stringify(JSON.stringify(st))}); }catch(e){}`;
// Common prelude: the wire is "open" (no real socket under file://), the mirror starts from the
// local state, and everything going out is logged.
const OUVRIR = `window.__plan.wsForceOpen(true); window.__plan.shadowSync();`;

// =============================================================================
//  1. ADOPTION BASED ON THE CONTENT FINGERPRINT, NOT A COUNTER
// =============================================================================
await test("adoption_sur_empreinte_et_pas_sur_compteur", seedV4(REAL_PLAN), `
  ${OUVRIR}
  var w = window.__plan.wire();
  var a = JSON.parse(JSON.stringify(w)); a.cells[0].name = "Venu du serveur";
  var b = JSON.parse(JSON.stringify(w)); b.cells[0].name = "JAMAIS adopté";
  // 1st hello: unknown fingerprint -> adoption.
  window.__plan.wsFeed({t:"hello", you:{email:"x@y", tag:"aaaaaa"}, peers:[], rev:5, fp:"FP-1", state:a, chat:[]});
  var apres1 = window.__plan.plan.cells[0].name;
  // 2nd hello: SAME fingerprint, different content -> no adoption (the rev did change though).
  window.__plan.wsFeed({t:"hello", you:{email:"x@y", tag:"aaaaaa"}, peers:[], rev:9, fp:"FP-1", state:b, chat:[]});
  var apres2 = window.__plan.plan.cells[0].name;
  // 3rd hello: NEW fingerprint, same rev as the previous one -> adoption.
  window.__plan.wsFeed({t:"hello", you:{email:"x@y", tag:"aaaaaa"}, peers:[], rev:9, fp:"FP-2", state:b, chat:[]});
  return { apres1: apres1, apres2: apres2, apres3: window.__plan.plan.cells[0].name, fp: window.__plan.wsFp };
`, (v: VerdictSonde) => expect(v.apres1 === "Venu du serveur", "1re empreinte : adoption attendue, vu " + v.apres1)
     && expect(v.apres2 === "Venu du serveur", "empreinte identique : AUCUNE adoption, vu " + v.apres2)
     && expect(v.apres3 === "JAMAIS adopté", "empreinte neuve : adoption attendue, vu " + v.apres3)
     && expect(v.fp === "FP-2", "l'empreinte retenue doit être la dernière annoncée : " + v.fp));

await test("le_compteur_du_repli_d1_reste_intact", seedV4(REAL_PLAN), `
  ${OUVRIR}
  var avant = window.__plan.serverRev;
  var w = window.__plan.wire();
  window.__plan.wsFeed({t:"hello", you:{email:"x@y"}, peers:[], rev:4242, fp:"FP-1", state:w, chat:[]});
  var apresHello = window.__plan.serverRev;
  window.__plan.wsFeed({t:"op", by:"b@example.com", rev:4243, fp:"FP-2",
    op:{kind:"cell.set", cellId:String(window.__plan.plan.cells[0].id), name:"Device B"}});
  return { avant: avant, apresHello: apresHello, apresOp: window.__plan.serverRev, fp: window.__plan.wsFp };
`, (v: VerdictSonde) => expect(v.apresHello === v.avant, "un hello ne doit PAS toucher le compteur D1 : " + v.avant + " -> " + v.apresHello)
     && expect(v.apresOp === v.avant, "une op ne doit PAS toucher le compteur D1 : " + v.avant + " -> " + v.apresOp)
     && expect(v.fp === "FP-2", "l'écho d'op porte l'empreinte : " + v.fp));

// =============================================================================
//  2. state / conflict / pong
// =============================================================================
await test("state_d1_adopt_est_adopte_et_annonce", seedV4(REAL_PLAN), `
  ${OUVRIR}
  var w = window.__plan.wire(); w.cells[0].name = "Repris de la coupure";
  window.__plan.clearToast();
  window.__plan.wsFeed({t:"state", state:w, rev:3, fp:"FP-D1", reason:"d1_adopt"});
  return { nom: window.__plan.plan.cells[0].name, fp: window.__plan.wsFp,
           toast: window.__plan.toastText,
           shadow: window.__plan.shadowOf("cells", String(window.__plan.plan.cells[0].id)) };
`, (v: VerdictSonde) => expect(v.nom === "Repris de la coupure", "l'état poussé doit être adopté : " + v.nom)
     && expect(v.fp === "FP-D1", "l'empreinte doit suivre : " + v.fp)
     && expect(!!v.toast && /link was down/i.test(v.toast), "un bandeau doit l'annoncer : " + v.toast)
     && expect(!/—/.test(v.toast || ""), "aucun tiret cadratin dans un texte visible")
     && expect(!!v.shadow && v.shadow.indexOf("Repris de la coupure") >= 0,
        "le miroir doit suivre l'état adopté : " + v.shadow));

await test("state_sync_est_adopte_sans_bandeau", seedV4(REAL_PLAN), `
  ${OUVRIR}
  var w = window.__plan.wire(); w.cells[0].name = "Resynchronisé";
  window.__plan.clearToast();
  window.__plan.wsFeed({t:"state", state:w, rev:3, fp:"FP-S", reason:"sync"});
  return { nom: window.__plan.plan.cells[0].name, toast: window.__plan.toastText };
`, (v: VerdictSonde) => expect(v.nom === "Resynchronisé", "un `sync` doit bien reposer l'état serveur : " + v.nom)
     && expect(v.toast === null, "une resynchro demandée par nous n'a rien à annoncer : " + v.toast));

await test("conflit_est_dit_en_francais", seedV4(REAL_PLAN), `
  ${OUVRIR}
  window.__plan.clearToast();
  window.__plan.wsFeed({t:"conflict", by:"b@example.com", at:"2026-08-04T10:00:00Z", bytes:9123, kept:"server"});
  var t = window.__plan.toastText;
  return { toast: t, plan: window.__plan.plan.cells.length };
`, (v: VerdictSonde) => expect(!!v.toast, "un conflit doit produire un bandeau")
     && expect(/merged/i.test(v.toast) && /server/i.test(v.toast),
        "le bandeau doit dire ce qui s'est passé et où sont les modifications : " + v.toast)
     && expect(!/—/.test(v.toast), "aucun tiret cadratin dans un texte visible")
     && expect(v.plan > 0, "un conflit ne touche pas au plan"));

await test("pong_desaccorde_demande_un_sync_une_fois", seedV4(REAL_PLAN), `
  ${OUVRIR}
  window.__plan.wsFeed({t:"hello", you:{email:"x@y"}, peers:[], rev:1, fp:"FP-1",
                        state:window.__plan.wire(), chat:[]});
  var L = window.__plan.outLog(true);                                  // LIVE log of outgoing messages
  var n = function(){ return L.filter(function(m){ return m.t==="sync"; }).length; };
  window.__plan.wsFeed({t:"pong", ts:Date.now(), fp:"FP-1"});          // in agreement: nothing
  var apresAccord = L.length;
  window.__plan.wsFeed({t:"pong", ts:Date.now(), fp:"FP-AUTRE"});       // disagreement: one sync
  var demande = n();
  // the server answers with a state: the fingerprint realigns, the next pong asks for nothing more
  window.__plan.wsFeed({t:"state", state:window.__plan.wire(), rev:2, fp:"FP-AUTRE", reason:"sync"});
  window.__plan.wsFeed({t:"pong", ts:Date.now(), fp:"FP-AUTRE"});
  var apresRecalage = n() - demande;
  window.__plan.outLog(false);
  return { apresAccord: apresAccord, demande: demande, apresRecalage: apresRecalage };
`, (v: VerdictSonde) => expect(v.apresAccord === 0, "un pong accordé ne doit rien envoyer : " + v.apresAccord)
     && expect(v.demande === 1, "un pong désaccordé doit demander UN sync : " + v.demande)
     && expect(v.apresRecalage === 0, "après le state de réponse, plus aucune demande (pas de boucle)"));

// =============================================================================
//  3. IDS THAT CANNOT COLLIDE
// =============================================================================
await test("identifiant_porte_l_etiquette_du_serveur", seedV4(REAL_PLAN), `
  window.__plan.wsFeed({t:"hello", you:{email:"x@y", tag:"a3f9c1"}, peers:[], rev:1, fp:"FP-1",
                        state:window.__plan.wire(), chat:[]});
  var w1 = window.__plan.newId("w"), w2 = window.__plan.newId("w"), o1 = window.__plan.newId("o");
  return { tag: window.__plan.deviceTag(), w1: w1, w2: w2, o1: o1,
           derive: window.__plan.newDerivedId("w"),
           murs: window.__plan.plan.walls.map(function(w){ return String(w.id); }) };
`, (v: VerdictSonde) => expect(v.tag === "a3f9c1", "l'étiquette du hello doit être adoptée : " + v.tag)
     && expect(/^w\d+-a3f9c1$/.test(v.w1), "forme attendue « w20-a3f9c1 », vu " + v.w1)
     && expect(/^o\d+-a3f9c1$/.test(v.o1), "forme attendue « o22-a3f9c1 », vu " + v.o1)
     && expect(v.w1 === v.w2, "sans insertion entre-temps, deux appels donnent le même prochain id")
     && expect(v.murs.indexOf(v.w1) < 0, "l'id neuf ne doit percuter aucun mur existant")
     && expect(/^w\d+$/.test(v.derive), "un id DÉRIVÉ (mur de façade) reste sans étiquette : " + v.derive));

await test("sans_serveur_l_etiquette_est_tiree_au_sort_et_figee", seedV4(REAL_PLAN), `
  var a = window.__plan.deviceTag();
  var b = window.__plan.deviceTag();
  var id = window.__plan.newId("w");
  var enSession = null; try { enSession = sessionStorage.getItem("plan-device-tag"); } catch(e){}
  // A hello ARRIVES AFTERWARD: the tag no longer changes (ids have already been handed out).
  window.__plan.wsFeed({t:"hello", you:{email:"x@y", tag:"zzzzzz"}, peers:[], rev:1, fp:"FP-1",
                        state:window.__plan.wire(), chat:[]});
  return { a: a, b: b, id: id, enSession: enSession, apres: window.__plan.deviceTag() };
`, (v: VerdictSonde) => expect(/^[a-z0-9]{4,8}$/.test(v.a), "étiquette de repli mal formée : " + v.a)
     && expect(v.a === v.b && v.a === v.apres, "l'étiquette est FIGÉE pour l'onglet : " + v.a + " / " + v.apres)
     && expect(v.enSession === v.a, "elle est gardée en sessionStorage : " + v.enSession)
     && expect(v.id.indexOf("-" + v.a) === v.id.length - v.a.length - 1, "l'id doit la porter : " + v.id));

// The server, for its part, validates: the manufactured id must pass ID_RE and be accepted by applyOp.
await test("l_identifiant_etiquete_est_accepte_par_le_serveur", seedV4(REAL_PLAN), `
  window.__plan.wsFeed({t:"hello", you:{email:"x@y", tag:"a3f9c1"}, peers:[], rev:1, fp:"FP-1",
                        state:window.__plan.wire(), chat:[]});
  return { id: window.__plan.newId("w"), etat: window.__plan.wire() };
`, (v: VerdictSonde) => {
  const plan = sanitizeState(v.etat);
  const apres = applyOp(JSON.parse(JSON.stringify(plan)),
    { kind: "wall.set", wall: { id: v.id, a: [10, 10], b: [10, 400], t: 10 } });
  return expect(v.id.length <= 80, "id trop long pour le serveur : " + v.id.length)
      && expect(apres.walls.some(w => w.id === v.id), "le serveur doit accepter " + v.id);
});

// =============================================================================
//  4. EMISSION BY FIELD-BY-FIELD DIFF
// =============================================================================
await test("emission_champ_a_champ_sur_un_meuble", seedV4(REAL_PLAN), `
  ${OUVRIR}
  var p = window.__plan.plan.pieces[0];
  window.__plan.opLog(true);
  p.name = "Renommé par Device A";
  window.__plan.forceDiff();
  var ops = window.__plan.opLog(false);
  return { ops: ops, id: String(p.id), etat: window.__plan.wire() };
`, (v: VerdictSonde) => {
  const ops = v.ops.filter((o: VerdictSonde) => o.kind === "piece.set");
  expect(ops.length === 1, "une seule op attendue, vu " + JSON.stringify(v.ops));
  const cles = Object.keys(ops[0].piece).sort();
  expect(JSON.stringify(cles) === JSON.stringify(["id", "name"]),
    "l'op ne doit porter que l'id et le champ modifié, vu " + JSON.stringify(cles));
  // Proof through the REAL server: the other person widens the same piece of furniture at the same
  // time; both changes must survive, whatever the arrival order.
  let plan = sanitizeState(v.etat);
  plan = applyOp(plan, { kind: "piece.set", piece: { id: v.id, w: 987 } } as unknown as Parameters<typeof applyOp>[1]);   // Device B
  plan = applyOp(plan, ops[0]);                                              // Device A
  const p = plan.pieces.find(x => x.id === v.id);
  return expect(p.name === "Renommé par Device A" && p.w === 987,
    "les deux champs doivent survivre : " + JSON.stringify(p));
});

await test("une_creation_envoie_l_entite_entiere", seedV4(REAL_PLAN), `
  ${OUVRIR}
  window.__plan.opLog(true);
  var p = window.__plan.addV5Piece("sofa3", 900, 400);
  var ops = window.__plan.opLog(false).filter(function(o){ return o.kind==="piece.set"; });
  return { cles: ops.length ? Object.keys(ops[0].piece).sort() : [], n: ops.length };
`, (v: VerdictSonde) => expect(v.n >= 1, "la pose d'un meuble doit émettre une op")
     && expect(["id","locked","name","rot","type","w","h","x","y"].every(k => v.cles.indexOf(k) >= 0),
        "une CRÉATION porte l'entité entière, vu " + JSON.stringify(v.cles)));

await test("une_op_partielle_recue_fusionne", seedV4(REAL_PLAN), `
  ${OUVRIR}
  var p = window.__plan.plan.pieces[0];
  var avant = {id:String(p.id), type:p.type, name:p.name, w:p.w, h:p.h, x:p.x, y:p.y};
  // The other device only moved the position: its op carries only x and y.
  window.__plan.wsFeed({t:"op", by:"b@example.com", rev:2, fp:"FP-2",
    op:{kind:"piece.set", piece:{id:avant.id, x:avant.x+40, y:avant.y+25}}});
  var q = window.__plan.plan.pieces.filter(function(e){ return String(e.id)===avant.id; })[0];
  return { avant: avant, apres: {type:q.type, name:q.name, w:q.w, h:q.h, x:q.x, y:q.y} };
`, (v: VerdictSonde) => expect(v.apres.x === v.avant.x + 40 && v.apres.y === v.avant.y + 25, "la position doit suivre")
     && expect(v.apres.type === v.avant.type && v.apres.name === v.avant.name
        && v.apres.w === v.avant.w && v.apres.h === v.avant.h,
        "les champs absents de l'op ne doivent PAS être effacés : " + JSON.stringify(v.apres)));

// =============================================================================
//  5. THE OUTGOING MIRROR DESCRIBES THE SERVER
// =============================================================================
await test("miroir_construit_sur_l_etat_du_serveur", seedV4(REAL_PLAN), `
  ${OUVRIR}
  // 1st hello: the server agrees with us, the fingerprint is retained.
  window.__plan.wsFeed({t:"hello", you:{email:"x@y"}, peers:[], rev:1, fp:"FP-1",
                        state:window.__plan.wire(), chat:[]});
  var w = window.__plan.wire();
  // 2nd hello (a reconnection): SAME fingerprint announced, so NO adoption. But the state it
  // describes is missing a wall: it's THAT one the mirror must reflect, not our local plan.
  var amputé = JSON.parse(JSON.stringify(w));
  var perdu = amputé.walls.pop();
  window.__plan.wsFeed({t:"hello", you:{email:"x@y"}, peers:[], rev:2, fp:"FP-1", state:amputé, chat:[]});
  var mirroir = window.__plan.shadowDump();
  if (window.__plan.plan.walls.filter(function(x){ return String(x.id)===String(perdu.id); }).length===0)
    return { __erreur: "le mur ne devait pas quitter le plan local (adoption inattendue)" };
  window.__plan.opLog(true);
  window.__plan.forceDiff();
  var ops = window.__plan.opLog(false);
  return { perdu: perdu.id, dansLeMiroir: mirroir.walls.indexOf(perdu.id) >= 0,
           ops: ops.map(function(o){ return o.kind + ":" + (o.wall? o.wall.id : ""); }),
           murComplet: (ops.filter(function(o){ return o.kind==="wall.set" && o.wall.id===perdu.id; })[0]||{}).wall };
`, (v: VerdictSonde) => expect(!v.__erreur, v.__erreur)
     && expect(v.dansLeMiroir === false, "le miroir ne doit PAS contenir un mur que le serveur n'a pas")
     && expect(!!v.murComplet, "le diff suivant doit rendre au serveur ce qui lui manque : " + JSON.stringify(v.ops))
     && expect(v.murComplet.a && v.murComplet.b && v.murComplet.t !== undefined,
        "et l'envoyer ENTIER (le serveur n'a rien à fusionner) : " + JSON.stringify(v.murComplet)));

// =============================================================================
//  6. FRESH HOUSEHOLD
// =============================================================================
await test("foyer_neuf_recoit_le_premier_plan", seedV4(REAL_PLAN), `
  ${OUVRIR}
  window.__plan.state.setupDone = true;
  window.__plan.outLog(true);
  // The server has nothing: an empty WALLS-ONLY plan.
  window.__plan.wsFeed({t:"hello", you:{email:"x@y"}, peers:[], rev:0, fp:"FP-VIDE",
    state:{outline:null, walls:[], openings:[], pieces:[], cells:[], setupDone:false}, chat:[]});
  var sorties = window.__plan.outLog(false);
  var rep = sorties.filter(function(m){ return m.t==="op" && m.op.kind==="plan5.replace"; });
  return { n: rep.length, murs: rep.length ? rep[0].op.plan.walls.length : 0,
           cells: rep.length ? rep[0].op.plan.cells.length : 0,
           autres: sorties.filter(function(m){ return m.t==="op" && m.op.kind!=="plan5.replace"; }).length,
           plan: rep.length ? rep[0].op.plan : null };
`, (v: VerdictSonde) => expect(v.n === 1, "un appareil déjà configuré doit publier son plan, UNE fois : " + v.n)
     && expect(v.autres === 0, "en UNE op atomique, pas en miettes : " + v.autres + " autres ops")
     && expect(v.murs > 0 && v.cells > 0, "le plan publié doit être complet")
     && expect(!!sanitizeState(v.plan), "et accepté par le validateur du serveur"));

await test("foyer_neuf_appareil_non_configure_ne_publie_rien", seedV4(REAL_PLAN), `
  ${OUVRIR}
  window.__plan.state.setupDone = false;
  window.__plan.outLog(true);
  window.__plan.wsFeed({t:"hello", you:{email:"x@y"}, peers:[], rev:0, fp:"FP-VIDE",
    state:{outline:null, walls:[], openings:[], pieces:[], cells:[], setupDone:false}, chat:[]});
  return { ops: window.__plan.outLog(false).filter(function(m){ return m.t==="op"; }).length };
`, (v: VerdictSonde) => expect(v.ops === 0, "un appareil qui n'a jamais été configuré n'a rien à publier : " + v.ops));

// =============================================================================
//  7. UNDO ONLY UNDOES ITS OWN AUTHOR'S WORK
// =============================================================================
// The case proven broken by duo/s3-annuler.ts: one household member makes a change, the other
// makes a different change, the first one hits Ctrl+Z. Before, the first one's snapshot (which
// knows nothing about the second's change) used to go back out as `plan5.replace` and erase the
// other person's work ON BOTH SCREENS.
const SCENARIO_S3 = `
  ${OUVRIR}
  var P = window.__plan.plan;
  var cS = P.cells[0], cE = P.cells[1];
  var pE = P.pieces[0];
  var depart = { nomS: cS.name, nomE: cE.name, xE: pE.x, yE: pE.y };
  // 1. Device A renames THEIR room (user path: pushHistory then mutation).
  window.__plan.pushHistory();
  window.__plan.setCell(String(cS.id), "Bureau de Device A");
  // 2. Device B, meanwhile, renames a DIFFERENT room and moves a piece of furniture.
  window.__plan.wsFeed({t:"op", by:"b@example.com", rev:2, fp:"FP-2",
    op:{kind:"cell.set", cellId:String(cE.id), name:"Cuisine de Device B"}});
  window.__plan.wsFeed({t:"op", by:"b@example.com", rev:3, fp:"FP-3",
    op:{kind:"piece.set", piece:{id:String(pE.id), x:depart.xE+70, y:depart.yE+40}}});
`;

await test("annuler_ne_detruit_pas_le_travail_de_l_autre", seedV4(REAL_PLAN), `
  ${SCENARIO_S3}
  var P0 = window.__plan.plan;
  var idS = String(P0.cells[0].id), idE = String(P0.cells[1].id), idP = String(P0.pieces[0].id);
  var nomAvant = P0.cells[0].name;
  var depart = { xE: P0.pieces[0].x - 70, yE: P0.pieces[0].y - 40 };
  window.__plan.opLog(true);
  window.__plan.undo();
  var ops = window.__plan.opLog(false);
  // WATCH OUT: \`undo\` replaces the state object. We reread the LIVE plan, never the earlier reference.
  var P = window.__plan.plan;
  var f = function(id){ return P.cells.filter(function(c){ return String(c.id)===id; })[0]; };
  var q = P.pieces.filter(function(e){ return String(e.id)===idP; })[0];
  return {
    nomAvant: nomAvant,
    nomAApres: f(idS).name,
    nomBApres: f(idE).name,
    posBApres: { x:q.x, y:q.y },
    posBAttendue: { x:depart.xE+70, y:depart.yE+40 },
    kinds: ops.map(function(o){ return o.kind; }),
    cellsTouchees: ops.filter(function(o){ return o.kind==="cell.set"; }).map(function(o){ return String(o.cellId); }),
    piecesTouchees: ops.filter(function(o){ return o.kind==="piece.set"; }).map(function(o){ return String(o.piece.id); }),
    idS: idS, idE: idE, idP: idP
  };
`, (v: VerdictSonde) => expect(v.nomAApres !== "Bureau de Device A", "Ctrl+Z doit annuler la modification de son auteur : " + v.nomAApres)
     && expect(v.nomBApres === "Cuisine de Device B", "le RENOMMAGE de Device B doit survivre : " + v.nomBApres)
     && expect(v.posBApres.x === v.posBAttendue.x && v.posBApres.y === v.posBAttendue.y,
        "le MEUBLE déplacé par Device B doit survivre : " + JSON.stringify(v.posBApres) + " au lieu de " + JSON.stringify(v.posBAttendue))
     && expect(v.kinds.indexOf("plan5.replace") < 0,
        "une annulation ne publie plus un plan ENTIER : " + JSON.stringify(v.kinds))
     && expect(v.cellsTouchees.indexOf(v.idE) < 0,
        "aucune op ne doit toucher la pièce renommée par Device B : " + JSON.stringify(v.cellsTouchees))
     && expect(v.piecesTouchees.indexOf(v.idP) < 0,
        "aucune op ne doit toucher le meuble déplacé par Device B : " + JSON.stringify(v.piecesTouchees))
     && expect(v.cellsTouchees.indexOf(v.idS) >= 0,
        "mais l'annulation DOIT être publiée pour ce qui est à son auteur : " + JSON.stringify(v.cellsTouchees)));

await test("retablir_suit_la_meme_regle", seedV4(REAL_PLAN), `
  ${SCENARIO_S3}
  var P0 = window.__plan.plan;
  var idS = String(P0.cells[0].id), idE = String(P0.cells[1].id), idP = String(P0.pieces[0].id);
  var attendu = { x: P0.pieces[0].x, y: P0.pieces[0].y };
  window.__plan.undo();
  window.__plan.opLog(true);
  window.__plan.redo();
  var ops = window.__plan.opLog(false);
  var P = window.__plan.plan;
  var f = function(id){ return P.cells.filter(function(c){ return String(c.id)===id; })[0]; };
  var q = P.pieces.filter(function(e){ return String(e.id)===idP; })[0];
  return { nomA: f(idS).name, nomB: f(idE).name, pos: {x:q.x, y:q.y}, attendu: attendu,
           kinds: ops.map(function(o){ return o.kind; }) };
`, (v: VerdictSonde) => expect(v.nomA === "Bureau de Device A", "Rétablir doit reposer la modification de son auteur : " + v.nomA)
     && expect(v.nomB === "Cuisine de Device B", "le travail de Device B survit aussi au Rétablir : " + v.nomB)
     && expect(v.pos.x === v.attendu.x && v.pos.y === v.attendu.y,
        "et son meuble ne recule pas : " + JSON.stringify(v.pos))
     && expect(v.kinds.indexOf("plan5.replace") < 0, "toujours par diff : " + JSON.stringify(v.kinds)));

await test("annuler_hors_ligne_reste_une_annulation_complete", seedV4(REAL_PLAN), `
  // No wire open: no remote op, undo must behave like before.
  var P = window.__plan.plan;
  var c = P.cells[0], nom0 = c.name;
  window.__plan.pushHistory();
  window.__plan.setCell(String(c.id), "Essai");
  var pendant = window.__plan.plan.cells[0].name;
  window.__plan.undo();
  return { nom0: nom0, pendant: pendant, apres: window.__plan.plan.cells[0].name,
           hist: window.__plan.histInfo() };
`, (v: VerdictSonde) => expect(v.pendant === "Essai", "la modification doit d'abord avoir lieu")
     && expect(v.apres === v.nom0, "l'annulation hors ligne doit tout rendre : " + v.apres)
     && expect(v.hist.log === 0, "aucun op distant journalisé hors ligne : " + JSON.stringify(v.hist)));

await test("un_remplacement_global_distant_vide_l_historique", seedV4(REAL_PLAN), `
  ${OUVRIR}
  var c = window.__plan.plan.cells[0];
  window.__plan.pushHistory();
  window.__plan.setCell(String(c.id), "Avant l'import de Device B");
  var avant = window.__plan.histInfo();
  var w = window.__plan.wire(); w.cells[0].name = "Plan importé par Device B";
  window.__plan.wsFeed({t:"op", by:"b@example.com", rev:9, fp:"FP-9",
                        op:{kind:"plan5.replace", plan:w}});
  return { avant: avant, apres: window.__plan.histInfo(),
           bouton: document.getElementById("btnUndo").disabled };
`, (v: VerdictSonde) => expect(v.avant.undo >= 1, "l'historique doit d'abord être garni : " + JSON.stringify(v.avant))
     && expect(v.apres.undo === 0 && v.apres.log === 0,
        "un plan5.replace distant rend les instantanés caducs : " + JSON.stringify(v.apres))
     && expect(v.bouton === true, "et le bouton Annuler doit le dire"));

// =============================================================================
//  8. CLAMPING BELONGS TO THE AUTHOR OF THE GESTURE
// =============================================================================
// Measured with two browsers: one device pushes a wall, the other touches nothing, and 1 to 4
// pieces of furniture end up at different coordinates on the two screens, permanently (27cm of
// drift for a wall pushed 180cm). Cause: the author clamps ONCE on the final geometry, the
// receiver used to re-clamp on EVERY `wall.set` received, so across every intermediate geometry.
await test("recevoir_un_mur_ne_deplace_aucun_meuble", seedV4(REAL_PLAN), `
  ${OUVRIR}
  var P = window.__plan.plan;
  var mur = P.walls.filter(function(w){ return !w.isOutline; })[0];
  var id = String(mur.id);
  var a0 = mur.a.slice(), b0 = mur.b.slice();          // STARTING coordinates, frozen
  var avant = P.pieces.map(function(p){ return String(p.id)+":"+p.x+","+p.y; });
  // The peer pushes this wall, in three successive ops the way the diff emitter does it.
  for (var k=1;k<=3;k++){
    window.__plan.wsFeed({t:"op", by:"b@example.com", rev:k, fp:"FP-"+k,
      op:{kind:"wall.set", wall:{id:id, a:[a0[0]-k*60, a0[1]], b:[b0[0]-k*60, b0[1]]}}});
  }
  var Q = window.__plan.plan;
  var apres = Q.pieces.map(function(p){ return String(p.id)+":"+p.x+","+p.y; });
  var bouges = apres.filter(function(s,i){ return s!==avant[i]; });
  return { bouges: bouges.slice(0,5), n: bouges.length,
           murBouge: Q.walls.filter(function(w){ return String(w.id)===id; })[0].a[0] === a0[0]-180 };
`, (v: VerdictSonde) => expect(v.murBouge === true, "le mur reçu doit bien avoir bougé")
     && expect(v.n === 0, "aucun meuble ne doit bouger sur le chemin de RÉCEPTION : " + JSON.stringify(v.bouges)));

await test("un_meuble_deplace_par_l_auteur_suit_quand_meme", seedV4(REAL_PLAN), `
  ${OUVRIR}
  var p = window.__plan.plan.pieces[0];
  var cible = {x:p.x-33, y:p.y-21};
  window.__plan.wsFeed({t:"op", by:"b@example.com", rev:1, fp:"FP-1",
    op:{kind:"piece.set", piece:{id:String(p.id), x:cible.x, y:cible.y}}});
  var q = window.__plan.plan.pieces.filter(function(e){ return String(e.id)===String(p.id); })[0];
  return { x:q.x, y:q.y, cible:cible };
`, (v: VerdictSonde) => expect(v.x === v.cible.x && v.y === v.cible.y,
        "le bornage de l'AUTEUR, lui, voyage par op et s'applique tel quel : "
        + JSON.stringify({x:v.x,y:v.y}) + " au lieu de " + JSON.stringify(v.cible)));

// =============================================================================
//  9. NOTHING VANISHES FROM UNDER YOUR HAND WITHOUT A WORD
// =============================================================================
await test("un_meuble_selectionne_supprime_par_l_autre_le_dit", seedV4(REAL_PLAN), `
  ${OUVRIR}
  var p = window.__plan.plan.pieces[0];
  window.__plan.selReplace(String(p.id));
  window.__plan.clearToast();
  window.__plan.wsFeed({t:"op", by:"b@example.com", rev:1, fp:"FP-1",
    op:{kind:"piece.del", pieceId:String(p.id)}});
  return { reste: window.__plan.plan.pieces.filter(function(e){ return String(e.id)===String(p.id); }).length,
           toast: window.__plan.toastText, sel: window.__plan.selCount };
`, (v: VerdictSonde) => expect(v.reste === 0, "le meuble doit bien disparaître")
     && expect(v.sel === 0, "et sortir de la sélection")
     && expect(!!v.toast && /deleted/i.test(v.toast), "et un bandeau doit le dire : " + v.toast)
     && expect(!/—/.test(v.toast || ""), "aucun tiret cadratin dans un texte visible"));

await test("un_meuble_non_selectionne_supprime_ne_dit_rien", seedV4(REAL_PLAN), `
  ${OUVRIR}
  var p = window.__plan.plan.pieces[1];
  window.__plan.clearSel();
  window.__plan.clearToast();
  window.__plan.wsFeed({t:"op", by:"b@example.com", rev:1, fp:"FP-1",
    op:{kind:"piece.del", pieceId:String(p.id)}});
  return { toast: window.__plan.toastText };
`, (v: VerdictSonde) => expect(v.toast === null, "un meuble qui n'était pas sous la main ne mérite pas de bandeau : " + v.toast));

// =============================================================================
//  10. BANNERS DO NOT SHOUT THE SAME THING TWICE
// =============================================================================
await test("un_message_identique_est_etrangle", seedV4(REAL_PLAN), `
  var vus = [];
  for (var i=0;i<6;i++) vus.push(window.__plan.showToast("Tapis 17 est plus grand que la pièce."));
  var autre = window.__plan.showToast("Un contour a besoin d'au moins 3 angles.");
  // Two ALTERNATING messages must not relaunch each other.
  var alterne = [];
  for (var j=0;j<4;j++){
    alterne.push(window.__plan.showToast("Tapis 17 est plus grand que la pièce."));
    alterne.push(window.__plan.showToast("Un contour a besoin d'au moins 3 angles."));
  }
  return { vus: vus, autre: autre, alterne: alterne };
`, (v: VerdictSonde) => expect(v.vus[0] === true, "la première fois passe toujours")
     && expect(v.vus.filter(Boolean).length === 1,
        "six fois la même phrase d'affilée ne doit s'afficher qu'une fois : " + JSON.stringify(v.vus))
     && expect(v.autre === true, "un message DIFFÉRENT passe devant sans délai")
     && expect(v.alterne.every((x: VerdictSonde) => x === false),
        "deux messages qui alternent ne se relancent pas : " + JSON.stringify(v.alterne)));

// =============================================================================
//  11. A FACADE DOES NOT GET DELETED, NO MATTER WHERE THE ORDER COMES FROM
// =============================================================================
// Measured with two browsers (duo2 / v2-r4b): when the other person deleted a FACADE, the wall
// stayed standing here (it's DERIVED from the outline, v5SyncOutlineWalls recreates it right
// away) but its openings left for good, and the state got saved as-is: 6 objects lost
// (3 windows, 3 wall lights) in a single op, without a word. The local UI already refused this
// deletion (js/53); it's the REMOTE path that complied. Three branches to distinguish:
// facade (refusal + republishing), interior partition (normal deletion), absent wall (silence).
const FACADE_GARNIE = `
  var P = window.__plan.plan;
  var f = P.walls.filter(function(w){ return w.isOutline
    && (P.openings||[]).some(function(o){ return String(o.wallId)===String(w.id); }); })[0];
  var id = String(f.id);
  var ouv = (P.openings||[]).filter(function(o){ return String(o.wallId)===id; }).map(function(o){ return String(o.id); });
`;
const compteOuv = `function(id){ return (window.__plan.plan.openings||[])
    .filter(function(o){ return String(o.wallId)===String(id); }).length; }`;

await test("les_trois_verdicts_de_suppression_de_mur", seedV4(REAL_PLAN), `
  var P = window.__plan.plan;
  var fac = P.walls.filter(function(w){ return w.isOutline; })[0];
  var int = P.walls.filter(function(w){ return !w.isOutline; })[0];
  return { facade: window.__plan.wallDeleteVerdict(String(fac.id)),
           cloison: window.__plan.wallDeleteVerdict(String(int.id)),
           absent: window.__plan.wallDeleteVerdict("w-jamais-vu"),
           canFacade: window.__plan.canDeleteWall(String(fac.id)),
           canCloison: window.__plan.canDeleteWall(String(int.id)) };
`, (v: VerdictSonde) => expect(v.facade === "facade", "un mur de façade se refuse : " + v.facade)
     && expect(v.cloison === "ok", "une cloison intérieure se supprime : " + v.cloison)
     && expect(v.absent === "absent", "un mur inconnu n'est pas un refus, il n'est plus là : " + v.absent)
     && expect(v.canFacade === false && v.canCloison === true, "et l'interface locale lit le même verdict"));

await test("facade_supprimee_a_distance_garde_ses_ouvertures", seedV4(REAL_PLAN), `
  ${OUVRIR}
  ${FACADE_GARNIE}
  var n = (${compteOuv});
  var avant = n(id);
  window.__plan.clearToast();
  window.__plan.wsFeed({t:"op", by:"b@example.com", rev:1, fp:"FP-1",
                        op:{kind:"wall.del", wallId:id}});
  var stocke = -1;
  try { var s = JSON.parse(localStorage.getItem("room-planner-v4"));
        stocke = (s.plan.openings||[]).filter(function(o){ return String(o.wallId)===id; }).length; } catch(e){}
  return { id:id, avant:avant, apres:n(id), stocke:stocke,
           mur: window.__plan.plan.walls.filter(function(w){ return String(w.id)===id; }).length,
           toast: window.__plan.toastText };
`, (v: VerdictSonde) => expect(v.avant >= 3, "le décor doit bien porter des ouvertures sur cette façade : " + v.avant)
     && expect(v.mur === 1, "la façade reste (elle est de toute façon recréée depuis le contour)")
     && expect(v.apres === v.avant, "et ses ouvertures aussi : " + v.apres + " au lieu de " + v.avant)
     && expect(v.stocke === v.avant, "l'état ENREGISTRÉ les garde également : " + v.stocke)
     && expect(!!v.toast && /facade/i.test(v.toast), "un bandeau doit le dire : " + v.toast)
     && expect(!/—/.test(v.toast || ""), "aucun tiret cadratin dans un texte visible"));

// Keeping it locally is not enough: the server, for its part, has cascaded the deletion. Without
// republishing, the preservation would only hold until the first F5 (the hello would adopt the
// amputated plan) and the other person would never see their windows again. The divergence gets
// resolved FROM THE TOP, in a single batch.
await test("la_facade_conservee_est_republiee_vers_le_pair", seedV4(REAL_PLAN), `
  ${OUVRIR}
  ${FACADE_GARNIE}
  var etat = window.__plan.wire();
  window.__plan.opLog(true);
  window.__plan.wsFeed({t:"op", by:"b@example.com", rev:1, fp:"FP-1",
                        op:{kind:"wall.del", wallId:id}});
  var ops = window.__plan.opLog(false);
  var murs = ops.filter(function(o){ return o.kind==="wall.set"; });
  var ouvOps = ops.filter(function(o){ return o.kind==="opening.set"; });
  return { id:id, ouv:ouv, etat:etat, ops:ops, kinds: ops.map(function(o){ return o.kind; }),
           murs: murs.map(function(o){ return String(o.wall.id); }),
           murEntier: murs.filter(function(o){ return String(o.wall.id)===id; })
                          .map(function(o){ return !!(o.wall.a && o.wall.b && o.wall.t); })[0],
           ouvertures: ouvOps.map(function(o){ return String(o.opening.id); }),
           ouvEntieres: ouvOps.filter(function(o){ return String(o.opening.wallId)===id; })
                              .every(function(o){ return !!o.opening.type && o.opening.t0!==undefined; }) };
`, (v: VerdictSonde) => {
  // The server's REAL validator, on the REAL amputated plan: the peer must recover everything.
  let srv = sanitizeState(v.etat);
  srv = applyOp(srv, { kind: "wall.del", wallId: v.id });                 // what the server did
  expect(!srv.walls.some(w => w.id === v.id), "le serveur a bien supprimé le mur");
  expect(!srv.openings.some(o => o.wallId === v.id), "et cascadé ses ouvertures");
  v.ops.forEach((op: VerdictSonde) => { srv = applyOp(srv, op); });                       // our correction
  return expect(v.murs.indexOf(v.id) >= 0, "le mur conservé doit repartir vers le serveur : " + JSON.stringify(v.murs))
      && expect(v.murEntier === true, "et en ENTIER (le serveur ne le connaît plus, c'est une création)")
      && expect(v.ouv.every((o: VerdictSonde) => v.ouvertures.indexOf(o) >= 0),
         "chaque ouverture doit repartir : " + JSON.stringify(v.ouvertures) + " pour " + JSON.stringify(v.ouv))
      && expect(v.ouvEntieres === true, "et en entier elles aussi")
      && expect(v.kinds.indexOf("plan5.replace") < 0, "par diff, jamais par plan entier : " + JSON.stringify(v.kinds))
      && expect(v.kinds.indexOf("wall.del") < 0, "et sans réémettre la suppression : " + JSON.stringify(v.kinds))
      && expect(srv.walls.some(w => w.id === v.id), "après nos ops, le serveur retrouve la façade")
      && expect(v.ouv.every((o: VerdictSonde) => srv.openings.some(x => x.id === o)),
         "et chacune de ses ouvertures : " + JSON.stringify(srv.openings.filter(x => x.wallId === v.id).map(x => x.id)));
});

await test("une_cloison_interieure_supprimee_a_distance_part_bien", seedV4(REAL_PLAN), `
  ${OUVRIR}
  var P = window.__plan.plan;
  var w = P.walls.filter(function(x){ return !x.isOutline
    && (P.openings||[]).some(function(o){ return String(o.wallId)===String(x.id); }); })[0];
  var id = String(w.id);
  var n = (${compteOuv});
  var avant = n(id);
  window.__plan.clearToast();
  window.__plan.wsFeed({t:"op", by:"b@example.com", rev:1, fp:"FP-1",
                        op:{kind:"wall.del", wallId:id}});
  return { avant:avant, apres:n(id), toast: window.__plan.toastText,
           mur: window.__plan.plan.walls.filter(function(x){ return String(x.id)===id; }).length };
`, (v: VerdictSonde) => expect(v.avant >= 1, "le décor doit porter des ouvertures sur cette cloison : " + v.avant)
     && expect(v.mur === 0, "une cloison intérieure supprimée par l'autre disparaît bien")
     && expect(v.apres === 0, "avec ses ouvertures en cascade, comme le serveur : " + v.apres)
     && expect(v.toast === null, "et sans bandeau : rien d'anormal ici (" + v.toast + ")"));

// The ORDINARY case of a shrunk outline: `outline.set` goes out BEFORE `wall.del` (js/42), so by
// the time the wall.del arrives our v5SyncOutlineWalls has already removed the extra facade.
// "Absent" is not "refused": conflating the two would cry refusal over a deletion already done.
await test("un_mur_deja_parti_ne_declenche_aucun_bandeau", seedV4(REAL_PLAN), `
  ${OUVRIR}
  window.__plan.clearToast();
  window.__plan.opLog(true);
  window.__plan.wsFeed({t:"op", by:"b@example.com", rev:1, fp:"FP-1",
                        op:{kind:"wall.del", wallId:"w-jamais-vu"}});
  return { toast: window.__plan.toastText, kinds: window.__plan.opLog(false).map(function(o){ return o.kind; }) };
`, (v: VerdictSonde) => expect(v.toast === null, "aucun bandeau pour un mur qui n'est déjà plus là : " + v.toast)
     && expect(v.kinds.length === 0, "et rien à republier : " + JSON.stringify(v.kinds)));

// The CASCADE itself is UNCONDITIONAL, exactly like on the server side (`live-worker/ops.ts`:
// `wall.del` filters the openings without checking whether the wall existed). Race measured on
// the two-browser bench (duo/s2c): one deletes a wall while the other places a window on it. The
// server discards the window; if the client only cascades when the wall is still there, the
// placer keeps a window hanging off a wall that no longer exists anywhere.
await test("un_wall_del_cascade_meme_quand_le_mur_manque_deja", seedV4(REAL_PLAN), `
  ${OUVRIR}
  var mur = window.__plan.plan.walls.filter(function(w){ return !w.isOutline; })[0];
  var id = String(mur.id);
  // We first delete the wall (ordinary op), THEN a window arrives on it (order reversed by
  // latency), THEN the deletion is replayed: nothing must be left hanging.
  window.__plan.wsFeed({t:"op", by:"b@example.com", rev:1, fp:"F1", op:{kind:"wall.del", wallId:id}});
  window.__plan.wsFeed({t:"op", by:"b@example.com", rev:2, fp:"F2",
    op:{kind:"opening.set", opening:{id:"o-tardive", wallId:id, t0:20, w:80, h:120, type:"window", side:0, name:"Fenêtre"}}});
  var orpheline = (window.__plan.plan.openings||[]).filter(function(o){ return String(o.id)==="o-tardive"; }).length;
  window.__plan.clearToast();
  window.__plan.wsFeed({t:"op", by:"b@example.com", rev:3, fp:"F3", op:{kind:"wall.del", wallId:id}});
  return { orpheline: orpheline, toast: window.__plan.toastText,
           reste: (window.__plan.plan.openings||[]).filter(function(o){ return String(o.wallId)===id; }).length,
           mur: window.__plan.plan.walls.filter(function(w){ return String(w.id)===id; }).length };
`, (v: VerdictSonde) => expect(v.orpheline === 1, "la fenêtre en retard s'installe bien (c'est la course à reproduire)")
     && expect(v.mur === 0, "le mur, lui, reste supprimé")
     && expect(v.reste === 0, "et la cascade la ramasse même si le mur manquait déjà : " + v.reste)
     && expect(v.toast === null, "sans bandeau : rien d'anormal ici (" + v.toast + ")"));

// THE CASCADE ARRIVES IN TWO STAGES. The diff emitter doesn't know about the server's cascade:
// when the facade disappears from ITS plan along with its openings, it sends `wall.del` THEN one
// `opening.del` per opening (measured: 1 + 6). Refusing the wall without refusing the rest would
// save nothing at all.
await test("la_cascade_des_ouvertures_est_refusee_aussi", seedV4(REAL_PLAN), `
  ${OUVRIR}
  ${FACADE_GARNIE}
  var n = (${compteOuv});
  var avant = n(id);
  var etat = window.__plan.wire();
  window.__plan.opLog(true);
  window.__plan.wsFeed({t:"op", by:"b@example.com", rev:1, fp:"F1",
                        op:{kind:"wall.del", wallId:id}});
  var apresMur = n(id);
  ouv.forEach(function(oid, i){
    window.__plan.wsFeed({t:"op", by:"b@example.com", rev:2+i, fp:"F"+(2+i),
                          op:{kind:"opening.del", openingId:oid}}); });
  var ops = window.__plan.opLog(false);
  var stocke = -1;
  try { var s = JSON.parse(localStorage.getItem("room-planner-v4"));
        stocke = (s.plan.openings||[]).filter(function(o){ return String(o.wallId)===id; }).length; } catch(e){}
  return { id:id, ouv:ouv, avant:avant, apresMur:apresMur, apres:n(id), stocke:stocke, etat:etat, ops:ops,
           mur: window.__plan.plan.walls.filter(function(w){ return String(w.id)===id; }).length };
`, (v: VerdictSonde) => {
  let srv = sanitizeState(v.etat);
  srv = applyOp(srv, { kind: "wall.del", wallId: v.id });
  v.ouv.forEach((o: VerdictSonde) => { srv = applyOp(srv, { kind: "opening.del", openingId: o }); });
  v.ops.forEach((op: VerdictSonde) => { srv = applyOp(srv, op); });
  return expect(v.avant >= 3, "décor : la façade doit porter des ouvertures (" + v.avant + ")")
      && expect(v.apresMur === v.avant, "le wall.del seul ne doit rien emporter : " + v.apresMur)
      && expect(v.apres === v.avant,
         "la CASCADE d'opening.del non plus : " + v.apres + " au lieu de " + v.avant)
      && expect(v.mur === 1, "et la façade est toujours là")
      && expect(v.stocke === v.avant, "l'état ENREGISTRÉ les garde : " + v.stocke)
      && expect(srv.walls.some(w => w.id === v.id) && v.ouv.every((o: VerdictSonde) => srv.openings.some(x => x.id === o)),
         "et le plan du serveur, rejoué à travers son propre validateur, retrouve tout : "
         + JSON.stringify(srv.openings.filter(x => x.wallId === v.id).map(x => x.id)));
});

// The protection is SURGICAL: it targets the consequence of a refusal, not facade openings in
// general. Deleting a single window remains an ordinary gesture, in both directions.
await test("supprimer_une_seule_fenetre_de_facade_reste_possible", seedV4(REAL_PLAN), `
  ${OUVRIR}
  ${FACADE_GARNIE}
  var n = (${compteOuv});
  var avant = n(id);
  window.__plan.clearToast();
  window.__plan.wsFeed({t:"op", by:"b@example.com", rev:1, fp:"F1",
                        op:{kind:"opening.del", openingId:ouv[0]}});
  var seule = n(id);
  // And after a refusal, each id is spared ONLY ONCE: the next deliberate gesture goes through.
  window.__plan.wsFeed({t:"op", by:"b@example.com", rev:2, fp:"F2", op:{kind:"wall.del", wallId:id}});
  window.__plan.wsFeed({t:"op", by:"b@example.com", rev:3, fp:"F3", op:{kind:"opening.del", openingId:ouv[1]}});
  var refuse = n(id);
  window.__plan.wsFeed({t:"op", by:"b@example.com", rev:4, fp:"F4", op:{kind:"opening.del", openingId:ouv[1]}});
  return { avant:avant, seule:seule, refuse:refuse, ensuite:n(id), toast: window.__plan.toastText };
`, (v: VerdictSonde) => expect(v.seule === v.avant - 1, "une fenêtre supprimée par l'autre part bien : " + v.seule)
     && expect(v.refuse === v.avant - 1, "la cascade d'un refus, elle, est écartée : " + v.refuse)
     && expect(v.ensuite === v.avant - 2,
        "mais la MÊME ouverture supprimée volontairement ensuite part : " + v.ensuite));

// The guard must exist in THREE places: the wire (js/43), the undo journal (js/44, which
// doesn't log a refused op) and the replay itself (js/27). Without the last two, receiving
// would preserve the facade fine, then the first Ctrl+Z would replay the peer's op onto
// the snapshot and make the same openings disappear again, this time for good
// (the restored snapshot is then published by diff).
await test("annuler_ne_refait_pas_disparaitre_les_ouvertures_d_une_facade", seedV4(REAL_PLAN), `
  ${OUVRIR}
  ${FACADE_GARNIE}
  var n = (${compteOuv});
  var avant = n(id);
  var cid = String(P.cells[0].id);
  window.__plan.pushHistory();
  window.__plan.setCell(cid, "Bureau de Device A");
  window.__plan.wsFeed({t:"op", by:"b@example.com", rev:2, fp:"FP-2",
                        op:{kind:"wall.del", wallId:id}});
  ouv.forEach(function(oid, i){
    window.__plan.wsFeed({t:"op", by:"b@example.com", rev:3+i, fp:"FP-"+(3+i),
                          op:{kind:"opening.del", openingId:oid}}); });
  var journal = window.__plan.histInfo();
  window.__plan.undo();
  var Q = window.__plan.plan;
  return { avant:avant, apres:n(id), journal:journal,
           mur: Q.walls.filter(function(w){ return String(w.id)===id; }).length,
           nom: Q.cells.filter(function(c){ return String(c.id)===cid; })[0].name };
`, (v: VerdictSonde) => expect(v.journal.undo >= 1, "l'historique doit être garni : " + JSON.stringify(v.journal))
     && expect(v.journal.log === 0,
        "une op REFUSÉE n'entre pas au journal des ops des pairs : " + JSON.stringify(v.journal))
     && expect(v.nom !== "Bureau de Device A", "l'annulation doit avoir eu lieu : " + v.nom)
     && expect(v.mur === 1, "la façade est toujours là après le rejeu")
     && expect(v.apres === v.avant,
        "et ses ouvertures ne repassent pas par la trappe : " + v.apres + " au lieu de " + v.avant));

// Belt and braces: `histApplyOp` (js/27) works on a DATA plan, not on `state.plan`. So it reads
// the verdict on THAT plan, and a snapshot's `isOutline` flag can describe a stale outline: it's
// GEOMETRY that decides. An `outline.set` replayed just before may have removed the edge that
// carried this wall, and it then has to be deleted for good.
await test("le_rejeu_d_annulation_tranche_sur_le_contour_du_moment", seedV4(REAL_PLAN), `
  var mk = function(){ return { outline:[[0,0],[400,0],[400,300],[0,300]],
    walls:[{id:"wf", a:[0,0], b:[400,0], t:10, isOutline:true},
           {id:"wi", a:[100,0], b:[100,300], t:7, isOutline:false}],
    openings:[{id:"of", wallId:"wf", t0:50, w:120, h:140, type:"window", side:0, name:"Fenêtre"},
              {id:"oi", wallId:"wi", t0:20, w:80, h:200, type:"door", side:0, name:"Porte"}],
    pieces:[], cells:[] }; };
  var A = window.__plan.histApplyOp(mk(), {kind:"wall.del", wallId:"wf"});
  var B = window.__plan.histApplyOp(mk(), {kind:"wall.del", wallId:"wi"});
  // The outline shrank first: the wall is no longer a facade, it MUST leave along with its openings.
  var C = mk();
  window.__plan.histApplyOp(C, {kind:"outline.set", outline:[[0,60],[400,60],[400,300],[0,300]]});
  window.__plan.histApplyOp(C, {kind:"wall.del", wallId:"wf"});
  return { facadeMur: A.walls.map(function(w){ return w.id; }), facadeOuv: A.openings.map(function(o){ return o.id; }),
           cloisonMur: B.walls.map(function(w){ return w.id; }), cloisonOuv: B.openings.map(function(o){ return o.id; }),
           retreciMur: C.walls.map(function(w){ return w.id; }), retreciOuv: C.openings.map(function(o){ return o.id; }) };
`, (v: VerdictSonde) => expect(v.facadeMur.indexOf("wf") >= 0 && v.facadeOuv.indexOf("of") >= 0,
        "une façade et sa fenêtre survivent au rejeu : " + JSON.stringify(v.facadeMur) + JSON.stringify(v.facadeOuv))
     && expect(v.cloisonMur.indexOf("wi") < 0 && v.cloisonOuv.indexOf("oi") < 0,
        "une cloison intérieure part, avec sa porte : " + JSON.stringify(v.cloisonMur) + JSON.stringify(v.cloisonOuv))
     && expect(v.retreciMur.indexOf("wf") < 0 && v.retreciOuv.indexOf("of") < 0,
        "contour rétréci d'abord : le mur n'est plus sur le contour, il part : "
        + JSON.stringify(v.retreciMur) + JSON.stringify(v.retreciOuv)));

// A4. AN OPENING LOST TO A PEER'S FACADE CASCADE MUST SAY SO AT RECEIPT, NOT ON THE NEXT LOCAL
// GESTURE. `v5SyncOutlineWalls` (called on every geometric remote op, section 11 above) shares
// its slate (`ardoiseBorned`, modele/edition.ts) with a LOCAL gesture's own clamping: left
// unflushed on the receive path, an opening orphaned by a peer's outline shrink sat there until
// whatever LOCAL gesture ran next flushed it, and the banner landed on the wrong screen. Same
// defect furniture already had (`v5NoteForeignOrphans`, section 11's neighbourhood), fixed the
// same way: flush and say so RIGHT HERE, on receipt (`fil/reception.ts:282`).
await test("une_facade_orphelinee_a_distance_le_dit_tout_de_suite", seedV4({
  outline: [[0, 0], [400, 0], [400, 300], [0, 300]],
  // `wf` LAST on purpose: `v5SyncOutlineWalls` recycles a leftover outline wall onto an
  // unmatched edge in ARRAY order (edition.ts:317), so putting the other three first makes THEM
  // absorb the new outline's three edges and leaves `wf` — the one carrying the window — with
  // nowhere to go: it becomes "gone", not merely moved.
  walls: [
    { id: "wb", a: [0, 300], b: [400, 300], t: 10, isOutline: true },
    { id: "wl", a: [0, 0], b: [0, 300], t: 10, isOutline: true },
    { id: "wr", a: [400, 0], b: [400, 300], t: 10, isOutline: true },
    { id: "wf", a: [0, 0], b: [400, 0], t: 10, isOutline: true },
  ],
  openings: [{ id: "of", wallId: "wf", t0: 50, w: 120, h: 140, type: "window", side: 0, name: "Fenêtre", hinge: 0, swing: 1 }],
  pieces: [], cells: [], setupDone: true, model: "v5",
}), `
  ${OUVRIR}
  window.__plan.clearToast();
  window.__plan.wsFeed({t:"op", by:"b@example.com", rev:1, fp:"FP-1",
    op:{kind:"outline.set", outline:[[1000,1000],[1400,1000],[1200,1300]]}});
  return { openings: window.__plan.plan.openings.length, toast: window.__plan.toastText };
`, (v: VerdictSonde) => expect(v.openings === 0, "la fenêtre doit être perdue avec sa façade : " + v.openings)
     && expect(!!v.toast, "la perte doit être dite AU MOMENT de la réception, pas au geste local suivant : " + v.toast)
     && expect(/gone|parti/i.test(v.toast || ""), "le vocabulaire doit être celui, déjà connu, d'une ouverture perdue avec son mur : " + v.toast)
     && expect(!/—/.test(v.toast || ""), "aucun tiret cadratin dans un texte visible"));

// ---- report -----------------------------------------------------------------------------------
sonde.fermer();
const passed = results.filter(r => r.pass).length;
process.stdout.write("\n");
if (passed === results.length) { process.stdout.write("OK " + passed + "/" + results.length + "\n"); process.exit(0); }
process.stdout.write("FAILURES " + (results.length - passed) + "/" + results.length + ":\n");
results.filter(r => !r.pass).forEach(r => process.stdout.write("  - " + r.name + ": " + r.detail.split("\n")[0] + "\n"));
process.exit(1);
