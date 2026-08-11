// src/ts/circulation/regles.ts — PORTED VERBATIM from src/js/36-flow-regles.js (391 lines).
// ELEVEN RULES MADE RIGHT, no type defect in their history. No threshold, no message,
// no finding identifier moves (`unreach_room_*` is asserted by tests/rapide.ts).

import type { Meuble, Ouverture, Pt } from "../partage/plan.ts";
import type {
  AABB, Constat, Grille, GrilleGlobale, ObjetFlow, Rect, ResultatAnalyse, SurlignagePinch,
} from "./etat.ts";
import { FL, scoreFromFindings } from "./etat.ts";
import { escapeHtml } from "../noyau/nombres.ts";
import { TYPEMAP, empilables } from "../catalogue/catalogue.ts";
import { bboxOfPoly, nearestOnPoly, pointInPoly, polyArea } from "../geometrie/polygones.ts";
import { pieceById, v5OpeningById } from "../app/contexte.ts";
import {
  PRIMARY_SEAT, allOf, buildAptContext, cellIndexAt, doorPassage, fcCells, fcPieces, frontNormal,
  isBlocker, norm, pieceAABB, rectGap, rectsOverlap,
} from "./contexte.ts";
import {
  buildGrid, cellCenterCm, clearanceField, doorApproach, nearestFreeCell, pathBottleneck,
  reconstruct, widestPath,
} from "./grille.ts";
import type { Goulet } from "./grille.ts";
import {
  faceToward, moveCoffeeToDist, nudgeAway, pullSofaIn, resizeRugToSofa, slideRugUnderSofa,
} from "./correctifs.ts";

// =====================================================================
//  RULES — ONE pass over the whole apartment
// =====================================================================
// `FL.flowCtx` is set by analyzeApt(): every cell and every object, in apartment cm.
// The GLOBAL rules (grid, clearances, reachability of each cell, pinch points) run
// once; the COMFORT rules (sofa / coffee table / dining table / TV / rug / window /
// walls) run PER CELL and are poured into the same list, the cell's name woven into
// the finding's French text. A SINGLE score.
//
// `detail` goes out as innerHTML (js/38) because it carries <b>: every object or cell NAME
// inserted into it is escaped (escapeHtml, js/00), otherwise a piece of furniture named "<b>x</b>" writes into
// the Circulation panel.
function runRules(): ResultatAnalyse {
  const F: Constat[] = [];
  const grid: GrilleGlobale = { g: null, clear: null, routes: [], pinches: [] };
  const cells = fcCells();
  const doors = allOf(["door", "sdoor"]);       // sources: every door/porte coulissante
  const g = buildGrid();
  const clear = clearanceField(g);
  grid.g = g; grid.clear = clear;

  const push = (f: Constat | null | undefined): void => { if (f) F.push(f); };
  const RND = Math.round;
  const multi = cells.length > 1;
  // "(Living room)" suffix when the finding targets ONE cell, and only if there's more than one
  const inCell = (name: string | undefined): string => multi && name ? ` (${escapeHtml(name)})` : "";
  const ofCell = (name: string | undefined): string => multi && name ? ` de ${escapeHtml(name)}` : "";

  // The FRONT DOOR is a door set on a FACADE wall (a wall of the outline).
  // Before: `hasEnv = !!fcEnv()`, always true (fcEnv never returns anything falsy), and
  // "d.ci === 'env'", that is to say "the door's center is in no cell". That
  // center is on the median line of its wall, hence on a boundary: the answer depended on which side
  // of the apartment it was on. A front door on the left or top facade was NOT recognized,
  // so the rule would cry "no front door" when it was right there, and reachability
  // would fall back to every door instead of the entrance. The facade wall, though, is a fact.
  const frontDoors = doors.filter((d) => d.onOutline);

  // Rule 1: no doors at all
  if (doors.length === 0) {
    push({
      id: "nodoor", severity: "tip", title: "No door placed",
      detail: "Add a Door on a wall to check that the circulation paths really cross the flat.", targets: [],
    });
  }
  // Rule 1b: there are doors, but none on a facade. Nobody enters this home,
  // so the reachability of each room is then judged from any door, for lack of anything better.
  else if (frontDoors.length === 0) {
    push({
      id: "nofrontdoor", severity: "tip", title: "No front door on a facade",
      detail: "Place a Door on a facade wall to define the entrance: rooms are judged reachable from it.", targets: [],
    });
  }

  // ---- approach to each door: a free cell right inside the cell it opens onto ----
  const approaches = doors.map((d) => ({ d, idx: doorApproach(g, d) })).filter((o) => o.idx >= 0);
  // widest-path field from EVERY door, unioned: a cell is "reachable from the entry network" if
  // any door reaches it. Also keep per-door fields for pinch reconstruction.
  const fields = approaches.map((a) => ({ a, ...widestPath(g, clear, a.idx) }));
  // Reachability sources: from the FRONT DOOR when one exists, else from any door (as before).
  const reachFields = (frontDoors.length)
    ? fields.filter((f) => f.a.d.onOutline)
    : fields;

  // Rule 2: blocked door swing (hinged doors only — a pocket/sliding door has no swing)
  doors.filter((d) => d.type === "door").forEach((door) => {
    const db = pieceAABB(door);
    const dw = door.w;
    const pa = doorPassage(door);
    const half = Math.max(db.x1 - db.x0, db.y1 - db.y0) / 2;
    // swing band = dw deep on the side the door actually OPENS (door.swing), along its span.
    // doorPassage nx,ny = local +y = the interior side (matches arc default swing=+1); swing=-1 flips
    // the band to the exterior/corridor side so an outward door flags an obstacle in its real arc.
    // `swing` can be absent: `undefined < 0` is false, exactly as in js/36. The
    // cast changes NOTHING about the execution, it only makes the comparison compile.
    const sgn = ((door.swing as number) < 0) ? -1 : 1;
    const fx = pa.nx * sgn, fy = pa.ny * sgn;
    // axis-aligned approximation of the oriented band (doors are axis-aligned on walls)
    const zone: Rect = {
      x0: Math.min(db.cx, db.cx + fx * dw) - Math.abs(pa.ux) * half,
      x1: Math.max(db.cx, db.cx + fx * dw) + Math.abs(pa.ux) * half,
      y0: Math.min(db.cy, db.cy + fy * dw) - Math.abs(pa.uy) * half,
      y1: Math.max(db.cy, db.cy + fy * dw) + Math.abs(pa.uy) * half,
    };
    for (const p of fcPieces()) {
      if (!isBlocker(p)) continue;
      const b = pieceAABB(p);
      if (rectsOverlap(zone, b)) {
        const pid = p.id, did = door.id;
        push({
          id: "swing_" + door.id + "_" + p.id, severity: "error", title: "Door swing blocked",
          detail: `${escapeHtml(p.name)}${inCell(p.cellName)} is in the way of ${escapeHtml(door.name)}.`, targets: [door.id, p.id],
          highlight: { type: "rect", rect: zone },
          fix: { label: "Clear it", apply: () => nudgeAway(realPieceById(pid) as Meuble, zone, realPieceById(did) as Meuble) },
        });
        break;
      }
    }
  });

  // Rule 3: every CELL must be reachable from the door network. When a front door
  // exists, "the entrance" designates it; otherwise any door.
  // A cell is reachable if a free cell at its interior center is reached.
  if (reachFields.length) {
    const fromWho = frontDoors.length ? "the front door" : "the entrance";
    cells.forEach((cl) => {
      const c = polyCentroidFree(g, cl.poly);
      if (c < 0) return;                                   // no free interior cell (fully furnished)
      let reached = false;
      for (const f of reachFields) { if (f.best[c]! >= 0) { reached = true; break; } }
      if (!reached) {
        const cc = cellCenterCm(g, c);
        push({
          id: "unreach_room_" + cl.ci, severity: "error", title: "Room unreachable",   // frozen id: asserted by tests/rapide.ts
          detail: `${multi ? escapeHtml(cl.name) : "The room"} cannot be reached from ${fromWho}: no clear path leads there.`,
          targets: [], highlight: { type: "point", x: cc.x, y: cc.y },
        });
      }
    });
  }

  // ---- destinations to serve (route tracing + pinch points between cells) ----
  // Seating groups (per cell), dining tables, worktop (sink/hob). We trace the
  // widest path from the nearest door, flagging any pinch points encountered.
  const dests: Array<{ kind: string; name: string; x: number; y: number; label: string }> = [];
  cells.forEach((cl) => {
    const cellPieces = fcPieces().filter((p) => p.ci === cl.ci);
    const seats = cellPieces.filter((p) => PRIMARY_SEAT.has(p.type));
    if (seats.length) {
      let sx = 0, sy = 0; seats.forEach((p) => { const b = pieceAABB(p); sx += b.cx; sy += b.cy; });
      dests.push({ kind: "seat", name: cl.name, x: sx / seats.length, y: sy / seats.length, label: "the seating" + ofCell(cl.name) });
    }
    const dn = cellPieces.find((p) => p.type === "dining");
    if (dn) { const b = pieceAABB(dn); dests.push({ kind: "dining", name: cl.name, x: b.cx, y: b.cy, label: "the dining table" + ofCell(cl.name) }); }
    const work = cellPieces.filter((p) => p.type === "sink" || p.type === "hob");
    if (work.length) {
      let wx = 0, wy = 0; work.forEach((p) => { const b = pieceAABB(p); wx += b.cx; wy += b.cy; });
      dests.push({ kind: "kitchen", name: cl.name, x: wx / work.length, y: wy / work.length, label: "the worktop" + ofCell(cl.name) });
    }
  });
  if (fields.length) {
    dests.forEach((dst) => {
      const tc = nearestFreeCell(g, dst.x, dst.y); if (tc < 0) return;
      // pick the door field that reaches this destination the widest
      let bf: (typeof fields)[number] | null = null;
      for (const f of fields) { if (f.best[tc]! >= 0 && (!bf || f.best[tc]! > bf.best[tc]!)) bf = f; }
      if (!bf) {
        push({
          id: "noreach_" + dst.kind + "_" + dst.name, severity: "error", title: "Destination inaccessible",
          detail: `No clear path leads to ${dst.label}.`, targets: [], highlight: { type: "point", x: dst.x, y: dst.y },
        });
        return;
      }
      const path = reconstruct(bf.prev, bf.a.idx, tc);
      const pin = pathBottleneck(g, clear, path);
      grid.routes.push(path);
      addPinchFinding(F, pin, bf.a.d, dst.label, g);
    });
  }

  // ---- COMFORT rules, per cell (same thresholds; the cell's name enters the text) ----
  cells.forEach((cl) => {
    const cn = cl.name;
    const cellPieces = fcPieces().filter((p) => p.ci === cl.ci);
    const areaM2 = polyArea(cl.poly) / 10000;
    const windows = cellPieces.filter((p) => p.type === "window");
    const seats = cellPieces.filter((p) => PRIMARY_SEAT.has(p.type));
    const blockers = cellPieces.filter(isBlocker);
    const first = (t: string): ObjetFlow | undefined => cellPieces.find((p) => p.type === t);
    let sofa: ObjetFlow | null = null, ba = -1;
    for (const p of cellPieces) { if (PRIMARY_SEAT.has(p.type)) { const a = p.w * p.h; if (a > ba) { ba = a; sofa = p; } } }
    const coffee = first("coffee"), dining = first("dining"), rug = first("rug"), tv = first("tv");

    // Rule 4: sofa <-> coffee distance
    if (sofa && coffee) {
      const gap = rectGap(pieceAABB(sofa), pieceAABB(coffee));
      const sid = sofa.id, cid = coffee.id;
      const fixDist = (): void => moveCoffeeToDist(realPieceById(sid) as Meuble, realPieceById(cid) as Meuble, 40);
      if (gap < 30) {
        push({
          id: "coffee_close_" + cl.ci, severity: "tip", title: "Coffee table too close",
          detail: `Only <b>${RND(gap)}cm</b> between the sofa and the coffee table${inCell(cn)}; aim for ~40cm.`, targets: [sofa.id, coffee.id],
          highlight: { type: "gap", a: sofa, b: coffee }, fix: { label: "Space to 40cm", apply: fixDist },
        });
      } else if (gap > 45) {
        push({
          id: "coffee_far_" + cl.ci, severity: "tip", title: "Coffee table too far",
          detail: `<b>${RND(gap)}cm</b> to the coffee table${inCell(cn)}; 35–45cm is comfortable reach.`, targets: [sofa.id, coffee.id],
          highlight: { type: "gap", a: sofa, b: coffee }, fix: { label: "Space to 40cm", apply: fixDist },
        });
      }
    }
    // Rule 5: coffee table walk-around
    if (coffee) {
      const sides = sideClearances(pieceAABB(coffee), coffee.id);
      const openSides = Object.values(sides).filter((v) => v >= 30).length;
      if (openSides < 2) {
        push({
          id: "coffee_loop_" + cl.ci, severity: "tip", title: "Little room around the coffee table",
          detail: `Hard to walk around the coffee table${inCell(cn)}: only ${openSides} side${openSides === 1 ? "" : "s"} with 30cm+ of clearance.`, targets: [coffee.id],
        });
      }
    }
    // Rule 6: rug under seating
    if (rug && sofa) {
      const rb = pieceAABB(rug), sb = pieceAABB(sofa);
      const rugW = rb.x1 - rb.x0, sofaW = sb.x1 - sb.x0;
      const rid = rug.id, sid = sofa.id;
      if (rugW < sofaW - 1) {
        push({
          id: "rug_narrow_" + cl.ci, severity: "warn", title: "Rug narrower than the sofa",
          detail: `The rug${inCell(cn)} is <b>${RND(rugW)}cm</b> against <b>${RND(sofaW)}cm</b> for the sofa; widen it to at least the width of the sofa.`, targets: [rug.id, sofa.id],
          fix: { label: "Widen the rug", apply: () => resizeRugToSofa(realPieceById(rid) as Meuble, realPieceById(sid) as Meuble) },
        });
      }
      if (!rectsOverlap(rb, sb)) {
        push({
          id: "rug_off_" + cl.ci, severity: "tip", title: "Rug not under the seating",
          detail: `The rug${inCell(cn)} is not under the seating; slide it so the front feet of the sofa rest on it.`, targets: [rug.id, sofa.id],
          fix: { label: "Slide it under the sofa", apply: () => slideRugUnderSofa(realPieceById(rid) as Meuble, realPieceById(sid) as Meuble) },
        });
      }
    }
    // Rule 6bis: TWO OBJECTS IN THE SAME PLACE.
    //
    // Nothing in the model forbids two pieces of furniture from overlapping, and that's deliberate: you place
    // fast, you tidy up after, and a plan that refuses an intermediate placement is a plan you
    // fight. But an overlap that STAYS is almost always an oversight, and it wasn't visible
    // anywhere: two stacked objects read as one at working zoom.
    //
    // THREE EXEMPTIONS, AND NONE IS ARBITRARY:
    //   · STACKABLE pairs (the dryer on the washing machine): same floor footprint, that's the
    //     intended storage, not a mistake;
    //   · SOFT objects (rugs): they pass UNDER furniture, that's their very function;
    //   · what isn't an obstacle (sconces, outlets, ceiling lights): they're up high.
    // A graze is also tolerated: two objects touching by 3 cm are placed side by side.
    {
      const FROLEMENT = 3;   // cm: below this, it's contact, not stacking
      const solides = cellPieces.filter((p) => isBlocker(p) && !(TYPEMAP[p.type] || {}).soft);
      for (let i = 0; i < solides.length; i++) {
        for (let j = i + 1; j < solides.length; j++) {
          const A = solides[i]!, B = solides[j]!;
          if (empilables(A.type, B.type)) continue;
          const ab = pieceAABB(A), bb = pieceAABB(B);
          const ox = Math.min(ab.x1, bb.x1) - Math.max(ab.x0, bb.x0);
          const oy = Math.min(ab.y1, bb.y1) - Math.max(ab.y0, bb.y0);
          if (ox <= FROLEMENT || oy <= FROLEMENT) continue;
          push({
            id: "overlap_" + A.id + "_" + B.id, severity: "warn", title: "Two objects in the same place",
            detail: `${escapeHtml(A.name)} and ${escapeHtml(B.name)} overlap by <b>${RND(Math.min(ox, oy))}cm</b>${inCell(cn)}.`,
            targets: [A.id, B.id],
          });
        }
      }
    }
    // Rule 7: hugging the walls
    if (areaM2 > 11 && blockers.length) {
      const touching = blockers.filter((p) => nearWall(pieceAABB(p), 5)).length;
      const anyFloating = seats.some((p) => !nearWall(pieceAABB(p), 5));
      if (touching / blockers.length > 0.75 && !anyFloating && sofa) {
        const sid = sofa.id;
        push({
          id: "walls_" + cl.ci, severity: "tip", title: "Everything is pushed against the walls",
          detail: `Everything is pushed against the walls${inCell(cn)}. Pull the sofa (and an armchair) in by ~30–50cm to make a conversation corner.`, targets: [sofa.id],
          fix: { label: "Pull the sofa in", apply: () => pullSofaIn(realPieceById(sid) as Meuble, 40) },
        });
      }
    }
    // Rule 8: sofa faces a blank wall
    if (sofa && (tv || windows.length)) {
      const fn = frontNormal(sofa); const sb = pieceAABB(sofa);
      const targets: ObjetFlow[] = []; if (tv) targets.push(tv); windows.forEach((w) => targets.push(w));
      let facesOne = false, nearest: ObjetFlow | null = null, nd = Infinity;
      for (const t of targets) {
        const tb = pieceAABB(t);
        const dir = norm({ x: tb.cx - sb.cx, y: tb.cy - sb.cy });
        if (dir.x * fn.x + dir.y * fn.y > 0.5) facesOne = true;
        const dist = Math.hypot(tb.cx - sb.cx, tb.cy - sb.cy);
        if (dist < nd) { nd = dist; nearest = t; }
      }
      if (!facesOne && nearest) {
        const what = nearest.type === "tv" ? "the TV" : "the window";
        const sid = sofa.id, nid = nearest.id;
        push({
          id: "facewall_" + cl.ci, severity: "tip", title: "The sofa faces a blank wall",
          detail: `The sofa${inCell(cn)} faces a blank wall. Turn it towards ${what} to give it a focal point.`, targets: [sofa.id, nearest.id],
          fix: { label: `Face ${what}`, apply: () => faceToward(realPieceById(sid) as Meuble, realPieceById(nid) as Meuble) },
        });
      }
    }
    // Rule 9: dining pull-out
    if (dining) {
      const sides = sideClearances(pieceAABB(dining), dining.id);
      const names: Degagements<string> = { top: "top side", bottom: "bottom side", left: "left side", right: "right side" };
      let worst: { k: CoteDegagement; v: number } | null = null;
      // `for…in` over an object literal and `Object.keys` give the SAME order (top, bottom,
      // left, right): the worst side in case of a tie thus stays the same as in js/36.
      for (const k of Object.keys(sides) as CoteDegagement[]) { if (sides[k] < 75 && (!worst || sides[k] < worst.v)) worst = { k, v: sides[k] }; }
      if (worst) {
        push({
          id: "dining_" + cl.ci + "_" + worst.k, severity: "warn", title: "Tight clearance at the dining table",
          detail: `Only <b>${RND(worst.v)}cm</b> behind the ${names[worst.k]} of the dining table${inCell(cn)}; ~90cm is needed to push a chair back and walk past.`, targets: [dining.id],
        });
      }
    }
    // Rule 10: window blocked by tall storage
    if (windows.length) {
      const tallSet = new Set(["shelf", "biblio", "sideb", "tv", "bed", "fridge", "oven", "armoire", "placard", "langer"]);
      windows.forEach((win) => {
        const wb = pieceAABB(win); const cx = wb.cx, cy = wb.cy;
        const rbb = bboxOfPoly(cl.poly);
        const dl = cx - rbb.minX, dr = rbb.maxX - cx, dt = cy - rbb.minY, dbm = rbb.maxY - cy, m = Math.min(dl, dr, dt, dbm);
        const band = 40, half = Math.max(wb.x1 - wb.x0, wb.y1 - wb.y0) / 2;
        let zone: Rect;
        if (m === dt) zone = { x0: cx - half, x1: cx + half, y0: wb.y1, y1: wb.y1 + band };
        else if (m === dbm) zone = { x0: cx - half, x1: cx + half, y0: wb.y0 - band, y1: wb.y0 };
        else if (m === dl) zone = { x0: wb.x1, x1: wb.x1 + band, y0: cy - half, y1: cy + half };
        else zone = { x0: wb.x0 - band, x1: wb.x0, y0: cy - half, y1: cy + half };
        for (const p of cellPieces) {
          if (!tallSet.has(p.type)) continue;
          if (rectsOverlap(zone, pieceAABB(p))) {
            push({
              id: "winblock_" + win.id + "_" + p.id, severity: "tip", title: "Window possibly blocked",
              detail: `Check the height: ${escapeHtml(p.name)} sits in front of ${escapeHtml(win.name)}${inCell(cn)} and may block the light. No problem if it is low.`, targets: [win.id, p.id],
            });
            break;
          }
        }
      });
    }
    // Rule 11: TV viewing distance
    if (tv && sofa) {
      const dist = rectGap(pieceAABB(tv), pieceAABB(sofa));
      // `tvIn` is declared `number|string|null` (settings read back from an old `localStorage`):
      // the cast changes nothing about the execution, JS already coerced the same way.
      const inch = FL.ctx.etat.opts.tvIn as number;
      if (inch && inch > 0) {
        const diag = inch * 2.54, lo = diag * 1.5, hi = diag * 2.5;
        if (dist < lo) push({
          id: "tvdist_" + cl.ci, severity: "tip", title: "TV a little close",
          detail: `<b>${RND(dist)}cm</b> for a ${inch}" TV${inCell(cn)}; the comfortable range is ~${RND(lo)}–${RND(hi)}cm.`, targets: [tv.id, sofa.id], highlight: { type: "gap", a: tv, b: sofa },
        });
        else if (dist > hi) push({
          id: "tvdist_" + cl.ci, severity: "tip", title: "TV a little far",
          detail: `<b>${RND(dist)}cm</b> for a ${inch}" TV${inCell(cn)}; the comfortable range is ~${RND(lo)}–${RND(hi)}cm.`, targets: [tv.id, sofa.id], highlight: { type: "gap", a: tv, b: sofa },
        });
      } else {
        if (dist < 120) push({
          id: "tvdist_" + cl.ci, severity: "tip", title: "TV very close",
          detail: `<b>${RND(dist)}cm</b> from the sofa to the TV${inCell(cn)}: very close for a TV.`, targets: [tv.id, sofa.id], highlight: { type: "gap", a: tv, b: sofa },
        });
        else if (dist > 400) push({
          id: "tvdist_" + cl.ci, severity: "tip", title: "TV far",
          detail: `<b>${RND(dist)}cm</b> from the sofa to the TV${inCell(cn)}: far, fine for a small TV, tight for a big screen.`, targets: [tv.id, sofa.id], highlight: { type: "gap", a: tv, b: sofa },
        });
      }
    }
  });

  // order + cap
  // The SORT BY SEVERITY runs BEFORE the truncation, so what the cap discards is always the
  // least severe: never a blocker behind a comfort tip. (The sort is stable, so at
  // equal severity the production order is kept.)
  const rank = { error: 0, warn: 1, tip: 2 };
  F.sort((a, b) => rank[a.severity] - rank[b.severity]);
  // But the cap is a DISPLAY cap: it must not lie about the COUNTS. They're
  // taken from the WHOLE list, for the pill (js/38) and to say what isn't shown.
  const counts = { error: 0, warn: 0, tip: 0 };
  F.forEach((f) => { if (counts[f.severity] != null) counts[f.severity]++; });
  const rf = F.slice(0, 14);
  grid.pinches = rf.filter((f) => f.highlight && f.highlight.type === "pinch").map((f) => f.highlight as SurlignagePinch);
  return { findings: rf, grid, score: scoreFromFindings(rf), counts, total: F.length };
}

// Resolve the REAL state piece (local coords) behind an apt-space analysis copy, by id.
// Fixes must mutate the real piece, not the translated copy the engine reasons over.
export function realPieceById(id: string): Meuble | Ouverture | null {
  return pieceById(FL.ctx, id) || v5OpeningById(FL.ctx, id) || null;
}
// free cell nearest to a polygon's centroid (a cell's reachability + anchoring)
function polyCentroidFree(g: Grille, poly: Pt[]): number {
  let cx = 0, cy = 0; for (const [x, y] of poly) { cx += x; cy += y; } cx /= poly.length; cy /= poly.length;
  if (!pointInPoly(cx, cy, poly)) { const b = bboxOfPoly(poly); cx = b.minX + b.w / 2; cy = b.minY + b.l / 2; }
  return nearestFreeCell(g, cx, cy);
}

// THE SOLE analysis pass. There's only one context (the whole apartment): we set it, we
// apply the rules. Nothing to stack or restore, the analysis is never reentrant.
export function analyzeApt(): ResultatAnalyse {
  FL.flowCtx = buildAptContext();
  return runRules();
}

function addPinchFinding(F: Constat[], pin: Goulet, door: ObjetFlow, destName: string, g: Grille): void {
  if (!isFinite(pin.clearance) || pin.cell < 0) return;
  const width = Math.round(pin.widthCm);
  const loc = cellCenterCm(g, pin.cell);
  if (width < 75) {
    F.push({
      id: "pinch_" + door.id + "_" + destName + "_" + pin.cell, severity: "error", title: "Gap too narrow",
      detail: `Only <b>${width}cm</b> wide between ${escapeHtml(door.name)} and ${destName}: too narrow to walk through comfortably.`,
      targets: [door.id], highlight: { type: "pinch", x: loc.x, y: loc.y, width },
    });
  } else if (width < 90) {
    F.push({
      id: "pinch_" + door.id + "_" + destName + "_" + pin.cell, severity: "warn", title: "Tight gap",
      detail: `A <b>${width}cm</b> pinch between ${escapeHtml(door.name)} and ${destName}: tight for a main route, aim for 90+.`,
      targets: [door.id], highlight: { type: "pinch", x: loc.x, y: loc.y, width },
    });
  }
}

// march outward from (x,y) along (dx,dy) until leaving the polygon; return cm traveled inside
function wallDist(x: number, y: number, dx: number, dy: number, poly: Pt[]): number {
  if (!pointInPoly(x, y, poly)) return 0;
  const step = 5; let d = 0;
  for (let k = 0; k < 400; k++) { d += step; if (!pointInPoly(x + dx * d, y + dy * d, poly)) return d - step; }
  return d;
}
// polygon of the cell containing (x,y), or null. Basis for per-object clearances.
function polyContaining(x: number, y: number): Pt[] | null { const i = cellIndexAt(x, y); return i >= 0 ? fcCells()[i]!.poly : null; }

export type CoteDegagement = "top" | "bottom" | "left" | "right";
export type Degagements<T = number> = { [K in CoteDegagement]: T };

// side clearances of an AABB to nearest blocker or polygon wall (cm), per side
function sideClearances(box: AABB, selfId: string): Degagements {
  const midX = (box.x0 + box.x1) / 2, midY = (box.y0 + box.y1) / 2;
  const poly = polyContaining(midX, midY) || (fcCells()[0] && fcCells()[0]!.poly) || ([[0, 0], [1, 0], [1, 1], [0, 1]] as Pt[]);
  let top = wallDist(midX, box.y0, 0, -1, poly);
  let bottom = wallDist(midX, box.y1, 0, 1, poly);
  let left = wallDist(box.x0, midY, -1, 0, poly);
  let right = wallDist(box.x1, midY, 1, 0, poly);
  for (const p of fcPieces()) {
    if (p.id === selfId || !isBlocker(p)) continue;
    const b = pieceAABB(p);
    // must overlap in the perpendicular span to count as "behind that side"
    if (b.x1 > box.x0 && b.x0 < box.x1) {
      if (b.y1 <= box.y0) top = Math.min(top, box.y0 - b.y1);
      if (b.y0 >= box.y1) bottom = Math.min(bottom, b.y0 - box.y1);
    }
    if (b.y1 > box.y0 && b.y0 < box.y1) {
      if (b.x1 <= box.x0) left = Math.min(left, box.x0 - b.x1);
      if (b.x0 >= box.x1) right = Math.min(right, b.x0 - box.x1);
    }
  }
  return { top: Math.max(0, top), bottom: Math.max(0, bottom), left: Math.max(0, left), right: Math.max(0, right) };
}
function nearWall(box: AABB, tol: number): boolean {
  // near a real (polygon) wall if any AABB-perimeter sample is within tol of the boundary
  const midX = (box.x0 + box.x1) / 2, midY = (box.y0 + box.y1) / 2;
  const poly = polyContaining(midX, midY) || (fcCells()[0] && fcCells()[0]!.poly);
  if (!poly) return false;
  const xs = [box.x0, (box.x0 + box.x1) / 2, box.x1], ys = [box.y0, (box.y0 + box.y1) / 2, box.y1];
  for (const x of xs) for (const y of ys) {
    if (x !== xs[1] && y !== ys[1]) continue; // perimeter mids + skip interior center
    if (nearestOnPoly(x, y, poly).dist <= tol) return true;
  }
  return false;
}
