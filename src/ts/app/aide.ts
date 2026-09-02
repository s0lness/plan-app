// src/ts/app/aide.ts: THE HELP MODAL.
// Ported from src/js/31-aide-astuces.js.
//
// ONE SINGLE ENTRY POINT TO HELP: the "?" in the toolbar. The rail menu carried a
// second entry on the exact same handler; two paths to the same modal, one of them
// hidden behind a menu, helped no one.
//
// THE FIRST-USE HINT BUBBLES ARE GONE (decision 0014, "l'app se tait"): a tip explaining a
// gesture at the moment it happens is a confession that the gesture isn't evident on its own.
// A browser that still carries the old `plan-hints` localStorage key from before this change
// is never read or written again: nothing here touches it, so nothing can trip on its shape.

import type { Contexte } from "./contexte.ts";
import { $ } from "../noyau/dom.ts";

export function brancherAide(ctx: Contexte): void {
  void ctx;
  const helpEl = $("help");
  if (!helpEl) return;
  const openHelp = (): void => { helpEl.hidden = false; };
  const closeHelp = (): void => { helpEl.hidden = true; };
  $("btnHelp")?.addEventListener("click", openHelp);
  $("helpClose")?.addEventListener("click", closeHelp);
  helpEl.addEventListener("pointerdown", (e) => { if (e.target === helpEl) closeHelp(); });
  // Escape closes it from anywhere while help is open (focus may be on the body).
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !helpEl.hidden) { e.stopPropagation(); e.preventDefault(); closeHelp(); }
  }, true);
  // "?" opens help, except while typing or when a modal holds the keyboard.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "?") return;
    const t = e.target as HTMLElement | null;
    if (/INPUT|TEXTAREA|SELECT/.test((t && t.tagName) || "") || (t && t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    if (!helpEl.hidden) closeHelp(); else openHelp();
  });
}
