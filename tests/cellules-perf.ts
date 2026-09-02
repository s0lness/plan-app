#!/usr/bin/env node
// =================================================================================================
//  CELL DETECTION: COST AND EQUIVALENCE — NO BROWSER (the geometry is PURE)
// =================================================================================================
// `v5RebuildCells` runs on EVERY frame of a geometry gesture and on every received op
// (AGENTS.md, "THE FLOOR FOLLOWS THE HAND"). That decision was taken on a 22-wall measurement
// (0.40 ms median), while the server accepts 2000 walls. Detection was quadratic twice over
// (`nodeAt` scanned every node, the split rescanned every node per segment), so the hand stopped
// following the floor long before the server's own limit.
//
//   node tests/cellules-perf.ts
//
//   perf_400_murs_croises          the reviewed case: 400 crossing partitions
//   perf_800_murs_croises          the same, doubled: the quadratic term used to show here
//   perf_2000_cloisons             the server's own ceiling, on a realistic room grid
//   pole_reutilise_le_meme_polygone   the pole cache no longer empties itself in one block
//   noeud_a_la_frontiere_de_tolerance the spatial index merges EXACTLY like the linear scan
//   equivalence_200_plans_aleatoires  200 seeded plans, old implementation as the oracle
//
// THE BOUNDS ARE DELIBERATELY WIDE. This machine runs up to six worktrees at once, so a tight
// bound would fail on someone else's build rather than on a regression. The real measurements
// live in the batch report; what is defended here is the ORDER OF MAGNITUDE.
//
// AND THEY ARE READ AGAINST THE OUTPUT, NOT THE INPUT. A grid of 400 CROSSING partitions is a plan
// of 32 761 rooms: whatever detection does, it has to produce, place and order 32 761 polygons, and
// that part is irreducibly linear in the number of cells (~16 us each, mostly the pole). Wall count
// alone therefore says nothing: 2000 partitions laid out as a real floor plan (T-junctions, 1024
// rooms) land two orders of magnitude below 400 crossing ones. What the quadratic passes cost is
// visible in the SHAPE: before this batch, doubling the walls multiplied the time by 5 to 9;
// it now multiplies it by the number of cells produced, and no more.
import type { DonneeDynamique } from "./_types.ts";
import { clamp, v5R2, V5_EPS, V5_MIN_AREA } from "../src/ts/noyau/nombres.ts";
import {
  closestOnSeg,
  pointInPoly,
  poleOfInaccessibility,
  simplifyRectilinear,
} from "../src/ts/geometrie/polygones.ts";
import { v5SegInt, v5SignedArea } from "../src/ts/modele/aires.ts";
import { v5DetectCells } from "../src/ts/modele/cellules.ts";
import type { Cellule, Mur, Pt, RapportDetection } from "../src/ts/partage/plan.ts";

let ok = 0, ko = 0;
const rates: string[] = [];
function test(nom: string, fn: (...args: DonneeDynamique[]) => DonneeDynamique): void {
  const fails: string[] = [];
  try {
    fn((c: DonneeDynamique, m: DonneeDynamique) => { if (!c) fails.push(String(m)); });
  } catch (e) {
    fails.push("EXCEPTION: " + ((e as Error)?.stack || e));
  }
  if (fails.length) { ko++; rates.push(nom); } else ok++;
  console.log(`  ${fails.length ? "FAIL " : "ok   "} ${nom}`);
  fails.forEach((f) => console.log("        - " + f));
}

// =================================================================================================
//  THE ORACLE: the implementation as it stood before this batch, kept PRIVATE to this file.
// =================================================================================================
// It is copied, not imported: the point of an oracle is that it does NOT change when the thing
// it watches changes. It stays here only as long as the rewritten detection has to prove it
// returns the same bytes; it is not a second implementation shipped to anybody.
type Segment = [Pt, Pt];
interface CelluleDetecteeRef extends Cellule { area: number }

function detectionDeReference(
  outline: readonly Pt[] | null | undefined,
  walls: readonly Mur[] | null | undefined,
): { cells: CelluleDetecteeRef[]; report: RapportDetection } {
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
    if (w.isOutline) return;
    if (Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) > V5_EPS) {
      segs.push([[w.a[0], w.a[1]], [w.b[0], w.b[1]]]);
    }
  });
  report.segments = segs.length;
  if (segs.length < 3) return { cells: [], report };

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

  const edges = new Map<string, [number, number]>();
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

  for (;;) {
    const deg = new Array<number>(nodes.length).fill(0);
    E.forEach((e) => { deg[e[0]]!++; deg[e[1]]!++; });
    const before = E.length;
    E = E.filter((e) => deg[e[0]]! > 1 && deg[e[1]]! > 1);
    report.pruned += before - E.length;
    if (E.length === before || !E.length) break;
  }
  if (E.length < 3) return { cells: [], report };

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
      let u = su, v = sv, steps = 0, okFace = true;
      do {
        used.add(u + ">" + v);
        poly.push(nodes[v]!);
        const list = adj[v]!;
        let ri = -1;
        for (let i = 0; i < list.length; i++) if (list[i]!.v === u) { ri = i; break; }
        if (ri < 0) { okFace = false; break; }
        const nx = list[(ri - 1 + list.length) % list.length]!.v;
        u = v; v = nx;
        if (++steps > maxSteps) { okFace = false; break; }
      } while (!(u === su && v === sv));
      if (okFace && poly.length >= 3) faces.push(poly);
    }
  }
  report.faces = faces.length;
  if (!faces.length) return { cells: [], report };

  let outer = 0, best = -1;
  faces.forEach((f, i) => { const a = Math.abs(v5SignedArea(f)); if (a > best) { best = a; outer = i; } });
  const cells: Array<CelluleDetecteeRef & { _px?: number; _py?: number }> = [];
  faces.forEach((f, i) => {
    if (i === outer) { report.dropped++; return; }
    let poly = simplifyRectilinear(f.map((p) => [v5R2(p[0]), v5R2(p[1])] as Pt), 0.05);
    if (poly.length < 3) { report.tiny++; return; }
    if (v5SignedArea(poly) < 0) poly = poly.slice().reverse();
    const area = Math.abs(v5SignedArea(poly));
    if (area < V5_MIN_AREA) { report.tiny++; return; }
    const c = poleOfInaccessibility(poly);
    if (O.length > 2 && !pointInPoly(c.x, c.y, O)) { report.outside++; return; }
    cells.push({ id: "c" + (cells.length + 1), poly, name: "", floor: "parquet", area });
  });
  cells.forEach((c) => { const p = poleOfInaccessibility(c.poly); c._px = p.x; c._py = p.y; });
  cells.sort((a, b) => (a._py! - b._py!) || (a._px! - b._px!));
  cells.forEach((c, i) => { c.id = "c" + (i + 1); delete c._px; delete c._py; });
  return { cells, report };
}

// =================================================================================================
//  GENERATED PLANS — never a real apartment, always a program
// =================================================================================================
const SPAN = 4000;
const CONTOUR: Pt[] = [[0, 0], [SPAN, 0], [SPAN, SPAN], [0, SPAN]];

/** `n` partitions CROSSING each other: half horizontal, half vertical, all spanning the outline. */
function grilleCroisee(n: number): Mur[] {
  const k = Math.floor(n / 2), step = SPAN / (k + 1), murs: Mur[] = [];
  for (let i = 1; i <= k; i++) {
    const y = Math.round(i * step);
    murs.push({ id: "h" + i, a: [0, y], b: [SPAN, y], t: 12, isOutline: false });
  }
  for (let i = 1; i <= k; i++) {
    const x = Math.round(i * step);
    murs.push({ id: "v" + i, a: [x, 0], b: [x, SPAN], t: 12, isOutline: false });
  }
  return murs;
}

/** `n` partitions, each ONE room edge: T-junctions everywhere, no proper crossing. A real floor plan. */
function grillePieces(n: number): Mur[] {
  let k = 2;
  while (2 * (k - 1) * k < n) k++;
  const step = SPAN / k, murs: Mur[] = [];
  for (let i = 1; i < k && murs.length < n; i++) {
    for (let j = 0; j < k && murs.length < n; j++) {
      const x = Math.round(i * step);
      murs.push({ id: "v" + i + "_" + j, a: [x, Math.round(j * step)], b: [x, Math.round((j + 1) * step)], t: 12, isOutline: false });
    }
  }
  for (let i = 1; i < k && murs.length < n; i++) {
    for (let j = 0; j < k && murs.length < n; j++) {
      const y = Math.round(i * step);
      murs.push({ id: "h" + i + "_" + j, a: [Math.round(j * step), y], b: [Math.round((j + 1) * step), y], t: 12, isOutline: false });
    }
  }
  return murs;
}

/** Best of `tours` runs, in ms: the machine is shared, the median would still carry a neighbour's build. */
function meilleur(tours: number, f: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < tours; i++) {
    const t0 = performance.now();
    f();
    const ms = performance.now() - t0;
    if (ms < best) best = ms;
  }
  return best;
}

// =================================================================================================
test("perf_400_murs_croises", (a: DonneeDynamique) => {
  const murs = grilleCroisee(400);
  const r = v5DetectCells(CONTOUR, murs);
  const ms = meilleur(3, () => v5DetectCells(CONTOUR, murs));
  console.log(`        400 murs croises: ${ms.toFixed(0)} ms (${r.report.nodes} noeuds, ${r.cells.length} cellules)`);
  a(r.cells.length > 30000, `le plan genere doit bien etre dense, vu ${r.cells.length} cellules`);
  a(ms < 1500, `400 murs doivent se detecter sous 1500 ms, vu ${ms.toFixed(0)} ms`);
});

test("perf_800_murs_croises", (a: DonneeDynamique) => {
  const murs = grilleCroisee(800);
  const ms = meilleur(2, () => v5DetectCells(CONTOUR, murs));
  console.log(`        800 murs croises: ${ms.toFixed(0)} ms`);
  a(ms < 8000, `800 murs doivent se detecter sous 8000 ms, vu ${ms.toFixed(0)} ms`);
});

test("perf_2000_cloisons", (a: DonneeDynamique) => {
  const murs = grillePieces(2000);
  const ms = meilleur(3, () => v5DetectCells(CONTOUR, murs));
  console.log(`        2000 cloisons (grille de pieces): ${ms.toFixed(0)} ms`);
  a(murs.length === 2000, `2000 murs attendus, vu ${murs.length}`);
  a(ms < 200, `le plafond du serveur doit se detecter sous 200 ms, vu ${ms.toFixed(0)} ms`);
});

// Le cache de pole se vidait EN BLOC au-dela de 200 entrees: sur un plan de plus de 200 pieces il
// ne servait donc plus jamais, et `v5DetectCells` recalculait chaque pole DEUX fois.
test("pole_reutilise_le_meme_polygone", (a: DonneeDynamique) => {
  const polys: Pt[][] = [];
  for (let i = 0; i < 600; i++) {
    const x = (i % 30) * 100, y = Math.floor(i / 30) * 100;
    polys.push([[x, y], [x + 80, y], [x + 80, y + 70], [x + 40, y + 90], [x, y + 70]]);
  }
  const froid = meilleur(1, () => { for (const p of polys) poleOfInaccessibility(p); });
  const chaud = meilleur(1, () => { for (const p of polys) poleOfInaccessibility(p); });
  console.log(`        600 poles: froid ${froid.toFixed(1)} ms, chaud ${chaud.toFixed(1)} ms`);
  a(chaud < froid / 4, `600 polygones deja vus doivent etre quasi gratuits, vu ${chaud.toFixed(1)} ms contre ${froid.toFixed(1)} ms a froid`);
});

// L'index spatial quantifie les coordonnees; un noeud a EXACTEMENT +/- la tolerance doit encore
// tomber sur le meme noeud qu'avec le balayage lineaire, y compris a cheval sur deux cases.
test("noeud_a_la_frontiere_de_tolerance", (a: DonneeDynamique) => {
  // Chaque paire pose un bout de mur juste a l'interieur (0.4 < V5_EPS) ou juste a l'exterieur
  // (0.6 > V5_EPS) de la tolerance, autour d'abscisses entieres (les frontieres de cases).
  for (const base of [100, 200.5, 300.999, 400.0001, -50]) {
    for (const d of [0, 0.4, 0.5, 0.6, 1.0]) {
      const murs: Mur[] = [
        { id: "w1", a: [base, 100], b: [base, 900], t: 12, isOutline: false },
        { id: "w2", a: [base + d, 900], b: [base + d + 600, 900], t: 12, isOutline: false },
        { id: "w3", a: [base - d, 500], b: [base + 700, 500], t: 12, isOutline: false },
      ];
      const contour: Pt[] = [[-200, 0], [1200, 0], [1200, 1200], [-200, 1200]];
      const vu = JSON.stringify(v5DetectCells(contour, murs));
      const attendu = JSON.stringify(detectionDeReference(contour, murs));
      a(vu === attendu, `base=${base} d=${d}: l'index spatial doit fusionner comme le balayage lineaire`);
    }
  }
});

// =================================================================================================
//  200 PLANS ALEATOIRES, GRAINE FIXE: l'ancienne implementation est l'oracle
// =================================================================================================
function graine(s: number): () => number {
  let t = s >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cloisons axiales, quelques obliques a 45 degres, croisements sans jonction, colineaires superposees, un mur qui depasse. */
function planAleatoire(rnd: () => number): { contour: Pt[]; murs: Mur[] } {
  const W = 400 + Math.round(rnd() * 600), H = 400 + Math.round(rnd() * 600);
  const contour: Pt[] = [[0, 0], [W, 0], [W, H], [0, H]];
  const murs: Mur[] = [];
  const q = (v: number): number => Math.round(v * 4) / 4; // du quart de cm: des bouts qui ne collent pas pile
  const n = 2 + Math.floor(rnd() * 9);
  for (let i = 0; i < n; i++) {
    const r = rnd();
    if (r < 0.45) {
      const x = q(rnd() * W);
      murs.push({ id: "w" + i, a: [x, q(rnd() * H)], b: [x, q(rnd() * H)], t: 12, isOutline: false });
    } else if (r < 0.8) {
      const y = q(rnd() * H);
      murs.push({ id: "w" + i, a: [q(rnd() * W), y], b: [q(rnd() * W), y], t: 12, isOutline: false });
    } else {
      const x0 = q(rnd() * W), y0 = q(rnd() * H), L = q(50 + rnd() * 300), s = rnd() < 0.5 ? 1 : -1;
      murs.push({ id: "w" + i, a: [x0, y0], b: [x0 + L, y0 + s * L], t: 12, isOutline: false });
    }
  }
  // un mur qui DEPASSE le contour
  murs.push({ id: "dehors", a: [-80, q(rnd() * H)], b: [W + 80, q(rnd() * H)], t: 12, isOutline: false });
  // deux murs COLINEAIRES superposes
  const yc = q(rnd() * H);
  murs.push({ id: "col1", a: [q(rnd() * W * 0.5), yc], b: [W, yc], t: 12, isOutline: false });
  murs.push({ id: "col2", a: [0, yc], b: [q(W * 0.5 + rnd() * W * 0.5), yc], t: 12, isOutline: false });
  // deux murs qui se CROISENT sans partager de bout
  const xc = q(rnd() * W), yd = q(rnd() * H);
  murs.push({ id: "x1", a: [xc, 0], b: [xc, H], t: 12, isOutline: false });
  murs.push({ id: "x2", a: [0, yd], b: [W, yd], t: 12, isOutline: false });
  return { contour, murs };
}

test("equivalence_200_plans_aleatoires", (a: DonneeDynamique) => {
  const rnd = graine(20260902);
  let differents = 0, premiereDiff = "";
  let cellules = 0;
  for (let i = 0; i < 200; i++) {
    const { contour, murs } = planAleatoire(rnd);
    const vu = v5DetectCells(contour, murs);
    const attendu = detectionDeReference(contour, murs);
    cellules += attendu.cells.length;
    const sv = JSON.stringify(vu), sa = JSON.stringify(attendu);
    if (sv !== sa) {
      differents++;
      if (!premiereDiff) premiereDiff = `plan #${i}\n          murs=${JSON.stringify(murs)}\n          vu=${sv.slice(0, 400)}\n          attendu=${sa.slice(0, 400)}`;
    }
  }
  a(cellules > 400, `les plans generes doivent contenir de vraies cellules, vu ${cellules} au total`);
  a(differents === 0, `${differents} plans sur 200 different de l'oracle. ${premiereDiff}`);
});

// -------------------------------------------------------------------------------------------------
console.log(`\n${ko ? `FAILURES ${ko}/${ok + ko}` : `OK ${ok}/${ok}`}`);
rates.forEach((n) => console.log("  FAIL " + n));
process.exit(ko ? 1 : 0);
