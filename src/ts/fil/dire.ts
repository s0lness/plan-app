// src/ts/fil/dire.ts: CURSOR CHAT ("/"): THE LOCAL BOX. THE WIRE HALF LIVES IN `fil/presence.ts`.
//
// Modeled on FigJam's cursor chat, the owner's request: press "/", a small text box appears
// attached to your cursor and follows it as you move; Enter or Escape closes it; otherwise it
// fades on its own after a few seconds without typing. What makes it feel like SPEAKING rather
// than SENDING is that every keystroke is visible to the others WHILE it happens (see
// `fil/presence.ts`'s `direTexte`, which rides the ordinary `cursor` message).
//
// THIS MODULE OWNS ONLY THE LOCAL UI: the floating `<input>`, its position, its idle timer, and
// the "/" open / Enter-Escape-blur close lifecycle. It writes NOTHING to the plan (no history
// push, no save, no op), it never enters the chat panel, and it never persists: closing it, by
// any of the four routes (Enter, Escape, blur, socket drop), leaves nothing behind on screen and
// nothing in `localStorage`.

import type { Contexte } from "../app/contexte.ts";
import type { Fil } from "./etat.ts";
import { lastCursorApt } from "../gestes/etat-pointeur.ts";
import { aptToScreen } from "../rendu/vue.ts";
import { direArreter, direTexte } from "./presence.ts";

/** Visible cap: the server truncates at the SAME length (`CURSOR_SAY_MAX`, `live-worker/ops.ts`). */
const DIRE_MAX = 140;
/** No keystroke for this long: the box closes on its own, exactly like Escape. */
const DIRE_IDLE_MS = 4000;
/** Offset from the cursor's own apartment point, px: enough that the box does not sit under the
 *  pointer (which stays free to click), matching `.pc-name`'s own offset from the arrow tip. */
const DIRE_DX = 16, DIRE_DY = 10;

let boite: HTMLInputElement | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function armerIdle(fil: Fil): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => fermerBoiteDire(fil), DIRE_IDLE_MS);
}

function poserBoite(ctx: Contexte): void {
  if (!boite) return;
  const c = lastCursorApt();
  const s = c ? aptToScreen(ctx, c.x, c.y)
    : { x: ctx.viewport.clientWidth / 2, y: ctx.viewport.clientHeight / 2 };
  boite.style.transform = `translate3d(${(s.x + DIRE_DX).toFixed(1)}px,${(s.y + DIRE_DY).toFixed(1)}px,0)`;
}

/** Closes the box (any of the four routes) and tells the wire the author stopped speaking. */
function fermerBoiteDire(fil: Fil): void {
  if (!boite || boite.hidden) return;
  boite.hidden = true;
  boite.value = "";
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  direArreter(fil);
}

/** "/" was pressed (`gestes/clavier.ts`, through the `direOuvrir` crochet, wired below, its
 *  only caller, so it stays private to this module). Idempotent: pressing "/" again while typing
 *  never reaches here, the box IS an `<input>`, so `clavier.ts`'s own `typing` guard already
 *  treats it like any other field and lets the character through instead. */
function ouvrirBoiteDire(ctx: Contexte, fil: Fil): void {
  if (!boite) return;
  boite.hidden = false;
  boite.value = "";
  poserBoite(ctx);
  direTexte(fil, "");
  armerIdle(fil);
  // Focused on the next tick: this runs from inside the very `keydown` that opened it, and
  // focusing synchronously mid-event is unreliable across browsers.
  setTimeout(() => { if (boite && !boite.hidden) boite.focus(); }, 0);
}

/** Wires the box's DOM lifecycle and the two crochets `presence.ts`/`clavier.ts` call into.
 *  Called once, from `fil/branchement.ts`, right beside `brancherChat`/`brancherCurseursSortants`
 *  (both `fil`-dependent UI, same spot). */
export function brancherDire(ctx: Contexte, fil: Fil): void {
  const el = document.createElement("input");
  el.type = "text";
  el.className = "say-box";
  el.maxLength = DIRE_MAX;
  el.autocomplete = "off";
  el.spellcheck = false;
  el.hidden = true;
  el.placeholder = "Say something…";
  el.setAttribute("aria-label", "Cursor chat");
  ctx.viewport.appendChild(el);
  boite = el;

  el.addEventListener("input", () => { direTexte(fil, el.value); armerIdle(fil); });
  el.addEventListener("keydown", (e) => {
    // Never let this bubble into the application's own shortcuts (Ctrl+Z while typing "z"…):
    // the box IS a text field, `clavier.ts`'s own `typing` guard already treats it as one, this
    // only stops Enter/Escape themselves from being seen twice.
    if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); e.stopPropagation(); fermerBoiteDire(fil); }
  });
  el.addEventListener("blur", () => fermerBoiteDire(fil));

  // Follows the pointer while open. A second passive listener on the viewport, same reasoning as
  // `brancherCurseursSortants`'s own: cheaper than a coupling between this module and the
  // gestures batch, and harmless while the box is hidden (`poserBoite` no-ops silently otherwise,
  // it still runs, but nothing reads its result while `[hidden]` applies `display:none`).
  ctx.viewport.addEventListener("pointermove", () => { if (boite && !boite.hidden) poserBoite(ctx); }, { passive: true });

  ctx.crochets.direOuvrir = () => ouvrirBoiteDire(ctx, fil);
  // The socket just dropped: no peer is left to tell, only local cleanup. `fil.sayText` is reset
  // by `wsOnDown` itself; this crochet only owns the DOM.
  ctx.crochets.direFermerUI = () => {
    if (boite) { boite.hidden = true; boite.value = ""; }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  };
}
