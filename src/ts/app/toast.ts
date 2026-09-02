// src/ts/app/toast.ts: THE TRANSIENT BANNER. Two kinds of message only (decision 0014,
// "l'app se tait", C-16): a gesture response (`{geste:true}`) shows every time, grouped by
// `_gesteEpoch`; a system message is throttled by its own text until it fades (`TOAST_MS`).

const TOAST_MS = 3200;

const _gesteVus = new Set<string>();
const _sysVus = new Map<string, ReturnType<typeof setTimeout>>();
let _gesteEpoch = 0;
let _toastT: ReturnType<typeof setTimeout> | null = null;
let _installe = false;

/** The viewport that hosts the banner. Set once at bootstrap. */
let _viewport: HTMLElement | null = null;

export function installerToasts(viewport: HTMLElement): void {
  _viewport = viewport;
  if (_installe) return;
  _installe = true;
  document.addEventListener("pointerdown", () => { _gesteEpoch++; _gesteVus.clear(); }, true);
  document.addEventListener("keydown", () => { _gesteEpoch++; _gesteVus.clear(); }, true);
}

export interface OptionsToast {
  /** True = this banner RESPONDS to a deliberate gesture: once per gesture, never final silence. */
  geste?: boolean;
}

/** Returns true if the banner was actually shown (false = it was on cooldown, and stayed silent). */
export function toast(msg: string, opts?: OptionsToast): boolean {
  const vp = _viewport;
  if (!vp) return false;
  const geste = !!(opts && opts.geste);
  const key = String(msg);
  let el = vp.querySelector<HTMLElement>(".app-toast");
  const reveille = (): void => {
    if (!el) return;
    const n = el;
    if (_toastT) clearTimeout(_toastT);
    _toastT = setTimeout(() => { if (n.parentNode) n.remove(); }, TOAST_MS);
  };
  if (geste) {
    // Already said during THIS gesture: a burst from the same gesture doesn't repeat. The next
    // gesture, though, says it all again, with no limit on count: that's the very meaning of a
    // response to an action.
    if (_gesteVus.has(key)) { reveille(); return false; }
    _gesteVus.add(key);
  } else if (_sysVus.has(key)) {
    // On cooldown: refresh it, and if it's the text currently on screen, keep it there a while
    // longer too. It does NOT show again, and it does NOT make a DIFFERENT text wait.
    clearTimeout(_sysVus.get(key)!);
    _sysVus.set(key, setTimeout(() => { _sysVus.delete(key); }, TOAST_MS));
    if (el && el.textContent === key) reveille();
    return false;
  }
  if (!el) {
    el = document.createElement("div");
    el.className = "walls-hint app-toast";
    el.style.bottom = "auto"; el.style.top = "14px";
    vp.appendChild(el);
  }
  el.hidden = false; el.textContent = msg;
  if (!geste) {
    // The bounded log of texts on cooldown: an unbounded session must not grow this forever
    // (some system texts carry a name or a status). We forget the OLDEST one, never the newest.
    if (_sysVus.size > 30) {
      const k = _sysVus.keys().next().value;
      if (k !== undefined) { clearTimeout(_sysVus.get(k)!); _sysVus.delete(k); }
    }
    _sysVus.set(key, setTimeout(() => { _sysVus.delete(key); }, TOAST_MS));
  }
  reveille();
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
