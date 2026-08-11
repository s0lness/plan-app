#!/usr/bin/env node
// Zero-dependency regression suite for the single-file apartment planner.
//
// Pattern (kept identical to the ad-hoc probes used across this project):
//   temp.html  =  <seed script>  +  <app file contents>  +  <probe script>
//   - seed  : sets window.__PLAN_TEST__=1 and seeds localStorage 'room-planner-v4'
//             (or a legacy key) BEFORE the app IIFE runs.
//   - app   : the DEPLOYED source (index.html body) OR the dev working copy
//             room-planner.html. Both are the same code; the deploy just wraps it
//             in <!doctype><head>. We wrap it ourselves at runtime.
//   - probe : runs AFTER the app booted, drives the window.__plan test hook,
//             writes a JSON verdict onto <html data-plan-test="...">.
// Chrome is launched headless with --dump-dom --virtual-time-budget; we parse the
// <html ...> open tag out of stdout and compare its dataset to what we expect.
//
// Run:   node tests/run.ts [path-to-app-html]
// Exit:  0 if every test passes, 1 otherwise.

import type { DonneeDynamique } from "./_types.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ControleSonde, ResultatTest, VerdictSonde } from "./_types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- config -----------------------------------------------------------------
const NODE = process.execPath;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
// Default source: the repo's REBUILT deliverable (`node build.ts` from src/).
// The old monolithic working copy from the Claude job remains usable as an explicit argument.
const DEFAULT_APP = path.join(__dirname, "..", "index.html");
const APP_PATH = process.argv[2] || DEFAULT_APP;
const V4_KEY = "room-planner-v4";
const V3_KEY = "room-planner-v3";

if (!fs.existsSync(APP_PATH)) { console.error("App file not found:", APP_PATH); process.exit(1); }
if (!fs.existsSync(CHROME)) { console.error("Chrome not found:", CHROME); process.exit(1); }

const APP_SRC = fs.readFileSync(APP_PATH, "utf8");

// ---- harness ----------------------------------------------------------------
// Build a temp html and run it in headless chrome, returning the parsed
// data-* attributes of the <html> element (our verdict channel).
let RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "plan-tests-"));

function runProbe(name: string, seedJs: string, probeBody: string): VerdictSonde {
  const caseDir = fs.mkdtempSync(path.join(RUN_DIR, "c-"));
  const htmlPath = path.join(caseDir, "case.html");
  const profileDir = path.join(caseDir, "profile");

  // seed runs first; sets the test flag + localStorage before the app IIFE.
  const seed = `<!doctype html><html><head><meta charset="utf-8"><script>
    window.__PLAN_TEST__ = 1;
    // The WALLS-ONLY model is the ONLY model: a plan seeded here in the old format is read and
    // converted on load, exactly as for the user.
    try { localStorage.clear(); } catch(e){}
    ${seedJs || ""}
  </script></head><body>`;

  // probe runs last; wrapped so any throw is captured as a verdict rather than
  // a silent white page. It writes JSON onto <html data-plan-test="...">.
  const probe = `<script>(function(){
    function emit(o){ try{ document.documentElement.dataset.planTest = JSON.stringify(o); }catch(e){} }
    function run(){
      try {
        var errs = [];
        try { errs = JSON.parse(localStorage.getItem("plan-errors")||"[]")||[]; } catch(e){}
        var __out = (function(){ ${probeBody} })();
        __out = __out || {};
        __out.jsErrors = errs.map(function(e){ return e && e.msg; });
        emit(__out);
      } catch(e) {
        emit({ __probeError: String(e && e.stack || e) });
      }
    }
    // Give the app's synchronous boot + any microtasks a beat; virtual-time
    // makes this effectively instant but deterministic.
    setTimeout(run, 0);
  })();</script></body></html>`;

  fs.writeFileSync(htmlPath, seed + APP_SRC + probe, "utf8");

  const args = [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--no-first-run", "--no-default-browser-check",
    "--user-data-dir=" + profileDir,
    "--virtual-time-budget=8000",
    "--run-all-compositor-stages-before-draw",
    "--dump-dom",
    "file:///" + htmlPath.replace(/\\/g, "/"),
  ];
  const res = spawnSync(CHROME, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
  const stdout = res.stdout || "";

  // parse data-plan-test off the <html ...> tag
  const m = stdout.match(/<html[^>]*\bdata-plan-test="([^"]*)"/i);
  if (!m) {
    return { __noVerdict: true, __stdoutHead: stdout.slice(0, 600), __stderr: (res.stderr||"").slice(0,600) };
  }
  const raw = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");
  try { return JSON.parse(raw); }
  catch (e) { return { __parseError: String(e), __raw: raw.slice(0, 400) }; }
}

// ---- assertion plumbing -----------------------------------------------------
const results: ResultatTest[] = [];
function test(name: string, seedJs: string, probeBody: string, check: ControleSonde): void {
  let pass = false, detail = "";
  const v = runProbe(name, seedJs, probeBody);
  if (v.__noVerdict) { detail = "no verdict emitted (app failed to boot?)\n  stdout: " + (v.__stdoutHead||"") + "\n  stderr: " + (v.__stderr||""); }
  else if (v.__probeError) { detail = "probe threw: " + v.__probeError; }
  else if (v.__parseError) { detail = "verdict parse error: " + v.__parseError + " raw=" + v.__raw; }
  else if (v.jsErrors && v.jsErrors.length) { detail = "app logged JS error(s): " + JSON.stringify(v.jsErrors); }
  else {
    try { const r = check(v); if (r === true) pass = true; else detail = r || "assertion returned falsy"; }
    catch (e) { detail = "check threw: " + String(e && e.stack || e); }
  }
  results.push({ name, pass, detail, verdict: v });
  process.stdout.write((pass ? "  ok   " : "  FAIL ") + name + "\n");
  if (!pass) process.stdout.write("       " + detail.replace(/\n/g, "\n       ") + "\n");
}

// tiny helpers for checks
const near = (a: DonneeDynamique, b: DonneeDynamique, tol?: number): boolean => Math.abs(a - b) <= (tol == null ? 1 : tol);
function expect(cond: unknown, msg: string): true { if (!cond) throw new Error(msg); return true; }

// ---- seed builders ----------------------------------------------------------
// A v4 plan with two rooms sharing a vertical party wall at apt x=300, plus one
// piece in room 0. Room A: 0..300 wide, Room B: 300..600. setupDone true so no
// wizard. flow off by default (tests turn it on via opts when needed).
function seedV4(state: unknown): string {
  return `try{ localStorage.setItem(${JSON.stringify(V4_KEY)}, ${JSON.stringify(JSON.stringify(state))}); }catch(e){}`;
}
const rect = (w: DonneeDynamique, l: DonneeDynamique): [number, number][] => [[0,0],[w,0],[w,l],[0,l]];

// two adjacent rooms, party wall at x=300
const TWO_ROOMS = {
  rooms: [
    { id: 1, name: "Salon", floor: "parquet", ax: 0,   ay: 0, room: { poly: rect(300, 300) },
      pieces: [ { id: 101, type: "sofa3", name: "Canapé 3 places", x: 20, y: 20, w: 220, h: 95, rot: 0 } ] },
    { id: 2, name: "Chambre", floor: "parquet", ax: 300, ay: 0, room: { poly: rect(300, 300) }, pieces: [] },
  ],
  active: 0,
  opts: { snap: true, labels: true, flow: false, overlay: false, tvIn: null as DonneeDynamique, collapsedCats: [] as DonneeDynamique[], layFurn: true, layLight: true, layPlug: true },
  setupDone: true,
  envelope: null as DonneeDynamique,
};

// single room, no envelope, flow ON, one door on the wall -> room reachable
const ONE_ROOM_FLOW = (withDoor: boolean) => ({
  rooms: [
    { id: 1, name: "Salon", floor: "parquet", ax: 0, ay: 0, room: { poly: rect(400, 360) },
      pieces: withDoor ? [ { id: 201, type: "door", name: "Porte", x: 160, y: -6, w: 80, h: 12, rot: 0, hinge: 0, swing: 1 } ] : [] },
  ],
  active: 0,
  opts: { snap: true, labels: true, flow: true, overlay: false, tvIn: null as DonneeDynamique, collapsedCats: [] as DonneeDynamique[], layFurn: true, layLight: true, layPlug: true },
  setupDone: true,
  envelope: null as DonneeDynamique,
});

// staircase (non-axis-aligned) polygon for the ortho-snap test: a rectangle with
// one vertex nudged diagonally so an edge is slanted; dragging it back onto grid
// with ortho snap must re-align all edges.
// The apartment's OUTLINE, with an edge deliberately off-kilter: the orthogonal snap must
// bring it back onto the axes. Seeded in the walls-only format, because an old plan is read through a
// rectilinear hull (computeEnvelopeHull) that comes out already axis-aligned: there would be nothing to straighten.
const STAIR = {
  outline: [[0,0],[300,0],[300,200],[160,200],[150,340],[0,340]],
  walls: [] as DonneeDynamique[], openings: [] as DonneeDynamique[], pieces: [] as DonneeDynamique[], cells: [] as DonneeDynamique[],
  opts: { snap: true, labels: true, flow: false, overlay: false, tvIn: null as DonneeDynamique, collapsedCats: [] as DonneeDynamique[], layFurn: true, layLight: true, layPlug: true },
  setupDone: true,
};

// legacy v3 single-room plan (pre-multi-room shape): {room:{poly},pieces,opts}
const V3_PLAN = {
  room: { poly: rect(420, 360) },
  pieces: [
    { id: 11, type: "sofa3", x: 30, y: 30, w: 220, h: 95, rot: 0 },
    { id: 12, type: "coffee", x: 100, y: 150, w: 110, h: 60, rot: 0 },
  ],
  opts: { snap: true, labels: true, floor: "herringbone" },
};

// =============================================================================
//  TESTS
// =============================================================================
// The WALLS-ONLY model is the ONLY model. Plans in the old format (v1/v2/v3/v4) remain
// READABLE: they are converted on load. The cases below are therefore written against the
// live model (outline + walls + computed cells + furniture in apartment cm); those that
// SEED a plan in the old format additionally verify that this read loses nothing.

// 1. Boot: fresh install (no localStorage) -> no error, one cell, setup overlay opens.
test("boot_fresh_install", "", `
  var P = window.__plan.plan;
  var setup = document.getElementById("setup");
  return {
    cells: P ? P.cells.length : -1,
    pieces: P ? P.pieces.length : -1,
    setupDone: window.__plan.state.setupDone,
    setupHidden: setup ? !!setup.hidden : null,
    layers: document.querySelectorAll("#canvas .v5layer").length,
    aptrooms: document.querySelectorAll("#canvas .aptroom").length,
  };
`, v => expect(v.cells === 1, "expected 1 default cell, got " + v.cells)
     // A blank plan is BLANK: the default used to embed a furnished living room (sofa, coffee table,
     // shelf, armchair) and the setup assistant opened on top of it, asking to define an outline
     // while showing another one, already furnished, behind the modal.
     && expect(v.pieces === 0, "un premier lancement ne doit meubler AUCUN objet, got " + v.pieces)
     && expect(v.setupDone === false, "fresh install setupDone should be false, got " + v.setupDone)
     && expect(v.setupHidden === false, "setup overlay should be OPEN on fresh install, hidden=" + v.setupHidden)
     && expect(v.layers === 1, "the plan must render in exactly one layer, got " + v.layers)
     && expect(v.aptrooms === 0, "no room container may exist, got " + v.aptrooms));

// 2. REPLACES `boot_seeded_v4`: a plan in the old format is READ and CONVERTED on load.
//    The two rooms become two computed cells, the furniture survives, the assistant stays closed.
test("boot_reads_and_converts_v4", seedV4(TWO_ROOMS), `
  var P = window.__plan.plan;
  var setup = document.getElementById("setup");
  return {
    cells: P.cells.length, names: P.cells.map(function(c){ return c.name; }),
    pieces: P.pieces.length,
    walls: P.walls.filter(function(w){ return !w.isOutline; }).length,
    layers: document.querySelectorAll("#canvas .v5layer").length,
    aptrooms: document.querySelectorAll("#canvas .aptroom").length,
    setupHidden: setup ? !!setup.hidden : null,
    hasRooms: ("rooms" in window.__plan.state),
    backup: !!window.__plan.backupInfo(),
  };
`, v => expect(v.cells === 2, "expected 2 cells, got " + v.cells + " " + JSON.stringify(v.names))
     && expect(v.names.indexOf("Salon") >= 0 && v.names.indexOf("Chambre") >= 0,
        "the old room names must land on the cells, got " + JSON.stringify(v.names))
     && expect(v.walls === 1, "the shared wall must become ONE interior wall, got " + v.walls)
     && expect(v.pieces === 1, "expected 1 piece, got " + v.pieces)
     && expect(v.layers === 1 && v.aptrooms === 0, "one layer, no room container")
     && expect(v.hasRooms === false, "the live state must carry no rooms[]")
     && expect(v.backup === true, "the pre-conversion blob must be backed up")
     && expect(v.setupHidden === true || v.setupHidden === null, "setup should stay closed with a seeded plan, hidden=" + v.setupHidden));

// 3. Add piece at a cursor point inside the right-hand cell -> it lands in that cell.
test("add_at_cursor_lands_in_the_cell", seedV4(TWO_ROOMS), `
  // point (450,150) is inside the right cell (apt x 300..600)
  var p = window.__plan.addAtCursor("arm", 450, 150);
  var at = window.__plan.pieceAt(p.id);
  return { cell: at && at.cell, type: at && at.type, cx: at && at.cx };
`, v => expect(v.cell === "Chambre", "the arm should land in Chambre, got " + v.cell)
     && expect(v.type === "arm", "wrong type: " + v.type));

// 3b. placeAt into the left cell explicitly.
test("placeAt_lands_in_the_cell", seedV4(TWO_ROOMS), `
  var p = window.__plan.placeAt("chair", { x: 100, y: 100 });
  var at = window.__plan.pieceAt(p.id);
  return { cell: at && at.cell, type: at && at.type };
`, v => expect(v.cell === "Salon", "the chair should land in Salon, got " + v.cell));

// 4. REPLACES `containerAtApt_resolution`: there is no longer a container to resolve, only
//    computed CELLS. Same geometric test, on cellAt().
test("cell_at_point_resolution", seedV4(TWO_ROOMS), `
  var a = window.__plan.cellAt(100, 100);   // left cell
  var b = window.__plan.cellAt(450, 150);   // right cell
  var c = window.__plan.cellAt(5000, 5000); // nowhere
  return { a: a && a.name, b: b && b.name, c: c ? c.name : "null",
           different: !!(a && b) && a.id !== b.id };
`, v => expect(v.a === "Salon", "point in the left cell, got " + v.a)
     && expect(v.b === "Chambre", "point in the right cell, got " + v.b)
     && expect(v.different === true, "the two points must be in different cells")
     && expect(v.c === "null", "point outside should be null, got " + v.c));

// 5. Resize handle: east edge +40 -> w+40, opposite (west) edge x fixed.
test("resize_east_edge_plus40", seedV4(TWO_ROOMS), `
  var p = window.__plan.plan.pieces[0];       // sofa3, west edge fixed
  var before = { x: p.x, w: p.w };
  var after = window.__plan.resizeHandle(p.id, "e", 40, 0);
  return { beforeX: before.x, beforeW: before.w, afterX: after.x, afterW: after.w };
`, v => expect(v.afterW === v.beforeW + 40, "width should be +40: " + v.beforeW + " -> " + v.afterW)
     && expect(v.afterX === v.beforeX, "west (opposite) edge x must stay fixed: " + v.beforeX + " -> " + v.afterX));

// 5b. Resize handle: south edge +40 -> h+40, top (y) fixed.
test("resize_south_edge_plus40", seedV4(TWO_ROOMS), `
  var p = window.__plan.plan.pieces[0];
  var before = { y: p.y, h: p.h };
  var after = window.__plan.resizeHandle(p.id, "s", 0, 40);
  return { beforeY: before.y, beforeH: before.h, afterY: after.y, afterH: after.h };
`, v => expect(v.afterH === v.beforeH + 40, "height should be +40: " + v.beforeH + " -> " + v.afterH)
     && expect(v.afterY === v.beforeY, "top (opposite) edge y must stay fixed: " + v.beforeY + " -> " + v.afterY));

// 6. REPLACES `wall_top_drag_bottom_fixed`: the apartment outline replaces the room polygon.
//    Pulling the TOP edge inward leaves the BOTTOM edge where it is.
test("outline_top_edge_drag_bottom_fixed", seedV4(TWO_ROOMS), `
  window.__plan.setWallsMode(true);
  var b0 = window.__plan.bboxOfPoly(window.__plan.plan.outline);
  // find the top edge (minimal y, horizontal) and pull it 30 cm inward
  var poly = window.__plan.plan.outline, ei = -1;
  for (var i = 0; i < poly.length; i++) {
    var a = poly[i], b = poly[(i + 1) % poly.length];
    if (Math.abs(a[1] - b[1]) < 0.5 && Math.abs(a[1] - b0.minY) < 0.5) { ei = i; break; }
  }
  // the sign of the normal depends on the outline's winding direction: we pick the one that SHRINKS
  window.__plan.moveOutlineEdge(ei, 30);
  var mid = window.__plan.bboxOfPoly(window.__plan.plan.outline);
  if (mid.l > b0.l) { window.__plan.moveOutlineEdge(ei, -60); }
  var b1 = window.__plan.bboxOfPoly(window.__plan.plan.outline);
  return { ei: ei, y0Before: b0.minY, y0After: b1.minY, y1Before: b0.maxY, y1After: b1.maxY,
           lBefore: b0.l, lAfter: b1.l };
`, v => expect(v.ei >= 0, "the top edge of the outline should have been found")
     && expect(near(v.y1After, v.y1Before, 1), "the bottom edge must stay fixed: " + v.y1Before + " -> " + v.y1After)
     && expect(near(v.lAfter, v.lBefore - 30, 1), "the apartment should shrink by 30: " + v.lBefore + " -> " + v.lAfter));

// 7. REPLACES `wall_ortho_snap_axis_aligned`: the same orthogonal snap, on the OUTLINE.
test("outline_ortho_snap_axis_aligned", seedV4(STAIR), `
  window.__plan.setWallsMode(true);
  var before = window.__plan.allEdgesAxisAligned(0.5);
  // the offset vertex of the converted outline: we bring it back onto its neighbor's column
  var poly = window.__plan.plan.outline, vi = -1, best = 1e9;
  for (var i = 0; i < poly.length; i++) {
    var a = poly[(i - 1 + poly.length) % poly.length], b = poly[i], c = poly[(i + 1) % poly.length];
    var slanted = (Math.abs(a[0]-b[0]) > 0.5 && Math.abs(a[1]-b[1]) > 0.5)
               || (Math.abs(c[0]-b[0]) > 0.5 && Math.abs(c[1]-b[1]) > 0.5);
    if (slanted && best === 1e9) { vi = i; best = 0; }
  }
  var target = vi >= 0 ? [poly[(vi + 1) % poly.length][0], poly[vi][1]] : null;
  var r = vi >= 0 ? window.__plan.moveOutlineVertex(vi, target[0], target[1], false) : null;
  var after = window.__plan.allEdgesAxisAligned(0.5);
  return { before: before, after: after, vi: vi, poly: r ? r.poly : null };
`, v => expect(v.before === false, "the staircase outline should START non-axis-aligned")
     && expect(v.vi >= 0, "a slanted vertex should have been found")
     && expect(v.after === true, "after the ortho drag every outline edge must be axis-aligned; poly=" + JSON.stringify(v.poly)));

// 8. REPLACES `wall_party_coupling_moves_both`: a party wall is a SINGLE shared object, so
//    moving it adjusts BOTH cells by construction (no more coupling to maintain).
test("wall_move_resizes_both_cells", seedV4(TWO_ROOMS), `
  window.__plan.setWallsMode(true);
  var P = window.__plan.plan;
  var w = P.walls.filter(function(x){ return !x.isOutline; })[0];
  var area = function(name){ var c = P.cells.filter(function(x){ return x.name === name; })[0];
                             return c ? Math.round(window.__plan.overlapArea(c.poly, c.poly)) : -1; };
  var before = { salon: area("Salon"), chambre: area("Chambre"), x: w.a[0], walls: P.walls.filter(function(x){ return !x.isOutline; }).length };
  window.__plan.moveWall(w.id, 40);
  var Q = window.__plan.plan;
  area = function(name){ var c = Q.cells.filter(function(x){ return x.name === name; })[0];
                         return c ? Math.round(window.__plan.overlapArea(c.poly, c.poly)) : -1; };
  var w2 = Q.walls.filter(function(x){ return x.id === w.id; })[0];
  return { before: before, salon: area("Salon"), chambre: area("Chambre"),
           x: w2 ? w2.a[0] : null, cells: Q.cells.length };
`, v => expect(v.before.walls === 1, "the two rooms must share ONE wall, got " + v.before.walls)
     && expect(v.x !== null && Math.abs(v.x - v.before.x) > 1, "the wall should have moved, x=" + v.x)
     && expect(v.cells === 2, "still exactly 2 cells, got " + v.cells)
     && expect((v.salon - v.before.salon) * (v.chambre - v.before.chambre) < 0,
        "one cell must shrink while the other grows: " + v.before.salon + "->" + v.salon
        + " / " + v.before.chambre + "->" + v.chambre)
     && expect(Math.abs((v.salon + v.chambre) - (v.before.salon + v.before.chambre)) < 200,
        "the total floor area is conserved: " + (v.before.salon + v.before.chambre) + " -> " + (v.salon + v.chambre)));

// 9. Wall-mount: a sconce dropped near a wall becomes an opening ON that wall.
test("wall_mount_sticks_to_a_wall", seedV4(TWO_ROOMS), `
  var p = window.__plan.placeAt("sconce", { x: 450, y: 296 });
  var pose = p ? window.__plan.v5OpeningPose(p.id) : null;
  var P = window.__plan.plan;
  return { placed: !!p, wallId: pose && pose.wallId, onWall: pose && pose.onWall,
           openings: P.openings.length, pieces: P.pieces.length,
           faces: pose && pose.facesName };
`, v => expect(v.placed === true, "the sconce should have been placed")
     && expect(!!v.wallId, "it must be parameterised on a wall, got " + v.wallId)
     && expect(v.onWall !== null && v.onWall < 0.6, "its centre must sit ON the wall, dist=" + v.onWall)
     && expect(v.openings === 1 && v.pieces === 1, "it becomes an OPENING, not a piece: " + v.openings + "/" + v.pieces)
     && expect(v.faces === "Chambre", "it must face the cell the cursor was in, got " + v.faces));

// 11. REPLACES `envelope_hull_matches_union_bbox`: the envelope is no longer an editable entity,
//     but the rectilinear hull remains the OUTLINE that reading an old plan produces.
test("outline_from_old_plan_matches_union_bbox", seedV4(TWO_ROOMS), `
  var st = window.__plan.readLegacy(JSON.parse(localStorage.getItem("room-planner-v4-backup")));
  var u = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  st.rooms.forEach(function(r){
    var poly = window.__plan.roomAptPoly(r);
    poly.forEach(function(p){ u.minX=Math.min(u.minX,p[0]); u.minY=Math.min(u.minY,p[1]);
                              u.maxX=Math.max(u.maxX,p[0]); u.maxY=Math.max(u.maxY,p[1]); });
  });
  var eb = window.__plan.bboxOfPoly(window.__plan.plan.outline);
  return { u:u, eb:{minX:eb.minX,minY:eb.minY,maxX:eb.maxX,maxY:eb.maxY} };
`, v => expect(near(v.eb.minX, v.u.minX, 12) && near(v.eb.minY, v.u.minY, 12)
            && near(v.eb.maxX, v.u.maxX, 12) && near(v.eb.maxY, v.u.maxY, 12),
        "the outline bbox should ~= the union bbox (tol 1 cell=12): union=" + JSON.stringify(v.u) + " outline=" + JSON.stringify(v.eb)));

// 11b. REPLACES `envelope_corridor_piece_homes_env`: the corridor is no longer a pseudo-container,
//      it's a CELL computed like the others, and furniture dropped inside it belongs to it.
test("corridor_gap_becomes_a_cell", (function(){
  var s = JSON.parse(JSON.stringify(TWO_ROOMS));
  s.rooms[0].room.poly = rect(250, 300); s.rooms[0].ax = 0;
  s.rooms[1].room.poly = rect(250, 300); s.rooms[1].ax = 400;
  return seedV4(s);
})(), `
  // point (320,150) is in the old corridor (between x=250 and x=400)
  var c = window.__plan.cellAt(320, 150);
  var p = window.__plan.placeAt("plant", { x: 320, y: 150 });
  var at = window.__plan.pieceAt(p.id);
  var P = window.__plan.plan;
  return { cellName: c ? c.name : null, homeCell: at && at.cell, cells: P.cells.length,
           names: P.cells.map(function(x){ return x.name; }) };
`, v => expect(!!v.cellName, "the corridor gap must be a detected cell, got " + JSON.stringify(v.names))
     && expect(v.cells === 3, "two rooms + the corridor = 3 cells, got " + v.cells + " " + JSON.stringify(v.names))
     && expect(v.homeCell === v.cellName, "the piece must belong to the corridor cell, got " + v.homeCell));

// 12. Flow: a room with NO door -> "Pièce inaccessible" finding.
test("flow_no_door_inaccessible", seedV4(ONE_ROOM_FLOW(false)), `
  window.__plan.analyzeNow();
  var findings = window.__plan.findings || [];
  return { titles: findings.map(function(x){return x.title;}) };
`, v => {
  const t = v.titles || [];
  return expect(t.some((x: string) => /No door|unreachable|inaccessible/i.test(x)),
    "expected a no-door / inaccessible finding, got: " + JSON.stringify(t));
});

// 12b. Flow: a room WITH a connecting door -> no inaccessible finding.
test("flow_with_door_reachable", seedV4(ONE_ROOM_FLOW(true)), `
  window.__plan.analyzeNow();
  var findings = window.__plan.findings || [];
  var titles = findings.map(function(x){return x.title;});
  var doors = window.__plan.plan.openings.filter(function(p){return p.type==="door";}).length;
  return { titles: titles, doors: doors };
`, v => {
  const t = v.titles || [];
  return expect(v.doors === 1, "the seeded door must survive the conversion, got " + v.doors)
      && expect(!t.some((x: string) => /inaccessible/i.test(x)), "room with a door should NOT be inaccessible, got: " + JSON.stringify(t))
      && expect(!t.some((x: string) => /No door placed/i.test(x)), "should not report 'no door', got: " + JSON.stringify(t));
});

// 13. Migration: a legacy v3 single-room plan is still READ (and converted) without loss.
test("migrate_v3_is_read_and_converted", `try{ localStorage.setItem(${JSON.stringify(V3_KEY)}, ${JSON.stringify(JSON.stringify(V3_PLAN))}); }catch(e){}`, `
  var P = window.__plan.plan;
  return {
    cells: P.cells.length,
    pieces: P.pieces.length,
    types: P.pieces.map(function(p){return p.type;}),
    floor: P.cells[0] && P.cells[0].floor,
    outline: window.__plan.bboxOfPoly(P.outline),
  };
`, v => expect(v.cells === 1, "a v3 plan must read as exactly 1 cell, got " + v.cells)
     && expect(v.pieces === 2, "both v3 pieces should survive, got " + v.pieces)
     && expect(v.types.indexOf("sofa3") >= 0 && v.types.indexOf("coffee") >= 0, "piece types lost: " + JSON.stringify(v.types))
     && expect(v.floor === "herringbone", "v3 opts.floor should carry to the cell floor, got " + v.floor)
     && expect(near(v.outline.w, 420, 12) && near(v.outline.l, 360, 12),
        "the v3 room becomes the apartment outline, got " + v.outline.w + "x" + v.outline.l));

// 13b. Roundtrip: serialize -> migrate preserves the whole plan.
test("serialize_migrate_roundtrip", seedV4(TWO_ROOMS), `
  var ser = window.__plan.serialize();
  var again = window.__plan.migrate(JSON.parse(JSON.stringify(ser)));
  var P = window.__plan.plan;
  return {
    cells: again.plan.cells.length, srcCells: P.cells.length,
    walls: again.plan.walls.length, srcWalls: P.walls.length,
    pieces: again.plan.pieces.length, srcPieces: P.pieces.length,
    openings: again.plan.openings.length, srcOpenings: P.openings.length,
    hasRooms: ("rooms" in again),
  };
`, v => expect(v.cells === v.srcCells && v.walls === v.srcWalls && v.pieces === v.srcPieces && v.openings === v.srcOpenings,
        "the plan lost data through serialize/migrate: " + JSON.stringify(v))
     && expect(v.hasRooms === false, "migrate() must never hand back a rooms[] array"));

// =============================================================================
//  PALETTE + WALL MOUNTING (regressions from the "wall fixtures" campaign)
// =============================================================================

// 14. Contained palette thumbnail. pieceIconSVG sets overflow:visible on wall-mounted objects
//     (the marker MUST stick into the room, on the PLAN). In the palette, the slot is only
//     44x30 px: this overflow, expressed in cm, was worth ~45 px and covered the neighboring slot.
//     We verify that NOTHING sticks out of a slot, neither the <svg> box nor the painted INK.
test("palette_icon_fits_its_slot", seedV4(TWO_ROOMS), `
  var rows = window.__plan.paletteIconOverflow();
  var bad = rows.filter(function(o){
    return Math.max(o.l,o.t,o.r,o.b,o.il,o.it,o.ir,o.ib) > 0.5;
  });
  var named = {};
  ["sconce","plug","rj45"].forEach(function(t){
    var o = rows.filter(function(x){ return x.type===t; })[0];
    if(o) named[t] = { box:Math.max(o.l,o.t,o.r,o.b), ink:Math.max(o.il,o.it,o.ir,o.ib), w:o.w, h:o.h };
  });
  return { count: rows.length, bad: bad, named: named,
           inset: window.__plan.pieceIconSVG("sconce",25,12,{inset:true}).indexOf("overflow:visible") < 0,
           plan: window.__plan.pieceIconSVG("sconce",25,12).indexOf("overflow:visible") >= 0 };
`, v => expect(v.count > 20, "palette should list many items, got " + v.count)
     && expect(v.bad.length === 0, "these palette icons overflow their 44x30 slot: " + JSON.stringify(v.bad))
     && expect(v.named.sconce && v.named.plug && v.named.rj45, "sconce/plug/rj45 missing from the palette")
     && expect(v.inset === true, "the palette (inset) variant must NOT set overflow:visible")
     && expect(v.plan === true, "the PLAN variant must keep overflow:visible (marker sticks into the room)"));

// 14b. The thumbnail's viewBox does contain the marker, and the ratio used by buildPalette
//      is that of this extended viewBox (otherwise the icon would be squashed).
test("palette_icon_viewbox_covers_marker", seedV4(TWO_ROOMS), `
  var out = {};
  ["sconce","plug","rj45"].forEach(function(t){
    var d = window.__plan.TYPEMAP[t];
    var m = window.__plan.wallMountMarkerMetrics(d.w);
    var vh = window.__plan.pieceIconViewH(t, d.w, d.h);
    var svg = window.__plan.pieceIconSVG(t, d.w, d.h, {inset:true});
    var vb = (svg.match(/viewBox="0 0 ([\\d.]+) ([\\d.]+)"/)||[]);
    out[t] = { h:d.h, over:+m.over.toFixed(2), viewH:+vh.toFixed(2), vbH:+vb[2] };
  });
  out.sofa3 = { h: window.__plan.TYPEMAP.sofa3.h,
                viewH: window.__plan.pieceIconViewH("sofa3", window.__plan.TYPEMAP.sofa3.w, window.__plan.TYPEMAP.sofa3.h) };
  return out;
`, v => expect(["sconce","plug","rj45"].every(t => near(v[t].viewH, v[t].h + v[t].over, 0.02)),
              "viewH must equal h + marker overflow: " + JSON.stringify(v))
     && expect(["sconce","plug","rj45"].every(t => near(v[t].vbH, v[t].viewH, 0.02)),
              "the inset viewBox height must be the extended one: " + JSON.stringify(v))
     && expect(v.sofa3.viewH === v.sofa3.h, "a non wall-mount must keep viewH === h"));

// 15. REPLACES `wallmount_drag_crosses_rooms`: there is no longer a room to cross. Dragging a
//     sconce onto ANOTHER wall re-parameterizes it there (wallId changes), in apartment space.
test("wallmount_drag_crosses_walls", seedV4(TWO_ROOMS), `
  var P = window.__plan;
  // place a sconce on the LEFT wall of the apartment (x=0)
  var a = P.placeAt("sconce", {x:4, y:150});
  var p0 = P.v5OpeningPose(a.id);
  // drag it to the RIGHT wall (x=600)
  var res = P.dragWallMountTo(a.id, 596, 150);
  var p1 = P.v5OpeningPose(a.id);
  return { w0: p0.wallId, w1: p1.wallId, cx: p1.cx, faces: p1.facesName,
           openings: P.plan.openings.length };
`, v => expect(v.w0 !== v.w1, "dragging onto another wall must re-parameterise it, got " + v.w0 + " -> " + v.w1)
     && expect(near(v.cx, 600, 2), "it must stick to the x=600 wall, got cx=" + v.cx)
     && expect(v.faces === "Chambre", "it must face the cell behind that wall, got " + v.faces)
     && expect(v.openings === 1, "the drag must not duplicate it, got " + v.openings));

// 16. Refusal to place out of reach. A wall-mounted object is NEVER placed floating: with no wall in
//     reach, nothing is created, no history entry, and a toast spells it out in plain language.
test("wallmount_refused_out_of_reach", seedV4(TWO_ROOMS), `
  var P = window.__plan;
  var before = P.plan.openings.length;
  P.clearToast();
  var r = P.placeWallMountAt("sconce", 4000, 4000);
  var after = P.plan.openings.length;
  P.clearToast();
  var ok = P.placeWallMountAt("sconce", 4, 150);
  var after2 = P.plan.openings.length;
  return { before: before, after: after, placed: r.placed, toast: r.toast,
           reach: +P.wallSnapReach().toFixed(1),
           nearOk: ok.placed, after2: after2,
           previewFar: P.wallMountPreviewApt("sconce", 4000, 4000, P.wallSnapReach()),
           previewNear: !!P.wallMountPreviewApt("sconce", 4, 150, P.wallSnapReach()) };
`, v => expect(v.placed === false, "no wall in reach must NOT place anything")
     && expect(v.after === v.before, "opening count must not change on a refused drop: " + v.before + " -> " + v.after)
     && expect(typeof v.toast === "string" && /wall/i.test(v.toast), "a toast must explain the refusal, got " + JSON.stringify(v.toast))
     && expect(v.previewFar === null, "the preview must report 'no wall' far from everything")
     && expect(v.previewNear === true, "the preview must find the wall when close")
     && expect(v.nearOk === true && v.after2 === v.before + 1, "a drop near a wall must still place exactly one opening"));

// 17. Reach adapts to zoom: 60 cm hardcoded was a few pixels at low zoom. The reach
//     equals max(60 cm, 45 px converted to cm), capped at 150 cm.
test("wallmount_reach_scales_with_zoom", seedV4(TWO_ROOMS), `
  var P = window.__plan;
  P.fitView();
  var s = P.vScale, reach = P.wallSnapReach();
  return { scale:+s.toFixed(4), reach:+reach.toFixed(2), px:+(reach*s).toFixed(1),
    formulaOK: Math.abs(reach - Math.min(150, Math.max(60, 45/s))) < 1e-6,
    floor60: reach >= 60, cap150: reach <= 150,
    atLeast45px: reach*s >= 44.9 || reach >= 149.9 };
`, v => expect(v.formulaOK === true, "reach must be min(150, max(60, 45/vScale))")
     && expect(v.atLeast45px === true, "at fit zoom the reach must be worth >= 45 px, got " + v.px + " px")
     && expect(v.floor60 === true, "reach must never drop below 60 cm")
     && expect(v.cap150 === true, "reach must be capped at 150 cm"));

// ---- SIDE OF THE WALL (sconce / outlet / RJ45) ---------------------------------------------------
// A wall has TWO faces. Side is a property of the OBJECT, decided by the GESTURE (the cursor's
// side), never deduced from belonging to a room.

// 18. Placement: the face is the cursor's, on both sides of the SAME interior wall.
test("wallmount_side_is_the_cursor_side", seedV4(TWO_ROOMS), `
  var P = window.__plan;
  var a = P.placeAt("sconce", { x: 292, y: 120 });   // cursor in the LEFT cell
  var pa = P.v5OpeningPose(a.id);
  var b = P.placeAt("sconce", { x: 308, y: 240 });   // cursor in the RIGHT cell, same wall
  var pb = P.v5OpeningPose(b.id);
  return { aWall: pa.wallId, bWall: pb.wallId, aFaces: pa.facesName, bFaces: pb.facesName,
           aSide: pa.side, bSide: pb.side, aCx: pa.cx, bCx: pb.cx,
           delta: (((pa.rot - pb.rot) % 360) + 360) % 360 };
`, v => expect(near(v.aCx, 300, 2) && near(v.bCx, 300, 2), "both must stick to the shared wall x=300, got " + v.aCx + " / " + v.bCx)
     && expect(v.aWall === v.bWall, "both must land on the SAME wall object, got " + v.aWall + " / " + v.bWall)
     && expect(v.aFaces === "Salon", "posed from the left cell it must FACE it, got " + v.aFaces)
     && expect(v.bFaces === "Chambre", "posed from the right cell it must FACE it, got " + v.bFaces)
     && expect(v.aSide !== v.bSide, "the two faces must differ, got " + v.aSide + " / " + v.bSide)
     && expect(v.delta === 180, "the two faces of a wall differ by exactly 180 degrees, got " + v.delta));

// 19. The reported case: a CORRIDOR wall. The corridor is now a cell like any other,
//     and a sconce placed FROM the corridor faces the corridor.
test("wallmount_corridor_side_is_reachable", (function () {
  var s = JSON.parse(JSON.stringify(TWO_ROOMS));
  s.rooms[0].room.poly = rect(250, 300); s.rooms[0].ax = 0;
  s.rooms[1].room.poly = rect(250, 300); s.rooms[1].ax = 400;
  return seedV4(s);
})(), `
  var P = window.__plan;
  var corridor = P.cellAt(320, 150);
  var p = P.placeAt("sconce", { x: 256, y: 150 });   // cursor on the CORRIDOR side of wall x=250
  var pose = p ? P.v5OpeningPose(p.id) : null;
  return { corridor: corridor ? corridor.name : null,
           faces: pose && pose.facesName, back: pose && pose.backName, cx: pose && pose.cx };
`, v => expect(!!v.corridor, "the corridor gap must be a cell of its own")
     && expect(near(v.cx, 250, 2), "the sconce must stick to the x=250 wall, got " + v.cx)
     && expect(v.faces === v.corridor, "posed from the CORRIDOR it must face the corridor, got " + v.faces)
     && expect(v.back === "Salon", "its back must be on the room side, got " + v.back));

// 20. Dragging: dragging the object across its wall moves it to the other face, both there AND back.
test("wallmount_drag_flips_side_through_wall", seedV4(TWO_ROOMS), `
  var P = window.__plan;
  var p = P.placeAt("sconce", { x: 292, y: 150 });
  var f0 = P.v5OpeningPose(p.id);
  P.dragWallMountTo(p.id, 308, 150);                  // the cursor crosses the wall
  var f1 = P.v5OpeningPose(p.id);
  P.dragWallMountTo(p.id, 292, 150);                  // and comes back
  var f2 = P.v5OpeningPose(p.id);
  return { f0: f0.facesName, f1: f1.facesName, f2: f2.facesName, cx: f1.cx,
           d01: (((f1.rot - f0.rot) % 360) + 360) % 360 };
`, v => expect(v.f0 === "Salon", "it must start facing the left cell, got " + v.f0)
     && expect(v.f1 === "Chambre", "dragged through the wall it must face the right cell, got " + v.f1)
     && expect(v.d01 === 180, "crossing the wall is exactly a 180 degrees flip, got " + v.d01)
     && expect(near(v.cx, 300, 2), "it must stay on the wall, got cx=" + v.cx)
     && expect(v.f2 === "Salon", "dragged back it must face the left cell again, got " + v.f2));

// 21. REPLACES `wallmount_side_survives_restick`: moving the LOAD-BEARING wall re-projects the
//     object's position but KEEPS the chosen side (this used to overwrite any user choice).
test("wallmount_side_survives_a_wall_move", seedV4(TWO_ROOMS), `
  var P = window.__plan;
  var p = P.placeAt("sconce", { x: 308, y: 150 });    // right cell side
  var before = P.v5OpeningPose(p.id);
  var w = P.plan.walls.filter(function(x){ return !x.isOutline; })[0];
  P.setWallsMode(true);
  P.moveWall(w.id, 40);                               // pull the load-bearing wall by 40 cm
  P.setWallsMode(false);
  var after = P.v5OpeningPose(p.id);
  return { r0: before.rot, s0: before.side, f0: before.facesName, cx0: before.cx,
           r1: after.rot, s1: after.side, f1: after.facesName, cx1: after.cx, wall: w.id };
`, v => expect(v.f0 === "Chambre", "it must start facing the right cell, got " + v.f0)
     && expect(Math.abs(v.cx1 - v.cx0) > 1, "the wall did move (position re-projected): " + v.cx0 + " -> " + v.cx1)
     && expect(v.s1 === v.s0 && v.r1 === v.r0, "moving the wall must NOT flip it: side " + v.s0 + " -> " + v.s1)
     && expect(v.f1 === "Chambre", "it must still face the right cell, got " + v.f1));

// 22. Explicit control: the sheet's "Flip side" button + the R key. Reserved for
//     non-opening wall-mounted objects (a door keeps its hinge + swing direction).
test("wallmount_flip_side_control", seedV4(TWO_ROOMS), `
  var P = window.__plan;
  var p = P.placeAt("sconce", { x: 292, y: 150 });
  var f0 = P.v5OpeningPose(p.id);
  var clicked = P.clickFlipSide(p.id);
  var label = (function(){ var b = document.getElementById("iSide"); return b ? b.textContent : null; })();
  var f1 = P.v5OpeningPose(p.id);
  P.pressFlipSide(p.id);                              // R key: same flip
  var f2 = P.v5OpeningPose(p.id);
  var d = P.placeAt("door", { x: 150, y: 4 });
  var doorBtn = P.clickFlipSide(d.id);
  return { clicked: clicked.clicked, label: label, f0: f0.facesName, f1: f1.facesName, f2: f2.facesName,
           s0: f0.side, s1: f1.side, s2: f2.side,
           d01: (((f1.rot - f0.rot) % 360) + 360) % 360,
           doorClicked: doorBtn.clicked, doorHidden: doorBtn.hidden };
`, v => expect(v.clicked === true, "the flip button must be visible + enabled for a sconce")
     && expect(v.label === "Flip side", "the button must carry its label, got " + JSON.stringify(v.label))
     && expect(v.d01 === 180 && v.s1 !== v.s0, "the button must flip it to the other face, got " + v.f0 + " -> " + v.f1)
     && expect(v.s2 === v.s0 && v.f2 === v.f0, "the R key must flip it back, got " + v.f1 + " -> " + v.f2)
     && expect(v.doorClicked === false && v.doorHidden === true, "a door must NOT get the flip button"));

// 23. Preview (palette ghost): it announces the SAME face as the real placement.
test("wallmount_preview_matches_the_pose", seedV4(TWO_ROOMS), `
  var P = window.__plan;
  var reach = P.wallSnapReach();
  var prevA = P.wallMountPreviewApt("sconce", 292, 150, reach);
  var a = P.placeAt("sconce", { x: 292, y: 150 });
  var fa = P.v5OpeningPose(a.id);
  var prevB = P.wallMountPreviewApt("sconce", 308, 260, reach);
  var b = P.placeAt("sconce", { x: 308, y: 260 });
  var fb = P.v5OpeningPose(b.id);
  return { pa: prevA && prevA.rot, ra: fa.rot, pb: prevB && prevB.rot, rb: fb.rot };
`, v => expect(v.pa === v.ra, "the ghost must announce the pose rotation, got " + v.pa + " vs " + v.ra)
     && expect(v.pb === v.rb, "same on the other face, got " + v.pb + " vs " + v.rb)
     && expect((((v.pa - v.pb) % 360) + 360) % 360 === 180, "the two previews must be 180 degrees apart"));

// 24. ESCAPING: a hostile name NEVER plants a tag, wherever it is displayed.
// A name (of a cell, furniture, opening) comes from the wire, a JSON import, or an old plan.
// Four surfaces splice it into HTML: the label on the plan (js/54), the furniture list
// (js/30), the printed page (js/32) and the Circulation panel (js/36 -> js/38). A single function
// escapes for everyone (escapeHtml, js/00). The `data-xss` marker is undetectable if the name
// is rendered as TEXT, and trivially detectable if it was interpreted as markup.
const XSS_NAME = '<i data-xss="1">boum</i>';
const HOSTILE_NAMES = {
  rooms: [
    { id: 1, name: XSS_NAME, floor: "parquet", ax: 0, ay: 0, room: { poly: rect(400, 360) },
      pieces: [
        { id: 201, type: "door",  name: XSS_NAME, x: 160, y: -6, w: 80,  h: 12, rot: 0, hinge: 0, swing: 1 },
        { id: 202, type: "sofa3", name: XSS_NAME, x: 150, y: 10, w: 220, h: 95, rot: 0 },
      ] },
  ],
  active: 0,
  opts: { snap: true, labels: true, flow: true, overlay: false, tvIn: null as DonneeDynamique, collapsedCats: [] as DonneeDynamique[], layFurn: true, layLight: true, layPlug: true },
  setupDone: true,
  envelope: null as DonneeDynamique,
};
test("hostile_names_never_inject_html", seedV4(HOSTILE_NAMES), `
  var P = window.__plan;
  document.getElementById("flowpanel").hidden = false;   // otherwise renderFlow bails out right away
  P.render();
  P.analyzeNow();     // Circulation panel (findings cite the names)
  P.openFurni();      // "Furniture list" modal
  P.preparePrint();   // printed page (#printFurni)
  var txt = function(id){ var e = document.getElementById(id); return e ? e.textContent : ""; };
  var label = document.querySelector("#canvas .plabel");
  return {
    injected : document.querySelectorAll("[data-xss]").length,
    italics  : document.querySelectorAll("#furniBody i, #printFurni i, #flowList i, #canvas .plabel i").length,
    findings : (P.findings || []).length,
    inFurni  : txt("furniBody").indexOf(${JSON.stringify(XSS_NAME)}) >= 0,
    inPrint  : txt("printFurni").indexOf(${JSON.stringify(XSS_NAME)}) >= 0,
    inFlow   : txt("flowList").indexOf(${JSON.stringify(XSS_NAME)}) >= 0,
    inLabel  : !!label && label.textContent.indexOf(${JSON.stringify(XSS_NAME)}) >= 0,
    svg      : P.buildMasterSVG().indexOf("<i data-xss") < 0,
  };
`, v => expect(v.injected === 0, "un nom hostile a posé " + v.injected + " élément(s) dans le DOM")
     && expect(v.italics === 0, "un nom hostile a été interprété comme du balisage (" + v.italics + " <i>)")
     && expect(v.findings > 0, "le panneau Circulation doit citer au moins un constat, got " + v.findings)
     && expect(v.inFurni, "la liste du mobilier doit afficher le nom EN TOUTES LETTRES")
     && expect(v.inPrint, "la page imprimée doit afficher le nom EN TOUTES LETTRES")
     && expect(v.inFlow, "le panneau Circulation doit afficher le nom EN TOUTES LETTRES")
     && expect(v.inLabel, "l'étiquette sur le plan doit afficher le nom EN TOUTES LETTRES")
     && expect(v.svg, "le SVG maître (export PNG/PDF) ne doit pas contenir de balise venue d'un nom"));

// ---- report -----------------------------------------------------------------
try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch (e) {}

const passed = results.filter(r => r.pass).length;
const total = results.length;
process.stdout.write("\n");
if (passed === total) {
  process.stdout.write("OK " + passed + "/" + total + "\n");
  process.exit(0);
} else {
  process.stdout.write("FAILURES " + (total - passed) + "/" + total + ":\n");
  results.filter(r => !r.pass).forEach(r => process.stdout.write("  - " + r.name + ": " + r.detail.split("\n")[0] + "\n"));
  process.exit(1);
}
