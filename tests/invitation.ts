#!/usr/bin/env node
// =================================================================================================
//  THE INVITE: NO BROWSER, against the real route files over an in-memory D1 (tests/fake-d1.ts).
// =================================================================================================
//   node tests/invitation.ts
//
// Covers docs/decisions/0004-partage-par-lien.md, "batch 1b, the invite": functions/api/invite.ts
// (the guest's redemption of a token), functions/api/invites.ts (the owner's management),
// functions/nom.ts (the shared name cleaner), and the "invite" door's effect on
// functions/api/plan.ts and functions/ws.ts. Style and assertion vocabulary match tests/porte.ts,
// which this suite is the direct continuation of.

import { onRequestPost as redeem } from "../functions/api/invite.ts";
import {
  onRequestDelete as invitesRevoke, onRequestGet as invitesList, onRequestPost as invitesCreate,
} from "../functions/api/invites.ts";
import { onRequestGet as planGet, onRequestPut as planPut } from "../functions/api/plan.ts";
import {
  onRequestDelete as plansDelete, onRequestPost as plansPost,
} from "../functions/api/plans.ts";
import { onRequestGet as orphansGet } from "../functions/api/orphans.ts";
import { onRequest as wsUpgrade } from "../functions/ws.ts";
import { cleanName } from "../functions/nom.ts";
import { fakeD1 } from "./fake-d1.ts";
import type { DonneeDynamique, ResultatSimple } from "./_types.ts";

// =================================================================================================
//  ASSERTION PLUMBING (same vocabulary as tests/porte.ts / tests/rapide.ts)
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

// =================================================================================================
//  FIXTURE PLUMBING
// =================================================================================================
const HOTE_FOYER = "plan.example.com";
const HOTE_INVITE = "share.example.com";
const HOTES_ENV = { HOUSEHOLD_HOSTS: HOTE_FOYER, GUEST_HOST: HOTE_INVITE };
const JOUR_MS = 86_400_000;

/** A fresh in-memory database, per test: `plans` and `invites` from the real schema, no seed. */
function base() {
  const { db, env } = fakeD1(null);
  return { db, env: { ...env, ...HOTES_ENV } };
}

const inserePlan = (db: DonneeDynamique, id: string, nom: string | null, auteur = "sylve@example.com") => {
  db.prepare("INSERT INTO plans(id,data,rev,updated_at,updated_by,name) VALUES(?1,?2,1,?3,?4,?5)")
    .run(id, JSON.stringify({ outline: [], walls: [], openings: [], pieces: [], cells: [] }),
      new Date().toISOString(), auteur, nom);
};

/**
 * A REALISTIC token from a readable label. `jetonInvitation()` only ever produces 22 base64url
 * characters, and `chargerInvitation` now refuses anything else, so a fixture like `"revoque1"`
 * would be turned away for its SHAPE and the test would pass for the wrong reason: a "revoked
 * token is refused" case that never reaches the revoked check proves nothing.
 *
 * Padding here rather than at the call sites keeps the labels legible while what is stored and
 * sent stays something the generator could actually have produced.
 */
const jeton = (etiquette: string) => (etiquette + "-".repeat(22)).slice(0, 22);

interface GraineInvite {
  token: string; planId: string; role?: string; expiresAt?: string | null;
  revoked?: number; uses?: number; lastName?: string | null; lastGuestId?: string | null;
}
const insereInvite = (db: DonneeDynamique, g: GraineInvite) => {
  db.prepare(
    "INSERT INTO invites(token,plan_id,role,created_at,created_by,expires_at,revoked,uses,last_used_at,last_name,last_guest_id) " +
    "VALUES(?1,?2,?3,?4,?5,?6,?7,?8,NULL,?9,?10)"
  ).run(jeton(g.token), g.planId, g.role || "edit", new Date().toISOString(), "sylve@example.com",
    g.expiresAt === undefined ? new Date(Date.now() + 30 * JOUR_MS).toISOString() : g.expiresAt,
    g.revoked || 0, g.uses || 0, g.lastName ?? null, g.lastGuestId ?? null);
};

const req = (url: string, opts: { method?: string; host: string; headers?: Record<string, string>; body?: unknown } = { host: HOTE_INVITE }) => {
  const headers = new Headers(opts.headers || {});
  headers.set("Host", opts.host);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, {
    method: opts.method || "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
};

const cookieDe = (token: string) => "plan_invite=" + jeton(token);

// =================================================================================================
//  1. functions/nom.ts, the shared name cleaner
// =================================================================================================

await test("nom_retire_les_controles_bidi", () => {
  // U+202E is RLO (right-to-left override): it would visually reorder the text AROUND the name
  // (design edge 2), not the name's own characters, which is exactly why a plain control-char
  // filter (c < 32) never caught it.
  const sale = "Marie‮eirat"; // "Marie" + RLO + "eirat" (would render reversed around it)
  return expect(cleanName(sale, 40) === "Marieeirat", "les points de code bidi doivent disparaître, vu " + JSON.stringify(cleanName(sale, 40)));
});

await test("nom_retire_toute_la_plage_bidi", () => {
  const tous = "‪‫‬‭‮⁦⁧⁨⁩";
  return expect(cleanName("a" + tous + "b", 40) === "ab", "les huit points de code bidi doivent tous disparaître");
});

await test("nom_borne_a_40_pour_un_invite", () => {
  const long = "x".repeat(60);
  return expect(cleanName(long, 40).length === 40, "un nom d'invité doit être coupé à 40, vu " + cleanName(long, 40).length);
});

await test("nom_borne_differemment_selon_l_appelant", () => {
  const long = "x".repeat(60);
  return expect(cleanName(long, 60).length === 60, "le même nettoyeur doit accepter une borne différente (60, plan)");
});

await test("nom_garde_toujours_les_controles_bas_et_del", () => {
  return expect(cleanName("a\x00\x1f\x7fb", 40) === "ab", "les caractères de contrôle historiques doivent rester filtrés");
});

// =================================================================================================
//  2. functions/api/invite.ts, the guest's redemption of a token
// =================================================================================================

await test("invite_refuse_sur_la_porte_foyer", async () => {
  const { env } = base();
  const r = req("https://plan.example.com/api/invite", { method: "POST", host: HOTE_FOYER, body: { token: "x" } });
  const res = await redeem({ request: r, env } as unknown as Parameters<typeof redeem>[0]);
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 403, "doit répondre 403, vu " + res.status)
      && expect(corps.error === "porte_refusee", "corps attendu porte_refusee, vu " + JSON.stringify(corps));
});

async function redeemAvecToken(db: DonneeDynamique, env: DonneeDynamique, token: string, corps?: unknown) {
  const r = req("https://share.example.com/api/invite", { method: "POST", host: HOTE_INVITE, body: corps ?? { token: jeton(token) } });
  return redeem({ request: r, env } as unknown as Parameters<typeof redeem>[0]);
}

await test("invite_jeton_inconnu_donne_404_invite_invalide", async () => {
  const { db, env } = base();
  const res = await redeemAvecToken(db, env, "n-existe-pas");
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 404, "doit répondre 404, vu " + res.status)
      && expect(corps.error === "invite_invalide", "corps attendu invite_invalide, vu " + JSON.stringify(corps));
});

await test("invite_jeton_de_mauvaise_forme_est_refuse_sans_toucher_la_base", async () => {
  // La FORME est vérifiée avant tout usage (`JETON_RE`). Deux bénéfices, et le second est le vrai :
  // une sonde est refusée sans requête D1, et un jeton porteur de `;`, CR ou LF ne peut pas être
  // recopié dans l'en-tête `Set-Cookie` de `functions/api/invite.ts`. Ce n'était pas atteignable
  // (il faudrait déjà une telle ligne en base), et c'est précisément pour ça que ça doit être
  // impossible plutôt que seulement inatteignable : la garantie ne doit pas dépendre du contenu
  // d'une table.
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  for (const mauvais of ["court", "avec;point-virgule-xxxx", "avec\r\nsaut-de-ligne", "x".repeat(65), ""]) {
    const r = req("https://share.example.com/api/invite", { method: "POST", host: HOTE_INVITE, body: { token: mauvais } });
    const res = await redeem({ request: r, env } as unknown as Parameters<typeof redeem>[0]);
    const corps = await res.json<DonneeDynamique>();
    const ok = expect(res.status === 404, JSON.stringify(mauvais) + " doit répondre 404, vu " + res.status)
      && expect(corps.error === "invite_invalide", JSON.stringify(mauvais) + " doit donner le MÊME corps qu'un jeton inconnu");
    if (!ok) return false;
  }
  return true;
});

await test("plan_cookie_mal_encode_ne_casse_pas", async () => {
  // `decodeURIComponent` LÈVE sur une échappée malformée (`%zz`), et le cookie vient du client :
  // sans garde, un cookie abîmé transformait une impasse propre en 500.
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  const r = req("https://share.example.com/api/plan", {
    host: HOTE_INVITE, headers: { Cookie: "plan_invite=%zz-casse" },
  });
  const res = await planGet({ request: r, env } as unknown as Parameters<typeof planGet>[0]);
  return expect(res.status !== 500, "un cookie mal encodé ne doit jamais donner un 500, vu " + res.status);
});

await test("invite_jeton_revoque_donne_le_meme_404", async () => {
  const { db, env } = base();
  inserePlan(db, "appartement", "Appartement");
  insereInvite(db, { token: "revoque1", planId: "appartement", revoked: 1 });
  const res = await redeemAvecToken(db, env, "revoque1");
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 404, "doit répondre 404, vu " + res.status)
      && expect(corps.error === "invite_invalide", "MÊME corps qu'un jeton inconnu : ne pas confirmer qu'il a existé");
});

await test("invite_jeton_expire_donne_le_meme_404", async () => {
  const { db, env } = base();
  inserePlan(db, "appartement", "Appartement");
  insereInvite(db, { token: "expire1", planId: "appartement", expiresAt: new Date(Date.now() - JOUR_MS).toISOString() });
  const res = await redeemAvecToken(db, env, "expire1");
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 404, "doit répondre 404, vu " + res.status)
      && expect(corps.error === "invite_invalide", "MÊME corps qu'un jeton inconnu ou révoqué");
});

await test("invite_plan_disparu_donne_le_meme_404", async () => {
  // Edge case 10: the plan can be deleted while a link stays live. No `plans` row is inserted at
  // all here, so the invite is structurally valid but names nothing.
  const { db, env } = base();
  insereInvite(db, { token: "orphelin1", planId: "envole" });
  const res = await redeemAvecToken(db, env, "orphelin1");
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 404, "doit répondre 404, vu " + res.status)
      && expect(corps.error === "invite_invalide", "MÊME corps qu'un jeton inconnu");
});

await test("invite_jeton_valide_pose_le_cookie_et_rend_le_nom_du_plan", async () => {
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  insereInvite(db, { token: "valide1", planId: "appartement" });
  const res = await redeemAvecToken(db, env, "valide1");
  const corps = await res.json<DonneeDynamique>();
  const cookie = res.headers.get("set-cookie") || "";
  return expect(res.status === 200, "doit répondre 200, vu " + res.status)
      && expect(corps.planId === "appartement", "planId attendu, vu " + JSON.stringify(corps))
      && expect(corps.planName === "Chez nous", "planName attendu, vu " + JSON.stringify(corps))
      && expect(corps.role === "edit", "role attendu edit")
      && expect(cookie.startsWith("plan_invite=" + jeton("valide1") + ";"), "le cookie doit porter le jeton, vu " + cookie)
      && expect(/(^|;\s*)HttpOnly(;|$)/i.test(cookie), "le cookie doit être HttpOnly, vu " + cookie)
      && expect(/(^|;\s*)Secure(;|$)/i.test(cookie), "le cookie doit être Secure, vu " + cookie)
      && expect(/SameSite=Strict/i.test(cookie), "le cookie doit être SameSite=Strict, vu " + cookie)
      && expect(/Path=\//.test(cookie), "le cookie doit couvrir tout le site, vu " + cookie);
});

await test("invite_nom_absent_rend_null_pour_un_premier_arrivant", async () => {
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  insereInvite(db, { token: "sansnom1", planId: "appartement", lastName: null });
  const res = await redeemAvecToken(db, env, "sansnom1");
  const corps = await res.json<DonneeDynamique>();
  return expect(corps.name === null, "name doit être null quand rien n'a jamais été déclaré, vu " + JSON.stringify(corps.name));
});

await test("invite_nom_deja_connu_prefiltre_un_visiteur_qui_revient_du_meme_appareil", async () => {
  // The prefill is keyed by DEVICE, not by token alone (design edge 20, corrected 2026-08-14):
  // the SAME `guestId` that recorded `last_name` is the one asking for it back.
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  insereInvite(db, { token: "revient1", planId: "appartement", lastName: "Marie", lastGuestId: "device-marie" });
  const res = await redeemAvecToken(db, env, "revient1", { token: jeton("revient1"), guestId: "device-marie" });
  const corps = await res.json<DonneeDynamique>();
  return expect(corps.name === "Marie", "name doit préremplir depuis last_name pour le MÊME appareil, vu " + JSON.stringify(corps.name));
});

await test("invite_nom_ne_prefiltre_pas_un_appareil_different_meme_jeton", async () => {
  // THE DEFECT THIS FIX CLOSES, confirmed live from two people testing multiplayer together:
  // the owner opened his own invite link and named himself, his friend opened the SAME link
  // right after and silently became him on both screens. `last_name` alone, keyed by TOKEN, had
  // no way to tell the two apart.
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  insereInvite(db, { token: "partage1", planId: "appartement", lastName: "Marie", lastGuestId: "device-marie" });
  const res = await redeemAvecToken(db, env, "partage1", { token: jeton("partage1"), guestId: "device-autre" });
  const corps = await res.json<DonneeDynamique>();
  return expect(corps.name === null, "un AUTRE appareil ne doit jamais hériter du nom, vu " + JSON.stringify(corps.name));
});

await test("invite_deux_invites_sur_le_meme_lien_gardent_chacun_leur_nom", async () => {
  // THE FULL SCENARIO from the report: A names themselves, B redeems the SAME token on a
  // DIFFERENT device and must NOT be handed A's name, then A returns and IS handed theirs, B's
  // own (nameless) redemption must not have clobbered A's remembered identity along the way.
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  insereInvite(db, { token: "duo1", planId: "appartement" });

  const resA = await redeemAvecToken(db, env, "duo1", { token: jeton("duo1"), name: "Alice", guestId: "device-a" });
  const corpsA = await resA.json<DonneeDynamique>();
  const ok1 = expect(corpsA.name === "Alice", "A doit se voir renvoyer son propre nom, vu " + JSON.stringify(corpsA.name));
  if (!ok1) return false;

  // B's FIRST call, exactly like a real page load: no name yet, just the silent check the client
  // makes before the name step would even show.
  const resB = await redeemAvecToken(db, env, "duo1", { token: jeton("duo1"), guestId: "device-b" });
  const corpsB = await resB.json<DonneeDynamique>();
  const ok2 = expect(corpsB.name === null, "B ne doit JAMAIS recevoir le nom d'Alice, vu " + JSON.stringify(corpsB.name));
  if (!ok2) return false;

  const resARevient = await redeemAvecToken(db, env, "duo1", { token: jeton("duo1"), guestId: "device-a" });
  const corpsARevient = await resARevient.json<DonneeDynamique>();
  return expect(corpsARevient.name === "Alice", "A doit retrouver son nom en revenant sur SON appareil, vu " + JSON.stringify(corpsARevient.name));
});

await test("invite_nom_envoye_est_nettoye_persiste_et_renvoye", async () => {
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  insereInvite(db, { token: "nomenvoye1", planId: "appartement" });
  const res = await redeemAvecToken(db, env, "nomenvoye1", { token: jeton("nomenvoye1"), name: "  Marie‮  " });
  const corps = await res.json<DonneeDynamique>();
  const ligne = db.prepare("SELECT last_name FROM invites WHERE token=?1").get(jeton("nomenvoye1")) as DonneeDynamique;
  return expect(corps.name === "Marie", "le nom renvoyé doit être nettoyé, vu " + JSON.stringify(corps.name))
      && expect(ligne.last_name === "Marie", "le nom doit être persisté nettoyé dans invites.last_name, vu " + JSON.stringify(ligne));
});

await test("invite_comptabilise_les_usages_au_mieux", async () => {
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  insereInvite(db, { token: "compte1", planId: "appartement", uses: 3 });
  await redeemAvecToken(db, env, "compte1");
  const ligne = db.prepare("SELECT uses, last_used_at FROM invites WHERE token=?1").get(jeton("compte1")) as DonneeDynamique;
  return expect(ligne.uses === 4, "uses doit être incrémenté, vu " + ligne.uses)
      && expect(!!ligne.last_used_at, "last_used_at doit être renseigné");
});

// =================================================================================================
//  3. functions/api/invites.ts, the owner's management, foyer door only
// =================================================================================================

const CTX_FOYER = () => {
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  return { db, env };
};

async function invitesGet(env: DonneeDynamique, url: string, host: string) {
  return invitesList({ request: req(url, { host }), env } as unknown as Parameters<typeof invitesList>[0]);
}
async function invitesPost(env: DonneeDynamique, host: string, corps: unknown) {
  return invitesCreate({
    request: req("https://" + host + "/api/invites", { method: "POST", host, body: corps }), env,
  } as unknown as Parameters<typeof invitesCreate>[0]);
}
async function invitesDelete(env: DonneeDynamique, host: string, token: string) {
  return invitesRevoke({
    request: req("https://" + host + "/api/invites", { method: "DELETE", host, body: { token } }), env,
  } as unknown as Parameters<typeof invitesRevoke>[0]);
}

await test("invites_get_refuse_sur_la_porte_invite", async () => {
  const { env } = CTX_FOYER();
  const res = await invitesGet(env, "https://share.example.com/api/invites?p=appartement", HOTE_INVITE);
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 403, "doit répondre 403, vu " + res.status)
      && expect(corps.error === "porte_refusee", "corps attendu porte_refusee, vu " + JSON.stringify(corps));
});

await test("invites_post_refuse_sur_la_porte_invite", async () => {
  const { env } = CTX_FOYER();
  const res = await invitesPost(env, HOTE_INVITE, { planId: "appartement" });
  return expect(res.status === 403, "doit répondre 403, vu " + res.status);
});

await test("invites_delete_refuse_sur_la_porte_invite", async () => {
  const { env } = CTX_FOYER();
  const res = await invitesDelete(env, HOTE_INVITE, "x");
  return expect(res.status === 403, "doit répondre 403, vu " + res.status);
});

await test("invites_creation_liste_revocation_aller_retour", async () => {
  const { env } = CTX_FOYER();

  const resCree = await invitesPost(env, HOTE_FOYER, { planId: "appartement" });
  const corpsCree = await resCree.json<DonneeDynamique>();
  const ok1 = expect(resCree.status === 201, "création doit répondre 201, vu " + resCree.status)
    && expect(!!corpsCree.invite && corpsCree.invite.token, "la réponse doit inclure le jeton créé, vu " + JSON.stringify(corpsCree));
  if (!ok1) return false;
  const token = corpsCree.invite.token as string;

  const resListe = await invitesGet(env, "https://plan.example.com/api/invites?p=appartement", HOTE_FOYER);
  const corpsListe = await resListe.json<DonneeDynamique>();
  const trouve = (corpsListe.invites || []).find((i: DonneeDynamique) => i.token === token);
  const ok2 = expect(resListe.status === 200, "liste doit répondre 200")
    && expect(!!trouve, "l'invite créée doit apparaître dans la liste")
    && expect(trouve.revoked === false, "l'invite fraîche ne doit pas être révoquée");
  if (!ok2) return false;

  const resRevoque = await invitesDelete(env, HOTE_FOYER, token);
  const corpsRevoque = await resRevoque.json<DonneeDynamique>();
  const ok3 = expect(resRevoque.status === 200, "révocation doit répondre 200")
    && expect(corpsRevoque.ok === true, "révocation doit renvoyer ok:true");
  if (!ok3) return false;

  const resRevoqueEncore = await invitesDelete(env, HOTE_FOYER, token);
  const ok4 = expect(resRevoqueEncore.status === 200, "une SECONDE révocation du même jeton doit rester 200, vu " + resRevoqueEncore.status);
  if (!ok4) return false;

  const resInconnu = await invitesDelete(env, HOTE_FOYER, "jeton-jamais-cree");
  return expect(resInconnu.status === 200, "révoquer un jeton INCONNU doit aussi rester 200 (pas de 404 qui confirmerait)");
});

// =================================================================================================
//  3bis. `guestHost` (batch 4, owner client): the client cannot know the guest hostname on its
//  own (de-identified repo, different origin from the owner's), so the server hands it back in
//  every GET/POST response, read straight from GUEST_HOST, the SAME plain value `functions/porte.ts`
//  already uses for the door check. `base()` configures GUEST_HOST; `baseSansGuestHost()` leaves it
//  unset, which must give `null`, never an empty string or an omitted field a client would have
//  to special-case.
// =================================================================================================

await test("invites_get_expose_guestHost_quand_configure", async () => {
  const { env } = CTX_FOYER();
  const res = await invitesGet(env, "https://plan.example.com/api/invites?p=appartement", HOTE_FOYER);
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 200, "doit répondre 200, vu " + res.status)
      && expect(corps.guestHost === HOTE_INVITE, "guestHost attendu " + HOTE_INVITE + ", vu " + JSON.stringify(corps.guestHost));
});

await test("invites_post_expose_guestHost_quand_configure", async () => {
  const { env } = CTX_FOYER();
  const res = await invitesPost(env, HOTE_FOYER, { planId: "appartement" });
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 201, "doit répondre 201, vu " + res.status)
      && expect(corps.guestHost === HOTE_INVITE, "guestHost attendu " + HOTE_INVITE + ", vu " + JSON.stringify(corps.guestHost));
});

const baseSansGuestHost = () => {
  const { db, env } = fakeD1(null);
  return { db, env: { ...env, HOUSEHOLD_HOSTS: HOTE_FOYER } };   // GUEST_HOST absent, volontairement
};

await test("invites_get_guestHost_absent_quand_non_configure", async () => {
  const { db, env } = baseSansGuestHost();
  inserePlan(db, "appartement", "Chez nous");
  const res = await invitesGet(env, "https://plan.example.com/api/invites?p=appartement", HOTE_FOYER);
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 200, "doit répondre 200, vu " + res.status)
      && expect(corps.guestHost === null, "guestHost doit être null sans GUEST_HOST, vu " + JSON.stringify(corps.guestHost));
});

await test("invites_post_guestHost_absent_quand_non_configure", async () => {
  const { db, env } = baseSansGuestHost();
  inserePlan(db, "appartement", "Chez nous");
  const res = await invitesPost(env, HOTE_FOYER, { planId: "appartement" });
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 201, "doit répondre 201, vu " + res.status)
      && expect(corps.guestHost === null, "guestHost doit être null sans GUEST_HOST, vu " + JSON.stringify(corps.guestHost));
});

await test("invites_delete_appelle_le_do_revoke_avec_le_marqueur_interne", async () => {
  // Batch 2, design edge 6: "Revoke must close live sockets, not merely block new ones." This
  // proves the WIRING from this route to `live-worker/worker.ts`'s `handleRevoke`, the DO-side
  // behaviour itself (which sockets close, which don't) is covered in `live-worker/test-local.ts`.
  const { db, env } = CTX_FOYER();
  insereInvite(db, { token: "wire1", planId: "appartement" });
  const { etat, room } = fakeRoom();
  const res = await invitesDelete({ ...env, ROOM: room }, HOTE_FOYER, jeton("wire1"));
  const corps = await res.json<DonneeDynamique>();
  const vue = etat.requete;
  return expect(res.status === 200 && corps.ok === true, "la révocation reste 200, vu " + res.status)
      && expect(!!vue, "le DO doit avoir reçu un appel (via le binding ROOM, jamais le réseau)")
      && expect(new URL(vue!.url).pathname === "/revoke", "l'appel doit cibler /revoke, vu " + vue!.url)
      && expect(vue!.headers.get("X-Plan-Internal") === "1", "et porter le marqueur interne")
      && expect((await vue!.clone().json<DonneeDynamique>()).token === jeton("wire1"), "avec le JETON révoqué dans le corps");
});

await test("invites_delete_ne_casse_pas_si_le_do_echoue", async () => {
  // BEST-EFFORT: the row is revoked either way (see the route's own comment), so a Worker/DO
  // failure must never turn an otherwise-successful revoke into an error response.
  const { db, env } = CTX_FOYER();
  insereInvite(db, { token: "wire2", planId: "appartement" });
  const roomEnPanne = { idFromName: (n: string) => n, get: () => ({ fetch: async () => { throw new Error("DO indisponible"); } }) };
  const res = await invitesDelete({ ...env, ROOM: roomEnPanne }, HOTE_FOYER, jeton("wire2"));
  const corps = await res.json<DonneeDynamique>();
  const ligne = db.prepare("SELECT revoked FROM invites WHERE token=?1").get(jeton("wire2")) as DonneeDynamique;
  return expect(res.status === 200 && corps.ok === true, "la révocation reste 200 même si le DO est en panne, vu " + res.status)
      && expect(ligne.revoked === 1, "la ligne D1 est révoquée quand même");
});

await test("invites_plan_inexistant_est_404", async () => {
  const { env } = base();   // no plan inserted
  const res = await invitesPost(env, HOTE_FOYER, { planId: "fantome" });
  return expect(res.status === 404, "doit répondre 404 pour un plan inexistant, vu " + res.status);
});

await test("invites_id_de_plan_invalide_est_400", async () => {
  const { env } = CTX_FOYER();
  const res = await invitesPost(env, HOTE_FOYER, { planId: "MAJUSCULE INVALIDE" });
  return expect(res.status === 400, "doit répondre 400 pour un id de plan mal formé, vu " + res.status);
});

await test("invites_plafond_a_vingt_invitations_vivantes", async () => {
  const { db, env } = CTX_FOYER();
  for (let i = 0; i < 20; i++) {
    insereInvite(db, { token: "cap" + i, planId: "appartement" });
  }
  const res = await invitesPost(env, HOTE_FOYER, { planId: "appartement" });
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 409, "la 21e invite vivante doit être refusée, vu " + res.status)
      && expect(corps.error === "trop_d_invitations", "corps attendu trop_d_invitations, vu " + JSON.stringify(corps))
      // Le client lit ce plafond au lieu de le recopier en dur (même pattern que MAX_PLANS dans
      // functions/api/plans.ts / panneaux/plans.ts) : sans lui, le message affiché dériverait
      // silencieusement de la vraie constante serveur le jour où elle change.
      && expect(corps.max === 20, "corps doit porter le plafond réel, vu " + JSON.stringify(corps.max));
});

await test("invites_plafond_ne_compte_pas_les_revoquees", async () => {
  const { db, env } = CTX_FOYER();
  for (let i = 0; i < 20; i++) {
    insereInvite(db, { token: "libre" + i, planId: "appartement", revoked: 1 });
  }
  const res = await invitesPost(env, HOTE_FOYER, { planId: "appartement" });
  return expect(res.status === 201, "20 invites RÉVOQUÉES ne doivent pas saturer le plafond, vu " + res.status);
});

// =================================================================================================
//  4. functions/api/plan.ts, the "invite" door's effect on the shared plan
// =================================================================================================

async function planGetVia(env: DonneeDynamique, url: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Cookie = cookieDe(token);
  return planGet({ request: req(url, { host: HOTE_INVITE, headers }), env } as unknown as Parameters<typeof planGet>[0]);
}
async function planPutVia(env: DonneeDynamique, url: string, token: string | undefined, corps: unknown) {
  const headers: Record<string, string> = {};
  if (token) headers.Cookie = cookieDe(token);
  return planPut({
    request: req(url, { method: "PUT", host: HOTE_INVITE, headers, body: corps }), env,
  } as unknown as Parameters<typeof planPut>[0]);
}

await test("plan_get_ignore_p_sur_la_porte_invite", async () => {
  const { db, env } = base();
  // LES DEUX PLANS ONT DES AUTEURS DIFFÉRENTS, et c'est ce qui rend ce test probant. Avant, les
  // deux lignes portaient le MÊME `updated_by`, donc l'assertion passait quel que soit le plan
  // servi : elle ne prouvait rien. Un test qui ne peut pas échouer sur le défaut qu'il décrit est
  // pire qu'absent, il rassure.
  inserePlan(db, "appartement", "Chez nous", "sylve@example.com");
  inserePlan(db, "autre-logement", "Ailleurs", "quelquun.dautre@example.com");
  insereInvite(db, { token: "getp1", planId: "appartement" });
  // `?p=` POINTS AT THE OTHER PLAN: a guest editing the URL must not reach it (design edge 5).
  const res = await planGetVia(env, "https://share.example.com/api/plan?p=autre-logement", "getp1");
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 200, "doit répondre 200, vu " + res.status)
      // Servi = le plan de l'invitation, PAS celui de `?p=` : les deux auteurs diffèrent.
      && expect(corps.updatedBy === "Sylve", "doit servir le plan de l'invite, pas celui de ?p=, vu " + JSON.stringify(corps))
      // Et l'auteur est RÉDUIT : une adresse du foyer ne traverse pas jusqu'à un invité (edge 16).
      && expect(!String(corps.updatedBy).includes("@"), "aucune adresse ne doit atteindre un invité, vu " + JSON.stringify(corps.updatedBy));
});

await test("plan_get_jeton_invalide_est_403", async () => {
  const { env } = base();
  const res = await planGetVia(env, "https://share.example.com/api/plan", "n-existe-pas");
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 403, "doit répondre 403, vu " + res.status)
      && expect(corps.error === "invite_invalide", "corps attendu invite_invalide, vu " + JSON.stringify(corps));
});

await test("plan_put_ignore_p_sur_la_porte_invite", async () => {
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  inserePlan(db, "autre-logement", "Ailleurs");
  insereInvite(db, { token: "putp1", planId: "appartement" });
  const res = await planPutVia(env, "https://share.example.com/api/plan?p=autre-logement", "putp1",
    { state: { outline: [], walls: [] }, rev: 1 });
  const corps = await res.json<DonneeDynamique>();
  const ok = expect(res.status === 200, "doit répondre 200, vu " + res.status + " " + JSON.stringify(corps));
  if (!ok) return false;
  const autre = db.prepare("SELECT rev FROM plans WHERE id=?1").get("autre-logement") as DonneeDynamique;
  return expect(autre.rev === 1, "le plan pointé par ?p= ne doit PAS avoir été écrit, vu rev=" + autre.rev);
});

await test("plan_put_sans_rev_est_400_sur_la_porte_invite", async () => {
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  insereInvite(db, { token: "sansrev1", planId: "appartement" });
  const res = await planPutVia(env, "https://share.example.com/api/plan", "sansrev1",
    { state: { outline: [], walls: [] } });   // NO rev
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 400, "doit répondre 400, vu " + res.status)
      && expect(corps.error === "rev_requis", "corps attendu rev_requis, vu " + JSON.stringify(corps));
});

await test("plan_put_rev_perimee_reste_409", async () => {
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");   // rev=1
  insereInvite(db, { token: "perime1", planId: "appartement" });
  const res = await planPutVia(env, "https://share.example.com/api/plan", "perime1",
    { state: { outline: [], walls: [] }, rev: 99 });
  return expect(res.status === 409, "une révision périmée doit toujours donner 409, vu " + res.status);
});

await test("plan_put_jeton_revoque_est_403", async () => {
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  insereInvite(db, { token: "revoquep1", planId: "appartement", revoked: 1 });
  const res = await planPutVia(env, "https://share.example.com/api/plan", "revoquep1",
    { state: { outline: [], walls: [] }, rev: 1 });
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 403, "doit répondre 403, vu " + res.status)
      && expect(corps.error === "invite_invalide", "corps attendu invite_invalide, vu " + JSON.stringify(corps));
});

await test("plan_put_invite_ecrit_updated_by_jamais_email_jamais_live", async () => {
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  insereInvite(db, { token: "ecrit1", planId: "appartement", lastName: "Marie" });
  const res = await planPutVia(env, "https://share.example.com/api/plan", "ecrit1",
    { state: { outline: [], walls: [] }, rev: 1 });
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 200, "doit répondre 200, vu " + res.status + " " + JSON.stringify(corps))
      && expect(corps.updatedBy === "invite:Marie", "updated_by attendu invite:Marie, vu " + JSON.stringify(corps.updatedBy))
      && expect(!/@/.test(String(corps.updatedBy)), "updated_by ne doit jamais ressembler à un e-mail")
      && expect(corps.updatedBy !== "live", "updated_by ne doit jamais être le marqueur live");
});

await test("plan_put_invite_sans_nom_connu_ecrit_le_point_d_interrogation", async () => {
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  insereInvite(db, { token: "sansnomecrit1", planId: "appartement", lastName: null });
  const res = await planPutVia(env, "https://share.example.com/api/plan", "sansnomecrit1",
    { state: { outline: [], walls: [] }, rev: 1 });
  const corps = await res.json<DonneeDynamique>();
  return expect(corps.updatedBy === "invite:?", "sans nom connu, updated_by attendu invite:?, vu " + JSON.stringify(corps.updatedBy));
});

// =================================================================================================
//  5. functions/ws.ts, door resolution and forwarded identity headers (no real Durable Object)
// =================================================================================================

function fakeRoom() {
  const etat: { requete: Request | null } = { requete: null };
  const stub = { fetch: async (r: Request) => { etat.requete = r; return new Response("ok"); } };
  return { etat, room: { idFromName: (n: string) => n, get: () => stub } };
}
function wsReq(url: string, host: string, headers?: Record<string, string>) {
  const h = new Headers(headers || {});
  h.set("Host", host);
  h.set("Upgrade", "websocket");
  return new Request(url, { headers: h });
}

await test("ws_invite_jeton_invalide_refuse_la_bascule", async () => {
  const { env } = base();
  const { room } = fakeRoom();
  const res = await wsUpgrade({
    request: wsReq("https://share.example.com/ws", HOTE_INVITE), env: { ...env, ROOM: room },
  } as unknown as Parameters<typeof wsUpgrade>[0]);
  return expect(res.status === 403, "doit refuser la bascule avec 403, vu " + res.status);
});

await test("ws_invite_valide_force_le_plan_et_marque_l_identite_invite", async () => {
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  inserePlan(db, "autre-logement", "Ailleurs");
  // `lastGuestId` matches the `?g=` this socket sends below: SAME device, so the wire may carry
  // its remembered name.
  insereInvite(db, { token: "ws1", planId: "appartement", lastName: "Marie", lastGuestId: "device-marie" });
  const { etat, room } = fakeRoom();
  const res = await wsUpgrade({
    // `?p=` POINTS AT THE OTHER PLAN: must be ignored, exactly like the REST routes.
    request: wsReq("https://share.example.com/ws?p=autre-logement&g=device-marie", HOTE_INVITE, { Cookie: cookieDe("ws1") }),
    env: { ...env, ROOM: room },
  } as unknown as Parameters<typeof wsUpgrade>[0]);
  const vue = etat.requete;
  return expect(res.status !== 403 && res.status !== 400, "la bascule doit être transmise, vu " + res.status)
      && expect(!!vue, "le Durable Object doit avoir reçu une requête transmise")
      && expect(vue!.headers.get("X-Plan-Id") === "appartement", "le plan doit venir de l'invite, pas de ?p=, vu " + vue!.headers.get("X-Plan-Id"))
      && expect(vue!.headers.get("X-Plan-Guest") === "1", "X-Plan-Guest doit être 1 pour un invité")
      && expect(vue!.headers.get("X-Plan-Email") === "", "X-Plan-Email doit être VIDE pour un invité, jamais 'inconnu'")
      && expect(vue!.headers.get("X-Plan-Name") === "Marie", "X-Plan-Name doit porter le nom nettoyé, vu " + vue!.headers.get("X-Plan-Name"));
});

await test("ws_invite_un_nom_connu_pour_le_jeton_ne_traverse_pas_vers_un_autre_appareil", async () => {
  // THE OTHER HALF OF THE DEFECT, confirmed live: `functions/ws.ts` used to read
  // `invites.last_name` UNCONDITIONALLY, so BOTH sockets on a shared link carried whichever name
  // last landed on that ONE row, the two people testing together both appeared under one name.
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  insereInvite(db, { token: "ws2", planId: "appartement", lastName: "Marie", lastGuestId: "device-marie" });
  const { etat, room } = fakeRoom();
  const res = await wsUpgrade({
    // `?g=` is a DIFFERENT device than the one the row remembers.
    request: wsReq("https://share.example.com/ws?g=un-autre-appareil", HOTE_INVITE, { Cookie: cookieDe("ws2") }),
    env: { ...env, ROOM: room },
  } as unknown as Parameters<typeof wsUpgrade>[0]);
  const vue = etat.requete;
  return expect(res.status !== 403 && res.status !== 400, "la bascule doit être transmise, vu " + res.status)
      && expect(!!vue, "le Durable Object doit avoir reçu une requête transmise")
      && expect(vue!.headers.get("X-Plan-Name") === "",
        "un appareil DIFFÉRENT ne doit JAMAIS recevoir le nom d'un autre sur le fil, vu " + JSON.stringify(vue!.headers.get("X-Plan-Name")));
});

await test("ws_invite_sans_g_ne_recoit_jamais_un_nom_devine", async () => {
  // No `?g=` at all (an older client, or a malformed one): same refusal as a mismatched device,
  // never a fallback that guesses.
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  insereInvite(db, { token: "ws3", planId: "appartement", lastName: "Marie", lastGuestId: "device-marie" });
  const { etat, room } = fakeRoom();
  const res = await wsUpgrade({
    request: wsReq("https://share.example.com/ws", HOTE_INVITE, { Cookie: cookieDe("ws3") }),
    env: { ...env, ROOM: room },
  } as unknown as Parameters<typeof wsUpgrade>[0]);
  const vue = etat.requete;
  return expect(res.status !== 403 && res.status !== 400, "la bascule doit être transmise, vu " + res.status)
      && expect(vue!.headers.get("X-Plan-Name") === "", "sans ?g=, X-Plan-Name doit rester vide, vu " + JSON.stringify(vue!.headers.get("X-Plan-Name")));
});

await test("ws_invite_deux_appareils_sur_le_meme_jeton_gardent_chacun_leur_propre_nom", async () => {
  // THE FULL SCENARIO: two guests, same token, different `guestId`, each socket must carry ITS
  // OWN name, and neither is left nameless because of the other.
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  // The row remembers Bob (whoever redeemed most recently WITH a name, functions/api/invite.ts).
  insereInvite(db, { token: "duoWs1", planId: "appartement", lastName: "Bob", lastGuestId: "device-bob" });
  const { etat: etatAlice, room: roomAlice } = fakeRoom();
  const resAlice = await wsUpgrade({
    request: wsReq("https://share.example.com/ws?g=device-alice", HOTE_INVITE, { Cookie: cookieDe("duoWs1") }),
    env: { ...env, ROOM: roomAlice },
  } as unknown as Parameters<typeof wsUpgrade>[0]);
  const { etat: etatBob, room: roomBob } = fakeRoom();
  const resBob = await wsUpgrade({
    request: wsReq("https://share.example.com/ws?g=device-bob", HOTE_INVITE, { Cookie: cookieDe("duoWs1") }),
    env: { ...env, ROOM: roomBob },
  } as unknown as Parameters<typeof wsUpgrade>[0]);
  return expect(resAlice.status !== 403 && resBob.status !== 403, "les deux bascules doivent être transmises")
      && expect(etatAlice.requete!.headers.get("X-Plan-Name") === "",
        "Alice n'est PAS le propriétaire actuel de la ligne : jamais le nom de Bob, vu " + JSON.stringify(etatAlice.requete!.headers.get("X-Plan-Name")))
      && expect(etatBob.requete!.headers.get("X-Plan-Name") === "Bob",
        "Bob EST le propriétaire actuel de la ligne : son propre nom, vu " + JSON.stringify(etatBob.requete!.headers.get("X-Plan-Name")));
});

await test("ws_foyer_marque_guest_a_zero", async () => {
  const { env } = base();
  const { etat, room } = fakeRoom();
  const res = await wsUpgrade({
    request: wsReq("https://plan.example.com/ws", HOTE_FOYER, { "Cf-Access-Authenticated-User-Email": "sylve@example.com" }),
    env: { ...env, ROOM: room },
  } as unknown as Parameters<typeof wsUpgrade>[0]);
  const vue = etat.requete;
  return expect(res.status !== 403, "la porte foyer ne doit jamais être refusée, vu " + res.status)
      && expect(!!vue, "le Durable Object doit avoir reçu une requête transmise")
      && expect(vue!.headers.get("X-Plan-Guest") === "0", "X-Plan-Guest doit être 0 sur la porte foyer")
      && expect(vue!.headers.get("X-Plan-Email") === "sylve@example.com", "X-Plan-Email doit rester l'identité Access sur le foyer");
});

// =================================================================================================
//  6. UN PLAN NEUF N'A PAS DE PLAN DEDANS, et ça se lit comme une ligne absente
// =================================================================================================
// `functions/api/plans.ts` crée une ligne VIDE. Le contrat de `/api/plan` GET dit
// « ligne absente = {data:null, rev:0} » : une ligne SANS plan dedans doit répondre pareil, sinon
// le client ne reconnaît pas « le foyer n'a encore rien dessiné » et n'ouvre pas son assistant.

async function planGetFoyer(env: DonneeDynamique, url: string) {
  return planGet({
    request: req(url, { host: HOTE_FOYER, headers: { "Cf-Access-Authenticated-User-Email": "sylve@example.com" } }),
    env,
  } as unknown as Parameters<typeof planGet>[0]);
}

await test("plan_neuf_se_lit_comme_une_ligne_absente", async () => {
  const { db, env } = base();
  const res0 = await plansPost({
    request: req("https://plan.example.com/api/plans", { method: "POST", host: HOTE_FOYER, body: { name: "Chez nous" } }),
    env,
  } as unknown as Parameters<typeof plansPost>[0]);
  const cree = await res0.json<DonneeDynamique>();
  const ok = expect(res0.status === 200 && cree.ok === true, "la création doit réussir, vu " + res0.status + " " + JSON.stringify(cree));
  if (!ok) return false;
  const ligne = db.prepare("SELECT data FROM plans WHERE id=?1").get(cree.id) as DonneeDynamique;
  const res = await planGetFoyer(env, "https://plan.example.com/api/plan?p=" + cree.id);
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 200, "doit répondre 200, vu " + res.status)
      && expect(corps.data === null, "un plan neuf doit rendre data:null, vu " + JSON.stringify(corps.data))
      && expect(corps.rev === 0, "et rev:0, vu " + JSON.stringify(corps.rev))
      // La colonne reste lisible par tout le monde : ce qu'elle porte doit se reparser en « rien ».
      && expect(JSON.parse(String(ligne.data)) === null, "la colonne doit porter « aucun plan », vu " + JSON.stringify(ligne.data));
});

await test("plan_colonne_data_sql_null_se_lit_comme_une_ligne_absente", async () => {
  // `plans.data` est `TEXT NOT NULL` en production (live-worker/schema.sql), donc cette ligne-là
  // n'existe pas aujourd'hui. On relâche la contrainte ICI, dans la base du test, pour prouver que
  // le lecteur ne dépend pas de cette contrainte : le jour où elle tombe (c'est ce que la revue
  // demande), `JSON.parse(null)` ne doit pas décider tout seul du contrat.
  const { db, env } = base();
  db.exec("ALTER TABLE plans RENAME TO plans_strict");
  db.exec("CREATE TABLE plans(id TEXT PRIMARY KEY, data TEXT, rev INTEGER NOT NULL DEFAULT 0, updated_at TEXT, updated_by TEXT, name TEXT)");
  db.prepare("INSERT INTO plans(id,data,rev,updated_at,updated_by,name) VALUES('vide',NULL,0,?1,'sylve@example.com','Chez nous')")
    .run(new Date().toISOString());
  const res = await planGetFoyer(env, "https://plan.example.com/api/plan?p=vide");
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 200, "doit répondre 200, vu " + res.status)
      && expect(corps.data === null, "une colonne SQL NULL doit rendre data:null, vu " + JSON.stringify(corps.data))
      && expect(corps.rev === 0, "et rev:0, vu " + JSON.stringify(corps.rev));
});

await test("plan_colonne_data_vide_se_lit_comme_une_ligne_absente", async () => {
  // La chaîne vide, elle, PASSE la contrainte NOT NULL : c'est le cas atteignable aujourd'hui, et
  // `JSON.parse("")` jette. Une ligne sans plan dedans n'est pas une panne du serveur.
  const { db, env } = base();
  db.prepare("INSERT INTO plans(id,data,rev,updated_at,updated_by,name) VALUES('vide','',0,?1,'sylve@example.com','Chez nous')")
    .run(new Date().toISOString());
  const res = await planGetFoyer(env, "https://plan.example.com/api/plan?p=vide");
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 200, "doit répondre 200, vu " + res.status)
      && expect(corps.data === null, "une colonne vide doit rendre data:null, vu " + JSON.stringify(corps.data));
});

// =================================================================================================
//  7. SUPPRIMER UN PLAN SUPPRIME AUSSI SA COPIE VIVANTE
// =================================================================================================
// Effacer la ligne D1 ne suffit pas : le Durable Object garde le plan en mémoire ET le réécrit en
// D1 à chaque alarme, donc le plan « supprimé » revient, et les gens connectés continuent d'éditer
// un plan qui n'existe plus. Le DELETE appelle donc `/purge` sur le stub ROOM du plan.

/** Un stub ROOM qui répond comme le DO à `/purge`, et retient la requête reçue. */
function fauxRoomPurge(closed: number) {
  const etat: { requete: Request | null } = { requete: null };
  const stub = {
    fetch: async (r: Request) => {
      etat.requete = r;
      return new Response(JSON.stringify({ ok: true, closed }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  return { etat, room: { idFromName: (n: string) => n, get: () => stub } };
}

async function plansDeleteVia(env: DonneeDynamique, id: string) {
  return plansDelete({
    request: req("https://plan.example.com/api/plans", { method: "DELETE", host: HOTE_FOYER, body: { id } }), env,
  } as unknown as Parameters<typeof plansDelete>[0]);
}

await test("plans_delete_purge_la_copie_vivante", async () => {
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  const { etat, room } = fauxRoomPurge(3);
  const res = await plansDeleteVia({ ...env, ROOM: room }, "appartement");
  const corps = await res.json<DonneeDynamique>();
  const vue = etat.requete;
  const restante = db.prepare("SELECT id FROM plans WHERE id=?1").get("appartement");
  return expect(res.status === 200 && corps.ok === true, "la suppression doit rester 200, vu " + res.status)
      && expect(!restante, "la ligne D1 doit avoir disparu")
      && expect(!!vue, "le DO doit avoir reçu un appel (par le binding ROOM, jamais le réseau)")
      && expect(new URL(vue!.url).pathname === "/purge", "l'appel doit cibler /purge, vu " + vue!.url)
      && expect(vue!.headers.get("X-Plan-Internal") === "1", "et porter le marqueur interne")
      && expect(corps.live === true, "la réponse doit dire que la copie vivante a été atteinte, vu " + JSON.stringify(corps))
      && expect(corps.closed === 3, "et combien de sockets ont été fermés, vu " + JSON.stringify(corps.closed));
});

await test("plans_delete_reste_200_et_dit_live_faux_si_le_do_echoue", async () => {
  // Même règle que `/revoke` : la ligne est effacée quoi qu'il arrive, donc une panne du Worker ne
  // doit jamais transformer une suppression réussie en erreur. Ce qui change, c'est ce qu'on DIT.
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  const roomEnPanne = { idFromName: (n: string) => n, get: () => ({ fetch: async () => { throw new Error("DO indisponible"); } }) };
  const res = await plansDeleteVia({ ...env, ROOM: roomEnPanne }, "appartement");
  const corps = await res.json<DonneeDynamique>();
  const restante = db.prepare("SELECT id FROM plans WHERE id=?1").get("appartement");
  return expect(res.status === 200 && corps.ok === true, "doit rester 200, vu " + res.status)
      && expect(!restante, "la ligne D1 est effacée quand même")
      && expect(corps.live === false, "et la réponse doit dire live:false, vu " + JSON.stringify(corps));
});

await test("plans_delete_ne_purge_pas_quand_la_ligne_n_existait_pas", async () => {
  // 404 : rien n'a été supprimé, donc rien à purger. Purger quand même fermerait les sockets d'un
  // plan bien vivant sur un simple identifiant mal tapé.
  const { env } = base();
  const { etat, room } = fauxRoomPurge(0);
  const res = await plansDeleteVia({ ...env, ROOM: room }, "fantome");
  return expect(res.status === 404, "doit répondre 404, vu " + res.status)
      && expect(etat.requete === null, "aucun appel au DO ne doit partir pour un plan inexistant");
});

// =================================================================================================
//  8. EXPIRATION ET RÉVOCATION D'UN LIEN
// =================================================================================================

await test("ws_transmet_l_echeance_du_lien_au_durable_object", async () => {
  // La porte ne vérifie la validité QU'À la bascule. Sans cette échéance, un lien qui expire à 18h
  // laissait le socket déjà ouvert éditer le plan aussi longtemps qu'il restait connecté :
  // l'expiration n'arrêtait que les NOUVELLES connexions.
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  const echeance = new Date(Date.now() + 3 * JOUR_MS).toISOString();
  insereInvite(db, { token: "exp1", planId: "appartement", expiresAt: echeance });
  const { etat, room } = fakeRoom();
  await wsUpgrade({
    request: wsReq("https://share.example.com/ws", HOTE_INVITE, { Cookie: cookieDe("exp1") }),
    env: { ...env, ROOM: room },
  } as unknown as Parameters<typeof wsUpgrade>[0]);
  return expect(etat.requete!.headers.get("X-Plan-Expires") === echeance,
    "l'échéance ISO doit être transmise, vu " + JSON.stringify(etat.requete!.headers.get("X-Plan-Expires")));
});

await test("ws_pose_toujours_l_echeance_vide_sur_le_foyer", async () => {
  // TOUJOURS POSÉ, jamais conditionnel, comme les cinq autres : ce que l'appelant a envoyé arrive
  // sur la requête ENTRANTE et doit être écrasé ici, sinon il se forge une échéance.
  const { env } = base();
  const { etat, room } = fakeRoom();
  await wsUpgrade({
    request: wsReq("https://plan.example.com/ws", HOTE_FOYER, {
      "Cf-Access-Authenticated-User-Email": "sylve@example.com",
      "X-Plan-Expires": "2099-01-01T00:00:00.000Z",
    }),
    env: { ...env, ROOM: room },
  } as unknown as Parameters<typeof wsUpgrade>[0]);
  return expect(etat.requete!.headers.get("X-Plan-Expires") === "",
    "sur le foyer rien n'expire, et l'en-tête envoyé par l'appelant doit être écrasé, vu "
      + JSON.stringify(etat.requete!.headers.get("X-Plan-Expires")));
});

await test("ws_echeance_vide_quand_l_invite_n_en_a_pas", async () => {
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  insereInvite(db, { token: "sansexp1", planId: "appartement", expiresAt: null });
  const { etat, room } = fakeRoom();
  await wsUpgrade({
    request: wsReq("https://share.example.com/ws", HOTE_INVITE, { Cookie: cookieDe("sansexp1") }),
    env: { ...env, ROOM: room },
  } as unknown as Parameters<typeof wsUpgrade>[0]);
  return expect(etat.requete!.headers.get("X-Plan-Expires") === "",
    "une invite sans échéance doit poser une chaîne vide, vu " + JSON.stringify(etat.requete!.headers.get("X-Plan-Expires")));
});

await test("invites_delete_dit_live_vrai_quand_le_do_a_repondu", async () => {
  const { db, env } = CTX_FOYER();
  insereInvite(db, { token: "live1", planId: "appartement" });
  const { room } = fakeRoom();   // répond 200
  const res = await invitesDelete({ ...env, ROOM: room }, HOTE_FOYER, jeton("live1"));
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 200 && corps.ok === true, "doit rester 200, vu " + res.status)
      && expect(corps.live === true, "la réponse doit dire que les sockets ont été fermés, vu " + JSON.stringify(corps));
});

await test("invites_delete_dit_live_faux_quand_le_do_echoue", async () => {
  // « Révoqué » et « révoqué, et tous les sockets ouverts fermés » ne sont pas la même promesse.
  // Le statut de l'appel n'était même pas lu : une panne du Worker ressemblait à une révocation
  // propre, et l'invité continuait d'éditer.
  const { db, env } = CTX_FOYER();
  insereInvite(db, { token: "live2", planId: "appartement" });
  const roomEnPanne = { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response("boom", { status: 500 }) }) };
  const res = await invitesDelete({ ...env, ROOM: roomEnPanne }, HOTE_FOYER, jeton("live2"));
  const corps = await res.json<DonneeDynamique>();
  const ligne = db.prepare("SELECT revoked FROM invites WHERE token=?1").get(jeton("live2")) as DonneeDynamique;
  return expect(res.status === 200 && corps.ok === true, "doit rester 200 (idempotent), vu " + res.status)
      && expect(ligne.revoked === 1, "la ligne D1 est révoquée quand même")
      && expect(corps.live === false, "mais la réponse doit dire live:false, vu " + JSON.stringify(corps));
});

await test("invite_refuse_un_corps_trop_grand_avant_de_le_lire", async () => {
  // La SEULE route qu'un appelant non authentifié atteint avec un corps. `request.json()` met tout
  // en mémoire avant que quoi que ce soit puisse regarder : un mégaoctet de bourrage était analysé
  // en entier, puis jeté.
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  insereInvite(db, { token: "gros1", planId: "appartement" });
  const enorme = { token: jeton("gros1"), name: "x".repeat(20000) };
  const res = await redeem({
    request: req("https://share.example.com/api/invite", { method: "POST", host: HOTE_INVITE, body: enorme }),
    env,
  } as unknown as Parameters<typeof redeem>[0]);
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 413, "doit répondre 413, vu " + res.status)
      && expect(corps.error === "corps_trop_grand", "corps attendu corps_trop_grand, vu " + JSON.stringify(corps))
      && expect(corps.max === 4096, "et le plafond réel, vu " + JSON.stringify(corps.max));
});

await test("invite_refuse_un_corps_trop_grand_meme_sans_content_length", async () => {
  // `Content-Length` est une DÉCLARATION, pas un fait : absente (chunked) ou mensongère. La vraie
  // borne s'applique au texte réellement reçu.
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  insereInvite(db, { token: "gros2", planId: "appartement" });
  const entetes = new Headers({ Host: HOTE_INVITE, "content-type": "application/json" });
  const requete = new Request("https://share.example.com/api/invite", {
    method: "POST", headers: entetes,
    body: JSON.stringify({ token: jeton("gros2"), name: "y".repeat(20000) }),
  });
  // On EFFACE la déclaration : seul le texte reçu doit trancher.
  const sansLongueur = new Request(requete, { headers: new Headers(entetes) });
  const res = await redeem({ request: sansLongueur, env } as unknown as Parameters<typeof redeem>[0]);
  return expect(sansLongueur.headers.get("Content-Length") === null, "le test doit bien partir sans Content-Length")
      && expect(res.status === 413, "doit répondre 413 quand même, vu " + res.status);
});

await test("invite_accepte_toujours_un_corps_normal", async () => {
  // La borne ne doit refuser RIEN de légitime : le vrai corps fait moins de 200 octets.
  const { db, env } = base();
  inserePlan(db, "appartement", "Chez nous");
  insereInvite(db, { token: "petit1", planId: "appartement" });
  const res = await redeemAvecToken(db, env, "petit1", { token: jeton("petit1"), name: "Marie", guestId: "device-marie" });
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 200, "doit répondre 200, vu " + res.status)
      && expect(corps.name === "Marie", "et rendre le nom, vu " + JSON.stringify(corps.name));
});

// =================================================================================================
//  9. /api/orphans, LES VERSIONS QUE LE PLAN VIVANT A ÉCARTÉES, PORTE FOYER SEULEMENT
// =================================================================================================
// La bannière `conflict` du client disait « elles sont gardées sur le serveur » : vrai, et
// inatteignable, puisque rien ne pouvait les demander. Cette route relaie le `GET /orphans` du
// Durable Object. Un écarté est un morceau du plan du foyer, donc un invité n'y a rien à lire.

function fauxRoomOrphelins(reponse: Response | null) {
  const etat: { requete: Request | null } = { requete: null };
  const stub = {
    fetch: async (r: Request) => {
      etat.requete = r;
      if (!reponse) throw new Error("DO indisponible");
      return reponse;
    },
  };
  return { etat, room: { idFromName: (n: string) => n, get: () => stub } };
}
const jsonReponse = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

await test("orphans_relaie_la_liste_du_durable_object", async () => {
  const { env } = base();
  const ecartes: DonneeDynamique[] = [
    { at: "2026-09-01T10:00:00.000Z", by: "b@example.com", rev: 12, data: { outline: [], walls: [] } },
  ];
  const { etat, room } = fauxRoomOrphelins(jsonReponse({ orphans: ecartes }));
  const res = await orphansGet({
    request: req("https://plan.example.com/api/orphans?p=appartement", { host: HOTE_FOYER }),
    env: { ...env, ROOM: room },
  } as unknown as Parameters<typeof orphansGet>[0]);
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 200, "doit répondre 200, vu " + res.status)
      && expect(new URL(etat.requete!.url).pathname === "/orphans", "l'appel doit cibler /orphans, vu " + etat.requete!.url)
      && expect(etat.requete!.headers.get("X-Plan-Internal") === "1", "et porter le marqueur interne")
      && expect(corps.live === true && corps.orphans.length === 1 && corps.orphans[0].rev === 12,
        "la liste doit être relayée telle quelle, vu " + JSON.stringify(corps));
});

await test("orphans_refuse_la_porte_invitee_et_la_porte_inconnue", async () => {
  const { env } = base();
  const { etat, room } = fauxRoomOrphelins(jsonReponse({ orphans: [] }));
  for (const hote of [HOTE_INVITE, "autre.example.com"]) {
    const res = await orphansGet({
      request: req("https://" + hote + "/api/orphans?p=appartement", { host: hote }),
      env: { ...env, ROOM: room },
    } as unknown as Parameters<typeof orphansGet>[0]);
    const ok = expect(res.status === 403, hote + " doit répondre 403, vu " + res.status)
      && expect(etat.requete === null, hote + " : le Durable Object ne doit jamais être atteint");
    if (!ok) return false;
  }
  return true;
});

await test("orphans_rend_une_liste_vide_quand_le_do_est_injoignable", async () => {
  // Cette route est demandée PENDANT qu'une bannière de conflit est déjà affichée : un second
  // échec doit dire « rien à proposer », pas s'empiler en panne par-dessus un conflit.
  const { env } = base();
  const { room } = fauxRoomOrphelins(null);
  const res = await orphansGet({
    request: req("https://plan.example.com/api/orphans", { host: HOTE_FOYER }),
    env: { ...env, ROOM: room },
  } as unknown as Parameters<typeof orphansGet>[0]);
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 200, "doit rester 200, vu " + res.status)
      && expect(Array.isArray(corps.orphans) && corps.orphans.length === 0, "liste vide attendue, vu " + JSON.stringify(corps))
      && expect(corps.live === false, "et live:false, vu " + JSON.stringify(corps.live));
});

await test("orphans_refuse_un_id_de_plan_mal_forme", async () => {
  const { env } = base();
  const { etat, room } = fauxRoomOrphelins(jsonReponse({ orphans: [] }));
  const res = await orphansGet({
    request: req("https://plan.example.com/api/orphans?p=MAJUSCULE%20INVALIDE", { host: HOTE_FOYER }),
    env: { ...env, ROOM: room },
  } as unknown as Parameters<typeof orphansGet>[0]);
  return expect(res.status === 400, "doit répondre 400, vu " + res.status)
      && expect(etat.requete === null, "et ne jamais retomber silencieusement sur main");
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
