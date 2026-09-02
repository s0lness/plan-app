// src/ts/app/persistance.ts — THE LOCAL WRITE, AND THE G-1 SAFETY NET.
// Ported from src/js/07-pieces-persistance.js (`serialize`, `save`, `notePersistFailed/Ok`) and from
// src/js/02 (`saveOpts`).
//
// THREE INVARIANTS HOLD HERE, AND ALL THREE ARE MEASURED LOST WORK:
//
//  G-2  THE VIEW IS NOT THE PLAN. `renderView()` increments `ctx.viewOnly`: `save()` bails out first thing.
//       Measured before: a 40-move pan = 40 serializations and 854,520 bytes written.
//  G-1  A GESTURE THAT NEVER ENDS MAKES THE APPLICATION MUTE. `gestureActive` makes
//       `save()` bail out first thing so the drag stays smooth; if the gesture NEVER ends, nothing
//       is ever written again and the whole session vanishes on reload, without a single message.
//       Hence the SAFETY NET: a gesture with no sign of life for GESTURE_IDLE_MS is not a
//       gesture, we force its exit HERE before deciding not to write.
//  D-7  PERSONAL SETTINGS NEVER CROSS OVER. `serialize()` carries NO `opts` at all: this
//       blob IS the body of the PUT to the shared plan and the content of a file export. Settings
//       live in their own key (`room-planner-opts`).

import type { Contexte } from "./contexte.ts";
import type { EtatFil, PlanV5 } from "../partage/plan.ts";
import { OPTS_KEY, keyPourMode } from "../noyau/nombres.ts";
import { modeCourant, planCourant, planIdInvite } from "../fil/drapeaux.ts";
import { $ } from "../noyau/dom.ts";
import { v5StateWire } from "../fil/pseudo-fil.ts";
import { endActiveGesture, gesteActif, gestureStale } from "../gestes/sortie.ts";
import { toast } from "./toast.ts";

/**
 * The canonical serializable state. The FLAT plan (outline/walls/openings/pieces/cells at the root)
 * IS the form the server recognizes; `plan` stays alongside as a complete local copy (it
 * carries the openings' `h`/`side`/`name`). D-4: on re-reading, `plan` wins over the flat form.
 */
export function serialize(ctx: Contexte): { setupDone: boolean; model: "v5"; plan: unknown } & EtatFil {
  // A5. `plan._report` (`partage/plan.ts`) is documented "diagnostic, never persisted", but
  // `plan: ctx.etat.plan` used to copy the LIVE object verbatim, `_report` included whenever the
  // last cell detection had left one behind: the promise was written down, not kept. A shallow
  // copy that OMITS it is what actually keeps it, without touching the live plan `v5RebuildCells`
  // still writes `_report` onto.
  const { _report, ...plan } = ctx.etat.plan as PlanV5 & { _report?: unknown };
  const s = { setupDone: !!ctx.etat.setupDone, model: "v5" as const, plan };
  return Object.assign(s, v5StateWire(ctx.etat.plan, !!ctx.etat.setupDone));
}

let persistFailed = false;
/** Counter of REAL local writes. Test probe: this is what proves G-1 and G-2. */
let _saveCount = 0;
export const saveCount = (): number => _saveCount;

function setStoreChip(on: boolean): void {
  const c = $("storeChip"); if (!c) return;
  c.hidden = !on;
  c.title = on ? "This browser refuses to save (private browsing, or storage full). The plan exists in memory only: keep a copy of it with “Save the plan…”." : "";
}

// D-15. Private browsing, blocked cookies, zero quota: `setItem` THROWS. The exception used to be
// swallowed by a silent `catch(e){}`: the person would work an hour believing they were saving, and lose
// everything on reload. A single message (not one per keystroke), plus a PERSISTENT chip for as long as it
// doesn't recover.
function notePersistFailed(ctx: Contexte, e: unknown): void {
  ctx.crochets.crumb?.("stockage", "refused:" + (((e as Error) && (e as Error).name) || "?"));
  if (persistFailed) return;
  persistFailed = true;
  setStoreChip(true);
  toast("Cannot save on this device: the plan is held in memory only.");
}

function notePersistOk(): void {
  if (!persistFailed) return;
  persistFailed = false;
  setStoreChip(false);
  toast("Local saving works again.");
}

/** D-7. PERSONAL settings, in their own key, never in the plan. */
export function saveOpts(ctx: Contexte): void {
  try { localStorage.setItem(OPTS_KEY, JSON.stringify(ctx.etat.opts)); } catch (_) { /* see D-15 */ }
}

export function save(ctx: Contexte): void {
  // G-2. The VIEW is not a plan modification: its render persists nothing and re-arms nothing.
  if (ctx.viewOnly) return;
  // G-1, THE SAFETY NET. See the header: a stale gesture is not a gesture.
  if (gesteActif() && gestureStale()) endActiveGesture();
  // While a gesture is live, we skip the per-move write and the sync bookkeeping: the
  // gesture already broadcasts ephemeral ghosts, and its exit writes ONCE. The freshness
  // counter, THOUGH, keeps running: without that, adopting a remote plan became allowed again
  // 2.5 s after a drag started, mid-gesture.
  if (gesteActif()) { ctx.crochets.toucherFraicheur?.(); return; }
  try {
    // Batch 3: which key depends on the MODE (household/invited/local-only), not only on which
    // plan a `?p=` might name — see `noyau/nombres.ts`'s `keyPourMode` for why `main`'s bare-key
    // exemption cannot survive off the household door (design edge 13).
    localStorage.setItem(keyPourMode(modeCourant(), planIdInvite() || planCourant()), JSON.stringify(serialize(ctx)));
    _saveCount++;
    notePersistOk();
  } catch (e) { notePersistFailed(ctx, e); }
  saveOpts(ctx);
  ctx.crochets.publierD1?.();
  ctx.crochets.publierFil?.();
}
