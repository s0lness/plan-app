# The floor plan's invariants: what the system guarantees, and why

> **PATH STATUS, 2026-08-10.** The live client is only in `src/ts/`. The `js/NN` markers kept
> in the defect narratives are HISTORICAL locators for the old client, available in the history
> of the private repository; to act today, search for the named symbol in
> `src/ts/`. The instructions and verification tables below, on the other hand, are kept up to
> date.

**This document is the rewrite's specification.** It lists what the application guarantees
today, the real defect each guarantee prevents (with its measurement when one exists), where
it lives in the current code, and how it is verified.

These guarantees cannot be read from the code. They were discovered one by one, by
measurement, over thirty hours of directed fixing: almost none is a logic error visible on
reading. They are silent data losses, races between two devices, arithmetic that drifts. Until
now they lived scattered across comments, commit messages, test names, and two documents.
**Here they are, gathered, so that a rewritten client does not pay for them again.**

## How to read an entry

```
### X-n. Title
Guarantees    what is true after the fix
Prevents      the real defect, with the measured figure
Where         the file and function, in today's code
Verified      the suite and the case name
Robustness    by construction | by convention | by accident | bounded
```

**Robustness**, the column that matters for the rewrite:

- **by construction**: the defect is impossible, the structure forbids it. Nothing to watch.
- **by convention**: the guarantee holds because N places in the code follow a rule written in
  a comment. An N+1th place breaks it silently. **These are the most fragile.**
- **by accident**: the guarantee holds for a reason other than the one believed. It will
  disappear at the first unrelated change.
- **bounded**: the guarantee is true up to a limit that is written down and accepted.

## The three most fragile, to address first

1. **C-5** a persisted field that is not declared in `src/ts/fil/pseudo-fil.ts` **and** in
   `live-worker/ops.ts` never crosses the network, with no visible error. Two files, two repos,
   no mechanism. Already happened twice (an opening's name and depth, then its side).
2. **G-1** every gesture must go through `armGesture()` and never listen to `pointerup` itself.
   A gesture that does not end leaves the application **silent** and loses the whole session on
   reload, without a single message. Eleven entry points, no technical barrier.
3. **R-3** renaming a catalog entry without depositing the old label into `LEGACY_TYPE_NAMES`
   brings back the name of **every existing piece of furniture**, all at once, on every floor
   plan. And the test that sweeps the table sees a **wrong** entry, never a **missing** one: the
   invariant is not checkable in the direction that matters.

## Contents

| Domain | Count | Section |
|---|---|---|
| Data and persistence | 18 | [D](#d-data-and-persistence) |
| Concurrency and collaboration | 22 | [C](#c-concurrency-and-collaboration) |
| Gestures and interaction | 24 | [G](#g-gestures-and-interaction) |
| Rendering and legibility | 19 | [R](#r-rendering-and-legibility) |
| Server-side validation | 12 | [V](#v-server-side-validation) |
| **Total** | **95** | |

Measured on 2026-08-05 on `af6459e`: the full pre-deploy barrier runs **3,415 checks across 27
suites in 348 s**, all green.

---
# D. Data and persistence

### D-1. Nothing goes out to the household plan until the first read has succeeded
**Guarantees** no `PUT`, no publish, before a server read has answered.
**Prevents** the push was debounced by one second and did not wait for the boot `GET`: a
change made in the first second of a slow page load published what **this device** believed it
had. And a device whose local storage is corrupted believes it has the default apartment.
Measured: the default plan (420 × 360, 1,692 bytes) overwrote the household's eight rooms, then
the second device adopted the destruction.
**Where** `bootReconciled` (`src/ts/fil/rest.ts`), set by the **first read that succeeds**
(`syncBoot` l. 355, `pollPull` l. 391), **never by a failure** (l. 426). `doPut()` bails out at
the top as long as it is false (l. 286).
**Verified** `tests/plan-abime.ts`: "no send went out while the boot read was still in flight",
"the shared plan never received the default apartment", "no payload EVER carried the default
apartment (420 × 360)".
**Robustness**: by construction (single choke point).

### D-2. An unreadable local record is neither a plan, nor "no plan"
**Guarantees** an unreadable blob is set aside verbatim, the screen says so, and `setupDone`
falls back to false so nothing more can be published from this device.
**Prevents** the default apartment started up believing it was configured
(`setupDone = hadSaved`): the wizard did not open, nothing displayed, the first `save()`
overwrote the corrupted content, and this default state became **sendable** to the household
plan. Measured: **6,040 bytes of plan became 1,692 bytes of default apartment**, with no backup
copy and not a word said.
**Where** `rescueUnreadable()` (`js/02:334`), key `room-planner-v4-backup-illisible`;
`state.setupDone = hadSaved && !bootUnreadable` (`js/02:371`); message in `#setupNotice` **and**
`#bootNotice` (`js/46:62`, two places because the wizard does not always open under `SYNC_ON`).
**Verified** `plan-abime.ts` #1 to #3.
**Robustness**: by construction.

### D-3. The pre-conversion blob is copied verbatim before the first write
**Guarantees** a backup copy of the old format exists, taken exactly once, during boot.
**Where** `v5BackupLegacy()` (`js/55`), key `room-planner-v4-backup`, called from `js/02:352-360`.
**Verified** `v5_backup_is_taken_once_and_kept`, `v5_restore_returns_the_plan_from_before_la_conversion`.
**Robustness**: **by accident**. The menu entry was removed on 2026-08-05 (`d7350c2`): the data
remains, `v5RestoreBackup()` remains, but **nothing in the application knows how to reach it
anymore**. Only `window.__plan.restoreBackup()` accesses it, that is, a test hook. A safety net
you can no longer grab is not a safety net.

### D-4. Old formats stay readable, and `migrate()` is the sole entry point
**Guarantees** five input shapes are accepted and converted in memory: v1/v2/v3 single-room
(`{room, pieces}`), v4 (`rooms[]` + `envelope`), wrapped export (`{app:"room-planner", state}`),
nested v5 (`{plan:{…}}`), flat v5 (the server shape, `outline`/`walls`/… at the root).
**Non-negotiable precedence**: `st.plan` (nested) **wins** over the flat shape, "it is the
complete local copy, which additionally carries the openings' `h`/`side`/`name`, lost over the
wire (strict server keys)" (`js/02:302`).
**Prevents** adopting the flat shape erased the depth, side, and name of every opening.
**Where** `migrate()` (`js/02:297`), `readLegacyRooms()` (l. 86), `sanitizeV5Plan()` (l. 170),
`buildV5FromV4()` (`js/49`).
**Verified** `run.ts`: `migrate_v3_is_read_and_converted`, `boot_reads_and_converts_v4`,
`serialize_migrate_roundtrip`; `model-v5-conversion-rendu.ts` on the **real plan** (8 rooms →
10 cells, 21 openings, 21 pieces of furniture); fixtures `plan-reel-77.json`, `plan-rev177.json`.
**Robustness**: by construction.

### D-5. Conversion is deterministic, hence idempotent
**Guarantees** two clients converting at the same instant converge; a second conversion changes
nothing.
**Prevents** a tab left on the old format overwrote the converted plan.
**Verified** `v5_two_clients_converge_on_the_same_conversion`, `v5_boot_does_not_reconvert`,
`rapide_detection_est_deterministe`, `v5_stale_tab_reacts_to_a_model_conflict`.

### D-6. Duplicate room identifiers are renumbered on read
**Prevents** "old data has multiple rooms with the SAME id" (`js/02:90`).

### D-7. Personal settings never cross over, in either direction, on either of the two paths
**Guarantees** layers, labels, snap, the Circulation panel, overlay, collapsed categories, and
TV inches live in `room-planner-opts` and neither leave nor enter.
**Prevents** they used to travel in the shared plan: one member of the household unchecks
"Luminaires", the other reloads, their wall lights disappear. Inconsistency on top: they traveled
when realtime was **down**, and not when it worked.
**Where** two symmetric guarantees (`js/02:249`): `serialize()` does not carry them (`js/07:27`,
"this blob IS the PUT body"); `makeState()` ignores the `opts` of any received payload
(`js/02:284`). Third barrier: `sanitizeState` (server) returns only
`outline/walls/openings/pieces/cells/setupDone`.
**Verified** `opts_un_plan_serveur_n_ecrase_aucun_reglage_local`,
`opts_ne_partent_ni_par_le_fil_ni_par_le_repli`, `opts_migration_depuis_l_ancien_blob`,
`opts_la_cle_personnelle_gagne_sur_le_plan`; `repli-d1-live.ts` #14 to #17.
**Robustness**: by construction (three independent barriers).

### D-8. `rev` is a lock, not information: atomic compare-and-swap on the PUT
**Guarantees** the `PUT` carries the revision **whose content the client has**; the write
succeeds only if the row still carries that revision, otherwise 409 with the winning revision,
author, and state.
**Prevents** the `PUT` was blind, last writer wins. Measured with two browsers, realtime down:
**both writes were accepted, the row went from revision 3 to revision 5, and it carried only the
second one's work.** The first saw the other's plan arrive on their screen, without a word, with
nothing to recover.
**Where** `functions/api/plan.ts:126`: **a single statement**
`INSERT … ON CONFLICT(id) DO UPDATE … WHERE plans.rev=?4`, verdict read from `meta.changes`,
never by a re-read. `rowsChanged()` (l. 81) refuses to guess: an executor that does not report
how many rows moved returns a 409 `unknown-changes`, because "a compare-and-swap that doesn't
know whether it bit is not a compare-and-swap".
**Verified** `tests/repli-conflit.ts`, 25 checks on a **real SQLite** with the **real
Function**; `--avant` mode replays the original measurement on `HEAD`.
**Robustness**: **bounded, and this is the most serious known hole.** The Durable Object's
snapshot writes this same row **with no expected revision**, through its own D1 binding. It can
no longer be overwritten without knowing it (a client that has not seen its snapshot is
refused), but it can still overwrite a REST write it has not seen between its reconciliation and
its own write. Mitigated by `reconcileD1()`, which re-reads the row before every snapshot.
Documented in `functions/api/plan.ts:27` and `docs/collab-etat-de-l-art.md` gap #1.

### D-9. A refusal is re-read, it is never rewritten
**Guarantees** the refused version is set aside (`room-planner-v4-conflit`, the last 5), a
persistent banner says so with a "Récupérer ma version" (Recover my version) button, `Ctrl+Z`
brings it back to the screen, and the winning state is adopted **from the body of the 409**,
with no second round trip.
**Prevents** replaying the PUT would ask for the same refusal again, and two devices would
endlessly bounce the same write back and forth. And a second round trip would reopen the same
race.
**Where** `js/41:206` (`stashConflit`), l. 235 (the persistent banner: "a loss of work is not
told through a message that erases itself"), l. 258, l. 290. `apiFetch` (l. 120) attaches
`e.status` and `e.payload` so the winning state travels with the refusal.
**Verified** `repli-conflit.ts` #16 to #23, including "the loser RE-READ, it did not rewrite in
a loop" and "only one version was set aside, not one per attempt".

### D-10. `serverRev` only advances on content we actually have
**Guarantees** the revision used as the base for the compare-and-swap advances when we
**adopt**, or when we have just written ourselves. Reading a more recent revision without
adopting it (during a gesture, a modal) does not advance it.
**Prevents** "writing on a base we have not incorporated is exactly the overwrite we are
closing off".
**Where** `js/41`, six assignment sites (l. 200, 319, 371, 402, 408, 415).
**Robustness**: **by convention.** Six assignments in a single file, a rule written as a
comment, no type. A seventh site would break it silently.

### D-11. Adopting is not modifying
**Guarantees** a device that has just adopted the server plan does not republish it.
**Prevents**: found by the seed harness and proven by it: a pending change at the moment of
adoption went out right after and republished the adopted state. **The row advanced by one
revision for nothing, and the neighbor's next PUT, which carried the previous revision, was
refused with a 409, a "not saved" banner, and a version set aside, with no real
conflict existing.**
**Where** `serverMirror` / `mirrorOf()` / `noteServerMirror()` (`js/41:32`), `doPut()` bails out
if the state is identical to the mirror. Subtle guard: `noteServerMirror()` sets
`serverMirror = null` if `gestureActive`, because during a gesture `applyReplacedState` queues
up, so `serialize()` still describes the local state, "and the mirror would lie in the one
dangerous direction: it would silence real local work".

### D-12. D1 is authoritative only when realtime is not authoritative
**Guarantees** `syncBoot()` bails out at the top if the WebSocket is alive, while still lifting
the publish lock.
**Prevents** the Durable Object's `hello` carries the plan to the second; the D1 row is only
refreshed by a 30 s alarm. A `GET` sent before the `hello` and arriving after describes a stale
plan. Adopting it means replacing the current plan with a stale plan **and then saving it**.
Measured: **an F5 brought back the plan from half a minute ago, 20 pieces of furniture lost
across both sessions, the chip showing "live ✓", without a word and with no way back**; three
times out of five.
**Where** `js/41:394`: `if (wsLive()) { serverRev = rev; return; }`.
**Verified** `repli-d1-live.ts`, `model-v5-modele-defaut.ts`.

### D-13. The REST fallback accepts both shapes
**Guarantees** `knownShape()` accepts `rooms[]` (old) **and** `walls`/`outline`/`plan`
(walls-only).
**Prevents** the original guard only accepted `rooms`: it refused 100% of the live model's
writes, the chip announced "slow sync", the two people silently diverged. Proven by
a two-browser test: **the same test with the old guard fails 8 times out of 11**.
**Where** `functions/api/plan.ts:71`.
**Verified** `repli-d1-live.ts`, `repli_d1_refuse_toujours_une_forme_inconnue`,
`repli-conflit.ts` #11 and #12.
**Robustness**: **by convention, and deliberately so.** The Function shares no code with the
Worker; `knownShape` is deliberately lax and **must stay that way**. Tightening this guard kills
the fallback. The rule is written as a comment, nothing enforces it.

### D-14. A name is truncated, never refused
**Guarantees** past 80 characters the server truncates and accepts.
**Prevents** a refusal is **final**: the client marks the value as acquired after sending and
never resends it, so the piece of furniture would disappear on the other end forever. And with
`cells.replace`, **a single room name that was too long would take down the sync of all ten
cells**.
**Where** `cleanName()` (`live-worker/ops.ts`), `NAME_MAX = 80`; client-side `maxlength="80"` on
`#iName`/`#rcName` and bounding in `sanitizeV5Plan` for programmatic paths (import, paste).
**Verified** `rapide_serveur_tronque_un_nom_trop_long`, `v4 piece name truncated not rejected`,
`name 81 truncated`, `v5 cell name truncated`.

### D-15. A refused local write is reported
**Prevents** private browsing, blocked cookies, zero quota: `setItem` throws, and the exception
used to be swallowed by a silent `catch(e){}`. **No banner, no chip, no log. The person would
work for an hour believing they were saving, and lose everything on reload.**
**Where** `notePersistFailed()` / `#storeChip` (`js/07:58`): a single message, plus a
**persistent** chip for as long as it lasts.
**Verified** `garde-fous.ts`: `stockage_refuse_le_dit`.

### D-16. The wire's four lists are sorted by identifier
**Prevents** a list's content is a set, but the **local** order diverges as soon as two people
each create an entity at the same moment. Without this sort, two plans with identical content
produced **two different exports, two different PUT bodies**, and a screen comparison would
fail with no entity actually differing.
**Where** `v5StateWire()` (`js/51:130`). The order of the **live** plan is never touched.
**Robustness**: by convention. The server, for its part, already sorts before hashing
(`canonPlan`), so the fingerprint is protected no matter what; the export and the PUT body are
protected only by this sort.

### D-17. A new plan is truly blank
**Prevents** the default install used to be furnished with four objects. "On a fresh page the
wizard would therefore open on top of an already furnished living room: it was asking to define
the outline while showing another home, furnished, behind the modal."
**Where** `defaultState()` (`js/02:319`), `pieces: []`.
**Verified** `tests/boot-vierge.ts` (pass 1, blank profile, zero JS errors).

### D-18. `state.pieces` is an accessor, not a copied alias
**Prevents** a plan replacement (remote op, undo, pull) used to leave a stale reference behind.
**Where** `bindState()` (`js/02:280`), non-enumerable property.

---

# C. Concurrency and collaboration

### C-1. Order of arrival at the server is the sole arbiter. No clock ever intervenes
**Guarantees** a single Durable Object, `idFromName("main")`, no decision based on `Date.now()`.
This is Figma's model, whose "last writer wins" designates the last one to **arrive at the server**,
never the largest timestamp.
**Robustness** by construction (a single hot writer).

### C-2. `fp` is a content fingerprint, and it is the only identity compared on the wire
**Guarantees** `hello`, the op echo, `state`, and `pong` all carry `fp`; adoption is decided on it and
nowhere else.
**Prevents** two counters counting unrelated things under the **same name** `rev` (the Durable
Object's ops, D1's row writes) that were compared to each other: **permanent divergence, with both
screens showing "live ✓"**.
**Where** `planFp` / `canonPlan` (`live-worker/ops.ts`): 64 bits as 16 hex digits, two mixing functions
(FNV-1a and djb2-xor) over a canonical projection, lists sorted by id, fixed field order, optionals
rendered as `null`. The Durable Object announces `opCount` (its own ops, informational, **restarted
from zero, it no longer reads D1's `rev`**); the D1 row keeps `rev`, read by `serverRev` (`js/41`) to
drive REST polling. The wire does not even read `opCount`.
**Verified** `adoption_sur_empreinte_et_pas_sur_compteur`,
`aucun_chemin_ne_compare_plus_deux_compteurs`,
`le_durable_object_ne_porte_plus_aucun_champ_nomme_rev`, `meme contenu -> meme empreinte`,
`l'ordre des listes ne change pas l'empreinte`, `hello porte l'empreinte du plan servi`.
**Documented exception**: on the drop of a link that had been **alive**, `serverRev` falls back to -1
so that the first poll reconciles; never on a plain connection failure.

### C-3. A lost outbound op is resent, and what is resent is the current value
**Guarantees** the echo **is** the acknowledgement: it carries `tag` (the authoring device) and `n`
(the number), so the author knows which one made it through. Resending brings the optimistic mirror
back onto the acknowledged mirror and redoes a diff.
**Prevents** there was **no** safety net at all. The brief claimed the `pong`'s fingerprint would catch
a lost op within ten seconds: false, measured. A lost outbound op changes nothing server-side, so both
fingerprints agree and no resync fires. The `pong` catches a missed **inbound** message, never a lost
**outbound** op. The two plans diverged permanently, both screens showing "live ✓". Worse: when a full
reload occurred for another reason, it **adopted** the server state, so the change was not caught up,
**it was erased**.
**Where** two mirrors (`js/42:150`): `ws5` optimistic (it advances on emission, otherwise every
`save()` would resend for the whole round trip) and `ws5Ack` acknowledged (it only advances on what the
server has confirmed). Two triggers: the server's `gap` message, and a 2.5 s client guard delay
(`WS_ACK_RTO`, "the real round trip is < 200 ms") which is indispensable because **the last op of a
burst, if lost, has no following op to reveal the gap**. Three resends without an ack close the socket:
"it is no longer a lost frame, it is a link dead in one direction".
**Divergence deliberately taken from Replicache**, whose "exactly once" assumes sending in an
**ordered batch**: on a frame-by-frame wire, replaying a stale op as-is would make it arrive after a
more recent op on the same field, and since order of arrival is the sole arbiter, **the stale value
would win**.
**Verified** `tests/collab-accuses.ts`, 13 cases, the **real `PlanRoom`** running in the page behind a
transport that drops, delays, and reorders. Including `avant_une_op_perdue_n_est_rattrapee_par_rien`
(the original defect, kept on the bench), `derniere_op_perdue_le_delai_de_garde_la_ramene`,
`reemettre_envoie_la_valeur_courante_pas_l_op_morte`,
`une_trame_sur_deux_perdue_le_plan_converge_quand_meme`.

### C-4. Server-side deduplication is a set, not a highest-seen counter
**Guarantees** a sliding window of 64 numbers per `(tag, n)`, **in memory, zero bytes of storage**.
**Prevents** with a plain highest-number-seen approach, "under reordering, a legitimate op arriving
late would be mistaken for a duplicate and **discarded**". Losing the table is harmless: ops are
idempotent.
**Non-obvious detail** a refusal **consumes** the number just like an acceptance does (`seqNote` is
called before `applyOp`), otherwise the client would resend an op the server had deliberately rejected.
**Verified** `numero deja traite : RIEN n'est reapplique`,
`l'ordre d'ARRIVEE arbitre, meme quand il inverse les numeros`,
`retard_et_reordonnancement_ne_perdent_rien`.

### C-5. An op is a field-by-field diff; an absent field means "no opinion"
**Guarantees** the server falls back to the value already in storage for any absent key. Two people
editing two fields of the same object no longer overwrite each other. On **creation**, the whole entity
is sent.
**Prevents** three distinct defects: two people editing two fields of the same piece of furniture
overwrote each other; manufacturing the key anyway (with `undefined`) **erased the peer's furniture
name, type, and dimensions the moment you only moved its position**; a sided-less op silently returned
an opening.
**Where** `ws5FieldDiff` (`js/42:338`), `prevOf`/`pick` (`ops.ts`), and `js/43:4` only copies **present**
keys. Subtlety: "a key the server has and we no longer have cannot be expressed as a partial, so we
instead repost the whole entity rather than leave a ghost field".
**Verified** `rapide_diff_n_emet_que_le_champ_change`, `une_op_partielle_recue_fusionne`,
`ouverture : une op qui ne dit rien du cote ne le remet PAS a 0`, `old client rewrite does NOT lose h`,
`old client rewrite does NOT lose name`.
**Robustness** **by convention, and it is the most fragile invariant in the repo.** Every new field
persisted on an entity must be declared in `src/ts/fil/pseudo-fil.ts` (the `*Wire` functions) **and**
in `live-worker/ops.ts` (the key whitelist), **otherwise it never crosses the network, with no visible
error**. This has already happened twice: an opening's name and depth did not travel (`9140714`), and
the side was packed into a bitfield on the hinge for lack of an authorized key (`44ae55e`, where "the
server believed it was validating a single hinge when it was actually validating three mixed-up
fields, and any finite number would pass").
**Third place** `src/ts/modele/migrations.ts` (`sanitizeV5Plan`) must recopy the same field, or a
plan that already carries it silently loses it on the next **read**. This is not the wire, but it sits
on the SAME path: `Ctrl+Z` snapshots through `serialize()` and restores through `migrate()`
(`src/ts/historique/pile.ts:40,91`), and `migrate()` calls `sanitizeV5Plan()`, so a field this function
forgets is a field undo silently erases, even though it never left the browser. Measured: `leaf`
(openings), `tr`/`dmin`/`pair` (furniture) were declared in `partage/plan.ts` and emitted by
`pseudo-fil.ts`, but dropped on every re-read.

### C-6. The outbound mirror describes the server, never us
**Guarantees** the mirror is built from the `hello` state (`wsShadowFromServer`) and then advances
**op by op** (`wsShadowApplyOp`).
**Prevents** resyncing it from local state is a trap: during a drag, the gesture continuously rewrites
the furniture's position, so local state **is not** what the server holds. The mirror would then record
the dragged position as already acknowledged server-side, and **the field the other person had just
changed was never resent again: the two screens stayed permanently off by one coordinate**. Another
case: a `hello` **without** adoption (fresh household, reconnection with an identical fingerprint)
copied local state, so the diff only emitted the local delta from then on and the shared plan stayed
amputated of everything the server had never received.
**Where** `js/42:266` and `js/42:286`. Associated safety rule: an entity that fails to serialize is
left **absent** from the mirror, because "emitting too much loses nothing, emitting too little loses
everything".
**Two exceptions**, both locally manufactured ops the server has never seen: the rollback of a refusal
(`wsReverting`) and the replay of unacknowledged ops after reconnection (`wsRebasing`).

### C-7. Technical identity is the device; email is the human identity
**Guarantees** `tag`, assigned by the server and unique **per socket**, accompanies `peer`, `op`,
`cursor`, and `drag`. `wsPeers` and `wsCursors` are indexed by **device**.
**Prevents** the household has two accounts, but one person has several devices behind a single Access
identity (the computer on the table, the phone in the apartment). As long as everything was decided on
the address, the same person's second device was mistaken for **oneself**. Measured: **a single Ctrl+Z
on the computer rolled back the furniture moved from the phone, made the chair placed there disappear,
and lost the rename, on both screens and in the server's plan, without a single banner.** And the
second device was completely invisible: no dot, no cursor, no drag ghost.
**A root cause deeper than the four filters first spotted**: the two presence and cursor tables were
**indexed by email**, so two devices on the same account overwrote each other.
**Where** three sole functions: `wsFromMe(msg)` (is this my socket?), `wsDevKey(msg)` (Map key),
`wsSameAccount(msg)` (my account, another device, rendered as distinct). Rendering keeps the **person's
name and color**; my other device is distinguished by a border (`.peer-dot.self`) and the label "your
other device". A server **without** `tag` falls back to email, exactly as before.
**Verified** `tests/deux-appareils.ts`, 15 cases.
**Robustness** **by convention.** Seven comparison sites reduced to three functions, but nothing
prevents an eighth `msg.by === wsMe.email`, or reindexing one of these Maps by email.

### C-8. A created entity's id carries a device label; a derived entity does not
**Guarantees** `w20-a3f9c1` for what a person creates, bare `w20` for what geometry derives on both
sides.
**Prevents** in one direction: the two members of the household drawing a partition wall at the same
instant both got `w20`, the second overwrote the first, **one wall in two disappeared without a
word**. In the other
direction, the symmetric trap: a label on an **outline** wall would spawn, on the peer's side upon
receiving an `outline.set`, a second outline wall carrying a different id, **and the two plans would
diverge**. Here the collision is the intended behavior.
**Where** `v5NewId` / `v5DerivedId` (`js/51:48` and `:65`). The label comes from `wsMe.tag`, or
otherwise from a draw kept in `sessionStorage`; **frozen for the life of the tab**: "an id already
handed out must never depend on the state of the link".
**Verified** `identifiant_porte_l_etiquette_du_serveur`,
`sans_serveur_l_etiquette_est_tiree_au_sort_et_figee`,
`l_identifiant_etiquete_est_accepte_par_le_serveur`.
**Robustness** **bounded.** Measured against the production database: **none of the 109 ids still
carry a device label.** The protection only covers entities created since its deployment.

### C-9. Ctrl+Z only undoes its own author's work
**Guarantees** a snapshot is a past **shared** state: the peer ops received since it was taken are
replayed on top of it at restore time, and the publish is a **diff**, never a `plan5.replace`.
**Prevents** `undo()` used to replay a full snapshot and publish it as a replacement of the plan. Since
ops received from the other person never entered the history, the snapshot ignored, by construction,
everything they had done since the last local action: **their furniture moved back, their rename
disappeared, on both screens, without a word. The longer we stayed idle while they worked, the more our
own Ctrl+Z destroyed.**
**Where** `histLog` / `histApplyOp` / `histReplay` / `restore({keepShadow:true})` (`js/27`), a stack of
60 snapshots, a journal capped at 800 ops.
**Verified** `annuler_ne_detruit_pas_le_travail_de_l_autre`, `retablir_suit_la_meme_regle`,
`rapide_annuler_ne_detruit_pas_le_travail_de_l_autre`, and the Figma round trip (N undos then N redos
render an identical document) over 2,500 seeds in `tests/harnais-graine.ts`.
**Robustness** **bounded, three written limits.** Beyond 800 received ops, undo steps are **dropped**
(`js/27:41`, a deliberate choice: "losing an undo step is nothing compared to silently destroying the
other person's work"); a received `plan5.replace` clears the whole history; catch-up depends on the
journal's completeness. The state of the art recommends a stack of per-device **inverse operations**;
it is gap n°3 of `docs/collab-etat-de-l-art.md`, not closed.

### C-10. A server refusal cannot leave the screen lying
**Guarantees** the client numbers its ops and keeps, **before sending**, the inverse op drawn from the
mirror; the server echoes that number back in its `err`; the local change is undone **through the
ordinary receive path**, so local state and the mirror return together to the server's truth and the
next diff emits nothing.
**Prevents** the sender works by diff and marks the value as acknowledged right after sending: nothing
gets resent, so keeping the local change makes it permanent and invisible. Measured: **33 openings on
one side, 33 on the other, not the same ones, 30 at the server, and both screens announcing
"live ✓".**
**Where** `wsSendOp` + `wsUndoOpsFor` (`js/42:99`), `wsRevertRefused` (`js/43:262`). Without a number
(client or server predating it): a full reload via `{t:"sync"}`, **throttled to once every 5 s**. The
chip stays `live ✓`: the link **is** alive, it's this particular write that was refused.
**Detail** the rollback happens **even while the banner is throttled**: a burst of refusals (one op per
cell, per piece of furniture) must not let the following divergences through.
**Verified** `un_refus_serveur_annule_la_modification_locale`,
`un_refus_sans_numero_demande_l_etat_complet`, `une_rafale_de_refus_est_entierement_defaite`,
`un_refus_ne_declenche_pas_de_reemission`.

### C-11. Bounding belongs to the author of the gesture; the receiver rebounds nothing
**Guarantees** whoever pushes a wall bounds it **once, on the final geometry**, and publishes the
result. The receive path recomputes the (derived) cells but calls neither `v5ClampPieces` nor
`v5ClampOpenings`.
**Prevents** the receiver sees walls arrive **one at a time**: rebounding on every op made it pass
through all the intermediate geometries and **accumulate** the drift. Measured with two browsers: **up
to 27 cm of offset on a wall pushed 180 cm, on 1 to 4 pieces of furniture, permanently and without a
word, for the person who had touched nothing.**
**Where** `js/43:204`.
**Verified** `recevoir_un_mur_ne_deplace_aucun_meuble`,
`un_meuble_deplace_par_l_auteur_suit_quand_meme`.

### C-12. A single exception to C-11, and it only concerns the wall named by the op
**Guarantees** when a peer **shortens** or **thins** a wall, the openings **of that wall** are
rebounded on receipt.
**Prevents** C-11 protects the plan of **someone** whom we would otherwise silently recalibrate. It
left a gap where there is no longer anyone to protect: an opening has no coordinates of its own (`t0`,
`w`, `h` only mean something relative to its wall), so merging produces an opening outside its wall,
**and the result is wrong on both screens**. This is not a divergence, it's invalid data that nobody
will ever fix: the white hole from G-16, or a window sticking out past the end of the wall.
**Where** `v5ClampOpeningsOfWall(P, wallId, opts)` (`js/52:186`), written **once**: **pure**,
**monotone** (it only ever shrinks or brings closer, so no oscillation or drift), **narrow** (the named
wall, `opts.only` for a single opening), and **silent at the receiver**
(`opts.gardeOrphelines`: it never makes an object disappear, only the cascade deletes). Three callers:
`v5ClampOpenings` (the author, announced), and `wall.set` / `opening.set` on receipt (`js/43:61`).
**Measurement** the brief claimed it was enough for the gesture's author alone to bound. **False,
measured**: the harness already modeled it and **24 seeds out of 2,500 still failed**. These are real
races; only bounding at the merge point, identically on both sides, closes them. Since then: **0
failures, `CONNUS` is empty, and 2,500/2,500 seeds pass in `--strict` mode** (verified today, 40.7 s).

### C-13. An outline wall does not get deleted, no matter where the order comes from, and the cascade arrives in two stages
**Guarantees** a single rule, `v5WallDeleteVerdict(P, id)` (`js/52:131`), returning **three** verdicts:
`facade` (refusal, banner), `ok` (interior partition, normal cascade), `absent` (silence).
**Prevents** an outline wall is **derived** from the outline: `v5SyncOutlineWalls` recreates it right
away, but its openings were gone for good. Measured with two browsers: **6 objects lost on one outline
wall (3 windows, 3 fixtures), 2 on another, state persisted as-is.**
**Four subtleties, all discovered after the first fix:**
1. `absent` is **not** `refused`. It is the ordinary case of a shrunk outline: `outline.set` is sent
   **before** the `wall.del`, so by the time the `wall.del` arrives our sync has already done the
   cleanup. Confusing the two would make us cry refusal over a legitimate deletion.
2. The cascade arrives in **two stages**. The diff-based sender ignores the server's cascade: it sends
   `wall.del` **then** one `opening.del` per opening (measured: 1 + 6). **Refusing the wall without
   also discarding what follows saved nothing.** Spared openings are tracked (`ws5KeptOpenings`) and
   each is protected **only once**: deleting a single window from an outline wall stays an ordinary
   gesture.
3. A refusal **restores**, it doesn't just keep. The outbound mirror follows the server, which did
   cascade; the exit `save()` therefore republishes the wall and its openings **in full**. Without it,
   "the preservation would only hold until the first F5 (the `hello` would make the amputated plan get
   adopted) and the other person would never see their windows again". **Divergence is resolved from
   the top, by giving the other person back what they lost, never by destroying here what we still
   have.**
4. A **refused** op **does not enter the undo journal**, otherwise the first Ctrl+Z would replay it
   onto the snapshot and redo exactly the disappearance we just prevented.
**`isOutline` is only a cache**: the verdict cross-checks it against the **outline's geometry at that
moment**, otherwise a replayed snapshot would keep a wall the outline no longer carries.
**Three callers** `v5DeleteSelectedWall` (`js/53`), `ws5ApplyRemoteOp` (`js/43:76`), `histApplyOp`
(`js/27:71`, which works on a **data** plan, not on `state.plan`).
**Verified** nine cases from `tests/collab-annuler.ts`, including `les_trois_verdicts_de_suppression_de_mur`,
`la_cascade_des_ouvertures_est_refusee_aussi`, `supprimer_une_seule_fenetre_de_facade_reste_possible`,
`annuler_ne_refait_pas_disparaitre_les_ouvertures_d_une_facade`,
`le_rejeu_d_annulation_tranche_sur_le_contour_du_moment`.
**Robustness** **by convention**, and it is the most expensive invariant in the repo: one rule, three
callers, a journal, a mirror, an exit `save()`. Each caller can forget it independently.

### C-14. "The geometry changed" does not mean "a wall op went through"
**Prevents** rerunning `v5SyncOutlineWalls()` for no reason is not neutral: it re-matches outline walls
to the outline's edges and, when one is missing, the fallback loop **shifts all the others by one
edge** and manufactures a new one for the gap. Measured on the two-browser bench: **the echo of one's
own deletion made the six outline walls on the sending device rotate by one notch, and its windows
ended up on the wrong wall.**
**Where** `js/43:106`.

### C-15. Nothing disappears from under your hand without a word
**Guarantees** a piece of furniture deleted by the other person while we had it selected (or were
dragging it) shows a banner.
**Prevents** "seeing it evaporate without a word is the worst kind of disappearance: you think it's a
bug in your own gesture".
**Verified** `un_meuble_selectionne_supprime_par_l_autre_le_dit`,
`un_meuble_non_selectionne_supprime_ne_dit_rien`.

### C-16. Banners are throttled by text, but never the response to a gesture
**Guarantees** two regimes. A **system** message is throttled by its text, and beyond
`TOAST_LASSITUDE` repetitions it demands two minutes of silence. A banner that **answers a deliberate
gesture** goes through `toast(msg, {geste:true})` and comes back **on every gesture**.
**Prevents** two opposite defects, both measured. Without throttling: **22 banners in 371 s, 8 of them
the same sentence** ("Tapis 17 est plus grand que la pièce" [Rug 17 is bigger than the room]), and two
alternating warnings kept retriggering each other indefinitely. With naive throttling: **"Cette
cloison est déjà là." [This partition is already there.] only showed on the first of five attempts, the
next four failed without a word**; yet repeating the gesture is exactly what someone who didn't
understand does.
**Where** `js/24:2` and `js/24:12`. The grouping unit is the **gesture** (`_gesteEpoch`, advanced by
`pointerdown` and `keydown`), so a burst within one gesture doesn't repeat and a gesture message never
accrues lassitude. **Accepted tradeoff**: repeating the same refused gesture ten times gives ten
banners.
**Verified** `un_message_identique_est_etrangle`, `un_message_du_systeme_reste_etrangle`,
`une_reponse_a_un_geste_revient_a_chaque_geste`, `un_trace_en_double_le_dit_a_chaque_essai`,
`meme_message_pas_huit_fois`.

### C-17. A full replacement received mid-gesture is queued, never dropped
**Prevents** a state replacement during a gesture wipes out the gesture: the dragged object becomes
orphaned (the drag closure holds the old object) and the view recenters under your fingers.
**Where** `gQueuedOp` / `gQueuedState` / `gQueuedStateOpts` (`js/03`), applied at the end of the
gesture; a remote op never recenters the view (`v5SetModel(p, {keepView:true})`). Detail:
`gQueuedStateOpts` travels along with the state, "otherwise a delayed undo would lose its
`keepShadow` and would be applied locally without ever being published".
**Verified** `interactions.ts`: `remote_replace_during_drag`, including the witness assertion "the
dragged object has become orphaned: the drag closure holds an object outside the plan".

### C-18. After a disconnect, what the server never received is resent
**Guarantees** `ws5DiffOps(local state, ws5Ack)` gives exactly the work the server has never received;
it is replayed **on top of** the adopted state.
**Prevents** without this, adoption would silently erase everything that was in flight at the moment of
the disconnect. Computed **before** any adoption, "adoption overwrites local state, so afterward it
would be too late".
**Where** `wsRejouerNonAcquittees` (`js/43:300`), `WS_REBASE_MAX = 500`. This is Replicache's rebasing,
written with the field-by-field diff.
**Verified** `reconnexion_le_travail_en_vol_est_repose_sur_l_etat_adopte`,
`reconnexion_sans_travail_en_vol_ne_republie_rien`.

### C-19. A refused op leaves no trace, and a failed write is rolled back
**Guarantees** `applyOp(structuredClone(plan), op)` works on a copy; size is checked **before** any
write; a `storage.put()` failure restores both the plan **and** the op counter.
**Prevents** `cell.set`, `env.set`, `room.set`, and `rooms.merge` (an op since removed: no client
emitted it, and it was the only non-idempotent one) used to leave an **incomplete**
entity, later persisted by the next op, which made **any subsequent cold load** fail (a cell with
`poly:[]` born from a name that was too long). And a mutation accepted then rejected by
`storage.put()` let the exception escape `webSocketMessage`, with no error for the client, no
persistence, and no echo to the peers.
**Ordering detail** `persistPlan()` arms the alarm **before** the `put`: "if `put` fails, the caller
can roll back without leaving storage ahead of memory".
**Verified** a generic test, **62 invalid ops replayed, plan compared byte for byte**;
`persistance KO : rollback du plan et du opCount`; `rapide_ops_sont_idempotentes`;
`op partielle refusee : plan intact`.

### C-20. The alarm is the "dirty" flag
**Guarantees** the persisted alarm (30 s) stands in as the flag: it survives the Durable Object's
eviction, unlike an in-memory `this.dirty` or a `setTimeout` under hibernation. Immediate flush when
the last socket leaves, disarmed only on success.
**Prevents** "the Durable Object's recycling no longer loses the pending snapshot".

### C-21. The REST/realtime conflict destroys nothing silently, but recovery is manual
**Guarantees** at rest the Durable Object **adopts** the REST write; while active it keeps the live
version, **preserves the foreign bytes** (the `orphan` key), and announces a `conflict`. A `told` list
guarantees whoever wrote offline learns about it on their return, **exactly once**, via their `hello`.
No merge is ever attempted: "a guessed merge would make deleted entities reappear". Fallback if storage
refuses: "warning without keeping is better than doing nothing at all".
**Prevents** the D1 fallback used to be a **sink**: everything written to it during a realtime outage
was destroyed on return, because the Durable Object never reread the database.
**Where** `d1Verdict(row, seen, dirty)`, a **pure** function (`worker.ts:140`). The discriminant is
that the Durable Object never writes anything but `'live'` into `updated_by`, and the REST Function
never writes `'live'`.
**Verified** `conflit_est_dit_en_francais`, `state_d1_adopt_est_adopte_et_annonce`,
`le travail fait pendant la panne SURVIT`, `les octets etrangers sont CONSERVES`,
`l'absente est prevenue a son retour`.
**Robustness** **incomplete.** The message says bytes are preserved, but **nobody can pick them back
up from within the app**: recovering an orphan is done by hand. Gap n°1, point 4 of
`docs/collab-etat-de-l-art.md`.

### C-22. Presence is never persisted
**Guarantees** `wsPeers` and `wsCursors` live in memory, indexed by device, nothing in the database.
This is Yjs's `awareness` protocol. The remote cursor is interpolated (lerp 0.35, roughly 80 ms of
convergence, hidden after 4 s).
**Verified** `peers() transporte l'etiquette d'appareil`, `peers() ne transporte plus de champ room`,
`freshTag evite l'etiquette deja prise par un socket vivant`.

---
# G. Gestures and interaction

### G-1. Every gesture has a single exit point
**Guarantees** eleven entry points go through `armGesture(finish[, onUp])`, which wires the end to
`pointerup`, `pointercancel`, `lostpointercapture`, **window focus loss**, and a **watchdog**
(`GESTURE_IDLE_MS = 8000`). This is the **only** place that ends a gesture. `save()` forces the exit
of a stale gesture before deciding not to write.
**Prevents** `gestureActive` makes `save()` bail out at the top. A gesture that never ends leaves the
flag true **forever**: nothing more is written locally, **no send, no op, and all the session's
work disappears on reload, without a single message**. Real trigger: a digit typed during a resize
left the gesture open (the keyboard listener survives the release, but the **gesture** itself must
end, `js/18:151`).
**Where** `js/03:39`, safety net in `save()` (`js/07:42`).
**Verified** `interactions.ts`: `gesture_always_ends`, whose assertions enumerate every entry point
(furniture, group, wall, vertex, edge, trace) and every trigger (`pointercancel`, `blur`,
watchdog, abandoned dimension entry).
**Robustness** **by convention, and one of the three most fragile.** Nothing technically prevents
a new gesture from listening to `pointerup` itself. The consequence is silent and total.

### G-2. The view is not the plan
**Guarantees** pan, zoom, pinch, "Fit" and window resize go through
`renderView()`, which repaints without persisting anything.
**Prevents** measured: **a 40-move pan = 40 serializations and 854,520 bytes written.**
**Where** `js/03:118`.
**Verified** `interactions.ts`: `view_gestures_never_persist`, with an essential witness case, "a
furniture move MUST still write, otherwise the counter lies."

### G-3. Selecting never writes: a 3 px guard on five entry points
**Guarantees** no geometry gesture pushes history or rewrites the plan until the pointer has
moved 3 px. `pushHistory()` is pushed on the **first move**, not on `pointerdown` (exception:
Alt+drag, whose duplicate is born on `pointerdown`).
**Prevents** two measurements on the real plan. A click **on an outline wall**, without the slightest
movement, split the wall in two, lengthened a kitchen partition by 90 cm three meters away,
took the apartment from 10 to 11 rooms, and **moved 16 pieces of furniture by up to 114 cm**,
plus a window teleported 3.3 m: **28 differences** (56 in an earlier version, with 10 rooms
reduced to 4). A click **on an outline vertex** lengthened a partition by 90 cm three meters
away, split a room in two (9.6 m² → 7.7 + 1.9), made a radiator travel 114 cm, and recorded
all of it. Overall measurement: **4 wall segments out of 44 broke something on a plain click,
0 out of 44 afterward.**
**Where** `v5StartOutlineEdgeDrag`, `v5StartVertexDrag`, `v5StartWallDrag`, `v5StartOpeningDrag`
(`js/53:253`, `:301`) and `startPieceDrag` (`js/17:56`).
**Verified** `gestes-usage-reel.ts`: `selection_facade_ne_modifie_rien`; `gestes-precision.ts`:
`clic_sur_sommet_n_ecrit_rien`, `clic_sur_meuble_ne_le_bouge_pas`.

### G-4. Picking up a piece of furniture doesn't move it
**Prevents** bounds correction kicked in on **every** release, even without the slightest
movement. Measured: **a plain click moved "Baignoire 2" (Bathtub 2) by 11 cm and "Machine à
laver" (Washing machine) by 8 cm**, because they were already encroaching on the 6 cm setback.
**Where** `js/17:237`.

### G-5. The round trip returns to the starting point
**Guarantees** an object put back where it was returns **exactly**.
**Prevents** three distinct causes, all measured:
1. **The grid rounded the absolute position** instead of the gesture's steps. A piece of
   furniture placed at 393 cm was shifted to 395 on the very first gesture, and bringing it back
   exactly became impossible: **6 exact returns out of 19, median gap 2 cm**.
2. **The center was rounded, then the corner was re-derived from it.** On an **odd** width (a
   45 cm chair) the center lands on a half-centimeter and `Math.round` always rounds up:
   **every round trip gained 1 cm, endlessly**, snapping cut short.
3. **Alignment snapping overshot the targeted line.** `Math.round(p.x + delta)`: a delta of 1.5
   became 2, the next calculation found 0.5, rounded it back to 1, and **the furniture oscillated
   endlessly by ±2 cm**. It is now truncated **toward zero**; snapping becomes idempotent.
**Plus a fourth**, priority given to the original position: a **long** gesture that puts a piece
of furniture back within 6 cm of where it was placed by the second-to-last drag puts it back
exactly there (`_avantDernier`, `js/17:243`). The condition applies to the **previous** gesture,
not this one: it required a path of more than 50 cm, so the most common step (30 cm) never
qualified, and the furniture oscillated endlessly (**62 exact returns out of 122 at 30 cm**).
**Result** 6 exact out of 19 → 20 out of 20; 23 pieces of furniture out of 47 that didn't return →
3 out of 47, no drift; **537 exact round trips out of 549, versus 468.**
**Where** `js/17:172`, `js/17:202`, `js/20:54`.
**Verified** `gestes-precision.ts`: `aller_retour_idempotent`; `gestes-usage-reel.ts`:
`aller_retour_revient_au_depart`.

### G-6. A bounds correction can never push something further away
**Guarantees** each iteration must **reduce** the penetration, otherwise it is discarded and it
stops there.
**Prevents** a piece of furniture larger than the cell received four opposing pushes that
**added up**: **the sofa dropped in a room too narrow jumped 372 cm on release, outside the
apartment, where it wasn't even reachable anymore.** "A tolerated (and announced) overflow is
worth more than a catapulted object."
**Where** `js/19:26`.
**Verified** `gestes-perte-de-travail.ts`: `meuble_trop_grand_ne_saute_pas`.

### G-7. What was already overflowing keeps its overflow, and pushing further is refused outright
**Guarantees** the **already acquired** penetration of a piece of furniture serves as a floor for
interactive bounds correction; we prevent it from going **further** into the wall, we don't push
back what was already there. Pushing further is refused, **never projected**.
**Prevents** a converted plan places furniture straddling a wall, or even the outline wall.
Measured: "Radiateur 3" (Radiator 3) started from **113 cm** in response to a push of 30,
without a word, and its original spot became unreachable. And why refuse rather than project:
**a projection slides along the outline wall, so the round trip never returns to the same
spot** (1 cm per cycle, measured).
**Where** `pieceTol` (`js/19:80`, in-memory scratchpad, "nothing is persisted: it describes what
was read, not a property of the plan"), `hors0` (`js/17`), `clampCenterToApt` (`js/05:56`),
`{gardeOrphelin}` (`js/52:287`).

### G-8. No mass renormalization, and the banner belongs to whoever made the gesture
**Guarantees** `v5ClampPieces()` only repositions **orphaned** furniture (center in no cell) and
announces it.
**Prevents** mass bounds correction used to sweep back over all 47 pieces of furniture in the
plan: **16 of them jumped (by up to 114 cm)** because they had been placed before the setback
existed. **Only one was actually lost.** "The plan shown on opening wasn't the plan we had, and
the first click rewrote it without a word."
**And the message goes to the right screen**: measured on three devices, "Radiateur 3 n'était
plus dans aucune pièce…" ("Radiator 3 was no longer in any room...") showed up on **2 screens
out of 3**, sometimes on the one who had done nothing rather than on the one who made the
gesture (`v5ForeignOrphans`, `js/52:318`).
**Verified** `mon_propre_orphelin_est_annonce`, `un_orphelin_venu_du_fil_est_repare_en_silence`.

### G-9. Painting goes from largest to smallest, and the stack sorts on the paint rank
**Guarantees** the paint order goes from **largest** to smallest, it is written into
`data-paint`, and that's **what** `stackedAt` sorts on. Openings carry `-1` (always underneath).
**Prevents** two distinct defects, stacked on top of each other:
1. **The paint order followed the array order.** A 6 m² rug added after an armchair covered it
   entirely and made it ungrabbable. Measured with **300 objects: 20 gestures out of 30 moved a
   different piece of furniture than the one targeted** (two out of three). Afterward: **0
   gestures out of 88.**
2. **The stack reordered itself on every click.** `elementsFromPoint` returns the actual paint
   order, but `.piece.sel` raises the selected item to `z-index:50`: the cycle's key changed and
   the cycle started over from zero. Measured on five stacked objects: **twelve clicks reached
   only two of them, the three at the bottom stayed unreachable.**
**Where** `renderPieces` and `pickStacked` (`js/12:67`, `:74`, `:179`).
**Verified** `gestes-precision.ts`: `cible_sous_le_curseur_a_300`, `pile_de_cinq_entierement_cyclee`;
`selection-visible.ts`: `la_selection_ne_reordonne_pas_la_pile`.

### G-10. The press grabs what's selected, the completed click steps down one notch
**Prevents** stepping down as early as `pointerdown` made the object just reached **unmovable**:
the next drag, starting from the same pixel, would grab the next one in the stack. Measured: "we
did reach the countertop under the cooktop, and it then refused to move."
**Where** `js/12:90`. The step-down is decided on `pointerup`, and only if the pointer hasn't
moved more than `STACK_TOL`. And it **is announced** ("the stack must be ANNOUNCED").
**Context** the real plan contains two wall lights exactly superimposed: "believing we were
picking up the same fixture again, we moved the washing machine by **74 cm** without seeing it."
**Verified** `gestes-precision.ts`: `gros_meuble_sous_petit_atteint`; `gestes-usage-reel.ts`:
`objets_superposes_atteignables`.

### G-11. The lasso knows both families, and what it catches gets marked during the gesture
**Prevents** `pieceById` only knows furniture: windows, doors, wall lights and outlets live in
`plan.openings` and were silently left out. Measured on the real plan: **a full-screen lasso
caught 47 objects and zero openings.** "It wasn't a style defect, it was a selection that
simply wasn't happening."
**And nothing is written during the gesture**: neither `selIds`, nor `render()`, nor `save()`;
the marking is paced by `requestAnimationFrame`, applied only to the nodes whose state
**changes**. Saved plan fingerprint identical throughout the gesture.
**Where** `piecesInClientRect` (`js/22:260`), live marking (`js/22:185`).
**Verified** `tests/selection-visible.ts`, 7 cases / 37 assertions.

### G-12. Escape cancels the gesture, puts the object back, and says so
**Prevents** three defects. The furniture kept following the mouse, the move was recorded on
release, and the only thing Escape did was **clear the selection out from under your finger**.
During a lasso, Escape **confirmed** the selection instead of canceling it (the shared exit path
took care of it). And **silently exiting Wall mode** is indistinguishable from a malfunction:
measured on a real session, **16 walls clicked in a row with no effect, and the incident filed
as "not reproducible."**
**Where** `js/33:180`, `js/33:220`, `onCancel` of `armGesture` (`js/22:231`).
**Verified** `gestes-precision.ts`: `echap_qui_quitte_les_murs_le_dit`;
`gestes-perte-de-travail.ts`: `echap_annule_le_geste`; `ouverture-redim.ts`:
`echap_rend_exactement_la_cote_d_avant`.

### G-13. A gesture that produces nothing says why
**Prevents** measured on the real plan: **a 45 × 50 cm chair didn't move a single centimeter,
four drags in a row, in total silence.**
**And its counterpart, G-13bis**: dropped here, put down there, it gets said. Measured: **an oven
pushed 30 cm to the right ended up 28 cm to the left, without a word, and the user started
over.** Threshold: 15 cm of gap between what the hand asked for and what the bounds correction
delivered.
**Where** `js/17:269`, `js/17:279`.
**Verified** `gestes-usage-reel.ts`: `geste_sans_effet_dit_pourquoi`.

### G-14. An armed tool wins, during the capture phase, over all handles
**Prevents** a wall drawn starting **on** a facade never reached the wall tool:
**the user dragged the outline wall across the apartment, 15 m² reduced to a 20 cm strip,
without a word.**
**Where** `gestes/murs.ts`, `v5CaptureDown`, arbitration at **capture** time, with no exception
since decision 0010 left a wall no button of its own. Also applies to Measure and pan:
"underneath them, a handle must absolutely not trigger a deletion or an insertion under the
cursor."
**Verified** `gestes-perte-de-travail.ts`: `tracer_gagne_sur_les_poignees`.

### G-15. The "+" handle lives outside the outline
**Prevents** the corner-insertion "+" used to sit at the **exact center** of every outline wall,
right on top of the wall: a click meant to select the wall landed on it and **inserted a
corner**, whose global recalculation cut the wall in two and moved 16 pieces of furniture.
**Where** `v5OutlineOutward` (`js/53:362`): 18 px **outside** the outline.
**Verified** `gestes-perte-de-travail.ts`: `poignee_plus_ne_vole_pas`.

### G-16. The depth of an opening is bounded by the thickness of its wall
**Guarantees** `h` is the thickness of the object **inside** the wall, and the box is centered on
the median line. The bound is the load-bearing wall's, and the refusal **names its reason**.
**Prevents** an opening **repaints the background over the floor**: `h` larger than the wall
digs a white hole that overflows on both sides, straight through both rooms. Measured: **200 cm
of depth on a 10 cm wall, accepted silently, 455 px of white across the plan.**
**Where** `v5OpeningDepthMax(w)` / `v5OpeningDepthFor(w, want)` (`js/52:373`), written once.
**Three callers, and only the ones that write during a gesture**: the `#iH` field (via
`dimBounds`, `js/21`, refusal stated with the wall's thickness, `min`/`max` attributes that
follow the **selected** opening), placement and paste (the catalog depth follows the wall,
without a word, nothing chosen being lost), and the **change of load-bearing wall**
(`v5MoveOpeningTo`: the depth follows **downward**, never upward, Escape restores it, and it's
stated on release).
**Explicitly not concerned, and it has to stay that way**: `sanitizeV5Plan` (import, old plan,
restore), `v5OpeningWire` (`js/51`, which keeps the sole server bound 1..200, **otherwise the
mirror would diverge from the state and keep re-emitting forever**) and receiving an op (`js/43`,
cf. C-11). "We never silently readjust someone else's saved plan."
**Recorded** on 2026-08-04 on production (rev 268) and on the pre-cutover backup: **0
openings beyond their wall, all thicknesses equal to 12 cm.**
**Verified** `garde-fous.ts`: `profondeur_bornee_par_le_mur`; `rapide.ts`:
`rapide_profondeur_bornee_par_le_mur`, `rapide_serveur_borne_la_profondeur_d_ouverture`.

### G-17. A numeric field applies nothing until the value is valid
**Guarantees** three outcomes and a single source of truth for bounds. Explicit refusal that
**gives the bound** (impossible keystroke, or value definitively out of bounds); "pending" state
for a prefix that could still grow (typing "1" before "180"); applied after **220 ms** of typing
pause. The HTML `min`/`max` attributes are rewritten from `cfg.bounds()`.
**Prevents** the field used to apply on **every keystroke**, silently falling back to an
arbitrary bound: **typing letters placed the furniture at 10 cm, "1" stored 5, "-50" too, and
"3000" went into a 12 m dwelling**. Three bounds contradicted each other (`min=10` attribute, JS
clamp `5..3000`, server `1..3000`). And without the typing pause, **typing "3000" committed 3,
then 30, then 300 along the way**, and the final refusal handed control back at 300, a value
nobody had wanted.
**`cfg.raison()`** completes the refusal when the bound comes from somewhere other than the
field: "This wall is 10 cm thick: any deeper and the opening would go through both rooms."
Without this wording, "between 1 and 10 cm" reads as an arbitrary software limit.
**Where** `numField(el, cfg)` (`js/00:100`), the **only** numeric-entry guard.
**Consequence for tests** a value set programmatically requires ~350 ms of waiting, or a
`blur`.
**Verified** `garde-fous.ts`: `champs_de_dimension`, `assistant_ne_ment_pas`.

### G-18. The server bounds what's dangerous, the client bounds what's sensible
**Guarantees** the client bound can be **stricter**, never wider. A piece of furniture's
dimension is additionally bounded by the **dwelling**'s largest side.
**Prevents** "a 3,000 cm bed in a 12 m dwelling went through, and ended up outside every
cell" (`js/21:3`). And the assistant: "an outline announced as 5 × 4000 built an apartment of
100 × 3000, and an outline 5 cm wide was accepted without a word" (`js/29:60`,
`SETUP_MIN = 100`, `SETUP_MAX = 3000`).
**Verified** `garde-fous.ts`: "the min attribute must be 10 (the server accepts 1, we are
stricter)," "never exceed the server bound `PIECE_WH_MAX=3000`."

### G-19. An opening resizes at the handles, opposite edge frozen, and every bound is stated
**Three arbitrations kept in a single place** (`js/56:1`): the other end doesn't move (keeping
the object centered would move both edges at half the hand's speed, whereas "what's under the
cursor is what moves" is the application's central rule); three bounds (wall length, neighbor on
the same **face**, server validator 1..600, "beyond that the op is refused and the change is
lost"); and when it hits a limit, it says so, "without this wording, a handle that no longer
advances is indistinguishable from a malfunction."
**Small openings** an outlet is 10 cm, i.e. ~6 px at "Fit" scale: two 9 px handles
placed on its edges **would cover the entire object and make it unmovable**. The threshold
applies to **length alone**, because an opening is always thin (12 cm, ~8 px) and a threshold on
the minimum would declare it compact even at 5 m wide.
**Verified** `tests/ouverture-redim.ts`, 11 cases / 41 assertions.

### G-20. Handles never eat into the object's surface
**Prevents** a 45 × 50 cm chair measures ~29 × 32 px at opening zoom: **eight 9 px handles
placed on its edge covered nearly all of its thumbnail**, so aiming at its center to move it
grabbed a handle instead, and the application's central gesture failed on the most common object
of a real plan (chairs, outlets, plants).
**Where** `js/12:266`, `RSZ_COMPACT_PX = 64` (below this threshold the middle handles disappear
and the corners move to the outside), `RSZ_OUT_PX = 6`. And handles are created **only on the
selection** (before: 8 nodes per piece of furniture, **376 in total**, plus a
`querySelectorAll` per piece of furniture on every frame).

### G-21. You see what you're placing, during the gesture
**Prevents** the ghost carried a plain rectangle whose background was `t.color + "55"`, but
`t.color` equals `var(--seat)`: the string `var(--seat)55` **is not a valid CSS color**, so it
was ignored. Measured headless: the rendered ghost's `backgroundColor` = `rgba(0,0,0,0)`,
**background computed as entirely transparent across all four paths.** On screen, you
literally saw nothing until you let go.
**Where** `js/16:90`, **a single implementation** served to the armed hover, the armed drag, and
the drag from the palette: "three copies would have diverged at the first fix."
**Verified** `tests/apercu-pose.ts`, 10 cases / 46 assertions (background actually painted, real
icon in the right orientation, targeted wall highlighted, refusal written out, touch path).

### G-22. Placement is a drag-and-drop, and the click arms it
**Prevents** a click on a thumbnail used to **make the object appear** at the last known cursor
position, so somewhere other than under the hand, so unpredictable. "You didn't know what you
were about to place until it was placed." This is also what produced **ten quick clicks, ten
objects at the same pixel** (the screen showed one, the furniture list counted ten, and the
occupied surface lied).
Fallback anti-stacking: `STACK_RING`, 24 offsets, applied **after** bounds-fitting to the cell
("in a narrow room the clamp brings every placement back to the same spot").
**And a double-click is one gesture, not two**: the second click (`detail >= 2`) places nothing,
otherwise the palette answered a double-click with two pieces of furniture, every time
(`js/08:31`).
**Where** `js/16:202`, `js/16:18`.
**Verified** `gestes-perte-de-travail.ts`: `pose_ne_sempile_pas`; `faces-pose-copie.ts`:
`clic_sur_la_vignette_arme_la_pose`, `chemin_tactile_pose_sous_le_doigt`.

### G-23. No invisible spacer captures clicks
**Prevents** measured: **238 px dead band to the right of the plan on desktop; on phone the
column spans the full width, so the entire plan was dead to the touch.**
**Verified** `faces-pose-copie.ts`: `la_cale_des_panneaux_n_avale_aucun_clic`.

### G-24. The clipboard: a single undo step, relative layout preserved
**Guarantees** a **wall-mounted** object can be copied (it has no coordinates, it belongs to a
wall, and "refusing it would make the gesture useless right where it matters most: the same
outlet in three rooms"); a locked object can be copied but **the copy is born unlocked**
("silently leaving it locked would make it immovable without anything explaining why"); a single
`Ctrl+Z` undoes the whole paste; the relative layout is identical to within 1 cm ("a
**distortion**, each object bounded on its own, breaks this promise"); `Ctrl+C` in a text field
stays text.
**Where** `js/33:1`. Same placement reference as placing from the palette (`lastCursorApt`), "two
different rules for two neighboring gestures would be one more source of error."
**Verified** `faces-pose-copie.ts`, seven clipboard cases.

---
# R. Rendering and legibility

### R-1. A furniture name is always horizontal
**Guarantees** zero degrees, everywhere, always. The `.plabel-wrap` wrapper is a child of the already-rotated node:
we cancel out exactly its rotation, through a **pure function of the angle**, with no DOM measurement and no hysteresis.
**Tried then rejected** the convention used by drawing software, where the label follows the object while staying
within the readable half-circle [-90, +90[. Verdict on the real floor plan: « never write furniture names
upside down, should always be readable (horizontal) ». **A vertical name running across the dining corner
is not upside down and still stays illegible at a glance.** `readableAngle` and `labelSpin` were
removed, no callers left.
**Consequence** there is no longer **any** special case, no half-turn, no hinge, so nothing left that
can flicker when slowly rotating.
**The trap kept as a reminder** the label wasn't failing to inherit the rotation, it was already compensated.
The real culprit was an **`innerHTML` cache whose key carried neither `side` nor `rot`** (`js/54`):
flipping a wall lamp rotated its box by 180° without rebuilding its content, and "Applique" stayed
upside down. Anything that depends on `side`/`rot` therefore sits **outside** this cache.
**Where** `setLabelSpin` (`js/00:62`), **two callers, and they must stay two**: `renderPieces`
(`js/12`) and `wsApplyOneGhost` (`js/43:347`, which drives the node's rotation while a peer is moving
the piece; without this callback, "a piece of furniture that the other person is rotating showed its
name upside down for the whole drag").
**Verified** `tests/textes-lisibles.ts`, 5 cases / 27 assertions, **24 orientations, measured angle = 0
everywhere**, screen + PNG + printing.

### R-2. No name is ever written on a wall object
**Prevents** the icon is unambiguous (a door's arc, a window's interrupted strip, a wall lamp's
half-disk); the name on top only added clutter. Measured on the real floor plan: **a single outline
wall carried four stacked labels, and the living-room wall three "Applique" side by side, illegible at
working zoom. 15 opening labels before, 0 after.**
**We are removing a display, not a piece of data** the name stays in the item's sheet, the furniture
list, the JSON export, local storage, and `opening.set` on the wire.
**Verified** `textes-lisibles.ts`: `appliques_dos_a_dos` (the test was **updated** instead of being
worked around: with no label it passed on its own anyway, so it now checks for the absence of text, the
presence of the icon, and the survival of the name in the model).

### R-3. On a piece of furniture, only a chosen name gets written, and the catalog has a history
**Guarantees** a name is "default" if it matches **today's** label or one of the **historical** labels
for its type. The comparison goes through `baseName`, so the occurrence number ("Table 2") doesn't turn
a catalog name into a chosen name. An **unknown** type is displayed: we don't judge what we don't know.
**Prevents** the application was born in English and got translated on day two. Compared only against
the current (French) label, the older names looked chosen. Measured on the household's floor plan, at
working zoom: **four "Chair" surrounding a table that itself carried a fifth, "Table," plus a
"Coffee table." 8 labels → 2 on screen, 3 → 2 on the printed sheet.** What remains is "Homu" and "Ikea,"
the two genuinely chosen names.
**Where the table comes from** the English catalog is in **no commit** (the first versioned
`index.html` is already French): `LEGACY_TYPE_NAMES` was reconstructed **from the floor plans
themselves**, where each piece of furniture carries its `type` next to the name it received at birth
(`tests/fixtures/plan-reel-77.json`, `plan-rev177.json`, household backups). Five types (`chair`,
`dining`, `coffee`, `door`, `window`), the only ones in the corpus to carry a name outside the catalog.
**No label was invented**: guessing one in would risk masking a name someone may actually have typed.
**Second wave** 2026-08-05, interface switched back to English: the **40 French labels** withdrawn at
that point went in as a single block.
**Accepted** nothing distinguishes a catalog "Table" from a "Table" typed deliberately; the call was
made from a screenshot of the real floor plan.
**Where** `isChosenName` (`js/12:143`), `LEGACY_TYPE_NAMES` (`js/01:77`), which lives **next to the
catalog, not in the rendering code**: it's the same column as `name`, at a different date.
**Verified** `rapide.ts`, five cases (`rapide_nom_de_catalogue_courant_ne_s_ecrit_pas`,
`rapide_ancien_libelle_anglais_ne_s_ecrit_pas`,
`rapide_le_numero_d_occurrence_ne_fait_pas_un_nom_choisi`, `rapide_un_nom_tape_s_ecrit_toujours`,
`rapide_la_table_des_anciens_libelles_ne_couvre_que_des_types_connus`), no browser needed.
**Robustness** **by convention, and it's one of the three most fragile.** Renaming a catalog entry
without depositing the old label into the table **brings back the name of every existing piece of
furniture, all at once, on every floor plan**. And the sweep "sees a **wrong** entry, never a
**missing** one": the invariant isn't checkable in the direction that matters.

### R-4. Color is carried by the item, never by the category
**Guarantees** `cat` says **where to look** (category = room of use), `color` says **what it is**
(painted hue).
**Prevents** color used to come from the **category**: grouping the palette by room of use would have
**repainted every floor plan already saved**. "Can't fix a filing mistake without changing a floor
plan."
**Fix measurement** rendering footprint **identical down to the bit** on the real floor plan, computed
colors included.
**Where** `js/01:3`.
**Robustness** **by convention.** A note and a one-off measurement, no type.

### R-5. The palette is organized by room of use, not by object family
**Guarantees** five categories, in the order of what actually gets placed (counted on the household's
floor plan, **77 objects**): Openings & fixtures (**39**), Living & dining (13), Bedroom (9), Bathroom
(9), Kitchen (7).
**Prevents** nine categories, two of which held only two objects each, put **a bed under "Déco"** even
though no bedroom category existed, **a radiator (the third most-placed object) under "Structure"**
next to a duct, **a chair under "Tables"** even though a Seating category existed, and split wall
objects across two categories.

### R-6. A label never spills outside its tile
**Guarantees** the available space is the **horizontal chord** of the rotated tile passing through its
center, `min(w/|cos|, h/|sin|)`.
**Prevents** the text is horizontal (R-1) while the box is tilted, so neither the local width nor the
bounding box works. The old guard compared an **estimated** length against the **largest** side: on a
narrow, long piece of furniture (a countertop, a radiator, the dining-corner table), **the label
overflowed on both sides and landed crosswise on the floor plan**.
**And truncating isn't always better than staying silent**: a short ellipsis is tolerated (the name may
overflow by at most a quarter) and we stay silent beyond that, "Coff…" on a coffee table teaching
nobody anything.
**Where** `js/12:329`, plus `max-width` and an ellipsis in CSS (`css/07`) to make overflow impossible at
any zoom level.

### R-7. The printed sheet and the PNG carry the same names
**Prevents** the sheet used to carry only the title and cell names, so "Homu" and "Ikea" only ever
existed on screen. "A floor plan you print is meant for discussing it away from the screen."
**Two accepted differences** the "Afficher noms & tailles" option does **not** govern the sheet (it's a
screen setting, personal), and its threshold there is in **centimeters** (60 cm on the shortest side),
since the export is independent of the live zoom.
**Associated rule** no `<text>` inside a `glyph` group of the SVG: this group carries a `rotate(rot)`,
so any text slipped into it would read crooked, possibly upside down (`js/32:27`).
**Verified** `textes-lisibles.ts`: `export_png_et_impression`, and the canary assertion "N `<text>`
lives inside a rotated group of the master SVG".

### R-8. An identifier never goes raw into a selector
**Prevents** an identifier comes from the wire, a JSON import, or an old floor plan: a `"` or a `]`
makes `querySelector` **throw**, and the call is made from `render()`, so **the whole application goes
down, not just the offending entity**. Twelve interpolations fixed. In the ghost loop, "one exception
would kill every ghost belonging to the peer, not just this one."
**Where** `cssId` (`js/00:9`) via `CSS.escape`, minimal fallback. "The server bounds the character set
of an id today, but this is our last frame."
**Verified** `v5_ghost_selector_resists_a_hostile_id`; `rapide_serveur_refuse_un_id_hostile` and
`id avec guillemet refuse` (the second barrier, server-side).

### R-9. One single HTML escaping function, complete, for the whole application
**Prevents** the Circulation panel used to put raw names into `innerHTML`, and an escaping function that
was **incomplete** existed elsewhere as well. The four characters all matter: `&` first (otherwise we
re-escape the entities we just wrote), `<`/`>` because the names go out through `innerHTML`, and `"`
because those same names land inside attributes.
**Where** `escapeHtml` (`js/00:19`). Same rule for an email relayed by the server (`js/44:52`): "one
single rule, no harmless exceptions."
**Verified** `run.ts`: `hostile_names_never_inject_html`.

### R-10. `[hidden]` means hidden
**Prevents** the browser sheet's rule has **zero specificity**: the smallest class rule
(`.dims{display:grid}`) would repaint a block that was supposed to stay hidden, including **a field
inoperative on every piece of furniture** and "Largeur de l'encoche" displayed on the Rectangle shape.
**Where** `[hidden]{display:none!important}` (`css/01`). **Never patch it case by case**: adding one
more `.x[hidden]{display:none}` just reopens the door somewhere else.
**Verified** `garde-fous.ts`: `hidden_veut_dire_cache` (three passes: assistant open, floor plan open,
inspector open).

### R-11. The two floating panels stack, never anchor to the same corner
**Prevents** the room sheet used to cover the inspector's fields and buttons, leaving some actions
unreachable.
**Where** `.side-panels` (`html/04` → `html/05`), a `.side-spacer` shim that collapses when they no
longer fit; on a short screen they sit side by side instead (`css/17`).
**Verified** `garde-fous.ts`: `panneaux_jamais_superposes`.

### R-12. An area is written with `fmtM2()`, the same way everywhere
**Prevents** the same number used to show up in three different forms a few pixels apart: "15.1 m²"
(rail chip), "15,12 m²" (room sheet), "total 15.1 m²" (toolbar). One decimal, a comma. `m²` stays
lowercase, "`M²` is not a unit."
**Verified** `garde-fous.ts`: `surfaces_au_meme_format` (four locations compared, including the
assistant's preview).

### R-13. The cell sheet is resynced by `render()`, not by a selection
**Prevents** after moving an outline wall it used to display the old area (**the toolbar announced
13.7 m², the rail chip 13.7 m², and the sheet for the very same room 15.12 m²**), and after a cell
merge, **a room that no longer existed**. Along the way it also resets `v5UI().selCell` if the targeted
cell has disappeared.
**Same defect on the rail**: "no wall edit refreshed it, not drawing, not deletion, not end of drag, not
a remote op, so it announced **10 rooms when the floor plan had 11**, with stale areas and phantom chips
framing a cell that no longer existed" (`js/25:124`).
**Verified** `garde-fous.ts`: `fiche_suit_le_plan`; `interactions.ts`: `rail_chips_follow_cells`.

### R-14. The foot of the rail stays reachable
**Prevents** the menu, **the only access to Save**, was buried under 3,000 px of palette.
**Where** `position: sticky`.
**Verified** `garde-fous.ts`: `menu_toujours_atteignable`.

### R-15. A resize only reframes if it broke the framing
**Guarantees** we compare the current transform against the **previous** viewport size, remembered: we
only reframe if the floor plan fit **before** and no longer fits **after**.
**Prevents** portrait → landscape used to leave half the floor plan below the bottom edge; 1680 × 1000 →
900 × 700 overflowed by **544 px** on the right. But reframing unconditionally would yank the view out
from under someone who had deliberately zoomed in.
**Where** `js/46:11`.
**Verified** `garde-fous.ts`: `recadrage_au_redimension`, with the canary "a deliberate zoom must never
be undone."

### R-16. The first adoption of the server floor plan reframes, later ones don't
**Prevents** a new device frames the apartment at the default view (420 × 360) before the real floor
plan arrives: without reframing it **overflowed by 389 px on the right**, and you'd have to go hunt down
"Fit" to see your own home. A later adoption, though, can land while someone is working. Import and
switching models, on the other hand, reframe every time: those are **deliberate** actions.
**Detail** during a gesture, `applyReplacedState` queues up, so the "first time" isn't spent for
nothing.
**Where** `firstAdoptDone` / `adoptServerState` (`js/41:156`).
**Verified** `vue_recadree_a_la_premiere_adoption_seulement`; `repli-d1-live.ts` #19 and #20.

### R-17. Anti blank page
**Guarantees** three barriers. Every element dimension is bounded to [0, 100000] px and `NaN` becomes 0
(`safeDim`, `js/00:5`); the px/cm scale of floor patterns is bounded to keep every `<pattern>` dimension
under ~4096 px (`js/10:5`); and a **sentinel** periodically checks structural invariants and attempts a
self-repair.
**Prevents** "a px dimension that is NaN, negative, or gigantic, written into a style, can make the GPU
raster fail **silently** (especially ARM/ANGLE) and blank out the entire page," **with no JS exception
at all**, so `window.onerror` never sees it. Other real causes encountered: a focus halo with a GPU
`filter`, and a giant scroll on the root.
**Cadence** 3 s while present, 10 s at rest, 20 s of inactivity: "every pass forces a layout sync;
every 3 s forever is a permanent tax paid for a failure that itself happens **during** an interaction."
**Verified** `v5_white_page_sentinel_is_quiet`.

### R-18. The Circulation panel never lies about what it isn't showing
**Guarantees** the score is computed from the counts of the **entire list**, not from the 14 findings
displayed; the sort by severity happens **before** the truncation, so whatever the cap drops is always
the least severe; and the panel states how many findings are not shown.
**Prevents** the cap of 14 used to cut **silently**. Measured at 300 objects: a floor plan can carry
**25 blockers, of which eleven fell into the 23 findings that weren't shown**, and the score came out
optimistic. The engine was also **inert with the panel closed**: the badge kept its original gray dash
even though five blocking findings existed on the household's floor plan.
**Cost measured before making it permanent** a full pass (grid, clearance field, Dijkstra, rules) costs
**30 to 50 ms**, almost independent of object count, triggered once at the **end** of a gesture, never
during it. At 77 objects, panel closed: **0 long tasks** across a 60-move drag, p95 frame time 23.6 ms.
Panel open: 126 ms of long tasks, p95 46.5 ms.
**Where** `js/38:10`, `:26`, `:96`, `:219`.

### R-19. No CSS class without a consumer
**Verified** `tests/no-dead-selectors.ts`, static, instant: every class in `src/css/` has a consumer in
`src/ts/` or `src/html/`, and a declared exception that no longer matches any CSS rule is flagged as
**unused**.
**Robustness** **bounded.** "The suite that tracks dead selectors only covers **classes**, not ids"
(noted in commit `d7350c2`).

---

# V. Server-side validation

### V-1. Key allow-list, rejection of the unknown
**Guarantees** for the four v5 entities, any key outside `PIECE_KEYS` / `WALL_KEYS` /
`OPENING_KEYS` / `CELL_KEYS` fails the op (`piece_key:<k>`, etc.).
**Prevents** for lack of an allow-list, the client used to pack **three pieces of information into
a bitfield in the hinge field**: the server thought it was validating a hinge when it was actually
validating three mixed-together fields, and **any finite number would pass**.
**Robustness** **undocumented asymmetry**: `validateRoom` and `validateEnvelope` (v4 path) have
**no** allow-list.
**Verified** `unknown key`, `v5 sanitize strips extras`, `v5 sanitize has no v4 keys`.

### V-2. The wire object is never stored
**Guarantees** each validator builds a **fresh** object. Consequence: "a rejected op leaves no
trace in the shared plan."
**Verified** `rapide_ops_sont_idempotentes`, `canonical opening survives a second sanitize`.

### V-3. A missing field means "no opinion," server-side too
**Where** `prevOf(prev, id)` and `pick(k)` (`ops.ts`).
**Robustness** **by accident on the v4 path.** `validateRoom` and `validateEnvelope` do
`pieces.map(validatePiece)` (`ops.ts:307` and `:334`), so `validatePiece` receives the **array
index** as `prev`. `prevOf` happens to neutralize it (`String(e.id)` is `"undefined"`), so it is
harmless today, but **the rule does not work on this path**. The correct call site is
`ops.ts:517`: `(p) => validatePiece(p, prev && prev.pieces)`. **To fix before types get frozen.**

### V-4. The bounds, as they stand
```
COORD_MAX       100 000        any coordinate, finite, in [-100000, +100000]
POLY_MAX_PTS    2 000          and minimum 3 points
MAX_ENTITIES    2 000          per family (walls / openings / pieces / cells / rooms)
PIECE_WH        1 .. 3 000
WALL_T          1 .. 60
OPENING_W       1 .. 600
OPENING_H       1 .. 200       depth as seen from above, NOT a height
NAME_MAX        80             TRUNCATED, never rejected
SWING_MAX       80             max length if swing is a string
TYPE_RE         ^[a-z0-9_-]{1,32}$
ID_RE           ^[A-Za-z0-9_.:-]{1,80}$
WIRE_COORD_MAX  10 000 000     cursor and ghost only
MAX_PLAN_BYTES  1 500 000      JSON.stringify(plan).length
OPENING_TYPES   door sdoor window sconce plug rj45
OPENING_SIDES   0 1
CELL_FLOORS     parquet herringbone tile plain
```
**Non-obvious decision** `t0` is bounded by the **physical** range (0..100000), **not** by the
wall's length. This is deliberate: operations arrive one at a time, a wall being thinned can
precede or follow its opening, **and a rejection is destructive**. "If this were ever touched, it
would be a clamp, never a rejection."
**Verified** ~131 `throws()` assertions in `live-worker/test-local.ts`.

### V-5. Type and identifiers constrained by shape, not by allow-list
**Why** "otherwise every catalog addition would require a server deployment."

### V-6. An op from the other model returns `op_shape`, not `unknown_kind`
**Guarantees** `applyOp` branches on `isV5(plan)` and both default branches distinguish the case
"this `kind` exists, but not for this state." `plan.replace` explicitly rejects a v5 payload.
**Prevents** a v4 tab left open used to overwrite a v5 plan.
**Verified** `v4 stays v4`, `v5 stays v5`, `neither shape rejected`.

### V-7. The Durable Object's snapshot is revalidated on wake
**Prevents** otherwise the database would stay **mixed** until the next write to each opening.

### V-8. Both forms of an opening are accepted during the deployment window
**Guarantees** **unpacked** form (`side` is a key in its own right, `hinge` a pure boolean) and
**packed** form (`side` in bit 1 of `hinge`), discriminated by the **presence** of `side`. The
database converges toward the unpacked form.
**And absence does not erase** `h` and `name` absent from an op mean "no opinion," never "erase":
**an old tab can no longer erase an opening's name by moving it.**
**Consequence for types** the **wire** type is not the type in the **database**: `hinge` is 0..3 on
the wire (packed form), 0 or 1 in the database.
**Verified** `packed 3 -> side 1 hinge 1`, `old client rewrite does NOT lose h`,
`old client rewrite does NOT lose name`, `old-client creation stores no invented h/name`,
`D1 load unpacks without inventing`.

### V-9. An unreadable plan never becomes an empty plan
**Guarantees** `coldLoad` has **three** distinct outcomes (`empty` / `d1` / `raw`), in a pure,
testable function. The `raw` outcome serves the raw bytes rather than installing a fresh plan:
"a stale state beats an empty plan." A failed D1 read lets the exception propagate, so the
WebSocket upgrade fails and the client goes back into backoff, **instead of installing an empty
plan that it would then write back over the real row**.
**Verified** `coldLoad ne substitue jamais un plan vide a une ligne pleine`,
`D1 injoignable : rien n'est installe ni persiste`.

### V-10. Relayed cursors and ghosts are validated and rebuilt field by field
**Prevents** `drag.pieceId` injecting a selector; an absurd wire coordinate. Losing a cursor frame
has no consequence, so `sanitizeCursor` / `sanitizeDrag` return `null` rather than tolerate.
**Verified** `cursor au-dela de la borne du fil rejete`,
`drag pieceId injectant un selecteur rejete`.

### V-11. A server error never ends up in the console
**Guarantees** `too_big`, `persist_fail`, `bad_json`, `unknown_t`, `state_shape`, `op_fail` each
have a message in French, and **every other reason falls back to a generic message that names
it**. Throttled by reason (one toast per reason per 5-second window, because "a single gesture
can produce a burst of ops all rejected for the same reason, cell by cell").
**Prevents** "a validation rejection used to be the most silent case: the edit was lost and the
screen claimed otherwise."
**Detail** `too_big` and `persist_fail` do not close the socket: "closing it would fix nothing
(the next send would hit the same wall) and would lose presence, cursors and chat."
**Verified** `model-v5-fil-serveur.ts`, five `v5_err_*` cases including
`v5_err_toast_is_throttled_per_reason`.

### V-12. The sync chip never lies
**Guarantees** five states, and **not a sixth**: `live ✓` (WebSocket), `saving…`,
`slow sync` (D1 fallback), `not saved` (the read succeeds, the **write** does not),
`offline`, `local` (tab detached after restoring a backup).
**Prevents** the chip used to lie twice. The `GET` poll would succeed every 4s and **repaint
"slow sync" over every failed send**. And a silent WebSocket failure passed for simple lag.
**Why no sixth state for a 409** a revision rejection is not a state of the **transport**: the
link works, it is the write that was rejected, so "not saved" for the duration of the
rejection, then back to "slow sync" as soon as the reread happens.
**Where** `putFailed` and `setSyncChip()` (`js/41:8`, `:79`).
**Verified** `repli-d1-live.ts` #10 to #12; `repli-conflit.ts` #21.

---

# Appendix A: what is guaranteed by accident

Six guarantees hold today for a reason other than the one it seems. They will disappear at the
first unrelated change, and a rewrite will not reproduce them on its own.

| # | Guarantee | Why it holds by accident |
|---|---|---|
| D-3 | The pre-conversion backup is recoverable | The menu entry was removed. Only `window.__plan.restoreBackup()`, a **test** hook, still accesses it. |
| V-3 | "Missing field = no opinion" on the v4 path | `pieces.map(validatePiece)` passes the **array index** as `prev`. `prevOf` rejects it by chance. |
| C-8 | Identifiers do not collide | **None of the 109 production identifiers** carries a device tag yet. The protection only covers new ones. |
| R-19 | No dead selector | The sweep only covers **classes**, not identifiers. |
| R-3 | The historical label table is complete | The test sees a **wrong** entry, never a **missing** one. |
| (not on the list) | `window.__plan` exposes what we think it does | Two duplicated keys (`wallsMode` `src/js/57:58` and `:294`, `pieceTol` `:465` and `:505`). The last one wins; the accessor form of `wallsMode` is dead. No test reads it, so nothing breaks, **by luck**. |

# Appendix B: known, unaddressed gaps

Carried over from `docs/collab-etat-de-l-art.md`, which remains the reference for detail.

1. **The Durable Object's snapshot has no compare-and-swap.** The REST side is closed (D-8), the
   Worker side is not. Mitigated by a reread before each snapshot.
2. **Recovering an orphan is manual** (C-21). Serving the orphan on a message would be enough:
   the client already knows how to adopt a complete state.
3. **Undo relies on snapshots, not on inverse operations** (C-9), with three documented limits.
4. **The peer sees nothing during a structural gesture.** Dragging a piece of furniture broadcasts
   a ghost every 40ms; dragging a wall, a vertex, an outline, or an opening broadcasts none
   (measured: **25 operations at once for a wall pushed 40cm**).
5. **Cell identifiers are positional**, renumbered on every detection. Only the name and the floor
   covering survive, by area matching. This is deterministic, it is not an identity.
6. **No tombstone.** Figma doesn't have one either and owns it. For 110 entities, a bounded
   tombstone would make undoing a deletion reliable after the tab is closed. **Useful, not
   essential.**
7. **An adoption event never put to the test**: the production row predates the unpacking of the
   wall side; run through cold load, its fingerprint changes (`95cfe1fc388ad314` becomes
   `fb8d4e7051ba4354`, +270 bytes). On the Durable Object's next cold start, every client will
   adopt the server state. **This is the intended behavior, but it has never actually happened on
   this data.**
