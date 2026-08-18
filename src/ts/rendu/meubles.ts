// src/ts/rendu/meubles.ts — RECONCILING THE FURNITURE IN THE LAYER.
// Ported from src/js/12-rendu.js (`renderPieces`, `RSZ_HANDLES`, `resizeCursor`, `stackedAt`).
//
// This is the most expensive code in the repo, and three invariants live here:
//
//  G-9  PAINT FROM LARGEST TO SMALLEST, and the stack sorts on PAINT RANK.
//       Paint order used to follow the ARRAY order: a 6 m² rug added after an armchair would
//       cover it entirely and make it uncatchable. Measured at 300 objects: 20 gestures out of
//       30 moved a different piece of furniture than the one aimed at. The rank is also written
//       into `data-paint`, and it is THAT which `stackedAt` sorts on: `elementsFromPoint` returns
//       the real order, but `.piece.sel` raises the selected item to `z-index:50`, so the stack
//       reordered on every click and the cycle started over from zero (twelve clicks on five
//       objects only reached two of them).
//  R-1  the label is a CHILD of the rotated node: `setLabelSpin` exactly cancels its rotation.
//  R-6  A LABEL NEVER LEAVES ITS TILE: the available room is the HORIZONTAL CHORD of the rotated
//       rectangle through its center, `min(w/|cos|, h/|sin|)`.
//  G-20 HANDLES NEVER EAT INTO THE OBJECT'S SURFACE: below 64 px on a side, only the four corners
//       are kept and pushed outward.
//
// This module DECIDES nothing: it paints what the plan says. The gestures (drag, rotate,
// resize, drop one level in the stack) are wired in via `ctx.gestes`.

import type { Contexte } from "../app/contexte.ts";
import type { BBox } from "../geometrie/polygones.ts";
import { TYPEMAP, isWallMount, pieceVisible } from "../catalogue/catalogue.ts";
import { cssId, setLabelSpin } from "../noyau/dom.ts";
import { safeDim } from "../noyau/nombres.ts";
import { resolveColor, withAlpha } from "./couleurs.ts";
import { pieceIconSVG } from "./icones.ts";
import { doorArcSVG } from "./arc-porte.ts";
import { isChosenName } from "./noms.ts";
import { isSel } from "./selection.ts";

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

  lst.forEach((p, i) => {
    if (!pieceVisible(p, ctx.etat.opts)) return;
    let el = container.querySelector<HTMLElement>(`.piece[data-id="${cssId(p.id)}"]`);
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
    }
    seen[String(p.id)] = 1;
    const lx = (p.x - bb.minX) * S, ly = (p.y - bb.minY) * S;
    el.style.zIndex = String(10 + (rang[i] ?? 0));
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
    const rh = el.querySelector<HTMLElement>(".rot-handle");
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
    const slot = el.querySelector<HTMLElement>(".picon-slot");
    const iconKey = `${p.type}|${p.w}|${p.h}`;
    if (slot && slot.dataset["k"] !== iconKey) {
      slot.outerHTML = pieceIconSVG(p.type, p.w, p.h).replace('class="picon"', `class="picon picon-slot" data-k="${iconKey}"`);
    }
    // `hinge` and `swing` are NOT furniture fields: `sanitizeV5Plan` only keeps them on
    // an OPENING (a door was a piece of furniture in v4, that is the legacy still carried by
    // `PIECE_KEYS` server-side). Only ORPHAN wall-mounted objects from an old plan land here,
    // and they may carry them: they are read without lying to the type.
    const bat = p as typeof p & { hinge?: unknown; swing?: unknown };
    if (p.type === "door") {
      const sg = (Number(bat.swing) < 0) ? -1 : 1;
      let darc = el.querySelector<HTMLElement>(".darc");
      const arcKey = `${p.w}|${bat.hinge ? 1 : 0}|${sg}`;
      if (!darc || darc.dataset["k"] !== arcKey) {
        if (darc) darc.remove();
        el.insertAdjacentHTML("afterbegin", doorArcSVG(p.w, bat.hinge ? 1 : 0, sg, resolveColor("var(--open)")).replace("<svg ", `<svg data-k="${arcKey}" `));
        darc = el.querySelector<HTMLElement>(".darc");
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
    } else {
      const darc = el.querySelector<HTMLElement>(".darc");
      if (darc) darc.remove();
    }
    if (p.type === "sdoor") {
      const ic = el.querySelector<HTMLElement>(".picon-slot");
      if (ic) ic.style.transform = bat.hinge ? "scaleX(-1)" : "";
    }
    const wrap = el.querySelector<HTMLElement>(".plabel-wrap");
    setLabelSpin(wrap, p.rot);
    const lab = el.querySelector<HTMLElement>(".plabel");
    const dim = el.querySelector<HTMLElement>(".pdim");
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
  container.querySelectorAll<HTMLElement>(".piece:not([data-op])").forEach((n) => {
    if (!seen[String(n.dataset["id"])]) n.remove();
  });
}
