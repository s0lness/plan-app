# 0001 - index.html is a product, never a source

Status: accepted, 2026-08-03

## Context
The deliverable stays ONE self-contained file (CSP-safe, served as-is by Pages
with no build step on Cloudflare's side). But editing an entire client in a
single HTML+CSS+JS file of several thousand lines makes it impossible
to have several agents work in parallel, and makes every review
harder than it needs to be.

## Decision
The source lives in `src/` (CSS in stylesheets, HTML in fragments, TypeScript
in ES modules) and `node build.ts` recomposes it into `index.html`, which is
COMMITTED and served as-is. `build.ts --check` exits 1 if the committed file
no longer matches the source, and runs before every commit.

## Cost accepted
An extra build step in the work loop, and a structural risk: an
`index.html` forgotten in the commit deploys the old
file without a word. `--check` is what catches this oversight, not a
guarantee it will never happen again.

## Rejected
- Editing `index.html` by hand: this was the original form (v1 to v4),
  abandoned the day the file exceeded what an agent can review
  in one pass.
- A build on Cloudflare's side: the deliverable must stay static, zero
  network dependency on the service, so the build stays local and its result
  committed.
