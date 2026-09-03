# 0018 - Le livrable ne transporte que ce qui s'exécute, et le serveur ne relit pas deux fois le même plan

Status: accepted, 2026-09-02. Lot P2 (serveur, Functions, build) de la revue du 2026-09-02.

## Contexte
Le propriétaire : « Read the code. Find things to simplify or remove. Make performance
optimizations ». Deux mesures ont servi d'entrée, pas une intuition :

- `index.html` pesait **448 633 octets**. Le JS y était minifié depuis toujours (esbuild), mais le
  CSS (73 183) et le HTML (36 084) y entraient **tels quels**, commentaires de conception et
  indentation compris. Le navigateur télécharge donc, à chaque chargement froid, une trentaine de
  kilo-octets d'explications écrites pour un lecteur de `src/`.
- Sur un plan de 300 meubles, une op reçue par le Durable Object coûtait **1 059 us** de CPU
  (`structuredClone` + `applyOp` + `planTooBig` + `planFp` + la sérialisation de `storage.put`).
  Deux postes n'étaient pas du travail utile : `strHash` traversait la chaîne canonique **deux
  fois** (une fonction de mélange par passe), et `planFp` était calculé **dans** le constructeur de
  message de `broadcastFor`, donc une fois par audience, alors qu'une empreinte de plan ne dépend
  pas de qui la lit.

## Décision
**1. Le CSS et le HTML servis sont compactés au build** (`serrer()` dans `build.ts`) : commentaires,
indentation, lignes vides. Rien d'autre. Aucune fusion de lignes, aucune réécriture de sélecteur,
aucun point-virgule retiré : **une ligne source reste une ligne**, donc les espaces entre éléments
en ligne (que le rendu HTML compte) sont préservés au caractère près. `--dev` ne compacte pas :
`index.dev.html` est l'artefact de débogage, il se lit.

Deux gardes font échouer le build si la compaction cesse d'être sûre : un `url(...)` dans le CSS
(le retrait des commentaires pourrait couper une donnée) et un contenu HTML où l'espace compte
(`<pre>`, `<script>` en ligne, `<textarea>` non vide). Aujourd'hui il n'y en a aucun.

**2. La cible esbuild passe de `es2019` à `es2020`.** La raison écrite pour `es2019`
(`docs/reecriture.md` : « la source n'utilise ni `?.` ni `??`, vérifié, zéro occurrence dans
`src/js/` ») portait sur l'ancien client. Le client typé en compte **1 480** sur 54 fichiers, toutes
réécrites en cascades de ternaires pour rien. `?.`, `??` et `??=` sont natifs depuis Chrome 80 et
Safari 13.4, donc sur l'iPhone du foyer.

**3. `strHash` lit chaque caractère une seule fois** et avance les deux mélangeurs (FNV-1a et
djb2-xor) dans la même boucle. Les deux valeurs produites sont identiques à celles d'avant : les
empreintes ne bougent pas, ce que `compat-donnees` vérifie sur 1 069 cas figés.

**4. `planFp` est calculé une fois par op**, hors du constructeur passé à `broadcastFor`.

## Ce qui a été rejeté
- **Supprimer le `structuredClone(this.plan)` de `applyOp`** (392 us, le premier poste du chemin).
  Il porte la garantie « une op refusée ne laisse pas le plan à moitié modifié » : l'appliquer puis
  l'annuler demanderait un inverse par sorte d'op, soit un mécanisme neuf dans le chemin le plus
  critique du serveur, pour un lot dont la consigne est de retirer. À mesurer à part si le plan de
  quelqu'un grossit vraiment.
  **Repris et fait le 2026-09-03** : il n'a pas fallu d'inverse par sorte d'op. `applyOp` ne
  écrivait déjà jamais avant d'avoir fini de valider (c'est ce que prouve le corpus d'atomicité),
  et il ne mutait plus rien en place une fois les quatre `list[i] = e` / `list.push(e)` passés au
  remplacement de liste (`putEntity`) : une copie PLATE des champs du plan (sept clés) décrit donc
  l'état d'avant en entier. `applyOpUndoable` la prend et rend le retour arrière, que les deux seuls
  refus postérieurs à l'écriture appellent (plafond de taille, storage qui refuse). Mesuré ici :
  1090 -> 504 us par op sur un plan de 300 meubles.
- **Coaliser `persistPlan` sur un `setTimeout(0)` ou l'alarme.** AGENTS.md fait de « l'accusé dit
  appliqué ET persisté » une règle : une coalescence rendrait l'accusé menteur pendant la fenêtre.
- **Minifier le CSS pour de bon** (fusion des lignes, raccourcis de couleurs, suppression du dernier
  point-virgule). Gain supplémentaire modeste au regard du risque, et il faudrait une dépendance ou
  un mini-analyseur maison : la compaction ci-dessus prend l'essentiel sans rien comprendre au CSS.
- **`charset: "utf8"` dans esbuild.** Mesuré : 483 caractères de moins, 300 octets une fois encodé.
  Sous le bruit.
- **Mémoïser `porteDe()` par requête** dans les Functions. Deux appels par requête au pire, sur du
  parsage d'en-tête : rien à gagner, une indirection à lire.

## Conséquences
- `index.html` : **448 633 -> 404 507 octets**, soit **-44 126 (-9,8 %)**. CSS 73 183 -> 49 552,
  HTML 36 084 -> 24 722, JS 337 299 -> 328 779. Aucun changement de comportement : `build --check`
  vert, `no-dead-selectors` vert (273 classes, 0 morte).
- Chemin d'une op sur un plan de 300 meubles : **1 059 us -> 887 us (-16 %)**, dont `planFp`
  169 -> 139 us. Sur la seule chaîne canonique de 200 000 caractères, `strHash` passe de 3 346 us à
  246 us.
- `tsconfig.json` garde `"target": "es2019"` avec un commentaire désormais faux (« la source
  n'utilise ni `?.` ni `??` »). Il ne sert qu'au `--noEmit`, donc rien n'en dépend dans le livrable ;
  hors zone de ce lot, à corriger par qui touche `tsconfig.json`.
