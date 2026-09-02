// src/ts/circulation/etat.ts: THE STATE OF THE CIRCULATION ENGINE, AND NOTHING ELSE. Findings,
// grid cache, and analysis context are gathered in one object (`FL`), a page-level singleton
// like `app/contexte.ts`; `FL.ctx` is set once by `brancherCirculation`, the same pattern as
// `gestes/sortie.ts`. The analysis is never reentrant, so there's nothing to stack or restore.

import type { Contexte } from "../app/contexte.ts";
import type { BBox } from "../geometrie/polygones.ts";
import type { Id, Meuble, Pt } from "../partage/plan.ts";

export type Gravite = "error" | "warn" | "tip";

/**
 * An object seen by the engine: a piece of furniture or an opening, always in apartment cm,
 * reduced to a box `{x,y,w,h,rot}`. `ci`/`cellName`/`onOutline` are set by `buildAptContext`;
 * they're optional because `fcPieces()` falls back to bare furniture when no context is set.
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
  /** Counts of the WHOLE list, before the display cap of 14: the toolbar pill must not
   * undercount blockers, nor forget tips it isn't displaying. */
  findingCounts: { error: 0, warn: 0, tip: 0 } as Comptes,
  /** number of findings produced (`findings.length` is the DISPLAYED count) */
  findingTotal: 0,
  /** id of the highlighted finding */
  hoverFinding: null as string | null,
  /** global grid cached as `{g,clear,routes,pinches}` for the overlay layer */
  lastGrid: null as GrilleGlobale | null,
  /** Inputs read by the engine, set by `analyzeApt()` before each pass (apartment cm throughout). */
  flowCtx: null as ContexteFlow | null,
  /** last analyzed signature (we don't recompute when nothing has moved) */
  aptCacheSig: null as string | null,
  aptResult: null as ResultatAnalyse | null,
  /** `afterFix()`: `render(); syncInspector(); analyzeNow();`, set by `brancherCirculation`. */
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
