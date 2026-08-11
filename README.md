# plan

Plan an apartment together in 2D.

The documentation is in English. Two things are deliberately French: the source
comments, which are extensive and carry most of the reasoning, and the
application's own interface strings, because the people it was built for use it
in French.

No licence yet, so all rights are reserved: the code is readable, not reusable.

This repository is the project root; the deployed site is
<https://plan.example.com>.

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

## Working locally

In PowerShell, from the repository root:

```powershell
$node = 'node' # Node must be on PATH
$npm = 'npm'
& $npm install                           # install the pinned tools
& $npm run build -- --dev                # produce index.dev.html and its map
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' `
  "$PWD\index.dev.html"                 # open the local copy
& $node tests/rapide.ts                  # fast loop, under one second
& $npm run typecheck                     # type-check client, tools, and server
& $npm run build                         # regenerate index.html
& $npm run build -- --check              # verify the committable artifact
```

Under `file://`, synchronization is disabled. For data, geometry, or
synchronization changes, run the only authorized pre-deploy barrier:

```powershell
& $node tests/all.ts # 36 suites
```

## Deploying

```powershell
& $npm run build             # rebuild index.html before the commit
& $npm run build -- --check  # reject a missing or hand-edited artifact
git push origin main         # Pages deploys the committed index.html
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
