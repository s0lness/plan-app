// src/ts/rendu/meubles.ts: RECONCILING THE FURNITURE IN THE LAYER, the most expensive code in the
// repo. G-9 (paint from largest to smallest, the stack sorts on `data-paint`, not array order or
// `.piece.sel`'s z-index), R-1 (the label is a CHILD of the rotated node, `setLabelSpin` cancels
// its rotation), R-6 (a label never leaves its tile: horizontal chord of the rotated rectangle),
// G-20 (handles never eat into the object's surface below 64px, only the four corners remain).
//
// This module DECIDES nothing: it paints what the plan says. Gestures wire in via `ctx.gestes`.

import type { Contexte } from "../app/contexte.ts";
import type { BBox } from "../geometrie/polygones.ts";
import { TYPEMAP, estAuSol, isWallMount, pieceVisible } from "../catalogue/catalogue.ts";
import { setLabelSpin } from "../noyau/dom.ts";
import { safeDim } from "../noyau/nombres.ts";
import { resolveColor, withAlpha } from "./couleurs.ts";
import { pieceIconSVG } from "./icones.ts";
import { doorArcSVG } from "./arc-porte.ts";
import { isChosenName } from "./noms.ts";
import { isSel } from "./selection.ts";
import { indexerParId } from "./index-noeuds.ts";

/**
 * LES ENFANTS D'UNE TUILE, RETENUS AVEC ELLE. Le corps d'une tuile est ecrit UNE fois, a la
 * creation, et ses enfants ne bougent plus: les rechercher a chaque image coutait six
 * `querySelector` par meuble (icone, enveloppe d'etiquette, etiquette, cote, poignee de rotation,
 * arc de porte), soit plus de mille par image sur un plan de 200 objets. Ils sont donc retenus AVEC
 * le noeud, dans une `WeakMap`: le jour ou la tuile est retiree du calque, l'entree part avec elle.
 *
 * DEUX ENFANTS SONT REMPLACES EN COURS DE VIE et c'est la seule subtilite: l'icone (`outerHTML`
 * quand la taille ou le type change) et l'arc de porte (retire puis reinsere). Les deux sont
 * reecrits DANS le cache au moment ou ils changent, jamais relus depuis le DOM.
 */
interface NoeudsMeuble {
  slot: HTMLElement | null;
  wrap: HTMLElement | null;
  lab: HTMLElement | null;
  dim: HTMLElement | null;
  rh: HTMLElement | null;
  darc: HTMLElement | null;
}
const noeudsMeuble = new WeakMap<HTMLElement, NoeudsMeuble>();

function noeuds(el: HTMLElement): NoeudsMeuble {
  let n = noeudsMeuble.get(el);
  if (!n) {
    n = {
      slot: el.querySelector<HTMLElement>(".picon-slot"),
      wrap: el.querySelector<HTMLElement>(".plabel-wrap"),
      lab: el.querySelector<HTMLElement>(".plabel"),
      dim: el.querySelector<HTMLElement>(".pdim"),
      rh: el.querySelector<HTMLElement>(".rot-handle"),
      darc: el.querySelector<HTMLElement>(".darc"),
    };
    noeudsMeuble.set(el, n);
  }
  return n;
}

/**
 * Model of the resize handles. `(ux,uy)` = the handle's position in the LOCAL, non-rotated
 * box, in half-extents (-1..1, center at 0,0); `ax/ay` = the OPPOSITE anchor, which stays fixed
 * during the drag; `dw/dh` = which dimensions this handle changes (corners: both).
 */
export interface PoigneeRedim {
  k: string;
  ux: -1 | 0 | 1;
  uy: -1 | 0 | 1;
  ax: -1 | 0 | 1;
  ay: -1 | 0 | 1;
  dw: 0 | 1;
  dh: 0 | 1;
}

export const RSZ_HANDLES: PoigneeRedim[] = [
  { k: "nw", ux: -1, uy: -1, ax: 1, ay: 1, dw: 1, dh: 1 },
  { k: "ne", ux: 1, uy: -1, ax: -1, ay: 1, dw: 1, dh: 1 },
  { k: "se", ux: 1, uy: 1, ax: -1, ay: -1, dw: 1, dh: 1 },
  { k: "sw", ux: -1, uy: 1, ax: 1, ay: -1, dw: 1, dh: 1 },
  { k: "n", ux: 0, uy: -1, ax: 0, ay: 1, dw: 0, dh: 1 },
  { k: "s", ux: 0, uy: 1, ax: 0, ay: -1, dw: 0, dh: 1 },
  { k: "e", ux: 1, uy: 0, ax: -1, ay: 0, dw: 1, dh: 0 },
  { k: "w", ux: -1, uy: 0, ax: 1, ay: 0, dw: 1, dh: 0 },
];

export const RSZ_BYKEY: Record<string, PoigneeRedim> = {};
for (const h of RSZ_HANDLES) RSZ_BYKEY[h.k] = h;

export const RSZ_MIN = 10, RSZ_MAX = 3000;
/**
 * Tile size (screen px) below which the handles shrink to the 4 corners and move outside the box.
 * 64 px = the smallest tile that still leaves a comfortable center with the 8 handles
 * sitting on the edge; 6 px = half a handle, plus a hair.
 */
export const RSZ_COMPACT_PX = 64, RSZ_OUT_PX = 6;

/**
 * Effective cursor for a handle on an object rotated by `rot`. The handle's outward direction,
 * rotated then quantized into 45° buckets, picks one of the four families: the double arrow
 * THEN points along the drag axis, which the CSS's static cursors can only do at rot = 0.
 */
export function resizeCursor(h: PoigneeRedim, rot: number): string {
  let a = Math.atan2(h.uy, h.ux) * 180 / Math.PI + (rot || 0);
  a = ((a % 180) + 180) % 180;           // a cursor is symmetric at 180°
  const bucket = Math.round(a / 45) % 4; // 0°→ew, 45°→nwse, 90°→ns, 135°→nesw
  return (["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"] as const)[bucket] || "ew-resize";
}

/**
 * G-9. The `.piece` nodes under the pointer, SORTED ON `data-paint` (the paint rank), never
 * on the order returned by `elementsFromPoint`: that one moves as soon as something is selected.
 */
export function stackedAt(e: { clientX: number; clientY: number }): HTMLElement[] {
  if (!document.elementsFromPoint) return [];
  const out: HTMLElement[] = [];
  document.elementsFromPoint(e.clientX, e.clientY).forEach((n) => {
    const pe = (n as Element).closest ? (n as Element).closest<HTMLElement>(".piece") : null;
    if (pe && pe.dataset["id"] && out.indexOf(pe) < 0) out.push(pe);
  });
  out.sort((a, b) => (+(b.dataset["paint"] || 0) || 0) - (+(a.dataset["paint"] || 0) || 0));
  return out;
}

/**
 * WHAT RENDERING READS FROM THE CATALOG, and nothing more. A `type` coming from an old plan or an
 * import is NOT necessarily in the catalog: the old client used to fall back to `{color:"var(--seat)"}`,
 * which is exactly what this type expresses.
 */
type TraitsPeints = {
  color: string;
  opening?: boolean | undefined;
  wallMount?: boolean | undefined;
  round?: boolean | undefined;
  soft?: boolean | undefined;
};

/**
 * Reconciles the furniture in the layer. `bb` = the outline's bbox (px origin of the layer).
 * A piece of furniture has APARTMENT coordinates: its px position is `(x - bb.minX) * scale`, period.
 */
export function renderPieces(ctx: Contexte, container: HTMLElement, bb: BBox): void {
  const seen: Record<string, 1> = {};
  const S = ctx.vue.scale;
  const lst = (ctx.etat.plan && ctx.etat.plan.pieces) || [];

  // G-9: from LARGEST to smallest; on equal area, array order breaks the tie.
  const rang = new Array<number>(lst.length);
  lst.map((p, i) => ({ i, a: (+p.w || 0) * (+p.h || 0) }))
    .sort((u, v) => (v.a - u.a) || (u.i - v.i))
    .forEach((o, k) => { rang[o.i] = k; });

  // UN SEUL PARCOURS DU CALQUE, au lieu d'un `querySelector` par meuble (`index-noeuds.ts`).
  const index = indexerParId(container, ".piece:not([data-op])");

  lst.forEach((p, i) => {
    if (!pieceVisible(p, ctx.etat.opts)) return;
    let el = index.get(String(p.id)) || null;
    const t: TraitsPeints = TYPEMAP[p.type] || { color: "var(--seat)" };
    if (!el) {
      el = document.createElement("div");
      el.className = "piece";
      el.dataset["id"] = String(p.id);
      // Resize handles are NOT created here: they only exist on the selected
      // piece (before: 8 nodes per piece of furniture, 376 in total, and a querySelectorAll per
      // piece on every frame).
      el.innerHTML = `<span class="picon-slot"></span><div class="plabel-wrap"><span class="plabel"></span><span class="pdim"></span></div><span class="rot-handle" data-rot="1"></span>`;
      // The DOM node survives object replacements (wire ops, adoptions), the creation closure
      // does not: the id is resolved, never the captured object.
      const noeud = el;
      noeud.addEventListener("pointerdown", (e) => {
        ctx.gestes.meublePointerDown?.(e as PointerEvent, String(noeud.dataset["id"]));
      });
      noeud.addEventListener("dblclick", (e) => {
        ctx.gestes.meubleDblClick?.(e as MouseEvent, String(noeud.dataset["id"]));
      });
      container.appendChild(el);
      index.set(String(p.id), el);
    }
    const nds = noeuds(el);
    seen[String(p.id)] = 1;
    const lx = (p.x - bb.minX) * S, ly = (p.y - bb.minY) * S;
    // A FLOOR COVERING IS PAINTED UNDER THE WALLS. `renderFond` draws the floors and the wall bands
    // in two separate svg layers precisely so that a rug can sit between them: a rug lies on the
    // floor, and a wall rises from the floor it covers. Everything else keeps its ordinary rank
    // above both. Reported from real use: a rug spread across a partition covered it.
    el.style.zIndex = estAuSol(p.type) ? String(Math.min(5, 2 + (rang[i] ?? 0))) : String(10 + (rang[i] ?? 0));
    el.dataset["paint"] = String(rang[i] ?? 0);   // STABLE rank: selection does not change it
    const pw = p.w * S, ph = p.h * S;
    el.style.width = safeDim(pw) + "px";
    el.style.height = safeDim(ph) + "px";
    el.style.left = lx + "px";
    el.style.top = ly + "px";
    el.style.transform = `rotate(${p.rot}deg)`;
    if (el.classList.contains("peer-ghost")) { el.classList.remove("peer-ghost"); el.style.outlineColor = ""; }
    el.style.borderColor = t.color;
    const wallMount = isWallMount(p.type);
    el.classList.toggle("opening", !!t.opening);
    // The rotation handle floats 24 px ABOVE the piece: placed on every piece of furniture, its
    // invisible box was stealing the neighbors' pointerdowns. Only the PRIMARY piece carries one.
    const isSelPiece = (String(p.id) === ctx.selection.primaire);
    const rh = nds.rh;
    if (rh) rh.style.display = (wallMount || !isSelPiece) ? "none" : "";
    const showRsz = isSelPiece && ctx.selection.ids.size === 1 && !wallMount && !p.locked;
    const hasRsz = el.dataset["rszon"] === "1";
    if (showRsz && !hasRsz) {
      el.dataset["rszon"] = "1";
      el.insertAdjacentHTML("beforeend", RSZ_HANDLES.map((h) => `<span class="rsz-handle" data-rsz="${h.k}" data-h="${h.k}"></span>`).join(""));
      const noeud = el;
      el.querySelectorAll<HTMLElement>(".rsz-handle").forEach((hEl) => {
        hEl.addEventListener("pointerdown", (e) => {
          ctx.gestes.poigneeRedim?.(e as PointerEvent, String(noeud.dataset["id"]), String(hEl.dataset["rsz"]));
        });
      });
    } else if (!showRsz && hasRsz) {
      delete el.dataset["rszon"];
      el.querySelectorAll<HTMLElement>(".rsz-handle").forEach((hEl) => hEl.remove());
    }
    // G-20: a 45×50 cm chair measures ~29×32 px at the opening zoom, and eight 9 px handles
    // placed on its edge used to cover almost its entire tile. Below the threshold: four corners,
    // pushed outward. No handle ever disappears completely.
    if (showRsz) {
      const compact = Math.min(pw, ph) < RSZ_COMPACT_PX;
      const off = compact ? RSZ_OUT_PX : 0;
      el.querySelectorAll<HTMLElement>(".rsz-handle").forEach((hEl) => {
        const h = RSZ_BYKEY[String(hEl.dataset["rsz"])];
        if (!h) return;
        if (compact && !(h.ux && h.uy)) { hEl.style.display = "none"; return; }  // edge midpoints removed
        hEl.style.display = "";
        hEl.style.left = (pw * (h.ux + 1) / 2 + h.ux * off) + "px";
        hEl.style.top = (ph * (h.uy + 1) / 2 + h.uy * off) + "px";
        hEl.style.cursor = resizeCursor(h, p.rot || 0);
      });
    }
    // An opening repaints the floor background over its whole box, which INTERRUPTS the wall
    // band underneath. (An ORPHAN wall-mounted object, not attached to a wall when reading an
    // old plan, can still land here; the normal case is an opening, rendered by `renderOuvertures`.)
    if (t.opening) { el.style.background = "var(--room-bg)"; el.style.borderWidth = "0"; }
    else if (t.wallMount) { el.style.background = withAlpha(t.color, 0.14); el.style.borderWidth = "1.5px"; }
    else { el.style.background = withAlpha(t.color, t.soft ? 0.10 : 0.15); el.style.borderWidth = "1.5px"; }
    if (t.round) { el.style.borderRadius = "50%"; }
    else { el.style.borderRadius = t.opening ? "1px" : (p.type === "gaine" ? "0" : "3px"); }
    el.classList.toggle("sel", isSel(ctx, p.id));
    const slot = nds.slot;
    const iconKey = `${p.type}|${p.w}|${p.h}`;
    if (slot && slot.dataset["k"] !== iconKey) {
      slot.outerHTML = pieceIconSVG(p.type, p.w, p.h).replace('class="picon"', `class="picon picon-slot" data-k="${iconKey}"`);
      // `outerHTML` REMPLACE le noeud: la reference retenue pointe sur un orphelin tant qu'on ne
      // la reprend pas ici. C'est le seul enfant d'une tuile qui change d'identite en cours de vie.
      nds.slot = el.querySelector<HTMLElement>(".picon-slot");
    }
    // `hinge` and `swing` are NOT furniture fields: `sanitizeV5Plan` only keeps them on
    // an OPENING (a door was a piece of furniture in v4, that is the legacy still carried by
    // `PIECE_KEYS` server-side). Only ORPHAN wall-mounted objects from an old plan land here,
    // and they may carry them: they are read without lying to the type.
    const bat = p as typeof p & { hinge?: unknown; swing?: unknown };
    if (p.type === "door") {
      const sg = (Number(bat.swing) < 0) ? -1 : 1;
      let darc = nds.darc;
      const arcKey = `${p.w}|${bat.hinge ? 1 : 0}|${sg}`;
      if (!darc || darc.dataset["k"] !== arcKey) {
        if (darc) darc.remove();
        el.insertAdjacentHTML("afterbegin", doorArcSVG(p.w, bat.hinge ? 1 : 0, sg, resolveColor("var(--open)")).replace("<svg ", `<svg data-k="${arcKey}" `));
        darc = el.querySelector<HTMLElement>(".darc");
        nds.darc = darc;
      }
      // swing = -1: the arc lives in the -w..0 band of the viewBox, so the SVG is shifted up by
      // its own height to draw it ABOVE the door box (outside edge).
      if (darc) {
        const aw = safeDim(p.w * S);
        darc.style.left = "0px";
        darc.style.top = (sg < 0 ? -aw : 0) + "px";
        darc.style.width = aw + "px";
        darc.style.height = aw + "px";
      }
    } else if (nds.darc) {
      nds.darc.remove();
      nds.darc = null;
    }
    if (p.type === "sdoor") {
      const ic = nds.slot;
      if (ic) ic.style.transform = bat.hinge ? "scaleX(-1)" : "";
    }
    const wrap = nds.wrap;
    setLabelSpin(wrap, p.rot);
    const lab = nds.lab, dim = nds.dim;
    if (!wrap || !lab || !dim) return;
    const small = Math.min(pw, ph);
    const sel = (String(p.id) === ctx.selection.primaire);
    // R-2: NO NAME ON A WALL-MOUNTED OBJECT (the icon already says what it is).
    // R-3: AND NO CATALOG NAME, only a CHOSEN name is written.
    const labelOk = !isWallMount(p.type) && !!ctx.etat.opts.labels && small >= 46 && isChosenName(p);
    // R-6: the text is HORIZONTAL while the tile is tilted. The available room is neither `pw` nor the
    // bounding box, it is the HORIZONTAL CHORD of the rotated rectangle through its center. It
    // equals `pw` at 0°, `ph` at 90°, the diagonal at 45°. And TRUNCATING IS NOT ALWAYS BETTER THAN
    // STAYING SILENT: a short overshoot is tolerated (at most a quarter over) and silence beyond that.
    const rad = (p.rot || 0) * Math.PI / 180, ca = Math.abs(Math.cos(rad)), sa = Math.abs(Math.sin(rad));
    const room = Math.min(ca > 1e-6 ? pw / ca : Infinity, sa > 1e-6 ? ph / sa : Infinity);
    const estim = String(p.name).length * 6.6 + 12;
    const showName = labelOk && estim <= room * 1.25;
    lab.style.maxWidth = Math.max(0, Math.round(room) - 4) + "px";
    lab.style.display = showName ? "" : "none";
    lab.textContent = (p.locked ? "🔒 " : "") + p.name;
    el.style.cursor = p.locked ? "default" : "";
    const showDim = sel && !isWallMount(p.type);
    dim.style.display = showDim ? "" : "none";
    dim.textContent = `${p.w}×${p.h}`;
    wrap.style.display = (showName || showDim) ? "" : "none";
  });
  // [data-op] = opening, rendered in the SAME container by `renderOuvertures`: do not sweep it.
  // Le balayage relit l'INDEX deja construit: le calque n'est parcouru qu'une fois par image.
  index.forEach((n, id) => { if (!seen[id]) n.remove(); });
}
