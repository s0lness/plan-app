// src/ts/exportation/transfert.ts — SAVE / LOAD A PLAN AS A JSON FILE.
// Ported from src/js/32-export.js (`exportPayload`, `importPlan`, the `#xfer` modal).
//
// INSIDE AN ARTIFACT IFRAME, THE SANDBOX BLOCKS `<a download>` SILENTLY: the click does
// nothing, no error. We therefore fall back to a copy/paste modal. A top-level window
// (the app hosted online) keeps the direct paths.
//
// A FILE IN THE OLD FORMAT IS READ AND CONVERTED by `migrate()`: we never reintroduce
// rooms into the live plan (and the server wire would not accept that shape).

import type { Contexte } from "../app/contexte.ts";
import { $ } from "../noyau/dom.ts";
import { migrate } from "../modele/etat.ts";
import { serialize } from "../app/persistance.ts";
import { applyReplacedState, pushHistory } from "../historique/pile.ts";
import { fitView } from "../rendu/vue.ts";
import { EMBEDDED } from "../fil/drapeaux.ts";

// `EMBEDDED` MOVED to `fil/drapeaux.ts` (batch E4) and is now only re-exported here for
// existing callers. A mechanical reason, not a cosmetic one: it governs `SYNC_ON`, so all
// synchronization depends on it; leaving it in this module would have made `fil/*` depend on the
// export module, whereas import MUST be able to publish onto the wire. That was a cycle, and a cycle
// brings back exactly the class of defect (temporal dead zone) that real modules eliminate.
export { EMBEDDED };

export const exportPayload = (ctx: Contexte): string =>
  JSON.stringify({ app: "room-planner", version: 4, savedAt: new Date().toISOString(), state: serialize(ctx) }, null, 2);

export function importPlan(ctx: Contexte, text: unknown): boolean {
  let ns: ReturnType<typeof migrate>;
  try {
    const obj: unknown = JSON.parse(String(text));
    ns = migrate(obj, ctx.etat.opts);   // v1/v2/v3/v4 AND walls-only
    if (!ns || !ns.plan) throw 0;
  } catch (_) { alert("Invalid plan file."); return false; }
  pushHistory(ctx);               // captures the layout from before: the import is undoable
  ns.setupDone = true;
  applyReplacedState(ctx, ns);    // shared, safe replacement path
  fitView(ctx);
  // C-14. THE IMPORT PROPAGATES AS ONE ATOMIC OP (`plan5.replace`), not by diff. This is
  // `wsMaybeReplace()` from the old client (js/32 l. 229): a deliberate, GLOBAL replacement,
  // so the peer receives the plan as a block, never half-done. The hook falls silent by itself when
  // we're applying a remote op (no echo) and when the wire is closed.
  ctx.crochets.publierPlanEntier?.();
  return true;
}

export function brancherTransfert(ctx: Contexte): void {
  const xferEl = $("xfer"), xferTa = $("xferTa") as HTMLTextAreaElement | null, xferTitle = $("xferTitle"),
    xferHint = $("xferHint"), xferCopy = $("xferCopy"), xferImport = $("xferImport"),
    xferFile = $("xferFile"), xferClose = $("xferClose");
  let xferCopyTimer: ReturnType<typeof setTimeout> | undefined;

  function openXfer(mode: "export" | "import"): void {
    if (!xferEl || !xferTa) return;
    if (mode === "export") {
      if (xferTitle) xferTitle.textContent = "Save the plan";
      xferTa.readOnly = true; xferTa.placeholder = ""; xferTa.value = exportPayload(ctx);
      if (xferHint) xferHint.textContent = "Direct download is not available here. Copy this content and keep it in a file (flat-plan.json), or paste it straight into “Open from file…”.";
      if (xferCopy) { xferCopy.hidden = false; xferCopy.textContent = "Copy"; }
      if (xferImport) xferImport.hidden = true;
      if (xferFile) xferFile.hidden = true;
    } else {
      if (xferTitle) xferTitle.textContent = "Load a plan";
      xferTa.readOnly = false; xferTa.value = ""; xferTa.placeholder = "Paste the content of a plan here…";
      if (xferHint) xferHint.textContent = "Paste the content of a saved plan, or choose a file.";
      if (xferCopy) xferCopy.hidden = true;
      if (xferImport) xferImport.hidden = false;
      if (xferFile) xferFile.hidden = false;
    }
    xferEl.hidden = false;
    setTimeout(() => { xferTa.focus(); if (mode === "export") xferTa.select(); }, 30);
  }
  function closeXfer(): void { if (xferEl) xferEl.hidden = true; clearTimeout(xferCopyTimer); }

  xferCopy?.addEventListener("click", () => {
    if (!xferTa || !xferCopy) return;
    const flash = (): void => {
      xferCopy.textContent = "Copied ✓"; clearTimeout(xferCopyTimer);
      xferCopyTimer = setTimeout(() => { xferCopy.textContent = "Copy"; }, 1500);
    };
    const fallback = (): void => { try { xferTa.select(); document.execCommand("copy"); flash(); } catch (_) { /* nothing more to try */ } };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(xferTa.value).then(flash, fallback);
    else fallback();
  });
  xferImport?.addEventListener("click", () => { if (xferTa && importPlan(ctx, xferTa.value)) closeXfer(); });
  xferFile?.addEventListener("click", () => $("fileImport")?.click());
  xferClose?.addEventListener("click", closeXfer);
  xferEl?.addEventListener("pointerdown", (e) => { if (e.target === xferEl) closeXfer(); });
  xferEl?.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Escape") { e.stopPropagation(); closeXfer(); } });

  $("btnExport")?.addEventListener("click", () => {
    if (EMBEDDED) { openXfer("export"); return; }
    const blob = new Blob([exportPayload(ctx)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "plan-appartement.json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });
  $("btnImport")?.addEventListener("click", () => { if (EMBEDDED) { openXfer("import"); return; } $("fileImport")?.click(); });
  $("fileImport")?.addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files && input.files[0];
    if (!file) return;
    const rdr = new FileReader();
    rdr.onload = (): void => { if (importPlan(ctx, rdr.result) && xferEl && !xferEl.hidden) closeXfer(); input.value = ""; };
    rdr.onerror = (): void => { alert("Invalid plan file."); input.value = ""; };
    rdr.readAsText(file);
  });
}
