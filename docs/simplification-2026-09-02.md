# Simplifier le planificateur, 2026-09-02

Le propriétaire: « notre app est un peu clunky, et pourrait être simplifiée ». Ce document dit d'où vient
la lourdeur, ce que font les planificateurs 2D comparables (Sweet Home 3D, Floorplanner, RoomSketcher,
Planner 5D, HomeByMe, Roomstyler, Coohom, magicplan), et ce qu'on coupe ou copie, dans l'ordre.
Ce n'est pas encore une décision: chaque lot ci-dessous en devient une (`docs/decisions/`) quand il part.

## 1. Le constat, en chiffres

| Mesure | Nous | Chez les autres |
| --- | --- | --- |
| Commandes visibles (boutons + champs) | 76 boutons, 27 champs, 14 fragments | non chiffré, mais un panneau de propriétés et une palette |
| Barre d'outils | 12 éléments | 4 à 6 |
| Inspecteur d'un objet | 17 commandes et un curseur | 4 à 8 propriétés |
| Aide | 10 sections, 19 raccourcis | une page |
| Touches modificatrices | Shift (3 sens), Ctrl (2), Alt (2), D, R, Espace | Shift (contraindre), Alt (couper l'aimant), une touche pour retourner une porte |
| Façons de faire une même chose | poser: glisser, armer puis cliquer, Entrée; tourner: curseur, bouton, R, double-clic; renommer: double-clic, fiche, panneau | une par action |
| Sites de messages | 72 toasts, 33 bannières | les apps sont muettes sauf refus |
| Boutons au survol d'un mur | jusqu'à 7 (disque, croix, coupe, équerre, deux bouts, maillons) | aucun au survol; 2 poignées de bout à la sélection |
| PR d'août sur les murs | 9 sur 20 (jonctions, suiveurs, bouts, coude, poignées, tracé, façade) | |

La dernière ligne est le symptôme le plus sûr: quand la moitié du travail d'un mois corrige la même
zone, ce n'est pas la zone qui est mal codée, c'est le modèle d'interaction qui demande trop.

## 2. Ce que tout le monde fait pareil (les attentes par défaut)

1. **Un mur se trace au clic-clic** (départ, arrivée, on enchaîne), longueur affichée en direct,
   Échap ou double-clic pour sortir. Sweet Home 3D, Floorplanner, RoomSketcher, Planner 5D, Coohom.
2. **L'aimant est actif par défaut** (orthogonal, mur, bout de mur), et UNE touche le coupe le temps
   d'un geste (Alt chez Sweet Home 3D, une touche chez Floorplanner).
3. **Les pièces sont déduites des murs fermés**, surface calculée (Floorplanner, Coohom, magicplan).
   C'est notre modèle: on garde.
4. **Une porte ou une fenêtre se pose en la glissant sur un mur**, elle s'oriente seule; un seul
   bouton (ou une touche, Q chez RoomSketcher) la retourne.
5. **Un meuble se colle au mur par le dos et prend l'orientation du mur** (Sweet Home 3D: « a piece of
   furniture is automatically rotated so its back face lies along the wall »), et s'empile sur un
   meuble plus grand. On vient de le faire pour le radiateur seul.
6. **La rotation se fait par une poignée au coin** de l'objet sélectionné, avec un pas de 15° tenu par
   Shift (Sweet Home 3D). Pas de curseur, pas de touche D.
7. **Un panneau de propriétés**, pas une barre flottante d'actions. Ce qu'on a est standard, il est
   seulement deux fois trop rempli.
8. **Glisser sur le vide sélectionne** (lasso). Aucune app ne trace un mur en glissant sur le sol.

Ce qui est critiqué partout: la lenteur sur les gros projets, et « too many clicks », les réglages
courants « hidden in menus ». Personne ne se plaint d'une app qui offre trop peu.

## 3. D'où vient la lourdeur chez nous

1. **Le sol trace.** Depuis « le mode murs n'existe plus » (PR #25), glisser sur le vide dessine un mur
   et le lasso est passé sous Shift. C'est l'inverse de toutes les apps, et c'est la racine d'une
   chaîne: pour ne pas tracer par accident il a fallu des boîtes de 32 px sous chaque bouton, puis
   des boutons qui apparaissent au survol, puis des règles pour qu'ils ne se volent pas le clic
   entre eux, ni avec un meuble, ni avec une étiquette. Sept PR.
2. **Le mur « traversant ».** Un mur qui s'allonge tout seul jusqu'au prochain mur est un concept à
   nous, avec son état persistant (`free`), ses suiveurs, ses jonctions pontées, ses avancées qui
   s'arrêtent sur la pièce, son bouton Through / Free dans la fiche. Aucune app comparable ne le
   fait: un mur va d'un point à un point, et l'aimant fait le reste.
3. **Deux ou trois chemins par action**, et un raccourci pour chacun. Le coût n'est pas le code, c'est
   l'aide de dix sections qu'il faut pour les expliquer, et le doute de l'utilisateur sur lequel est
   « le bon ».
4. **L'app parle trop.** Cent cinq points de message, un système de bannières avec throttling par
   texte, des astuces une fois. Une app qui doit expliquer un geste au moment où on le fait, c'est un
   geste qui n'est pas évident.
5. **Le mobilier est bridé par des règles au lieu d'être guidé par des aimants**: pénétration acquise,
   tolérance par pièce, orphelins renvoyés à la maison, alignement tronqué vers zéro. Le résultat est
   juste, mais chaque règle est née d'un bug d'une règle précédente.

## 4. Ce qu'on fait, dans l'ordre

Chaque lot retire plus qu'il n'ajoute. Le chiffre entre crochets est ce qu'on gagne.

### Lot 1. Le mur redevient un outil, le sol redevient un lasso
- Bouton **Mur** dans la barre (il y est déjà), tracé au **clic-clic**: départ, arrivée, on enchaîne,
  longueur affichée en direct, Échap ou double-clic pour sortir. Aimant orthogonal et aux murs
  existants par défaut, Alt le coupe.
- Glisser sur le vide = **lasso** (comme partout), Shift+glisser disparaît.
- Les boutons de mur au survol disparaissent. Cliquer un mur le **sélectionne** (surbrillance, deux
  poignées de bout, fiche). Couper, supprimer et redresser vivent dans la fiche du mur, qui existe déjà.
- Renverse PR #25. Ce que PR #25 achetait (ne pas avoir à choisir un outil) coûte plus qu'il ne rend.
  [supprime les boîtes de 32 px, les paliers de boutons, la moitié de `rendu/calque.ts` et de
  `gestes/murs.ts`, trois suites de tests de poignées]

### Lot 2. Un mur va d'un point à un point
- Plus de mur « traversant »: un mur finit où on le lâche, aimanté au mur ou au bout de mur à portée.
  Un mur qui touche un autre mur y est joint; on tire un bout, il reste joint. Rien ne s'allonge seul.
- `free` disparaît de l'interface (Through / Free retiré de la fiche). Dans les données, tout mur
  existant devient libre, ce qui ne déplace rien: sa géométrie est déjà celle qu'on voit.
- Les suiveurs (décision 0005) restent: quand on pousse un mur, ce qui le touche glisse. C'est le seul
  automatisme que les autres apps ont aussi.
  [supprime `v5ThroughWall`, les avancées de 0009, le pontage de 0007 dans sa moitié « extension »,
  et le bouton Through / Free]

### Lot 3. L'aimant remplace les règles, pour tout le mobilier
- Ce qu'on vient de faire pour le radiateur devient la règle pour tout meuble: le dos qui arrive à
  portée d'un mur s'y colle et prend l'orientation du mur. Alt coupe l'aimant pour un geste.
- L'alignement entre meubles reste (guides), l'empilement reste (sèche-linge, tapis).
- La grille de 5 cm disparaît comme mode: on aimante aux murs, aux meubles et aux guides, sinon on est
  au centimètre. Plus de Ctrl « sans grille », plus de Shift « mode fin ».
  [supprime `pieceTol`, `hors0`, la tolérance acquise, Ctrl+glisser, Shift+glisser]

### Lot 4. Une action, un chemin
- Poser: glisser depuis la palette (souris) ou toucher la vignette puis le plan (doigt). Plus de
  « armer par clic » ni d'Entrée.
- Tourner: une **poignée de rotation** au coin de la sélection (pas de 15° avec Shift), et le bouton
  Rotate 90°. Plus de curseur, plus de R, plus de double-clic qui tourne.
- Renommer: double-clic sur le nom, partout (meuble, pièce, plan). Plus de champ nom dans la fiche.
- Dupliquer: le bouton, et Ctrl+D. Plus d'Alt+glisser.
- Inspecteur: Width, Depth, From the corner, Lock, Duplicate, Delete, plus les champs propres au type
  (battant, sens, projecteur). **Bring to front** part (l'ordre de peinture est déjà automatique),
  **Even spacing** part de la fiche et devient un petit bouton sur les guides quand trois objets sont
  alignés, **D maintenu** part (les cotes s'affichent à la sélection et pendant le geste).
- Modificateurs restants: **Shift** contraint (axe, 15°), **Alt** coupe l'aimant. C'est tout.
  [l'aide tient sur un écran]

### Lot 5. L'app se tait
- Règle: un message n'existe que pour dire POURQUOI un geste délibéré n'a pas eu d'effet. Les
  informations (« objet ramené à la maison de 113 cm », « mur devenu libre ») disparaissent ou
  deviennent visibles dans le dessin.
- Les astuces « une fois » disparaissent.
  [de 105 sites de message à moins de 30, et le throttling par texte n'a plus de raison d'exister]

### Lot 6. La barre et la collaboration
- Barre: Menu, Mur, Mesure, Ajuster, Circulation, Inviter, Aide. Annuler et Refaire passent au clavier
  et dans le menu. Le calque « circulation » devient un état du bouton Circulation.
- Collaboration: curseurs et présence restent (Planner 5D fait pareil, c'est apprécié). La bulle de
  curseur « / » disparaît; le chat reste, replié.

## 5. Ce qu'on garde parce que c'est mieux que les autres

- Les pièces déduites des murs, avec nom et sol qui survivent aux recalculs.
- Le moteur Circulation: aucune app comparable n'évalue les dégagements.
- Le temps réel avec Ctrl+Z par auteur, l'accusé d'op, le repli D1 en compare-and-swap.
- La règle « un clic sur ce qui est visible atteint ce qui est visible », et l'aller-retour exact.
- Le radiateur bas sous la fenêtre. À généraliser (lot 3), pas à retirer.

## 6. Ordre et coût

Lot 1 d'abord: il conditionne tout le reste et enlève le plus de code. Lot 2 juste après, parce que
les deux touchent `gestes/murs.ts` et qu'on ne veut le rouvrir qu'une fois. Lots 3 et 4 peuvent aller
en parallèle. Lot 5 est mécanique. Lot 6 est cosmétique et ferme.

Chaque lot se montre avant de se verrouiller: une preview, le propriétaire s'en sert dix minutes, puis
seulement la barrière et le dossier de décision.
