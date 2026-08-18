# The pre-deploy barrier

Everything runs through **ONE single command**:

```
node tests/all.ts
```

36 suites run in parallel on the development machine. The total check count is printed by
the launcher: several suites have gained cases since the historical measurement of 2026-08-05. Nonzero exit
code as soon as one suite fails; only the FAILURE detail is reprinted.

```
node tests/all.ts --list        # list the suites
node tests/all.ts run model-v5  # only run the ones whose name contains this
node tests/all.ts --jobs 2      # force concurrency   (--seq = one by one)
node tests/all.ts --repeat 5    # replay the whole barrier 5 times (stability proof)

PLAN_TESTS_PRIORITE=normale node tests/all.ts   # normal priority: used to REPLAY the measurement
```

- `node` must be on PATH
- Default path of the application under test: `index.html` of the repo (produced by `node build.ts`).

**Never run the suites one by one by hand.** The launcher gives each suite a PRIVATE `%TEMP%`,
kills at its exit the Chrome tree whose command line carries this folder, and deletes the
folder. Without it, each round left dozens of orphaned `chrome.exe` processes and their profiles:
the machine slowed down until it made the suites waiting on a render lie (`model-v5` went
from 47s to 246s then 496s within the same session). The kill filter is this private PATH,
never the process name: the user's browser cannot be touched.

**The barrier runs at low priority.** Each suite is set to `BELOW_NORMAL` at launch,
and a watcher also sets the barrier's `chrome.exe` processes to it (Chrome itself resets the priority of
its renderers and its `gpu-process`, so they inherit nothing). Without this, a run was the
worst moment of the day for the machine's responsiveness. The full reasoning and measurements are
in `AGENTS.md`, section "The barrier runs at LOW PRIORITY".

## What each suite covers

*(table regenerated from `node tests/all.ts --list` and a real barrier log)*

| Suite | Checks | Covers |
|---|---|---|
| `tests/gestes-precision.ts` | 7/7 | REAL MOUSE: the click target is indeed what's shown, and repeating gives the same result, up to 300 objects. |
| `tests/model-v5-fil-serveur.ts` | 15/15 | Shape of the wire (validated by the REAL `live-worker/ops.ts`), server refusals announced to the client, D1 fallback through `functions/api/plan.ts`. |
| `tests/model-v5-modele-defaut.ts` | 16/16 | The walls-only model is the DEFAULT model: automatic conversion on load, not repeated, reversible, identical on two clients; view recropped only on first adoption. |
| `tests/model-v5-edition.ts` | 9/9 | Editing tools (walls, outline, openings, furniture, pointer designation) and inspector with no dead button. |
| `tests/model-v5-ancien-plan.ts` | 11/11 | Reading an old plan (overlapping rooms, undo, wall objects) and personal settings that do not carry over. |
| `tests/rapide.ts` | 48/48 | **No browser, < 1s.** Planar subdivision, opening bounds, sanitization, door arc, Circulation engine, wire shape, server refusals, diff and undo. All client code is imported from `src/ts`. |
| `tests/model-v5-conversion-rendu.ts` | 6/6 | REAL plan of the user (8 rooms → 10 cells, 21 openings, 21 furniture items), read-only rendering, `serialize`/`migrate` round trip. |
| `tests/repli-d1-live.ts` | 21/21 | Realtime DOWN, two real browsers: no `/ws`, so D1 fallback. Renaming that carries through in both directions, "slow sync" chip, broken write announced "not saved" then restored. |
| `tests/collab-annuler.ts` | 34/34 | Realtime wire: fingerprint, identifiers, field-by-field diff, server mirror, UNDO with two clients, bounding on receipt, banner throttling. |
| `tests/gestes-usage-reel.ts` | 10/10 | REAL MOUSE: ordinary usage (selection, round trips, stacks of objects). |
| `tests/repli-conflit.ts` | 25/25 | Two devices write IN FALLBACK AT THE SAME TIME, on a real SQLite: compare-and-swap of the PUT, 409, loser's version set aside, `Ctrl+Z` brings it back, convergence. `--avant` replays the measurement on `HEAD`. |
| `tests/faces-pose-copie.ts` | 18/18 | Faces of wall objects on placement and on copy. |
| `tests/deux-appareils.ts` | 15/15 | Two devices behind a single address: replay log, presence, cursors, undone server refusal, banners. |
| `tests/collab-accuses.ts` | ok | LOSSY TRANSPORT: the real `PlanRoom` runs in the page, frames get lost / delayed / reordered; acknowledgments, retransmission, reconnection. |
| `tests/garde-fous.ts` | 10/10 | REAL MOUSE + KEYBOARD: inputs, panels, bounds and messages (banners visible, not covered, in French). |
| `tests/gestes-perte-de-travail.ts` | 7/7 | REAL MOUSE: seven SILENT losses of work (trace stolen by a handle, crossing wall cut, oversized furniture that snaps away, duplicate walls, Escape, stacked placement, "+" handle). |
| `tests/ouverture-redim.ts` | 11/11 | REAL MOUSE: opening width via the handle (opposite edge frozen, wall / neighbor / server bounds, all STATED). |
| `tests/run.ts` | 29/29 | Base behaviors + READING of old formats (v3, v4 `rooms[]`): placement, cells, resizing, outline, shared walls, wall lights (range, face, sliding), `serialize`/`migrate` round trip. |
| `tests/apercu-pose.ts` | 10/10 | REAL MOUSE + REAL FINGER: during the gesture, you SEE what you're placing (background actually painted, icon, targeted wall, refusal). |
| `tests/plan-abime.ts` | 13/13 | Slow GET or damaged plan: a device in a bad state does not overwrite the household's plan. |
| `tests/interactions.ts` | 5/5 | REAL MOUSE (CDP): every gesture terminates, VIEW gestures write nothing, a remote op received mid-drag is queued, the rail follows the cells, a renamed opening carries through the wire. |
| `tests/selection-visible.ts` | 7/7 | REAL MOUSE: the lasso also picks up OPENINGS, and what it catches gets marked DURING the gesture, without writing anything. |
| `tests/textes-lisibles.ts` | 5/5 | NO UPSIDE-DOWN TEXT: the half-circle rule across all text families, screen + PNG + print. |
| `tests/boot-vierge.ts` | ok | Blank startup: wizard open on an empty install, closed once a plan is seeded, no JS error. |
| `tests/harnais-graine.ts` | 2500/2500 | No browser, seed-deterministic: convergence of ops and undo/redo round trip (20,000 green seeds outside the barrier). |
| `tests/compat-donnees.ts` | 1065/1065 | No browser: THE DATA COMPATIBILITY ORACLE. Rereads the corpus through `src/ts` and compares its fingerprint to `tests/fixtures/empreintes-compat.json`; `--b` compares two module directories; `--corpus <dir>` (or `PLAN_CORPUS_PRIVE`) adds a private corpus from a directory outside the repo, off by default, whose fingerprints live next to it (`<dir>/empreintes.json`), never in this repo. |
| `tests/no-dead-selectors.ts` | 1/1 | Static, instant: every class in `src/css/` has a taker in `src/ts/` or `src/html/`; exceptions carry their reason. |
| `tests/artefact-autonome.ts` | 6/6 | The deliverable is a self-contained file and triggers no external request. |
| `tests/etiquette-renommer.ts` | browser | Inline renaming of a label, without a detour through the inspector. |
| `tests/train-ouvertures.ts` | browser | Grouped movement of openings without destroying the selection. |
| `tests/repartir-espacement.ts` | pure | Even distribution of selected furniture. |
| `tests/fenetre-battement.ts` | pure | Geometry of window swing. |
| `tests/mur-libre.ts` | pure | Freestanding partition wall and precise placement mode. |
| `tests/projection.ts` | pure | Optical calculation of the projector. |
| `tests/exports-morts.ts` | 2/2 | Every suite is registered in the barrier and no new export goes without a caller. |
| `live-worker/test-local.ts` | 601 assertions | Server, no browser: validator, ops, Durable Object, D1 fallback, sequencing and deduplication by (tag, n). |

## How the suites work

Zero dependencies. Two families:

- **DOM** (`run.ts`, `model-v5-*.ts`, `collab-*.ts`, `deux-appareils.ts`...): for each case, a
  temporary HTML = `<seed>` (`window.__PLAN_TEST__=1` + a plan fabricated in `localStorage`) + the
  application verbatim + `<probe>` (drives `window.__plan`, writes a JSON verdict on
  `<html data-plan-test>`). The probe also rereads the `localStorage['plan-errors']` ring: any
  logged JS error fails the case.
  **All of these share ONE browser per suite**, opened by `tests/_navigateur.ts`: a case is a
  `Page.navigate`, not a process. Six suites used to spawn a whole Chrome per case, which came to
  159 cold starts per barrier run and collapsed into phantom `0/11` results as soon as the machine
  was busy. Isolation is unchanged and never came from the fresh profile: the seed's own
  `localStorage.clear()` / `sessionStorage.clear()` is what empties the state. The verdict is
  awaited as a CONDITION carrying the case's nonce, under a bound that calibrates itself on the
  suite's median. A probe body may be `async` (only `collab-accuses.ts` needs it, to await the real
  server). See `docs/decisions/0006-un-navigateur-par-suite.md`.
- **REAL MOUSE** (`interactions.ts`, `gestes-*.ts`, `apercu-pose.ts`, `ouverture-redim.ts`,
  `selection-visible.ts`, `garde-fous.ts`): built-in CDP driver
  (`Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText`) on a Chrome at
  `--remote-debugging-port=0`, port reread from the `DevToolsActivePort` of ITS OWN profile. Synthetic
  `PointerEvent`s bypass hit-testing: only they prove a real gesture.

The two-browser suites (`repli-d1-live`, `repli-conflit`, `deux-appareils`, `collab-*`)
spin up a local HTTP server on `listen(0)` that serves the application and `/api/plan` wired to the
REAL `functions/api/plan.ts` Function; `SYNC_ON` is only true over http(s), hence the server.
Nothing is shared in writing between two suites: they run in parallel without stepping on each other.

## The model under test: walls-only, and nothing else

The application now has only ONE model: an outline, walls, furniture in apartment cm, and
**cells calculated** from the walls. No more room, no more envelope, no more container.

Old formats remain **READABLE**: a `rooms[]` plan seeded in `localStorage` is read and
converted on load, exactly as for the user. Half of `run.ts`'s cases deliberately
seed an old plan.

## Notes

- The suites read `index.html`, never modify it.
- Under `file://`, `SYNC_ON` is false: the wizard opens on a truly empty install and
  stays closed when a plan is seeded (which the startup tests assert).
