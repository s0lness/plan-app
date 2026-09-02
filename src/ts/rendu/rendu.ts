// src/ts/rendu/rendu.ts: `render()`, THE CROSSROADS: almost every visible feature ends up
// touching it. What is NOT rendering has moved out: persistence and Circulation analysis go
// through `ctx.crochets`, so this module no longer depends on them.

import type { Contexte } from "../app/contexte.ts";
import { $ } from "../noyau/dom.ts";
import { updateReadout } from "./vue.ts";
import { renderV5 } from "./calque.ts";
import { renderRoomChips } from "./puces-rail.ts";
import { syncCellCard, syncWallCard } from "./fiche-cellule.ts";

export function render(ctx: Contexte): void {
  updateReadout(ctx);
  renderV5(ctx);
  // R-13: the sheets follow ALL editing paths, like the rail, not just a selection. The wall's
  // card is resynced UNCONDITIONALLY: it also decides its own visibility (open exactly when a
  // wall is selected) and closes the room's card while it is open (rule A, one panel at a time).
  syncWallCard(ctx);
  const card = $("roomCard");
  if (card && !(card as HTMLElement).hidden) syncCellCard(ctx);
  const vide = $("emptyMsg");
  if (vide) {
    vide.style.display = (ctx.etat.plan && ctx.etat.plan.pieces.length) ? "none" : "";
  }
  renderRoomChips(ctx);
  ctx.crochets.persister?.();
  ctx.crochets.apresRendu?.();
}
