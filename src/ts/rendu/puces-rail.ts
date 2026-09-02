// src/ts/rendu/puces-rail.ts: THE ROOM CHIPS IN THE RAIL. Ported from src/js/25-enveloppe.js
// (`roomChipsSig`, `renderRoomChips`; `computeEnvelopeHull` is elsewhere, it's reading of
// an existing plan, not rendering).
//
// R-13. THE RAIL WAS LYING: no wall edit refreshed it, neither drawing, nor deletion, nor
// end of drag, nor remote op. It reported 10 rooms when the plan had 11, with stale
// areas and ghost chips framing a cell that no longer existed. It is therefore called by
// `render()`, hence by ALL edit paths, and compares itself to a SIGNATURE: the
// reconstruction only happens if the cells (id, name, area) or the active cell have changed.
//
// R-12: the area goes through `fmtM2`, like the toolbar and the room sheet.

import type { Contexte } from "../app/contexte.ts";
import { v5SignedArea } from "../modele/aires.ts";
import { fmtM2 } from "../noyau/nombres.ts";
import { $ } from "../noyau/dom.ts";

function roomChipsSig(ctx: Contexte): string {
  const P = ctx.etat.plan;
  if (!P) return "";
  return (P.cells || [])
    .map((c) => c.id + "~" + (c.name || "") + "~" + Math.round(Math.abs(v5SignedArea(c.poly))))
    .join("|") + "#" + (ctx.ihm.selCell || "");
}

let _chipsSig: string | null = null;

export function renderRoomChips(ctx: Contexte, force?: boolean): void {
  const el = $("roomsList");
  if (!el) return;
  const sig = roomChipsSig(ctx);
  const nb = ((ctx.etat.plan && ctx.etat.plan.cells) || []).length;
  if (!force && sig === _chipsSig && el.childElementCount === nb) return;
  _chipsSig = sig;
  el.innerHTML = "";
  const P = ctx.etat.plan;
  if (!P) return;
  (P.cells || []).forEach((c) => {
    const chip = document.createElement("div");
    chip.className = "room-chip" + ((String(ctx.ihm.selCell) === String(c.id)) ? " active" : "");
    chip.setAttribute("role", "button");
    chip.tabIndex = 0;
    const nm = document.createElement("span");
    nm.className = "rc-name";
    nm.textContent = c.name || "";
    const ar = document.createElement("span");
    ar.className = "rc-area";
    ar.textContent = fmtM2(v5SignedArea(c.poly));
    chip.appendChild(nm);
    chip.appendChild(ar);
    const pick = (): void => {
      ctx.gestes.choisirCellule?.(String(c.id), true);
      ctx.gestes.cadrerCellule?.(c);
    };
    chip.addEventListener("click", pick);
    chip.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
    });
    el.appendChild(chip);
  });
}
