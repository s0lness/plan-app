// src/ts/exportation/liste-mobilier.ts: THE FURNITURE LIST, by cell. Grouping is a geometric
// test (object center inside the cell's polygon); an object outside any cell lands in "Outside
// any room". Openings attach to the cell their FACE looks onto (`v5OpeningBox` + normal). The
// screen modal and `impression.ts` both call `furnitureSectionHTML`, so PDF and screen can't diverge.

import type { Contexte } from "../app/contexte.ts";
import type { Cellule, Meuble, Ouverture } from "../partage/plan.ts";
import { TYPEMAP, type ItemCatalogue } from "../catalogue/catalogue.ts";
import { v5SignedArea } from "../modele/aires.ts";
import { v5CellsAt, v5OpeningBox } from "../modele/murs.ts";
import { WALL, escapeHtml, fmtM2 } from "../noyau/nombres.ts";

/** What the list knows how to read from an object: its type, its name, its two dimensions. Nothing else. */
export interface ObjetListe {
  type: string;
  name?: string | undefined;
  w: number;
  h: number;
}

export interface LigneListe {
  type: string;
  name: string;
  w: number;
  h: number;
  /** the number of copies aggregated under this row */
  n: number;
}

export interface SectionListe {
  name: string;
  ri: string;
  /** in m² */
  area: number;
  total: number;
  furn: LigneListe[];
  open: LigneListe[];
}

interface SectionBrute {
  name: string;
  ri: string;
  area: number;
  list: ObjetListe[];
}

function buildFurnitureData(ctx: Contexte): SectionListe[] {
  const P = ctx.etat.plan || ({} as Contexte["etat"]["plan"]);
  const cells: Cellule[] = P.cells || [];
  const secs: SectionBrute[] = cells.map((c) => ({
    name: c.name || "Room", ri: String(c.id),
    area: Math.abs(v5SignedArea(c.poly)) / 10000, list: [],
  }));
  const byId = new Map<string, SectionBrute>(secs.map((s, i) => [String(cells[i]!.id), s]));
  const orphan: SectionBrute = { name: "Outside any room", ri: "__orphan__", area: 0, list: [] };
  const push = (cx: number, cy: number, obj: ObjetListe): void => {
    const c = v5CellsAt(P, cx, cy);
    const sec = c ? byId.get(String(c.id)) : null;
    (sec || orphan).list.push(obj);
  };
  (P.pieces || []).forEach((p: Meuble) => push(p.x + p.w / 2, p.y + p.h / 2, p));
  (P.openings || []).forEach((o: Ouverture) => {
    const b = v5OpeningBox(P, o, (TYPEMAP[o.type] || { h: WALL }).h || WALL);
    if (!b) { orphan.list.push({ type: o.type, name: o.name, w: o.w, h: o.h || WALL }); return; }
    const rad = b.rot * Math.PI / 180;                       // +y local = the face looked onto
    const probe = v5CellsAt(P, b.cx - Math.sin(rad) * 20, b.cy + Math.cos(rad) * 20) || v5CellsAt(P, b.cx, b.cy);
    const sec = probe ? byId.get(String(probe.id)) : null;
    (sec || orphan).list.push({ type: o.type, name: o.name, w: o.w, h: o.h || WALL });
  });
  if (orphan.list.length) secs.push(orphan);
  return secs.map((s) => {
    const g = groupPieces(s.list);
    return { name: s.name, ri: s.ri, area: s.area, total: g.furn.reduce((a, x) => a + x.n, 0), furn: g.furn, open: g.open };
  });
}

/**
 * Groups the objects of a container: furniture (non-opening / non-wall-mounted) against openings and
 * electrics. Duplicates aggregated by (type,w,h) with a counter. Returns SORTED rows, in
 * French (`localeCompare(…, "fr")`, without which "Étagère" would sort after "Zone").
 */
function groupPieces(list: readonly ObjetListe[] | null | undefined): { furn: LigneListe[]; open: LigneListe[] } {
  const furn = new Map<string, LigneListe>(), open = new Map<string, LigneListe>();
  (list || []).forEach((p) => {
    const t: Partial<ItemCatalogue> = TYPEMAP[p.type] || {};
    const bucket = (t.opening || t.wallMount) ? open : furn;
    const key = `${p.type}|${p.w}|${p.h}`;
    const name = String(p.name || t.name || p.type);
    const deja = bucket.get(key);
    if (deja) deja.n++;
    else bucket.set(key, { type: p.type, name, w: p.w, h: p.h, n: 1 });
  });
  const rows = (m: Map<string, LigneListe>): LigneListe[] =>
    Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name, "fr"));
  return { furn: rows(furn), open: rows(open) };
}

/** The HTML of a section, THE ONLY ONE: the screen (modal) and printing both call it. The name
 *  carries `data-cell-id` for a REAL room only (never the "Outside any room" orphan, `ri ===
 *  "__orphan__"`, which has no cell to rename): the screen modal (`exportation.ts`) uses it to
 *  wire the same double-click rename as the plan's label, the room card and the rail's chip
 *  (`renommerCelluleEnLigne`). Printing renders the SAME markup; the attribute is inert there. */
function furnitureSectionHTML(sec: SectionListe): string {
  const nomAttrs = sec.ri === "__orphan__" ? "" : ` class="furni-name" data-cell-id="${escapeHtml(sec.ri)}" title="Double-click to rename"`;
  let h = `<div class="furni-room"><h3><span${nomAttrs}>${escapeHtml(sec.name)}</span><span class="fa">${fmtM2(sec.area * 10000)} · ${sec.total} piece${sec.total > 1 ? "s" : ""}</span></h3>`;
  if (sec.furn.length) {
    h += `<table class="furni-tbl"><tbody>`;
    sec.furn.forEach((x) => { h += `<tr><td class="q">×${x.n}</td><td>${escapeHtml(x.name)}</td><td class="d">${x.w}×${x.h}</td></tr>`; });
    h += `</tbody></table>`;
  } else {
    h += `<div class="furni-empty">No furniture.</div>`;
  }
  if (sec.open.length) {
    h += `<div class="furni-sub">Openings &amp; electrics</div><table class="furni-tbl"><tbody>`;
    sec.open.forEach((x) => { h += `<tr><td class="q">×${x.n}</td><td>${escapeHtml(x.name)}</td><td class="d">${x.w}×${x.h}</td></tr>`; });
    h += `</tbody></table>`;
  }
  return h + `</div>`;
}

export function furnitureListHTML(ctx: Contexte, data?: SectionListe[] | null): string {
  const d = data || buildFurnitureData(ctx);
  if (!d.length) return `<div class="furni-empty">No room.</div>`;
  return d.map(furnitureSectionHTML).join("");
}

/** Plain text version (clipboard / notes). */
export function furnitureListText(ctx: Contexte, data?: SectionListe[] | null): string {
  const d = data || buildFurnitureData(ctx);
  const L: string[] = []; L.push("FURNITURE LIST"); L.push("");
  d.forEach((sec) => {
    L.push(`${sec.name}: ${fmtM2(sec.area * 10000)}, ${sec.total} piece${sec.total > 1 ? "s" : ""}`);
    if (sec.furn.length) sec.furn.forEach((x) => L.push(`  ${x.name} ×${x.n} (${x.w}×${x.h} cm)`));
    else L.push("  (no furniture)");
    if (sec.open.length) { L.push("  Openings & electrics:"); sec.open.forEach((x) => L.push(`    ${x.name} ×${x.n} (${x.w}×${x.h} cm)`)); }
    L.push("");
  });
  return L.join("\n").replace(/\n+$/, "\n");
}
