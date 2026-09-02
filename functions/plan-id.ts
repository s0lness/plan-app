// THE ONE PLACE THE PLAN ID SHAPE LIVES for the Pages Functions. Lowercase letters, digits, `_`
// and `-`, 1 to 40 of them, starting with a letter or digit: narrow enough that an id is safe to
// use as a D1 primary key and as a Durable Object name (`env.ROOM.idFromName`), with no quoting
// question either way.
//
// Previously copied verbatim in six files (functions/api/feedback.ts, functions/api/invites.ts,
// functions/api/orphans.ts, functions/api/plan.ts, functions/api/plans.ts, functions/ws.ts): all
// six import from here now. `live-worker/ops.ts` keeps its OWN copy: that file is bundled and
// deployed as a separate Worker (`live-worker/build-worker.ts`), a unit apart from these Pages
// Functions, so it cannot import this module. `tests/rapide.ts` verifies the two copies still say
// the same thing (same spirit as invariant C-5).
export const PLAN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
