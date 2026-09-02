// src/ts/modele/creation.ts: BEING BORN: `mk()` and automatic naming.
// Porté de src/js/07-pieces-persistance.js (`mk`, `autoName`, `aptToLayerPx`).
//
// R-3. A PIECE OF FURNITURE IS BORN WITH ITS TYPE'S LABEL, sometimes numbered ("Table 2",
// "Lit (160) 2"). That name teaches nothing the icon does not already say: it is `isChosenName`
// (rendu/noms.ts) that decides whether to display it, by comparing against the base of the
// CURRENT label **and** against HISTORICAL labels. Here we only manufacture it.

import type { Meuble, PlanV5 } from "../partage/plan.ts";
import { TYPEMAP, baseName } from "../catalogue/catalogue.ts";
import { v5NewId } from "../fil/identite.ts";

// THE OBJECT COUNTER, AND WHY IT IS A MODULE-LEVEL COUNTER.
// It numbers the furniture this client creates. It starts from `Date.now()` so an identifier
// drawn today cannot collide with one drawn yesterday and already recorded in the household's
// plan: resetting it to zero between two sessions would hand out identifiers that already exist.
let uid = Date.now();

/**
 * RESETS THE COUNTER TO A KNOWN VALUE. The only consumer is the compatibility oracle
 * (`tests/compat-donnees.ts`), which reads back dozens of documents in a single process and
 * requires that a read owe NOTHING to the previous one: without this, the corpus's order would
 * change the identifiers drawn, hence the fingerprints, and the oracle would become a coin toss.
 * THE APPLICATION NEVER CALLS THIS, and must never call it.
 */
export function reglerCompteurs(nouvelUid: number): void {
  uid = nouvelUid;
}

/** The next OBJECT identifier. */
export function prochainUid(): number {
  return ++uid;
}

/**
 * If the name's base already exists, returns "Base 2", "Base 3"... NEVER renumbers an existing
 * piece of furniture, and takes the smallest free suffix. `excludeId` = a piece to ignore (rename).
 */
export function autoName(P: PlanV5 | null | undefined, base: unknown, excludeId?: unknown): string {
  const b = baseName(base);
  const pieces = (P && P.pieces) || null;
  if (!Array.isArray(pieces)) return b;
  const names = new Set(pieces.filter((p) => p.id !== excludeId).map((p) => p.name));
  if (!names.has(b)) return b;
  let n = 2; while (names.has(b + " " + n)) n++;
  return b + " " + n;
}

/** A new piece of furniture, catalog dimensions, placed at (x,y) apartment cm (top-left corner). */
export function mk(P: PlanV5 | null | undefined, type: string, x: number, y: number): Meuble {
  const t = TYPEMAP[type];
  const p = {
    id: String(prochainUid()), type, name: autoName(P, t ? t.name : type),
    x, y, w: (t && t.w) || 60, h: (t && t.h) || 60, rot: 0, locked: false,
  } as Meuble & { hinge?: number; swing?: number };
  if (type === "door" || type === "sdoor") p.hinge = 0;
  if (type === "door") p.swing = 1;   // 1 = opens inward (+y), -1 = opens outward
  return p;
}

/**
 * What placing and pasting a WALL-MOUNTED object must supply to `modele/edition.ts`: an
 * identifier (with its device tag, C-8) and a name free of duplicates. Both depend on the live
 * plan, which `edition.ts` already receives as an argument; passing them together avoids
 * reintroducing global state there.
 */
export function fabriqueOuverture(P: PlanV5 | null | undefined): {
  newId(prefix: string): string;
  autoName(base: string): string;
} {
  return {
    newId: (prefix: string) => v5NewId(prefix),
    autoName: (base: string) => autoName(P, base),
  };
}

// `aptToLayerPx` (js/07) lives in `gestes/guides.ts`, with its only consumers (guides, dimensions,
// alignment safety nets): duplicating it here would make two truths for a single conversion.
