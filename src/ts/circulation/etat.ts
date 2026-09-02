// src/ts/circulation/etat.ts: THE STATE OF THE CIRCULATION ENGINE, AND NOTHING ELSE.
//
// The engine is ported VERBATIM (docs/reecriture.md §7.4). In the old client it lived in the
// single closure: `flowCtx`, `findings`, `findingCounts`, `findingTotal`, `hoverFinding`,
// `lastGrid`, `aptCacheSig`, `aptResult` were plain `let`s visible from the five slices
// js/34 → js/38. Real ES modules don't share a reassignable `let`: so we gather
// these variables into ONE object, exactly as `app/contexte.ts` does for rendering.
//
// `FL.ctx` is the app context, set ONCE by `brancherCirculation`. That's the same
// approach as `gestes/sortie.ts` (`brancherSortieGestes(ctx)` → `_ctx`): the engine is a
// page-level singleton, the analysis is never reentrant ("Nothing to stack or restore", js/36),
// and threading `ctx` through sixty functions would have been a rewrite, not a translation.
//
// WHAT'S HERE AND WHAT js/38 USED TO DECLARE: `scoreFromFindings` and `scoreFromCounts`. They're pure,
// but js/36 CALLS `scoreFromFindings` while js/38 declares it: between two real ES modules,
// that would be a cycle. So they move down a level, without a single line of their body changing.

import type { Contexte } from "../app/contexte.ts";
import type { BBox } from "../geometrie/polygones.ts";
import type { Id, Meuble, Pt } from "../partage/plan.ts";

export type Gravite = "error" | "warn" | "tip";

/**
 * An object seen by the engine: a PIECE OF FURNITURE or an OPENING, always in apartment cm, always
 * reduced to a box `{x,y,w,h,rot}`. `ci` / `cellName` / `onOutline` are set by
 * `buildAptContext`; they're optional because `fcPieces()` falls back to `state.pieces`
 * (bare furniture) when no context has been set, that's the behavior of the old client,
 * and it's kept as is.
 */
export interface ObjetFlow {
  id: Id;
  type: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  locked: boolean;
  hinge?: 0 | 1 | undefined;
  swing?: 1 | -1 | undefined;
  /** index of the cell that contains the center, or `"env"` (outline / wall thickness) */
  ci?: number | "env" | undefined;
  cellName?: string | undefined;
  /** the opening is carried by a FACADE wall: the only exact definition of "on the outside" */
  onOutline?: boolean | undefined;
}

export interface CelluleFlow {
  poly: Pt[];
  ci: number;
  name: string;
}

export interface ContexteFlow {
  cells: CelluleFlow[];
  pieces: ObjetFlow[];
  bb: BBox;
  env: { poly: Pt[] };
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface AABB extends Rect {
  cx: number;
  cy: number;
}

export interface SurlignageRect { type: "rect"; rect: Rect }
export interface SurlignageGap { type: "gap"; a: ObjetFlow; b: ObjetFlow }
export interface SurlignagePinch { type: "pinch"; x: number; y: number; width: number }
export interface SurlignagePoint { type: "point"; x: number; y: number }
export type Surlignage = SurlignageRect | SurlignageGap | SurlignagePinch | SurlignagePoint;

export interface Correctif {
  label: string;
  apply: () => void;
}

/** A finding. `detail` goes out as innerHTML (js/38): every name in it is escaped (escapeHtml, js/00). */
export interface Constat {
  id: string;
  severity: Gravite;
  title: string;
  detail: string;
  targets: string[];
  highlight?: Surlignage;
  fix?: Correctif;
}

export interface Grille {
  cs: number;
  gw: number;
  gh: number;
  blocked: Uint8Array;
  W: number;
  L: number;
  ox: number;
  oy: number;
}

export interface GrilleGlobale {
  g: Grille | null;
  clear: Float64Array | null;
  routes: number[][];
  pinches: SurlignagePinch[];
}

export interface Comptes {
  error: number;
  warn: number;
  tip: number;
}

export interface ResultatAnalyse {
  findings: Constat[];
  grid: GrilleGlobale;
  score: number;
  counts: Comptes;
  total: number;
}

/** The `let`s of the old closure, gathered. A single engine per page, as before. */
export const FL = {
  ctx: null as unknown as Contexte,
  flowCanvas: null as HTMLCanvasElement | null,
  /** current findings, ONE list, apartment-wide */
  findings: [] as Constat[],
  /**
   * Counts of the WHOLE list, BEFORE the display cap of 14 (js/36). The toolbar
   * pill reads them: it must not announce 14 blockers when there are 20, and the
   * cap also must not make it forget tips it isn't displaying.
   */
  findingCounts: { error: 0, warn: 0, tip: 0 } as Comptes,
  /** number of findings produced (`findings.length` is the DISPLAYED count) */
  findingTotal: 0,
  /** id of the highlighted finding */
  hoverFinding: null as string | null,
  /** global grid cached as `{g,clear,routes,pinches}` for the overlay layer */
  lastGrid: null as GrilleGlobale | null,
  /**
   * The engine reads its inputs through `flowCtx`, set by `analyzeApt()` before each pass.
   * The apartment is analyzed as ONE plan: cells = rooms, outline = envelope, everything is
   * already in apartment cm, there's neither a local frame nor a translation.
   */
  flowCtx: null as ContexteFlow | null,
  /** last analyzed signature (we don't recompute when nothing has moved) */
  aptCacheSig: null as string | null,
  aptResult: null as ResultatAnalyse | null,
  /** `afterFix()` (js/37): `render(); syncInspector(); analyzeNow();`, set by js/38. */
  afterFix: (() => { /* set by brancherCirculation */ }) as () => void,
};

export function poserContexteFlow(ctx: Contexte): void {
  FL.ctx = ctx;
  FL.flowCanvas = document.getElementById("flowCanvas") as HTMLCanvasElement | null;
}

/** Pure scorer: same weights as before, on any findings list. */
export function scoreFromFindings(F: Constat[] | null | undefined): number {
  let s = 100;
  const w: Comptes = { error: 18, warn: 9, tip: 3 };
  (F || []).forEach((f) => { s -= w[f.severity] || 0; });
  return Math.max(0, s);
}

// The score is computed on the counts of the WHOLE list, not on the 14 displayed findings:
// otherwise a busy plan would get a better score than the truth, because the display
// cap had removed findings from the computation.
export function scoreFromCounts(c: Comptes): number {
  const w: Comptes = { error: 18, warn: 9, tip: 3 };
  return Math.max(0, 100 - (c.error || 0) * w.error - (c.warn || 0) * w.warn - (c.tip || 0) * w.tip);
}

/** The plan's furniture, in apartment cm, in the shape the engine works with. */
export const meublesDuPlan = (): ObjetFlow[] => (FL.ctx.etat.pieces || []) as Meuble[] as ObjetFlow[];
