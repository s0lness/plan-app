// THE DOOR. One function decides whether a request landed on a hostname Cloudflare Access
// actually protects (`porteDe`); a second reads identity, and reads it ONLY when it did
// (`identiteFoyer`). See docs/decisions/0004-partage-par-lien.md ("batch 1a, hardening, no new
// surface", then "batch 1b, the invite"): Pages Functions are bound to the PROJECT, not to a
// hostname, so `/api/plan`, `/api/plans`, `/api/invite(s)`, `/api/err` and `/ws` answer on every
// hostname the project serves. Adding a hostname Access does not cover exposes the household's
// API unless the code decides for itself.
//
// `identiteFoyer` is now THE ONE implementation of `who()`, previously duplicated three times
// (functions/api/plan.ts:45, functions/api/plans.ts:36, functions/api/err.ts:6).
//
// Three verdicts, in this order of precedence: `"foyer"` (Access-protected, unchanged since
// batch 1a) beats `"invite"` (no Access, a valid invite token is the only credential) beats
// `"inconnue"` (refused outright). A host that somehow appears in BOTH lists is `"foyer"`: the
// household's own hostname must never be downgraded by a misconfiguration of `GUEST_HOST`.

export type Porte = "foyer" | "invite" | "inconnue";

interface EnvAvecHotes {
  HOUSEHOLD_HOSTS?: string;
  GUEST_HOST?: string;
}

const hoteDe = (request: Request): string => {
  const brut = request.headers.get("Host") || "";
  // Port stripped: a preview or a local run can carry one, the allowlist never lists one.
  return brut.split(":")[0].trim().toLowerCase();
};

// Comma-separated allowlist read from the environment, cleaned once: trimmed, lowercased, empty
// entries dropped (a trailing comma in the dashboard variable must not become a wildcard match
// against every empty string).
const listeHotes = (env: unknown): string[] => {
  const brut = (env && typeof env === "object" ? (env as EnvAvecHotes).HOUSEHOLD_HOSTS : undefined) || "";
  return brut.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
};

// A SINGLE hostname, unlike HOUSEHOLD_HOSTS: the guest door is one label under the zone
// (docs/decisions/0004-partage-par-lien.md, a two-level name needs an advanced Cloudflare
// certificate), so there is never a list to join. UNSET, exactly like an absent HOUSEHOLD_HOSTS
// entry, means the verdict it would produce can never be reached, but the two absences do NOT
// mean the same thing: an absent HOUSEHOLD_HOSTS treats every host as the household door
// (compatibility default, batch 1a), while an absent GUEST_HOST simply removes "invite" from the
// set of possible verdicts. Nothing starts trusting a guest host that was never declared.
//
// EXPORTED so `functions/api/invites.ts` can hand the guest origin back to the owner client
// (batch 4): the client cannot know the guest hostname on its own (de-identified repo, and it is
// a different origin from the one the owner is on), so the server is the only place that may say
// it. Same cleaning as the door check itself: no caller builds its own copy that could drift.
export const hoteInviteDe = (env: unknown): string => {
  const brut = (env && typeof env === "object" ? (env as EnvAvecHotes).GUEST_HOST : undefined) || "";
  return brut.split(":")[0].trim().toLowerCase();
};

// An entry may start with `*.`, matching any subdomain of the rest: Pages preview deployments
// (`abc123.plan.pages.dev`), which ARE Access-protected (verified while writing decision 0004),
// carry a hostname the operator cannot list in advance one by one.
const correspond = (hote: string, motif: string): boolean => {
  if (motif.startsWith("*.")) {
    const suffixe = motif.slice(1); // keeps the leading dot: ".example.pages.dev"
    return hote.length > suffixe.length && hote.endsWith(suffixe);
  }
  return hote === motif;
};

export function porteDe(request: Request, env: unknown): Porte {
  const hotes = listeHotes(env);
  // ABSENT OR EMPTY ALLOWLIST = today's behaviour, EXACTLY. Four suites import these Functions
  // directly against synthetic Requests with no env configuration at all (tests/plan-abime.ts,
  // tests/repli-d1-live.ts, tests/repli-conflit.ts, tests/model-v5-fil-serveur.ts): the door must
  // not start refusing them the moment it exists. The door only discriminates once an operator
  // has DECLARED which hosts Access protects; until then every host is treated as the household
  // door, exactly as `who()` treated it before this file existed.
  if (!hotes.length) return "foyer";
  const hote = hoteDe(request);
  if (hotes.some((motif) => correspond(hote, motif))) return "foyer";
  const hoteInvite = hoteInviteDe(env);
  if (hoteInvite && hote === hoteInvite) return "invite";
  return "inconnue";
}

/**
 * The one place identity is read. `who()` used to fall back to decoding the
 * `Cf-Access-Jwt-Assertion` header or the `CF_Authorization` cookie with `atob`, WITHOUT
 * verifying the signature. That is correct ONLY behind Access, which verifies the token upstream
 * before the request ever reaches the Function. Off an Access-protected host that reasoning
 * collapses: the `Cf-Access-Authenticated-User-Email` header itself, the `Cf-Access-Jwt-Assertion`
 * header, and the `CF_Authorization` cookie are all CALLER-SUPPLIED there, and a `curl` with one
 * header would be believed.
 */
export function identiteFoyer(request: Request, porte: Porte): string {
  if (porte !== "foyer") {
    // Read NO header and NO cookie: off the household door there is no upstream verification
    // left to trust, so there is no fallback here that is safe to consult.
    return "inconnu";
  }
  let email = request.headers.get("Cf-Access-Authenticated-User-Email") || "";
  if (!email) {
    const jwt = request.headers.get("Cf-Access-Jwt-Assertion") ||
      (request.headers.get("Cookie") || "").match(/CF_Authorization=([^;]+)/)?.[1];
    if (jwt) {
      try {
        const payload = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        if (payload.email) email = String(payload.email);
      } catch {}
    }
  }
  if (!email) return "inconnu";
  // `live` IS THE DURABLE OBJECT'S RESERVED MARKER. `d1Verdict` (live-worker/worker.ts) reads
  // `updated_by === "live"` as "the DO NEVER writes anything else, and the REST Function NEVER
  // writes 'live'" to decide a D1 row is its OWN write, not a foreign one to reconcile. A REST
  // route that let this literal identity through would make its own write invisible to that
  // reconciliation: never adopted, never flagged as a conflict, never told to anyone.
  if (email.trim().toLowerCase() === "live") return "inconnu";
  return email;
}
