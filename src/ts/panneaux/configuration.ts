// src/ts/panneaux/configuration.ts: THE CONFIGURATION WIZARD (the apartment's OUTLINE).
// Ported from src/js/29-configuration.js (SETUP OVERLAY block, lines 1 to 194) and the "floor"
// block of src/js/28-options.js (the floor selector lives INSIDE this modal: it drives
// `setup.floor`, so it belongs to the draft, not to personal settings).
//
// WHAT THIS SCREEN IS, AND WHAT IT IS NOT. It does not configure "a room": it sets the
// OUTLINE, once. The walls, and therefore the cells, follow from it. While it is open, NOTHING is
// written to `ctx.etat`: the `setup` draft is isolated, and only `applySetup()` commits it.
//
// G-17 / G-18. THE BOUNDS ARE WRITTEN INTO THE FIELDS, NOT HIDDEN BEHIND THEM. `numField`
// (`noyau/champ-numerique.ts`) holds the HTML attribute, the applied value and the rejection message
// in the same place; `setupSyncBounds()` recalls them as soon as a bound moves (the notch's bound
// depends on the current width). A claimed outline of 5 × 4000 used to produce a 100 × 3000
// apartment, and an "outline" 5 cm wide was accepted without a word.
//
// WHAT REMAINS UNPORTED, STATED PLAINLY:
//   · `wsMaybeReplace()` (the ATOMIC publication of the new plan to the household, right before
//     `save()`) belongs to the SYNCHRONIZATION batch. `ctx.crochets` today carries NO hook point of
//     this shape (`publierFil` is what `save()` triggers DOWNSTREAM, that is not the same thing:
//     an atomic op is needed BEFORE the save). No hook is invented here; the synchronization batch
//     will add its own and call it here.
//   · `maybeOpenSetupFromServer()` (under `SYNC_ON`, it is the SERVER that decides to open
//     the wizard, never an empty `localStorage`) belongs to the same batch. The local decision
//     (`!SYNC_ON`) is carried as-is, at the bottom of this file.
//   · `#setupNotice` (D-2, the unreadable local save) is filled in by js/46 from
//     `bootUnreadable`, which `main.ts` computes without exposing it. The banner therefore stays
//     hidden here.

import type { Contexte } from "../app/contexte.ts";
import type { Pt } from "../partage/plan.ts";
import { $ } from "../noyau/dom.ts";
import { clamp, fmtM2 } from "../noyau/nombres.ts";
import { numField, syncBounds } from "../noyau/champ-numerique.ts";
import { polyArea, selfIntersects } from "../geometrie/polygones.ts";
import { lShapePoly, rectPoly } from "../geometrie/polygones.ts";
import { aptBBox } from "../rendu/vue.ts";
import { render } from "../rendu/rendu.ts";
import { renderRoomChips } from "../rendu/puces-rail.ts";
import { pushHistory } from "../historique/pile.ts";
import { save } from "../app/persistance.ts";
import { v5AfterGeometry } from "../gestes/murs.ts";
import { activeFloor, setActiveFloor } from "./fiche-cellule-edition.ts";
import { SYNC_ON } from "../fil/drapeaux.ts";

/**
 * The draft, isolated from state until "Start furnishing" applies it.
 * `custom`: the current outline matches NO preset (corners adjusted by hand).
 * `pickedShape` / `dirtyDims`: what the person actually touched THIS time; nothing
 * touched -> the existing outline is kept intact on apply.
 */
interface Brouillon {
  shape: "rect" | "l";
  w: number;
  l: number;
  nw: number;
  nl: number;
  floor: string;
  custom: boolean;
  pickedShape: boolean;
  dirtyDims: boolean;
}

// cm: a dwelling, not a 5 cm corridor. These two bounds are WRITTEN into the fields' attributes
// by `numField` (G-18: the client bounds what's sensible, the server bounds what's dangerous).
const SETUP_MIN = 100, SETUP_MAX = 3000;

type CleDimension = "w" | "l" | "nw" | "nl";

/**
 * The wizard, named from another module. `fil/` opens it (an empty household, an invitation
 * landing on nothing) and closes it (the hello brought rooms); the functions live in the
 * wiring's closure, because they read the draft. This small registry is the only way to name
 * them without widening `ctx.crochets`, which describes what RENDERING calls.
 */
export const assistant: {
  ouvrir?: () => void;
  fermer?: () => void;
  estOuvert?: () => boolean;
} = {};

// THE CURRENT CELL'S FLOOR (js/03) HAS TWO CONSUMERS, AND ONE DEFINITION. The cell sheet
// and the wizard both call it: it lives in `fiche-cellule-edition.ts` and gets imported.
// Two copies would have diverged at the first fix, exactly like the three placement-preview
// copies that `makePlacePreview` replaced.

export function brancherConfiguration(ctx: Contexte): void {
  const modale = $("setup");
  if (!modale) return;
  const setupEl: HTMLElement = modale;

  const setup: Brouillon = {
    shape: "rect", w: 420, l: 360, nw: 168, nl: 144, floor: "parquet",
    custom: false, pickedShape: false, dirtyDims: false,
  };

  /** The polygon the draft describes, in LOCAL cm (origin 0,0). */
  const setupPoly = (): Pt[] =>
    setup.shape === "l" ? lShapePoly(setup.w, setup.l, setup.nw, setup.nl) : rectPoly(setup.w, setup.l);

  /**
   * The polygon the draft WOULD PRODUCE: the preset if a card has been picked (or if the
   * outline already is one), otherwise the hand-adjusted outline, scaled to the draft's W/L.
   */
  function draftPoly(): Pt[] {
    if (setup.pickedShape || !setup.custom) return setupPoly();
    const bb = aptBBox(ctx);
    const sx = setup.w / bb.w, sy = setup.l / bb.l;
    return ((ctx.etat.plan && ctx.etat.plan.outline) || []).map(
      ([x, y]) => [(x - bb.minX) * sx, (y - bb.minY) * sy] as Pt);
  }

  /** Equality of vertex SETS, to the centimeter, independent of order. */
  function samePolySet(A: readonly Pt[], B: readonly Pt[]): boolean {
    if (A.length !== B.length) return false;
    const key = (v: Pt): string => Math.round(v[0]) + "," + Math.round(v[1]);
    return A.map(key).sort().join(";") === B.map(key).sort().join(";");
  }

  /** The LIVE preview, to scale, plus the area written in the shared format (R-12, `fmtM2`). */
  function drawSetupPreview(): void {
    const svg = $("setupSvg");
    const poly = draftPoly();
    const w = setup.w, l = setup.l, pad = 6;
    const vw = 100, sc = Math.min((vw - 2 * pad) / w, (vw - 2 * pad) / l);
    const ox = (vw - w * sc) / 2, oy = (vw - l * sc) / 2;
    const pts = poly.map(([x, y]) => `${(ox + x * sc).toFixed(2)},${(oy + y * sc).toFixed(2)}`).join(" ");
    // subtle floor tint according to the finish; outline + light fill otherwise
    const tints: Record<string, string> = {
      parquet: "#e7d3b1", herringbone: "#e3cda8", tile: "#efeae0", plain: "var(--room-bg)",
    };
    const tint = tints[setup.floor] || "var(--room-bg)";
    const grid = 100 * sc;   // meter lines, subtle
    if (svg) {
      svg.setAttribute("viewBox", `0 0 ${vw} ${vw}`);
      svg.innerHTML =
        `<defs><clipPath id="suClip"><polygon points="${pts}"/></clipPath>
        <pattern id="suGrid" width="${grid}" height="${grid}" patternUnits="userSpaceOnUse">
          <path d="M ${grid} 0 L 0 0 0 ${grid}" fill="none" stroke="var(--grid-m)" stroke-width="0.5"/></pattern></defs>
      <polygon points="${pts}" fill="${tint}"/>
      <g clip-path="url(#suClip)"><rect x="${ox}" y="${oy}" width="${w * sc}" height="${l * sc}" fill="url(#suGrid)"/></g>
      <polygon points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.4" stroke-linejoin="round"/>`;
    }
    const area = $("setupArea");
    if (area) area.textContent = fmtM2(polyArea(poly));
    $("shapeWarn")?.classList.toggle("on", selfIntersects(poly));
  }

  function syncSetupShapeCards(): void {
    const keepCustom = setup.custom && !setup.pickedShape;   // adjusted outline kept: no card pressed
    const isL = setup.shape === "l";
    $("cardRect")?.setAttribute("aria-pressed", (!keepCustom && !isL) ? "true" : "false");
    $("cardL")?.setAttribute("aria-pressed", (!keepCustom && isL) ? "true" : "false");
    const notch = $("notchRow");
    if (notch) notch.hidden = keepCustom || !isL;
  }

  /** The modal's floor selector (js/28): it writes into the DRAFT, not into the plan. */
  function syncFloorButtons(): void {
    $("setupFloor")?.querySelectorAll<HTMLElement>(".floor-opt").forEach((b) => {
      b.classList.toggle("pri", b.dataset["floor"] === (setup.floor || activeFloor(ctx)));
    });
  }

  const setupBounds: Record<CleDimension, () => { min: number; max: number }> = {
    w: () => ({ min: SETUP_MIN, max: SETUP_MAX }),
    l: () => ({ min: SETUP_MIN, max: SETUP_MAX }),
    // The notch is CARVED into the rectangle: it cannot swallow it entirely.
    nw: () => ({ min: 10, max: Math.max(10, setup.w - 10) }),
    nl: () => ({ min: 10, max: Math.max(10, setup.l - 10) }),
  };

  function setupSyncBounds(): void {
    ["suW", "suL", "suNW", "suNL"].forEach((id) => syncBounds($(id)));
  }

  // The fields now carry the truth (`numField` rejects and restores the last valid value):
  // this read now just copies over, without silently clamping anything.
  function readSetupInputs(): void {
    const n = (id: string, b: { min: number; max: number }): number | null => {
      const el = $(id) as HTMLInputElement | null;
      const v = parseInt(el ? el.value : "", 10);
      return isFinite(v) ? clamp(v, b.min, b.max) : null;
    };
    const w = n("suW", setupBounds.w()); if (w != null) setup.w = w;
    const l = n("suL", setupBounds.l()); if (l != null) setup.l = l;
    if (setup.shape === "l") {
      const nw = n("suNW", setupBounds.nw()); if (nw != null) setup.nw = nw;
      const nl = n("suNL", setupBounds.nl()); if (nl != null) setup.nl = nl;
    }
    fillSetupInputs(); setupSyncBounds();
  }

  function fillSetupInputs(): void {
    const pose = (id: string, v: number): void => {
      const el = $(id) as HTMLInputElement | null;
      if (el) el.value = String(v);
    };
    pose("suW", setup.w); pose("suL", setup.l);
    pose("suNW", setup.nw); pose("suNL", setup.nl);
  }

  function pickShape(shape: "rect" | "l"): void {
    setup.shape = shape;
    setup.pickedShape = true;   // explicit choice of a preset: rebuilt on apply
    if (shape === "l" && !(setup.nw > 0 && setup.nw < setup.w && setup.nl > 0 && setup.nl < setup.l)) {
      setup.nw = clamp(Math.round(setup.w * 0.4), 10, setup.w - 10);
      setup.nl = clamp(Math.round(setup.l * 0.4), 10, setup.l - 10);
    }
    fillSetupInputs(); syncSetupShapeCards(); drawSetupPreview();
  }

  /** Opens the modal, seeding the draft from the current state. */
  function openSetup(): void {
    const bb = aptBBox(ctx);
    setup.w = Math.round(bb.w); setup.l = Math.round(bb.l);
    setup.floor = activeFloor(ctx);
    setup.pickedShape = false; setup.dirtyDims = false;
    // Does the outline match a preset EXACTLY? Everything else is a hand-adjusted outline,
    // and it is PRESERVED as long as no shape card is chosen.
    const p0: Pt[] = ((ctx.etat.plan && ctx.etat.plan.outline) || [])
      .map(([x, y]) => [x - bb.minX, y - bb.minY] as Pt);
    setup.custom = true; setup.shape = "rect";
    if (p0.length === 4 && samePolySet(p0, rectPoly(setup.w, setup.l))) {
      setup.shape = "rect"; setup.custom = false;
    } else if (p0.length === 6) {
      // recover the TRUE notch of a canonical L (notch top right)
      const xs = [...new Set(p0.map((v) => Math.round(v[0])))].sort((a, b) => a - b);
      const ys = [...new Set(p0.map((v) => Math.round(v[1])))].sort((a, b) => a - b);
      if (xs.length === 3 && ys.length === 3) {
        const nw = setup.w - (xs[1] as number), nl = ys[1] as number;
        if (samePolySet(p0, lShapePoly(setup.w, setup.l, nw, nl))) {
          setup.shape = "l"; setup.custom = false; setup.nw = nw; setup.nl = nl;
        }
      }
    }
    if (!(setup.nw > 0 && setup.nw < setup.w)) setup.nw = Math.round(setup.w * 0.4);
    if (!(setup.nl > 0 && setup.nl < setup.l)) setup.nl = Math.round(setup.l * 0.4);
    fillSetupInputs(); setupSyncBounds(); syncSetupShapeCards(); syncFloorButtons(); drawSetupPreview();
    setupEl.hidden = false;
    setTimeout(() => $("suW")?.focus(), 30);
  }

  function closeSetup(): void { setupEl.hidden = true; }

  /**
   * Commits the draft. The outline is touched ONLY if a shape card was chosen or a
   * dimension was edited; otherwise the hand-adjusted corners are kept as they are.
   */
  function applySetup(): void {
    pushHistory(ctx);
    setActiveFloor(ctx, setup.floor);
    if (setup.pickedShape || setup.dirtyDims) {
      if (ctx.etat.plan) {
        ctx.etat.plan.outline = draftPoly().map(([x, y]) => [Math.round(x), Math.round(y)] as Pt);
      }
      ctx.selVtx = -1;
    }
    ctx.etat.setupDone = true;
    // What the wizard draws IS the apartment's outline. The cells follow from it (just one
    // at the start); without this recalculation, a fresh first launch stayed on the previous shape.
    v5AfterGeometry(ctx, true);
    // NEW HOUSEHOLD: THIS PLAN MUST REACH THE SHARED PLAN, IN ONE ATOMIC OP, BEFORE `save()`.
    // This is `wsMaybeReplace()` from the old client (js/29 l. 149). Without this publication, two
    // people would each configure their apartment on their own and never share anything: the
    // server was empty, so the emission mirror was too, and nothing triggered the initial send.
    // ORDER MATTERS AND IT IS THE SAME AS BEFORE: the publication resyncs the mirror, so the
    // diff that `save()` triggers right after has nothing left to add, and the peer receives the
    // plan as one block, never half of it.
    ctx.crochets.publierPlanEntier?.();
    render(ctx); save(ctx); renderRoomChips(ctx);
  }

  // ---- the wiring ------------------------------------------------------------------------------
  // Shape choice
  $("cardRect")?.addEventListener("click", () => pickShape("rect"));
  $("cardL")?.addEventListener("click", () => pickShape("l"));

  // Dimensions -> the live preview. `numField` only calls `set` on a VALID value: as long
  // as the input is incomplete or rejected, neither the draft nor the preview moves, and the field
  // SAYS SO (G-17).
  const champs: Array<[string, CleDimension, string]> = [
    ["suW", "w", "The width"], ["suL", "l", "The length"],
    ["suNW", "nw", "The notch width"], ["suNL", "nl", "The notch depth"],
  ];
  champs.forEach(([id, key, label]) => {
    numField($(id), {
      label, unit: "cm",
      bounds: setupBounds[key], get: () => setup[key],
      set: (v: number) => { setup.dirtyDims = true; setup[key] = v; setupSyncBounds(); drawSetupPreview(); },
    });
    // "the person TOUCHED a dimension" is a fact independent of validation: without this
    // flag, `applySetup()` kept the previous outline (`numField` only applies after a typing
    // pause, and a programmatically set value does not wait).
    $(id)?.addEventListener("input", () => { setup.dirtyDims = true; });
  });

  // The floor: it drives the DRAFT (and the preview), it only writes into the plan on apply.
  $("setupFloor")?.querySelectorAll<HTMLElement>(".floor-opt").forEach((b) => {
    b.addEventListener("click", () => {
      setup.floor = String(b.dataset["floor"] || "parquet");
      syncFloorButtons(); drawSetupPreview();
    });
  });

  // Primary: apply shape + size + floor, mark done, close.
  $("setupStart")?.addEventListener("click", () => {
    readSetupInputs();
    applySetup();
    closeSetup();
  });
  // Secondary: apply and close after defining an atypical outline.
  $("setupFine")?.addEventListener("click", () => {
    readSetupInputs();
    applySetup();
    closeSetup();
  });
  // Escape only closes IF the wizard has already been completed once; a first launch
  // must start (or accept the default rectangle), never leave a screen with no outline.
  setupEl.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape") {
      e.stopPropagation();
      if (ctx.etat.setupDone) { closeSetup(); }
      else { readSetupInputs(); applySetup(); closeSetup(); }   // first launch: the draft is accepted
    }
  });

  // js/46 does this at boot: the floor buttons say the current floor before any opening.
  syncFloorButtons();

  // ---- AUTOMATIC OPENING (js/46-init.js) ----------------------------------------------------------
  //  - EMBEDDED / `file://` (`!SYNC_ON`): the wizard keeps a SINGLE person's HOUSEHOLD (this
  //    device IS the household), so a never-configured device opens it.
  //  - `SYNC_ON` (top-level http(s)): the wizard keeps the SHARED PLAN, not this device.
  //    A new device must NEVER open it on the sole grounds that `localStorage` is empty; the
  //    decision belongs to server reconciliation (`maybeOpenSetupFromServer`, `fil/rest.ts`),
  //    which calls `assistant.ouvrir` below. The flag now comes from `fil/drapeaux.ts`,
  //    a single definition for the whole client.
  if (!SYNC_ON && !ctx.etat.setupDone) openSetup();

  // `fil/` calls these two (an empty household or an invitation opens the wizard, a hello that
  // brought rooms closes it). `ctx.crochets` is NOT the right vehicle: it describes what
  // RENDERING calls, and the wizard is not called by rendering.
  assistant.ouvrir = openSetup;
  assistant.fermer = closeSetup;
  assistant.estOuvert = () => !setupEl.hidden;
}
