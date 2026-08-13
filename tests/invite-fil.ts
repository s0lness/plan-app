#!/usr/bin/env node
// =================================================================================================
//  THE GUEST CLIENT'S PURE LOGIC — NO BROWSER, against src/ts by import.
// =================================================================================================
//   node tests/invite-fil.ts
//
// Covers docs/decisions/0004-partage-par-lien.md, "batch 3, guest client": the token capture from
// `location.hash` (`src/ts/fil/invite.ts`), the storage-key choice per mode (`src/ts/noyau/nombres.ts`),
// and the duplicate-name display rule (`src/ts/mesure/curseur-pair.ts`). Everything network-shaped,
// DOM-shaped, or timing-shaped about the guest flow belongs to `tests/porte-invitee.ts` (a real
// browser) instead; this suite only exercises what is provably pure. Style matches
// tests/invitation.ts, which this suite is the client-side counterpart of.

import { hashSansJeton, jetonDepuisHash } from "../src/ts/fil/jeton-hash.ts";
import { KEY_GUEST_LOCAL, keyPourMode, keyPourPlan } from "../src/ts/noyau/nombres.ts";
import { dedupedDisplayName } from "../src/ts/mesure/curseur-pair.ts";
import type { ResultatSimple } from "./_types.ts";

// =================================================================================================
//  ASSERTION PLUMBING (same vocabulary as tests/invitation.ts / tests/porte.ts)
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

// A realistic 22-char base64url token, the shape `jetonInvitation()` (functions/invitation.ts)
// actually produces and the ONLY shape `JETON_HASH_RE` accepts.
const JETON = "abcdefghij0123456789AB";

// =================================================================================================
//  1. jetonDepuisHash — the token's shape in `location.hash`
// =================================================================================================

test("jeton_absent_du_hash_rend_null", () =>
  expect(jetonDepuisHash("") === null && jetonDepuisHash("#") === null,
    "un hash vide ou réduit à # ne doit rendre aucun jeton"));

test("jeton_lu_avec_le_dièse_en_tête", () =>
  expect(jetonDepuisHash("#k=" + JETON) === JETON, "vu " + jetonDepuisHash("#k=" + JETON)));

test("jeton_lu_sans_le_dièse", () =>
  expect(jetonDepuisHash("k=" + JETON) === JETON, "la fonction doit tolérer un hash déjà nettoyé de son #"));

test("jeton_lu_au_milieu_d_autres_segments", () =>
  expect(jetonDepuisHash("#a=1&k=" + JETON + "&b=2") === JETON,
    "un autre segment avant ou après ne doit pas gêner la lecture"));

test("jeton_trop_court_est_ignore", () =>
  expect(jetonDepuisHash("#k=trop-court") === null,
    "en dessous de 16 caractères, ce n'est pas un jeton valide (JETON_RE du serveur)"));

test("jeton_trop_long_est_ignore", () =>
  expect(jetonDepuisHash("#k=" + "x".repeat(65)) === null,
    "au-dessus de 64 caractères non plus"));

test("jeton_avec_caracteres_hors_base64url_est_ignore", () =>
  expect(jetonDepuisHash("#k=" + JETON.slice(0, 20) + "+/") === null,
    "+ et / ne sont pas base64url : ce segment ne doit pas être pris pour un jeton"));

test("cle_kk_ne_matche_pas_k", () =>
  expect(jetonDepuisHash("#kk=" + JETON) === null,
    "le motif doit ancrer sur k= exactement, pas sur un préfixe (kk=, ok=…)"));

// =================================================================================================
//  2. hashSansJeton — stripped SECOND, and only the k= segment
// =================================================================================================

test("hash_sans_jeton_est_vide_si_le_jeton_etait_seul", () =>
  expect(hashSansJeton("#k=" + JETON) === "", "vu " + JSON.stringify(hashSansJeton("#k=" + JETON))));

test("hash_sans_jeton_garde_les_autres_segments", () =>
  expect(hashSansJeton("#a=1&k=" + JETON + "&b=2") === "#a=1&b=2",
    "vu " + JSON.stringify(hashSansJeton("#a=1&k=" + JETON + "&b=2"))));

test("hash_sans_jeton_sur_un_hash_sans_jeton_ne_bouge_rien", () =>
  expect(hashSansJeton("#a=1") === "#a=1", "aucun k= à retirer : le hash doit rester identique"));

test("hash_sans_jeton_sur_un_hash_vide_rend_vide", () =>
  expect(hashSansJeton("") === "" && hashSansJeton("#") === "", "rien à retirer, rien à rendre"));

// =================================================================================================
//  3. keyPourMode / keyPourPlan — design edge 13, the storage key never collides across modes
// =================================================================================================

test("menage_main_garde_la_cle_nue_historique", () =>
  expect(keyPourMode("menage", "main") === "room-planner-v4",
    "les octets déjà écrits chez le foyer ne doivent pas être renommés"));

test("menage_sans_id_retombe_aussi_sur_la_cle_nue", () =>
  expect(keyPourMode("menage", null) === "room-planner-v4",
    "un id absent doit se comporter comme main, exactement comme keyPourPlan"));

test("menage_un_autre_plan_est_namespace", () =>
  expect(keyPourMode("menage", "cave") === "room-planner-v4:cave",
    "un plan secondaire du foyer garde son comportement d'avant ce batch"));

test("invite_sur_main_n_utilise_jamais_la_cle_nue", () =>
  // THE decisive case (design edge 13): an invitation to the household's OWN `main` plan must
  // never collapse to the bare key, unlike the household door's `keyPourPlan("main")`.
  expect(keyPourMode("invite", "main") === "room-planner-v4:main"
    && keyPourMode("invite", "main") !== keyPourPlan("main"),
    "vu " + keyPourMode("invite", "main") + " (keyPourPlan(main) = " + keyPourPlan("main") + ")"));

test("invite_sans_id_reste_namespace_sous_un_radical_distinct", () =>
  expect(keyPourMode("invite", null) === "room-planner-v4:invite"
    && keyPourMode("invite", null) !== "room-planner-v4",
    "vu " + keyPourMode("invite", null)));

test("local_seul_a_sa_propre_cle_jamais_la_nue_jamais_namespacee", () => {
  const k = keyPourMode("local", null);
  return expect(k === KEY_GUEST_LOCAL, "vu " + k)
      && expect(k !== "room-planner-v4", "ne doit jamais être la clé nue")
      && expect(k !== keyPourMode("invite", "main"), "ne doit jamais être une clé d'invite");
});

test("local_seul_ignore_tout_id_de_plan_fourni", () =>
  // A plan id can leak in from `planCourant()`'s fallback (main.ts always passes SOME id): local-only
  // mode must not let it influence the key at all.
  expect(keyPourMode("local", "peu-importe") === KEY_GUEST_LOCAL,
    "l'id ne doit jamais changer la clé du mode local"));

test("les_trois_modes_sur_main_donnent_trois_cles_distinctes", () => {
  const m = keyPourMode("menage", "main"), i = keyPourMode("invite", "main"), l = keyPourMode("local", "main");
  return expect(new Set([m, i, l]).size === 3, "vu menage=" + m + " invite=" + i + " local=" + l);
});

// =================================================================================================
//  4. dedupedDisplayName — design edge 3, display only, never the stored name
// =================================================================================================

test("nom_unique_reste_tel_quel", () =>
  expect(dedupedDisplayName([{ tag: "a", name: "Marie" }], { tag: "a", name: "Marie" }) === "Marie",
    "aucune collision : rien à désambiguïser"));

test("deux_pairs_meme_nom_le_second_par_ordre_de_tag_porte_2", () => {
  const tous = [{ tag: "b", name: "Marie" }, { tag: "a", name: "Marie" }];   // insertion order irrelevant
  return expect(dedupedDisplayName(tous, { tag: "a", name: "Marie" }) === "Marie",
    "le tag trié en premier (\"a\") doit rester nu")
    && expect(dedupedDisplayName(tous, { tag: "b", name: "Marie" }) === "Marie (2)",
    "le second par ordre de tag (\"b\") doit porter (2)");
});

test("trois_pairs_meme_nom_sont_numerotes_dans_l_ordre_du_tag", () => {
  const tous = [{ tag: "z", name: "Marie" }, { tag: "a", name: "Marie" }, { tag: "m", name: "Marie" }];
  return expect(dedupedDisplayName(tous, { tag: "a", name: "Marie" }) === "Marie", "a = nu")
    && expect(dedupedDisplayName(tous, { tag: "m", name: "Marie" }) === "Marie (2)", "m = (2)")
    && expect(dedupedDisplayName(tous, { tag: "z", name: "Marie" }) === "Marie (3)", "z = (3)");
});

test("deux_ecrans_recevant_la_meme_liste_calculent_le_meme_rang", () => {
  // THE decisive property: the discriminator must not depend on which client asks, only on the
  // peer list itself — the server broadcasts the SAME list to everyone, and there is no
  // coordination round trip to agree on who is "(2)".
  const listeA = [{ tag: "a", name: "Marie" }, { tag: "b", name: "Marie" }];
  const listeB = [{ tag: "b", name: "Marie" }, { tag: "a", name: "Marie" }];   // shuffled, same set
  return expect(dedupedDisplayName(listeA, { tag: "b", name: "Marie" }) === dedupedDisplayName(listeB, { tag: "b", name: "Marie" }),
    "l'ordre d'arrivée dans la liste ne doit pas influer sur le rang");
});

test("des_noms_differents_ne_se_desambiguisent_jamais", () => {
  const tous = [{ tag: "a", name: "Marie" }, { tag: "b", name: "Julien" }];
  return expect(dedupedDisplayName(tous, { tag: "a", name: "Marie" }) === "Marie", "Marie ne doit pas changer")
    && expect(dedupedDisplayName(tous, { tag: "b", name: "Julien" }) === "Julien", "Julien ne doit pas changer");
});

test("une_cible_sans_tag_ne_se_desambiguise_jamais", () =>
  // A value with no `tag` (read before the wire ever assigned one) simply cannot collide.
  expect(dedupedDisplayName([{ tag: "a", name: "Marie" }], { name: "Marie" }) === "Marie",
    "sans tag, aucune numérotation n'est possible"));

test("un_nom_vide_reste_vide", () =>
  expect(dedupedDisplayName([{ tag: "a" }], { tag: "a" }) === "", "displayName() vide -> rien à désambiguïser"));

test("preferer_le_nom_avant_de_desambiguiser_pas_l_email", () => {
  // The discriminator must key off the RENDERED name (displayName's own "explicit name beats
  // email" rule), not the raw fields: two household peers with different emails but the SAME
  // chosen display name still collide, disambiguated by tag order like any other pair.
  const tous = [{ tag: "b", name: "Sacha" }, { tag: "a", email: "sacha@example.com" }];
  return expect(dedupedDisplayName(tous, { tag: "a", email: "sacha@example.com" }) === "Sacha",
    "\"a\" trie en premier : doit rester nu, vu " + dedupedDisplayName(tous, { tag: "a", email: "sacha@example.com" }))
    && expect(dedupedDisplayName(tous, { tag: "b", name: "Sacha" }) === "Sacha (2)",
    "\"b\" trie en second : doit porter (2), vu " + dedupedDisplayName(tous, { tag: "b", name: "Sacha" }));
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
