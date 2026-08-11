# 0002 - No wrangler.toml in this repo

Status: accepted, 2026-08-06

## Context
`DB` (D1) and `ROOM` (the Durable Object) are two bindings this project
needs. gazette2 had put them in a `wrangler.toml` and lost an
afternoon on 2026-08-05: a PATCH API succeeded, the dashboard
showed the binding present, and the NEXT deployment made it
disappear anyway, because a `wrangler.toml` present takes authority
over bindings on every build. `env.ROOM` became undefined, `/ws`
responded 503, and clients fell back to the REST fallback WHILE LOOKING
LIKE IT WORKED.

## Decision
No `wrangler.toml` in this repo. `DB` and `ROOM` are set ON THE
Pages PROJECT, on the dashboard side, configured through the REST API.

## Cost accepted
The bindings are not version-controlled or readable in the repo: inspecting
the code doesn't tell you what is wired up, you have to go to the
dashboard or query the API.

## Rejected
- A `wrangler.toml` declaring the bindings: this is exactly what
  cost gazette2 an afternoon. If it ever becomes necessary here, it
  must declare `DB` and `ROOM` BEFORE being committed, and three times (root,
  `[env.preview]`, `[env.production]`), because a named
  environment inherits nothing.
