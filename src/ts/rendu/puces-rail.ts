// src/ts/rendu/puces-rail.ts: THE ROOM CHIPS IN THE RAIL.
//
// R-13: called by `render()`, hence by ALL edit paths (no wall edit used to refresh it on its
// own), and compares itself to a SIGNATURE so reconstruction only happens if cells or the active
// cell changed. R-12: the area goes through `fmtM2`, like the toolbar and the room sheet.

import type { Contexte } from "../app/contexte.ts";
import { v5SignedArea } from "../modele/aires.ts";
import { fmtM2 } from "../noyau/nombres.ts";
import { $ } from "../noyau/dom.ts";
import { renommerCelluleEnLigne } from "../panneaux/renommer-en-ligne.ts";

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
    nm.title = "Double-click to rename";
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
    // The chip's name renames the same ONE way as the label on the plan and the room card's
    // title: `renommerCelluleEnLigne`, not a fourth copy of it. `stopPropagation` keeps the
    // chip's own click (select the room) from also firing on this second click of the pair.
    nm.addEventListener("dblclick", (e) => {
      e.preventDefault(); e.stopPropagation();
      renommerCelluleEnLigne(ctx, String(c.id), nm);
    });
    el.appendChild(chip);
  });
}
