// src/ts/modele/filets.ts — THE TWO SAFETY NETS OF BOOTSTRAP.
// Porté de src/js/55-v5-migration.js (`v5BackupLegacy`, `v5BackupInfo`) and of
// src/js/02-etat-migrations.js (`rescueUnreadable`, and the call that decides whether the blob
// is legacy).
//
// D-3. THE PRE-CONVERSION BLOB IS COPIED VERBATIM, ONCE. The walls-only model is the ONLY model:
// a legacy-format plan is read and converted at load time. Before the very first conversion on
// this device, the `localStorage` blob is copied AS IS (never re-serialized), with its
// timestamp. "The backup stays, its menu entry doesn't": the conversion has taken place, the
// converted plan is in service, and the only thing the menu entry could still do was get
// clicked by mistake.
//
// D-2. AN UNREADABLE PLAN DOES NOT PASS ITSELF OFF AS A PLAN. A record that is present but
// unreadable (cut-off write, truncated JSON, unknown version) is not a plan, and it is not
// "no plan" either. Measured: 6,040 bytes of plan became 1,692 bytes of default apartment, with
// no rescue copy and not a word said. So it is set aside under ITS OWN key, BEFORE anything can
// replace it, and `setupDone` falls back to false (no publication can leave a device that failed
// to read its own plan back).

import { V5_BACKUP_AT, V5_BACKUP_KEY, V5_RESCUE_AT, V5_RESCUE_KEY } from "../noyau/nombres.ts";

/** What the pre-conversion backup contains, read without restoring it. */
export interface InfoSauvegarde {
  raw: string;
  at: string;
  rooms: number;
  pieces: number;
  names: string[];
}

/** The blob set aside because it was unreadable. `kept` says whether the write succeeded. */
export interface InfoIllisible { bytes: number; kept: boolean }

/**
 * Is the blob just read in the LEGACY format? This is exactly the question `js/02` asks: no
 * `outline`, no `walls`, no `plan`, but `rooms[]`, a `room`, or `pieces`.
 */
function estAncienFormat(brut: string): boolean {
  let o: unknown = null;
  try { o = JSON.parse(brut); } catch (_) { return false; }
  const enveloppe = o as { app?: string; state?: unknown } | null;
  const st = (enveloppe && enveloppe.app === "room-planner" && enveloppe.state)
    ? enveloppe.state as Record<string, unknown>
    : o as Record<string, unknown> | null;
  if (!st || typeof st !== "object") return false;
  return st["outline"] === undefined && st["walls"] === undefined && !st["plan"]
    && ((Array.isArray(st["rooms"]) && (st["rooms"] as unknown[]).length > 0)
      || !!st["room"] || !!st["pieces"]);
}

/**
 * Rescue copy of the blob just read, if (and only once) it was in the legacy format. Returns
 * true if the copy was just taken.
 */
export function v5BackupLegacy(brut: string | null | undefined): boolean {
  try {
    if (!brut) return false;
    if (!estAncienFormat(brut)) return false;
    if (localStorage.getItem(V5_BACKUP_KEY)) return false;   // already backed up
    localStorage.setItem(V5_BACKUP_KEY, brut);
    localStorage.setItem(V5_BACKUP_AT, new Date().toISOString());
  } catch (_) { return false; }
  return true;
}

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

/** What the pre-conversion backup says about itself, without restoring it. */
export function v5BackupInfo(): InfoSauvegarde | null {
  try {
    const raw = localStorage.getItem(V5_BACKUP_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw) as { app?: string; state?: unknown } | null;
    const st = (obj && obj.app === "room-planner" && obj.state)
      ? obj.state as Record<string, unknown>
      : obj as unknown as Record<string, unknown> | null;
    if (!st || !Array.isArray(st["rooms"]) || !(st["rooms"] as unknown[]).length) return null;
    const salles = st["rooms"] as { name?: unknown; pieces?: unknown[] }[];
    const env = st["envelope"] as { pieces?: unknown[] } | undefined;
    return {
      raw,
      at: localStorage.getItem(V5_BACKUP_AT) || "",
      rooms: salles.length,
      pieces: salles.reduce((n, r) => n + ((r.pieces && r.pieces.length) || 0), 0)
        + ((env && env.pieces && env.pieces.length) || 0),
      names: salles.map((r) => String(r.name || "")).slice(0, 12),
    };
  } catch (_) { return null; }
}
