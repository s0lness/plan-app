// src/ts/app/aide.ts: THE HELP MODAL, ONE SINGLE ENTRY POINT (the "?" in the toolbar).
// First-use hint bubbles are gone (decision 0014, "l'app se tait"); the old `plan-hints`
// localStorage key is never read or written again.

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
