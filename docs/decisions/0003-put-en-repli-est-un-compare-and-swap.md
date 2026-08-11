# 0003 - The fallback PUT is a compare-and-swap, the DO snapshot isn't

Status: accepted, 2026-08-03

## Context
Two writers target the same D1 row: the Durable Object's snapshot
(30s debounce on alarm) and the client via `PUT /api/plan` when the
realtime wire has dropped. The PUT was BLIND, without a revision. Measured:
two writes accepted in fallback, rev 3 then 5, the row left carrying
only the second one's work, the other person overwritten in silence.

## Decision
The PUT carries `rev`, the revision the client holds the content for. The
Function does an atomic compare-and-swap in one statement
(`INSERT … ON CONFLICT(id) DO UPDATE … WHERE plans.rev=?4`, verdict read
from `meta.changes`) and responds 409 with the winning revision, author and
state. The client sets its version aside (`room-planner-v4-conflit`,
reimportable) rather than writing over it.

## Cost accepted
The Durable Object's snapshot, meanwhile, still writes WITHOUT an expected
revision (`live-worker/worker.ts`, `ON CONFLICT … DO UPDATE SET data=?1, rev=rev+1`,
with no WHERE clause on `rev`). The asymmetry is accepted and documented
(`docs/collab-etat-de-l-art.md`), not resolved: converting it to a
compare-and-swap is a known TODO, not done yet.

## Rejected
- Blind PUT (the old contract): kept ONLY for a tab left open
  before the guard was deployed; all new code must send `rev`.
