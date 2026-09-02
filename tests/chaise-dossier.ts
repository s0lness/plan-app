#!/usr/bin/env node
// =================================================================================================
//  "CHAIR BACKREST" SUITE: NO BROWSER (snapChairToTable's rotation math is PURE)
// =================================================================================================
// Usage report, verbatim: "Quand je place une chaise contre une table, le dossier ne se met pas
// dans le bon sens." A chair docked against a table must end up with its BACK to the outside and
// its SEAT toward the table, on whichever side it lands, and the answer is relative to the TABLE
// (which can itself be rotated by `rot`), never to the screen.
//
// THE BUG, measured here before the fix: `snapChairToTable` (src/ts/gestes/contraintes.ts)
// already computed the world direction the chair's front must face (`wfx,wfy`), but then derived
// `p.rot` from it with the WRONG sign: `atan2(wfx, wfy)` instead of `atan2(-wfx, wfy)`. The two
// only agree when `wfx` is exactly 0 (docking at the table's top or bottom edge, on an unrotated
// table), which is why the defect can look intermittent: TOP/BOTTOM come out right, LEFT/RIGHT
// come out rotated 180deg from correct (backrest jammed against the table instead of away from
// it), and a rotated table gets it wrong almost everywhere.
//
// THE CONVENTION THIS SUITE PINS DOWN, read off `icones.ts`'s "chair" icon and the CSS
// `rotate(deg)` the renderer applies (`meubles.ts`): at `rot=0` the backrest bar is drawn at the
// TOP of the tile (small local y) and the seat opens toward the BOTTOM (large local y). So the
// chair's own "front" (open, no-backrest side) is the LOCAL vector (0,1), and a `rot` degrees CSS
// rotation sends it to world `(-sin(rot), cos(rot))`, same rotation convention as
// the piece-corner rotation helper in contraintes.ts, which is exactly what a correct
// `snapChairToTable` must invert.
//
//   node tests/chaise-dossier.ts
import { snapChairToTable } from "../src/ts/gestes/contraintes.ts";
import type { Meuble, PlanV5 } from "../src/ts/partage/plan.ts";

let ok = 0, ko = 0;
const rates: string[] = [];
function test(nom: string, fn: (a: (cond: unknown, msg: string) => void) => void) {
  const fails: string[] = [];
  try { fn((cond, msg) => { if (!cond) fails.push(msg); }); }
  catch (e) { fails.push("EXCEPTION: " + (e && (e as Error).stack || e)); }
  if (fails.length) { ko++; rates.push(nom); } else ok++;
  console.log(`  ${fails.length ? "FAIL " : "ok   "} ${nom}`);
  fails.forEach((f) => console.log("        - " + f));
}

function mkTable(rot: number, w = 120, h = 80): Meuble {
  return { id: "t1", type: "dining", name: "Table", x: 200 - w / 2, y: 200 - h / 2, w, h, rot,
    locked: false } as Meuble;
}
function mkChair(cx: number, cy: number, rot = 0): Meuble {
  return { id: "c1", type: "chair", name: "Chaise", x: cx - 22.5, y: cy - 22.5, w: 45, h: 45,
    rot, locked: false } as Meuble;
}
/** The chair's OWN "front" world direction: local (0,1) [seat-open side, opposite the
 *  backrest] rotated by `rot`, using the SAME rotation convention as the renderer's CSS
 *  `rotate(deg)`. */
function frontDir(rot: number): { x: number; y: number } {
  const rad = (rot || 0) * Math.PI / 180;
  return { x: -Math.sin(rad), y: Math.cos(rad) };
}
/** Cosine of the angle between the chair's front and the direction from the chair to the table:
 *  1 = the chair looks exactly at the table, -1 = its back is turned to it. */
function facing(table: Meuble, chair: Meuble): number {
  const f = frontDir(chair.rot);
  const ccx = chair.x + chair.w / 2, ccy = chair.y + chair.h / 2;
  const tcx = table.x + table.w / 2, tcy = table.y + table.h / 2;
  let dx = tcx - ccx, dy = tcy - ccy;
  const m = Math.hypot(dx, dy) || 1; dx /= m; dy /= m;
  return f.x * dx + f.y * dy;
}
function dock(table: Meuble, cx: number, cy: number): Meuble {
  const chair = mkChair(cx, cy);
  const P = { pieces: [table, chair] } as unknown as PlanV5;
  const snapped = snapChairToTable(P, {}, chair);
  if (!snapped) throw new Error(`no snap happened from (${cx},${cy})`);
  return chair;
}

// =================================================================================================
//  1. AN UNROTATED TABLE: all four sides have a clean, hand-computed expected angle.
// =================================================================================================
// rot=0 means the chair's own front already points south (screen-down): correct for a chair
// docked ABOVE the table (it must look down, toward the table below it).
test("chaise_au_nord_regarde_vers_le_sud_rot_0", (a) => {
  const table = mkTable(0);
  const chair = dock(table, 200, 200 - 40 - 20);   // above the table
  a(chair.rot === 0, `attendu rot=0, vu ${chair.rot}`);
  a(facing(table, chair) > 0.99, `la chaise doit regarder la table, cos=${facing(table, chair)}`);
});
test("chaise_au_sud_regarde_vers_le_nord_rot_180", (a) => {
  const table = mkTable(0);
  const chair = dock(table, 200, 200 + 40 + 20);   // below the table
  a(chair.rot === 180, `attendu rot=180, vu ${chair.rot}`);
  a(facing(table, chair) > 0.99, `la chaise doit regarder la table, cos=${facing(table, chair)}`);
});
// THIS IS THE PAIR THAT WAS WRONG: LEFT and RIGHT came out with each other's angle, backrest
// jammed against the table instead of turned away from it (measured: cos = -1.000 before the fix).
test("chaise_a_l_ouest_regarde_vers_l_est_rot_270", (a) => {
  const table = mkTable(0);
  const chair = dock(table, 200 - 60 - 20, 200);   // left of the table
  a(chair.rot === 270, `attendu rot=270, vu ${chair.rot}`);
  a(facing(table, chair) > 0.99, `la chaise doit regarder la table, cos=${facing(table, chair)}`);
});
test("chaise_a_l_est_regarde_vers_l_ouest_rot_90", (a) => {
  const table = mkTable(0);
  const chair = dock(table, 200 + 60 + 20, 200);   // right of the table
  a(chair.rot === 90, `attendu rot=90, vu ${chair.rot}`);
  a(facing(table, chair) > 0.99, `la chaise doit regarder la table, cos=${facing(table, chair)}`);
});

// =================================================================================================
//  2. A ROTATED TABLE: the answer is relative to the TABLE, not the screen (the owner's exact
//     complaint). At rot=90 the table's own former "left"/"right" edges now face north/south.
// =================================================================================================
test("table_tournee_90_chaise_a_l_est_regarde_vers_l_ouest", (a) => {
  const table = mkTable(90);
  const chair = dock(table, 200 + 60, 200);
  a(chair.rot === 90, `attendu rot=90, vu ${chair.rot}`);
  a(facing(table, chair) > 0.99, `la chaise doit regarder la table, cos=${facing(table, chair)}`);
});
test("table_tournee_90_chaise_a_l_ouest_regarde_vers_l_est", (a) => {
  const table = mkTable(90);
  const chair = dock(table, 200 - 60, 200);
  a(chair.rot === 270, `attendu rot=270, vu ${chair.rot}`);
  a(facing(table, chair) > 0.99, `la chaise doit regarder la table, cos=${facing(table, chair)}`);
});
// An "ugly" angle: no clean expected degree value to hand-compute, so this pins the PHYSICAL
// invariant instead (the chair looks at the table), on all four sides at once.
test("table_tournee_37_degres_la_chaise_regarde_toujours_la_table", (a) => {
  const table = mkTable(37);
  const rad = 37 * Math.PI / 180, ca = Math.cos(rad), sa = Math.sin(rad);
  const tcx = 200, tcy = 200;
  // world offsets of the table's own local N/S/E/W directions, at a comfortable snap distance
  // table is 120x80 (hw=60, hh=40): stay within the chair-table snap's 40cm reach of each edge.
  const offs: [number, number][] = [
    [0 * ca - -60 * sa, 0 * sa + -60 * ca],   // "north" in table-local, rotated to world
    [0 * ca - 60 * sa, 0 * sa + 60 * ca],     // "south"
    [-80 * ca - 0 * sa, -80 * sa + 0 * ca],   // "west"
    [80 * ca - 0 * sa, 80 * sa + 0 * ca],     // "east"
  ];
  for (const [ox, oy] of offs) {
    const chair = dock(table, tcx + ox, tcy + oy);
    const cos = facing(table, chair);
    a(cos > 0.99, `angle table=37deg, offset (${ox.toFixed(0)},${oy.toFixed(0)}) : la chaise devrait regarder la table, cos=${cos.toFixed(3)} rot=${chair.rot}`);
  }
});

// =================================================================================================
//  3. A DEAD CLICK (no movement) is not this function's business, but a NO-OP call (chair already
//     exactly at rest, called again with the same position) must stay idempotent: docking twice
//     from the same spot must not spin the chair.
// =================================================================================================
test("re_appeler_snap_depuis_la_position_deja_calee_ne_change_rien", (a) => {
  const table = mkTable(0);
  const chair = dock(table, 200, 200 - 40 - 20);
  const rotAfterFirst = chair.rot;
  const P = { pieces: [table, chair] } as unknown as PlanV5;
  snapChairToTable(P, {}, chair);
  a(chair.rot === rotAfterFirst, `un second calage depuis la meme place a change rot (${rotAfterFirst} -> ${chair.rot})`);
});

// ---------------------------------------------------------------------------------------------
console.log(`\n${ko ? `FAILURES ${ko}/${ok + ko}` : `OK ${ok}/${ok}`}`);
rates.forEach((n) => console.log("  FAIL " + n));
process.exit(ko ? 1 : 0);
