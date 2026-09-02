// src/ts/rendu/index-noeuds.ts: UN INDEX PAR RECONCILIATION, PLUS UNE REQUETE PAR OBJET (au lieu
// d'un `querySelector` par noeud, mesure a 230 requetes/image par `tests/rendu-perf.ts`).
//
// La cle est la chaine brute, pas un selecteur echappe: une Map n'a pas le probleme que `cssId`
// resolvait pour un selecteur. Le premier noeud gagne en cas de doublon, comme `querySelector`.

/** Table `data-id` -> noeud, pour tous les noeuds de `container` qui repondent a `selecteur`. */
export function indexerParId(container: HTMLElement, selecteur: string): Map<string, HTMLElement> {
  const table = new Map<string, HTMLElement>();
  container.querySelectorAll<HTMLElement>(selecteur).forEach((n) => {
    const id = n.dataset["id"];
    if (id != null && !table.has(id)) table.set(id, n);
  });
  return table;
}
