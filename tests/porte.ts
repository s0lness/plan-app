#!/usr/bin/env node
// =================================================================================================
//  THE DOOR: NO BROWSER, by import against functions/porte.ts and functions/_middleware.ts.
// =================================================================================================
//   node tests/porte.ts
//
// Covers docs/decisions/0004-partage-par-lien.md, "batch 1a, hardening, no new surface":
// `porteDe` (the allowlist and its `*.` wildcard), `identiteFoyer` (the ONE `who()`, and why it
// must never trust anything off the household door), and `functions/_middleware.ts` (the 403 on
// /api/ off an unrecognized host, the header/cookie strip, and that the household door is left
// untouched).
//
// Section 4 covers the OTHER half of the same rule: every route refuses an unrecognized door
// ITSELF. This suite imports the route files directly, so the middleware does not exist here,
// which is precisely what makes the point provable, and what made the hole invisible for as long
// as the choke point was the only guard.

import { porteDe, identiteFoyer } from "../functions/porte.ts";
import { onRequest as middleware } from "../functions/_middleware.ts";
import { onRequestGet as planGet, onRequestPut as planPut } from "../functions/api/plan.ts";
import {
  onRequestDelete as plansDelete, onRequestGet as plansGet,
  onRequestPatch as plansPatch, onRequestPost as plansPost,
} from "../functions/api/plans.ts";
import { onRequestPost as errPost } from "../functions/api/err.ts";
import { onRequest as wsUpgrade } from "../functions/ws.ts";
import type { DonneeDynamique, ResultatSimple } from "./_types.ts";

// =================================================================================================
//  ASSERTION PLUMBING (same vocabulary as tests/rapide.ts: `test` / `expect`)
// =================================================================================================
const results: ResultatSimple[] = [];
async function test(name: string, corps: () => boolean | string | void | Promise<boolean | string | void>): Promise<void> {
  let pass = false, detail = "";
  try { const r = await corps(); if (r === true || r === undefined) pass = true; else detail = String(r); }
  catch (e) { detail = String((e && (e as Error).stack) || e); }
  results.push({ name, pass, detail });
  process.stdout.write((pass ? "  ok   " : "  FAIL ") + name + "\n");
  if (!pass) process.stdout.write("       " + detail.replace(/\n/g, "\n       ") + "\n");
}
function expect(cond: unknown, msg: string): true { if (!cond) throw new Error(msg); return true; }

// A base64url-encoded JWT shape, unsigned: exactly what a forged `Cf-Access-Jwt-Assertion` header
// or `CF_Authorization` cookie looks like. `identiteFoyer` never verifies the signature (that is
// Access's job, upstream), its only defence off the household door is to never read it at all.
const jwtForge = (email: string) => {
  const b64url = (s: string) => Buffer.from(s).toString("base64url");
  return b64url(JSON.stringify({ alg: "none" })) + "." + b64url(JSON.stringify({ email })) + ".sig";
};

// A minimal Pages Functions context: enough for `middleware` to run, nothing `onRequest` doesn't
// touch. `next` is a stand-in that records whether it was called and with what request.
function ctx(request: Request, env: DonneeDynamique, next: (input?: Request | string) => Promise<Response>) {
  return {
    request, env, next,
    params: {}, data: {}, functionPath: "", waitUntil: () => {}, passThroughOnException: () => {},
  } as DonneeDynamique;
}
function fauxNext() {
  const appel = { appelee: false, requete: null as Request | null };
  const next = async (input?: Request | string) => {
    appel.appelee = true;
    if (input && typeof input !== "string") appel.requete = input;
    return new Response("next-ok");
  };
  return { appel, next };
}
const requeteVers = (url: string, headers?: Record<string, string>) => new Request(url, { headers });

// =================================================================================================
//  1. porteDe, the allowlist and its `*.` wildcard
// =================================================================================================

await test("porte_liste_absente_est_foyer", () => {
  // Preserves today's behaviour EXACTLY: four suites (tests/plan-abime.ts, tests/repli-d1-live.ts,
  // tests/repli-conflit.ts, tests/model-v5-fil-serveur.ts) import these Functions directly with
  // no env configuration at all. The door must not start refusing them the moment it exists.
  const r = requeteVers("https://plan.example.com/api/plan", { Host: "plan.example.com" });
  return expect(porteDe(r, {}) === "foyer", "sans HOUSEHOLD_HOSTS, porte doit être foyer");
});

await test("porte_liste_vide_est_foyer", () => {
  const r = requeteVers("https://plan.example.com/api/plan", { Host: "plan.example.com" });
  return expect(porteDe(r, { HOUSEHOLD_HOSTS: "" }) === "foyer", "liste vide == liste absente");
});

await test("porte_correspondance_exacte", () => {
  const env = { HOUSEHOLD_HOSTS: "plan.example.com" };
  const r = requeteVers("https://plan.example.com/api/plan", { Host: "plan.example.com" });
  return expect(porteDe(r, env) === "foyer", "hôte listé -> foyer");
});

await test("porte_hote_non_liste_est_inconnue", () => {
  const env = { HOUSEHOLD_HOSTS: "plan.example.com" };
  const r = requeteVers("https://share.example.com/api/plan", { Host: "share.example.com" });
  return expect(porteDe(r, env) === "inconnue", "hôte absent de la liste -> inconnue");
});

await test("porte_joker_sous_domaine", () => {
  // Pages preview deployments, which ARE Access-protected (verified while writing decision 0004).
  const env = { HOUSEHOLD_HOSTS: "*.example.pages.dev" };
  const abc = requeteVers("https://abc123.example.pages.dev/", { Host: "abc123.example.pages.dev" });
  return expect(porteDe(abc, env) === "foyer", "un sous-domaine du joker doit passer");
});

await test("porte_joker_n_accepte_pas_le_domaine_nu", () => {
  const env = { HOUSEHOLD_HOSTS: "*.example.pages.dev" };
  const nu = requeteVers("https://example.pages.dev/", { Host: "example.pages.dev" });
  return expect(porteDe(nu, env) === "inconnue", "le domaine nu, sans sous-domaine, n'est pas '*.'");
});

await test("porte_joker_n_accepte_pas_un_prefixe_colle", () => {
  // `evilexample.pages.dev` must NOT match `*.example.pages.dev`: the leading dot in the suffix
  // is what enforces a real label boundary, not a bare substring match.
  const env = { HOUSEHOLD_HOSTS: "*.example.pages.dev" };
  const collee = requeteVers("https://evilexample.pages.dev/", { Host: "evilexample.pages.dev" });
  return expect(porteDe(collee, env) === "inconnue", "un préfixe collé sans point ne doit pas matcher");
});

await test("porte_port_retire", () => {
  const env = { HOUSEHOLD_HOSTS: "plan.example.com" };
  const r = requeteVers("https://plan.example.com:8788/api/plan", { Host: "plan.example.com:8788" });
  return expect(porteDe(r, env) === "foyer", "le port doit être retiré avant comparaison");
});

await test("porte_liste_est_nettoyee", () => {
  // Trailing/leading commas and mixed case must not become traps: an empty entry never becomes a
  // wildcard match against every empty string, and the comparison is case-insensitive.
  const env = { HOUSEHOLD_HOSTS: " Plan.Example.com ,,share.example.com" };
  const r = requeteVers("https://plan.example.com/", { Host: "plan.example.com" });
  return expect(porteDe(r, env) === "foyer", "casse et espaces ne doivent pas empêcher la correspondance");
});

// =================================================================================================
//  1bis. porteDe, the "invite" verdict (batch 1b)
// =================================================================================================

await test("porte_invite_correspond_au_guest_host", () => {
  const env = { HOUSEHOLD_HOSTS: "plan.example.com", GUEST_HOST: "share.example.com" };
  const r = requeteVers("https://share.example.com/api/invite", { Host: "share.example.com" });
  return expect(porteDe(r, env) === "invite", "l'hôte GUEST_HOST doit donner le verdict invite");
});

await test("porte_invite_guest_host_absent_est_inaccessible", () => {
  // GUEST_HOST UNSET means "invite" can never be the verdict: the same host that would be an
  // invite door once configured is just an unrecognized one until an operator declares it,
  // exactly like HOUSEHOLD_HOSTS before it existed.
  const env = { HOUSEHOLD_HOSTS: "plan.example.com" };
  const r = requeteVers("https://share.example.com/api/invite", { Host: "share.example.com" });
  return expect(porteDe(r, env) === "inconnue", "sans GUEST_HOST, aucun hôte ne doit jamais donner invite");
});

await test("porte_invite_guest_host_vide_est_inaccessible", () => {
  const env = { HOUSEHOLD_HOSTS: "plan.example.com", GUEST_HOST: "" };
  const r = requeteVers("https://share.example.com/api/invite", { Host: "share.example.com" });
  return expect(porteDe(r, env) === "inconnue", "GUEST_HOST vide doit se comporter comme absent");
});

await test("porte_foyer_gagne_le_conflit", () => {
  // A host that appears in BOTH lists (a misconfiguration, but one that must fail SAFE): the
  // household's own hostname must never be downgraded to "invite" by a stray GUEST_HOST entry.
  const env = { HOUSEHOLD_HOSTS: "plan.example.com", GUEST_HOST: "plan.example.com" };
  const r = requeteVers("https://plan.example.com/api/plan", { Host: "plan.example.com" });
  return expect(porteDe(r, env) === "foyer", "un hôte présent dans les deux listes doit rester foyer");
});

await test("porte_invite_port_retire", () => {
  const env = { HOUSEHOLD_HOSTS: "plan.example.com", GUEST_HOST: "share.example.com" };
  const r = requeteVers("https://share.example.com:8788/api/invite", { Host: "share.example.com:8788" });
  return expect(porteDe(r, env) === "invite", "le port doit être retiré avant comparaison, comme pour HOUSEHOLD_HOSTS");
});

await test("porte_invite_hote_different_reste_inconnue", () => {
  const env = { HOUSEHOLD_HOSTS: "plan.example.com", GUEST_HOST: "share.example.com" };
  const r = requeteVers("https://autre.example.com/api/plan", { Host: "autre.example.com" });
  return expect(porteDe(r, env) === "inconnue", "un hôte qui n'est ni le foyer ni l'invité reste inconnue");
});

// =================================================================================================
//  2. identiteFoyer, reads nothing off an unrecognized door, and never returns `live`
// =================================================================================================

await test("identite_hote_inconnu_ignore_l_en_tete_direct", () => {
  const r = requeteVers("https://share.example.com/api/plan",
    { "Cf-Access-Authenticated-User-Email": "sylve@example.com" });
  return expect(identiteFoyer(r, "inconnue") === "inconnu",
    "hors du foyer, même l'en-tête direct ne doit JAMAIS être cru");
});

await test("identite_hote_inconnu_ignore_le_cookie_forge", () => {
  // No direct header, no Cf-Access-Jwt-Assertion header: only a forged CF_Authorization cookie,
  // exactly what a `curl` at the guest door could send.
  const r = requeteVers("https://share.example.com/api/plan",
    { Cookie: "CF_Authorization=" + jwtForge("attaquant@ailleurs.com") });
  return expect(identiteFoyer(r, "inconnue") === "inconnu",
    "un cookie CF_Authorization forgé ne doit jamais être décodé hors du foyer");
});

await test("identite_foyer_lit_normalement", () => {
  // Sanity check, so the two tests above are proven to test something REAL: on the household
  // door, the same header IS read.
  const r = requeteVers("https://plan.example.com/api/plan",
    { "Cf-Access-Authenticated-User-Email": "sylve@example.com" });
  return expect(identiteFoyer(r, "foyer") === "sylve@example.com",
    "sur la porte foyer, l'en-tête Access doit être lu normalement");
});

await test("identite_foyer_retombe_sur_le_jwt", () => {
  const r = requeteVers("https://plan.example.com/api/plan",
    { Cookie: "CF_Authorization=" + jwtForge("elise@example.com") });
  return expect(identiteFoyer(r, "foyer") === "elise@example.com",
    "sur la porte foyer, le repli JWT/cookie doit toujours fonctionner (verifié en amont par Access)");
});

await test("identite_marqueur_live_jamais_sur_le_foyer", () => {
  const brut = requeteVers("https://plan.example.com/api/plan",
    { "Cf-Access-Authenticated-User-Email": "live" });
  const espaces = requeteVers("https://plan.example.com/api/plan",
    { "Cf-Access-Authenticated-User-Email": " LIVE " });
  // `d1Verdict` (live-worker/worker.ts) treats updated_by === "live" as "the Durable Object's own
  // write". A REST route writing that literal would make its own write invisible to reconciliation.
  return expect(identiteFoyer(brut, "foyer") === "inconnu", "'live' exact ne doit jamais survivre")
      && expect(identiteFoyer(espaces, "foyer") === "inconnu", "' LIVE ' ne doit pas survivre non plus (trim+lowercase)");
});

await test("identite_marqueur_live_jamais_hors_foyer", () => {
  const r = requeteVers("https://share.example.com/api/plan",
    { "Cf-Access-Authenticated-User-Email": "live" });
  return expect(identiteFoyer(r, "inconnue") === "inconnu", "'live' ne doit survivre sur AUCUNE porte");
});

await test("identite_hote_invite_ignore_aussi_l_en_tete_direct", () => {
  // Same rule as "inconnue": a valid invite token is not an Access identity, and the "invite"
  // verdict must not become a second way to smuggle a household email through.
  const r = requeteVers("https://share.example.com/api/plan",
    { "Cf-Access-Authenticated-User-Email": "sylve@example.com" });
  return expect(identiteFoyer(r, "invite") === "inconnu",
    "sur la porte invite, même l'en-tête direct ne doit JAMAIS être cru");
});

// =================================================================================================
//  3. functions/_middleware.ts, the choke point
// =================================================================================================

await test("middleware_403_sur_api_hote_inconnu", async () => {
  const env = { HOUSEHOLD_HOSTS: "plan.example.com" };
  const r = requeteVers("https://share.example.com/api/plan", { Host: "share.example.com" });
  const { appel, next } = fauxNext();
  const res = await middleware(ctx(r, env, next));
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 403, "doit répondre 403, vu " + res.status)
      && expect(corps && corps.error === "porte_inconnue", "corps attendu {error:'porte_inconnue'}, vu " + JSON.stringify(corps))
      && expect(res.headers.get("content-type") === "application/json", "content-type doit être json")
      && expect(!appel.appelee, "next() ne doit PAS être appelé : aucune surface invité n'existe encore");
});

// Le fil, pas seulement /api/. Sur l'hôte du foyer une route de zone envoie `/ws*` directement
// au Worker `plan-live`, donc ce middleware ne le voit jamais ; sur tout AUTRE hôte il arrive ici,
// et `functions/ws.ts` transmettrait la bascule au Durable Object pour `?p=main` avec une simple
// identité `inconnu`. Un socket sans nom reste un socket SUR LE PLAN DU FOYER.
await test("middleware_403_sur_le_fil_hote_inconnu", async () => {
  const env = { HOUSEHOLD_HOSTS: "plan.example.com" };
  for (const chemin of ["/ws", "/ws?p=main"]) {
    const r = requeteVers("https://share.example.com" + chemin, {
      Host: "share.example.com", Upgrade: "websocket",
    });
    const { appel, next } = fauxNext();
    const res = await middleware(ctx(r, env, next));
    const ok = expect(res.status === 403, chemin + " doit répondre 403, vu " + res.status)
      && expect(!appel.appelee, chemin + " : next() ne doit PAS être appelé");
    if (!ok) return false;
  }
  return true;
});

await test("middleware_laisse_passer_le_statique_hote_inconnu", async () => {
  const env = { HOUSEHOLD_HOSTS: "plan.example.com" };
  const r = requeteVers("https://share.example.com/index.html", { Host: "share.example.com" });
  const { appel, next } = fauxNext();
  const res = await middleware(ctx(r, env, next));
  return expect(appel.appelee, "next() doit être appelé pour un chemin hors /api/")
      && expect(await res.text() === "next-ok", "la réponse doit venir de next()");
});

await test("middleware_ne_touche_rien_sur_la_porte_foyer", async () => {
  const env = { HOUSEHOLD_HOSTS: "plan.example.com" };
  const r = requeteVers("https://plan.example.com/api/plan",
    { Host: "plan.example.com", "Cf-Access-Authenticated-User-Email": "sylve@example.com" });
  const { appel, next } = fauxNext();
  await middleware(ctx(r, env, next));
  return expect(appel.appelee, "next() doit être appelé sur la porte foyer")
      && expect(appel.requete === null, "next() est appelé SANS argument sur le foyer : rien n'est réécrit")
      && expect(r.headers.get("Cf-Access-Authenticated-User-Email") === "sylve@example.com",
        "et l'en-tête d'origine n'est pas altéré");
});

await test("middleware_retire_les_en_tetes_cf_access_et_seulement_cf_authorization", async () => {
  const env = { HOUSEHOLD_HOSTS: "plan.example.com" };
  const r = requeteVers("https://share.example.com/", {
    Host: "share.example.com",
    "Cf-Access-Authenticated-User-Email": "sylve@example.com",
    "Cf-Access-Jwt-Assertion": jwtForge("sylve@example.com"),
    Cookie: "other=stays; CF_Authorization=" + jwtForge("sylve@example.com") + "; foo=bar",
  });
  const { appel, next } = fauxNext();
  await middleware(ctx(r, env, next));
  const vue = appel.requete;
  return expect(!!vue, "next() doit recevoir une requête reconstruite")
      && expect(vue!.headers.get("cf-access-authenticated-user-email") === null,
        "l'en-tête d'identité Access doit disparaître")
      && expect(vue!.headers.get("cf-access-jwt-assertion") === null,
        "l'en-tête du JWT Access doit disparaître")
      && expect(vue!.headers.get("cookie") === "other=stays; foo=bar",
        "seul CF_Authorization doit être retiré du cookie, vu " + JSON.stringify(vue!.headers.get("cookie")));
});

// =================================================================================================
//  3bis. functions/_middleware.ts, the "invite" door (batch 1b): a NAMED surface, not
//  "everything except the owner routes". /api/invite, /api/plan and /ws pass through UNVALIDATED
//  (the token itself is checked downstream, by the route that can read D1); everything else under
//  /api/ is 403, /api/plans and /api/invites explicitly included.
// =================================================================================================

const ENV_INVITE = { HOUSEHOLD_HOSTS: "plan.example.com", GUEST_HOST: "share.example.com" };

await test("middleware_invite_laisse_passer_api_invite", async () => {
  const r = requeteVers("https://share.example.com/api/invite", { Host: "share.example.com" });
  const { appel, next } = fauxNext();
  await middleware(ctx(r, ENV_INVITE, next));
  return expect(appel.appelee, "next() doit être appelé pour /api/invite sur la porte invite");
});

await test("middleware_invite_laisse_passer_api_plan", async () => {
  const r = requeteVers("https://share.example.com/api/plan", { Host: "share.example.com" });
  const { appel, next } = fauxNext();
  await middleware(ctx(r, ENV_INVITE, next));
  return expect(appel.appelee, "next() doit être appelé pour /api/plan sur la porte invite");
});

await test("middleware_invite_laisse_passer_le_fil", async () => {
  for (const chemin of ["/ws", "/ws?p=main"]) {
    const r = requeteVers("https://share.example.com" + chemin, {
      Host: "share.example.com", Upgrade: "websocket",
    });
    const { appel, next } = fauxNext();
    await middleware(ctx(r, ENV_INVITE, next));
    const ok = expect(appel.appelee, chemin + " : next() doit être appelé sur la porte invite");
    if (!ok) return false;
  }
  return true;
});

await test("middleware_invite_refuse_api_feedback", async () => {
  // Le retour utilisateur a quitté l'app (decision 0022) : `/api/feedback` n'existe plus DU TOUT,
  // donc la porte invitée ne doit plus le laisser passer, comme n'importe quel autre chemin
  // `/api/` non nommé dans sa surface.
  const r = requeteVers("https://share.example.com/api/feedback", { Host: "share.example.com" });
  const { appel, next } = fauxNext();
  const res = await middleware(ctx(r, ENV_INVITE, next));
  return expect(res.status === 403, "doit répondre 403, vu " + res.status)
      && expect(!appel.appelee, "next() ne doit PAS être appelé pour /api/feedback sur la porte invite");
});

await test("middleware_invite_refuse_api_plans", async () => {
  const r = requeteVers("https://share.example.com/api/plans", { Host: "share.example.com" });
  const { appel, next } = fauxNext();
  const res = await middleware(ctx(r, ENV_INVITE, next));
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 403, "doit répondre 403, vu " + res.status)
      && expect(corps && corps.error === "porte_refusee", "corps attendu {error:'porte_refusee'}, vu " + JSON.stringify(corps))
      && expect(!appel.appelee, "next() ne doit PAS être appelé pour /api/plans sur la porte invite");
});

await test("middleware_invite_refuse_api_invites", async () => {
  const r = requeteVers("https://share.example.com/api/invites", { Host: "share.example.com" });
  const { appel, next } = fauxNext();
  const res = await middleware(ctx(r, ENV_INVITE, next));
  return expect(res.status === 403, "doit répondre 403, vu " + res.status)
      && expect(!appel.appelee, "next() ne doit PAS être appelé pour /api/invites sur la porte invite");
});

await test("middleware_invite_refuse_api_err", async () => {
  const r = requeteVers("https://share.example.com/api/err", { Host: "share.example.com" });
  const { appel, next } = fauxNext();
  const res = await middleware(ctx(r, ENV_INVITE, next));
  return expect(res.status === 403, "doit répondre 403, vu " + res.status)
      && expect(!appel.appelee, "next() ne doit PAS être appelé pour /api/err sur la porte invite");
});

await test("middleware_invite_retire_les_en_tetes_access", async () => {
  // Les DEUX en-têtes Access, et sur les DEUX chemins que la porte invitée atteint. `/ws` compte
  // autant que `/api/plan` : c'est `functions/ws.ts` qui recopie les en-têtes entrants vers le
  // Durable Object (`new Request(url, request)`), donc un `Cf-Access-Jwt-Assertion` laissé passer
  // serait exactement celui qu'`identiteFoyer` sait décoder.
  for (const chemin of ["/api/plan", "/ws"]) {
    const r = requeteVers("https://share.example.com" + chemin, {
      Host: "share.example.com",
      Upgrade: "websocket",
      "Cf-Access-Authenticated-User-Email": "sylve@example.com",
      "Cf-Access-Jwt-Assertion": jwtForge("sylve@example.com"),
      Cookie: "other=stays; CF_Authorization=" + jwtForge("sylve@example.com"),
    });
    const { appel, next } = fauxNext();
    await middleware(ctx(r, ENV_INVITE, next));
    const vue = appel.requete;
    const ok = expect(!!vue, chemin + " : next() doit recevoir une requête reconstruite")
      && expect(vue!.headers.get("cf-access-authenticated-user-email") === null,
        chemin + " : l'en-tête d'identité Access doit disparaître aussi sur la porte invite")
      && expect(vue!.headers.get("cf-access-jwt-assertion") === null,
        chemin + " : l'en-tête du JWT Access doit disparaître aussi sur la porte invite")
      && expect(vue!.headers.get("cookie") === "other=stays",
        chemin + " : seul CF_Authorization doit être retiré du cookie");
    if (!ok) return false;
  }
  return true;
});

// =================================================================================================
//  4. CHAQUE ROUTE REFUSE LA PORTE INCONNUE ELLE-MÊME, sans middleware, par import direct
// =================================================================================================
// C'est exactement ce que ces tests prouvent : ils appellent les fichiers de route DIRECTEMENT,
// donc le point d'étranglement n'existe pas ici. Une route qui ne se gardait pas elle-même était
// donc sans garde sous test, et sous tout appelant futur qui l'atteindrait autrement (la route de
// zone décrite dans `live-worker/DEPLOY.md` §2, par exemple, enverrait `/ws*` droit au Worker).
//
// Avant : seul le verdict `invite` était distingué, et `inconnue` tombait dans la MÊME branche que
// le foyer. `/api/plan` GET rendait la colonne `updated_by` brute, une adresse Access, en clair ;
// `/ws` transmettait la bascule vers le Durable Object DU FOYER avec `?p=` honoré.

const ENV_HOTES = { HOUSEHOLD_HOSTS: "plan.example.com", GUEST_HOST: "share.example.com" };
const HOTE_INCONNU = "autre.example.com";

/** Une base D1 minimale pour `functions/api/err.ts` : elle compte et elle insère, rien d'autre. */
function fauxDbErreurs() {
  const lignes: { at: string; who: string }[] = [];
  const prepare = (sql: string) => ({
    args: [] as unknown[],
    bind(...a: unknown[]) { this.args = a; return this; },
    async first() {
      if (sql.includes("COUNT(*) AS n FROM errors")) {
        const who = String(this.args[0]), depuis = String(this.args[1]);
        return { n: lignes.filter((l) => l.who === who && l.at > depuis).length };
      }
      return null;
    },
    async all() { return { results: [] as unknown[] }; },
    async run() {
      if (sql.startsWith("INSERT INTO errors")) lignes.push({ at: String(this.args[0]), who: String(this.args[1]) });
      return { success: true, meta: { changes: 1 } };
    },
  });
  return { lignes, env: { ...ENV_HOTES, DB: { prepare } } as DonneeDynamique };
}

const requetePour = (url: string, host: string, methode: string, corps?: unknown, entetes?: Record<string, string>) => {
  const h = new Headers(entetes || {});
  h.set("Host", host);
  if (corps !== undefined) h.set("content-type", "application/json");
  return new Request(url, {
    method: methode, headers: h,
    body: corps === undefined ? undefined : JSON.stringify(corps),
  });
};

await test("plan_get_refuse_la_porte_inconnue", async () => {
  // AUCUNE base dans l'env : si la garde ne tranchait pas AVANT la lecture, on verrait une
  // exception, pas un 403. C'est la preuve que le refus vient en premier.
  const res = await planGet({
    request: requetePour("https://autre.example.com/api/plan?p=main", HOTE_INCONNU, "GET",
      undefined, { "Cf-Access-Authenticated-User-Email": "sylve@example.com" }),
    env: ENV_HOTES,
  } as DonneeDynamique);
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 403, "doit répondre 403, vu " + res.status)
      && expect(corps.error === "porte_refusee", "corps attendu porte_refusee, vu " + JSON.stringify(corps));
});

await test("plan_put_refuse_la_porte_inconnue", async () => {
  const res = await planPut({
    request: requetePour("https://autre.example.com/api/plan", HOTE_INCONNU, "PUT",
      { state: { outline: [], walls: [] }, rev: 0 }),
    env: ENV_HOTES,
  } as DonneeDynamique);
  return expect(res.status === 403, "doit répondre 403, vu " + res.status);
});

await test("fil_refuse_la_porte_inconnue_sans_toucher_au_durable_object", async () => {
  let appele = false;
  const room = { idFromName: (n: string) => n, get: () => ({ fetch: async () => { appele = true; return new Response("ok"); } }) };
  const res = await wsUpgrade({
    request: requetePour("https://autre.example.com/ws?p=main", HOTE_INCONNU, "GET", undefined, { Upgrade: "websocket" }),
    env: { ...ENV_HOTES, ROOM: room },
  } as DonneeDynamique);
  return expect(res.status === 403, "doit répondre 403, vu " + res.status)
      && expect(!appele, "le Durable Object du foyer ne doit JAMAIS être atteint depuis un hôte inconnu");
});

await test("err_refuse_la_porte_inconnue_et_la_porte_invitee", async () => {
  for (const hote of [HOTE_INCONNU, "share.example.com"]) {
    const { env, lignes } = fauxDbErreurs();
    const res = await errPost({
      request: requetePour("https://" + hote + "/api/err", hote, "POST", { msg: "boum" }), env,
    } as DonneeDynamique);
    const ok = expect(res.status === 403, hote + " doit répondre 403, vu " + res.status)
      && expect(lignes.length === 0, hote + " : rien ne doit être écrit en base");
    if (!ok) return false;
  }
  return true;
});

await test("err_borne_le_debit_via_le_compteur_partage", async () => {
  // functions/debit.ts, jamais une copie locale : une erreur dans un chemin de rendu part à
  // chaque image, et la purge de rétention ne borne que ce qui est GARDÉ, jamais le nombre
  // d'écritures demandées à D1.
  const { env, lignes } = fauxDbErreurs();
  const envoyer = () => errPost({
    request: requetePour("https://plan.example.com/api/err", "plan.example.com", "POST", { msg: "boucle" },
      { "Cf-Access-Authenticated-User-Email": "sylve@example.com" }),
    env,
  } as DonneeDynamique);
  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push((await envoyer()).status);
  return expect(codes.slice(0, 5).every((c) => c === 200), "les cinq premières doivent passer, vu " + JSON.stringify(codes))
      && expect(codes[5] === 429 && codes[6] === 429, "au-delà, 429, vu " + JSON.stringify(codes))
      && expect(lignes.length === 5, "et cinq lignes seulement en base, vu " + lignes.length);
});

await test("plans_refuse_la_porte_inconnue_dans_toutes_les_methodes", async () => {
  const env = { ...ENV_HOTES } as DonneeDynamique;   // pas de DB : la garde doit trancher avant
  const cas: [string, () => Promise<Response> | Response][] = [
    ["GET", () => plansGet({ request: requetePour("https://autre.example.com/api/plans", HOTE_INCONNU, "GET"), env } as DonneeDynamique)],
    ["POST", () => plansPost({ request: requetePour("https://autre.example.com/api/plans", HOTE_INCONNU, "POST", { name: "X" }), env } as DonneeDynamique)],
    ["PATCH", () => plansPatch({ request: requetePour("https://autre.example.com/api/plans", HOTE_INCONNU, "PATCH", { id: "x", name: "X" }), env } as DonneeDynamique)],
    ["DELETE", () => plansDelete({ request: requetePour("https://autre.example.com/api/plans", HOTE_INCONNU, "DELETE", { id: "x" }), env } as DonneeDynamique)],
  ];
  for (const [nom, appel] of cas) {
    const res = await appel();
    const ok = expect(res.status === 403, nom + " doit répondre 403, vu " + res.status);
    if (!ok) return false;
  }
  return true;
});

// =================================================================================================
//  VERDICT
// =================================================================================================
const passed = results.filter((r) => r.pass).length;
process.stdout.write("\n");
if (passed === results.length) {
  process.stdout.write("OK " + passed + "/" + results.length + "\n");
  process.exit(0);
} else {
  process.stdout.write("FAILURES " + (results.length - passed) + "/" + results.length + ":\n");
  results.filter((r) => !r.pass).forEach((r) => process.stdout.write("  - " + r.name + ": " + r.detail.split("\n")[0] + "\n"));
  process.exit(1);
}
