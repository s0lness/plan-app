#!/usr/bin/env node
// THE EDITING TOOLS (phase 2): walls, outline, openings, furniture, pointer targeting,
// and the inspector that offers no dead button.
import type { DonneeDynamique } from "./_types.ts";
import { test, near, expect, seedV4, REAL_PLAN, SEED_PLAN, report } from "./_harness-v5.ts";

// =============================================================================
//  6. EDITING (phase 2), wall / outline / opening / furniture tools
// =============================================================================



// 6a. TOOL 1, dragging a wall moves the SHARED boundary: both cells adjust at once.
await test("v5_wall_drag_moves_shared_boundary", "", `
  window.__plan.setModel(${SEED_PLAN});
  var P = window.__plan.plan;
  window.__plan.rebuildCells(P);
  var before = P.cells.length;
  // n = (-uy, ux) = (-1,0) for a vertical downward a->b wall: d=-100 pushes the wall toward +x
  var w = window.__plan.moveWall("w1", -100);
  var ext = P.cells.map(function(c){
    var mn=1e9, mx=-1e9;
    c.poly.forEach(function(p){ if(p[0]<mn)mn=p[0]; if(p[0]>mx)mx=p[0]; });
    return {mn:mn, mx:mx, area:Math.round(window.__plan.overlapArea(c.poly,c.poly))};
  }).sort(function(a,b){ return a.mn-b.mn; });
  return { before: before, after: P.cells.length, wall: w, ext: ext,
           isOutline: P.walls.filter(function(x){ return x.isOutline; }).length };
`, v => expect(v.before === 2 && v.after === 2, "expected 2 cells before and after, got " + v.before + "/" + v.after)
     && expect(v.isOutline === 4, "the 4 facade walls must be flagged isOutline by derivation, got " + v.isOutline)
     && expect(near(v.wall.a[0], 400, 0.5) && near(v.wall.b[0], 400, 0.5),
        "the wall should sit at x=400, got " + JSON.stringify(v.wall))
     && expect(near(v.ext[0].mx, 400, 0.5) && near(v.ext[1].mn, 400, 0.5),
        "both cells must share the NEW boundary at x=400, got " + JSON.stringify(v.ext))
     && expect(near(v.ext[0].area, 160000, 500) && near(v.ext[1].area, 80000, 500),
        "areas should be 400x400 and 200x400, got " + JSON.stringify(v.ext)));

// 6b. TOOL 2, tracing a wall: a segment that reaches no geometry is EXTENDED (through wall)
// and does split the cell in two.
await test("v5_wall_draw_splits_cell", "", `
  window.__plan.setModel({ outline:[[0,0],[600,0],[600,400],[0,400]],
    walls:[], openings:[], pieces:[], cells:[] });
  var P = window.__plan.plan;
  window.__plan.rebuildCells(P);
  var n0 = P.cells.length;
  var w = window.__plan.addWall([300,50],[300,200]);   // too short on BOTH sides
  return { n0: n0, n1: P.cells.length, a: w.a, b: w.b,
           areas: P.cells.map(function(c){ return Math.round(window.__plan.overlapArea(c.poly,c.poly)); }) };
`, v => expect(v.n0 === 1, "one cell to start with, got " + v.n0)
     && expect(v.n1 === 2, "the drawn wall must split the cell, got " + v.n1 + " cells")
     && expect(near(v.a[1], 0, 0.5) && near(v.b[1], 400, 0.5),
        "both endpoints must be extended to the outline, got " + JSON.stringify([v.a, v.b]))
     && expect(v.areas.every((a: DonneeDynamique) => near(a, 120000, 500)), "two 300x400 halves expected, got " + JSON.stringify(v.areas)));

// 6c. TOOL 3, deleting a wall merges the two cells; the name of the BIGGER one wins
// (matched by area overlap), and the wall's openings cascade away.
await test("v5_wall_delete_merges_bigger_name_wins", "", `
  window.__plan.setModel({ outline:[[0,0],[600,0],[600,400],[0,400]],
    walls:[{id:"w1", a:[200,0], b:[200,400], t:12}],
    openings:[{id:"o1", wallId:"w1", t0:160, w:80, h:12, type:"door", side:0, hinge:0, swing:1}],
    pieces:[], cells:[] });
  var P = window.__plan.plan;
  window.__plan.rebuildCells(P);
  var small = P.cells.filter(function(c){ return window.__plan.overlapArea(c.poly,c.poly) < 100000; })[0];
  var big   = P.cells.filter(function(c){ return c !== small; })[0];
  small.name = "Placard"; big.name = "Grand salon";
  var openingsBefore = P.openings.length;
  var n = window.__plan.delWall("w1");
  return { n: n, name: P.cells[0] ? P.cells[0].name : null,
           area: P.cells[0] ? Math.round(window.__plan.overlapArea(P.cells[0].poly, P.cells[0].poly)) : 0,
           openingsBefore: openingsBefore, openingsAfter: P.openings.length,
           walls: P.walls.filter(function(w){ return !w.isOutline; }).length };
`, v => expect(v.n === 1, "the two cells must merge into one, got " + v.n)
     && expect(v.name === "Grand salon", "the bigger cell's name must win, got " + JSON.stringify(v.name))
     && expect(near(v.area, 240000, 800), "the merged cell should cover the whole outline, got " + v.area)
     && expect(v.openingsBefore === 1 && v.openingsAfter === 0,
        "the wall's openings must cascade away client-side (mirroring wall.del), got " + v.openingsAfter)
     && expect(v.walls === 0, "the wall itself must be gone, got " + v.walls));

// 6d. TOOL 4, moving a facade: interior walls that were leaning on it FOLLOW (re-traversal).
await test("v5_outline_drag_pulls_wall_followers", "", `
  window.__plan.setModel({ outline:[[0,0],[600,0],[600,400],[0,400]],
    walls:[{id:"w1", a:[0,200], b:[600,200], t:12}], openings:[], pieces:[], cells:[] });
  var P = window.__plan.plan;
  window.__plan.rebuildCells(P);
  var before = { b: P.walls.filter(function(w){return w.id==="w1";})[0].b.slice(), cells: P.cells.length };
  window.__plan.moveOutlineEdge(1, -200);      // edge 1 = right side, pushed to x=800
  var w1 = P.walls.filter(function(w){ return w.id==="w1"; })[0];
  var maxX = P.outline.reduce(function(m,p){ return Math.max(m,p[0]); }, -1e9);
  var total = P.cells.reduce(function(s,c){ return s + window.__plan.overlapArea(c.poly,c.poly); }, 0);
  return { beforeB: before.b, afterB: w1.b, maxX: maxX, cells: P.cells.length, total: Math.round(total),
           facades: P.walls.filter(function(w){ return w.isOutline; }).length };
`, v => expect(near(v.maxX, 800, 0.5), "the outline edge should have moved to x=800, got " + v.maxX)
     && expect(near(v.afterB[0], 800, 0.5), "the interior wall must follow the moved facade, got " + JSON.stringify(v.afterB))
     && expect(v.cells === 2, "still 2 cells after the outline move, got " + v.cells)
     && expect(near(v.total, 320000, 2000), "cells must still tile the (bigger) outline, got " + v.total)
     && expect(v.facades === 4, "the facade walls must track the outline, got " + v.facades));

// 6e. TOOL 6, an opening slides along its wall (t0 only) and reparameterizes onto ANOTHER
// wall when dropped near it (<=60 cm), with no notion of membership whatsoever.
await test("v5_opening_slides_and_rewalls", "", `
  window.__plan.setModel(${SEED_PLAN});
  var P = window.__plan.plan;
  window.__plan.rebuildCells(P);
  P.openings.push({id:"o1", wallId:"w1", t0:150, w:80, h:12, type:"door", side:0, hinge:0, swing:1});
  var slid = window.__plan.dragOpeningTo("o1", 300, 60);      // slides toward the top of the same wall
  var reWall = window.__plan.dragOpeningTo("o1", 120, 6);      // approaches the top facade
  var clampTop = window.__plan.dragOpeningTo("o1", 5000, 6);   // far to the right: t0 clamped to L-w
  return { slid: slid, reWall: reWall, clampTop: clampTop, wallLen: 600 };
`, v => expect(v.slid.wallId === "w1" && near(v.slid.t0, 20, 1),
        "sliding should only change t0 (expected ~20), got " + JSON.stringify(v.slid))
     && expect(v.reWall.wallId === "wt", "dropping near the top facade must re-wall the opening, got " + v.reWall.wallId)
     && expect(near(v.reWall.t0, 80, 1), "t0 on the new wall should be ~80, got " + v.reWall.t0)
     && expect(near(v.clampTop.t0, 520, 1), "t0 must clamp to L-w = 520, got " + v.clampTop.t0));

// 6f. TOOL 7, a piece of furniture is bounded by ITS cell (polygon inset by half a wall's
// thickness), no longer by the v4 room: it cannot overflow through the partition.
await test("v5_furniture_clamped_to_its_cell", "", `
  window.__plan.setModel(${SEED_PLAN});
  var P = window.__plan.plan;
  window.__plan.rebuildCells(P);
  var p = window.__plan.addV5Piece("sofa3", 40, 40);
  p.x = 150; p.y = 100;                 // 220 wide: would overflow from x=150 to x=370
  window.__plan.clampV5Piece(p);
  var cell = window.__plan.cellOf(p.x + p.w/2, p.y + p.h/2);
  return { x:p.x, y:p.y, w:p.w, h:p.h, right:p.x+p.w, bottom:p.y+p.h,
           cell: cell ? cell.id : null, inset: window.__plan.WALL_INSET };
`, v => expect(v.right <= 300 - v.inset + 1, "the sofa must stay inside its cell (right edge " + v.right + " > 300)")
     && expect(v.x >= v.inset - 1 && v.bottom <= 400 - v.inset + 1,
        "the sofa must stay inside the outline too, got " + JSON.stringify(v))
     && expect(v.cell !== null, "the clamped piece must resolve to a cell"));


// 6i. Hover geometry reveals a visible move handle without adding a transparent wall band.
await test("v5_pointer_hit_test_drags_the_wall", "", `
  window.__plan.setModel(${SEED_PLAN});
  var P = window.__plan.plan;
  window.__plan.rebuildCells(P);
  var layer = document.querySelector(".v5layer");
  var hit = layer && layer.querySelector('.v5hit-wall[data-w="w1"]');
  var aptrooms = document.querySelectorAll("#canvas .aptroom").length;
  if(hit) return { err:"a transparent wall hit shape still covers the drawing surface", aptrooms: aptrooms };
  var w0 = P.walls.filter(function(x){ return x.id==="w1"; })[0];
  var s0 = window.__plan.aptToScreen((w0.a[0]+w0.b[0])/2,(w0.a[1]+w0.b[1])/2);
  var vr = document.getElementById("viewport").getBoundingClientRect();
  var cx = vr.left+s0.x, cy = vr.top+s0.y;
  function pe(t,x,y){ return new PointerEvent(t,{bubbles:true, clientX:x, clientY:y, button:0, pointerId:1, pointerType:"mouse"}); }
  // THE WALL'S BODY NO LONGER CAPTURES THE PRESS, and that is the point of the hover-handles
  // batch: a press on a wall falls through to DRAWING, so a new partition can start on top of an
  // existing one. Selecting and moving a wall is the job of its midpoint handle, which appears
  // when the wall is hovered. This case therefore states both halves of the rule instead of the
  // old single one: the body selects nothing, the handle selects and drags.
  document.getElementById("viewport").dispatchEvent(pe("pointermove", cx, cy));
  var corps = window.__plan.v5ui.selWall;
  var move = layer.querySelector('.v5wmove[data-w="w1"]');
  if(!move) return { err:"no move handle after hovering the wall", aptrooms: aptrooms };
  var rm = move.getBoundingClientRect();
  var mx = rm.left + rm.width/2, my = rm.top + rm.height/2;
  move.dispatchEvent(pe("pointerdown", mx, my));
  var sel = window.__plan.v5ui.selWall;
  window.dispatchEvent(pe("pointermove", mx+40, my));
  window.dispatchEvent(pe("pointerup",   mx+40, my));
  var w = P.walls.filter(function(x){ return x.id==="w1"; })[0];
  var ext = P.cells.map(function(c){
    var mn=1e9,mx=-1e9; c.poly.forEach(function(p){ if(p[0]<mn)mn=p[0]; if(p[0]>mx)mx=p[0]; });
    return {mn:mn,mx:mx};
  }).sort(function(a,b){ return a.mn-b.mn; });
  return { aptrooms: aptrooms, sel: sel, corps: corps, x: w.a[0], cells: P.cells.length, ext: ext };
`, v => expect(!v.err, v.err + " (aptrooms=" + v.aptrooms + ")")
     && expect(v.aptrooms === 0, "v5 must not build any .aptroom container, got " + v.aptrooms)
     && expect(!v.corps, "hovering the wall's BODY must select nothing, got " + v.corps)
     && expect(v.sel === "w1", "the pointerdown on the move handle must select the wall, got " + v.sel)
     && expect(v.x > 300 && v.x < 600, "the wall should have moved right, got x=" + v.x)
     && expect(v.cells === 2 && near(v.ext[0].mx, v.x, 0.5) && near(v.ext[1].mn, v.x, 0.5),
        "the two cells must follow the dragged boundary, got " + JSON.stringify(v.ext)));

// 6j. Furniture drags with the UNCHANGED v4 MECHANICS (startPieceDrag), on the v5 layer:
// apartment coordinates, no rehousing, cell clamp on release.
await test("v5_pointer_drag_furniture_on_layer", "", `
  window.__plan.setModel(${SEED_PLAN});
  var P = window.__plan.plan;
  window.__plan.rebuildCells(P);
  var p = window.__plan.addV5Piece("arm", 60, 60);
  var layer = document.querySelector(".v5layer");
  var el = layer && layer.querySelector('.piece[data-id="'+p.id+'"]');
  if(!el) return { err:"the piece was not rendered in the v5 layer" };
  var r = el.getBoundingClientRect();
  var cx = r.left + r.width/2, cy = r.top + r.height/2;
  function pe(t,x,y){ return new PointerEvent(t,{bubbles:true, clientX:x, clientY:y, button:0, pointerId:2}); }
  var x0 = p.x, y0 = p.y;
  el.dispatchEvent(pe("pointerdown", cx, cy));
  window.dispatchEvent(pe("pointermove", cx+60, cy+30));
  window.dispatchEvent(pe("pointerup",   cx+60, cy+30));
  var q = P.pieces.filter(function(z){ return String(z.id)===String(p.id); })[0];
  var cell = window.__plan.cellOf(q.x+q.w/2, q.y+q.h/2);
  return { x0:x0, y0:y0, x:q.x, y:q.y, n:P.pieces.length, sel:window.__plan.selId,
           cell: cell?cell.id:null };
`, v => expect(!v.err, v.err)
     && expect(v.n === 1, "the drag must not duplicate the piece, got " + v.n)
     && expect(v.x !== v.x0 || v.y !== v.y0, "the piece should have moved, still at " + v.x + "," + v.y)
     && expect(v.cell !== null, "the dropped piece must land inside a cell")
     && expect(String(v.sel) === "1" || v.sel != null, "the dragged piece stays selected"));


// =============================================================================
//  14. INSPECTOR: NO BUTTON THAT DOES NOTHING ON AN OPENING
// =============================================================================
await test("inspecteur_dup_et_devant_absents_sur_une_ouverture", seedV4(REAL_PLAN), `
  var op = window.__plan.plan.openings.filter(function(o){ return o.type==="window"; })[0]
        || window.__plan.plan.openings[0];
  var furn = window.__plan.plan.pieces[0];
  var onOpening = window.__plan.inspectorButtons(op.id);
  var dupClick = window.__plan.clickInspector("iDup");
  var frontClick = window.__plan.clickInspector("iFront");
  var onFurn = window.__plan.inspectorButtons(furn.id);
  var dupFurn = window.__plan.clickInspector("iDup");
  return { onOpening: onOpening, onFurn: onFurn, dupClick: dupClick, frontClick: frontClick,
           dupFurn: dupFurn };
`, v => expect(v.onOpening.dup.hidden === true && v.onOpening.front.hidden === true,
        "« Dupliquer » et « Devant » doivent être retirés sur une ouverture : " + JSON.stringify(v.onOpening))
     && expect(v.onOpening.del.hidden === false, "« Supprimer », lui, marche : il reste offert")
     && expect(v.dupClick.after.undo === v.dupClick.before.undo
        && v.dupClick.after.pieces === v.dupClick.before.pieces,
        "un clic forcé sur « Dupliquer » ne doit plus pousser d'historique vide : " + JSON.stringify(v.dupClick))
     && expect(v.frontClick.after.undo === v.frontClick.before.undo,
        "ni « Devant » : " + JSON.stringify(v.frontClick))
     && expect(v.onFurn.dup.hidden === false && v.onFurn.front.hidden === false,
        "sur un MEUBLE les deux boutons reviennent : " + JSON.stringify(v.onFurn))
     && expect(v.dupFurn.after.pieces === v.dupFurn.before.pieces + 1
        && v.dupFurn.after.undo === v.dupFurn.before.undo + 1,
        "et ils font toujours leur travail : " + JSON.stringify(v.dupFurn)));

// ---- verdict -----------------------------------------------------------------------------------
report();
