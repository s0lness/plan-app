// src/ts/panneaux/renommer-en-ligne.ts: RENAMING ON THE NAME ITSELF, WHEREVER IT'S SHOWN, not a
// panel's name field: looking away to a side panel while double-clicking a name means already
// losing sight of the object. A room's name is renamed from FOUR spots by the same ONE function
// (`renommerCelluleEnLigne`, no second copy): its label on the plan, the room card's title
// (`#rcName`, `panneaux/fiche-cellule-edition.ts`), the rail's chip (`rendu/puces-rail.ts`), and
// a piece of furniture's own label answers the same way via `renommerMeubleEnLigne`.
//
// THE FIELD DOES NOT LIVE IN THE LAYER: labels (`renderPieces`, `renderEtiquettesCellules`) are
// REBUILT on every render, which can fire for any reason (a peer's op, circulation analysis, a
// hover), so an `<input>` dropped into the layer
// would be destroyed mid-word. It's placed in the VIEWPORT, on top, at the label's SCREEN
// position (`position:fixed`, so this holds whether the target itself is inside the canvas
// viewport or in a side panel), so renders pass underneath without touching it. Price: it
// doesn't follow zoom/pan, so it closes and VALIDATES on the first wheel tick or view drag.

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
  /** The label element itself: the field borrows its typography and hides it while typing, so
   *  what the person sees is the name turning editable IN PLACE, not a box landing on it. */
  el: HTMLElement;
  valeur: string;
  /** Writes the new name. Returns `true` if something changed. */
  ecrire: (nom: string) => boolean;
  /** Runs AFTER a successful write, once `render(ctx)` already ran: for a caller whose own
   *  display isn't part of the render pipeline (the furniture list's modal snapshot, built once
   *  by `openFurni` and never resynced by `render()`), so its own copy of the name doesn't go
   *  stale until the modal is reopened. */
  apres?: (nom: string) => void;
}

function ouvrir(ctx: Contexte, c: Cible): void {
  fermerRenommage(true);
  const vp = ctx.viewport;
  const inp = document.createElement("input");
  inp.type = "text";
  inp.className = "label-edit";
  inp.maxLength = NAME_MAX;
  inp.value = c.valeur;
  // BROWSER coordinates, not "relative to `vp`'s own box": a room's name is now renamed
  // wherever it's shown, including OUTSIDE the canvas viewport (the room card's title, the
  // rail's chip), not just on the plan's own label. `.label-edit` is `position:fixed`
  // (08-inspecteur-fiche.css), so `c.rect`'s client coordinates place it correctly no matter
  // which of the three it came from. It still gets APPENDED to `vp`: that's what keeps it
  // riding above a render that rebuilds the plan's own labels underneath it (see file top).
  inp.style.left = (c.rect.left + c.rect.width / 2) + "px";
  inp.style.top = (c.rect.top + c.rect.height / 2) + "px";
  // IN PLACE MEANS INVISIBLE AS A FIELD: same font, size, weight, colour and alignment as the
  // label it replaces, the label's own width plus a little room to type, and the label hidden
  // underneath. What the person sees is the name turning editable, not a box landing on it.
  const cs = getComputedStyle(c.el);
  inp.style.font = cs.font;
  inp.style.letterSpacing = cs.letterSpacing;
  inp.style.color = cs.color;
  inp.style.textAlign = cs.textAlign;
  inp.style.width = Math.max(24, Math.round(c.rect.width) + 12) + "px";
  inp.style.height = Math.round(c.rect.height) + "px";
  const visibiliteAvant = c.el.style.visibility;
  c.el.style.visibility = "hidden";
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
    c.el.style.visibility = visibiliteAvant;
    _fermer = null;
    window.removeEventListener("wheel", surVue, true);
    window.removeEventListener("pointerdown", surDehors, true);
    if (!valider) { render(ctx); return; }
    if (c.ecrire(nom)) {
      v5Touch(ctx);
      render(ctx);
      ctx.crochets.persister?.();
      c.apres?.(nom);
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
    el: etiquette,
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

/** Rename a CELL, on its label. `apres` (optional): see `Cible.apres`. */
export function renommerCelluleEnLigne(
  ctx: Contexte, id: string, etiquette: HTMLElement, apres?: (nom: string) => void,
): void {
  const P = ctx.etat.plan;
  const c = (P.cells || []).find((q) => String(q.id) === String(id));
  if (!c) return;
  const avant = String(c.name || "");
  ouvrir(ctx, {
    rect: etiquette.getBoundingClientRect(),
    el: etiquette,
    valeur: avant,
    ecrire: (nom) => {
      if (!nom || nom === avant) return false;
      pushHistory(ctx);
      c.name = nom;
      return true;
    },
    // `exactOptionalPropertyTypes`: an explicit `undefined` is not the same as an absent key.
    ...(apres ? { apres } : {}),
  });
}

void $;
