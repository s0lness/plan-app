# 0014 - L'app se tait

Status: accepted, 2026-09-02. Lot 5 de `docs/simplification-2026-09-02.md`.

## Contexte

Le relevé (`docs/simplification-2026-09-02.md` §1 et §3.4) : 72 toasts et 33 bannières, 105 sites
de message au total, avec un système de bannières throttlé par TEXTE et des astuces une fois. **L'app
parle trop**: une app qui doit expliquer un geste au moment où on le fait, c'est un geste qui n'est
pas évident. Les planificateurs comparables (Sweet Home 3D, Floorplanner, RoomSketcher…) sont muets
sauf refus.

## Décision

**Un message n'existe que pour dire POURQUOI un geste délibéré n'a eu aucun effet (un refus), ou
pour dire que quelque chose d'invisible à l'écran est arrivé au travail de la personne** (un pair a
supprimé ce qu'il tenait, une écriture a été refusée par le serveur, le plan n'a pas pu être
enregistré, le réseau est coupé). Tout le reste se tait: confirmations (« enregistré », « copié »,
« créé »), informations déjà visibles dans le dessin (un meuble a bougé, un mur est devenu libre,
une cellule a été renommée), astuces, explications au premier usage.

**105 sites de message avant, 60 après** (voir `tests/rapide.ts`, aucune empreinte de données
touchée: `compat-donnees` rend les mêmes 1069 vérifications). La cible du lot (35) n'a pas été
atteinte: la majorité des sites restants sont des refus DISTINCTS, chacun couvert par son propre
test navigateur (`tests/collab-annuler.ts`, `tests/deux-appareils.ts`, `tests/gestes-usage-reel.ts`,
`tests/faces-pose-copie.ts`, `tests/model-v5-fil-serveur.ts`…), et la règle ci-dessus les protège
explicitement. Les fusionner davantage aurait supprimé des raisons de refus différentes derrière un
même texte générique, ce que ni la règle ni les tests n'autorisent.

**`toast.ts` simplifié à deux régimes** (au lieu du throttling par texte + compteur de lassitude
+ deux minutes de silence forcé):
- **geste** (`toast(msg,{geste:true})`) : une fois par geste (`_gesteEpoch`, avancé par
  `pointerdown`/`keydown`), jamais de fatigue, revient à chaque répétition du geste.
- **système** (`toast(msg)`) : une fois, puis en cooldown sur son PROPRE texte jusqu'à ce qu'il se
  serait effacé de l'écran (`TOAST_MS`, 3.2 s) ; un texte DIFFÉRENT ne l'attend jamais.

`TOAST_LASSITUDE`, `TOAST_LONG_MS`, `TOAST_SAME_MS` et la carte `_toastSeen` (compteur + horodatage
+ époque, bornée à 60 entrées) disparaissent, remplacés par un `Set` (geste) et une `Map` de minuteurs
individuels (système, bornée à 30). Le fichier passe de 108 à 100 lignes (les commentaires
d'en-tête expliquent le nouveau contrat) en gagnant un régime strictement plus simple, prouvé par
les mêmes tests navigateur
(`un_message_identique_est_etrangle`, `un_message_du_systeme_reste_etrangle`,
`une_reponse_a_un_geste_revient_a_chaque_geste`, `meme_message_pas_huit_fois`), non relancés ici
(consigne du propriétaire), mais dont le raisonnement pas à pas contre l'implémentation est dans le
rapport du lot.

**Les astuces une fois disparaissent** (`src/ts/app/aide.ts`): la table `HINTS`, `hintsSeen`,
`markHintSeen`, `showHint`, le crochet `ctx.crochets.showHint`, les trois appelants
(`gestes/pose.ts`, `gestes/vue-interactions.ts`, `mesure/mesure.ts`) et le CSS `.tip-hint`. La clé
`localStorage` `plan-hints` n'est plus ni lue ni écrite : un navigateur qui la porte encore d'avant
ce lot n'est jamais consulté, donc rien ne peut trébucher sur sa forme.

## Ce qui a été rejeté

- **Retirer aussi les bannières système en double avec la bannière persistante** (`fil/rest.ts`:
  le conflit de révision, le plan supprimé, la resynchronisation après coupure émettent un toast
  transitoire PUIS une bannière persistante `#bootNotice` avec le même message). Le toast semblait
  redondant, mais `tests/collab-annuler.ts` (`v.toast` attendu non nul et matchant le texte) le
  vérifie explicitement sur trois scénarios distincts : retiré, il aurait fallu réécrire ces
  assertions dans une suite navigateur non relançable ici. Rejeté par prudence, pas par principe:
  un lot futur qui relance ces suites peut trancher.
- **Le bornage de masse du mobilier silencieux** (`bornerLesMeubles`, `gestes/murs.ts`). Semblait
  correspondre à l'exemple « objet ramené à la maison de 113 cm » du plan de simplification à
  retirer, mais `tests/deux-appareils.ts` (`mon_propre_orphelin_est_annonce`) et le dossier G-8
  (`docs/invariants.md`) exigent explicitement l'annonce: un meuble qui bouge SANS qu'une main le
  tienne n'est pas expliqué par le dessin seul. Gardé.
- **« Le mobilier collé a changé de face de mur »** (`gestes/selection-actions.ts`,
  `flipWallMountSide`) après un flip réussi. Retiré: aucun test ne le couvre, et la fonction pure
  qui le calculait (`wallMountBothSidesLive`) n'avait plus d'autre appelant, donc elle part aussi.
  Doute noté dans le rapport: c'est un état sémantique (orientation intérieur/extérieur) sans
  signe visible dans le tracé 2D, à revoir si un propriétaire rapporte l'avoir perdu.
- **« Objet collé posé UNLOCKED »** après un Ctrl+V d'un objet verrouillé
  (`gestes/clavier.ts`). Semblait correspondre à une information à retirer, mais
  `tests/faces-pose-copie.ts` (`verrouille_colle_deverrouille_et_le_dit`) le vérifie: silencieux, la
  copie déverrouillée serait indiscernable d'un objet resté verrouillé qui refuserait de bouger.
  Gardé, c'est le cas explicite de la règle « seul signe d'un invisible ».
- **« Placement cancelled » sur Échap** (`gestes/pose.ts`, `annulerPoseArmee`). Retiré partout
  d'abord (le désarmement se voit déjà au surlignage `.armed` qui disparaît), puis restauré sur le
  SEUL appel d'Échap (`gestes/clavier.ts`): `tests/faces-pose-copie.ts` l'exige
  (`/cancelled/.test(t2)`). Les deux autres appels (retaper la même vignette, un autre outil qui
  prend la main) restent silencieux, non couverts par un test.

## Conséquences

- **En moins**: 45 sites de message (105 -> 60, `toast(`/`dire(` appels réels, hors clear
  `dire("")` et commentaires), le fichier `toast.ts` simplifié à deux régimes sans fatigue, tout le
  système d'astuces (`aide.ts`, `.tip-hint`), les messages « Loading… »/« Creating… »/« Revoking… »/
  « Sending… » remplacés par le silence pendant l'attente (le bouton désactivé suffit), et les
  variantes de refus réseau (code de statut vs pas de réseau) fusionnées en un seul texte par
  action quand les deux menaient à la même remédiation (« check your connection »).
- **En plus**: rien de nouveau, seulement des textes fusionnés ou raccourcis.
- **Les données ne bougent pas**: `compat-donnees` rend les mêmes 1069 empreintes, le lot ne
  touche ni la géométrie, ni la lecture, ni le fil.
- **AGENTS.md** (« Banners are throttled by TEXT ») et `docs/invariants.md` (C-16) réécrits pour
  décrire le mécanisme à deux régimes actuel plutôt que la fatigue disparue.
