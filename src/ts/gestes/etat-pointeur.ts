// src/ts/gestes/etat-pointeur.ts: THE LITTLE STATE THAT SEVERAL GESTURES SHARE.
// Ported from src/js/09-viewport-rail.js (`isTouchEvt`, `TOUCH_DRAG_THRESH`, `LONGPRESS_MS`),
// src/js/22-interactions-vue.js (`spaceHeld`, `touchPts`) and src/js/06-mesure.js (`measureMode`).
//
// These four values used to be variables of the single closure, read by gestures that live
// in different files (furniture drag bails out early if `measureMode` or `spaceHeld`). Gathering
// them here makes them VISIBLE: whoever writes them is a named function, not an assignment
// lost in the middle of a listener.

/** A finger, never a mouse or a stylus. */
export const isTouchEvt = (e: { pointerType?: string } | null | undefined): boolean =>
  !!e && e.pointerType === "touch";

/** px of travel before a finger drag engages (avoids accidental drags). */
export const TOUCH_DRAG_THRESH = 8;
/** duration of a finger long-press (touch equivalent of Ctrl+click). */
export const LONGPRESS_MS = 450;

let _spaceHeld = false;
/** Space held down: the drag PANS, never moves furniture. */
export const spaceHeld = (): boolean => _spaceHeld;
export function setSpaceHeld(v: boolean): void { _spaceHeld = v; }

/**
 * PRECISE MODE: SHIFT held during a drag. The hand moves ten pixels, the object one or two.
 * We do NOT change the unit (the plan stays in whole cm), we change the RATIO between the gesture
 * and the movement: the exact centimeter becomes reachable at working scale.
 *
 * SHIFT IS NOT FREE EVERYWHERE, hence the scope limited to moving and resizing: the
 * rotation handle already uses it to snap to 15°, outline editing to force the axis, and
 * the keyboard arrows for the 10 cm step. Taking it back from them would break three gestures to
 * gain one.
 */
export const RATIO_PRECIS = 0.2;
export const estPrecis = (e: { shiftKey?: boolean }): boolean => !!e.shiftKey;

/**
 * NO GRID: Ctrl (or Cmd) held during a drag. Where `estPrecis` slows the pointer down (the object
 * still lands on the 5 cm grid), this one SUPPRESSES the grid outright: the object follows the
 * pointer to the whole centimeter. Combined with Shift, the hand moves ten pixels, the object one,
 * and it lands off-grid: that is the real fine adjustment.
 *
 * BOTH KEYS, DELIBERATELY. On macOS, Ctrl+click is a SECONDARY click, and in this app the right
 * button already means "pan": a Mac user holding Ctrl from `pointerdown` would open the browser's
 * or OS's own context menu instead of dragging. Cmd is therefore the reliable key on a Mac; Ctrl is
 * the reliable key on Windows and Linux. Accepting either removes the need to know which OS you're
 * on. It reads `ev.ctrlKey || ev.metaKey` on a MOVE event, so it applies whether the modifier was
 * grabbed mid-drag or was already held at `pointerdown`: for furniture, Ctrl/Cmd held from the
 * press DEFERS the toggle-vs-drag decision to the release (`gestes/meuble.ts`, the same pattern as
 * the stacked-pick rule), it no longer forecloses the drag the way it used to.
 */
export const sansGrille = (e: { ctrlKey?: boolean; metaKey?: boolean }): boolean => !!(e.ctrlKey || e.metaKey);

/**
 * THE RELATIVE 5 CM GRID (G-5): STEPS COUNTED FROM THE START OF THE GESTURE, never the absolute
 * position. `depart` is where the gesture began (`p0x`/`p0y` in `gestes/meuble.ts`), `courant` is
 * where the hand is asking to go NOW. With the grid on, we round the OFFSET from `depart`, then add
 * it back: a piece that starts at an off-grid coordinate (a converted plan, an odd width) still
 * returns EXACTLY there on the way back, because both legs of a round trip round the SAME kind of
 * quantity (a delta), never the raw coordinate itself (which an odd start would round differently
 * each time). `snap` off, or `sansGrille` active, or the grid is out of the trip entirely and the
 * whole-centimeter position applies as-is (still integer, so idempotent both ways).
 */
export function pasGrille(depart: number, courant: number, snap: boolean, sansGrilleActif: boolean): number {
  if (snap && !sansGrilleActif) return depart + Math.round((courant - depart) / 5) * 5;
  return Math.round(courant);
}

/**
 * The point to TRACK: the pointer as-is, or a slowed-down version around the starting point.
 * Returning a POINT (and not a factor) applies precise mode in one line, without the rest of the
 * gesture knowing it exists: snapping, bounds and messages all stay on the same path.
 */
export function pointSuivi(
  e: { shiftKey?: boolean }, x: number, y: number, x0: number, y0: number,
): { x: number; y: number } {
  if (!estPrecis(e)) return { x, y };
  return { x: x0 + (x - x0) * RATIO_PRECIS, y: y0 + (y - y0) * RATIO_PRECIS };
}

let _measureMode = false;
/** Tape measure armed: furniture is frozen, the event bubbles up to the viewport. */
export const measureMode = (): boolean => _measureMode;
export function setMeasureModeFlag(v: boolean): void { _measureMode = v; }

/** Fingers down, indexed by `pointerId`: two fingers = pinch, never a drag. */
export const touchPts = new Map<number, { x: number; y: number }>();

/**
 * Last known pointer position over the viewport, in APARTMENT cm (null when the
 * cursor has never been there / has left). Both G-22 and G-24 use it: "two different rules
 * for two neighboring gestures would be one more source of error".
 */
let _lastCursorApt: { x: number; y: number } | null = null;
export const lastCursorApt = (): { x: number; y: number } | null => _lastCursorApt;
export function setCursorApt(ax: number | null | undefined, ay: number | null | undefined): void {
  _lastCursorApt = (ax == null || ay == null) ? null : { x: ax, y: ay };
}
