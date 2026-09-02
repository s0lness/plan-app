# 0017 - Une entrée de sonde sans consommateur n'est pas une sonde, c'est du code livré

Status: accepted, 2026-09-02. Lot P1 (client), revue « simplifier, retirer, accélérer ».

## Contexte
`window.__plan` expose 278 entrées réparties sur huit fichiers `src/ts/sonde*.ts` (1817 lignes).
En comptant, mot par mot, chaque nom d'entrée dans l'ensemble de `tests/` (suites navigateur
incluses, où les sondes sont lues à travers `page.evaluate`), 77 n'ont AUCUN lecteur.

Le cas de `sonde-config.ts` est le plus net, et son propre en-tête le disait : « WHAT THE OLD HOOK
EXPOSED FROM THIS BATCH: NOTHING [...] it gives the same typed view to a future suite that would
want to set a state ». Sept entrées écrites pour une suite qui n'a jamais été écrite. Elles
n'étaient pas seulement inertes : elles tenaient en vie deux ardoises (`assistant.pickShape`, et
tout l'objet `menuPied`) que rien d'autre ne lisait, et elles partaient dans le paquet servi
(`installerSonde` sort tôt sans `window.__PLAN_TEST__`, mais le code est bundlé quand même).

## Décision
Une entrée de sonde existe parce qu'une suite la lit. Sans lecteur, elle se retire, et avec elle
ce qui n'existait que pour elle.

- `src/ts/sonde-config.ts` disparaît entièrement (42 lignes, 7 entrées, zéro lecteur), ainsi que
  son câblage dans `sonde.ts` et son exemption dans `tests/exports-morts.ts`.
- `assistant.pickShape` sort de l'ardoise de `panneaux/configuration.ts` : les cartes de forme
  appellent la fonction locale directement. `assistant` garde `ouvrir`/`fermer`/`estOuvert`, qui
  ont de vrais appelants dans `fil/`.
- L'ardoise `menuPied` (`panneaux/menu-pied.ts`) disparaît : le menu se pilote au clic, et sa seule
  lectrice était la sonde supprimée.
- `sonde-flow.ts` perd `buildGrid`, `isBlocker`, `flowCounts`, `flowTotal` et `flowPill`
  (et l'interface `EtatPastille` avec eux).

## Ce qui a été rejeté
- **Retirer les 77 entrées d'un coup.** Trois d'entre elles (`scheduleAnalysis`, `drawOverlay`,
  `setFlowOpen`) sont les SEULS appelants d'exports de `circulation/`, hors zone de ce lot : les
  retirer faisait tomber `tests/exports-morts.ts` sur du code qui n'est pas à nous. Elles restent,
  avec la raison écrite sur place. Le reste (`sonde-export.ts` surtout, une vingtaine d'entrées de
  mesure et d'impression) attend un lot qui pourra suivre la cascade jusqu'au bout.
- **Garder « au cas où ».** C'est exactement l'argument qui a écrit `sonde-config.ts`.

## Conséquences
- 78 lignes de source en moins, `index.html` passe de 448 633 à 447 752 octets (−881).
- Une suite future qui voudrait piloter l'assistant sans souris devra rouvrir une sonde. C'est
  moins cher que huit fichiers dont on ne sait plus lesquels servent.
- Le compte reste vérifiable : chaque nom d'entrée doit se retrouver, mot pour mot, dans `tests/`.
