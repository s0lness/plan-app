// src/ts/fil/hud.ts — THE LATENCY HUD (`?rt=1`).
// Ported from src/js/45-hud-latence.js.
//
// FIELD PROOF, measured in production with the REAL network and the REAL Durable Object: link
// state, incoming / outgoing cursors per second, received -> painted latency (p95 rolling over
// 5 s) and ping/pong round trip. Hidden without the URL parameter, and with no effect on the rest.
//
// THIS MODULE ONLY IMPORTS `Fil`: it is the only one in the batch that cannot break anything, and
// it must stay that way. `presence.ts` feeds it its measurements (`hudRecordPaint`), it goes
// fetching nothing itself.

import type { Fil } from "./etat.ts";

const FENETRE = 5000;      // ms of the rolling window
const MAX_MESURES = 600;

/** A received -> painted measurement, taken WITHIN the cursor's reception tick. */
export function hudRecordPaint(fil: Fil, ms: number): void {
  fil.paintLat.push({ t: performance.now(), ms });
  if (fil.paintLat.length > MAX_MESURES) fil.paintLat.shift();
}

export interface RoulantPeint { p50: number | null; p95: number | null; n: number }

function rollingPaint(fil: Fil): RoulantPeint {
  const cut = performance.now() - FENETRE;
  const xs: number[] = [];
  for (let i = fil.paintLat.length - 1; i >= 0; i--) {
    const e = fil.paintLat[i]!;
    if (e.t < cut) break;
    xs.push(e.ms);
  }
  if (!xs.length) return { p50: null, p95: null, n: 0 };
  xs.sort((a, b) => a - b);
  return {
    p50: +xs[Math.floor(xs.length * 0.5)]!.toFixed(1),
    p95: +xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))]!.toFixed(1),
    n: xs.length,
  };
}

export interface StatsTempsReel {
  wsOpen: boolean;
  rtt: number | null;
  inPerSec: number;
  outPerSec: number;
  dragPerSec: number;
  paintP50: number | null;
  paintP95: number | null;
  paintN: number;
  curOutTotal: number;
  curInTotal: number;
}

/** PER-SECOND counters: we remember the cumulative values from one second ago. */
let _prev = { t: 0, inC: 0, outC: 0, dragC: 0 };

function rtStats(fil: Fil): StatsTempsReel {
  const now = performance.now();
  if (!_prev.t) _prev = { t: now, inC: fil.curIn, outC: fil.curOut, dragC: fil.dragOut };
  const dt = (now - _prev.t) / 1000 || 1;
  const inps = Math.round((fil.curIn - _prev.inC) / dt);
  const outps = Math.round((fil.curOut - _prev.outC) / dt);
  const dragps = Math.round((fil.dragOut - _prev.dragC) / dt);
  _prev = { t: now, inC: fil.curIn, outC: fil.curOut, dragC: fil.dragOut };
  const rp = rollingPaint(fil);
  return {
    wsOpen: fil.wsOpen, rtt: fil.lastRtt,
    inPerSec: inps, outPerSec: outps, dragPerSec: dragps,
    paintP50: rp.p50, paintP95: rp.p95, paintN: rp.n,
    curOutTotal: fil.curOut, curInTotal: fil.curIn,
  };
}

export function brancherHud(fil: Fil): void {
  // `window.__rtStats` stays exposed unconditionally: it is the field measurement harness, and it
  // does not depend on the test flag (the old client set it too, even outside `?rt=1`).
  (window as unknown as { __rtStats?: () => StatsTempsReel }).__rtStats = () => rtStats(fil);
  if (!/[?&]rt=1\b/.test(location.search)) return;
  const hud = document.createElement("div");
  hud.id = "rtHud";
  hud.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:9999;font-family:var(--mono,monospace);"
    + "font-size:11px;line-height:1.5;color:#dfe;background:rgba(18,28,30,.86);padding:7px 9px;border-radius:7px;"
    + "white-space:pre;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.3)";
  document.body.appendChild(hud);
  setInterval(() => {
    const s = rtStats(fil);
    hud.textContent =
      "WS      " + (s.wsOpen ? "live ✓" : "offline") + "\n"
      + "cursor   in " + s.inPerSec + "/s  out " + s.outPerSec + "/s\n"
      + "drag    out " + s.dragPerSec + "/s\n"
      + "recv→paint p95 " + (s.paintP95 == null ? "—" : s.paintP95 + " ms")
      + "  (p50 " + (s.paintP50 == null ? "—" : s.paintP50) + ", n=" + s.paintN + ")\n"
      + "round trip     " + (s.rtt == null ? "—" : s.rtt + " ms");
  }, 500);
}
