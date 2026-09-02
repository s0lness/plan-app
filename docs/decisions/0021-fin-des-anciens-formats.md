# 0021 - Les formats v1 à v4 ne sont plus lus, et un plan qu'on ne lit plus n'est pas jeté

Status: accepted, 2026-09-02. Lot R1 (fin des anciens formats) de la revue du 2026-09-02.

## Contexte

Le propriétaire veut 20 % de code en moins. Le plus gros bloc mort du dépôt était la LECTURE des
formats antérieurs au modèle murs-seuls : v1/v2/v3 (une pièce, `{room, pieces}`), v4 (`rooms[]` +
`envelope`), et le chemin v4 côté serveur.

Ce que disaient les faits, pas une intuition :

- Le plan du foyer a été converti en murs-seuls le **2026-08-03**. Depuis, tout plan naît murs-seuls
  (`defaultState`, `emptyPlan`), et le serveur ne reçoit plus aucune op v4 : `ops.ts` le notait déjà
  en toutes lettres, « v4 is now only a READ path ».
- Les seuls blobs v1-v4 qui existent encore sont un `room-planner-v4-backup` dans le `localStorage`
  de deux navigateurs, que **rien ne relit** : l'entrée de menu qui le rechargeait avait été retirée
  le 2026-08-05, et `v5RestoreBackup()` n'était plus atteignable que par une sonde de test. Un filet
  qu'on ne peut plus attraper n'est pas un filet (c'est ce que disait déjà D-3, « robustesse : par
  accident »).
- Coût de ce chemin mort : cinq modules client (`lecture-v4`, `conversion-v4`, `salles-anciennes`,
  `enveloppe`, `restauration`), la moitié du validateur serveur (`validateRoom`, `validateEnvelope`,
  `findRoom`, `applyOpV4`, dix genres d'op), deux suites navigateur, six documents de corpus, et une
  bonne part d'`AGENTS.md`.

Le D1 de production n'a **pas pu être relu ce jour-là** (l'API de requête D1 répondait « internal
error » sur `SELECT 1`). C'est ce qui a décidé la forme de la décision : on retire la lecture, on
garde un filet.

## Décision

**1. `migrate()` n'accepte plus que le modèle murs-seuls**, imbriqué (`st.plan`, la copie locale
complète, qui garde la priorité) ou à plat (la forme serveur). Toute autre forme rend `null`.

**2. Un blob refusé n'est ni converti ni jeté : il prend le chemin déjà existant du « plan
illisible » (D-2).** Côté client, l'amorçage met ses octets de côté **tels quels** sous
`room-planner-v4-backup-illisible`, avant que quoi que ce soit ne les remplace, `setupDone` retombe
à faux (donc aucune publication ne part de cet appareil), et une bannière propose le
téléchargement. Côté serveur, `sanitizeState` refuse la ligne, `coldLoad` la sert **brute**
(`source:"raw"`, ce qu'il faisait déjà pour un état que le validateur courant refuse), et `applyOp`
n'accepte plus **aucune** op sur un tel état, sauf `plan5.replace` : c'est la sortie de secours, et
c'est ce qui empêche une op murs-seuls de greffer un demi-plan sur des octets qu'on ne sait plus
lire.

**3. Les trois clés historiques ne sont plus lues** (`room-planner`, `-v1`, `-v2`, `-v3`). Leurs
octets restent où ils sont, intacts.

**4. Les genres d'op v4 disparaissent du serveur** (`room.*`, `env.*`, `plan.replace`), de `OP_KEYS`
et de l'aiguillage. Un vieil onglet qui en émet une reçoit `err unknown_kind`, que le client lit
**exactement comme `op_shape`** (`fil/presence.ts` : conflit de modèle, annonce, rechargement).
`plan5.replace` reste.

**5. Les deux fixtures de graine du dépôt ont été CONVERTIES une fois, dans le dépôt**
(`tests/fixtures/plan-reel-77.json`, `plan-rev177.json`), par le convertisseur juste avant son
retrait. Elles servent de graine à une vingtaine de suites navigateur : les laisser en v4 aurait
fait démarrer ces suites sur la bannière « plan illisible ». Leurs **trois empreintes de
compatibilité n'ont pas bougé d'un caractère** (`fp`, `octets`, `local`), ce qui prouve que la
conversion figée dans le dépôt est exactement celle que l'application faisait à chaque ouverture.

## Ce qui a été rejeté

- **Convertir les blobs restants au chargement, une dernière fois, puis retirer le code.** Il n'y a
  pas de « dernière fois » vérifiable : le D1 n'a pas pu être relu, et deux navigateurs ne sont pas
  un inventaire. Une conversion silencieuse d'un plan qu'on n'a pas vu est exactement le risque que
  D-2 existe pour éviter.
- **Jeter les blobs refusés** (repartir sur un appartement par défaut). C'est le défaut mesuré qui a
  fait naître D-2 : 6 040 octets de plan devenus 1 692 octets d'appartement par défaut, sans copie et
  sans un mot.
- **Garder `validateRoom`/`validateEnvelope` « au cas où ».** Un validateur qu'aucun chemin
  n'atteint ne valide rien ; il fait croire que quelque chose est protégé.
- **Inventer un motif de refus `op_kind`.** `unknown_kind` existait déjà et le client le traite
  déjà comme un conflit de modèle. Un motif de plus, c'est une branche de plus des deux côtés.

## Conséquences

- **Supprimé** (client) : `modele/lecture-v4.ts`, `conversion-v4.ts`, `salles-anciennes.ts`,
  `enveloppe.ts`, `restauration.ts`, `v5BackupLegacy`/`v5BackupInfo` dans `filets.ts`, les clés
  `KEY_V3`/`KEY_V2`/`KEY_OLD`/`V5_BACKUP_*` et `V5_SNAP`, `wallInwardNormal`/`wallFacingRot`
  (`geometrie/polygones.ts`) et `v5SnapToOutline` (`modele/conversion.ts`), devenus sans appelant.
- **Supprimé** (serveur) : `LegacyRoom`, `rooms`/`envelope` de `PlanState`, `validateRoom`,
  `validateEnvelope`, `findRoom`, `applyOpV4`, `isFloorValue`, `V4_KINDS`/`V5_KINDS`,
  `upgradeEmptyLegacy` (`worker.ts`), la branche v4 de `canonPlan` et de `sanitizeState`.
- **Déplacé, pas supprimé** : `rectPoly` et `lShapePoly` vers `geometrie/polygones.ts` (ce sont des
  constructeurs de polygones, ils servent aux presets et à l'assistant) ; `prochainUid` et
  `reglerCompteurs` vers `modele/creation.ts` (naissance d'un meuble).
- **`defaultState()` construit directement** le contour et ses quatre murs de façade au lieu
  d'écrire un plan v4 et de le convertir. Vérifié : le plan produit est **identique**, cellule et nom
  compris.
- **Suites retirées** : `tests/model-v5-ancien-plan.ts`, `tests/model-v5-conversion-rendu.ts` (et de
  `SUITES` dans `tests/all.ts`). Les cas de conversion, de sauvegarde et de restauration ont aussi
  quitté `model-v5-modele-defaut.ts` et `run.ts`.
- **Corpus de `compat-donnees`** : les six documents v1-v4 partent, deux entrées de REFUS les
  remplacent (`refus-v4-salles`, `refus-v3-mono-piece`), et `abime-outline-court` change de verdict
  (il retombait sur le chemin ancien format et revenait en appartement par défaut ; il est
  maintenant refusé, donc mis de côté). Les **huit empreintes v5 restantes n'ont pas bougé**.
- **Invariants** : D-3, D-5 et D-6 sont retirés (ils décrivaient la lecture des anciens formats),
  D-4 est réécrit.
- Un foyer dont la ligne D1 serait encore dans une forme ancienne ne perd rien, mais ne peut plus
  éditer : sa ligne est servie brute et refuse toute op. La sortie est un `plan5.replace`, donc un
  client qui sait encore convertir, ou une intervention. C'est le prix assumé du filet.
