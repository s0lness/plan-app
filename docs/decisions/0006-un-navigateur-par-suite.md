# 0006 - Un navigateur par suite, et un verdict qui s'attend

Status: accepted, 2026-08-17

## Contexte
Le 2026-08-17, la barrière de pré-déploiement a tourné **5 h 15 au lieu de ~6 min**, et les suites
qui ont fini ont rendu des verdicts qui ne parlaient pas du code : `model-v5-ancien-plan 0/11` en
1733 s, soit 157 s par cas, tous les cas tombant d'un bloc.

Six suites avaient chacune écrit sa **propre copie** du même harnais : construire une page
(graine + source de l'application + sonde), lancer un Chrome complet dessus en `spawnSync` avec
`--dump-dom` et un profil neuf sur disque, relire le verdict dans `<html data-plan-test="…">`.
Compté ce jour-là : `model-v5-*` 54 cas, `run` 29, `collab-annuler` 34, `deux-appareils` 24,
`collab-accuses` 13, `curseur-dire-deux-appareils` 5. **159 démarrages à froid par passage**, et
six exemplaires des trois mêmes défauts.

Sur machine calme, un démarrage à froid coûte ~0,6 s et personne ne le remarque. Mesuré le même
jour avec le poste à ~50 % de CPU (six sessions d'agents), un démarrage headless nu prenait 10 à
40 s, et **chaque copie passait un `timeout` FIXE à `spawnSync`** (90 s, parfois 60 ou 120).
Passé cette borne, Chrome était tué avant d'avoir rendu la page, aucun verdict ne revenait, et
toute la suite tombait. La borne fixe est aussi ce que le dépôt s'interdit partout ailleurs :
« attendre une CONDITION partout, jamais une durée ».

Écartés en chemin, par la mesure et non par l'intuition : les drapeaux de Chrome (la même
configuration a mis 9,7 s puis 39,5 s sur deux lancements consécutifs, donc l'écart entre deux
runs identiques dépasse l'écart entre configurations), le mode d'alimentation (déjà sur
« meilleures performances »), la file disque (0) et les défauts de page durs (3).

## Décision
1. **Un navigateur par SUITE, pas par cas.** `tests/_navigateur.ts` est le seul harnais : il ouvre
   un Chrome piloté en CDP (même plomberie que `tests/interactions.ts`) et chaque cas devient une
   simple `Page.navigate`. Les six copies s'y branchent, aucune ne garde de chemin de repli vers
   `spawnSync` : deux chemins cacheraient lequel a tourné.
2. **Le verdict s'attend comme une CONDITION.** L'attribut `data-plan-case` porte le nonce du cas
   et est écrit EN DERNIER, donc un verdict laissé à l'écran par la page précédente ne peut jamais
   être lu comme celui du cas courant. Une borne demeure, parce qu'un blocage doit échouer plutôt
   qu'attendre indéfiniment, mais elle **se calibre sur la médiane de la suite** (douze fois, jamais
   moins d'une minute) : une machine trois fois plus lente reçoit trois fois plus de marge.
3. **Une seule barrière à la fois** (`tests/all.ts`). Un fichier de verrou porte le PID du
   propriétaire et est ignoré dès que ce PID a disparu ; `--sans-verrou` passe outre pour le cas
   délibéré de deux barrières comparées. Trois barrières ont tourné en même temps ce jour-là,
   lancées par trois agents à qui on avait demandé de vérifier leur propre travail, et aucune n'a
   fini : celle qui a fini par rendre un verdict mesurait les deux autres.
4. **La barrière dit ce qui tourne, pendant que ça tourne.** Une ligne au DÉMARRAGE de chaque
   suite, et toutes les minutes le nom de ce qui est encore en vol avec son âge. Elle ne parlait
   qu'à la fin d'une suite : cinq heures de terminal muet, sans moyen de distinguer un run lent
   d'un run mort sans aller regarder la liste des processus.

L'isolation entre cas ne change pas. Elle n'est jamais venue du profil neuf : c'est le
`localStorage.clear()` / `sessionStorage.clear()` de la graine qui vide l'état, et il tourne
toujours en premier à chaque chargement, avant que l'application ne s'analyse.

`--virtual-time-budget` disparaît avec le processus par cas, et cela ne change rien d'observable :
chaque sonde est armée sur `setTimeout(run, 0)`, donc c'est le tout premier minuteur dans les deux
cas, et aucun corps de sonde du dépôt ne contient de minuteur (vérifié suite par suite). Le temps
virtuel n'a jamais réordonné les minuteurs, il les faisait seulement partir plus tôt.

## Mesuré
Machine calme, les cinq suites `model-v5`, ancien harnais contre nouveau, même application, même
instant :

| suite | ancien | nouveau | |
|---|---|---|---|
| `model-v5-ancien-plan` | 12,6 s | 1,8 s | ×7,1 |
| `model-v5-conversion-rendu` | 6,4 s | 1,7 s | ×3,7 |
| `model-v5-edition` | 10,9 s | 2,1 s | ×5,2 |
| `model-v5-fil-serveur` | 15,9 s | 2,5 s | ×6,3 |
| `model-v5-modele-defaut` | 36,8 s | 3,2 s | ×11,3 |
| **total** | **82,6 s** | **11,3 s** | **×7,3** |

`model-v5-modele-defaut` était la suite la plus longue de toute la barrière (~226 s en parallèle).

## Coût accepté
Les cas d'une même suite partagent désormais un navigateur, donc un état résiduel qui échapperait
à `localStorage.clear()` / `sessionStorage.clear()` traverserait d'un cas à l'autre, là où un
profil neuf l'aurait effacé de force. C'est un renoncement délibéré : le profil neuf coûtait 159
démarrages par passage pour se prémunir d'une fuite d'état que rien n'a jamais observée, et il
achetait cette garantie au prix de verdicts faux dès que la machine était chargée. Un test qui
ment sous charge est plus coûteux qu'un test qui partage un navigateur.

## Rejeté
- **Baisser `--jobs`.** Traiterait une saturation qui n'existe pas : le CPU était à 39 % pendant
  que la file d'exécution montait à 104. Le problème est l'équité de l'ordonnanceur, pas les
  cycles, et baisser la concurrence coûte des minutes par passage pour rien.
- **Régler les drapeaux de Chrome.** Mesuré et écarté : la variance entre deux lancements
  identiques dépasse la différence entre configurations.
- **Allonger le `timeout` de `spawnSync`.** C'est exactement ce que le dépôt s'interdit depuis le
  commit `c1b7fe1` : une pause plus longue ne fait que déplacer le seuil de charge où elle casse
  à nouveau.

## Trou constaté, pas comblé ici
`tsconfig.json` n'inclut que `src/ts/**` : **rien ne type le dossier `tests/`**. C'est ce qui a
laissé passer, pendant cette réécriture, un `await` manquant qui faisait lire une promesse comme
un verdict (`repli_d1_le_pair_adopte_le_changement`, faux rouge). Typer `tests/` est un lot à
part entière, et il vaut la peine.
