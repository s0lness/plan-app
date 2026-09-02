// src/ts/gestes/etat-pointeur.ts: THE LITTLE STATE THAT SEVERAL GESTURES SHARE, read by gestures
// living in different files (furniture drag bails out early if `measureMode` or `spaceHeld`).
// Gathering them here makes them VISIBLE: whoever writes them is a named function.

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

// THERE IS NO "NO GRID" MODIFIER ANY MORE (decisions 0011/0012): `Alt` suspends the magnets,
// `Shift` constrains (axis, 15° rotation, 10cm keyboard step), the same one thing everywhere.

let _measureMode = false;
/** Tape measure armed: furniture is frozen, the event bubbles up to the viewport. */
export const measureMode = (): boolean => _measureMode;
export function setMeasureModeFlag(v: boolean): void { _measureMode = v; }

/** Fingers down, indexed by `pointerId`: two fingers = pinch, never a drag. */
export const touchPts = new Map<number, { x: number; y: number }>();

/** Last known pointer position over the viewport, in APARTMENT cm (null when the cursor has
 * never been there / has left). Both G-22 and G-24 use it: one rule, not two neighboring ones. */
let _lastCursorApt: { x: number; y: number } | null = null;
export const lastCursorApt = (): { x: number; y: number } | null => _lastCursorApt;
export function setCursorApt(ax: number | null | undefined, ay: number | null | undefined): void {
  _lastCursorApt = (ax == null || ay == null) ? null : { x: ax, y: ay };
}
