// src/ts/sonde-flow.ts: THE PROBE SLICE FOR THE "flow" SUB-BATCH (E3c).
// One probe file PER BATCH: `js/57-sondes-test.js` was "the repo's most likely git conflict
// point", and two keys were genuinely duplicated in it.
//
// TRAP PAID FOR BY THE PREVIOUS BATCH: `Object.assign` COPIES an accessor's VALUE. Anything
// that must stay LIVE is written as `get x()` here, and `sonde.ts` carries the DESCRIPTORS.
// `findings` is REASSIGNED on every analysis (`analyze()` replaces `FL`'s field): so it is an
// ACCESSOR, never a frozen value.
import type { Contexte } from "./app/contexte.ts";
import type { Constat, ContexteFlow, Gravite, ResultatAnalyse } from "./circulation/etat.ts";
import { FL } from "./circulation/etat.ts";
import { buildAptContext } from "./circulation/contexte.ts";
import { analyzeApt } from "./circulation/regles.ts";
import { analyzeNow, renderFlow } from "./circulation/circulation.ts";

export interface SondeFlow {
  // ---- the engine, called directly (no debounce, no painting) ----
  analyzeApt(): ResultatAnalyse;
  buildAptContext(): ContexteFlow;

  // ---- the engine, through the application's path ----
  analyzeNow(): void;
  renderFlow(): void;

  /** THE DISPLAYED FINDINGS (14 at most). LIVE: `analyze()` replaces the list. */
  readonly findings: Constat[];

  /** TOOL 8: Circulation. Analyzes WITHOUT painting, and sets the current list. */
  analyzeV5(): Array<{ id: string; title: string; severity: Gravite }>;
}

export function sondeFlow(_ctx: Contexte): SondeFlow {
  return {
    analyzeApt,
    buildAptContext,

    analyzeNow,
    renderFlow,

    get findings() { return FL.findings; },

    analyzeV5() {
      const r = analyzeApt(); FL.findings = r.findings;
      return r.findings.map((f) => ({ id: f.id, title: f.title, severity: f.severity }));
    },
  };
}
