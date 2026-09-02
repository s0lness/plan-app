// src/ts/modele/cellules.ts: CELL DETECTION (planar subdivision) and persistence of
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
  polyCentroid,
  simplifyRectilinear,
} from "../geometrie/polygones.ts";
import { memoriserOrphelins, orphelinsCellules } from "./photo-cellules.ts";
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

// =================================================================================================
//  THE UNIFORM GRIDS: the ONLY thing that changed about detection is what it SKIPS
// =================================================================================================
// `v5RebuildCells` runs on every frame of a geometry gesture and on every received op ("THE FLOOR
// FOLLOWS THE HAND"), a decision taken on a 22-wall plan at 0.40 ms. The server accepts 2000.
// Three passes were quadratic: `nodeAt` scanned every node, every pair of segments was tested for
// intersection, and the split rescanned every node for every segment. Measured on a grid of
// crossing partitions: 400 walls took 4.5 s, 800 took 22 s.
//
// EVERY GRID HERE ONLY EVER REMOVES WORK THAT COULD NOT HAVE PRODUCED ANYTHING. The result must
// stay byte-identical, because D-5 ("the conversion is deterministic, hence idempotent") rests on
// node NUMBERING and edge INSERTION ORDER, not just on the set of cells. So:
//   - `nodeAt` still returns the SMALLEST matching index, which is what the linear scan returned;
//   - candidate pairs are replayed in (i, j) order, so intersections create nodes in the old order;
//   - the split's tie-break becomes explicit (`t`, then node index), which is exactly what a stable
//     sort over an index-ordered array used to give.
// `tests/cellules-perf.ts` keeps the previous implementation as an oracle and compares the two
// on 200 seeded plans, plus the tolerance-boundary cases the quantization could have moved.

/**
 * Bucket key for a grid cell. A collision between two distinct cells is HARMLESS: it can only add
 * candidates, and every candidate is still checked exactly. A miss would not be, which is why the
 * key is a pure function of the cell and never of the query.
 */
const cleCase = (gx: number, gy: number): number => gx * 33554432 + gy;

function ajouter(grille: Map<number, number[]>, k: number, i: number): void {
  const b = grille.get(k);
  if (b) b.push(i); else grille.set(k, [i]);
}

/** Bounding box of a segment list, inflated by nothing. Empty list -> a degenerate box at 0. */
function boiteDesSegments(segs: readonly Segment[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of segs) {
    for (const p of s) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/**
 * Cells a segment PASSES THROUGH, inflated by `marge`, column by column. Exact supercover: a point
 * lying on the segment is always in one of the yielded cells, so two segments that meet always
 * share one. `visite` is called once per cell, in no particular order.
 */
function casesDuSegment(
  ax: number, ay: number, bx: number, by: number,
  ox: number, oy: number, taille: number, marge: number,
  visite: (gx: number, gy: number) => void,
): void {
  const sMinX = Math.min(ax, bx), sMaxX = Math.max(ax, bx);
  const sMinY = Math.min(ay, by), sMaxY = Math.max(ay, by);
  const gx0 = Math.floor((sMinX - marge - ox) / taille);
  const gx1 = Math.floor((sMaxX + marge - ox) / taille);
  const vertical = sMaxX - sMinX < 1e-9;
  for (let gx = gx0; gx <= gx1; gx++) {
    let yLo: number, yHi: number;
    if (vertical) {
      yLo = sMinY; yHi = sMaxY;
    } else {
      // the x window of this column, widened by the margin, then clipped to the segment itself
      const lo = Math.max(sMinX, ox + gx * taille - marge);
      const hi = Math.min(sMaxX, ox + (gx + 1) * taille + marge);
      if (lo > hi) continue;
      const pente = (by - ay) / (bx - ax);
      const y1 = ay + (lo - ax) * pente, y2 = ay + (hi - ax) * pente;
      yLo = Math.min(y1, y2); yHi = Math.max(y1, y2);
    }
    const gy0 = Math.floor((yLo - marge - oy) / taille);
    const gy1 = Math.floor((yHi + marge - oy) / taille);
    for (let gy = gy0; gy <= gy1; gy++) visite(gx, gy);
  }
}

/**
 * Pairs of segments that MIGHT properly intersect, in (i, j) order. A proper intersection lies on
 * both segments, hence in a cell both pass through: dropping the rest cannot lose a node.
 */
function pairesCandidates(segs: readonly Segment[]): Array<[number, number]> {
  const S = segs.length;
  const b = boiteDesSegments(segs);
  const cote = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1);
  const G = Math.max(1, Math.min(512, Math.ceil(Math.sqrt(S))));
  const taille = Math.max(2 * V5_EPS, cote / G);
  const grille = new Map<number, number[]>();
  for (let i = 0; i < S; i++) {
    const s = segs[i]!;
    casesDuSegment(s[0][0], s[0][1], s[1][0], s[1][1], b.minX, b.minY, taille, V5_EPS,
      (gx, gy) => ajouter(grille, cleCase(gx, gy), i));
  }
  // Buckets are filled in increasing `i`, so `voisins[a]` only ever needs sorting, never a pass to
  // reorder pairs: duplicates land next to each other.
  const voisins: number[][] = [];
  for (const bucket of grille.values()) {
    for (let x = 0; x < bucket.length; x++) {
      const a = bucket[x]!;
      let l = voisins[a];
      if (!l) { l = []; voisins[a] = l; }
      for (let y = x + 1; y < bucket.length; y++) l.push(bucket[y]!);
    }
  }
  const paires: Array<[number, number]> = [];
  for (let i = 0; i < S; i++) {
    const l = voisins[i];
    if (!l) continue;
    l.sort((p, q) => p - q);
    let prev = -1;
    for (const j of l) {
      if (j === prev) continue;
      prev = j;
      paires.push([i, j]);
    }
  }
  return paires;
}

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
  // Buckets of exactly 2*V5_EPS: a merge query covers [x-eps, x+eps], i.e. at most 2 buckets per
  // axis. The answer is the SMALLEST matching index, which is what the linear scan returned; the
  // exact tolerance test is unchanged, so a node at exactly +/-V5_EPS still merges as before.
  const grilleNoeuds = new Map<number, number[]>();
  const nodeAt = (x: number, y: number): number => {
    const gx0 = Math.floor(x - V5_EPS), gx1 = Math.floor(x + V5_EPS);
    const gy0 = Math.floor(y - V5_EPS), gy1 = Math.floor(y + V5_EPS);
    let trouve = -1;
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const bucket = grilleNoeuds.get(cleCase(gx, gy));
        if (!bucket) continue;
        for (const i of bucket) {
          if (trouve >= 0 && i > trouve) continue;
          const n = nodes[i]!;
          if (Math.abs(n[0] - x) <= V5_EPS && Math.abs(n[1] - y) <= V5_EPS) trouve = i;
        }
      }
    }
    if (trouve >= 0) return trouve;
    const nx = v5R2(x), ny = v5R2(y);
    nodes.push([nx, ny]);
    ajouter(grilleNoeuds, cleCase(Math.floor(nx), Math.floor(ny)), nodes.length - 1);
    return nodes.length - 1;
  };
  segs.forEach((s) => { nodeAt(s[0][0], s[0][1]); nodeAt(s[1][0], s[1][1]); });
  for (const [i, j] of pairesCandidates(segs)) {
    const p = v5SegInt(segs[i]![0], segs[i]![1], segs[j]![0], segs[j]![1]);
    if (p) nodeAt(p[0], p[1]);
  }
  report.nodes = nodes.length;

  // --- 3: split + deduplication ---
  // The key is `min*N + max` rather than "min|max": a NUMBER, so a plan of 80 000 edges no longer
  // builds 80 000 strings just to notice it already has the edge. The map is still keyed one entry
  // per undirected edge and still filled in the same order, which is what the faces walk reads.
  const NN = nodes.length;
  const edges = new Map<number, [number, number]>();
  const addEdge = (u: number, v: number): void => {
    if (u === v) return;
    const lo = u < v ? u : v, hi = u < v ? v : u;
    const k = lo * NN + hi;
    if (!edges.has(k)) edges.set(k, [lo, hi]);
  };
  // Second index, over the FINAL nodes: the split only ever needs the nodes within V5_EPS of the
  // segment, and it used to rescan all of them for every segment. Cell size follows the density,
  // so a bucket holds a handful of nodes whatever the plan's extent.
  const bn = boiteDesSegments(nodes.map((n) => [n, n] as Segment));
  const coteN = Math.max(bn.maxX - bn.minX, bn.maxY - bn.minY, 1);
  const GN = Math.max(1, Math.min(1024, Math.ceil(Math.sqrt(nodes.length))));
  const tailleN = Math.max(2 * V5_EPS, coteN / GN);
  const grilleSplit = new Map<number, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    ajouter(grilleSplit, cleCase(
      Math.floor((n[0] - bn.minX) / tailleN),
      Math.floor((n[1] - bn.minY) / tailleN),
    ), i);
  }
  segs.forEach((s) => {
    const ax = s[0][0], ay = s[0][1], bx = s[1][0], by = s[1][1];
    const L2 = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
    if (L2 < V5_EPS * V5_EPS) return;
    const on: Array<{ ni: number; t: number }> = [];
    casesDuSegment(ax, ay, bx, by, bn.minX, bn.minY, tailleN, V5_EPS, (gx, gy) => {
      const bucket = grilleSplit.get(cleCase(gx, gy));
      if (!bucket) return;
      for (const ni of bucket) {
        const n = nodes[ni]!;
        const c = closestOnSeg(n[0], n[1], ax, ay, bx, by);
        if (c.dist <= V5_EPS) {
          const t = ((n[0] - ax) * (bx - ax) + (n[1] - ay) * (by - ay)) / L2;
          on.push({ ni, t: clamp(t, 0, 1) });
        }
      }
    });
    // The tie-break on the node index is what the previous stable sort over an index-ordered
    // array gave for free; the grid hands the nodes back in bucket order, so it is now stated.
    on.sort((p, q) => (p.t - q.t) || (p.ni - q.ni));
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
  const used = new Set<number>(); // directed half-edge `u*N + v`, a number for the same reason
  const faces: Pt[][] = [];
  const maxSteps = E.length * 2 + 8;
  for (const [u0, v0] of E) {
    for (const [su, sv] of [[u0, v0], [v0, u0]] as Array<[number, number]>) {
      if (used.has(su * NN + sv)) continue;
      const poly: Pt[] = [];
      let u = su, v = sv, steps = 0, ok = true;
      do {
        used.add(u * NN + v);
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
    // The pole is the one just computed: recomputing it below cost a second full pass over every
    // cell, and on a plan of more than 200 rooms the cache could not absorb it either.
    cells.push({ id: "c" + (cells.length + 1), poly, name: "", floor: "parquet", area, _px: c.x, _py: c.y });
  });
  // deterministic order: top->bottom then left->right of the pole
  cells.sort((a, b) => (a._py! - b._py!) || (a._px! - b._px!));
  cells.forEach((c, i) => { c.id = "c" + (i + 1); delete c._px; delete c._py; });
  return { cells, report };
}

// =================================================================================================
//  NAME / FLOOR PERSISTENCE, the cells are derived, the labels are not
// =================================================================================================
// Matching by largest (exact) area overlap, deterministic: every pair sorted by (decreasing
// overlap, previous index, new index) and consumed greedily.
// Fallback rescue by pole containment. The rest gets "Room N"/parquet.
//
// A NAME IS NEVER LOST WHILE ITS ORIGINAL CELL CAN STILL BE FOUND, AND AN EXACT TIE IS NOT AN
// ORDER OF ARRIVAL. When two old cells overlap a new one by exactly the same area, the tie-break
// used to be `(a.pi - b.pi)`: the smaller previous index, i.e. wherever the room happened to sit
// in an array. Measured on three rooms A|B|C split at x=100 and x=200 in a 400-wide outline:
// pushing the left partition to 250 gives 30000 with A and 30000 with B, A won because it was
// first, B became "Room 1", and bringing the partition back did NOT bring the name back.
//
// The tie is now settled by GEOMETRY, and only between old cells competing for the SAME new one
// (a name choosing its cell is the other direction, and is left alone): first the old cell whose
// POLE falls inside the new one, then the one whose area centroid is nearest. When even that ties
// exactly, the previous index still decides, because something has to.
//
// AND THE LOSER IS NOT THROWN AWAY. Two rooms merging into one cannot both keep their name, so
// the one not retained goes to `modele/photo-cellules.ts`'s purgatory and is offered back to any
// later recomputation whose cell CONTAINS its pole. That is what makes a two-gesture round trip
// (push, release, pull back) return all three names.

/** What we keep from a cell as it was BEFORE: its label and its shape, nothing else. */
export interface CellulePrecedente {
  name?: string | undefined;
  floor?: string | undefined;
  poly?: Pt[] | undefined;
}

export function v5AssignNames<T extends Cellule>(
  cells: T[],
  prev: readonly CellulePrecedente[] | null | undefined,
  secours?: readonly CellulePrecedente[] | null,
): T[] {
  const anciennes: readonly CellulePrecedente[] = Array.isArray(prev) ? prev : [];
  const pairs: Array<{ ci: number; pi: number; ov: number; rang: number }> = [];
  cells.forEach((c, ci) =>
    anciennes.forEach((p, pi) => {
      if (!p || !Array.isArray(p.poly) || p.poly.length < 3) return;
      const ov = v5OverlapArea(c.poly, p.poly);
      if (ov > V5_MIN_AREA) pairs.push({ ci, pi, ov, rang: 0 });
    }),
  );
  // `rang` only ever moves for a group of at least two old cells overlapping ONE new cell by
  // EXACTLY the same area: everywhere else it stays 0 and the order is the one that shipped.
  // Paying a pole and a centroid per pair would otherwise cost as much as the overlap itself.
  const groupes = new Map<string, Array<{ ci: number; pi: number; ov: number; rang: number }>>();
  for (const pr of pairs) {
    const k = pr.ci + "|" + pr.ov;
    const g = groupes.get(k);
    if (g) g.push(pr); else groupes.set(k, [pr]);
  }
  for (const g of groupes.values()) {
    if (g.length < 2) continue;
    const cible = cells[g[0]!.ci]!.poly;
    const centre = polyCentroid(cible);
    const mesure = g.map((pr) => {
      const p = anciennes[pr.pi]!.poly!;
      const pole = poleOfInaccessibility(p);
      const c = polyCentroid(p);
      return {
        pr,
        dedans: pointInPoly(pole.x, pole.y, cible) ? 0 : 1,
        dist: Math.hypot(c.x - centre.x, c.y - centre.y),
      };
    });
    mesure.sort((a, b) => (a.dedans - b.dedans) || (a.dist - b.dist) || (a.pr.pi - b.pr.pi));
    mesure.forEach((m, i) => { m.pr.rang = i; });
  }
  pairs.sort((a, b) => (b.ov - a.ov) || (a.rang - b.rang) || (a.pi - b.pi) || (a.ci - b.ci));
  const takenC = new Set<number>(), takenP = new Set<number>();
  pairs.forEach((pr) => {
    if (takenC.has(pr.ci) || takenP.has(pr.pi)) return;
    takenC.add(pr.ci); takenP.add(pr.pi);
    cells[pr.ci]!.name = anciennes[pr.pi]!.name || "";
    cells[pr.ci]!.floor = anciennes[pr.pi]!.floor || "parquet";
  });
  // rescue: does the old cell's pole fall inside a new one that is still free?
  const secourir = (liste: readonly CellulePrecedente[], marque: ((pi: number) => void) | null): void => {
    liste.forEach((p, pi) => {
      if (!p || !Array.isArray(p.poly) || p.poly.length < 3) return;
      if (marque && takenP.has(pi)) return;
      const q = poleOfInaccessibility(p.poly);
      for (let ci = 0; ci < cells.length; ci++) {
        if (takenC.has(ci)) continue;
        if (pointInPoly(q.x, q.y, cells[ci]!.poly)) {
          takenC.add(ci);
          if (marque) marque(pi);
          cells[ci]!.name = p.name || "";
          cells[ci]!.floor = p.floor || "parquet";
          break;
        }
      }
    });
  };
  secourir(anciennes, (pi) => { takenP.add(pi); });
  // Then, and only then, the names no earlier recomputation managed to place: a room swept away by
  // one gesture and reopened by the next comes back named instead of coming back "Room N".
  if (secours && secours.length) secourir(secours, null);
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
  const secours = orphelinsCellules(plan);
  v5AssignNames(cells, prev, secours);
  // What the recomputation could NOT place goes to the purgatory, so the gesture that reopens the
  // room finds the name again. It is deliberately read from `prev` only: a name already waiting
  // stays waiting (`memoriserOrphelins` keeps it), and one that came back leaves the list.
  const gardes = new Set(cells.map((c) => c.name).filter(Boolean) as string[]);
  memoriserOrphelins(plan, prev.filter((p) => !!p.name && !gardes.has(p.name)), gardes);
  plan.cells = cells.map((c) => ({ id: c.id, poly: c.poly, name: c.name, floor: c.floor }));
  plan._report = report;
  return plan;
}
