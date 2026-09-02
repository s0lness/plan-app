// src/ts/panneaux/renommer-en-ligne.ts: RENAMING ON THE LABEL ITSELF, not the panel's name field:
// looking away to a side panel while double-clicking a label means already losing sight of the object.
//
// THE FIELD DOES NOT LIVE IN THE LAYER: labels (`renderPieces`, `renderEtiquettesCellules`) are
// REBUILT on every render, which can fire for any reason (a peer's op, circulation analysis, a
// hover), so an `<input>` dropped into the layer
// would be destroyed mid-word. It's placed in the VIEWPORT, on top, at the label's SCREEN
// position, so renders pass underneath without touching it. Price: it doesn't follow zoom/pan, so
// it closes and VALIDATES on the first wheel tick or view drag.

import type { Contexte } from "../app/contexte.ts";
import { pieceById, v5Touch } from "../app/contexte.ts";
import { $ } from "../noyau/dom.ts";
import { NAME_MAX } from "../partage/contrat-serveur.ts";
import { pushHistory } from "../historique/pile.ts";
import { render } from "../rendu/rendu.ts";

// ONLY ONE INPUT AT A TIME: `_fermer` closes the previous one before opening another, and
// that is all this module needs to remember.
//
// A `renommageEnCours()` had also been exported "so gestures don't trample the input."
// It NEVER had a caller, and did not need one: `keydown`'s `stopPropagation` already
// protects the plan's shortcuts (Delete, R, arrows). A guard nobody calls protects
// nothing, it just gives the impression that something is protected.
let _fermer: ((valider: boolean) => void) | null = null;

/** Closes the current input if there is one. `valider` = write, otherwise discard. */
function fermerRenommage(valider: boolean): void { _fermer?.(valider); }

interface Cible {
  /** The label's SCREEN rectangle, to place the field exactly on top of it. */
  rect: DOMRect;
  valeur: string;
  /** Writes the new name. Returns `true` if something changed. */
  ecrire: (nom: string) => boolean;
}

function ouvrir(ctx: Contexte, c: Cible): void {
  fermerRenommage(true);
  const vp = ctx.viewport;
  const vr = vp.getBoundingClientRect();
  const inp = document.createElement("input");
  inp.type = "text";
  inp.className = "label-edit";
  inp.maxLength = NAME_MAX;
  inp.value = c.valeur;
  inp.style.left = (c.rect.left - vr.left + c.rect.width / 2) + "px";
  inp.style.top = (c.rect.top - vr.top + c.rect.height / 2) + "px";
  // The width follows the label, with a floor: a short name must not produce a
  // three-pixel field where you cannot see what you're typing.
  inp.style.width = Math.max(96, Math.round(c.rect.width) + 24) + "px";
  vp.appendChild(inp);
  inp.focus();
  inp.select();

  let fini = false;
  const finir = (valider: boolean): void => {
    if (fini) return;
    fini = true;
    // `maxLength` bounds TYPING; the `.slice` bounds a value set PROGRAMMATICALLY (a paste, a
    // test probe): the field's old panel counterpart (`#iName`) had the same two-layer bound,
    // and a name is truncated at 80 server-side (`ops.ts`, `NAME_MAX`) regardless.
    const nom = inp.value.trim().slice(0, NAME_MAX);
    inp.remove();
    _fermer = null;
    window.removeEventListener("wheel", surVue, true);
    window.removeEventListener("pointerdown", surDehors, true);
    if (!valider) { render(ctx); return; }
    if (c.ecrire(nom)) {
      v5Touch(ctx);
      render(ctx);
      ctx.crochets.persister?.();
    } else render(ctx);
  };
  _fermer = finir;
  const surVue = (): void => finir(true);
  // A click ELSEWHERE counts as validation, as in any grid: it is the natural gesture for
  // "I'm done." A click INSIDE the field obviously must not close anything.
  const surDehors = (e: Event): void => { if (e.target !== inp) finir(true); };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finir(true); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finir(false); }
    else e.stopPropagation();   // the plan's shortcuts (Delete, R, arrows) don't type into the field
  });
  window.addEventListener("wheel", surVue, true);
  window.addEventListener("pointerdown", surDehors, true);
}

/** Rename a FURNITURE piece, on its label. */
export function renommerMeubleEnLigne(ctx: Contexte, id: string, etiquette: HTMLElement): void {
  const p = pieceById(ctx, id);
  if (!p || p.locked) return;
  const avant = String(p.name || "");
  ouvrir(ctx, {
    rect: etiquette.getBoundingClientRect(),
    valeur: avant,
    ecrire: (nom) => {
      if (!nom || nom === avant) return false;
      pushHistory(ctx);
      p.name = nom;
      // NOTHING is emitted by hand here: publication happens via diff at the next `save`.
      // Emitting here too would send the op TWICE.
      return true;
    },
  });
}

/** Rename a CELL, on its label. */
export function renommerCelluleEnLigne(ctx: Contexte, id: string, etiquette: HTMLElement): void {
  const P = ctx.etat.plan;
  const c = (P.cells || []).find((q) => String(q.id) === String(id));
  if (!c) return;
  const avant = String(c.name || "");
  ouvrir(ctx, {
    rect: etiquette.getBoundingClientRect(),
    valeur: avant,
    ecrire: (nom) => {
      if (!nom || nom === avant) return false;
      pushHistory(ctx);
      c.name = nom;
      return true;
    },
  });
}

void $;
