// src/ts/app/diagnostics.ts: THE UNCAUGHT-ERROR REPORT, and nothing else.
//
// `window.onerror` and `unhandledrejection` land here; the entry goes into a local ring of ten
// (`localStorage["plan-errors"]`) and, when sync is on, to `POST /api/err`, whose rate limit and
// retention live on the server (`functions/api/err.ts`).
//
// THE RING IS NOT A SOUVENIR: every browser suite rereads `plan-errors` after each case to
// declare a failure on an uncaught JS error. Without it an error in the client would be seen by
// NO ONE and the suites would render a FALSE green.
//
// THE FLIGHT RECORDER IS GONE (decision 0019): the breadcrumb trail, the white-page sentinel and
// its 3 s cadence, the red banner. They were born of the July "white page" saga, which the single
// layer closed; the server never stored a single breadcrumb (`functions/api/err.ts` writes
// `msg`, `src`, `stack`, `ua`).

import type { Contexte } from "./contexte.ts";

const ERR_KEY = "plan-errors";

export interface EntreeErreur { at: string; msg: string; src: string; stack: string }

let _errReenter = false;

const errShortMsg = (m: unknown): string => {
  const s = String(m == null ? "unknown error" : m);
  return s.length > 140 ? s.slice(0, 140) + "…" : s;
};

/** The local ring of the last 10 errors. This is what every suite reads. */
function errRing(entry: EntreeErreur): void {
  try {
    let arr: EntreeErreur[] = [];
    try { arr = (JSON.parse(localStorage.getItem(ERR_KEY) || "[]") as EntreeErreur[]) || []; } catch (_) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    arr.push(entry);
    while (arr.length > 10) arr.shift();
    localStorage.setItem(ERR_KEY, JSON.stringify(arr));
  } catch (_) { /* zero quota: we lose the trace, never the application */ }
}

/** The POST to `/api/err`. Wired by `fil/branchement.ts`, absent under `file://` and in an iframe. */
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
      at: new Date().toISOString(), msg: errShortMsg(texte), src: String(src || ""), stack: pile,
    };
    errRing(entry);
    if (_envoyer) _envoyer(entry);
  } catch (_) { /* nothing */ }
  finally { _errReenter = false; }
}

export function brancherDiagnostics(ctx: Contexte): void {
  // A gesture that throws reports through this hook (`gestes/sortie.ts`, `app/options.ts`):
  // it is the only path by which a caught exception still reaches the ring and the server.
  ctx.crochets.reportError = (e: unknown, ou?: string) => reportError(e, ou);

  window.addEventListener("error", (e) => {
    try {
      reportError(e.message || (e.error && e.error.message) || "error",
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
}
