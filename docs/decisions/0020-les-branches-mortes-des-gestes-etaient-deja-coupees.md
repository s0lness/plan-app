# 0020 - Les branches mortes des gestes étaient déjà coupées

Status: accepted, 2026-09-02. Lot R4 de la revue du 2026-09-02. Ne renverse aucune décision:
il constate le résultat de [0010](0010-le-mur-est-un-outil-le-sol-un-lasso.md),
[0011](0011-l-aimant-remplace-les-regles.md), [0012](0012-un-mur-va-d-un-point-a-un-point.md),
[0013](0013-une-action-un-chemin.md) et [0019](0019-une-couche-de-diagnostic-se-lit-ou-se-retire.md).

## Contexte

Le lot cherchait 20 % de code en moins dans `src/ts/gestes/**` et dans ce que ces gestes
n'appellent plus de `src/ts/rendu/calque.ts`. La méthode était la bonne: partir des entrées
(`gestes/branchement.ts`, `main.ts`, `gestes/clavier.ts`, les crochets `ctx.gestes.*` que le rendu
appelle) et suivre les appelants, parce qu'une fonction exportée appelée uniquement par une
fonction morte reste verte au typecheck.

La chasse n'a presque rien trouvé, et c'est le résultat. Les cibles nommées dans l'énoncé étaient
déjà parties avec les lots qui les avaient décidées: `v5StartDraw` et l'ancien tracé au glisser,
`sansGrille`, `estPrecis`, `Options.snap`, `v5CoinSurCloison` et les avancées de 0009,
`v5ThroughWall`/`free`, le double-clic qui tournait, l'armement par clic souris à la palette,
`poserAuCentre`, `pieceSousD`. Il ne restait ni fonction sans appelant (`exports-morts` est à zéro
et le reste), ni fonction interne sans appelant: chacune des 120 fonctions de la zone est atteinte
depuis une entrée réelle.

## Décision

**Ce qui reste dans les gestes est vivant, et ce qui pesait était de la copie, pas du mort.** Deux
familles seulement:

1. **Une couche de diagnostic sans lecteur n'est pas une couche.** `v5LastFit` (`modele/edition.ts`)
   et son ardoise `ardoiseFit` n'avaient plus qu'un lecteur, l'entrée `lastFit` de
   `sonde-gestes.ts`, qu'aucune suite n'interroge. Le commentaire de la sonde le disait mot pour
   mot et se retenait de la retirer par respect du périmètre d'un autre lot: c'est exactement le
   raisonnement que 0019 refuse. L'accesseur, l'ardoise et ses trois écritures partent ensemble.
2. **Six contrôles de mur, un seul patron.** Dans `drawHandles` (`rendu/calque.ts`), déplacer, les
   deux bouts, ressouder, supprimer, couper et redresser étaient six copies des mêmes huit lignes;
   seuls le glyphe, la taille et l'acte différaient. Un constructeur les porte tous, attribut pour
   attribut, dans le même ordre, donc le DOM peint est identique. La liste des classes de poignées,
   tenue à la main en quatre endroits, devient une constante partagée (`SEL_POIGNEES`): c'est
   l'oubli de `.v5wjoin` dans l'une de ces copies qui avait laissé deux « - » flotter en l'air.

## Ce qui a été rejeté

- **Retirer la quantification `DIR8` de `v5WallEndDrop`** au motif que le tracé la porte déjà. Ce
  sont deux gestes différents: le tracé quantifie depuis le départ de la CHAÎNE, le glisser de bout
  quantifie depuis le bout FIXE du mur existant. Le tracé passe d'ailleurs par `v5WallEndDrop`
  (`pointVise`): il n'y a qu'une implémentation, pas deux.
- **Retirer les paramètres morts `tol` et `opts` de `v5ClampPiece`**, et avec eux
  `OptionsClampPiece`, `opts.gardeOrphelin` et le `tolIn` de `clampCenterToInset`
  (`gestes/contraintes.ts`). Aucun des cinq appelants ne les passe depuis 0011: `TOL` vaut toujours
  `INSET_TOL`, la branche `gardeOrphelin` n'est jamais prise. La coupe est légitime mais elle part
  de `modele/edition.ts`, hors du périmètre de ce lot, et `tolIn` ne peut pas tomber seul de son
  côté. Signalé au lot qui tient le modèle.
- **Le rebond du double-clic meuble** (`branchement.ts`: `meubleDblClick` teste `etiquetteSous`
  puis délègue à `etiquetteDblClick`, qui refait le même test de collision). Le second test n'est
  pas redondant: il tourne APRÈS un `render()` qui a pu déplacer l'étiquette, c'est écrit sur
  place, et le premier est la garde qui évite d'ouvrir une renommée depuis le corps du meuble.

## Conséquences

- `src/ts/rendu/calque.ts` −24 lignes, `modele/edition.ts` −11, `sonde-gestes.ts` −4,
  `gestes/murs.ts` −4, `gestes/vue-interactions.ts` −1. Rien à l'écran ne change: mêmes nœuds,
  mêmes attributs, mêmes gestes.
- **Les données ne bougent pas**: `compat-donnees` rend les mêmes 1069 empreintes, sans `--figer`.
- **Aucune suite supprimée**: aucun comportement n'a disparu.
- **Le chiffre demandé n'a pas été atteint, et il ne l'aurait pas été honnêtement.** Les 20 % que
  cherchait ce lot avaient déjà été retirés par les lots 1 à 4; ce qui reste dans `gestes/**` est
  du commentaire d'incident (ce dépôt garde le pourquoi près du code) et de la géométrie qui
  s'exécute. Couper plus aurait voulu dire changer un comportement, ce que ce lot n'avait pas le
  droit de faire.
