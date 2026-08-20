// src/ts/rendu/calque.ts — THE LAYER, the SINGLE editing container.
// Ported from src/js/50-v5-rendu.js (`renderV5`, `v5RenderBack`) and src/js/54-v5-interface.js
// (`v5RenderOpenings`, `v5RenderLabels`, `v5DrawHandles`).
//
// There is only ONE container, `.v5layer`, positioned on the outline's bbox: guides, handles and
// dimensions anchor to it. No more "focused room", so no more local reference frame.
//
// THE BACKGROUND IS CACHED, THE REST IS RECONCILED. Floors, wall bands and hit shapes are only
// rebuilt when the geometry, scale or layers change (`data-sig` signature). Furniture, openings,
// labels and handles are reconciled on EVERY render: a drag must not depend on a rebuild, and the
// DOM nodes hold closures.

import type { BBox } from "../geometrie/polygones.ts";
import type { Contexte } from "../app/contexte.ts";
import type { PlanV5, Pt } from "../partage/plan.ts";
import { TYPEMAP, pieceVisible } from "../catalogue/catalogue.ts";
import { bboxOfPoly, pointInPoly, poleOfInaccessibility, polyArea } from "../geometrie/polygones.ts";
import { v5OpeningBox } from "../modele/murs.ts";
import { v5BoutJoint, v5IndexAreteContour, v5MurDeTravers, v5SommetPlatDeFacade, v5WallMergeCandidate } from "../modele/edition.ts";
import { WALL, escapeHtml, safeDim, v5R2 } from "../noyau/nombres.ts";
import { SVGNS, cssId } from "../noyau/dom.ts";
import { aptToScreen, evtApt } from "./vue.ts";
import { gesteActif } from "../gestes/sortie.ts";
import { floorPatternDefs } from "./sol.ts";
import { resolveColor, withAlpha } from "./couleurs.ts";
import { pieceIconSVG } from "./icones.ts";
import { doorArcSVG, windowArcSVG } from "./arc-porte.ts";
import { polygoneFaisceau, projection } from "../modele/projection.ts";
import { renderPieces } from "./meubles.ts";
import { isSel } from "./selection.ts";
import type { CandidatEtiquetteCellule } from "./etiquettes-disposition.ts";
import { disposerEtiquettesCellules, obstaclesMeubles } from "./etiquettes-disposition.ts";

/** The layer, if mounted. */
export const focusEl = (ctx: Contexte): HTMLElement | null =>
  ctx.canvas.querySelector<HTMLElement>(".v5layer");

const finsSurvol = new WeakMap<Contexte, number>();
const survolBranche = new WeakSet<Contexte>();

function murPointe(t: EventTarget | null): string | null {
  const e = t instanceof Element ? t.closest<HTMLElement>("[data-w]") : null;
  return e?.dataset["w"] || null;
}

function montrerPoigneesMur(ctx: Contexte, layer: HTMLElement, wallId: string | null): void {
  const old = finsSurvol.get(ctx);
  if (old !== undefined) { window.clearTimeout(old); finsSurvol.delete(ctx); }
  if (wallId && !(ctx.etat.plan.walls || []).some((w) => String(w.id) === wallId)) wallId = null;
  if (ctx.ihm.hoverWall === wallId) return;
  ctx.ihm.hoverWall = wallId;
  const P = ctx.etat.plan;
  if (P?.outline?.length >= 3) drawHandles(ctx, layer, bboxOfPoly(P.outline), ctx.vue.scale);
}

function planifierMasquageMur(ctx: Contexte, layer: HTMLElement): void {
  const old = finsSurvol.get(ctx);
  if (old !== undefined) window.clearTimeout(old);
  const id = window.setTimeout(() => montrerPoigneesMur(ctx, layer, null), 120);
  finsSurvol.set(ctx, id);
}

function murGeometrique(ctx: Contexte, e: PointerEvent): string | null {
  const p = evtApt(ctx, e);
  let best: { id: string; d: number } | null = null;
  let tenu: number | null = null;
  for (const w of (ctx.etat.plan.walls || [])) {
    const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1], ll = dx * dx + dy * dy;
    const u = ll ? Math.max(0, Math.min(1, ((p.x - w.a[0]) * dx + (p.y - w.a[1]) * dy) / ll)) : 0;
    const d = Math.hypot(p.x - (w.a[0] + u * dx), p.y - (w.a[1] + u * dy));
    const reach = Math.max((w.t || WALL) / 2, 7 / Math.max(0.01, ctx.vue.scale));
    if (d <= reach && (!best || d < best.d)) best = { id: String(w.id), d };
    if (d <= reach && String(w.id) === ctx.ihm.hoverWall) tenu = d;
  }
  // THE WALL YOU ARE ALREADY ON KEEPS THE HOVER unless another one is CLEARLY closer. Without this
  // hysteresis, walking the pointer toward a wall's own end flips the hover to the neighbour that
  // meets it there, because at a junction the two are equidistant. The owner then aims at one
  // wall's end handle and grabs the other one's: measured on the real flat, the element under a
  // 47 cm partition's tip belonged to the wall next to it. A candidate must beat the incumbent by
  // a clear margin, not by a rounding error.
  if (tenu !== null && (!best || best.d > tenu * 0.6)) return ctx.ihm.hoverWall;
  return best?.id || null;
}

function brancherSurvolMurs(ctx: Contexte): void {
  if (survolBranche.has(ctx)) return;
  survolBranche.add(ctx);
  // Geometric detection deliberately leaves transparent wall bands out of the hit-test stack.
  // A transparent DOM band would join the hit-test stack and could cover the furniture that is
  // visibly painted above it. Geometry only decides whether handles should be shown; the real DOM
  // target still decides what receives the press.
  ctx.viewport.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    const layer = focusEl(ctx); if (!layer) return;
    const direct = murPointe(e.target);
    if (direct) { montrerPoigneesMur(ctx, layer, direct); return; }
    const t = e.target instanceof Element ? e.target : null;
    // UNE OUVERTURE APPARTIENT A UN MUR, donc la survoler c'est survoler SON MUR. Ce chemin les
    // traitait comme des meubles et effacait les poignees: une facade portant une fenetre en son
    // milieu devenait insaisissable a l'endroit exact ou son bouton se pose. Signale par le
    // proprietaire: « s'il y a une fenetre a l'endroit du bouton, je dois pouvoir saisir le
    // bouton ». Une ouverture RESOUT vers son mur; un MEUBLE, lui, n'appartient a aucun mur, donc
    // il ne resout vers rien: il retient, mais ne revele pas (voir plus bas).
    const ouv = t?.closest<HTMLElement>('.piece[data-op="1"]');
    if (ouv) {
      const o = (ctx.etat.plan.openings || []).find((q) => String(q.id) === String(ouv.dataset["id"]));
      montrerPoigneesMur(ctx, layer, o ? String(o.wallId) : null);
      return;
    }
    // UNE ETIQUETTE DE PIECE N'EFFACE PAS LES POIGNEES, elle n'est le nom d'aucun objet: une
    // cellule est DERIVEE des murs, donc survoler son nom c'est encore survoler ce qu'il y a
    // dessous. Ce chemin la traitait comme un meuble, et l'etiquette se pose au pole de la
    // cellule, c'est-a-dire au milieu d'un couloir etroit, pile sur le bouton du mur qui le
    // borde: approcher ce bouton faisait disparaitre la commande qu'on visait. On laisse donc
    // decider la GEOMETRIE, comme pour une ouverture.
    // UN MEUBLE RETIENT LES COMMANDES DU MUR QU'IL RECOUVRE, MAIS IL N'EN REVELE AUCUNE.
    // Ce chemin les EFFACAIT: passer au-dessus d'un meuble en allant vers le bouton d'un mur
    // faisait disparaitre le bouton qu'on visait, et un bouton se pose justement A COTE de la
    // bande du mur (la croix et la coupe sont decalees d'une boite entiere), donc le trajet
    // traverse par force ce qui est pose la. C'est la meme famille de defaut que l'etiquette de
    // piece, un cran plus loin.
    //
    // MAIS UN MEUBLE N'EST PAS UNE ETIQUETTE, et c'est la seule nuance qui compte ici: on le
    // SAISIT. Si un meuble revelait les commandes du mur sous lequel il est pose, alors depuis
    // que ces commandes passent au-dessus de lui (`css/06`), venir prendre un lit colle a une
    // cloison ferait apparaitre un bouton sous la main juste avant l'appui. Le defaut serait
    // seulement deplace. La regle est donc DISSYMETRIQUE: un meuble RETIENT le survol du mur
    // qu'on tenait deja (on venait du mur, on va vers son bouton), il n'en DEMARRE jamais un
    // nouveau (on arrive du sol libre, on vient prendre le meuble). Quand il ne retient rien, on
    // passe par le masquage DIFFERE ordinaire, celui-la meme qui donne le temps d'atteindre un
    // bouton, au lieu d'effacer sur-le-champ.
    const surMeuble = !!t?.closest(".piece");
    const id = murGeometrique(ctx, e);
    if (id && (!surMeuble || id === ctx.ihm.hoverWall)) montrerPoigneesMur(ctx, layer, id);
    else planifierMasquageMur(ctx, layer);
  });
  ctx.viewport.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    const layer = focusEl(ctx), t = e.target instanceof Element ? e.target : null;
    if (!layer || t?.closest(".piece")) return;
    montrerPoigneesMur(ctx, layer, murPointe(e.target) || murGeometrique(ctx, e));
  }, { capture: true });
  ctx.viewport.addEventListener("pointerleave", () => {
    const layer = focusEl(ctx); if (layer) planifierMasquageMur(ctx, layer);
  });
}

export function renderV5(ctx: Contexte): void {
  const P = ctx.etat.plan;
  let layer = ctx.canvas.querySelector<HTMLElement>(".v5layer");
  if (!P || !Array.isArray(P.outline) || P.outline.length < 3) { if (layer) layer.remove(); return; }
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "v5layer";
    layer.addEventListener("pointerdown", (e) => {
      // Hover does not exist on touch. Remembering the tapped wall makes its handles reachable on
      // the next tap, while the clean first tap still writes no geometry.
      if ((e as PointerEvent).pointerType === "touch") montrerPoigneesMur(ctx, layer!, murPointe(e.target));
      ctx.gestes.calquePointerDown?.(e as PointerEvent);
    });
    layer.addEventListener("dblclick", (e) => ctx.gestes.calqueDblClick?.(e as MouseEvent));
    ctx.canvas.appendChild(layer);
  }
  brancherSurvolMurs(ctx);
  const bb = bboxOfPoly(P.outline);
  const sp = aptToScreen(ctx, bb.minX, bb.minY);
  const S = ctx.vue.scale;
  layer.style.left = sp.x + "px";
  layer.style.top = sp.y + "px";
  layer.style.width = safeDim(bb.w * S) + "px";
  layer.style.height = safeDim(bb.l * S) + "px";
  layer.classList.toggle("drawing", !!ctx.ihm.draw);
  const o = ctx.etat.opts;
  // `ctx.ihm.draw` gates the HIT shapes below (walls/cells only get their clickable band while
  // the draw tool is OFF): leaving it out of the cache key is exactly the bug that made "turn the
  // tool off" and "never having turned it on" two different renders. Escape happened to work by
  // accident, through a DIFFERENT branch (`v5SelectWall(ctx,null)`) that bumps `ctx.rev` as a
  // side effect of clearing the selection, not because it releases anything the button doesn't.
  const sig = S.toFixed(4) + "|" + ctx.rev + "|" + (o.labels ? 1 : 0) + "|" + (o.layFurn !== false ? 1 : 0)
    + (o.layLight !== false ? 1 : 0) + (o.layPlug !== false ? 1 : 0)
    + "|" + (ctx.ihm.selWall || "") + "|" + (ctx.ihm.draw ? 1 : 0);
  if (layer.dataset["sig"] !== sig) { layer.dataset["sig"] = sig; renderFond(ctx, layer, P, bb, S); }
  renderPieces(ctx, layer, bb);
  renderOuvertures(ctx, layer, bb, S);
  renderEtiquettesCellules(ctx, layer, bb, S);
  renderFaisceaux(ctx, layer, bb, S);
  drawHandles(ctx, layer, bb, S);
}

/** Floors per cell, grid, wall bands (ONE per wall only), and hit shapes. */
export function renderFond(ctx: Contexte, layer: HTMLElement, P: PlanV5, bb: BBox, S: number): void {
  // TWO BACKGROUND LAYERS, AND THAT IS THE WHOLE POINT OF THIS FUNCTION'S SHAPE. A rug lies ON THE
  // FLOOR and a wall rises from it, so a rug spread under a partition must pass UNDER it. With a
  // single svg holding both the floors and the wall bands there was nowhere to put it: above that
  // svg it covered the walls (which is what the owner saw), below it the opaque floor fill hid it
  // completely. So the floors go in one svg, the wall bands in another, and floor coverings are
  // painted between the two (`estAuSol`, `rendu/meubles.ts`).
  layer.querySelectorAll("svg.v5svg").forEach((n) => n.remove());
  const X = (x: number): number => v5R2((x - bb.minX) * S);
  const Y = (y: number): number => v5R2((y - bb.minY) * S);
  const pts = (poly: readonly Pt[]): string => poly.map((p) => X(p[0]) + "," + Y(p[1])).join(" ");
  // R-17, blank-page safeguard: the pattern scale is clamped before any size computation.
  let gs = S;
  if (!isFinite(gs) || gs <= 0) gs = 0.5;
  gs = Math.max(0.01, Math.min(40, gs));
  const m = 100 * gs, f = m / 10;
  const css = getComputedStyle(document.documentElement);
  const cFine = css.getPropertyValue("--grid-fine").trim() || "#e7e9e3";
  const cM = css.getPropertyValue("--grid-m").trim() || "#cfd3cc";
  const cWall = css.getPropertyValue("--line-strong").trim() || "#c6c9c2";
  let defs = `<pattern id="v5gf" width="${f}" height="${f}" patternUnits="userSpaceOnUse">
        <path d="M ${f} 0 L 0 0 0 ${f}" fill="none" stroke="${cFine}" stroke-width="1"/></pattern>
      <pattern id="v5gm" width="${m}" height="${m}" patternUnits="userSpaceOnUse">
        <path d="M ${m} 0 L 0 0 0 ${m}" fill="none" stroke="${cM}" stroke-width="1"/></pattern>`;
  let body = "";
  const W = safeDim(bb.w * S), H = safeDim(bb.l * S);
  (P.cells || []).forEach((c, i) => {
    const fl = floorPatternDefs(c.floor || "parquet", S, "_v5" + i);
    defs += fl.defs + `<clipPath id="v5clip${i}"><polygon points="${pts(c.poly)}"/></clipPath>`;
    const gridOp = (c.floor && c.floor !== "plain") ? 0.45 : 1;
    body += `<polygon points="${pts(c.poly)}" fill="${fl.fill}"/>
        <g clip-path="url(#v5clip${i})" opacity="${gridOp}">
          <rect x="0" y="0" width="${W}" height="${H}" fill="url(#v5gf)"/>
          <rect x="0" y="0" width="${W}" height="${H}" fill="url(#v5gm)"/></g>`;
  });
  // From here on, everything belongs to the WALLS layer, which is painted above the floor coverings.
  let murs = "";
  // outline band (closed) then one segment per interior wall: never two bands at the same spot
  const outBand = Math.max(2, WALL * gs);
  murs += `<polygon points="${pts(P.outline)}" fill="none" stroke="#3b3f3d" stroke-width="${outBand}" stroke-linejoin="miter"/>
      <polygon points="${pts(P.outline)}" fill="none" stroke="${cWall}" stroke-width="1" stroke-linejoin="miter" opacity="0.6"/>`;
  const selW = ctx.ihm.selWall;
  (P.walls || []).forEach((w) => {
    if (w.isOutline) return;
    const band = Math.max(2, (w.t || WALL) * gs);
    const cls = "v5band" + (String(selW) === String(w.id) ? " sel" : "");
    murs += `<line class="${cls}" data-wid="${escapeHtml(w.id)}" x1="${X(w.a[0])}" y1="${Y(w.a[1])}" x2="${X(w.b[0])}" y2="${Y(w.b[1])}"
        stroke="#3b3f3d" stroke-width="${band}" stroke-linecap="square"/>`;
  });
  const faire = (classe: string, dedans: string): SVGSVGElement => {
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", classe);
    svg.setAttribute("width", String(W));
    svg.setAttribute("height", String(H));
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = dedans;
    return svg;
  };
  // The patterns live with the floors; the walls layer needs none.
  layer.insertBefore(faire("v5svg v5svg-murs", murs), layer.firstChild);
  layer.insertBefore(faire("v5svg v5svg-sol", `<defs>${defs}</defs>${body}`), layer.firstChild);
}

/**
 * The openings from the live model, in the SAME container as the furniture.
 *
 * R-2: NO NAME IS EVER WRITTEN ON A WALL OBJECT. The icon already says what it is (a door's arc,
 * a window's broken band, a sconce's half-disk). Measured on the real plan: a single facade
 * carried four stacked labels, and the living room wall three "Sconce" side by side, unreadable
 * at working zoom. 15 opening labels before, 0 after. The name STAYS in the model (the sheet, the
 * furniture list, export, `opening.set` on the wire): we're removing a DISPLAY, not a piece of
 * data, hence the absence of `op.name` from the cache key.
 *
 * R-1, the trap kept here for memory: this `innerHTML` cache key carried NEITHER `side` NOR
 * `rot`, so flipping a sconce rotated its box 180° without rebuilding its content.
 */
export function renderOuvertures(ctx: Contexte, layer: HTMLElement, bb: BBox, S: number): void {
  const P = ctx.etat.plan;
  const X = (x: number): number => v5R2((x - bb.minX) * S);
  const Y = (y: number): number => v5R2((y - bb.minY) * S);
  const seen: Record<string, 1> = {};
  (P.openings || []).forEach((op) => {
    const t = TYPEMAP[op.type];
    if (!t || !pieceVisible(op, ctx.etat.opts)) return;
    const box = v5OpeningBox(P, op, t.h || WALL);
    if (!box) return;
    let el = layer.querySelector<HTMLElement>(`.piece[data-op="1"][data-id="${cssId(op.id)}"]`);
    if (!el) {
      el = document.createElement("div");
      el.className = "piece opening";
      el.dataset["id"] = String(op.id);
      el.dataset["op"] = "1";
      const noeud = el;
      noeud.addEventListener("pointerdown", (ev) => {
        ctx.gestes.ouverturePointerDown?.(ev as PointerEvent, String(noeud.dataset["id"]));
      });
      noeud.addEventListener("dblclick", (ev) => {
        ctx.gestes.ouvertureDblClick?.(ev as MouseEvent, String(noeud.dataset["id"]));
      });
      layer.appendChild(el);
    }
    seen[String(op.id)] = 1;
    const w = box.w, h = box.h, rot = box.rot;
    // 7, ET PLUS 8: l'etage libere sert a l'etiquette de piece, qui doit passer SOUS les commandes
    // du mur (9) sans pour autant passer sous les fenetres, ce qu'elle ne faisait pas avant. Rien
    // d'autre ne vit entre la bande de mur (6) et les commandes, donc l'ouverture ne change de
    // place par rapport a rien: elle reste au-dessus du mur dont elle fait partie, et sous ce qui
    // le commande.
    el.style.zIndex = "7";
    el.dataset["paint"] = "-1";   // an opening is ALWAYS below the furniture (cf. `stackedAt`)
    el.style.left = X(box.cx - w / 2) + "px";
    el.style.top = Y(box.cy - h / 2) + "px";
    el.style.width = safeDim(w * S) + "px";
    el.style.height = safeDim(h * S) + "px";
    el.style.transform = `rotate(${rot}deg)`;
    el.style.borderColor = t.color;
    if (t.opening) { el.style.background = "var(--room-bg)"; el.style.borderWidth = "0"; }
    else { el.style.background = withAlpha(t.color, 0.14); el.style.borderWidth = "1.5px"; }
    el.style.borderRadius = t.opening ? "1px" : "3px";
    el.classList.toggle("sel", isSel(ctx, op.id));
    // `leaf` IS PART OF THE KEY: without it, switching a window from "fixed" to "double" would
    // not change the key, so the icon cache would keep the old drawing and the setting would
    // have no visible effect. Same trap as R-3 on labels.
    const key = `${op.type}|${Math.round(w)}|${Math.round(h)}|${op.hinge ? 1 : 0}|${Number(op.swing) < 0 ? -1 : 1}|${op.leaf || 0}|${Math.round(S * 100)}`;
    if (el.dataset["k"] !== key) {
      el.dataset["k"] = key;
      let html = "";
      if (op.type === "door") html += doorArcSVG(w, op.hinge ? 1 : 0, (Number(op.swing) < 0) ? -1 : 1, resolveColor("var(--open)"));
      else if (op.type === "window") html += windowArcSVG(w, op.hinge ? 1 : 0, (Number(op.swing) < 0) ? -1 : 1, op.leaf || 0, resolveColor("var(--open)"));
      html += pieceIconSVG(op.type, w, h);
      el.innerHTML = html;
      if (op.type === "door" || op.type === "window") {
        const d = el.querySelector<HTMLElement>(".darc");
        if (d) {
          const aw = safeDim(w * S);
          const sg = (Number(op.swing) < 0) ? -1 : 1;
          d.style.left = "0px";
          d.style.top = (sg < 0 ? -aw : 0) + "px";
          d.style.width = aw + "px";
          d.style.height = aw + "px";
        }
      }
      if (op.type === "sdoor") {
        const ic = el.querySelector<HTMLElement>(".picon");
        if (ic && op.hinge) ic.style.transform = "scaleX(-1)";
      }
    }
  });
  layer.querySelectorAll<HTMLElement>('.piece[data-op="1"]').forEach((n) => {
    if (!seen[String(n.dataset["id"])]) n.remove();
  });
}

/**
 * A VIDEOPROJECTOR'S BEAM.
 *
 * It is painted BELOW the furniture and above the floor: it is a placement aid, not an object of
 * the plan, so it must neither cover what's being moved nor be left forgotten. It exists ONLY if
 * a projection ratio has been entered: a projector that was just placed does not bar the room
 * with a cone before anything has been told to it.
 *
 * No state here: everything comes from `modele/projection.ts`, which is pure and proven without
 * a browser.
 */
export function renderFaisceaux(ctx: Contexte, layer: HTMLElement, bb: BBox, S: number): void {
  const P = ctx.etat.plan;
  const vieux = layer.querySelector("svg.v5beams");
  if (vieux) vieux.remove();
  const projs = (P.pieces || []).filter((p) => p.type === "projector" && Number(p.tr) > 0
                                            && pieceVisible(p, ctx.etat.opts));
  if (!projs.length) return;
  const X = (x: number): number => v5R2((x - bb.minX) * S);
  const Y = (y: number): number => v5R2((y - bb.minY) * S);
  let body = "";
  for (const p of projs) {
    const ecran = p.pair ? (P.pieces || []).find((q) => String(q.id) === String(p.pair)) : null;
    const pr = projection(p, ecran || null);
    const poly = polygoneFaisceau(p, ecran || null);
    // Red when the image won't be sharp: this is the only case where the beam must ALERT, width
    // discrepancies are already spelled out in the inspector.
    const col = resolveColor(pr.tropPres ? "var(--danger)" : "var(--open)");
    body += `<polygon points="${poly.map((q) => X(q[0]) + "," + Y(q[1])).join(" ")}"`
      + ` fill="${withAlpha(col, pr.tropPres ? 0.16 : 0.10)}" stroke="${withAlpha(col, 0.45)}"`
      + ` stroke-width="1" stroke-dasharray="6 4"/>`;
    // The firing axis: without it, a very wide cone no longer says where the device is AIMING.
    body += `<line x1="${X(pr.ox)}" y1="${Y(pr.oy)}" x2="${X(pr.ox + pr.ux * pr.distance)}"`
      + ` y2="${Y(pr.oy + pr.uy * pr.distance)}" stroke="${withAlpha(col, 0.35)}" stroke-width="1"`
      + ` stroke-dasharray="3 5"/>`;
  }
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("class", "v5beams");
  const W = safeDim(bb.w * S), H = safeDim(bb.l * S);
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = body;
  // Right after the background, so BELOW the furniture: `insertBefore` on the second child.
  layer.insertBefore(svg, layer.children[1] || null);
}

/**
 * A cell's name, anchored on its POLE OF INACCESSIBILITY (an L-shaped room doesn't have its
 * centroid inside it) then NUDGED AWAY from furniture and from other room labels
 * (`disposerEtiquettesCellules`, `rendu/etiquettes-disposition.ts`).
 *
 * Room labels and furniture labels used to be laid out independently: on a real 103 m2 apartment
 * (ten rooms), a chosen furniture name landed on top of "Cuisine", and other room labels landed on
 * an appliance icon. A label that cannot be placed without overlapping something is DROPPED, never
 * painted over it: the name also lives in the rail, so losing it on the canvas costs less than an
 * unreadable stack.
 */
export function renderEtiquettesCellules(ctx: Contexte, layer: HTMLElement, bb: BBox, S: number): void {
  const P = ctx.etat.plan;
  const seen: Record<string, 1> = {};
  const candidats: CandidatEtiquetteCellule[] = (P.cells || []).map((c) => {
    const pl = poleOfInaccessibility(c.poly);
    const poly = c.poly;
    return {
      id: String(c.id),
      ax: (pl.x - bb.minX) * S,
      ay: (pl.y - bb.minY) * S,
      texte: c.name || "",
      aire: polyArea(c.poly),
      // The label is never pushed into a NEIGHBOR's territory while searching for a clear spot:
      // a nudge is only tried while it is still inside THIS cell's own polygon.
      dansCellule: (x: number, y: number) => pointInPoly(x / S + bb.minX, y / S + bb.minY, poly),
    };
  });
  const obstacles = obstaclesMeubles(P.pieces || [], ctx.etat.opts, S, bb);
  const places = disposerEtiquettesCellules(candidats, obstacles);
  (P.cells || []).forEach((c) => {
    const id = String(c.id);
    const pos = places.get(id) || null;
    let el = layer.querySelector<HTMLElement>(`.ov-name[data-c="${cssId(c.id)}"]`);
    if (!pos) { if (el) el.remove(); return; } // YIELDS: no spot clears every obstacle
    if (!el) {
      el = document.createElement("div");
      el.className = "ov-name ov-name-center";
      el.dataset["c"] = String(c.id);
      const noeud = el;
      noeud.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        ctx.gestes.choisirCellule?.(String(noeud.dataset["c"]), true);
      });
      layer.appendChild(el);
    }
    seen[id] = 1;
    el.textContent = c.name || "";
    el.classList.toggle("focused", String(ctx.ihm.selCell) === String(c.id));
    el.style.left = pos.x + "px";
    el.style.top = pos.y + "px";
    el.style.right = "auto";
  });
  layer.querySelectorAll<HTMLElement>(".ov-name[data-c]").forEach((n) => {
    if (!seen[String(n.dataset["c"])]) n.remove();
  });
}

/**
 * OUTLINE handles (edges, corner insertions, vertices) and the delete cross of the selected wall.
 * The outline controls exist only while a facade or one of its corners is selected. They cover
 * the whole perimeter, so mere hover would make them intrude on ordinary work near a wall.
 *
 * G-15: the corner-insertion "+" is OFFSET 18 px OUTSIDE the outline. Placed on the facade, it
 * stole the selection click, and its global recomputation would cut the wall in two and move
 * 16 pieces of furniture.
 */
export function drawHandles(ctx: Contexte, layer: HTMLElement, bb: BBox, S: number): void {
  // EVERY handle class belongs in this list, and forgetting one leaves ghosts on screen. `.v5wjoin`
  // was missing: the merge controls were never removed, so they piled up and survived the deletion
  // of the very wall they belonged to. Reported from real use as two "-" floating in mid-air.
  layer.querySelectorAll(".vtx,.mid,.edge,.v5wx,.v5wend,.v5wmid,.v5wmove,.v5wjoin,.v5wdroit").forEach((n) => n.remove());
  if (ctx.ihm.hoverWall && !(ctx.etat.plan.walls || []).some((w) => String(w.id) === String(ctx.ihm.hoverWall))) {
    ctx.ihm.hoverWall = null;
  }
  const poly = ctx.etat.plan.outline, np = poly.length;
  const toC = (x: number, y: number): { x: number; y: number } => ({ x: (x - bb.minX) * S, y: (y - bb.minY) * S });
  const selectionMur = (ctx.etat.plan.walls || []).find((w) => String(w.id) === String(ctx.ihm.selWall));
  const contourVisible = !!selectionMur?.isOutline || ctx.selVtx >= 0;
  for (let i = 0; i < np && contourVisible; i++) {
    const a = poly[i]!, b = poly[(i + 1) % np]!;
    const sa = toC(a[0], a[1]), sb = toC(b[0], b[1]);
    const s = { x: (sa.x + sb.x) / 2, y: (sa.y + sb.y) / 2 };
    const lenpx = Math.hypot(sb.x - sa.x, sb.y - sa.y);
    const ang = Math.atan2(sb.y - sa.y, sb.x - sa.x) * 180 / Math.PI;
    const eb = document.createElement("div");
    eb.className = "edge";
    const ow = (ctx.etat.plan.walls || []).find((w) => w.isOutline
      && (Math.hypot(w.a[0] - a[0], w.a[1] - a[1]) + Math.hypot(w.b[0] - b[0], w.b[1] - b[1]) < 2
       || Math.hypot(w.a[0] - b[0], w.a[1] - b[1]) + Math.hypot(w.b[0] - a[0], w.b[1] - a[1]) < 2));
    if (ow) eb.dataset["w"] = String(ow.id);
    eb.style.width = Math.max(10, lenpx - 36) + "px";
    eb.style.left = s.x + "px";
    eb.style.top = s.y + "px";
    eb.style.transform = `translate(-50%,-50%) rotate(${ang}deg)`;
    const aa = ((ang % 180) + 180) % 180;
    eb.style.cursor = (aa < 20 || aa > 160) ? "ns-resize" : (aa > 70 && aa < 110) ? "ew-resize" : "move";
    eb.title = "Click to select this facade · drag to move it";
    const idx = i;
    eb.addEventListener("pointerdown", (ev) => ctx.gestes.contourAretePointerDown?.(ev as PointerEvent, idx));
    layer.appendChild(eb);
    const nOut = outlineOutward(ctx, i);
    const md = document.createElement("div");
    md.className = "mid";
    md.textContent = "+";
    md.title = "Insert a corner on this facade";
    md.style.left = (s.x + nOut.x * 18) + "px";
    md.style.top = (s.y + nOut.y * 18) + "px";
    md.addEventListener("pointerdown", (ev) => ctx.gestes.contourInsertionPointerDown?.(ev as PointerEvent, idx));
    layer.appendChild(md);
  }
  poly.forEach((v, i) => {
    if (!contourVisible) return;
    const s = toC(v[0], v[1]);
    const h = document.createElement("div");
    h.className = "vtx" + ((i === ctx.selVtx) ? " sel" : "");
    h.style.left = s.x + "px";
    h.style.top = s.y + "px";
    h.title = "Drag to move · click then Del to remove";
    const x = document.createElement("div");
    x.className = "vx";
    x.textContent = "×";
    x.title = "Remove this corner";
    x.addEventListener("pointerdown", (ev) => ctx.gestes.contourSommetSupprimer?.(ev as PointerEvent, i));
    h.appendChild(x);
    h.addEventListener("pointerdown", (ev) => ctx.gestes.contourSommetPointerDown?.(ev as PointerEvent, i));
    layer.appendChild(h);
  });
  // THE HANDLES BELONG TO THE WALL UNDER THE POINTER, not to the selected one. Keeping them on a
  // SELECTED wall meant that after drawing a partition, its five discs stayed floating on screen
  // for as long as it remained selected, and they stole the clicks meant for the wall next to it:
  // the owner reported having to click away or press Escape before he could split or delete
  // anything else. Selection still highlights the wall and drives its sheet; it just does not own
  // the controls. The selected wall is kept in the list only WHILE A GESTURE IS RUNNING on it, so
  // dragging a handle past the wall it belongs to does not make it vanish under the hand.
  const ids = [gesteActif() ? ctx.ihm.selWall : null, ctx.ihm.hoverWall]
    .filter((id, i, a): id is string => !!id && a.indexOf(id) === i);
  const murs = ids.map((id) => (ctx.etat.plan.walls || []).find((q) => String(q.id) === String(id))).filter((w) => w !== undefined);
  for (const w of murs) {
    const mx = (w.a[0] + w.b[0]) / 2, my = (w.a[1] + w.b[1]) / 2;
    const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1], L = Math.hypot(dx, dy) || 1;
    const lenpx = L * S;
    const sMid = toC(mx, my);
    // A SHORT WALL SHRINKS ITS HANDLES: it never moves them and never hides them. Hiding was the
    // defect the owner hit, a 47 cm partition offering one handle out of five, with the END HANDLE
    // OF THE NEIGHBOURING WALL sitting on its tip and taking the gesture. Pushing them outward was
    // tried the same day and rejected: the disc then no longer sits where the end IS, so pressing
    // the visible tip of the wall fell through to DRAWING, the same defect in another hat.
    // Position must stay truthful. Size is what gives, down to 55 %, which keeps a 9 px target.
    // Le facteur se mesure sur la BOITE, pas sur le disque: c'est elle qui decide si deux commandes
    // se marchent dessus, et c'est un clic vole qui fait mal, pas un dessin serre.
    const facteur = Math.max(0.55, Math.min(1, lenpx / 64));
    // UNE CIBLE PLUS LARGE QUE SON DESSIN. Le bouton faisait 20 px, exactement sa taille visible, et
    // le corps du mur autour TRACE depuis qu'il n'y a plus de mode: rater la prise de deux pixels
    // creait donc un mur par-dessus celui qu'on voulait deplacer. Signale a l'usage: « je veux
    // attraper le mur par le rond et ca dessine ». Chaque bouton devient une boite TRANSPARENTE de
    // 32 px qui contient son disque de 20: la surface saisissable grandit de moitie, le dessin ne
    // bouge pas d'un pixel, et un quasi-succes cesse d'etre destructif.
    const BOITE = 32;
    const disque = (r: number, remplissage: string, contour: string, dedans: string): string =>
      `<svg viewBox="0 0 ${BOITE} ${BOITE}" width="100%" height="100%" aria-hidden="true">`
      + `<circle cx="16" cy="16" r="${r}" fill="${remplissage}" stroke="${contour}" stroke-width="2"/>`
      + dedans + `</svg>`;
    const traits = (d: string): string =>
      `<g stroke="#fff" stroke-width="2.2" stroke-linecap="round" fill="none">${d}</g>`;
    const boite = (base: number): string => {
      const c = BOITE * facteur * (base / 20);
      return `width:${c.toFixed(1)}px;height:${c.toFixed(1)}px;`
        + `margin:${(-c / 2).toFixed(1)}px 0 0 ${(-c / 2).toFixed(1)}px;`;
    };
    const facade = !!w.isOutline;
    // LA NORMALE ET L'ÉCART SONT DÉCIDÉS AVANT TOUT BOUTON, parce que c'est d'eux que dépend la
    // place de chacun, donc le palier auquel il tombe.
    // THE SIDE IS DECIDED ON SCREEN, NOT BY THE WALL'S STORED DIRECTION. The normal of a segment
    // flips with the order of `a` and `b`, which is arbitrary: two walls drawn the same way but
    // stored in opposite directions put the delete cross on opposite sides, and the owner has to
    // look for it every time. We therefore orient the normal so it always points DOWN the screen,
    // and to the RIGHT for a vertical wall. The delete cross then always sits below (or right of)
    // the wall, and the split control always above (or left of) it.
    let nx = -dy / L, ny = dx / L;
    if (ny < 0 || (Math.abs(ny) < 1e-9 && nx < 0)) { nx = -nx; ny = -ny; }
    // ET SUR UNE FACADE, LA NORMALE EST CELLE DU CONTOUR, TOURNEE VERS L'INTERIEUR. Le « + » du
    // contour (`.mid`, G-15) est deja pose 18 px A L'EXTERIEUR de la meme arete: y poser aussi la
    // coupe de la facade remettrait deux commandes au meme pixel, ce qui est exactement le defaut
    // que G-15 a corrige. On prend donc l'AUTRE cote, a l'interieur du logement, ou la seule chose
    // presente est le sol de la cellule. Les deux « + » sont alors separes d'au moins 50 px et
    // chacun reste atteignable. Sans arete identifiable (une facade orpheline en cours de
    // recalcul), on retombe sur l'orientation ecran ordinaire.
    if (facade) {
      const arete = v5IndexAreteContour(ctx.etat.plan, w.id);
      const dehors = arete >= 0 ? outlineOutward(ctx, arete) : null;
      if (dehors) { nx = dehors.x; ny = dehors.y; }
    }
    // DEUX BOITES NE SE RECOUVRENT JAMAIS. L'ecart perpendiculaire doit valoir au moins une boite
    // entiere, sinon la coupe et la suppression mordent sur le bouton de deplacement et un
    // presque-rate atteint la mauvaise commande. C'est la meme famille de defaut que le « + » du
    // contour qui volait le clic d'une facade.
    const off = Math.max(((w.t || 0) * S) / 2 + 16, BOITE * facteur + 2);

    // UN MUR TROP COURT EN PORTE MOINS, JAMAIS ZÉRO, ET L'ORDRE N'EST PAS ARBITRAIRE.
    // Avant, un seul seuil (28 px de longueur à l'écran) retirait d'un coup la coupe, la croix ET
    // les maillons: sur le plan réel à 77 objets, au zoom d'ajustement, la cloison de 47 cm
    // (24,3 px) devenait impossible à couper comme à supprimer, et il fallait zoomer de 15 % de
    // plus pour la retrouver, sans que rien ne le dise. Dézoomé de moitié, 3 murs sur 22 étaient
    // dans ce cas. Les boutons se posent donc du plus utile au moins utile, et chacun n'apparaît
    // que s'il reste de la place pour lui:
    //   1. le DISQUE DE DÉPLACEMENT: sans lui le corps du mur trace au lieu de le saisir, donc
    //      il n'a aucune solution de rechange, pas même le clavier (rien n'est sélectionné);
    //   2. la CROIX: elle est le seul geste de pointage qui supprime, et elle se pose de l'autre
    //      côté de la normale, donc elle ne dispute sa place à personne;
    //   3. la COUPE « + »: elle garde son seuil de longueur, mais pour ce qu'il veut vraiment
    //      dire — couper plus court laisse deux moitiés qu'on ne peut plus viser;
    //   4. les BOUTS, puis 5. les MAILLONS: ils cèdent en premier parce qu'ils ont, eux, une
    //      solution de rechange immédiate, zoomer.
    // Et la place se vérifie sur les BOITES, pas sur la longueur: deux boutons au même pixel
    // valent zéro bouton (mesuré: sous ~32 px, le disque de déplacement et les deux bouts se
    // recouvraient, chacun rendant l'autre inatteignable).
    const COUPE_MIN = 28;
    const posees: Array<{ x: number; y: number; c: number }> = [];
    const poser = (el: HTMLElement, x: number, y: number, base: number): boolean => {
      const c = BOITE * facteur * (base / 20);
      for (const q of posees) {
        if (Math.abs(q.x - x) < (q.c + c) / 2 - 0.5 && Math.abs(q.y - y) < (q.c + c) / 2 - 0.5) return false;
      }
      posees.push({ x, y, c });
      el.style.left = x + "px";
      el.style.top = y + "px";
      layer.appendChild(el);
      return true;
    };
    // UNE FAÇADE N'A PAS DEUX COMMANDES AU MÊME ENDROIT. Sa poignée de déplacement ne sait que
    // SÉLECTIONNER (le contour se remodèle par ses arêtes et ses coins), et elle se pose au milieu
    // du segment, exactement là où la bande `.edge` du contour se saisit. Depuis que les poignées
    // passent au-dessus des meubles, elle passait aussi au-dessus de `.edge` et volait le
    // glissement: tirer une façade ne la déplaçait plus. Une fois le contour révélé, `.edge`
    // sélectionne ET déplace, donc la poignée n'a plus de raison d'être là.
    // La facade GARDE son bouton meme quand le contour est revele: c'est lui la prise de premiere
    // classe, au-dessus des fenetres, et c'est lui qui deplace. La bande `.edge` reste disponible
    // partout ailleurs le long du mur, la ou une fenetre a le droit de gagner le clic.
    const move = document.createElement("div");
    move.className = "v5wmove";
    move.dataset["w"] = String(w.id);
    move.style.cssText = boite(20);
    move.innerHTML = disque(9, "var(--accent)", "var(--room-bg)", "");
    move.title = w.isOutline ? "Click to select this facade" : "Click to select this wall, or drag to move it";
    move.addEventListener("pointerdown", (ev) => ctx.gestes.deplacerMurPointerDown?.(ev as PointerEvent, String(w.id)));
    poser(move, sMid.x, sMid.y, 20);
    // UNE FACADE PORTE SON « + » ET SON MAILLON, JAMAIS SA CROIX NI SES BOUTS. Demande du
    // proprietaire, mot pour mot: « je peux resize un mur de facade comme je veux, donc je devrais
    // aussi pouvoir le couper », et « quand un autre mur coupe une facade je veux que les deux
    // moities aient ce bouton en leur centre ». Les deux exceptions sont DELIBEREES:
    //   - pas de croix: un mur de contour est DERIVE du contour, il ne se supprime pas
    //     (`v5WallDeleteVerdict` verdict `facade`), et un bouton qui refuse n'apprend rien;
    //   - pas de poignees de bout: les bouts d'une facade sont les COINS du contour, qui ont deja
    //     leur poignee `.vtx` exactement au meme pixel. Deux commandes au meme endroit s'annulent.
    // UNE FACADE PORTE SON « + » ET SON MAILLON, JAMAIS SA CROIX NI SES BOUTS: voir plus haut.
    // G-15-BIS: SAME TRAP AS THE OUTLINE'S "+", one wall family over. Dead-center on the wall's
    // own segment, this "x" used to sit exactly where `[data-w]` (the drag band, G-3's "grab it
    // again to nudge it") is grabbed: selecting a wall by dragging it once, then reaching for the
    // SAME spot to adjust it again, deleted it instead — the delete handler wins the hit-test the
    // layer's own early return grants `.v5wx` (`v5LayerDown`). Measured: a wall dragged out and
    // back vanished on the second grab, silently (no toast, `v5DeleteSelectedWall`'s refusal path
    // is for facades, not "wrong target"). Offset PERPENDICULAR to the wall, clear of its own
    // half-thickness, exactly the outline fix's shape (`outlineOutward`, an outward normal), so
    // the drag band stays reachable at its own center.
    // PALIER 2, ET IL NE CONNAIT PAS DE SEUIL DE LONGUEUR: la croix est seule de son cote de la
    // normale, donc raccourcir le mur ne la met en concurrence avec rien. C'est exactement ce qui
    // manquait: elle tombait avec la coupe alors que rien ne l'y obligeait.
    if (!facade) {
      const x = document.createElement("div");
      x.className = "v5wx";
      x.dataset["w"] = String(w.id);
      x.innerHTML = disque(9, "var(--accent)", "var(--room-bg)",
        traits('<line x1="12.9" y1="12.9" x2="19.1" y2="19.1"/><line x1="19.1" y1="12.9" x2="12.9" y2="19.1"/>'));
      x.title = "Delete this wall (the two rooms merge)";
      x.style.cssText = boite(20);
      x.addEventListener("pointerdown", (ev) => ctx.gestes.supprimerMurSelectionne?.(ev as PointerEvent, String(w.id)));
      poser(x, sMid.x + nx * off, sMid.y + ny * off, 20);
    }
    // PALIER 3, LE SEUL QUI RESTE UNE LONGUEUR, et pour ce qu'il veut vraiment dire: couper un mur
    // plus court que ca donne deux moities trop petites pour porter leur propre bouton, donc une
    // coupe qu'on ne peut plus defaire a la main.
    // The split control uses the same clearance as the delete cross, on the opposite normal. If it
    // sat on the segment itself it would steal the wall band's midpoint, the ordinary place used
    // to grab the selected wall again and nudge the whole partition.
    if (lenpx >= COUPE_MIN) {
      const coude = document.createElement("div");
      coude.className = "v5wmid";
      coude.dataset["w"] = String(w.id);
      // DESSINE, PAS ECRIT. Un glyphe de police s'aligne sur ses propres metriques: en monospace, le
      // « + » et le « x » s'assoient sur l'axe mathematique, donc plus haut que le centre optique du
      // disque, et aucun centrage CSS ne rattrape ca. Signale a l'oeil par le proprietaire sur la
      // croix. Les trois boutons sont donc des traits dans le meme carre de 20, geometriquement
      // centres et coherents entre eux.
      coude.innerHTML = disque(9, "var(--accent)", "var(--room-bg)",
        traits('<line x1="16" y1="11.6" x2="16" y2="20.4"/><line x1="11.6" y1="16" x2="20.4" y2="16"/>'));
      coude.title = facade ? "Split this facade in two here" : "Split this wall in two here";
      coude.style.cssText = boite(20);
      coude.addEventListener("pointerdown", (ev) => ctx.gestes.coudeMurPointerDown?.(ev as PointerEvent, String(w.id)));
      poser(coude, sMid.x - nx * off, sMid.y - ny * off, 20);
    }
    // PALIER 3-BIS: L'ÉQUERRE, ET ELLE N'EXISTE QUE SUR UN MUR DE TRAVERS.
    // Le propriétaire: « the vertical wall on the right is slightly off, i want a way to make it
    // perpendicular ». Ses deux murs de travers n'ont AUCUNE poignée de bout (leurs quatre bouts
    // sont des jonctions, `v5BoutJoint` les retire), donc aucun geste ne pouvait fixer leur
    // direction. Le modèle décide seul si ce bouton a le droit d'exister (`v5MurDeTravers`), comme
    // le maillon plus bas: un contrôle qui apparaît puis refuse n'apprend rien.
    // Il se pose du côté de la croix, un cran plus loin, donc il ne dispute son pixel ni au disque
    // ni au « + »; et sur un mur trop court `poser` le refuse, comme tous les autres.
    if (!facade && v5MurDeTravers(ctx.etat.plan, w.id)) {
      const eq = document.createElement("div");
      eq.className = "v5wdroit";
      eq.dataset["w"] = String(w.id);
      // UNE ÉQUERRE, DESSINÉE. Un angle droit et son petit carré de sommet: c'est le symbole du
      // dessin technique pour « ici c'est perpendiculaire », et il se lit dans une boite de 20.
      eq.innerHTML = disque(9, "var(--accent)", "var(--room-bg)",
        traits('<path d="M11.2 10 L11.2 21 L22.2 21"/><path d="M15.8 21 L15.8 16.4 L20.4 16.4" stroke-width="1.3" opacity=".75"/>'));
      eq.title = "Square this wall up (it is slightly off)";
      eq.style.cssText = boite(20);
      eq.addEventListener("pointerdown", (ev) => ctx.gestes.redresserMurPointerDown?.(ev as PointerEvent, String(w.id)));
      poser(eq, sMid.x + nx * off * 2, sMid.y + ny * off * 2, 20);
    }
    // PALIER 4: LES BOUTS, qui cedent quand leur boite mord celle du deplacement.
    // ENDPOINT HANDLES (owner's report: "choper les extrémités des murs et pouvoir étendre et
    // relier à d'autres murs"). One per end, sitting EXACTLY on the endpoint: unlike the
    // outline's "+" (G-15) there is no selection click to steal here, since the wall's own drag
    // band already covers the whole segment INCLUDING its very tip, and grabbing the small
    // circle right on top of it starts `v5StartWallEndDrag` instead (wired through
    // `ctx.gestes.boutMurPointerDown`, `gestes/branchement.ts`), which moves ONLY that end.
    if (!facade) (["a", "b"] as const).forEach((bout) => {
      // UN JOINT N'EST PAS UN BOUT. Si quelque chose tient deja cette extremite (un autre mur, son
      // flanc, la facade), on n'offre pas de prise pour l'etirer: tirer dessus dechirerait la
      // jonction qu'on vient de faire. Signale par le proprietaire juste apres une coupe, ou les
      // deux moities exhibaient le point de coupe comme un bout saisissable. Ce qui a sa place la
      // est le « - » qui ressoude, et il y est deja.
      if (v5BoutJoint(ctx.etat.plan, w.id, bout)) return;
      const p = w[bout];
      const s = toC(p[0], p[1]);
      const h = document.createElement("div");
      h.className = "v5wend";
      h.dataset["w"] = String(w.id);
      h.dataset["bout"] = bout;
      h.style.cssText = boite(16);
      h.innerHTML = disque(7, "var(--room-bg)", "var(--accent)", "");
      h.title = "Drag to extend this wall, or connect it to another";
      h.addEventListener("pointerdown", (ev) => ctx.gestes.boutMurPointerDown?.(ev as PointerEvent, String(w.id), bout));
      poser(h, s.x, s.y, 16);
    });

    // THE "-" ONLY EXISTS WHERE WELDING IS LEGITIMATE. The model decides (`v5WallMergeCandidate`):
    // exactly two walls at this joint, neither of them a facade, and the two continuing one
    // another. A control that appears and then refuses teaches nothing; one that is simply absent
    // says "not here" without a word. It sits on the same side as the "+", so the pair that cuts
    // and welds reads together, and the delete cross keeps the other side to itself.
    // SUR UNE FACADE, LE MAILLON RESSOUDE UN SOMMET PLAT. Deux moities de facade ne sont pas deux
    // murs poses cote a cote: ce sont deux ARETES du contour separees par un sommet, et les
    // recoller veut dire retirer ce sommet (`v5SommetPlatDeFacade`). Meme garde que pour deux
    // cloisons: les deux aretes doivent se continuer, et rien d'autre ne doit tenir ce point.
    // PALIER 5, LE DERNIER A ETRE SERVI: le maillon partage le cote du « + », donc c'est lui qui
    // cede quand les deux se disputent le meme pixel sur un mur court. Ressouder a une solution de
    // rechange immediate, zoomer; supprimer n'en a pas.
    (["a", "b"] as const).forEach((bout) => {
      if (facade ? v5SommetPlatDeFacade(ctx.etat.plan, w.id, bout) < 0
        : !v5WallMergeCandidate(ctx.etat.plan, w.id, bout)) return;
      const p = toC(w[bout][0], w[bout][1]);
      const m = document.createElement("div");
      m.className = "v5wjoin";
      m.dataset["w"] = String(w.id);
      m.dataset["bout"] = bout;
      // DEUX MAILLONS, PAS UN MOINS. Un « - » dit « enlever »; ici on RELIE. Demande du
      // proprietaire. Deux capsules qui se chevauchent se lisent encore a 11 px, la ou une chaine
      // dessinee finement devient une tache.
      m.innerHTML = disque(9, "var(--accent)", "var(--room-bg)",
        '<g fill="none" stroke="#fff" stroke-width="1.9" stroke-linejoin="round">'
        + '<rect x="8.9" y="13.2" width="7.4" height="5.6" rx="2.8"/>'
        + '<rect x="15.7" y="13.2" width="7.4" height="5.6" rx="2.8"/></g>');
      m.title = facade ? "Weld these two halves of the facade back together"
        : "Weld this wall to the one it continues";
      m.style.cssText = boite(20);
      m.addEventListener("pointerdown", (ev) => ctx.gestes.fusionnerMurPointerDown?.(ev as PointerEvent, String(w.id), bout));
      poser(m, p.x - nx * off, p.y - ny * off, 20);
    });
  }
}

/**
 * OUTWARD normal of the outline's edge `i`, in screen coordinates (y downward). Ported from
 * `v5OutlineOutward` (src/js/53): rendering needs it to offset the "+" outside the outline, and
 * that is its only dependency on this utility file.
 */
export function outlineOutward(ctx: Contexte, i: number): { x: number; y: number } {
  const poly = ctx.etat.plan && ctx.etat.plan.outline;
  if (!poly || poly.length < 3) return { x: 0, y: -1 };
  const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
  let nx = -dy / L, ny = dx / L;
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  if (pointInPoly(mx + nx * 10, my + ny * 10, poly)) { nx = -nx; ny = -ny; }
  return { x: nx, y: ny };
}
