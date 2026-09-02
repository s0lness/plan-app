// src/ts/rendu/icones.ts: THE FURNITURE ICONS SEEN FROM ABOVE, in SVG.
//
// THE ICONS ARE DRAWN IN REAL CENTIMETERS, then stretched by `preserveAspectRatio="none"`: a
// 220cm sofa and a 40cm stool share the same code, and strokes (`sw`, in cm) grow with the zoom
// instead of staying in pixels. The front of the object is at the BOTTOM (+y).
//
// `doorArcSVG` lives in `arc-porte.ts` (the swing arc overflows the door's 12cm box) and is
// re-exported here so the block of graphic assets keeps ONE entry point, not duplicated.

import { clamp } from "../noyau/nombres.ts";
import { TYPEMAP } from "../catalogue/catalogue.ts";
import type { ItemCatalogue } from "../catalogue/catalogue.ts";
import { resolveColor, withAlpha } from "./couleurs.ts";

export { doorArcSVG } from "./arc-porte.ts";

/** Rounded to two decimals, as the old client wrote it into every attribute. */
type Arrondi = (x: number) => number;
type TraceRect = (x: number, y: number, ww: number, hh: number, r: number, f: string, st: string, stw: number) => string;
type TraceLigne = (x1: number, y1: number, x2: number, y2: number, st: string, stw: number) => string;
type TraceCercle = (cx: number, cy: number, r: number, f: string, st: string, stw?: number) => string;

/** The three families of wall-mounted devices that carry a marker into the room. */
export type SorteMarqueur = "plug" | "rj45" | "sconce";

// Stub that STICKS OUT of a wall-mounted device's box TOWARD the room (room side = local +y).
// Drawn in cm within the icon's viewBox; a wall-mounted device's svg is overflow:visible,
// so it is visible beyond h. Symbol depends on type: plug = disk, rj45 = square,
// sconce = fan of rays. White halo underneath, to stay legible against any background.
//
// BOUNDED LENGTHS: proportional for small boxes (plug / RJ45, 10 cm wide),
// but capped afterward. Without a cap a 25 cm sconce would stick out ~33 cm into the room,
// well beyond its own 12 cm box: the object looked like it was placed far from the wall, and the
// clickable zone (the box, on the wall) no longer matched the symbol you see at all.
//
// `_S` IS NOT USED: the old code already passed it without ever using it (the three
// tracers round on their own). The parameter is KEPT, in its place, so the calls
// stay byte-identical; it is prefixed to say it is dead.
function wallMountMarker(
  cx: number, h: number, w: number, kind: SorteMarqueur, open: string,
  _S: Arrondi, ln: TraceLigne, ci: TraceCercle, rr: TraceRect,
): string {
  const stem = clamp(w * 0.9, 9, 14);         // stem of 9..14 cm toward the room
  const symR = clamp(w * 0.42, 4, 6.5);       // symbol radius
  const tipY = h + stem;                       // symbol center, in the room
  const halo = "#ffffff", hw = Math.max(2.4, symR * 0.55);
  let s = "";
  // stem: white halo underneath, then the colored stroke
  s += ln(cx, h, cx, tipY, halo, hw * 1.2);
  s += ln(cx, h, cx, tipY, open, Math.max(1.6, symR * 0.32));
  if (kind === "plug") {
    s += ci(cx, tipY, symR + hw * 0.5, halo, "none", 0);
    s += ci(cx, tipY, symR, "#ffffff", open, Math.max(1.4, symR * 0.28));
    const dr = Math.max(0.9, symR * 0.30);
    s += ci(cx - symR * 0.42, tipY, dr, open, "none", 0);
    s += ci(cx + symR * 0.42, tipY, dr, open, "none", 0);
  } else if (kind === "rj45") {
    const q = symR * 1.5;
    s += rr(cx - q / 2 - hw * 0.5, tipY - q / 2 - hw * 0.5, q + hw, q + hw, q * 0.2, halo, "none", 0);
    s += rr(cx - q / 2, tipY - q / 2, q, q, q * 0.16, "#ffffff", open, Math.max(1.4, symR * 0.28));
    s += ln(cx - q * 0.24, tipY + q * 0.5, cx + q * 0.24, tipY + q * 0.5, open, Math.max(1.2, symR * 0.24));
  } else { // sconce: small sun / fan of rays at the tip of the stem
    s += ci(cx, tipY, symR + hw * 0.5, halo, "none", 0);
    s += ci(cx, tipY, symR * 0.62, "#ffffff", open, Math.max(1.4, symR * 0.26));
    for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; s += ln(cx + Math.cos(a) * symR * 0.7, tipY + Math.sin(a) * symR * 0.7, cx + Math.cos(a) * symR * 1.05, tipY + Math.sin(a) * symR * 1.05, open, Math.max(1, symR * 0.20)); }
  }
  return s;
}

/** Marker geometry, in cm, WITHOUT drawing it: how far does it stick out past the box? */
export interface MetriquesMarqueur {
  stem: number;
  symR: number;
  hw: number;
  /** overshoot below y = h, halo included */
  over: number;
}

// Must stay in sync with wallMountMarker() above (SAME bounds).
export function wallMountMarkerMetrics(w: number): MetriquesMarqueur {
  const stem = clamp(w * 0.9, 9, 14);
  const symR = clamp(w * 0.42, 4, 6.5);
  const hw = Math.max(2.4, symR * 0.55);
  return { stem, symR, hw, over: stem + symR + hw };
}

// viewBox height needed for an icon to fit ENTIRELY inside its box (tile mode).
// On the plan we keep viewBox = h + overflow:visible (the marker MUST overflow into the room);
// in the palette the cell is only 44×30 px and an overflow in cm there became an overflow of
// ~45 px over the neighboring cell. buildPalette MUST use this same ratio to avoid overlapping.
export function pieceIconViewH(type: string, w: number, h: number): number {
  const t: Partial<ItemCatalogue> = TYPEMAP[type] || {};
  if (!(t.wallMount && !t.opening)) return h;
  return h + wallMountMarkerMetrics(w).over;
}

/** `inset` = "tile" rendering: viewBox extended to the marker, no overflow. */
export interface OptionsIcone {
  inset?: boolean | undefined;
}

// Without options the rendering is strictly that of the plan (no caller from the plan passes options).
export function pieceIconSVG(type: string, w: number, h: number, opts?: OptionsIcone): string {
  const t: Partial<ItemCatalogue> = TYPEMAP[type] || {};
  const col = resolveColor(t.color);
  const open = resolveColor("var(--open)");
  const fill = withAlpha(col, 0.16);
  const S: Arrondi = (x) => +(x.toFixed(2));
  const sw = S(Math.max(2.2, Math.min(w, h) * 0.035));         // body stroke, in cm
  const swThin = S(sw * 0.6);
  // A wall-mounted device draws a marker that overflows the box (y>h) toward the room: the overflow
  // must be visible. In tile mode (opts.inset) we extend the viewBox instead: nothing sticks out.
  const inset = !!(opts && opts.inset);
  const marker = !!(t.wallMount && !t.opening);
  const vbH = (inset && marker) ? pieceIconViewH(type, w, h) : h;
  const overflowV = (marker && !inset) ? ' style="overflow:visible"' : '';
  const head = `<svg class="picon" viewBox="0 0 ${w} ${S(vbH)}" preserveAspectRatio="none"${overflowV} xmlns="http://www.w3.org/2000/svg">`;
  const rr: TraceRect = (x, y, ww, hh, r, f, st, stw) => `<rect x="${S(x)}" y="${S(y)}" width="${S(ww)}" height="${S(hh)}" rx="${S(r)}" ry="${S(r)}" fill="${f}" stroke="${st}" stroke-width="${S(stw)}"/>`;
  const ln: TraceLigne = (x1, y1, x2, y2, st, stw) => `<line x1="${S(x1)}" y1="${S(y1)}" x2="${S(x2)}" y2="${S(y2)}" stroke="${st}" stroke-width="${S(stw)}" stroke-linecap="round"/>`;
  const ci: TraceCercle = (cx, cy, r, f, st, stw) => `<circle cx="${S(cx)}" cy="${S(cy)}" r="${S(r)}" fill="${f}" stroke="${st}" stroke-width="${S(stw || 0)}"/>`;
  const el = (cx: number, cy: number, rx: number, ry: number, f: string, st?: string, stw?: number, rot?: number): string => `<ellipse cx="${S(cx)}" cy="${S(cy)}" rx="${S(rx)}" ry="${S(ry)}" fill="${f}" stroke="${st || "none"}" stroke-width="${S(stw || 0)}"${rot !== undefined ? ` transform="rotate(${S(rot)} ${S(cx)} ${S(cy)})"` : ""}/>`;
  let g = "";

  const seatSofa = (n: number): void => {
    const arm = Math.min(w * 0.16, 18), back = Math.min(h * 0.28, 26), pad = sw;
    g += rr(pad, pad, w - 2 * pad, h - 2 * pad, Math.min(w, h) * 0.08, fill, col, sw);
    // backrest bar (at the top)
    g += rr(pad * 1.4, pad * 1.4, w - 2.8 * pad, back, Math.min(w, h) * 0.06, withAlpha(col, 0.30), col, swThin);
    // armrests (left and right)
    g += rr(pad * 1.4, pad + back * 0.7, arm, h - 2 * pad - back * 0.7 - pad * 0.4, arm * 0.4, withAlpha(col, 0.30), col, swThin);
    g += rr(w - pad * 1.4 - arm, pad + back * 0.7, arm, h - 2 * pad - back * 0.7 - pad * 0.4, arm * 0.4, withAlpha(col, 0.30), col, swThin);
    // seat cushions
    const cx0 = pad * 1.4 + arm + 2, cy0 = pad + back + 2, cw = w - 2 * (pad * 1.4 + arm + 2), chh = h - cy0 - pad * 1.4;
    const gap = 3, each = (cw - gap * (n - 1)) / n;
    for (let k = 0; k < n; k++) g += rr(cx0 + k * (each + gap), cy0, each, chh, each * 0.14, withAlpha(col, 0.10), col, swThin);
  };
  const tableTop = (grain: boolean): void => {
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.06, fill, col, sw);
    g += rr(sw * 2.4, sw * 2.4, w - 4.8 * sw, h - 4.8 * sw, Math.min(w, h) * 0.05, "none", withAlpha(col, 0.55), swThin);
    if (grain) { for (let k = 1; k <= 2; k++) { const yy = h * (0.35 + 0.3 * (k - 1)); g += ln(sw * 3.2, yy, w - sw * 3.2, yy, withAlpha(col, 0.35), swThin * 0.8); } }
  };

  if (type === "sofa3") seatSofa(3);
  else if (type === "sofa2") seatSofa(2);
  else if (type === "arm") seatSofa(1);
  else if (type === "ottoman") {
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.14, fill, col, sw);
    g += rr(sw * 3, sw * 3, w - 6 * sw, h - 6 * sw, Math.min(w, h) * 0.10, "none", withAlpha(col, 0.45), swThin);
  }
  else if (type === "coffee") tableTop(true);
  else if (type === "dining") { const bkp = sw; g += rr(bkp, bkp, w - 2 * bkp, h - 2 * bkp, Math.min(w, h) * 0.06, fill, col, S(sw * 1.2)); g += rr(sw * 2.6, sw * 2.6, w - 5.2 * sw, h - 5.2 * sw, Math.min(w, h) * 0.05, "none", withAlpha(col, 0.55), swThin); for (let k = 1; k <= 3; k++) { const yy = h * (0.28 + 0.22 * (k - 1)); g += ln(sw * 3.4, yy, w - sw * 3.4, yy, withAlpha(col, 0.32), swThin * 0.8); } }
  else if (type === "side") { g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.16, fill, col, sw); g += rr(sw * 3, sw * 3, w - 6 * sw, h - 6 * sw, Math.min(w, h) * 0.12, "none", withAlpha(col, 0.45), swThin); }
  else if (type === "chair") {
    g += rr(sw, h * 0.20, w - 2 * sw, h * 0.80 - sw, Math.min(w, h) * 0.12, fill, col, sw); // seat
    g += rr(sw * 1.6, sw, w - 3.2 * sw, h * 0.20, Math.min(w, h) * 0.06, withAlpha(col, 0.30), col, swThin); // backrest bar (at the top)
  }
  else if (type === "tv") {
    g += rr(sw, h * 0.32, w - 2 * sw, h * 0.68 - sw, Math.min(w, h) * 0.06, fill, col, sw); // cabinet
    const n = 3, cw = (w - 2 * sw) / n; for (let k = 1; k < n; k++) g += ln(sw + cw * k, h * 0.32, sw + cw * k, h - sw, withAlpha(col, 0.4), swThin);
    g += rr(w * 0.22, sw * 0.6, w * 0.56, h * 0.16, 2, withAlpha(col, 0.22), col, swThin); // screen along the back edge
  }
  else if (type === "shelf") {
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.05, fill, col, sw);
    const n = Math.max(4, Math.round(w / 22)); for (let k = 1; k < n; k++) { const xx = sw + (w - 2 * sw) * k / n; g += ln(xx, sw * 2.2, xx, h - sw * 2.2, withAlpha(col, 0.5), swThin); }
  }
  else if (type === "biblio") {
    // bookcase: cabinet + vertical uprights + irregular book spines
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.04, fill, col, sw);
    const n = Math.max(3, Math.round(w / 30));
    for (let k = 1; k < n; k++) { const xx = sw + (w - 2 * sw) * k / n; g += ln(xx, sw * 1.6, xx, h - sw * 1.6, withAlpha(col, 0.55), swThin); }
    for (let k = 0; k < n; k++) {
      const x0 = sw + (w - 2 * sw) * k / n; const cwid = (w - 2 * sw) / n;
      for (let b = 0; b < 3; b++) { const bx = x0 + cwid * (0.2 + b * 0.25); g += ln(bx, h * 0.30 + ((k + b) % 3) * h * 0.08, bx, h - sw * 2, withAlpha(col, 0.35), swThin * 0.9); }
    }
  }
  else if (type === "sideb") {
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.06, fill, col, sw);
    const n = 3, cw = (w - 2 * sw) / n; for (let k = 1; k < n; k++) g += ln(sw + cw * k, sw, sw + cw * k, h - sw, withAlpha(col, 0.4), swThin);
    for (let k = 0; k < n; k++) g += ci(sw + cw * (k + 0.5), h * 0.5, Math.max(1.4, w * 0.012), withAlpha(col, 0.7), "none", 0);
  }
  else if (type === "desk") {
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.05, fill, col, sw);
    g += rr(w * 0.30, sw * 0.8, w * 0.40, h * 0.14, 2, withAlpha(col, 0.22), col, swThin); // screen at the back
    g += rr(w * 0.24, h * 0.66, w * 0.52, h * 0.20, 2, "none", withAlpha(col, 0.4), swThin); // keyboard toward the front
  }
  else if (type === "rug") {
    const rc = withAlpha(col, 0.10), rl = withAlpha(col, 0.28);
    g += rr(swThin, swThin, w - 2 * swThin, h - 2 * swThin, Math.min(w, h) * 0.03, rc, rl, swThin);
    g += rr(w * 0.09, h * 0.09, w * 0.82, h * 0.82, Math.min(w, h) * 0.02, "none", rl, swThin * 0.8);
    // central diamond
    g += `<polygon points="${S(w / 2)},${S(h * 0.30)} ${S(w * 0.70)},${S(h / 2)} ${S(w / 2)},${S(h * 0.70)} ${S(w * 0.30)},${S(h / 2)}" fill="none" stroke="${rl}" stroke-width="${swThin * 0.8}"/>`;
  }
  else if (type === "plant") {
    const dec = resolveColor("var(--decor)"), cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.30;
    for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; g += el(cx + Math.cos(a) * R * 0.7, cy + Math.sin(a) * R * 0.7, R * 0.62, R * 0.32, withAlpha(dec, 0.30), dec, swThin, a * 180 / Math.PI); }
    g += ci(cx, cy, Math.min(w, h) * 0.16, withAlpha(dec, 0.30), dec, sw); // pot
  }
  else if (type === "lamp") {
    const cx = w / 2, cy = h / 2;
    g += ci(cx, cy, Math.min(w, h) * 0.42, withAlpha(col, 0.10), withAlpha(col, 0.30), swThin); // light pool
    g += ci(cx, cy, Math.min(w, h) * 0.16, withAlpha(col, 0.8), col, swThin); // base
  }
  else if (type === "bed") {
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.05, fill, col, sw); // mattress
    // pillows along the top edge (the headboard)
    const pw = (w - 4 * sw) / 2 - 2, ph = h * 0.16;
    g += rr(sw * 2, sw * 2, pw, ph, ph * 0.3, withAlpha(col, 0.28), col, swThin);
    g += rr(sw * 2 + pw + 2, sw * 2, pw, ph, ph * 0.3, withAlpha(col, 0.28), col, swThin);
    g += ln(sw * 1.6, h * 0.36, w - sw * 1.6, h * 0.36, withAlpha(col, 0.4), swThin); // duvet fold
  }
  else if (type === "door") {
    // The swing arc and the leaf are drawn by a separate w×w SVG (.darc, arc-porte.ts)
    // so it can extend past the door's 12 cm depth box. Here: the opening alone (the jambs).
    g += ln(sw, sw, w - sw, sw, withAlpha(open, 0.5), swThin);       // wall line behind the door
    g += ci(sw, h / 2, Math.max(1.6, sw), open, "none", 0);           // hinge jamb (left)
    g += ci(w - sw, h / 2, Math.max(1.2, swThin), withAlpha(open, 0.6), "none", 0); // strike jamb (right)
  }
  else if (type === "sdoor") {
    // pocket sliding door (top view): leaf half-retracted into the wall; the open
    // span is dashed. The direction flips via CSS scaleX(-1) when hinge=1 (the icon
    // cache ignores the hinge).
    const mid = h / 2, leaf = w * 0.52;
    g += ln(sw, sw, w - sw, sw, withAlpha(open, 0.5), swThin);                 // wall line
    g += rr(sw, mid - h * 0.14, leaf - sw, h * 0.28, 1, withAlpha(open, 0.30), open, swThin);  // leaf (pocket on the left)
    g += `<line x1="${S(leaf)}" y1="${S(mid)}" x2="${S(w - sw)}" y2="${S(mid)}" stroke="${withAlpha(open, 0.7)}" stroke-width="${S(swThin)}" stroke-dasharray="${S(sw * 1.5)} ${S(sw * 1.2)}"/>`;
    g += ci(w - sw, mid, Math.max(1.2, swThin), withAlpha(open, 0.6), "none", 0);       // strike jamb
  }
  else if (type === "window") {
    const mid = h / 2;
    g += ln(sw, mid - h * 0.16, w - sw, mid - h * 0.16, open, swThin);
    g += ln(sw, mid + h * 0.16, w - sw, mid + h * 0.16, open, swThin);
    g += ln(sw, mid, w - sw, mid, withAlpha(open, 0.5), swThin * 0.7);
  }
  else if (type === "sconce") {
    // sconce (top view): half-disk on the back wall (top) + a marker that STICKS OUT into
    // the room. The room side is local +y (bottom of the box); a stem and a symbol are drawn
    // just past h so they read over both the wall's dark band AND the
    // floor. The white halo keeps them legible against any background.
    const cx = w / 2, r = Math.min(w * 0.34, h * 0.62);
    g += `<path d="M ${S(cx - r)} ${S(sw)} A ${S(r)} ${S(r)} 0 0 0 ${S(cx + r)} ${S(sw)} Z" fill="${withAlpha(open, 0.20)}" stroke="${open}" stroke-width="${swThin}"/>`;
    g += wallMountMarker(cx, h, w, "sconce", open, S, ln, ci, rr);
  }
  else if (type === "plug") {
    // plug (top view): the body in the wall + a marker that STICKS OUT into the room (room side = +y)
    const st = S(Math.max(sw, 1.4));
    g += rr(sw * 0.6, sw * 0.6, w - 1.2 * sw, h - 1.2 * sw, Math.min(w, h) * 0.18, withAlpha(open, 0.14), open, st);
    const dr = Math.max(0.9, Math.min(w, h) * 0.14);
    g += ci(w * 0.5 - w * 0.16, h * 0.5, dr, open, "none", 0);
    g += ci(w * 0.5 + w * 0.16, h * 0.5, dr, open, "none", 0);
    g += wallMountMarker(w / 2, h, w, "plug", open, S, ln, ci, rr);
  }
  else if (type === "rj45") {
    // network jack: box + square port; marker that sticks out into the room (room side = +y)
    const st = S(Math.max(sw, 1.4));
    g += rr(sw * 0.6, sw * 0.6, w - 1.2 * sw, h - 1.2 * sw, Math.min(w, h) * 0.18, withAlpha(open, 0.14), open, st);
    const pw2 = w * 0.34, ph2 = h * 0.5;
    g += rr(w * 0.5 - pw2 / 2, h * 0.5 - ph2 / 2, pw2, ph2, 0.4, "none", open, st);
    g += ln(w * 0.5 - pw2 * 0.22, h * 0.5 + ph2 / 2, w * 0.5 + pw2 * 0.22, h * 0.5 + ph2 / 2, open, st);
    g += wallMountMarker(w / 2, h, w, "rj45", open, S, ln, ci, rr);
  }
  else if (type === "ceil") {
    // ceiling light (on the ceiling, non-blocking): disk + mounting cross, all in light stroke
    const r = Math.min(w, h) * 0.42, cx2 = w / 2, cy2 = h / 2;
    g += ci(cx2, cy2, r, withAlpha(col, 0.10), col, swThin);
    g += ci(cx2, cy2, r * 0.28, withAlpha(col, 0.45), "none", 0);
    g += ln(cx2 - r * 0.7, cy2, cx2 + r * 0.7, cy2, withAlpha(col, 0.5), swThin * 0.8);
    g += ln(cx2, cy2 - r * 0.7, cx2, cy2 + r * 0.7, withAlpha(col, 0.5), swThin * 0.8);
  }
  else if (type === "counter") {
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.04, fill, col, sw); // countertop
    g += ln(sw * 2.4, h * 0.5, w - sw * 2.4, h * 0.5, withAlpha(col, 0.32), swThin * 0.8); // grain line, lengthwise
  }
  else if (type === "sink") {
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.04, fill, col, sw); // countertop
    g += rr(w * 0.10, h * 0.22, w * 0.52, h * 0.56, Math.min(w, h) * 0.10, withAlpha(col, 0.14), col, swThin); // basin offset to one side
    g += ci(w * 0.80, h * 0.16, Math.max(1.6, Math.min(w, h) * 0.06), withAlpha(col, 0.7), col, swThin * 0.7); // faucet on the back edge
  }
  else if (type === "hob") {
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.06, fill, col, sw); // body
    const br = Math.min(w, h) * 0.17;
    const bx = [w * 0.32, w * 0.68], by = [h * 0.32, h * 0.68];
    for (const cy of by) for (const cx of bx) g += ci(cx, cy, br, "none", withAlpha(col, 0.6), swThin); // 4 burners 2x2
  }
  else if (type === "fridge") {
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.05, fill, col, sw); // cabinet
    g += ln(sw * 1.6, h * 0.34, w - sw * 1.6, h * 0.34, withAlpha(col, 0.4), swThin); // door seam on the front
    g += ln(w - sw * 2.6, h * 0.5, w - sw * 2.6, h * 0.86, withAlpha(col, 0.7), S(sw * 1.1)); // handle near a corner
  }
  else if (type === "oven") {
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.05, fill, col, sw); // cabinet
    g += rr(w * 0.20, h * 0.24, w * 0.60, h * 0.60, Math.min(w, h) * 0.06, "none", withAlpha(col, 0.5), swThin); // oven door
    g += ln(w * 0.24, h * 0.16, w * 0.76, h * 0.16, withAlpha(col, 0.7), S(sw * 1.1)); // handle bar
  }
  else if (type === "dw") {
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.05, fill, col, sw); // cabinet
    g += ln(sw * 1.6, h * 0.30, w - sw * 1.6, h * 0.30, withAlpha(col, 0.4), swThin); // front seam
    const dd = Math.max(1.2, Math.min(w, h) * 0.05);
    for (let k = 0; k < 3; k++) g += ci(w * (0.36 + 0.14 * k), h * 0.16, dd, withAlpha(col, 0.7), "none", 0); // 3 control dots
  }
  else if (type === "island") {
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.06, fill, col, sw); // rounded countertop
    for (let k = 1; k <= 2; k++) { const yy = h * (0.36 + 0.28 * (k - 1)); g += ln(sw * 2.6, yy, w - sw * 2.6, yy, withAlpha(col, 0.30), swThin * 0.8); } // wood grain
  }
  else if (type === "armoire") {
    // wardrobe (hinged): cabinet + vertical seam in the center (two doors) + two handles near the seam
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.03, fill, col, sw);
    g += rr(sw * 2.4, sw * 2.4, w - 4.8 * sw, h - 4.8 * sw, Math.min(w, h) * 0.02, "none", withAlpha(col, 0.30), swThin * 0.8); // depth inset
    g += ln(w * 0.5, sw * 1.6, w * 0.5, h - sw * 1.6, withAlpha(col, 0.6), swThin); // central seam
    const hd = Math.max(1.2, Math.min(w, h) * 0.05);
    g += ci(w * 0.5 - w * 0.05, h * 0.5, hd, withAlpha(col, 0.8), "none", 0); // left handle
    g += ci(w * 0.5 + w * 0.05, h * 0.5, hd, withAlpha(col, 0.8), "none", 0); // right handle
  }
  else if (type === "placard") {
    // built-in closet (sliding): 3 vertical panels; the offset overlap says "sliding"
    // where the wardrobe says "hinged" through its central seam
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.03, fill, col, sw);
    const n = 3, cw = (w - 2 * sw) / n;
    for (let k = 0; k < n; k++) { g += rr(sw + cw * k + swThin * 0.5, sw * 1.8, cw - swThin, h - sw * 3.6, 0, "none", withAlpha(col, 0.45), swThin * 0.9); }
    // double chevron (sliding cue), centered
    const my = h * 0.5, ch = Math.min(w, h) * 0.12;
    g += ln(w * 0.5 - ch, my - ch, w * 0.5, my, withAlpha(col, 0.6), swThin);
    g += ln(w * 0.5 - ch, my + ch, w * 0.5, my, withAlpha(col, 0.6), swThin);
  }
  else if (type === "gaine") {
    // utility duct (structure / forbidden): outlined box + 45° hatching, clipped to the box
    const gid = "hx" + Math.random().toString(36).slice(2, 8);
    const struct = resolveColor("var(--struct)");
    g += `<clipPath id="${gid}"><rect x="${S(sw)}" y="${S(sw)}" width="${S(w - 2 * sw)}" height="${S(h - 2 * sw)}"/></clipPath>`;
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, 0, withAlpha(struct, 0.12), struct, S(Math.max(sw, 2))); // square box, sharp-edged
    const step = Math.max(6, Math.min(w, h) * 0.22);
    let hatch = "";
    for (let d = -h; d < w; d += step) { hatch += `<line x1="${S(d)}" y1="0" x2="${S(d + h)}" y2="${S(h)}" stroke="${withAlpha(struct, 0.55)}" stroke-width="${S(swThin)}"/>`; }
    g += `<g clip-path="url(#${gid})">${hatch}</g>`;
  }
  else if (type === "wc") {
    // toilet (top view): rectangular tank against the back wall (top) + oval bowl at the front
    const tankH = h * 0.24;
    g += rr(w * 0.14, sw, w * 0.72, tankH, Math.min(w, h) * 0.05, withAlpha(col, 0.14), col, swThin); // tank along the back edge
    g += el(w / 2, sw + tankH + (h - tankH - 2 * sw) * 0.55, w * 0.30, (h - tankH - 2 * sw) * 0.45, fill, col, sw);   // bowl (oval) at the front
    g += el(w / 2, sw + tankH + (h - tankH - 2 * sw) * 0.52, w * 0.17, (h - tankH - 2 * sw) * 0.28, "none", withAlpha(col, 0.5), swThin); // inner lid
  }
  else if (type === "bath") {
    // bathtub: rounded outline + thick rim (inset rounded rectangle) + drain at one end
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.22, fill, col, sw);                          // outline (thick rim)
    g += rr(sw * 3.2, sw * 3.2, w - 6.4 * sw, h - 6.4 * sw, Math.min(w, h) * 0.18, "none", withAlpha(col, 0.5), swThin); // inner basin
    g += ci(w - h * 0.42, h / 2, Math.max(1.4, Math.min(w, h) * 0.06), "none", withAlpha(col, 0.7), swThin);       // drain at one end
  }
  else if (type === "shower") {
    // shower: square tray + center drain + suggested glass panel (two thickened edges + quarter arc)
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.05, fill, col, sw);                          // tray outline
    g += ci(w / 2, h / 2, Math.max(1.6, Math.min(w, h) * 0.08), "none", withAlpha(col, 0.7), swThin);   // center drain
    g += ln(sw, sw, w - sw, sw, withAlpha(col, 0.8), S(sw * 1.4));                                   // glass panel edge (top)
    g += ln(sw, sw, sw, h - sw, withAlpha(col, 0.8), S(sw * 1.4));                                   // glass panel edge (left)
    g += `<path d="M ${S(w - sw)} ${S(h * 0.42)} A ${S(h * 0.42)} ${S(h * 0.42)} 0 0 1 ${S(w - h * 0.42)} ${S(h - sw)}" fill="none" stroke="${withAlpha(col, 0.5)}" stroke-width="${swThin}"/>`; // door quarter-arc
  }
  else if (type === "lavabo") {
    // sink (bathroom basin): rounded rectangle + recessed oval basin + light faucet mark at the back
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.10, fill, col, sw);                           // countertop
    g += el(w / 2, h * 0.56, w * 0.34, h * 0.34, withAlpha(col, 0.12), withAlpha(col, 0.55), swThin);      // recessed oval basin
    g += ci(w / 2, h * 0.18, Math.max(1.2, Math.min(w, h) * 0.05), withAlpha(col, 0.55), "none", 0);     // faucet dot on the back edge
  }
  else if (type === "washer") {
    // washing machine (top view): square cabinet + porthole (large circle) with inner drum + control panel at the back
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.05, fill, col, sw);                       // cabinet (square)
    g += rr(sw * 1.6, sw * 1.6, w - 3.2 * sw, h * 0.16, Math.min(w, h) * 0.04, withAlpha(col, 0.14), col, swThin); // control panel along the back edge
    const dd = Math.max(1.2, Math.min(w, h) * 0.05);
    g += ci(w * 0.34, sw * 1.6 + h * 0.08, dd, withAlpha(col, 0.7), "none", 0);                       // control dot
    g += ci(w * 0.50, sw * 1.6 + h * 0.08, dd, withAlpha(col, 0.7), "none", 0);                       // control dot
    const dr = Math.min(w, h) * 0.28, dcy = h * 0.60;
    g += ci(w / 2, dcy, dr, withAlpha(col, 0.10), col, swThin);                                 // porthole / drum (large circle)
    g += ci(w / 2, dcy, dr * 0.5, "none", withAlpha(col, 0.55), swThin * 0.9);                      // drum's inner circle
  }
  else if (type === "langer") {
    // changing table (top view): rounded cabinet + inset changing pad (raised rim look) + drawer/shelf below
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.10, fill, col, sw);                        // rounded body
    g += rr(sw * 2.6, sw * 2.6, w - 5.2 * sw, h * 0.56, Math.min(w, h) * 0.14, withAlpha(col, 0.18), col, swThin);   // changing pad (raised-rim look)
    g += rr(sw * 4, sw * 4, w - 8 * sw, h * 0.56 - sw * 2.8, Math.min(w, h) * 0.12, "none", withAlpha(col, 0.40), swThin * 0.8); // pad's inner fold
    g += ln(sw * 2.6, h * 0.78, w - sw * 2.6, h * 0.78, withAlpha(col, 0.45), swThin);                  // drawer/shelf line below
    g += ci(w / 2, h * 0.89, Math.max(1.2, Math.min(w, h) * 0.045), withAlpha(col, 0.7), "none", 0);  // drawer handle dot
  }
  else if (type === "radiateur") {
    // radiator (top view): thin rounded cabinet against the wall + regular vertical fins
    const struct = resolveColor("var(--struct)");
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.35, withAlpha(struct, 0.12), struct, sw); // thin rounded body
    const n = Math.max(5, Math.round(w / 10));                                            // number of fins
    for (let k = 1; k < n; k++) { const xx = sw + (w - 2 * sw) * k / n; g += ln(xx, sw * 1.6, xx, h - sw * 1.6, withAlpha(struct, 0.5), swThin); } // vertical fins
  }
  else if (type === "bed1") {
    // single bed: same drawing as the double, ONE single centered pillow (that's what reads
    // at a glance at working zoom, not the width, which depends on the scale).
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.05, fill, col, sw);   // mattress
    const pw3 = (w - 4 * sw) * 0.62, ph3 = h * 0.14;
    g += rr((w - pw3) / 2, sw * 2, pw3, ph3, ph3 * 0.3, withAlpha(col, 0.28), col, swThin); // pillow
    g += ln(sw * 1.6, h * 0.34, w - sw * 1.6, h * 0.34, withAlpha(col, 0.4), swThin);      // duvet fold
  }
  else if (type === "bedside") {
    // nightstand: small cabinet + one drawer + the knob
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.10, fill, col, sw);
    g += ln(sw * 1.8, h * 0.44, w - sw * 1.8, h * 0.44, withAlpha(col, 0.45), swThin);
    g += ci(w / 2, h * 0.70, Math.max(1.2, Math.min(w, h) * 0.07), withAlpha(col, 0.75), "none", 0);
  }
  else if (type === "dresser") {
    // dresser: cabinet + three drawers + two knobs per drawer
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.05, fill, col, sw);
    for (let k = 1; k <= 2; k++) { const yy = sw + (h - 2 * sw) * k / 3; g += ln(sw * 1.6, yy, w - sw * 1.6, yy, withAlpha(col, 0.45), swThin); }
    const bd = Math.max(1.1, Math.min(w, h) * 0.045);
    for (let k = 0; k < 3; k++) {
      const yy = sw + (h - 2 * sw) * (k + 0.5) / 3;
      g += ci(w * 0.36, yy, bd, withAlpha(col, 0.7), "none", 0);
      g += ci(w * 0.64, yy, bd, withAlpha(col, 0.7), "none", 0);
    }
  }
  else if (type === "crib") {
    // crib: slatted cabinet (short strokes all around the perimeter) + inset mattress
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.08, fill, col, sw);
    g += rr(sw * 3.2, sw * 3.2, w - 6.4 * sw, h - 6.4 * sw, Math.min(w, h) * 0.06, withAlpha(col, 0.10), withAlpha(col, 0.45), swThin);
    const nb = Math.max(4, Math.round(h / 22));
    for (let k = 1; k < nb; k++) {
      const yy = sw + (h - 2 * sw) * k / nb;
      g += ln(sw, yy, sw * 3.2, yy, withAlpha(col, 0.55), swThin * 0.9);          // slats, left post
      g += ln(w - sw * 3.2, yy, w - sw, yy, withAlpha(col, 0.55), swThin * 0.9);  // slats, right post
    }
  }
  else if (type === "stool") {
    // stool: round seat, no backrest (it's the absence of the bar that distinguishes it from the chair)
    const r = Math.min(w, h) * 0.42;
    g += ci(w / 2, h / 2, r, fill, col, sw);
    g += ci(w / 2, h / 2, r * 0.42, "none", withAlpha(col, 0.45), swThin);
  }
  else if (type === "console") {
    // console table: narrow top against the wall + two visible legs at the ends
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.08, fill, col, sw);
    g += ln(sw * 2.4, h * 0.5, w - sw * 2.4, h * 0.5, withAlpha(col, 0.30), swThin * 0.8);
    const fd = Math.max(1.2, Math.min(w, h) * 0.10);
    g += ci(sw * 3, h * 0.5, fd, withAlpha(col, 0.55), "none", 0);
    g += ci(w - sw * 3, h * 0.5, fd, withAlpha(col, 0.55), "none", 0);
  }
  else if (type === "highchair") {
    // high chair: narrow seat + tray that STICKS OUT at the front (the tray is what
    // distinguishes it from a chair), plus the backrest bar at the back
    g += rr(w * 0.18, h * 0.22, w * 0.64, h * 0.52, Math.min(w, h) * 0.10, fill, col, sw);       // seat
    g += rr(w * 0.20, sw, w * 0.60, h * 0.16, Math.min(w, h) * 0.05, withAlpha(col, 0.30), col, swThin); // backrest (at the back)
    g += rr(sw, h * 0.72, w - 2 * sw, h * 0.22, Math.min(w, h) * 0.08, withAlpha(col, 0.20), col, swThin); // tray, wider than the seat
  }
  else if (type === "tvscreen") {
    // TV screen: very thin slab, slightly bulging toward the room, with its central stand
    g += rr(sw * 0.4, sw * 0.4, w - 0.8 * sw, h - 0.8 * sw, Math.min(w, h) * 0.20, withAlpha(col, 0.22), col, S(Math.max(sw, 1.4)));
    g += ln(w * 0.12, h * 0.5, w * 0.88, h * 0.5, withAlpha(col, 0.55), swThin * 0.8); // slab line
    g += rr(w * 0.42, h * 0.55, w * 0.16, h * 0.6, 1, withAlpha(col, 0.45), "none", 0); // stand, toward the room
  }
  else if (type === "projector") {
    // video projector: housing + lens at the FRONT (room side) + hint of a diverging beam.
    // The actual beam length is not drawn here: it depends on `thr`, which is a
    // property of the placed object, not of its icon.
    g += rr(sw, sw, w - 2 * sw, h * 0.66, Math.min(w, h) * 0.10, fill, col, sw);      // housing
    g += ci(w / 2, h * 0.68, Math.min(w, h) * 0.15, withAlpha(col, 0.30), col, swThin); // lens
    g += ln(w * 0.36, h * 0.86, w * 0.20, h - sw * 0.4, withAlpha(col, 0.45), swThin * 0.9); // beam hint
    g += ln(w * 0.64, h * 0.86, w * 0.80, h - sw * 0.4, withAlpha(col, 0.45), swThin * 0.9);
  }
  else if (type === "pscreen") {
    // projection screen: the roller housing (at the back) + the screen unrolled in front of it
    g += rr(sw * 0.4, sw * 0.4, w - 0.8 * sw, h * 0.46, Math.min(w, h) * 0.22, withAlpha(col, 0.30), col, swThin); // roller
    g += rr(w * 0.04, h * 0.52, w * 0.92, h * 0.44, 1, withAlpha(col, 0.12), withAlpha(col, 0.7), swThin);        // screen
    g += ln(w * 0.04, h * 0.74, w * 0.96, h * 0.74, withAlpha(col, 0.35), swThin * 0.7);
  }
  else if (type === "dryer") {
    // dryer: same cabinet as the washing machine, SOLID porthole and airflow arcs instead of the
    // dotted panel. It STACKS on top of the washing machine, so it must be distinguishable at
    // a glance when the two are in the same spot.
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.05, fill, col, sw);
    const dr2 = Math.min(w, h) * 0.28, dcy2 = h * 0.56;
    g += ci(w / 2, dcy2, dr2, withAlpha(col, 0.10), col, swThin);
    for (let k = 1; k <= 2; k++) {
      const rr2 = dr2 * (0.34 + 0.30 * k);
      g += `<path d="M ${S(w / 2 - rr2)} ${S(dcy2)} A ${S(rr2)} ${S(rr2)} 0 0 1 ${S(w / 2 + rr2)} ${S(dcy2)}" fill="none" stroke="${withAlpha(col, 0.5)}" stroke-width="${S(swThin * 0.9)}"/>`;
    }
    g += ln(w * 0.28, h * 0.16, w * 0.72, h * 0.16, withAlpha(col, 0.5), swThin); // filter grille at the back
  }
  else if (type === "microwave") {
    // microwave: cabinet + large glass door on the left + narrow control panel on the right
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.06, fill, col, sw);
    g += rr(sw * 2, sw * 2, (w - 4 * sw) * 0.70, h - 4 * sw, Math.min(w, h) * 0.04, withAlpha(col, 0.10), withAlpha(col, 0.55), swThin);
    const mx = sw * 2 + (w - 4 * sw) * 0.78;
    g += ci(mx + (w - 2 * sw) * 0.06, h * 0.34, Math.max(1.2, Math.min(w, h) * 0.06), withAlpha(col, 0.7), "none", 0);
    g += ln(mx, h * 0.56, w - sw * 2, h * 0.56, withAlpha(col, 0.5), swThin * 0.8);
    g += ln(mx, h * 0.70, w - sw * 2, h * 0.70, withAlpha(col, 0.5), swThin * 0.8);
  }
  else if (type === "stairs") {
    // straight staircase (top view): outlined footprint + regular steps + an UP arrow.
    // A step is ~28 cm of tread: the count follows the actual length instead of being fixed,
    // otherwise a resized staircase draws false steps.
    const struct = resolveColor("var(--struct)");
    g += rr(sw, sw, w - 2 * sw, h - 2 * sw, 0, withAlpha(struct, 0.12), struct, S(Math.max(sw, 2)));
    const marches = Math.max(3, Math.round((h - 2 * sw) / 28));
    for (let k = 1; k < marches; k++) {
      const yy = sw + (h - 2 * sw) * k / marches;
      g += ln(sw, yy, w - sw, yy, withAlpha(struct, 0.55), swThin);
    }
    // up arrow, on the centerline, head toward the back (decreasing y)
    const ax = w / 2, ay0 = h - sw * 3, ay1 = sw * 3, ah = Math.min(w, h) * 0.10;
    g += ln(ax, ay0, ax, ay1, withAlpha(struct, 0.8), S(swThin * 1.1));
    g += ln(ax - ah, ay1 + ah, ax, ay1, withAlpha(struct, 0.8), S(swThin * 1.1));
    g += ln(ax + ah, ay1 + ah, ax, ay1, withAlpha(struct, 0.8), S(swThin * 1.1));
  }
  else { g += rr(sw, sw, w - 2 * sw, h - 2 * sw, Math.min(w, h) * 0.08, fill, col, sw); }

  return head + g + "</svg>";
}
