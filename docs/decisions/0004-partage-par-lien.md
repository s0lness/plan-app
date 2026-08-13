# 0004 - Sharing a plan by link: two doors, one deliverable

Status: PROPOSED, 2026-08-13. Not implemented.

## Context

Today the only way in is Cloudflare Access with a two-address allowlist. There is
no other notion of identity: `displayName()`
(`src/ts/mesure/curseur-pair.ts:59`) derives the name on a peer dot, a cursor
label and a chat line entirely from the Access email, and `colorFor()`
(`live-worker/ops.ts:345`) hashes that same email into a palette. Nothing
downstream of Access checks an author: `applyOp` validates the SHAPE of an op,
never who sent it, so "authorized" means exactly "Access let you through".

Two things are wanted, and one architecture delivers both:

1. Send someone a link so they can work on a plan with me, without giving them an
   account and without adding them to the Access allowlist.
2. Let anyone who simply visits the site use the planner, storing their work in
   their own browser.

## Decision

**Two front doors onto ONE Pages project and ONE `index.html`.**

| door | hostname | Access | what it is |
| --- | --- | --- | --- |
| household | `plan.example.com` | yes, unchanged | the couple, all plans, full privileges |
| guest | `share.example.com` | **no** | invited guests, and the local-only planner |

The guest door with **no token** is a planner that syncs nothing and stores
everything in the visitor's own `localStorage`. That is idea 2, and it costs one
condition in `src/ts/fil/drapeaux.ts`, the module every `SYNC_ON` reader already
funnels through. The guest door **with a valid token** is idea 1.

The guest hostname must be ONE label under the zone (`share.example.com`, not
`share.plan.example.com`): Cloudflare's universal certificate covers a single
level of subdomain, and a two-level name needs an advanced certificate.

### The door is enforced in code, not by Access

**This is the part that is easy to get fatally wrong.** Pages Functions are bound
to the PROJECT, not to a hostname: `/api/plan`, `/api/plans`, `/ws` and
`/api/err` answer on every hostname the project serves. Adding a hostname that
Access does not cover therefore exposes the household's API unless the Functions
decide for themselves.

So a single choke point, `porte(request)`, decides. It is a
`functions/_middleware.ts`, NOT a helper each route remembers to call: a
convention is deny-by-convention, and the next route added in six months would be
open on the guest door by default. It returns one of three verdicts, and handlers
opt into what they accept:

- **Host is the household host** → Access has already proven identity at the
  edge. Full privileges.
- **Host is the guest host** → no Access. `/api/plans` is 403 in every method.
  `/api/plan` and `/ws` require a valid invite token, and the plan id comes
  **from the token**, never from `?p=`.
- **Any other Host** → refuse outright. Nothing is served and no token is
  accepted.

### `/ws` IS A FOURTH DOOR, and middleware does not cover it

A zone route (`live-worker/DEPLOY.md` §2) sends `plan.example.com/ws*` straight
to the `plan-live` Worker. A zone route takes precedence over Pages, so on the
household host `/ws` **never reaches `functions/ws.ts`**, and a choke point
living only in Pages Functions misses the most privileged route in the product.
`worker.ts` has its own public `fetch` that reads
`Cf-Access-Authenticated-User-Email` and `?p=` from the incoming request.

Worse, the asymmetry is invisible: a zone route is bound to a hostname, so
`share.example.com/ws` would NOT match it and WOULD go through Pages. Two hosts,
two different code paths, one of which is easy to forget.

So the authoritative door check lives in `worker.ts`'s `fetch`, the only place
that sees every socket whatever the route, and `functions/ws.ts` enforces the
same rule as defence in depth. Checked while writing this: the `workers.dev`
subdomain on `plan-live` is disabled (`enabled:false`, `previews_enabled:false`),
so the Worker is not directly reachable today. Batch 5 must verify that it stays
disabled, because if it is ever turned on, that route answers with no Access, no
middleware, and a caller-supplied identity header.

### `Cf-Access-*` headers and the `who()` cookie fallback are safe ONLY behind Access

`who()` (`functions/api/plan.ts:44-56`, duplicated in `plans.ts:36-46`) falls
back to decoding the `Cf-Access-Jwt-Assertion` header or the `CF_Authorization`
cookie. It decodes with `atob` and **never verifies the signature**. That is
correct today, because Access verified the token upstream before the request
reached the Function.

Off an Access-protected host that reasoning collapses. Everything `who()` reads
is caller-supplied: the `Cf-Access-Authenticated-User-Email` header itself, the
`Cf-Access-Jwt-Assertion` header, and the `CF_Authorization` cookie, whose
signature is never checked. A `curl` to the guest door with one header would be
believed. `who()` is duplicated three times, in `plan.ts:45`, `plans.ts:36` and
`err.ts:6`.

Two consequences, the second worse than the first:

1. **Impersonation of a household member** in `updated_by`, which surfaces on the
   owner's own screen ("X wrote to the shared plan before you").
2. **`updated_by: "live"` is a magic value.** `d1Verdict`
   (`live-worker/worker.ts:208`) returns `own_write` for that exact string,
   because "the DO NEVER writes anything but 'live', and the REST Function NEVER
   writes 'live'". Forge that identity and a REST write becomes invisible to the
   Durable Object's reconciliation: it is never adopted, never flagged as a
   conflict, never told to anyone.

So: `porte()` **strips every `Cf-Access-*` header and the `CF_Authorization`
cookie** on any non-household verdict, before anything downstream reads them; the
unsigned-JWT fallback goes away (it is now a vulnerability, not a convenience);
and a REST PUT may never write the literal `live`, whoever asks. Identity on the
guest door comes from the invite row and from nothing else.

### The token is a capability, and it travels in the fragment

The link is `https://share.example.com/#k=<22 chars, 128 bits, base64url>`.

In the **fragment**, not the query string: a fragment is never sent to the
server, so the token stays out of edge logs and out of any `Referer`. The client
reads it once, stores it, and strips it from the address bar with
`history.replaceState` so it does not sit in a screenshot or a shared screen. It
is stored first and stripped second, so a reload still works.

New D1 table, additive, no existing row touched:

```sql
CREATE TABLE IF NOT EXISTS invites(
  token TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'edit',
  created_at TEXT, created_by TEXT,
  expires_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0, last_used_at TEXT, last_name TEXT
);
```

The token is stored in clear, deliberately. Hashing it would mean the link can be
shown exactly once, and the owner will want to re-send it. What the row protects
is the same thing the link protects, and the table is reachable only through the
household door. This is the one place where convenience beat rigour on purpose;
it is the first thing to revisit if the guest door ever carries anything more
sensitive than an apartment layout.

`role` exists with only `edit` accepted, so adding read-only later is not a
migration. It is not "one line" either: read-only needs op rejection in the DO,
PUT rejection in the Function, plumbing on the socket attachment, and UI
trimming. Deferred deliberately, not cheap.

**How the token travels after capture.** A browser cannot set headers on a
WebSocket upgrade, so a `?k=` on `/ws` would put the capability into the very
logs the fragment was chosen to avoid, on every reconnect. The token is exchanged
once at `/api/invite/hello` for a short-lived `HttpOnly`, `Secure`, `SameSite`
cookie scoped to the guest host; `/ws` and the REST routes validate that cookie.
The capability stays in the fragment, the session credential is never readable by
script.

Default expiry: **30 days**. Revocation is the real control; expiry is the
backstop for a link forgotten in a chat thread.

## The flow

**Owner.** In the Plans panel, a plan gets a "Share" action → the link appears
already selected with a "Copy" button, plus that plan's live invites (created,
last used, last name seen) each with "Revoke".

**Guest.**

1. Opens the link. The client captures `#k=`, stores it, cleans the URL.
2. `POST /api/invite/hello` with the token → `{planId, planName, role}`, or a
   dead end. A dead end is a full screen, not a banner: "This link no longer
   works. Ask for a new one." There is no planner behind it.
3. **The name step.** One field, pre-focused, Enter submits:
   "You have been invited to work on « <plan name> ». What should we call you?"
   The Join button is disabled while the field is empty. Nobody reaches the wire
   unnamed, which is the entire point of the step.
4. The name and a generated `guestId` are stored locally. A returning guest skips
   step 3; the name stays changeable from the sync chip menu.
5. The app boots into that plan, live, with their name on their dot and cursor.

## What a guest may and may not do

May: view the plan, edit geometry, furniture and openings, undo their own work,
see and be seen by cursors, export, print.

May not, enforced **server-side** and hidden in the UI:

- list, create, rename or delete plans (`/api/plans` is 403 on the guest door)
- reach any plan other than the one their token names
- send `plan5.replace`. "Load a plan…" would replace the plan in one atomic op
  AND clear the undo history, so no snapshot describes its past anymore. Hidden
  from the guest UI and rejected by the DO.
- send a **blind PUT**. `functions/api/plan.ts:142` still accepts `PUT {state}`
  with no `rev`: last writer wins, whole document. That is `plan5.replace` under
  another name, reachable with one `curl`. The old contract exists for "a tab
  opened before deployment", and no guest tab predates the feature, so the guest
  door requires `rev`.

"Remove all furniture" stays reachable, and the honest statement of the risk is
NOT "undo covers it". **Undo is author-scoped by design**: history replays peers'
ops over one's own snapshots, so the owner cannot undo a guest's mass delete.
Recovery is the file export, because D1 keeps one row and no history. Either
accept that explicitly or keep the last N revisions server-side; this proposal
accepts it and says so.

## Edge cases

Each of these is a test case, not a note.

1. **The name is the first untrusted string the client has ever rendered.** Until
   now every name came from an Access-verified email. `presence.ts` and
   `curseur-pair.ts` build markup with `innerHTML`; the code says the label is
   escaped (R-9), and that discipline must be re-audited end to end for the new
   source, including `initial()`, the dot `title`, the chat line, the conflict
   banner and the chip tooltip. This is the highest-risk item in the feature: a
   stored XSS here runs in the household's browser.
2. **Bidi overrides.** `cleanName` (`functions/api/plans.ts:50`) strips control
   chars below 32 and 127, which lets `U+202A…U+202E` through. Those visually
   reorder the text AROUND the name. Strip them, and cap at 40.
3. **Two guests pick the same name.** The wire already keys by device `tag`, so
   they do not merge, but the screen becomes a lie. The DO appends a display
   discriminator when a name is already live in the room: "Marie", "Marie (2)".
4. **A guest names themselves after the owner.** Unpreventable, so make
   provenance visible instead: household peers and guests render differently,
   because the household identity is Access-proven and the guest's is
   self-declared.
5. **`?p=` on the guest door.** A guest editing the URL must not reach another
   plan. The plan comes from the token; the query is ignored.
6. **Revocation must close live sockets**, not merely block new ones. The
   Function tells the DO, which closes the matching sockets. Otherwise "Revoke"
   is a lie for as long as the guest stays connected.
7. **Revoked mid-gesture.** The guest gets a blocking screen that states
   accurately whether their last change was saved. Anything vaguer breaks the
   "the chip never lies" rule.
8. **Every guest would be marked as "your other device".** `wsSameAccount`
   (`src/ts/fil/etat.ts:294`) returns true when two sockets carry the same email
   and different tags. All guests share the fallback identity `inconnu`, so each
   guest sees every OTHER guest wearing the `.self` outline, the
   "your other device" tooltip and the "Other device" cursor label: the strongest
   trust marker in the UI, handed to a stranger. It fails toward trust, which is
   the wrong direction. A stored `guestId` becomes the "same person" key, and
   `wsSameAccount` must return false whenever the identity is a guest fallback.
9. **All guests collide today.** Without this work every unauthenticated caller
   is the literal string `inconnu`, so `displayName()` gives them all the same
   name and one shared color.
10. **The plan is deleted while a link is live** → dead end, same screen as a
    revoked link.
11. **The owner opens their own guest link** and appears as a guest. Offer
    "You're the owner? Open the household site".
12. **`/api/err` from the guest door** must require a valid token, otherwise it
    is an open write into D1.
13. **The sandbox and an invited `main` collide in local storage.** Per-origin
    separation protects the household's bytes, but not these two from each other:
    `keyPourPlan("main")` (`src/ts/noyau/nombres.ts:53`) deliberately returns the
    UNSUFFIXED `room-planner-v4`, so on the guest origin an anonymous visitor's
    own apartment and an invitation to the household's `main` are the same key.
    Two failures follow. If the invited plan is empty, the new-household branch
    on `hello` publishes the visitor's private sandbox INTO the shared plan. If
    it is not, adoption silently replaces their sandbox. And a guest whose token
    is wiped but whose blob survives boots local-only ON the household plan's
    data, a silent fork that re-syncs on the next click. The `main` exemption
    exists to protect bytes already written on the household origin; it has no
    reason to exist on the guest origin. Namespace guest storage by plan, and
    give local-only mode a key of its own.
14. **The local-only sandbox loses work silently**: Safari clears `localStorage`
    after 7 days without a visit, and so does clearing site data. The file export
    must be prominent there, and the chip must say "local to this browser" rather
    than any of the five sync states.
15. **A rate cap per token** in the DO. Brute-forcing 128 bits is not a threat; a
    valid link behaving badly is, and revoke is the answer, but a cap keeps a
    loop from filling the row. It needs the token on the socket attachment, which
    is the same thing revocation needs (edge 6): add it once, in batch 2.
16. **Household emails must stop crossing to guest sockets.** `hello` peers, op
    `by`, the replayed chat history, cursor labels and `updatedBy` in GET bodies
    all carry raw addresses today. Anyone holding a link would collect the
    couple's email addresses. Guests receive `{name, tag, guest}` and never an
    email; the guest door blanks `updatedBy` down to a display name.
17. **The name gate is client-side only.** A disabled Join button stops a person,
    not a script. If nobody may reach the wire unnamed, the SERVER enforces it:
    refuse ops until a name is presented, seeding from `invites.last_name`.
18. **A revoked guest in REST fallback would read "offline".** `doPut`/`doGet`
    map every failure to that state, so a permission answer would be dressed as a
    network one, in the codebase whose rule is that the chip never lies. 401 and
    403 from the guest door route to the dead-end screen, from REST as well as
    from the socket close.
19. **`chat` needs `name`/`guest` too.** It is persisted and replayed in full to
    the household on every `hello`, and `wsAppendChat` derives its label from the
    email.
20. **The name lives in the invite row, not in local storage.** iOS in-app
    browsers (a link opened from a message) partition and discard storage, so
    "a returning guest skips the name step" would be false exactly where links
    get opened. `invites.last_name` is the store; local storage is a cache.

## What this deliberately is not

Not accounts, not multi-tenancy, not a plan-hosting service (`MAX_PLANS = 40`
says so already). Anyone holding the link is in: that is what a capability URL
means, and revoke plus visible presence is the mitigation.

## Verified while writing this, not assumed

- No Access application covers the zone as a wildcard, so a new hostname is
  public the moment it exists. That is what makes the guest door possible, and
  what makes forgetting `porte()` fatal.
- **Preview deployments are NOT exposed.** An earlier draft claimed the Access
  app on the `pages.dev` domain fails to cover its subdomains. Tested: branch
  aliases return 302 to the Access login, for `/api/plan` as well as `/`. The
  `porte()` rule that refuses unknown Hosts is defence in depth, not a fix for a
  live hole.
- Preview deployments carry the `DB` binding but not `ROOM`, so a preview has D1
  but no realtime wire. Note the limit of any code fix here: **a preview
  deployment is immutable**, so previews built before this work keep serving
  their own un-guarded Functions against the production database. Middleware
  protects future deployments only; existing previews have to be deleted, or
  previews disabled, or covered by their own Access application.
- The `workers.dev` subdomain on the `plan-live` Worker is disabled, so the
  Durable Object's front `fetch` is not reachable outside the zone route.

## Implementation batches

**The hardening comes first, and it ships on its own.** Batch 1a adds no guest
surface at all: it is pure security payoff on the product as it stands today, and
it is what makes every later batch safe to half-build. Nothing that follows is
reachable until the guest hostname exists, so the hostname is created LAST.

1. **1a, hardening, no new surface.** `functions/_middleware.ts` with two
   verdicts (household / deny), stripping of every `Cf-Access-*` header and the
   `CF_Authorization` cookie on anything that is not the household host; the
   unsigned-JWT fallback deleted; `updated_by` may never be written as `live` by
   a REST route; the same door check in `worker.ts`'s `fetch`.
2. **1b, the invite.** `invites` table, `/api/invite/*`, the guest verdict, the
   session cookie exchange, `/api/plans` 403 on the guest door, blind PUT refused
   there.
3. **2, wire identity.** `name` + `guest` + the token on the socket attachment
   and on `peer`, `op`, `cursor`, `drag`, `chat`; `displayName` prefers a sent
   name; emails never sent to guests; guest rendering; `wsSameAccount` never true
   for guests; `plan5.replace` refused from a guest; revoke closes sockets.
4. **3, guest client.** Door detection, token capture, the name step, the
   dead-end screen (including from REST 401/403), UI trimming, local-only mode
   with its own storage key.
5. **4, owner client.** Share action and Revoke first; the invite list after.
6. **5, Cloudflare, LAST.** Existing preview deployments deleted (or previews
   disabled, or given their own Access application), `workers.dev` on `plan-live`
   confirmed still disabled, then the guest hostname created.

Tests are NOT a trailing batch: each edge case above is a test case, and server
assertions land in `live-worker/test-local.ts` inside the batch that creates the
behaviour, as `tests/repli-conflit.ts` did. The two-browser owner+guest suite
lands with batch 3.

Batches 1a through 2 touch DATA and SYNCHRONIZATION, so the full barrier
(`node tests/all.ts`) applies, not the fast path.

## Review

Reviewed by a second model before implementation. It found six factual errors in
the first draft, all corrected above: the `/ws` zone route bypassing Pages
Functions entirely, the `updated_by: "live"` magic value, the storage-key
collision on `main`, the inverted "your other device" failure, "undo covers it"
being false for the owner, and read-only being "one line". It also caught that
the blind PUT is `plan5.replace` by another name, that a WebSocket cannot carry a
header, and that middleware beats a convention. One of its findings did not
survive checking: `workers.dev` on `plan-live` is already disabled, so there is
no live bypass today.
