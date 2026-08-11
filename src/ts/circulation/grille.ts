// src/ts/circulation/grille.ts — PORTED VERBATIM from src/js/35-flow-grille.js (165 lines).
// No rule, no threshold, no constant changes. Only the language of the code changes.

import type { Grille, ObjetFlow, Rect } from "./etat.ts";
import { clamp } from "../noyau/nombres.ts";
import { nearestOnPoly } from "../geometrie/polygones.ts";
import {
  doorPassage, fcBBox, fcCells, fcPieces, inAnyCell, isBlocker, pieceAABB, rectsOverlap,
} from "./contexte.ts";

// ---- circulation grid (THE WHOLE APARTMENT) ----
// ONE grid over the outline. A cell is walkable when its center falls inside a CELL, outside
// the wall band and outside furniture. Doors (and pocket doors) punch through their wall
// band, which links neighboring cells; a door on the outline opens onto a plain stub.
// There's no more "corridor" to handle separately: the cells tile the inside of the outline, a
// corridor IS a cell like any other.
export function buildGrid(): Grille {
  const bb = fcBBox();
  const W = bb.w, L = bb.l, ox = bb.minX, oy = bb.minY;
  // cell size keeps the union under ~20k cells: max(10, ceil(maxUnionDim/160))
  const cs = Math.max(10, Math.ceil(Math.max(W, L) / 160));
  const gw = Math.ceil(W / cs), gh = Math.ceil(L / cs);
  const blocked = new Uint8Array(gw * gh);
  const boxes = fcPieces().filter(isBlocker).map(pieceAABB);
  const polys = fcCells();
  // A wall has a thickness in the grid: any cell within wallPad of a cell
  // boundary IS a wall (blocked). Two adjoining cells therefore don't leak into one another,
  // only a carved door links them.
  const wallPad = cs * 0.7;
  const nearAnyCellWall = (x: number, y: number): boolean => {
    for (let pi = 0; pi < polys.length; pi++) { if (nearestOnPoly(x, y, polys[pi]!.poly).dist < wallPad) return true; }
    return false;
  };
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const ccx = ox + gx * cs + cs / 2, ccy = oy + gy * cs + cs / 2;
      const x0 = ox + gx * cs, y0 = oy + gy * cs;
      const cell: Rect = { x0, y0, x1: x0 + cs, y1: y0 + cs };
      let b = 1;
      if (inAnyCell(ccx, ccy) && !nearAnyCellWall(ccx, ccy)) {
        b = 0;
        for (const box of boxes) { if (rectsOverlap(cell, box)) { b = 1; break; } }
      }
      blocked[gy * gw + gx] = b;
    }
  }
  // carve door passages: mark cells inside a thin oriented band through each door span walkable
  const doors = fcPieces().filter((p) => p.type === "door" || p.type === "sdoor");
  const carveDepth = cs * 1.6;          // reach across the (flush) wall to bridge both sides
  doors.forEach((d) => {
    const pa = doorPassage(d);
    // scan cells within the door's bounding reach and test the oriented band
    const reach = pa.halfLen + carveDepth + cs;
    const gx0 = clamp(Math.floor((pa.cx - reach - ox) / cs), 0, gw - 1), gx1 = clamp(Math.ceil((pa.cx + reach - ox) / cs), 0, gw - 1);
    const gy0 = clamp(Math.floor((pa.cy - reach - oy) / cs), 0, gh - 1), gy1 = clamp(Math.ceil((pa.cy + reach - oy) / cs), 0, gh - 1);
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
      const ccx = ox + gx * cs + cs / 2, ccy = oy + gy * cs + cs / 2;
      const rx = ccx - pa.cx, ry = ccy - pa.cy;
      const along = Math.abs(rx * pa.ux + ry * pa.uy);         // distance along the wall span
      const perp = Math.abs(rx * pa.nx + ry * pa.ny);          // distance across the wall
      if (along <= pa.halfLen && perp <= carveDepth) {
        // don't punch through a furniture obstacle sitting in the doorway
        const x0 = ox + gx * cs, y0 = oy + gy * cs;
        const cell: Rect = { x0, y0, x1: x0 + cs, y1: y0 + cs };
        let hit = false; for (const box of boxes) { if (rectsOverlap(cell, box)) { hit = true; break; } }
        if (!hit) blocked[gy * gw + gx] = 0;
      }
    }
  });
  return { cs, gw, gh, blocked, W, L, ox, oy };
}
// Distance transform: cm to nearest blocked cell OR boundary (chamfer 2-pass)
export function clearanceField(g: Grille): Float64Array {
  const { gw, gh, cs, blocked } = g;
  const INF = 1e9;
  const d = new Float64Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) d[i] = blocked[i] ? 0 : INF;
  // outside-polygon cells are already blocked (=0), so this transform encodes
  // distance to the real walls automatically — no rectangle-edge seeding needed.
  const D1 = cs, D2 = cs * Math.SQRT2;
  // forward
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const i = y * gw + x; if (d[i] === 0) continue;
    let v = d[i]!;
    if (x > 0) { const w = d[i - 1]! + D1; if (w < v) v = w; }
    if (y > 0) { const w = d[i - gw]! + D1; if (w < v) v = w; }
    if (x > 0 && y > 0) { const w = d[i - gw - 1]! + D2; if (w < v) v = w; }
    if (x < gw - 1 && y > 0) { const w = d[i - gw + 1]! + D2; if (w < v) v = w; }
    d[i] = v;
  }
  // backward
  for (let y = gh - 1; y >= 0; y--) for (let x = gw - 1; x >= 0; x--) {
    const i = y * gw + x; if (d[i] === 0) continue;
    let v = d[i]!;
    if (x < gw - 1) { const w = d[i + 1]! + D1; if (w < v) v = w; }
    if (y < gh - 1) { const w = d[i + gw]! + D1; if (w < v) v = w; }
    if (x < gw - 1 && y < gh - 1) { const w = d[i + gw + 1]! + D2; if (w < v) v = w; }
    if (x > 0 && y < gh - 1) { const w = d[i + gw - 1]! + D2; if (w < v) v = w; }
    d[i] = v;
  }
  return d; // clearance in cm (~half local corridor width)
}

export interface CheminLePlusLarge {
  best: Float64Array;
  prev: Int32Array;
}

// Widest-path (max-min bottleneck) Dijkstra from a source cell.
// Returns {bottleneck:Float64Array, prev:Int32Array} where bottleneck[t]=widest achievable min-clearance to t.
export function widestPath(g: Grille, clear: Float64Array, srcIdx: number): CheminLePlusLarge {
  const { gw, gh, blocked } = g;
  const N = gw * gh;
  const best = new Float64Array(N).fill(-1);
  const prev = new Int32Array(N).fill(-1);
  if (srcIdx < 0 || blocked[srcIdx]) return { best, prev };
  // simple max-priority via bucket-less binary heap
  const heapI: number[] = [], heapV: number[] = [];
  const push = (i: number, v: number): void => {
    heapI.push(i); heapV.push(v); let c = heapI.length - 1;
    while (c > 0) {
      const par = (c - 1) >> 1; if (heapV[par]! >= heapV[c]!) break;
      [heapV[par], heapV[c]] = [heapV[c]!, heapV[par]!]; [heapI[par], heapI[c]] = [heapI[c]!, heapI[par]!]; c = par;
    }
  };
  const pop = (): { i: number; v: number } => {
    const ti = heapI[0]!, tv = heapV[0]!; const li = heapI.pop()!, lv = heapV.pop()!;
    if (heapI.length) {
      heapI[0] = li; heapV[0] = lv; let c = 0; const n = heapI.length;
      for (; ;) {
        let l = 2 * c + 1, r = 2 * c + 2, b = c;
        if (l < n && heapV[l]! > heapV[b]!) b = l; if (r < n && heapV[r]! > heapV[b]!) b = r; if (b === c) break;
        [heapV[b], heapV[c]] = [heapV[c]!, heapV[b]!]; [heapI[b], heapI[c]] = [heapI[c]!, heapI[b]!]; c = b;
      }
    }
    return { i: ti, v: tv };
  };
  best[srcIdx] = clear[srcIdx]!;
  push(srcIdx, best[srcIdx]!);
  const nb: Array<[number, number]> = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
  while (heapI.length) {
    const { i, v } = pop();
    if (v < best[i]!) continue;
    const x = i % gw, y = (i / gw) | 0;
    for (const [dx, dy] of nb) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const ni = ny * gw + nx; if (blocked[ni]) continue;
      const bott = Math.min(v, clear[ni]!);
      if (bott > best[ni]!) { best[ni] = bott; prev[ni] = i; push(ni, bott); }
    }
  }
  return { best, prev };
}
export function reconstruct(prev: Int32Array, srcIdx: number, tgtIdx: number): number[] {
  const path: number[] = []; let c = tgtIdx, guard = 0;
  while (c >= 0 && guard++ < 100000) { path.push(c); if (c === srcIdx) break; c = prev[c]!; }
  return path.reverse();
}
export function nearestFreeCell(g: Grille, xcm: number, ycm: number): number {
  const { gw, gh, cs, blocked } = g;
  const gx = clamp(Math.floor((xcm - g.ox) / cs), 0, gw - 1), gy = clamp(Math.floor((ycm - g.oy) / cs), 0, gh - 1);
  if (!blocked[gy * gw + gx]) return gy * gw + gx;
  for (let r = 1; r < Math.max(gw, gh); r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      if (!blocked[ny * gw + nx]) return ny * gw + nx;
    }
  }
  return -1;
}
export function cellCenterCm(g: Grille, idx: number): { x: number; y: number } {
  const x = idx % g.gw, y = (idx / g.gw) | 0; return { x: g.ox + (x + 0.5) * g.cs, y: g.oy + (y + 0.5) * g.cs };
}

// A door's first cell: just inside the cell it opens onto. We push
// the door's center along its normal; if neither side is a cell (door
// on the outline), we fall back to the carved threshold cell.
export function doorApproach(g: Grille, door: ObjetFlow): number {
  const b = pieceAABB(door);
  const pa = doorPassage(door);
  const off = g.cs * 1.5;
  // prefer the +normal side, then the -normal side
  for (const sgn of [1, -1]) {
    const ax = b.cx + pa.nx * off * sgn, ay = b.cy + pa.ny * off * sgn;
    if (inAnyCell(ax, ay)) return nearestFreeCell(g, ax, ay);
  }
  return nearestFreeCell(g, b.cx, b.cy);   // door to outside: the carved stub
}

export interface Goulet {
  clearance: number;
  cell: number;
  widthCm: number;
}

// ---- pinch extraction from a path ----
// `_g`: the grid isn't read here, and wasn't in js/35 either (`pathBottleneck(g,…)`).
// The parameter stays in place, calls are positional, but it carries the prefix that
// `noUnusedParameters` expects.
export function pathBottleneck(_g: Grille, clear: Float64Array, path: number[]): Goulet {
  let minC = Infinity, minIdx = -1;
  for (const idx of path) { if (clear[idx]! < minC) { minC = clear[idx]!; minIdx = idx; } }
  return { clearance: minC, cell: minIdx, widthCm: minC * 2 };
}
