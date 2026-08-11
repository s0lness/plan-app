// src/ts/sonde-export.ts — THE PROBE SLICE FOR THE "export" SUB-BATCH (E3c).
// One probe file PER BATCH: `js/57-sondes-test.js` was "the repo's most likely git conflict
// point", and two keys were genuinely duplicated in it.
//
// TRAP PAID FOR BY THE PREVIOUS BATCH: `Object.assign` COPIES an accessor's VALUE. Anything
// that must stay LIVE is written as `get x()` here, and `sonde.ts` carries the DESCRIPTORS. This
// file's four live entries (`measureMode`, `measureCount`, `measures`, `appMeasuring`) would
// otherwise be SNAPSHOTS taken at install time, and every suite would read the same value for
// its whole life.
//
// WHAT THIS FILE COVERS: outputs (master SVG, PNG, printing, furniture list, JSON file), the
// measuring tape, the cursor-distance probe, and the three "show..." calls that make the
// ephemeral text families APPEAR so that a single snapshot measures all of them.

import type { Contexte } from "./app/contexte.ts";
import type { Ouverture } from "./partage/plan.ts";
import { pieceById, v5OpeningById } from "./app/contexte.ts";
import { v5DrawWallDims } from "./gestes/murs.ts";
import { v5DrawOpeningGuides } from "./gestes/ouverture.ts";
import { pieceAABB } from "./gestes/guides.ts";
import { measureMode } from "./gestes/etat-pointeur.ts";
import { buildMasterSVG, type OptionsSVGMaitre } from "./exportation/svg-maitre.ts";
import { clearPrint, exportPNG, preparePrint, printPlan, renderMasterPNG, type RenduPNG } from "./exportation/impression.ts";
import {
  buildFurnitureData, furnitureListHTML, furnitureListText, type SectionListe,
} from "./exportation/liste-mobilier.ts";
import { closeFurni, openFurni } from "./exportation/exportation.ts";
import { exportPayload, importPlan } from "./exportation/transfert.ts";
import {
  allPieceCornersApt, clearMeasures, drawMeasures, measureClickApt, measureDistCm, mesureEnAttente,
  mesuresPosees, resetMeasurePending, setMeasureMode, snapMeasurePoint,
  type PointAccroche, type PointMesure, type Segment,
} from "./mesure/mesure.ts";
import {
  allBlockerAABBsApt, clearCursorGuides, cursorDistances, drawCursorGuides, type BoiteObstacle,
} from "./mesure/guides-curseur.ts";
import { peindreCurseurPair } from "./mesure/curseur-pair.ts";

export interface MesureLue {
  a: PointMesure;
  b: PointMesure;
  cm: number;
}

export interface DeuxClics {
  count: number;
  cm: number | null;
  snappedA: PointAccroche;
  snappedB: PointAccroche;
}

export interface SondeExport {
  // ---- outputs (PNG, PDF/printing, furniture list, file) ----
  buildMasterSVG(opts?: OptionsSVGMaitre): string;
  renderMasterPNG(scale?: number): Promise<RenduPNG>;
  exportPNG(): Promise<RenduPNG>;
  preparePrint(): void;
  clearPrint(): void;
  printPlan(): void;
  buildFurnitureData(): SectionListe[];
  furnitureData(): SectionListe[];
  furnitureListHTML(): string;
  furnitureListText(): string;
  openFurni(): void;
  closeFurni(): void;
  exportPayload(): string;
  importPlan(text: unknown): boolean;

  // ---- measuring tape ----
  setMeasureMode(on: boolean): void;
  readonly measureMode: boolean;
  readonly measureCount: number;
  readonly measures: MesureLue[];
  readonly appMeasuring: boolean;
  measureClickApt(ax: number, ay: number): Segment | null;
  measureTwoClicks(ax: number, ay: number, bx: number, by: number): DeuxClics;
  measureBetween(ax: number, ay: number, bx: number, by: number): number;
  measureSnap(ax: number, ay: number, tol?: number | null): PointAccroche;
  measureClickAtPieceCorner(pieceId: unknown): {
    snapped: PointMesure & { kind: string }; corner: PointMesure; measurePend: PointMesure | null;
  } | null;
  clearMeasures(): void;
  drawMeasures(): void;
  allPieceCornersApt(): PointMesure[];

  // ---- cursor-distance probe ----
  cursorDistances(ax: number, ay: number): { dir: string; dist: number }[];
  drawCursorGuidesNow(ax: number, ay: number): { lines: number; chips: number };
  cursorGuideCount(): number;
  clearCursorGuides(): void;
  allBlockerAABBsApt(): BoiteObstacle[];

  // ---- make the ephemeral text families APPEAR ----
  montrerCotesMurs(): number;
  montrerGuidesOuverture(id: unknown): number;
  montrerCurseurPair(x: number, y: number): number;
}

export function sondeExport(ctx: Contexte): SondeExport {
  return {
    buildMasterSVG: (opts?: OptionsSVGMaitre) => buildMasterSVG(ctx, opts),
    renderMasterPNG: (scale?: number) => renderMasterPNG(ctx, scale),
    exportPNG: () => exportPNG(ctx),
    preparePrint: () => preparePrint(ctx),
    clearPrint,
    printPlan: () => printPlan(ctx),
    buildFurnitureData: () => buildFurnitureData(ctx),
    furnitureData: () => buildFurnitureData(ctx),
    furnitureListHTML: () => furnitureListHTML(ctx),
    furnitureListText: () => furnitureListText(ctx),
    openFurni: () => openFurni(ctx),
    closeFurni,
    exportPayload: () => exportPayload(ctx),
    importPlan: (text: unknown) => importPlan(ctx, text),

    setMeasureMode: (on: boolean) => setMeasureMode(ctx, on),
    // LIVE, therefore accessors: `Object.assign` would have frozen them at install time.
    get measureMode() { return measureMode(); },
    get measureCount() { return mesuresPosees().length; },
    get measures(): MesureLue[] {
      return mesuresPosees().map((m) => ({ a: { x: m.a.x, y: m.a.y }, b: { x: m.b.x, y: m.b.y }, cm: measureDistCm(m.a, m.b) }));
    },
    get appMeasuring() { return !!document.querySelector(".app")?.classList.contains("measuring"); },
    measureClickApt: (ax: number, ay: number) => measureClickApt(ctx, ax, ay),
    measureTwoClicks(ax: number, ay: number, bx: number, by: number): DeuxClics {
      resetMeasurePending();
      const sa = snapMeasurePoint(ctx, ax, ay); measureClickApt(ctx, ax, ay);
      const sb = snapMeasurePoint(ctx, bx, by); const seg = measureClickApt(ctx, bx, by);
      return {
        count: mesuresPosees().length, cm: seg ? measureDistCm(seg.a, seg.b) : null,
        snappedA: sa, snappedB: sb,
      };
    },
    measureBetween: (ax: number, ay: number, bx: number, by: number) => measureDistCm({ x: ax, y: ay }, { x: bx, y: by }),
    measureSnap: (ax: number, ay: number, tol?: number | null) => snapMeasurePoint(ctx, ax, ay, tol),
    measureClickAtPieceCorner(pieceId: unknown) {
      const p = pieceById(ctx, pieceId); if (!p) return null;
      const b = pieceAABB(p);
      const target = { x: b.x0, y: b.y0 };
      const snapped = snapMeasurePoint(ctx, target.x + 3, target.y + 3);   // near the corner (within tolerance)
      measureClickApt(ctx, target.x + 3, target.y + 3);
      const pend = mesureEnAttente();
      return {
        snapped: { x: snapped.x, y: snapped.y, kind: snapped.kind }, corner: target,
        measurePend: pend ? { x: pend.x, y: pend.y } : null,
      };
    },
    clearMeasures: () => clearMeasures(ctx),
    drawMeasures: () => drawMeasures(ctx),
    allPieceCornersApt: () => allPieceCornersApt(ctx),

    cursorDistances: (ax: number, ay: number) => cursorDistances(ctx, ax, ay).map((g) => ({ dir: g.dir, dist: Math.round(g.dist) })),
    drawCursorGuidesNow(ax: number, ay: number) {
      drawCursorGuides(ctx, ax, ay);
      const ov = document.getElementById("cursorGuides");
      return { lines: ov ? ov.querySelectorAll(".cgline").length : 0, chips: ov ? ov.querySelectorAll(".cgchip").length : 0 };
    },
    cursorGuideCount() {
      const ov = document.getElementById("cursorGuides");
      return ov ? ov.querySelectorAll(".cgline").length : 0;
    },
    clearCursorGuides,
    allBlockerAABBsApt: () => allBlockerAABBsApt(ctx),

    // Make the ephemeral text families APPEAR, so a test can measure all of them in the same
    // snapshot: wall dimensions (wall drag), clearance guides (opening drag), a peer's cursor
    // label (realtime wire).
    montrerCotesMurs(): number {
      v5DrawWallDims(ctx, (ctx.etat.plan.walls || []).slice(0, 6));
      return ctx.canvas.querySelectorAll(".v5dim").length;
    },
    montrerGuidesOuverture(id: unknown): number {
      const o: Ouverture | null = v5OpeningById(ctx, id); if (!o) return 0;
      v5DrawOpeningGuides(ctx, o);
      return document.querySelectorAll(".guides .glab").length;
    },
    montrerCurseurPair(x: number, y: number): number {
      peindreCurseurPair(ctx, { by: "pair@exemple.fr", tag: "t-pair", color: "#c0392b", x, y });
      return document.querySelectorAll(".peer-cur .pc-name").length;
    },
  };
}
