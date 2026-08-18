// src/ts/panneaux/menu-pied.ts — THE "File" MENU AT THE FOOT OF THE RAIL.
// Ported from src/js/29-configuration.js (lines 216 to 236), without changing an id or a behavior.
//
// WHY IT MATTERS MORE THAN ITS SIZE. The "File" button is the ONLY access to Save,
// Load, Furniture list, PNG, Print and Clear all. It was measured at y = 2999 px in an
// 849 px window, i.e. 18 wheel ticks to reach it: the foot of the rail is therefore
// `position:sticky` (css/02) and this module only OPENS and CLOSES.
//
// WHAT IT DOES NOT DO, DELIBERATELY: no ACTION is wired here. Export, print,
// the furniture list and "Clear all" live in `exportation/` (a parallel batch). This module only
// knows one thing about the menu entries: clicking on one of them closes the menu.
//
// THE OPEN STATE IS MARKED BY `open` (border accent + flipped chevron), plus by `pri`: a full-width
// petrol-blue fill gave a simple menu the visual weight of a primary action.

import type { Contexte } from "../app/contexte.ts";
import { $ } from "../noyau/dom.ts";

/** What this sub-batch's probe reads (`sonde-config.ts`). */
export const menuPied: { ouvrir?: (on: boolean) => void; estOuvert?: () => boolean } = {};

export function brancherMenuPied(_ctx: Contexte): void {
  const footMenu = $("footMenu"), btnMenu = $("btnMenu");
  if (!footMenu || !btnMenu) return;

  function setMenuOpen(on: boolean): void {
    const m = footMenu as HTMLElement, b = btnMenu as HTMLElement;
    m.hidden = !on;
    b.setAttribute("aria-expanded", on ? "true" : "false");
    b.classList.toggle("open", on);
  }

  btnMenu.addEventListener("click", () => setMenuOpen(!!footMenu.hidden));
  // A click on an entry closes the menu. The ACTION itself is wired by its own batch.
  footMenu.addEventListener("click", (e) => {
    if ((e.target as Element | null)?.closest("button")) setMenuOpen(false);
  });
  // Click outside: neither in the menu, nor on its button.
  document.addEventListener("pointerdown", (e) => {
    if (footMenu.hidden) return;
    const t = e.target as Node | null;
    if (t && (footMenu.contains(t) || btnMenu.contains(t))) return;
    setMenuOpen(false);
  });
  // IN CAPTURE PHASE: Escape closes ONLY the menu, and does not reach the application's
  // other Escape handlers (closing a sheet, cancelling a gesture).
  window.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape" && !footMenu.hidden) {
      setMenuOpen(false);
      e.stopPropagation();
    }
  }, true);

  menuPied.ouvrir = setMenuOpen;
  menuPied.estOuvert = () => !footMenu.hidden;
}
