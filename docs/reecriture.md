# Rewriting the client in TypeScript: the plan

> **WORK COMPLETED, CUTOVER DONE ON 2026-08-05** (commit `8943730`). `node build.ts` produces
> `index.html` from `src/ts`; the old client was archived separately and is not part of this
> repository. Its source was removed on 2026-08-10 and can no longer be built in the current
> worktree: it remains in the history of the private repository. This document remains as a trace
> of the reasoning, not as instructions; its `src/js` paths, `-next` suffixes, and dual-build steps
> describe the porting period.
> Five of the six conditions in the §6 criterion were measured and met; the sixth (a thirty-minute
> human session on two devices, real mouse) was **replaced** by the real-use suites, which is not the
> same proof and still needs to be done by a human.
>
> Three claims in this document proved false in use. They are noted here instead of being corrected
> in the body: (1) typing does NOT catch an optional field that is declared but never set and called
> with `?.()`, which is exactly the same silence as the old `typeof x === "function"`;
> (2) Circulation was not the only module ported outside its batch, four others were too;
> (3) the "20,000 green seeds" criterion was false when it was written: the harness oracle modeled
> only half of the receive path.

The decision has been made and is not debated here: the client is rewritten from scratch in
TypeScript, following good practices. The current application **stays online and serves the
household throughout the work**; the new one replaces it only when it satisfies the contract.

The contract is **`docs/invariants.md`**: 95 guarantees, almost all born from a measurement, almost
none readable from the code. This document explains how to keep them without paying for them again.

**Reading convention:** what I **VERIFIED** by running the code is marked as such, with the command
and the figure. The rest is marked **ASSUMED** and must be checked before committing to anything.

---

## 0. What I verified by running the code

All these measurements were taken on 2026-08-05 at `af6459e`, on this machine (Windows 11,
win32-arm64, 12 cores).

| Measurement | Command | Result |
|---|---|---|
| Node | `node -p process.version/platform/arch` | **v24.18.0, win32, arm64** |
| Bun | `bun -e "process.arch"` | **1.3.14, native arm64** (no emulation) |
| TS + esbuild installation | `npm i typescript esbuild` in `%TEMP%` | **4 packages in 3.0 s** |
| ARM64 esbuild binary | `ls node_modules/@esbuild/` | **`win32-arm64/esbuild.exe` present, `--version` = 0.28.1** |
| TypeScript compiler | `tsc --version` | **7.0.2** (the native compiler) |
| Strict typing | `tsc --noEmit --strict --lib es2020,dom --module preserve --moduleResolution bundler` | **exit 0** |
| Typing speed | same on a synthetic project of 3,050 lines / 50 modules | **0.66 s** |
| TS bundle to an IIFE | `esbuild main.ts --bundle --format=iife --minify` | **25 ms, 311 bytes** |
| Bundle with bun | `bun build main.ts --target=browser` | **128 ms, OK** |
| Minification of current JS | `esbuild plan-app.js --minify` | **700,034 → 255,743 bytes (-63.5%)** |
| Fast loop | `node tests/rapide.ts` | **46/46 in 0.19 s** |
| Server suite | `node live-worker/test-local.ts` | **582 assertions in 0.56 s** |
| Seeded harness, strict | `node tests/harnais-graine.ts 2500 --strict` | **2,500/2,500 in 40.7 s, empty `CONNUS`** |
| **Full pre-deploy barrier** | `node tests/all.ts` | **3,415/3,415, 27/27 suites, 348.3 s** |

Two additional findings, both **VERIFIED**:

- `esbuild` refuses to stay quiet about the current source: it reports **two real duplicate keys**
  in `window.__plan` (`src/js/57-sondes-test.js`, `wallsMode` l. 58 and 294, `pieceTol` l. 465 and
  505). The last definition wins, so the accessor form of `wallsMode` is dead code and `pieceTol`
  has no consumer. Nothing breaks today **by chance**: the tests use the winning form. This is
  exactly the class of defect that simply passing through a compiler catches for free.
- A stray `nul` file sits at the root (untracked by git, 4,431 bytes, a bundle of
  `functions/api/plans.ts`). It is residue from a Windows redirection. Delete it.

---

## 1. What stays as it is

### The server: we do NOT rewrite it

**Blunt verdict: rewriting `live-worker/` in TypeScript brings no benefit and costs a lot.**

The facts, **VERIFIED**:

| | `worker.ts` | `ops.ts` | total |
|---|---|---|---|
| lines | 654 | 892 | 1,546 |
| blank | 35 | 46 | 81 |
| **comment-only** | 266 (41%) | 218 (24%) | **484** |
| **actual code** | 353 | 628 | **981** |

981 lines of code, **zero dependencies, zero `node_modules`, zero build step**, and 582 assertions
that pass in 0.56 s. `ops.ts` is **pure**: no Cloudflare import, it can be imported under Node with
no side effect, which lets `tests/rapide.ts` and `tests/harnais-graine.ts` run the **real** validator
without a browser. The three riskiest decisions are already extracted into exported pure functions:
`coldLoad`, `d1Verdict`, `upgradeEmptyLegacy`, `planTooBig`. This code was designed to be tested.

Five reasons not to touch it:

1. **The deployment path works against it.** There is no `wrangler` on this machine (win32-arm64):
   `live-worker/DEPLOY.md` documents a **REST multipart upload of two raw `.ts` modules**
   (`main_module: "worker.ts"` plus `ops.ts`), done by hand with `curl.exe`. TypeScript adds a
   transpiler to this path, hence `node_modules` in a project that currently has none, and a rewrite
   of `DEPLOY.md`. The cost lies in the tooling, not the code.
2. **TypeScript would not replace one line of this validator.** Types disappear at runtime and the
   input comes from a WebSocket. We would keep the roughly 450 validation lines **plus** a layer of
   types maintained in parallel, meaning a second source of truth that can diverge.
3. **The file's value lies in its deliberate asymmetries**, and a schema-first rewrite would erase
   all of them silently: truncate a `name` but **reject** a `type` (D-14); accept two input forms for
   `side`/`hinge` and store only one (V-8); bound `t0` by the physical range and **not** by wall
   length (V-4). Each repairs a measured data loss.
4. **Risk is asymmetric.** The file reached its present form through a series of postmortems, whose
   only record is 484 lines of comments. A rewrite resets that trust to zero for a typing benefit.
5. **What we actually want can be obtained without a port:** see §5.

**What still needs to be done on the server before freezing types:**

- **Fix `ops.ts:307` and `:334`.** `pieces.map(validatePiece)` passes the **array index** as `prev`,
  so "missing field = no opinion" **does not work on the v4 path** (invariant V-3). Harmless today
  because `prevOf` happens to reject the value. The correct site is `ops.ts:517`. A port would freeze
  the defect as-is.
- **Export constants** currently private to the module (`OPENING_TYPES`, `OPENING_SIDES`,
  `CELL_FLOORS`, the `*_MIN`/`*_MAX` values, `TYPE_RE`, `ID_RE`). This is the prerequisite for any
  type sharing (§5), and is purely additive.
- **Decide about `validateRoom`/`validateEnvelope`**, which have no key allowlist, unlike the four
  v5 entities. An undocumented asymmetry. Since the v4 path is now only a read path, leaving it is
  defensible, but it must be written down.

### The Pages Functions: we do not rewrite them either

`functions/api/plan.ts` (149 lines, about 35 comments), `functions/api/err.ts` (29 lines),
`functions/ws.ts` (about twenty). The compare-and-swap is **one SQL statement** covered by 25 checks
against real SQLite (`tests/repli-conflit.ts`), and `knownShape` must remain **deliberately loose**
(invariant D-13: tightening this guard kills the fallback). There is nothing to gain.

### Section conclusion

**The rewrite covers only the client**, meaning `src/js/` (11,555 lines, including 2,970
comment-only lines, or 8,353 lines of code), `src/css/` (801 lines), and `src/html/` (453 lines).
`build.ts`, `split.ts`, `tests/`, and `live-worker/` remain.

---

## 2. The build pipeline

### The unchanged constraint

The deliverable remains **a single standalone HTML file**: CSS inline in `<style>`, JS inline in
`<script>`, **no `<script src>`, no `<link rel=stylesheet>`, no `@import url`, no CDN**, and no
runtime dependency. `build.ts` already refuses to produce a file that violates these three rules
(l. 91). Cloudflare Pages serves the repository root **without a build**: `index.html` is
**committed**, built locally. This property does not change.

### The proposed pipeline

```
src/ts/**/*.ts          vrais modules ES (import / export), plus d'IIFE unique
  │
  ├─ tsc --noEmit --strict          typage. 0,66 s mesuré sur 3 050 lignes. Ne produit RIEN.
  │
  └─ esbuild --bundle --format=iife --target=es2019 --minify
                                    25 ms mesuré. Produit build/app.js.
src/css/*.css  +  src/html/*.html   inchangés, mêmes fichiers, même manifeste
  │
  └─ node build.ts                 inline app.js + le CSS + le HTML, mêmes garde-fous CSP
       │
       └─ index.html                un seul fichier, autonome, committé
```

**What changes in `build.ts`:** `manifest.json` governs only `css` and `html`. The `js` section
disappears, along with the entire ordering burden described in `src/README.md` (coupling no. 4,
"execution order is an implicit contract", with three temporal dead zone initialization failures
already encountered). **Real modules remove this entire class of defects**, and with it the need
for `tests/boot-vierge.ts` as an ordering guard (the suite remains useful for virgin startup itself).

**What does not change:** `build.ts --check` (exit 1 if `index.html` no longer matches the source,
to run before every commit), the three CSP guards, and CRLF/LF normalization (documented Windows
trap, `core.autocrlf=true`).

### Feasibility on this machine

**VERIFIED.** The only two development dependencies install and run natively:

- `typescript@7.0.2`: native compiler, no per-platform binary to negotiate, `--noEmit --strict`
  exits 0.
- `esbuild@0.28.1`: `@esbuild/win32-arm64` is published and contains a real ARM64 `esbuild.exe`,
  which runs (`--version` answers) **even though `postinstall` did not run** (npm blocked it under
  its `allow-scripts` policy, and the binary is there anyway). Calling
  `node_modules/@esbuild/win32-arm64/esbuild.exe` directly bypasses the friction point.

**Fallback if npm becomes a problem:** `bun build --target=browser` works (**VERIFIED**, 128 ms) and
`bun.exe` is a **native ARM64** binary, not emulation. Bun can bundle TypeScript without
`node_modules`. It does not type-check, so it does not replace `tsc` at all, only `esbuild`.

**What I did NOT verify (ASSUMED):** that esbuild's `postinstall` will behave well long-term under
this npm's `allow-scripts` policy; that a major `tsc` 7 update will not break anything. Both are
handled by a committed `package-lock.json` and pinned versions.

### Decisions to make, with my recommendation

| Question | Recommendation | Why |
|---|---|---|
| Target | `es2019` | The current source uses **neither** `?.` **nor** `??` (**VERIFIED**, zero occurrences in `src/js/`). There is no reason to move higher, and the household's iPhone is a real client. |
| Minification | **yes** | Measured 700,034 → 255,743 bytes, on a file served at every load. |
| Sourcemaps in the deliverable | **no** | An external map breaks the single file; an inline map doubles its weight. Provide `node build.ts --dev`, producing `index.dev.html` with `--sourcemap=inline`, never committed. |
| `node_modules` in the repository | **no**, gitignored | But **commit `package.json` and `package-lock.json`**: this repository has no dependencies today, so the addition must be reproducible. |
| Does Pages build? | **no**, static root, unchanged | `index.html` remains committed. A mistake here takes the household offline. |

---

## 3. Data compatibility is non-negotiable

The household floor plan is in production, it contains real work, and older formats exist. The new
client must read them. **This is the hardest constraint in the project**, because a defect here is
silent and permanent.

### The data contract: seven input forms

| # | Form | Where it comes from | Must it be read? |
|---|---|---|---|
| 1 | **nested** v5 `{plan:{outline,walls,openings,pieces,cells}, setupDone, model}` | `serialize()`, `localStorage["room-planner-v4"]`, JSON export | yes, **PRIORITY** |
| 2 | **flat** v5 `{outline,walls,openings,pieces,cells,setupDone}` | `GET /api/plan`, Durable Object state | yes |
| 3 | v4 `{rooms[], envelope, active, opts, setupDone}` | old exports, `tests/fixtures/plan-reel-77.json`, `plan-rev177.json` | yes |
| 4 | single-room v1/v2/v3 `{room:{poly,w,l,h}, pieces[], opts}` | `localStorage["room-planner-v3"]`, `-v2`, `-v1` | yes |
| 5 | **wrapped** export `{app:"room-planner", version, savedAt, note, state}` | saved files (`exemple-cuisine.json`) | yes |
| 6 | `room-planner-v4-backup` | verbatim pre-conversion blob | yes (D-3) |
| 7 | `room-planner-v4-backup-illisible`, `room-planner-v4-conflit` | safety nets | yes |

Plus **`room-planner-opts`**, which must be read and **must never cross the wire** (invariant D-7).

**The precedence rule is an invariant, not a detail:** form 1 wins over form 2 because the flat form
loses `h`, `side`, and `name` from openings (strict server keys). Reversing it erases the depth,
side, and name of every opening in the household floor plan.

### How we verify it: the fingerprint oracle

A canonical equality function already exists in production: **`planFp`** (`live-worker/ops.ts`),
64 bits, sorted lists, fixed field order, insensitive to key order. The realtime wire uses it to
decide adoption. It can also serve as an oracle:

```
pour chaque document d du corpus :
    planFp(sanitizeState(ANCIEN.migrate(d))) === planFp(sanitizeState(NOUVEAU.migrate(d)))
```

**One mechanical criterion, no browser, in milliseconds.** It compares how the old client and the
new one read each document, without a human having to decide what matters.

A second, equally cheap oracle: **`v5StateWire()` must return the same bytes** for the whole corpus.
This is what the server sees, and it is the PUT body.

Third: **the round trip is a fixed point**, `migrate(serialize(migrate(d))) ≡ migrate(d)`.

### The corpus

To assemble **before writing one line of the new client**:

- `tests/fixtures/plan-reel-77.json` (v4, 8 rooms, 10,084 bytes) and `plan-rev177.json` (v4, 6,049
  bytes), already versioned;
- `exemple-cuisine.json` (wrapped export, single-room v4);
- **the current production D1 row**, read through the REST API (the token already exists, see
  `~/projects/.secrets.env`);
- the household's local backups (`room-planner-v4-backup`, and the pre-cutover blob mentioned in
  the 2026-08-04 report);
- `defaultState()`;
- **seed-generated floor plans:** `tests/harnais-graine.ts` can already produce valid floor plans
  reproducibly. Connecting its generator to the oracle provides thousands of documents for free.

**This corpus must be versioned** in `tests/fixtures/`, except for the production row, which is read
again on every run. **ASSUMED:** that the household's local backups are still on the machine. Check
early, because they cannot be reconstructed.

---

## 4. Tests: what survives and what does not

### The measured inventory

Full pre-deploy barrier on 2026-08-05, **3,415 checks, 27 suites, 348.3 s** (8 tasks in parallel,
12 cores). Broken down as follows:

| Family | Checks | % | Cumulative suite time | % |
|---|---:|---:|---:|---:|
| Seeded harness (`harnais-graine.ts`) | 2,500 | 73.2% | 39.8 s | 1.9% |
| Server (`live-worker/test-local.ts`) | 582 | 17.0% | 0.7 s | 0.03% |
| Fast loop (`rapide.ts`) | 46 | 1.3% | 0.2 s | 0.01% |
| Static (`no-dead-selectors.ts`) | 1 | 0.03% | 0.3 s | 0.01% |
| **Browser (23 suites)** | **286** | **8.4%** | **2,104 s** | **98.1%** |

**The figure that decides everything: 8% of checks consume 98% of the time.** A cold-started Chrome
costs about 1.2 s per case, and this is structural, not a partitioning defect.

### Behavior versus implementation: sorting them

**Describe BEHAVIOR, survive the rewrite, and become the contract (3,129, or 92%):**

- **582 server assertions.** The server is not rewritten: they survive **unchanged**, without one
  line changing.
- **2,500 seeds.** They check convergence by fingerprint, Figma's undo/redo round trip, and five
  domain invariants after **every** merge (`mur_longueur_nulle`, `ouverture_orpheline`,
  `ouverture_hors_du_mur`, `profondeur_au_dela_du_mur`, `contour_non_ferme`). None of these
  statements mentions the implementation.
- **46 fast checks** and **1 static check**, for the same reason.

**Probe the IMPLEMENTATION through a test hook (286, or 8%):** the 23 browser suites go through
`window.__plan`, exposed by `src/js/57-sondes-test.js` (**616 lines, 234 entries**). Measured textual
occurrences: **1,013 in `tests/`**, up to 188 in a single suite (`collab-annuler.ts`). The hook does
not describe behavior; it reaches inside the closure.

An important nuance: **the scenario survives, the probe does not.** "Clicking an outline vertex does
not change the floor plan" remains true in any language; `__plan.state`, `__plan.rszHandleCount`,
and `__plan.resizeHandle` disappear. The work is therefore not to rewrite 286 tests, but to
**rebuild a probe surface** and reconnect the scenarios to it.

### What can be reused unchanged, VERIFIED

- **`tests/all.ts`, the runner.** It gives each suite a private `%TEMP%`, kills the Chrome tree whose
  command line carries that folder, and deletes the folder. This is what cut a session from 885 s
  to 348 s, and what stopped suites from lying (`model-v5` went from 47 s to 246 s and then 496 s
  in one session, with more than 2,000 leftover folders). **It has nothing to do with the client's
  language. Do not touch it.**
- **`tests/fake-d1.ts`**, a D1 test double on `node:sqlite`, with the same schema as `schema.sql`.
- **The CDP driver** embedded in real-mouse suites (`Input.dispatchMouseEvent`,
  `dispatchKeyEvent`, `insertText` on `--remote-debugging-port=0`). Synthetic `PointerEvent`s bypass
  hit testing: "only they prove a real gesture."
- **The local HTTP server** in two-browser suites, which serves the application and connects
  `/api/plan` to the **real** Function.

### The seeded harness and fast loop: reusable, and they BECOME SIMPLER

**VERIFIED, and it is a pleasant surprise.** Both browserless suites currently begin with a
**source extraction** section: because `src/js/*` is one closure with no `export`, they **cut out
functions by name while counting braces** (`decouper()` in `harnais-graine.ts`,
`fn()`/`cst()`/`ligne()`/`blk()` in `rapide.ts`). A missing name fails startup, which is the right
choice, but this is a workaround.

**With real modules, this entire section disappears and becomes an `import`.** About 120 lines of
text manipulation become typed imports, where a rename is a **compilation error** instead of a
startup error. Everything else in both files, meaning the seeded generator, the transport that
loses, delays, reorders, and duplicates, delta debugging reduction, the five domain invariants, and
the two properties, is **independent of the client language** and stays unchanged.

The same applies to the harness: it already imports the **real** `PlanRoom` and `applyOp` from
`live-worker/`. Since the server is not rewritten, that half does not move at all.

### How to replace the 286 probes

Three rules, in this order:

1. **The hook remains, but becomes a typed, explicit surface.** A `src/ts/debug.ts` module that
   imports the real functions and exports a typed object, inert outside `window.__PLAN_TEST__`.
   Immediate benefit: a rename breaks **compilation**, not a test at 2 a.m. And today's two measured
   duplicate keys (`wallsMode`, `pieceTol`) become impossible.
2. **A typed driver on the test side.** Today the suites talk to the application through strings
   (`evaluate("__plan.wallsMode(true); true")`), 1,013 times. A thin `tests/_pilote.ts`, typed against
   the same definition as `debug.ts`, makes these 1,013 sites checkable.
3. **Migrate one suite at a time, keeping both clients in parallel.** Browser suites already accept
   an application path as an argument (`node tests/run.ts chemin/vers/app.html`). **We can therefore
   run the same suite on the old and new clients** and require the same verdict. This is the best
   safety net in the project, and it already exists.

### What this sorting honestly implies

The real test work is not rewriting 3,415 checks. It is rebuilding **234 probes** and reconnecting
**286 scenarios**. The other 3,129 checks, or 92%, are available from day one.

---

## 5. Typing: where it really pays on THIS project

TypeScript will not prevent a race between two devices. Three specific places, however, have
**already** caused incidents that typing would have stopped at compilation.

### 5.1 The client-server contract

The validator freezes allowed keys and rejects unknown ones. Several incidents came from this:
without an allowed key, the client **packed three pieces of information into a bitfield in the
hinge field**, and the server thought it was validating a hinge; an opening's name and depth did
not cross; neither did its side. This is invariant **C-5**, the most fragile in the repository: a
persisted field that is not declared on both sides never travels, **with no visible error**.

**Typing closes this, on one condition: types must be DERIVED from runtime, not written twice.** The
server exports its constants, and the type is inferred:

```ts
// live-worker/ops.ts  (ajout purement additif)
export const OPENING_TYPES = ["door","sdoor","window","sconce","plug","rj45"] as const;
export const CELL_FLOORS   = ["parquet","herringbone","tile","plain"] as const;
export const OPENING_KEYS  = ["id","wallId","t0","w","h","type","side","name","hinge","swing"] as const;

// src/ts/partage/plan.ts
export type OpeningType = typeof OPENING_TYPES[number];
export type CellFloor   = typeof CELL_FLOORS[number];
export type OpeningKey  = typeof OPENING_KEYS[number];
```

And **a test asserting that the server allowlist and the type keys match**. Without that test, C-5
is not closed, only documented twice.

### 5.2 Entity unions: the `NaN` defect

A piece of furniture has `x`/`y`. An opening does **not**: its position is parametric (`wallId`,
`t0`, `side`). Neither does a wall (`a`, `b`, `t`). Neither does a cell (`poly`). The outline is not
even an entity, it is a bare `[number,number][]`. **This confusion has already written `NaN` values
into the floor plan** (`setDim` on an object with no `x` or `y`, fixed in `9140714`, and the witness
assertion "`setDim()` still writes NaNs on an opening" remains in `interactions.ts`).

A discriminated union makes this defect **impossible to compile**:

```ts
export interface Piece   { kind:"piece";   id:Id; type:string; name:string;
                           x:number; y:number; w:number; h:number; rot:number; locked:boolean;
                           hinge?:0|1; swing?:number|string }
export interface Wall    { kind:"wall";    id:Id; a:Pt; b:Pt; t:number }
export interface Opening { kind:"opening"; id:Id; wallId:Id; t0:number; w:number;
                           type:OpeningType; side:0|1;
                           h?:number; name?:string; hinge?:0|1; swing?:number|string }
export interface Cell    { kind:"cell";    id:Id; poly:Pt[]; name:string; floor:CellFloor }

export type Entity = Piece | Wall | Opening | Cell;
export type Pt = [number, number];
export type Id = string;             // ID_RE = ^[A-Za-z0-9_.:-]{1,80}$
```

The `kind` discriminator **does not exist in the data** (the wire does not carry it). There are two
options: carry it in memory and remove it in the `*Wire` functions, or discriminate by field
presence. **Recommendation: carry it in memory**, because serialization already goes through four
separate functions (`v5PieceWire`, `v5WallWire`, `v5OpeningWire`, `v5CellWire`) that build a new
object anyway.

### 5.3 The wire and operations

```ts
export type Op =
  | { kind:"plan5.replace"; plan: V5State }
  | { kind:"outline.set";   outline: Pt[] }
  | { kind:"wall.set";      wall: WireWall }
  | { kind:"wall.del";      wallId: Id }            // CASCADE les ouvertures du mur
  | { kind:"opening.set";   opening: WireOpening }
  | { kind:"opening.del";   openingId: Id }
  | { kind:"cell.set";      cellId: Id; name?:string; floor?:CellFloor; poly?:Pt[] }
  | { kind:"cells.replace"; cells: WireCell[] }
  | { kind:"piece.set";     piece: WirePiece }
  | { kind:"piece.del";     pieceId: Id };

export type ClientMsg =
  | { t:"hello" } | { t:"sync" } | { t:"ping"; ts:number }
  | { t:"op"; op:Op; n?:number }
  | { t:"cursor"; room?:string; x:number; y:number }
  | { t:"drag"; room?:string; pieceId:Id; x:number; y:number; rot?:number }
  | { t:"chat"; text:string };

export type ServerMsg =
  | { t:"hello"; you:Me; peers:Peer[]; state:V5State; opCount:number; fp:Fp; acks:true; chat:ChatMsg[] }
  | { t:"op"; op:Op; by:string; tag:Tag; n?:number; opCount:number; fp:Fp }
  | { t:"ack"; n:number; tag:Tag; opCount:number; fp:Fp; dup:true }
  | { t:"gap"; tag:Tag; need:number; n:number }
  | { t:"state"; state:V5State; opCount:number; fp:Fp; reason:"sync"|"d1_adopt" }
  | { t:"conflict"; by:string; at:string; bytes:number; kept:"server"|"none" }
  | { t:"peer"; peers:Peer[] }
  | { t:"cursor"; by:string; tag:Tag; color:string; room?:string; x:number; y:number }
  | { t:"drag"; by:string; tag:Tag; color:string; room?:string; pieceId:Id; x:number; y:number; rot:number }
  | { t:"chat"; msg:ChatMsg }
  | { t:"pong"; ts:number; fp:Fp }
  | { t:"err"; reason:OpReason; n?:number|null; kind?:string };
```

**Two traps that types must EXPRESS, not hide:**

1. **`WireOpening` is not `Opening`.** On the wire, the old form packs `side` into bit 1 of `hinge`,
   so `hinge: 0|1|2|3` on input and `0|1` in the database. Two distinct types, with an explicit
   unpacking function between them.
2. **`fp` and `opCount` must not be compared.** The two counters with the same name caused permanent
   divergence with both screens showing « live ✓ ». Making `Fp` an **opaque type**
   (`type Fp = string & {readonly __fp:unique symbol}`) makes `fp === String(opCount)` fail to
   compile. It is cheap and closes a real incident.

### 5.4 What must NOT be typed

- **Centimeters as a nominal type** (`type Cm = number & {...}`). The entire application uses
  apartment centimeters; there are no two units to mix. High friction, no benefit.
- **The DOM and CSS.** Rendering invariants (R-1 to R-19) are proven by measured pixels and angles,
  not by types.
- **The Circulation engine.** 1,040 lines of geometric rules, with no type defect in its history.

### 5.5 Where to put shared types

`live-worker/ops.d.ts`, next to `ops.ts`, plus a `tsconfig.json` in `allowJs`/`checkJs` mode **with
no output**. The server does not change by one byte, the TS client imports the types, and a test
asserts that the `.d.ts` and exported constants match. This is the cheapest solution that actually
closes C-5.

---

## 6. The work order

The rule governing the entire breakdown: **`main` remains deployable at every step.** The new client
lives in `src/ts/` **next to** `src/js/`, `build.ts` can produce either one, and `index.html` remains
the old client until cutover. No long-lived branch.

### E0. The oracle, before writing any application code

Assemble the corpus (§3), write the fingerprint oracle, connect it to the seeded generator, and
**run it on the old client against itself** (this tests the test). Along the way, fix
`ops.ts:307`/`:334` and export the server constants (§1).

*Deliverable:* `tests/compat-donnees.ts`, green, without a browser.
*Criterion:* the oracle rejects a deliberately introduced regression (for example, reversing the
precedence of `st.plan` / flat form must make it red).
*Risk:* low. **This step has value even if the rewrite is abandoned.**

### E1. The pipeline skeleton

`package.json` + lock, `tsconfig.json`, a `src/ts/main.ts` that does nothing, and `build.ts` able to
produce `index-next.html` from `src/ts` plus the existing CSS and HTML.

*Criterion:* `node build.ts` produces a single file that passes the three CSP guards;
`tsc --noEmit` exits 0; `node tests/boot-vierge.ts index-next.html` mounts the page without a JS
error.
*Risk:* low.

### E2. The pure core

Geometry (`js/04`, `js/47`, `js/48`, `js/52`), old-format reading and conversion (`js/02`,
`js/49`), serialization and wire (`js/07`, `js/51`), emission diff and mirrors (`js/42`), undo
(`js/27`), catalog (`js/01`). In other words, **exactly what `rapide.ts` and
`harnais-graine.ts` currently extract from the source**.

*Criterion:* both browserless suites run against the TS modules, **by import**, and are green:
46/46 and **20,000 seeds** under `--strict`. Plus the E0 oracle.
*Risk:* medium. It is a lot of code, but **this is the only place in the project where proof is
complete, fast, and browserless.**

### E3. Rendering and gestures

`js/03`, `js/05`, `js/09`, `js/11`, `js/12`, `js/15` through `js/22`, `js/28` through `js/33`,
`js/50`, `js/53`, `js/54`, `js/56`, plus the typed probe surface (§4). The Circulation engine
(`js/34` through `js/38`, 1,040 lines) is **ported last, verbatim**.

*Criterion:* the 23 browser suites pass on `index-next.html`, **with the same number of checks**, the
same command, and the same runner.
*Risk:* **high because of the volume.** This is where invariants G-1 to G-24 and R-1 to R-19 live,
meaning 43 of 95, most of them "guaranteed by convention." And the only proof is a real mouse.

### E4. Synchronization and collaboration

`js/39` through `js/45`, plus `js/41`.

*Criterion:* `collab-annuler` (34), `collab-accuses` (13), `deux-appareils` (15),
`repli-d1-live` (21), `repli-conflit` (25), `plan-abime` (13), and
`model-v5-fil-serveur` (15) green, plus 20,000 seeds.
*Risk:* **the highest in the project because of the consequences.** See below.

### E5. Parity, then cutover

Run the **entire** pre-deploy barrier on both clients, compare suite by suite, then cut over in one
commit.

### The riskiest step, and why

**E4 because of the consequences; E3 because of the volume.** If I must name only one: **E4**.

E3 defects are visible: a click lands beside its target, a label is crooked, a gesture does not
finish. They hurt, they are visible, and a thirty-minute real-use session finds them.

E4 defects are **silent and destructive**. This repository contains at least five, all measured: a
default floor plan overwriting the household floor plan; an undo erasing the other person's work on
both screens **and** in the server floor plan; a reload losing twenty pieces of furniture while the
chip shows « live ✓ »; a lost operation that no mechanism caught, and which a reread **erased**
instead of recovering; two devices belonging to one person treated as one. **In every case, the
screen said everything was fine.**

Three non-negotiable precautions:

1. **The new client never touches the real Durable Object or the real D1 row before E5.** Everything
   is proven on the local bench, which starts an HTTP server on `listen(0)`, serves the application,
   and connects `/api/plan` to the real Function over real SQLite. This bench exists.
2. **The seeded harness is run under `--strict` and with 20,000 seeds** at the end of every E4 batch,
   not only 2,500. It found the last two races (the device republishing what it had just adopted,
   and the opening left outside its wall), where a brief claimed the opposite.
3. **Keep the client's "old server" mode.** The protocol tolerates a server without `tag` (falling
   back to email) and without `acks` (idle retransmission mechanism). These fallbacks are not
   folklore; they let a tab that stayed open avoid destroying the floor plan.

### The explicit, measurable cutover criterion

Cutover happens when all **six** conditions are true on the same day:

1. `node tests/all.ts` on the new client: **27/27 suites, at least 3,415 checks**, zero failures, on
   three consecutive runs (`--repeat 3`).
2. `node tests/compat-donnees.ts`: **green fingerprint oracle on the entire corpus**, including the
   production D1 row **from the day of cutover**.
3. `node tests/harnais-graine.ts 20000 --strict`: green, empty `CONNUS`.
4. **A thirty-minute real-use session**, on the real floor plan, with two devices and a real mouse:
   identical round-trip criterion (an object returned to where it was comes back exactly), with 300
   objects, without regression on the measurements cited in `invariants.md` (G-5: at least 537
   exact round trips out of 549; G-9: zero gestures out of 88 moving an object that is not under the
   cursor).
5. **Zero errors** in the `localStorage['plan-errors']` ring and **zero rows** added to D1's `errors`
   table during this session.
6. `index.html` is **one file**, passes all three CSP guards, and **weighs no more** than today
   (789,975 bytes; with minification, it should be far below that, see §0).

---

## 7. What I advise against

**1. Rewriting the server.** Argued in §1. The only real gain would be shared types, and they can be
obtained with a `.d.ts` and a few exported constants, without touching runtime or deployment.

**2. Replacing the validator with a schema (Zod, Valibot, TypeBox).** This is the natural temptation
in a typed rewrite, and it is the trap. The 450 validation lines derive their value from their
**deliberate asymmetries**, each paid for by a measured data loss: truncate a `name` but reject a
`type`; accept two input forms for `side`/`hinge` and store only one; bound `t0` by the physical
range, not wall length. A declarative schema erases all of them uniformly and silently.

**3. Introducing a UI framework (React, Svelte, Solid).** The file must remain standalone and
CSP-safe. More importantly, a VDOM framework would **rewrite precisely the code that cost the
most**: paint order (`data-paint`, largest to smallest), reconciliation that never replaces a node
("DOM nodes have closures attached to them"), stack arbitration, and handles created only on
selection (saving 376 nodes). These choices run **against** a framework's defaults.

**4. Rewriting the Circulation engine.** 1,040 lines (`js/34` through `js/38`), eleven correct rules,
no type defect in its history, and a measured cost of 30-50 ms per analysis. **Port it verbatim,
last, without changing it.** Its only recent defect was in integration (it was inert when the panel
was closed), not in its rules.

**5. Renaming anything along the way.** The `LEGACY_TYPE_NAMES` episode shows the cost of a rename:
renaming a catalog entry without preserving the old label makes the name of every existing piece of
furniture reappear at once, on every floor plan. **Rule: the rewrite changes the language of the
code, not a data key, catalog label, `localStorage` key name, or user-visible string.** Those changes
come later, one at a time, with their own measurement.

**6. A long-lived branch.** `src/ts/` next to `src/js/`, with `main` always deployable. The household
uses this application every day.

**7. The part that frankly is not worth its cost.** `js/11-icones.js` (385 lines generating SVG)
and `js/12-rendu.js` (358 lines) gain almost nothing from typing: their correctness is proven in
pixels, and they have never caused a type defect. The same applies to `src/css/` (801 lines) and
`src/html/` (453 lines), which are **not involved at all**. Of the 8,353 lines of client code, I put
the real typing benefit at about **3,500 lines**: model, conversion, wire, synchronization, and
geometry. The rest is ported because it has to be in the same file, not because typing improves it.

**8. One final point that must be acknowledged.** This project fixes none of the seven known gaps
listed in appendix B of `invariants.md`. Compare-and-swap for the Durable Object snapshot, automatic
orphan recovery, the inverse-operation stack, ghosts for structural gestures: **none of these is
closed by rewriting the client in TypeScript.** They are separate, smaller projects with immediate
value. If the goal is to make the system safer rather than more pleasant to write, **gap no. 1 (the
snapshot without compare-and-swap) costs five identified points in `worker.ts` and is handled in one
batch.** The rewrite costs weeks, and its benefit is maintainability, not safety. Both are
defensible; they simply must not be confused.
