# 0022 - Plus de retour utilisateur dans l'app

Status: accepted, 2026-09-02. Revue du 2026-09-02.

## Décision
Le propriétaire : « vire juste feedback ». Le bouton du menu Fichier, son dialogue, `/api/feedback`
et sa table retirée du client sont supprimés (`comptageRecent` et son plafond horaire survivent,
déplacés dans `functions/debit.ts`, seuls consommés désormais par `/api/err`). La table `feedback`
reste en base de production, non lue, non touchée par ce lot. Rejeté : purger la table en base
(hors périmètre, décision du propriétaire seul). Conséquence : la tâche planifiée Windows
`plan-retours` (hors dépôt) qui lisait cette table n'a plus rien à lire, à désactiver par le
propriétaire.
