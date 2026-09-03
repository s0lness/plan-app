# La barrière

```
node tests/all.ts
```

Une vingtaine de secondes: les deux passes `tsc --noEmit`, puis six suites sans navigateur, en
séquence, une ligne chacune. Code de sortie non nul dès qu'une échoue. Chaque suite se lance
aussi seule (`node tests/rapide.ts`).

| Suite | Couvre |
|---|---|
| `tests/rapide.ts` | Boucle de travail: subdivision planaire, bornes d'ouverture, assainissement, arc de porte, moteur Circulation, forme du fil, refus serveur, diff et annulation. Tout est importé de `src/ts`. |
| `tests/compat-donnees.ts` | L'oracle de compatibilité des données: relit le corpus par `src/ts` et compare son empreinte à `tests/fixtures/empreintes-compat.json`. `--corpus <dir>` ajoute un corpus privé hors dépôt. `--figer` est un acte délibéré. |
| `tests/harnais-graine.ts` | Graine déterministe, client contre vrai serveur: convergence des ops et aller-retour annuler/refaire. |
| `tests/porte.ts` | La porte foyer: `functions/porte.ts`, le middleware et les Functions du plan, importées directement. |
| `tests/invitation.ts` | L'invitation: `functions/api/invite(s).ts`, jeton, orphelins, `tests/fake-d1.ts`. |
| `live-worker/test-local.ts` | Le serveur: validateur, ops, Durable Object, repli D1, séquencement et déduplication par (tag, n). |

## La règle de cette base

Un test se fait sans navigateur, par règle du modèle ou du fil, et **il est vu ROUGE avant d'être
vu VERT**. Les gestes (souris, clavier, rendu) se vérifient dans Chrome, à la main, par le
propriétaire: voir `docs/decisions/0023-les-tests-repartent-de-zero.md`.

À la main, avant une livraison qui touche au démarrage: ouvrir `index.html` dans un profil
vierge (aucun `localStorage`), vérifier que l'assistant s'ouvre et qu'aucune erreur JS ne sort.
