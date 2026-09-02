# 0016 - Détacher un meuble d'un mur lui rend son orientation d'avant l'aimant

Status: accepted, 2026-09-02. Lot S7, suite de [0011](0011-l-aimant-remplace-les-regles.md).

## Contexte
Le propriétaire, mot pour mot : « si je le fais "stick" à un mur par inadvertance qu'il puisse
reprendre son orientation originale si je le détache du mur ». Depuis 0011, `meubleWallSnap`
écrase `rot` par l'angle du mur dès que le dos d'un meuble entre à portée ; rien ne retenait ce
que `rot` valait avant. Un frôlement de mur pendant un glisser, ou un aimant déclenché sans le
vouloir, laissait donc une trace permanente même si le meuble finissait loin de tout mur.

## Décision
Une mémoire de session, `avantAimant` (`Map<id, rot>` dans `modele/aimant-memoire.ts`, jamais dans
le plan, jamais sur le fil : rien à déclarer en C-5) retient l'orientation d'avant le PREMIER
aimantage d'un meuble, et la restitue dès que son dos ressort de portée, dans le même glisser ou un
glisser ultérieur. `rotationAimantee(id, rotDepart, aimant)` est la seule fonction qui la lit et
l'écrit (`gestes/meuble.ts`, glisser simple) :
- aimanté maintenant → applique l'angle du mur ; si rien n'est encore retenu pour cet id, retient
  `rotDepart` (l'orientation au `pointerdown` de CE glisser) : un second aimantage, même geste ou
  geste suivant, n'écrase pas un original déjà retenu par l'angle du mur ;
- pas aimanté, quelque chose de retenu → rend ce qui est retenu, et le garde retenu (lâcher au
  milieu de la pièce puis regliser plus tard doit revenir au MÊME original, pas à celui du dernier
  geste) ;
- pas aimanté, rien de retenu → `rotDepart` inchangé.

**Alt suspend aussi ce mécanisme**, comme tout le reste (0011) : sous Alt, `rot` n'est jamais
touché par `rotationAimantee`, la fonction n'est pas appelée.

**L'entrée s'efface** dès que la personne tourne le meuble elle-même : la poignée de rotation
(premier mouvement du geste) et « Rotate 90° » appellent `oublierAvantAimant(id)`. Elle s'efface
aussi à la suppression du meuble (`delSel`). Les flèches ne tournent rien (0011/0013), donc rien à
faire de ce côté. **Un rechargement la perd** : changer de plan recharge déjà la page
(`panneaux/plans.ts`), qui repart d'un module neuf ; c'est assumé, pas un trou.

**Le glisser de groupe n'y touche pas.** Il ne fait déjà QUE de la translation : l'aimant y est lu
une fois sur la pièce sous la main et sa correction est portée en translation par tout le groupe,
sans jamais réécrire `rot` (0011, « TRANSLATION ONLY »). Sans rotation appliquée, il n'y a rien à
restituer au détachement pour un meuble en groupe.

## Ce qui a été rejeté
- **Appliquer l'aimant en rotation au meuble sous la main pendant un glisser de groupe**, pour que
  cette règle s'y applique symétriquement. Reviendrait sur le choix « translation only » de 0011,
  qui existe précisément pour ne pas déformer visuellement la sélection ; hors du périmètre de ce
  lot (« un lot = ce lot »).
- **Étendre la mémoire au dépôt depuis la palette** (`gestes/pose.ts`). Un meuble neuf n'a pas
  d'« avant » : son `rot` de catalogue est 0, arbitraire, pas un choix de la personne à préserver.
  Non fait, à discuter si le besoin se présente en usage réel.

## Conséquences
- Nouveau : `modele/aimant-memoire.ts` (~25 lignes utiles).
- `gestes/meuble.ts` : le glisser simple capture `rotDepart` au `pointerdown` et applique
  `rotationAimantee` (sauf sous Alt ou pendant un aimantage chaise-table, mécanisme distinct) ; la
  poignée de rotation oublie l'entrée au premier mouvement.
- `gestes/selection-actions.ts` (`delSel`) et `panneaux/inspecteur.ts` (`Rotate 90°`) oublient
  l'entrée.
- `tests/rapide.ts` couvre `rotationAimantee` en pur (aller-retour même geste, aller-retour geste
  suivant, rotation manuelle qui gagne, glissé le long du mur qui reste collé) ; un cas est écrit
  dans `tests/gestes-usage-reel.ts`, non lancé (consigne du propriétaire).
- `compat-donnees` ne bouge pas : rien n'est lu ni écrit dans le plan.
