// src/ts/noyau/nombres.ts: the core's constants and its handful of numeric functions.
// Ported from src/js/00-noyau.js.
//
// In the old client, these declarations had to live in the FIRST module because
// `migrate()` runs as early as `js/02`: "any constant the converter reads is declared in
// js/00-noyau.js; declaring it further down would put it in a temporal dead zone and would break
// startup WITHOUT breaking the tests" (AGENTS.md, coupling #4 of src/README.md).
//
// THAT INVARIANT BECOMES STRUCTURAL: these are real ES modules, the `import` graph decides
// the order, and a cycle would be a compile error. The whole class of "temporal dead zone
// initialization error" disappears along with the manifest (docs/reecriture.md §2).

export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/**
 * Anti-white-page (R-17): a NaN/negative/gigantic px dimension written into a style can
 * silently fail the GPU raster (especially ARM/ANGLE) and blank out the whole page.
 */
export const safeDim = (v: unknown): number => {
  const n = Number(v);
  if (!isFinite(n) || n < 0) return 0;
  return n > 100000 ? 100000 : n;
};

/**
 * HTML escaping, ONE single function for the whole application (R-9). The four characters
 * matter, and `&` first (otherwise we'd re-escape the entities we just placed).
 */
export const escapeHtml = (s: unknown): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** ONE single surface-area formatting for the whole application (R-12): a comma, one decimal. */
export const fmtM2 = (cm2: unknown): string =>
  (Math.round((Math.abs(Number(cm2)) || 0) / 1000) / 10).toFixed(1).replace(".", ",") + " m²";

/**
 * ONE single download filename for the whole application (C-6 of the 2026-09-02 review): the PNG
 * export and the JSON save used to be fixed names (`plan.png`, `plan-appartement.json`), so saving
 * a second plan the same way silently overwrote the first one in the person's Downloads folder.
 * `<cleaned plan name>-<YYYY-MM-DD>.<ext>`: letters, digits and dashes only (a plan title can carry
 * spaces, slashes, emoji, anything typed into `#planName`, none of which belongs in a filename
 * unescaped), and an EMPTY or entirely-punctuation name falls back to `"plan"` rather than
 * producing a bare `-2026-09-02.png`.
 */
export function nomFichierExport(nomPlan: unknown, ext: string): string {
  const propre = String(nomPlan ?? "").normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  const d = new Date();
  const jour = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
  return (propre || "plan") + "-" + jour + "." + ext;
}

// ---- local storage keys (D-2, D-3, D-7) -----------------------------------------------------------
// None is renamed by the rewrite: these are bytes already written at the household's.
export const KEY = "room-planner-v4";

/**
 * THE LOCAL COPY IS PER-PLAN, AND `main` KEEPS EXACTLY THE HISTORICAL KEY.
 *
 * Defect measured before this fix: the key was unique for the whole browser, so opening a
 * NEW plan repainted the previous plan from the local cache. Worse than annoying: startup paints
 * the local copy BEFORE the server has answered, so the first save would have published
 * one plan's document INTO another. That's exactly the failure that reloading on every
 * plan change was trying to make impossible, and it was sneaking back in through the storage door.
 *
 * `main` with no suffix is NOT a stylistic choice: these are bytes already written at the
 * household's, and renaming them would lose the flat's local copy (and its pre-conversion
 * rescue plan, which derives from the same key).
 */
export function keyPourPlan(planId: string): string {
  return (!planId || planId === "main") ? KEY : KEY + ":" + planId;
}

/**
 * BATCH 3, GUEST CLIENT (design edge 13). Local-only mode's own key, entirely separate from
 * every plan id: on the guest origin an anonymous visitor's own sandbox and an invited `main`
 * plan must never share bytes.
 */
export const KEY_GUEST_LOCAL = "room-planner-guest-local";

/**
 * THE STORAGE KEY FOR THE CURRENT MODE. `keyPourPlan` alone is right for the household door: its
 * `main` exemption protects bytes already written there, before this feature existed. Off it,
 * that exemption has nothing to protect and everything to lose: local-only mode gets its OWN key
 * (never the bare one, never a plan-namespaced one), and an invited plan is ALWAYS namespaced by
 * its id, `main` included, the SAME `main` that would otherwise collapse to the bare key.
 *
 * `mode` and `planId` come from `fil/drapeaux.ts` (the only place that tracks them), passed in
 * rather than imported, so this function stays as leaf as `keyPourPlan` itself.
 */
export function keyPourMode(mode: "menage" | "invite" | "local", planId: string | null): string {
  if (mode === "local") return KEY_GUEST_LOCAL;
  if (mode === "invite") return KEY + ":" + (planId || "invite");
  return keyPourPlan(planId || "main");
}

export const OPTS_KEY = "room-planner-opts";
// The blob that could NOT be read back, set aside under its own key. The name still carries "v4"
// because it IS the key already written in two browsers: renaming it would orphan what it holds.
export const V5_RESCUE_KEY = "room-planner-v4-backup-illisible";
export const V5_RESCUE_AT = "room-planner-v4-backup-illisible-at";

// ---- walls-only model constants ------------------------------------------------------------------
/** cm: merging points in the planar graph */
export const V5_EPS = 0.5;

/** cm²: below this threshold a face is a sliver, not a room (2×2 dm) */
export const V5_MIN_AREA = 400;

/**
 * Default wall thickness (cm). A SINGLE constant, so that the rendering and the inner
 * dimension (clear length = centerline - WALL) never drift apart.
 */
export const WALL = 12;

export const v5R2 = (v: number): number => Math.round(v * 100) / 100;

