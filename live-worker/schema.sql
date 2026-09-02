-- Schema of the D1 `plan` database (id <d1_database_id>).
--
-- The tables were created by hand, with no record kept: this file is the EXACT reproduction
-- of the definitions read in production (SELECT sql FROM sqlite_master), so that a database
-- recreated from scratch is identical. It therefore does NOT contain any constraints that
-- production doesn't have.
--
-- Replay on a fresh database (REST, no wrangler): POST to
--   /accounts/{account_id}/d1/database/{db_id}/query   with {"sql": "<content of this file>"}
-- Each statement is idempotent (IF NOT EXISTS): replaying it on an existing database does nothing.
--
-- Do NOT add the `_cf_KV` table here: it belongs to the D1 runtime, not to the application schema.

-- The household's plan. A SINGLE row, id='main'.
--   data       : the complete state serialized as JSON (v4 shape {rooms,envelope} or v5
--                {outline,walls,openings,pieces,cells}, cf. ops.ts / sanitizeState).
--   rev        : write counter, AND the lock. Both writers compare-and-swap on it in a single
--                statement (`ON CONFLICT(id) DO UPDATE ... WHERE plans.rev=?`, verdict read from
--                `meta.changes`): the REST fallback since docs/decisions/0003, the Durable
--                Object's snapshot since it stopped writing blind. The last writer no longer
--                wins; the one whose revision moved under it is refused and rereads.
--                Live clients compare CONTENT (`fp`), never this number: the Durable Object's own
--                `opCount` counts something else entirely (cf. live-worker/worker.ts).
--   updated_by : 'live' when the write comes from the Durable Object's snapshot, otherwise the
--                Access email of the author (write from functions/api/plan.ts).
CREATE TABLE IF NOT EXISTS plans(
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT
);

-- Log of JS errors reported by the client (functions/api/err.ts). Purely diagnostic.
CREATE TABLE IF NOT EXISTS errors(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT,
  who TEXT,
  msg TEXT,
  src TEXT,
  stack TEXT,
  ua TEXT
);

-- Feedback dropped from inside the app itself (functions/api/feedback.ts): an unauthenticated
-- free-text note, no account required, reachable from EITHER door (household or guest link):
-- the whole point is that a visitor can report something too. Read periodically by whoever
-- maintains the plan; there is no in-app inbox to view it back.
--   at       : ISO timestamp of the write.
--   who      : the Access email on the household door, or the guest's already-known chosen name
--              (invites.last_name) on the guest door; empty when a guest never gave one.
--   porte    : which door it came from, 'foyer' or 'invite' (functions/porte.ts's own verdict),
--              so a reply knows which kind of visitor to look for.
--   plan_id  : which plan the note is about, the household's own plan id on the foyer door, or
--              the plan named by the invite the guest came through. No foreign key, same
--              reasoning as `invites`: a plan can be deleted while its feedback rows stay legible.
--   texte    : the note itself. Required, cleaned and capped by functions/nom.ts's cleanName.
--   contact  : optional free text, "how to reach you", never validated, not necessarily an email.
--   ua       : navigator.userAgent, for triage only (which build/browser hit the bug).
--   ip       : CF-Connecting-IP, kept short. Rate-limit and abuse bookkeeping only, never shown.
CREATE TABLE IF NOT EXISTS feedback(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT, who TEXT, porte TEXT, plan_id TEXT,
  texte TEXT NOT NULL, contact TEXT, ua TEXT, ip TEXT
);

-- Invites for sharing a plan by link, no Access account required (functions/api/invite.ts,
-- functions/api/invites.ts, functions/invitation.ts). See docs/decisions/0004-partage-par-lien.md
-- ("batch 1b, the invite").
--   token      : the capability itself, PRIMARY KEY, 128 bits base64url. Stored IN CLEAR,
--                deliberately: hashing it would mean the link can be shown exactly once, and the
--                owner will want to re-copy it later (a "Share" panel that lists live invites).
--                What this row protects is the SAME thing the link already protects, someone
--                holding the token can already reach the plan, so a leaked row leaks nothing a
--                leaked link would not. Reachable only through the household door
--                (functions/api/invites.ts checks porteDe()==="foyer" itself, not just the
--                middleware), which is why this is acceptable here and would not be for anything
--                the guest door itself could read back.
--   plan_id    : which plan the token unlocks. No foreign key (this database has none anywhere):
--                a plan can be deleted while a link stays live, and that is read back as a dead
--                end (functions/api/invite.ts), not as a database error.
--   role       : 'edit' is the only value accepted today. The column exists so read-only access
--                can be ADDED later without a migration; it is not "one line" either (it needs op
--                rejection in the Durable Object, PUT rejection here, and UI trimming), so it is
--                deferred on purpose, not implemented halfway.
--   expires_at : NULL = no expiry (the row never disappears on its own; revoke is the real
--                control). functions/api/invites.ts always sets a value (default 30 days) when it
--                creates a row, so NULL is reachable only from a row created some other way.
--   revoked    : 0/1. The real control, not expiry: `functions/api/invites.ts`'s DELETE flips
--                this rather than deleting the row, so "revoke" stays idempotent (a second revoke
--                of the same token is still 200, never a 404 that would confirm a guessed token
--                ever existed).
--   uses, last_used_at, last_name : best-effort bookkeeping written by
--                functions/api/invite.ts on redemption. `last_name` is the STORE for a guest's
--                self-declared name, not local storage: an iOS in-app browser (a link opened from
--                a message) partitions and discards storage, so "a returning guest skips the name
--                step" would be false exactly where links get opened (design edge 20).
--   last_guest_id : the DEVICE `last_name` belongs to (functions/api/invite.ts's `guestId`, the
--                same per-browser-profile id `src/ts/fil/identite.ts`'s `guestIdCourant()` puts on
--                the wire). Corrected 2026-08-14: a name prefill keyed by TOKEN ALONE handed the
--                first redeemer's name to whoever opened the same link next, silently, on both
--                screens (measured in production: one row carrying `last_name` and 5 `uses`, two
--                people sharing one identity). `last_name` is only ever echoed back to the caller
--                whose `guestId` matches this column; a different device gets asked, never guessed.
CREATE TABLE IF NOT EXISTS invites(
  token TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'edit',
  created_at TEXT, created_by TEXT,
  expires_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0, last_used_at TEXT, last_name TEXT, last_guest_id TEXT
);
