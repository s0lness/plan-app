// src/ts/modele/edition.ts — THE EDITING GEOMETRY: what moves when you trace, drag, or place.
// Porté de src/js/52-v5-geometrie-edition.js, the half that was NOT already in `modele/murs.ts`
// (that one holds only the functions with no slate and no neighbors: `v5Seg`, `v5WallById`,
// `v5SameSegment`, `v5DedupeWalls`, `v5OpeningSameSlot`, `v5OpeningDepthMax`/`For`,
// `v5ClampOpeningsOfWall`, `v5WallDeleteVerdict`, `v5OpeningEdgeLimits`, `v5OpeningBox`,
// `v5CellsAt`). None of that is re-declared here: it is imported.
//
// THE INVARIANTS THIS FILE HOLDS, and every one of them was paid for by an incident:
//   G-6  a clamp can NEVER move something farther away (`clampCenterToInset`: an iteration that
//        does not improve the penetration is discarded; without this guard the sofa jumped 372 cm);
//   G-7  what was already overflowing keeps its overflow (`tol`, `opts.gardeOrphelin`);
//   G-8  no mass renormalization (`v5ClampPieces` touches ONLY orphans) and the banner belongs to
//        the AUTHOR of the gesture (`v5NoteForeignOrphans`);
//   G-16 an opening's depth is bounded by its wall's thickness (`v5MoveOpeningTo`,
//        `v5PlaceWallMount`, `v5PasteWallMount`, via `v5OpeningDepthFor`).
//
// ---- WHAT THE PORT CHANGES, AND NOTHING ELSE -----------------------------------------------------
// 1. THE PLAN IS AN ARGUMENT. The old code read `state.plan` through the closure. Here every
//    function receives `P`. This is not cosmetic: these functions are called with the LIVE plan
//    by the author of a gesture and with a DATA plan on replay.
// 2. NO SCREEN EFFECTS. Where the old code called `toast(...)`, `render()`, `save()`, `v5Touch()`,
//    `selReplace()`, or `openInspector()`, we RETURN the data and the caller decides. The four
//    `v5Flush*` functions therefore return the message TEXT (or `null`), to display with
//    `{geste:true}` as the old code did; `v5ClampPieces` returns both its count AND its message
//    (that message never carried `{geste:true}`).
// 3. THE SLATES REMAIN MODULE-LEVEL VARIABLES, as before, but they are now read only through an
//    exported accessor (`v5LastFit()`, `v5LastRefus()`, ...).
// 4. WHAT DEPENDED ON THE VIEW BECOMES A PARAMETER. `wallSnapReach()` (js/05) and `vScale` depend
//    on the zoom: `maxDist` and `echelle` are therefore REQUIRED, never guessed. `state.opts.snap`
//    becomes `snap`. The visibility layers are a PERSONAL setting: they are passed in too.
//
// ---- A DELIBERATE BORROW, AND WHY --------------------------------------------------------------
// `v5ResolveOpening` comes from js/53 (tools batch), but placing, pasting, and moving an opening
// all three call it: it is PURE, it is ported here and EXPORTED, so the tools batch can import it
// instead of making yet another copy. `clampCenterToInset` (js/19), by contrast, already has an
// owner (`gestes/contraintes.ts`): it is imported from there.

import { clamp, v5R2, WALL } from "../noyau/nombres.ts";
import {
  isWallMount,
  pieceVisible,
  TYPEMAP,
  type CalquesVisibles,
  type ItemCatalogue,
} from "../catalogue/catalogue.ts";
import { closestOnSeg, nearestOnPoly, poleOfInaccessibility, pointInPoly } from "../geometrie/polygones.ts";
import { clampCenterToInset } from "../gestes/contraintes.ts";
import { v5LineKey, v5SameLine } from "./conversion.ts";
import {
  v5CellsAt,
  v5ClampOpeningsOfWall,
  v5OpeningDepthFor,
  v5OpeningDepthMax,
  v5OpeningSameSlot,
  v5Seg,
  v5WallById,
  v5WallDeleteVerdict,
  type ChangementOuverture,
  type SegmentMur,
} from "./murs.ts";
import type { Cellule, Id, Meuble, Mur, Ouverture, PlanV5, Pt } from "../partage/plan.ts";
import { v5NewId } from "../fil/identite.ts";

/**
 * Is the plan usable? (valid outline). `v5On()` from js/51, without the global: false only on a
 * broken state.
 */
function planUtilisable(P: PlanV5 | null | undefined): boolean {
  return !!P && Array.isArray(P.outline) && P.outline.length > 2;
}

// =================================================================================================
//  IDENTIFIER FOR A DERIVED ENTITY (js/51)
// =================================================================================================
// Identifier for a DERIVED entity, which both devices recompute identically from the same
// geometry (outline walls, a mirror of the outline's edges). Here the collision IS the intended
// behavior: without it, a received `outline.set` would spawn a second outline wall on the peer's
// side carrying a different identifier, and the two plans would diverge. Hence no device tag: just
// local numbering, as before.
// Ported here because `v5SyncOutlineWalls` depends on it and `fil/pseudo-fil.ts` does not carry it
// yet; `v5NewId`, by contrast, depends on the socket and on `sessionStorage`, and remains an
// injected FACTORY (see `FabriqueOuverture`).

export function v5DerivedId(P: PlanV5 | null | undefined, prefix: string): Id {
  const p = P || ({} as Partial<PlanV5>);
  const used = new Set<string>();
  const listes: { id: Id }[][] = [p.walls || [], p.openings || [], p.pieces || [], p.cells || []];
  for (const l of listes) for (const e of l) used.add(String(e.id));
  let n = 1, id: string;
  do { id = prefix + (n++); } while (used.has(id));
  return id;
}

// =================================================================================================
//  BARRIERS, RAYS, LINES
// =================================================================================================

/** An edge that STOPS something. `outline:true` = an outline edge (only it TRIMS). */
export interface Barriere {
  a: Pt;
  b: Pt;
  outline: boolean;
  /** cm: the barrier's THICKNESS. A wall is a band, not a line, and a hand aims at the band. */
  t: number;
}

// "Barrier" segments: outline edges + interior walls (except `excludeId`).
// `outline:true` marks the OUTLINE: only it TRIMS a wall (a wall never leaves the apartment).
// Interior walls, on the other hand, STOP an endpoint that runs into them, and nothing more: a
// wall they cross through its middle is not cut.
type ExclusionMurs = Id | readonly Id[] | null | undefined;

const idsMursExclus = (excludeId: ExclusionMurs): Set<string> => new Set(
  Array.isArray(excludeId) ? excludeId.map(String) : (excludeId == null ? [] : [String(excludeId)]),
);

export function v5Barriers(P: PlanV5 | null | undefined, excludeId: ExclusionMurs): Barriere[] {
  const out: Barriere[] = [];
  if (!P) return out;
  const exclus = idsMursExclus(excludeId);
  const O = P.outline || [];
  for (let i = 0; i < O.length; i++) {
    const a = O[i]!, b = O[(i + 1) % O.length]!;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1) out.push({ a, b, outline: true, t: WALL });
  }
  (P.walls || []).forEach((w) => {
    if (w.isOutline || exclus.has(String(w.id))) return;
    out.push({ a: w.a, b: w.b, outline: false, t: w.t || WALL });
  });
  return out;
}

export interface CroisementRayon {
  t: number;
  outline: boolean;
}

// Every crossing along the ray (ox,oy)+t*(ux,uy), sorted by increasing t. `tMin` allows looking a
// touch BACKWARD: an overshoot of two centimeters must snap back to the junction it just crossed,
// not run off to the far end of the apartment.
export function v5RayHits(
  P: PlanV5 | null | undefined,
  ox: number,
  oy: number,
  ux: number,
  uy: number,
  excludeId: Id | null | undefined,
  tMin?: number | null,
): CroisementRayon[] {
  const lo = (tMin == null ? 0.5 : tMin);
  const out: CroisementRayon[] = [];
  v5Barriers(P, excludeId).forEach((s) => {
    const a = s.a, b = s.b;
    const rx = b[0] - a[0], ry = b[1] - a[1];
    const den = ux * ry - uy * rx;
    if (Math.abs(den) < 1e-9) return;
    const t = ((a[0] - ox) * ry - (a[1] - oy) * rx) / den;
    const u = ((a[0] - ox) * uy - (a[1] - oy) * ux) / den;
    if (t >= lo && u >= -1e-6 && u <= 1 + 1e-6) out.push({ t, outline: !!s.outline });
  });
  out.sort((p, q) => p.t - q.t);
  return out;
}

// =================================================================================================
//  A v5 WALL RUNS THROUGH, AND IT DOES SO OVER ITS ENTIRE LENGTH
// =================================================================================================
// BUSINESS DECISION. Each endpoint is pushed out to the first geometry encountered BEYOND itself
// (a T-junction), and trimmed by the OUTLINE if it goes past it. What crosses the wall BETWEEN
// its two endpoints no longer shortens it.
// The ray used to start from the wall's MIDPOINT and stop at the first crossing: any wall crossed
// anywhere other than exactly at its midpoint was therefore truncated on the next drag, a room
// vanished, silently. Starting from the ENDPOINT makes the crossing (an off-center T, a cross, or
// multiple crossings) have no effect, and the operation idempotent.

/** cm: an overshoot of less than 2 cm snaps back to the junction it crossed */
export const V5_JOIN_TOL = 2;

export function v5ThroughEnd(
  P: PlanV5 | null | undefined,
  w: Mur,
  s: SegmentMur,
  sign: number,
): Pt | null {
  const half = s.L / 2;
  const mx = (w.a[0] + w.b[0]) / 2, my = (w.a[1] + w.b[1]) / 2;
  const ux = s.ux * sign, uy = s.uy * sign;
  const ex = (sign > 0 ? w.b[0] : w.a[0]), ey = (sign > 0 ? w.b[1] : w.a[1]);
  // 1. EXTENSION: first barrier seen from the endpoint (t~0 => it already touches there, we do
  //    not move; no barrier => we do not extend on this side).
  let ext: number | null = null;
  const fromEnd = v5RayHits(P, ex, ey, ux, uy, w.id, -V5_JOIN_TOL);
  if (fromEnd.length) ext = half + fromEnd[0]!.t;
  // 2. TRIM: a wall never leaves the outline.
  let trim: number | null = null;
  const fromMid = v5RayHits(P, mx, my, ux, uy, w.id, 0.5);
  for (const h of fromMid) { if (h.outline) { trim = h.t; break; } }
  const t = (ext != null && trim != null) ? Math.min(ext, trim) : (ext != null ? ext : trim);
  if (t == null || !isFinite(t) || t <= 0.5) return null;
  return [v5R2(mx + ux * t), v5R2(my + uy * t)];
}

/**
 * TRIM ONLY: every endpoint that LEAVES the outline is brought back onto it, and nothing else
 * moves. Serves free-standing partitions, which keep their ends but are not allowed to overflow
 * the home.
 */
function v5TrimWall(P: PlanV5 | null | undefined, w: Mur, s: SegmentMur): Mur {
  const poly = P && Array.isArray(P.outline) ? P.outline : null;
  if (!poly || poly.length < 3) return w;
  for (const sign of [1, -1] as const) {
    const ux = s.ux * sign, uy = s.uy * sign;
    const ex = (sign > 0 ? w.b[0] : w.a[0]), ey = (sign > 0 ? w.b[1] : w.a[1]);
    if (pointInPoly(ex, ey, poly)) continue;          // this end is inside: leave it alone
    // THE RAY STARTS FROM THE OTHER END, NOT THE MIDPOINT. When an endpoint is far outside, the
    // wall's MIDPOINT can be outside too: a ray cast from there never crosses the outline going
    // outward again, and the trim would not happen. The other end, on the other hand, is the only
    // point we know is on the right side when there is still something to trim.
    const ox = (sign > 0 ? w.a[0] : w.b[0]), oy = (sign > 0 ? w.a[1] : w.b[1]);
    if (!pointInPoly(ox, oy, poly)) continue;         // BOTH ends outside: we do not guess
    const hits = v5RayHits(P, ox, oy, ux, uy, w.id, 0.5);
    let t: number | null = null;
    for (const h of hits) { if (h.outline) { t = h.t; break; } }
    if (t == null || !isFinite(t) || t <= 0.5) continue;
    const p: Pt = [v5R2(ox + ux * t), v5R2(oy + uy * t)];
    if (sign > 0) w.b = p; else w.a = p;
  }
  return w;
}

/** Mutates `w`: both endpoints are recomputed. Returns the wall, as the old code did. */
export function v5ThroughWall(P: PlanV5 | null | undefined, w: Mur): Mur {
  const s = v5Seg(w);
  // A FREE-STANDING PARTITION DOES NOT EXTEND. It is still TRIMMED by the outline (free does not
  // mean "allowed to leave the home"), but no endpoint is pushed out looking for a barrier: that
  // is exactly what makes it stay where it was placed.
  if (w.free) return v5TrimWall(P, w, s);
  const nb = v5ThroughEnd(P, w, s, 1), na = v5ThroughEnd(P, w, s, -1);
  if (nb) w.b = nb;
  if (na) w.a = na;
  return w;
}

// Does a wall ALREADY carry the segment a->b? (same support line within `tol`, and at least 60%
// of the requested length already covered). Serves to refuse a second stroke on an existing
// partition: two strokes at the same spot = two overlapping walls, the second invisible, and
// "Delete wall" only removes one (see `v5DedupeWalls`, modele/murs.ts).
export function v5WallCovering(
  P: PlanV5 | null | undefined,
  a: Pt,
  b: Pt,
  tol?: number,
): Mur | null {
  if (!P) return null;
  const t = (tol == null ? 4 : tol);
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
  if (L < 1) return null;
  const ux = dx / L, uy = dy / L;
  for (const w of (P.walls || [])) {
    if (w.isOutline) continue;
    const s = v5Seg(w);
    if (Math.abs(s.ux * uy - s.uy * ux) > 0.035) continue;               // not collinear (~2°)
    const d1 = Math.abs((w.a[0] - a[0]) * (-uy) + (w.a[1] - a[1]) * ux);
    const d2 = Math.abs((w.b[0] - a[0]) * (-uy) + (w.b[1] - a[1]) * ux);
    if (d1 > t || d2 > t) continue;
    const t1 = (w.a[0] - a[0]) * ux + (w.a[1] - a[1]) * uy, t2 = (w.b[0] - a[0]) * ux + (w.b[1] - a[1]) * uy;
    const lo = Math.max(0, Math.min(t1, t2)), hi = Math.min(L, Math.max(t1, t2));
    if (hi - lo >= L * 0.6) return w;
  }
  return null;
}

// Outline walls = mirror of the outline's edges (support for exterior windows/outlets).
// Rematched by support line so openings survive an outline move.
// Mutates `P`: `P.walls` is rewritten (interior walls first, outline walls next) and the openings
// of vanished outline walls are carried away with them.
export function v5SyncOutlineWalls(P: PlanV5 | null | undefined): void {
  if (!P) return;
  const O = P.outline || [], n = O.length;
  const old = (P.walls || []).filter((w) => w.isOutline);
  const inner = (P.walls || []).filter((w) => !w.isOutline);
  const taken = new Set<Mur>(), keep: Mur[] = [];
  for (let i = 0; i < n; i++) {
    const a = O[i]!, b = O[(i + 1) % n]!;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1) continue;
    // APPARIE PAR RECOUVREMENT, PAS PAR DROITE. Deux aretes COLINEAIRES, ce qui arrive des qu'on
    // coupe une facade en deux, portent la MEME cle de droite: la premiere prenait l'ancien mur et
    // la seconde ramassait un mur de facade quelconque parmi les restants. Les ouvertures suivant
    // l'identifiant du mur et non la geometrie, une fenetre changeait de facade en silence.
    // On prend donc, parmi les murs restes sur la meme droite, celui qui RECOUVRE le plus cette
    // arete; la moitie qui n'en herite pas recoit un identifiant derive neuf, et
    // `v5RelogerOuverturesContour` (plus bas) redistribue les ouvertures par la geometrie.
    const k = v5LineKey(a, b);
    const ux = b[0] - a[0], uy = b[1] - a[1];
    const L = Math.hypot(ux, uy) || 1e-9;
    const proj = (q: Pt): number => ((q[0] - a[0]) * ux + (q[1] - a[1]) * uy) / L;
    let w: Mur | undefined, meilleur = -1;
    for (const o of old) {
      if (taken.has(o) || !v5SameLine(v5LineKey(o.a, o.b), k, 6)) continue;
      const t0 = proj(o.a), t1 = proj(o.b);
      const recouvre = Math.max(0, Math.min(L, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1)));
      if (recouvre > meilleur) { meilleur = recouvre; w = o; }
    }
    if (!w) w = old.find((o) => !taken.has(o));
    if (w) { taken.add(w); w.a = [a[0], a[1]]; w.b = [b[0], b[1]]; w.t = w.t || WALL; }
    // OUTLINE wall: an entity derived from the outline, recomputed identically on both sides ->
    // identifier WITHOUT a device tag (see v5DerivedId, js/51).
    else w = { id: v5DerivedId(P, "w"), a: [a[0], a[1]], b: [b[0], b[1]], t: WALL, isOutline: true };
    keep.push(w);
  }
  // UNE FACADE QUI DISPARAIT NE PART PLUS AVEC SES OUVERTURES SANS UN MOT. Ce bloc les SUPPRIMAIT
  // toutes, en silence: supprimer un coin du contour (`v5DeleteVertex`) fait disparaitre une arete,
  // donc son mur, donc la fenetre, la porte et la prise qui etaient dessus. Et le cas le plus
  // ordinaire est le plus destructeur: ressouder les deux moities d'une facade coupee, c'est
  // exactement retirer un sommet plat, et l'arete fusionnee passe pile ou etaient les ouvertures.
  // Elles sont donc RELOGEES par la geometrie, comme apres une coupe, et seules celles qui ne
  // retrouvent aucun mur porteur sont supprimees, en le disant (ardoise `orpheline`, deja lue par
  // `v5FlushOpeningsBorned`).
  const gone = old.filter((o) => !taken.has(o));
  P.walls.length = 0;
  inner.forEach((w) => P.walls.push(w));
  keep.forEach((w) => P.walls.push(w));
  v5RelogerOuverturesContour(P, keep, gone);
}

/**
 * REDISTRIBUE LES OUVERTURES DE FACADE PAR LA GEOMETRIE, apres que les murs de contour ont ete
 * recalcules. Une ouverture appartient a un mur par son IDENTIFIANT et une distance le long de
 * lui; quand une facade est coupee en deux, la moitie qui garde l'identifiant ne contient plus
 * forcement la fenetre. Sans ce passage, la fenetre reste attachee a un mur trop court et se
 * retrouve ecrasee a son extremite.
 *
 * On travaille sur la POSITION REELLE de l'ouverture, pas sur son `t0`: on la place sur le mur de
 * contour qui contient son milieu, et on recalcule `t0` par projection. Une ouverture qui ne
 * retrouve aucun mur reste ou elle est, c'est le comportement d'avant et il ne perd rien.
 *
 * `disparus` SONT LES FACADES QUI VIENNENT DE S'EN ALLER, et leurs ouvertures passent par le meme
 * chemin plutot que par une seconde mecanique. Leur geometrie n'a PAS ete reecrite (ce sont
 * justement celles qu'aucune arete n'a reprises), donc leur position au sol est encore lisible: on
 * cherche qui reprend cet emplacement. Deux differences avec le cas d'une facade toujours la:
 *
 * - on cherche TOUJOURS un nouveau mur, meme quand l'ouverture tenait encore sur l'ancien: c'est
 *   l'ancien qui n'existe plus;
 * - la portee vaut une EPAISSEUR DE MUR au lieu de 2 cm. Ressouder deux moities colineaires met la
 *   nouvelle arete exactement sur l'ancienne (ecart nul), mais un contour redessine peut poser la
 *   facade qui reprend l'emplacement a un demi-mur de la, et une fenetre a 6 cm de son mur est
 *   toujours la fenetre de ce mur.
 *
 * Ce qui ne retrouve rien est SUPPRIME, et l'ardoise le dit avec son nombre (`orpheline`, le meme
 * verdict que pour un mur interieur efface sous une ouverture): la suppression silencieuse etait le
 * defaut.
 */
function v5RelogerOuverturesContour(P: PlanV5, contour: readonly Mur[], disparus: readonly Mur[] = []): void {
  const parId = new Map<string, Mur>(contour.map((w) => [String(w.id), w]));
  const partis = new Map<string, Mur>(disparus.map((w) => [String(w.id), w]));
  if (!parId.size && !partis.size) return;
  const perdues: ChangementOuverture[] = [];
  for (let i = (P.openings || []).length - 1; i >= 0; i--) {
    const o = P.openings[i]!;
    const actuel = parId.get(String(o.wallId)) || partis.get(String(o.wallId));
    if (!actuel) continue;                       // pas une ouverture de facade
    const disparu = !parId.has(String(o.wallId));
    const L = Math.hypot(actuel.b[0] - actuel.a[0], actuel.b[1] - actuel.a[1]) || 1e-9;
    const ux = (actuel.b[0] - actuel.a[0]) / L, uy = (actuel.b[1] - actuel.a[1]) / L;
    const tc = o.t0 + o.w / 2;
    const centre: Pt = [actuel.a[0] + ux * tc, actuel.a[1] + uy * tc];
    if (!disparu && tc >= 0 && tc <= L) continue; // elle tient encore sur son mur
    const portee = disparu ? Math.max(2, actuel.t || WALL) : 2;
    let cible: Mur | null = null, mieux = Infinity;
    for (const w of contour) {
      const c = closestOnSeg(centre[0], centre[1], w.a[0], w.a[1], w.b[0], w.b[1]);
      if (c.dist < mieux) { mieux = c.dist; cible = w; }
    }
    if (!cible || mieux > portee) {
      if (!disparu) continue;                    // son mur est la, elle y reste: rien n'est perdu
      P.openings.splice(i, 1);
      perdues.push({ id: String(o.id), name: o.name || "", quoi: "orpheline" });
      continue;
    }
    const cl = Math.hypot(cible.b[0] - cible.a[0], cible.b[1] - cible.a[1]) || 1e-9;
    const cux = (cible.b[0] - cible.a[0]) / cl, cuy = (cible.b[1] - cible.a[1]) / cl;
    const d = (centre[0] - cible.a[0]) * cux + (centre[1] - cible.a[1]) * cuy;
    o.wallId = cible.id;
    o.t0 = v5R2(clamp(d - o.w / 2, 0, Math.max(0, cl - o.w)));
  }
  if (perdues.length) ardoiseBorned = (ardoiseBorned || []).concat(perdues).slice(0, 50);
}

// =================================================================================================
//  WHAT DEPENDS ON A WALL FOLLOWS THAT WALL: THE GESTURE AUTHOR'S CLAMPING
// =================================================================================================
// Openings stay INSIDE their wall, on EVERY wall: this is the clamping done for the AUTHOR of a
// geometry gesture. What was moved or shrunk is remembered, and reported on release. The per-wall
// rule itself lives in `v5ClampOpeningsOfWall` (modele/murs.ts): PURE, MONOTONIC, NARROW.

let ardoiseBorned: ChangementOuverture[] | null = null;

/** The last clamping's slate, without clearing it (the old `v5LastBorned`). */
export function v5LastBorned(): ChangementOuverture[] | null {
  return ardoiseBorned;
}

export function v5ClampOpenings(P: PlanV5 | null | undefined): void {
  if (!P) return;
  const murs = new Set((P.openings || []).map((o) => String(o.wallId)));
  let chg: ChangementOuverture[] = [];
  murs.forEach((id) => { chg = chg.concat(v5ClampOpeningsOfWall(P, id)); });
  if (chg.length) ardoiseBorned = (ardoiseBorned || []).concat(chg).slice(0, 50);
}

/**
 * A clamp that MOVES or SHRINKS something gets reported, just as moving to a thinner wall already
 * does (`v5FlushOpeningThinned`). One single message per gesture, the first one named.
 * Returns the TEXT (the old code called `toast(texte,{geste:true})` right here) or `null`.
 */
export function v5FlushOpeningsBorned(): string | null {
  const l = ardoiseBorned;
  ardoiseBorned = null;
  if (!l || !l.length) return null;
  const r = l[0]!, quoi = r.name ? `“${r.name}”` : "an opening";
  const n = l.length > 1 ? ` (and ${l.length - 1} other${l.length > 2 ? "s" : ""})` : "";
  if (r.quoi === "aminci") return `This wall is thinner: ${quoi} goes from ${r.de} to ${r.a} cm deep${n}.`;
  if (r.quoi === "retrecie") return `This wall is shorter: ${quoi} goes from ${r.de} to ${r.a} cm wide${n}.`;
  if (r.quoi === "orpheline") return `The wall is gone: ${quoi} with it${n}.`;
  return `This wall is shorter: ${quoi} was brought back inside${n}.`;
}

// Would opening `op`, placed on face `side` of ITS wall, run into an object there? Returns the
// obstruction (the first one found) or null. Serves the refusal of "Changer de côté": the only
// way to create a stack on one face, once back-to-back is allowed.
export function v5OpeningBlockerOnSide(
  P: PlanV5 | null | undefined,
  op: Ouverture | null | undefined,
  side: 0 | 1,
  calques?: CalquesVisibles,
): Ouverture | null {
  if (!P || !op) return null;
  const vis = calques || {};
  const probe = { type: op.type, side };
  return (P.openings || []).find((q) => q !== op && String(q.wallId) === String(op.wallId)
    && v5OpeningSameSlot(probe, q) && pieceVisible(q, vis)
    && op.t0 < q.t0 + q.w && op.t0 + op.w > q.t0) || null;
}

// =================================================================================================
//  A PIECE OF FURNITURE STAYS IN ITS CELL (G-6, G-7)
// =================================================================================================
// The wall inset itself (`clampCenterToInset`, and the G-6 / G-7 guards it holds) belongs to
// `gestes/contraintes.ts` (js/19): it is IMPORTED, never recopied. A second version of that guard
// is exactly how the 372 cm sofa comes back.
//
// `v5LastFit` says whether the LAST clamped piece of furniture really fit in its cell: when it
// overflows, the gesture that just released it SAYS SO (js/17, js/16) instead of letting it go
// silently.
let ardoiseFit = true;

export function v5LastFit(): boolean {
  return ardoiseFit;
}

export interface OptionsClampPiece {
  /**
   * this piece of furniture was ALREADY outside a cell when the hand grabbed it. Bringing it back
   * to the nearest cell would be a mass correction disguised as a gesture: measured, a radiator
   * straddling a wall traveled 113 cm on the first drag, silently (js/17).
   */
  gardeOrphelin?: boolean | undefined;
}

/**
 * A piece of furniture stays inside ITS cell, inset by half a wall thickness. Mutates `p`.
 * `tol` (cm): penetration already tolerated before the gesture (`pieceTol`, js/19, which stays
 * with its owner: it is passed in as an argument, exactly as it is today).
 */
export function v5ClampPiece(P: PlanV5, p: Meuble, tol?: number, opts?: OptionsClampPiece): void {
  if (!planUtilisable(P) || isWallMount(p.type)) return;
  let cx = p.x + p.w / 2, cy = p.y + p.h / 2;
  let cell: Cellule | null = v5CellsAt(P, cx, cy);
  if (!cell && opts && opts.gardeOrphelin) { ardoiseFit = true; return; }
  if (!cell) {                                   // outside a cell: bring back to the nearest one
    let bd = Infinity;
    (P.cells || []).forEach((c) => {
      const np = nearestOnPoly(cx, cy, c.poly);
      if (np.dist < bd) { bd = np.dist; cell = c; }
    });
    if (cell) {
      const np = nearestOnPoly(cx, cy, (cell as Cellule).poly);
      const pl = poleOfInaccessibility((cell as Cellule).poly);
      const ix = pl.x - np.x, iy = pl.y - np.y;
      const m = Math.hypot(ix, iy) || 1;
      cx = np.x + ix / m * 2; cy = np.y + iy / m * 2;
    }
  }
  if (!cell) { ardoiseFit = true; return; }
  const r = clampCenterToInset(cx, cy, p.w, p.h, p.rot || 0, (cell as Cellule).poly, tol);
  ardoiseFit = (r.fits !== false);
  p.x = Math.round(r.cx - p.w / 2); p.y = Math.round(r.cy - p.h / 2);
}

// ---- WE NEVER RENORMALIZE SILENTLY (G-8) ---------------------------------------------------------
// `v5ClampPiece` is the INTERACTIVE clamp: it applies to the object that was just released, and it
// is allowed to push it against the wall. The MASS clamp, on the other hand, used to run on every
// structural change and sweep back over all 47 pieces of furniture in the plan: on the real plan,
// 16 of them jumped (up to 114 cm) because they had been placed before this inset existed. Only
// one was truly lost; the other 15 simply bit into the 6 cm inset by a few centimeters and were
// exactly where they were meant to be. Consequence: the plan shown on open was not the plan you
// had, and the first click rewrote it without a word.
// DECISION: the mass clamp now touches ONLY ORPHANED furniture (center in no cell: no room houses
// it anymore, a genuine repair), and it SAYS SO.
//
// ---- THE BANNER BELONGS TO THE AUTHOR OF THE GESTURE ----------------------------------------------
// The mass clamp runs on every LOCAL geometry gesture, but it also repairs furniture that a PEER's
// op just orphaned: that is what made the message erratic. Measured across three devices:
// "'Radiateur 3' is no longer in any room..." showed up on 2 screens out of 3, and sometimes on
// the one that had done nothing rather than on the author's, because whoever did the NEXT geometry
// gesture inherited the announcement.
// So we remember the orphans created by the wire (`v5NoteForeignOrphans`, called on receipt,
// js/43): their repair still happens, but SILENTLY. On the author's side, that same piece of
// furniture is already an orphan BEFORE its op leaves: it is that device, and only that device,
// that announces it.

const v5ForeignOrphans = new Set<string>();
const V5_FOREIGN_MAX = 500;

export function v5NoteForeignOrphans(P: PlanV5 | null | undefined): void {
  if (!P) return;
  (P.pieces || []).forEach((p) => {
    if (isWallMount(p.type)) return;
    if (!v5CellsAt(P, p.x + p.w / 2, p.y + p.h / 2)) v5ForeignOrphans.add(String(p.id));
  });
  while (v5ForeignOrphans.size > V5_FOREIGN_MAX) {
    v5ForeignOrphans.delete(v5ForeignOrphans.values().next().value as string);
  }
}

export interface BilanClampPieces {
  /** number of orphaned pieces of furniture repaired (what the old `v5ClampPieces()` returned) */
  perdus: number;
  /** the message to display, or null. Without `{geste:true}`: this banner never carried one. */
  message: string | null;
}

export function v5ClampPieces(P: PlanV5 | null | undefined): BilanClampPieces {
  if (!P) return { perdus: 0, message: null };
  const perdus = (P.pieces || []).filter((p) => !isWallMount(p.type) && !v5CellsAt(P, p.x + p.w / 2, p.y + p.h / 2));
  // Orphans inherited from a received op are repaired without a word: their author already said it.
  const miens = perdus.filter((p) => !v5ForeignOrphans.has(String(p.id)));
  perdus.forEach((p) => { v5ClampPiece(P, p); v5ForeignOrphans.delete(String(p.id)); });
  ardoiseFit = true;
  let message: string | null = null;
  if (miens.length) {
    message = miens.length === 1
      ? `“${miens[0]!.name || "A piece"}” was no longer in any room: it was brought back inside.`
      : `${miens.length} pieces were no longer in any room: they were brought back inside.`;
  }
  return { perdus: perdus.length, message };
}

// =================================================================================================
//  PLACING, PASTING, MOVING A WALL-MOUNTED OBJECT
// =================================================================================================

export interface MurLePlusProche {
  w: Mur;
  x: number;
  y: number;
  dist: number;
}

/**
 * Nearest wall to an apartment point (outline walls included), within `maxDist`.
 * `maxDist` is REQUIRED: the old `wallSnapReach()` fallback (js/05) depends on the current zoom,
 * hence on the VIEW. Letting this function guess it would make it impure without saying so.
 */
export function v5NearestWall(
  P: PlanV5 | null | undefined,
  x: number,
  y: number,
  maxDist: number,
): MurLePlusProche | null {
  if (!P) return null;
  let best: MurLePlusProche | null = null, bd = maxDist;
  (P.walls || []).forEach((w) => {
    const c = closestOnSeg(x, y, w.a[0], w.a[1], w.b[0], w.b[1]);
    if (c.dist <= bd) { bd = c.dist; best = { w, x: c.x, y: c.y, dist: c.dist }; }
  });
  return best;
}

// Which side of the wall the wall-mounted object must FACE (its local +y). side=0 => left normal
// n0=(-uy,ux) (see v5OpeningBox: rot = ang + 180*side, and the local +y of rot=ang equals n0).
// We take the CURSOR's side; on an outline wall (only one adjacent cell) we force the interior.
// `_w`: the old code takes the wall as an argument and NEVER reads it (everything goes through
// `s`). The parameter is kept so the call stays readable, prefixed so the compiler tolerates it.
export function v5WallMountSide(
  P: PlanV5 | null | undefined,
  _w: Mur,
  s: SegmentMur,
  px: number,
  py: number,
  x: number,
  y: number,
): 0 | 1 {
  const n0 = { x: -s.uy, y: s.ux };
  let side: 0 | 1 = (((x - px) * n0.x + (y - py) * n0.y) >= 0) ? 0 : 1;
  const off = WALL / 2 + 6;
  const cA = !!v5CellsAt(P, px + n0.x * off, py + n0.y * off);
  const cB = !!v5CellsAt(P, px - n0.x * off, py - n0.y * off);
  if (cA && !cB) side = 0; else if (cB && !cA) side = 1;
  return side;
}

// ---- TOOL 6: ANTI-OVERLAP SETTLING (js/53) ---------------------------------------------------------
// 1-D non-overlap between openings of the same family AND THE SAME FACE (`v5OpeningSameSlot`): a
// through opening (door/window) crosses the wall and blocks both faces, a surface device (wall
// light, outlet, RJ45) only blocks its own.
// PORTED HERE and exported even though it comes from js/53: placing, pasting, and moving an
// opening all three call it, and making yet another copy would be the second version of a rule
// that is only allowed to exist once.
export function v5ResolveOpening(
  P: PlanV5 | null | undefined,
  op: Ouverture,
  dir: number,
  calques?: CalquesVisibles,
): void {
  if (!P) return;
  const w = v5WallById(P, op.wallId);
  if (!w) return;
  const s = v5Seg(w), halfW = op.w / 2;
  let t = op.t0 + halfW;
  const vis = calques || {};
  const nbs: { lo: number; hi: number }[] = [];
  (P.openings || []).forEach((q) => {
    if (q === op || String(q.wallId) !== String(op.wallId)) return;
    if (!v5OpeningSameSlot(op, q) || !pieceVisible(q, vis)) return;
    nbs.push({ lo: q.t0, hi: q.t0 + q.w });
  });
  for (let pass = 0; pass < nbs.length + 1; pass++) {
    let hit: { lo: number; hi: number } | null = null;
    for (const nb of nbs) { if (t - halfW < nb.hi && t + halfW > nb.lo) { hit = nb; break; } }
    if (!hit) break;
    const toLeft = hit.lo - halfW, toRight = hit.hi + halfW;
    if (dir < 0) t = toLeft; else if (dir > 0) t = toRight;
    else t = (Math.abs(t - toLeft) <= Math.abs(t - toRight)) ? toLeft : toRight;
  }
  let bestGap = Infinity, bestT = t;
  for (const nb of nbs) {
    const gL = nb.lo - (t + halfW), gR = (t - halfW) - nb.hi;
    if (gL > 0 && gL < bestGap) { bestGap = gL; bestT = nb.lo - halfW; }
    if (gR > 0 && gR < bestGap) { bestGap = gR; bestT = nb.hi + halfW; }
  }
  if (bestGap > 0 && bestGap <= 6) t = bestT;
  op.t0 = v5R2(clamp(t - halfW, 0, Math.max(0, s.L - op.w)));
}

/**
 * WHAT PLACEMENT CANNOT MANUFACTURE ON ITS OWN.
 * `v5NewId` (js/51) draws a device tag from the realtime socket or from `sessionStorage`: this is
 * not a function of the plan, it cannot live here. `autoName` (js/07) numbers a name by looking at
 * `state.pieces`. Both are therefore INJECTED, and placement remains a pure function of the plan.
 */
export interface FabriqueOuverture {
  /** identifier unique per family, device tag included (`v5NewId`, js/51) */
  newId(prefix: string): Id;
  /** name free of duplicates (`autoName`, js/07) */
  autoName(base: string): string;
}

// Placing a wall-mounted object (door/window/wall light/outlet/RJ45) = creating a parametric
// OPENING on the nearest wall. Returns the created opening, or null if no wall is in reach.
// The old code chained `v5Touch(); selReplace(op.id); render(); openInspector();`: that is screen
// work, the caller handles it.
export function v5PlaceWallMount(
  P: PlanV5 | null | undefined,
  type: string,
  x: number,
  y: number,
  maxDist: number,
  fab: FabriqueOuverture,
  calques?: CalquesVisibles,
): Ouverture | null {
  if (!P) return null;
  const nw = v5NearestWall(P, x, y, maxDist);
  if (!nw) return null;
  const w = nw.w, s = v5Seg(w), t: Partial<ItemCatalogue> = TYPEMAP[type] || {};
  const want = t.w || 60;
  const ow = Math.min(want, s.L);
  // The wall is shorter than the object: we place what fits, and `v5FlushPlaceNarrowed` reports
  // it at the end of the gesture (js/16). Without that word, the door was born at 43 cm without
  // anything announcing it.
  ardoiseNarrowed = (ow < want - 0.5) ? { len: Math.round(s.L), want: Math.round(want), name: t.name || type } : null;
  const tc = (x - w.a[0]) * s.ux + (y - w.a[1]) * s.uy;
  const op: Ouverture = {
    id: fab.newId("o"), wallId: String(w.id),
    // The CATALOG depth (12 cm) is a default, not a user choice: on a thinner wall it follows the
    // wall, without a word (nothing chosen is lost).
    t0: v5R2(clamp(tc - ow / 2, 0, Math.max(0, s.L - ow))), w: ow, h: v5OpeningDepthFor(w, t.h || WALL), type,
    side: v5WallMountSide(P, w, s, nw.x, nw.y, x, y), name: fab.autoName(t.name || ""),
  };
  if (type === "door" || type === "sdoor") op.hinge = 0;
  if (type === "door") op.swing = 1;
  P.openings.push(op);
  v5ResolveOpening(P, op, 0, calques);
  return op;
}

/** What a paste knows about the copied object: its type, and the rest at best. */
export type SourceCollage = Pick<Ouverture, "type"> & Partial<Ouverture>;

// ---- PASTING A WALL-MOUNTED OBJECT -----------------------------------------------------------------
// A wall-mounted object has no coordinates: it belongs to a WALL (`wallId`, `t0`, `side`).
// "Pasting it at point P" therefore only makes sense by ATTACHING it to the wall nearest P,
// exactly as a drag or a placement from the palette does. We keep its width, depth, name, hinges,
// and swing direction; the FACE, on the other hand, is recomputed from the paste point, because
// that is the only thing the new wall can say. Returns the opening, or null if no wall is in
// reach (the caller SAYS SO).
export function v5PasteWallMount(
  P: PlanV5 | null | undefined,
  src: SourceCollage | null | undefined,
  x: number,
  y: number,
  maxDist: number,
  fab: FabriqueOuverture,
  calques?: CalquesVisibles,
): Ouverture | null {
  if (!P || !src) return null;
  const nw = v5NearestWall(P, x, y, maxDist);
  if (!nw) return null;
  const w = nw.w, s = v5Seg(w), t: Partial<ItemCatalogue> = TYPEMAP[src.type] || {};
  const want = src.w || t.w || 60;
  const ow = Math.min(want, s.L);
  ardoiseNarrowed = (ow < want - 0.5)
    ? { len: Math.round(s.L), want: Math.round(want), name: src.name || t.name || src.type }
    : null;
  const tc = (x - w.a[0]) * s.ux + (y - w.a[1]) * s.uy;
  const op: Ouverture = {
    id: fab.newId("o"), wallId: String(w.id),
    t0: v5R2(clamp(tc - ow / 2, 0, Math.max(0, s.L - ow))), w: ow,
    h: v5OpeningDepthFor(w, src.h || t.h || WALL), type: src.type,
    side: v5WallMountSide(P, w, s, nw.x, nw.y, x, y), name: fab.autoName(src.name || t.name || src.type),
  };
  if (src.hinge !== undefined) op.hinge = src.hinge;
  if (src.swing !== undefined) op.swing = src.swing;
  P.openings.push(op);
  v5ResolveOpening(P, op, 0, calques);
  return op;
}

// v5: bring opening `op` to the APARTMENT point (x,y). ONE single implementation, shared by
// pointer dragging, the keyboard arrow, and the test hook. No notion of room: we look for the
// nearest wall among ALL walls, we change `wallId` if another one is closer, we re-orient `side`
// onto the cursor's CELL (so the other face of the same wall flips the object), then we set t0.
// `dir` = direction of movement along the wall (for anti-overlap settling). Returns the opening.
// A wall that is TOO SHORT does not take the opening. Before, `op.w=Math.min(op.w,s.L)` shaved the
// door down to the length of the targeted wall: an 80 cm door briefly placed on a 43 cm stub of
// wall came back at 43 cm, PERMANENTLY (bringing it back home gave it nothing back, the desired
// width no longer existed anywhere). Since the server accepts no unknown key (live-worker/ops.ts),
// we cannot keep the desired width on the side: we therefore REFUSE the drop, and we say so.

/** last wall refused during the current gesture (for the end-of-gesture message) */
export interface RefusOuverture {
  len: number;
  need: number;
  name: string;
}

/** depth brought back down to the arrival wall's thickness (reported at the end) */
export interface AmincissementOuverture {
  t: number;
  avant: number;
  name: string;
}

let ardoiseRefus: RefusOuverture | null = null;
let ardoiseThinned: AmincissementOuverture | null = null;

export function v5LastRefus(): RefusOuverture | null {
  return ardoiseRefus;
}

export function v5LastThinned(): AmincissementOuverture | null {
  return ardoiseThinned;
}

export function v5OpeningFitsWall(op: Pick<Ouverture, "w">, w: Pick<Mur, "a" | "b">): boolean {
  return v5Seg(w).L + 0.5 >= op.w;
}

export function v5MoveOpeningTo(
  P: PlanV5 | null | undefined,
  op: Ouverture,
  x: number,
  y: number,
  dir: number,
  maxDist: number,
  calques?: CalquesVisibles,
): Ouverture | null {
  const nw = v5NearestWall(P, x, y, maxDist);
  if (nw && String(nw.w.id) !== String(op.wallId)) {
    if (v5OpeningFitsWall(op, nw.w)) op.wallId = String(nw.w.id);
    else ardoiseRefus = { len: Math.round(v5Seg(nw.w).L), need: Math.round(op.w), name: op.name || "" };
  }
  const w = v5WallById(P, op.wallId);
  if (!w) return null;
  // THE ARRIVAL WALL CAN BE THINNER. Depth belongs to the wall: it follows the wall DOWNWARD
  // (otherwise the object would overflow both sides of the new wall and repaint the floor), never
  // upward (nobody asked to thicken a window by moving it). This is not a refusal, unlike width: a
  // width is CHOSEN, a depth is dictated by the wall. It is reported on release
  // (v5FlushOpeningThinned), and Escape restores the previous depth (js/53).
  const hMax = v5OpeningDepthMax(w);
  if (Math.round(Number(op.h) || WALL) > hMax) {
    ardoiseThinned = { t: hMax, avant: Math.round(Number(op.h) || WALL), name: op.name || "" };
    op.h = hMax;
  }
  const s = v5Seg(w);
  if (op.type !== "door" && op.type !== "sdoor") {
    const c = closestOnSeg(x, y, w.a[0], w.a[1], w.b[0], w.b[1]);
    op.side = v5WallMountSide(P, w, s, c.x, c.y, x, y);
  }
  const tc = (x - w.a[0]) * s.ux + (y - w.a[1]) * s.uy;
  op.w = Math.min(op.w, s.L);
  op.t0 = v5R2(clamp(tc - op.w / 2, 0, Math.max(0, s.L - op.w)));
  v5ResolveOpening(P, op, dir || 0, calques);
  return op;
}

/** End-of-gesture message: a refused drop must not go unnoticed. */
export function v5FlushOpeningRefus(): string | null {
  const r = ardoiseRefus;
  ardoiseRefus = null;
  if (!r) return null;
  return `This wall is ${r.len} cm: too short for “${r.name || "this object"}” (${r.need} cm).`;
}

/** Same, for the DEPTH brought down to the arrival wall's thickness: the value changed, it is reported. */
export function v5FlushOpeningThinned(): string | null {
  const r = ardoiseThinned;
  ardoiseThinned = null;
  if (!r) return null;
  return `This wall is ${r.t} cm thick: “${r.name || "this object"}” goes from ${r.avant} to ${r.t} cm deep.`;
}

// ---- A SHAVED-DOWN PLACEMENT IS REPORTED -----------------------------------------------------------
// Placing a 90 cm door on a 43 cm wall does not refuse it (at PLACEMENT time, no width has been
// chosen yet: it is the catalog default), but the resulting width is not the one you think you
// got. Measured in a real session: nothing was ever announced, not even on the first try.
// Moving an opening that is ALREADY placed remains a refusal (v5FlushOpeningRefus): there, a
// chosen width would be destroyed.

export interface PoseRabotee {
  len: number;
  want: number;
  name: string;
}

let ardoiseNarrowed: PoseRabotee | null = null;

export function v5LastNarrowed(): PoseRabotee | null {
  return ardoiseNarrowed;
}

export function v5FlushPlaceNarrowed(): string | null {
  const r = ardoiseNarrowed;
  ardoiseNarrowed = null;
  if (!r) return null;
  return `This wall is ${r.len} cm: “${r.name || "this object"}” was placed at ${r.len} cm instead of ${r.want} cm.`;
}

// Snapping a drawn point: outline vertices / wall endpoints > edges > 5 cm grid.
// The drawing snap used to be expressed in PIXELS (14 px), so in cm it grew as you zoomed out: at
// the "Fit" scale of a real apartment it was worth ~18 cm and jumped clean over the real gap
// between two parallel partitions. Deleting one of the two and redrawing it became impossible:
// the stroke stuck to the other one and "Cette cloison est déjà là" refused the wall. So the snap
// is now capped at one wall thickness: it can no longer jump across a gap that genuinely exists.
// `echelle` = the view's `vScale`, `snap` = `state.opts.snap`: two settings that are not part of
// the plan, hence two arguments.

/** The tolerance shared by every point-snap in this file: one wall thickness at most, never less
 * than 8 cm, and shrinking with zoom (14 screen px converted to cm) so it stays a SCREEN-sized
 * target rather than a fixed apartment distance. */
function v5SnapTol(echelle: number): number {
  return Math.min(WALL, Math.max(8, 14 / (echelle || 1)));
}

/**
 * VERTEX-ONLY snap: outline corners and interior wall endpoints, nothing else (no edge, no grid).
 * Factored out of `v5SnapPoint` so a caller that needs to know "did this land EXACTLY on an
 * existing joint" (closing a room by drawing back onto another wall's end, `gestes/murs.ts`) can
 * ask the same question `v5SnapPoint` already answers first, without a second notion of snapping.
 * Returns null outside `tol` cm (see `v5SnapTol`).
 */
export function v5SnapVertex(P: PlanV5 | null | undefined, x: number, y: number, echelle: number): Pt | null {
  if (!P) return null;
  const tol = v5SnapTol(echelle);
  let best: Pt | null = null, bd = tol;
  const tryPt = (q: Pt): void => {
    const d = Math.hypot(q[0] - x, q[1] - y);
    if (d <= bd) { bd = d; best = [q[0], q[1]]; }
  };
  (P.outline || []).forEach((q) => tryPt(q));
  (P.walls || []).forEach((w) => { if (!w.isOutline) { tryPt(w.a); tryPt(w.b); } });
  return best ? [v5R2((best as Pt)[0]), v5R2((best as Pt)[1])] : null;
}

export function v5SnapPoint(P: PlanV5, x: number, y: number, echelle: number, snap: boolean): Pt {
  const tol = v5SnapTol(echelle);
  const vtx = v5SnapVertex(P, x, y, echelle);
  if (vtx) return vtx;
  let best: Pt | null = null, bd = tol;
  v5Barriers(P, null).forEach((s) => {
    const c = closestOnSeg(x, y, s.a[0], s.a[1], s.b[0], s.b[1]);
    if (c.dist <= bd) { bd = c.dist; best = [c.x, c.y]; }
  });
  if (best) return [v5R2((best as Pt)[0]), v5R2((best as Pt)[1])];
  const st = snap ? 5 : 1;
  return [Math.round(x / st) * st, Math.round(y / st) * st];
}

// ---- SNAP FOR A DRAGGED WALL ENDPOINT (owner's report: "choper les extrémités des murs et
// pouvoir étendre et relier à d'autres murs") -------------------------------------------------
// Same two-stage precedence as `v5SnapPoint` (a junction first, a segment next), reused rather
// than re-invented, but with THREE differences that `v5SnapPoint` cannot serve as-is:
//   1. THE WALL'S OWN TWO ENDPOINTS ARE EXCLUDED. `v5SnapPoint`/`v5SnapVertex` snap onto ANY
//      wall endpoint, including the dragged wall's own FIXED end: dragging the free end back
//      toward it would then "snap" the wall down to zero length the moment the pointer got
//      close, instead of letting the person actually place it there by hand.
//   2. THE TWO TOLERANCES ARE WIDER (15px / 10px vs 14px for both stages of `v5SnapPoint`): a
//      junction that must physically CONNECT two walls needs a more forgiving target than a
//      point merely snapping to an existing line while drawing.
//   3. `snap` (the personal "snapping enabled" setting) plays NO PART here, matching how
//      `v5SnapPoint` itself never gates its own vertex/edge stages on it either (only the
//      GRID fallback, computed by the caller, is gated by that setting): a junction connection
//      is not an optional convenience to turn off, only the grid-rounding fallback is.

// A HAND AIMS IN PIXELS, NOT IN CENTIMETRES, AND THESE TWO SAID THE OPPOSITE. `Math.min(WALL, ...)`
// capped both at 12 cm, which cancelled outright the `Math.max(8, 15 / echelle)` that was meant to
// widen them as you zoom out: the cap wins as soon as the scale drops below 1,25 px/cm, so at EVERY
// working zoom you had to aim within about six pixels. Reported from real use: dragging a wall's
// end up against a facade would simply not latch onto it.
//
// The bound therefore becomes a FLOOR in centimetres, never below half a wall's thickness even
// zoomed right in, and the term in pixels gets its job back. Covered by
// `tests/bouts-de-mur.ts` (`la_portee_d_accroche_grandit_quand_on_dezoome`), which checks the SAME
// point in centimetres latches when zoomed out and does not when zoomed in.

/** cm: tolerance for stage 1 (another wall's endpoint, or an outline corner). A junction has to
 * hold, so it gets a more forgiving target than the drawing tool's own vertex snap. */
function v5SnapTolBout(echelle: number): number {
  return Math.max(WALL, 16 / (echelle || 1));
}

/** cm: tolerance for stage 2 (a point ON another wall's segment, or on the outline's own body). */
function v5SnapTolSegment(echelle: number): number {
  return Math.max(WALL / 2, 18 / (echelle || 1));
}

/**
 * Where a dragged wall ENDPOINT lands when released near another wall's own endpoint / an
 * outline corner (stage 1, exact), or near another wall's segment / the outline's own body
 * (stage 2, exact). `excludeWallId` is the wall being dragged: its own two endpoints never
 * compete as targets (see file note above). Returns null when nothing is in reach: the caller
 * (`gestes/murs.ts`, `v5WallEndDrop`) then falls back to 45-degree direction quantisation and
 * the grid.
 */
export function v5SnapWallEnd(
  P: PlanV5 | null | undefined,
  excludeWallId: Id | readonly Id[],
  x: number,
  y: number,
  echelle: number,
): Pt | null {
  if (!P) return null;
  const exclus = idsMursExclus(excludeWallId);
  let bestV: Pt | null = null, bdV = v5SnapTolBout(echelle);
  const tryPt = (q: Pt): void => {
    const d = Math.hypot(q[0] - x, q[1] - y);
    if (d <= bdV) { bdV = d; bestV = [q[0], q[1]]; }
  };
  (P.outline || []).forEach((q) => tryPt(q));
  (P.walls || []).forEach((w) => {
    if (w.isOutline || exclus.has(String(w.id))) return;
    tryPt(w.a); tryPt(w.b);
  });
  if (bestV) return [v5R2((bestV as Pt)[0]), v5R2((bestV as Pt)[1])];
  let bestE: Pt | null = null, bdE = v5SnapTolSegment(echelle);
  v5Barriers(P, excludeWallId).forEach((s) => {
    const c = closestOnSeg(x, y, s.a[0], s.a[1], s.b[0], s.b[1]);
    // MEASURED FROM THE WALL'S FACE, NOT ITS AXIS. A wall is a 12 cm band and the eye aims at the
    // band, so "I dropped it against the wall" means the pointer is at the FACE, already half a
    // thickness away from the centreline the snap compares against. Measured on the real flat: the
    // latch only fired within 9 cm of the axis, i.e. 3 cm PAST the inner face, so dropping where
    // the wall visibly ends did nothing. Owner's report, twice.
    const dFace = Math.max(0, c.dist - (s.t || WALL) / 2);
    if (dFace <= bdE) { bdE = dFace; bestE = [c.x, c.y]; }
  });
  if (bestE) return [v5R2((bestE as Pt)[0]), v5R2((bestE as Pt)[1])];
  return null;
}

// ---- SPLITTING A WALL AT ITS MIDPOINT ----------------------------------------------------------
// An elbow begins with a split that changes no visible geometry. The original entity remains the
// first half so every opening before the midpoint keeps both its wall identifier and its distance.
// Only openings wholly after the midpoint move to the new half, by subtracting the first half's
// length. No ratio enters this operation because `t0` is a distance in centimetres.

export type ResultatDivisionMur = { id: Id } | { refus: string };

// THE MIDPOINT IS ROUNDED LIKE EVERY OTHER STORED COORDINATE, and the first half's length is then
// derived FROM THAT ROUNDED POINT rather than from `L / 2`. Two coordinates rounded to the
// centimetre's hundredth can have a midpoint that is not, and storing an unrounded point here
// would be the only place in the model that does. Deriving the length from the point we actually
// store is what keeps an opening's absolute position on the floor exactly where it was: subtract
// a half-length the split did not really use, and every object on the second half slides by the
// difference.
function v5WallSplitPoint(w: Mur): { milieu: Pt; premiereMoitie: number } {
  const milieu: Pt = [v5R2((w.a[0] + w.b[0]) / 2), v5R2((w.a[1] + w.b[1]) / 2)];
  return { milieu, premiereMoitie: Math.hypot(milieu[0] - w.a[0], milieu[1] - w.a[1]) };
}

/** A non-mutating preflight, also used by the gesture so a refusal creates no history entry.
 *  `ou` is the distance IN CENTIMETRES from the wall's `a` end; omitted, it is the midpoint. */
export function v5WallSplitRefusal(P: PlanV5 | null | undefined, wallId: Id, ou?: number): string | null {
  const w = v5WallById(P, wallId);
  if (!P || !w) return "This wall no longer exists.";
  // `isOutline` is only a cache. The shared deletion verdict verifies it against the current
  // outline geometry, which prevents a stale cache from deciding what may be edited.
  if (v5WallDeleteVerdict(P, wallId) === "facade") return "A facade wall cannot be split.";
  const coupe = ou == null ? v5WallSplitPoint(w).premiereMoitie : ou;
  const L = v5Seg(w).L;
  if (!(coupe > 0) || !(coupe < L)) return "This wall is too short to split.";
  const obstacle = (P.openings || []).find((o) =>
    String(o.wallId) === String(wallId) && o.t0 < coupe && coupe < o.t0 + o.w,
  );
  if (obstacle) return `“${obstacle.name || "This object"}” crosses that point, so the wall cannot be cut there.`;
  return null;
}

/** Splits an interior wall at its exact geometric midpoint, without moving anything on the floor. */
export function v5WallSplitAt(P: PlanV5 | null | undefined, wallId: Id): ResultatDivisionMur {
  const w0 = v5WallById(P, wallId);
  if (!P || !w0) return { refus: "This wall no longer exists." };
  return v5WallSplitAtPoint(P, wallId, v5WallSplitPoint(w0).milieu);
}

/**
 * SPLITS A WALL AT AN ARBITRARY POINT ON ITS BODY, which is what a T junction needs: bringing a
 * wall's end onto another wall's flank must not only CONNECT them, it must cut the crossed wall in
 * two at the contact, so the bar of the T becomes two walls with their own handles. The midpoint
 * split of the "+" is this same function called at the middle.
 *
 * `pt` is projected onto the wall, so the caller may pass the raw contact point.
 */
export function v5WallSplitAtPoint(P: PlanV5 | null | undefined, wallId: Id, pt: Pt): ResultatDivisionMur {
  const w0 = v5WallById(P, wallId);
  if (!P || !w0) return { refus: "This wall no longer exists." };
  const proj = closestOnSeg(pt[0], pt[1], w0.a[0], w0.a[1], w0.b[0], w0.b[1]);
  const coupe: Pt = [v5R2(proj.x), v5R2(proj.y)];
  const premiere = Math.hypot(coupe[0] - w0.a[0], coupe[1] - w0.a[1]);
  const refus = v5WallSplitRefusal(P, wallId, premiere);
  if (refus) return { refus };
  const plan = P;
  const w = w0;
  const ancienB: Pt = [w.b[0], w.b[1]];
  const milieu = coupe, demiLongueur = premiere;
  const id = v5NewId("w", plan);
  const nouveau: Mur = { id, a: [milieu[0], milieu[1]], b: ancienB, t: w.t, isOutline: false };
  if (w.free !== undefined) nouveau.free = w.free;

  w.b = [milieu[0], milieu[1]];
  for (const o of plan.openings || []) {
    if (String(o.wallId) !== String(wallId) || o.t0 < demiLongueur) continue;
    o.wallId = id;
    o.t0 -= demiLongueur;
  }
  plan.walls.push(nouveau);
  return { id };
}

// ---- A T JUNCTION CUTS THE WALL IT LANDS ON ----------------------------------------------------
// Owner's request, in his words: bringing a wall's END onto another wall must (a) connect them and
// (b) cut the wall that forms the bar of the T. Connecting alone was already happening (the snap
// puts the endpoint exactly on the other wall's axis), but the crossed wall stayed whole, so the
// two halves of the bar could not be moved, split or deleted independently.
//
// THE MARGIN IS WHAT KEEPS THIS SANE. A contact within a few centimetres of the crossed wall's own
// END is not a T, it is two walls meeting corner to corner: cutting there would produce a stub of
// nothing. `MARGE_T` is that floor, and it is the same order as the junction tolerance itself.
const MARGE_T = 5;

/**
 * IS THIS ENDPOINT A JOINT? True when something else is already holding it: another wall's end,
 * another wall's flank, or the outline. Reported by the owner: after splitting a wall, the cut
 * point was still offered as a grabbable END on both halves, and pulling it would have torn open
 * the junction that had just been made. A joint is not an end. What belongs there is the "-" that
 * welds the two halves back together, and that one is already drawn.
 */
export function v5BoutJoint(P: PlanV5 | null | undefined, wallId: Id, bout: "a" | "b"): boolean {
  const w = v5WallById(P, wallId);
  if (!P || !w) return false;
  const pt = w[bout];
  return (P.walls || []).some((x) => {
    if (String(x.id) === String(wallId)) return false;
    return closestOnSeg(pt[0], pt[1], x.a[0], x.a[1], x.b[0], x.b[1]).dist <= JOINT_TOL;
  });
}

/**
 * COUPER UNE FACADE, C'EST INSERER UN SOMMET DANS LE CONTOUR. Une facade n'est pas stockee comme un
 * mur: elle est RECALCULEE a partir du polygone du contour a chaque changement (`v5SyncOutlineWalls`).
 * La couper en deux revient donc a donner un sommet de plus au polygone, et les deux moities
 * deviennent deux aretes, chacune deplacable comme n'importe quelle facade. C'est exactement ce que
 * demande le proprietaire: « je peux resize un mur de facade comme je veux, donc je devrais aussi
 * pouvoir le couper et bouger les deux bissections comme si c'etait deux facades ».
 *
 * Retourne l'index d'insertion, ou -1 s'il n'y a pas de coupe legitime ici (trop pres d'un coin
 * existant, meme marge que pour un T entre cloisons: sinon on fabrique un moignon).
 */
function v5AreteContourTraversee(P: PlanV5 | null | undefined, pt: Pt): { i: number; sur: Pt } | null {
  const O = P?.outline || [];
  for (let i = 0; i < O.length; i++) {
    const a = O[i]!, b = O[(i + 1) % O.length]!;
    const c = closestOnSeg(pt[0], pt[1], a[0], a[1], b[0], b[1]);
    if (c.dist > 2) continue;
    if (Math.hypot(c.x - a[0], c.y - a[1]) < MARGE_T) continue;
    if (Math.hypot(c.x - b[0], c.y - b[1]) < MARGE_T) continue;
    return { i, sur: [v5R2(c.x), v5R2(c.y)] };
  }
  return null;
}

/**
 * L'INDEX DE L'ARETE DU CONTOUR que ce mur de facade represente, ou -1. Une facade est recalculee
 * depuis le polygone: pour la DEPLACER il faut savoir quelle arete elle mirroir.
 */
export function v5IndexAreteContour(P: PlanV5 | null | undefined, wallId: Id): number {
  const w = v5WallById(P, wallId);
  const O = P?.outline || [];
  if (!w || !w.isOutline) return -1;
  for (let i = 0; i < O.length; i++) {
    const a = O[i]!, b = O[(i + 1) % O.length]!;
    const direct = Math.hypot(a[0] - w.a[0], a[1] - w.a[1]) + Math.hypot(b[0] - w.b[0], b[1] - w.b[1]);
    const inverse = Math.hypot(a[0] - w.b[0], a[1] - w.b[1]) + Math.hypot(b[0] - w.a[0], b[1] - w.a[1]);
    if (Math.min(direct, inverse) < 2) return i;
  }
  return -1;
}

/** Inserts that vertex, so the facade becomes two. Returns false if there was nothing to cut. */
export function v5CouperContour(P: PlanV5 | null | undefined, pt: Pt): boolean {
  const t = v5AreteContourTraversee(P, pt);
  if (!t || !P) return false;
  // ON SCINDE LE MUR AVANT D'INSERER LE SOMMET, et ce n'est pas une optimisation, c'est ce qui
  // empeche une perte de donnees. `v5SyncOutlineWalls` reapparie chaque arete a un mur de facade;
  // la seconde moitie d'une arete coupee est COLINEAIRE a la premiere, donc son seul candidat sur
  // la meme droite est deja pris, et le repli `old.find(non pris)` lui donnait alors une facade
  // QUELCONQUE. Toutes les suivantes se decalaient d'un cran, et comme une ouverture designe son
  // mur par IDENTIFIANT, portes et fenetres changeaient de facade en silence. Mesure sur le vrai
  // plan par une revue adverse: UNE cloison tracee depuis une facade deplacait 9 ouvertures sur 30,
  // jusqu'a 11 metres, sans un mot. En creant nous-memes le mur de la seconde moitie, chaque arete
  // retrouve un candidat exact et le repli n'est plus atteint.
  const O = P.outline, n = O.length;
  const ea = O[t.i]!, eb = O[(t.i + 1) % n]!;
  const mur = (P.walls || []).find((w) => w.isOutline
    && (Math.hypot(w.a[0] - ea[0], w.a[1] - ea[1]) + Math.hypot(w.b[0] - eb[0], w.b[1] - eb[1]) < 2
     || Math.hypot(w.a[0] - eb[0], w.a[1] - eb[1]) + Math.hypot(w.b[0] - ea[0], w.b[1] - ea[1]) < 2));
  if (mur) {
    P.walls.push({
      id: v5DerivedId(P, "w"),
      a: [t.sur[0], t.sur[1]], b: [mur.b[0], mur.b[1]],
      t: mur.t || WALL, isOutline: true,
    });
    mur.b = [t.sur[0], t.sur[1]];
  }
  P.outline = [...O.slice(0, t.i + 1), t.sur, ...O.slice(t.i + 1)];
  v5SyncOutlineWalls(P);
  return true;
}

/** The wall whose BODY passes through `pt`, if cutting it there would make a real T. */
export function v5MurTraverse(P: PlanV5 | null | undefined, pt: Pt, exclure: readonly Id[]): Mur | null {
  if (!P) return null;
  const exclus = idsMursExclus(exclure);
  for (const w of (P.walls || [])) {
    if (w.isOutline || exclus.has(String(w.id))) continue;
    const c = closestOnSeg(pt[0], pt[1], w.a[0], w.a[1], w.b[0], w.b[1]);
    if (c.dist > 2) continue;
    const dA = Math.hypot(c.x - w.a[0], c.y - w.a[1]);
    const dB = Math.hypot(c.x - w.b[0], c.y - w.b[1]);
    if (dA < MARGE_T || dB < MARGE_T) continue;      // corner to corner, not a T
    return w;
  }
  return null;
}

// ---- MERGING TWO WALLS BACK INTO ONE -----------------------------------------------------------
// The exact inverse of the split, and the owner asked for it in those words: having partitioned a
// wall, he wants to put it back together when the two pieces still continue one another. A "+"
// that cuts and a "-" that welds are the same pair of scissors.
//
// THE GUARD IS WHAT MAKES IT SAFE, and it is not "are they roughly aligned". Three walls meeting at
// a point is a T, and welding two of them would silently swallow the third's junction; so the
// junction must belong to EXACTLY these two. And a facade is derived from the outline, so it can
// take part in nothing.

/** How close two endpoints must be to count as the same joint. Same 2 cm as junction detection. */
const JOINT_TOL = 2;
/** How straight the two walls must be to be weldable: about 2 degrees of slack. */
const COLIN_TOL = 0.035;

export interface FusionMur { autre: Id; bout: "a" | "b"; autreBout: "a" | "b"; }

const unitaire = (w: Mur, de: "a" | "b"): Pt => {
  const vers = de === "a" ? w.b : w.a;
  const dx = vers[0] - w[de][0], dy = vers[1] - w[de][1];
  const L = Math.hypot(dx, dy) || 1e-9;
  return [dx / L, dy / L];
};

/** Is this wall's `bout` end weldable to exactly one collinear neighbour? */
export function v5WallMergeCandidate(P: PlanV5 | null | undefined, wallId: Id, bout: "a" | "b"): FusionMur | null {
  const w = v5WallById(P, wallId);
  if (!P || !w || w.isOutline) return null;
  const pt = w[bout];
  let trouve: FusionMur | null = null;
  for (const x of (P.walls || [])) {
    if (x === w) continue;
    for (const k of ["a", "b"] as const) {
      if (Math.hypot(x[k][0] - pt[0], x[k][1] - pt[1]) > JOINT_TOL) continue;
      // A THIRD wall at the same joint means this is a T, and welding would swallow its junction.
      if (trouve || x.isOutline) return null;
      trouve = { autre: x.id, bout, autreBout: k };
    }
    // A wall whose FLANK passes through the joint is a third party too, even without an endpoint
    // there: welding across it would bury a junction inside the new wall.
    if (!x.isOutline && closestOnSeg(pt[0], pt[1], x.a[0], x.a[1], x.b[0], x.b[1]).dist <= JOINT_TOL
      && Math.hypot(x.a[0] - pt[0], x.a[1] - pt[1]) > JOINT_TOL
      && Math.hypot(x.b[0] - pt[0], x.b[1] - pt[1]) > JOINT_TOL) return null;
  }
  if (!trouve) return null;
  const x = v5WallById(P, trouve.autre)!;
  // Collinear means the two walls CONTINUE one another: leaving the joint, they point in opposite
  // directions. The cross product alone would also accept a wall folded back onto itself.
  const u = unitaire(w, bout), v = unitaire(x, trouve.autreBout);
  const croix = Math.abs(u[0] * v[1] - u[1] * v[0]);
  const scal = u[0] * v[0] + u[1] * v[1];
  if (croix > COLIN_TOL || scal > -0.9) return null;
  return trouve;
}

/**
 * OU CETTE FACADE SE RESSOUDE: L'INDEX DU SOMMET PLAT, ou -1.
 *
 * Une facade coupee n'est pas deux murs poses cote a cote, c'est UN SOMMET DE PLUS dans le polygone
 * du contour (`v5CouperContour`). La ressouder n'est donc pas une fusion de murs, c'est retirer ce
 * sommet, et `v5WallMergeCandidate` ne peut pas repondre ici: il refuse categoriquement une facade,
 * parce que fusionner deux murs DERIVES ne survivrait pas au prochain `v5SyncOutlineWalls`.
 *
 * La regle est la meme que pour deux cloisons, transposee au polygone: les deux aretes qui se
 * rejoignent en ce sommet doivent CONTINUER l'une l'autre (en repartant du sommet, elles pointent
 * en sens opposes), et rien d'autre ne doit tenir ce point, sinon on enterrerait une jonction dans
 * la nouvelle facade. Un contour de trois sommets n'a rien a donner: il cesserait d'etre un polygone.
 */
export function v5SommetPlatDeFacade(
  P: PlanV5 | null | undefined,
  wallId: Id,
  bout: "a" | "b",
): number {
  const w = v5WallById(P, wallId);
  const O = P?.outline || [];
  if (!P || !w || !w.isOutline || O.length <= 3) return -1;
  const pt = w[bout];
  for (let i = 0; i < O.length; i++) {
    const v = O[i]!;
    if (Math.hypot(v[0] - pt[0], v[1] - pt[1]) > JOINT_TOL) continue;
    const p = O[(i - 1 + O.length) % O.length]!, n = O[(i + 1) % O.length]!;
    const dep = (q: Pt): Pt => {
      const dx = q[0] - v[0], dy = q[1] - v[1], L = Math.hypot(dx, dy) || 1e-9;
      return [dx / L, dy / L];
    };
    const u = dep(p), z = dep(n);
    if (Math.abs(u[0] * z[1] - u[1] * z[0]) > COLIN_TOL) return -1;
    if (u[0] * z[0] + u[1] * z[1] > -0.9) return -1;
    // Une cloison qui vient mourir sur ce sommet en fait une jonction a trois.
    for (const x of P.walls || []) {
      if (x.isOutline) continue;
      if (closestOnSeg(v[0], v[1], x.a[0], x.a[1], x.b[0], x.b[1]).dist <= JOINT_TOL) return -1;
    }
    return i;
  }
  return -1;
}

/** Welds `wallId` to the neighbour meeting its `bout` end. The merged wall keeps `wallId`. */
export function v5WallMergeAt(P: PlanV5 | null | undefined, wallId: Id, bout: "a" | "b"): { refus: string } | { id: Id } {
  const f = v5WallMergeCandidate(P, wallId, bout);
  if (!f) return { refus: "These two walls do not continue one another, or something else meets them here." };
  const plan = P!;
  const w = v5WallById(plan, wallId)!, x = v5WallById(plan, f.autre)!;
  const A: Pt = bout === "a" ? [w.b[0], w.b[1]] : [w.a[0], w.a[1]];
  const B: Pt = f.autreBout === "a" ? [x.b[0], x.b[1]] : [x.a[0], x.a[1]];
  const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
  if (!(L > 0)) return { refus: "These two walls would weld into nothing." };
  const ux = (B[0] - A[0]) / L, uy = (B[1] - A[1]) / L;

  // EVERY OPENING IS RE-MEASURED FROM THE NEW `a`, BY PROJECTION, and not by adding lengths. Adding
  // works only when both walls happen to be stored in the same direction, and the direction of a
  // wall is arbitrary: a merge that assumed it would slide half the doors and windows to the wrong
  // end. Projecting both ends of the opening and keeping the smaller one is direction-agnostic.
  for (const o of plan.openings || []) {
    const surW = String(o.wallId) === String(wallId), surX = String(o.wallId) === String(f.autre);
    if (!surW && !surX) continue;
    const q = surW ? w : x;
    const ql = Math.hypot(q.b[0] - q.a[0], q.b[1] - q.a[1]) || 1e-9;
    const qux = (q.b[0] - q.a[0]) / ql, quy = (q.b[1] - q.a[1]) / ql;
    const p0: Pt = [q.a[0] + qux * o.t0, q.a[1] + quy * o.t0];
    const p1: Pt = [q.a[0] + qux * (o.t0 + o.w), q.a[1] + quy * (o.t0 + o.w)];
    const d0 = (p0[0] - A[0]) * ux + (p0[1] - A[1]) * uy;
    const d1 = (p1[0] - A[0]) * ux + (p1[1] - A[1]) * uy;
    o.wallId = wallId;
    o.t0 = v5R2(clamp(Math.min(d0, d1), 0, Math.max(0, L - o.w)));
  }

  w.a = [v5R2(A[0]), v5R2(A[1])];
  w.b = [v5R2(B[0]), v5R2(B[1])];
  // A welded wall stays put. If either piece was a free partition, the result must be one too:
  // letting the through rule loose on it would stretch the weld somewhere nobody asked for.
  if (w.free === 1 || x.free === 1) w.free = 1;
  plan.walls = (plan.walls || []).filter((q) => String(q.id) !== String(f.autre));
  return { id: w.id };
}

// ---- WHO IS ALLOWED TO DISAPPEAR (C-13) --------------------------------------------------------
// An OUTLINE WALL is an entity DERIVED from the outline: `v5SyncOutlineWalls` recreates it on the
// next update. Deleting it therefore does not remove the wall, but permanently takes its openings
// with it. The three-outcome verdict lives in `v5WallDeleteVerdict` (modele/murs.ts); here, the
// only question is the LOCAL path: does this particular wall get deleted?
export function v5CanDeleteWall(P: PlanV5 | null | undefined, id: Id): boolean {
  return v5WallDeleteVerdict(P, id) === "ok";
}
