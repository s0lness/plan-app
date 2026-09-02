// src/ts/fil/branchement.ts: THE ONLY PLACE THAT WIRES THE SYNC LAYER INTO THE REST OF THE CLIENT.
//
// The old client had no place like this one: `save()` (js/07) called `syncOnSave()` and
// `wsOnSave()` by name, `js/29` and `js/32` called `wsMaybeReplace()` behind a
// `typeof x === "function"`, and `js/44` set `window.__wsDragStart`, which `js/17` called: it was
// COLLABORATION that carried, without saying so, the flag that silences `save()` during a gesture.
// Here all that wiring is written once, in plain sight, and it is the only wiring.
//
// A MEASURED FINDING, AND IT CONFIRMS WHAT E3c HAD FOUND. The hooks are OPTIONAL fields:
// `ctx.crochets.publierPlanEntier?.()` compiles perfectly even if NOBODY ever sets it. The type
// system does not catch a forgotten call site: it is exactly the same silence as the old
// `typeof x === "function"`, with shorter syntax. What catches it is the tests. So they are named
// here, next to each assignment: if a line of this file disappears, this is what turns red.

import type { Contexte } from "../app/contexte.ts";
import type { Fil } from "./etat.ts";
import { creerFil } from "./etat.ts";
import { SYNC_ON, ERR_URL, estLocalSeul } from "./drapeaux.ts";
import { poserEnvoiErreur } from "../app/diagnostics.ts";
import { brancherTagServeur } from "./identite.ts";
import { beginGesture, endGesture } from "../gestes/sortie.ts";
import {
  brancherSondage, setSyncChip, syncBoot, syncOnSave, syncTouchLocal,
} from "./rest.ts";
import { wsMaybeReplace, wsOnSave, wsShadowSync } from "./emission.ts";
import { wsApplyGhostsToDOM, wsApplyRemoteOp } from "./reception.ts";
import {
  brancherChat, brancherCurseursSortants, demarrerFil, wsEmitDrag, wsEmitDragMulti,
  wsReprojectCursors,
} from "./presence.ts";
import { brancherHud } from "./hud.ts";
import type { Op } from "../partage/plan.ts";

/**
 * THE POST TO `/api/err` (js/40, the NETWORK part left open by E3c). `keepalive` because the
 * error that matters most is the one right before the tab closes. It only fires UNDER
 * `SYNC_ON`: under `file://` and in an iframe, the old client already posted nothing, and that
 * is what lets the test suites run without a single request going out.
 */
function brancherRapportErreur(): void {
  if (!SYNC_ON) return;
  poserEnvoiErreur((entry) => {
    // BATCH 3. "No /api/err" is part of local-only mode's "sync fully off": once the guest door
    // WITHOUT an invitation is confirmed (`fil/invite.ts`), nothing leaves this browser, crash
    // reports included. Checked here rather than by threading `fil` through: this callback is
    // wired once, before `fil` exists, and the mode is the one piece of state that does not need it.
    if (estLocalSeul()) return;
    try {
      fetch(ERR_URL, {
        method: "POST", keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      }).catch(() => { /* the reporter must NEVER raise an error: it would manufacture one */ });
    } catch (_) { /* same */ }
  });
}

/**
 * Sets up the whole sync layer and returns the state object (the probe needs it).
 * To be called LAST in `main.ts`: `syncBoot()` can adopt a plan, so everything that paints and
 * everything that listens must already be wired.
 */
export function brancherFil(ctx: Contexte): Fil {
  const fil = creerFil();

  // ---- what `save()` triggers downstream (js/07 -> js/41 + js/42) -------------------------------
  // Covered by: `repli-d1-live` (the PUT goes out), `collab-annuler` (the diff goes out), `plan-abime`
  // (nothing goes out before the first read).
  ctx.crochets.publierD1 = () => syncOnSave(ctx, fil);
  ctx.crochets.publierFil = () => wsOnSave(ctx, fil);
  // The freshness counter runs EVEN during a gesture: without it, adopting a remote plan became
  // permitted again 2.5 s after a drag started, mid-gesture.
  ctx.crochets.toucherFraicheur = () => syncTouchLocal(fil);

  // ---- C-14: the ATOMIC publication of the whole plan, BEFORE `save()` --------------------------
  // Covered by: `model-v5-fil-serveur` (fresh household bootstrapped), `run` (import propagated).
  ctx.crochets.publierPlanEntier = () => wsMaybeReplace(ctx, fil);

  // ---- C-6: the mirror follows the freshly adopted state ------------------------------------------
  // `applyReplacedState` calls it EXCEPT for an undo (`keepShadow`), which must publish by DIFF.
  // Covered by: `collab-annuler` (undo with two people).
  ctx.crochets.resyncMiroir = () => wsShadowSync(ctx, fil);

  // ---- C-17: what the gesture's exit replays ------------------------------------------------------
  // Covered by: `interactions` (`remote_replace_during_drag`).
  ctx.crochets.appliquerOpFile = (op: unknown) => { wsApplyRemoteOp(ctx, fil, op as Op); };

  // ---- D-3: the tab detaches from sharing -----------------------------------------------------
  ctx.crochets.detacherSynchro = () => {
    fil.detached = true;                                   // no more op, PUT, or poll goes out
    try { fil.ws?.close(); } catch (_) { /* already gone */ }
    setSyncChip(fil, "local");
  };

  // ---- dragging a piece of furniture: ephemeral ghosts, diff suspended ---------------------------
  // The old client had `beginGesture`/`endGesture` carried by `window.__wsDragStart`, so
  // collaboration decided, without saying so, when `save()` falls silent. We keep the coupling, it
  // is real, but we write it down: the gesture flag AND the diff flag are set in the same place.
  ctx.crochets.dragStart = () => { fil.wsDragActive = true; beginGesture(); };
  ctx.crochets.dragEnd = () => { fil.wsDragActive = false; endGesture(); };
  ctx.crochets.emitDrag = (p: unknown) => wsEmitDrag(fil, p as Parameters<typeof wsEmitDrag>[1]);
  ctx.crochets.emitDragMulti = (l: unknown[]) =>
    wsEmitDragMulti(fil, l as Parameters<typeof wsEmitDragMulti>[1]);

  // ---- after every paint: cursors reproject, ghosts reapply --------------------------------------
  // `renderPieces` just rebuilt the nodes: without this callback, a re-render FROZE the piece that
  // a peer is currently dragging, and cursors stayed at their pre-zoom position.
  // We WRAP the hook set by E3b (opening handles), we do not replace it.
  const apresRenduPrecedent = ctx.crochets.apresRendu;
  ctx.crochets.apresRendu = () => {
    apresRenduPrecedent?.();
    wsReprojectCursors(ctx, fil);
    wsApplyGhostsToDOM(ctx, fil);
  };

  // ---- C-8: the device label comes from the server when it gives one ----------------------------
  brancherTagServeur(() => fil.wsMe.tag);

  brancherRapportErreur();
  brancherChat(fil);
  brancherCurseursSortants(ctx, fil);
  brancherHud(fil);

  // THE ORDER OF THESE THREE LINES IS THE ONE FROM THE OLD MANIFEST, AND IT HAD TO BE VERIFIED.
  // Intuition says "the D1 fallback first, real time second"; the manifest says the opposite.
  // `js/45` (last line: `if(SYNC_ON){ wsConnect(); }`) is evaluated BEFORE `js/46-init`, which is
  // placed in SECOND-TO-LAST position and calls `syncBoot()`. The connection is therefore OPENED
  // first, and that is precisely what makes the C-1 race possible: the GET goes out while the
  // socket is already in the process of establishing, and the `hello` can beat it. The
  // `if (wsLive())` guard at the top of `syncBoot` only makes sense in that order; reversing it
  // would make the race rarer without closing it, hence harder to reproduce.
  demarrerFil(ctx, fil);
  syncBoot(ctx, fil);
  brancherSondage(ctx, fil);

  return fil;
}
