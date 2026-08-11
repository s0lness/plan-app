# plan

Plan an apartment together in 2D.

The documentation is in English. Two things are deliberately French: the source
comments, which are extensive and carry most of the reasoning, and the
application's own interface strings, because the people it was built for use it
in French.

No licence yet, so all rights are reserved: the code is readable, not reusable.

This repository is the project root. A deployed instance lives behind
Cloudflare Access, so the link is not public.

## Status as of 2026-08-10

- Live on Cloudflare Pages, protected by Access for both members of the
  household. The TypeScript client has been served since 2026-08-05.
- The client, Worker, Pages Functions, build, and tests now use TypeScript as
  their single source.
- Collaboration runs through `PlanRoom`, with D1 as cold storage and fallback.
- Half-done: the fallback PUT is revision-protected, but the Durable Object
  snapshot writes without compare-and-swap after reconciliation.
- To verify: a 30-minute human session on two real devices. The automated
  suites have replaced it, not proved it.

## Running it

Open `index.html` in a browser. That is the whole procedure: no install, no
build, no server, no network. The file is the application, 400 KB of it, and it
makes no outbound request of any kind.

```
git clone https://github.com/<owner>/plan-app.git
cd plan-app
# then double-click index.html, or:
open index.html      # macOS
xdg-open index.html  # Linux
start index.html     # Windows
```

The setup wizard opens on a blank profile and you can draw an outline, raise
walls, drop furniture and read the computed rooms straight away. Your work is
saved in the browser's local storage, and the File menu exports and reimports a
floor plan as JSON.

A demo floor plan ships with the repository, `exemple-appartement.json`: an
invented apartment, nobody's home. Load it from the File menu ("Open from
file…") to see a furnished plan instead of an empty canvas.

What you do NOT get this way is the shared part. Under `file://` the client
disables synchronization on purpose, so there is no account, no server and no
second person. The collaborative half needs the Cloudflare pieces described
under Deploying: a Durable Object for the live wire and a D1 database behind it.

## Developing it

Node 22.18 or newer, because the tooling runs TypeScript directly, with no
transpile step. From the repository root:

```
npm install              # two pinned build tools, nothing at runtime
npm run build -- --dev   # index.dev.html, unminified, with an inline sourcemap
npm run build            # regenerate index.html, the deliverable
npm run build -- --check # fail if index.html no longer matches the source
npm run typecheck        # client, tools and server, both configurations
node tests/rapide.ts     # the fast loop, no browser, under a second
```

Never edit `index.html` by hand: it is built from `src/` and the next build
overwrites it.

For a change touching data, geometry or synchronization, run the whole
pre-deploy barrier, which is the project's only gate:

```
node tests/all.ts        # 36 suites, 4 557 checks
```

Most suites drive a real Chrome and currently expect it at the standard Windows
install path, so on macOS or Linux the browser suites will not start yet. The
browserless ones (`rapide`, `compat-donnees`, `harnais-graine`, `exports-morts`,
`no-dead-selectors`, `live-worker/test-local`) run anywhere.

## Deploying

```
npm run build              # rebuild index.html before the commit
npm run build -- --check   # reject a missing or hand-edited artifact
git push origin main       # Pages serves the committed index.html as-is
```

Wrangler cannot be used on this ARM64 machine; the Worker is deployed through
the REST API after `npm run build:worker`. Redeploying cuts the WebSockets, so
do it outside editing sessions. See [the procedure](live-worker/DEPLOY.md).

## Writing the shared floor plan

In realtime, the client sends operations to `/ws`. `PlanRoom` applies and
persists them, then writes a snapshot to D1 after 30 seconds.

If the WebSocket goes down, the client polls `GET /api/plan?p=<id>`, then sends
`PUT /api/plan?p=<id>` with `{state, rev}`. The Function performs an atomic
compare-and-swap. A conflict returns 409 with the winning state and keeps the
rejected version locally. D1 is `plan`, binding `DB`, table `plans`, UUID
`<d1_database_id>` (get your own from the Cloudflare dashboard or `wrangler
d1 list`).

## Traps that cost an hour

- Never edit `index.html`; it is an output of `build.ts`.
- Never add `wrangler.toml`: `DB` and `ROOM` are configured on the project, and
  an incomplete file would delete them.
- `build.ts` rejects `--next`. The `--legacy` flag was removed along with the
  archived pre-cutover build, which is not part of this repository.
- Run tests through `tests/all.ts`, never suite by suite.
- Node runs `.ts` files directly here, without `tsx` or Bun.
- `core.autocrlf=true`; `build.ts --check` normalizes LF and CRLF.

## Other documents

Start with `AGENTS.md`, then `src/README.md` for the module map. The guarantees
are in `docs/invariants.md`, the history in `docs/reecriture.md`, the
collaboration limits in `docs/collab-etat-de-l-art.md`, and deployment in
`live-worker/DEPLOY.md`.
