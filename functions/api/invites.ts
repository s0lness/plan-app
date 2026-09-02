// THE OWNER-FACING SIDE of sharing a plan by link: list, create and revoke invites for one plan.
// FOYER DOOR ONLY, whatever the method — an invite grants a stranger entry to a plan, so only
// someone Access already vouched for may mint or manage one. See
// docs/decisions/0004-partage-par-lien.md ("batch 1b, the invite").
//
// This file is DISTINCT from functions/api/invite.ts (singular): that one is the guest's
// redemption of a token, reachable only from the "invite" door; this one is management,
// reachable only from the "foyer" door. `functions/_middleware.ts` already keeps the "invite"
// door away from this path entirely, but each handler here checks `porteDe()` again anyway: every
// direct-import test in this codebase (tests/repli-conflit.ts, tests/invitation.ts, tests/porte.ts)
// calls a route file directly, bypassing the middleware, and a route that trusted it alone would
// be unguarded under test and under any future caller that reaches it a different way.
//
// This paragraph used to claim functions/api/plan.ts and functions/ws.ts already did the same. They
// did not: they distinguished only the "invite" door, and treated "inconnue" exactly like the
// household — `/api/plan` GET handed back the raw `updated_by` column (an Access address) and `/ws`
// forwarded the upgrade to the household's own Durable Object. Both check for themselves now, so
// the sentence is true; it is written down because a comment that describes a discipline nobody
// applies is worse than no comment, it stops the next reader from looking.

import type { Env } from "../env.ts";
import { hoteInviteDe, identiteFoyer, porteDe } from "../porte.ts";
import { jetonInvitation } from "../invitation.ts";

const PLAN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
// In the spirit of MAX_PLANS (functions/api/plans.ts): a live invite list, not a distribution
// list. Brute-forcing a 128-bit token is not the threat this bounds (design edge 15); a link
// handed around too widely and never revoked is, and this keeps a runaway loop from filling the
// row regardless.
const MAX_INVITES_PAR_PLAN = 20;
const EXPIRY_DEFAULT_JOURS = 30;

interface LigneInvitationDB {
  token: string;
  plan_id: string;
  role: string;
  created_at: string | null;
  created_by: string | null;
  expires_at: string | null;
  revoked: number;
  uses: number;
  last_used_at: string | null;
  last_name: string | null;
}

const json = (o: unknown, status?: number) => new Response(JSON.stringify(o),
  { status: status || 200, headers: { "content-type": "application/json" } });
const refuse = () => json({ error: "porte_refusee" }, 403);

// THE OWNER CLIENT CANNOT KNOW THE GUEST HOSTNAME ON ITS OWN (batch 4): this repository is
// de-identified, and the guest door is a DIFFERENT origin from the one the owner is browsing, so
// there is no `location.host` to read it from. `hoteInviteDe` is the same cleaning `porteDe`
// itself applies to `GUEST_HOST`; `null` (never `""`) is what an unset variable becomes, so the
// client can tell "not configured" apart from "configured to an empty string" with one falsy check.
const guestHost = (env: Env): string | null => hoteInviteDe(env) || null;

const versJson = (r: LigneInvitationDB) => ({
  token: r.token,
  createdAt: r.created_at,
  createdBy: r.created_by,
  expiresAt: r.expires_at,
  revoked: !!r.revoked,
  uses: r.uses,
  lastUsedAt: r.last_used_at,
  lastName: r.last_name,
});

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (porteDe(request, env) !== "foyer") return refuse();
  const planId = (new URL(request.url).searchParams.get("p") || "").trim().toLowerCase();
  if (!PLAN_ID_RE.test(planId)) return json({ error: "bad_plan_id" }, 400);
  const r = await env.DB
    .prepare(
      "SELECT token, plan_id, role, created_at, created_by, expires_at, revoked, uses, last_used_at, last_name " +
      "FROM invites WHERE plan_id=?1 ORDER BY created_at DESC"
    )
    .bind(planId).all<LigneInvitationDB>();
  return json({ invites: (r.results || []).map(versJson), guestHost: guestHost(env) });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (porteDe(request, env) !== "foyer") return refuse();
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
  const planId = String(body.planId || "").trim().toLowerCase();
  if (!PLAN_ID_RE.test(planId)) return json({ error: "bad_plan_id" }, 400);

  const plan = await env.DB.prepare("SELECT 1 FROM plans WHERE id=?1").bind(planId).first();
  if (!plan) return json({ error: "plan_not_found" }, 404);

  const now = new Date();
  // A CAP ON LIVE INVITES, not on ever-created ones: a revoked or expired invite frees a slot,
  // exactly like MAX_PLANS counts rows that still exist, not rows that ever existed.
  const live = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM invites WHERE plan_id=?1 AND revoked=0 AND (expires_at IS NULL OR expires_at > ?2)"
  ).bind(planId, now.toISOString()).first<{ n: number }>();
  if ((live?.n || 0) >= MAX_INVITES_PAR_PLAN) return json({ error: "trop_d_invitations", max: MAX_INVITES_PAR_PLAN }, 409);

  const joursDemandes = Number(body.expiresInDays);
  const jours = Number.isFinite(joursDemandes) && joursDemandes > 0
    ? Math.floor(joursDemandes) : EXPIRY_DEFAULT_JOURS;
  const expiresAt = new Date(now.getTime() + jours * 86_400_000).toISOString();
  const token = jetonInvitation();
  const by = identiteFoyer(request, porteDe(request, env));

  await env.DB.prepare(
    "INSERT INTO invites(token,plan_id,role,created_at,created_by,expires_at,revoked,uses) " +
    "VALUES(?1,?2,'edit',?3,?4,?5,0,0)"
  ).bind(token, planId, now.toISOString(), by, expiresAt).run();

  return json({
    invite: versJson({
      token, plan_id: planId, role: "edit", created_at: now.toISOString(), created_by: by,
      expires_at: expiresAt, revoked: 0, uses: 0, last_used_at: null, last_name: null,
    }),
    guestHost: guestHost(env),
  }, 201);
};

export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  if (porteDe(request, env) !== "foyer") return refuse();
  let token = (new URL(request.url).searchParams.get("token") || "").trim();
  if (!token) {
    try {
      const body = await request.json();
      if (body && typeof body === "object" && typeof (body as Record<string, unknown>).token === "string") {
        token = ((body as Record<string, unknown>).token as string).trim();
      }
    } catch {}
  }
  // IDEMPOTENT, ON PURPOSE: revoking an unknown or already-revoked token still returns 200. A 404
  // here would let a caller learn whether a guessed token ever existed — exactly what
  // functions/api/invite.ts's single 404 shape already refuses to leak on the guest side, so the
  // owner side must not reopen the same leak from the other direction.
  // Did the LIVE half of the revocation actually happen? The row is revoked regardless, which is
  // why this stays a 200; but "revoked" and "revoked, and every open socket was closed" are not
  // the same promise, and the owner is the one who has to know which one they got. Saying nothing
  // was the defect: the call's status was never even read, so a Worker outage looked exactly like
  // a clean revoke, and the guest kept editing.
  let live = false;
  if (token) {
    // The plan id BEFORE the write: needed to reach the right Durable Object, and reading it after
    // marking the row revoked would work just as well, but there is no reason to make the D1 write
    // wait on it.
    const ligne = await env.DB.prepare("SELECT plan_id FROM invites WHERE token=?1").bind(token).first<{ plan_id: string }>();
    await env.DB.prepare("UPDATE invites SET revoked=1 WHERE token=?1").bind(token).run();
    // Design edge 6: "Revoke must close live sockets, not merely block new ones." BEST-EFFORT — the
    // row is already revoked regardless of whether this call succeeds, so a Worker hiccup here must
    // never turn an otherwise-successful revoke into an error response. If it fails, the ONLY
    // leftover risk is an already-open socket staying open until it drops on its own (heartbeat,
    // reconnect): every OTHER guest-facing route (`/api/invite`, `/api/plan`, a fresh `/ws` upgrade)
    // already re-checks `invitationValide()` against the now-revoked row, so nothing NEW can be
    // reached through it.
    if (ligne && ligne.plan_id && env.ROOM) {
      try {
        const stub = env.ROOM.get(env.ROOM.idFromName(ligne.plan_id));
        const r = await stub.fetch(new Request("https://plan-live-internal/revoke", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Plan-Internal": "1" },
          body: JSON.stringify({ token }),
        }));
        live = !!(r && r.ok);
      } catch { /* best-effort, see above */ }
    }
  }
  return json({ ok: true, live });
};
