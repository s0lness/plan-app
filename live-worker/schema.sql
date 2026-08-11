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
--   rev        : write counter. Informative, this is NOT a lock: the last writer wins. The rev
--                that is authoritative for live clients is the Durable Object's, not this one.
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
