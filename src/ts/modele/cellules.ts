// src/ts/modele/cellules.ts — CELL DETECTION (planar subdivision) and persistence of
// names/floors. Porté de src/js/48-v5-cellules.js.
//
// 1. segments = outline edges + interior walls
// 2. nodes = endpoints merged at V5_EPS + proper intersections computed pairwise
// 3. split: each segment is cut at EVERY node that lands on it (T-junctions, collinear overlaps
//    -> identical sub-edges deduplicated)
// 4. dead-end pruning: a wall that joins nothing partitions nothing
// 5. faces: walk left along the half-edges; the outer face (largest |area|) is discarded
//
// D-5 ("the conversion is deterministic, hence idempotent") rests on TWO explicit sort tie-breaks:
// the angular order of edges is broken by vertex index, and cells are ordered by their pole
// (top-to-bottom then left-to-right). Without them, two clients converge on different
// identifiers. This is verified by `rapide_detection_est_deterministe`.

import { clamp, v5R2, V5_EPS, V5_MIN_AREA } from "../noyau/nombres.ts";
import {
  closestOnSeg,
  pointInPoly,
  poleOfInaccessibility,
  simplifyRectilinear,
} from "../geometrie/polygones.ts";
import { v5SegInt, v5SignedArea, v5OverlapArea } from "./aires.ts";
import { v5DedupeWalls } from "./murs.ts";
import type { Cellule, Mur, PlanV5, Pt, RapportDetection } from "../partage/plan.ts";

/** A freshly detected cell: it carries its area, which `v5RebuildCells` does not persist. */
export interface CelluleDetectee extends Cellule {
  area: number;
}

export interface ResultatDetection {
  cells: CelluleDetectee[];
  report: RapportDetection;
}

type Segment = [Pt, Pt];

export function v5DetectCells(
  outline: readonly Pt[] | null | undefined,
  walls: readonly Mur[] | null | undefined,
): ResultatDetection {
  const report: RapportDetection = {
    segments: 0, nodes: 0, edges: 0, pruned: 0, faces: 0, dropped: 0, tiny: 0, outside: 0,
  };
  const segs: Segment[] = [];
  const O: readonly Pt[] = Array.isArray(outline) ? outline : [];
  for (let i = 0; i < O.length; i++) {
    const a = O[i]!, b = O[(i + 1) % O.length]!;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > V5_EPS) segs.push([[a[0], a[1]], [b[0], b[1]]]);
  }
  (walls || []).forEach((w) => {
    if (w.isOutline) return; // duplicate of the outline
    if (Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) > V5_EPS) {
      segs.push([[w.a[0], w.a[1]], [w.b[0], w.b[1]]]);
    }
  });
  report.segments = segs.length;
  if (segs.length < 3) return { cells: [], report };

  // --- 1/2: nodes ---
  const nodes: Pt[] = [];
  const nodeAt = (x: number, y: number): number => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (Math.abs(n[0] - x) <= V5_EPS && Math.abs(n[1] - y) <= V5_EPS) return i;
    }
    nodes.push([v5R2(x), v5R2(y)]);
    return nodes.length - 1;
  };
  segs.forEach((s) => { nodeAt(s[0][0], s[0][1]); nodeAt(s[1][0], s[1][1]); });
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const p = v5SegInt(segs[i]![0], segs[i]![1], segs[j]![0], segs[j]![1]);
      if (p) nodeAt(p[0], p[1]);
    }
  }
  report.nodes = nodes.length;

  // --- 3: split + deduplication ---
  const edges = new Map<string, [number, number]>(); // "u|v" (u<v) -> [u,v]
  const addEdge = (u: number, v: number): void => {
    if (u === v) return;
    const k = u < v ? u + "|" + v : v + "|" + u;
    if (!edges.has(k)) edges.set(k, [Math.min(u, v), Math.max(u, v)]);
  };
  segs.forEach((s) => {
    const ax = s[0][0], ay = s[0][1], bx = s[1][0], by = s[1][1];
    const L2 = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
    if (L2 < V5_EPS * V5_EPS) return;
    const on: Array<{ ni: number; t: number }> = [];
    for (let ni = 0; ni < nodes.length; ni++) {
      const n = nodes[ni]!;
      const c = closestOnSeg(n[0], n[1], ax, ay, bx, by);
      if (c.dist <= V5_EPS) {
        const t = ((n[0] - ax) * (bx - ax) + (n[1] - ay) * (by - ay)) / L2;
        on.push({ ni, t: clamp(t, 0, 1) });
      }
    }
    on.sort((p, q) => p.t - q.t);
    for (let k = 1; k < on.length; k++) addEdge(on[k - 1]!.ni, on[k]!.ni);
  });
  let E = Array.from(edges.values());
  report.edges = E.length;
  if (!E.length) return { cells: [], report };

  // --- 4: dead-end pruning ---
  for (;;) {
    const deg = new Array<number>(nodes.length).fill(0);
    E.forEach((e) => { deg[e[0]]!++; deg[e[1]]!++; });
    const before = E.length;
    E = E.filter((e) => deg[e[0]]! > 1 && deg[e[1]]! > 1);
    report.pruned += before - E.length;
    if (E.length === before || !E.length) break;
  }
  if (E.length < 3) return { cells: [], report };

  // --- 5: faces ---
  // The return type is written ON the lambda, not just on `adj`: without it, `[]` infers as
  // `any[]` as soon as `strictNullChecks` is off, and `tsconfig.outils.json` (which re-reads this
  // module through the suites' imports) rejects an implicit `any`. Annotating the source beats loosening the setting.
  const adj: Array<Array<{ v: number; ang: number }>> = nodes.map((): Array<{ v: number; ang: number }> => []);
  E.forEach(([u, v]) => {
    adj[u]!.push({ v, ang: Math.atan2(nodes[v]![1] - nodes[u]![1], nodes[v]![0] - nodes[u]![0]) });
    adj[v]!.push({ v: u, ang: Math.atan2(nodes[u]![1] - nodes[v]![1], nodes[u]![0] - nodes[v]![0]) });
  });
  adj.forEach((l) => l.sort((a, b) => a.ang - b.ang || a.v - b.v));
  const used = new Set<string>();
  const faces: Pt[][] = [];
  const maxSteps = E.length * 2 + 8;
  for (const [u0, v0] of E) {
    for (const [su, sv] of [[u0, v0], [v0, u0]] as Array<[number, number]>) {
      if (used.has(su + ">" + sv)) continue;
      const poly: Pt[] = [];
      let u = su, v = sv, steps = 0, ok = true;
      do {
        used.add(u + ">" + v);
        poly.push(nodes[v]!);
        const list = adj[v]!;
        let ri = -1;
        for (let i = 0; i < list.length; i++) if (list[i]!.v === u) { ri = i; break; }
        if (ri < 0) { ok = false; break; }
        const nx = list[(ri - 1 + list.length) % list.length]!.v;
        u = v; v = nx;
        if (++steps > maxSteps) { ok = false; break; }
      } while (!(u === su && v === sv));
      if (ok && poly.length >= 3) faces.push(poly);
    }
  }
  report.faces = faces.length;
  if (!faces.length) return { cells: [], report };

  // outer face = largest |area| (the sum of the internal faces equals exactly its area)
  let outer = 0, best = -1;
  faces.forEach((f, i) => { const a = Math.abs(v5SignedArea(f)); if (a > best) { best = a; outer = i; } });
  const cells: Array<CelluleDetectee & { _px?: number; _py?: number }> = [];
  faces.forEach((f, i) => {
    if (i === outer) { report.dropped++; return; }
    let poly = simplifyRectilinear(f.map((p) => [v5R2(p[0]), v5R2(p[1])] as Pt), 0.05);
    if (poly.length < 3) { report.tiny++; return; }
    if (v5SignedArea(poly) < 0) poly = poly.slice().reverse(); // stable orientation
    const area = Math.abs(v5SignedArea(poly));
    if (area < V5_MIN_AREA) { report.tiny++; return; }
    const c = poleOfInaccessibility(poly);
    if (O.length > 2 && !pointInPoly(c.x, c.y, O)) { report.outside++; return; }
    cells.push({ id: "c" + (cells.length + 1), poly, name: "", floor: "parquet", area });
  });
  // deterministic order: top->bottom then left->right of the pole
  cells.forEach((c) => { const p = poleOfInaccessibility(c.poly); c._px = p.x; c._py = p.y; });
  cells.sort((a, b) => (a._py! - b._py!) || (a._px! - b._px!));
  cells.forEach((c, i) => { c.id = "c" + (i + 1); delete c._px; delete c._py; });
  return { cells, report };
}

// =================================================================================================
//  NAME / FLOOR PERSISTENCE — the cells are derived, the labels are not
// =================================================================================================
// Matching by largest (exact) area overlap, deterministic: every pair sorted by (decreasing
// overlap, previous index, new index) and consumed greedily.
// Fallback rescue by pole containment. The rest gets "Room N"/parquet.

/** What we keep from a cell as it was BEFORE: its label and its shape, nothing else. */
export interface CellulePrecedente {
  name?: string | undefined;
  floor?: string | undefined;
  poly?: Pt[] | undefined;
}

export function v5AssignNames<T extends Cellule>(
  cells: T[],
  prev: readonly CellulePrecedente[] | null | undefined,
): T[] {
  const anciennes: readonly CellulePrecedente[] = Array.isArray(prev) ? prev : [];
  const pairs: Array<{ ci: number; pi: number; ov: number }> = [];
  cells.forEach((c, ci) =>
    anciennes.forEach((p, pi) => {
      if (!p || !Array.isArray(p.poly) || p.poly.length < 3) return;
      const ov = v5OverlapArea(c.poly, p.poly);
      if (ov > V5_MIN_AREA) pairs.push({ ci, pi, ov });
    }),
  );
  pairs.sort((a, b) => (b.ov - a.ov) || (a.pi - b.pi) || (a.ci - b.ci));
  const takenC = new Set<number>(), takenP = new Set<number>();
  pairs.forEach((pr) => {
    if (takenC.has(pr.ci) || takenP.has(pr.pi)) return;
    takenC.add(pr.ci); takenP.add(pr.pi);
    cells[pr.ci]!.name = anciennes[pr.pi]!.name || "";
    cells[pr.ci]!.floor = anciennes[pr.pi]!.floor || "parquet";
  });
  // rescue: does the old cell's pole fall inside a new one that is still free?
  anciennes.forEach((p, pi) => {
    if (takenP.has(pi) || !p || !Array.isArray(p.poly) || p.poly.length < 3) return;
    const q = poleOfInaccessibility(p.poly);
    for (let ci = 0; ci < cells.length; ci++) {
      if (takenC.has(ci)) continue;
      if (pointInPoly(q.x, q.y, cells[ci]!.poly)) {
        takenC.add(ci); takenP.add(pi);
        cells[ci]!.name = p.name || "";
        cells[ci]!.floor = p.floor || "parquet";
        break;
      }
    }
  });
  // Defaults: "Room N" with the smallest free N, in order (deterministic).
  //
  // THIS NAME NOW SHIPS IN ENGLISH, DELIBERATELY, AND IT MOVED DATA. It used to stay "Pièce N"
  // inside an otherwise English interface, because this same function names both NEW cells *and*
  // the ones the v4 conversion manufactures: changing it therefore moved the fingerprint of every
  // historical document whose cells carry no stored name (`node tests/compat-donnees.ts --figer`,
  // frozen deliberately, see its git history for which documents shifted and by what). A finished
  // translation outweighs a frozen fingerprint that only ever existed to buy time.
  const used = new Set(cells.map((c) => c.name).filter(Boolean));
  let n = 1;
  cells.forEach((c) => {
    if (c.name) return;
    while (used.has("Room " + n)) n++;
    c.name = "Room " + n;
    used.add(c.name);
    c.floor = c.floor || "parquet";
  });
  return cells;
}

export interface OptionsRecalcul {
  /**
   * The cells to inherit names and floors FROM, instead of the plan's current ones. This is how a
   * gesture matches from the PHOTO taken before it started (`modele/photo-cellules.ts`) rather than
   * from the intermediate state its own previous frame left behind.
   */
  depuis?: readonly CellulePrecedente[] | null;
  /**
   * DURING a gesture (`final=false`): recompute the cells, and touch NOTHING ELSE. In particular no
   * `v5DedupeWalls`: a partition pushed onto another one is EXACTLY overlapping for a few frames,
   * and deduplication DELETES a wall and re-homes its openings. Run per frame it would destroy, for
   * good and without a word, a wall the hand is merely sweeping past. Cleaning up belongs to the
   * final recomputation, on the geometry that was actually released.
   */
  enDirect?: boolean;
}

/** Recomputes `cells` from outline+walls while keeping name/floor. Mutates and returns the plan. */
export function v5RebuildCells(
  plan: PlanV5 | null | undefined,
  opts?: OptionsRecalcul | null,
): PlanV5 | null | undefined {
  if (!plan) return plan;
  if (!opts?.enDirect) v5DedupeWalls(plan); // sanitization: never two exactly overlapping walls
  const prev: CellulePrecedente[] = opts?.depuis
    ? opts.depuis.slice()
    : (Array.isArray(plan.cells)
      ? plan.cells.map((c) => ({ name: c.name, floor: c.floor, poly: c.poly }))
      : []);
  const { cells, report } = v5DetectCells(plan.outline, plan.walls);
  plan.cells = v5AssignNames(cells, prev).map((c) => ({ id: c.id, poly: c.poly, name: c.name, floor: c.floor }));
  plan._report = report;
  return plan;
}
