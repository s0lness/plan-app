// src/ts/rendu/fiche-cellule.ts: THE ROOM SHEET (name, floor, area) AND THE WALL SHEET (length).
//
// R-13: both are resynced by `render()`, NOT by a selection, or a stale value survives past the
// edit that invalidated it. ONE PANEL AT A TIME (decision 0010): `syncCellCard` and `syncWallCard`
// are two SEPARATE cards; `syncWallCard` hides `#roomCard` whenever a wall is selected, on every
// render, so the invariant holds regardless of which code path changed the selection.

import type { Contexte } from "../app/contexte.ts";
import { v5SelectedCell, v5WallById } from "../app/contexte.ts";
import { v5BoutLibre } from "../modele/edition.ts";
import { v5SignedArea } from "../modele/aires.ts";
import { fmtM2 } from "../noyau/nombres.ts";
import { $ } from "../noyau/dom.ts";

/** THE ROOM'S OWN CARD: name, flooring, area. Nothing about a wall lives here any more. */
export function syncCellCard(ctx: Contexte): void {
  const c = v5SelectedCell(ctx);
  const card = $("roomCard");
  if (!card) return;
  if (!c) { (card as HTMLElement).hidden = true; return; }
  // The selected cell may have DISAPPEARED (deleting a wall: two cells merge). `v5SelectedCell`
  // then falls back to the first one; the identifier is realigned so the sheet, the rail's chip
  // and the plan's label all point to the same room.
  if (String(ctx.ihm.selCell) !== String(c.id)) ctx.ihm.selCell = String(c.id);
  const nom = $("rcName") as HTMLInputElement | null;
  if (nom && document.activeElement !== nom) nom.value = c.name || "";
  const sols = $("rcFloor");
  if (sols) {
    sols.querySelectorAll<HTMLElement>(".floor-opt").forEach((b) => {
      b.classList.toggle("pri", b.dataset["floor"] === (c.floor || "parquet"));
    });
  }
  // Width / Length / Shapes don't make sense on a DERIVED cell: the sheet shows the AREA, in the
  // same format as the chip and the toolbar (R-12).
  const area = $("rcArea");
  if (area) area.textContent = "Area " + fmtM2(v5SignedArea(c.poly));
}

/**
 * THE WALL'S OWN CARD: a title (Wall, or Facade for an outline wall) and its Length. Split,
 * Square up and Delete are DRAWN ON THE WALL (`rendu/calque.ts`), not here (decision 0010,
 * amended 2026-09-02): the owner asked to keep them there rather than in a sheet.
 */
export function syncWallCard(ctx: Contexte): void {
  const card = $("wallCard");
  const w = ctx.ihm.selWall ? v5WallById(ctx, ctx.ihm.selWall) : null;
  if (!w) { if (card) (card as HTMLElement).hidden = true; return; }
  if (card) (card as HTMLElement).hidden = false;
  // ONE PANEL AT A TIME: selecting a wall closes the room's card, on every render, not just at
  // the moment of selection (rule A).
  const room = $("roomCard");
  if (room && !room.hidden) room.hidden = true;
  const title = $("wcTitle");
  if (title) title.textContent = w.isOutline ? "Facade" : "Wall";
  // LENGTH. Facade INCLUDED: its length can also be set, by moving the next facade (see
  // `gestes/murs.ts`).
  const inp = $("rcLen") as HTMLInputElement | null;
  if (inp && document.activeElement !== inp) {
    inp.value = String(Math.round(Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1])));
  }
  // A TYPED LENGTH STRETCHES THE FREE END, so a partition held at BOTH ends has no end to give:
  // the field is disabled and says why, rather than picking a junction to tear open (G-13, a
  // gesture that produces nothing says why). A facade is never in that case: it is resized by the
  // next one, which is why it keeps the field.
  const bloque = !w.isOutline && !v5BoutLibre(ctx.etat.plan, w);
  const noteLen = $("rcLenNote");
  if (inp) {
    inp.disabled = bloque;
    inp.title = bloque ? "Both ends of this wall are junctions." : "";
  }
  if (noteLen) noteLen.hidden = !bloque;
}
