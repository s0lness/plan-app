// src/ts/panneaux/fiche-cellule-edition.ts: THE ROOM'S CELL SHEET, EDITABLE PART (name, floor,
// close). The READ part (area) is in `rendu/fiche-cellule.ts` (R-13). The WALL'S OWN card
// (`#wallCard`, decision 0010) is elsewhere entirely: this module never touches a wall, and never
// opens the sheet either (`v5SelectCell`, `gestes/murs.ts`); it only knows how to close it.

import type { Contexte } from "../app/contexte.ts";
import { v5SelectedCell, v5Touch } from "../app/contexte.ts";
import { FLOORS, LUX_MAX, LUX_MIN } from "../partage/contrat-serveur.ts";
import { $ } from "../noyau/dom.ts";
import { numField } from "../noyau/champ-numerique.ts";
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

  // The name: history COALESCED per focus session, the same rule the inline label rename applies
  // (`panneaux/renommer-en-ligne.ts`). One entry per keystroke made "undo" unusable (one character
  // per step). `rcName` is the LAST field of this kind left in a panel (decision 0013): a piece of
  // furniture and a plan both rename on a double-click of their own label now.
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

  // THE ROOM'S OWN LIGHTING TARGET. Same guard as every other numeric field: clearing it RESETS
  // the target to the one deduced from the name (it is an optional setting), and a value outside
  // 0..2000 lx is refused and SAID, never silently defaulted.
  numField($("rcLux"), {
    label: "Light target", unit: "lx", optional: true,
    bounds: () => ({ min: LUX_MIN, max: LUX_MAX }),
    get: () => { const c = v5SelectedCell(ctx); return c && c.lux !== undefined ? c.lux : null; },
    set: (v: number) => {
      const c = v5SelectedCell(ctx); if (!c) return;
      pushHistory(ctx); c.lux = Math.round(v);
      v5Touch(ctx); syncCellCard(ctx); render(ctx); save(ctx);
    },
    clear: () => {
      const c = v5SelectedCell(ctx); if (!c) return;
      pushHistory(ctx); c.lux = undefined;
      v5Touch(ctx); syncCellCard(ctx); render(ctx); save(ctx);
    },
  });

  // The sheet had no way to close: opened by a click on a label, it just stayed there.
  $("rcClose")?.addEventListener("click", () => { const card = $("roomCard"); if (card) card.hidden = true; });
}
