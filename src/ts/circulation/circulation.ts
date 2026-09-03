// src/ts/circulation/circulation.ts: THE CIRCULATION ENGINE, PORTED VERBATIM AND LAST.
// This slice ports src/js/38-flow-ui.js (294 lines): the panel, the `#flowPill` pill,
// the overlay layer, and the debounce/live-analysis split. The other four slices are
// in the neighboring files, one for one:
//   js/34 → contexte.ts · js/35 → grille.ts · js/36 → regles.ts · js/37 → correctifs.ts
// and the `let`s of the old single closure are in etat.ts.
//
// "Eleven rules made right, no type defect in their history. Port it verbatim, last,
// without touching it." (docs/reecriture.md §7.4). No threshold, no message, no constant,
// no finding identifier has changed.
//
// THE ONLY DEFECT THIS ENGINE HAS RECENTLY HAD WAS ITS INTEGRATION: it was inert with the panel
// closed (`if(!flow && !overlay) return`), so the toolbar pill kept the last computed value,
// which is to say NOTHING as long as nobody had opened the panel. That's why
// `brancherCirculation` wires the debounced analysis to the render pass AND restores the UI
// state of the panel: the engine must run even when nobody is looking.

import type { Contexte } from "../app/contexte.ts";
import type { Constat, SurlignagePinch } from "./etat.ts";
import { FL, poserContexteFlow, scoreFromCounts } from "./etat.ts";
import { $ } from "../noyau/dom.ts";
import { numField } from "../noyau/champ-numerique.ts";
import { pieceById, v5OpeningById } from "../app/contexte.ts";
import { v5OpeningBox } from "../modele/murs.ts";
import { render } from "../rendu/rendu.ts";
import { selReplace } from "../rendu/selection.ts";
import { save } from "../app/persistance.ts";
import { gesteActif } from "../gestes/sortie.ts";
import { aptCmToVp, aptFlowSig, hDefaut, pieceAABB, rectGap, sizeFlowCanvas } from "./contexte.ts";
import { cellCenterCm } from "./grille.ts";
import { analyzeApt } from "./regles.ts";

/** `$` without the fallback: the html/03 fragment is always there, exactly as in the old client. */
const E = (id: string): HTMLElement => $(id) as HTMLElement;

// =====================================================================
//  FLOW UI
// =====================================================================
// `scoreFromFindings` / `scoreFromCounts` are in etat.ts: js/36 calls the former, and an
// ES module can't loop. Their bodies haven't changed by a single line.
function scoreOf(): number { return scoreFromCounts(FL.findingCounts); }
function bandOf(s: number): { label: string; color: string } {
  if (s >= 85) return { label: "Flows well", color: "#3f7a4f" };
  if (s >= 60) return { label: "Needs tuning", color: "#b8860b" };
  return { label: "Needs review", color: "var(--danger)" };
}
// any furniture anywhere in the apartment? (the score reflects the whole plan, not one room)
function anyAptPieces(): boolean { return ((FL.ctx.etat.plan && FL.ctx.etat.plan.pieces) || []).length > 0; }

// ---- the toolbar pill ----------------------------------------------------
// It's SEEN PERMANENTLY, so it must stay quiet when everything is fine and only speak up
// when there's something to fix.
// It no longer shows the score: 100 and 91 aren't distinguishable at a glance, and a score
// out of 100 conflates a BLOCKER (a door that won't open, a room that can't be reached) with a
// comfort tip, a single blocker gives 82, that is to say the same band as a plan with six
// tips. So it shows a COUNT OF FINDINGS, that of the worst severity present, and its
// color IS that severity. Neither blocker nor warning: it DISAPPEARS (a permanent green "0" is
// noise, and as long as nothing has been analyzed yet there's nothing honest to announce).
// Comfort tips alone don't light it up: they don't describe a plan that wouldn't
// work, and the "Circulation" button is still there for whoever wants to read them.
// The counts come from the WHOLE list (before the display cap), see js/36.
function pillState(): { n: number; cls: string } | null {
  const c = FL.findingCounts || ({} as typeof FL.findingCounts);
  if (c.error > 0) return { n: c.error, cls: "bad" };
  if (c.warn > 0) return { n: c.warn, cls: "warn" };
  return null;
}
function flowButtonTitle(): string {
  const c = FL.findingCounts || ({} as typeof FL.findingCounts), parts: string[] = [];
  if (c.error) parts.push(c.error + (c.error > 1 ? " blocking issues" : " blocking issue"));
  if (c.warn) parts.push(c.warn + (c.warn > 1 ? " to review" : " to review"));
  if (c.tip) parts.push(c.tip + (c.tip > 1 ? " tips" : " tip"));
  if (!anyAptPieces()) return "Circulation: add furniture to check the layout";
  return parts.length ? "Circulation: " + parts.join(", ") : "Circulation: nothing to report";
}
function renderFlow(): void {
  const s = scoreOf(), band = bandOf(s);
  const has = anyAptPieces();
  const pill = E("flowPill"), ps = pillState();
  // `[hidden]` already carries `display:none!important` (css/01): nothing to add on the stylesheet side.
  if (ps) { pill.hidden = false; pill.textContent = String(ps.n); pill.className = "pill " + ps.cls; }
  else { pill.hidden = true; pill.textContent = ""; }
  E("btnFlow").title = flowButtonTitle();
  if (E("flowpanel").hidden) return;
  E("flowNum").textContent = has ? String(s) : "–";
  E("flowNum").style.color = has ? band.color : "var(--faint)";
  E("flowBand").textContent = has ? band.label : "";
  E("flowBand").style.color = band.color;
  E("flowChecking").textContent = "";
  const list = E("flowList");
  // no-flash guard: if the finding set is identical (same ids+severities, same order) AND the
  // empty/pieces context is unchanged, keep the existing DOM (only the score chips above updated).
  const sig = FL.findings.map((f) => f.id + ":" + f.severity).join("|") + "#" + (has ? 1 : 0) + "#" + FL.findingTotal;
  if (list.dataset["sig"] === sig) return;
  list.dataset["sig"] = sig;
  if (!FL.findings.length) {
    list.innerHTML = `<div class="flow-empty">${has ? "Nothing to report, this layout looks fine." : "Add furniture to check the layout."}</div>`;
    return;
  }
  list.innerHTML = "";
  FL.findings.forEach((f) => {
    const row = document.createElement("div");
    row.className = "finding" + (FL.hoverFinding === f.id ? " on" : "");
    row.dataset["fid"] = f.id;
    row.innerHTML = `<div class="fh"><span class="dot ${f.severity}"></span><span class="ft"></span></div>
        <div class="fd"></div>`;
    (row.querySelector(".ft") as HTMLElement).textContent = f.title;
    (row.querySelector(".fd") as HTMLElement).innerHTML = f.detail;
    // `fix` is captured into a constant: the closure calls EXACTLY the same object
    // as before (`f.fix.apply()`), the typing only named the narrowing.
    const fix = f.fix;
    if (fix) {
      const b = document.createElement("button");
      b.className = "btn sm fix"; b.textContent = fix.label;
      b.addEventListener("click", (ev) => { ev.stopPropagation(); try { fix.apply(); } catch (_e) { /* a fix that throws doesn't break the panel */ } });
      row.appendChild(b);
    }
    row.addEventListener("mouseenter", () => { FL.hoverFinding = f.id; markOn(row); drawOverlay(); });
    row.addEventListener("mouseleave", () => { FL.hoverFinding = null; markOn(null); drawOverlay(); });
    row.addEventListener("click", () => { FL.hoverFinding = (FL.hoverFinding === f.id ? null : f.id); markOn(FL.hoverFinding ? row : null); drawOverlay(); highlightPieces(f); });
    list.appendChild(row);
  });
  // The cap of 14 (js/36) used to cut SILENTLY. The sort by severity runs first, so what
  // gets dropped is always at most as severe as what remains, but MEASURED at 300 objects, a plan
  // can carry 25 blockers: eleven of them then fall into the 23 findings not shown.
  // The list must therefore not pass itself off as complete, and the pill, for its part, counts everything.
  const hidden = FL.findingTotal - FL.findings.length;
  if (hidden > 0) {
    const more = document.createElement("div");
    more.className = "flow-more";
    more.textContent = hidden + (hidden > 1 ? " more findings not shown" : " more finding not shown");
    list.appendChild(more);
  }
}
function markOn(activeRow: HTMLElement | null): void {
  E("flowList").querySelectorAll(".finding").forEach((r) => r.classList.toggle("on", r === activeRow));
}
function highlightPieces(f: Constat): void {
  if (!(f.targets && f.targets.length)) return;
  const id = f.targets[0];
  selReplace(FL.ctx, id); render(FL.ctx); FL.ctx.crochets.openInspector?.();
}

// ---- overlay canvas draw ----
// coalesced reprojection (1 per frame max): the overlay no longer "trails" behind pan/zoom
let _ovRaf = 0, _ovSig = "";
function scheduleOverlayDraw(): void { if (_ovRaf) return; _ovRaf = requestAnimationFrame(() => { _ovRaf = 0; drawOverlay(); }); }
function drawOverlay(): void {
  const flowCanvas = FL.flowCanvas;
  if (!flowCanvas) return;
  sizeFlowCanvas();
  const ctx = flowCanvas.getContext("2d") as CanvasRenderingContext2D;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, flowCanvas.width, flowCanvas.height);
  if (!FL.ctx.etat.opts.flow && !FL.hoverFinding) return;
  if (!FL.lastGrid || !FL.lastGrid.g) return;
  const g = FL.lastGrid.g, clear = FL.lastGrid.clear as Float64Array;
  // `SC`: the view's scale. js/38 named this local `S`; here `S` would have shadowed something
  // else, and a LOCAL variable name is part of no contract.
  const cs = g.cs, SC = FL.ctx.vue.scale;
  const M = aptCmToVp;   // the single global grid lives in apartment cm
  // shade clearance across the WHOLE apartment (one grid): the panel and the overlay are the
  // SAME state since decision 0015 (`Show circulation` was a separate button, now the Circulation
  // button's own click paints this too).
  if (FL.ctx.etat.opts.flow) {
    for (let gy = 0; gy < g.gh; gy++) for (let gx = 0; gx < g.gw; gx++) {
      const i = gy * g.gw + gx; if (g.blocked[i]) continue;
      const width = clear[i]! * 2;
      let col: string;
      if (width >= 110) col = "rgba(63,122,79,.14)";
      else if (width >= 90) col = "rgba(63,122,79,.09)";
      else if (width >= 75) col = "rgba(184,134,11,.16)";
      else col = "rgba(176,74,61,.20)";
      ctx.fillStyle = col;
      const p0 = M(g.ox + gx * cs, g.oy + gy * cs);
      ctx.fillRect(p0.x, p0.y, cs * SC + 0.5, cs * SC + 0.5);
    }
    // routes (may cross rooms through doorways)
    ctx.strokeStyle = "rgba(31,111,120,.55)"; ctx.lineWidth = 2; ctx.lineCap = "round";
    (FL.lastGrid.routes || []).forEach((path) => {
      ctx.beginPath();
      path.forEach((idx, k) => { const c = cellCenterCm(g, idx); const s = M(c.x, c.y); if (k) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); });
      ctx.stroke();
    });
    // pinch markers
    FL.findings.forEach((f) => { if (f.highlight && f.highlight.type === "pinch") drawPinch(ctx, f.highlight, M); });
  }
  // highlighted finding
  if (FL.hoverFinding) {
    const f = FL.findings.find((x) => x.id === FL.hoverFinding);
    if (f) drawFindingHi(ctx, f, M);
  }
}
// apt-space AABB of a piece by id. Everything is already in apartment cm (furniture AND openings).
function aptAABBById(id: string): ReturnType<typeof pieceAABB> | null {
  const p = pieceById(FL.ctx, id); if (p) return pieceAABB(p);
  const o = v5OpeningById(FL.ctx, id);
  if (o) {
    const b = v5OpeningBox(FL.ctx.etat.plan, o, hDefaut(o.type));
    if (b) return pieceAABB({ x: b.cx - b.w / 2, y: b.cy - b.h / 2, w: b.w, h: b.h, rot: b.rot });
  }
  return null;
}
function drawPinch(ctx: CanvasRenderingContext2D, h: SurlignagePinch, M: typeof aptCmToVp): void {
  const s = M(h.x, h.y), x = s.x, y = s.y;
  ctx.save();
  ctx.fillStyle = h.width < 75 ? "#b04a3d" : "#b8860b";
  ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill();
  ctx.font = "600 11px ui-monospace,Consolas,monospace";
  const t = h.width + "cm"; const tw = ctx.measureText(t).width;
  ctx.fillStyle = "rgba(255,255,255,.92)";
  ctx.fillRect(x + 6, y - 9, tw + 8, 16);
  ctx.fillStyle = h.width < 75 ? "#b04a3d" : "#8a6608";
  ctx.fillText(t, x + 10, y + 3);
  ctx.restore();
}
function drawFindingHi(ctx: CanvasRenderingContext2D, f: Constat, M: typeof aptCmToVp): void {
  const vScale = FL.ctx.vue.scale;
  ctx.save();
  // outline target pieces (apartment-space AABB, any room)
  (f.targets || []).forEach((id) => {
    const b = aptAABBById(id); if (!b) return;
    const s0 = M(b.x0, b.y0);
    ctx.strokeStyle = "#1f6f78"; ctx.lineWidth = 2.5;
    ctx.strokeRect(s0.x, s0.y, (b.x1 - b.x0) * vScale, (b.y1 - b.y0) * vScale);
  });
  const h = f.highlight; if (!h) { ctx.restore(); return; }
  if (h.type === "rect") {
    const s0 = M(h.rect.x0, h.rect.y0), w = (h.rect.x1 - h.rect.x0) * vScale, hh = (h.rect.y1 - h.rect.y0) * vScale;
    ctx.fillStyle = "rgba(176,74,61,.15)"; ctx.strokeStyle = "#b04a3d"; ctx.lineWidth = 2;
    ctx.fillRect(s0.x, s0.y, w, hh);
    ctx.strokeRect(s0.x, s0.y, w, hh);
  } else if (h.type === "gap") {
    const a = pieceAABB(h.a), b = pieceAABB(h.b);
    const sa = M(a.cx, a.cy), sb = M(b.cx, b.cy);
    const x1 = sa.x, y1 = sa.y, x2 = sb.x, y2 = sb.y;
    ctx.strokeStyle = "#1f6f78"; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
    const gap = Math.round(rectGap(a, b));
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    ctx.font = "600 11px ui-monospace,Consolas,monospace"; const t = gap + "cm"; const tw = ctx.measureText(t).width;
    ctx.fillStyle = "rgba(255,255,255,.92)"; ctx.fillRect(mx - tw / 2 - 4, my - 8, tw + 8, 16);
    ctx.fillStyle = "#12474d"; ctx.fillText(t, mx - tw / 2, my + 3);
  } else if (h.type === "pinch") {
    drawPinch(ctx, h, M);
  } else if (h.type === "point") {
    const s = M(h.x, h.y);
    ctx.strokeStyle = "#b04a3d"; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(s.x, s.y, 10, 0, 7); ctx.stroke();
  }
  ctx.restore();
}

// ONE apartment-wide analysis. Cached by aptFlowSig(): if nothing that affects circulation
// changed since the last run, reuse the cached result (still repaint so pan/zoom stay live).
// (js/36 declared `analyze()`; it lives here because it PAINTS, `renderFlow` and `drawOverlay` are
// of this module, and an ES module can't loop. Its body hasn't changed.)
export function analyze(force?: boolean): void {
  const sig = aptFlowSig();
  if (force || sig !== FL.aptCacheSig || !FL.aptResult) {
    FL.aptResult = analyzeApt();
    FL.aptCacheSig = sig;
  }
  FL.findings = FL.aptResult.findings;
  FL.findingCounts = FL.aptResult.counts;
  FL.findingTotal = FL.aptResult.total;
  FL.lastGrid = FL.aptResult.grid;
  renderFlow();
  drawOverlay();
}

// ---- debounced scheduling ----
// THE ENGINE IS NO LONGER INERT WITH THE PANEL CLOSED. It used to be (`if(!flow && !overlay) return`), so the
// toolbar pill kept the last computed value, that is to say NOTHING as long as
// nobody had opened the panel. The information was already computed, already correct, and never
// shown.
// MEASURED before making it permanent (headless Chrome, real plan then 300 objects): a full
// pass (grid + clearance field + Dijkstra + rules) costs 30 to 50 ms, and this cost barely
// depends on the number of objects (it's the grid that dominates, capped at ~160x160 cells).
// 30 to 50 ms is two to three dropped frames: acceptable ONCE after a gesture, not
// acceptable DURING one. Hence the split:
//   - `scheduleAnalysis` (180 ms trailing debounce) always runs, panel open or closed.
//     render() doesn't call it during a gesture (js/12); endGesture() calls it back on exit.
//     The pill is thus accurate at rest, and stays quiet during the gesture instead of chopping it up.
//   - `liveAnalyze` (during the drag) stays reserved for the panel/overlay: only they
//     show something that changes every frame. Measured at 77 objects, panel closed: 0
//     long tasks over a 60-move drag, p95 frame time 23.6 ms; panel open:
//     126 ms of long tasks, p95 46.5 ms. That's the price we refuse to impose on someone
//     who hasn't opened anything.
// A call that lands on an unchanged signature (`aptFlowSig`, js/34) recomputes nothing.
// js/38's `anaPending` isn't carried over: it was read nowhere (esbuild would say so too).
let anaT: ReturnType<typeof setTimeout> | null = null;
function scheduleAnalysis(): void {
  if (!E("flowpanel").hidden) { E("flowChecking").textContent = "checking…"; }
  if (anaT) clearTimeout(anaT);
  anaT = setTimeout(() => { analyze(); }, 180);
}
export function analyzeNow(): void { if (anaT) clearTimeout(anaT); analyze(); }
// ---- throttled LIVE analysis (fires DURING a continuous drag, not only at its end) ----
// Unlike scheduleAnalysis (trailing debounce), this runs at most every LIVE_MS while the
// gesture keeps calling it; render()'s trailing debounced run still finalises the end state.
const LIVE_MS = 150;
let liveLast = 0, liveT: ReturnType<typeof setTimeout> | null = null, liveRaf = 0;
// Run the (synchronous grid+Dijkstra) analysis OFF the move handler: throttle to LIVE_MS, and when
// the window elapses defer the actual analyze() to the next animation frame so the drag's own
// render() paints first and the heavy compute never blocks the pointermove that triggered it.
function runAnalyzeRaf(): void { if (liveRaf) return; liveRaf = requestAnimationFrame(() => { liveRaf = 0; liveLast = Date.now(); analyze(); }); }
export function liveAnalyze(): void {
  // deliberately NOT ungated: see the block above, it's the cost of the drag that decides.
  if (!FL.ctx.etat.opts.flow) return;
  const now = Date.now(), wait = LIVE_MS - (now - liveLast);
  if (wait <= 0) { if (liveT) clearTimeout(liveT); liveT = null; runAnalyzeRaf(); }
  else if (!liveT) { liveT = setTimeout(() => { liveT = null; runAnalyzeRaf(); }, wait); }
}

// ---- flow toolbar / panel wiring ----
// ONE state now drives both the panel AND the shaded overlay (decision 0015: the "Show
// circulation" button is gone, its layer is a state of THIS button). A click opens the panel and
// paints the layer together; a second click closes both.
function setFlowOpen(on: boolean): void {
  FL.ctx.etat.opts.flow = on;
  E("flowpanel").hidden = !on;
  (document.querySelector(".app") as HTMLElement).classList.toggle("flow-open", on);
  E("btnFlow").setAttribute("aria-pressed", on ? "true" : "false");
  E("btnFlow").classList.toggle("pri", on);
  // the floating-panel column (inspector + sheet) shifts over when Circulation takes the right side
  E("sidePanels").style.right = on ? "296px" : "16px";
  save(FL.ctx);
  render(FL.ctx);   // keep transform; stage width changed but we don't force a refit
  if (on) analyzeNow(); else renderFlow();
}

/**
 * What js/12 (`render()`) used to do for Circulation, and which doesn't belong to rendering: the
 * rescheduling of the debounced analysis, and the reprojection of the overlay when the VIEW has moved.
 */
function apresRenduFlow(): void {
  const ctx = FL.ctx;
  // During a live gesture the move-handler drives liveAnalyze() itself (rAF-throttled); don't also
  // reschedule the 180ms debounce on EVERY move (it thrashed). Gesture exit finalizes it.
  if (!gesteActif() && !ctx.viewOnly) scheduleAnalysis();
  // the circulation overlay follows pan/zoom: reproject only when the VIEW has changed
  if ((ctx.etat.opts.flow || FL.hoverFinding) && FL.lastGrid) {
    const sig = ctx.vue.scale + "|" + ctx.vue.ox + "|" + ctx.vue.oy;
    if (sig !== _ovSig) { _ovSig = sig; scheduleOverlayDraw(); }
  }
}

export function brancherCirculation(ctx: Contexte): void {
  poserContexteFlow(ctx);
  // js/37: `afterFix()`, the fix mutated the REAL piece, we repaint and re-analyze.
  FL.afterFix = () => { render(ctx); ctx.crochets.syncInspector?.(); analyzeNow(); };

  // THE TWO HOOKS ALREADY PROVIDED FOR (app/contexte.ts).
  // `analyser` has THREE callers, and the old client knew TWO FORMS: `endGesture()`
  // (js/03) called `scheduleAnalysis()`, while replacing the plan (js/27) and exiting
// The retired structural toggle called `analyzeNow()`. A single hook could not carry both;
  // we keep `scheduleAnalysis`, that is to say the EXACT behavior of the HOT path (a gesture
  // exit, hundreds of times per session, and the one js/38 explicitly wanted debounced).
  // The two cold paths get the same state 180 ms later: same computation, same result,
  // only the paint date differs.
  ctx.crochets.analyser = () => scheduleAnalysis();
  ctx.crochets.liveAnalyze = () => liveAnalyze();
  // `apresRendu` is a SINGLE slot, already occupied by the opening handles (js/56, set by
  // main.ts). We WRAP it: the previous value is called first, never overwritten.
  const apresRenduPrecedent = ctx.crochets.apresRendu;
  ctx.crochets.apresRendu = () => {
    if (apresRenduPrecedent) apresRenduPrecedent();
    apresRenduFlow();
  };

  E("btnFlow").addEventListener("click", () => setFlowOpen(!ctx.etat.opts.flow));
  E("flowClose").addEventListener("click", () => setFlowOpen(false));
  // TV inches: same guard as dimension fields. Clearing the field RESETS the rule
  // to its default (it's an optional setting), a value outside 10..120 inches is refused
  // and stated, never silently defaulted.
  numField($("flowTv"), {
    label: "TV size", unit: "inches", optional: true,
    bounds: () => ({ min: 10, max: 120 }),
    get: () => ctx.etat.opts.tvIn as number | null,
    set: (v: number) => { ctx.etat.opts.tvIn = v; save(ctx); analyzeNow(); },
    clear: () => { ctx.etat.opts.tvIn = null; save(ctx); analyzeNow(); },
  });

  // ---- restored UI state (js/46-init) --------------------------------------------------------
  // The `.flow-open` class is set BEFORE the framing (main.ts calls `fitView` after us): the
  // framing must account for the right-hand column, otherwise the plan overflows the viewport.
  E("flowpanel").hidden = !ctx.etat.opts.flow;
  (document.querySelector(".app") as HTMLElement).classList.toggle("flow-open", !!ctx.etat.opts.flow);
  E("btnFlow").setAttribute("aria-pressed", ctx.etat.opts.flow ? "true" : "false");
  E("btnFlow").classList.toggle("pri", !!ctx.etat.opts.flow);
  // The two floating panels are STACKED in a column: it's that column we shift when the
  // Circulation panel takes the right side of the screen, versus the inspector alone.
  E("sidePanels").style.right = ctx.etat.opts.flow ? "296px" : "16px";
  // Panel open: we analyze right away (the panel would be empty for 180 ms). Panel closed: the
  // pill can wait for the first render()'s debounce, startup doesn't pay the 30-50 ms.
  if (ctx.etat.opts.flow) analyzeNow(); else scheduleAnalysis();
}
