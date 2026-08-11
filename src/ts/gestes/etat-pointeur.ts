// src/ts/gestes/etat-pointeur.ts — THE LITTLE STATE THAT SEVERAL GESTURES SHARE.
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
