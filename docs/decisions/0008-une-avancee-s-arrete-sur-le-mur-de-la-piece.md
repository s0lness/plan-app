# 0008 - Une avancée s'arrête sur le mur de la pièce

Status: accepted, 2026-08-20. Prolonge [0007](0007-une-jonction-qui-se-romprait-est-pontee.md)
au cas où c'est une FAÇADE qui s'en va.

## Contexte
Signalement du propriétaire, captures à l'appui : il pousse vers le haut le tronçon de façade qui
forme le mur du haut d'une petite pièce. « Ça crée un trou », et « la bissection à droite ne se
fait pas au bon endroit ».

Reproduction minimale, à la vraie souris (`tests/avancee-suit-la-piece-geste.ts`) : un contour
900 × 700 dont la façade du haut est déjà coupée en 350 et en 550, deux cloisons à 350 et à 560
qui bornent la pièce du milieu, et une poussée de 200 cm vers le haut. Mesuré AVANT :

```
contour : [[0,0],[350,0],[350,-200],[550,-200],[550,0],[900,0],[900,700],[0,700]]
pièce   : [[350,-200],[550,-200],[550,0],[560,0],[560,700],[350,700]]   6 sommets
```

L'avancée sort large de 200 cm (350 → 550) alors que la pièce en fait 210 (350 → 560) : son coin
droit tombe 10 cm avant le mur de la pièce, et le plan garde une encoche de 10 × 200 cm
d'EXTÉRIEUR qui mord dans le coin haut-droit de la pièce. C'est le trou. La cloison de gauche, elle,
tombe pile sur la coupe, et ce côté-là est déjà correct : c'est pour ça que le défaut est invisible
quand les deux coupes tombent juste, et pourquoi il faut deux cas pour le voir.

La règle de 0007 ne peut rien ici, et il faut le dire précisément : elle relève au `pointerdown` les
cloisons dont un bout touche le mur tiré, à 2 cm près. La cloison de droite touche la façade
VOISINE, à 10 cm de la coupe : elle n'est donc suiveuse de rien, et un portage fidèle de 0007 au
glissement de façade ne change pas un centimètre de la mesure ci-dessus.

## Décision
**Le coin de l'avancée se pose sur la cloison qui borde la pièce, pas sur la coupe de la façade.**

Au premier centimètre du geste, `poserLesCoins` crée déjà un raccord à angle droit à chaque bout où
la façade voisine prolonge en ligne droite celle qu'on tire (c'est ce qui empêche le contour de
plier). Ce coin-là n'existe QUE parce que le geste vient de le créer : avant de le poser, on cherche
sur la ligne de la façade, à portée d'aimant, le bout d'une cloison, et c'est là qu'on le pose.

Trois précisions qui ne sont pas des détails :

- **La cloison ne bouge pas d'un centimètre.** C'est le coin qui va la chercher. Mesuré : les deux
  cloisons sont identiques au bit près avant et après le geste.
- **La portée d'aimant est celle des autres aimants du contour** (`aimantFacade`) : une épaisseur de
  mur, ou 16 pixels d'écran, le plus grand des deux. Ce qui est à portée de doigt du coin sous la
  main.
- **Seulement là où un raccord naît**, donc uniquement quand la façade a été coupée et que sa
  voisine la prolonge. Un voisin PERPENDICULAIRE ne reçoit aucun coin, donc aucun aimant : sans
  cette borne, pousser le haut d'un rectangle déplacerait ses deux façades latérales de côté.

Mesuré APRÈS, même geste :

```
contour : [[0,0],[350,0],[350,-200],[560,-200],[560,0],[900,0],[900,700],[0,700]]
pièce   : [[350,-200],[560,-200],[560,700],[350,700]]   4 sommets, 210 × 900
```

La pièce a simplement grandi de 200 cm vers le haut. Le cas où la coupe tombe déjà sur la cloison
(550) rend exactement le même plan qu'avant ce lot.

**Et la pièce dit qu'elle a changé de forme** : « The recess stopped on the partition, 10 cm past
the cut, so the room keeps a square corner. » La pièce n'a pas la largeur qu'on lisait avant le
geste, donc le chiffre est annoncé, comme tout ce qui change de nature ici.

**Une fenêtre de la façade voisine ne bouge pas.** Une ouverture désigne son mur et sa DISTANCE
depuis `a` ; le coin qui glisse est justement le `a` de la façade voisine, donc sans correction
toutes ses fenêtres partiraient avec lui, en silence (mesuré : 10 cm, sans un mot). Les ouvertures
des deux murs qui touchent ce coin sont corrigées d'un cran avant qu'il ne bouge, et leurs valeurs
d'origine sont retenues pour Échap et pour le clic net.

## Rejeté
- **Faire glisser la cloison de 10 cm jusqu'au coin.** C'est déplacer latéralement, sur toute sa
  hauteur (900 cm ici), un mur que la personne n'a pas touché, pour rattraper une coupe de façade.
  Ce dépôt refuse ça partout ailleurs (AGENTS.md, « NO MASS RENORMALIZATION ») et le dégât serait
  plus grand que celui qu'on répare : les meubles et les ouvertures de cette cloison suivraient.
- **Prolonger la cloison le long de sa propre direction jusqu'à la nouvelle façade.** C'était la
  piste la plus proche de 0007, et elle ne mène nulle part ici : la cloison de droite est HORS de
  l'avancée, sa droite ne rencontre plus rien, et celle de gauche est déjà collée au raccord du
  contour (les prolonger produirait une cloison superposée à une façade).
- **Laisser le trou et le signaler par un bandeau.** Le propriétaire ne demande pas qu'on lui
  décrive son encoche, il demande que sa pièce ait un coin.
- **Aimanter aussi les voisins perpendiculaires.** Ça revient à déplacer une façade que personne ne
  tire, dans le geste le plus ordinaire du contour.
