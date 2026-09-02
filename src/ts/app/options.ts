// src/ts/app/options.ts: THE RAIL'S PERSONAL SETTINGS, AND THE UNREADABLE-PLAN BANNER.
// Ported from src/js/28-options.js (snap, labels, the three layers, the palette search
// clear button) and from src/js/46-init.js (the `#bootNotice` / `#setupNotice` banner).
//
// D-7. WHAT DESCRIBES THE PERSON'S SCREEN NEVER CROSSES THE NETWORK. These settings go through
// `saveOpts()`, never `save()`: an unchecked layer is not a plan modification, it has
// nothing to send to the household, but it must survive a reload without waiting for the next
// edit.
//
// A HOOK DECLARED AND NEVER WIRED IS SILENCE. `ctx.gestes.syncLayerToggles` is called by
// `ensureLayerVisible` (gestes/pose.ts): placing an object whose layer is hidden TURNS THE
// layer back on, and the toggles must follow. Without the assignment made here, the `?.()` call
// did nothing, silently, and the toggle lied about the layer's state. That's exactly the
// defect `ctx.gestes.railOpen` had (the drawer stayed open over the plan).

import type { Contexte } from "./contexte.ts";
import { $ } from "../noyau/dom.ts";
import { pieceById, v5OpeningById } from "./contexte.ts";
import { pieceVisible } from "../catalogue/catalogue.ts";
import { selRecomputePrimary } from "../rendu/selection.ts";
import { render } from "../rendu/rendu.ts";
import { applyPaletteFilter, buildPalette, setPaletteQuery } from "../rendu/palette.ts";
import { save, saveOpts } from "./persistance.ts";

const box = (id: string): HTMLInputElement | null => $(id) as HTMLInputElement | null;

/** The three layer toggles follow the state, wherever it comes from (including a placement). */
export function syncLayerToggles(ctx: Contexte): void {
  const o = ctx.etat.opts;
  const f = box("optLayFurn"); if (f) f.checked = o.layFurn !== false;
  const l = box("optLayLight"); if (l) l.checked = o.layLight !== false;
  const p = box("optLayPlug"); if (p) p.checked = o.layPlug !== false;
  syncPalBy(ctx);
}

/** The two palette sort-order buttons follow the state, wherever it comes from. LOCAL usage. */
function syncPalBy(ctx: Contexte): void {
  const parNature = ctx.etat.opts.palBy === "kind";
  $("palByRoom")?.setAttribute("aria-pressed", String(!parNature));
  $("palByKind")?.setAttribute("aria-pressed", String(parNature));
}

export function brancherOptions(ctx: Contexte): void {
  // Sort the palette by room or by kind. PERSONAL setting: `saveOpts`, never `save`.
  // Collapsed categories are deliberately KEPT when switching axis: the two
  // taxonomies share no category name, so a collapse remembered in one can't
  // accidentally collapse a category in the other.
  for (const [id, val] of [["palByRoom", "room"], ["palByKind", "kind"]] as const) {
    $(id)?.addEventListener("click", () => {
      if (ctx.etat.opts.palBy === val) return;
      ctx.etat.opts.palBy = val;
      saveOpts(ctx);
      syncPalBy(ctx);
      buildPalette(ctx);
    });
  }
  const snap = box("optSnap");
  if (snap) {
    snap.checked = !!ctx.etat.opts.snap;
    // Snapping IS a work decision: it goes through `save()`, as in the old client.
    snap.addEventListener("change", () => { ctx.etat.opts.snap = snap.checked; save(ctx); });
  }
  const lab = box("optLabels");
  if (lab) {
    lab.checked = !!ctx.etat.opts.labels;
    lab.addEventListener("change", () => { ctx.etat.opts.labels = lab.checked; saveOpts(ctx); render(ctx); });
  }

  /**
   * Hidden layers are neither painted nor selectable, but they REMAIN in the state. An object
   * that just became invisible drops out of the selection: keeping selected what you no longer
   * see would let a Delete keypress erase something invisible.
   */
  const onLayerToggle = (): void => {
    ctx.crochets.crumb?.("layer", JSON.stringify({
      furn: !!box("optLayFurn")?.checked,
      light: !!box("optLayLight")?.checked,
      plug: !!box("optLayPlug")?.checked,
    }));
    try {
      const o = ctx.etat.opts;
      o.layFurn = !!box("optLayFurn")?.checked;
      o.layLight = !!box("optLayLight")?.checked;
      o.layPlug = !!box("optLayPlug")?.checked;
      saveOpts(ctx);   // personal setting: saved right away, never sent to the shared plan
      for (const id of [...ctx.selection.ids]) {
        const pc = pieceById(ctx, id) || v5OpeningById(ctx, id);
        if (pc && !pieceVisible(pc, o)) ctx.selection.ids.delete(id);
      }
      selRecomputePrimary(ctx);
      if (ctx.selection.primaire == null) ctx.crochets.hideInspector?.();
      render(ctx);
      ctx.crochets.syncInspector?.();
    } catch (err) {
      ctx.crochets.reportError?.(err, "bascule de calque");
    }
  };
  ["optLayFurn", "optLayLight", "optLayPlug"].forEach((id) => {
    box(id)?.addEventListener("change", onLayerToggle);
  });
  syncLayerToggles(ctx);
  ctx.gestes.syncLayerToggles = () => syncLayerToggles(ctx);

  // ---- the palette search clear button (transient: no history, no persistence) -------------------
  const inp = box("palSearch"), x = $("palSearchX");
  if (inp) {
    const sync = (): void => {
      setPaletteQuery(ctx, inp.value || "");
      if (x) x.hidden = !inp.value;
      applyPaletteFilter(ctx);
    };
    inp.addEventListener("input", sync);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); inp.value = ""; sync(); }
    });
    x?.addEventListener("click", () => { inp.value = ""; sync(); inp.focus(); });
  }
}

/**
 * D-2. THE LOCAL SAVE WAS UNREADABLE: WE SAY SO, IN TWO PLACES.
 *
 * Without this notice, the default apartment used to start thinking it was configured: no message, no
 * assistant, and the first save overwrote the damaged content (6,040 bytes -> 1,692). Two
 * places because the assistant doesn't always open: online, the decision falls
 * to the server (it may have the household's plan), and meanwhile the screen said nothing.
 *
 * `telecharger` is supplied by the EXPORT batch (`downloadRescued`): it is passed as an argument rather
 * than imported, so that this module doesn't depend on export.
 */
export function direPlanIllisible(
  ctx: Contexte,
  info: { bytes: number; kept: boolean },
  telecharger?: () => boolean,
): void {
  const msg = info.kept
    ? `The plan saved on this device is unreadable (${info.bytes} bytes: interrupted write, or unknown version). It has been set aside WITHOUT being overwritten, and nothing was sent to the shared plan.`
    : `The plan saved on this device is unreadable (${info.bytes} bytes) and this browser refuses to keep a backup copy of it. Nothing was sent to the shared plan.`;
  const notice = $("setupNotice"), txt = $("setupNoticeText"), dl = $("setupNoticeDl");
  if (notice && txt) {
    notice.hidden = false;
    txt.textContent = msg + " Start again from the outline below, or reload a plan from a file.";
    if (dl) {
      dl.hidden = !info.kept;
      if (telecharger) dl.addEventListener("click", () => { telecharger(); });
    }
  }
  const ban = $("bootNotice"), banTxt = $("bootNoticeText");
  if (ban && banTxt) {
    ban.hidden = false;
    banTxt.textContent = msg;
    $("bootNoticeX")?.addEventListener("click", () => { ban.hidden = true; });
  }
  ctx.crochets.crumb?.("boot", "plan local illisible:" + info.bytes);
}
