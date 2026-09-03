# `src/` map

`src/` is the SOURCE of the client being served. `node build.ts` assembles the CSS and HTML in
the order defined in `manifest.json`, then produces a minified, self-contained IIFE from
`src/ts/main.ts`. `index.html` is the committed output: never edit it by hand.

Write the comments and the indentation you need here: the build strips them out of the deliverable
(decision 0017). It keeps one source line per line, so no rendering depends on how a fragment is
laid out; it refuses to build if a fragment gains a `url(...)` or content where whitespace matters
(`<pre>`, an inline `<script>`, a non-empty `<textarea>`).

The historical client no longer has source files in the repository. It was archived separately as
a self-contained artifact, which is not part of this published repository. Comments that say
`Porté de src/js/…` refer to the source from before the cutover. It was removed from the
repository and is available in the history of the private repository.

## Overview

| Path | Role | Ordering contract |
| --- | --- | --- |
| `head.html` | Contents of `<head>` after the preamble produced by `build.ts`. | Single `head` entry in the manifest. |
| `css/` | The product's stylesheets. `01-jetons-base.css` contains the tokens; the following files build the cascade. | EXPLICIT order in `manifest.json`; a file missing from the manifest makes the build fail. |
| `html/` | The shell, scene, panel, and modal fragments. | EXPLICIT order in `manifest.json`; a file missing from the manifest makes the build fail. |
| `ts/` | The only client: TypeScript ES modules grouped by domain. | `import` graph from `main.ts`; no list in the manifest. |
| `manifest.json` | Manually maintained order for the head, CSS, and HTML. | Never describes TypeScript: esbuild follows imports. |

## TypeScript (`src/ts/`)

| Folder / file | What it contains |
| --- | --- |
| `main.ts` | Startup: local state, application context, domain wiring, first render, and realtime wire startup. |
| `noyau.ts` | Pure export facade used by browserless suites; it is not the application's entry point. |
| `app/` | Shared context, persistence, personal settings, diagnostics, messages, and help. |
| `partage/` | Floor plan types and a verified copy of the client/server contract. |
| `modele/` | v1-v5 reading, migration, sanitization, derived cells, walls, openings, furniture, conversions, projection, and distribution. |
| `geometrie/` | Pure polygon primitives shared by the model, rendering, and gestures. |
| `catalogue/` | Catalog, families, current labels, and historical labels. |
| `rendu/` | View, layers, furniture, openings, icons, floors, palette, selection, and calculated cards. |
| `gestes/` | Shared gesture output, view, placement, dragging, resizing, walls, openings, keyboard, and selection. |
| `panneaux/` | Setup, inspector, cell card, menu, floor plans, and inline renaming. |
| `mesure/` | Measurements, pointer guides, and peer cursors. |
| `historique/` | Local stack and replay of remote operations during undo/redo. |
| `fil/` | Identity, pseudo-wire, mirrors, sending, receiving, presence, acknowledgements, REST. |
| `circulation/` | Engine state, apartment context, grid, rules, fixes, and Circulation panel. |
| `exportation/` | JSON import/export, master SVG, PNG, printing, and furniture list. |
| `types-globaux.d.ts` | Declarations for browser surfaces that do not come from modules. |
| `package.json` | Provides `"type":"module"` so Node loads the `.ts` files used by browserless suites. |

## CSS and HTML

The numbered name gives the cascade or insertion order. Adding, removing, or moving a fragment
requires changing `manifest.json` in the same batch. The `build.ts` guard rejects any `.css` or
`.html` file that exists on disk but is missing from the manifest.

Tokens live in `css/01-jetons-base.css`. Chrome and panel rules use these tokens; they do not
invent a second palette. `[hidden]{display:none!important}` is also a structural invariant there,
not a local convenience.

## Where to start

| Need | Starting point |
| --- | --- |
| State, reading a payload | `ts/modele/etat.ts`, `migrations.ts`, `filets.ts` (the unreadable-plan net) |
| Walls, cells, openings | `ts/modele/murs.ts`, `cellules.ts`, `edition.ts` |
| Room names during a gesture | `ts/modele/photo-cellules.ts` (why the photo exists, and what it protects) |
| Geometry gestures | `ts/gestes/murs.ts`, `outil-mur.ts` (the wall tool's chain, pure), `ouverture.ts`, `edition-murs.ts` |
| Furniture and placement | `ts/gestes/meuble.ts`, `pose.ts`, `rendu/meubles.ts` |
| Floor plan rendering | `ts/rendu/rendu.ts`, `calque.ts`, `vue.ts` |
| Collaboration | `ts/fil/`, then `live-worker/ops.ts` for the server contract |
| Persistence and settings | `ts/app/persistance.ts`, `options.ts` |
| Circulation | `ts/circulation/` |
| Export and printing | `ts/exportation/` |
| Side interface | `ts/panneaux/`, `html/`, corresponding CSS files |

## Verify

`node build.ts --check` proves that the committed artifact matches the source. The fast loop is
`node tests/rapide.ts`; type checking is `node_modules/.bin/tsc --noEmit`. The whole barrier,
typing included, is `node tests/all.ts` and takes about twenty seconds: run it on every change.
