# 0011 - L'aimant remplace les règles, pour tout le mobilier

Status: accepted, 2026-09-02. Lot 3 de `docs/simplification-2026-09-02.md`. Généralise l'aimant du
radiateur (F1) et **renverse la moitié « mobilier » de [G-7](../invariants.md)** : la pénétration
acquise, la tolérance par pièce et le renvoi à la maison n'existent plus.

## Contexte
Le propriétaire : « notre app est un peu clunky ». Le relevé de `docs/simplification-2026-09-02.md`
§3.5 nomme la cause pour le mobilier : **il est bridé par des règles au lieu d'être guidé par des
aimants**. Chacune de ces règles est née d'un bug de la précédente, et il fallait les six ensemble
pour que l'aller-retour reste exact :

- `clampCenterToInset` borne le meuble dans sa cellule, avec une garde pour ne pas le catapulter ;
- `pieceTol` mémorise la pénétration déjà acquise, pour ne pas « corriger » un plan converti ;
- `hors0` + `clampCenterToApt` font la même chose pour le contour, et **refusent** le geste au lieu
  de projeter, parce qu'une projection glisse le long de la façade ;
- `{gardeOrphelin}` exempte le meuble déjà hors de toute cellule ;
- `deltaScaleMax` rétrécit le delta d'un groupe pour que ses membres ne soient pas bornés chacun de
  son côté ;
- `_avantDernier` se souvient de la place d'avant le dernier glisser pour défaire, au retour, ce que
  tout ce qui précède avait déplacé à l'aller.

Le résultat était juste. Le coût était une grille de 5 cm plus deux modificateurs pour s'en
échapper (Ctrl sans grille, Maj mode fin), et un mobilier qui bouge sans qu'on comprenne pourquoi.
Aucun planificateur comparable ne fait ça : chez Sweet Home 3D, « a piece of furniture is
automatically rotated so its back face lies along the wall », et Alt coupe l'aimant.

## Décision
**Un meuble n'est plus jamais repoussé. Ce qui le place, c'est un aimant, et Alt le suspend.**

1. **Tout meuble non mural se colle au mur par le dos** (`meubleWallSnap`, `modele/espace.ts`) :
   dos affleurant la face, orientation du mur. Même portée que les ouvertures (`wallSnapReach`),
   mais **mesurée sur le dos et pas sur le centre** : un lit fait 200 cm de profondeur, son centre
   est à un mètre du mur qu'il touche. Pendant un glisser, au dépôt depuis la palette, et pendant
   un déplacement de groupe (l'aimant y est lu UNE fois, sur la pièce sous la main, et sa
   correction est portée en translation par tout le groupe, sinon la sélection se déforme).
2. **Le dos, c'est le −y local**, sans table par type : le +y local est déjà l'avant partout dans
   l'app (`snapChairToTable` fait regarder la chaise vers sa table), et le catalogue ne porte aucun
   drapeau de face. Une convention, pas un cas particulier par meuble.
3. **Alt maintenu coupe tous les aimants** (mur, alignement, empilement) le temps du geste. C'est
   le seul modificateur d'un glisser de meuble. **Ctrl+glisser (sans grille) et Maj+glisser (mode
   fin) disparaissent**, avec la grille qu'ils servaient à contourner. Maj garde ses autres sens,
   qui sont tous « contraindre » : 15° à la rotation, l'axe sur le contour, le pas de 10 cm au
   clavier.
4. **Plus de grille de 5 cm**, ni comme comportement ni comme option (l'interrupteur quitte la
   configuration). Un meuble se déplace au centimètre ; les coordonnées restent entières, arrondies
   **une seule fois, sur le coin** (règle inchangée). L'ancienne clé `snap` reste **lue et ignorée**
   dans les réglages personnels : aucun plan enregistré n'est refusé, et rien ne la réécrit.
5. **Un meuble peut chevaucher un mur.** Rien ne le borne, ni au glisser, ni au dépôt, ni au
   redimensionnement : `pieceTol`, `hors0`, `clampCenterToApt`, `deltaScaleMax` et le passage de
   `{gardeOrphelin}` sont retirés. Le chevauchement est signalé par Circulation, qui est le moteur
   dont c'est le métier, et il n'est plus empêché par le geste.
6. **`_avantDernier` disparaît.** Il n'existait que pour défaire le bornage de l'aller. Sans
   bornage et sans grille, le coin est `Math.round(pointeur − prise)` et chaque aimant est une
   fonction pure de cette position : la même position de main redonne exactement la même place, donc
   l'aller-retour est exact par construction et non plus par mémorisation.

Ce qui NE change pas : l'empilement (`empilables`, `passeAuDessus`), l'alignement entre meubles et
ses guides, l'aimant chaise-table, et la règle **« pas de renormalisation de masse »** ([G-8]) : un
meuble dont le centre est hors de toute cellule au chargement est signalé une fois, comme avant. Le
serveur non plus : `live-worker/` accepte les mêmes champs, un client resté ouvert ne casse pas.

## Ce qui a été rejeté
- **Garder la grille en option décochée par défaut.** Une option que personne ne coche est un
  chemin de code que personne ne teste : c'est exactement ce que ce lot enlève.
- **Un drapeau `face` dans le catalogue**, pour distinguer le dos d'un canapé du côté d'un tapis.
  Ça ajoute une colonne à 80 entrées pour un cas (tapis, plante) où l'aimant ne se déclenche
  presque jamais, le centre d'un grand tapis étant loin de tout mur. La convention du +y local
  répond déjà pour le lit, le canapé, la chaise et la commode.
- **Appliquer l'aimant membre par membre dans un groupe.** C'est la déformation que
  `deltaScaleMax` avait été écrit pour empêcher ; on ne la réintroduit pas par l'autre bout.
- **Garder Alt+glisser = dupliquer.** Alt est le modificateur d'aimant de tout le monde (Sweet Home
  3D, Floorplanner) et il ne peut pas être les deux. Dupliquer reste le bouton de l'inspecteur ; le
  lot 4 lui rendra un raccourci clavier.

## Conséquences
- Zone du lot : `modele/espace.ts` (−45 lignes), `gestes/meuble.ts` (−228), `gestes/contraintes.ts`
  (−110), `gestes/pose.ts`, `gestes/redimension.ts`, `gestes/etat-pointeur.ts`, `app/options.ts`,
  `historique/pile.ts`, `sonde-gestes.ts`, `src/html/01-coque-rail.html`.
- Suite `tests/sans-grille.ts` supprimée (elle testait la grille relative et Ctrl) ; deux cas de
  `tests/geste-ami.ts` supprimés (le même Ctrl) ; `geste_sans_effet_dit_pourquoi` et
  `clic_net_sur_un_groupe_ne_borne_personne` supprimés de `tests/gestes-usage-reel.ts` : sans
  bornage, un geste ne peut plus être sans effet ni borner un groupe au clic.
- `tests/rapide.ts` couvre l'aimant en pur : lit à 8 cm collé avec la bonne rotation, rien à 60 cm,
  rien sous Alt, aller-retour exact, meuble à cheval ressorti sans être repoussé ailleurs.
- `compat-donnees` ne bouge pas : le chargement ne déplace toujours rien.

[G-8]: ../invariants.md
