// src/ts/rendu/rendu.ts — `render()`, THE CROSSROADS.
// Ported from src/js/12-rendu.js (`render`).
//
// "`js/12-rendu.js` is the crossroads: almost every visible feature ends up touching it"
// (src/README.md, coupling n° 1). It still is, but what is NOT rendering has moved out: persistence
// and Circulation analysis go through `ctx.crochets`, so this module no longer depends on
// them, and a batch that carries them does not need to reopen this file.

import type { Contexte } from "../app/contexte.ts";
import { $ } from "../noyau/dom.ts";
import { updateReadout } from "./vue.ts";
import { renderV5 } from "./calque.ts";
import { renderRoomChips } from "./puces-rail.ts";
import { syncCellCard } from "./fiche-cellule.ts";

export function render(ctx: Contexte): void {
  updateReadout(ctx);
  const app = document.querySelector(".app");
  if (app) app.classList.toggle("walls", ctx.wallsMode);
  renderV5(ctx);
  // R-13: the sheet follows ALL editing paths, like the rail, not just a selection.
  const card = $("roomCard");
  if (card && !(card as HTMLElement).hidden) syncCellCard(ctx);
  const vide = $("emptyMsg");
  if (vide) {
    vide.style.display = ((ctx.etat.plan && ctx.etat.plan.pieces.length) || ctx.wallsMode) ? "none" : "";
  }
  renderRoomChips(ctx);
  ctx.crochets.persister?.();
  ctx.crochets.apresRendu?.();
}
