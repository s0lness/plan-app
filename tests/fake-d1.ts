// AN IN-MEMORY D1, BUT A REAL DATABASE.
//
// The benches that mount the REAL Pages Function (`functions/api/plan.ts`) over a simulated
// database used to each do it with a small JavaScript object whose `run()` wrote without ever
// reading the SQL. That was enough as long as the PUT was BLIND. It isn't anymore: the PUT now
// does a COMPARE-AND-SWAP (`… ON CONFLICT(id) DO UPDATE … WHERE plans.rev = ?4`) and reads its
// verdict from the number of rows touched. A double that always writes would prove nothing at
// all, least of all atomicity.
//
// So we lean on the runtime's SQLite (`node:sqlite`), with the EXACT schema from
// `live-worker/schema.sql`. What that buys us:
//   - `meta.changes` comes from the engine, not from a guess: a swap that doesn't bite returns 0;
//   - the race between two writers is arbitrated by SQLite, just like in production;
//   - the SQL is actually executed, so a syntax mistake shows up here and not in production.
//
// The rendered object mimics the D1 surface used by the Function: `env.DB.prepare(sql).bind(…).run()`
// and `.first()`. `store` exposes the 'main' row in the shape of the old doubles (the benches'
// assertions still read `store.row.rev`, `store.row.data`, `store.puts`).

import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";

export interface LigneD1 {
  data: string;
  rev: number;
  updated_at: string | null;
  updated_by: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plans(
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT
);`;

// `seed`: initial content of the 'main' row (JS object), or null for an empty database.
// `seedRev` / `seedBy`: the household's row as it already sits in the database when the benches wake up.
export function fakeD1(seed: unknown, seedRev?: number, seedBy?: string) {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  if (seed != null) {
    db.prepare("INSERT INTO plans(id,data,rev,updated_at,updated_by) VALUES('main',?1,?2,?3,?4)")
      .run(JSON.stringify(seed), seedRev == null ? 1 : seedRev,
           new Date().toISOString(), seedBy || "b@example.com");
  }
  const store = {
    puts: 0,
    get row() {
      const r = db.prepare("SELECT data, rev, updated_at, updated_by FROM plans WHERE id='main'").get() as unknown as LigneD1 | undefined;
      return r ? { data: r.data, rev: r.rev, updated_at: r.updated_at, updated_by: r.updated_by } : null;
    },
    // DIRECT write, bypassing the Function: it's what the Durable Object does with its own D1
    // binding (snapshot every 30 s), and it's the writer that doesn't play compare-and-swap.
    // The benches use it to simulate a snapshot coming from the realtime wire.
    writeDirect(dataObj: unknown, by?: string) {
      const res = db.prepare(
        "INSERT INTO plans(id,data,rev,updated_at,updated_by) VALUES('main',?1,1,?2,?3) " +
        "ON CONFLICT(id) DO UPDATE SET data=?1, rev=rev+1, updated_at=?2, updated_by=?3"
      ).run(JSON.stringify(dataObj), new Date().toISOString(), by || "live");
      return res.changes;
    },
  };
  const prepare = (sql: string) => ({
    args: [] as SQLOutputValue[],
    bind(...a: SQLOutputValue[]) { this.args = a; return this; },
    async first() {
      const r = db.prepare(sql).get(...this.args);
      return r === undefined ? null : r;
    },
    async run() {
      const res = db.prepare(sql).run(...this.args);
      if (res.changes) store.puts++;
      // D1 shape: the verdict of a compare-and-swap is read from meta.changes.
      return { success: true, meta: { changes: res.changes, last_row_id: Number(res.lastInsertRowid),
                                     duration: 0, rows_written: res.changes } };
    },
  });
  return { store, db, env: { DB: { prepare } } };
}
