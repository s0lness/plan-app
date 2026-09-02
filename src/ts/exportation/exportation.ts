// src/ts/exportation/exportation.ts: WIRING UP THE OUTPUTS (batch E3c, EXPORT sub-batch).
// Ported from src/js/32-export.js and src/js/30-liste-mobilier.js.
//
// WHAT THIS MODULE WIRES, and nothing else:
//   · the "Furniture list" modal (#furni) and its "Copy the list" button;
//   · "Export as PNG" (rasterizing the master SVG);
//   · "Print / PDF" (filling #printRoot then `window.print()`), and the `afterprint`
//     cleanup without which a frozen plan would remain in the live document;
//   · "Save / Load a plan" as a JSON file (`transfert.ts`);
//   · "Clear" (removing all furniture), which lives in the same source file of origin.
//
// OPENING THE "File" MENU IS NOT HERE: it belongs to the panels sub-batch. This module
// carries only the ACTIONS behind its entries, and each one is also proven by the probe,
// without a menu (`sonde-export.ts`).

import type { Contexte } from "../app/contexte.ts";
import { $ } from "../noyau/dom.ts";
import { v5Touch } from "../app/contexte.ts";
import { pushHistory } from "../historique/pile.ts";
import { render } from "../rendu/rendu.ts";
import { clearSel } from "../rendu/selection.ts";
import { furnitureListHTML, furnitureListText } from "./liste-mobilier.ts";
import { clearPrint, exportPNG, printPlan } from "./impression.ts";
import { brancherTransfert } from "./transfert.ts";

let furniCopyTimer: ReturnType<typeof setTimeout> | undefined;

export function openFurni(ctx: Contexte): void {
  const furniBody = $("furniBody"), furniEl = $("furni");
  if (furniBody) furniBody.innerHTML = furnitureListHTML(ctx);
  if (furniEl) furniEl.hidden = false;
}

function closeFurni(): void {
  const furniEl = $("furni");
  if (furniEl) furniEl.hidden = true;
  clearTimeout(furniCopyTimer);
}

export function brancherExport(ctx: Contexte): void {
  // ---- the "Furniture list" modal ----------------------------------------------------------
  const furniEl = $("furni"), furniCopy = $("furniCopy"), furniClose = $("furniClose");
  $("btnFurni")?.addEventListener("click", () => openFurni(ctx));
  furniClose?.addEventListener("click", closeFurni);
  furniEl?.addEventListener("pointerdown", (e) => { if (e.target === furniEl) closeFurni(); });
  furniEl?.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Escape") { e.stopPropagation(); closeFurni(); } });
  furniCopy?.addEventListener("click", () => {
    const txt = furnitureListText(ctx);
    const flash = (): void => {
      furniCopy.textContent = "Copied ✓"; clearTimeout(furniCopyTimer);
      furniCopyTimer = setTimeout(() => { furniCopy.textContent = "Copy the list"; }, 1500);
    };
    const fallback = (): void => {
      try {
        const ta = document.createElement("textarea"); ta.value = txt;
        ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); flash();
      } catch (_) { /* nothing more to try */ }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(flash, fallback);
    else fallback();
  });

  // ---- PNG, printing ----------------------------------------------------------------------------
  $("btnExportPNG")?.addEventListener("click", () => { void exportPNG(ctx); });
  // `#btnExportPDF` carries the SAME action as "Print / PDF": both print, the person
  // chooses "Save as PDF" in the browser's dialog. The button stays hidden in the
  // template; we wire it anyway, so the template and the code never diverge.
  $("btnExportPDF")?.addEventListener("click", () => printPlan(ctx));
  $("btnPrint")?.addEventListener("click", () => printPlan(ctx));
  window.addEventListener("afterprint", clearPrint);

  // ---- JSON file --------------------------------------------------------------------------------
  brancherTransfert(ctx);

  // ---- "Clear" ------------------------------------------------------------------------------
  $("btnClear")?.addEventListener("click", () => {
    if (ctx.etat.plan.pieces.length && !confirm("Remove all furniture from the flat?")) return;
    pushHistory(ctx); ctx.etat.plan.pieces.length = 0; v5Touch(ctx); clearSel(ctx);
    ctx.crochets.hideInspector?.(); render(ctx);
  });
}
