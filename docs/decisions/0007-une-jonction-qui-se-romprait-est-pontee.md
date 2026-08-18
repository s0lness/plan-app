# 0007 - Une jonction qui se romprait est pontée

Status: accepted, 2026-08-18. Amende [0005](0005-un-suiveur-ne-bascule-jamais.md), dont il annule
le « coût accepté ».

## Contexte
La décision 0005 donne deux règles pour ce qui arrive aux murs voisins quand on en pousse un :

1. un suiveur ne bascule jamais : il glisse le long de sa propre direction jusqu'à la nouvelle
   droite du mur tiré, ou il ne bouge pas ;
2. il ne bouge que s'il se retrouverait dans le vide : encore tenu par un autre mur ou la façade,
   il reste exactement où il est.

Elle assumait explicitement une perte : **un suiveur colinéaire dont l'autre bout ne touche rien se
détache**, au motif qu'« un écart visible est honnête et réversible, une diagonale ne l'est pas ».

Le propriétaire a signalé ce cas deux fois en usage réel, avec des captures les deux fois. La
seconde est la plus nette : il coupe une cloison horizontale en deux avec le « + », pousse la
moitié GAUCHE vers le bas, et obtient deux morceaux qui ne se touchent plus. Ce qu'il attendait,
dessin à l'appui : **qu'un segment apparaisse pour tenir la jonction**, transformant la déchirure
en décrochement.

Il a raison, et les deux règles de 0005 ne peuvent pas produire ce résultat, par construction.
La règle 1 fait glisser le point de contact le long de la droite du suiveur jusqu'à la nouvelle
droite du mur tiré : deux droites parallèles ne se rencontrent jamais, donc le cas colinéaire n'a
aucune solution. La règle 2 immobilise un suiveur tenu ailleurs, ce qui est correct mais laisse la
jonction se rompre. Aucune des deux ne pouvait faire autre chose que constater la rupture.

## Décision
**Troisième règle, appliquée au RELÂCHEMENT du geste : une jonction qui s'est rompue reçoit un
segment de liaison.**

Pour chaque suiveur relevé au `pointerdown`, on compare son point de contact à l'endroit où ce
point serait s'il avait suivi le mur (la même fraction le long du mur déplacé). Si l'écart dépasse
2 cm ET que le point de contact ne touche plus le mur nulle part ailleurs sur sa longueur, un mur
est créé entre les deux. Il porte l'épaisseur du mur déplacé, pour que le décrochement se lise
comme une seule maçonnerie.

Trois précisions qui ne sont pas des détails :

- **Le pont est une cloison LIBRE.** C'est un mur qu'on pose exactement là où on le veut ; le
  laisser traversant le ferait étirer par la règle du mur traversant, loin de la jonction même
  qu'il existe pour tenir.
- **Au relâchement, pas à chaque mouvement.** Ponter à chaque image fabriquerait un mur par
  déplacement de souris. Pendant le geste on voit l'écart s'ouvrir, ce qui est honnête, et il se
  referme quand on lâche.
- **Et surtout pas depuis l'application « finale » du glissement**, parce que ce même chemin est
  celui de l'ANNULATION : ponter là aurait fabriqué des murs au moment précis où quelqu'un
  abandonne son geste.

## Ce qui ne change pas
Les règles 1 et 2 de 0005 restent mot pour mot. Un suiveur qui PEUT suivre suit, un suiveur tenu
ailleurs ne bouge pas, et **aucun suiveur ne bascule jamais**. La règle 3 ne s'applique qu'au cas
où ni l'une ni l'autre ne peut préserver la jonction : elle ajoute une réponse là où il n'y en
avait pas, elle n'en remplace aucune.

## Rejeté
- **Faire basculer le suiveur pour rejoindre le mur déplacé.** C'est exactement ce que 0005
  interdit, et pour une bonne raison : une diagonale ressemble à une pièce normale jusqu'à ce qu'on
  la mesure.
- **Déplacer le suiveur entier.** Il est tenu à son autre bout ; le déplacer casserait cette
  jonction-là pour en sauver une autre.
- **Laisser la déchirure et la signaler par un bandeau.** C'était la position de 0005 sans le
  bandeau. Le propriétaire ne demande pas à être averti que son plan s'est déchiré, il demande que
  son plan tienne.
