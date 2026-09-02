// src/ts/sonde-export.ts: THE PROBE SLICE FOR THE "export" SUB-BATCH (E3c).
// One probe file PER BATCH: `js/57-sondes-test.js` was "the repo's most likely git conflict
// point", and two keys were genuinely duplicated in it.
//
// TRAP PAID FOR BY THE PREVIOUS BATCH: `Object.assign` COPIES an accessor's VALUE. Anything
// that must stay LIVE is written as `get x()` here, and `sonde.ts` carries the DESCRIPTORS.
// `measures` would otherwise be a SNAPSHOT taken at install time, and every suite would read
// the same value for its whole life.
//
// WHAT THIS FILE COVERS: outputs (master SVG, printing, furniture list, JSON file), the
// measuring tape as the suites use it, and the three "show..." calls that make the ephemeral
// text families APPEAR so that a single snapshot measures all of them. Decision 0017: an entry
// exists because a suite reads it, and the feature behind it keeps its own button as a caller.

import type { Contexte } from "./app/contexte.ts";
import type { Ouverture } from "./partage/plan.ts";
import { v5OpeningById } from "./app/contexte.ts";
import { v5DrawWallDims } from "./gestes/murs.ts";
import { v5DrawOpeningGuides } from "./gestes/ouverture.ts";
import { buildMasterSVG, type OptionsSVGMaitre } from "./exportation/svg-maitre.ts";
import { clearPrint, preparePrint } from "./exportation/impression.ts";
import { buildFurnitureData, furnitureListText, type SectionListe } from "./exportation/liste-mobilier.ts";
import { openFurni } from "./exportation/exportation.ts";
import { importPlan } from "./exportation/transfert.ts";
import {
  measureClickApt, measureDistCm, mesuresPosees, setMeasureMode,
  type PointMesure, type Segment,
} from "./mesure/mesure.ts";
import { drawCursorGuides } from "./mesure/guides-curseur.ts";
import { creerNoeudCurseur } from "./mesure/curseur-pair.ts";
import { aptToScreen } from "./rendu/vue.ts";

export interface MesureLue {
  a: PointMesure;
  b: PointMesure;
  cm: number;
}

export interface SondeExport {
  // ---- outputs (master SVG, printing, furniture list, file) ----
  buildMasterSVG(opts?: OptionsSVGMaitre): string;
  preparePrint(): void;
  clearPrint(): void;
  furnitureData(): SectionListe[];
  furnitureListText(): string;
  openFurni(): void;
  importPlan(text: unknown): boolean;

  // ---- measuring tape ----
  setMeasureMode(on: boolean): void;
  readonly measures: MesureLue[];
  measureClickApt(ax: number, ay: number): Segment | null;

  // ---- cursor-distance probe ----
  drawCursorGuidesNow(ax: number, ay: number): { lines: number; chips: number };

  // ---- make the ephemeral text families APPEAR ----
  montrerCotesMurs(): number;
  montrerGuidesOuverture(id: unknown): number;
  montrerCurseurPair(x: number, y: number): number;
}

export function sondeExport(ctx: Contexte): SondeExport {
  return {
    buildMasterSVG: (opts?: OptionsSVGMaitre) => buildMasterSVG(ctx, opts),
    preparePrint: () => preparePrint(ctx),
    clearPrint,
    furnitureData: () => buildFurnitureData(ctx),
    furnitureListText: () => furnitureListText(ctx),
    openFurni: () => openFurni(ctx),
    importPlan: (text: unknown) => importPlan(ctx, text),

    setMeasureMode: (on: boolean) => setMeasureMode(ctx, on),
    // LIVE, therefore an accessor: `Object.assign` would have frozen it at install time.
    get measures(): MesureLue[] {
      return mesuresPosees().map((m) => ({ a: { x: m.a.x, y: m.a.y }, b: { x: m.b.x, y: m.b.y }, cm: measureDistCm(m.a, m.b) }));
    },
    measureClickApt: (ax: number, ay: number) => measureClickApt(ctx, ax, ay),

    drawCursorGuidesNow(ax: number, ay: number) {
      drawCursorGuides(ctx, ax, ay);
      const ov = document.getElementById("cursorGuides");
      return { lines: ov ? ov.querySelectorAll(".cgline").length : 0, chips: ov ? ov.querySelectorAll(".cgchip").length : 0 };
    },

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
      // The SAME node factory the wire uses (`fil/presence.ts` calls it too): the probe paints a
      // peer cursor without a second painting path to keep in step with the first one.
      const hote = document.getElementById("peerCursors");
      if (hote) {
        const el = creerNoeudCurseur("pair", "#c0392b");
        hote.appendChild(el);
        const s = aptToScreen(ctx, x, y);
        el.style.transform = `translate3d(${s.x.toFixed(1)}px,${s.y.toFixed(1)}px,0)`;
      }
      return document.querySelectorAll(".peer-cur .pc-name").length;
    },
  };
}
