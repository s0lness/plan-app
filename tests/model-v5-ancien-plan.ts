#!/usr/bin/env node
// READING AN OLD PLAN (there's no more toggle: a single model), and the PERSONAL SETTINGS
// that cross neither through the wire nor through the fallback.
import type { DonneeDynamique } from "./_types.ts";
import { test, near, expect, seedV4, REAL_PLAN, SEED_PLAN, report } from "./_harness-v5.ts";

// =============================================================================
//  8. READING AN OLD PLAN (there's no more manual toggle: a single model)
// =============================================================================
// 8a. REPLACES "v5_migration_reports_then_switches" (the toggle modal no longer exists). What
// this case actually protected: the fixture plan, whose two old rooms OVERLAP (Salon /
// Piece 4, ~11.64 m2), still reads correctly, with no lost cell and no sliver.
// (11.64 = value coming from the fixture corpus after a uniform 1.37 similarity-scale
// transform; it is not the measurement of any real place.)
await test("v5_overlapping_old_rooms_still_convert", seedV4(REAL_PLAN), `
  var st = window.__plan.readLegacy(JSON.parse(localStorage.getItem("room-planner-v4-backup")));
  var overlaps = [];
  for(var i=0;i<st.rooms.length;i++) for(var j=i+1;j<st.rooms.length;j++){
    var ov = window.__plan.overlapArea(window.__plan.roomAptPoly(st.rooms[i]),
                                       window.__plan.roomAptPoly(st.rooms[j]));
    if(ov > 1000) overlaps.push({ a: st.rooms[i].name, b: st.rooms[j].name, m2: Math.round(ov/100)/100 });
  }
  var P = window.__plan.plan;
  var minCell = P.cells.reduce(function(m,c){ return Math.min(m, window.__plan.overlapArea(c.poly,c.poly)); }, 1e12);
  return { overlaps: overlaps, cells: P.cells.length,
           walls: P.walls.filter(function(w){ return !w.isOutline; }).length,
           openings: P.openings.length, pieces: P.pieces.length,
           minCell: Math.round(minCell),
           backupKey: !!localStorage.getItem("room-planner-v4-backup") };
`, v => expect(v.overlaps.length >= 1 && v.overlaps.some((o: DonneeDynamique) => near(o.m2, 11.64, 0.2)),
        "le chevauchement connu Salon / Pièce 4 (~11,64 m², corpus transformé, échelle x1.37) doit exister dans la source, got " + JSON.stringify(v.overlaps))
     && expect(v.cells === 10, "il doit rester 10 cellules malgré le chevauchement, got " + v.cells)
     && expect(v.walls === 13, "13 murs intérieurs, got " + v.walls)
     && expect(v.openings === 21 && v.pieces === 21, "21 ouvertures + 21 meubles, got " + v.openings + "/" + v.pieces)
     && expect(v.minCell >= 400, "aucune cellule éclat, plus petite = " + v.minCell + " cm²")
     && expect(v.backupKey === true, "le blob d'avant conversion doit être en sauvegarde"));

// 8b. REPLACES "v5_undo_crosses_the_migration_boundary" (there's no more boundary to cross):
// undo brings back the PREVIOUS geometry, and the screen stays the single layer.
await test("v5_undo_restores_the_previous_geometry", seedV4(REAL_PLAN), `
  var P = window.__plan.plan;
  var wall = P.walls.filter(function(w){ return !w.isOutline; })[0];
  var before = { id: wall.id, a: wall.a.slice(), cells: P.cells.length };
  window.__plan.pushHistory();
  window.__plan.moveWall(wall.id, 25);
  var moved = window.__plan.plan.walls.filter(function(w){ return w.id===before.id; })[0].a.slice();
  window.__plan.undo();
  var Q = window.__plan.plan;
  var back = Q.walls.filter(function(w){ return w.id===before.id; })[0];
  return { before: before, moved: moved, back: back ? back.a : null,
           cells: Q.cells.length,
           layer: document.querySelectorAll(".v5layer").length,
           aptrooms: document.querySelectorAll("#canvas .aptroom").length,
           canvasV5: document.getElementById("canvas").classList.contains("v5"),
           keys: Object.keys(window.__plan.serialize()).sort().join(",") };
`, v => expect(v.moved && (v.moved[0] !== v.before.a[0] || v.moved[1] !== v.before.a[1]),
        "le mur doit avoir bougé, got " + JSON.stringify(v.moved))
     && expect(v.back && near(v.back[0], v.before.a[0], 0.6) && near(v.back[1], v.before.a[1], 0.6),
        "annuler doit rendre la position d'origine, got " + JSON.stringify(v.back))
     && expect(v.cells === v.before.cells, "le nombre de cellules doit revenir, got " + v.cells)
     && expect(v.layer === 1 && v.aptrooms === 0 && v.canvasV5 === true, "l'écran reste le calque unique")
     && expect(v.keys === "cells,model,openings,outline,pieces,plan,setupDone,walls",
        "la charge utile reste murs-seuls, got " + v.keys));

// =============================================================================
//  WALL-MOUNTED OBJECTS IN PURE APARTMENT SPACE (no notion of room)
// =============================================================================

// 7a. PLACEMENT: the cursor gives an apartment point, we look for the nearest wall among ALL
// the walls in state.plan.walls, we create a parametric opening (wallId + t0). Out of reach:
// explicit refusal, nothing created, nothing to undo.
await test("v5_wallmount_place_is_apartment_space", "", `
  window.__plan.setModel(${SEED_PLAN});
  var P = window.__plan.plan;
  window.__plan.rebuildCells(P);
  var n0 = P.openings.length;
  // near the w1 partition (x=300), LEFT side: the sconce must face the left-hand cell
  var a = window.__plan.v5PlaceAt("sconce", 288, 200);
  var poseA = a ? window.__plan.v5OpeningPose(a.id) : null;
  // very far from anything: refusal
  window.__plan.clearToast();
  var far = window.__plan.placeWallMountAt("sconce", 5000, 5000);
  var n1 = P.openings.length;
  return { n0:n0, n1:n1, a:a, poseA:poseA, far:far,
           reach:+window.__plan.wallSnapReach().toFixed(1),
           previewFar: window.__plan.wallMountPreviewApt("sconce", 5000, 5000, window.__plan.wallSnapReach()) };
`, v => expect(v.a && v.a.wallId === "w1", "the sconce must land on the nearest wall w1, got " + JSON.stringify(v.a))
     && expect(v.poseA && v.poseA.onWall < 0.6, "it must sit ON the wall, dist=" + (v.poseA && v.poseA.onWall))
     && expect(v.poseA && v.poseA.facesCell, "its +y must point into a cell, got " + JSON.stringify(v.poseA))
     && expect(v.n1 === v.n0 + 1, "exactly one opening created (refused drop adds nothing), got " + v.n0 + " -> " + v.n1)
     && expect(v.far.placed === false, "a drop far from every wall must create nothing")
     && expect(typeof v.far.toast === "string" && /wall/i.test(v.far.toast), "a French toast must explain, got " + JSON.stringify(v.far.toast))
     && expect(v.previewFar === null, "the preview must report 'no wall' out of reach"));

// 7b. DRAGGING: along the wall, then JUMPING onto a perpendicular wall, then moving to the OTHER
// FACE of the same wall (the object flips). No notion of membership: just wallId/t0/side.
await test("v5_wallmount_drag_jumps_walls_and_flips", "", `
  window.__plan.setModel(${SEED_PLAN});
  var P = window.__plan.plan;
  window.__plan.rebuildCells(P);
  var op = window.__plan.v5PlaceAt("sconce", 288, 120);     // partition w1, left face
  var p1 = window.__plan.v5OpeningPose(op.id);
  window.__plan.dragOpeningTo(op.id, 288, 320);             // slides along w1
  var p2 = window.__plan.v5OpeningPose(op.id);
  window.__plan.dragOpeningTo(op.id, 150, 392);             // jumps onto the BOTTOM facade (wb)
  var p3 = window.__plan.v5OpeningPose(op.id);
  window.__plan.dragOpeningTo(op.id, 312, 320);             // back on w1, RIGHT face this time
  var p4 = window.__plan.v5OpeningPose(op.id);
  return { p1:p1, p2:p2, p3:p3, p4:p4, cells:P.cells.length };
`, v => expect(v.p1.wallId === "w1" && v.p2.wallId === "w1" && Math.abs(v.p2.t0 - v.p1.t0) > 100,
        "sliding along the wall must only move t0: " + v.p1.t0 + " -> " + v.p2.t0)
     && expect(v.p3.wallId === "wb", "it must jump onto the perpendicular wall wb, got " + v.p3.wallId)
     && expect(v.p3.onWall < 0.6 && !!v.p3.facesCell, "still stuck + facing a cell after the jump: " + JSON.stringify(v.p3))
     && expect(Math.abs((((v.p3.rot - v.p2.rot) % 180) + 180) % 180 - 90) < 1,
        "a perpendicular wall means a 90 degrees turn: " + v.p2.rot + " -> " + v.p3.rot)
     && expect(v.p4.wallId === "w1" && v.p4.side !== v.p1.side,
        "back on w1 from the other side, `side` must flip: " + v.p1.side + " -> " + v.p4.side)
     && expect(Math.abs((((v.p4.rot - v.p2.rot) % 360) + 360) % 360 - 180) < 1,
        "the other face means a 180 degrees flip: " + v.p2.rot + " -> " + v.p4.rot)
     && expect(v.p4.facesCell === v.p2.backCell,
        "it must now face the cell that was behind it: faces " + v.p4.facesCell + ", was backing " + v.p2.backCell));

// 7c. The "blank page" sentinel used to count rooms and look for containers that no longer
// exist: it screamed on every tick over a perfectly painted plan (and relaunched a full fitView
// every 3 s). It now checks the single layer and must stay quiet on a healthy plan.
await test("v5_white_page_sentinel_is_quiet", seedV4(REAL_PLAN), `
  try{ localStorage.removeItem("plan-errors"); }catch(e){}
  window.__forceSentinel("test");
  window.__forceSentinel("test2");
  var errs = [];
  try{ errs = JSON.parse(localStorage.getItem("plan-errors")||"[]")||[]; }catch(e){}
  return { model: window.__plan.model, layer: document.querySelectorAll("#canvas .v5layer").length,
           aptrooms: document.querySelectorAll("#canvas .aptroom").length,
           sentinel: errs.filter(function(e){ return /sentinel/.test(e.msg||""); }).length };
`, v => expect(v.model === "v5" && v.layer === 1 && v.aptrooms === 0, "expected a painted v5 layer, got " + JSON.stringify(v))
     && expect(v.sentinel === 0, "the sentinel must stay quiet on a healthy v5 plan, got " + v.sentinel + " alert(s)"));

// 7d. SIDE OF THE WALL, parity with v4. The three entry points (placement, dragging,
// button/key) give the same result: the side is the one from the GESTURE. In v5 it lives in
// `side`, in v4 in `rot`, with no duplicated code visible to the user (same button, same key,
// same label).
await test("v5_wallmount_side_is_the_cursor_side", "", `
  window.__plan.setModel(${SEED_PLAN});
  var P = window.__plan.plan;
  window.__plan.rebuildCells(P);
  // interior partition w1 (x=300), one cell on EACH side: the cursor decides.
  var a = window.__plan.v5PlaceAt("sconce", 288, 120);   // cursor to the LEFT of the wall
  var pa = window.__plan.v5OpeningPose(a.id);
  var b = window.__plan.v5PlaceAt("sconce", 312, 300);   // cursor to the RIGHT of the same wall
  var pb = window.__plan.v5OpeningPose(b.id);
  // and on a FACADE (only one adjacent cell): the habitable face is forced, wherever you aim
  var c = window.__plan.v5PlaceAt("sconce", 150, 406);   // cursor OUTSIDE, below the bottom facade
  var pc = window.__plan.v5OpeningPose(c.id);
  return { aWall:pa.wallId, aSide:pa.side, aFaces:pa.facesCell, aRot:pa.rot,
           bWall:pb.wallId, bSide:pb.side, bFaces:pb.facesCell, bRot:pb.rot,
           cWall:pc.wallId, cFaces:pc.facesCell, cBack:pc.backCell,
           delta:(((pa.rot - pb.rot) % 360) + 360) % 360 };
`, v => expect(v.aWall === "w1" && v.bWall === "w1", "both must land on the interior wall w1, got " + v.aWall + " / " + v.bWall)
     && expect(v.aSide !== v.bSide, "posed from either side of the wall, `side` must differ: " + v.aSide + " / " + v.bSide)
     && expect(v.aFaces && v.bFaces && v.aFaces !== v.bFaces,
        "each must face the cell the cursor was in, got " + v.aFaces + " / " + v.bFaces)
     && expect(v.delta === 180, "the two faces of a wall are 180 degrees apart, got " + v.delta)
     && expect(!!v.cFaces && !v.cBack, "on a facade the habitable face is forced, got faces=" + v.cFaces + " back=" + v.cBack));

await test("v5_wallmount_flip_side_control", "", `
  window.__plan.setModel(${SEED_PLAN});
  var P = window.__plan.plan;
  window.__plan.rebuildCells(P);
  var op = window.__plan.v5PlaceAt("sconce", 288, 120);
  var p0 = window.__plan.v5OpeningPose(op.id);
  var clicked = window.__plan.clickFlipSide(op.id);
  var label = (function(){ var b=document.getElementById("iSide"); return b?b.textContent:null; })();
  var p1 = window.__plan.v5OpeningPose(op.id);
  window.__plan.pressFlipSide(op.id);                    // R key
  var p2 = window.__plan.v5OpeningPose(op.id);
  // a door doesn't have this button: hinge + direction remain its only control
  var d = window.__plan.v5PlaceAt("door", 288, 200);
  var doorBtn = window.__plan.clickFlipSide(d.id);
  return { clicked:clicked.clicked, label:label,
           s0:p0.side, s1:p1.side, s2:p2.side,
           f0:p0.facesCell, f1:p1.facesCell, f2:p2.facesCell, b0:p0.backCell,
           d01:(((p1.rot - p0.rot) % 360) + 360) % 360,
           doorClicked:doorBtn.clicked, doorHidden:doorBtn.hidden };
`, v => expect(v.clicked === true, "the flip button must be visible + enabled on a v5 sconce")
     && expect(v.label === "Flip side", "same French label as v4, got " + JSON.stringify(v.label))
     && expect(v.s1 !== v.s0 && v.d01 === 180, "the button must act on `side` (180 degrees), got side " + v.s0 + " -> " + v.s1)
     && expect(v.f1 === v.b0, "it must now face the cell that was behind it, got " + v.f1 + " vs " + v.b0)
     && expect(v.s2 === v.s0 && v.f2 === v.f0, "the R key must flip it back, got side " + v.s1 + " -> " + v.s2)
     && expect(v.doorClicked === false && v.doorHidden === true, "a door must NOT get the flip button"));


// =============================================================================
//  12. PERSONAL SETTINGS: they cross NEITHER one way, NOR the other
// =============================================================================
// Real scenario: one household member unchecks "Lighting" to see clearly, the other reloads,
// their sconces have vanished. The Circulation panel would open and close on its own from one
// person to the other.

// 12a. a plan received from the server (realtime wire, `hello` message) can no longer set a
// setting.
await test("opts_un_plan_serveur_n_ecrase_aucun_reglage_local", seedV4(REAL_PLAN), `
  // This household member has THEIR OWN settings: sconces hidden, Circulation panel closed, labels off.
  window.__plan.setLayer("light", false);
  document.getElementById("optLabels").checked = false;
  document.getElementById("optLabels").dispatchEvent(new Event("change", {bubbles:true}));
  var mine = window.__plan.opts();
  // The other member has turned everything on and the panel open: their plan arrives with THEIR OWN options.
  var wire = window.__plan.wire();
  wire.opts = { layLight:true, layPlug:false, layFurn:true, labels:true, flow:true, overlay:true,
                snap:false, collapsedCats:["Salon"], tvIn:75 };
  wire.cells[0].name = "Vient de Device A";
  window.__plan.wsFeed({ t:"hello", you:{email:"b@example.com"}, peers:[], rev:9, fp:"fp-a",
                         state:wire, chat:[] });
  var after = window.__plan.opts();
  return { adopted: window.__plan.plan.cells[0].name,
           before: {light:mine.layLight, labels:mine.labels, flow:mine.flow, cats:mine.collapsedCats.length},
           after: {light:after.layLight, labels:after.labels, flow:after.flow, plug:after.layPlug,
                   snap:after.snap, tv:after.tvIn, cats:after.collapsedCats.length},
           boxLight: document.getElementById("optLayLight").checked,
           boxLabels: document.getElementById("optLabels").checked,
           panel: !document.getElementById("flowpanel").hidden };
`, v => expect(v.adopted === "Vient de Device A", "le PLAN, lui, doit bien être adopté : " + v.adopted)
     && expect(v.after.light === false && v.boxLight === false,
        "« Luminaires » doit rester décoché : " + JSON.stringify(v.after) + " case=" + v.boxLight)
     && expect(v.after.labels === false && v.boxLabels === false, "les étiquettes doivent rester coupées")
     && expect(v.after.flow === false && v.panel === false, "le panneau Circulation ne doit pas s'ouvrir tout seul")
     && expect(v.after.plug === true && v.after.snap === true && v.after.tv == null && v.after.cats === 0,
        "aucune option reçue ne doit passer : " + JSON.stringify(v.after)));

// 12b. reverse direction: nothing personal goes out to the household, neither through the wire,
// nor through the D1 fallback.
await test("opts_ne_partent_ni_par_le_fil_ni_par_le_repli", seedV4(REAL_PLAN), `
  window.__plan.setLayer("light", false);
  window.__plan.save();
  var ser = window.__plan.serialize();      // body of the D1 PUT AND the content of an export
  var wire = window.__plan.wire();          // realtime wire
  var stored = JSON.parse(localStorage.getItem("room-planner-v4"));
  return { serHasOpts: window.__plan.serializedHasOpts(),
           serText: JSON.stringify(ser).indexOf("layLight"),
           wireHasOpts: ("opts" in wire),
           storedHasOpts: ("opts" in stored),
           // the setting itself IS saved: in ITS OWN key, on this device
           own: window.__plan.storedOpts() };
`, v => expect(v.serHasOpts === false && v.serText < 0, "le corps du PUT ne doit plus porter d'options")
     && expect(v.wireHasOpts === false, "le fil temps réel n'a jamais porté d'options, et ne le fait toujours pas")
     && expect(v.storedHasOpts === false, "le plan enregistré localement ne mélange plus plan et réglages")
     && expect(v.own && v.own.layLight === false,
        "le réglage doit vivre dans sa propre clé : " + JSON.stringify(v.own)));

// 12c. migration: options that used to live INSIDE the saved plan are recovered on first
// startup (otherwise the switch would silently erase settings already set).
await test("opts_migration_depuis_l_ancien_blob", seedV4(Object.assign({}, REAL_PLAN,
  { opts: { layLight: false, labels: false, snap: false, collapsedCats: ["Chambre"], tvIn: 55 } })), `
  var o = window.__plan.opts();
  return { light:o.layLight, labels:o.labels, snap:o.snap, cats:o.collapsedCats, tv:o.tvIn,
           box: document.getElementById("optLayLight").checked,
           stored: window.__plan.storedOpts() };
`, v => expect(v.light === false && v.labels === false && v.snap === false,
        "les options du plan enregistré doivent être reprises : " + JSON.stringify(v))
     && expect(v.tv === 55 && JSON.stringify(v.cats) === JSON.stringify(["Chambre"]),
        "y compris tvIn et les catégories repliées")
     && expect(v.box === false, "l'IHM doit refléter le réglage repris")
     && expect(v.stored && v.stored.layLight === false, "et ils doivent être recopiés dans leur clé à eux"));

// 12d. the personal key ALWAYS wins over what an old saved plan still carries.
await test("opts_la_cle_personnelle_gagne_sur_le_plan", `
  try{ localStorage.setItem("room-planner-opts", JSON.stringify({layLight:true, labels:true})); }catch(e){}
  ` + seedV4(Object.assign({}, REAL_PLAN, { opts: { layLight: false, labels: false } })), `
  var o = window.__plan.opts();
  return { light:o.layLight, labels:o.labels };
`, v => expect(v.light === true && v.labels === true,
        "la clé personnelle doit gagner : " + JSON.stringify(v)));

// ---- verdict -----------------------------------------------------------------------------------
report();
