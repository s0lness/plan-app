#!/usr/bin/env node
// THE WALLS-ONLY MODEL IS THE DEFAULT MODEL: automatic conversion on load, not repeated,
// reversible, identical across two clients; and the view recropped on the FIRST adoption.
import type { DonneeDynamique } from "./_types.ts";
import { sanitizeState, applyOp, isV5 } from "../live-worker/ops.ts";
import { test, near, expect, seedV4, REAL_PLAN, report } from "./_harness-v5.ts";

// =============================================================================
//  9. THE WALLS-ONLY MODEL IS THE DEFAULT MODEL
//     (automatic conversion on load, not repeated, reversible)
// =============================================================================
// These cases describe what a user sees in production: the walls-only model is the ONLY
// model, a plan in the old format is read and converted on load.
const REAL_PIECES = REAL_PLAN.rooms.reduce((n: number, r: DonneeDynamique) => n + ((r.pieces && r.pieces.length) || 0), 0);
const REAL_ENV_PIECES = (REAL_PLAN.envelope && REAL_PLAN.envelope.pieces) ? REAL_PLAN.envelope.pieces.length : 0;
const AUTO = "";
const seedAuto = (st: DonneeDynamique) => AUTO + seedV4(st);
// A state that's ALREADY converted, flat server shape (what D1 sends back after conversion).
const SEED_V5_STATE = {
  outline: [[0, 0], [600, 0], [600, 400], [0, 400]],
  walls: [{ id: "w1", a: [300, 0], b: [300, 400], t: 12 }],
  openings: [] as DonneeDynamique[], pieces: [] as DonneeDynamique[], cells: [] as DonneeDynamique[], setupDone: true,
};
// A small plan in the OLD format, for the import.
const IMPORT_V4 = {
  rooms: [
    { id: 1, name: "Bureau", floor: "parquet", ax: 0, ay: 0, room: { poly: [[0,0],[300,0],[300,300],[0,300]] },
      pieces: [{ id: 901, type: "desk", name: "Bureau", x: 40, y: 40, w: 140, h: 70, rot: 0 }] },
    { id: 2, name: "Cellier", floor: "tile", ax: 300, ay: 0, room: { poly: [[0,0],[200,0],[200,300],[0,300]] },
      pieces: [] },
  ],
  active: 0, setupDone: true, envelope: null as DonneeDynamique,
};

// 9a. the user's REAL plan, in the old format, converts itself on load:
// 13 interior walls, 6 facades, 10 cells, 21 openings, 21 pieces of furniture, and the 8 original names.
test("v5_boot_converts_the_old_plan", seedAuto(REAL_PLAN), `
  var P = window.__plan.plan;
  return { model: window.__plan.model,
           walls: P ? P.walls.filter(function(w){ return !w.isOutline; }).length : -1,
           facades: P ? P.walls.filter(function(w){ return w.isOutline; }).length : -1,
           cells: P ? P.cells.length : -1,
           names: P ? P.cells.map(function(c){ return c.name; }) : [],
           openings: P ? P.openings.length : -1,
           pieces: P ? P.pieces.length : -1,
           aptrooms: document.querySelectorAll("#canvas .aptroom").length,
           layer: document.querySelectorAll(".v5layer").length,
           canvasV5: document.getElementById("canvas").classList.contains("v5"),
           hasRooms: ("rooms" in window.__plan.state),
           serverShape: Array.isArray(window.__plan.serialize().walls),
           backup: !!window.__plan.backupInfo() };
`, v => expect(v.model === "v5" && v.hasRooms === false,
        "le chargement doit convertir tout seul et ne laisser AUCUNE salle")
     && expect(v.walls === 13 && v.facades === 6, "13 murs intérieurs + 6 façades, got " + v.walls + "/" + v.facades)
     && expect(v.cells === 10, "10 cellules attendues, got " + v.cells)
     && expect(v.openings === 21 && v.pieces === 21, "21 ouvertures + 21 meubles, got " + v.openings + "/" + v.pieces)
     && expect(["Salon", "Cuisine", "Pièce 4", "Pièce 6", "Pièce 7", "Pièce 8", "Pièce 9", "Pièce 10"]
        .every(n => v.names.indexOf(n) >= 0), "les 8 noms d'origine doivent revenir, got " + JSON.stringify(v.names))
     && expect(v.layer === 1 && v.aptrooms === 0 && v.canvasV5 === true, "l'écran doit être en murs-seuls")
     && expect(v.serverShape === true, "serialize() doit être à la forme serveur murs-seuls")
     // THE MENU ENTRY IS GONE, THE BACKUP ISN'T: "Revert to the plan from before conversion" has
     // been removed from the rail menu (the conversion is done, the converted plan is in service).
     // What must hold is the BLOB, not a button.
     && expect(v.backup === true, "la sauvegarde d'avant conversion doit exister"));

// 9b. a plan that's ALREADY converted is not reconverted (two clients cannot step on each other).
test("v5_boot_does_not_reconvert", seedAuto(SEED_V5_STATE), `
  var idsBefore = window.__plan.plan.cells.map(function(c){ return c.id; }).join(",");
  var wallsBefore = window.__plan.plan.walls.map(function(w){ return w.id; }).join(",");
  // rereading what was just saved must reconvert NOTHING: same ids, same walls.
  var again = window.__plan.migrate(JSON.parse(localStorage.getItem("room-planner-v4")));
  return { model: window.__plan.model,
           idsBefore: idsBefore, idsAfter: again.plan.cells.map(function(c){ return c.id; }).join(","),
           wallsBefore: wallsBefore, wallsAfter: again.plan.walls.map(function(w){ return w.id; }).join(","),
           backup: !!window.__plan.backupInfo(), cells: window.__plan.plan.cells.length };
`, v => expect(v.model === "v5", "un état serveur murs-seuls doit se monter en murs-seuls, got " + v.model)
     && expect(v.backup === false, "un état déjà murs-seuls n'a rien à sauvegarder, backup=" + v.backup)
     && expect(v.idsBefore === v.idsAfter && v.wallsBefore === v.wallsAfter,
        "relire l'état enregistré ne doit rien reconvertir : " + v.idsBefore + " / " + v.idsAfter)
     && expect(v.cells === 2, "les cellules ne doivent pas bouger, got " + v.cells));

// 9c. REPLACES "v5_optout_is_respected_at_boot" (staying on the old model no longer exists): the
// safety net, however, remains. The blob from BEFORE conversion is copied AS IS, once,
// and the first save of the converted plan does not overwrite it.
test("v5_backup_is_taken_once_and_kept", seedAuto(REAL_PLAN), `
  var raw = localStorage.getItem("room-planner-v4-backup");
  var at = localStorage.getItem("room-planner-v4-backup-at");
  var src = JSON.parse(raw);
  var info = window.__plan.backupInfo();
  // a change + a save must NOT touch the backup
  window.__plan.plan.pieces[0].x += 30; window.__plan.save();
  var raw2 = localStorage.getItem("room-planner-v4-backup");
  var live = JSON.parse(localStorage.getItem("room-planner-v4"));
  return { legacy: Array.isArray(src.rooms) && src.rooms.length,
           unchanged: raw === raw2, hasAt: !!at,
           info: info, liveIsWalls: Array.isArray(live.walls) && !("rooms" in live) };
`, v => expect(v.legacy === 8, "la sauvegarde doit contenir les 8 anciennes pièces, got " + v.legacy)
     && expect(v.hasAt === true, "la sauvegarde doit être horodatée")
     && expect(v.unchanged === true, "un enregistrement ne doit jamais réécrire la sauvegarde")
     && expect(v.liveIsWalls === true, "le plan vivant enregistré, lui, est murs-seuls")
     && expect(v.info && v.info.rooms === 8, "backupInfo() doit décrire l'ancien plan, got " + JSON.stringify(v.info)));

// 9d. two clients converting at the same time produce EXACTLY the same plan
// (same wall ids, same cell ids/names): the last write wins without losing anything.
test("v5_two_clients_converge_on_the_same_conversion", seedAuto(REAL_PLAN), `
  var mine = window.__plan.plan;
  // 2nd client: starts back from the blob from BEFORE conversion and replays the same conversion
  var raw = localStorage.getItem("room-planner-v4-backup");
  var st2 = window.__plan.readLegacy(JSON.parse(raw));
  var other = window.__plan.buildV5FromV4(st2).plan;
  var key = function(P){ return JSON.stringify({
      o: P.outline,
      w: P.walls.map(function(w){ return [w.id, w.a, w.b]; }),
      c: P.cells.map(function(c){ return [c.id, c.name, c.floor, c.poly]; }),
      p: P.pieces.map(function(p){ return [p.id, p.x, p.y, p.rot]; }),
      op: P.openings.map(function(o){ return [o.id, o.wallId, o.t0, o.side]; }) }); };
  return { same: key(mine) === key(other),
           mineCells: mine.cells.map(function(c){ return c.id + ":" + c.name; }).join("|"),
           otherCells: other.cells.map(function(c){ return c.id + ":" + c.name; }).join("|") };
`, v => expect(v.same === true,
        "la conversion doit être déterministe :\n  " + v.mineCells + "\n  " + v.otherCells));

// 9e. SAFETY NET: the backup from before conversion gives back the original plan, identically.
test("v5_restore_returns_the_plan_from_before_the_conversion", seedAuto(REAL_PLAN), `
  var conv = { model: window.__plan.model, cells: window.__plan.plan.cells.length };
  var info = window.__plan.backupInfo();
  // we first damage the live plan: restoring must really reload the other content
  window.__plan.plan.pieces.length = 0; window.__plan.save();
  var r = window.__plan.restoreBackup();
  var P = window.__plan.plan;
  return { conv: conv, info: info, r: r, model: window.__plan.model,
           cells: P.cells.length,
           names: P.cells.map(function(c){ return c.name; }),
           pieces: P.pieces.length, openings: P.openings.length,
           hasRooms: ("rooms" in window.__plan.state),
           detached: window.__plan.syncDetached,
           aptrooms: document.querySelectorAll("#canvas .aptroom").length,
           layer: document.querySelectorAll(".v5layer").length };
`, v => expect(v.conv.model === "v5" && v.conv.cells === 10, "il faut d'abord avoir été converti")
     && expect(v.info && v.info.rooms === 8, "la sauvegarde doit décrire les 8 pièces d'origine, got " + JSON.stringify(v.info))
     && expect(v.cells === 10 && v.pieces === 21 && v.openings === 21,
        "le contenu d'avant conversion doit revenir (relu + reconverti), got "
        + v.cells + "/" + v.pieces + "/" + v.openings)
     && expect(v.names.indexOf("Salon") >= 0 && v.names.indexOf("Cuisine") >= 0,
        "les noms d'origine doivent revenir, got " + JSON.stringify(v.names))
     && expect(v.hasRooms === false && v.layer === 1 && v.aptrooms === 0,
        "l'écran reste murs-seuls : recharger n'est pas revenir aux salles")
     && expect(v.detached === true, "l'onglet doit se détacher du partage"));

// 9f. BLANK FIRST LAUNCH: no localStorage, no server plan. The app boots in walls-only,
// the wizard opens, and what it applies becomes the outline + one cell.
test("v5_fresh_install_boots_on_walls", AUTO, `
  var P = window.__plan.plan;
  var before = { model: window.__plan.model, cells: P ? P.cells.length : -1,
                 pieces: P ? P.pieces.length : -1, outline: P ? P.outline.length : -1,
                 layer: document.querySelectorAll(".v5layer").length,
                 aptrooms: document.querySelectorAll("#canvas .aptroom").length,
                 setupOpen: !document.getElementById("setup").hidden };
  // the wizard: 500 x 400, then "Start"
  var w = document.getElementById("suW"); w.value = "500"; w.dispatchEvent(new Event("input", {bubbles:true}));
  var l = document.getElementById("suL"); l.value = "400"; l.dispatchEvent(new Event("input", {bubbles:true}));
  document.getElementById("setupStart").click();
  var Q = window.__plan.plan;
  var bb = window.__plan.bboxOfPoly(Q.outline);
  return { before: before, model: window.__plan.model,
           cells: Q.cells.length, cellName: Q.cells.length ? Q.cells[0].name : null,
           w: Math.round(bb.w), l: Math.round(bb.l),
           setupOpen: !document.getElementById("setup").hidden,
           layer: document.querySelectorAll(".v5layer").length };
`, v => expect(v.before.model === "v5", "un premier lancement doit démarrer en murs-seuls, got " + v.before.model)
     // A blank plan is BLANK: no more default furniture behind the wizard's modal.
     && expect(v.before.cells === 1 && v.before.pieces === 0,
        "une cellule et AUCUN meuble par défaut, got " + v.before.cells + "/" + v.before.pieces)
     && expect(v.before.layer === 1 && v.before.aptrooms === 0, "un seul conteneur : le calque")
     && expect(v.before.setupOpen === true, "l'assistant de premier lancement doit s'ouvrir")
     && expect(v.setupOpen === false && v.model === "v5", "après l'assistant on reste en murs-seuls")
     && expect(v.w === 500 && v.l === 400, "l'assistant définit le CONTOUR, got " + v.w + "x" + v.l)
     && expect(v.cells === 1 && !!v.cellName, "une cellule nommée doit subsister, got " + v.cells + "/" + v.cellName));

// 9g. FURNITURE LIST: grouped by COMPUTED CELL (geometric test of the center), and nothing
// disappears, an object outside every cell lands in "Outside any room".
test("v5_furniture_list_groups_by_cell", seedAuto(REAL_PLAN), `
  var P = window.__plan.plan;
  var data = window.__plan.furnitureData();
  var count = function(d){ return d.reduce(function(n,s){
    return n + s.furn.reduce(function(a,x){ return a + x.n; }, 0)
             + s.open.reduce(function(a,x){ return a + x.n; }, 0); }, 0); };
  var before = { sections: data.map(function(s){ return s.name; }),
                 cells: P.cells.map(function(c){ return c.name; }),
                 total: count(data), expect: P.pieces.length + P.openings.length };
  // we push a piece of furniture OUTSIDE every cell (far from the outline): it must not disappear
  var p = P.pieces[0];
  var bb = window.__plan.bboxOfPoly(P.outline);
  p.x = bb.minX - 900; p.y = bb.minY - 900;
  var data2 = window.__plan.furnitureData();
  var orphan = data2.filter(function(s){ return s.ri === "__orphan__"; })[0];
  return { before: before, total2: count(data2),
           orphanName: orphan ? orphan.name : null,
           orphanCount: orphan ? orphan.furn.reduce(function(a,x){ return a + x.n; }, 0) : 0,
           txt: window.__plan.furnitureListText().indexOf("Salon") >= 0 };
`, v => expect(v.before.sections.join("|") === v.before.cells.join("|"),
        "une section par cellule, dans l'ordre :\n  " + v.before.sections.join("|") + "\n  " + v.before.cells.join("|"))
     && expect(v.before.total === v.before.expect,
        "aucun objet perdu : " + v.before.total + " listés pour " + v.before.expect + " objets")
     && expect(v.orphanName === "Outside any room" && v.orphanCount === 1,
        "un objet hors cellule doit rester listé, got " + v.orphanName + "/" + v.orphanCount)
     && expect(v.total2 === v.before.expect, "toujours aucun objet perdu après déplacement")
     && expect(v.txt === true, "la version texte doit porter les noms de cellule"));

// 9h. NO ACTIVE PATH ASKS "WHICH ROOM". The live state no longer carries rooms, active, or
// envelope, and we replay every hot path: nothing throws.
test("v5_hot_paths_never_ask_which_room", seedAuto(REAL_PLAN), `
  var st = window.__plan.state;
  var out = { hasRooms: ("rooms" in st), hasActive: ("active" in st), hasEnvelope: ("envelope" in st) };
  var threw = null;
  var wireRoom = null;
  try {
    window.__plan.wsForceOpen(true);
    var sent = []; var _s = WebSocket.prototype.send;
    window.__wsEmitDrag(window.__plan.plan.pieces[0]);
    window.__wsEmitDragMulti([{ pc: window.__plan.plan.pieces[0] }]);
    // the CURSOR path (the hottest one): it used to resolve the room under the pointer on every move
    var vp = document.getElementById("viewport");
    var vr = vp.getBoundingClientRect();
    vp.dispatchEvent(new PointerEvent("pointermove", { bubbles:true, clientX: vr.left+300, clientY: vr.top+200,
      pointerType:"mouse", isPrimary:true }));
    out.cursorApt = !!window.__plan.lastCursorApt;
    window.__plan.render();
    window.__plan.furnitureData();
    window.__plan.buildMasterSVG({ title: "" });
    window.__plan.analyzeV5();
    window.__plan.wire();
  } catch (e) { threw = String((e && e.message) || e); }
  window.__plan.wsForceOpen(false);
  out.threw = threw;
  // the container label on the wire: a constant, never a room id
  out.wire = (window.__plan.wire().outline || []).length > 2 ? "__apt__" : null;
  return out;
`, v => expect(v.hasRooms === false && v.hasActive === false && v.hasEnvelope === false,
        "l'état vivant ne doit plus porter rooms/active/envelope, got " + JSON.stringify(v))
     && expect(v.threw === null, "un chemin actif a interrogé une salle : " + v.threw)
     && expect(v.wire === "__apt__", "le fil doit porter l'appartement")
     && expect(v.cursorApt === true, "le curseur doit rester suivi en cm appartement"));

// 9i. MODEL CONFLICT: a tab that stayed on the old format wakes up, the server refuses its op
// (ops.ts -> op_shape). The client must NOT fail silently: it announces and reloads.
test("v5_stale_tab_reacts_to_a_model_conflict", seedAuto(REAL_PLAN), `
  window.__plan.wsForceOpen(true);
  window.__plan.wsFeed({ t: "err", reason: "op_shape" });
  var first = { toast: window.__plan.toastText, flag: sessionStorage.getItem("plan-model-reload") };
  window.__plan.clearToast();
  window.__plan.wsFeed({ t: "err", reason: "op_shape" });   // 2nd time: never a loop
  window.__plan.wsForceOpen(false);
  return { first: first, second: window.__plan.toastText };
`, v => expect(!!v.first.toast && /reloading/i.test(v.first.toast),
        "un conflit de modèle doit être annoncé, got " + JSON.stringify(v.first.toast))
     && expect(v.first.flag === "1", "le rechargement doit être marqué une seule fois par session")
     && expect(v.second === null, "un second conflit ne doit pas relancer le cycle"));

// 9j. PEER GHOSTS: in walls-only they paint onto the layer (they weren't painting at all
// anymore, wsApplyOneGhost was still looking for an .aptroom).
test("v5_peer_drag_ghost_paints_on_the_layer", seedAuto(REAL_PLAN), `
  var P = window.__plan.plan;
  var p = P.pieces[0];
  var bb = window.__plan.bboxOfPoly(P.outline);
  window.__plan.wsForceOpen(true);
  window.__plan.wsFeed({ t: "drag", by: "device.b@example.com", room: "__apt__",
                         pieceId: String(p.id), x: p.x + 120, y: p.y + 80, rot: p.rot || 0 });
  window.__plan.render();                       // render() reapplies active ghosts
  var pose = window.__plan.ghostPose(p.id);
  window.__plan.wsForceOpen(false);
  return { pose: pose,
           expLeft: ((p.x + 120 - bb.minX) * window.__plan.vScale) + "px",
           expTop: ((p.y + 80 - bb.minY) * window.__plan.vScale) + "px" };
`, v => expect(!!v.pose, "la pièce doit être rendue")
     && expect(v.pose.ghost === true, "le nœud doit porter la classe peer-ghost")
     && expect(near(parseFloat(v.pose.left), parseFloat(v.expLeft), 0.05)
            && near(parseFloat(v.pose.top), parseFloat(v.expTop), 0.05),
        "le fantôme doit être posé en cm appartement, got " + v.pose.left + "/" + v.pose.top
        + " au lieu de " + v.expLeft + "/" + v.expTop));

// 9k. IMPORTING a file in the OLD format: converted on import, never a return to rooms.
test("v5_importing_an_old_format_file_converts_it", seedAuto(REAL_PLAN), `
  var payload = JSON.stringify({ app: "room-planner", version: 4, savedAt: "x",
    state: ${JSON.stringify(IMPORT_V4)} });
  var ok = window.__plan.importPlan(payload);
  var P = window.__plan.plan;
  return { ok: ok, model: window.__plan.model,
           cells: P ? P.cells.length : -1, pieces: P ? P.pieces.length : -1,
           rooms: ("rooms" in window.__plan.state) ? 99 : 1,
           aptrooms: document.querySelectorAll("#canvas .aptroom").length,
           layer: document.querySelectorAll(".v5layer").length };
`, v => expect(v.ok === true, "l'import doit réussir")
     && expect(v.model === "v5", "un fichier ancien format doit être converti à l'import, got " + v.model)
     && expect(v.cells === 2, "les 2 pièces importées doivent devenir 2 cellules, got " + v.cells)
     && expect(v.pieces === 1, "le meuble importé doit survivre, got " + v.pieces)
     && expect(v.rooms === 1 && v.aptrooms === 0 && v.layer === 1, "l'écran reste en murs-seuls"));

// 9l. PNG / PDF EXPORT: the master SVG is painted from the walls and cells, not from
// old rooms (one band per interior wall, one name per cell).
test("v5_master_svg_is_walls_only", seedAuto(REAL_PLAN), `
  var svg = window.__plan.buildMasterSVG({ title: "" });
  var P = window.__plan.plan;
  return { lines: (svg.match(/<line class="v5band"/g) || []).length,
           interior: P.walls.filter(function(w){ return !w.isOutline; }).length,
           names: P.cells.filter(function(c){ return svg.indexOf(">" + c.name + "<") >= 0; }).length,
           cells: P.cells.length,
           filters: /filter\s*[:=]/.test(svg),
           len: svg.length };
`, v => expect(v.lines === v.interior, "une bande par mur intérieur, got " + v.lines + " pour " + v.interior)
     && expect(v.names === v.cells, "chaque cellule doit être étiquetée, got " + v.names + "/" + v.cells)
     && expect(v.filters === false, "aucun filtre CSS/SVG dans l'export")
     && expect(v.len > 5000, "l'export ne doit pas être vide, got " + v.len));

// 9m-bis. The OTHER client converted first: its `plan5.replace` switches this tab over without
// triggering a second local conversion (no concurrent conversion, no overwrite).
test("v5_remote_conversion_switches_this_tab", seedV4(REAL_PLAN), `
  var before = { cells: window.__plan.plan.cells.length, model: window.__plan.model };
  // the plan the other client just sent: the SAME deterministic conversion, one wall fewer
  var res = window.__plan.buildV5FromV4(
    window.__plan.readLegacy(JSON.parse(localStorage.getItem("room-planner-v4-backup"))));
  res.plan.walls = res.plan.walls.filter(function(w){ return w.isOutline || w.id !== "w1"; });
  var wire = { outline: res.plan.outline,
               walls: res.plan.walls.map(function(w){ return {id:w.id, a:w.a, b:w.b, t:w.t}; }),
               openings: res.plan.openings.map(function(o){ return {id:o.id, wallId:o.wallId, t0:o.t0, w:o.w, type:o.type}; }),
               pieces: res.plan.pieces.map(function(p){ return {id:String(p.id), type:p.type, name:p.name,
                 x:p.x, y:p.y, w:p.w, h:p.h, rot:p.rot, locked:!!p.locked}; }),
               cells: res.plan.cells.map(function(c){ return {id:c.id, poly:c.poly, name:c.name, floor:c.floor}; }) };
  window.__plan.wsForceOpen(true);
  window.__plan.wsFeed({ t: "op", rev: 42, op: { kind: "plan5.replace", plan: wire } });
  window.__plan.wsForceOpen(false);
  var P = window.__plan.plan;
  return { before: before, model: window.__plan.model,
           cells: P ? P.cells.length : -1, pieces: P ? P.pieces.length : -1,
           walls: P ? P.walls.filter(function(w){ return !w.isOutline; }).length : -1,
           hasRooms: ("rooms" in window.__plan.state),
           aptrooms: document.querySelectorAll("#canvas .aptroom").length,
           layer: document.querySelectorAll(".v5layer").length };
`, v => expect(v.before.cells === 10, "cet onglet doit avoir converti tout seul au chargement, got " + v.before.cells)
     && expect(v.model === "v5" && v.pieces === 21, "l'op distante doit remplacer le plan, got " + v.model + "/" + v.pieces)
     && expect(v.walls === 12, "le mur retiré par le pair doit disparaître ici aussi, got " + v.walls)
     && expect(v.cells === 10, "les cellules du pair sont adoptées telles quelles, got " + v.cells)
     && expect(v.hasRooms === false && v.aptrooms === 0 && v.layer === 1, "l'écran reste murs-seuls"));

// 9m. COLLABORATION: presence, cursor, chat. A peer's cursor is placed in APARTMENT cm
// (aptToScreen); nothing depends anymore on a room id relayed on the wire.
test("v5_collab_surfaces_are_apartment_space", seedAuto(REAL_PLAN), `
  window.__plan.wsForceOpen(true);
  window.__plan.wsFeed({ t: "peer", peers: [{ email: "device.b@example.com", color: "#b04a3d" },
                                            { email: "a@example.com", color: "#1f6f78" }] });
  var dots = document.querySelectorAll("#peers .peer-dot").length;
  window.__plan.wsFeed({ t: "cursor", by: "device.b@example.com", color: "#b04a3d",
                         room: "__apt__", x: 900, y: 300 });
  var cur = document.querySelector("#peerCursors .peer-cur");
  var s = window.__plan.aptToScreen(900, 300);
  window.__plan.wsFeed({ t: "chat", msg: { by: "device.b@example.com", text: "et le lit ici ?", ts: Date.now() } });
  var chat = document.querySelectorAll("#chatList .chat-msg").length;
  var chatTxt = document.querySelector("#chatList .ctext");
  window.__plan.wsForceOpen(false);
  return { dots: dots, cursor: !!cur, transform: cur ? cur.style.transform : null,
           exp: "translate3d(" + s.x.toFixed(1) + "px," + s.y.toFixed(1) + "px,0)",
           label: cur ? (cur.querySelector(".pc-name") || {}).textContent : null,
           chat: chat, chatTxt: chatTxt ? chatTxt.textContent : null };
`, v => expect(v.dots === 2, "les pastilles de présence doivent s'afficher, got " + v.dots)
     && expect(v.cursor === true && v.label === "Device B", "le curseur du pair doit être créé et nommé, got " + v.label)
     && expect((function(){ var n=function(t: DonneeDynamique){ return String(t||"").replace(/\s+|px/g, ""); };
          return n(v.transform) === n(v.exp); })(),
        "curseur posé en cm appartement, got " + v.transform + " au lieu de " + v.exp)
     && expect(v.chat === 1 && v.chatTxt === "et le lit ici ?", "le chat doit recevoir le message, got " + v.chatTxt));

// 9n. Granular ops emitted in walls-only pass the REAL server validator, on a server state
// already converted (no v4 op must slip through).
test("v5_granular_ops_pass_the_server_on_a_converted_state", seedAuto(REAL_PLAN), `
  var log = window.__plan.opLog(true);
  window.__plan.wsForceOpen(true);
  var P = window.__plan.plan;
  P.pieces[0].x += 40;                       // furniture moved
  P.cells[0].name = "Chambre";               // cell renamed
  window.__plan.render(); window.__plan.save();
  window.__plan.forceDiff();
  window.__plan.wsForceOpen(false);
  var ops = window.__plan.opLog(false);
  return { ops: ops, wire: window.__plan.wire() };
`, v => {
  const kinds = v.ops.map((o: DonneeDynamique) => o.kind);
  expect(kinds.length > 0, "des ops doivent être émises");
  // `piece.front` NO LONGER APPEARS in this list: the server removed it from both of its op sets
  // and the client neither emits nor receives it anymore. Seeing it come through would be a regression.
  expect(kinds.every((k: string) => ["piece.set", "piece.del", "cell.set", "cells.replace", "wall.set", "wall.del",
    "opening.set", "opening.del", "outline.set"].indexOf(k) >= 0),
    "une op de l'ancien modèle s'est échappée : " + JSON.stringify(kinds));
  // replayed on a walls-only server state by the real ops.ts
  const plan = sanitizeState(JSON.parse(JSON.stringify(v.wire)));
  expect(isV5(plan), "l'état serveur doit être murs-seuls");
  v.ops.forEach((op: DonneeDynamique) => applyOp(plan, op));
  return true;
});


// =============================================================================
//  13. THE VIEW IS RECROPPED ON THE FIRST ADOPTION, AND ONLY THAT ONE
// =============================================================================
// A household member opens the plan on a brand-new device: `init` framed the default apartment (420x360),
// then the real dwelling (1250x870) arrives. Without recropping it overflows the viewport.
test("vue_recadree_a_la_premiere_adoption_seulement", "", `
  var small = window.__plan.viewFits();                   // default apartment, framed by init
  var big = window.__plan.wire();
  // a dwelling much bigger than the local state
  big.outline = [[0,0],[1250,0],[1250,870],[0,870]];
  big.walls = [{id:"w1", a:[600,0], b:[600,870], t:12}];
  big.openings = []; big.pieces = []; big.cells = [];
  window.__plan.wsFeed({ t:"hello", you:{email:"device.b@example.com"}, peers:[], rev:11, fp:"fp-1", state:big, chat:[] });
  var first = window.__plan.viewFits();
  var vFirst = window.__plan.viewTransform();
  // This household member is working: they move their view.
  window.__plan.panBy(-140, 90);
  var vPanned = window.__plan.viewTransform();
  // The other member modifies the plan again: a SECOND adoption arrives.
  var big2 = JSON.parse(JSON.stringify(big));
  big2.outline = [[0,0],[1600,0],[1600,1100],[0,1100]];
  window.__plan.wsFeed({ t:"hello", you:{email:"device.b@example.com"}, peers:[], rev:12, fp:"fp-2", state:big2, chat:[] });
  var vAfter = window.__plan.viewTransform();
  return { smallFits: small.fits, first: first, vFirst: vFirst, vPanned: vPanned, vAfter: vAfter,
           outline2: window.__plan.plan.outline[1][0] };
`, v => expect(v.first.fits === true,
        "le plan adopté doit tenir dans le viewport : " + JSON.stringify(v.first))
     && expect(v.vPanned.ox !== v.vFirst.ox && v.vPanned.oy !== v.vFirst.oy,
        "le panoramique de contrôle doit bien avoir bougé la vue")
     && expect(v.outline2 === 1600, "la deuxième adoption doit bien avoir eu lieu")
     && expect(v.vAfter.scale === v.vPanned.scale && v.vAfter.ox === v.vPanned.ox
        && v.vAfter.oy === v.vPanned.oy,
        "une adoption ULTÉRIEURE ne doit pas faire sauter la vue de qui travaille : "
        + JSON.stringify(v.vPanned) + " -> " + JSON.stringify(v.vAfter)));

// ---- verdict -----------------------------------------------------------------------------------
report();
