# 0015 - Sept boutons, et des curseurs qui ne parlent plus

Status: accepted, 2026-09-02. Lot 6 de `docs/simplification-2026-09-02.md`, dernier de la série.
Complète [0013](0013-une-action-un-chemin.md) sur deux points qu'elle avait délibérément laissés
en suspens (le D tenu sur un mur, l'espacement égal), et retire un mécanisme que 0013 ne
mentionnait pas: la bulle de curseur « / ».

## Contexte

Le relevé de `docs/simplification-2026-09-02.md` §1 comptait **12 éléments** dans la barre
d'outils, contre 4 à 6 chez les planificateurs comparables. Deux causes distinctes:

1. **Annuler, Refaire et Feedback occupaient une icône chacun** pour une action déjà accessible
   autrement (Ctrl+Z / Ctrl+Y pour les deux premiers) ou rare (Feedback). Le calque « circulation »
   (`btnOverlay`) et le panneau qui l'accompagne (`btnFlow`) étaient DEUX boutons pour UN concept:
   personne ne veut peindre le calque sans lire pourquoi, ni lire le panneau sans voir le calque.
2. **Deux restes des lots précédents** trainaient dans des fichiers que ce lot est le premier à
   pouvoir rouvrir: la moitié « mur » de la touche D tenue (0013 avait retiré la moitié mobilier
   et explicitement laissé l'autre, « territoire du lot voisin, pas retiré ici »), et
   `modele/repartir.ts` (0013 l'avait gardé « prêt à être rebranché », sans qu'aucun lot depuis ne
   l'ait fait).
3. **La bulle de curseur « / »** (FigJam-style: taper à côté de son curseur, visible en direct par
   les autres) n'a jamais été demandée par le propriétaire ni mentionnée dans l'aide. Elle double
   le chat (💬), déjà présent et replié par défaut, pour un geste que personne n'a signalé utiliser.

## Décision

**La barre porte sept éléments, dans cet ordre: Menu, Mur, Mesure, Ajuster, Circulation, Inviter,
Aide.** Les puces d'état (échelle, surface, synchro, pairs) restent des puces.

1. **Annuler et Refaire quittent la barre.** `Ctrl+Z` / `Ctrl+Y` sont inchangés
   (`gestes/clavier.ts`). Deux entrées rejoignent le HAUT du menu Fichier, chacune avec son
   raccourci écrit à droite (`.fm-key`). Le suivi d'état désactivé des deux boutons
   (`updateHistBtns`, `historique/pile.ts`) part avec eux: `undo()`/`redo()` ne font déjà rien sur
   une pile vide, une entrée de menu qui parfois ne fait rien n'a pas besoin d'un état séparé pour
   le dire à l'avance.
2. **Le calque « circulation » devient un état du bouton Circulation.** `btnOverlay` disparaît;
   un clic sur `btnFlow` ouvre le panneau ET peint le calque, un second clic ferme les deux.
   `Options.overlay` disparaît du client, traité exactement comme `snap` avant lui (décisions
   0011/0012): une valeur ancienne est lue et jetée par `cleanOpts`, jamais réécrite.
3. **Feedback (✉) rejoint le menu Fichier**, en dernière entrée, en texte plutôt qu'en icône.
   `#btnFeedback` garde son id, seul son parent change: `panneaux/retour.ts` n'a rien à savoir de
   l'endroit d'où on l'ouvre.
4. **La touche D disparaît entièrement.** Sa moitié mur (`murSousD`, `gestes/clavier.ts`) part
   avec le `keydown`/`keyup`/`blur` qui la tenait. Ce qu'elle montrait (longueur du mur, ses deux
   dégagements, `drawWallGuides`, `gestes/guides.ts`) s'affiche maintenant À LA SÉLECTION, câblé
   depuis `gestes/murs.ts` via le crochet `apresRendu` partagé (le même mécanisme que Circulation
   utilise pour son propre calque), plutôt que depuis `rendu/calque.ts`: un module de rendu
   n'importe pas un module de geste. Masqué pendant un geste actif sur CE mur (son propre calque
   de glisser, `v5DrawWallDims`, prend le relais).
5. **`modele/repartir.ts` et sa suite disparaissent.** Aucun appelant depuis 0013 (S4); un lot qui
   ne trouve rien pointant vers un fichier le retire, il ne continue pas de lui deviner un avenir.
   L'entrée dans `SUITES` (`tests/all.ts`) part avec.
6. **Le mode fin d'une ouverture (Shift + glisser, cinq fois plus lent, `pointSuivi`,
   `RATIO_PRECIS`, `gestes/etat-pointeur.ts`) disparaît.** Shift ne garde qu'UN sens dans toute
   l'app: contraindre (l'axe, les 15°, le pas de 10 cm). L'aide ne le mentionnait déjà plus.
7. **La bulle de curseur « / » disparaît entièrement côté client**: `fil/dire.ts` (la boîte
   flottante), sa touche, son CSS (`.say-box`, `.pc-say`), et le texte peint à côté du curseur d'un
   pair. Le message `cursor` sortant ne porte plus jamais `say`. **Le serveur ne change pas**:
   `live-worker/ops.ts` continue d'accepter et de borner `say` (`CURSOR_SAY_MAX`), parce qu'un
   onglet resté ouvert sur une build plus ancienne peut encore l'envoyer, et qu'un serveur en
   service ne doit jamais rejeter un client qu'il ne contrôle pas. Les curseurs et la présence
   eux-mêmes ne bougent pas; le chat (💬) non plus, toujours replié par défaut.

## Ce qui a été rejeté

- **Garder un bouton Overlay séparé, désactivé tant que le panneau est fermé.** Rejeté: un bouton
  qui n'a de sens que relatif à un autre est déjà la moitié du problème que 0010 avait nommé pour
  les boutons au survol d'un mur. Fusionner l'état est plus simple que d'expliquer la relation.
- **Garder le suivi de l'état désactivé d'Annuler/Refaire dans le menu.** Un `<button disabled>`
  dans un menu qui s'ouvre puis se ferme demande une resynchronisation à chaque ouverture; la
  fonction sous-jacente refuse déjà silencieusement, et un clic qui ne fait rien dans un menu qu'on
  vient d'ouvrir exprès n'est pas le genre de silence que l'app doit éviter.
- **Écrire un nouveau test navigateur pour la bulle « / » avant de la retirer.** Aucun test
  n'existait pour la moitié D-tenu du mur non plus (jamais couverte, `drawWallGuides` étant un
  effet de survol pur). Les deux suites `curseur-dire.ts` et `curseur-dire-deux-appareils.ts`, qui
  couvraient la bulle elle-même, sont supprimées avec la fonctionnalité; un test WRITTEN, NOT RUN
  (`tests/outil-mur-geste.ts`) couvre en revanche le nouveau chemin « cotes du mur à la
  sélection », parce que celui-là est un comportement qui reste dans l'app.

## Conséquences

- **En moins**: `src/ts/fil/dire.ts` (108 lignes), `src/ts/modele/repartir.ts` (141 lignes) et
  `tests/repartir-espacement.ts` (169 lignes), `tests/curseur-dire.ts`,
  `tests/curseur-dire-deux-appareils.ts`, `murSousD`/le triplet `keydown`/`keyup`/`blur` de D dans
  `gestes/clavier.ts`, `pointSuivi`/`RATIO_PRECIS`/`estPrecis` dans `gestes/etat-pointeur.ts`,
  `direTexte`/`direArreter`/`Fil.sayText` dans `fil/presence.ts` et `fil/etat.ts`, `majDireCurseur`
  et `.pc-say` dans `mesure/curseur-pair.ts`, `setOverlay`/`Options.overlay`, `updateHistBtns`,
  quatre boutons de barre (`btnUndo`, `btnRedo`, `btnOverlay`, `btnFeedback` en tant que bouton de
  barre), le CSS `.say-box`/`.pc-say`.
- **En plus**: deux entrées de menu Fichier avec raccourci affiché (`.fm-key`, ~10 lignes de CSS),
  le câblage `apresRendu` des cotes de mur dans `gestes/murs.ts` (~10 lignes), un cas dans
  `tests/outil-mur-geste.ts` (écrit, non lancé).
- **Les données ne bougent pas.** `compat-donnees` rend les mêmes empreintes: aucun de ces
  changements ne touche la géométrie, la lecture du plan, ni le fil. `Options.overlay` et l'ancien
  `Options.snap` suivent le même chemin (lus, jetés, jamais réécrits): une fixture qui porte encore
  `"overlay":false` dans un vieux blob d'opts continue de se charger sans erreur.
- **Le serveur ne change pas.** `live-worker/ops.ts` garde `CURSOR_SAY_MAX` et continue d'accepter
  le champ `say`: un onglet ouvert sur l'ancien client n'est jamais cassé par ce lot.
