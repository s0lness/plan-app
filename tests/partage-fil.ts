#!/usr/bin/env node
// =================================================================================================
//  THE OWNER SHARE PANEL'S PURE LOGIC: NO BROWSER, against src/ts by import.
// =================================================================================================
//   node tests/partage-fil.ts
//
// Covers docs/decisions/0004-partage-par-lien.md, "batch 4, owner client":
// `src/ts/panneaux/partage.ts`'s three pure functions, link construction from a guest host and a
// token, the "not configured" fallback (`construireLienInvite` returns `null` rather than a URL
// that would not work), the live/revoked/expired filter (`inviteEstVivante`), and the display
// formatting of one invite row (`ligneInviteAffichage`). Everything DOM-shaped or fetch-shaped
// about the panel is NOT here on purpose: this suite only exercises what is provably pure, the
// same split `tests/invite-fil.ts` (the guest client's counterpart) already draws. Style matches
// that suite and `tests/invitation.ts`, which this suite's server half is the direct continuation of.

import { construireLienInvite, inviteEstVivante, ligneInviteAffichage } from "../src/ts/panneaux/partage.ts";
import type { ResultatSimple } from "./_types.ts";

// =================================================================================================
//  ASSERTION PLUMBING (same vocabulary as tests/invite-fil.ts / tests/invitation.ts)
// =================================================================================================
const results: ResultatSimple[] = [];
function test(name: string, corps: () => boolean | string | void): void {
  let pass = false, detail = "";
  try { const r = corps(); if (r === true || r === undefined) pass = true; else detail = String(r); }
  catch (e) { detail = String((e && (e as Error).stack) || e); }
  results.push({ name, pass, detail });
  process.stdout.write((pass ? "  ok   " : "  FAIL ") + name + "\n");
  if (!pass) process.stdout.write("       " + detail.replace(/\n/g, "\n       ") + "\n");
}
function expect(cond: unknown, msg: string): true { if (!cond) throw new Error(msg); return true; }

const TOKEN = "abcdefghij0123456789AB";
const JOUR_MS = 86_400_000;

// =================================================================================================
//  1. construireLienInvite, the link's shape, and the honest fallback
// =================================================================================================

test("lien_construit_depuis_hote_et_jeton", () =>
  expect(construireLienInvite("share.example.com", TOKEN) === "https://share.example.com/#k=" + TOKEN,
    "vu " + construireLienInvite("share.example.com", TOKEN)));

test("lien_hote_null_rend_null_plutot_qu_une_url_qui_ne_marcherait_pas", () =>
  expect(construireLienInvite(null, TOKEN) === null, "GUEST_HOST non configuré doit rendre null, pas une URL inventée"));

test("lien_hote_undefined_rend_null", () =>
  expect(construireLienInvite(undefined, TOKEN) === null, "vu " + construireLienInvite(undefined, TOKEN)));

test("lien_hote_chaine_vide_rend_null", () =>
  // functions/api/invites.ts's guestHost() only ever sends null or a real hostname, never "",
  // this proves the client would still refuse to build a broken link even from a malformed reply.
  expect(construireLienInvite("", TOKEN) === null, "un hôte vide ne doit jamais produire de lien"));

test("lien_hote_avec_espaces_est_nettoye", () =>
  expect(construireLienInvite("  share.example.com  ", TOKEN) === "https://share.example.com/#k=" + TOKEN,
    "vu " + construireLienInvite("  share.example.com  ", TOKEN)));

test("lien_jeton_vide_rend_null", () =>
  expect(construireLienInvite("share.example.com", "") === null, "sans jeton il n'y a rien à partager"));

// =================================================================================================
//  2. inviteEstVivante, the same "live" rule the server enforces server-side
// =================================================================================================

const dans30Jours = new Date(Date.now() + 30 * JOUR_MS).toISOString();
const hier = new Date(Date.now() - JOUR_MS).toISOString();

test("invite_fraiche_sans_expiration_est_vivante", () =>
  expect(inviteEstVivante({ revoked: false, expiresAt: null }) === true, "sans expiration, vivante tant que non révoquée"));

test("invite_fraiche_avec_expiration_future_est_vivante", () =>
  expect(inviteEstVivante({ revoked: false, expiresAt: dans30Jours }) === true, "vu expiresAt=" + dans30Jours));

test("invite_revoquee_n_est_jamais_vivante_meme_avec_expiration_future", () =>
  expect(inviteEstVivante({ revoked: true, expiresAt: dans30Jours }) === false,
    "révoquée doit primer, même avec une expiration qui n'est pas encore atteinte"));

test("invite_expiree_n_est_plus_vivante", () =>
  expect(inviteEstVivante({ revoked: false, expiresAt: hier }) === false, "une expiration dans le passé doit exclure l'invite"));

test("invite_avec_expiration_illisible_n_explose_pas_et_reste_vivante", () =>
  // Date.parse("n'importe quoi") est NaN : le garde `!Number.isNaN` doit s'appliquer, pas planter.
  expect(inviteEstVivante({ revoked: false, expiresAt: "n'importe quoi" }) === true,
    "une date illisible ne doit ni planter ni exclure l'invite par erreur"));

// =================================================================================================
//  3. ligneInviteAffichage, pure formatting of one row
// =================================================================================================

test("ligne_jamais_utilisee_dit_never_used", () => {
  const l = ligneInviteAffichage({ createdAt: "2026-08-01T10:00:00.000Z", lastUsedAt: null, lastName: null, uses: 0 });
  return expect(l.created === "2026-08-01", "vu " + l.created)
      && expect(l.lastUsed === "never used", "vu " + JSON.stringify(l.lastUsed))
      && expect(l.uses === "0", "vu " + l.uses);
});

test("ligne_utilisee_porte_la_date_et_le_dernier_nom_vu", () => {
  const l = ligneInviteAffichage({
    createdAt: "2026-08-01T10:00:00.000Z", lastUsedAt: "2026-08-10T14:30:00.000Z", lastName: "Marie", uses: 4,
  });
  return expect(l.created === "2026-08-01", "vu " + l.created)
      && expect(l.lastUsed === "2026-08-10 · Marie", "vu " + JSON.stringify(l.lastUsed))
      && expect(l.uses === "4", "vu " + l.uses);
});

test("ligne_utilisee_sans_nom_connu_n_affiche_que_la_date", () => {
  // Une invite peut avoir été échangée (`POST /api/invite`) avant que le nom ne soit envoyé
  // (edge 20 du dossier de décision : le nom vit dans invites.last_name, pas dans le jeton).
  const l = ligneInviteAffichage({ createdAt: "2026-08-01T10:00:00.000Z", lastUsedAt: "2026-08-10T14:30:00.000Z", lastName: null, uses: 1 });
  return expect(l.lastUsed === "2026-08-10", "sans last_name connu, pas de tiret suivi de rien, vu " + JSON.stringify(l.lastUsed));
});

test("ligne_sans_date_de_creation_rend_le_tiret_court", () =>
  expect(ligneInviteAffichage({ createdAt: null, lastUsedAt: null, lastName: null, uses: 0 }).created === "-",
    "même convention que panneaux/plans.ts pour une date absente"));

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
