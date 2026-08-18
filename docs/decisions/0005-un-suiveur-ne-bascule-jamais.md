# 0005 - Un suiveur ne bascule jamais

Status: accepted, 2026-08-15

## Contexte
Deux signalements du propriétaire, en apparence contradictoires, sur le même geste (tirer un mur
intérieur sur le côté) :

1. Un mur horizontal touchant le PIED d'un mur vertical qu'on tire est devenu une diagonale au
   lieu de simplement raccourcir.
2. Un mur vertical qui CONTINUE en ligne droite le mur qu'on tire, planté dans la façade à
   l'autre bout, est devenu une diagonale après le même geste — alors que le correctif écrit pour
   le premier signalement (porter le point de contact du suiveur vers l'intersection de sa PROPRE
   droite avec la nouvelle droite du mur tiré) était déjà en place.

Le mécanisme d'origine (C-19, PR #17) transportait le point de contact du suiveur PAR FRACTION le
long du mur tiré. Comme le mur tiré ne fait que se TRANSLATER pendant ce geste (jamais tourner),
ce transport déplace toujours le point de contact du MÊME vecteur que le mur, quel que soit
l'angle du suiveur. Un suiveur exactement perpendiculaire chevauche ce vecteur gratuitement (déjà
correct, sans qu'on l'ait cherché). Un suiveur COLINÉAIRE — le cas même que PR #17 visait à
réparer — reçoit ce même vecteur, qui n'est PAS le long de sa propre ligne : il bascule en
diagonale, exactement le défaut que PR #17 prétendait avoir corrigé.

Le remplacement direct par une intersection (la propre droite du suiveur avec la nouvelle droite
du mur tiré) règle le basculement, mais fait réapparaître le second signalement pour une raison
différente : un suiveur qui touchait EN RÉALITÉ un troisième mur au même point (pas seulement le
mur tiré) glisse « correctement » le long de sa propre direction pour rejoindre le mur tiré — et
déchire sa jonction avec ce troisième mur au passage.

## Décision
Deux règles, dans cet ordre, décidées UNE FOIS à `pointerdown` (`v5WallDragCtx`), jamais
réévaluées en cours de geste :

1. **Un suiveur ne bascule jamais.** Il garde sa propre direction : soit son point de contact
   glisse le long de cette direction jusqu'à rencontrer la nouvelle droite du mur tiré
   (intersection ordinaire), soit il ne bouge pas du tout. Aucun troisième chemin, aucun repli qui
   le transporterait autrement.
2. **Un suiveur ne bouge que s'il se retrouverait dans le vide.** Si son point de contact touche
   encore, une fois le mur tiré parti, un AUTRE mur (son extrémité ou son flanc) ou la façade —
   même tolérance de 2 cm que la détection de jonction elle-même — il est déjà tenu par ce
   troisième objet et reste EXACTEMENT où il est.

La règle 2 est évaluée en premier : elle décide si la règle 1 s'applique du tout. Un suiveur
colinéaire ET dans le vide se détache (deux droites quasi parallèles n'ont pas d'intersection
utilisable, et rien d'autre ne le retient) ; un suiveur tenu par un troisième mur ne bouge jamais,
quel que soit son angle par rapport au mur tiré.

Conséquence directe sur le second signalement : trois murs qui se rejoignent au même point (le
mur tiré, un mur perpendiculaire, et un mur qui continue ce dernier en ligne droite jusqu'à la
façade) restent tous les deux inchangés au bit près pendant le geste, parce qu'ils se tiennent
mutuellement (chacun est « tenu ailleurs » par l'autre). Seul le mur tiré bouge, et vient
simplement former un T plus loin sur le flanc de celui qu'il ne touche plus à son ancien point de
contact.

## Coût accepté
Un suiveur colinéaire dont l'autre bout ne touche rien SE DÉTACHE du mur qu'on tire, au lieu de
le suivre. C'est un renoncement délibéré : un écart visible est honnête et réversible (on le voit
tout de suite, un Ctrl+Z l'annule), une diagonale ne l'est pas (elle ressemble à une pièce normale
jusqu'à ce qu'on la mesure). Ce cas est écrit noir sur blanc dans `tests/jonction-glisser-mur.ts`
(`voisin_colineaire_dans_le_vide_se_detache`), pas laissé à découvrir en usage réel comme les deux
signalements qui ont mené à cette décision.

## Rejeté
- **Le transport par fraction seul (PR #17, l'état d'origine).** Correct pour un suiveur
  perpendiculaire par une coïncidence de construction, mais fabrique une diagonale pour tout
  suiveur qui n'est ni perpendiculaire ni parfaitement aligné avec le vecteur de translation — y
  compris, ironiquement, le cas colinéaire que PR #17 visait à corriger.
- **L'intersection seule, sans la règle du « tenu ailleurs ».** Règle le basculement (plus aucun
  mur en biais) mais rouvre une jonction à trois murs dès qu'un suiveur touche autre chose que le
  seul mur tiré : c'est le second signalement du propriétaire.
