// src/ts/app/toast.ts — THE TRANSIENT BANNER, AND ITS THROTTLING.
// Ported from src/js/24-multi-salles.js.
//
// C-16 / G-13. TWO OPPOSITE SITUATIONS, AND IT'S NOT DISTINGUISHING THEM THAT MADE
// THROTTLING HARMFUL:
//   - a message ISSUED BY THE SYSTEM (an op received, an automatic repair, a server refusal in
//     a burst): repeating it no longer informs, it hides the next one. It stays throttled. Measured:
//     22 banners in 371 s, 8 of them the same sentence.
//   - a message that RESPONDS TO A DELIBERATE GESTURE: someone who didn't understand REDOES the gesture, and
//     that's precisely where silence is intolerable. Measured: "This partition wall is already there."
//     only showed on the first of five attempts, the next four failed without a word.
//
// THE GROUPING UNIT IS THE GESTURE, NOT THE SECOND (`_gesteEpoch`, advanced by `pointerdown` and
// `keydown`): a single gesture can produce a burst (one message per furniture item of a selection), so
// it doesn't repeat; two presses give two responses, ten presses ten responses. Accepted trade-off:
// redoing the same refused gesture ten times gives ten banners. That's the price for a gesture with no
// effect to always say why.

const TOAST_MS = 3200, TOAST_SAME_MS = 12000;
const TOAST_LASSITUDE = 3, TOAST_LONG_MS = 120000;

interface VuToast { n: number; at: number; ep: number }

const _toastSeen = new Map<string, VuToast>();
let _toastT: ReturnType<typeof setTimeout> | null = null;
let _toastLast = "", _toastAt = 0;
let _gesteEpoch = 0;
let _installe = false;

/** The viewport that hosts the banner. Set once at bootstrap. */
let _viewport: HTMLElement | null = null;

export function installerToasts(viewport: HTMLElement): void {
  _viewport = viewport;
  if (_installe) return;
  _installe = true;
  document.addEventListener("pointerdown", () => { _gesteEpoch++; }, true);
  document.addEventListener("keydown", () => { _gesteEpoch++; }, true);
}

export interface OptionsToast {
  /** True = this banner RESPONDS to a deliberate gesture: once per gesture, never final silence. */
  geste?: boolean;
}

/** Returns true if the banner was actually shown (false = throttled). */
export function toast(msg: string, opts?: OptionsToast): boolean {
  const vp = _viewport;
  if (!vp) return false;
  const now = Date.now();
  const geste = !!(opts && opts.geste);
  const key = String(msg);
  const vu = _toastSeen.get(key);
  let el = vp.querySelector<HTMLElement>(".app-toast");
  if (geste) {
    // Already said during THIS gesture: a burst from the same gesture doesn't repeat. The next gesture,
    // though, says it all again, with no limit on count: that's the very meaning of a response to an action.
    if (vu && vu.ep === _gesteEpoch) {
      if (el) { const n = el; if (_toastT) clearTimeout(_toastT); _toastT = setTimeout(() => { if (n.parentNode) n.remove(); }, TOAST_MS); }
      return false;
    }
  } else {
    const same = (key === _toastLast) || !!vu;
    if (vu) {
      _toastLast = key; _toastAt = vu.at;
      if (vu.n >= TOAST_LASSITUDE && (now - vu.at) < TOAST_LONG_MS) return false;
    }
    if (same && (now - _toastAt) < TOAST_SAME_MS) {
      if (el) { const n = el; if (_toastT) clearTimeout(_toastT); _toastT = setTimeout(() => { if (n.parentNode) n.remove(); }, TOAST_MS); }
      return false;
    }
  }
  if (!el) {
    el = document.createElement("div");
    el.className = "walls-hint app-toast";
    el.style.bottom = "auto"; el.style.top = "14px";
    vp.appendChild(el);
  }
  el.hidden = false; el.textContent = msg;
  _toastLast = key; _toastAt = now;
  {
    const e = _toastSeen.get(_toastLast);
    // A gesture message doesn't wear out: its lassitude counter doesn't climb, otherwise it would end
    // up falling back into the silence we just removed.
    if (e) { if (!geste) e.n++; e.at = now; e.ep = _gesteEpoch; }
    else _toastSeen.set(_toastLast, { n: 1, at: now, ep: _gesteEpoch });
  }
  // The log of seen texts is BOUNDED: sentences carry furniture names, so their count
  // has no natural ceiling. We forget the oldest ones, never the most recent.
  if (_toastSeen.size > 60) {
    const k = _toastSeen.keys().next().value;
    if (k !== undefined && k !== _toastLast) _toastSeen.delete(k);
  }
  const n = el;
  if (_toastT) clearTimeout(_toastT);
  _toastT = setTimeout(() => { if (n.parentNode) n.remove(); }, TOAST_MS);
  return true;
}

/** Test probes. */
export function toastText(): string | null {
  const el = _viewport?.querySelector<HTMLElement>(".app-toast");
  return (el && !el.hidden) ? el.textContent : null;
}
export function clearToast(): void {
  const el = _viewport?.querySelector<HTMLElement>(".app-toast");
  if (el) el.remove();
}
