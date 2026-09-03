// THE ONE RATE LIMIT LEFT IN THIS CODEBASE (the feedback drop that shared it is gone, decision
// 0022): `functions/api/err.ts` is a write a page can drive in a loop with no one typing
// anything, so it still needs a counting query. Kept as its own module rather than folded back
// into `err.ts` so a second unauthenticated-ish write, if one is ever added, has somewhere to
// import this from instead of copying it.

import type { Env } from "./env.ts";

const HEURE_MS = 3_600_000;

// Five per hour: a crash loop repeats the SAME error, so the fifth copy already says what the
// five hundredth would.
export const PAR_HEURE_MAX = 5;

/**
 * `table` and `colonne` are a CLOSED UNION, never caller data: they are interpolated into the SQL
 * because a table or column name cannot be a bind parameter, and the type is what guarantees only
 * this spelling ever reaches it.
 *
 * Returns how many rows that handle already wrote inside the window; the caller compares it to
 * its own cap. An empty handle counts as 0: refusing a caller we cannot even name would refuse
 * everyone at once.
 */
export async function comptageRecent(
  env: Env, table: "errors", colonne: "who", valeur: string,
  fenetreMs: number = HEURE_MS,
): Promise<number> {
  if (!valeur) return 0;
  const depuis = new Date(Date.now() - fenetreMs).toISOString();
  const r = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${colonne}=?1 AND at>?2`)
    .bind(valeur, depuis).first<{ n: number }>();
  return (r && typeof r.n === "number") ? r.n : 0;
}
