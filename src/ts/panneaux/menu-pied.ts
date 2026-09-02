// src/ts/panneaux/menu-pied.ts: THE "File" MENU AT THE FOOT OF THE RAIL, the ONLY access to Save,
// Load, Furniture list, PNG, Print and Clear all. The foot of the rail is `position:sticky`
// (css/02), and this module only OPENS and CLOSES it: no action is wired here (export, print,
// the furniture list live in `exportation/`); clicking an entry just closes the menu.

import type { Contexte } from "../app/contexte.ts";
import { $ } from "../noyau/dom.ts";

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
}
