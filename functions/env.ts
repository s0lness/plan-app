/** Bindings set on the Pages project, never through a local `wrangler.toml`. */
export interface Env {
  DB: D1Database;
  ROOM: DurableObjectNamespace;
}
