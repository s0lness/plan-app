// src/ts/app/aide.ts: THE HELP MODAL AND THE FIRST-USE HINTS.
// Ported from src/js/31-aide-astuces.js.
//
// ONE SINGLE ENTRY POINT TO HELP: the "?" in the toolbar. The rail menu carried a
// second entry on the exact same handler; two paths to the same modal, one of them
// hidden behind a menu, helped no one.
//
// HINTS ARE NEVER A GUIDED TOUR: one discreet bubble, ONE at a time, ONE
// time in the browser's whole lifetime (personal flags in `plan-hints`, never shared). Four
// callers already exist and call `ctx.crochets.showHint?.(key)`: wall drawing,
// the multi-selection, the measuring tape, and armed placement. AS LONG AS THIS HOOK IS NOT WIRED, these four
// calls do NOTHING, silently: it's the same class of defect as `ctx.gestes.railOpen`, which
// left the drawer open over the plan under a finger.

import type { Contexte } from "./contexte.ts";
import { $ } from "../noyau/dom.ts";

const HINTS: Record<string, string> = {
  draw: "Drag empty space to draw a wall; hold <b>Shift</b> while dragging for lasso selection.",
  multi: "Drag to move the group; <b>Del</b> deletes them all, <b>Ctrl+C</b> copies it.",
  measure: "Click two points; the cursor shows the distances around it.",
  // Placement is a drag-and-drop: the click ARMS it. Said ONE time, on the first click on a thumbnail.
  pose: "You can also <b>drag the thumbnail</b> straight to its place.",
};

function hintsSeen(): Record<string, unknown> {
  try { return (JSON.parse(localStorage.getItem("plan-hints") || "{}") as Record<string, unknown>) || {}; }
  catch (_) { return {}; }
}
function markHintSeen(key: string): void {
  try { const s = hintsSeen(); s[key] = 1; localStorage.setItem("plan-hints", JSON.stringify(s)); }
  catch (_) { /* quota nul : l'astuce se remontrera, ce n'est pas grave */ }
}

let _hintT: ReturnType<typeof setTimeout> | null = null;

export function showHint(ctx: Contexte, key: string): void {
  const msg = HINTS[key];
  if (!msg) return;
  if (hintsSeen()[key]) return;                              // already seen: never again
  if (ctx.viewport.querySelector(".tip-hint")) return;       // only one visible at a time
  markHintSeen(key);   // counted as soon as it's shown (no repeat even if dismissed)
  const el = document.createElement("div");
  el.className = "tip-hint";
  el.innerHTML = '<span class="tt">Tip: ' + msg + '</span><button class="tip-x" type="button" aria-label="Close">×</button>';
  const kill = (): void => { if (_hintT) clearTimeout(_hintT); if (el.parentNode) el.remove(); };
  el.querySelector(".tip-x")?.addEventListener("click", kill);
  ctx.viewport.appendChild(el);
  if (_hintT) clearTimeout(_hintT);
  _hintT = setTimeout(() => { el.classList.add("fade"); setTimeout(kill, 550); }, 6000);
}

export function brancherAide(ctx: Contexte): void {
  ctx.crochets.showHint = (k: string) => showHint(ctx, k);

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
