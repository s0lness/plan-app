// src/ts/exportation/impression.ts — THE PNG IMAGE AND THE PRINTED PAGE.
// Ported from src/js/32-export.js (`renderMasterPNG`, `exportPNG`, `preparePrint`, `clearPrint`,
// `printPlan`).
//
// PDF = PRINTING. There is no embedded PDF generator: we fill `#printRoot` with the
// master SVG (page 1) and the furniture table (page 2), then call `window.print()`; the
// person chooses "Save as PDF". `#printRoot` is `display:none` on screen and is only
// revealed by `@media print` (css/16). We EMPTY it after printing: an `afterprint` that
// doesn't clean up leaves a frozen plan in the live document.
//
// Everything is client-side, everything is CSP-safe: `data:` URL and `blob:` only, hardcoded system font.

import type { Contexte } from "../app/contexte.ts";
import { $ } from "../noyau/dom.ts";
import { buildMasterSVG } from "./svg-maitre.ts";
import { furnitureListHTML } from "./liste-mobilier.ts";

export interface RenduPNG {
  blob: Blob | null;
  dataURL: string | null;
  width: number;
  height: number;
}

/**
 * Rasterizes the master SVG into PNG at `scale`x (2 by default). `data:` URL -> `Image` -> `canvas`.
 * The background is painted white BEFORE drawing: a PNG with a transparent background prints gray.
 */
export function renderMasterPNG(ctx: Contexte, scale?: number): Promise<RenduPNG> {
  const sc = scale || 2;
  const svg = buildMasterSVG(ctx);
  const m = svg.match(/width="(\d+)"\s+height="(\d+)"/);
  const w = m ? +m[1]! : 800, h = m ? +m[2]! : 600;
  const svgUrl = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  return new Promise<RenduPNG>((resolve, reject) => {
    const img = new Image();
    img.onload = (): void => {
      try {
        const cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(w * sc)); cv.height = Math.max(1, Math.round(h * sc));
        const c2 = cv.getContext("2d")!;
        c2.fillStyle = "#ffffff"; c2.fillRect(0, 0, cv.width, cv.height);
        c2.drawImage(img, 0, 0, cv.width, cv.height);
        const finish = (blob: Blob | null, dataURL?: string | null): void =>
          resolve({ blob, dataURL: dataURL || (blob ? null : cv.toDataURL("image/png")), width: cv.width, height: cv.height });
        if (cv.toBlob) cv.toBlob((b) => finish(b, b ? null : cv.toDataURL("image/png")), "image/png");
        else finish(null, cv.toDataURL("image/png"));
      } catch (err) { reject(err); }
    };
    img.onerror = (): void => reject(new Error("SVG image load failed"));
    img.src = svgUrl;
  });
}

export function exportPNG(ctx: Contexte): Promise<RenduPNG> {
  return renderMasterPNG(ctx, 2).then((res) => {
    const url = res.blob ? URL.createObjectURL(res.blob) : (res.dataURL || "");
    const a = document.createElement("a"); a.href = url; a.download = "plan.png";
    document.body.appendChild(a); a.click(); a.remove();
    if (res.blob) setTimeout(() => URL.revokeObjectURL(url), 0);
    return res;
  }).catch((err: unknown) => {
    try { alert("PNG export failed: " + ((err as Error)?.message || err)); } catch (_) { /* no alert available */ }
    throw err;
  });
}

export function preparePrint(ctx: Contexte): void {
  const plan = $("printPlan"), furni = $("printFurni");
  if (plan) plan.innerHTML = `<h2>Plan de l'appartement</h2>` + buildMasterSVG(ctx, { title: "" });
  // The printed list is THE SAME as the modal's: one single table factory (`liste-mobilier.ts`),
  // so it's impossible for the screen and the PDF to diverge.
  if (furni) furni.innerHTML = `<h2>Furniture list</h2>` + furnitureListHTML(ctx);
}

export function clearPrint(): void {
  const plan = $("printPlan"), furni = $("printFurni");
  if (plan) plan.innerHTML = "";
  if (furni) furni.innerHTML = "";
}

export function printPlan(ctx: Contexte): void { preparePrint(ctx); window.print(); }
