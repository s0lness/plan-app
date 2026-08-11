// src/ts/gestes/sortie.ts — THE SHARED EXIT POINT OF GESTURES.
// Ported from src/js/03-vue-selection.js (the `armGesture` block) and the `save()` safety net (src/js/07).
//
// G-1, AND IT IS ONE OF THE THREE MOST FRAGILE INVARIANTS IN THE REPO.
// A gesture = a `pointerdown` that installs window listeners. If it NEVER finishes,
// `gestureActive` stays true FOREVER and `save()` bails out on every call: nothing more
// is written locally, no send, no op, and ALL of the session's work disappears on
// reload, without a single message. Real trigger measured: a digit typed during a
// resize left the gesture open.
//
// No gesture can therefore depend on `pointerup` alone: `armGesture()` wires the end to
// `pointerup`, `pointercancel`, `lostpointercapture`, WINDOW FOCUS LOSS, and a WATCHDOG
// (8 s without the slightest movement or keystroke). This is the ONLY place that ends a gesture.
//
// WHAT THE PORT CHANGES, AND WHAT IT DOES NOT. The old client held these variables in
// its single closure; here they are private to the MODULE, which is strictly stronger: nothing
// else can read or write them. What is NOT closed off by construction, and what no
// language closes off: nothing stops a new gesture from listening to `pointerup` itself. The
// guarantee stays CONVENTIONAL. What we gained: the only way to obtain `gestureActive` is
// `gesteActif()`, and the only way to set it is `beginGesture()`, so a gesture that forgets to
// end can no longer lie about its state.

import type { Contexte } from "../app/contexte.ts";

/** Without the slightest sign of life during this delay, it is no longer a gesture. */
export const GESTURE_IDLE_MS = 8000;

type Finish = (ev?: Event | null) => void;
type OnUp = (ev: Event) => unknown;
type OnCancel = () => void;

let gFinish: Finish | null = null;
let gOnUp: OnUp | null = null;
let gCancel: OnCancel | null = null;
let gTimer: ReturnType<typeof setInterval> | 0 = 0;
let gSeen = 0;
let gestureActive = false;

/** The current context. Set once at bootstrap: `save()` and the queue depend on it. */
let _ctx: Contexte | null = null;
export function brancherSortieGestes(ctx: Contexte): void { _ctx = ctx; }

export const gesteActif = (): boolean => gestureActive;
export const gesteArme = (): boolean => !!gFinish;

export function gPoke(): void { gSeen = Date.now(); }
export function gestureStale(): boolean { return !!gSeen && (Date.now() - gSeen) > GESTURE_IDLE_MS; }

/** Test probe: artificially age the current gesture to exercise the watchdog. */
export function vieillirGeste(ms?: number | null): boolean {
  gSeen = Date.now() - (ms == null ? GESTURE_IDLE_MS + 1 : ms);
  return gestureStale();
}

/**
 * During a gesture, `save()` skips the local write and the sync bookkeeping, and `render()`
 * does not reschedule the debounced analysis: the release writes ONCE for the whole gesture.
 */
export function beginGesture(): void {
  gestureActive = true;
  gPoke();
  _ctx?.crochets.crumb?.("drag", "start");
}

export function endGesture(): void {
  gestureActive = false;
  _ctx?.crochets.crumb?.("drag", "end");
  _ctx?.crochets.persister?.();       // one single real write for the whole gesture
  _ctx?.crochets.analyser?.();        // the analysis skipped during the gesture is finalized
}

function gTick(): void {
  if (!gFinish) { if (gTimer) { clearInterval(gTimer); gTimer = 0; } return; }
  if (gestureStale()) {
    _ctx?.crochets.crumb?.("geste", "chien de garde");
    endActiveGesture();
  }
}

function gUpEvt(ev: Event): void {
  gPoke();
  // `false` = dimension entry is in progress: the release does not end anything.
  if (gOnUp && gOnUp(ev) === false) return;
  endActiveGesture(ev);
}

function gCancelEvt(): void { endActiveGesture(); }

/**
 * Arms the shared exit. `finish` is the gesture's teardown, `onUp` can refuse to let a
 * release end it (dimension entry), `onCancel` puts the object back EXACTLY in place (Escape, G-12).
 */
export function armGesture(finish: Finish, onUp?: OnUp | null, onCancel?: OnCancel | null): void {
  // Never two stacked gestures. The remote queue is NOT flushed here: it would be applied under
  // the gesture that is starting (whose closure already holds its objects). It waits for this one to end.
  if (gFinish) endActiveGesture(null, true);
  gFinish = finish; gOnUp = onUp || null; gCancel = onCancel || null; gPoke();
  window.addEventListener("pointerup", gUpEvt);
  window.addEventListener("pointercancel", gCancelEvt);
  window.addEventListener("lostpointercapture", gUpEvt);
  window.addEventListener("blur", gCancelEvt);
  window.addEventListener("pointermove", gPoke, true);
  window.addEventListener("keydown", gPoke, true);
  if (!gTimer) gTimer = setInterval(gTick, 1000);
}

/**
 * Removes the shared exit's listeners. Idempotent, and exported because the teardown of a
 * dimension-entry gesture (js/18) must be able to disarm without going back through `endActiveGesture`.
 */
export function disarmGesture(): void {
  gFinish = null; gOnUp = null; gCancel = null;
  window.removeEventListener("pointerup", gUpEvt);
  window.removeEventListener("pointercancel", gCancelEvt);
  window.removeEventListener("lostpointercapture", gUpEvt);
  window.removeEventListener("blur", gCancelEvt);
  window.removeEventListener("pointermove", gPoke, true);
  window.removeEventListener("keydown", gPoke, true);
  if (gTimer) { clearInterval(gTimer); gTimer = 0; }
}

/**
 * Exit, normal or forced. We DISARM before calling the teardown (never two executions); if
 * the teardown did not hand `gestureActive` back, we do it in its place.
 */
export function endActiveGesture(ev?: Event | null, keepQueue?: boolean): void {
  const f = gFinish; disarmGesture();
  if (f) {
    try { f(ev); }
    catch (e) { _ctx?.crochets.reportError?.(e, "fin de geste"); }
  }
  if (gestureActive) endGesture();
  if (!keepQueue) flushQueuedRemote();
}

/**
 * G-12. ESCAPE cancels the current gesture: the object goes back EXACTLY where it was (each
 * gesture supplies its own restoration), then the gesture ends through the shared exit. No more
 * furniture that keeps following the mouse, no more move recorded on release, and the selection
 * is no longer cleared out from under the finger. Returns false if no gesture was armed.
 */
export function escapeActiveGesture(): boolean {
  if (!gFinish) return false;
  const c = gCancel; gCancel = null;
  if (c) {
    try { c(); }
    catch (e) { _ctx?.crochets.reportError?.(e, "annulation de geste"); }
  }
  endActiveGesture();
  return true;
}

// ---- THE REMOTE REPLACEMENT QUEUE ---------------------------------------------------------
// C-17. A full plan replacement received DURING a gesture would wipe out the ongoing gesture (the
// dragged object is no longer in the live plan): we DELAY it, we never drop it.
// `gQueuedStateOpts` travels along with the queued state: a delayed cancellation must keep its
// `keepShadow`, otherwise it would be applied locally without ever being published.

let gQueuedState: unknown = null;
let gQueuedStateOpts: unknown = null;
let gQueuedOp: { kind?: string } | null = null;

export function fileEtatDistant(st: unknown, opts?: unknown): void {
  gQueuedState = st; gQueuedStateOpts = opts ?? null;
}
export function fileOpDistante(op: { kind?: string }): void { gQueuedOp = op; }
export function fileEnAttente(): { state: boolean; op: string | null } {
  return { state: !!gQueuedState, op: gQueuedOp ? String(gQueuedOp.kind) : null };
}

export function flushQueuedRemote(): void {
  const st = gQueuedState, so = gQueuedStateOpts, op = gQueuedOp;
  gQueuedState = null; gQueuedStateOpts = null; gQueuedOp = null;
  if (st) _ctx?.crochets.appliquerEtatFile?.(st, so);
  if (op) _ctx?.crochets.appliquerOpFile?.(op);
}
