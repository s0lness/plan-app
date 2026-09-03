// src/ts/panneaux/fiche-cellule-edition.ts: THE ROOM'S CELL SHEET, EDITABLE PART (name, floor,
// close). The READ part (area) is in `rendu/fiche-cellule.ts` (R-13). The WALL'S OWN card
// (`#wallCard`, decision 0010) is elsewhere entirely: this module never touches a wall, and never
// opens the sheet either (`v5SelectCell`, `gestes/murs.ts`); it only knows how to close it.

import type { Contexte } from "../app/contexte.ts";
import { v5SelectedCell, v5Touch } from "../app/contexte.ts";
import { FLOORS } from "../partage/contrat-serveur.ts";
import { $ } from "../noyau/dom.ts";
import { syncCellCard } from "../rendu/fiche-cellule.ts";
import { render } from "../rendu/rendu.ts";
import { pushHistory } from "../historique/pile.ts";
import { save } from "../app/persistance.ts";
import { renommerCelluleEnLigne } from "./renommer-en-ligne.ts";

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

  // The name is now a TITLE, not a field: `rcName` renames on a double-click, the same ONE path
  // as the label on the plan and the rail's chip (decision 0013, extended: a room's name is
  // editable everywhere it's shown, and the three spots share `renommerCelluleEnLigne`, not
  // three copies of it).
  $("rcName")?.addEventListener("dblclick", (e) => {
    e.preventDefault();
    const c = v5SelectedCell(ctx);
    const el = $("rcName");
    if (c && el) renommerCelluleEnLigne(ctx, String(c.id), el);
  });

  // The sheet had no way to close: opened by a click on a label, it just stayed there.
  $("rcClose")?.addEventListener("click", () => { const card = $("roomCard"); if (card) card.hidden = true; });
}
