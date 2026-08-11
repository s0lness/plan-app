#!/usr/bin/env node
// =============================================================================
//  ACKNOWLEDGEMENT, RETRANSMISSION, AND A TRANSPORT THAT LOSES
// =============================================================================
// No test bench modeled MESSAGE LOSS: the only simulated network effect was a uniform delay.
// Yet that is the only defect that matters here, because until this batch an op lost in
// transit was NEVER retransmitted. The internal brief said "the safety net exists and works,
// it's just slower"; that is false, and this suite shows it:
//   - BEFORE: the lost op is not caught by the `pong`'s fingerprint comparison, it is
//     ERASED. The full re-read it triggers ADOPTS the server state, so the author's screen
//     loses their change, silently, for up to 10s.
//   - AFTER: the echo carries the op's number, the client keeps the unacknowledged ones, and
//     whatever is missing gets resent, at its CURRENT value, never at the stale intent of a dead op.
//
// The test bench runs THE REAL SERVER inside the page: `live-worker/ops.ts` and
// `live-worker/worker.ts` first get stripped of their types, then are injected after their
// module keywords are removed. `PlanRoom` is instantiated over a storage and D1 test double.
// There is therefore no server copy to keep up to date: a change to `PlanRoom` is in the bench
// within a second. Between the two sits a transport that knows how to LOSE, DELAY, and
// REORDER frames.
//
//   node tests/collab-accuses.ts [path/to/app.html]
//
// Exit 0 if everything passes, 1 otherwise.

import type { VerdictSonde } from "./_types.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const APP_PATH = process.argv[2] || path.join(__dirname, "..", "index.html");
const V4_KEY = "room-planner-v4";

if (!fs.existsSync(APP_PATH)) { console.error("App file not found:", APP_PATH); process.exit(1); }
if (!fs.existsSync(CHROME)) { console.error("Chrome not found:", CHROME); process.exit(1); }
const APP_SRC = fs.readFileSync(APP_PATH, "utf8");
const REAL_PLAN = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "plan-rev177.json"), "utf8"));

// ---- THE REAL SERVER, INSIDE THE PAGE --------------------------------------------------------------
// We strip the module keywords (the file must remain a classic script, the page is served over
// file:// and the deliverable is CSP-safe) and NOTHING else. No rewriting, no copying.
function moduleEnScript(src: string) {
  // Chrome executes a classic script here: Node's syntactic stripping does not apply inside
  // the page. esbuild therefore removes the types BEFORE the historical ES module handling.
  return transformSync(src, { loader: "ts", format: "esm", target: "es2022" }).code
    .replace(/^import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];\s*$/m, "")
    // esbuild gathers TypeScript exports into a final block; leaving it and then stripping only
    // the word `export` would produce an invalid JavaScript block (`{ PlanRoom, ... }`).
    .replace(/^export\s*\{[\s\S]*?\};?\s*$/m, "")
    .replace(/^export\s+default\s+/m, "const __srvDefault = ")
    .replace(/^export\s+/gm, "");
}
const SERVEUR_JS = `<script>(function(){
${moduleEnScript(fs.readFileSync(path.join(__dirname, "..", "live-worker", "ops.ts"), "utf8"))}
${moduleEnScript(fs.readFileSync(path.join(__dirname, "..", "live-worker", "worker.ts"), "utf8"))}
window.__monde = { PlanRoom: PlanRoom, applyOp: applyOp, sanitizeState: sanitizeState, planFp: planFp, emptyPlan: emptyPlan };
})();</script>`;

// ---- the test bench, as seen by a probe ----------------------------------------------------
// perdre(msg) returns true to drop a CLIENT -> SERVER frame. retard(msg) returns a number
// of rounds to wait: that's what produces the reordering.
const BANC = `
  var M = window.__monde;
  // RAW abscissa (top-left corner, apartment cm) of a piece of furniture, on both sides of the wire.
  function locX(id){ var p=window.__plan.plan.pieces.filter(function(q){ return String(q.id)===String(id); })[0]; return p?p.x:null; }
  function srvX(b,id){ var p=b.room.plan.pieces.filter(function(q){ return String(q.id)===String(id); })[0]; return p?p.x:null; }
  function fabriquerBanc(opts){
    opts = opts || {};
    var kv = new Map(), alarmAt = null;
    var storage = {
      get: function(k){ return Promise.resolve(Array.isArray(k)
        ? new Map(k.filter(function(x){return kv.has(x);}).map(function(x){return [x, kv.get(x)];}))
        : kv.get(k)); },
      put: function(a,b){ if(typeof a==="string") kv.set(a,b);
        else Object.keys(a).forEach(function(k){ kv.set(k,a[k]); }); return Promise.resolve(); },
      getAlarm: function(){ return Promise.resolve(alarmAt); },
      setAlarm: function(t){ alarmAt=t; return Promise.resolve(); },
      deleteAlarm: function(){ alarmAt=null; return Promise.resolve(); }
    };
    var ligne = opts.ligne===undefined ? null : opts.ligne;
    var env = { DB: { prepare: function(){ return {
      args: [],
      bind: function(){ this.args=[].slice.call(arguments); return this; },
      first: function(){ return Promise.resolve(ligne); },
      run: function(){ ligne = {data:this.args[0], rev:(ligne?ligne.rev:0)+1,
        updated_by:"live", updated_at:this.args[1]}; return Promise.resolve({}); }
    }; } } };
    var sockets = [];
    var srvOut = [];      // what the server sends TO US
    function ouvrirSocket(tag){
      var att = {email:"a@example.com", color:"#1f6f78", tag:tag};
      var w = { deserializeAttachment:function(){ return att; },
                serializeAttachment:function(a){ att=a; },
                send:function(s){ srvOut.push(JSON.parse(s)); }, close:function(){} };
      sockets.push(w); return w;
    }
    var st = { storage:storage, getWebSockets:function(){ return sockets.slice(); }, acceptWebSocket:function(){} };
    var room = new M.PlanRoom(st, env);
    var ws = ouvrirSocket(opts.tag || "aaa111");

    var out = window.__plan.outLog(true);   // log of EVERYTHING that leaves the client
    var lu = 0, perdues = [], enVol = [], tour = 0;
    var banc = {
      room: room, ws: ws, srvOut: srvOut, perdues: perdues,
      perdre: opts.perdre || null,
      retard: opts.retard || null,
      // Removes the capability announcement: that's how we replay the OLD server.
      vieuxServeur: !!opts.vieuxServeur,
      sockets: sockets,
      ouvrirSocket: ouvrirSocket,
      // CLIENT -> SERVER, then SERVER -> CLIENT, until nothing moves anymore.
      pousser: async function(){
        for (var garde=0; garde<40; garde++){
          var bouge = false;
          tour++;
          while (lu < out.length){
            var m = out[lu++];
            if (banc.perdre && banc.perdre(m)) { perdues.push(m); bouge = true; continue; }
            var d = banc.retard ? banc.retard(m) : 0;
            if (d > 0) { enVol.push({m:m, quand:tour+d}); bouge = true; continue; }
            await room.webSocketMessage(ws, JSON.stringify(m));
            bouge = true;
          }
          var prets = enVol.filter(function(e){ return e.quand<=tour; });
          for (var i=0;i<prets.length;i++){
            enVol.splice(enVol.indexOf(prets[i]),1);
            await room.webSocketMessage(ws, JSON.stringify(prets[i].m));
            bouge = true;
          }
          while (srvOut.length){
            var s = srvOut.shift();
            if (banc.vieuxServeur && s.t==="hello") delete s.acks;
            if (banc.vieuxServeur && (s.t==="ack"||s.t==="gap")) continue;
            if (banc.vieuxServeur && s.t==="op") delete s.n;
            window.__plan.wsFeed(s);
            bouge = true;
          }
          if (!bouge) break;
        }
      },
      viderRetards: async function(){ tour += 1000; await banc.pousser(); },
      // Handshake: the client believes it's online, the server serves it its hello.
      demarrer: async function(){
        window.__plan.wsForceOpen(true);
        await room.webSocketMessage(ws, JSON.stringify({t:"hello"}));
        await banc.pousser();
      },
      // A reconnection: fresh socket, fresh tag, new handshake.
      reconnecter: async function(tag){
        ws = banc.ws = ouvrirSocket(tag);
        window.__plan.wsForceOpen(true);
        await room.webSocketMessage(ws, JSON.stringify({t:"hello"}));
        await banc.pousser();
      },
      fpServeur: function(){ return M.planFp(room.plan); },
      fpClient: function(){ return M.planFp(M.sanitizeState(window.__plan.wire())); }
    };
    return banc;
  }
`;

// ---- harness (ASYNCHRONOUS probe: the bench awaits storage on every op) --------------------------
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "plan-acc-"));
function runProbe(seedJs: string, probeBody: string) {
  const caseDir = fs.mkdtempSync(path.join(RUN_DIR, "c-"));
  const htmlPath = path.join(caseDir, "case.html");
  const seed = `<!doctype html><html><head><meta charset="utf-8"><script>
    window.__PLAN_TEST__ = 1;
    try { localStorage.clear(); sessionStorage.clear(); } catch(e){}
    ${seedJs || ""}
  </script></head><body>`;
  const probe = `<script>(function(){
    function emit(o){ try{ document.documentElement.dataset.planTest = JSON.stringify(o); }catch(e){} }
    async function run(){
      try {
        var errs = [];
        try { errs = JSON.parse(localStorage.getItem("plan-errors")||"[]")||[]; } catch(e){}
        ${BANC}
        var __out = (await (async function(){ ${probeBody} })()) || {};
        __out.jsErrors = errs.map(function(e){ return e && e.msg; });
        emit(__out);
      } catch(e) { emit({ __probeError: String(e && e.stack || e) }); }
    }
    setTimeout(run, 0);
  })();</script></body></html>`;
  fs.writeFileSync(htmlPath, seed + SERVEUR_JS + APP_SRC + probe, "utf8");
  const res = spawnSync(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
    "--user-data-dir=" + path.join(caseDir, "profile"),
    "--virtual-time-budget=15000", "--run-all-compositor-stages-before-draw", "--dump-dom",
    "file:///" + htmlPath.replace(/\\/g, "/"),
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  const m = (res.stdout || "").match(/<html[^>]*\bdata-plan-test="([^"]*)"/i);
  if (!m) return { __noVerdict: true, __stdoutHead: (res.stdout || "").slice(0, 700), __stderr: (res.stderr || "").slice(0, 700) };
  const raw = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");
  try { return JSON.parse(raw); } catch (e) { return { __parseError: String(e), __raw: raw.slice(0, 400) }; }
}
const results: VerdictSonde[] = [];
function test(name: string, seedJs: string, probeBody: string, check: (...args: VerdictSonde[]) => VerdictSonde | Promise<VerdictSonde>) {
  let pass = false, detail = "";
  const v = runProbe(seedJs, probeBody);
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
const SEED = seedV4(REAL_PLAN);

// =============================================================================
//  0. THE TEST BENCH ITSELF: the real server runs, and the plan crosses over
// =============================================================================
test("le_banc_fait_tourner_le_vrai_serveur", SEED, `
  var b = fabriquerBanc({});
  await b.demarrer();
  var idPiece = window.__plan.plan.pieces[0].id;
  window.__plan.setPos(idPiece, 300, 300); window.__plan.save();
  await b.pousser();
  var srv = b.room.plan.pieces.filter(function(p){ return String(p.id)===String(idPiece); })[0];
  return { acks: window.__plan.acksOn, murs: b.room.plan.walls.length,
           x: srv?srv.x:null, memeFp: b.fpServeur()===b.fpClient(), unacked: window.__plan.unackedOps().length };
`, (v: VerdictSonde) => expect(v.acks === true, "le hello du vrai serveur annonce les accusés")
     && expect(v.murs > 0, "le plan du client a bien amorcé le serveur, vu " + v.murs + " murs")
     && expect(v.x === 300, "la modification a traversé, vu x=" + v.x)
     && expect(v.memeFp === true, "client et serveur portent la MÊME empreinte")
     && expect(v.unacked === 0, "tout est acquitté, vu " + v.unacked + " en attente"));

// =============================================================================
//  1. BEFORE: a lost op is caught by ABSOLUTELY NOTHING
// =============================================================================
// The old server does not announce acknowledgements: the client leaves the whole mechanism idle,
// so we replay exactly yesterday's behavior. This is ALSO the compatibility proof for "an
// up-to-date client in front of the currently deployed Worker".
//
// And the `pong` safety net DOES NOT KICK IN. It compares the fingerprint announced by the server
// against the LAST fingerprint the server had announced. An op lost on the way out does not
// change the server's state, so its fingerprint does not move, so the two numbers agree and no
// `sync` is sent. That safety net catches a missed INCOMING message, never a lost OUTGOING op:
// the two plans diverge permanently, both screens showing "live ✓".
test("avant_une_op_perdue_n_est_rattrapee_par_rien", SEED, `
  var b = fabriquerBanc({vieuxServeur:true});
  await b.demarrer();
  var id = window.__plan.plan.pieces[0].id;
  // from here on, EVERY furniture op gets lost in transit
  b.perdre = function(m){ return m.t==="op" && m.op && m.op.kind==="piece.set"; };
  window.__plan.setPos(id, 777, 777); window.__plan.save();
  await b.pousser();
  var srvApres = srvX(b,id), localApres = locX(id);
  var divergent = b.fpServeur()!==b.fpClient();
  // The supposed safety net: the pong, every 10s, carrying the server's fingerprint.
  b.perdre = null;
  var journal = window.__plan.outLog(true);
  window.__plan.wsFeed({t:"pong", ts:Date.now(), fp:b.fpServeur()});
  await b.pousser();
  var syncs = journal.filter(function(m){ return m.t==="sync"; }).length;
  // And IF a full re-read happened for another reason, it WOULD ERASE the change.
  window.__plan.wsFeed({t:"state", reason:"sync", fp:b.fpServeur(), state:b.room.plan});
  return { perdues: b.perdues.length, acks: window.__plan.acksOn, reemis: window.__plan.retransmits,
           srvX: srvApres, localX: localApres, divergent: divergent, syncs: syncs,
           apresRelecture: locX(id) };
`, (v: VerdictSonde) => expect(v.acks === false, "serveur d'avant : la mécanique d'accusé reste au repos")
     && expect(v.perdues >= 1, "au moins une op a bien été perdue")
     && expect(v.reemis === 0, "AVANT : rien n'est jamais réémis, vu " + v.reemis)
     && expect(v.srvX !== 777, "le serveur n'a pas reçu la modification")
     && expect(v.localX === 777, "l'écran de l'auteur l'affichait pourtant, vu " + v.localX)
     && expect(v.divergent === true, "les deux plans DIVERGENT")
     && expect(v.syncs === 0, "et le pong ne demande AUCUNE relecture : il ne voit rien, vu " + v.syncs)
     && expect(v.apresRelecture !== 777, "une relecture, si elle survient, EFFACE la modification, vu " + v.apresRelecture));

// =============================================================================
//  2. AFTER: the server flags the gap, the client retransmits, nothing is lost
// =============================================================================
test("apres_le_trou_est_signale_et_la_modification_repart", SEED, `
  var b = fabriquerBanc({});
  await b.demarrer();
  var id = window.__plan.plan.pieces[0].id;
  var id2 = window.__plan.plan.pieces[1].id;
  var n = 0;
  // the FIRST furniture op is lost, the following ones go through
  b.perdre = function(m){ return m.t==="op" && m.op && m.op.kind==="piece.set" && (n++)===0; };
  window.__plan.setPos(id, 777, 777); window.__plan.save();
  await b.pousser();
  var perduAuServeur = srvX(b,id);
  // a second gesture: it's the one that reveals the gap to the server
  window.__plan.setPos(id2, 500, 500); window.__plan.save();
  await b.pousser();
  return { perdues: b.perdues.length, reemis: window.__plan.retransmits,
           avantX: perduAuServeur, srvX: srvX(b,id),
           localX: locX(id), memeFp: b.fpServeur()===b.fpClient(),
           unacked: window.__plan.unackedOps().length };
`, (v: VerdictSonde) => expect(v.perdues === 1, "une op perdue, vu " + v.perdues)
     && expect(v.avantX !== 777, "le serveur ne l'avait effectivement pas reçue")
     && expect(v.reemis >= 1, "le trou signalé a déclenché une réémission, vu " + v.reemis)
     && expect(v.srvX === 777, "et la modification est arrivée, vu " + v.srvX)
     && expect(v.localX === 777, "l'écran de l'auteur n'a rien perdu au passage")
     && expect(v.memeFp === true, "client et serveur convergent")
     && expect(v.unacked === 0, "plus rien n'attend, vu " + v.unacked));

// =============================================================================
//  3. THE LAST OP LOST: nothing follows it, the watchdog timeout catches it
// =============================================================================
// The server's `gap` detector is the fastest one, but it only sees a hole thanks to the
// FOLLOWING op. When the lost frame is the last one, there is no following op: without a second
// safety net, the change would stay stranded outside. This is exactly the case the pong used to
// take 10s to see, and resolved by erasing it.
test("derniere_op_perdue_le_delai_de_garde_la_ramene", SEED, `
  var b = fabriquerBanc({});
  await b.demarrer();
  var id = window.__plan.plan.pieces[0].id;
  b.perdre = function(m){ return m.t==="op" && m.op && m.op.kind==="piece.set"; };
  window.__plan.setPos(id, 777, 777); window.__plan.save();
  await b.pousser();
  var enAttente = window.__plan.unackedOps().length;
  var srvAvant = srvX(b,id);
  // nothing follows: the server CANNOT see the gap. The client's watchdog timeout, though, sees it.
  b.perdre = null;
  window.__plan.ageUnacked();
  window.__plan.ackTickNow();
  await b.pousser();
  return { enAttente: enAttente, srvAvant: srvAvant, srvX: srvX(b,id),
           localX: locX(id), reemis: window.__plan.retransmits,
           memeFp: b.fpServeur()===b.fpClient(), unacked: window.__plan.unackedOps().length };
`, (v: VerdictSonde) => expect(v.enAttente >= 1, "l'op perdue est restée dans la file des non-acquittées")
     && expect(v.srvAvant !== 777, "le serveur ne l'avait pas")
     && expect(v.reemis >= 1, "le délai de garde a réémis")
     && expect(v.srvX === 777, "et la modification est arrivée, vu " + v.srvX)
     && expect(v.localX === 777, "sans rien perdre à l'écran")
     && expect(v.memeFp === true, "client et serveur convergent")
     && expect(v.unacked === 0, "la file est vide"));

// =============================================================================
//  4. THE MIRROR ONLY ADVANCES ON WHAT IS ACKNOWLEDGED
// =============================================================================
// The trap: the client emits by DIFF against a mirror. If it advances that mirror on emission
// and the op gets lost, it believes it was sent forever and never retransmits it. So we keep
// two mirrors, and it's the ACKNOWLEDGED one that serves as memory.
test("le_miroir_acquitte_n_avance_que_sur_l_echo", SEED, `
  var b = fabriquerBanc({});
  await b.demarrer();
  var id = window.__plan.plan.pieces[0].id;
  b.perdre = function(m){ return m.t==="op" && m.op && m.op.kind==="piece.set"; };
  window.__plan.setPos(id, 777, 777); window.__plan.save();
  await b.pousser();
  var optimiste = JSON.parse(window.__plan.shadowOf("pieces", id));
  var acquitte = JSON.parse(window.__plan.shadowAckOf("pieces", id));
  var manque = window.__plan.diffContreAcquitte();
  // the op goes through again: the two mirrors converge
  b.perdre = null;
  window.__plan.ageUnacked(); window.__plan.ackTickNow();
  await b.pousser();
  return { optimisteX: optimiste.x, acquitteX: acquitte.x, manque: manque,
           apresOptimiste: JSON.parse(window.__plan.shadowOf("pieces", id)).x,
           apresAcquitte: JSON.parse(window.__plan.shadowAckOf("pieces", id)).x,
           apresManque: window.__plan.diffContreAcquitte() };
`, (v: VerdictSonde) => expect(v.optimisteX === 777, "le miroir optimiste avance à l'émission, vu " + v.optimisteX)
     && expect(v.acquitteX !== 777, "l'ACQUITTÉ, lui, ne bouge pas tant que rien n'est revenu, vu " + v.acquitteX)
     && expect(v.manque.indexOf("piece.set") >= 0, "et il sait dire ce qui manque au serveur : " + JSON.stringify(v.manque))
     && expect(v.apresAcquitte === 777, "après l'écho, l'acquitté rejoint, vu " + v.apresAcquitte)
     && expect(v.apresManque.length === 0, "et plus rien ne manque : " + JSON.stringify(v.apresManque)));

// =============================================================================
//  5. RETRANSMITTING MEANS SENDING THE CURRENT VALUE, NEVER THE STALE INTENT
// =============================================================================
// This is where we diverge from Replicache's "exactly once" guarantee, which relies on an
// ordered BATCH send. On a frame-by-frame wire, replaying a lost op as-is would make it
// arrive AFTER a more recent op on the same field, and since arrival order is the sole arbiter,
// the stale value would win. So we don't retransmit an op: we redo a diff.
test("reemettre_envoie_la_valeur_courante_pas_l_op_morte", SEED, `
  var b = fabriquerBanc({});
  await b.demarrer();
  var id = window.__plan.plan.pieces[0].id;
  b.perdre = function(m){ return m.t==="op" && m.op && m.op.kind==="piece.set"; };
  window.__plan.setPos(id, 100, 100); window.__plan.save();   // STALE, lost
  await b.pousser();
  window.__plan.setPos(id, 900, 900); window.__plan.save();   // CURRENT, lost too
  await b.pousser();
  b.perdre = null;
  window.__plan.ageUnacked(); window.__plan.ackTickNow();
  await b.pousser();
  return { srvX: srvX(b,id), localX: locX(id), memeFp: b.fpServeur()===b.fpClient(),
           perdues: b.perdues.length };
`, (v: VerdictSonde) => expect(v.perdues === 2, "deux ops perdues, vu " + v.perdues)
     && expect(v.srvX === 900, "le serveur reçoit la valeur COURANTE, jamais la périmée, vu " + v.srvX)
     && expect(v.localX === 900, "l'écran n'a pas bougé")
     && expect(v.memeFp === true, "client et serveur convergent"));

// =============================================================================
//  6. RECONNECTION: whatever was in flight goes back out over the adopted state
// =============================================================================
// On reconnection, the `hello` makes the client ADOPT the server's plan: without a replay,
// everything that was in flight at the moment of the drop used to vanish from its author's
// screen, without a word.
test("reconnexion_le_travail_en_vol_est_repose_sur_l_etat_adopte", SEED, `
  var b = fabriquerBanc({});
  await b.demarrer();
  var id = window.__plan.plan.pieces[0].id;
  b.perdre = function(m){ return m.t==="op"; };          // the link no longer gets through, in this direction
  window.__plan.setPos(id, 777, 777); window.__plan.save();
  await b.pousser();
  var enVol = window.__plan.unackedOps().length;
  // the link drops for good
  var chute = window.__plan.wsSimulerChute();
  b.perdre = null;
  await b.reconnecter("bbb222");
  return { enVol: enVol, aRejouer: chute.aRejouer, srvX: srvX(b,id),
           localX: locX(id), memeFp: b.fpServeur()===b.fpClient(),
           acks: window.__plan.acksOn };
`, (v: VerdictSonde) => expect(v.enVol >= 1, "des ops étaient en vol à la coupure, vu " + v.enVol)
     && expect(v.aRejouer === true, "la chute retient qu'il y aura du travail à reposer")
     && expect(v.localX === 777, "l'adoption n'a PAS effacé le travail de l'auteur, vu " + v.localX)
     && expect(v.srvX === 777, "et il est reparti vers le serveur, vu " + v.srvX)
     && expect(v.memeFp === true, "client et serveur convergent après la reprise"));

// Nothing to replay -> nothing goes out: an ordinary reconnection does not republish the plan.
test("reconnexion_sans_travail_en_vol_ne_republie_rien", SEED, `
  var b = fabriquerBanc({});
  await b.demarrer();
  var id = window.__plan.plan.pieces[0].id;
  window.__plan.setPos(id, 300, 300); window.__plan.save();
  await b.pousser();
  window.__plan.wsSimulerChute();
  var opsAvant = window.__plan.opLog(true).length;
  var log = window.__plan.opLog(true);
  await b.reconnecter("ccc333");
  var emises = log.length;
  return { emises: emises, memeFp: b.fpServeur()===b.fpClient(), localX: locX(id) };
`, (v: VerdictSonde) => expect(v.emises === 0, "aucune op émise à la reconnexion, vu " + v.emises)
     && expect(v.localX === 300, "et le plan est intact")
     && expect(v.memeFp === true, "client et serveur restent d'accord"));

// =============================================================================
//  7. REORDERING AND DELAY: nothing gets lost, and nothing travels back in time
// =============================================================================
test("retard_et_reordonnancement_ne_perdent_rien", SEED, `
  var b = fabriquerBanc({});
  await b.demarrer();
  var k = 0;
  b.retard = function(m){ return (m.t==="op" && (k++)%2===0) ? 2 : 0; };
  var ids = window.__plan.plan.pieces.slice(0,6).map(function(p){ return p.id; });
  for (var i=0;i<ids.length;i++){ window.__plan.setPos(ids[i], 200+i*10, 200+i*10); window.__plan.save(); await b.pousser(); }
  b.retard = null;
  await b.viderRetards();
  window.__plan.ageUnacked(); window.__plan.ackTickNow();
  await b.pousser();
  var ecarts = [];
  for (var j=0;j<ids.length;j++){
    var s = b.room.plan.pieces.filter(function(p){ return String(p.id)===String(ids[j]); })[0];
    var l = window.__plan.pieceAt(ids[j]);
    if (!s || Math.round(s.x + (s.w||0)/2) !== l.cx) ecarts.push(ids[j]);
  }
  return { ecarts: ecarts, memeFp: b.fpServeur()===b.fpClient(), unacked: window.__plan.unackedOps().length };
`, (v: VerdictSonde) => expect(v.ecarts.length === 0, "aucun meuble en désaccord : " + JSON.stringify(v.ecarts))
     && expect(v.memeFp === true, "client et serveur portent la même empreinte")
     && expect(v.unacked === 0, "rien n'attend plus"));

// =============================================================================
//  8. LOST BURST: half the frames drop during real work
// =============================================================================
test("une_trame_sur_deux_perdue_le_plan_converge_quand_meme", SEED, `
  var b = fabriquerBanc({});
  await b.demarrer();
  var k = 0;
  b.perdre = function(m){ return m.t==="op" && (k++)%2===0; };
  var ids = window.__plan.plan.pieces.slice(0,8).map(function(p){ return p.id; });
  for (var i=0;i<ids.length;i++){
    window.__plan.setPos(ids[i], 150+i*20, 150+i*20); window.__plan.save();
    await b.pousser();
    window.__plan.ageUnacked(); window.__plan.ackTickNow(); await b.pousser();
  }
  b.perdre = null;
  for (var t=0;t<4;t++){ window.__plan.ageUnacked(); window.__plan.ackTickNow(); await b.pousser(); }
  return { perdues: b.perdues.length, memeFp: b.fpServeur()===b.fpClient(),
           unacked: window.__plan.unackedOps().length, reemis: window.__plan.retransmits };
`, (v: VerdictSonde) => expect(v.perdues >= 4, "des trames ont bien été perdues, vu " + v.perdues)
     && expect(v.reemis >= 1, "il a fallu réémettre, vu " + v.reemis)
     && expect(v.memeFp === true, "et le plan CONVERGE malgré tout")
     && expect(v.unacked === 0, "rien ne reste en attente, vu " + v.unacked));

// =============================================================================
//  9. A REJECTION IS NOT A LOSS
// =============================================================================
// An op rejected by the server must not trigger a retransmission: the client got its answer
// (`err`), it UNDOES the change. Without this, rejection and retransmission would fight forever.
test("un_refus_ne_declenche_pas_de_reemission", SEED, `
  var b = fabriquerBanc({});
  await b.demarrer();
  var avantFp = b.fpServeur();
  // a deliberately invalid op, sent through the ordinary path
  window.__plan.wsFeed({t:"err", reason:"op_fail", n:999, kind:"wall.set"});
  var apres1 = window.__plan.unackedOps().length;
  // and a real op rejected by the REAL validator: wall thickness out of bounds
  var mur = window.__plan.plan.walls.filter(function(w){ return !w.isOutline; })[0];
  var res = null;
  if (mur){ mur.t = 99; window.__plan.save(); await b.pousser(); res = window.__plan.retransmits; }
  window.__plan.ageUnacked(); window.__plan.ackTickNow(); await b.pousser();
  return { apres1: apres1, reemis: window.__plan.retransmits, unacked: window.__plan.unackedOps().length,
           murServeur: mur ? (b.room.plan.walls.filter(function(w){ return String(w.id)===String(mur.id); })[0]||{}).t : null };
`, (v: VerdictSonde) => expect(v.apres1 === 0, "un err sur un numéro inconnu ne laisse rien en attente")
     && expect(v.unacked === 0, "après un refus, la file est vide, vu " + v.unacked)
     && expect(v.murServeur !== 99, "et le serveur n'a pas pris l'épaisseur refusée, vu " + v.murServeur));

// =============================================================================
//  10. THE DURABLE OBJECT'S COUNTER IS NO LONGER A HOMONYM
// =============================================================================
test("aucun_chemin_ne_compare_plus_deux_compteurs", SEED, `
  var b = fabriquerBanc({});
  var revAvant = window.__plan.serverRev;
  await b.demarrer();
  var id = window.__plan.plan.pieces[0].id;
  for (var i=0;i<5;i++){ window.__plan.setPos(id, 200+i, 200+i); window.__plan.save(); await b.pousser(); }
  // The server has counted its ops; the D1 fallback's counter, meanwhile, hasn't budged an inch.
  return { opCount: b.room.opCount, revClient: window.__plan.serverRev, revAvant: revAvant,
           doPorteRev: ("rev" in b.room) };
`, (v: VerdictSonde) => expect(v.opCount > 0, "le Durable Object a bien compté ses ops, vu " + v.opCount)
     && expect(v.doPorteRev === false, "le Durable Object ne porte plus aucun champ nommé rev")
     && expect(v.revClient === v.revAvant, "le compteur du repli D1 n'a pas bougé, vu " + v.revClient));

// =============================================================================
//  11. COMPATIBILITY: new messages do not disturb a tab that ignores them
// =============================================================================
// An OLD tab in front of the new Worker receives three novelties: an extra `n` and `opCount`
// in the echo (unknown keys, ignored), and two message kinds it doesn't know (`ack`,
// `gap`). Its receive dispatcher has no default branch: an unknown kind does
// NOTHING. We check this here on the plan and on the error log.
test("les_messages_neufs_ne_derangent_pas_un_onglet_qui_les_ignore", SEED, `
  var b = fabriquerBanc({});
  await b.demarrer();
  var id = window.__plan.plan.pieces[0].id;
  window.__plan.setPos(id, 400, 400); window.__plan.save();
  await b.pousser();
  var avant = b.fpClient();
  var journal = window.__plan.outLog(true);
  ["ack","gap","inconnu","futur"].forEach(function(t){
    window.__plan.wsFeed({t:t, n:1234, tag:"zzzzzz", need:7, quelquechose:{a:1}});
  });
  return { avant: avant, apres: b.fpClient(), sorti: journal.length, x: locX(id) };
`, (v: VerdictSonde) => expect(v.avant === v.apres, "aucun message inconnu ne touche au plan")
     && expect(v.x === 400, "et le meuble n'a pas bougé")
     && expect(v.sorti === 0, "aucun message n'est parti en réponse, vu " + v.sorti));

// ---- verdict -----------------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
process.stdout.write("\n" + (results.length - failed.length) + "/" + results.length + " vérifications passent\n");
try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch (_) {}
process.exit(failed.length ? 1 : 0);
