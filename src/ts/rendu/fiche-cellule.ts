// src/ts/rendu/fiche-cellule.ts: THE ROOM SHEET (name, floor, area).
// Ported from src/js/54-v5-interface.js (`v5SyncCellCard`).
//
// R-13. IT IS RESYNCED BY `render()`, NOT BY A SELECTION. Before, moving a facade left it on its
// opening value: the toolbar announced 13.7 m², the rail's chip 13.7 m², and the sheet of the SAME
// room 15.12 m², a few centimeters apart from each other. Worse, after merging two cells it still
// showed a room that no longer existed.

import type { Contexte } from "../app/contexte.ts";
import { v5SelectedCell, v5WallById } from "../app/contexte.ts";
import { v5SignedArea } from "../modele/aires.ts";
import { fmtM2 } from "../noyau/nombres.ts";
import { $ } from "../noyau/dom.ts";

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
  // The button used to announce "Delete wall (none selected)" while looking at a ROOM: a red
  // action that spells out, in plain words, that it applies to nothing. And a FACADE can be
  // selected: the sheet must say, on screen, that it can't be deleted (C-13).
  const del = $("rcDel") as HTMLButtonElement | null;
  if (!del) return;
  const w = ctx.ihm.selWall ? v5WallById(ctx, ctx.ihm.selWall) : null;
  const note = $("rcNote");
  if (w && w.isOutline) {
    del.hidden = true;
    if (note) { note.textContent = "A facade can be moved and resized, but not deleted."; note.hidden = false; }
  } else {
    del.textContent = "Delete wall";
    del.disabled = !w;
    del.hidden = !w;
    if (note) note.hidden = true;
  }
  // Through-wall or free-standing: only on a PARTITION. A facade has no ends to leave dangling,
  // and a room is not a wall.
  const lenRow = $("rcLenRow");
  if (lenRow) {
    // Facade INCLUDED: its length can also be set, by moving the next facade (see
    // `gestes/murs.ts`). Only its DELETION remains forbidden.
    const cloison = !!w;
    lenRow.hidden = !cloison;
    const inp = $("rcLen") as HTMLInputElement | null;
    if (cloison && inp && document.activeElement !== inp) {
      inp.value = String(Math.round(Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1])));
    }
  }
  const row = $("rcFreeRow");
  if (row) {
    const cloison = !!w && !w.isOutline;
    row.hidden = !cloison;
    if (cloison) {
      const libre = !!w.free;
      $("rcThrough")?.setAttribute("aria-pressed", String(!libre));
      $("rcFree")?.setAttribute("aria-pressed", String(libre));
    }
  }
}
