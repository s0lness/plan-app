// src/ts/gestes/edition-murs.ts: THE OUTLINE'S ORTHOGONAL SNAP AND ITS GUIDES. The snap pulls the
// moved vertex so its incident edges become AXIAL as soon as another vertex of the SAME polygon
// shares an X/Y within tolerance. Both axes can snap, giving a 90° corner. Order: the caller
// applies the GRID first, then this. The outline must not self-intersect, said by only one place,
// the wall card (`#rcWarn`), which follows a selected facade or corner.

import type { Contexte } from "../app/contexte.ts";
import type { Pt } from "../partage/plan.ts";
import { $ } from "../noyau/dom.ts";
import { selfIntersects } from "../geometrie/polygones.ts";
import { WALL } from "../noyau/nombres.ts";
import { resolveColor } from "../rendu/couleurs.ts";
import { aptToScreen } from "../rendu/vue.ts";

const ORTHO_TOL_CM = 8;
/** 8 cm or 8 px, whichever is bigger: at low zoom, 8 cm is only a few pixels. */
const orthoTol = (scale: number): number => Math.max(ORTHO_TOL_CM, 8 / scale);

export interface GuideOrtho { axis: "x" | "y"; line: number; a: number; b: number }

/**
 * Snaps ONE axis of the dragged vertex to the coordinate of the closest vertex of the same
 * polygon on that axis. Both NEIGHBORS win (they make an incident edge perfectly H/V), then
 * any other vertex. Returns `{val, target}` (`target` = aligned index, or -1).
 */
function orthoSnapAxis(
  poly: readonly Pt[], i: number, val: number, ax: "x" | "y", scale: number,
): { val: number; target: number } {
  const c = (ax === "x") ? 0 : 1, tol = orthoTol(scale), n = poly.length;
  const prev = (i - 1 + n) % n, next = (i + 1) % n;
  let best: { d: number; ad: number; pri: number; k: number } | null = null;
  const consider = (k: number, pri: number): void => {
    if (k === i) return;
    const pt = poly[k]; if (!pt) return;
    const d = pt[c]! - val; const ad = Math.abs(d);
    if (ad > tol) return;
    // rank: neighbors (pri 0) beat distant vertices (pri 1); same rank, the closest one wins.
    if (!best || pri < best.pri || (pri === best.pri && ad < best.ad)) best = { d, ad, pri, k };
  };
  consider(prev, 0); consider(next, 0);
  for (let k = 0; k < n; k++) { if (k !== prev && k !== next) consider(k, 1); }
  if (!best) return { val, target: -1 };
  const b = best as { d: number; ad: number; pri: number; k: number };
  return { val: val + b.d, target: b.k };
}

/**
 * Full snap of vertex `i` to the post-grid apartment position `(lx,ly)`. `shiftLock` forces a
 * purely horizontal OR vertical pull relative to `(sx,sy)`, the drag's starting point:
 * the locked axis is chosen from the dominant movement, so a small crossing movement is discarded.
 */
export function orthoSnapVertex(
  poly: readonly Pt[], i: number, lx: number, ly: number,
  shiftLock: boolean, sx: number, sy: number, scale: number,
): { x: number; y: number; guides: GuideOrtho[] } {
  let x = lx, y = ly;
  if (shiftLock) {
    if (Math.abs(lx - sx) >= Math.abs(ly - sy)) y = sy; else x = sx;
  }
  const sX = orthoSnapAxis(poly, i, x, "x", scale);
  const sY = orthoSnapAxis(poly, i, y, "y", scale);
  x = sX.val; y = sY.val;
  const guides: GuideOrtho[] = [];
  if (sX.target >= 0) guides.push({ axis: "x", line: x, a: y, b: poly[sX.target]![1]! });
  if (sY.target >= 0) guides.push({ axis: "y", line: y, a: x, b: poly[sY.target]![0]! });
  return { x, y, guides };
}

/**
 * UNE FAÇADE COLLE À CELLE QUI EST DANS SON PROLONGEMENT.
 *
 * Signalé par le propriétaire, mot pour mot: « j'arrive pas à le refaire coller, il est toujours
 * slightly on top or below et se stick jamais dans le mur ». Sa façade porte une encoche en U;
 * pour la refermer il faut pousser le fond du U PILE sur la ligne des deux façades voisines, et
 * le glissement n'était arrondi qu'à la grille de 5 cm. Mesuré sur
 * `[[0,0],[300,0],[300,200],[600,200],[600,0],[900,0],[900,600],[0,600]]`, fond du U tiré vers
 * y=0: visé 0 pile, l'encoche se referme (6 sommets); visé -7, +6 ou +3, il reste une marche de
 * 5 cm et 8 sommets. À la main on tombe toujours sur un multiple de 5 non nul, donc jamais sur
 * l'alignement, quel que soit le soin mis à viser.
 *
 * On cherche donc, parmi les AUTRES arêtes du contour, celles qui sont PARALLÈLES à celle qu'on
 * tire, et si la position atteinte tombe à portée de l'une de leurs lignes, on s'y pose
 * exactement. Trois choses qui ne sont pas des détails:
 *
 * - **La portée se mesure à l'écran**, `Math.max(WALL, 16 / echelle)`, la même formule que
 *   `v5SnapTolBout`: un aimant en centimètres ne s'attrape plus une fois dézoomé, et une main
 *   vise en pixels.
 * - **Il est seul, maintenant qu'il n'y a plus de grille** (décision 0012). Il devait primer sur
 *   un pas de 5 cm, parce que se poser à 5 cm près d'un alignement est exactement le défaut; la
 *   façade se déplace au centimètre, et `Alt` suspend l'aimant le temps d'un geste.
 * - **Il ne s'applique que sur un axe**, donc là où le guide qui le PROUVE peut être dessiné. Un
 *   aimant muet est indistinguable d'un hasard, et c'est une façade oblique qui paierait le
 *   silence.
 *
 * Prix payé, mesuré: les seules positions perdues sont les multiples de 5 situés à moins d'une
 * portée d'un alignement, soit 4 positions au zoom de travail (portée 12 cm), 6 à 1 px/cm et 12
 * une fois dézoomé à 0,5 px/cm. Ctrl les rend toutes.
 */
export function aimantFacade(
  poly: readonly Pt[], i: number, a0: Pt, b0: Pt,
  nx: number, ny: number, d: number, scale: number,
): { d: number; guide: GuideOrtho | null } {
  const axe: "x" | "y" | null = Math.abs(nx) > 0.99 ? "x" : (Math.abs(ny) > 0.99 ? "y" : null);
  if (!axe) return { d, guide: null };
  const tol = Math.max(WALL, 16 / (scale || 1));
  const n = poly.length;
  let cible: { d: number; p: Pt; q: Pt } | null = null;
  for (let k = 0; k < n; k++) {
    if (k === i) continue;
    const p = poly[k], q = poly[(k + 1) % n];
    if (!p || !q) continue;
    const ux = q[0] - p[0], uy = q[1] - p[1], L = Math.hypot(ux, uy);
    if (L < 1) continue;
    if (Math.abs(ux * nx + uy * ny) / L >= 0.02) continue;        // pas parallèle
    const dc = (p[0] - a0[0]) * nx + (p[1] - a0[1]) * ny;         // le d qui pose l'arête sur SA ligne
    if (Math.abs(dc - d) > tol) continue;
    if (!cible || Math.abs(dc - d) < Math.abs(cible.d - d)) cible = { d: dc, p, q };
  }
  if (!cible) return { d, guide: null };
  // Le guide relie les deux arêtes: il va d'un bout à l'autre de leur étendue commune le long de
  // la ligne attrapée, donc on voit CE À QUOI ça s'est aligné, pas seulement que ça a sauté. Et il
  // DÉBORDE largement des deux côtés: une façade posée pile sur la ligne d'une autre est peinte
  // par-dessus le trait, donc ce qui se voit, ce sont ses deux dépassements, de part et d'autre du
  // plan. Un débord de la longueur d'une porte se lit à l'œil à tous les zooms de travail.
  const c = axe === "x" ? 1 : 0;                                   // la coordonnée LE LONG de l'arête
  const vals = [a0[c]!, b0[c]!];
  for (let k = 0; k < n; k++) {                                    // TOUT ce qui est sur la ligne attrapée
    const p = poly[k], q = poly[(k + 1) % n];
    if (k === i || !p || !q) continue;
    const ux = q[0] - p[0], uy = q[1] - p[1], L = Math.hypot(ux, uy);
    if (L < 1 || Math.abs(ux * nx + uy * ny) / L >= 0.02) continue;
    if (Math.abs((p[0] - a0[0]) * nx + (p[1] - a0[1]) * ny - cible.d) > 0.5) continue;
    vals.push(p[c]!, q[c]!);
  }
  const ligne = axe === "x" ? a0[0] + nx * cible.d : a0[1] + ny * cible.d;
  const DEBORD = 80;
  return { d: cible.d, guide: { axis: axe, line: ligne, a: Math.min(...vals) - DEBORD, b: Math.max(...vals) + DEBORD } };
}

/** The snapping guides live on the canvas (viewport px via `aptToScreen`). */
export function clearStitchGuides(ctx: Contexte): void {
  // PAR LEUR PROPRE CLASSE, JAMAIS PAR `.ov-guides`: les cotes vivantes d'un glissement de façade
  // (`v5DrawWallDims`) portent la même classe de conteneur, et le premier `.ov-guides` venu, c'était
  // parfois elles. Le guide de l'image précédente survivait alors à son effacement et s'empilait.
  ctx.canvas.querySelectorAll(".ov-stitch").forEach((g) => g.remove());
}

export function drawOrthoGuides(ctx: Contexte, guides: GuideOrtho[] | null | undefined): void {
  clearStitchGuides(ctx);
  if (!guides || !guides.length) return;
  const cont = document.createElement("div"); cont.className = "ov-guides ov-stitch";
  const acc = resolveColor("var(--accent)");
  const pad = 14;   // cm of overshoot, so the line clearly connects the two corners
  guides.forEach((g) => {
    const el = document.createElement("div");
    el.className = "gline"; el.style.position = "absolute"; el.style.opacity = "0.85";
    const lo = Math.min(g.a, g.b) - pad, hi = Math.max(g.a, g.b) + pad;
    if (g.axis === "x") {   // vertical line at X=g.line, covering Y from lo to hi
      const s0 = aptToScreen(ctx, g.line, lo), s1 = aptToScreen(ctx, g.line, hi);
      el.style.left = s0.x + "px"; el.style.top = Math.min(s0.y, s1.y) + "px";
      el.style.width = "0"; el.style.height = Math.abs(s1.y - s0.y) + "px";
      el.style.borderLeft = "1px solid " + acc;
    } else {                // horizontal line at Y=g.line, covering X from lo to hi
      const s0 = aptToScreen(ctx, lo, g.line), s1 = aptToScreen(ctx, hi, g.line);
      el.style.left = Math.min(s0.x, s1.x) + "px"; el.style.top = s0.y + "px";
      el.style.height = "0"; el.style.width = Math.abs(s1.x - s0.x) + "px";
      el.style.borderTop = "1px solid " + acc;
    }
    cont.appendChild(el);
  });
  ctx.canvas.appendChild(cont);
}

/**
 * Called on EVERY geometry change (`v5AfterGeometry`): crossing the outline by dragging a
 * vertex lights up the warning right away, uncrossing it turns it off.
 */
export function checkShapeWarn(ctx: Contexte): void {
  const rw = $("rcWarn"); if (!rw) return;
  const poly = (ctx.etat.plan && ctx.etat.plan.outline) || [];
  const selection = ctx.ihm.selWall
    ? (ctx.etat.plan.walls || []).find((w) => String(w.id) === String(ctx.ihm.selWall))
    : null;
  rw.classList.toggle("on", (!!selection?.isOutline || ctx.selVtx >= 0) && poly.length > 2 && selfIntersects(poly));
}
