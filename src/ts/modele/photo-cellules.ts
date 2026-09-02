// src/ts/modele/photo-cellules.ts — LA PHOTO DES CELLULES, PRISE AU DÉBUT DU GESTE.
//
// Le sol est peint à partir des CELLULES, et les cellules sont DÉRIVÉES des murs: les recalculer à
// chaque image est ce qui fait suivre le sol sous la main (`v5ResoudreGeometrie`). Mais un nom et un
// sol de cellule ne sont PAS dérivés: ils survivent au recalcul par appariement d'aire
// (`v5AssignNames`). Recalculer à chaque image fait donc traverser au plan tous les états
// INTERMÉDIAIRES, et l'appariement s'y ferait de proche en proche: un mur qui balaie une pièce la
// fait fusionner avec sa voisine, la fusion ne garde qu'un nom des deux, et quand la pièce se
// rouvre le nom perdu ne revient plus. La géométrie, elle, revient exactement où elle était. Un
// « Chambre d'Élise » saisi à la main disparaîtrait pour de bon, pour un aller-retour.
//
// C'est le raisonnement déjà écrit pour les bornes (AGENTS.md, « les bornes appartiennent à
// l'AUTEUR du geste »): on applique une fois, sur la géométrie FINALE, parce que passer par tous
// les états intermédiaires accumule une dérive définitive. Même règle ici, pour les noms: on
// photographie les cellules AU DÉBUT du geste, et TOUT recalcul du geste (les images comme le
// relâchement) apparie depuis cette photo, jamais depuis l'état intermédiaire précédent. Pendant le
// geste l'appariement peut être approximatif, il n'est que du rendu; au relâchement il est exact,
// parce qu'il repart de l'avant-geste.
//
// POURQUOI ICI ET PAS AILLEURS. La photo est posée et relâchée par `gestes/sortie.ts`, qui est le
// point d'entrée ET l'unique point de sortie d'un geste (`beginGesture` / `armGesture` /
// `endGesture`, invariant G-1): tout autre endroit serait un des N gestes, donc N occasions
// d'oublier de la relâcher. Elle vit dans SON module, et pas dans `sortie.ts`, pour que
// `modele/cellules.ts` puisse la lire sans dépendre des gestes.
//
// ET ELLE EST ATTACHÉE À SON PLAN. Un remplacement complet de plan reçu pendant un geste
// (`plan5.replace`, adoption) est mis en file et appliqué à la fin, mais `v5SetModel` peut poser un
// AUTRE objet plan: apparier les cellules de ce nouveau plan depuis la photo de l'ancien
// écrirait des noms d'un plan sur les pièces d'un autre. `photoCellules(P)` ne rend donc la photo
// que si elle a été prise sur CE plan-là.

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
