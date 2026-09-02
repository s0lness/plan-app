# plan

2D apartment planner: an OUTLINE, WALLS, furniture, and ROOMS COMPUTED from the walls.
Drag-and-drop furniture, distance guides, windows/wall lights/outlets configured on their wall,
"Circulation" engine (clearances, paths, score), floor plan JSON export/import.

Why it is built this way, not just how to work in it: `docs/decisions/`.

## The model: walls only, and NOTHING else
- `state = {plan, opts, setupDone, model:"v5"}` with
  `plan = {outline, walls[], openings[], pieces[], cells[]}`, **everything in APARTMENT cm**.
- A **cell** (a "room" in the usual sense) is DERIVED from the planar subdivision of the outline by
  the walls. It owns nothing: neither furniture nor openings. It carries a name and a floor, and
  these survive recomputation through area matching.
- A **wall** is ONE object shared by the two cells it separates: moving it adjusts both. It goes
  from `a` to `b` and stays there (decision 0012): nothing pushes an end out to the first thing
  beyond it, at load, during a gesture, on an incoming op or after a square-up. The one thing that
  still moves an end by itself is the OUTLINE, which brings back inside anything that left the home.
- An **opening** (door, window, wall light, outlet, RJ45) belongs to the WALL: `{wallId, t0, side}`.
- A **piece of furniture** has apartment coordinates, period. No re-homing, no notion of a
  "current room", no local coordinate system.
- **Old formats remain READABLE** (v1/v2/v3 single-room, v4 `rooms[]`+`envelope`):
  `migrate()` rebuilds them in memory (`readLegacyRooms`), then converts them (`buildV5FromV4`)
  and discards the scaffolding. Nothing in the live application edits this format. The blob from
  before conversion is copied verbatim into `localStorage` (key `room-planner-v4-backup`). The menu
  entry that reloaded it was REMOVED (conversion is done, the converted floor plan is in service):
  the data remains, `v5RestoreBackup()` remains, the entry point does not.

## Architecture
- **The deliverable remains ONE file**: `index.html`, self-contained (CSS + HTML + a JS IIFE),
  zero dependencies, zero network, no `<script src>`, no CDN. Persistence in `localStorage`
  (key `room-planner-v4`, history) + shared D1 floor plan + file export/import.
- **Local storage does not have ONE key, it has six, and they do not mix.** What describes the
  APARTMENT crosses the network, what describes THE PERSON'S SCREEN never does.

| `localStorage` key | What it contains | Written by | Crosses the network? |
| --- | --- | --- | --- |
| `room-planner-v4` | **THE FLOOR PLAN.** It is the D1 PUT body and the contents of an export. | `save()` | **yes**, it is the shared data |
| `room-planner-opts` | PERSONAL SETTINGS: layers, labels, snapping, Circulation panel, overlay, collapsed categories, television inches. | the options | **no**, in EITHER direction: `serialize()` does not include them and `makeState()` ignores the `opts` of every received payload (neither realtime nor D1 fallback) |
| `room-planner-v4-backup` (+ `-at`) | The blob from BEFORE conversion, copied VERBATIM on the first conversion. | `migrate()`, once | no |
| `room-planner-v4-backup-illisible` (+ `-at`) | The blob that could NOT be read again (interrupted write, truncated JSON, unknown version), set aside BEFORE anything replaces it. | the read that fails | no (downloadable from the banner) |
| `room-planner-v4-conflit` | The last 5 versions rejected by a 409, so nothing is lost during a concurrent fallback. | `js/41` | no (can be reimported through "Load a plan…") |
| `room-planner`, `room-planner-v1..v3` | Old formats. **Read only**, never rewritten. | nobody | no |

- **An unreadable floor plan does not pretend to be a floor plan.** When the rescue blob is written,
  `setupDone` falls back to false: the application SAYS SO (banner + wizard) and **can no longer
  publish anything** to the shared floor plan (`putableState` requires `setupDone===true`). Covered
  by `tests/plan-abime.ts`.
- **`index.html` is a PRODUCT, not a source.** The source lives in `src/` and is assembled again
  by `node build.ts`. Never edit `index.html` by hand: the next build will overwrite the change.
  It is COMMITTED (Pages serves the root statically, without a build).
- **The TypeScript client is the only client source.** `index.html` is built from `src/ts/`.
  The old JavaScript source was removed. It was archived as a self-contained artifact for a
  retention period; that archive is not part of this published repository.

## Layout
What an agent will need to open, and nothing else. Built files (`index.html`) are OUTPUTS: never
edit them.

```
plan/
  index.html                THE DELIVERABLE served by Pages. Produced by `node build.ts`, never edited by hand.
  build.ts                 builds index.html from src/ts · `--check` · `--dev` · `--out`
  exemple-appartement.json  demo floor plan (invented apartment, v5 walls-only format)
  src/
    manifest.json           manually maintained order of the head, CSS, and HTML
    head.html               the deliverable's <head>
    README.md               the actual source map
    css/                    stylesheets in the cascade order of src/manifest.json
    html/                   shell and panel fragments in the order of src/manifest.json
    ts/                     THE ONLY CLIENT: typed ES modules; main.ts boots it
  functions/                Pages Functions: D1 floor plan, errors, and WebSocket upgrade
  live-worker/              Realtime Worker, server validator, and local tests
  tests/                    suites and pre-deploy barrier; see tests/README.md
  docs/                     invariants, rewrite history, and collaboration
```

## Work loop
```
edit src/ts/…
node build.ts                    # builds index.html, THE DELIVERABLE
node tests/rapide.ts             # THE FAST LOOP, without a browser, < 1 s
node tests/all.ts                # THE PRE-DEPLOY BARRIER: see `node tests/all.ts --list`
git add -A && git commit && git push
```
`tests/all.ts` is the ONLY pre-deploy barrier launcher. It gives every suite a private `%TEMP%`,
kills the Chrome tree living inside it on exit, and deletes the folder. Never run the browser
suites manually in sequence.

- `node tests/all.ts --list` lists the suites · `run model-v5` runs only one (name filter)
- `--jobs N` forces concurrency · `--seq` serializes · `--repeat 5` replays the entire barrier
- The `--legacy` flag, which used to replay the 24 suites that accept an application path against
  the archived pre-cutover build, was removed along with that archive: it is not part of this
  repository.

### What `node build.ts` produces, and where the old client lives

```
node build.ts                    # index.html: THE DELIVERABLE, minified TypeScript client
node build.ts --dev              # index.dev.html: inline sourcemap, never committed
node build.ts --check            # rewrites nothing; exits 1 if index.html differs from the source
node build.ts --out X.html       # builds elsewhere for comparison
npm run typecheck                # client config + tools config; also run by tests/all.ts
node tests/boot-vierge.ts        # starts without a JS error
```

`npm run typecheck` runs both `tsc --noEmit` and
`tsc --noEmit -p tsconfig.outils.json`; `tests/all.ts` runs the same two passes as its `typecheck`
pseudo-suite.

- `--next` and `--legacy` are rejected by `build.ts`: `src/js` no longer exists, and the archived
  pre-cutover build is not part of this repository.
- The build path requires `node_modules` (`typescript@7.0.2`, `esbuild@0.28.1`, pinned versions).
  They are build tools, never runtime dependencies.
- The deliverable remains self-contained. The esbuild metafile must contain only `src/ts/`, and the
  CSP guards reject every tag or rule that would load an external resource.
- `src/ts/` has no manifest: the import graph sets the order. `src/manifest.json` controls only the
  head, CSS, and HTML, in a manually maintained order.
- `node_modules/` and `index.dev.html` are gitignored; `index.html` is committed and served statically.
- npm on this machine blocks esbuild's `postinstall` without preventing the JS API from finding the
  binary. Bun can replace esbuild for a parse check, never `tsc` for type checking.

### Two speeds of verification
- **FAST path**, VISUAL or COSMETIC change (color, margin, label, icon, panel order): fix it, take
  ONE before/after screenshot, run `node build.ts`, push. Do not write a lasting test for the
  occasion, and do not sweep the suites.
- **FULL path**, `node tests/all.ts`, only when the change touches **DATA** (model, serialization,
  migration, storage), **SYNCHRONIZATION** (realtime wire, ops, D1 fallback, conflicts), or
  **GEOMETRY** (walls, cells, openings, outline, gestures that modify them).

### A NEW TEST IS SEEN RED BEFORE IT IS SEEN GREEN
Write the test, then **remove the fix and run it**. If it still passes, it does not test the defect,
whatever its name says, and shipping it is worse than shipping nothing: a suite that cannot fail
reassures, and the next real defect gets waved through as "the machine again".

Measured on 2026-08-13, twice in one day. A case proving `?p=` was ignored on the guest door
asserted on `updated_by`, and the fixture wrote the SAME author to both plans, so it passed
whichever plan was served. And the room-label suite compared labels only to other labels, while
half the reported defect was a room name printed on an OBJECT: it passed against the broken code,
and it took FOUR attempts on the fixture before the real cause (the measurement looked in the wrong
place) came out. Once corrected, the negative control is unambiguous: 36 overlaps without the fix,
zero with.

The same applies to a fixture: `--figer`-style freezes and "known debt" lists are ratchets, and a
ratchet you lower to silence a suite is a rug.

### NEVER AUTHOR SOURCE THROUGH A SHELL HEREDOC
Escape sequences do not survive the trip. Writing `\n`, a regex, or a template literal through
`bash <<EOF` + `python` puts REAL newlines into the file and breaks it, three times in one night
here (`functions/nom.ts`, `tests/retour.ts`, `tests/exports-morts.ts`). Use the editor for anything
containing an escape. A shell heredoc is for data, never for code.

### A GUARD IS JUDGED ON ITS NEW FAILURE MODE
Hardening that turns one crash into another has moved the problem, not removed it. The browser
suites read `document.getElementById("x").hidden`, which throws mid-navigation; guarding it with
`||{}` then returned `undefined`, which `JSON.stringify` renders as the string `"undefined"` and
`JSON.parse` rejects. Same dead scenario, one layer further out, one more full barrier lost. State
what the guarded path returns, and check that the caller accepts it.

### Pace
- **One batch carries one request.** Do not pick up improvements along the way.
- **After more than ten minutes without delivery**, the worker returns what works instead of continuing.
- **Check the branch before committing.** A sub-agent may have moved it under you: work meant for
  one branch has already landed on another here, and the wrong branch got pushed.
- **This repository is PUBLIC.** Before committing, look for real identifiers: hostnames, addresses,
  and above all personal data disguised as a test fixture. A real apartment, room by room, was one
  commit away from being published as a label-collision fixture. What reproduces a defect best is
  often exactly what may not be published.

### The pre-deploy barrier runs at LOW PRIORITY, and why (measured on 2026-08-05)

**EVERY FIGURE IN THIS SECTION DESCRIBES A HARNESS THAT NO LONGER EXISTS.** The current suite list
comes from `node tests/all.ts --list`. What survives here is the reasoning about scheduler
fairness, the `--jobs` default, and the second-chance retry.

`PLAN_TESTS_PRIORITE=normale node tests/all.ts` restores normal priority for the barrier. This is
the measurement instrument used to REPLAY the comparison, not a comfort setting.
`PLAN_SEM_CLIENT` may name the local TypeScript client for the machine-wide browser permit pool.
When it is unset or cannot be imported, the barrier warns once and runs without that optional cap.

<details><summary>Obsolete measurements from the former harness</summary>

Continuous monitoring of the workstation for 6 h identified the two `tests/all.ts` runs as the
**two worst moments of the day** for machine responsiveness: the system run queue reached 260 then
324 waiting threads on 12 cores, and keyboard input lagged in **every** application, not only here.

**CPU use was only 52-58% during those peaks.** Free cycles REMAIN: the problem is **scheduler
fairness**, not saturation. **Do NOT lower `--jobs` for this**: that would treat saturation that
does not exist and cost minutes per run for nothing. Puppeteer suites spend most of their time
waiting for page loads, so they legitimately exceed a concurrency ceiling calculated from CPU alone.

**What is applied** in `tests/all.ts`: each suite is lowered to `BELOW_NORMAL` at launch
(`os.setPriority`), **and** one PowerShell watcher repeatedly lowers (every 1,5 s) the barrier's
`chrome.exe` processes.

**Why the watcher, despite intuition.** Priority class inheritance IS NOT ENOUGH on Windows.
Measured process by process: the suite's node process, the browser process, `utility`, and
`crashpad-handler` inherit it correctly (base priority 6), but **Chrome resets the priority of its
renderers itself** (8 visible page, 4 hidden page) **and of its `gpu-process`** (10). Lowering only
node creates a **priority inversion** (the CDP driver falls below the renderers it drives) and costs
2,6 times as much time. Measured across 8 × `tests/interactions.ts`:

| setting | duration | average run queue | keyboard jitter p95 |
|---|---|---|---|
| normal priority | 71 s | 325 | 63 ms |
| node only lowered | 181 s | 254 | 28 ms |
| **entire tree lowered** (selected) | **113 s** | **158** | **15 ms** |

**Guard**, the same as for killing orphans: the filter is the **path** of the barrier's private
folders (`<TEMP>/plan-run-…`), never the process name. The user's browser cannot be slowed down.
A process already below `BELOW_NORMAL` (a hidden-page renderer, which Chrome sets to 4) is never raised.

**The old figures, 4 tasks = 885 s / 8 tasks = 524 s, are OBSOLETE**: they predate the workstation
fixes of 2026-08-05 (CPU capped at ~2700 MHz, 8 of 12 cores parked). The full barrier was measured
again the same day, 12 cores, 28 suites, 4479 checks **on the old client** (4495 since the switch:
`compat-donnees` rises from 1064 to 1080 in differential mode). The "foreign" column counts suites
from ANOTHER agent session running at the same time: that noise dominates everything else.

| run | tasks | foreign | duration | queue avg/p95 | keyboard jitter p95/p99 |
|---|---|---|---|---|---|
| without the fix | 8 | ~1,9 | 564 s | 193 / 338 | 37 / 61 ms |
| without the fix | 8 | ~4,0 | 386 s | 167 / 268 | 29 / 61 ms |
| **with** | 8 | ~1,9 | 572 s | 162 / 304 | **17 / 32 ms** |
| **with** | 8 | ~0 | **334 s** | 115 / 218 | **15 / 18 ms** |
| **with** | 10 | 0 | 311 s | 152 / 252 | 15 / 20 ms |
| **with** | 6 | ~1,8 | 393 s | 116 / 214 | 16 / 20 ms |

What we can state: **keyboard jitter is cut in half or better in every comparable pair**, and the
run queue falls by one third. What we CANNOT state: that the fix affects duration. A second agent
session weighs more than the fix AND the `--jobs` setting combined, and there was no window long
enough with the machine to ourselves to decide. Usable reference: **334 s with 8 tasks on a clean
machine**, versus the 524 s reported by the old figure.

**PER-RUN DURATION REFERENCE, AFTER THE SWITCH** (2026-08-05, 8 tasks, 12 cores, barrier alone on
the machine):

| target | runs | duration per run | checks |
|---|---|---|---|
| **typed client** (`index.html`, default) | `--repeat 3` | 287,8 s · 293,3 s · **289,7 s** | 4495/4495, 28/28 suites |
| **old client** (`--legacy`) | 1 | **275,0 s** | 4479/4479, 28/28 suites |

That is ~290 s per run on the served client, 14,8 min for all three. **The old "~5,5 min" figure is
worthless now**, as is 334 s: that was a single run on the old client, before the four fixes in
`c1b7fe1`. What we can say about the typed/old difference: **it is ~15 s, in favor of the OLD
client**, from one `--legacy` run versus three. That is noise at this scale, not a cost of the typed
client. More importantly, barrier time is dominated by Chrome and waiting for page loads, not by
the client's JS. The three longest suites make up a full run by themselves
(`model-v5-modele-defaut` ~226 s, `gestes-precision` ~201 s, `model-v5-fil-serveur` ~188 s): look
there to save time, not in `--jobs`.

</details>

### One browser per suite (measured on 2026-08-17 and 2026-08-18)

Six suites had each copied the same harness: build a page, `spawnSync` a whole headless Chrome on
it with `--dump-dom` and a brand-new profile, read the verdict back. That was **159 cold starts per
barrier run** (`model-v5-*` 54, `run` 29, `collab-annuler` 34, `deux-appareils` 24, `collab-accuses`
13, `curseur-dire-deux-appareils` 5), each under a FIXED `spawnSync` timeout. On a busy machine a
cold start passed that bound, Chrome was killed before rendering, and a whole suite reported `0/11`
without a word about the code. `tests/_navigateur.ts` replaced it: one Chrome per suite driven over
CDP, a case is a `Page.navigate`, and the verdict is awaited as a CONDITION under a bound that
calibrates itself on the suite's median. Why, and what was rejected:
`docs/decisions/0006-un-navigateur-par-suite.md`.

Same machine, same parallelism (8 tasks), same priority setting, the six converted suites INSIDE
the barrier:

| suite | before | after |
|---|---|---|
| `model-v5-modele-defaut` | 542,7 s | 8,6 s |
| `model-v5-ancien-plan` | 379,9 s | 3,0 s |
| `model-v5-fil-serveur` | 334,4 s | 3,8 s |
| `collab-accuses` | 301,1 s | 2,4 s |
| `model-v5-edition` | 274,5 s | 5,9 s |
| `model-v5-conversion-rendu` | 257,5 s | 5,1 s |

Whole barrier, `PLAN_TESTS_PRIORITE=normale`, machine otherwise idle: **before, it had NOT finished
after 600 s**; **after, 421,8 s, every registered suite and check was green**. See
`node tests/all.ts --list` for the current list. Two suites
(`partage-navigateur`, `retour-navigateur`) still needed the sequential second chance, which is the
known instability, not a defect.

**AND THE LOW-PRIORITY SETTING HAS BECOME THE FIRST COST, which is a reversal.** It was measured
against browsers that lived less than a second each; against a browser that lives for a whole
suite, pinning the tree at `BELOW_NORMAL` starves the page for the entire run. Measured the same
day on the five `model-v5` suites in parallel: **24,2 s at normal priority, 137,5 s with the
lowering**, i.e. every suite roughly forty times slower. Making the watcher idempotent (never
re-lowering a PID it already handled) does NOT recover it: 197,8 s, so the cost is the low priority
itself and not the fight with Chrome raising its renderers back. The default is LEFT AS IS in this
batch: what the lowering buys is the owner's keyboard comfort, it was decided from a jitter
measurement, and reversing it needs its own measurement rather than a duration argument. Replay
with `node tests/all.ts model-v5` against `PLAN_TESTS_PRIORITE=normale node tests/all.ts model-v5`.

**The concurrency optimum did not move enough to change the default.** 10 tasks took 311 s versus
334 s with 8, a 7% difference, over one run each; that is within this machine's noise. The default
remains `floor(cœurs × 2/3)` = 8, which matches the ceiling measured elsewhere on this workstation
(wake latency stays flat through 10 tasks, then doubles at 12).

**Resolved issue** (commit `c1b7fe1`, before the switch): the isolated failures seen at low priority
were not caused by low priority, they were **four cases measuring something other than their name**
(`repli-d1-live` × 2, `apercu-pose`, `garde-fous`). No product code was touched: the returned-database
assertion required two things and the loop waited for only one; the chip was read over two round
trips while `_writeChip` resets the generic title between them; the fixed 250 ms pause in
`apercu-pose` raced the drawer closing; and CDP typing in `garde-fous` committed "2" before "00"
arrived because `numField` applies after a 220 ms typing pause. **Wait for a CONDITION everywhere,
never for a duration**: a longer `sleep` only moves the load threshold where it fails again. A red
negative control exists for each of the four, and `apercu-pose` dropped from 52,5 s to 12,6 s along
the way. If a case becomes unstable again, apply this rule, do not extend a delay.

<details><summary>Suite details (what each one covers)</summary>

All are launched with `node tests/all.ts <filtre>`. "Chrome" says how many browsers the suite opens:
this is what caps barrier concurrency.

**Four of these suites do NOT read the artifact, they read `src/ts` directly**: `rapide`,
`harnais-graine`, `no-dead-selectors`, and `compat-donnees`. Under the now-removed `--legacy` mode,
they were counted as `absent` with their real reason: the archived client had no source in this
repository.

| Suite | Chrome | Covers |
| --- | --- | --- |
| `tests/rapide.ts` | 0 | THE WORK LOOP, < 1 s: cells, server bounds, field-by-field diff, undo, and Circulation. All client code is imported from `src/ts`. |
| `tests/compat-donnees.ts` | 0 | **THE DATA COMPATIBILITY ORACLE**. Reads the corpus again and compares its fingerprints with `tests/fixtures/empreintes-compat.json`. `--b <dir>` compares two module directories; the barrier uses only the frozen reference. `--figer` remains a deliberate act. A private corpus can be pointed at with `--corpus <dir>` (a directory outside the repository), and its fingerprints stay with it. |
| `tests/harnais-graine.ts` | 0 | Deterministic seeded harness: convergence and undo/redo round trip, client code imported from `src/ts`, real server imported from `live-worker/`. |
| `tests/no-dead-selectors.ts` | 0 | Static: no CSS class without a consumer in `src/ts` or `src/html`. |
| `live-worker/test-local.ts` | 0 | 657 SERVER assertions: validator, ops, Durable Object, D1 fallback, sequence, deduplication by `(tag, n)`, and the guest wire (per-recipient redaction, the `name` message, refused `plan5.replace`, the rate cap, revoke closing sockets). |
| `tests/porte.ts` | 0 | THE DOOR: the `HOUSEHOLD_HOSTS` / `GUEST_HOST` allowlists and their `*.` wildcard, the ONE `who()`, and the middleware's refusals. |
| `tests/invitation.ts` | 0 | THE INVITE: token redemption and its single 404, the session cookie, the owner's create/list/revoke, and the guest door's effect on `/api/plan` and `/ws`. |
| `tests/identite-fil.ts` | 0 | WHO A NAME BELONGS TO: `displayName` / `personColor` / `wsSameAccount` including guest-vs-guest, and the proof that a name of `<img onerror=…>` renders as TEXT. |
| `tests/run.ts` | 1 | 29 general regression tests on the deliverable. |
| `tests/model-v5-*.ts` (7 suites) | 1 each | 74 tests: walls-only model, server rejection, D1 fallback. Filter: `all.ts model-v5`. |
| `tests/boot-vierge.ts` | 1 | THE NUMBER ONE TRAP: the page mounts without a JS error, with a blank profile THEN a seeded floor plan. |
| `tests/interactions.ts` | 1 | 6 REAL MOUSE tests (CDP): gestures, view, remote op, rail, openings, wheel routed to the panel under the pointer. |
| `tests/garde-fous.ts` | 1 | 9 REAL MOUSE + KEYBOARD tests: input, panels, bounds, messages. |
| `tests/gestes-perte-de-travail.ts` | 1 | 7 REAL MOUSE tests: SILENT work loss. |
| `tests/gestes-usage-reel.ts` | 1 | 10 REAL MOUSE tests: ordinary use (selection, round trips, stacks). |
| `tests/gestes-precision.ts` | 1 | 7 REAL MOUSE tests: click target and idempotence, up to 300 objects. |
| `tests/apercu-pose.ts` | 1 | 10 REAL MOUSE + REAL FINGER tests: what is being placed is VISIBLE during the gesture (actually painted background, icon, targeted wall, rejection). |
| `tests/ouverture-redim.ts` | 1 | 11 REAL MOUSE tests: resize an opening from its handle (opposite edge fixed, wall/neighbor/server bounds, and STATED). |
| `tests/outil-mur-geste.ts` | 1 | 9 REAL MOUSE + KEYBOARD tests: the click-click wall chain, double-click and Escape, the floor lassoes instead of drawing, a selected wall carries three controls at most and its sheet carries the rest. |
| `tests/selection-visible.ts` | 1 | 7 REAL MOUSE tests: the lasso also takes OPENINGS, and what it catches is marked DURING the gesture, without writing anything. |
| `tests/faces-pose-copie.ts` | 1 | Faces of a wall-mounted object: placement, copy, side change. |
| `tests/textes-lisibles.ts` | 1 | 5 tests, NO UPSIDE-DOWN TEXT: the semicircle rule across every text family, screen + PNG + print. |
| `tests/deux-appareils.ts` | 1 | 24 tests, TWO DEVICES behind one address: replay log, presence, cursors, undone server rejection, banners. |
| `tests/collab-annuler.ts` | 1 | 34 tests, realtime wire: fingerprint, identifiers, field-by-field diff, server mirror, new household, two-person UNDO, receive-time bounds, announced disappearance, banner throttling. **Also checks that no visible text contains an em dash.** |
| `tests/collab-accuses.ts` | 1 | 13 tests, LOSSY TRANSPORT: the REAL `PlanRoom` runs in the page, frames are lost / delayed / reordered; acknowledgement, acknowledged mirror, retransmission, reconnection. |
| `tests/plan-abime.ts` | 2 | 13 tests, slow GET: a damaged device does not overwrite the household floor plan. |
| `tests/repli-conflit.ts` | 2 | 24 tests, TWO DEVICES WRITE THROUGH FALLBACK AT THE SAME TIME: PUT compare-and-swap, 409 rejection, set-aside version. `--avant` replays the measurement against HEAD's `index.html` and Function. |
| `tests/repli-d1-live.ts` | 3 | 21 tests, two browsers, realtime down (touches synchronization). |

</details>

- `node build.ts --check` rewrites nothing and exits 1 if `index.html` no longer matches `src/ts`:
  run it before a commit to detect a hand-edited `index.html`.
- `node build.ts --out X.html` builds elsewhere (comparisons, trials).
- Browser suites use the repository's `index.html` by default, so **the served client**; another
  path can be passed as an argument for comparison builds.
- **Windows trap**: this repository has `core.autocrlf=true`. `build.ts` writes LF, `git checkout`
  rewrites CRLF. The contents remain identical to git; `build.ts --check` normalizes line endings
  before comparing. Do not be alarmed by `M index.html` with no content diff.

## `src/`: the client map

- `src/README.md` is the current map by domain: read it before distributing work.
- `src/manifest.json` manually maintains the order of the head, CSS, and HTML. Adding a fragment
  requires creating the file AND registering it in the right position; `build.ts` rejects an orphan file.
- `src/ts/` contains real ES modules. Their `import` graph is the order contract; `main.ts` is the
  only boot entry point.
- The old JavaScript split, `split.ts`, and `decoupage.json` were removed. The `js/NN` references
  still present in the incident accounts below are HISTORICAL references, not paths in the live
  repository: use `rg` to find the named symbol in `src/ts/`.

## Blank startup (the number one trap)
The file has already had three temporal dead zone initialization errors. Reordering modules brings
them back, and **the test suites do not see them** (they all seed `localStorage`). After every move
in `src/manifest.json`:
```
node tests/boot-vierge.ts                                    # repository index.html
node tests/boot-vierge.ts --plan ~/.claude/jobs/d745c367/tmp/backup-rev246.json --png /tmp/boot
```
Pass 1: blank profile, no `localStorage`, no server floor plan (`file://` disables synchronization).
The "The outline of the flat" modal must open, with zero JS errors. Pass 2: a real floor plan is
seeded, furniture must render, with zero JS errors. `--png` writes the screenshots.

## Deployment
- Cloudflare Pages, project `plan-app`, git-connected to `<owner>/plan-app`, branch `main`, without a build
  (static root). Routine deployment = `git push`.
- **What Pages serves is the COMMITTED `index.html`**, as-is: there is no Cloudflare-side build
  step. Leaving `index.html` out of the commit deploys the old file without a word;
  `node build.ts --check` before committing prevents this.
- **Rollback**: `git revert <cutover commit>` returns `index.html` to the previous client.
- Domain: `plan.example.com` (CNAME to `plan.pages.dev`, the zone's domain).
- Access restricted by Cloudflare Access (allowed emails: someone@example.com,
  someone-else@example.com). The service must never be assumed public.
- **`HOUSEHOLD_HOSTS` MUST BE SET ON THE PAGES PROJECT, AND ON THE `plan-live` WORKER.** It is a
  plain (non-secret) comma-separated list of the hostnames Cloudflare Access actually protects, for
  example `plan.example.com,plan-x.pages.dev,*.plan-x.pages.dev` (an entry may start with `*.`).
  It is the allowlist `functions/porte.ts` and `worker.ts` compare the `Host` header against.
  **UNSET, IT IS A NO-OP**: every host is treated as the household door, which is exactly today's
  behaviour and is why the four suites that import the Functions directly keep passing. That
  compatibility default is also the trap: the day a hostname Access does NOT cover is added to the
  project, an unset variable means the door never closes. Set it BEFORE adding any hostname.
  Functions are bound to the PROJECT, not to a hostname, so `/api/plan`, `/api/plans`, `/api/err`
  and `/ws` answer on every hostname the project serves. See `docs/decisions/0004-partage-par-lien.md`.
- **`GUEST_HOST` is the ONE hostname of the guest door**, the one Access does NOT cover. Unset, the
  `"invite"` verdict can never occur and the guest door simply does not exist, which is the state
  the repository ships in. It is checked only AFTER the household allowlist misses, so a host named
  in both stays `"foyer"`: the door can only ever be loosened deliberately, never by a typo.
- **NEVER ADD `wrangler.toml` TO THIS REPOSITORY.** This project does not have one, and that is what
  keeps its bindings alive: `DB` (D1) and `ROOM` (the Durable Object namespace) are set ON THE Pages
  PROJECT, in the dashboard. As soon as a Pages project contains `wrangler.toml`, **that file becomes
  authoritative for bindings on every build**: the next deployment would delete both. The failure
  is hidden, it disguises itself: `env.ROOM` becomes `undefined`, `/ws` responds 503, and all clients
  fall back to REST **while appearing to work**. This is exactly what cost gazette2 an afternoon on
  05/08/2026 (playbook, `guides/temps-reel.md` §1.4). If a `wrangler.toml` ever becomes necessary
  here, it must declare `DB` and `ROOM` BEFORE it is committed, three times: at root level, under
  `[env.preview]`, and under `[env.production]`, because a named environment inherits nothing.
- **`_headers` (repo root) is a Cloudflare Pages response-header file, NOT a `wrangler.toml`**: it
  carries no binding and cannot touch `DB` or `ROOM`, the trap described just above does not apply
  to it. It serves a Content-Security-Policy (`default-src 'none'`, with the narrow allowances the
  client actually needs: `'unsafe-inline'` script/style for the single inlined `<script>`/`<style>`
  block `build.ts` produces, `data:`/`blob:` for the PNG export and the favicon, `connect-src 'self'
  wss:` for `/api/*` and the realtime socket), plus `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: no-referrer` (the invite token lives in the URL fragment and is never sent to a
  server, but a referrer header is one more thing that doesn't need to leak). No automated suite
  reads response headers: verify on a deployed preview, not in a test.

## Backend (shared floor plan, live sync)
- D1 `plan` (uuid `<d1_database_id>`, get your own from the Cloudflare dashboard), `plans` table with one `main` row
  (`data` JSON, increasing `rev`, `updated_at`, `updated_by`). Bound to the Pages project as `DB`
  (production + preview), configured through the REST API (no wrangler here).
- **Eight network entry points, not one more.** Five are HOUSEHOLD-ONLY; the other three exist
  because of the guest door, and `functions/_middleware.ts` decides which door may reach which
  route (`docs/decisions/0004-partage-par-lien.md`). **Each route also refuses an unrecognized door
  ITSELF**, it does not lean on that choke point: every direct-import test in this repository calls
  a route file with no middleware at all, and `live-worker/DEPLOY.md` §2 describes a zone route that
  would send `/ws*` straight to the Worker. Identity is the `Cf-Access-Authenticated-User-Email`
  header set by Access (fallback: the `Cf-Access-Jwt-Assertion` JWT payload, already verified
  upstream); otherwise, `inconnu`.

| Route | Method | Purpose | Contract |
| --- | --- | --- | --- |
| `/api/plan` | `GET` | Read the household floor plan. | `{data, rev, updatedAt, updatedBy}` · missing row = `{data:null, rev:0}` |
| `/api/plan` | `PUT` | Write the floor plan through FALLBACK (realtime down). | `{state, rev}` = compare-and-swap: **409** with the winning revision, author, AND state if the row moved. `{state}` alone = BLIND write, the old contract, kept for a tab opened before deployment. |
| `/api/err` | `POST` | Collect an uncaught client JS error in D1 for remote diagnosis. | HOUSEHOLD ONLY. Free-form body, response without useful content. **429** past 5 per hour and per author (the same rate limiter as `/api/feedback`, the same function: an error in a render path fires on every frame, and the retention sweep bounds only what is KEPT). |
| `/api/orphans` | `GET` | Read back the versions the LIVE plan set aside (a `conflict`). | HOUSEHOLD ONLY. Relays the Durable Object's `GET /orphans` → `{orphans:[{at, by, rev, data}], live}`. Unreachable object = `{orphans:[], live:false}`, never an error: it is asked while a conflict banner is already up. |
| `/api/feedback` | `POST` | A free-text note from inside the app, no account. | BOTH DOORS, deliberately: a visitor on a shared link must be able to report something too. **429** past 5 per hour and per IP. Who and which plan come from the DOOR, never from the body. |
| `/ws` | `GET` + `Upgrade` | Open the realtime wire. | Pass-through: adds `X-Plan-Email`, `X-Plan-Id`, `X-Plan-Guest`, `X-Plan-Name`, `X-Plan-Guest-Id`, `X-Plan-Token` and `X-Plan-Expires` (always SET, never conditionally, so a caller cannot forge them) and forwards to the `PlanRoom` Durable Object (binding `ROOM`). **426** without an `Upgrade` header. **403** off a recognized door, checked here as well as in the middleware. |
| `/api/invite` | `POST` | GUEST DOOR ONLY. Trade the link's `#k=` token for a session. | `{token, name?}` → `{planId, planName, role, name}` + an `HttpOnly; Secure; SameSite=Strict` cookie. Unknown, revoked, expired and deleted-plan all answer the SAME **404**, so a probe never learns it guessed a real token. |
| `/api/invites` | `GET` `POST` `DELETE` | HOUSEHOLD DOOR ONLY. Create, list and revoke a plan's links. | 20 live invites per plan max (**409**), revoke is idempotent (**200** even for an unknown token, same reason as the 404 above). |
- **`rev` IS THE LOCK, no longer mere information.** TWO writers write to the D1 row (the Durable
  Object snapshot, and the client PUT when realtime is down): blind PUT let two people in fallback
  silently overwrite each other (measured: two writes accepted, rev 3 then 5, the row retaining only
  the second person's work). The PUT therefore carries the revision **whose contents the client
  has**; the Function performs an ATOMIC compare-and-swap in ONE statement
  (`INSERT … ON CONFLICT(id) DO UPDATE … WHERE plans.rev=?4`, verdict read from `meta.changes`) and
  responds **409** with the winning revision, author, AND state. A PUT WITHOUT `rev` remains accepted:
  that is the old contract, for a tab opened before deployment. The Worker snapshot still always
  writes without an expected revision (its file has not yet been converted, see
  `docs/collab-etat-de-l-art.md`). Covered by `tests/repli-conflit.ts`.
- **A rejection is READ BACK, never rewritten** (js/41). The rejected version is set aside under
  `room-planner-v4-conflit` (the last 5), announced by a persistent banner with a
  "Recover my version" button (file reimportable through "Load a plan…"), and `Ctrl+Z`
  returns it to the screen; the winning state is adopted from the 409 body, without a second round
  trip. Until the household floor plan has been read again, no more PUTs leave: otherwise two devices
  would send the same write back and forth forever. **No sixth chip state**: the link works, the
  write was rejected, so "not saved" (with its own title) during the rejection, then back to
  "slow sync" as soon as it is read again.
- **This REST FALLBACK is the only safety net when the Worker goes down**: its PUT must accept BOTH
  forms (old `rooms[]`, walls-only `outline`/`walls`/`plan`). A guard that accepts only `rooms`
  rejects 100% of writes from the live model, the chip says "slow sync", and the two people
  silently diverge. Covered by `tests/repli-d1-live.ts`.
- **The synchronization chip must never lie.** States: `live ✓` (WS), `slow sync` (D1 fallback),
  `not saved` (reads work, WRITES do not), `offline`, `local` (detached tab). A successful
  GET probe does not prove that writing works: `putFailed` prevents the chip from repainting
  "slow sync" over a failed PUT.
- **NOTHING LEAVES until the first read has responded** (`bootReconciled`, js/41). The push is
  debounced by one second and did not wait for the boot GET: a change made early on a slow page
  published what that device thought it had. The lock is released by the FIRST successful read
  (`syncBoot` or `pollPull`), never by a failure: until the household floor plan has been seen, it
  must not be overwritten. Covered by `tests/plan-abime.ts`.
- **The first adoption of the server floor plan REFRAMES the view, later ones do not**
  (`adoptServerState`, js/41). A new device frames the default apartment (420×360) before the real
  floor plan arrives: without reframing it overflows the viewport. A later adoption arrives while
  someone is working and must never jump their view.
- Client: sync enabled only in top-level http(s) (plan.example.com); the claude.ai artifact remains
  localStorage-only. Push debounced ~1 s after the last change, poll ~4 s, remote application only
  while idle (and undoable with Ctrl+Z); state chip in the toolbar.

## The realtime wire: what must not be confused
- **`fp` is a CONTENT fingerprint; the counters no longer have the same name.** `hello`, the op
  echo, `state`, and `pong` carry `fp`: it is the ONLY identity to compare on this wire (adoption is
  decided from it). The two counters counted unrelated things under the SAME name, and comparing
  them produced permanent divergence with two screens showing "live ✓". The Durable Object now
  reports **`opCount`** (its own ops, informational, restarted from zero: it no longer reads D1's
  `rev`, which was the last place the two touched); the D1 row keeps **`rev`** (its own writes), read
  by `serverRev` (js/41), which drives the REST probe. The wire does not even read `opCount`.
- **A LOST OUTBOUND OP IS SENT AGAIN.** THE ECHO IS THE ACKNOWLEDGEMENT: it carries `tag` (the author
  device) and `n` (its number), so the author knows which one passed. The client maintains TWO send
  mirrors: `ws5` (optimistic, advances on send) and `ws5Ack` (acknowledged, advances only on what the
  server confirmed). Retransmitting means returning the optimistic mirror to the acknowledged one
  and diffing again: the CURRENT value is sent, never the stale intent of a dead op (because ARRIVAL
  order is the only arbiter, replaying a stale op after a newer one would make it win, which is why
  we do not follow Replicache's "exactly once" model literally; it assumes ordered BATCH sending).
  Two triggers: the server's `gap` message (one round trip) and a 2,5 s client-side guard timeout,
  essential because if the LAST op in a burst is lost, no later op reveals the gap. On reconnection,
  work still in flight is placed back over the adopted state (otherwise adoption silently erased it).
  The server deduplicates by `(tag, n)` over a sliding window of 64 numbers, IN MEMORY, never in
  storage: losing this table is harmless (ops are idempotent). Covered by `tests/collab-accuses.ts`.
  **The `pong` safety net did NOT cover this case**: it compares the fingerprint announced by the
  server with the previous one, but an outbound op lost on the way changes nothing on the server.
  It catches a missed INBOUND message, never a lost OUTBOUND op.
- **Added messages**: `state` (`reason:"sync"` or `"d1_adopt"`, the full state pushed back by the
  server), `conflict` (a write made outside realtime could not be merged, the live version was kept,
  the bytes are retained server-side), `sync` (us → server, without closing the socket). A
  `conflict` is NOT an op rejection: it does not go through `WS_ERR_MSG` and is not throttled.
- **THE TECHNICAL IDENTITY IS THE DEVICE, email is the HUMAN identity.** The household has two
  accounts, but ONE person has several devices (the computer on the table, the phone in the
  apartment) behind a single Access identity. The server already assigned one unique label per
  SOCKET (`freshTag`) but sent it only in `hello`; everything else was decided by
  `by === mon e-mail`. The same person's second device was therefore mistaken for SELF: its ops did
  not enter the replay log (ONE Ctrl+Z destroyed its work on both screens AND in the server floor
  plan, without a banner), and its dot, cursor, and ghosts did not appear. `tag` now accompanies
  `peer`, `op`, `cursor`, and `drag`; `wsPeers` and `wsCursors` are indexed by DEVICE. Rendering
  keeps the PERSON's name and color; my other device is distinguished by an outline
  (`.peer-dot.self`), the "your other device" tooltip, and the "Other device" cursor label.
  A server WITHOUT `tag` makes the client fall back to email, exactly as before. Covered by
  `tests/deux-appareils.ts`.
- **A REJECTION CANNOT LEAVE THE SCREEN LYING.** The client numbers its ops (`n`) and retains,
  before sending, the INVERSE op derived from the mirror; the server returns this number in its
  `err`. On rejection, the local change is UNDONE through the ordinary receive path, so local state
  and mirror return together to the server truth and the next diff sends nothing. Without a number
  (old server), the full state is requested again (`sync`). The chip remains `live ✓`: the link IS
  alive, this specific write was rejected. Measured before: 33 openings on one side, 33 on the other,
  not the same ones, 30 on the server, two "live ✓".
- **A created entity identifier carries a device tag**: `w20-a3f9c1`. A DERIVED entity (outline
  wall) keeps a bare id, otherwise the two floor plans would diverge. Details in `src/README.md`.
- **An op is a FIELD-BY-FIELD diff**; the server treats "missing field" as "no opinion". Every new
  receive path must therefore merge present keys, never replace the entity.
- **D1 is authoritative only when realtime is not authoritative.** `syncBoot()` starts with a REST
  GET; if the Durable Object `hello` arrives BEFORE the response, that response describes a floor
  plan up to 30 s behind (the D1 snapshot is driven by an alarm). Adopting it means replacing the
  current floor plan with a stale one AND then saving it. Measured: F5 restored the starting floor
  plan, 20 pieces of furniture lost, the chip showing "live ✓", without a word. `syncBoot` therefore
  returns immediately if `wsLive()`, while still releasing the `bootReconciled` lock (a read did
  succeed). `pollPull` and `doPut` already had this guard.
- **Bounds belong to the gesture's AUTHOR.** The person pushing a wall applies bounds once, on the
  FINAL geometry, and publishes the result. The receiver sees walls arrive ONE BY ONE: applying
  bounds after every op made the floor plan pass through every intermediate geometry and accumulate
  drift (up to 27 cm on 4 pieces of furniture, forever, for the person who touched nothing). The
  receive path (`js/43`) therefore recomputes cells, but calls NEITHER `v5ClampPieces` NOR
  `v5ClampOpenings`.
- **Nothing disappears from under the hand without a word.** Furniture deleted by the other person
  while it was selected (or being dragged) shows a banner: without it, it looks like a bug in one's
  own gesture.
- **An OUTLINE WALL cannot be deleted, no matter where the order comes from.** It is DERIVED from
  the outline: `v5SyncOutlineWalls` recreates it immediately, but its openings were lost for good
  (measured: 6 objects from one received op, saved as lost). The UI already rejected it (js/53); the
  remote path (js/43) and undo replay (js/27) obeyed it. One rule, `v5WallDeleteVerdict(P, id)`
  (js/52), with **three** verdicts: `facade` (rejection + banner), `ok` (interior wall, normal
  cascade), `absent` (silence: the ordinary case of a reduced outline, `outline.set` leaves before
  `wall.del`). The `isOutline` flag is only a cache: the verdict cross-checks it against the CURRENT
  outline GEOMETRY, otherwise a replayed snapshot retains a wall no longer carried by the outline.
  **The cascade arrives in two stages**: the diff emitter does not know the server cascade and sends
  `wall.del` THEN one `opening.del` per opening (1 + 6 measured); rejecting the wall without
  discarding the rest saves nothing, so spared openings are recorded and each is protected ONLY
  once (deleting a single window remains possible). A rejection does more than retain: the mirror
  follows the server, so the `save()` triggered just after **republishes** the wall and its openings,
  and a rejected op **does not enter the undo log** (otherwise the first Ctrl+Z would replay it).
  Divergence is resolved from ABOVE, by returning to the other person what they lost. Covered by
  `tests/collab-annuler.ts`.
- **Banners are throttled by TEXT**, not only by server error pattern (`js/24`): 22 banners in 371 s,
  including the same sentence 8 times, no longer informs anyone, it hides the next one. **But
  throttling applies ONLY TO SYSTEM MESSAGES.** A banner that RESPONDS to a deliberate gesture goes
  through `toast(msg, {geste:true})` and returns for EVERY gesture: someone who did not understand
  repeats the gesture, and that is exactly when silence is intolerable (measured:
  "That partition is already there." appeared only on the first of five attempts, while the next four
  failed without a word). The grouping unit is the GESTURE (`_gesteEpoch`, advanced by `pointerdown`
  and `keydown`), so a burst within the same gesture does not repeat, and a gesture message never
  accumulates "fatigue". Accepted tradeoff: repeating the same rejected gesture ten times produces
  ten banners. That is the price of always saying why a gesture had no effect.
- **Ctrl+Z undoes only its author's work.** History is a stack of past SHARED states: ops received
  from peers since a snapshot was taken are replayed over it during undo, and the undo is published
  by DIFF, never as `plan5.replace`. A `plan5.replace` received from a peer (import, conversion)
  clears history: no snapshot describes a past of this floor plan anymore. Covered by
  `tests/collab-annuler.ts`.
- Check without an account: the API is behind Access (curl → 302 login). The API token cannot create
  an Access service token (10000); check through the D1 row (REST query) after a real site visit.

## Input, bounds, and messages: what cannot be done must SAY SO
- **A numeric field goes through `numField(el, cfg)`** (`js/00`). It applies NOTHING while the value
  is invalid: impossible typing or a permanently out-of-bounds value = explicit REJECTION (the
  field returns to its last valid value, in red, with a message giving the bound); still-incomplete
  input (« 1 » before « 180 ») = nothing is applied and the field is marked pending; valid = applied
  after a short typing pause (220 ms), so typing « 3000 » does not commit 3, then 30, then 300 along
  the way. A test that sets a value programmatically must therefore wait ~350 ms, or trigger `blur`.
- **All bounds say the same thing**: `cfg.bounds()` rewrites the field's `min`/`max` attributes, and
  the applied value respects the SAME bound, itself compatible with the server validator. **The
  server bounds the DANGEROUS, the client bounds the REASONABLE**: the client bound may therefore be
  stricter, never wider. The validator (`live-worker/ops.ts`) is the reference, and every op outside
  it is rejected with its number, then undone on screen (never swallowed):

| Bound (`live-worker/ops.ts`) | Value | Applies to | Why this one |
| --- | --- | --- | --- |
| `WALL_T_MIN` / `WALL_T_MAX` | 1 … 60 cm | wall thickness | physical range from a partition to a load-bearing wall |
| `OPENING_W_MIN` / `OPENING_W_MAX` | 1 … 600 cm | opening width | a 6 m bay is already generous |
| `OPENING_H_MIN` / `OPENING_H_MAX` | 1 … 200 cm | opening DEPTH (top view, not ceiling height) | copies the client clamp (`sanitizeV5Plan`); any tighter would reject legitimate values, and a wrongly rejected op silently removes a change. The client ADDITIONALLY bounds it by the load-bearing wall thickness. |
| `PIECE_WH_MIN` / `PIECE_WH_MAX` | 1 … 3000 cm | furniture width / depth | the client tightens it to the HOME's largest side |
| `NAME_MAX` | 80 | `piece.name`, `opening.name`, `cell.name`, `room.name`, `room.floor`, `envelope.floor` | the field physically rejects the 81st keystroke |
| `THROW_RATIO_MIN` / `THROW_RATIO_MAX` | 10 … 1000 (ratio × 100) | projector throw ratio | covers ratios from 0.10 to 10.0 |
| `THROW_DMIN_MIN` / `THROW_DMIN_MAX` | 0 … 2000 cm | projector minimum focus distance | zero means not provided; 20 m catches a typo without rejecting a home |
| `OPENING_LEAVES` | 0, 1, 2 | window leaf count | only the three rendered opening shapes are accepted |
| `CELL_FLOORS` | `parquet`, `herringbone`, `tile`, `plain` | computed-cell floor | mirrors the client floor catalogue |
| `GUEST_NAME_MAX` | 40 | guest display name | bounds untrusted identity text sent to peers |
| `CURSOR_SAY_MAX` | 140 | cursor chat bubble | **server-side only since decision 0015**: no client build opens the bubble or emits `say` any more, but the field is still accepted (a tab left open on an older build can still send it) and still bounded |
| `SWING_MAX` | 80 | `swing` (opening direction) | without it, `swing` accepted a 5 MB string |
| `COORD_MAX` | 100 000 cm | every coordinate | 1 km = thirty times the largest plausible dimension (the real floor plan fits within 1418 cm): nothing legitimate is rejected, `1e308` is |
| `POLY_MAX_PTS` | 2000 | polygon vertices | the real floor plan peaks at 11 |
| `MAX_ENTITIES` | 2000 | entities per family (walls / openings / furniture / cells / rooms) | the real floor plan fits within 22 / 30 / 47 / 10; also bounds snapshot size |
| `TYPE_RE` | `^[a-z0-9_-]{1,32}$` | furniture `type` | enforce the SHAPE, not the list of 41 types: otherwise a catalog addition would require redeploying the Worker, and every placement of the new item would be rejected and silently lost |
| `ID_RE` | `^[A-Za-z0-9_.:-]{1,80}$` | entity identifier | an id is injected back into `data-id="…"` and a CSS selector: allowing a quote there is a vulnerability |
- **An opening's DEPTH is bounded by ITS WALL'S THICKNESS** (`v5OpeningDepthMax`, js/52; the field
  goes through `dimBounds`, js/21). `h` is the object's thickness INSIDE the wall and the box is
  centered on the centerline (`v5OpeningBox`, js/50), but an opening REPAINTS the background over
  the floor: an `h` larger than the wall cuts a white hole that extends on both sides, through both
  rooms (measured: 200 cm on a 10 cm wall, silently accepted, 455 px of white across the floor plan).
  The rule applies to all three paths that WRITE during a gesture: the field (stated rejection, with
  the wall thickness), placement and paste (catalog depth follows the wall), and load-bearing wall
  change (depth follows DOWN, never up, and this is stated on release). It does NOT apply on read
  (`sanitizeV5Plan`, js/02) or when receiving an op (js/43): do not silently adjust someone else's
  saved floor plan. Recorded on 2026-08-04 from the production floor plan (rev 268) and the pre-switch
  backup: 0 openings beyond their wall, all thicknesses are 12 cm. Covered by
  `tests/garde-fous.ts` (`profondeur_bornee_par_le_mur`).
- **`[hidden]{display:none!important}`** (`css/01`). The browser stylesheet has zero specificity:
  the smallest class rule (`.dims{display:grid}`) repainted a block that was meant to be hidden.
  Never "fix" this kind of case with one more `.x[hidden]{display:none}`.
- **Rejected local write** (private browsing, zero quota): `save()` no longer swallows it, it shows
  the `#storeChip` chip for as long as it lasts, plus a message. **Unreadable local floor plan**:
  `#bootNotice` banner (persistent) + banner in the wizard, with the set-aside blob downloadable.
- **An area is written with `fmtM2()`** (`js/00`), one decimal and a comma, never uppercase: the
  toolbar, rail chip, room sheet, and wizard preview display the SAME number in the SAME way.
- **The two floating panels are STACKED** in `.side-panels` (`html/04` → `html/05`), never anchored
  to the same corner: they can no longer overlap. The `.side-spacer` spacer pushes them downward and
  collapses when they no longer fit; on a short screen they sit side by side (`css/17`).
- **The rail footer is `position:sticky`**: the "File" menu is the only access to Undo, Redo, Save
  to file, Open from file, Furniture list, Export as PNG, Print / PDF, Remove all furniture, and
  Feedback (decision 0015); it must never end up at the bottom of a 3 000 px rail.
- **A resize that breaks framing reframes** (`js/46`): compare the current transform against the OLD
  viewport size (stored), so reframing happens only if the floor plan fit before and no longer fits
  afterward. The view of someone who deliberately moved closer stays intact.

## Design
- Custom "warm paper" design specific to the app (tokens in the <style>: #e9eae7 background,
  #1f6f78 petrol accent, mono + tabular-nums for every measurement). Not one of the two global
  design systems, but in the same family.
- **NO NAME WRITTEN ON A WALL-MOUNTED OBJECT** (door, sliding door, window, wall light, outlet,
  RJ45): the icon is unambiguous, the label only added clutter (measured on the real floor plan:
  four labels stacked on an outline wall, three « Applique » side by side on one wall). The name
  REMAINS in the model (sheet, furniture list, export, network wire): a display was removed, not
  data. An opening's dimension was already not displayed on the floor plan; it is read where it is
  changed (sheet field, live `#rszReadout` dimension while dragging a handle).
  "Show names & sizes" therefore controls FURNITURE. Details: `src/README.md` 22bis.
- **AND ON FURNITURE, ONLY A CHOSEN NAME IS WRITTEN.** Furniture is created with its type label
  (`mk` → `autoName`, js/07), sometimes numbered: « Table 2 », « Plan de travail 3 »,
  « Lit (160) 2 ». That says nothing the icon does not. A TYPED name (« Homu », « Ikea ») exists
  nowhere else on the floor plan. `isChosenName` (js/12) compares the name base with the type's
  CURRENT label **and its HISTORICAL labels** (`LEGACY_TYPE_NAMES`, js/01): the application started
  in English, and without this table the « Chair » / « Table » / « Coffee table » entries in a
  pre-translation floor plan looked like chosen names (measured at working zoom on the household
  floor plan: four « Chair » labels surrounding a table carrying a fifth). The name remains in the
  model. Measured on the real floor plan: 8 labels → 2, and 3 → 2 on the sheet. A label is also
  BOUNDED to the space available in its thumbnail (short ellipsis allowed, silence beyond): it can
  no longer run across the floor plan. **And the printed sheet / PNG carry the SAME names** (js/32),
  where they previously had only the title and room names. Details: `src/README.md` 22ter.
- **RENAMING A CATALOG ENTRY WITHOUT PUTTING THE OLD LABEL IN `LEGACY_TYPE_NAMES` MAKES THE NAME OF
  EVERY EXISTING PIECE OF FURNITURE REAPPEAR**, at once, on every floor plan. The table has two
  waves: the 5 original ENGLISH labels (observed in floor plans, carried by no commit) and the 40
  FRENCH labels removed on 2026-08-05 when the interface switched back to English.
  `tests/rapide.ts` (`rapide_ancien_libelle_anglais_ne_s_ecrit_pas`) sweeps the entire table: it
  sees an EXTRA entry, never a MISSING entry.
- **THE PALETTE GROUPS BY ROOM OF USE, NOT BY OBJECT FAMILY.** Five sections, in the order items are
  actually placed (counted on the household floor plan, 77 objects): **Openings & fixtures** (39,
  everything fixed to the building: doors, windows, outlets, RJ45, radiators, FIXED lighting,
  duct), **Living & dining** (13), **Bedroom** (9), **Bathroom** (9), **Kitchen** (7). The criterion
  is not the nature of the object, but where one goes to find it: nine sections, including two with
  only two objects, put a BED in « Déco », a RADIATOR in « Structure », a CHAIR in « Tables », and
  split wall-mounted objects in two (wall light on one side, outlet on the other).
  **And regrouping repaints nothing**: `color` belongs to the ITEM (its nature), no longer to the
  group, otherwise moving an object from one section to another would change its color in every
  saved floor plan. A batch that reorganizes sections never touches `color`.
- **A FURNITURE NAME IS ALWAYS HORIZONTAL**, on screen and on the sheet. We tried the drafting
  software convention (text FOLLOWS the tilted object, folded into the readable semicircle): it was
  rejected on the real floor plan, with « Table » written vertically across the dining area and
  unreadable at a glance. `setLabelSpin` (js/00) therefore CANCELS inherited rotation, with no special
  cases; `readableAngle`/`labelSpin` no longer had consumers and were removed. Verified across 24
  orientations by `tests/textes-lisibles.ts` (measured angle = 0 everywhere, screen + PNG + print).

## Gestures: ONE exit point
- Every gesture (drag furniture, rotate, resize, drag a wall / vertex / edge / opening,
  pan, rubber band) is armed through **`armGesture(finish[, onUp])`**
  (`src/ts/gestes/sortie.ts`) and NEVER listens for `pointerup` itself. The shared exit attaches the
  finish to `pointerup`, `pointercancel`, `lostpointercapture`, **window focus loss**, and a
  **watchdog** (8 s without movement or typing). `save()` forces a stale gesture to exit before
  deciding not to write.
- Why: `gestureActive` makes `save()` return immediately. A gesture that never ended made the
  application **mute** (no local write, no send, no op) and lost ALL session work on reload, without
  a message. Covered by `tests/interactions.ts`.
- The **VIEW is not the floor plan**: pan, zoom, pinch, "Fit", and window resizing go through
  **`renderView()`**, which repaints without persisting anything (before: 40 serializations and
  854 KB written for one pan). Never call `render()` for a simple `vScale`/`vOx`/`vOy` change.
- A complete floor plan replacement received **during** a gesture (`plan5.replace`, pull adoption)
  is **queued** (`gQueuedOp`/`gQueuedState`) and applied at the end of the gesture, never discarded;
  a remote op never reframes the view (`v5SetModel(p,{keepView:true})`).

## THE FLOOR FOLLOWS THE HAND, AND NO ROOM NAME IS LOST ON THE WAY
Owner's report: "when i move a facade the ground underneath lags behind significantly". The walls
followed the hand frame by frame, but the FLOOR is painted from the CELLS (`renderFond`), and
`v5ResoudreGeometrie` rebuilt the cells only on release (`if (final)`). Measured on the real floor
plan (22 walls, 10 cells), a facade pushed from 1090 to 1320 cm: the model followed live (60 fps
held), the painted surface stayed at g=1098 d=1269 through all 20 steps, then JUMPED to g=659
d=1089 on release. `v5RebuildCells` costs **0,40 ms median** (0,7 ms p90, 1,6 ms worst) against a
16,7 ms frame budget in which a full `render()` already costs 2,3 ms: the guard paid for nothing.
Cells are therefore rebuilt on EVERY frame of every geometry gesture (facade, partition, outline
vertex). Measured again after: work per frame 3,5 ms median before, 4,7 ms after, three paired runs.
- **BUT NAMES ARE MATCHED FROM A PHOTO OF THE CELLS TAKEN BEFORE THE GESTURE**
  (`src/ts/modele/photo-cellules.ts`), never from the previous frame. A name and a floor are NOT
  derived: they survive recomputation through area matching. Rebuilding every frame makes the plan
  cross every INTERMEDIATE state, and a wall sweeping across a room merges it with its neighbour;
  the merge keeps ONE name of the two, so a typed name is gone for good even though the geometry
  comes back exactly where it was. Same reasoning as "bounds belong to the gesture's AUTHOR": apply
  once, from the state before the gesture, because passing through every intermediate state
  accumulates permanent drift. The photo is taken by `beginGesture`/`armGesture` and released by
  `endGesture` (the ONE entry and exit of a gesture), and it is tied to its plan object, so a plan
  replacement mid-gesture can never inherit another plan's names.
- **AND AN INTERMEDIATE FRAME CLEANS UP NOTHING** (`enDirect`, `OptionsRecalcul`): no
  `v5DedupeWalls` while dragging. A partition pushed onto another one overlaps it exactly for a few
  frames, and deduplication DELETES a wall and re-homes its openings. Furniture bounding stays on
  the final geometry too, for the reason above.
- Covered by `tests/sol-suit-la-main-geste.ts` (real mouse). Both negative controls exist and they
  are NOT the same: the floor case goes red without the per-frame rebuild; the name case goes red
  with the per-frame rebuild but WITHOUT the photo ("Chambre d'Elise" comes back as "Room 2").

## Looking changes nothing, and repeating gives the same result
Four rules born from a real-use session where a simple click rewrote the floor plan.
- **SELECTING NEVER WRITES.** An outline gesture (`v5StartOutlineEdgeDrag`, js/53) pushes history and
  calls `v5AfterGeometry(true)` **only if the pointer moved**. A clean click on an outline wall only
  selects it. The corner-insertion "+" is **offset 18 px OUTSIDE the outline** (`v5OutlineOutward`,
  js/53 + js/54): on the outline wall it stole the click, and its global recomputation split the
  wall in two and moved 16 pieces of furniture.
- **NO MASS RENORMALIZATION.** `v5ClampPieces()` (js/52) adjusts ONLY ORPHAN furniture (center in
  no cell) and announces it, once. `v5ClampPiece` remains for the paths that place furniture with no
  hand on it (the keyboard, the inspector, the Circulation fixes); a GESTURE never calls it.
- **NOTHING PUSHES FURNITURE BACK** (decision 0011). A piece may straddle a wall: dragging, dropping
  and resizing bound nothing. What places it is a MAGNET, and Alt suspends every one of them for the
  length of one gesture. Circulation reports the overlap; the gesture does not prevent it.
- **A ROUND TRIP RETURNS TO THE STARTING POINT.** There is no grid: the corner is
  `Math.round(pointer − grab)`, rounded ONCE, and every magnet is a pure function of that position,
  so the same hand position always gives back the same placement.
- **AN OBJECT HIDDEN UNDER ANOTHER REMAINS REACHABLE.** Clicking the same spot again moves down one
  step in the stack (`pickStacked`, js/12, shared with openings from js/54), and says so.
Covered by `tests/gestes-usage-reel.ts` (9 tests, real mouse).

## THE WALL IS A TOOL, THE FLOOR IS A LASSO
Decision [0010](docs/decisions/0010-le-mur-est-un-outil-le-sol-un-lasso.md), which reverses PR #25
("wall mode no longer exists"). Read this section before touching `gestes/murs.ts`,
`gestes/outil-mur.ts` or `rendu/calque.ts`'s `drawHandles`.

- **The wall is drawn with an ARMED TOOL, click by click.** The toolbar button (`btnDrawWall`) or
  **W** arms it, `aria-pressed` follows, the layer wears a crosshair. A click lays the start, the
  segment follows the pointer with its length shown next to it, and the next click closes that
  segment AND starts the following one. **Double-click, Enter or Escape** ends the run; the tool
  stays armed for the next one, and a further **Escape** puts it away and says so.
- **Digits then Enter** place the arrival at that exact length in the direction aimed at, the same
  grammar the resize readout already uses (`#rszReadout`, reused, not reinvented).
- **The magnets are on by default and ONE key cuts them.** A junction wins (another wall's end, an
  outline corner, a point on a wall's face, `v5SnapWallEnd` through `v5WallEndDrop`), otherwise the
  direction quantises to 45° from the chain's start. **Shift** narrows that to the two axes,
  **Alt** cuts every magnet while held.
- **The chain's grammar is PURE** and lives in `src/ts/gestes/outil-mur.ts` (`outilMurPoint`,
  `outilMurFin`, `outilMurALongueur`), tested without a browser in `tests/rapide.ts`. Where a point
  LANDS needs the plan, so it stays in `gestes/murs.ts`. Do not merge the two back together: the
  reason the old shape was untestable is that its rule lived inside a `pointerdown` closure.
- **Dragging over empty space is a LASSO**, as in every comparable planner, and it draws nothing.
  Shift or Ctrl/Cmd make it ADD to the selection. Right button and Space+drag still pan.
- **A wall carries NO button on hover**: a light highlight (`.v5band.survol`) and the pointer cursor,
  nothing more. That absence is the point of the whole batch: the seven pull requests of 32 px
  boxes, tiers and anti-theft rules existed only to arbitrate between buttons that appeared under a
  moving hand.
- **Pressing a wall SELECTS it, and the same press moves it.** The hit test is GEOMETRIC
  (`murSousLePointeur`, `rendu/calque.ts`), never a transparent DOM band: a band would join the
  hit-test stack and cover the furniture painted above the wall. G-3's 3 px threshold keeps a clean
  click from writing anything.
- **A selected wall carries THREE controls at most**: a move disc at its middle and one handle per
  FREE end (`v5BoutJoint` removes an end that a junction already holds). A facade carries only the
  disc: its ends are the outline's corners, which already have their own `.vtx` at the same pixel.
- **Split, Square up and Delete are COMMANDS, so they live in the wall's sheet**
  (`#rcSplit`, `#rcSquare`, `#rcDel`, `src/html/05-fiche-piece.html`), next to Length. Only what has
  to be DRAGGED stays on the plan, because dragging is the one thing a sheet cannot do.
- Covered by `tests/outil-mur-geste.ts` (browser) and by the four pure cases of `tests/rapide.ts`.

## A WALL GOES FROM ONE POINT TO ANOTHER POINT
Decision [0012](docs/decisions/0012-un-mur-va-d-un-point-a-un-point.md), which reverses the
through-running wall, the `free` flag it needed, decision 0009's recess magnet, and the 5 cm grid
for walls and openings. Read it before touching `modele/edition.ts` or `gestes/murs.ts`.

- **Nothing lengthens on its own.** A wall ends where the hand put it. `v5BornerAuLogement`
  (`modele/edition.ts`) is all that is left of the old `v5ThroughWall`: it TRIMS an endpoint that
  has left the outline and does nothing else. `v5ResoudreGeometrie` calls it on every interior wall
  at every frame, exactly as before, and now that call moves nothing that was already inside.
- **The junction is what connects, and it is made by the MAGNET at drop time** (`v5SnapWallEnd`
  through `v5WallEndDrop`), never by a wall running into another one. A wall that touches another
  one within 2 cm is joined to it, and its end follows when that wall is pushed (the followers of
  decision 0005, unchanged, plus the bridge of 0007 for the junction that would otherwise tear).
- **There is no `free` field any more.** It marked "this one must not stretch"; nothing stretches,
  so it describes nothing. `sanitizeV5Plan` READS it and drops it, `v5WallWire` never emits it, the
  sheet's Through / Free pair is gone, and the server (`WALL_KEYS`, `live-worker/ops.ts`) still
  accepts it so a tab running the old code is never refused.
- **No grid, for walls or openings either** (decision 0011 did furniture). A wall, a facade, an
  outline corner and an opening all move at the CENTIMETRE. `Alt` suspends the magnets, `Shift`
  constrains; the `sansGrille` (Ctrl/Cmd) modifier and the `snap` setting are both gone, the
  setting read from an old save and dropped by `cleanOpts`.
- **A typed Length stretches the FREE end** (`v5BoutLibre`), `b` when both are free. Held at both
  ends, the field is DISABLED and the sheet says why: picking a junction to tear would be worse
  than refusing.
- Covered without a browser by `tests/rapide.ts` (five cases) and `tests/bouts-de-mur.ts`.

## Pushing a wall: A FOLLOWER NEVER TILTS
Two rules, decided ONCE at `pointerdown` (`v5WallDragCtx`) and never re-evaluated during the
gesture. **A follower never tilts**: it keeps its own direction, so its touching point either slides
ALONG that direction to the intersection with the dragged wall's new line, or it does not move at
all. And **a follower moves only if it would be left dangling**: if that point still touches another
wall (its end or its flank) or the outline once the dragged wall has left, it is already held and
stays EXACTLY where it is. Rule 2 is evaluated first, and decides whether rule 1 applies at all.

Accepted loss: a COLLINEAR follower with nothing else holding it DETACHES instead of following. A
visible gap is honest and undoable; a diagonal wall looks like a normal room until someone measures
it. Both owner reports that led here, the reasoning, and what was rejected (the parametric carry of
PR #17, and intersection alone) are in `docs/decisions/0005-un-suiveur-ne-bascule-jamais.md`.
Covered by `tests/jonction-glisser-mur.ts`, whose `aucun_mur_ne_bascule_jamais` sweeps EVERY wall of
EVERY case in the suite for a direction change: that is the invariant, not one example of it.

## A CROOKED WALL IS SQUARED UP BY A BUTTON, NEVER BY A MAGNET AND NEVER IN SILENCE
Owner's report: "the vertical wall on the right is slightly off, i want a way to make it
perpendicular", then "automatically", then "it should snap". Measured on the real floor plan
(22 walls): two walls are neither horizontal nor vertical, `w3` (154 cm, 0,373°) and `w7` (146 cm,
0,392°), each missing square by 1 cm at its far end. Invisible in the numbers, visible to the eye
because the wall is no longer parallel to its neighbours.

**A MAGNET COULD NOT HAVE HELPED THOSE TWO, AND THAT IS THE WHOLE POINT.** Their four ends are
JUNCTIONS, so `v5BoutJoint` removes every endpoint handle (deliberate, from `771bab5`: pulling an
end that something already holds would tear the junction open). Selected, they carry only the disc
that MOVES them, and a translation cannot change a direction. No gesture of theirs could fix it, so
no magnet hung on a gesture had anything to bite. And the three gestures that DO fix a direction
are already square: the wall tool quantises to 45° from the chain's start, an endpoint drag does the
same from the fixed end (`v5WallEndDrop`/`DIR8`), the outline vertex has `orthoSnapVertex`. What was
missing was not a fourth magnet, it was a COMMAND.

**THE RULE**: **Square up**, a button of the WALL'S SHEET that exists ONLY on a crooked wall
(`v5MurDeTravers`, `modele/edition.ts`) and squares it up on a click. A control that appears and
then refuses teaches nothing; one that is simply absent says "not here" without a word. And unlike
a magnet, **it takes away no angle at all**: a deliberate oblique stays exactly as reachable, it
merely carries no button.

- **Three thresholds, each answering one question.** Beyond **2°** the oblique is a CHOICE (a
  chamfered corner is at 45°, twenty times further out). Under **0,5 cm** of end displacement there
  is nothing to see: without that floor, `w2` (0,003°, i.e. 0,1 mm over 164 cm) would carry the
  button too. And the displacement is capped by **the wall's own thickness**: correcting by less
  than the masonry is a correction, beyond that it is a redesign, and that does not fire from a
  small disc. Measured: 3 of 22 walls are not square, 2 are visibly so, and at 1° a 12 m wall is
  refused (21 cm) while a 3 m wall is offered (5,2 cm).
- **We pivot around the CROSSROADS, never around a simple rest.** Both ends are held, so one has to
  move; the one that stays is the one where the MOST other wall ENDS coincide, because that is the
  junction that would tear. Measured on `w3`: end `a` carries the ends of `w2` and `w7` (the middle
  T), end `b` only `w4`, so `b` is the one that slides by 1 cm.
- **Nothing is frozen afterwards, and nothing runs away** (decision 0012). The correction used to
  need a `free` flag on the spot: the end just moved by 1 cm stopped touching, for one frame, the
  wall that was waiting for it, and the through rule then sent it to the facade (measured: `w3`
  went from 154 cm to 716 cm, in silence). No wall runs, so there is nothing to freeze and nothing
  to announce beyond the two figures. The counterpart, accepted: the wall ACROSS from it does not
  come along by itself either, it is pushed or its end is pulled.
- **NOTHING IS SQUARED UP IN SILENCE, AND NOTHING IN BULK.** No pass at load, none inside
  `v5ThroughWall`: this is the "NO MASS RENORMALIZATION" rule below, born from a click that rewrote
  the floor plan. The correction is a consequence of a DELIBERATE gesture on THAT wall, and it is
  announced with both figures (`toast({geste:true})`), because a 1 cm move is indistinguishable
  from a click that did nothing.
- Facades are out of scope: a facade is DERIVED from the outline, squaring it up would mean moving a
  polygon vertex, which is the vertex's gesture and not this wall's.
- The three thresholds are covered without a browser by the model's own suites; the sheet button
  itself is covered by `tests/outil-mur-geste.ts` (it stays hidden on a wall that is already
  square). The measurements above were taken with `tests/mur-droit-geste.ts`, removed with the
  hover controls it was written against (decision 0010).
- Squaring up no longer stretches anything, in either direction (decision 0012).

## A click lands on what is visible, and repeating gives EXACTLY the same number
Four rules born from a second real-use session (1 500 gestures, real floor plan then 300 objects).
Covered by `tests/gestes-precision.ts` (7 tests, real mouse).
- **PAINT FROM LARGEST TO SMALLEST** (`renderPieces`, js/12). Paint order followed ARRAY order: a
  6 m² rug added after an armchair covered it completely and made it impossible to grab. Measured
  with 300 objects: 20 gestures out of 30 moved furniture other than the target. Paint rank is also
  written in `data-paint`, and THAT is what `stackedAt` sorts: `elementsFromPoint` returns real order,
  while `.piece.sel` raises the selected item to `z-index:50`, so the stack reordered on every click
  and the cycle restarted from zero (twelve clicks on five objects reached only two).
- **PRESS TAKES WHAT IS SELECTED, A COMPLETED CLICK MOVES DOWN ONE STEP.** Two separate things
  (`pickStacked`, js/12). Moving down on `pointerdown` made the object just reached IMPOSSIBLE TO
  MOVE: the next drag, starting from the same pixel, picked the next item in the stack. The next step
  is therefore chosen on release, only if the pointer did not move.
- **ROUND THE CORNER, ONCE** (`gestes/meuble.ts`). The CENTER was rounded and the corner derived
  from it: with an ODD width (a 45 cm chair), the center falls on a half centimeter and `Math.round`
  rounds upward, so every round trip gained 1 cm forever. Same requirement for alignment snapping
  (`alignSnap`, gestes/guides.ts): the delta is TRUNCATED TOWARD ZERO, otherwise it overshot the
  target line and the object oscillated indefinitely by ±2 cm.
- **THE MAGNET PLACES FURNITURE, NO RULE HOLDS IT BACK** (`meubleWallSnap`, modele/espace.ts;
  decision 0011). Every non-wall-mounted piece whose BACK comes within `wallSnapReach` of a wall
  snaps to it, back flush against the face, oriented with the wall. The reach is read on the back,
  not the center: a 200 cm deep bed flush against a wall has its center a metre away from it. Out
  of reach, the piece stays exactly where the hand put it, wall or no wall. **Alt held suspends
  every magnet** (wall, alignment, chair-to-table) for the length of the gesture, and it is the only
  modifier a furniture drag understands: there is no grid, no fine mode, no no-grid key.
- **A PRESS-RELEASE WITHOUT MOVEMENT NEVER WRITES, ANYWHERE.** The rule applied to the outline wall;
  it now applies to the outline VERTEX (`v5StartVertexDrag`, js/53: a click on the top-left corner
  extended a partition 90 cm three meters away, split a room in two, and moved a radiator 114 cm),
  to the partition (`v5StartWallDrag`), opening (`v5StartOpeningDrag`), and furniture (js/17: bounds
  ran on every release, even motionless, and shifted furniture already flush with the wall by 11 cm).
  `pushHistory()` is no longer pushed on `pointerdown`, only on the first real movement. No
  exception any more: Alt+drag never duplicated (decision 0011 rejected that reading of Alt, it
  only ever suspends magnets), and Duplicate (the button, or `Ctrl+D`, decision 0013) is its own
  gesture, not a drag.
- **ESC PUTS THE WALL TOOL AWAY, AND SAYS SO.** Without a word, the result is indistinguishable
  from a failure: no wall can be selected by clicking. A real session clicked 16 walls in a row with
  no effect and the incident was classified as « non reproductible ». The first Esc ends the run
  being drawn, the second one disarms the tool and states it (`toast({geste:true})`).

## ONE ACTION, ONE PATH
Decision [0013](docs/decisions/0013-une-action-un-chemin.md). Placing, rotating, renaming and
duplicating a piece of furniture used to each have two or three competing gestures, with their own
raccourci; the cost was not the code, it was the ten sections of help it took to explain them, and
the doubt about which one was "the real one". Each of those actions now keeps ONE path:
- **Placing**: drag from the palette with a mouse; on a finger, tap the thumbnail then tap the
  plan. A MOUSE click on a thumbnail no longer arms anything (`gestes/pose.ts`, gated by
  `isTouchEvt`); `Enter`/`Space` on a focused thumbnail still arms it, for the keyboard. `Enter`
  placing at the center of the view (`poserAuCentre`) is gone with it.
- **Rotating**: the handle on the selection (`.rot-handle`, `angleVersPointeur` in
  `gestes/guides.ts`, PURE, proven in `tests/rapide.ts` without a browser) or "Rotate 90°". The
  angle slider and its readout are gone from the inspector, and so is the double-click that used to
  rotate a piece (or flip a door's leaf) everywhere except its label. **R keeps ONE meaning**:
  flipping a wall light / outlet / RJ45 to the other face; it no longer rotates free furniture.
- **Renaming**: a double-click on the object's own label (meuble, cell, plan), landing the field
  ON the label (`panneaux/renommer-en-ligne.ts`). The inspector's Name field is gone. An OPENING
  has neither a label to double-click (R-2, no name is painted on it) nor a Name field any more: it
  keeps whatever name it already carries, it just can no longer be retyped from the interface.
- **Duplicating**: the inspector's Duplicate button and `Ctrl+D`, ONE function
  (`dupliquerSelection`, `gestes/selection-actions.ts`) behind both.
- **Multi-selecting by click**: `Shift`+click toggles a piece in or out of the selection (was
  `Ctrl`/`Cmd`; Ctrl means nothing left in this app, decision 0011 already retired it mid-drag).
- **Dimensions**: shown ON the selection, for a piece of furniture (`showDim`, `rendu/meubles.ts`)
  AND for a wall (its length and its two clearances, `drawWallGuides`, `gestes/guides.ts`, wired
  from `gestes/murs.ts`'s `apresRendu` hook), and through every gesture that moves or resizes
  either. **The `D` key is gone entirely** (decision 0015, finishing decision 0013): both halves
  used to show a size while held, furniture first, then the wall; neither needs a key held down
  any more, both show at selection like everything else in the app.
- **Paint order**: automatic, largest to smallest (G-9 above). "Bring to front" is gone, not
  hidden on some object kind, gone.
- **Even spacing**: gone entirely (decision 0015, reversing 0013's own deferral). The pure
  computation (`modele/repartir.ts`) and its test never gained a caller after 0013 kept them
  "unattached, ready to be rebranched"; a lot that finds nothing pointing at a file removes the
  file, it does not keep guessing a future for it.
- **NOTHING PUSHES A MEUBLE ANY MORE, FROM ANY PATH** (completing decision 0011): the arrow keys
  (`gestes/clavier.ts`) and the inspector's Width/Depth fields (`panneaux/inspecteur.ts`) no longer
  call `v5ClampPiece`. Only `circulation/correctifs.ts` (an explicit repair, on request) and the
  orphan pass at load (`v5ClampPieces`, once, never mid-gesture) still bound a piece of furniture.

## SEVEN BUTTONS, AND THE BUBBLE THAT NEVER SPEAKS AGAIN
Decision [0015](docs/decisions/0015-sept-boutons-et-des-curseurs.md), lot 6 of
`docs/simplification-2026-09-02.md`, closing the series that started at decision 0010.
- **The toolbar carries exactly seven buttons, in this order**: Menu (☰), Wall (`btnDrawWall`),
  Measure, Fit, Circulation (`btnFlow`), Invite, Help. The state chips (scale, area, sync, peers)
  stay chips, never buttons. Everything else that used to sit in the bar left it for the File
  menu or the keyboard.
- **Undo and Redo left the bar.** `Ctrl+Z` / `Ctrl+Y` (`gestes/clavier.ts`) are unchanged; the two
  buttons are gone, and two entries now sit at the TOP of the File menu instead, each showing its
  shortcut on the right (`.fm-key`). There is no more disabled-state tracking on them:
  `undo()`/`redo()` already no-op on an empty stack, and a menu entry that sometimes does nothing
  needs no separate bookkeeping to say so up front.
- **The "Show circulation" overlay button is gone: it is now a STATE of the Circulation button.**
  One click opens the panel AND paints the shaded floor together; a second click closes both.
  `Options.overlay` is gone from the client (same treatment as `snap` before it, decision
  0011/0012: an old saved value is read and dropped, `cleanOpts`, never written back); every place
  that read `opts.overlay` now reads `opts.flow`.
- **Feedback (✉) left the bar for the File menu**, last entry, plain text instead of an icon
  (`#btnFeedback` keeps its id, only its parent changed): it is reached often enough to deserve a
  menu line, not often enough to deserve a permanent icon next to Circulation.
- **The cursor-say bubble ("/", FigJam-style) is gone entirely.** `fil/dire.ts` (the floating box),
  its keyboard shortcut, its CSS (`.say-box`, `.pc-say`), and the code that painted a peer's live
  text next to their cursor are all removed; the outgoing `cursor` message no longer carries a
  `say` field. **The server is untouched**: `live-worker/ops.ts` still accepts and bounds `say`
  (`CURSOR_SAY_MAX`), because a tab left open on an older build can still send it, and a live
  server must never reject a client it doesn't control. Cursors and presence themselves are
  unchanged; the chat panel (💬) is unchanged, still collapsed by default.
- **The wall D-held dimensions are gone with the key** (see "ONE ACTION, ONE PATH" above): a
  selected wall shows its length and clearances the same way a selected piece of furniture shows
  its size, no key required.

## Traps
- No `wrangler` on this machine (win32-arm64): every Cloudflare API operation goes through REST
  with `CLOUDFLARE_API_TOKEN` (see `~/projects/.secrets.env`).
- The file must remain CSP-safe (also served as a claude.ai artifact): everything inline, no CDN.
  `build.ts` refuses to produce a file containing `<script src=`, a `<link rel=stylesheet>`, or an
  `@import url(`.
- The barrier launches suites with `process.execPath`; Node need not be on PATH, and the launcher
  may itself be an absolute path. Bun remains a useful parse check where it is installed.
- Headless Chrome (tests, screenshots): `C:\Program Files\Google\Chrome\Application\chrome.exe`.

## gazette

The gazette project has been on standby since 2026-08-10. Do not post anything.
The publication procedure will be restored when the project reopens.
