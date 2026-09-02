# 0013 - Une action, un chemin

Status: accepted, 2026-09-02. Lot 4 de `docs/simplification-2026-09-02.md`, en parallèle du lot 2
(géométrie des murs, non touché ici).

## Contexte

Le propriétaire : « notre app est un peu clunky, et pourrait être simplifiée ». Le relevé
(`docs/simplification-2026-09-02.md` §3.3) nomme la cause : **deux ou trois chemins par action**,
chacun avec son propre raccourci. Poser un objet se faisait par glisser, par armer-puis-cliquer,
ou par Entrée ; tourner se faisait par un curseur d'angle, un bouton, la touche R, ou le
double-clic ; renommer se faisait par la fiche, le panneau, ou le double-clic. Le coût n'est pas le
code, c'est l'aide de dix sections qu'il faut pour les expliquer, et le doute de l'utilisateur sur
lequel est « le bon ».

## Décision

**Chaque action garde UN chemin, choisi parmi les concurrents, et les autres partent.**

| Action | Le chemin qui reste | Ce qui part |
| --- | --- | --- |
| Poser un objet | glisser depuis la palette (souris) ; au doigt : toucher la vignette puis toucher le plan | armer par clic (souris) + clic sur le plan, Entrée qui pose au centre |
| Tourner | une poignée de rotation au coin de la sélection (Shift = pas de 15°), et le bouton Rotate 90° | le curseur d'angle et sa valeur, le double-clic qui tourne (ou flip la porte) |
| Flip side (appliques / prises) | la touche R, seule signification qui lui reste | R ne tourne plus un meuble libre |
| Renommer | double-clic sur le nom (meuble, cellule, plan) | le champ Name de l'inspecteur (`iName`) ; la fiche pièce garde `rcName`, faute de double-clic déjà branché dessus |
| Dupliquer | le bouton Duplicate, et Ctrl+D | (Alt+glisser dupliquait déjà avant ce lot, décision 0011) |
| Sélection multiple | lasso (lot 1), Shift+clic ajoute ou retire | Ctrl+clic sur un meuble (Ctrl n'a plus de sens dans l'app) |
| Cotes | affichées sur la sélection (`showDim`, déjà vrai) et pendant tout geste | D maintenu, pour le mobilier |
| Ordre de peinture | automatique (du plus grand au plus petit, G-9, déjà vrai) | Bring to front |
| Espacement égal | rien : le champ et le bouton partent, sans remplacement | le champ Even et son bouton dans l'inspecteur |

**Espacement égal n'a pas de remplacement.** L'énoncé du lot proposait « un petit bouton sur les
guides quand trois objets sont alignés » ou rien ; ajouter ce bouton demandait de faire suivre un
état d'alignement statique (hors geste) dans une zone de rendu hors du périmètre de ce lot, pour un
geste rare. `modele/repartir.ts` (le calcul pur) et sa suite `tests/repartir-espacement.ts`
restent dans le dépôt, prouvés par leurs propres tests : rien n'empêche un lot futur de leur
redonner une entrée d'interface.

**Le mobilier n'est plus repoussé par une flèche, un redimensionnement au clavier ou un
« Even »**, complétant la décision 0011 : `v5ClampPiece` sortait encore de `gestes/clavier.ts`
(les flèches), `panneaux/inspecteur.ts` (Width/Depth) et `gestes/selection-actions.ts`
(l'espacement égal, retiré avec le reste de la fonctionnalité). Ces trois appels sont retirés ;
restent `circulation/correctifs.ts` (une réparation explicite, sur demande) et le bornage des
orphelins au chargement (`v5ClampPieces`, appelé une fois, jamais pendant un geste).

**La fenêtre D maintenu reste, pour un mur seulement.** La géométrie des murs
(`modele/edition.ts`, `gestes/murs.ts`) est le territoire du lot 2, non touché ici : retirer
`v5RayHits`/`v5ClearDims` de son seul appelant externe (`drawWallGuides`, `gestes/guides.ts`) les
aurait rendus orphelins selon `tests/exports-morts.ts`, dans des fichiers que ce lot n'a pas le
droit de modifier. La moitié MOBILIER de D maintenu (`pieceSousD`) part bien : les cotes d'un
meuble sont déjà affichées sur la sélection, la touche n'apportait plus rien.

## Ce qui a été rejeté

- **Garder R comme raccourci de rotation libre, en plus de la poignée.** C'était exactement la
  duplication que ce lot retire : deux chemins pour un pas de 90°. R garde un seul sens, flip side,
  qui n'a pas d'équivalent bouton+poignée.
- **Un bouton d'espacement égal sur les guides.** Rejeté faute de budget dans ce lot (voir
  ci-dessus) plutôt que par principe : le calcul pur et sa preuve restent, prêts à être rebranchés.
- **Une case Name en lecture seule dans l'inspecteur**, pour ne pas perdre l'affichage du nom
  quand l'étiquette est masquée (option « Show names » décochée, ou objet trop petit). Rejeté :
  le tableau final de l'inspecteur (`docs/simplification-2026-09-02.md` lot 4) ne liste aucun champ
  Name, et une case qui ne fait qu'afficher sans agir aurait été un chemin de plus à expliquer pour
  un besoin marginal.

## Conséquences

- **En moins**, dans la zone de ce lot : le champ `iName` et sa case (`04-inspecteur.html`,
  `panneaux/inspecteur.ts`), le curseur d'angle `iRot`/`iRotV`, le bouton `iFront` (Bring to
  front), le bloc Even (`iSpread`/`iGaps`/`iGapSet`/`iSpreadGo`), `poserAuCentre`
  (`gestes/pose.ts`), la moitié mobilier de D maintenu (`pieceSousD`, `gestes/clavier.ts`), le
  double-clic qui tourne un meuble ou flip une porte (`gestes/branchement.ts`), et l'armement par
  clic SOURIS sur une vignette (`gestes/pose.ts`, l'armement par toucher ou par
  `Entrée`/`Espace` clavier reste).
- **En plus** : `angleVersPointeur` (`gestes/guides.ts`, pure, testée dans `tests/rapide.ts`),
  `dupliquerSelection` (`gestes/selection-actions.ts`, partagée par le bouton et Ctrl+D).
- **Les données ne bougent pas** : `compat-donnees` rend les mêmes 1069 empreintes. Ce lot ne
  touche ni la géométrie, ni la lecture, ni le fil ; le serveur continue d'accepter les mêmes
  champs.
- **L'aide tient sur un écran** : cinq blocs de quatre lignes au plus, et la table des raccourcis.
