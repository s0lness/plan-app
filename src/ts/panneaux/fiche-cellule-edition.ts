// src/ts/panneaux/fiche-cellule-edition.ts: THE CELL SHEET, EDITABLE PART (name, floor, close).
// Ported from src/js/29-configuration.js (the cell sheet's name and floor block) and
// from src/js/03-vue-selection.js (`activeFloor` / `setActiveFloor`).
//
// The READ part (area, active floor, the "Delete wall" button's verdict) is in
// `rendu/fiche-cellule.ts`: it is recalled by `render()`, never by a selection (R-13).
//
// WHAT IS NOT HERE, AND IT'S DELIBERATE:
//   . `#rcDel` triggers a geometry GESTURE (`v5DeleteSelectedWall`): it is wired with the other
//     wall tools, in `gestes/murs.ts`;
//   . the sheet's OPENING belongs to whoever selects the cell (`v5SelectCell`),
//     already ported in `gestes/murs.ts`. This module only knows how to CLOSE it.

import type { Contexte } from "../app/contexte.ts";
import { v5SelectedCell, v5Touch } from "../app/contexte.ts";
import { FLOORS } from "../partage/contrat-serveur.ts";
import { $ } from "../noyau/dom.ts";
import { syncCellCard } from "../rendu/fiche-cellule.ts";
import { renderRoomChips } from "../rendu/puces-rail.ts";
import { render } from "../rendu/rendu.ts";
import { pushHistory } from "../historique/pile.ts";
import { save } from "../app/persistance.ts";

/**
 * The floor no longer belongs to a room: it's a property of the currently selected CELL. Read
 * and written by both the sheet AND the configuration wizard (js/28 and js/29 both call them):
 * both callers therefore read the same function, never a copy.
 */
export function activeFloor(ctx: Contexte): string {
  const c = v5SelectedCell(ctx);
  return (c && c.floor) || "parquet";
}

export function setActiveFloor(ctx: Contexte, f: string): void {
  if (!FLOORS.has(f)) return;
  const c = v5SelectedCell(ctx);
  if (c) { c.floor = f; v5Touch(ctx); }
}

export function brancherFicheCellule(ctx: Contexte): void {
  const sols = $("rcFloor");
  sols?.querySelectorAll<HTMLElement>(".floor-opt").forEach((b) => {
    b.addEventListener("click", () => {
      const f = String(b.dataset["floor"] || "");
      if (f === activeFloor(ctx)) return;
      pushHistory(ctx); setActiveFloor(ctx, f); syncCellCard(ctx); render(ctx); save(ctx);
    });
  });

  // The name: history COALESCED per focus session, exactly like `#iName`. One entry per keystroke
  // made "undo" unusable (one character per step).
  const nom = $("rcName") as HTMLInputElement | null;
  let rcEdited = false;
  nom?.addEventListener("focus", () => { rcEdited = false; });
  nom?.addEventListener("blur", () => { rcEdited = false; });
  nom?.addEventListener("input", () => {
    const c = v5SelectedCell(ctx); if (!c) return;
    if (!rcEdited) { rcEdited = true; pushHistory(ctx); }
    // 80 = the length the shared plan RETAINS (live-worker/ops.ts, NAME_MAX).
    c.name = nom.value.slice(0, 80);
    v5Touch(ctx); render(ctx); renderRoomChips(ctx);
  });

  // The sheet had no way to close: opened by a click on a label, it just stayed there.
  $("rcClose")?.addEventListener("click", () => { const card = $("roomCard"); if (card) card.hidden = true; });
}
