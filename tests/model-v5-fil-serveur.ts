#!/usr/bin/env node
// THE WIRE: the shape the server expects (validated by the REAL live-worker/ops.ts), what the
// client says when the server REFUSES, and the D1 fallback (functions/api/plan.ts) that takes over.
import type { DonneeDynamique } from "./_types.ts";
import { sanitizeState, applyOp, isV5 } from "../live-worker/ops.ts";
import { runProbe, test, near, expect, seedV4, results, REAL_PLAN, SEED_PLAN, report } from "./_harness-v5.ts";

// AUTO is empty: there's no more manual toggle, a plan in the old format planted in
// localStorage is read and converted on load (see model-v5-modele-defaut.ts).
const AUTO = "";
const seedAuto = (st: DonneeDynamique) => AUTO + seedV4(st);


// =============================================================================
//  7. WIRE SHAPE (what the server expects) + COLLABORATION
// =============================================================================
test("v5_wire_shape_is_server_shape", seedV4(REAL_PLAN), `
  var wire = window.__plan.wire();
  var ser = window.__plan.serialize();
  return { wire: wire, serKeys: Object.keys(ser).sort().join(","),
           serTop: { outline: Array.isArray(ser.outline), walls: Array.isArray(ser.walls),
                     openings: Array.isArray(ser.openings), pieces: Array.isArray(ser.pieces),
                     cells: Array.isArray(ser.cells), model: ser.model },
           serPayload: { outline: ser.outline, walls: ser.walls, openings: ser.openings,
                         pieces: ser.pieces, cells: ser.cells, setupDone: ser.setupDone,
                         rooms: ser.rooms, opts: ser.opts, plan: ser.plan, active: ser.active,
                         model: ser.model, envelope: ser.envelope } };
`, v => {
  const w = v.wire;
  // 1. the server's op-validator accepts the payload as is
  let clean, cleanFull;
  try { clean = sanitizeState(w); }
  catch (e) { return "sanitizeState(wire) rejected the payload: " + (e && e.reason || e); }
  try { cleanFull = sanitizeState(v.serPayload); }
  catch (e) { return "sanitizeState(serialize()) rejected the real PUT body: " + (e && e.reason || e); }
  return expect(isV5(clean), "the server must detect the wire as v5")
      && expect(isV5(cleanFull), "the server must detect the full serialize() payload as v5")
      && expect(v.serTop.outline && v.serTop.walls && v.serTop.openings && v.serTop.pieces && v.serTop.cells,
         "serialize() must put the v5 plan at TOP LEVEL, got " + JSON.stringify(v.serTop))
      && expect(v.serTop.model === "v5", "serialize() must carry model:v5, got " + v.serTop.model)
      && expect(clean.walls.length === w.walls.length && clean.cells.length === w.cells.length
         && clean.openings.length === w.openings.length && clean.pieces.length === w.pieces.length,
         "the server dropped entities: " + JSON.stringify({w: clean.walls.length, c: clean.cells.length,
           o: clean.openings.length, p: clean.pieces.length}))
      && expect(w.walls.every((x: DonneeDynamique) => typeof x.id === "string" && x.isOutline === undefined && x.t >= 1 && x.t <= 60),
         "wall wire must be {id:string,a,b,t in [1,60]} with NO isOutline")
      && expect(w.openings.every((o: DonneeDynamique) => typeof o.id === "string" && typeof o.wallId === "string"
         && o.t0 >= 0 && o.w >= 1 && o.w <= 600
         && o.h >= 1 && o.h <= 200 && (o.side === 0 || o.side === 1)
         && typeof o.name === "string" && o.name.length <= 80
         && (o.hinge === undefined || o.hinge === 0 || o.hinge === 1)),
         "opening wire must be {id,wallId,t0,w,h,type,side,name,hinge?,swing?} (forme DÉPLIÉE) with string ids")
      && expect(w.pieces.every((p: DonneeDynamique) => typeof p.id === "string"), "piece ids must be strings on the wire")
      && expect(w.cells.every((c: DonneeDynamique) => typeof c.id === "string"
         && ["parquet","herringbone","tile","plain"].includes(c.floor)),
         "cell ids must be strings and floors within the allowed set");
});

// 7c. The diff-emitter produces the server's v5 ops, and they really do apply to a server plan.
test("v5_diff_emits_server_ops", "", `
  window.__plan.setModel(${SEED_PLAN});
  var P = window.__plan.plan;
  window.__plan.rebuildCells(P);
  window.__plan.shadowSync();
  var base = window.__plan.wire();

  window.__plan.opLog(true);
  window.__plan.moveWall("w1", -100);
  window.__plan.forceDiff();
  var afterMove = window.__plan.opLog(false);

  window.__plan.shadowSync();
  window.__plan.opLog(true);
  // the BIGGEST cell (P.cells order follows the pole of inaccessibility, not size)
  var big = P.cells.slice().sort(function(x,y){ return window.__plan.overlapArea(y.poly,y.poly) - window.__plan.overlapArea(x.poly,x.poly); })[0];
  window.__plan.setCell(big.id, "Bureau", "tile");
  window.__plan.forceDiff();
  var afterRename = window.__plan.opLog(false);

  window.__plan.shadowSync();
  window.__plan.opLog(true);
  window.__plan.delWall("w1");
  window.__plan.forceDiff();
  var afterDel = window.__plan.opLog(false);

  return { base: base, move: afterMove, rename: afterRename, del: afterDel };
`, v => {
  const kinds = (a: DonneeDynamique) => a.map((o: DonneeDynamique) => o.kind);
  // replays the sequence on a clean SERVER plan: every op must be accepted
  let plan;
  try { plan = sanitizeState(v.base); } catch (e) { return "base state rejected: " + (e && e.reason || e); }
  const all = [].concat(v.move, v.rename, v.del);
  for (const op of all) {
    try { applyOp(plan, op); }
    catch (e) { return "server refused " + op.kind + ": " + (e && e.reason || e); }
  }
  return expect(kinds(v.move).includes("wall.set"), "a wall move must emit wall.set, got " + JSON.stringify(kinds(v.move)))
      && expect(kinds(v.move).includes("cells.replace"),
         "a geometry change must republish the cells (cells.replace), got " + JSON.stringify(kinds(v.move)))
      && expect(kinds(v.rename).includes("cell.set") && !kinds(v.rename).includes("cells.replace"),
         "a rename must emit cell.set only, got " + JSON.stringify(kinds(v.rename)))
      && expect(kinds(v.del).includes("wall.del"), "deleting a wall must emit wall.del, got " + JSON.stringify(kinds(v.del)))
      && expect(plan.walls.filter(w => w.id === "w1").length === 0, "the server plan should have lost w1")
      && expect(plan.cells.some(c => c.name === "Bureau" && c.floor === "tile"),
         "the rename must have landed on the server plan: " + JSON.stringify(plan.cells.map(c => c.name)));
});

// 7d. Remote ops MUTATE objects in place (the v4 "orphan echo" fix: a DOM node holds a closure
// on the object; replacing it used to kill the next drag). Cells are re-detected.
test("v5_remote_ops_mutate_in_place", "", `
  window.__plan.setModel(${SEED_PLAN});
  var P = window.__plan.plan;
  window.__plan.rebuildCells(P);
  P.pieces.push({id:"p1", type:"sofa3", name:"Canapé", x:40, y:40, w:220, h:95, rot:0, locked:false});
  var w = P.walls.filter(function(x){ return x.id==="w1"; })[0];
  w.__mark = "keep-wall";
  P.pieces[0].__mark = "keep-piece";
  P.openings.push({id:"o1", wallId:"w1", t0:100, w:80, h:12, type:"door", side:0, hinge:0, swing:1});
  P.openings[0].__mark = "keep-opening";

  window.__plan.applyRemote({kind:"wall.set", wall:{id:"w1", a:[420,0], b:[420,400], t:12}});
  window.__plan.applyRemote({kind:"piece.set", piece:{id:"p1", type:"sofa3", name:"Canapé bis",
    x:60, y:60, w:220, h:95, rot:0, locked:false}});
  window.__plan.applyRemote({kind:"opening.set", opening:{id:"o1", wallId:"w1", t0:200, w:80, type:"door", hinge:1, swing:-1}});

  var w2 = P.walls.filter(function(x){ return x.id==="w1"; })[0];
  var p2 = P.pieces.filter(function(x){ return x.id==="p1"; })[0];
  var o2 = P.openings.filter(function(x){ return x.id==="o1"; })[0];
  // a remote op that deletes the wall must also purge its openings and re-merge the cells
  window.__plan.applyRemote({kind:"wall.del", wallId:"w1"});
  return { wallMark: w2.__mark, wallX: w2.a[0],
           pieceMark: p2.__mark, pieceName: p2.name, pieceX: p2.x,
           openMark: o2.__mark, openT0: o2.t0, openHinge: o2.hinge, openSwing: o2.swing,
           cellsAfterMove: 2, cellsAfterDel: P.cells.length, openingsAfterDel: P.openings.length };
`, v => expect(v.wallMark === "keep-wall" && v.wallX === 420,
        "a remote wall.set must mutate the existing wall object, got " + JSON.stringify(v))
     && expect(v.pieceMark === "keep-piece" && v.pieceName === "Canapé bis" && v.pieceX === 60,
        "a remote piece.set must mutate in place, got " + JSON.stringify(v))
     && expect(v.openMark === "keep-opening" && v.openT0 === 200 && v.openHinge === 1 && v.openSwing === -1,
        "a remote opening.set must mutate in place and unpack hinge/side, got " + JSON.stringify(v))
     && expect(v.cellsAfterDel === 1, "after the remote wall.del the cells must be re-detected and merged, got " + v.cellsAfterDel)
     && expect(v.openingsAfterDel === 0, "the remote wall.del must cascade its openings client-side, got " + v.openingsAfterDel));

// 7e. A 100% SERVER state (flat v5 shape, no v4 room whatsoever, what a late arrival receives)
// boots directly in v5, with no JS error, with a dummy room for the v4 scaffolding.
test("v5_boots_from_a_server_shaped_state", `try{ localStorage.setItem("room-planner-v4", JSON.stringify({
  outline:[[0,0],[600,0],[600,400],[0,400]],
  walls:[{id:"w1", a:[300,0], b:[300,400], t:12}],
  openings:[{id:"o1", wallId:"w1", t0:150, w:80, type:"door", hinge:3, swing:-1}],
  pieces:[{id:"p1", type:"sofa3", name:"Canapé", x:20, y:20, w:220, h:95, rot:0, locked:false}],
  cells:[{id:"c1", poly:[[0,0],[300,0],[300,400],[0,400]], name:"Salon", floor:"tile"},
         {id:"c2", poly:[[300,0],[600,0],[600,400],[300,400]], name:"Chambre", floor:"parquet"}],
  setupDone:true, model:"v5" })); }catch(e){}`, `
  var P = window.__plan.plan;
  var o = P.openings[0];
  return { model: window.__plan.model, cells: P.cells.length, names: P.cells.map(function(c){return c.name;}),
           layer: document.querySelectorAll(".v5layer").length,
           aptrooms: document.querySelectorAll("#canvas .aptroom").length,
           canvasV5: document.getElementById("canvas").classList.contains("v5"),
           side: o.side, hinge: o.hinge, swing: o.swing, h: o.h,
           facades: P.walls.filter(function(w){ return w.isOutline; }).length,
           pieceId: typeof P.pieces[0].id };
`, v => expect(v.model === "v5", "a server-shaped payload must boot in v5, got " + v.model)
     && expect(v.layer === 1 && v.canvasV5 === true, "the v5 layer must be live at boot")
     && expect(v.aptrooms === 0, "no v4 container should be built, got " + v.aptrooms)
     && expect(v.cells === 2 && v.names.indexOf("Salon") >= 0, "cell metadata must survive, got " + JSON.stringify(v.names))
     && expect(v.side === 1 && v.hinge === 1 && v.swing === -1,
        "hinge=3 must unpack to side=1/hinge=1 and swing must survive, got " + JSON.stringify(v))
     && expect(v.h > 0, "the opening depth must be re-derived from the catalogue, got " + v.h)
     && expect(v.pieceId === "string", "ids must be strings, got " + v.pieceId));


// =============================================================================
//  10. THE SERVER REFUSES, THE CLIENT MUST SAY SO
//      (wire error reasons, input bounds, identifiers in selectors)
// =============================================================================
// The emitter works by DIFF: `wsShadowSync()` marks the value as acknowledged right after
// emission, so a refused op is NEVER resent. A `console.warn` was letting the screen claim the
// change was shared when it had been lost.

// 10a. `too_big`: the shared plan has reached its maximum size. Clear message, and ABOVE ALL no
// reload (reloading doesn't shrink the plan, and would cost the work in progress).
test("v5_err_too_big_is_announced_without_a_reload", seedAuto(REAL_PLAN), `
  window.__plan.wsForceOpen(true);
  window.__plan.clearToast();
  window.__plan.wsFeed({ t: "err", reason: "too_big" });
  var txt = window.__plan.toastText;
  var reload = null; try { reload = sessionStorage.getItem("plan-model-reload"); } catch(e){}
  window.__plan.wsForceOpen(false);
  return { txt: txt, reload: reload };
`, v => expect(!!v.txt, "un toast doit annoncer la perte, got " + JSON.stringify(v.txt))
     && expect(/maximum size/i.test(v.txt) && /NOT saved/i.test(v.txt),
        "le message doit nommer la cause ET dire que rien n'est enregistré, got " + v.txt)
     && expect(v.reload === null, "`too_big` ne doit PAS déclencher le rechargement de conflit de modèle"));

// 10b. `persist_fail`: the op was valid, the server write failed and the server rolled back.
// The change is lost for everyone: we ask them to redo it.
test("v5_err_persist_fail_is_announced_without_a_reload", seedAuto(REAL_PLAN), `
  window.__plan.wsForceOpen(true);
  window.__plan.clearToast();
  window.__plan.wsFeed({ t: "err", reason: "persist_fail" });
  var txt = window.__plan.toastText;
  var reload = null; try { reload = sessionStorage.getItem("plan-model-reload"); } catch(e){}
  window.__plan.wsForceOpen(false);
  return { txt: txt, reload: reload };
`, v => expect(!!v.txt, "un toast doit annoncer la perte")
     && expect(/could not save/i.test(v.txt) && /do it again/i.test(v.txt),
        "le message doit dire quoi faire, got " + v.txt)
     && expect(v.reload === null, "`persist_fail` ne doit PAS déclencher le rechargement"));

// 10c. Any VALIDATION REFUSAL (here `wall_t`, an out-of-bounds thickness) was the most silent
// case of all: the op is dropped by ops.ts and nothing appeared on screen.
test("v5_err_op_refusee_is_announced_with_its_reason", seedAuto(REAL_PLAN), `
  window.__plan.wsForceOpen(true);
  window.__plan.clearToast();
  window.__plan.wsFeed({ t: "err", reason: "wall_t" });
  var txt = window.__plan.toastText;
  window.__plan.wsForceOpen(false);
  return { txt: txt };
`, v => expect(!!v.txt, "un refus d'op doit être annoncé")
     && expect(/wall_t/.test(v.txt) && /NOT saved/i.test(v.txt),
        "le message doit nommer le motif et l'effet, got " + v.txt));

// 10d. A gesture produces a BURST of ops (one per cell, one per piece of furniture): a toast per
// refusal would flood the screen. Only one per reason and per window; a DIFFERENT reason gets
// through right away.
test("v5_err_toast_is_throttled_per_reason", seedAuto(REAL_PLAN), `
  window.__plan.wsForceOpen(true);
  window.__plan.clearToast();
  window.__plan.wsFeed({ t: "err", reason: "cell_dup" });
  var first = window.__plan.toastText;
  window.__plan.clearToast();
  window.__plan.wsFeed({ t: "err", reason: "cell_dup" });   // same reason, right away -> silenced
  var repeat = window.__plan.toastText;
  window.__plan.wsFeed({ t: "err", reason: "piece_wh" });   // different reason -> announced
  var other = window.__plan.toastText;
  window.__plan.wsForceOpen(false);
  return { first: first, repeat: repeat, other: other };
`, v => expect(!!v.first, "le premier refus doit être annoncé")
     && expect(v.repeat === null, "le même motif répété ne doit pas re-toaster, got " + JSON.stringify(v.repeat))
     && expect(!!v.other && /piece_wh/.test(v.other), "un autre motif doit passer, got " + JSON.stringify(v.other)));

// 10e. `op_shape` stays a MODEL CONFLICT: it alone reloads (the tab is no longer on the shared
// plan's model). Guardrail: the grouping of error messages must not have drowned it out.
test("v5_err_op_shape_still_reloads", seedAuto(REAL_PLAN), `
  window.__plan.wsForceOpen(true);
  window.__plan.clearToast();
  window.__plan.wsFeed({ t: "err", reason: "op_shape" });
  var txt = window.__plan.toastText;
  var reload = null; try { reload = sessionStorage.getItem("plan-model-reload"); } catch(e){}
  window.__plan.wsForceOpen(false);
  return { txt: txt, reload: reload };
`, v => expect(!!v.txt && /model/i.test(v.txt), "le conflit de modèle garde son message, got " + v.txt)
     && expect(v.reload === "1", "`op_shape` doit armer le rechargement, got " + JSON.stringify(v.reload)));

// 10f. NAME fields are bounded to what the shared plan retains (ops.ts NAME_MAX = 80).
// Without this bound, the user would see a name that the server silently truncated.
test("v5_name_fields_are_capped_at_the_server_limit", seedAuto(REAL_PLAN), `
  var long = new Array(140).join("a") + "FIN";        // 142 characters
  var iName = document.getElementById("iName"), rcName = document.getElementById("rcName");
  var P = window.__plan.plan;
  window.__plan.selReplace(P.pieces[0].id); window.__plan.openInspector();
  // pasting / a programmatically set value bypasses maxlength: the handler bounds it too.
  iName.value = long;
  iName.dispatchEvent(new Event("input", { bubbles: true }));
  var stored = window.__plan.pieceById(P.pieces[0].id).name;
  return { maxI: iName.getAttribute("maxlength"), maxRc: rcName.getAttribute("maxlength"),
           stored: stored.length, tail: stored.slice(-3) };
`, v => expect(v.maxI === "80", "#iName (meuble ET ouverture) doit être borné à 80, got " + v.maxI)
     && expect(v.maxRc === "80", "#rcName (cellule) doit être borné à 80, got " + v.maxRc)
     && expect(v.stored === 80, "un nom collé doit être tronqué à 80, got " + v.stored));

// 10g. An identifier coming from the WIRE ends up in a CSS selector. A `"]` used to make
// querySelector THROW, and that call is made from render(): the whole application would go
// down, not just the offending ghost. The server now bounds ids, this is the last line of defense.
test("v5_ghost_selector_resists_a_hostile_id", seedAuto(REAL_PLAN), `
  var P = window.__plan.plan;
  var p = P.pieces[0];
  var bb = window.__plan.bboxOfPoly(P.outline);
  window.__plan.wsForceOpen(true);
  // hostile id: closes the selector's string then the attribute block
  window.__plan.wsFeed({ t: "drag", by: "b@example.com", room: "__apt__",
                         pieceId: 'x"] , * { display:none } .piece[data-id="', x: 100, y: 100 });
  window.__plan.render();                        // render() reapplies ALL active ghosts
  // a legitimate ghost must keep working: the loop wasn't killed
  window.__plan.wsFeed({ t: "drag", by: "b@example.com", room: "__apt__",
                         pieceId: String(p.id), x: p.x + 120, y: p.y + 80, rot: p.rot || 0 });
  window.__plan.render();
  var pose = window.__plan.ghostPose(p.id);
  var visible = document.querySelectorAll("#canvas .v5layer .piece").length;
  window.__plan.wsForceOpen(false);
  return { pose: pose, visible: visible,
           expLeft: ((p.x + 120 - bb.minX) * window.__plan.vScale) + "px" };
`, v => expect(v.visible > 0, "le calque doit toujours peindre ses meubles (aucun sélecteur ne doit avoir levé)")
     && expect(!!v.pose && v.pose.ghost === true, "le fantôme légitime doit encore se poser")
     && expect(near(parseFloat(v.pose.left), parseFloat(v.expLeft), 0.05),
        "le fantôme légitime doit être posé au bon endroit, got " + v.pose.left));

// 10h. `piece.front` no longer exists server-side: the reception branch has been removed.
// An op with this name must be IGNORED without breaking anything (neither furniture order nor
// a JS error).
test("v5_piece_front_op_is_dead_and_ignored", seedAuto(REAL_PLAN), `
  var P = window.__plan.plan;
  var before = P.pieces.map(function(p){ return String(p.id); });
  window.__plan.applyRemote({ kind: "piece.front", pieceId: before[0] });
  var after = window.__plan.plan.pieces.map(function(p){ return String(p.id); });
  return { before: before, after: after };
`, v => expect(JSON.stringify(v.before) === JSON.stringify(v.after),
        "l'ordre du mobilier ne doit pas bouger, got " + JSON.stringify(v.after.slice(0, 3))));

// =============================================================================
//  11. THE D1 FALLBACK (functions/api/plan.ts) MUST REALLY TAKE OVER
// =============================================================================
// When realtime goes down, the chip announces "slow sync: deferred sync". This fallback is the
// only safety net, and its PUT used to refuse every walls-only state (`!Array.isArray(st.rooms)`):
// nothing got through, the two people would diverge silently. Here we replay the real path:
//   client A -> serialize() -> onRequestPut -> D1 -> onRequestGet -> migrate() on client B.
const planApi = await import("../functions/api/plan.ts");

// In-memory D1: a single 'main' row, same columns as schema.sql.
function fakeD1() {
  const store = { row: null as DonneeDynamique };
  const mk = (sql: DonneeDynamique) => ({
    args: [] as DonneeDynamique[],
    bind(...a: DonneeDynamique[]) { this.args = a; return this; },
    async first() {
      if (/SELECT data/.test(sql)) {
        return store.row ? { data: store.row.data, rev: store.row.rev,
                             updated_at: store.row.updated_at, updated_by: store.row.updated_by } : null;
      }
      if (/SELECT rev/.test(sql)) return store.row ? { rev: store.row.rev } : null;
      return null;
    },
    async run() {
      const [data, now, by] = this.args;
      store.row = { data, rev: store.row ? store.row.rev + 1 : 1, updated_at: now, updated_by: by };
      return { success: true };
    },
  });
  return { store, DB: { prepare: mk } };
}
const putState = async (env: DonneeDynamique, state: DonneeDynamique) => planApi.onRequestPut({
  request: new Request("https://plan.example.org/api/plan", {
    method: "PUT",
    headers: { "Content-Type": "application/json",
               "Cf-Access-Authenticated-User-Email": "a@example.com" },
    body: JSON.stringify({ state }),
  }),
  env,
} as unknown as Parameters<typeof planApi.onRequestPut>[0]);

// Like `test()`, but the body drives its own probes (several phases, async calls).
async function testRaw(name: string, fn: (...args: DonneeDynamique[]) => DonneeDynamique | Promise<DonneeDynamique>) {
  let pass = false, detail = "";
  try { const r = await fn(); if (r === true) pass = true; else detail = r || "assertion returned falsy"; }
  catch (e) { detail = String(e && e.stack || e); }
  results.push({ name, pass, detail, verdict: null });
  process.stdout.write((pass ? "  ok   " : "  FAIL ") + name + "\n");
  if (!pass) process.stdout.write("       " + detail.replace(/\n/g, "\n       ") + "\n");
}

// 11a. What the client ACTUALLY SENDS (serialize() of the real converted plan) goes through the
// PUT, comes back out of the GET, and is readopted by a SECOND, blank browser via migrate().
// This is the end-to-end proof that the fallback works: a change goes through.
const fallbackProbe = runProbe("repli-serialize", seedAuto(REAL_PLAN), `
  var P = window.__plan.plan;
  P.cells[0].name = "Repli D1";                 // THE change that must go through
  window.__plan.render(); window.__plan.save();
  return { state: window.__plan.serialize(),
           cells: P.cells.length, walls: P.walls.length, pieces: P.pieces.length,
           openings: P.openings.length, changed: P.cells[0].name,
           hasRooms: Array.isArray(window.__plan.serialize().rooms) };
`);

let fallbackGet: DonneeDynamique = null;
await testRaw("repli_d1_accepte_l_etat_murs_seuls_du_client", async () => {
  expect(!fallbackProbe.__probeError && !fallbackProbe.__noVerdict,
    "la sonde doit produire un état : " + JSON.stringify(fallbackProbe).slice(0, 300));
  // The original guard tested EXACTLY this, and so refused 100% of the live model's PUTs.
  expect(fallbackProbe.hasRooms === false, "l'état du client n'a plus de `rooms` : c'est bien le cas qui était refusé");
  const env = fakeD1();
  const res = await putState(env, fallbackProbe.state);
  expect(res.status === 200, "le PUT doit être accepté, got " + res.status + " " + await res.clone().text());
  const body = await res.json() as ReturnType<typeof JSON.parse>;
  expect(body.ok === true && body.rev === 1, "le PUT doit renvoyer une révision, got " + JSON.stringify(body));
  expect(body.updatedBy === "a@example.com", "l'identité Access doit être enregistrée, got " + body.updatedBy);
  const got = await (await planApi.onRequestGet(
    { env } as unknown as Parameters<typeof planApi.onRequestGet>[0],
  )).json() as ReturnType<typeof JSON.parse>;
  expect(got.rev === 1 && got.data && typeof got.data === "object", "le GET doit rendre la ligne, got " + JSON.stringify(got).slice(0, 200));
  fallbackGet = got.data;
  // The row written by the fallback must also be readable cold by the WORKER (sanitizeState):
  // otherwise realtime's return would start over from an empty plan.
  const cold = sanitizeState(JSON.parse(JSON.stringify(got.data)));
  expect(isV5(cold), "la ligne écrite par le repli doit être un état murs-seuls pour le Worker");
  expect(cold.walls.length === fallbackProbe.walls, "murs conservés : " + cold.walls.length + " au lieu de " + fallbackProbe.walls);
  return true;
});

// 11b. the other browser ADOPTS what the fallback wrote (migrate() on the GET's payload).
await testRaw("repli_d1_le_pair_adopte_le_changement", () => {
  expect(!!fallbackGet, "le GET du cas précédent doit avoir rendu une charge");
  const v = runProbe("repli-adopt", "", `
    var payload = ${JSON.stringify(fallbackGet)};
    var ns = window.__plan.migrate(payload);
    return { ok: !!(ns && ns.plan),
             cells: ns && ns.plan ? ns.plan.cells.length : -1,
             walls: ns && ns.plan ? ns.plan.walls.length : -1,
             pieces: ns && ns.plan ? ns.plan.pieces.length : -1,
             openings: ns && ns.plan ? ns.plan.openings.length : -1,
             firstCell: ns && ns.plan && ns.plan.cells[0] ? ns.plan.cells[0].name : null,
             serverHasPlan: window.__plan.serverHasPlan(payload) };
  `);
  expect(!v.__probeError && !v.__noVerdict, "la sonde d'adoption doit produire un verdict : " + JSON.stringify(v).slice(0, 300));
  expect(v.serverHasPlan === true, "le client doit reconnaître ce plan serveur (serverHasPlan)");
  expect(v.ok === true, "migrate() doit accepter la charge du GET");
  expect(v.cells === fallbackProbe.cells && v.walls === fallbackProbe.walls
      && v.pieces === fallbackProbe.pieces && v.openings === fallbackProbe.openings,
    "le plan adopté doit être identique : " + JSON.stringify({ cells: v.cells, walls: v.walls, pieces: v.pieces, openings: v.openings })
    + " au lieu de " + JSON.stringify({ cells: fallbackProbe.cells, walls: fallbackProbe.walls, pieces: fallbackProbe.pieces, openings: fallbackProbe.openings }));
  expect(v.firstCell === "Repli D1", "LE changement doit avoir traversé, got " + JSON.stringify(v.firstCell));
  return true;
});

// 11c. the PUT stays strict: no empty payload, no unknown shape, no array.
await testRaw("repli_d1_refuse_toujours_une_forme_inconnue", async () => {
  const env = fakeD1();
  const bad: DonneeDynamique[] = [null, 42, "x", [], { foo: 1 }, { rooms: "non" }];
  for (const st of bad) {
    const r = await putState(env, st);
    expect(r.status === 400, "état " + JSON.stringify(st) + " doit être refusé, got " + r.status);
  }
  // and the OLD format stays accepted (a tab that was never reloaded can still send it)
  const okOld = await putState(env, { rooms: [], envelope: null, setupDone: true });
  expect(okOld.status === 200, "l'ancien format doit rester accepté, got " + okOld.status);
  expect(env.store.row.rev === 1, "seul le PUT valide doit avoir écrit, rev=" + env.store.row.rev);
  return true;
});

// ---- verdict -----------------------------------------------------------------------------------
report();
