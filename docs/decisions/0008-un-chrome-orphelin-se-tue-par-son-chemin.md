# 0008 - Un Chrome orphelin se tue par son chemin, et il y en a moins qu'on croit

Status: accepted, 2026-08-19.

## Contexte

Le 19/08/2026 à 11h11 la station a gelé sept minutes : Chrome de 44 à 264 processus, 1,98 Go de RAM
libre, une file d'exécution de 318 sur 12 cœurs. La cause est connue et n'est pas discutée ici :
neuf worktrees de ce dépôt lançaient chacun `tests/all.ts` avec son propre plafond de 8, plus un
autre projet en Puppeteer. Chaque lanceur était poli ; aucun ne voyait les autres.

Deux gardes en découlent, posées dans `tests/all.ts` et déjà en service :

- **le plafond de navigateurs est MACHINE, pas processus** : `lance()` prend `suite.chrome` permis
  auprès du pool de local-agent (`:5100`), tous worktrees confondus. Un permis = UN navigateur, pas
  une suite. `JOBS` continue de borner le nombre de suites lancées ici ; les deux plafonds se
  composent. Pool injoignable : on exécute quand même, une barrière ne doit jamais dépendre du
  superviseur ;
- **une suite muette cinq minutes est tuée et comptée en échec.** Le balayage d'orphelins ne
  récupère que ce qu'un process MORT laisse ; une suite figée gardait son créneau, son navigateur
  et son permis, indéfiniment, sans rien dire.

Restait un troisième défaut, apparent : la quasi-totalité des suites à navigateur finit par
`ws.close(); chrome.kill(); process.exit(...)` en script de haut niveau, sans `try/finally`. Tout
ce qui lève avant cette ligne saute le `kill()`. Un lot a donc été écrit pour installer un ménage
partagé (registre des process, des dossiers et des sockets ; nettoyage sur `exit`,
`uncaughtException`, `unhandledRejection`, `SIGINT`, `SIGTERM`), sur 34 fichiers.

## Ce que la mesure a dit

Protocole : une exception injectée juste après le démarrage du navigateur, hors de tout `try` ;
comptage des `chrome.exe` dont la ligne de commande porte le dossier privé de la suite, relevé
quatre secondes après la mort du node.

| variante | survivants |
| --- | --- |
| aucun ménage, code d'origine | **0, 0, 0, 0** (4 lancers) |
| le ménage tel qu'écrit | **6, 7, 9, 10, 11** |
| le ménage corrigé (tuer par chemin AVANT d'effacer le dossier) | **0, 0, 0** |

Deux conclusions, dans cet ordre.

**La prémisse ne se reproduit pas.** Quand le node meurt d'une exception, son Chrome meurt avec
lui : les tubes d'entrée-sortie se ferment et le navigateur s'arrête tout seul. Le `kill()` sauté ne
laissait rien derrière lui.

**Et le ménage produisait exactement ce qu'il prétendait empêcher.** Il effaçait le profil sous un
navigateur vivant, et il ne tuait que le process racine. Or un Chrome n'est pas un process, c'est
une famille : navigateur, `gpu-process`, `utility`, un rendu par page, `crashpad-handler`. Trois
façons de la tuer, mesurées :

- `p.kill()` : ne touche que la racine, sans effet sur le reste ;
- `taskkill /F /T /PID <racine>` : tue les enfants, **pas la racine** (il sort en 128), et le
  navigateur en relance aussitôt d'autres ;
- **énumération par CHEMIN**, `Get-CimInstance Win32_Process` filtré sur le dossier privé, puis
  `taskkill /F` par PID, en deux passes : converge à zéro. C'est déjà ce que fait
  `tueArbresEtEfface` dans `tests/all.ts`, et c'est le seul critère qui décrit la famille entière.

## Décision

**Le lot des 34 fichiers n'est pas livré.** Il corrigeait un défaut qui ne se manifeste pas, en
touchant toute la barrière la veille d'un déploiement, et sa version livrable dégradait la mesure.

**Le nettoyage des navigateurs reste centralisé dans `tests/all.ts`**, par chemin, après la sortie
du process fils. Le filtre est le dossier privé (`<TEMP>/plan-run-…`), jamais le nom du process :
un `taskkill /IM chrome.exe` fermerait le navigateur de l'utilisateur, ce que ce dépôt s'interdit
depuis le 04/08.

**Si quelqu'un rouvre le sujet**, la charge de la preuve est le tableau ci-dessus : montrer d'abord
des orphelins qui survivent réellement, avec des chiffres, avant d'écrire la garde. Une garde se
juge sur son NOUVEAU mode de panne, et celui-ci était de fabriquer dix orphelins là où il n'y en
avait aucun.
