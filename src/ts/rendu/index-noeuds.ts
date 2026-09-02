// src/ts/rendu/index-noeuds.ts: UN INDEX PAR RECONCILIATION, PLUS UNE REQUETE PAR OBJET.
//
// La reconciliation cherchait son noeud objet par objet
// (`container.querySelector('.piece[data-id="…"]')`). Sur le plan mesure par `tests/rendu-perf.ts`
// (200 meubles, 30 ouvertures) cela faisait 230 requetes de selecteur par image, et chacune
// reparcourt le calque. Un seul `querySelectorAll` construit la table entiere, et la boucle n'y
// fait plus que des lectures de Map.
//
// LA CLE EST LA CHAINE BRUTE, PAS UN SELECTEUR ECHAPPE. `cssId` existait pour qu'un identifiant
// contenant un guillemet ou un espace ne casse pas le selecteur; une Map n'a pas ce probleme,
// donc l'echappement disparait avec la requete. Le premier noeud gagne en cas de doublon, comme
// `querySelector` le faisait.

/** Table `data-id` -> noeud, pour tous les noeuds de `container` qui repondent a `selecteur`. */
export function indexerParId(container: HTMLElement, selecteur: string): Map<string, HTMLElement> {
  const table = new Map<string, HTMLElement>();
  container.querySelectorAll<HTMLElement>(selecteur).forEach((n) => {
    const id = n.dataset["id"];
    if (id != null && !table.has(id)) table.set(id, n);
  });
  return table;
}
