// src/ts/app/diagnostics.ts — ACTION BREADCRUMB TRAIL, CRASH REPORTER, SENTINEL.
// Ported from src/js/40-diagnostics.js, LOCAL PART ONLY.
//
// WHAT IS NOT PORTED HERE, AND IT'S SAID: the `POST /api/err` (both the reporter AND the sentinel) is
// NETWORK, it belongs to the SYNCHRONIZATION batch. It is left as a named
// call point, `envoyer`, that this batch will wire up. Under `file://` and in an embedded iframe, the
// old client already posted nothing: the behavior ported here is therefore EXACTLY that of these two
// contexts, which are also those of every test suite.
//
// WHY THIS MODULE MATTERS FOR TESTS, AND NOT JUST FOR THE HOUSEHOLD: every browser-driven suite
// rereads `localStorage["plan-errors"]` after each case to declare a failure on an
// uncaught JS error. Without this ring buffer, an error in the new client would be seen by NO ONE
// and the suites would render a FALSE green.
//
// THE BREADCRUMB TRAIL exists for a class of failure that does NOT throw: the full white page (rail,
// toolbar and canvas all blank) is a silent death of the GPU compositor. `window.onerror`
// doesn't see it, hence the sentinel that periodically checks structural invariants and
// degenerate dimensions (NaN, negative, > 100,000 px), then attempts recovery.

import type { Contexte } from "./contexte.ts";

const ERR_KEY = "plan-errors";

export interface Miette { t: number; k: string; i: unknown }
export interface EntreeErreur {
  at: string; msg: string; src: string; stack: string;
  crumbs: { dt: number; k: string; i: unknown }[];
}

const _crumbs: Miette[] = [];
let _errReenter = false;

/** The breadcrumb trail: the last 25 UI actions, attached to each report. */
export function crumb(kind: string, info?: unknown): void {
  try {
    _crumbs.push({ t: Date.now(), k: String(kind), i: (info == null ? null : info) });
    while (_crumbs.length > 25) _crumbs.shift();
  } catch (_) { /* never let the diagnostic break anything */ }
}

/** Compact, serializable copy (RELATIVE milliseconds, so the payload stays short). */
export function crumbsSnapshot(): { dt: number; k: string; i: unknown }[] {
  try { const now = Date.now(); return _crumbs.map((c) => ({ dt: c.t - now, k: c.k, i: c.i })); }
  catch (_) { return []; }
}

const errShortMsg = (m: unknown): string => {
  const s = String(m == null ? "erreur inconnue" : m);
  return s.length > 140 ? s.slice(0, 140) + "…" : s;
};

/** The red banner, dismissible, and therefore screenshot-able. Two at most, stacked. */
function errToast(msg: string): void {
  try {
    let host = document.querySelector<HTMLElement>(".err-toasts");
    if (!host) { host = document.createElement("div"); host.className = "err-toasts"; document.body.appendChild(host); }
    while (host.children.length >= 2 && host.firstChild) host.removeChild(host.firstChild);
    const t = document.createElement("div"); t.className = "err-toast";
    const span = document.createElement("span"); span.textContent = "Erreur : " + errShortMsg(msg);
    const x = document.createElement("button"); x.className = "et-x"; x.textContent = "✕"; x.title = "Fermer";
    const kill = (): void => { try { if (t.parentNode) t.parentNode.removeChild(t); } catch (_) { /* already gone */ } };
    x.addEventListener("click", kill);
    t.appendChild(span); t.appendChild(x); host.appendChild(t);
    setTimeout(kill, 12000);
  } catch (_) { /* the reporter must never throw */ }
}

/** The local ring of the last 10 errors. This is what every suite reads. */
export function errRing(entry: EntreeErreur): void {
  try {
    let arr: EntreeErreur[] = [];
    try { arr = (JSON.parse(localStorage.getItem(ERR_KEY) || "[]") as EntreeErreur[]) || []; } catch (_) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    arr.push(entry);
    while (arr.length > 10) arr.shift();
    localStorage.setItem(ERR_KEY, JSON.stringify(arr));
  } catch (_) { /* zero quota: we lose the trace, never the application */ }
}

/** The POST to `/api/err`. Wired by the SYNCHRONIZATION batch, absent here. */
let _envoyer: ((entry: EntreeErreur) => void) | null = null;
export function poserEnvoiErreur(f: (entry: EntreeErreur) => void): void { _envoyer = f; }

export function reportError(msg: unknown, src?: unknown, stack?: unknown): void {
  if (_errReenter) return;   // NEVER recurse
  _errReenter = true;
  try {
    const e = msg as { message?: string; stack?: string } | null;
    const texte = (e && typeof e === "object" && e.message) ? e.message : msg;
    const pile = String(stack || (e && typeof e === "object" && e.stack) || "");
    const entry: EntreeErreur = {
      at: new Date().toISOString(), msg: errShortMsg(texte), src: String(src || ""),
      stack: pile, crumbs: crumbsSnapshot(),
    };
    errToast(entry.msg); errRing(entry);
    if (_envoyer) _envoyer(entry);
  } catch (_) { /* nothing */ }
  finally { _errReenter = false; }
}

// ---- THE WHITE-PAGE SENTINEL --------------------------------------------------------------------
// It checks STRUCTURAL invariants, not an exception: "the plan exists but no layer",
// "a layer that has zero area", "a degenerate dimension". Then it attempts recovery
// (remove the poisoned surfaces, refit, force a document repaint).

let _sentinelBusy = false;

function _degenerateEls(): { tag: string; cls: string; w: unknown; h: unknown }[] {
  const bad: { tag: string; cls: string; w: unknown; h: unknown }[] = [];
  try {
    document.querySelectorAll<HTMLElement>(".v5layer,.piece,svg,#flowCanvas,#canvas").forEach((el) => {
      if (bad.length >= 4) return;
      let w = parseFloat(el.style && el.style.width), h = parseFloat(el.style && el.style.height);
      if (!isFinite(w) && !isFinite(h)) { const r = el.getBoundingClientRect(); w = r.width; h = r.height; }
      const degen = (v: number): boolean => v != null && (Number.isNaN(v) || (isFinite(v) && v > 100000) || v < 0);
      const sw = (el.style && el.style.width) || "", sh = (el.style && el.style.height) || "";
      const strNaN = /NaN/i.test(sw) || /NaN/i.test(sh);
      if (strNaN || degen(w) || degen(h)) {
        bad.push({
          tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 60),
          w: sw || Math.round(w), h: sh || Math.round(h),
        });
      }
    });
  } catch (_) { /* nothing */ }
  return bad;
}

export function whitePageSentinel(ctx: Contexte, reason: string, recadrer: () => void): void {
  if (_sentinelBusy) return;
  _sentinelBusy = true;
  try {
    const SEL = "#canvas .v5layer";
    const P = ctx.etat.plan;
    const roomCount = (P && Array.isArray(P.outline) && P.outline.length > 2) ? 1 : 0;
    const domRooms = document.querySelectorAll(SEL).length;
    let visChildren = 0;
    document.querySelectorAll(SEL).forEach((el) => {
      const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) visChildren++;
    });
    const degen = _degenerateEls();
    const tripped =
      (roomCount > 0 && domRooms === 0) ? "plan-but-no-layer"
        : (roomCount > 0 && visChildren === 0) ? "layer-not-visible"
          : (degen.length > 0) ? "degenerate-dimension" : null;
    if (!tripped) return;
    errRing({
      at: new Date().toISOString(), msg: "white-page sentinel (" + tripped + ")",
      src: "sentinel:" + (reason || "tick"), stack: "", crumbs: crumbsSnapshot(),
    });
    crumb("sentinel", { tripped, degen: degen.length });
    let recovered = false;
    try {
      ctx.canvas.querySelectorAll(".v5layer").forEach((el) => el.remove());   // poisoned surfaces
      recadrer();                                                            // full recompute + render
      try {
        document.body.style.transform = "translateZ(0)";
        void document.body.offsetHeight;
        document.body.style.transform = "";
      } catch (_) { /* nothing */ }
      const dr2 = document.querySelectorAll(SEL).length;
      let vis2 = 0;
      document.querySelectorAll(SEL).forEach((el) => { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) vis2++; });
      recovered = (roomCount === 0) || (dr2 > 0 && vis2 > 0 && _degenerateEls().length === 0);
    } catch (_) { recovered = false; }
    crumb("sentinel-heal", { recovered });
  } catch (_) { /* nothing */ }
  finally { _sentinelBusy = false; }
}

// ---- CADENCE: fast while someone's around, slow at rest -----------------------------------------
// Each pass forces a layout sync. Every 3 s forever would be a
// permanent tax for a failure that itself occurs DURING an interaction. So we keep 3 s while
// someone is active, 10 s after 20 s of inactivity, and the hidden tab skips its turn (it paints
// nothing, there's nothing to see).
const SENTINEL_FAST = 3000, SENTINEL_IDLE = 10000, SENTINEL_IDLE_AFTER = 20000;

export function brancherDiagnostics(ctx: Contexte, recadrer: () => void): void {
  ctx.crochets.crumb = (a: string, b?: string) => crumb(a, b);
  ctx.crochets.reportError = (e: unknown, ou?: string) => reportError(e, ou);

  window.addEventListener("error", (e) => {
    try {
      reportError(e.message || (e.error && e.error.message) || "erreur",
        (e.filename || "") + ":" + (e.lineno || 0) + ":" + (e.colno || 0),
        (e.error && e.error.stack) || "");
    } catch (_) { /* nothing */ }
  });
  window.addEventListener("unhandledrejection", (e) => {
    try {
      const r = (e as PromiseRejectionEvent).reason as { message?: string; stack?: string } | undefined;
      reportError((r && r.message) || String(r) || "unhandled rejection", "unhandledrejection", (r && r.stack) || "");
    } catch (_) { /* nothing */ }
  });

  let derniereActivite = Date.now(), timer: ReturnType<typeof setInterval> | null = null, cadence = 0;
  function planifier(every: number): void {
    if (cadence === every && timer) return;
    cadence = every;
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      try {
        if (document.hidden) return;
        const repos = Date.now() - derniereActivite >= SENTINEL_IDLE_AFTER;
        planifier(repos ? SENTINEL_IDLE : SENTINEL_FAST);
        whitePageSentinel(ctx, "tick", recadrer);
      } catch (_) { /* nothing */ }
    }, every);
  }
  // Any activity makes the cadence fast RIGHT AWAY (we don't finish the current slow cycle).
  const poke = (): void => {
    derniereActivite = Date.now();
    if (cadence !== SENTINEL_FAST) planifier(SENTINEL_FAST);
  };
  ["pointerdown", "pointermove", "wheel", "keydown", "touchstart", "resize", "visibilitychange"]
    .forEach((ev) => window.addEventListener(ev, poke, { passive: true, capture: true }));
  planifier(SENTINEL_FAST);

  // Test hook: force a sentinel pass on demand (harmless in production).
  (window as unknown as { __forceSentinel?: (r?: string) => void }).__forceSentinel =
    (r?: string) => { try { whitePageSentinel(ctx, r || "forced", recadrer); } catch (_) { /* nothing */ } };
}
