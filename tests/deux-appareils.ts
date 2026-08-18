#!/usr/bin/env node
// =============================================================================
//  TWO DEVICES BEHIND A SINGLE ADDRESS
// =============================================================================
// The household has two accounts, but ONE person has several devices: the computer on the desk
// and the phone in the apartment, both behind the same Cloudflare Access identity. That is the
// application's main use case, and it was the only one nothing tested.
//
// As long as the technical identity was the EMAIL ADDRESS, a second device belonging to the same
// person was mistaken for THAT SAME PERSON:
//   - its ops did not enter the replayable journal, so ONE Ctrl+Z on the computer destroyed its
//     work on both screens AND in the server's plan, without a single banner;
//   - neither its presence dot, nor its cursor, nor its drag ghosts ever appeared.
// The technical identity is now the DEVICE (`tag`, set by the server, unique per socket);
// the email remains the HUMAN identity (that of the two household members).
//
// This suite also covers the two other promises kept at the same time:
//   - an op REJECTED by the server can no longer let the screen lie;
//   - a banner that ANSWERS A GESTURE is never silenced, only the system's own stays throttled;
//   - the repair banner for an orphaned piece of furniture belongs to the AUTHOR of the gesture.
//
//   node tests/deux-appareils.ts [path/to/app.html]
//
// Exit 0 if everything passes, 1 otherwise.

import type { VerdictSonde } from "./_types.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ouvrirSonde } from "./_navigateur.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_PATH = process.argv[2] || path.join(__dirname, "..", "index.html");
const V4_KEY = "room-planner-v4";

if (!fs.existsSync(APP_PATH)) { console.error("App file not found:", APP_PATH); process.exit(1); }
const APP_SRC = fs.readFileSync(APP_PATH, "utf8");
const REAL_PLAN = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "plan-rev177.json"), "utf8"));

// ---- harness: ONE shared Chrome for the whole suite (tests/_navigateur.ts) ----------------
const sonde = ouvrirSonde(APP_SRC);
async function runProbe(seedJs: string, probeBody: string) {
  return sonde.sonder(seedJs, probeBody);
}
const results: VerdictSonde[] = [];
async function test(name: string, seedJs: string, probeBody: string, check: (...args: VerdictSonde[]) => VerdictSonde | Promise<VerdictSonde>) {
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

// A believable server `hello`: me on device "aaaaaa", my OTHER device (same email)
// on "bbbbbb", and the other household member on "cccccc". The plan is not pushed back (fp
// matches nothing known -> no useful adoption here): we only exercise identity.
const HELLO = `window.__plan.wsForceOpen(true);
  window.__plan.wsFeed({ t:"hello",
    you:{ email:"a@example.com", color:"#1f6f78", tag:"aaaaaa" },
    peers:[ {email:"a@example.com", color:"#1f6f78", tag:"aaaaaa"},
            {email:"a@example.com", color:"#1f6f78", tag:"bbbbbb"},
            {email:"device.b@example.com",   color:"#b04a3d", tag:"cccccc"} ],
    state:null, rev:1, fp:"x", chat:[] });`;

// =============================================================================
//  1. THE REPLAY JOURNAL: "another device" is not "me"
// =============================================================================

// 1a. The op from MY OTHER DEVICE enters the journal: without it, a Ctrl+Z would restore a
// snapshot that doesn't contain it, and the work done on the phone would vanish from both screens.
await test("op_du_second_appareil_du_meme_compte_entre_au_journal", SEED, `
  ${HELLO}
  var p = window.__plan.plan.pieces[0];
  window.__plan.pushHistory();          // a snapshot is REQUIRED, otherwise the journal stays empty (js/27)
  var avant = window.__plan.histInfo().log;
  window.__plan.wsFeed({ t:"op", by:"a@example.com", tag:"bbbbbb", fp:"y",
    op:{ kind:"piece.set", piece:{ id:String(p.id), x:p.x+80, y:p.y } } });
  return { avant:avant, apres: window.__plan.histInfo().log, moi: window.__plan.wsMeInfo() };
`, (v: VerdictSonde) => expect(v.moi.tag === "aaaaaa", "le hello doit poser l'étiquette d'appareil, vu " + JSON.stringify(v.moi))
     && expect(v.apres === v.avant + 1, "l'op de l'autre appareil doit entrer au journal, " + v.avant + " -> " + v.apres));

// 1b. MY OWN echo (same tag) does not enter: replaying it would undo the undo.
await test("mon_propre_echo_n_entre_pas_au_journal", SEED, `
  ${HELLO}
  var p = window.__plan.plan.pieces[0];
  window.__plan.pushHistory();
  var avant = window.__plan.histInfo().log;
  window.__plan.wsFeed({ t:"op", by:"a@example.com", tag:"aaaaaa", fp:"y",
    op:{ kind:"piece.set", piece:{ id:String(p.id), x:p.x+80, y:p.y } } });
  return { avant:avant, apres: window.__plan.histInfo().log };
`, (v: VerdictSonde) => expect(v.apres === v.avant, "mon propre écho ne doit rien journaliser, " + v.avant + " -> " + v.apres));

// 1c. BACKWARD COMPATIBILITY: a server from BEFORE this fix does not broadcast a tag. We then
// fall back to email, exactly as before: nothing breaks, nothing is invented.
await test("serveur_sans_etiquette_retombe_sur_l_email", SEED, `
  window.__plan.wsForceOpen(true);
  window.__plan.wsFeed({ t:"hello", you:{ email:"a@example.com", color:"#1f6f78" },
    peers:[{email:"a@example.com", color:"#1f6f78"}], state:null, rev:1, fp:"x", chat:[] });
  var p = window.__plan.plan.pieces[0];
  window.__plan.pushHistory();
  var a = window.__plan.histInfo().log;
  window.__plan.wsFeed({ t:"op", by:"device.b@example.com", fp:"y",
    op:{ kind:"piece.set", piece:{ id:String(p.id), x:p.x+10, y:p.y } } });
  var b = window.__plan.histInfo().log;
  window.__plan.wsFeed({ t:"op", by:"a@example.com", fp:"z",
    op:{ kind:"piece.set", piece:{ id:String(p.id), x:p.x+20, y:p.y } } });
  var c = window.__plan.histInfo().log;
  return { a:a, b:b, c:c };
`, (v: VerdictSonde) => expect(v.b === v.a + 1, "sans étiquette, l'op d'un AUTRE e-mail doit être journalisée")
     && expect(v.c === v.b, "sans étiquette, l'op de MON e-mail ne doit pas l'être"));

// =============================================================================
//  2. PRESENCE AND CURSORS: one dot per DEVICE
// =============================================================================

// 2a. Two dots (my other device + the other household member), and mine stands out.
await test("deux_pastilles_dont_mon_autre_appareil", SEED, `
  ${HELLO}
  return { dots: window.__plan.peerDots(), cles: window.__plan.wsPeerKeys() };
`, (v: VerdictSonde) => expect(v.cles.length === 3, "les trois appareils doivent tenir dans la Map, vu " + JSON.stringify(v.cles))
     && expect(v.dots.length === 2, "deux pastilles attendues (mon autre appareil + l'autre membre du foyer), vu " + JSON.stringify(v.dots))
     && expect(v.dots.filter((d: VerdictSonde) => d.self).length === 1, "une seule pastille marquée « autre appareil », vu " + JSON.stringify(v.dots))
     && expect(/your other device/.test(v.dots.find((d: VerdictSonde) => d.self).title),
        "l'info-bulle doit le dire, vu " + JSON.stringify(v.dots)));

// 2b. Two distinct cursors for two devices on the SAME account: the Map used to be indexed by
// email, so the second one erased the first and only one was left.
await test("deux_curseurs_pour_deux_appareils_du_meme_compte", SEED, `
  ${HELLO}
  window.__plan.wsFeed({ t:"cursor", by:"a@example.com", tag:"bbbbbb", room:"__apt__", x:100, y:100 });
  window.__plan.wsFeed({ t:"cursor", by:"device.b@example.com",   tag:"cccccc", room:"__apt__", x:300, y:200 });
  // and OURS must never be displayed
  window.__plan.wsFeed({ t:"cursor", by:"a@example.com", tag:"aaaaaa", room:"__apt__", x:500, y:500 });
  return { curs: window.__plan.peerCursors() };
`, (v: VerdictSonde) => expect(v.curs.length === 2, "deux curseurs attendus, vu " + JSON.stringify(v.curs))
     && expect(v.curs.some((c: VerdictSonde) => c.label === "Other device"),
        "mon autre appareil ne s'appelle pas comme moi à l'écran, vu " + JSON.stringify(v.curs))
     && expect(v.curs.some((c: VerdictSonde) => c.label === "Device B"), "le pair garde un nom tiré de son adresse, vu " + JSON.stringify(v.curs)));

// 2c. The drag ghost of another device on the same account is applied (it used not to be:
// nothing warned that another device was dragging a piece of furniture).
await test("fantome_de_glissement_du_meme_compte_est_applique", SEED, `
  ${HELLO}
  var p = window.__plan.plan.pieces[0];
  window.__plan.wsFeed({ t:"drag", by:"a@example.com", tag:"bbbbbb", room:"__apt__",
    pieceId:String(p.id), x:p.x+150, y:p.y+150, rot:0 });
  var ids = window.__plan.ghostIds();
  var g = window.__plan.ghostPose(String(p.id));
  return { ids: ids, ghost: g && g.ghost };
`, (v: VerdictSonde) => expect(v.ids.length === 1, "le fantôme du second appareil doit être enregistré, vu " + JSON.stringify(v.ids))
     && expect(v.ghost === true, "et peint sur son noeud, vu " + JSON.stringify(v.ghost)));

// =============================================================================
//  3. A REJECTION FROM THE SERVER CAN NO LONGER LET THE SCREEN LIE
// =============================================================================

// 3a. The server rejects the op: the local change is UNDONE, and the outgoing mirror
// (what this client believes the server holds) becomes consistent with the local plan again.
await test("un_refus_serveur_annule_la_modification_locale", SEED, `
  ${HELLO}
  window.__plan.shadowSync();                     // the mirror describes the starting state
  var w = window.__plan.plan.walls.filter(function(x){ return !x.isOutline; })[0];
  var mid = { x:(w.a[0]+w.b[0])/2, y:(w.a[1]+w.b[1])/2 };
  var o = window.__plan.v5PlaceAt("plug", mid.x, mid.y);
  var pend = window.__plan.pendingOps().filter(function(e){ return e.kind==="opening.set"; });
  var n = pend.length ? pend[pend.length-1].n : null;
  var avant = { existe: !!window.__plan.v5OpeningById(o.id),
                miroir: window.__plan.shadowDump().openings.indexOf(String(o.id)) >= 0 };
  window.__plan.clearToast();
  window.__plan.wsFeed({ t:"err", reason:"opening_type", n:n, kind:"opening.set" });
  var pl = window.__plan.plan.openings.map(function(x){ return String(x.id); });
  var sh = window.__plan.shadowDump().openings;
  return { n:n, avant:avant,
           existeApres: !!window.__plan.v5OpeningById(o.id),
           miroirApres: sh.indexOf(String(o.id)) >= 0,
           enTrop: pl.filter(function(i){ return sh.indexOf(i) < 0; }),
           txt: window.__plan.toastText };
`, (v: VerdictSonde) => expect(v.n !== null, "l'op doit être numérotée pour être défaisable")
     && expect(v.avant.existe === true && v.avant.miroir === true, "l'ouverture devait exister et être au miroir avant le refus")
     && expect(v.existeApres === false, "l'ouverture refusée doit disparaître de l'écran")
     && expect(v.miroirApres === false, "elle doit aussi quitter le miroir d'émission")
     && expect(v.enTrop.length === 0, "plus rien ne doit être « en trop » dans le plan, vu " + JSON.stringify(v.enTrop))
     && expect(!!v.txt && /undone/i.test(v.txt), "le bandeau doit dire que la modification a été annulée, vu " + JSON.stringify(v.txt)));

// 3b. Server from BEFORE the fix: no number. We don't guess, we re-request the full state.
await test("un_refus_sans_numero_demande_l_etat_complet", SEED, `
  ${HELLO}
  window.__plan.shadowSync();
  window.__plan.outLog(true);
  window.__plan.wsFeed({ t:"err", reason:"too_big" });
  var out = window.__plan.outLog(false);
  return { sync: out.filter(function(m){ return m && m.t==="sync"; }).length,
           txt: window.__plan.toastText };
`, (v: VerdictSonde) => expect(v.sync === 1, "un refus non identifiable doit déclencher UNE relecture complète, vu " + v.sync)
     && expect(!!v.txt && /maximum size/.test(v.txt) && /re-read/i.test(v.txt),
        "le bandeau doit nommer la cause et dire ce qui est fait, vu " + JSON.stringify(v.txt)));

// 3c. A BURST of rejections is entirely undone, even though the banner itself is throttled.
await test("une_rafale_de_refus_est_entierement_defaite", SEED, `
  ${HELLO}
  window.__plan.shadowSync();
  var murs = window.__plan.plan.walls.filter(function(x){ return !x.isOutline; }).slice(0,3);
  var poses = murs.map(function(w){
    return window.__plan.v5PlaceAt("plug", (w.a[0]+w.b[0])/2, (w.a[1]+w.b[1])/2); }).filter(Boolean);
  var pend = window.__plan.pendingOps().filter(function(e){ return e.kind==="opening.set"; });
  var n0 = window.__plan.plan.openings.length;
  pend.forEach(function(e){ window.__plan.wsFeed({ t:"err", reason:"opening_type", n:e.n, kind:"opening.set" }); });
  var pl = window.__plan.plan.openings.map(function(x){ return String(x.id); });
  var sh = window.__plan.shadowDump().openings;
  return { poses: poses.length, n0:n0, apres: window.__plan.plan.openings.length,
           restants: poses.filter(function(o){ return !!window.__plan.v5OpeningById(o.id); }).length,
           enTrop: pl.filter(function(i){ return sh.indexOf(i) < 0; }) };
`, (v: VerdictSonde) => expect(v.poses === 3, "trois poses attendues, vu " + v.poses)
     && expect(v.restants === 0, "les trois refus doivent tous être défaits, il en reste " + v.restants)
     && expect(v.enTrop.length === 0, "aucun reliquat dans le plan, vu " + JSON.stringify(v.enTrop)));

// =============================================================================
//  4. BANNERS: the system throttles itself, a response to a gesture never does
// =============================================================================

// 4a. A repeated message from the SYSTEM stays throttled (22 banners in 371s, 8 of them the same one).
await test("un_message_du_systeme_reste_etrangle", SEED, `
  var vus = 0;
  for (var i=0;i<8;i++) if (window.__plan.emitToast("Message du système")) vus++;
  return { vus: vus };
`, (v: VerdictSonde) => expect(v.vus === 1, "huit émissions système doivent donner un seul bandeau, vu " + v.vus));

// 4b. The response to a GESTURE comes back on every gesture: someone who didn't understand
// repeats the gesture, and that is exactly where silence is intolerable. Measured: "This wall is
// already there." only showed on the first of five attempts.
await test("une_reponse_a_un_geste_revient_a_chaque_geste", SEED, `
  var vus = 0;
  for (var i=0;i<5;i++){
    window.__plan.nouveauGeste();
    window.__plan.clearToast();
    if (window.__plan.emitToastGeste("Cette cloison est déjà là.")) vus++;
  }
  // and a BURST within the SAME gesture does not repeat (one message per piece of furniture in a selection)
  window.__plan.nouveauGeste();
  var rafale = 0;
  for (var j=0;j<6;j++) if (window.__plan.emitToastGeste("Un seul geste, six objets.")) rafale++;
  return { vus: vus, rafale: rafale };
`, (v: VerdictSonde) => expect(v.vus === 5, "cinq gestes doivent donner cinq réponses, vu " + v.vus)
     && expect(v.rafale === 1, "une rafale d'un même geste ne se répète pas, vu " + v.rafale));

// 4c. The real gesture: tracing a wall twice in the same spot must say so TWICE.
await test("un_trace_en_double_le_dit_a_chaque_essai", SEED, `
  var w = window.__plan.plan.walls.filter(function(x){ return !x.isOutline; })[0];
  var vus = [];
  for (var i=0;i<3;i++){
    window.__plan.nouveauGeste();
    window.__plan.clearToast();
    vus.push(window.__plan.drawWall([w.a[0],w.a[1]],[w.b[0],w.b[1]]).toast);
  }
  return { vus: vus, murs: window.__plan.plan.walls.length };
`, (v: VerdictSonde) => expect(v.vus.filter((t: VerdictSonde) => t && /already there/.test(t)).length === 3,
        "les trois essais doivent tous être annoncés, vu " + JSON.stringify(v.vus)));

// =============================================================================
//  5. THE BANNER FOR AN ORPHANED PIECE OF FURNITURE BELONGS TO THE AUTHOR OF THE GESTURE
// =============================================================================

// 5a. A piece of furniture that MY gesture leaves outside any cell: I get told about it.
await test("mon_propre_orphelin_est_annonce", SEED, `
  var p = window.__plan.plan.pieces[0];
  p.x = 50000; p.y = 50000;                        // outside any cell
  window.__plan.clearToast();
  var n = window.__plan.clampPieces();
  return { n:n, txt: window.__plan.toastText };
`, (v: VerdictSonde) => expect(v.n >= 1, "au moins un orphelin devait être réparé, vu " + v.n)
     && expect(!!v.txt && /any room/.test(v.txt), "la réparation doit être annoncée, vu " + JSON.stringify(v.txt)));

// 5b. The same piece of furniture, orphaned by a RECEIVED op: repaired, but WITHOUT a banner. It's
// the author of the gesture who gets told, on their own screen. Measured across three devices: the
// message landed on 2 screens out of 3, sometimes on the one that had done nothing.
await test("un_orphelin_venu_du_fil_est_repare_en_silence", SEED, `
  ${HELLO}
  var p = window.__plan.plan.pieces[0];
  window.__plan.applyRemote({ kind:"piece.set", piece:{ id:String(p.id), x:50000, y:50000 } });
  window.__plan.clearToast();
  var n = window.__plan.clampPieces();
  return { n:n, txt: window.__plan.toastText };
`, (v: VerdictSonde) => expect(v.n >= 1, "l'orphelin doit tout de même être réparé, vu " + v.n)
     && expect(v.txt === null, "mais sans bandeau chez celui qui n'a rien fait, vu " + JSON.stringify(v.txt)));

// =============================================================================
//  6. A TRIMMED PLACEMENT SAYS SO
// =============================================================================
// Placing a wall-mounted object wider than a wall places it anyway, trimmed to the wall's width,
// without a word, ever, even on the first try.
// Since the fixture corpus was scaled by similarity transform (x1.37), the reference plan no
// longer has a wall short enough for a door (catalog: 80cm): its shortest wall (~95cm, "w6") is
// now longer than one. It remains shorter than a window, however (catalog: 120cm), which
// exercises exactly the same trim-and-announce.
await test("une_pose_rabotee_par_un_mur_court_est_annoncee", SEED, `
  var court = window.__plan.plan.walls.slice()
    .map(function(w){ var d=Math.hypot(w.b[0]-w.a[0], w.b[1]-w.a[1]); return {w:w, L:d}; })
    .filter(function(e){ return e.L > 20 && e.L < 120; })
    .sort(function(a,b){ return a.L-b.L; })[0];
  if (!court) return { aucun:true };
  window.__plan.clearToast();
  var r = window.__plan.placeWallMountAt("window", (court.w.a[0]+court.w.b[0])/2, (court.w.a[1]+court.w.b[1])/2);
  var wire = r.id ? window.__plan.openingWire(r.id) : null;
  return { len: Math.round(court.L), w: wire && wire.w, txt: r.toast };
`, (v: VerdictSonde) => expect(!v.aucun, "le plan de référence doit contenir un mur plus court qu'une fenêtre (120 cm)")
     && expect(v.w !== null && v.w < 120, "la fenêtre doit bien avoir été rabotée, vu " + JSON.stringify(v.w))
     && expect(!!v.txt && /instead of/.test(v.txt), "et le dire, vu " + JSON.stringify(v.txt)));

// =============================================================================
//  7. A FREE-STANDING PARTITION SURVIVES THE INCREMENTAL WIRE
// =============================================================================
// A wall can carry `free:1`: it does NOT extend to the first barrier (the Freehand tool's loose
// ends, and the "Ends: Through | Free" control). `sanitizeV5Plan` (full-plan re-read: reload,
// undo/redo, D1/realtime adoption) already keeps it. The receive path for a SINGLE incremental
// op (`ws5ApplyRemoteOp`'s `wall.set` case, `src/ts/fil/reception.ts`) is a SEPARATE code path
// that merges only the keys present on the op: it used to merge neither on wall CREATION nor on
// an UPDATE to an existing wall, so a free partition drawn by one device looked right locally but
// reverted to through-going the moment the OTHER device received it, live or through fallback.

// 7a. The peer receives a brand-new wall carrying `free:1` (the author's FIRST op for it,
// C-5: creation sends the whole entity): it must exist, and stay free.
await test("un_mur_libre_recu_du_pair_reste_libre", SEED, `
  ${HELLO}
  window.__plan.applyRemote({ kind:"wall.set", wall:{ id:"wPeerLibre", a:[60,60], b:[60,120], t:12, free:1 } });
  var w = window.__plan.v5WallById("wPeerLibre");
  return { existe: !!w, free: w && w.free };
`, (v: VerdictSonde) => expect(v.existe === true, "le mur reçu doit exister chez le pair")
     && expect(v.free === 1, "et y rester libre, vu " + JSON.stringify(v)));

// 7b. The reverse, the suite's own negative control: an ORDINARY wall (no `free` key at all)
// must NOT come out free on the peer's side either.
await test("un_mur_traversant_recu_du_pair_reste_traversant", SEED, `
  ${HELLO}
  window.__plan.applyRemote({ kind:"wall.set", wall:{ id:"wPeerTrav", a:[80,60], b:[80,120], t:12 } });
  var w = window.__plan.v5WallById("wPeerTrav");
  return { existe: !!w, free: w && w.free };
`, (v: VerdictSonde) => expect(v.existe === true, "le mur reçu doit exister chez le pair")
     && expect(!v.free, "et rester traversant, vu " + JSON.stringify(v)));

// 7c. The OTHER half of the receive path: an UPDATE to a wall the peer ALREADY has (field-by-field
// merge, C-5) must also carry `free` over, not just a creation.
await test("une_maj_recue_du_pair_rend_un_mur_deja_connu_libre", SEED, `
  ${HELLO}
  window.__plan.applyRemote({ kind:"wall.set", wall:{ id:"wPeerMaj", a:[100,60], b:[100,120], t:12 } });
  // \`v5WallById\` returns a LIVE reference: the flag is read off right away, before the second
  // op can mutate the SAME object in place.
  var avantFree = (window.__plan.v5WallById("wPeerMaj") || {}).free;
  window.__plan.applyRemote({ kind:"wall.set", wall:{ id:"wPeerMaj", free:1 } });
  var apres = window.__plan.v5WallById("wPeerMaj");
  return { avant: avantFree, apres: apres && apres.free };
`, (v: VerdictSonde) => expect(!v.avant, "avant la mise à jour, le mur doit être traversant, vu " + JSON.stringify(v))
     && expect(v.apres === 1, "après la mise à jour partielle, il doit devenir libre, vu " + JSON.stringify(v)));

// =============================================================================
//  8. THE CLEAR TRAVELS TOO, NOT JUST THE SET
// =============================================================================
// `v5WallWire` used to emit `free` ONLY when truthy: switching a partition back to Through
// (`gestes/murs.ts`'s "Ends: Through" button) deletes the local flag, so the wire object for
// that wall came back out looking EXACTLY like a wall that was never touched, and the
// field-by-field diff had nothing to compare `free` against. The author saw Through, the peer
// kept showing Free, and only a full resync repaired it. Fixed: the local model now keeps the
// clear as `free: 0` (never `delete`), and the wire emits it explicitly.

// 8a. THE ROUND TRIP: device A's diff emitter is made to run for real (`outLog`+`forceDiff`,
// the same rig `collab-annuler.ts` uses), so this exercises the ACTUAL emission code, not a
// hand-built op. The captured op is then handed to a peer whose copy of the SAME wall is still
// `free:1` (representative of someone who has not heard about the clear yet): applying the op
// must bring them back to Through.
await test("la_levee_d_une_cloison_libre_atteint_le_pair", SEED, `
  ${HELLO}
  var w = window.__plan.plan.walls.filter(function(x){ return !x.isOutline; })[0];
  if (!w) return { aucun: true };
  // Device A had already set it free, and this state was already shared (the mirror knows it).
  w.free = 1;
  window.__plan.shadowSync();
  window.__plan.outLog(true);
  // Device A now flips it back to Through.
  w.free = 0;
  window.__plan.forceDiff();
  var out = window.__plan.outLog(false);
  var msg = out.filter(function(m){
    return m.t === "op" && m.op && m.op.kind === "wall.set" && String(m.op.wall.id) === String(w.id);
  })[0];
  var opEnvoye = msg && msg.op;
  // A peer whose copy is still free (they have not received anything yet).
  w.free = 1;
  if (opEnvoye) window.__plan.applyRemote(opEnvoye);
  var apres = window.__plan.v5WallById(w.id);
  return { id: w.id, opPresent: !!opEnvoye, opCles: opEnvoye && Object.keys(opEnvoye.wall).sort(),
           opFree: opEnvoye && opEnvoye.wall.free, peerFreeApres: apres && apres.free };
`, (v: VerdictSonde) => expect(!v.aucun, "le plan de référence doit contenir au moins une cloison intérieure")
     && expect(v.opPresent === true, "la levée doit émettre une op wall.set, vu " + JSON.stringify(v))
     && expect(v.opCles.indexOf("free") >= 0, "l'op doit PORTER la clé \`free\`, vu " + JSON.stringify(v.opCles))
     && expect(v.opFree === 0, "avec la valeur explicite 0 (pas l'absence), vu " + JSON.stringify(v.opFree))
     && expect(!v.peerFreeApres, "et le pair doit redevenir traversant en l'appliquant, vu " + JSON.stringify(v)));

// 8b. NEGATIVE CONTROL / no wire-shape regression: a wall that NEVER used the Free tool
// (`free` absent, not just falsy) must keep emitting EXACTLY what it emitted before this fix
// when an unrelated field changes, otherwise every existing plan would move on its next save.
await test("une_cloison_jamais_libre_n_emet_toujours_pas_free", SEED, `
  ${HELLO}
  var w = window.__plan.plan.walls.filter(function(x){ return !x.isOutline && x.free === undefined; })[0];
  if (!w) return { aucun: true };
  window.__plan.shadowSync();
  window.__plan.outLog(true);
  w.t = w.t === 12 ? 13 : 12;   // touch an UNRELATED field to force a diff
  window.__plan.forceDiff();
  var out = window.__plan.outLog(false);
  var msg = out.filter(function(m){
    return m.t === "op" && m.op && m.op.kind === "wall.set" && String(m.op.wall.id) === String(w.id);
  })[0];
  var opEnvoye = msg && msg.op;
  return { opPresent: !!opEnvoye, opCles: opEnvoye && Object.keys(opEnvoye.wall).sort() };
`, (v: VerdictSonde) => expect(!v.aucun, "le plan de référence doit contenir une cloison jamais libre")
     && expect(v.opPresent === true, "le changement d'épaisseur doit émettre une op, vu " + JSON.stringify(v))
     && expect(JSON.stringify(v.opCles) === JSON.stringify(["id", "t"]),
        "et ne JAMAIS porter \`free\`, vu " + JSON.stringify(v.opCles)));

// =============================================================================
//  9. GUEST WIRE IDENTITY: EACH DEVICE REASSERTS ITS OWN NAME, NEITHER IS LEFT NAMELESS
// =============================================================================
// `invites.last_name`/`last_guest_id` is ONE slot, shared by every device holding the link
// (functions/api/invite.ts, functions/ws.ts): whichever device redeemed the token MOST RECENTLY
// WITH a name owns it. A plain WebSocket RECONNECT (no `/api/invite` POST — a network blip, the
// heartbeat's dead-socket close) can therefore land THIS device on a `hello` carrying an EMPTY
// name, even though it chose one long ago and never forgot it (`localStorage`'s
// `plan-invite-nom`). `fil/presence.ts`'s `hello` handler now reasserts it over the wire itself
// the moment that happens, rather than leave the socket — and every op it tries to send — silently
// unnamed until someone notices the `guest_unnamed` refusal.
const seedNom = (nom: string) => `try{ localStorage.setItem("plan-invite-nom", ${JSON.stringify(nom)}); }catch(e){}`;
const helloInviteVide = (tag: string, guestId: string) => `window.__plan.wsForceOpen(true);
  window.__plan.outLog(true);
  window.__plan.wsFeed({ t:"hello",
    you:{ email:"", color:"#1f6f78", tag:${JSON.stringify(tag)}, guest:true, name:"", guestId:${JSON.stringify(guestId)} },
    peers:[], state:null, rev:1, fp:"x", chat:[] });`;

// 9a. Device A: the wire hands it back NOTHING, but this browser remembers "Alice" — it must send
// its own name right away, and its local identity must reflect it immediately (no round trip).
await test("appareil_a_reaffirme_son_propre_nom_quand_le_fil_ne_le_connait_plus", SEED + seedNom("Alice"), `
  ${helloInviteVide("aaaaaa", "device-a")}
  var out = window.__plan.outLog(false);
  return { moi: window.__plan.wsMeInfo(), noms: out.filter(function(m){ return m && m.t === "name"; }) };
`, (v: VerdictSonde) => expect(v.noms.length === 1 && v.noms[0].name === "Alice",
      "device A doit renvoyer SON PROPRE nom sur le fil, vu " + JSON.stringify(v.noms))
     && expect(v.moi.name === "Alice", "et se savoir nommé sans attendre l'écho serveur, vu " + JSON.stringify(v.moi)));

// 9b. Device B, SAME token, a DIFFERENT device: it must reassert "Bob", never "Alice" — proves the
// reassertion is keyed by THIS browser's own storage, not by whatever the last hello happened to say.
await test("appareil_b_reaffirme_bob_jamais_le_nom_d_alice", SEED + seedNom("Bob"), `
  ${helloInviteVide("bbbbbb", "device-b")}
  var out = window.__plan.outLog(false);
  return { moi: window.__plan.wsMeInfo(), noms: out.filter(function(m){ return m && m.t === "name"; }) };
`, (v: VerdictSonde) => expect(v.noms.length === 1 && v.noms[0].name === "Bob",
      "device B doit renvoyer SON PROPRE nom, jamais celui d'un autre appareil, vu " + JSON.stringify(v.noms))
     && expect(v.moi.name === "Bob", "et se savoir nommé « Bob », vu " + JSON.stringify(v.moi)));

// 9c. NEGATIVE CONTROL: when the wire ALREADY hands back a name, the client must not resend one
// needlessly — a `{t:"name"}` on every `hello` would republish the row's last_name on every
// reconnect, exactly the "everyone re-pushes and clobbers everyone else" mechanism this batch closes.
await test("aucun_reenvoi_de_nom_quand_le_fil_le_connait_deja", SEED + seedNom("Alice"), `
  window.__plan.wsForceOpen(true);
  window.__plan.outLog(true);
  window.__plan.wsFeed({ t:"hello",
    you:{ email:"", color:"#1f6f78", tag:"aaaaaa", guest:true, name:"Alice", guestId:"device-a" },
    peers:[], state:null, rev:1, fp:"x", chat:[] });
  var out = window.__plan.outLog(false);
  return { noms: out.filter(function(m){ return m && m.t === "name"; }) };
`, (v: VerdictSonde) => expect(v.noms.length === 0, "un nom déjà connu ne doit jamais être renvoyé sans raison, vu " + JSON.stringify(v.noms)));

// 9d. `guest_unnamed` (the server refusing an op from an unnamed socket) opens the SAME name step
// a fresh guest sees on arrival, instead of relying on a toast throttled to one per 5 s that a
// whole editing session could lose.
await test("guest_unnamed_ouvre_l_etape_du_nom_pas_seulement_un_bandeau", SEED, `
  ${helloInviteVide("cccccc", "device-c")}
  window.__plan.wsFeed({ t:"err", reason:"guest_unnamed", n:1, kind:"piece.set" });
  var dlg = document.getElementById("inviteNameDlg");
  return { hidden: dlg ? dlg.hidden : null };
`, (v: VerdictSonde) => expect(v.hidden === false, "guest_unnamed doit ouvrir l'étape du nom, vu " + JSON.stringify(v)));

// ---- verdict ---------------------------------------------------------------------------------
sonde.fermer();
const bad = results.filter(r => !r.pass);
console.log("");
if (bad.length) { console.log(`FAILURES ${bad.length}/${results.length}`); process.exitCode = 1; }
else console.log(`OK ${results.length}/${results.length}`);
