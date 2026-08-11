// src/ts/modele/enveloppe.ts — RECTILINEAR SHELL of the union of legacy rooms.
// Porté de src/js/25-enveloppe.js (`computeEnvelopeHull` only).
//
// Rectilinear outer outline of a union of polygons (apartment cm). Serves ONLY the conversion of
// a legacy-format plan WITHOUT an envelope: the outline has to come from somewhere. Nothing in
// the live application calls it, and that is deliberate: a live outline is edited, not guessed.
//
// `simplifyRectilinear` lives in `geometrie/polygones.ts` (cell detection uses it too): it is
// IMPORTED, not duplicated. `renderRoomChips`, the other half of js/25, is RENDERING and has no
// business here.

import { pointInPoly, simplifyRectilinear } from "../geometrie/polygones.ts";
import type { Pt } from "../partage/plan.ts";

/** An oriented half-edge of the covered region's border. `dir`: 0=+x, 1=+y, 2=-x, 3=-y. */
interface DemiArete {
  from: Pt;
  to: Pt;
  dir: number;
  used: boolean;
}

/**
 * Rasterizes each polygon on a grid with step `cell`, marks the covered cells, then walks the
 * outer border of the covered region and simplifies alignments. Returns a polygon in apartment
 * cm, or `null` if nothing can be traced.
 */
export function computeEnvelopeHull(
  cell: number | null | undefined,
  polys: ReadonlyArray<readonly Pt[]> | null | undefined,
): Pt[] | null {
  const pas = cell || 5;
  const P = (polys || []).filter((p) => Array.isArray(p) && p.length > 2);
  if (!P.length) return null;
  // box of the union
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of P) {
    for (const p of poly) {
      const x = p[0], y = p[1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!isFinite(minX)) return null;
  const ox = minX, oy = minY;
  const gw = Math.max(1, Math.ceil((maxX - minX) / pas)), gh = Math.max(1, Math.ceil((maxY - minY) / pas));
  if (gw * gh > 4_000_000) return null; // guard: absurd grid
  const cov = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const cx = ox + (gx + 0.5) * pas, cy = oy + (gy + 0.5) * pas;
      for (let pi = 0; pi < P.length; pi++) {
        if (pointInPoly(cx, cy, P[pi]!)) { cov[gy * gw + gx] = 1; break; }
      }
    }
  }
  // BRIDGING THE HALLWAY: two rooms can be separated by a gap (the hallway, which no one had
  // drawn as a room). We fill in any empty cell that has coverage on BOTH sides along a row (or a
  // column), until it stabilizes, so the shell encloses rooms + hallway as a single region.
  {
    const between = new Uint8Array(gw * gh);
    let passes = 0, more = true;
    const at = (gx: number, gy: number): number =>
      (gx < 0 || gy < 0 || gx >= gw || gy >= gh) ? 0 : (cov[gy * gw + gx]! || between[gy * gw + gx]!);
    while (more && passes++ < 8) {
      more = false;
      // rows
      for (let gy = 0; gy < gh; gy++) {
        let last = -1;
        for (let gx = 0; gx < gw; gx++) {
          if (at(gx, gy)) {
            if (last >= 0 && gx - last > 1) {
              for (let k = last + 1; k < gx; k++) {
                if (!cov[gy * gw + k] && !between[gy * gw + k]) { between[gy * gw + k] = 1; more = true; }
              }
            }
            last = gx;
          }
        }
      }
      // columns
      for (let gx = 0; gx < gw; gx++) {
        let last = -1;
        for (let gy = 0; gy < gh; gy++) {
          if (at(gx, gy)) {
            if (last >= 0 && gy - last > 1) {
              for (let k = last + 1; k < gy; k++) {
                if (!cov[k * gw + gx] && !between[k * gw + gx]) { between[k * gw + gx] = 1; more = true; }
              }
            }
            last = gy;
          }
        }
      }
    }
    for (let i = 0; i < cov.length; i++) if (between[i]) cov[i] = 1;
  }
  // outside the grid = empty
  const covAt = (gx: number, gy: number): number =>
    (gx < 0 || gy < 0 || gx >= gw || gy >= gh) ? 0 : cov[gy * gw + gx]!;
  // Oriented border half-edges: for each covered cell, each side that faces an empty cell is a
  // border segment, oriented so that COVERED is to the LEFT of the walk (hence counterclockwise
  // in a grid with y pointing down). Corners are (gx,gy) in [0..gw]x[0..gh]. We then stitch from
  // the end of one edge to the outgoing edge at that corner; at an ambiguous corner (two outgoing
  // edges) we take the tightest LEFT turn, which traces the correct outer and inner outlines.
  const key = (x: number, y: number): number => x * 100003 + y;
  const outByCorner = new Map<number, DemiArete[]>();
  const addEdge = (x1: number, y1: number, x2: number, y2: number, dir: number): void => {
    const k = key(x1, y1);
    let a = outByCorner.get(k);
    if (!a) { a = []; outByCorner.set(k, a); }
    a.push({ from: [x1, y1], to: [x2, y2], dir, used: false });
  };
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      if (!cov[gy * gw + gx]) continue;
      // covered to the LEFT of the walk direction:
      if (!covAt(gx, gy - 1)) addEdge(gx, gy, gx + 1, gy, 0);           // top side, walk +x
      if (!covAt(gx + 1, gy)) addEdge(gx + 1, gy, gx + 1, gy + 1, 1);   // right side, walk +y
      if (!covAt(gx, gy + 1)) addEdge(gx + 1, gy + 1, gx, gy + 1, 2);   // bottom side, walk -x
      if (!covAt(gx - 1, gy)) addEdge(gx, gy + 1, gx, gy, 3);           // left side, walk -y
    }
  }
  if (!outByCorner.size) return null;
  // start: the edge whose STARTING corner is topmost, then leftmost (hence on the OUTER
  // border).
  let startEdge: DemiArete | null = null;
  for (const arr of outByCorner.values()) {
    for (const e of arr) {
      if (!startEdge || e.from[1] < startEdge.from[1]
        || (e.from[1] === startEdge.from[1] && e.from[0] < startEdge.from[0])) startEdge = e;
    }
  }
  if (!startEdge) return null;
  // outgoing edge at a corner, knowing the incoming direction: tightest LEFT turn.
  // order from direction d: (d-1), d, (d+1), (d+2), left, straight, right, u-turn.
  const pickNext = (cornerKey: number, inDir: number): DemiArete | null => {
    const arr = outByCorner.get(cornerKey);
    if (!arr) return null;
    const order = [(inDir + 3) & 3, inDir, (inDir + 1) & 3, (inDir + 2) & 3];
    for (const d of order) {
      const e = arr.find((x) => !x.used && x.dir === d);
      if (e) return e;
    }
    const any = arr.find((x) => !x.used);
    return any || null;
  };
  let e: DemiArete | null = startEdge;
  const loop: Pt[] = [];
  let guard = 0;
  while (e && guard++ < outByCorner.size * 4 + 32) {
    e.used = true;
    loop.push(e.from);
    const nk = key(e.to[0], e.to[1]);
    if (e.to[0] === startEdge.from[0] && e.to[1] === startEdge.from[1]) break; // closed back up
    const ne = pickNext(nk, e.dir);
    if (!ne) break;
    e = ne;
  }
  if (loop.length < 4) return null;
  // grid corners -> apartment cm
  let poly: Pt[] = loop.map((p) => [ox + p[0] * pas, oy + p[1] * pas] as Pt);
  // Simplifying alignments: a vertex is removed only if it is (almost) exactly on the line
  // through its neighbors. Collinear points aligned on the axes give cross==0; a real 90-degree
  // corner gives cross/segLen ~ pas, so the tolerance MUST stay well under `pas` (0.5 cm) or real
  // corners get eaten.
  poly = simplifyRectilinear(poly, 0.5);
  // round to integers
  poly = poly.map((p) => [Math.round(p[0]), Math.round(p[1])] as Pt);
  if (poly.length < 3) return null;
  return poly;
}
