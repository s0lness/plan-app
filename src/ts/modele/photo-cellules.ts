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
