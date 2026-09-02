# 0019 - Une couche de diagnostic se lit, ou elle se retire

Status: accepted, 2026-09-02. Lot R2 (couches mortes du client) de la revue du 2026-09-02.

## Contexte
Le propriétaire : « notre app est un peu clunky, et pourrait être simplifiée ». Le client portait
trois couches d'observation qui ne servaient plus à observer quoi que ce soit :

- **65 entrées de `window.__plan`** sans aucun lecteur dans `tests/`, en comptant chaque nom mot
  pour mot, suites navigateur incluses. La décision 0017 avait retiré les sept entrées de
  `sonde-config.ts` et écrit ce qui restait à faire : « le reste (`sonde-export.ts` surtout, une
  vingtaine d'entrées de mesure et d'impression) attend un lot qui pourra suivre la cascade
  jusqu'au bout ». Ce lot est celui-là.
- **Le HUD de latence** (`fil/hud.ts`, `?rt=1`, `window.__rtStats`) : un instrument de terrain que
  personne n'ouvre. Il coûtait quatre compteurs dans `Fil` (`curIn`, `curOut`, `dragOut`,
  `paintLat`), une mesure `performance.now()` dans la boucle de réception des curseurs et un
  `setInterval` de 500 ms dès que `?rt=1` était présent.
- **L'enregistreur de vol** (`app/diagnostics.ts`) : la piste de 25 miettes, la sentinelle de page
  blanche avec sa cadence de 3 s / 10 s, `__forceSentinel`, et la bannière rouge d'erreur. Né de la
  saga « page blanche » de juillet, close depuis le calque unique.

Deux mesures ont tranché plutôt qu'une intuition. D'abord `functions/api/err.ts` : le serveur écrit
`msg`, `src`, `stack`, `ua`, et **jamais `crumbs`**. La piste de miettes était donc sérialisée à
chaque erreur, envoyée sur le réseau, et jetée à l'arrivée. Ensuite la sentinelle : sa seule preuve
était `v5_white_page_sentinel_is_quiet`, un test qui vérifie qu'elle **ne dit rien**.

## Décision
Une couche de diagnostic existe parce qu'un lecteur la lit. Sans lecteur, elle se retire, et avec
elle ce qui n'existait que pour elle.

1. **Les 65 entrées de sonde sans lecteur partent**, et la cascade suit. Une fonction qui garde un
   appelant réel (le bouton d'export PNG, l'impression, le ruban de mesure) perd seulement son
   `export` ; celle qui n'a plus aucun appelant disparaît (`mesureEnAttente`,
   `resetMeasurePending`, `drawCursorGuidesNow`, `puceTexte`). Le cliquet `exports-morts` reste à
   zéro sans exemption nouvelle.
2. **`fil/hud.ts` disparaît en entier**, avec `__rtStats` et les cinq champs de `Fil` qui ne
   servaient qu'à lui. Le fil ne change pas : le client envoie toujours son `ping`, le serveur
   répond toujours son `pong` avec l'empreinte du plan (c'est cette empreinte, pas le temps
   d'aller-retour, qui fait travailler le `pong`).
3. **`app/diagnostics.ts` se réduit au rapport d'erreur non capturée** : `window.onerror` et
   `unhandledrejection` alimentent l'anneau local `plan-errors` et le `POST /api/err`, dont la
   limite de débit et la rétention vivent côté serveur. Le crochet `ctx.crochets.reportError`
   reste : c'est le seul chemin par lequel une exception attrapée (fin de geste, bascule de calque)
   atteint encore l'anneau.
4. **`peindreCurseurPair` disparaît** : c'était un second chemin de peinture d'un curseur de pair,
   avec sa propre carte de curseurs, dont le seul appelant était la sonde. La sonde construit
   désormais son nœud avec `creerNoeudCurseur`, la fabrique que `fil/presence.ts` utilise déjà.

## Ce qui a été rejeté
- **Retirer aussi l'anneau `plan-errors`**, que la consigne du lot rangeait avec le reste de
  l'enregistreur de vol. Une vingtaine de suites navigateur le relisent après chaque cas pour
  déclarer un échec sur une erreur JS non capturée : sans lui, une erreur du client ne serait vue
  par PERSONNE et la barrière rendrait un FAUX vert. Ce n'est pas un souvenir, c'est le seul œil
  des suites.
- **Retirer les correctifs automatiques de `circulation/correctifs.ts`** (famille 6 du lot). Un
  bouton les déclenche toujours, dans chaque constat du panneau Circulation
  (`circulation.ts:114`, `b.className = "btn sm fix"`). Ils restent.
- **Retirer `pollPull` quand le fil est vivant** (famille 4). Le repli D1 n'est pas doublé : la
  toute première ligne de `pollPull` sort déjà si `wsLive(fil)`, donc le sondage de 4 s ne fait
  rien tant que le temps réel tient. La liste des cinq versions écartées et sa bannière restent,
  par sécurité des données (décision 0003).
- **Retirer l'entrée de sonde `lastFit`.** Elle n'a aucun lecteur, mais elle est le seul appelant de
  `v5LastFit`, un export de `modele/edition.ts`, hors de la zone de ce lot. Elle reste, la raison
  écrite sur place, comme la décision 0017 l'avait fait pour `scheduleAnalysis`, `drawOverlay` et
  `setFlowOpen`, qui ont depuis retrouvé de vrais appelants.

## Conséquences
- 759 lignes retirées pour 135 ajoutées sur la zone du lot, deux fichiers en moins
  (`src/ts/fil/hud.ts`, la moitié de `app/diagnostics.ts`).
- La bannière rouge d'erreur n'existe plus : une exception non capturée est désormais silencieuse à
  l'écran, et visible dans `plan-errors` et dans la table `errors` du serveur. C'est ce que dit la
  décision 0014 (« l'app se tait ») : un message existe pour dire pourquoi un geste délibéré n'a
  pas eu d'effet, et un plantage n'est pas un geste.
- L'invariant R-17 (anti page blanche) garde ses deux barrières à la source (`safeDim`, la borne du
  pas des motifs de sol) et perd la sentinelle qui guettait le symptôme.
- Le compte reste vérifiable : chaque nom d'entrée de sonde doit se retrouver, mot pour mot, dans
  `tests/`.
