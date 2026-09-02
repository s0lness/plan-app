// src/ts/noyau/dom.ts: the four DOM gestures that all of rendering shares. None of this is a
// convenience utility: `cssId` and `setLabelSpin` each carry a numbered invariant (R-8, R-1), and
// having them in ONE single copy is what holds them.

/** SVG namespace. An `<svg>` created without it displays NOTHING, with no error. */
export const SVGNS = "http://www.w3.org/2000/svg";

export const $ = (id: string): HTMLElement | null => document.getElementById(id);

/**
 * The same, for when the element's absence is a template defect and not a usage case: the
 * HTML template is OURS, not data. Throws rather than paint half a screen.
 */
export function el(id: string): HTMLElement {
  const n = document.getElementById(id);
  if (!n) throw new Error("element missing from the template: #" + id);
  return n;
}

/** R-8: an entity identifier (wire, JSON import, old plan) never goes RAW into a selector. A `"`
 * or `]` makes `querySelector` THROW from inside `render()`, taking down the whole application. */
export function cssId(v: unknown): string {
  const s = String(v);
  try {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
  } catch (_) { /* CSS.escape absent: we fall back to minimal escaping */ }
  return s.replace(/[\\"]/g, "\\$&").replace(/[\n\r\f]/g, "");
}

/**
 * R-1. A PIECE OF FURNITURE'S NAME IS ALWAYS HORIZONTAL, on screen just as on the sheet.
 *
 * The `.plabel-wrap` wrapper is a CHILD of the node already rotated by `rot`: it inherits its
 * rotation, so we cancel it out exactly. A PURE function of the angle: no DOM measurement, no
 * hysteresis, no special case, so nothing that could flicker while rotating slowly.
 *
 * The drawing-software convention (the text FOLLOWS the object, folded into the readable
 * half-circle) was tried then REJECTED on the real plan: "Table" written vertically across the
 * dining corner isn't upside down and still stays unreadable at a glance.
 *
 * TWO consumers, and they must stay that way: furniture rendering, and a peer's drag ghost
 * (which drives the node's own rotation, and must therefore reapply ours).
 */
export function setLabelSpin(wrap: HTMLElement | null | undefined, rot: unknown): 0 {
  if (!wrap) return 0;
  let a = Number(rot);
  if (!isFinite(a)) a = 0;
  wrap.style.transform = "translate(-50%,-50%) rotate(" + (-a) + "deg)";
  return 0;
}

/**
 * Coarse pointer (finger). Used ONLY for layout (the rail drawer collapsed by default):
 * mouse behavior is never decided on this, it's decided by `e.pointerType`.
 */
export const COARSE: boolean =
  (typeof matchMedia === "function" && matchMedia("(pointer:coarse)").matches) || false;
