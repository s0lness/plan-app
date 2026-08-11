// src/ts/modele/conversion-v4.ts — THE v4 -> v5 CONVERSION, in a single pass.
// Porté de src/js/49-v5-conversion.js (`buildV5FromV4`; the four support-line functions live in
// `modele/conversion.ts` and are IMPORTED).
//
//   outline  : the envelope if it exists, otherwise the hull of the union of rooms (`computeEnvelopeHull`)
//   walls    : room edges that are NOT on the outline, deduplicated: two coincident edges (two
//              neighboring rooms) MERGE into ONE wall; collinear segments that overlap or touch
//              within V5_SNAP are joined into one
//   openings : wall-mounted objects (door / sliding door / window / wall light / outlet / RJ45)
//              reparameterized onto their nearest wall (outline included, via isOutline walls)
//   pieces   : all the rest of the furniture, converted to apartment coordinates
//   cells    : detected, then named by pole containment of the legacy rooms
//
// THE FUNCTION IS PURE: it takes a `PlanAncien` and returns a fresh plan. In the old client it
// read `state` through the closure for nothing; here its only dependency is its argument.

import { clamp, v5R2, V5_SNAP, WALL } from "../noyau/nombres.ts";
import { estSolConnu } from "../partage/contrat-serveur.ts";
import { isWallMount, TYPEMAP } from "../catalogue/catalogue.ts";
import { closestOnSeg, pointInPoly, poleOfInaccessibility, simplifyRectilinear } from "../geometrie/polygones.ts";
import { v5LineKey, v5SameLine, v5SnapToOutline, v5OnOutline } from "./conversion.ts";
import type { DroiteSupport } from "./conversion.ts";
import { computeEnvelopeHull } from "./enveloppe.ts";
import { localToApt, roomAptPoly } from "./salles-anciennes.ts";
import type { MeubleAncien, PlanAncien, SalleAncienne } from "./salles-anciennes.ts";
import { v5AssignNames, v5DetectCells } from "./cellules.ts";
import type { Meuble, Mur, Ouverture, PlanV5, Pt, RapportDetection } from "../partage/plan.ts";

/** What the conversion SAYS about itself: diagnostic, never persisted. */
export interface RapportConversionV4 {
  rooms: number;
  rawEdges: number;
  outlineEdges: number;
  mergedWalls: number;
  outlineWalls: number;
  openings: number;
  openingsOrphan: number;
  pieces: number;
  unmatchedRooms: string[];
  detect: RapportDetection | null;
  error?: string | undefined;
}

export interface ResultatConversionV4 {
  plan: PlanV5 | null;
  report: RapportConversionV4;
}

/** A group of edges carried by the SAME support line, with the abscissas to be merged. */
interface GroupeDroite {
  k: DroiteSupport;
  o: Pt;
  segs: Array<[number, number]>;
  cs: number[];
}

export function buildV5FromV4(source: PlanAncien | null | undefined): ResultatConversionV4 {
  const st: PlanAncien = source || { rooms: [], envelope: null };
  const report: RapportConversionV4 = {
    rooms: 0, rawEdges: 0, outlineEdges: 0, mergedWalls: 0, outlineWalls: 0,
    openings: 0, openingsOrphan: 0, pieces: 0, unmatchedRooms: [], detect: null,
  };

  // ---- outline: the envelope if the plan just read had one, otherwise the hull of the union of rooms ----
  let outline: Pt[] | null = (st.envelope && Array.isArray(st.envelope.poly) && st.envelope.poly.length > 2)
    ? st.envelope.poly.map((p) => [p[0], p[1]] as Pt)
    : computeEnvelopeHull(5, (st.rooms || []).map(roomAptPoly));
  if (!outline) {
    // sober fallback: box of the union of rooms
    let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
    (st.rooms || []).forEach((r) => {
      const poly = roomAptPoly(r);
      for (const p of poly) {
        const x = p[0], y = p[1];
        if (x < mnX) mnX = x;
        if (y < mnY) mnY = y;
        if (x > mxX) mxX = x;
        if (y > mxY) mxY = y;
      }
    });
    if (isFinite(mnX)) outline = [[mnX, mnY], [mxX, mnY], [mxX, mxY], [mnX, mxY]];
  }
  if (!outline || outline.length < 3) {
    return { plan: null, report: Object.assign(report, { error: "no_outline" }) };
  }
  outline = simplifyRectilinear(outline.map((p) => [Math.round(p[0]), Math.round(p[1])] as Pt), 0.5);
  const contour: readonly Pt[] = outline;

  // ---- room edges -> interior walls ----
  const rooms: SalleAncienne[] = Array.isArray(st.rooms) ? st.rooms : [];
  report.rooms = rooms.length;
  const cand: Array<[Pt, Pt]> = [];
  rooms.forEach((r) => {
    const poly = roomAptPoly(r);
    for (let i = 0; i < poly.length; i++) {
      let a = poly[i]!.slice() as Pt, b = poly[(i + 1) % poly.length]!.slice() as Pt;
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1) continue;
      report.rawEdges++;
      a = v5SnapToOutline(a, contour, V5_SNAP);
      b = v5SnapToOutline(b, contour, V5_SNAP);
      if (v5OnOutline(a, b, contour, V5_SNAP)) { report.outlineEdges++; continue; }
      cand.push([a, b]);
    }
  });
  // grouping by support line, then union of intervals (merging coincidences/overlaps)
  const groups: GroupeDroite[] = [];
  cand.forEach(([a, b]) => {
    const k = v5LineKey(a, b);
    let g = groups.find((G) => v5SameLine(G.k, k, V5_SNAP));
    if (!g) { g = { k: { dx: k.dx, dy: k.dy, c: k.c }, o: a, segs: [], cs: [] }; groups.push(g); }
    const t0 = (a[0] - g.o[0]) * g.k.dx + (a[1] - g.o[1]) * g.k.dy;
    const t1 = (b[0] - g.o[0]) * g.k.dx + (b[1] - g.o[1]) * g.k.dy;
    g.segs.push([Math.min(t0, t1), Math.max(t0, t1)]);
    g.cs.push(k.c);
  });
  const walls: Mur[] = [];
  let wn = 0;
  groups.forEach((g) => {
    const c = g.cs.reduce((s, v) => s + v, 0) / g.cs.length; // group's average line
    const shift = c - g.k.c, nx = -g.k.dy, ny = g.k.dx;
    const ox = g.o[0] + nx * shift, oy = g.o[1] + ny * shift;
    g.segs.sort((p, q) => p[0] - q[0]);
    const merged: Array<[number, number]> = [];
    g.segs.forEach((s) => {
      const last = merged[merged.length - 1];
      if (last && s[0] <= last[1] + V5_SNAP) { if (s[1] > last[1]) last[1] = s[1]; }
      else merged.push([s[0], s[1]]);
    });
    merged.forEach((m) => {
      const a: Pt = [v5R2(ox + g.k.dx * m[0]), v5R2(oy + g.k.dy * m[0])];
      const b: Pt = [v5R2(ox + g.k.dx * m[1]), v5R2(oy + g.k.dy * m[1])];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1) return;
      walls.push({ id: "w" + (++wn), a, b, t: WALL, isOutline: false });
    });
  });
  report.mergedWalls = walls.length;
  // snapping endpoints onto the outline then onto the other walls (closed T-junctions)
  const snapEnd = (p: Pt, self: Mur): Pt => {
    let best: Pt | null = null, bd = V5_SNAP;
    for (let i = 0; i < contour.length; i++) {
      const q = contour[i]!, r = contour[(i + 1) % contour.length]!;
      const c = closestOnSeg(p[0], p[1], q[0], q[1], r[0], r[1]);
      if (c.dist <= bd && c.dist > 1e-9) { bd = c.dist; best = [c.x, c.y]; }
    }
    walls.forEach((w) => {
      if (w === self) return;
      const c = closestOnSeg(p[0], p[1], w.a[0], w.a[1], w.b[0], w.b[1]);
      if (c.dist <= bd && c.dist > 1e-9) { bd = c.dist; best = [c.x, c.y]; }
    });
    return best ? [v5R2(best[0]), v5R2(best[1])] : p;
  };
  walls.forEach((w) => { w.a = snapEnd(w.a, w); w.b = snapEnd(w.b, w); });
  // outline edges as walls (isOutline): support for openings on exterior walls
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i]!, b = contour[(i + 1) % contour.length]!;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1) continue;
    walls.push({ id: "w" + (++wn), a: [a[0], a[1]], b: [b[0], b[1]], t: WALL, isOutline: true });
    report.outlineWalls++;
  }

  // ---- openings + furniture ----
  const openings: Ouverture[] = [];
  const pieces: Meuble[] = [];
  const consider = (p: MeubleAncien, r: SalleAncienne | null): void => {
    const isEnv = (r === null);
    const c = isEnv ? { x: p.x + p.w / 2, y: p.y + p.h / 2 } : localToApt(r!, p.x + p.w / 2, p.y + p.h / 2);
    const cat = TYPEMAP[p.type];
    if (!isWallMount(p.type)) {
      const tl = isEnv ? { x: p.x, y: p.y } : localToApt(r!, p.x, p.y);
      pieces.push({
        id: String(p.id), type: p.type, name: String(p.name || cat!.name),
        x: Math.round(tl.x), y: Math.round(tl.y), w: p.w, h: p.h,
        rot: ((Math.round(p.rot || 0) % 360) + 360) % 360, locked: !!p.locked,
      });
      report.pieces++;
      return;
    }
    // wall closest to the center
    let best: { w: Mur } | null = null, bd = Infinity;
    walls.forEach((w) => {
      const q = closestOnSeg(c.x, c.y, w.a[0], w.a[1], w.b[0], w.b[1]);
      if (q.dist < bd) { bd = q.dist; best = { w }; }
    });
    if (!best || bd > 60) {
      report.openingsOrphan++;
      const tl = isEnv ? { x: p.x, y: p.y } : localToApt(r!, p.x, p.y);
      pieces.push({
        id: String(p.id), type: p.type, name: String(p.name || cat!.name),
        x: Math.round(tl.x), y: Math.round(tl.y), w: p.w, h: p.h,
        rot: ((Math.round(p.rot || 0) % 360) + 360) % 360, locked: !!p.locked,
      });
      return;
    }
    const w = (best as { w: Mur }).w;
    const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1], L = Math.hypot(dx, dy) || 1;
    const ux = dx / L, uy = dy / L;
    const tc = (c.x - w.a[0]) * ux + (c.y - w.a[1]) * uy; // center's abscissa along a->b
    const ang = Math.atan2(uy, ux) * 180 / Math.PI;
    const rot = ((Math.round(p.rot || 0) % 360) + 360) % 360;
    let dA = ((rot - ang) % 360 + 360) % 360;
    if (dA > 180) dA -= 360;
    const side: 0 | 1 = (Math.abs(dA) > 90) ? 1 : 0; // rot ≈ ang + 180*side
    const ow = Math.min(p.w, L);
    openings.push({
      id: String(p.id), wallId: w.id, t0: v5R2(clamp(tc - ow / 2, 0, Math.max(0, L - ow))), w: ow,
      h: p.h, type: p.type, side, name: String(p.name || cat!.name),
      hinge: (p.hinge != null) ? (Number(p.hinge) ? 1 : 0) : undefined,
      swing: (p.swing != null) ? (Number(p.swing) < 0 ? -1 : 1) : undefined,
    });
    report.openings++;
  };
  rooms.forEach((r) => (r.pieces || []).forEach((p) => { if (TYPEMAP[p.type]) consider(p, r); }));
  if (st.envelope && Array.isArray(st.envelope.pieces)) {
    st.envelope.pieces.forEach((p) => { if (TYPEMAP[p.type]) consider(p, null); });
  }

  // ---- cells + recovery of names/floors by pole containment of the legacy rooms ----
  const det = v5DetectCells(contour, walls);
  report.detect = det.report;
  const cells = det.cells;
  const claimed = new Set<number>();
  rooms.forEach((r) => {
    const poly = roomAptPoly(r);
    const c = poleOfInaccessibility(poly);
    let hit = -1;
    for (let i = 0; i < cells.length; i++) {
      if (!claimed.has(i) && pointInPoly(c.x, c.y, cells[i]!.poly)) { hit = i; break; }
    }
    if (hit < 0) { report.unmatchedRooms.push(r.name); return; }
    claimed.add(hit);
    cells[hit]!.name = r.name;
    cells[hit]!.floor = estSolConnu(r.floor) ? r.floor : "parquet";
  });
  v5AssignNames(cells, []); // "Room N" for the remaining cells
  const plan: PlanV5 = {
    outline: contour as Pt[], walls, openings, pieces,
    cells: cells.map((c) => ({ id: c.id, poly: c.poly, name: c.name, floor: c.floor })),
  };
  return { plan, report };
}
