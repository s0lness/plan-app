#!/usr/bin/env node
// THE OWNER'S REAL PLAN, READ AND RENDERED: converting their 8 rooms into cells, then the render
// (read-only) and the serialize/migrate round trip. The suite states the facts of the conversion.
import type { DonneeDynamique } from "./_types.ts";
import { test, near, expect, seedV4, REAL_PLAN, report } from "./_harness-v5.ts";

// =============================================================================
//  4. CONVERSION OF THE OWNER'S REAL 8-ROOM PLAN
// =============================================================================
const REAL_ROOM_NAMES = REAL_PLAN.rooms.map((r: DonneeDynamique) => r.name);
const REAL_FURNITURE = REAL_PLAN.rooms.reduce((n: number, r: DonneeDynamique) => n + r.pieces.filter((p: DonneeDynamique) =>
  !["door", "sdoor", "window", "sconce", "plug", "rj45"].includes(p.type)).length, 0);
const REAL_WALLMOUNTS = REAL_PLAN.rooms.reduce((n: number, r: DonneeDynamique) => n + r.pieces.filter((p: DonneeDynamique) =>
  ["door", "sdoor", "window", "sconce", "plug", "rj45"].includes(p.type)).length, 0);

test("v5_convert_real_plan", seedV4(REAL_PLAN), `
  // The plan was READ and CONVERTED on load; we replay the same read from the backup taken
  // before conversion (the only place where the old format survives).
  var st = window.__plan.readLegacy(JSON.parse(localStorage.getItem("room-planner-v4-backup")));
  var res = window.__plan.buildV5FromV4(st);
  var P = res.plan, R = res.report;
  if(!P) return { error: "no plan", report: R };
  var interior = P.walls.filter(function(w){ return !w.isOutline; });
  var outlineW = P.walls.filter(function(w){ return w.isOutline; });
  // every old room name must appear on some cell
  var names = P.cells.map(function(c){ return c.name; });
  var missing = st.rooms.map(function(r){ return r.name; }).filter(function(n){ return names.indexOf(n) < 0; });
  // no orphan geometry: every cell has area, and the cells tile the outline
  var outArea = 0, poly = P.outline;
  for(var i=0,j=poly.length-1;i<poly.length;j=i++) outArea += (poly[j][0]*poly[i][1]-poly[i][0]*poly[j][1]);
  outArea = Math.abs(outArea/2);
  var cellArea = P.cells.reduce(function(s,c){ return s + window.__plan.overlapArea(c.poly, c.poly); }, 0);
  var minCell = P.cells.reduce(function(m,c){ return Math.min(m, window.__plan.overlapArea(c.poly,c.poly)); }, 1e12);
  // furniture round-trip: same count, same apartment position (within 1cm)
  var wallTypes = {door:1, sdoor:1, window:1, sconce:1, plug:1, rj45:1};
  var srcFurn = [];
  st.rooms.forEach(function(r){
    var b = window.__plan.roomLocalBBox(r);
    r.pieces.forEach(function(p){
      if(wallTypes[p.type]) return;
      srcFurn.push({id:String(p.id), x:(r.ax||0)+p.x-b.minX, y:(r.ay||0)+p.y-b.minY, w:p.w, h:p.h, rot:p.rot||0, locked:!!p.locked, type:p.type});
    });
  });
  var byId = {}; P.pieces.forEach(function(p){ byId[p.id]=p; });
  var badPos = [];
  srcFurn.forEach(function(s){
    var d = byId[s.id];
    if(!d){ badPos.push({id:s.id, why:"missing"}); return; }
    if(Math.abs(d.x-s.x)>1 || Math.abs(d.y-s.y)>1) badPos.push({id:s.id, why:"pos", got:[d.x,d.y], want:[Math.round(s.x),Math.round(s.y)]});
    if(d.w!==s.w || d.h!==s.h || d.rot!==s.rot || d.locked!==s.locked || d.type!==s.type) badPos.push({id:s.id, why:"attrs"});
  });
  // every opening must sit ON its wall (distance from its box centre to the wall segment ~0)
  var offWall = 0;
  P.openings.forEach(function(o){
    var box = window.__plan.v5OpeningBox(P, o); if(!box){ offWall++; return; }
    var w = box.wall, dx=w.b[0]-w.a[0], dy=w.b[1]-w.a[1], L=Math.hypot(dx,dy)||1;
    var t = ((box.cx-w.a[0])*dx + (box.cy-w.a[1])*dy)/(L*L);
    var px = w.a[0]+t*dx, py = w.a[1]+t*dy;
    if(Math.hypot(box.cx-px, box.cy-py) > 0.6 || t < -0.001 || t > 1.001) offWall++;
  });
  return {
    rooms: st.rooms.length,
    interiorWalls: interior.length, outlineWalls: outlineW.length,
    cells: P.cells.length, cellNames: names,
    missingNames: missing,
    outArea: Math.round(outArea), cellArea: Math.round(cellArea), minCell: Math.round(minCell),
    openings: P.openings.length, orphanOpenings: R.openingsOrphan, offWall: offWall,
    pieces: P.pieces.length, srcFurn: srcFurn.length, badPos: badPos.slice(0,6), badCount: badPos.length,
    rawEdges: R.rawEdges, outlineEdges: R.outlineEdges, unmatchedRooms: R.unmatchedRooms,
    detect: R.detect
  };
`, v => expect(!v.error, "conversion failed: " + JSON.stringify(v))
     && expect(v.rooms === 8, "fixture should hold 8 rooms, got " + v.rooms)
     && expect(v.cells >= 9, "expected at least 8 rooms + a corridor cell, got " + v.cells + " (detect=" + JSON.stringify(v.detect) + ")")
     && expect(v.missingNames.length === 0, "these room names were lost: " + JSON.stringify(v.missingNames) + " cells=" + JSON.stringify(v.cellNames))
     && expect(v.unmatchedRooms.length === 0, "these rooms matched no cell: " + JSON.stringify(v.unmatchedRooms))
     && expect(v.minCell >= 400, "no sliver cell allowed, smallest = " + v.minCell + " cm²")
     && expect(near(v.cellArea, v.outArea, v.outArea * 0.02),
        "cells must tile the outline (±2%): cells=" + v.cellArea + " outline=" + v.outArea)
     && expect(v.pieces === REAL_FURNITURE, "furniture count changed: " + v.pieces + " vs " + REAL_FURNITURE)
     && expect(v.badCount === 0, "furniture not preserved: " + JSON.stringify(v.badPos))
     && expect(v.openings === REAL_WALLMOUNTS, "wall-mounted items lost: " + v.openings + " vs " + REAL_WALLMOUNTS)
     && expect(v.orphanOpenings === 0, "orphan openings (no wall found): " + v.orphanOpenings)
     && expect(v.offWall === 0, v.offWall + " opening(s) do not sit on their wall"));

// 4b. every old room name lands in the cell that CONTAINS that room's centroid.
test("v5_convert_names_land_on_right_cell", seedV4(REAL_PLAN), `
  // We reread the old rooms from the backup taken before conversion, then check that each name
  // landed on the right cell.
  var st = window.__plan.readLegacy(JSON.parse(localStorage.getItem("room-planner-v4-backup")));
  var before = st.rooms.map(function(r){
    return { name:r.name, bb: window.__plan.bboxOfPoly(window.__plan.roomAptPoly(r)) };
  });
  var res = window.__plan.buildV5FromV4(st);
  window.__plan.setModel(res.plan);
  var bad = [];
  before.forEach(function(r){
    var b = r.bb;
    var c = window.__plan.cellAt((b.minX+b.maxX)/2, (b.minY+b.maxY)/2);
    if(!c || c.name !== r.name) bad.push({room:r.name, cell:c?c.name:null});
  });
  return { bad: bad, model: window.__plan.model, cells: window.__plan.plan.cells.length };
`, v => expect(v.model === "v5", "the only model is the walls-only one, got " + v.model)
     && expect(v.bad.length === 0, "room centre -> wrong cell: " + JSON.stringify(v.bad)));

// =============================================================================
//  5. RENDER (read-only)
// =============================================================================
test("v5_render_single_band_per_wall", "", `
  var plan = { outline:[[0,0],[600,0],[600,400],[0,400]],
               walls:[{id:"w1", a:[300,0], b:[300,400], t:12}],
               openings:[{id:"o1", wallId:"w1", t0:150, w:80, h:12, type:"door", side:0, hinge:0, swing:1}],
               pieces:[{id:"p1", type:"sofa3", name:"Canapé", x:20, y:20, w:220, h:95, rot:0}],
               cells:[] };
  window.__plan.setModel(plan);
  window.__plan.rebuildCells(window.__plan.plan);
  window.__plan.renderV5();
  var st = window.__plan.v5RenderStats();
  var aptrooms = document.querySelectorAll("#canvas .aptroom").length;
  var hiddenV4 = document.getElementById("canvas").classList.contains("v5");
  return { layer: st.layer, lines: st.bands, outlineBands: st.outlineBands, floors: st.floors,
           pieces: st.pieces, openings: st.openings,
           labels: st.labels, aptrooms: aptrooms, hiddenV4: hiddenV4, cells: window.__plan.plan.cells.length };
`, v => expect(v.layer === 1, "no v5 layer rendered")
     && expect(v.cells === 2, "expected 2 cells, got " + v.cells)
     && expect(v.lines === 1, "exactly ONE band per interior wall (no doubling), got " + v.lines)
     && expect(v.outlineBands === 1, "the outline must be one closed band, got " + v.outlineBands)
     && expect(v.floors === 2, "one clipped floor fill per cell, got " + v.floors)
     && expect(v.openings === 1, "the door should render as an opening on its wall, got " + v.openings)
     && expect(v.pieces === 2, "one sofa + one door = 2 .piece nodes, got " + v.pieces)
     && expect(v.labels === 2, "one label per cell, got " + v.labels)
     && expect(v.hiddenV4 === true, "the v4 containers must be hidden while v5 is on"));

// 5b. zoom/pan correctness: the layer is anchored at the outline origin, and its size tracks the scale.
test("v5_render_zoom_pan_anchored", "", `
  var plan = { outline:[[100,50],[700,50],[700,450],[100,450]],
               walls:[{id:"w1", a:[400,50], b:[400,450], t:12}], openings:[], pieces:[], cells:[] };
  window.__plan.setModel(plan);
  var a = window.__plan.v5RenderStats();
  var w1 = parseFloat(a.width);
  // zoom in and re-render: the layer width must scale with vScale, origin stays on the outline corner
  window.__plan.fitView();
  var b = window.__plan.v5RenderStats();
  return { w1: w1, w2: parseFloat(b.width), left1: parseFloat(a.left), left2: parseFloat(b.left),
           ok: isFinite(w1) && isFinite(parseFloat(b.width)) };
`, v => expect(v.ok, "layer size not numeric: " + JSON.stringify(v))
     && expect(v.w1 > 0 && v.w2 > 0, "layer must have a positive width, got " + v.w1 + "/" + v.w2));

// 5c. REPLACES the old "v5_off_by_default" (there's no more model to switch off): what matters
// is that the SAVED state is walls-only and no longer carries the slightest room.
test("v5_saved_payload_is_walls_only", seedV4(REAL_PLAN), `
  var ser = window.__plan.serialize();
  return { model: window.__plan.model, layer: document.querySelectorAll(".v5layer").length,
           canvasV5: document.getElementById("canvas").classList.contains("v5"),
           aptrooms: document.querySelectorAll("#canvas .aptroom").length,
           serialized: Object.keys(ser).sort().join(","),
           hasRooms: ("rooms" in ser) || ("envelope" in ser) || ("active" in ser),
           hasOpts: ("opts" in ser),
           stateKeys: Object.keys(window.__plan.state).sort().join(","),
           stored: Object.keys(JSON.parse(localStorage.getItem("room-planner-v4"))).sort().join(",") };
`, v => expect(v.model === "v5", "the only model is the walls-only one, got " + v.model)
     && expect(v.layer === 1 && v.canvasV5 === true, "the single container must be the layer")
     && expect(v.aptrooms === 0, "no room container may exist, got " + v.aptrooms)
     && expect(v.hasRooms === false, "serialize() must carry NO rooms/envelope/active key")
     && expect(v.serialized === "cells,model,openings,outline,pieces,plan,setupDone,walls",
        "unexpected payload keys: " + v.serialized)
     // SETTINGS are PERSONAL: they are no longer in the blob, hence no longer in the PUT body.
     && expect(v.hasOpts === false, "serialize() ne doit plus porter `opts` (réglage personnel)")
     && expect(v.stateKeys === "model,opts,plan,setupDone", "state must be walls-only, got " + v.stateKeys)
     && expect(v.stored === v.serialized, "localStorage must hold the same payload, got " + v.stored));

// 5d. once a v5 plan exists it round-trips through serialize()/migrate() intact.
test("v5_plan_roundtrips_serialize", seedV4(REAL_PLAN), `
  var res = { plan: window.__plan.plan };
  var ser = JSON.parse(JSON.stringify(window.__plan.serialize()));
  var again = window.__plan.migrate(ser);
  return { model: again.model,
           walls: again.plan ? again.plan.walls.length : -1,
           cells: again.plan ? again.plan.cells.length : -1,
           openings: again.plan ? again.plan.openings.length : -1,
           pieces: again.plan ? again.plan.pieces.length : -1,
           srcWalls: res.plan.walls.length, srcCells: res.plan.cells.length,
           srcOpenings: res.plan.openings.length, srcPieces: res.plan.pieces.length,
           rooms: ("rooms" in again) ? -1 : 0 };
`, v => expect(v.model === "v5", "model should round-trip as v5, got " + v.model)
     && expect(v.walls === v.srcWalls && v.cells === v.srcCells && v.openings === v.srcOpenings && v.pieces === v.srcPieces,
        "the plan lost data through serialize/migrate: " + JSON.stringify(v))
     && expect(v.rooms === 0, "migrate() must never hand back a rooms[] array"));

// The conversion facts that the deliverable requires to be stated explicitly.
function faitsDeConversion(results: DonneeDynamique) {
  const conv = results.find((r: DonneeDynamique) => r.name === "v5_convert_real_plan");
  if (!conv || !conv.verdict || conv.verdict.__probeError) return;
  const v = conv.verdict;
    process.stdout.write("Conversion of the real 8-room plan:\n");
    process.stdout.write("  rooms in            : " + v.rooms + "\n");
    process.stdout.write("  room edges seen     : " + v.rawEdges + " (on the outline: " + v.outlineEdges + ")\n");
    process.stdout.write("  interior walls      : " + v.interiorWalls + "   outline walls: " + v.outlineWalls + "\n");
    process.stdout.write("  cells detected      : " + v.cells + "  -> " + JSON.stringify(v.cellNames) + "\n");
    process.stdout.write("  cell area / outline : " + v.cellArea + " / " + v.outArea + " cm²  (smallest cell " + v.minCell + ")\n");
    process.stdout.write("  openings / orphans  : " + v.openings + " / " + v.orphanOpenings + "\n");
    process.stdout.write("  furniture kept      : " + v.pieces + "/" + v.srcFurn + "  (mismatches: " + v.badCount + ")\n");
    process.stdout.write("  unmatched rooms     : " + JSON.stringify(v.unmatchedRooms) + "\n");
    process.stdout.write("  detect report       : " + JSON.stringify(v.detect) + "\n\n");
}

// ---- verdict -----------------------------------------------------------------------------------
report(faitsDeConversion);
