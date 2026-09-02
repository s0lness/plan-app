// src/ts/modele/restauration.ts: RELOAD THE PRE-CONVERSION PLAN, OUTSIDE SHARING.
// Porté de src/js/55-v5-migration.js (`v5RestoreBackup`).
//
// D-3. THE SAFETY NET EXISTS, ITS FRONT DOOR DOES NOT. The menu entry that reloaded the backup
// was REMOVED (the conversion is done, the converted plan is in service, and the only thing that
// button could still do was get clicked by mistake). The DATA remains, this function remains; it
// is now reachable only through the test probe.
//
// WHY IT DETACHES THE REALTIME WIRE, AND WHY THAT IS NOT NEGOTIABLE. Restoring means taking back
// the plan's content exactly as it was BEFORE the conversion: it is read again (legacy format)
// and reconverted, like any imported file. It is a LOCAL rescue. The shared plan, meanwhile, has
// its own history, a more recent one, and republishing an old snapshot on top of it would
// overwrite it for the whole household, in a single op. So the link is cut for this session
// rather than risk that, and the chip SAYS so ("local", with its own title). It is the only path
// in the client that deliberately makes a tab go silent.

import type { Contexte } from "../app/contexte.ts";
import { migrate } from "./etat.ts";
import { v5BackupInfo } from "./filets.ts";
import { applyReplacedState, pushHistory } from "../historique/pile.ts";
import { fitView } from "../rendu/vue.ts";
import { toast } from "../app/toast.ts";

export type ResultatRestauration =
  | { error: string }
  | { cells: number; detached: true };

export function v5RestoreBackup(ctx: Contexte): ResultatRestauration {
  const info = v5BackupInfo();
  if (!info) return { error: "no backup" };
  let ns: ReturnType<typeof migrate> = null;
  try { ns = migrate(JSON.parse(info.raw), ctx.etat.opts); } catch (_) { ns = null; }
  if (!ns || !ns.plan) return { error: "unreadable backup" };
  // Cut FIRST, replace SECOND. In the other order, the `save()` that `applyReplacedState`
  // triggers would publish the old snapshot to the household before the link is closed.
  ctx.crochets.detacherSynchro?.();
  pushHistory(ctx);
  applyReplacedState(ctx, ns);
  fitView(ctx);   // VOLUNTARY action: it recenters, unlike a remote adoption (D-12)
  toast("Pre-conversion plan reloaded on this device (not shared).");
  return { cells: (ctx.etat.plan.cells || []).length, detached: true };
}
