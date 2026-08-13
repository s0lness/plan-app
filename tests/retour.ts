#!/usr/bin/env node
// =================================================================================================
//  THE FEEDBACK DROP — NO BROWSER, against the real route file over an in-memory D1 (tests/fake-d1.ts).
// =================================================================================================
//   node tests/retour.ts
//
// Covers functions/api/feedback.ts and its addition to functions/_middleware.ts's "invite" door
// surface. Style and assertion vocabulary match tests/invitation.ts, which this suite is the
// direct sibling of.

import { onRequestPost as retour } from "../functions/api/feedback.ts";
import { onRequest as middleware } from "../functions/_middleware.ts";
import { fakeD1 } from "./fake-d1.ts";
import type { DonneeDynamique, ResultatSimple } from "./_types.ts";

// =================================================================================================
//  ASSERTION PLUMBING (same vocabulary as tests/invitation.ts / tests/porte.ts)
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
const HOTE_INCONNU = "ailleurs.example.com";
const HOTES_ENV = { HOUSEHOLD_HOSTS: HOTE_FOYER, GUEST_HOST: HOTE_INVITE };
const JOUR_MS = 86_400_000;

function base() {
  const { db, env } = fakeD1(null);
  return { db, env: { ...env, ...HOTES_ENV } };
}

const inserePlan = (db: DonneeDynamique, id: string, auteur = "sylve@example.com") => {
  db.prepare("INSERT INTO plans(id,data,rev,updated_at,updated_by,name) VALUES(?1,?2,1,?3,?4,?5)")
    .run(id, JSON.stringify({ outline: [], walls: [], openings: [], pieces: [], cells: [] }),
      new Date().toISOString(), auteur, "Chez nous");
};

const jeton = (etiquette: string) => (etiquette + "-".repeat(22)).slice(0, 22);

interface GraineInvite { token: string; planId: string; lastName?: string | null; revoked?: number }
const insereInvite = (db: DonneeDynamique, g: GraineInvite) => {
  db.prepare(
    "INSERT INTO invites(token,plan_id,role,created_at,created_by,expires_at,revoked,uses,last_used_at,last_name) " +
    "VALUES(?1,?2,'edit',?3,'sylve@example.com',?4,?5,0,NULL,?6)"
  ).run(jeton(g.token), g.planId, new Date().toISOString(),
    new Date(Date.now() + 30 * JOUR_MS).toISOString(), g.revoked || 0, g.lastName ?? null);
};

const req = (url: string, opts: { method?: string; host: string; headers?: Record<string, string>; body?: unknown } = { host: HOTE_FOYER }) => {
  const headers = new Headers(opts.headers || {});
  headers.set("Host", opts.host);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, {
    method: opts.method || "POST",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
};
const cookieDe = (token: string) => "plan_invite=" + jeton(token);

async function poster(env: DonneeDynamique, host: string, corps: unknown, extra?: Record<string, string>) {
  return retour({
    request: req("https://" + host + "/api/feedback", { host, body: corps, headers: extra }), env,
  } as unknown as Parameters<typeof retour>[0]);
}

// =================================================================================================
//  1. ACCEPTED ON BOTH DOORS
// =================================================================================================

await test("retour_accepte_sur_la_porte_foyer", async () => {
  const { db, env } = base();
  inserePlan(db, "main");
  const res = await poster(env, HOTE_FOYER, { texte: "Le mur ne se redimensionne pas." });
  const corps = await res.json<DonneeDynamique>();
  const ligne = db.prepare("SELECT * FROM feedback ORDER BY id DESC LIMIT 1").get() as DonneeDynamique;
  return expect(res.status === 200, "doit répondre 200, vu " + res.status + " " + JSON.stringify(corps))
      && expect(corps.ok === true, "corps attendu {ok:true}")
      && expect(!!ligne, "une ligne doit avoir été écrite")
      && expect(ligne.porte === "foyer", "porte attendue foyer, vu " + JSON.stringify(ligne.porte))
      && expect(ligne.plan_id === "main", "plan_id attendu main, vu " + JSON.stringify(ligne.plan_id))
      && expect(ligne.texte === "Le mur ne se redimensionne pas.", "texte doit être conservé");
});

await test("retour_who_est_l_email_access_sur_la_porte_foyer", async () => {
  const { db, env } = base();
  inserePlan(db, "main");
  const res = await poster(env, HOTE_FOYER, { texte: "x" }, { "Cf-Access-Authenticated-User-Email": "sylve@example.com" });
  const corps = await res.json<DonneeDynamique>();
  const ligne = db.prepare("SELECT who FROM feedback ORDER BY id DESC LIMIT 1").get() as DonneeDynamique;
  return expect(res.status === 200, "doit répondre 200, vu " + res.status)
      && expect(ligne.who === "sylve@example.com", "who attendu l'email Access, vu " + JSON.stringify(ligne.who));
});

await test("retour_accepte_sur_la_porte_invite_et_porte_le_nom_connu", async () => {
  const { db, env } = base();
  inserePlan(db, "appartement");
  insereInvite(db, { token: "invit1", planId: "appartement", lastName: "Marie" });
  const res = await poster(env, HOTE_INVITE, { texte: "La fenêtre ne s'ouvre pas dans le bon sens." }, { Cookie: cookieDe("invit1") });
  const corps = await res.json<DonneeDynamique>();
  const ligne = db.prepare("SELECT * FROM feedback ORDER BY id DESC LIMIT 1").get() as DonneeDynamique;
  return expect(res.status === 200, "doit répondre 200, vu " + res.status + " " + JSON.stringify(corps))
      && expect(ligne.porte === "invite", "porte attendue invite, vu " + JSON.stringify(ligne.porte))
      && expect(ligne.plan_id === "appartement", "plan_id attendu appartement (celui de l'invite), vu " + JSON.stringify(ligne.plan_id))
      && expect(ligne.who === "Marie", "who attendu le nom déjà connu de l'invité, vu " + JSON.stringify(ligne.who));
});

await test("retour_porte_invite_sans_nom_connu_donne_who_vide", async () => {
  const { db, env } = base();
  inserePlan(db, "appartement");
  insereInvite(db, { token: "invit2", planId: "appartement", lastName: null });
  const res = await poster(env, HOTE_INVITE, { texte: "x" }, { Cookie: cookieDe("invit2") });
  const ligne = db.prepare("SELECT who FROM feedback ORDER BY id DESC LIMIT 1").get() as DonneeDynamique;
  return expect(res.status === 200, "doit répondre 200, vu " + res.status)
      && expect(ligne.who === "", "who attendu vide quand l'invité n'a jamais donné de nom, vu " + JSON.stringify(ligne.who));
});

await test("retour_porte_invite_jeton_invalide_est_403", async () => {
  const { db, env } = base();
  inserePlan(db, "appartement");
  const res = await poster(env, HOTE_INVITE, { texte: "x" }, { Cookie: cookieDe("n-existe-pas") });
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 403, "doit répondre 403, vu " + res.status)
      && expect(corps.error === "invite_invalide", "corps attendu invite_invalide, vu " + JSON.stringify(corps));
});

await test("retour_porte_invite_jeton_revoque_est_403", async () => {
  const { db, env } = base();
  inserePlan(db, "appartement");
  insereInvite(db, { token: "revoque1", planId: "appartement", revoked: 1 });
  const res = await poster(env, HOTE_INVITE, { texte: "x" }, { Cookie: cookieDe("revoque1") });
  return expect(res.status === 403, "un jeton révoqué doit être refusé, vu " + res.status);
});

// =================================================================================================
//  2. REFUSED ON AN UNKNOWN HOST
// =================================================================================================

await test("retour_refuse_sur_un_hote_inconnu", async () => {
  const { db, env } = base();
  inserePlan(db, "main");
  const res = await poster(env, HOTE_INCONNU, { texte: "x" });
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 403, "doit répondre 403, vu " + res.status)
      && expect(corps.error === "porte_refusee", "corps attendu porte_refusee, vu " + JSON.stringify(corps));
});

await test("middleware_invite_laisse_passer_api_feedback", async () => {
  const env = { HOUSEHOLD_HOSTS: HOTE_FOYER, GUEST_HOST: HOTE_INVITE };
  const r = new Request("https://" + HOTE_INVITE + "/api/feedback", { headers: { Host: HOTE_INVITE } });
  const appel = { appelee: false };
  const next = async () => { appel.appelee = true; return new Response("next-ok"); };
  await middleware({
    request: r, env, next, params: {}, data: {}, functionPath: "", waitUntil: () => {}, passThroughOnException: () => {},
  } as unknown as DonneeDynamique);
  return expect(appel.appelee, "next() doit être appelé pour /api/feedback sur la porte invite");
});

// =================================================================================================
//  3. VALIDATION: empty text, over-long text truncated not rejected, bidi/control stripped
// =================================================================================================

await test("retour_texte_vide_est_400", async () => {
  const { db, env } = base();
  inserePlan(db, "main");
  const res = await poster(env, HOTE_FOYER, { texte: "   " });
  const corps = await res.json<DonneeDynamique>();
  return expect(res.status === 400, "doit répondre 400, vu " + res.status)
      && expect(corps.error === "texte_requis", "corps attendu texte_requis, vu " + JSON.stringify(corps));
});

await test("retour_texte_absent_est_400", async () => {
  const { db, env } = base();
  inserePlan(db, "main");
  const res = await poster(env, HOTE_FOYER, {});
  return expect(res.status === 400, "doit répondre 400, vu " + res.status);
});

await test("retour_texte_trop_long_est_tronque_pas_refuse", async () => {
  const { db, env } = base();
  inserePlan(db, "main");
  const long = "x".repeat(5000);
  const res = await poster(env, HOTE_FOYER, { texte: long });
  const ligne = db.prepare("SELECT texte FROM feedback ORDER BY id DESC LIMIT 1").get() as DonneeDynamique;
  return expect(res.status === 200, "un texte trop long doit être ACCEPTÉ (tronqué), vu " + res.status)
      && expect(String(ligne.texte).length === 2000, "texte doit être tronqué à 2000, vu " + String(ligne.texte).length);
});

await test("retour_contact_trop_long_est_tronque", async () => {
  const { db, env } = base();
  inserePlan(db, "main");
  const res = await poster(env, HOTE_FOYER, { texte: "x", contact: "y".repeat(400) });
  const ligne = db.prepare("SELECT contact FROM feedback ORDER BY id DESC LIMIT 1").get() as DonneeDynamique;
  return expect(res.status === 200, "doit répondre 200, vu " + res.status)
      && expect(String(ligne.contact).length === 200, "contact doit être tronqué à 200, vu " + String(ligne.contact).length);
});

await test("retour_texte_est_nettoye_des_bidi_et_controles", async () => {
  const { db, env } = base();
  inserePlan(db, "main");
  // U+202E is RLO (right-to-left override), same fixture as tests/invitation.ts's nom_ tests.
  const sale = "Marie‮eirat" + "\x00\x1f\x7f" + "fin";
  const res = await poster(env, HOTE_FOYER, { texte: sale });
  const ligne = db.prepare("SELECT texte FROM feedback ORDER BY id DESC LIMIT 1").get() as DonneeDynamique;
  return expect(res.status === 200, "doit répondre 200, vu " + res.status)
      && expect(ligne.texte === "Marieeiratfin", "bidi et contrôles doivent avoir disparu, vu " + JSON.stringify(ligne.texte));
});

// =================================================================================================
//  4. RATE LIMIT: the (N+1)th write from the same IP in the hour is refused with 429
// =================================================================================================

await test("retour_limite_de_debit_refuse_la_sixieme_ecriture_depuis_la_meme_ip", async () => {
  const { db, env } = base();
  inserePlan(db, "main");
  const ip = "203.0.113.9";
  let dernier: DonneeDynamique | null = null;
  for (let i = 0; i < 5; i++) {
    dernier = await poster(env, HOTE_FOYER, { texte: "essai " + i }, { "CF-Connecting-IP": ip });
    const ok = expect(dernier.status === 200, "l'écriture #" + (i + 1) + " doit passer, vu " + dernier.status);
    if (!ok) return false;
  }
  const sixieme = await poster(env, HOTE_FOYER, { texte: "essai 5" }, { "CF-Connecting-IP": ip });
  const corps = await sixieme.json<DonneeDynamique>();
  const compte = db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE ip=?1").get(ip) as DonneeDynamique;
  return expect(sixieme.status === 429, "la 6e écriture en une heure depuis la même IP doit être refusée, vu " + sixieme.status)
      && expect(corps.error === "trop_de_retours", "corps attendu trop_de_retours, vu " + JSON.stringify(corps))
      && expect(corps.max === 5, "corps doit porter le plafond réel, vu " + JSON.stringify(corps.max))
      && expect(compte.n === 5, "la 6e tentative refusée ne doit PAS avoir écrit de ligne, vu " + compte.n);
});

await test("retour_limite_de_debit_est_par_ip_pas_globale", async () => {
  const { db, env } = base();
  inserePlan(db, "main");
  for (let i = 0; i < 5; i++) await poster(env, HOTE_FOYER, { texte: "a" }, { "CF-Connecting-IP": "198.51.100.1" });
  const autre = await poster(env, HOTE_FOYER, { texte: "b" }, { "CF-Connecting-IP": "198.51.100.2" });
  return expect(autre.status === 200, "une IP différente ne doit pas être affectée par le plafond de l'autre, vu " + autre.status);
});

await test("retour_absence_de_cf_connecting_ip_n_empeche_pas_l_ecriture", async () => {
  // No CF-Connecting-IP header at all (a direct-import test, or an edge case upstream): the write
  // still succeeds, it simply cannot be rate-limited by IP. Never a reason to refuse a report.
  const { db, env } = base();
  inserePlan(db, "main");
  const res = await poster(env, HOTE_FOYER, { texte: "sans ip" });
  return expect(res.status === 200, "doit quand même répondre 200, vu " + res.status);
});

// =================================================================================================
//  5. RETENTION: only the newest FEEDBACK_GARDE_MAX (500) rows survive
// =================================================================================================

await test("retour_le_plafond_de_retention_garde_les_lignes_les_plus_recentes", async () => {
  const { db, env } = base();
  inserePlan(db, "main");
  // Seed 501 pre-existing rows directly (bypassing the route, and its rate limit): a distinct `ip`
  // ('seed', never a real caller's IP) so they never count against the request under test below.
  const insereLigne = db.prepare(
    "INSERT INTO feedback(at,who,porte,plan_id,texte,contact,ua,ip) VALUES(?1,'','foyer','main',?2,'','','seed')"
  );
  for (let i = 0; i < 501; i++) {
    // Strictly increasing timestamps so "oldest" and "newest" are unambiguous regardless of
    // autoincrement id ordering.
    insereLigne.run(new Date(2020, 0, 1, 0, 0, i).toISOString(), "graine " + i);
  }
  const avant = (db.prepare("SELECT COUNT(*) AS n FROM feedback").get() as DonneeDynamique).n;
  const res = await poster(env, HOTE_FOYER, { texte: "la ligne la plus récente" }, { "CF-Connecting-IP": "203.0.113.50" });
  const apres = (db.prepare("SELECT COUNT(*) AS n FROM feedback").get() as DonneeDynamique).n;
  const dernierePresente = db.prepare("SELECT 1 FROM feedback WHERE texte=?1").get("la ligne la plus récente");
  const premiereGraineAbsente = db.prepare("SELECT 1 FROM feedback WHERE texte='graine 0'").get();
  return expect(avant === 501, "501 lignes doivent avoir été semées, vu " + avant)
      && expect(res.status === 200, "l'écriture qui déclenche le nettoyage doit quand même réussir, vu " + res.status)
      && expect(apres === 500, "seules les 500 plus récentes doivent survivre, vu " + apres)
      && expect(!!dernierePresente, "la ligne qui vient d'être écrite doit survivre")
      && expect(!premiereGraineAbsente, "la plus ancienne des graines doit avoir été supprimée");
});

await test("retour_garde_les_sauts_de_ligne", async () => {
  // UN NOM N'A PAS DE LIGNES, UN RETOUR SI. `cleanName` retire tous les contrôles, donc les sauts :
  // deux lignes arrivaient collées en une, sur le seul champ dont le but est qu'on y raconte
  // quelque chose. `cleanTexte` garde le saut, et lui seul.
  const { db, env } = base();
  const res = await poster(env, HOTE_FOYER, { texte: "Ligne une\r\nLigne deux\n\n\n\nLigne trois" });
  const ligne = db.prepare("SELECT texte FROM feedback ORDER BY id DESC LIMIT 1").get() as DonneeDynamique;
  const t = String(ligne.texte);
  return expect(res.status === 200, "doit accepter, vu " + res.status)
      && expect(t.indexOf("Ligne une\nLigne deux") === 0,
        "le retour chariot doit devenir un simple saut et les lignes survivre, vu " + JSON.stringify(t))
      && expect(t.includes("\n\nLigne trois"), "le paragraphe suivant doit rester séparé, vu " + JSON.stringify(t))
      && expect(!t.includes("\n\n\n"), "jamais plus de deux sauts de suite, vu " + JSON.stringify(t));
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
