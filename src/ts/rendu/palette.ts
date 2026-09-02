// src/ts/rendu/palette.ts: THE FURNITURE PALETTE. Placement is a DRAG-AND-DROP from a tile
// (G-22), so search, collapsible categories and persistence all come along, since `buildPalette`
// calls them at construction time.
//
// R-4: color is carried by the ITEM, never the CATEGORY: this module reads `CATALOG`, decides no
// hue of its own, so a batch reorganizing categories never touches `color`.

import type { Contexte } from "../app/contexte.ts";
import { CATALOG, TYPEMAP, catalogueParNature } from "../catalogue/catalogue.ts";
import { $, el as elById } from "../noyau/dom.ts";
import { escapeHtml } from "../noyau/nombres.ts";
import { pieceIconSVG, pieceIconViewH } from "./icones.ts";

/** Accent + case normalization for search. */
const normStr = (s: unknown): string =>
  String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Search query: TRANSIENT, never persisted. */
let palQuery = "";
export function setPaletteQuery(ctx: Contexte, q: string): void { palQuery = q; applyPaletteFilter(ctx); }

const isCatCollapsed = (ctx: Contexte, cat: string): boolean =>
  (ctx.etat.opts.collapsedCats || []).indexOf(cat) >= 0;

/**
 * Collapsing a category is a PERSONAL SETTING (D-7): it lives in `opts.collapsedCats`, it saves
 * itself, and above all it does NOT push history (it's not a modification of the plan).
 */
export function toggleCat(ctx: Contexte, cat: string, persister: () => void): void {
  const arr = ctx.etat.opts.collapsedCats || (ctx.etat.opts.collapsedCats = []);
  const i = arr.indexOf(cat);
  if (i >= 0) arr.splice(i, 1); else arr.push(cat);
  persister();
  applyPaletteFilter(ctx);
}

/** Shows / hides the tiles and headers according to the query and the collapsed state. */
export function applyPaletteFilter(ctx: Contexte): void {
  const q = normStr(palQuery.trim());
  const active = q.length > 0;
  const pal = $("palette"); if (!pal) return;
  const shownPerCat: Record<string, number> = {};
  pal.querySelectorAll<HTMLElement>(".pitem").forEach((it) => {
    const cat = String(it.dataset["cat"]);
    const nom = String(it.dataset["name"] || "");
    const show = active ? nom.indexOf(q) >= 0 : !isCatCollapsed(ctx, cat);
    it.classList.toggle("phide", !show);
    if (show) shownPerCat[cat] = (shownPerCat[cat] || 0) + 1;
    // a match during a query counts as visible even under a collapsed category
    else if (active && nom.indexOf(q) >= 0) shownPerCat[cat] = (shownPerCat[cat] || 0);
  });
  let anyShown = false;
  pal.querySelectorAll<HTMLElement>(".pcat").forEach((h) => {
    const cat = String(h.dataset["cat"]);
    const collapsed = !active && isCatCollapsed(ctx, cat);
    h.classList.toggle("collapsed", collapsed);
    h.setAttribute("aria-expanded", collapsed ? "false" : "true");
    const hasMatch = active ? ((shownPerCat[cat] || 0) > 0) : true;
    h.classList.toggle("phide", active && !hasMatch);
    if (hasMatch && (shownPerCat[cat] || 0) > 0) anyShown = true;
    if (!active) anyShown = true;   // no query: there's always something to show
  });
  const nr = $("palNoRes"); if (nr) nr.hidden = !(active && !anyShown);
}

/**
 * Builds the palette. LISTENERS are NOT set up here: `gestes/pose.ts` delegates from `#palette`
 * (click, keyboard, `pointerdown`), so this module knows no gesture and the order of the batches
 * doesn't matter at all.
 */
export function buildPalette(ctx: Contexte): void {
  const cible = $("palette"); if (!cible) return;
  let html = "";
  // ONE SINGLE CONSTRUCTION PATH, TWO SOURCES. Sorting by kind doesn't duplicate the rendering: it
  // changes the LIST of categories passed to the same loop. Two layouts would diverge at the
  // first fix, exactly like the three placement previews that `makePlacePreview` replaced.
  const source = ctx.etat.opts.palBy === "kind" ? catalogueParNature() : CATALOG;
  source.forEach((g) => {
    const visItems = g.items.filter((it) => !it.legacy);   // legacy types: kept in TYPEMAP, out of the palette
    if (!visItems.length) return;
    html += `<div class="pcat" data-cat="${escapeHtml(g.cat)}" role="button" tabindex="0" aria-expanded="true"><span class="cv">▾</span><span>${g.cat}</span></div>`;
    visItems.forEach((it) => {
      // Ratio of the tile's ACTUAL viewBox (wall-mounted object marker included): otherwise the
      // icon is squashed vertically or overflows the box.
      const ar = it.w / pieceIconViewH(it.type, it.w, it.h), bw = 44, bh = 30;
      let sw: number, sh: number;
      if (ar >= bw / bh) { sw = bw; sh = Math.max(5, bw / ar); } else { sh = bh; sw = Math.max(5, bh * ar); }
      html += `<div class="pitem" data-type="${it.type}" data-cat="${escapeHtml(g.cat)}" data-name="${escapeHtml(normStr(it.name))}" role="button" tabindex="0" title="Add ${it.name}">
          <div class="prev"><span class="prev-ico" style="width:${sw}px;height:${sh}px"></span></div>
          <div class="nm">${it.name}</div>
          <div class="dm">${it.w}×${it.h}</div>
        </div>`;
    });
  });
  cible.innerHTML = html;
  cible.querySelectorAll<HTMLElement>(".pitem").forEach((p) => {
    const type = String(p.dataset["type"]);
    const t = TYPEMAP[type];
    const ico = p.querySelector<HTMLElement>(".prev-ico");
    if (ico && t) ico.innerHTML = pieceIconSVG(type, t.w, t.h, { inset: true });
  });
  applyPaletteFilter(ctx);
  void elById;
}
