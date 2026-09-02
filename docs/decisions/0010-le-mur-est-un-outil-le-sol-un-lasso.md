# 0010 - Le mur redevient un outil, le sol redevient un lasso

Status: accepted, 2026-09-02. **Renverse** la PR #25 (« le mode murs n'existe plus ») et la PR #24
(« on survole un mur pour le manipuler »). Lot 1 de `docs/simplification-2026-09-02.md`.

## Contexte

Le propriétaire : « notre app est un peu clunky, et pourrait être simplifiée ». Le relevé
(`docs/simplification-2026-09-02.md` §1) donne le chiffre qui tranche : **9 des 20 PR d'août
portent sur les murs**, et sept d'entre elles ne corrigent qu'une seule chose, la façon dont on
attrape un mur.

Ces sept PR descendent toutes de la même décision, la PR #25 : **glisser sur le vide dessine un
mur**, et le lasso passe sous Shift. Aucun planificateur 2D comparable ne fait ça (Sweet Home 3D,
Floorplanner, RoomSketcher, Planner 5D, Coohom, magicplan, HomeByMe, Roomstyler : un mur se trace
au clic-clic avec un outil armé, et glisser sur le vide sélectionne). La conséquence était
mécanique, et elle est lisible dans l'ordre des PR :

1. le corps du mur trace, donc rater sa prise de deux pixels crée un mur par-dessus celui qu'on
   voulait déplacer (« je veux attraper le mur par le rond et ça dessine ») ;
2. il a donc fallu donner à chaque bouton une **boîte transparente de 32 px** plus large que son
   dessin ;
3. ces boîtes se recouvraient, il a donc fallu un **écart perpendiculaire** puis une règle
   « deux boîtes ne se recouvrent jamais » ;
4. sur un mur court elles ne tenaient plus, il a donc fallu **cinq paliers** décidant quel bouton
   cède en premier ;
5. les boutons étaient sous les meubles, il a donc fallu les monter à **z-index 2100** ;
6. ils volaient alors le clic des meubles, il a donc fallu une règle **dissymétrique** de survol
   (un meuble RETIENT le survol du mur, il n'en DÉMARRE jamais un) ;
7. et l'outil armé prenait le pas sur ces boutons, il a donc fallu **exempter** trois classes de
   la règle G-14, puis expliquer pourquoi deux autres n'étaient pas exemptées.

Au bout : **jusqu'à sept boutons au survol d'un mur** (disque, croix, coupe, équerre, deux bouts,
deux maillons), contre zéro chez tous les autres, qui n'offrent que deux poignées de bout à la
SÉLECTION. Chaque étage a été ajouté pour réparer l'étage précédent : ce n'est pas la zone qui est
mal codée, c'est le modèle d'interaction qui demande trop.

## Décision

**Le tracé de mur est un OUTIL qu'on arme, et le sol est un LASSO.**

- Le bouton **Mur** (`btnDrawWall`) ou la touche **W** arme l'outil ; `aria-pressed` suit, le
  calque prend la croix en curseur. Un clic pose le départ, le segment suit le pointeur avec sa
  longueur affichée à côté, un clic pose l'arrivée ET devient le départ du suivant. Double-clic,
  Entrée ou Échap termine la chaîne ; l'outil reste armé pour la suivante, un Échap de plus le
  range **et le dit**.
- Des chiffres puis Entrée posent le point à cette longueur exacte, dans la direction visée : même
  grammaire que la cote de redimensionnement, `#rszReadout` réutilisé.
- Aimants actifs par défaut (jonction exacte, sinon direction quantifiée à 45° depuis le départ),
  **Shift** ramène aux deux axes, **Alt** coupe tout aimant le temps du geste.
- **Glisser sur le vide sélectionne** (Shift ou Ctrl/Cmd ajoutent). Le clic droit et Espace+glisser
  déplacent toujours la vue.
- **Au survol, un mur n'a aucun bouton** : une surbrillance légère et le curseur `pointer`.
  L'appui le sélectionne et le déplace (seuil de 3 px : un clic net n'écrit rien).
- Un mur sélectionné porte **trois contrôles au plus** : un disque de déplacement en son milieu, et
  une poignée par bout LIBRE. Une façade ne porte que le disque, ses bouts étant les coins du
  contour, qui ont déjà leur poignée au même pixel.
- **Couper**, **Redresser** et **Supprimer** deviennent trois boutons de la **fiche du mur**, à
  côté de sa longueur. Ce qui reste sur le plan est ce qui se TIRE, parce que c'est la seule chose
  qu'une fiche ne sait pas faire.
- La grammaire de la chaîne est **pure** (`src/ts/gestes/outil-mur.ts`) et testée sans navigateur.
  L'ancienne vivait dans une fermeture de `pointerdown` : aucun test ne pouvait l'énoncer.

## Ce qui a été rejeté

- **Garder le sol qui trace et rendre les boutons plus robustes.** C'est ce qu'ont tenté les sept
  PR. Chacune a marché, et la suivante a été rendue nécessaire par la précédente. Le défaut n'est
  pas dans un bouton, il est dans le fait qu'un geste ordinaire (glisser sur le sol) écrit.
- **Garder les boutons, mais seulement sur le mur SÉLECTIONNÉ.** C'était l'état avant la PR #24, et
  il a été abandonné pour une raison réelle : après avoir tracé une cloison, ses cinq disques
  restaient flottants tant qu'elle était sélectionnée et volaient les clics du mur voisin. Le
  nombre de commandes, pas leur déclencheur, était le problème.
- **Garder le maillon qui ressoude deux murs.** Il n'existait que pour défaire une coupe faite au
  survol, et une coupe se défait déjà par Ctrl+Z. `v5WallMergeAt` reste dans le modèle : il sert
  encore au ressoudage automatique après suppression d'un mur (`v5RessouderJoints`).
- **Une palette d'outils (mur, porte, meuble…).** L'app n'a qu'un objet qui se trace ; un seul
  outil armé, un seul drapeau (`ctx.ihm.draw`), et tout le reste reste sans mode.

## Conséquences

- **En moins** : sept suites de navigateur (`mur-outil-geste`, `poignees-survol-geste`,
  `sans-mode-geste`, `facade-controles-geste`, `mur-droit-geste`, `coude-mur-geste`,
  `bouts-de-mur-geste`), les paliers, les boîtes de 32 px, le facteur, le placement anti-recouvrement,
  la moitié de `drawHandles`, la machinerie de survol différé (`planifierMasquageMur`, l'hystérésis,
  la règle dissymétrique du meuble), les exemptions de G-14, quatre familles de CSS
  (`.v5wx`, `.v5wmid`, `.v5wjoin`, `.v5wdroit`) et trois gestes (`v5MergeWallAt`, `v5SplitWallAtMid`
  et `v5RedresserMurAt` deviennent deux actions de fiche).
- **En plus** : `src/ts/gestes/outil-mur.ts` (56 lignes, pur), `tests/outil-mur-geste.ts`, deux
  boutons dans la fiche, et quatre cas dans `tests/rapide.ts`.
- **Les données ne bougent pas** : `compat-donnees` rend les mêmes 1069 empreintes. Ce lot ne
  touche ni la géométrie, ni la lecture, ni le fil.
- **Ce que ce lot ne fait PAS** : le mur traversant (`v5ThroughWall`, le bouton Through / Free) est
  le lot 2, juste après. Un segment posé se joint à ce qu'il touche exactement comme avant.

## Amendement du 2026-09-02

Le propriétaire, mot pour mot : « quand je sélectionne un mur ça m'affiche aussi le "menu" de la
pièce. je devrais juste voir le menu du mur. also je suis plutôt pour le fait de garder les
boutons sur le mur malgré tout ». Deux retours distincts, deux corrections distinctes :

- **Un panneau pour le mur, un pour la pièce, jamais les deux.** La fiche partagée (`#roomCard`,
  nom + sol + surface + longueur + actions du mur mêlés) devient DEUX cartes, sœurs dans
  `.side-panels` : `#roomCard` redevient ce qu'il était avant ce lot (nom, sol, surface, croix de
  fermeture), `#wallCard` est neuf et ne porte qu'un titre (« Wall », ou « Facade » pour un mur de
  contour) et la longueur. `syncWallCard` (`rendu/fiche-cellule.ts`) dérive la visibilité de
  `#wallCard` de `ctx.ihm.selWall` à CHAQUE `render()` (R-13) et ferme `#roomCard` tant qu'elle est
  ouverte : l'invariant tient quel que soit le chemin de code qui a changé la sélection, pas
  seulement au moment du clic. `v5SelectWall` n'a donc plus besoin de deviner une pièce voisine à
  afficher (l'ancien sondage de part et d'autre du mur, `v5CellsAt`, disparaît avec la raison
  d'être) : la carte du mur ne montre aucun champ de pièce.
- **Les boutons reviennent SUR le mur, mais seulement à la sélection.** La moitié « sept PR de
  boîtes de 32 px et de survol » de la décision ci-dessus reste vraie : aucun bouton n'apparaît au
  survol, et seul le mur SÉLECTIONNÉ en porte. Ce qui revient, c'est l'endroit où Split, Square up
  et Delete se dessinent : sur le mur (`rendu/calque.ts`, `drawHandles`), plutôt que dans la fiche
  (`#rcSplit`/`#rcSquare`/`#rcDel` disparaissent du HTML). Ils appellent les MÊMES fonctions qu'avant
  (`v5CouperMurSelectionne`, `v5RedresserMurSelectionne`, `v5DeleteSelectedWall`), via trois hooks
  neufs (`ctx.gestes.couperMurClic`/`redresserMurClic`/`supprimerMurClic`) puisqu'un module de rendu
  ne doit pas importer un module de geste. Taille FIXE, jamais réduite (commit 5e8c334, toujours en
  vigueur) ; PAS de réintroduction des boîtes de 32 px anti-recouvrement ni des cinq paliers : un
  mur trop court porte quand même ses boutons, au risque d'un chevauchement visuel accepté plutôt
  que de refaire l'arbitrage de clic entre murs voisins que ce lot avait justement supprimé (il n'y
  a plus de voisin à arbitrer : seul le mur sélectionné porte quoi que ce soit).
- **Ce qui NE change PAS** : le tracé au clic-clic, les aimants, le lasso, l'absence de bouton au
  survol, les trois contrôles de traction (disque + deux bouts). `compat-donnees` rend toujours les
  mêmes 1069 empreintes.
