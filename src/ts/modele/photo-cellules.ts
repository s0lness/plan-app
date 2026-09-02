// src/ts/modele/photo-cellules.ts: LA PHOTO DES CELLULES, PRISE AU DÉBUT DU GESTE.
//
// Les cellules sont DÉRIVÉES des murs et un nom/sol de cellule survit au recalcul par appariement
// d'aire (`v5AssignNames`). Recalculer à chaque image ferait apparier depuis chaque état
// INTERMÉDIAIRE (un mur qui fusionne puis rouvre une pièce perdrait le nom saisi à la main), donc
// on photographie les cellules AU DÉBUT du geste et tout recalcul du geste apparie depuis cette
// photo, jamais depuis l'état précédent (même raisonnement que les bornes, G-1: une fois, sur la
// géométrie finale).
//
// Posée et relâchée par `gestes/sortie.ts`, seul point d'entrée/sortie d'un geste; vit dans son
// propre module pour que `modele/cellules.ts` la lise sans dépendre des gestes. Attachée à SON
// plan: `photoCellules(P)` ne rend la photo que si elle a été prise sur ce plan-là, sinon un
// `v5SetModel` posant un autre objet plan écrirait des noms d'un plan sur les pièces d'un autre.

import type { CellulePrecedente } from "./cellules.ts";
import type { PlanV5, Pt } from "../partage/plan.ts";

let photoPlan: PlanV5 | null = null;
let photo: CellulePrecedente[] | null = null;

/** Prend la photo des cellules du plan. Idempotente: la reprendre écrase la précédente. */
export function photographierCellules(plan: PlanV5 | null | undefined): void {
  if (!plan || !Array.isArray(plan.cells)) { photoPlan = null; photo = null; return; }
  photoPlan = plan;
  // Copie PROFONDE des polygones: la photo doit décrire l'avant-geste même si quelque chose
  // mutait un point en place plus tard.
  photo = plan.cells.map((c) => ({
    name: c.name,
    floor: c.floor,
    poly: (c.poly || []).map((p) => [p[0], p[1]] as Pt),
  }));
}

/** La photo, si elle a été prise sur CE plan. `null` hors geste, ou sur un autre plan. */
export function photoCellules(plan: PlanV5 | null | undefined): CellulePrecedente[] | null {
  if (!plan || plan !== photoPlan) return null;
  return photo;
}

/** Fin du geste: la photo n'a plus cours. */
export function oublierPhotoCellules(): void { photoPlan = null; photo = null; }

// =================================================================================================
//  LES NOMS NON RETENUS: LE PURGATOIRE, QUI SURVIT AU GESTE
// =================================================================================================
// La photo ci-dessus tient un geste, et c'est ce qu'il lui faut: pendant un geste, tout recalcul
// repart de l'avant-geste, donc un aller-retour à l'intérieur d'un même geste ne perd rien.
//
// CE QU'ELLE NE COUVRE PAS. Deux pièces qui FUSIONNENT ne rendent qu'une cellule, et une cellule
// ne porte qu'un nom: le second nom n'a nulle part où aller. Au relâchement, la photo est oubliée
// et le plan ne contient plus ce nom; le geste SUIVANT, celui qui rouvre la pièce, repart donc
// d'un plan où il n'existe plus, et la pièce rouverte se nomme « Room N ». Mesuré sur trois pièces
// A|B|C séparées à x=100 et x=200: pousser la cloison de gauche à 250 puis la ramener rend bien
// la géométrie exacte, et ne rend pas le nom.
//
// D'OÙ CETTE LISTE, ET SA FORME. Les noms qu'un recalcul n'a pas su replacer y attendent, huit au
// plus, du plus récent au plus ancien, attachés au plan comme la photo l'est. Ils ne sont repris
// que si la nouvelle cellule contient le PÔLE de l'ancienne, c'est-à-dire si la pièce d'origine a
// vraiment été retrouvée, jamais sur un simple recouvrement: un nom qui erre est pire qu'un nom
// perdu. Un nom qui revient dans le plan sort de la liste, et un plan différent la vide.
const ORPHELINS_MAX = 8;
let orphelinsPlan: PlanV5 | null = null;
let orphelins: CellulePrecedente[] = [];

/** Les noms en attente pour CE plan. Vide sur un autre plan. */
export function orphelinsCellules(plan: PlanV5 | null | undefined): readonly CellulePrecedente[] {
  if (!plan || plan !== orphelinsPlan) return [];
  return orphelins;
}

/**
 * Met à jour le purgatoire après un recalcul: `perdus` entre, tout nom présent dans `gardes`
 * en sort (il est de retour dans le plan, il n'a plus besoin d'être attendu).
 */
export function memoriserOrphelins(
  plan: PlanV5 | null | undefined,
  perdus: readonly CellulePrecedente[],
  gardes: ReadonlySet<string>,
): void {
  if (!plan) { orphelinsPlan = null; orphelins = []; return; }
  if (plan !== orphelinsPlan) { orphelinsPlan = plan; orphelins = []; }
  orphelins = orphelins.filter((o) => !!o.name && !gardes.has(o.name));
  for (const p of perdus) {
    if (!p.name || !Array.isArray(p.poly) || p.poly.length < 3) continue;
    if (orphelins.some((o) => o.name === p.name)) continue;
    orphelins.unshift({ name: p.name, floor: p.floor, poly: p.poly.map((q) => [q[0], q[1]] as Pt) });
  }
  if (orphelins.length > ORPHELINS_MAX) orphelins.length = ORPHELINS_MAX;
}
