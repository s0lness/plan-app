# 0023 - Les tests repartent de zéro, et aucun ne lance de navigateur

Status: accepted, 2026-09-02. Revue du 2026-09-02.

## Décision
Le propriétaire : « on vire tous les tests et on reprend de zéro ». Les suites navigateur et leur
harnais disparaissent EN ENTIER, et il n'y en aura plus. La graine de la nouvelle base est ce qui
tourne sans navigateur en moins de vingt secondes et protège les données ou la porte.

## Ce qui est parti
53 fichiers de `tests/` et 18 681 lignes : les 26 suites navigateur, les suites au geste, les
statiques (`exports-morts`, `no-dead-selectors`), les mesures de performance, les suites pures
(`projection`, `fenetre-battement`, `bouts-de-mur`, `coude-mur`, `jonction-glisser-mur`,
`etiquettes-disposition`, `chaise-dossier`, `identite-fil`, `invite-fil`, `partage-fil`,
`carte-og`), le harnais `_navigateur.ts` / `_harness-v5.ts` / `_typecheck.ts`, deux fixtures
(`exports-morts-connus.json`, `plan-etiquettes-dense.json`), et l'ancien `all.ts` (barrière
parallèle, permis machine, priorité basse, tranches, seconde chance, tueur de Chrome).

Avec elles, les sept sondes `src/ts/sonde*.ts` (1 456 lignes) : la surface `window.__plan`
n'avait plus de consommateur, et le livrable ne contient plus la chaîne `__plan`. Quatorze exports
que seules les sondes appelaient redeviennent internes ; les neuf fonctions qui n'existaient que
pour elles (`toastText`, `clearToast`, `planClipInfo`, `planClipReset`, `lassoVivant`, `gesteArme`,
`vieillirGeste`, `fileEnAttente`, `mesuresPosees`) et la sortie anticipée `__PLAN_TEST__` de
`fil/presence.ts` sont supprimées. `index.html` perd 18 886 octets.

## Ce qui est gardé, et pourquoi
Six suites, parce qu'elles tournent sans navigateur, en quinze secondes à elles toutes, et parce
que chacune protège soit les données du foyer, soit la porte :

- `tests/rapide.ts` : la boucle de travail, tout `src/ts` importé directement.
- `tests/compat-donnees.ts` : l'oracle des données, empreintes figées d'un corpus réel.
- `tests/harnais-graine.ts` : graine déterministe, vrai client contre vrai serveur.
- `tests/porte.ts` et `tests/invitation.ts` : la porte foyer et l'invité, Functions importées.
- `live-worker/test-local.ts` : le serveur.

Le nouveau `tests/all.ts` fait quarante lignes : les deux passes `tsc --noEmit`, puis ces six
suites en séquence, une ligne chacune, code de sortie non nul dès qu'une échoue.

## La règle de la nouvelle base
**Un test se fait sans navigateur, par règle du modèle ou du fil, et il est vu ROUGE avant d'être
vu VERT.** Un test qui ne peut pas échouer ne vaut rien. Les gestes, le rendu et l'aller-retour à
deux appareils se vérifient dans Chrome, à la main, par le propriétaire : c'est un jugement, pas
une assertion, et le prix payé pour l'automatiser était une barrière de sept minutes qui saturait
le poste.

## Ce que ça rend historique
- 0006 (un navigateur par suite, verdict qui s'attend) : plus aucun navigateur n'est piloté ici.
- 0008 (un Chrome orphelin se tue par son chemin) : plus aucun Chrome n'est lancé, donc aucun ne
  reste orphelin, et le pool de permis machine ne sert plus.

0017 (une sonde sans consommateur n'est pas une sonde) survit dans sa conclusion : la surface de
sondes n'a plus de consommateur du tout, elle est donc partie en entier.

## Rejeté
Garder une ou deux suites navigateur « pour les cas critiques » : une barrière qui lance un
navigateur redevient une barrière qu'on n'ose plus lancer, et c'est exactement ce qui a fait
mourir la précédente.
