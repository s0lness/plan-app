// src/ts/sonde-flow.ts — THE PROBE SLICE FOR THE "flow" SUB-BATCH (E3c).
// One probe file PER BATCH: `js/57-sondes-test.js` was "the repo's most likely git conflict
// point", and two keys were genuinely duplicated in it.
//
// TRAP PAID FOR BY THE PREVIOUS BATCH: `Object.assign` COPIES an accessor's VALUE. Anything
// that must stay LIVE is written as `get x()` here, and `sonde.ts` carries the DESCRIPTORS.
// `findings`, `flowCounts`, and `flowTotal` are REASSIGNED on every analysis (`analyze()`
// replaces `FL`'s three fields): so these are three ACCESSORS, never three frozen values.
import type { Contexte } from "./app/contexte.ts";
import type { Comptes, Constat, ContexteFlow, Gravite, Grille, ResultatAnalyse } from "./circulation/etat.ts";
import { FL } from "./circulation/etat.ts";
import { buildAptContext, isBlocker } from "./circulation/contexte.ts";
import { buildGrid } from "./circulation/grille.ts";
import { analyzeApt } from "./circulation/regles.ts";
import {
  analyze, analyzeNow, drawOverlay, renderFlow, scheduleAnalysis, setFlowOpen, setOverlay,
} from "./circulation/circulation.ts";
import { $ } from "./noyau/dom.ts";

/** What the toolbar badge ACTUALLY shows at this instant. */
export interface EtatPastille {
  hidden: boolean;
  txt: string;
  cls: string;
  title: string;
}

export interface SondeFlow {
  // ---- the engine, called directly (no debounce, no painting) ----
  analyzeApt(): ResultatAnalyse;
  buildAptContext(): ContexteFlow;
  buildGrid(): Grille;
  /** passthrough: check that a bathroom's furniture really counts as obstacles. */
  isBlocker(type: string): boolean;

  // ---- the engine, through the application's path ----
  analyzeNow(): void;
  scheduleAnalysis(): void;
  analyze(force?: boolean): void;
  renderFlow(): void;
  drawOverlay(): void;
  setFlowOpen(on: boolean): void;
  setOverlay(on: boolean): void;

  /** THE DISPLAYED FINDINGS (14 at most). LIVE: `analyze()` replaces the list. */
  readonly findings: Constat[];
  /** The counts for the WHOLE list, before the display cap. LIVE. */
  readonly flowCounts: Comptes;
  /** The number of findings PRODUCED (`findings.length` is the number shown). LIVE. */
  readonly flowTotal: number;
  flowPill(): EtatPastille;

  /** TOOL 8: Circulation. Analyzes WITHOUT painting, and sets the current list. */
  analyzeV5(): Array<{ id: string; title: string; severity: Gravite }>;
}

export function sondeFlow(_ctx: Contexte): SondeFlow {
  return {
    analyzeApt,
    buildAptContext,
    buildGrid,
    isBlocker: (type: string) => isBlocker({ type }),

    analyzeNow,
    scheduleAnalysis,
    analyze,
    renderFlow,
    drawOverlay,
    setFlowOpen,
    setOverlay,

    get findings() { return FL.findings; },
    // Circulation: the counts for the WHOLE list (before the display cap) and what the
    // toolbar badge ACTUALLY shows at this instant.
    get flowCounts() { return FL.findingCounts; },
    get flowTotal() { return FL.findingTotal; },
    flowPill(): EtatPastille {
      const p = $("flowPill") as HTMLElement;
      return {
        hidden: !!p.hidden, txt: String(p.textContent || ""), cls: p.className,
        title: ($("btnFlow") as HTMLElement).title,
      };
    },

    analyzeV5() {
      const r = analyzeApt(); FL.findings = r.findings;
      return r.findings.map((f) => ({ id: f.id, title: f.title, severity: f.severity }));
    },
  };
}
