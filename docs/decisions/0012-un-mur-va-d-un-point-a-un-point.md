# 0012 - Un mur va d'un point à un point

Status: accepted, 2026-09-02. Lot 2 de `docs/simplification-2026-09-02.md`. **Renverse** le mur
traversant et son champ `free`, **renverse** [0009](0009-une-avancee-s-arrete-sur-le-mur-de-la-piece.md)
en entier, **retire la moitié « extension » de** [0007](0007-une-jonction-qui-se-romprait-est-pontee.md)
(le pont reste), **garde** [0005](0005-un-suiveur-ne-bascule-jamais.md) mot pour mot, et finit ce que
[0011](0011-l-aimant-remplace-les-regles.md) avait commencé en retirant la grille de 5 cm aux murs et
aux ouvertures.

## Contexte

Le relevé de `docs/simplification-2026-09-02.md` §3.2 nomme le mur « traversant » comme la deuxième
source de lourdeur, après le sol qui traçait (lot 1, décision 0010) :

> Un mur qui s'allonge tout seul jusqu'au prochain mur est un concept à nous, avec son état
> persistant (`free`), ses suiveurs, ses jonctions pontées, ses avancées qui s'arrêtent sur la
> pièce, son bouton Through / Free dans la fiche. Aucune app comparable ne le fait : un mur va d'un
> point à un point, et l'aimant fait le reste.

Ce que ça coûtait, mesurable dans le code plutôt que dans les mots : chaque endroit qui POSAIT
délibérément un bout de mur devait ensuite se protéger de la règle qui allait le déplacer. Le tracé
(`v5TryCreateWall`), le glisser d'un bout (`v5WallEndDragApply`), la coupe au « + »
(`v5CouperMurSelectionne`), la coupe d'un T (`v5CouperLesTraverses`), le redressement à l'équerre
(`v5RedresserMurSelectionne`), la longueur tapée et le pont de jonction (`v5PontsDeJonction`)
posaient tous `free = 1`, chacun avec son commentaire expliquant le désastre mesuré si on l'oubliait :
un mur de 154 cm parti à 716 cm après un redressement, deux moitiés superposées après une coupe, une
cloison de 60 cm traversant la pièce à sa naissance. La règle par défaut était fausse pour tout ce
qu'une main fabrique, et on la corrigeait sept fois.

Le champ lui-même a ensuite coûté sa propre série : `sanitizeV5Plan` le perdait à la relecture, puis
`v5WallWire` ne l'émettait pas, puis la LEVÉE du drapeau ne traversait pas le fil (il a fallu
distinguer « absent » de « remis à 0 »), puis la réception devait le fusionner à la création ET à la
mise à jour. Quatre défauts, tous sur un champ qui n'existe que pour désactiver un comportement que
personne n'a demandé.

## Décision

**Un mur va de `a` à `b`. Rien ne l'allonge, jamais.**

1. **Plus d'extension.** `v5ThroughWall` et `v5ThroughEnd` disparaissent. Ce qui reste s'appelle
   `v5BornerAuLogement` (`modele/edition.ts`) : le seul rognage par le contour, appliqué à tous les
   murs intérieurs, à chaque image, comme avant. Rogner n'est pas allonger, et « un mur va d'un
   point à un point » n'a jamais voulu dire « autorisé à sortir du logement ».
2. **Le champ `free` disparaît du client.** Il n'est plus dans `Mur` ni dans `MurFil`
   (`partage/plan.ts`), `sanitizeV5Plan` le LIT et le jette, `v5WallWire` ne l'émet plus, la
   réception ne le fusionne plus, et le couple de boutons Through / Free quitte la fiche du mur.
   **Le serveur, lui, ne change pas** : `WALL_KEYS` le garde (`live-worker/ops.ts` et sa copie
   vérifiée dans `partage/contrat-serveur.ts`), donc un onglet resté ouvert sur l'ancien code
   continue d'émettre des ops acceptées, dont ce champ ne fait plus rien de plus qu'être stocké.
3. **La jonction remplace l'extension.** Ce qui connecte deux murs, c'est l'aimant au moment du
   lâcher (`v5SnapWallEnd` via `v5WallEndDrop`), et c'est lui seul. Un bout à 2 cm d'un autre mur y
   est joint ; quand ce mur bouge, le bout suit (les suiveurs de 0005, inchangés), et si la jonction
   se romprait quand même, elle est pontée (0007, gardé).
4. **Plus de grille de 5 cm pour les murs ni les ouvertures.** Un mur, une façade, un sommet de
   contour et une ouverture se déplacent au centimètre. La clé `snap` quitte `Options`
   (`modele/migrations.ts`, lue tolérante par `cleanOpts` et jamais réécrite) et le modificateur
   `sansGrille` (Ctrl/Cmd) disparaît, n'ayant plus rien à contourner. `Alt` suspend les aimants,
   `Shift` contraint : deux touches, comme partout ailleurs dans l'app.
5. **La longueur tapée étire le bout LIBRE** (`v5BoutLibre`, même prédicat que les poignées de
   bout), `b` si les deux sont libres. Si AUCUN ne l'est, le champ est **désactivé** et la fiche dit
   pourquoi : choisir une jonction à déchirer est pire que refuser.

## Ce qui est renversé, précisément

- **0009 (« une avancée s'arrête sur le mur de la pièce ») part en entier.** `v5CoinSurCloison`,
  `glisserLeCoin`, `v5MurDeArete`, la mémoire des `t0` pour Échap et le message chiffré partent avec.
  0009 répondait à une encoche de 10 × 200 cm née d'une coupe de façade qui ne tombait pas sur la
  cloison de la pièce ; c'était un aimant de plus, à portée de doigt, qui déplaçait le coin d'une
  avancée en le disant. Sans la règle traversante, un plan ne se réarrange plus tout seul autour des
  coupes : si la coupe ne tombe pas où la pièce se termine, on la déplace au « + », en la voyant.
  La suite `tests/avancee-suit-la-piece-geste.ts` est supprimée.
- **De 0007, seule la moitié « extension » part** : le pont naissait `free`, « parce que le laisser
  traversant le ferait étirer par la règle du mur traversant, loin de la jonction même qu'il existe
  pour tenir ». Il n'y a plus de règle à fuir, donc le pont est un mur ordinaire. Le mécanisme
  lui-même (une jonction qui se romprait reçoit un segment, au relâchement, un par jonction) est
  **gardé mot pour mot** : c'est lui qui fait tenir la jonction que 0005 ne sait pas sauver.
- **0005 ne bouge pas.** Les deux règles (un suiveur ne bascule jamais ; il ne bouge que s'il se
  retrouverait dans le vide) sont exactement celles d'avant.
- **Le redressement à l'équerre garde ses trois seuils** et perd son gel. Contrepartie assumée : le
  mur d'EN FACE ne se rallonge plus tout seul jusqu'à la nouvelle droite (0009 comme le gel comptaient
  dessus). On le pousse, ou on tire son bout, ce qui est le geste ordinaire.

## Ce qui a été rejeté

- **Garder `free` dans les données « au cas où ».** Un champ que rien ne lit et que rien n'écrit est
  un chemin de code que personne ne teste, et il aurait fallu continuer de le faire traverser le fil
  correctement, ce qui a déjà coûté quatre défauts. Il est lu (donc aucun plan n'est refusé) et
  jeté.
- **Retirer aussi le rognage par le contour.** C'est la seule chose qui déplace encore un bout toute
  seule, et elle ne fait que raccourcir. Sans elle, pousser une façade vers l'intérieur laisse des
  cloisons qui dépassent du logement, ce qui n'est pas « un mur va d'un point à un point », c'est un
  plan faux.
- **Supprimer le pont de 0007 avec le reste.** C'est la demande explicite du propriétaire, deux fois
  avec des captures : « qu'un segment apparaisse pour tenir la jonction ». Rien dans ce lot ne la
  périme.
- **Garder la grille en option décochée.** Même réponse que 0011 : une option que personne ne coche
  est un chemin que personne ne teste.

## Conséquences

- **Les données ne bougent pas.** Une seule empreinte de `compat-donnees` change, celle de la
  fixture INVENTÉE `plan-champs-recents` (elle porte `free:1` exprès, pour C-5) : sa géométrie est
  identique au centimètre près avant et après, seule la clé `free` disparaît de la relecture. Les
  1068 autres, dont les plans réels du foyer, sont inchangées. `--figer` est donc délibéré et porte
  sur ce seul document.
- **En moins** : `v5ThroughEnd`, `v5ThroughWall`, `V5_JOIN_TOL`, `v5CoinSurCloison`, `v5MurDeArete`,
  `glisserLeCoin`, `sansGrille`, la clé `Options.snap`, le champ `Mur.free`/`MurFil.free`, les
  boutons `#rcThrough`/`#rcFree` et leurs quatre règles CSS, deux toasts (le gel après coupe, le
  chiffre de l'avancée), et deux suites (`tests/mur-libre.ts`, `tests/avancee-suit-la-piece-geste.ts`).
- **En plus** : `v5BornerAuLogement` (3 lignes, ce qui restait de `v5ThroughWall`), `v5BoutLibre`
  (5 lignes), la note `#rcLenNote` de la fiche, et cinq cas dans `tests/rapide.ts`.
