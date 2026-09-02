// src/ts/main.ts: THE NEW CLIENT'S BOOTSTRAP.
//
// Ported from src/js/02-etat-migrations.js (the `state` bootstrap block), from src/js/07 (`load`)
// and from src/js/46-init.js (the initialization, evaluated last in the old manifest).
//
// WHAT THIS BATCH (E3a, RENDERING) SETS UP, AND NOTHING ELSE:
//   read the saved plan (any format), convert it, frame it, PAINT it, and track window
//   resizes.
// WHAT IT DOES NOT SET UP, AND THAT IS DELIBERATE: persistence (no local write is done
//   by this client, so it can damage NOTHING on the household's device), gestures, the
//   D1 sync, the realtime wire, the setup assistant, export, the Circulation engine. Each will
//   come with its own batch; the wiring point is already there
//   (`ctx.gestes`, `ctx.crochets`).
//
// EVALUATION ORDER IS NO LONGER AN IMPLICIT CONTRACT. The old client had "three initialization
// errors in the temporal dead zone" and a manifest to respect down to the module. Here the
// `import` graph makes the order, and a cycle would be a compile error.

import { creerContexte } from "./app/contexte.ts";
import type { Contexte } from "./app/contexte.ts";
import type { Fil } from "./fil/etat.ts";
import type { Etat } from "./modele/etat.ts";
import type { Options } from "./modele/migrations.ts";
import { cleanOpts } from "./modele/migrations.ts";
import { defaultState, migrate } from "./modele/etat.ts";
import { downloadRescued, rescueUnreadable, v5BackupLegacy } from "./modele/filets.ts";
import { KEY, KEY_OLD, KEY_V2, KEY_V3, OPTS_KEY, keyPourMode } from "./noyau/nombres.ts";
import { $, el } from "./noyau/dom.ts";
import { aptBBox, aptToScreen, brancherRendu, fitView, renderView } from "./rendu/vue.ts";
import { render } from "./rendu/rendu.ts";
import { renderRoomChips } from "./rendu/puces-rail.ts";
import { installerSonde } from "./sonde.ts";
import { installerToasts } from "./app/toast.ts";
import { save } from "./app/persistance.ts";
import { beginGesture, brancherSortieGestes, endGesture } from "./gestes/sortie.ts";
import { brancherGestes } from "./gestes/branchement.ts";
import { brancherInteractionsVue } from "./gestes/vue-interactions.ts";
import { brancherClavier } from "./gestes/clavier.ts";
import { brancherBoutonsHistorique, jeterHistoriqueVide } from "./historique/pile.ts";
import { brancherPlanIdentite } from "./fil/identite.ts";
import { brancherOutilsMurs } from "./gestes/murs.ts";
import { brancherPalette } from "./gestes/pose.ts";
// G-22: without thumbnails, placement does not exist. The palette is built here, at minimum, so
// that drag-and-drop from a thumbnail is provable; search and section collapse come along with
// it (buildPalette calls them at construction).
import { applyPaletteFilter, buildPalette, setPaletteQuery, toggleCat } from "./rendu/palette.ts";
import { v5DrawOpeningResize } from "./gestes/ouverture.ts";
// ---- BATCH E3c: the panels, the assistant, the measuring tape, export, Circulation ------------------
// Each sub-batch has ITS OWN module and ITS OWN probe file: nothing is wired up anywhere but
// here, and no two sub-batches share a file.
import { brancherInspecteur } from "./panneaux/inspecteur.ts";
import { brancherFicheCellule } from "./panneaux/fiche-cellule-edition.ts";
import { brancherConfiguration } from "./panneaux/configuration.ts";
import { brancherMenuPied } from "./panneaux/menu-pied.ts";
import { brancherPlans } from "./panneaux/plans.ts";
import { brancherPartage } from "./panneaux/partage.ts";
import { brancherRetour } from "./panneaux/retour.ts";
import { brancherMesure } from "./mesure/mesure.ts";
import { brancherExport } from "./exportation/exportation.ts";
import { brancherCirculation } from "./circulation/circulation.ts";
import { brancherOptions, direPlanIllisible } from "./app/options.ts";
import { brancherAide } from "./app/aide.ts";
import { brancherDiagnostics } from "./app/diagnostics.ts";
import { EMBEDDED } from "./exportation/transfert.ts";
import { brancherFil } from "./fil/branchement.ts";
import { modeCourant, planCourant, planIdInvite, estInvite } from "./fil/drapeaux.ts";
import {
  entrerImpasseInvite, entrerLocalSeul, finirGuestOnboarding, nomInviteConnu, oublierPorteLocale,
  ouvrirEtapeNomInvite, preparerAccueil,
} from "./fil/invite.ts";

/** The saved blob, AS-IS, tried in the order of the four historical keys (js/07, `load`). */
function lireBrut(): string | null {
  try {
    const k = keyPourMode(modeCourant(), planIdInvite() || planCourant());
    // THE THREE HISTORICAL KEYS ARE READ ONLY FOR `main`, ON THE HOUSEHOLD DOOR. A fresh plan
    // must inherit NOTHING: falling back to `room-planner-v3` would make it display the
    // apartment from two versions ago instead of opening the outline assistant. Batch 3: the
    // SAME reasoning now also applies to every key `keyPourMode` returns off the household
    // door, an invited or local-only key never inherits from these either.
    if (k !== KEY) return localStorage.getItem(k);
    return localStorage.getItem(KEY) || localStorage.getItem(KEY_V3)
      || localStorage.getItem(KEY_V2) || localStorage.getItem(KEY_OLD) || null;
  } catch (_) { return null; }
}

/**
 * The PERSONAL SETTINGS (D-7). They describe the person's SCREEN, not the apartment, and NEVER
 * cross over, in either direction. The saved plan's `opts` only serves as a SEED, once, and the
 * personal key always wins.
 *
 * This batch PERSISTS nothing: it reads the key without ever writing it back. `saveOpts` will
 * come with the persistence batch.
 */
function bootOpts(seed: Partial<Options> | null | undefined): Options {
  let stocke: Partial<Options> | null = null;
  try {
    const s = localStorage.getItem(OPTS_KEY);
    stocke = s ? (JSON.parse(s) as Partial<Options>) : null;
  } catch (_) { stocke = null; }
  return cleanOpts(stocke || seed);
}

/**
 * Returns `{ctx, fil}` (batch 3): `demarrer()` needs both, right after this call, to wire the
 * two guest-door crochets (`accesRefuseSansInvite`/`accesRefuseInvite`) before any network
 * response can possibly arrive, and, for an already-redeemed invitation, to finish onboarding
 * (`finirGuestOnboarding`).
 */
function amorcer(): { ctx: Contexte; fil: Fil } {
  const brut = lireBrut();
  const hadSaved = !!brut;
  let charge: unknown = null;
  try { charge = brut ? JSON.parse(brut) : null; } catch (_) { charge = null; }

  // D-3. THE PRE-CONVERSION BLOB, COPIED VERBATIM, ONCE, BEFORE ANY WRITE. It can only be taken
  // HERE: as soon as `save()` has run once, the key carries the CONVERTED plan and the
  // original no longer exists anywhere.
  try { v5BackupLegacy(brut); } catch (_) { /* storage denied: see the #storeChip badge */ }

  const migre = migrate(charge);
  // D-2. A record that is present but UNREADABLE is not a plan, and it is not "no plan" either.
  // It is set aside AS-IS under its own key, before anything replaces it, and `setupDone` falls
  // back to false: no publication can start from a device that failed to read back its plan.
  const illisible = !migre && hadSaved;
  const bootIllisible = illisible ? rescueUnreadable(brut) : null;
  const etat: Etat = migre || defaultState();
  if (etat.setupDone === undefined) etat.setupDone = hadSaved && !illisible;
  etat.opts = bootOpts(etat.opts);

  const ctx = creerContexte(etat, el("canvas"), el("viewport"));
  // The plan is painted into ONE container, the layer: the canvas carries the class permanently.
  ctx.canvas.classList.add("v5");
  // NO CELL IS SELECTED AT BOOT, and this is measured: `v5UI().selCell` stays null as long as
  // nobody has clicked. It is `v5SetModel` (import, adoption, restore) that sets the first cell,
  // and it is not called at load. Setting `cells[0]` here used to mark the first room's label
  // as `.focused` on the household's plan, the only difference caught by the render fingerprint
  // for this batch. The card, though, already falls back to the first one (R-13).

  brancherRendu(() => render(ctx));

  // ---- GESTURES (batch E3b) ---------------------------------------------------------------------
  // The order of these lines is NOT an implicit contract: these are wiring calls, not
  // declarations, and the `import` graph has already made the evaluation order.
  // THE REPORTER FIRST: it must be wired up BEFORE everything else, otherwise an error thrown
  // during a wiring call would be seen by nobody (neither banner nor `plan-errors` ring, and
  // therefore not by the suites either, which read it back after each case).
  brancherDiagnostics(ctx, () => fitView(ctx));
  installerToasts(ctx.viewport);
  brancherSortieGestes(ctx);
  brancherPlanIdentite(() => ctx.etat.plan);
  // `render()` calls `persister`: this is the old client's `save()`, with its two outputs in
  // mind (VIEW render, live gesture). Without it, a gesture would leave no trace on reload.
  ctx.crochets.persister = () => save(ctx);
  // In the old client, `beginGesture`/`endGesture` were called for a FURNITURE drag only by
  // `window.__wsDragStart` / `__wsDragEnd` (js/44): collaboration carried, without saying so,
  // the flag that silences `save()` during a gesture. This coupling is made explicit here; the
  // collaboration batch will WRAP these two hooks instead of replacing them.
  ctx.crochets.dragStart = () => beginGesture();
  ctx.crochets.dragEnd = () => endGesture();
  // G-3 + G-12: Escape must not leave a no-op entry on the undo stack (see the crochet's own doc).
  ctx.crochets.jeterHistoriqueVide = () => jeterHistoriqueVide(ctx);
  // The inspector wires itself up further down (batch E3c) and sets `openInspector` /
  // `syncInspector` / `hideInspector` itself. The fallback below is the default value: a panel
  // that closes.
  ctx.crochets.hideInspector = () => { const i = $("inspector"); if (i) i.hidden = true; };
  // G-19. An OPENING's width handles are repainted after every layer render. The old client
  // wrapped `renderV5` for this (js/56, hence its imposed position in the manifest); a named
  // call point says the same thing without an ordering constraint.
  ctx.crochets.apresRendu = () => v5DrawOpeningResize(ctx);

  brancherGestes(ctx);
  brancherInteractionsVue(ctx);
  brancherClavier(ctx);
  brancherOutilsMurs(ctx);
  buildPalette(ctx);
  brancherPalette(ctx);
  $("palette")?.addEventListener("click", (e) => {
    const h = (e.target as Element | null)?.closest<HTMLElement>("#palette .pcat");
    if (h) toggleCat(ctx, String(h.dataset["cat"]), () => save(ctx));
  });
  const rech = $("palSearch") as HTMLInputElement | null;
  rech?.addEventListener("input", () => setPaletteQuery(ctx, rech.value || ""));
  applyPaletteFilter(ctx);
  brancherBoutonsHistorique(ctx);

  // ---- THE PANELS AND THE REST OF THE UI (batch E3c) -----------------------------------------
  // One wiring call per sub-batch, in its own module. The order of these seven lines is not a
  // contract: these are wiring calls, not declarations.
  brancherOptions(ctx);
  brancherAide(ctx);
  brancherInspecteur(ctx);
  brancherFicheCellule(ctx);
  brancherConfiguration(ctx);
  brancherMenuPied(ctx);
  brancherPlans(ctx);
  brancherPartage(ctx);
  brancherRetour();
  brancherMesure(ctx);
  brancherExport(ctx);
  // VERBATIM AND LAST: the Circulation engine is neither touched nor reordered (§7.4).
  brancherCirculation(ctx);

  // D-2. An unreadable local plan is STATED, on screen, and in two places (the assistant does
  // not always open). The panels must be wired up before this: the recovery button lives in
  // the assistant's banner.
  if (bootIllisible) direPlanIllisible(ctx, bootIllisible, () => downloadRescued(EMBEDDED));

  renderRoomChips(ctx, true);

  // R-15. A RESIZE ONLY REFRAMES IF IT BROKE THE FRAMING. We compare the CURRENT transform
  // against the OLD viewport size, remembered: we only reframe if the plan fit BEFORE and no
  // longer fits AFTER. Portrait -> landscape left half the plan below the bottom edge,
  // 1680x1000 -> 900x700 overflowed by 544 px on the right; but reframing unconditionally would
  // snap away the view of someone who had deliberately zoomed in.
  let prevVW = ctx.viewport.clientWidth, prevVH = ctx.viewport.clientHeight;
  const fitsIn = (w: number, h: number): boolean => {
    try {
      const b = aptBBox(ctx);
      const a = aptToScreen(ctx, b.minX, b.minY), c = aptToScreen(ctx, b.maxX, b.maxY);
      return a.x >= -1 && a.y >= -1 && c.x <= w + 1 && c.y <= h + 1;
    } catch (_) { return false; }
  };
  let rt: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      const tenaitAvant = fitsIn(prevVW, prevVH);
      const w = ctx.viewport.clientWidth, h = ctx.viewport.clientHeight;
      prevVW = w; prevVH = h;
      if (tenaitAvant && !fitsIn(w, h)) fitView(ctx); else renderView(ctx);
    }, 80);
  });

  fitView(ctx);   // initial view = the whole apartment (goes through renderView: the VIEW persists nothing)
  // ...SO BOOT PERSISTENCE IS EXPLICIT HERE (js/46-init, same line). Without it, a plan in the
  // OLD format that was read and converted at load stays, in `localStorage`, in the old format:
  // the conversion is redone on every open, and the PERSONAL SETTINGS carried over from that old
  // blob are never copied back into their own key (`room-planner-opts`, D-7). Measured by
  // `model-v5-conversion-rendu` (`v5_saved_payload_is_walls_only`) and `model-v5-ancien-plan`
  // (`opts_migration_depuis_l_ancien_blob`).
  save(ctx);

  // ---- BATCH E4: SYNC AND COLLABORATION -------------------------------------------
  // LAST, and this is not a style detail: `syncBoot()` can ADOPT the household's plan, so
  // everything that paints, everything that listens, and the assistant must already be wired
  // up. This is the same position as in the old manifest (`js/46-init`, second to last, called
  // `syncBoot()`). It is also what gives the client a property the previous batch did not have:
  // from here on, it WRITES to the shared plan. Under `file://` and in an iframe, `SYNC_ON` is
  // false and nothing goes out, which is what lets the suites run without ever touching the
  // household's plan.
  const fil = brancherFil(ctx);

  installerSonde(ctx, fil);
  return { ctx, fil };
}

/**
 * BATCH 3. `preparerAccueil()` runs BEFORE anything else: it captures a `#k=` token (or a
 * remembered one), redeems it, and blocks on the name step if one is shown, nobody reaches the
 * wire unnamed. It resolves `false` only when the dead end already covers the whole screen, in
 * which case `amorcer()` never runs at all: "there is no planner behind it" is not a figure of
 * speech. On the household door (and on a guest door with no token yet, which only reveals
 * itself later) it resolves `true` immediately, so nothing here changes anyone else's boot.
 *
 * The two crochets are wired UNCONDITIONALLY, right after `amorcer()` returns and therefore
 * still inside this synchronous tick: no network response, the one thing that could call them,
 * can possibly have arrived yet. On the household door neither is ever invoked.
 */
async function demarrer(): Promise<void> {
  const suite = await preparerAccueil();
  if (!suite) return;
  const { ctx, fil } = amorcer();
  ctx.crochets.accesRefuseSansInvite = () => entrerLocalSeul(ctx, fil);
  ctx.crochets.accesRefuseInvite = () => entrerImpasseInvite(fil);
  ctx.crochets.porteMenageConfirmee = () => oublierPorteLocale();
  ctx.crochets.guestSansNom = () => ouvrirEtapeNomInvite(fil);
  ctx.crochets.guestNomLocal = () => nomInviteConnu();
  if (estInvite()) finirGuestOnboarding(ctx, fil);
}

void demarrer();
