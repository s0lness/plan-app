#!/usr/bin/env node
// =================================================================================================
//  WIRE IDENTITY, CLIENT SIDE: NO BROWSER, by import against the real client modules.
// =================================================================================================
//   node tests/identite-fil.ts
//
// Covers docs/decisions/0004-partage-par-lien.md, "batch 2, wire identity", client side:
// `displayName`/`personColor` (src/ts/mesure/curseur-pair.ts) preferring an explicitly sent name,
// `wsSameAccount` (src/ts/fil/etat.ts) never matching two different guests, and, the highest-risk
// item in the whole feature (design edge 1), a stored XSS proof for a guest name rendered by
// `creerNoeudCurseur`.
//
// Style and assertion vocabulary match tests/porte.ts / tests/invitation.ts, which this suite
// continues. Deliberately does NOT import `src/ts/fil/presence.ts`: that module (and everything
// it pulls in through `fil/drapeaux.ts`) reads `window`/`location` at MODULE SCOPE, which plain
// node has neither of. `curseur-pair.ts` and `fil/etat.ts` do not, and are imported directly:
// see AGENTS.md, "Blank startup", for why module-scope reads of globals are the trap this avoids.

import { displayName, personColor, creerNoeudCurseur } from "../src/ts/mesure/curseur-pair.ts";
import { creerFil, wsFromMe, wsSameAccount } from "../src/ts/fil/etat.ts";
import type { Fil, Pair } from "../src/ts/fil/etat.ts";
import { escapeHtml } from "../src/ts/noyau/nombres.ts";
import type { ResultatSimple } from "./_types.ts";

// =================================================================================================
//  MINIMAL DOM STUB, just enough for `creerNoeudCurseur`, nothing else
// =================================================================================================
// `creerNoeudCurseur` calls exactly two DOM operations: `document.createElement("div")`, then sets
// `.className` and `.innerHTML` on the result. `innerHTML` here is a PLAIN STRING STORE, with NO
// parsing attempted: that is precisely what makes this a faithful (not a simulated) proof. A real
// browser's `.innerHTML` SETTER is what parses its argument as HTML and instantiates whatever tags
// it finds, this stub captures EXACTLY the string that setter would receive. If that string never
// contains a raw, un-escaped "<img …>" and DOES contain the escaped form, a real browser parsing
// it necessarily renders inert text, never an element. No jsdom/happy-dom in this repository (see
// AGENTS.md, "browserless" tests): this is the honest alternative for the one function that needs
// `document` at all in this suite.
class ElementStub {
  tagName: string;
  className = "";
  private html = "";
  constructor(tag: string) { this.tagName = tag; }
  get innerHTML(): string { return this.html; }
  set innerHTML(v: string) { this.html = v; }
}
(globalThis as unknown as { document: { createElement: (tag: string) => ElementStub } }).document = {
  createElement: (tag: string) => new ElementStub(tag),
};

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
//  1. displayName / personColor: prefer an explicitly sent name (batch 2 item 8)
// =================================================================================================

await test("displayName_prefere_le_nom_explicite_sur_l_email", () => {
  const p: Pair = { email: "sylve@example.com", name: "Marie" };
  return expect(displayName(p) === "Marie", "un nom explicite doit l'emporter sur l'email, vu " + JSON.stringify(displayName(p)));
});

await test("displayName_retombe_sur_l_email_sans_nom", () => {
  const p: Pair = { email: "jean.dupont42@example.com" };
  return expect(displayName(p) === "Jean Dupont", "sans nom, retombee sur la derivation d'email, vu " + JSON.stringify(displayName(p)));
});

await test("displayName_retombe_sur_by_sans_email", () => {
  const p: Pair = { by: "marie@example.com" };
  return expect(displayName(p) === "Marie", "sans email, retombee sur 'by', vu " + JSON.stringify(displayName(p)));
});

await test("displayName_chaine_brute_reste_compatible", () => {
  // Every PRE-EXISTING call site passed a bare email string: additive, so this must keep working.
  return expect(displayName("sylve@example.com") === "Sylve", "une chaine brute doit toujours fonctionner comme avant");
});

await test("displayName_vide_rend_une_chaine_vide", () => {
  const p: Pair = {};
  return expect(displayName(p) === "", "ni nom ni email/by : chaine vide, jamais 'undefined', vu " + JSON.stringify(displayName(p)));
});

await test("displayName_nom_est_coupe_a_40", () => {
  const p: Pair = { name: "x".repeat(60) };
  return expect(displayName(p).length === 40, "un nom deja trop long (ne devrait pas arriver, le serveur borne) reste borne cote client aussi");
});

await test("personColor_prefere_le_nom_deterministe", () => {
  const p1: Pair = { name: "Marie", email: "" };
  const p2: Pair = { name: "Marie", email: "" };
  return expect(personColor(p1) === personColor(p2), "le meme nom doit toujours donner la meme couleur");
});

await test("personColor_chaine_brute_reste_compatible", () => {
  return expect(personColor("sylve@example.com") === personColor("sylve@example.com"),
    "une chaine brute (email) doit toujours fonctionner comme avant, deterministe");
});

await test("personColor_sans_rien_retombe_sur_le_repli", () => {
  const p: Pair = {};
  return expect(personColor(p, "#123456") === "#123456", "sans nom ni email/by, la couleur retombe sur le parametre fallback");
});

// =================================================================================================
//  2. wsSameAccount: NEVER true for two DIFFERENT guests (batch 2 item 8, design edges 8/9)
// =================================================================================================
// BEFORE this field existed, every unauthenticated caller shared the SAME fallback identity
// ("inconnu"), so `by === fil.wsMe.email` matched every stranger holding the link: each guest saw
// every OTHER guest wearing the `.self` outline, the "your other device" tooltip and the "Other
// device" cursor label, the strongest trust marker in the UI, handed to a stranger.

function filFoyer(email: string, tag: string): Fil {
  const f = creerFil();
  f.wsMe = { email, tag, color: "#1f6f78", name: "", guest: false, guestId: "" };
  return f;
}
function filInvite(guestId: string, tag: string, name = ""): Fil {
  const f = creerFil();
  f.wsMe = { email: "", tag, color: "#1f6f78", name, guest: true, guestId };
  return f;
}

await test("wsSameAccount_deux_invites_differents_ne_matchent_jamais", () => {
  // THE CORE BUG THIS BATCH FIXES: both guests carry email "" (the old shared fallback). Without
  // the guestId-based rule, `"" === ""` would have matched them.
  const fil = filInvite("guest-aaa", "tagA");
  const autre: Pair = { guest: true, guestId: "guest-bbb", tag: "tagB", email: "" };
  return expect(wsSameAccount(fil, autre) === false, "deux invites avec des guestId DIFFERENTS ne sont jamais 'mon autre appareil'");
});

await test("wsSameAccount_meme_invite_deux_onglets_matche", () => {
  // Two tabs of the SAME browser profile: same localStorage, so the SAME stored guestId (batch 3
  // is what generates/stores it; this suite only proves the comparison rule).
  const fil = filInvite("guest-aaa", "tagA");
  const monAutreOnglet: Pair = { guest: true, guestId: "guest-aaa", tag: "tagB", email: "" };
  return expect(wsSameAccount(fil, monAutreOnglet) === true, "le MEME invite (meme guestId), un autre onglet, doit matcher");
});

await test("wsSameAccount_invite_vs_foyer_jamais_vrai", () => {
  const fil = filInvite("guest-aaa", "tagA");
  const pairFoyer: Pair = { email: "sylve@example.com", tag: "tagC" };
  return expect(wsSameAccount(fil, pairFoyer) === false, "un invite ne peut jamais etre 'mon autre appareil' d'un compte du foyer");
});

await test("wsSameAccount_foyer_vs_invite_jamais_vrai", () => {
  const fil = filFoyer("sylve@example.com", "tagA");
  const pairInvite: Pair = { guest: true, guestId: "guest-zzz", tag: "tagB", email: "" };
  return expect(wsSameAccount(fil, pairInvite) === false, "un compte du foyer ne peut jamais etre 'mon autre appareil' d'un invite");
});

await test("wsSameAccount_deux_invites_sans_guestId_ne_matchent_pas_non_plus", () => {
  // Two guests who somehow both carry an EMPTY guestId (e.g. an older client, before batch 3 ever
  // sends `?g=`): the rule requires a NON-EMPTY match, so this still fails toward NOT-trust.
  const fil = filInvite("", "tagA");
  const autre: Pair = { guest: true, guestId: "", tag: "tagB", email: "" };
  return expect(wsSameAccount(fil, autre) === false, "deux guestId vides ne doivent jamais se compter comme un match");
});

await test("wsSameAccount_foyer_inchange_meme_email_autre_tag", () => {
  // The PRE-EXISTING household rule must survive untouched.
  const fil = filFoyer("sylve@example.com", "tagA");
  const monAutrePoste: Pair = { email: "sylve@example.com", tag: "tagB" };
  return expect(wsSameAccount(fil, monAutrePoste) === true, "deux appareils du MEME compte foyer doivent toujours matcher (regle inchangee)");
});

await test("wsSameAccount_jamais_vrai_pour_soi_meme", () => {
  const fil = filFoyer("sylve@example.com", "tagA");
  const moi: Pair = { email: "sylve@example.com", tag: "tagA" };
  return expect(wsFromMe(fil, moi) === true && wsSameAccount(fil, moi) === false,
    "le meme socket (meme tag) est SOI, jamais 'un autre appareil'");
});

// =================================================================================================
//  3. THE XSS AUDIT: a guest name of `<img src=x onerror=...>` renders as TEXT (design edge 1)
// =================================================================================================
// `creerNoeudCurseur` is the ONE node factory shared by the realtime wire and the probe (see its
// own header note): it builds `.innerHTML` from an SVG constant plus the ESCAPED label. This is
// the authoritative proof that the escaping actually runs on the string a real browser would then
// parse, not just that `escapeHtml` exists somewhere in the codebase.

const CHARGE_UTILE = '<img src=x onerror=alert(document.cookie)>';

await test("xss_creerNoeudCurseur_echappe_le_nom_dans_innerHTML", () => {
  const el = creerNoeudCurseur(CHARGE_UTILE, "#1f6f78");
  const html = el.innerHTML;
  // The RAW payload must be ABSENT as a literal substring: if it were present unescaped, a real
  // browser parsing this `.innerHTML` string would instantiate an <img> element and fire
  // `onerror` the instant it fails to load, this is what "renders as text" is a proxy for.
  const ok1 = expect(!html.includes(CHARGE_UTILE), "le HTML genere ne doit JAMAIS contenir le payload brut, vu " + html);
  // And the ESCAPED form must be present: proves the string was actually run through
  // `escapeHtml`, not merely that the raw one is absent for some unrelated reason.
  const ok2 = expect(html.includes(escapeHtml(CHARGE_UTILE)), "le HTML genere doit contenir la forme ECHAPPEE du nom, vu " + html);
  // Belt and suspenders: no bare "<img" tag opening anywhere in the generated markup.
  const ok3 = expect(!/<img[\s>]/i.test(html), "aucune balise <img> ne doit apparaitre dans le HTML genere, vu " + html);
  return ok1 && ok2 && ok3;
});

await test("xss_creerNoeudCurseur_echappe_aussi_guillemets_et_chevrons_seuls", () => {
  const attaque = `"><script>alert(1)</script>`;
  const el = creerNoeudCurseur(attaque, "#b04a3d");
  const html = el.innerHTML;
  // The escaped form is the ONLY place these code points may legitimately appear together: the
  // surrounding SVG/span markup is a FIXED, trusted constant that never itself carries the
  // attacker's literal three-character run `">'`, so this is not a false positive on our own markup.
  return expect(!/<script[\s>]/i.test(html), "aucune balise <script> ne doit apparaitre, vu " + html)
      && expect(!html.includes(attaque), "le payload brut ne doit jamais apparaitre tel quel, vu " + html)
      && expect(html.includes(escapeHtml(attaque)), "la forme ECHAPPEE du payload doit etre presente, vu " + html);
});

await test("xss_creerNoeudCurseur_porte_la_classe_guest_pour_la_provenance", () => {
  // Design edge 4: provenance must be visible on its own, never inferred from the name (someone
  // COULD name themselves after the owner). `.guest` (css/15-collab.css) is the only signal.
  const elInvite = creerNoeudCurseur("Marie", "#1f6f78", true);
  const elFoyer = creerNoeudCurseur("Sylve", "#1f6f78", false);
  return expect(elInvite.className === "peer-cur guest", "un curseur d'invite porte la classe guest, vu " + elInvite.className)
      && expect(elFoyer.className === "peer-cur", "un curseur du foyer ne la porte pas, vu " + elFoyer.className);
});

await test("xss_escapeHtml_neutralise_les_quatre_caracteres_dangereux", () => {
  // The primitive itself, isolated: `&`, `<`, `>`, `"`, everything `creerNoeudCurseur` and
  // `wsAppendChat` (src/ts/fil/presence.ts, rewritten to build the DOM via createElement/
  // textContent rather than innerHTML, so it needs no escaping at all) rely on.
  const sale = `&<>"'`;
  const propre = escapeHtml(sale);
  return expect(!propre.includes("&<") && propre.includes("&amp;") && propre.includes("&lt;")
    && propre.includes("&gt;") && propre.includes("&quot;"), "les quatre caracteres doivent etre echappes, vu " + propre);
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
