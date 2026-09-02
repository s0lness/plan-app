// src/ts/modele/filets.ts: THE SAFETY NET OF BOOTSTRAP.
// Porté de src/js/02-etat-migrations.js (`rescueUnreadable`) and de src/js/55 (`downloadRescued`).
//
// D-2. AN UNREADABLE PLAN DOES NOT PASS ITSELF OFF AS A PLAN. A record that is present but
// unreadable (cut-off write, truncated JSON, a format this client no longer reads) is not a plan,
// and it is not "no plan" either. Measured: 6,040 bytes of plan became 1,692 bytes of default
// apartment, with no rescue copy and not a word said. So it is set aside under ITS OWN key,
// BEFORE anything can replace it, `setupDone` falls back to false (no publication can leave a
// device that failed to read its own plan back), and a banner offers it for download.
//
// This is also where a plan written in one of the formats that came before the walls-only model
// lands now (decision 0021): it is neither converted nor thrown away, its bytes are kept and
// handed back.

import { V5_RESCUE_AT, V5_RESCUE_KEY } from "../noyau/nombres.ts";

/** The blob set aside because it was unreadable. `kept` says whether the write succeeded. */
export interface InfoIllisible { bytes: number; kept: boolean }

/** The UNREADABLE blob, set aside AS IS under its own key, before any replacement. */
export function rescueUnreadable(brut: string | null | undefined): InfoIllisible | null {
  if (!brut) return null;
  const info: InfoIllisible = { bytes: String(brut).length, kept: false };
  try {
    if (!localStorage.getItem(V5_RESCUE_KEY)) {
      localStorage.setItem(V5_RESCUE_KEY, brut);
      localStorage.setItem(V5_RESCUE_AT, new Date().toISOString());
    }
    info.kept = true;
  } catch (_) { /* zero quota, private browsing: we can't keep it, but we don't lie either */ }
  return info;
}

/**
 * The UNREADABLE blob, made RECOVERABLE instead of being left at the bottom of the browser. This
 * is the button in the `#bootNotice` / `#setupNotice` banner. Porté de src/js/55 (`downloadRescued`).
 *
 * Two paths, as in the old client: the ordinary download, and the copy/paste-window fallback
 * when the application is embedded in a sandboxed iframe (`<a download>` is blocked there). The
 * fallback writes into the SAME fields as the transfer window, without depending on it.
 */
export function downloadRescued(encastre: boolean): boolean {
  let raw: string | null = null;
  try { raw = localStorage.getItem(V5_RESCUE_KEY); } catch (_) { raw = null; }
  if (!raw) return false;
  if (encastre) {
    const el = document.getElementById("xfer");
    const ta = document.getElementById("xferTa") as HTMLTextAreaElement | null;
    if (!el || !ta) return false;
    el.hidden = false;
    ta.readOnly = true; ta.value = raw;
    const t = document.getElementById("xferTitle"), h = document.getElementById("xferHint");
    if (t) t.textContent = "Unreadable content set aside";
    if (h) h.textContent = "Copy this content and keep it in a file before doing anything else.";
    return true;
  }
  try {
    const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = "plan-illisible.json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  } catch (_) { return false; }
}
