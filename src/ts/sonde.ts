// src/ts/sonde.ts: THE PROBE SURFACE, TYPED, and INERT outside `window.__PLAN_TEST__`.
// Replaces src/js/57-sondes-test.js (616 lines, 234 entries) for what the RENDER batch ported,
// and nothing else.
//
// Why it exists (docs/reecriture.md §4): 8% of the repo's checks consume 98% of the time, and
// those are the 23 browser suites. They do not describe a behavior, they reach a hand into the
// closure, 1,013 times. "The scenario survives, the probe does not." So we do not rewrite 286
// tests: we rebuild the surface, then rewire the scenarios.
//
// WHAT THE TYPING CLOSES OFF HERE, and this is not theoretical: `esbuild` measured TWO REAL
// DUPLICATE KEYS existed in the old hook. The last one won, so an accessor form was dead code
// and another probe had no taker. A typed object
// literal makes this impossible to compile.
//
// WHAT IS NOT EXPOSED, AND WHY: everything this batch did not port. Gestures (drag, placement,
// lasso, resize and wall gestures), persistence and history, sync and collaboration, PNG
// export / printing, the Circulation engine, the measuring tape. Each will come with its own
// batch, and its slice of the probe with it. A missing entry is an entry NOT YET PORTED, never
// an abandoned entry.

import type { Contexte } from "./app/contexte.ts";
import type { BBox } from "./geometrie/polygones.ts";
import type { Meuble, Ouverture, PlanV5 } from "./partage/plan.ts";
import { pieceById, v5OpeningById, v5Touch, v5WallById } from "./app/contexte.ts";
import { TYPEMAP, isWallMount, pieceVisible } from "./catalogue/catalogue.ts";
import { bboxOfPoly, poleOfInaccessibility } from "./geometrie/polygones.ts";
import { v5OpeningBox } from "./modele/murs.ts";
import { v5SignedArea } from "./modele/aires.ts";
import { WALL, fmtM2 } from "./noyau/nombres.ts";
import { cssId, setLabelSpin } from "./noyau/dom.ts";
import { stackedAt } from "./rendu/meubles.ts";
import { isChosenName } from "./rendu/noms.ts";
import { clearSel, isSel, selAdd, selReplace } from "./rendu/selection.ts";
import { aptBBox, aptToScreen, fitView, renderView, screenToApt, zoomAt } from "./rendu/vue.ts";
import { render } from "./rendu/rendu.ts";
import { drawHandles as dessinerPoignees, renderV5 } from "./rendu/calque.ts";
import { doorArcSVG } from "./rendu/arc-porte.ts";
import { pieceIconSVG } from "./rendu/icones.ts";
import type { SondeGestes } from "./sonde-gestes.ts";
import { sondeGestes } from "./sonde-gestes.ts";
import type { SondePanneaux } from "./sonde-panneaux.ts";
import { sondePanneaux } from "./sonde-panneaux.ts";
import type { SondeExport } from "./sonde-export.ts";
import { sondeExport } from "./sonde-export.ts";
import type { SondeFlow } from "./sonde-flow.ts";
import { sondeFlow } from "./sonde-flow.ts";
import type { SondeDonnees } from "./sonde-donnees.ts";
import { sondeDonnees } from "./sonde-donnees.ts";
import { lassoVivant } from "./gestes/vue-interactions.ts";
import type { Fil } from "./fil/etat.ts";
import type { SondeFil } from "./sonde-fil.ts";
import { sondeFil } from "./sonde-fil.ts";

/** The reading of what the layer painted. `layer:0` = no layer at all. */
export interface StatsCalque {
  layer: number;
  floors?: number; bands?: number; outlineBands?: number;
  pieces?: number; openings?: number; labels?: number;
  left?: string; top?: string; width?: string;
}

export interface TexteDuPlan {
  sel: string;
  txt: string;
  /** real SCREEN angle, the product of every ancestor's `transform` */
  ang: number;
  envers: boolean;
}

export interface SelDump {
  modele: string[];
  ecran: string[];
  /** G-11: is a lasso IN PROGRESS? (the live marking only makes sense during the gesture) */
  bandeVive: boolean;
  familles: string[];
  famillesEcran: string[];
  manquants: string[];
  enTrop: string[];
}

export interface Transformee {
  scale: number;
  ox: number;
  oy: number;
}

export interface SondePlan {
  readonly state: Contexte["etat"];
  readonly plan: PlanV5;
  readonly ctx: Contexte;
  TYPEMAP: typeof TYPEMAP;
  WALL: number;

  // ---- rendering ----
  render(): void;
  /** The layer ALONE, without the rest of the render (rail, card, empty-plan message). */
  renderV5(): void;
  /**
   * LES POIGNEES SEULES, sur le calque deja monte. Elles sont refaites a CHAQUE image (elles
   * portent des fermetures, elles ne se reconcilient pas), donc leur cout se mesure a part du
   * reste du rendu: c'est le seul moyen de dire si un `walls.find` par arete pese ou non.
   * Sans calque monte, ne fait rien (lue par `tests/rendu-perf.ts`).
   */
  drawHandles(): void;
  /** What the layer ACTUALLY painted: the only measure that distinguishes a plan from a drawing. */
  v5RenderStats(): StatsCalque;
  fitView(): void;
  zoomAt(x: number, y: number, f: number): void;
  setZoom(s: number): Transformee;
  viewTransform(): Transformee;
  aptBBox(): BBox;
  bboxOfPoly: typeof bboxOfPoly;
  aptToScreen(x: number, y: number): { x: number; y: number };
  viewCenterApt(): { x: number; y: number };

  // ---- reading the model ----
  pieceById(id: unknown): Meuble | null;
  v5OpeningById(id: unknown): Ouverture | null;
  v5WallById(id: unknown): ReturnType<typeof v5WallById>;
  /**
   * HISTORICAL SIGNATURE, AND IT MUST BE KEPT: the old hook exposed the RAW function
   * `v5OpeningBox(P, op)`, and the suites call it with the plan as the first argument
   * (`textes-lisibles.ts`, `model-v5-conversion-rendu.ts`). A single-argument signature
   * silently returned `null`, and the `appliques_dos_a_dos` case threw on `box.rot`.
   */
  v5OpeningBox(P: PlanV5 | null | undefined, op: Ouverture): ReturnType<typeof v5OpeningBox>;
  v5SignedArea: typeof v5SignedArea;
  poleOfInaccessibility: typeof poleOfInaccessibility;
  fmtM2: typeof fmtM2;
  cssId: typeof cssId;

  // ---- selection ----
  selReplace(id: unknown): void;
  selAdd(id: unknown): void;
  clearSel(): void;
  isSel(id: unknown): boolean;
  readonly selCount: number;
  readonly selId: string | null;
  selDump(): SelDump;

  // ---- what gets PAINTED ----
  setLabelSpin: typeof setLabelSpin;
  isChosenName: typeof isChosenName;
  pieceVisible(p: { type: string }): boolean;
  isWallMount: typeof isWallMount;
  doorArcSVG: typeof doorArcSVG;
  pieceIconSVG: typeof pieceIconSVG;
  stackedAt: typeof stackedAt;
  rszHandleCount(pieceId: unknown): number;
  handleCount(): {
    edge: number; vtx: number; mid: number; move: number; bout: number;
    del: number; split: number; square: number;
  };
  textesDuPlan(): TexteDuPlan[];

  v5Touch(): void;
}

/**
 * Installs the hook. INERT if `window.__PLAN_TEST__` was not set BEFORE loading:
 * in production the flag is never set, and `window.__plan` does not exist.
 */
export function installerSonde(ctx: Contexte, fil: Fil): void {
  const w = window as unknown as { __PLAN_TEST__?: unknown; __plan?: SondePlan & SondeGestes };
  if (!w.__PLAN_TEST__) return;
  const sonde: SondePlan = {
    get state() { return ctx.etat; },
    get plan() { return ctx.etat.plan; },
    get ctx() { return ctx; },
    TYPEMAP,
    WALL,

    render: () => render(ctx),
    renderV5: () => renderV5(ctx),
    drawHandles(): void {
      const l = ctx.canvas.querySelector<HTMLElement>(".v5layer");
      const P = ctx.etat.plan;
      if (!l || !P || !Array.isArray(P.outline) || P.outline.length < 3) return;
      dessinerPoignees(ctx, l, bboxOfPoly(P.outline), ctx.vue.scale);
    },
    // COUNTS WHAT IS PAINTED, never what the model claims. A duplicated wall band, a floor
    // that was not cut out, an opening that does not come out: none of that shows in the plan,
    // and all of it shows here. The selectors are the old hook's, to the letter, otherwise
    // the two clients would not be measured the same way.
    v5RenderStats(): StatsCalque {
      const l = ctx.canvas.querySelector<HTMLElement>(".v5layer");
      if (!l) return { layer: 0 };
      // COUNTED ON THE LAYER, NOT ON ONE SVG. The background is drawn in TWO svg elements now, the
      // floors below the floor coverings and the wall bands above them, so a probe that looked
      // inside "the" svg would report zero bands and be believed.
      return {
        layer: 1,
        floors: l.querySelectorAll("clipPath").length,
        bands: l.querySelectorAll("line.v5band").length,
        outlineBands: l.querySelectorAll("polygon[stroke='#3b3f3d']").length,
        pieces: l.querySelectorAll(".piece").length,
        openings: l.querySelectorAll(".piece.opening").length,
        labels: l.querySelectorAll(".ov-name").length,
        left: l.style.left, top: l.style.top, width: l.style.width,
      };
    },
    fitView: () => fitView(ctx),
    zoomAt: (x: number, y: number, f: number) => zoomAt(ctx, x, y, f),
    setZoom(s: number) { ctx.vue.scale = s; renderView(ctx); return this.viewTransform(); },
    // HISTORICAL SIGNATURE, ROUNDING INCLUDED, AND IT TOOK A SUITE TO SEE IT. The old hook
    // returned `{scale:+vScale.toFixed(6), ox:Math.round(vOx), oy:Math.round(vOy)}`; this port
    // had returned the RAW values, while `panBy` (GESTES batch) kept the rounding. The suites
    // compare the two against each other to prove that a view has NOT moved: `0.548598` against
    // `0.5485981308411215` made `repli-d1-live` ("a LATER adoption does not snap away the view
    // of someone working") fail on a view that was rigorously still. A false positive on D-12,
    // and the only place in the repo that could catch it.
    viewTransform: () => ({
      scale: +ctx.vue.scale.toFixed(6),
      ox: Math.round(ctx.vue.ox),
      oy: Math.round(ctx.vue.oy),
    }),
    aptBBox: () => aptBBox(ctx),
    bboxOfPoly,
    aptToScreen: (x: number, y: number) => aptToScreen(ctx, x, y),
    viewCenterApt: () => {
      const r = ctx.viewport.getBoundingClientRect();
      return screenToApt(ctx, r.width / 2, r.height / 2);
    },

    pieceById: (id: unknown) => pieceById(ctx, id),
    v5OpeningById: (id: unknown) => v5OpeningById(ctx, id),
    v5WallById: (id: unknown) => v5WallById(ctx, id),
    v5OpeningBox: (P: PlanV5 | null | undefined, op: Ouverture) =>
      v5OpeningBox(P || ctx.etat.plan, op, (TYPEMAP[op.type] || { h: WALL }).h || WALL),
    v5SignedArea,
    poleOfInaccessibility,
    fmtM2,
    cssId,

    selReplace: (id: unknown) => selReplace(ctx, id),
    selAdd: (id: unknown) => selAdd(ctx, id),
    clearSel: () => clearSel(ctx),
    isSel: (id: unknown) => isSel(ctx, id),
    get selCount() { return ctx.selection.ids.size; },
    get selId() { return ctx.selection.primaire; },
    // THE MODEL AND THE SCREEN, SIDE BY SIDE: the only way to distinguish "not selected" from
    // "selected but invisible". The two lists must be IDENTICAL, always (G-11).
    selDump(): SelDump {
      const modele = [...ctx.selection.ids].map(String).sort();
      const ecran = [...ctx.canvas.querySelectorAll<HTMLElement>(".piece.sel")]
        .map((e) => String(e.dataset["id"])).sort();
      const fam = (id: string): string => pieceById(ctx, id) ? "meuble" : (v5OpeningById(ctx, id) ? "ouverture" : "?");
      return {
        modele, ecran,
        bandeVive: lassoVivant(),
        familles: modele.map(fam),
        famillesEcran: ecran.map(fam),
        manquants: modele.filter((id) => ecran.indexOf(id) < 0),
        enTrop: ecran.filter((id) => modele.indexOf(id) < 0),
      };
    },

    setLabelSpin,
    isChosenName,
    pieceVisible: (p: { type: string }) => pieceVisible(p, ctx.etat.opts),
    isWallMount,
    doorArcSVG,
    pieceIconSVG,
    stackedAt,
    rszHandleCount(pieceId: unknown): number {
      const n = ctx.canvas.querySelector<HTMLElement>(`.piece[data-id="${cssId(pieceId)}"]`);
      if (!n) return 0;
      let k = 0;
      n.querySelectorAll<HTMLElement>(".rsz-handle").forEach((h) => { if (h.style.display !== "none") k++; });
      return k;
    },
    handleCount() {
      const l = ctx.canvas.querySelector(".v5layer");
      if (!l) return { edge: 0, vtx: 0, mid: 0, move: 0, bout: 0, del: 0, split: 0, square: 0 };
      return {
        edge: l.querySelectorAll(".edge").length,
        vtx: l.querySelectorAll(".vtx").length,
        mid: l.querySelectorAll(".mid").length,
        move: l.querySelectorAll(".v5wmove").length,
        bout: l.querySelectorAll(".v5wend").length,
        del: l.querySelectorAll(".v5wx").length,
        split: l.querySelectorAll(".v5wmid").length,
        square: l.querySelectorAll(".v5wdroit").length,
      };
    },
    // R-1. All the PLAN's texts with their REAL SCREEN angle (the product of every ancestor's
    // `transform`). This is the only measure that counts: a rotated parent is enough to flip a
    // child that is otherwise "straight". The ephemeral families (wall dimensions, guides, peer
    // cursors) are not ported yet: their selectors stay in the list, they simply render nothing.
    textesDuPlan(): TexteDuPlan[] {
      const SEL = [".plabel", ".pdim", ".ov-name", ".glab", ".v5dim", ".mchip", ".cgchip", ".pc-name"];
      const ang = (n: Element): number => {
        let m = new DOMMatrix();
        let cur: Element | null = n;
        while (cur && cur !== document.body) {
          const t = getComputedStyle(cur).transform;
          if (t && t !== "none") m = new DOMMatrix(t).multiply(m);
          cur = cur.parentElement;
        }
        const a = Math.atan2(m.b, m.a) * 180 / Math.PI;
        return Math.round((((a % 360) + 540) % 360 - 180) * 10) / 10;
      };
      const out: TexteDuPlan[] = [];
      SEL.forEach((s) => document.querySelectorAll(s).forEach((n) => {
        const r = n.getBoundingClientRect();
        if (!r.width && !r.height) return;
        const a = ang(n);
        out.push({ sel: s, txt: String(n.textContent || "").slice(0, 24), ang: a, envers: Math.abs(a) > 90 });
      }));
      return out;
    },
    v5Touch: () => v5Touch(ctx),
  };
  // The GESTES batch brings ITS slice of the hook, in its own file: `js/57-sondes-test.js`
  // was "the repo's most likely git conflict point", and two keys were genuinely duplicated
  // in it. A typed object per batch closes both problems at once.
  // `Object.assign` COPIES an accessor's VALUE, it does not carry the accessor itself:
  // `gestureActive`, `toastText`, `vScale`, `poseArme` would have become SNAPSHOTS taken at
  // install time, and every suite would have read the same value for its whole life (measured:
  // `after.s > before.s` false even though the zoom had genuinely changed). So the DESCRIPTORS
  // are carried instead.
  Object.defineProperties(sonde, Object.getOwnPropertyDescriptors(sondeGestes(ctx)));
  // Batch E3c: one probe slice per sub-batch, carried by DESCRIPTOR for the same reason.
  Object.defineProperties(sonde, Object.getOwnPropertyDescriptors(sondePanneaux(ctx)));
  Object.defineProperties(sonde, Object.getOwnPropertyDescriptors(sondeExport(ctx)));
  Object.defineProperties(sonde, Object.getOwnPropertyDescriptors(sondeFlow(ctx)));
  Object.defineProperties(sonde, Object.getOwnPropertyDescriptors(sondeDonnees(ctx)));
  // Batch E4. This slice is almost ENTIRELY made of accessors (`wsFp`, `serverRev`,
  // `acksOn`, `retransmits`, `syncDetached`): carrying by DESCRIPTOR is not an elegance,
  // it is the condition for them to read the CURRENT value and not an install-time snapshot.
  Object.defineProperties(sonde, Object.getOwnPropertyDescriptors(sondeFil(ctx, fil)));
  w.__plan = sonde as SondePlan & SondeGestes & SondePanneaux
    & SondeExport & SondeFlow & SondeDonnees & SondeFil;

  // ---- THE TWO GHOST EMITTERS, ON `window`, AND ONLY UNDER THE TEST FLAG --------
  // In the old client, `window.__wsEmitDrag` / `__wsEmitDragMulti` were REAL production hooks:
  // `js/17` and `js/18` (drag, resize) called a global set up by `js/44` so as not to depend
  // on the wire. Here that decoupling goes through `ctx.crochets.emitDrag`, which is better:
  // nothing lingers on `window` in production. The MODEL suites, though, still call the HOT
  // path by its historical name (`v5_hot_paths_never_ask_which_room` proves that a drag ghost
  // does not query any "room"). So both names are given back, inert outside `__PLAN_TEST__`
  // like the rest of this file, and wired to the SAME hooks as the real drag: it is the
  // production code that gets measured, not a stand-in.
  const wd = w as unknown as { __wsEmitDrag?: unknown; __wsEmitDragMulti?: unknown };
  wd.__wsEmitDrag = (p: unknown) => ctx.crochets.emitDrag?.(p);
  wd.__wsEmitDragMulti = (moved: unknown[]) => ctx.crochets.emitDragMulti?.(moved);
}
