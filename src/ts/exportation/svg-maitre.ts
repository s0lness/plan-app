// src/ts/exportation/svg-maitre.ts: THE MASTER SVG OF THE WHOLE FLAT.
// Ported from src/js/32-export.js (`buildMasterSVG`), VERBATIM in its geometry and its strings.
//
// ONE SINGLE FRAME: the FLAT cm, `sc=1`, so independent of the live zoom. The file is
// SELF-CONTAINED (colors and fonts hardcoded) because it goes out as a `data:` URL to an `<img>`:
// there, no CSS variable exists. Any tint that comes from a token is therefore RESOLVED here, at
// construction time (`resolveColor`), never left as a `var(--…)`.
//
// R-1 HOLDS ON THE SHEET JUST AS ON SCREEN, and that is the shape constraint of this file: "a
// correct screen with an upside-down sheet would be absurd". The ONLY rotated group in the document is
// the icons' (`glyph`, which carries `rotate(rot)`); NO `<text>` enters it. All the text
// (title, cell names, furniture names) is placed NEXT TO the group, horizontal, in the `labels`
// layer. A `<text>` slipped into `glyph` would inherit the object's rotation and would read
// crooked, or even upside down.

import type { Contexte } from "../app/contexte.ts";
import type { Cellule, Meuble, Ouverture, Pt } from "../partage/plan.ts";
import { TYPEMAP, isWallMount } from "../catalogue/catalogue.ts";
import { bboxOfPoly, poleOfInaccessibility } from "../geometrie/polygones.ts";
import { v5OpeningBox } from "../modele/murs.ts";
import { WALL, escapeHtml } from "../noyau/nombres.ts";
import { doorArcSVG } from "../rendu/arc-porte.ts";
import { resolveColor } from "../rendu/couleurs.ts";
import { pieceIconSVG } from "../rendu/icones.ts";
import { isChosenName } from "../rendu/noms.ts";
import { floorPatternDefs } from "../rendu/sol.ts";

export interface OptionsSVGMaitre {
  /** `null`/absent = the default title; `""` = no title (printing sets its own in HTML). */
  title?: string | null | undefined;
}

/** The default depth of an opening: that of its type, otherwise the wall thickness. */
const hDefautDe = (o: Ouverture): number => (TYPEMAP[o.type] || { h: WALL }).h || WALL;

export function buildMasterSVG(ctx: Contexte, opts?: OptionsSVGMaitre): string {
  const o = opts || {};
  const P = ctx.etat.plan;
  const u = bboxOfPoly(P.outline);
  const PAD = 40;
  const W = u.w + PAD * 2, H = u.l + PAD * 2;
  const ox = PAD - u.minX, oy = PAD - u.minY;
  const X = (x: number): string => (x + ox).toFixed(2);
  const Y = (y: number): string => (y + oy).toFixed(2);
  const pts = (poly: readonly Pt[]): string => poly.map((p) => X(p[0]) + "," + Y(p[1])).join(" ");
  let defs = "", body = "", labels = "";

  (P.cells || []).forEach((c: Cellule, i: number) => {
    const fl = floorPatternDefs(c.floor || "parquet", 1, "_ex" + i);
    defs += fl.defs;
    body += `<polygon points="${pts(c.poly)}" fill="${fl.fill}"/>`;
  });
  body += `<polygon points="${pts(P.outline)}" fill="none" stroke="#3b3f3d" stroke-width="${WALL}" stroke-linejoin="miter"/>`;
  (P.walls || []).forEach((w) => {
    if (w.isOutline) return;
    body += `<line class="v5band" x1="${X(w.a[0])}" y1="${Y(w.a[1])}" x2="${X(w.b[0])}" y2="${Y(w.b[1])}" `
      + `stroke="#3b3f3d" stroke-width="${w.t || WALL}" stroke-linecap="square"/>`;
  });

  // NO TEXT INSIDE A `glyph`. This group carries a `rotate(rot)`: any `<text>` slipped in
  // there would inherit the object's rotation and would read crooked, or even upside down.
  // ALL the text on this sheet is HORIZONTAL (title, cell names, furniture names):
  // it's the same rule as on screen (rendu/meubles.ts, noyau/dom.ts `setLabelSpin`), and it
  // suffers no exception here either. A `<text>` is therefore placed next to the group, never inside it.
  const glyph = (type: string, w: number, h: number, cx: number, cy: number, rot: number, extra?: string): string => {
    const ico = pieceIconSVG(type, w, h).replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
    return `<g transform="translate(${X(cx)} ${Y(cy)}) rotate(${rot}) translate(${(-w / 2).toFixed(2)} ${(-h / 2).toFixed(2)})">${extra || ""}${ico}</g>`;
  };

  (P.openings || []).forEach((op: Ouverture) => {
    const b = v5OpeningBox(P, op, hDefautDe(op));
    if (!b) return;
    let arc = "";
    if (op.type === "door") {
      const sg = (Number(op.swing) < 0) ? -1 : 1;
      arc = doorArcSVG(b.w, op.hinge ? 1 : 0, sg, resolveColor("var(--open)"))
        .replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
    }
    body += glyph(op.type, b.w, b.h, b.cx, b.cy, b.rot, arc);
  });
  (P.pieces || []).forEach((p: Meuble) => {
    body += glyph(p.type, p.w, p.h, p.x + p.w / 2, p.y + p.h / 2, p.rot || 0);
  });

  // ---- CHOSEN NAMES ARE ALSO ON THE SHEET -------------------------------------------------------
  // A plan you print is used to discuss it away from the screen: the sheet used to carry only the
  // title and the CELL names, so "Homu" and "Ikea" only existed on screen. SAME rule as on
  // screen (rendu/meubles.ts) so the two tell the same story: only CHOSEN names
  // (`isChosenName`), never a wall-mounted object, never an overflow.
  // Two deliberate differences, each with a single reason:
  //   · the "Show names & sizes" option does NOT govern the sheet: it's a personal screen
  //     setting (`room-planner-opts`), and a printout without names would be an
  //     unusable printout for someone who unchecked the box a month ago;
  //   · the threshold is in CENTIMETERS, not pixels: the export is independent of the live zoom.
  // The text is HORIZONTAL, with no rotation at all: a piece of furniture's name reads flat even when the
  // furniture is standing upright. The available room is therefore the HORIZONTAL CHORD of the rotated
  // rectangle (`min(w/|cos|, h/|sin|)`, same calculation as on screen): `w` at 0°, `h` at 90°.
  const LBL_FS = 15, LBL_CH = LBL_FS * 0.52;   // average width of a character in this font
  (P.pieces || []).forEach((p: Meuble) => {
    if (isWallMount(p.type) || !isChosenName(p)) return;
    // 60 cm of shortest side: that's the on-screen threshold (46 px side) at the zoom level where
    // the whole flat is visible. Below that (a 45x50 chair), the label eats the thumbnail.
    if (Math.min(p.w, p.h) < 60) return;
    const rad = (p.rot || 0) * Math.PI / 180, ca = Math.abs(Math.cos(rad)), sa = Math.abs(Math.sin(rad));
    const room = Math.min(ca > 1e-6 ? p.w / ca : Infinity, sa > 1e-6 ? p.h / sa : Infinity);
    // Same tradeoff as on screen: a SHORT overflow (the name overflows by at most a quarter) is
    // tolerated, beyond that we stay silent rather than print "Coff…". The furniture list, page 2
    // of the same printout, carries the full name.
    const nMax = Math.floor((room - 8) / LBL_CH);
    let n = String(p.name).trim();
    if (nMax < 5 || n.length > nMax * 1.25) return;
    if (n.length > nMax) n = n.slice(0, Math.max(1, nMax - 1)).trim() + "…";
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    labels += `<text x="${X(cx)}" y="${Y(cy)}" `
      + `text-anchor="middle" dominant-baseline="central" `
      + `font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="${LBL_FS}" font-weight="600" `
      + `fill="#2b2f2e" style="paint-order:stroke" stroke="#ffffff" stroke-width="3">${escapeHtml(n)}</text>`;
  });
  (P.cells || []).forEach((c: Cellule) => {
    const pole = poleOfInaccessibility(c.poly);
    labels += `<text x="${X(pole.x)}" y="${Y(pole.y)}" text-anchor="middle" dominant-baseline="central" `
      + `font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="22" font-weight="600" `
      + `fill="#2b2f2e" style="paint-order:stroke" stroke="#ffffff" stroke-width="4">${escapeHtml(c.name || "")}</text>`;
  });

  const title = o.title != null ? o.title : "Apartment plan";
  const titleSVG = title ? `<text x="${(W / 2).toFixed(1)}" y="26" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="26" font-weight="650" fill="#1a1e1e">${escapeHtml(title)}</text>` : "";
  const topPad = title ? 26 : 0;
  const totH = H + topPad;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(0)}" height="${totH.toFixed(0)}" viewBox="0 0 ${W.toFixed(0)} ${totH.toFixed(0)}">`
    + `<rect x="0" y="0" width="${W.toFixed(0)}" height="${totH.toFixed(0)}" fill="#ffffff"/>`
    + titleSVG
    + `<defs>${defs}</defs>`
    + `<g transform="translate(0 ${topPad})" overflow="visible">${body}${labels}</g>`
    + `</svg>`;
}
