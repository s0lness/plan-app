// src/ts/panneaux/inspecteur.ts: THE INSPECTOR (editable object sheet).
// Ported from src/js/21-inspecteur.js.
//
// THE PANEL DECIDES NOTHING, IT SHOWS AND IT APPLIES. Only three rules live here, and they live
// here because they exist only for the screen:
//
//   G-17 / G-18. INPUT BOUNDS HAVE ONE SINGLE TRUTH, `dimBounds`, and the field's HTML `min`/`max`
//   attributes are REWRITTEN with it (`__syncBounds`, called back on every `syncInspector`): the
//   field can no longer announce a bound the code doesn't respect. Before: `min="10"` on the
//   front end, `clamp(…,5,3000)` in the code, `1..3000` on the server. The guard itself
//   (`numField`) is UNIQUE and shared with the assistant: it is not restated here.
//
//   The UPPER bound follows the object: a piece of furniture cannot be longer than the home that
//   holds it (a 3,000 cm bed "fit" in a 12 m apartment and ended up outside every cell); an
//   OPENING is parametric on ITS wall, its width is bounded by the length of that wall and its
//   DEPTH by its THICKNESS (G-16, `v5OpeningDepthMax`).
//
//   HISTORY COALESCES BY FOCUS SESSION: ONE entry on the first change after gaining focus, not
//   one per keystroke.
//
// WHAT IS NOT HERE, AND IT'S DELIBERATE: `cur`, `delSel`, `flipWallMountSide` and
// `dupliquerSelection` are actions on the SELECTION (the keyboard calls them too), they live in
// `gestes/selection-actions.ts`. Renaming is not here either (decision 0013): it happens on a
// double-click on the object's own label (`panneaux/renommer-en-ligne.ts`), never through a field
// of this panel.

import type { Contexte } from "../app/contexte.ts";
import type { Meuble, Ouverture } from "../partage/plan.ts";
import { v5OpeningById, v5Touch, v5WallById } from "../app/contexte.ts";
import { TYPEMAP, isSideable, isWallMount } from "../catalogue/catalogue.ts";
import { WALL, clamp, v5R2, escapeHtml } from "../noyau/nombres.ts";
import { $ } from "../noyau/dom.ts";
import { numField, syncBounds } from "../noyau/champ-numerique.ts";
import type { Bornes } from "../noyau/champ-numerique.ts";
import { v5OpeningDepthMax, v5Seg } from "../modele/murs.ts";
import { v5ResolveOpening } from "../modele/edition.ts";
import { projection, verdictProjection } from "../modele/projection.ts";
import { LM_MAX, LM_MIN } from "../partage/contrat-serveur.ts";
import { estLumiere, fluxDe } from "../circulation/lumiere.ts";
import type { ObjetFlow } from "../circulation/etat.ts";
import { openingWallInfo, rotatePieceWithChairs } from "../gestes/guides.ts";
import { oublierAvantAimant } from "../modele/aimant-memoire.ts";
import { cur, delSel, dupliquerSelection, flipWallMountSide } from "../gestes/selection-actions.ts";
import { aptBBox } from "../rendu/vue.ts";
import { render } from "../rendu/rendu.ts";
import { pushHistory } from "../historique/pile.ts";
import { save } from "../app/persistance.ts";

// ---- INPUT BOUNDS: one single truth --------------------------------------------------------
/** cm; the server accepts 1, but a 1 cm piece of furniture doesn't exist. */
const DIM_MIN = 10;
/** cm; live-worker/ops.ts, PIECE_WH_MAX. */
const DIM_MAX = 3000;

/**
 * The two families have the same field NAMES (`w`, `h`, `name`) but not the same shape: an
 * opening has neither `x`, nor `y`, nor `rot`, nor `locked`. So the primary object is read through
 * this permissive view, and each write states which family it belongs to.
 */
type ObjetInspecte = {
  id: string | number;
  type: string;
  name: string;
  w: number;
  h: number;
  rot?: number | undefined;
  locked?: boolean | undefined;
  x?: number | undefined;
  y?: number | undefined;
  wallId?: string | number | undefined;
  t0?: number | undefined;
  side?: 0 | 1 | undefined;
  hinge?: 0 | 1 | undefined;
  swing?: 1 | -1 | undefined;
};

const vue = (p: Meuble | Ouverture | undefined): ObjetInspecte | undefined =>
  p as unknown as ObjetInspecte | undefined;

/** The longest side of the outline, upper bound for a piece of furniture (never more than the server bound). */
function aptLongestSide(ctx: Contexte): number {
  const b = aptBBox(ctx);
  const m = Math.round(Math.max(Number(b.w) || 0, Number(b.l) || 0));
  return (isFinite(m) && m >= DIM_MIN) ? Math.min(m, DIM_MAX) : DIM_MAX;
}

/**
 * Bounds of field `which` ("w"|"h") for object `p`. An OPENING is parametric on its wall: its
 * width is bounded by the length of that wall (and by OPENING_W_MAX=600), its DEPTH by the
 * THICKNESS OF THAT WALL. The server bounds remain the absolute ceiling: beyond them, the server
 * REJECTS the op, and a rejected op is lost forever.
 *
 * WHY THE WALL AND NOT 200. `h` is the thickness of the object WITHIN the wall, and the box is
 * centered on the wall's MIDLINE: an opening repaints the floor background over it, so an `h`
 * bigger than the wall digs a white hole that spills over on BOTH sides, through both rooms
 * (measured: 200 cm on a 10 cm wall, 455 px of white across the plan). The rule itself lives in
 * ONE single place, `v5OpeningDepthMax`, shared with placement, snapping and wall changes.
 */
function dimBounds(ctx: Contexte, p: Meuble | Ouverture | undefined, which: string): Bornes {
  if (!p) return { min: DIM_MIN, max: DIM_MAX };
  const o = vue(p)!;
  if (v5OpeningById(ctx, o.id)) {
    if (which === "w") {
      const w = v5WallById(ctx, o.wallId), L = w ? Math.round(v5Seg(w).L) : 0;
      return { min: 5, max: Math.max(5, Math.min(600, L || 600)) };
    }
    return { min: 1, max: v5OpeningDepthMax(v5WallById(ctx, o.wallId)) };
  }
  return { min: DIM_MIN, max: Math.max(DIM_MIN, aptLongestSide(ctx)) };
}

/** "From the corner": from 0 to the remaining wall available once the opening is placed. */
function wallPosBounds(ctx: Contexte): Bornes {
  const p = cur(ctx); if (!p) return { min: 0, max: 0 };
  const info = openingWallInfo(ctx.etat.plan, p as Ouverture); if (!info) return { min: 0, max: 0 };
  return { min: 0, max: Math.max(0, Math.round(info.segLen - 2 * info.halfW)) };
}

export function openInspector(ctx: Contexte): void {
  syncInspector(ctx);
  const insp = $("inspector"); if (insp) insp.hidden = !cur(ctx);
}

export function hideInspector(): void {
  const insp = $("inspector"); if (insp) insp.hidden = true;
}

function syncInspector(ctx: Contexte): void {
  const insp = $("inspector"); if (!insp) return;
  const p = vue(cur(ctx));
  if (!p) { insp.hidden = true; return; }
  // Multi-selection: the inspector shows the PRIMARY object, and says how many are selected.
  const iMulti = $("iMulti");
  if (iMulti) {
    if (ctx.selection.ids.size > 1) { iMulti.hidden = false; iMulti.textContent = ctx.selection.ids.size + " selected"; }
    else iMulti.hidden = true;
  }
  const t = TYPEMAP[p.type];
  const sw = $("iSw"); if (sw) sw.style.background = (t && t.color) || "var(--seat)";
  // The min/max attributes follow the selected object: the field no longer announces a bound
  // different from the one the code applies.
  const iW = $("iW") as HTMLInputElement | null;
  const iH = $("iH") as HTMLInputElement | null;
  const iWallPos = $("iWallPos") as HTMLInputElement | null;
  syncBounds(iW); syncBounds(iH); syncBounds(iWallPos);
  if (iW && document.activeElement !== iW) iW.value = String(p.w);
  if (iH && document.activeElement !== iH) iH.value = String(p.h);
  // Objects driven by the wall (openings + sconce/outlet): no manual rotation.
  // Locked objects: no editing at all anymore.
  const op = isWallMount(p.type), lk = !!p.locked;
  if (iW) { iW.disabled = lk; iW.closest(".in")?.classList.toggle("disabled", lk); }
  if (iH) { iH.disabled = lk; iH.closest(".in")?.classList.toggle("disabled", lk); }
  // AN OPENING HAS NO ANGLE OF ITS OWN: it belongs to its wall. Decision 0013 removed the angle
  // slider entirely: the rotation handle on the selection, and Rotate 90°, are the one path left
  // for a piece of furniture, and this row now carries buttons only, on every kind of object.
  // "Rotate 90°" is for FURNITURE. On a door it used to read "Flip the leaf" and toggle the hinge,
  // which is exactly what "Hinge side" next to it does (and does properly: persisted, sent to the
  // peers). Two buttons for one action, with different labels, is one button too many. Sconce /
  // outlet / RJ45 never rotated either: "Flip side" is their only real command.
  const rot90 = $("iRot90") as HTMLButtonElement | null;
  if (rot90) {
    rot90.textContent = "Rotate 90°";
    rot90.title = "Rotate 90°";
    rot90.disabled = op || lk;
    rot90.classList.toggle("disabled", op || lk);
    rot90.style.opacity = (op || lk) ? ".45" : "";
    rot90.hidden = op;
  }
  // Opening direction (inward/outward): only for a hinged door (not sdoor).
  const swg = $("iSwing") as HTMLButtonElement | null;
  if (swg) {
    swg.hidden = p.type !== "door";
    swg.disabled = lk;
    swg.classList.toggle("disabled", lk);
    swg.style.opacity = lk ? ".45" : "";
  }
  // PROJECTOR: the spec-sheet numbers, and the DEDUCED distance below.
  const projRow = $("iProjRow");
  if (projRow) {
    const estProj = p.type === "projector";
    projRow.hidden = !estProj;
    if (estProj) {
      const pj = p as unknown as { tr?: number; dmin?: number; pair?: string };
      const tr = $("iTr") as HTMLInputElement | null;
      const dm = $("iDmin") as HTMLInputElement | null;
      // The ratio is TYPED as 1.50 and STORED as 150: an integer can't drift on a rounding in the
      // content hash, but nobody writes "150" on a spec sheet.
      if (tr && document.activeElement !== tr) tr.value = pj.tr ? String(pj.tr / 100) : "";
      if (dm && document.activeElement !== dm) dm.value = pj.dmin ? String(pj.dmin) : "";
      const sel = $("iPair") as HTMLSelectElement | null;
      if (sel && document.activeElement !== sel) {
        const ecrans = (ctx.etat.plan.pieces || []).filter((q) => q.type === "pscreen");
        sel.innerHTML = `<option value="">(none)</option>`
          + ecrans.map((q) => `<option value="${escapeHtml(String(q.id))}">${escapeHtml(q.name)}</option>`).join("");
        sel.value = pj.pair || "";
        sel.disabled = !ecrans.length;
      }
      const out = $("iProjOut");
      if (out) {
        if (!pj.tr) out.textContent = "Enter the throw ratio to see the beam.";
        else {
          const ec = pj.pair ? (ctx.etat.plan.pieces || []).find((q) => String(q.id) === String(pj.pair)) : null;
          const pr = projection(p as never, ec || null);
          const v = verdictProjection(pr);
          out.textContent = `${Math.round(pr.distance)}cm → ${Math.round(pr.largeur)}cm image`
            + (pr.versEcran ? "" : " (no screen aimed at)") + (v ? ` · ${v}` : "");
          out.classList.toggle("bad", !!v);
        }
      }
    }
  }
  // LIGHT FIXTURE: the flux on its box, and what it means when the field is left empty.
  const lightRow = $("iLightRow");
  if (lightRow) {
    const estLum = estLumiere(p.type);
    lightRow.hidden = !estLum;
    if (estLum) {
      const lm = $("iLm") as HTMLInputElement | null;
      const val = (p as unknown as { lm?: number }).lm;
      if (lm && document.activeElement !== lm) lm.value = val === undefined ? "" : String(val);
      const out = $("iLightOut");
      if (out) {
        const effectif = Math.round(fluxDe(p as unknown as ObjetFlow));
        out.textContent = val === undefined
          ? "Default for this fixture: " + effectif + " lm."
          : effectif + " lm on the lighting map.";
      }
    }
  }
  // HOW THE WINDOW OPENS. The row only exists on a window: a door already has its direction and
  // its hinge, a wall-mounted object has no leaf at all.
  const leafRow = $("iLeafRow");
  if (leafRow) {
    const estFenetre = p.type === "window";
    leafRow.hidden = !estFenetre;
    if (estFenetre) {
      const n = Number((p as { leaf?: number }).leaf || 0) | 0;
      for (const k of [0, 1, 2]) {
        const b = $("iLeaf" + k) as HTMLButtonElement | null;
        if (!b) continue;
        b.setAttribute("aria-pressed", String(k === n));
        b.disabled = lk;
        b.style.opacity = lk ? ".45" : "";
      }
    }
  }
  // HINGE AND DIRECTION OF A CASEMENT WINDOW. A window that opens has exactly the same two
  // degrees of freedom as a door: which side it's hinged on, and which way it opens. So both
  // buttons appear as soon as `leaf` is 1 (a double window opens down the middle: its hinge has
  // no side, only a direction).
  {
    const leafN = p.type === "window" ? (Number((p as { leaf?: number }).leaf || 0) | 0) : 0;
    const hg = $("iHinge") as HTMLButtonElement | null;
    if (hg) {
      // A sliding door has the same single degree of freedom, called by its own name: the side
      // it slides towards. Same field (`hinge`), same button, honest label.
      hg.hidden = !(p.type === "door" || p.type === "sdoor" || leafN === 1);
      hg.textContent = p.type === "sdoor" ? "Slide direction" : "Hinge side";
      hg.title = p.type === "sdoor" ? "Slides to the left or to the right" : "Hinge on the left or on the right";
      hg.disabled = lk;
      hg.style.opacity = lk ? ".45" : "";
    }
    if (swg) swg.hidden = !(p.type === "door" || leafN === 1 || leafN === 2);
  }
  // "Change side": sconce / outlet / RJ45 only (doors and windows have hinge+direction).
  const sd = $("iSide") as HTMLButtonElement | null;
  if (sd) {
    sd.hidden = !isSideable(p.type);
    sd.disabled = lk;
    sd.classList.toggle("disabled", lk);
    sd.style.opacity = lk ? ".45" : "";
  }
  // An OPENING is not a piece of furniture: it lives in `openings[]`, parametric on ITS wall.
  // "Duplicate" can only read `pieces[]`: on a window it used to push a history entry and do
  // nothing, with no feedback whatsoever. It is HIDDEN rather than reinvented. "Bring to front" is
  // GONE entirely (decision 0013): paint order is already automatic, largest to smallest (G-9).
  const isOpening = !!v5OpeningById(ctx, p.id);
  const iDup = $("iDup"), iLock = $("iLock");
  if (iDup) iDup.hidden = isOpening;
  if (iLock) { iLock.textContent = lk ? "Unlock" : "Lock"; iLock.classList.toggle("pri", lk); }
  // "From the corner": distance from the wall's starting corner (A) to the nearest edge.
  const wallRow = $("iWallRow");
  if (!wallRow) return;
  if (op) {
    wallRow.hidden = false;
    const info = openingWallInfo(ctx.etat.plan, p as unknown as Ouverture);
    if (info && iWallPos && document.activeElement !== iWallPos) {
      iWallPos.value = String(Math.round(info.t - info.halfW));
    }
    if (iWallPos) { iWallPos.disabled = lk; iWallPos.closest(".in")?.classList.toggle("disabled", lk); }
  } else {
    wallRow.hidden = true;
  }
}

// ---- HISTORY COALESCING BY FOCUS SESSION -------------------------------------------
// ONE history entry on the first change after gaining focus, not one per keystroke.
let inspEdited = false;

/**
 * `val` arrives ALREADY validated and bounded by `numField`: nothing enters here mid-keystroke
 * anymore, neither empty, nor negative, nor out of bounds. The clamp that follows now only serves
 * as a last frontier for programmatic calls (test probe, keyboard shortcut).
 */
export function setDim(ctx: Contexte, which: string, val: unknown): void {
  const p = vue(cur(ctx));
  if (!p || p.locked) return;
  if (!inspEdited) { inspEdited = true; pushHistory(ctx); }
  // An OPENING is PARAMETRIC on its wall: it has neither x nor y. The recentering below
  // (p.x+p.w/2) used to write NaN into the plan there, hence into the op. Its width is bounded by
  // the length of the supporting wall, its depth by the THICKNESS of that wall: ONE single truth,
  // `dimBounds`, the same one shown in the field's `min`/`max` attributes.
  const b0 = dimBounds(ctx, p as unknown as Ouverture, which);
  if (v5OpeningById(ctx, p.id)) {
    if (which === "w") {
      p.w = clamp(parseInt(String(val), 10) || b0.min, b0.min, b0.max);
      v5ResolveOpening(ctx.etat.plan, p as unknown as Ouverture, 0, ctx.etat.opts);
    } else {
      p.h = clamp(parseInt(String(val), 10) || b0.min, b0.min, b0.max);
    }
    v5Touch(ctx); render(ctx); syncInspector(ctx); return;
  }
  const b = dimBounds(ctx, p as unknown as Meuble, which);
  const n = parseInt(String(val), 10);
  if (!isFinite(n)) return;                       // nothing readable: do NOT touch the plan
  const v = clamp(n, b.min, b.max);
  const cx = (p.x || 0) + p.w / 2, cy = (p.y || 0) + p.h / 2;
  if (which === "w") { p.w = v; } else { p.h = v; }
  p.x = Math.round(cx - p.w / 2); p.y = Math.round(cy - p.h / 2);
  // NOTHING BOUNDS THIS ANY MORE (decision 0011/0013): a resize from the inspector may leave the
  // piece straddling a wall, exactly like the drag it mirrors. `v5Touch` marks the plan dirty.
  v5Touch(ctx);
  render(ctx);
}

export function brancherInspecteur(ctx: Contexte): void {
  // The hooks: rendering, gestures and the keyboard only know these three names.
  ctx.crochets.openInspector = () => openInspector(ctx);
  ctx.crochets.syncInspector = () => syncInspector(ctx);
  ctx.crochets.hideInspector = () => hideInspector();

  const iW = $("iW"), iH = $("iH");
  const iWallPos = $("iWallPos");

  // One focus session = one history entry. Renaming is no longer one of this panel's fields
  // (decision 0013): it happens on a double-click on the object's own label, on the plan.
  ["iW", "iH", "iWallPos"].forEach((id) => {
    const e = $(id); if (!e) return;
    e.addEventListener("focus", () => { inspEdited = false; });
    e.addEventListener("blur", () => { inspEdited = false; });
  });

  numField(iW, {
    label: "The width", unit: "cm",
    bounds: () => dimBounds(ctx, cur(ctx), "w"),
    get: () => { const p = vue(cur(ctx)); return p ? p.w : null; },
    set: (v) => setDim(ctx, "w", v),
  });
  numField(iH, {
    label: "The depth", unit: "cm",
    bounds: () => dimBounds(ctx, cur(ctx), "h"),
    get: () => { const p = vue(cur(ctx)); return p ? p.h : null; },
    // An opening's upper bound doesn't come from the field, it comes from the WALL: say so,
    // otherwise "between 1 and 10 cm" reads as an arbitrary limit and the gesture repeats.
    raison: () => {
      const p = vue(cur(ctx)); if (!p || !v5OpeningById(ctx, p.id)) return "";
      const w = v5WallById(ctx, p.wallId); if (!w) return "";
      return `This wall is ${Math.round(Number(w.t) || WALL)} cm thick: any deeper and the opening would go through both rooms.`;
    },
    set: (v) => setDim(ctx, "h", v),
  });

  // Reposition a wall-mounted object along its wall, by "distance from the corner".
  numField(iWallPos, {
    label: "The distance from the corner", unit: "cm",
    bounds: () => wallPosBounds(ctx),
    get: () => {
      const p = cur(ctx); if (!p) return null;
      const i = openingWallInfo(ctx.etat.plan, p as Ouverture);
      return i ? Math.round(i.t - i.halfW) : null;
    },
    set: (d) => {
      const p = vue(cur(ctx));
      if (!p || p.locked || !isWallMount(p.type)) return;
      const info = openingWallInfo(ctx.etat.plan, p as unknown as Ouverture); if (!info) return;
      if (!inspEdited) { inspEdited = true; pushHistory(ctx); }
      // "From the corner" IS t0: an opening is parametric on its wall.
      p.t0 = v5R2(clamp(d, 0, Math.max(0, info.segLen - 2 * info.halfW)));
      v5ResolveOpening(ctx.etat.plan, p as unknown as Ouverture, 0, ctx.etat.opts);
      v5Touch(ctx); render(ctx); syncInspector(ctx);
    },
  });

  $("iRot90")?.addEventListener("click", () => {
    const p = vue(cur(ctx)); if (!p || p.locked) return;
    if (isWallMount(p.type)) return;   // an opening or a wall-mounted object has no angle of its own
    pushHistory(ctx);
    oublierAvantAimant(String(p.id));   // the person is choosing the rotation herself
    rotatePieceWithChairs(ctx.etat.plan, p as unknown as Meuble, (p.rot || 0) + 90);
    render(ctx); syncInspector(ctx);
  });

  // Opening direction: flips the side (inward/outward) the hinged door opens toward.
  $("iSwing")?.addEventListener("click", () => {
    const p = vue(cur(ctx));
    if (!p || p.locked) return;
    const leafN = p.type === "window" ? (Number((p as unknown as { leaf?: number }).leaf || 0) | 0) : 0;
    if (p.type !== "door" && !leafN) return;
    pushHistory(ctx); p.swing = ((p.swing || 0) < 0) ? 1 : -1;
    v5Touch(ctx); render(ctx); syncInspector(ctx); ctx.crochets.persister?.();
    ctx.crochets.emitDrag?.(p as never);
  });

  // The three leaf buttons. Setting "None" REMOVES the key instead of writing 0: absence means
  // "nobody has decided", and that's what keeps the field compatible with earlier openings
  // (C-5: an absent field is not a field set to zero).
  for (const k of [0, 1, 2]) {
    $("iLeaf" + k)?.addEventListener("click", () => {
      const p = vue(cur(ctx));
      if (!p || p.locked || p.type !== "window") return;
      const f = p as unknown as { leaf?: 0 | 1 | 2 };
      const veut = k as 0 | 1 | 2;
      const actuel = Number(f.leaf || 0) | 0;
      if (veut === actuel) return;
      pushHistory(ctx);
      if (veut === 0) delete f.leaf; else f.leaf = veut;
      v5Touch(ctx); render(ctx); syncInspector(ctx); ctx.crochets.persister?.();
      ctx.crochets.emitDrag?.(p as Ouverture);
    });
  }

  // Left/right hinge: door, or single-leaf window.
  $("iHinge")?.addEventListener("click", () => {
    const p = vue(cur(ctx));
    if (!p || p.locked) return;
    const leafN = p.type === "window" ? (Number((p as unknown as { leaf?: number }).leaf || 0) | 0) : 0;
    if (p.type !== "door" && p.type !== "sdoor" && leafN !== 1) return;
    pushHistory(ctx);
    const b = p as unknown as { hinge?: unknown };
    b.hinge = b.hinge ? 0 : 1;
    v5Touch(ctx); render(ctx); syncInspector(ctx); ctx.crochets.persister?.();
    ctx.crochets.emitDrag?.(p as never);
  });

  // The throw ratio: typed as 1.50, stored as 150.
  numField($("iTr"), {
    label: "The throw ratio", unit: ":1",
    bounds: () => ({ min: 1, max: 10 }),
    get: () => { const p = vue(cur(ctx)) as unknown as { tr?: number } | null; return p && p.tr ? p.tr / 100 : null; },
    set: (v: number) => {
      const p = vue(cur(ctx)); if (!p || p.type !== "projector") return;
      pushHistory(ctx);
      (p as unknown as { tr?: number }).tr = Math.round(v * 100);
      v5Touch(ctx); render(ctx); syncInspector(ctx); ctx.crochets.persister?.();
    },
  });
  // THE FLUX OF A LIGHT FIXTURE. Clearing it puts the fixture back on its type's default: an
  // absent `lm` is not a fixture set to zero (C-5), which is why `clear` deletes the key.
  numField($("iLm"), {
    label: "The luminous flux", unit: "lm", optional: true,
    bounds: () => ({ min: LM_MIN, max: LM_MAX }),
    get: () => { const p = vue(cur(ctx)) as unknown as { lm?: number } | null; return p && p.lm !== undefined ? p.lm : null; },
    set: (v: number) => {
      const p = vue(cur(ctx)); if (!p || !estLumiere(p.type)) return;
      pushHistory(ctx);
      (p as unknown as { lm?: number }).lm = Math.round(v);
      v5Touch(ctx); render(ctx); syncInspector(ctx); ctx.crochets.persister?.();
    },
    clear: () => {
      const p = vue(cur(ctx)); if (!p || !estLumiere(p.type)) return;
      pushHistory(ctx);
      delete (p as unknown as { lm?: number }).lm;
      v5Touch(ctx); render(ctx); syncInspector(ctx); ctx.crochets.persister?.();
    },
  });
  numField($("iDmin"), {
    label: "The minimum distance", unit: "cm",
    bounds: () => ({ min: 0, max: 2000 }),
    get: () => { const p = vue(cur(ctx)) as unknown as { dmin?: number } | null; return p && p.dmin ? p.dmin : null; },
    set: (v: number) => {
      const p = vue(cur(ctx)); if (!p || p.type !== "projector") return;
      pushHistory(ctx);
      (p as unknown as { dmin?: number }).dmin = Math.round(v);
      v5Touch(ctx); render(ctx); syncInspector(ctx); ctx.crochets.persister?.();
    },
  });
  $("iPair")?.addEventListener("change", () => {
    const p = vue(cur(ctx)); if (!p || p.type !== "projector") return;
    const sel = $("iPair") as HTMLSelectElement | null; if (!sel) return;
    pushHistory(ctx);
    const pj = p as unknown as { pair?: string };
    // Clearing the pairing writes an EMPTY string, not `undefined`: "no more screen" is
    // information that must travel through to the peer, not a field left unemitted.
    pj.pair = sel.value || "";
    v5Touch(ctx); render(ctx); syncInspector(ctx); ctx.crochets.persister?.();
  });

  $("iSide")?.addEventListener("click", () => { const p = cur(ctx); if (p) flipWallMountSide(ctx, p); });

  // Duplicate: ONE path (decision 0013), shared with `Ctrl+D` (`gestes/clavier.ts`).
  $("iDup")?.addEventListener("click", () => dupliquerSelection(ctx));

  $("iLock")?.addEventListener("click", () => {
    const p = vue(cur(ctx)); if (!p) return;
    pushHistory(ctx); p.locked = !p.locked; save(ctx); render(ctx); syncInspector(ctx);
  });

  $("iDel")?.addEventListener("click", () => delSel(ctx));
}
