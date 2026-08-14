#!/usr/bin/env node
// =================================================================================================
//  THE LINK PREVIEW CARD — NO BROWSER, by import against functions/_middleware.ts.
// =================================================================================================
//   node tests/carte-og.ts
//
// Covers the invite link's Open Graph / Twitter card: `avecCarteOg` in functions/_middleware.ts
// injects `og:url`, `og:image` and `twitter:image` into an HTML response, built from THIS
// REQUEST's own Host — never from a committed hostname (this repository is public) and never
// from anything else the request carries. The static tags (title, description, type) live in
// src/head.html and are not this file's concern.
//
// THE TEST THAT MATTERS is the last one: the token travels in the URL FRAGMENT, which a server
// never sees, so a link-preview crawler can only ever learn the origin. If a future edit built
// `og:url` from `request.url` verbatim (the easy, wrong shortcut) instead of `origin`, the query
// string — and anything an operator ever put there by mistake — would ride along into every
// crawler's log. `carte_og_aucun_secret_de_la_requete` proves that never happens, whatever the
// query string carries.

import { onRequest as middleware } from "../functions/_middleware.ts";
import type { DonneeDynamique, ResultatSimple } from "./_types.ts";

// =================================================================================================
//  ASSERTION PLUMBING (same vocabulary as tests/porte.ts: `test` / `expect`)
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

function ctx(request: Request, env: DonneeDynamique, next: (input?: Request | string) => Promise<Response>) {
  return {
    request, env, next,
    params: {}, data: {}, functionPath: "", waitUntil: () => {}, passThroughOnException: () => {},
  } as DonneeDynamique;
}
// Stands in for the real Pages static-asset handler: returns the deliverable's actual `<head>`
// shape (a title, nothing more — this suite does not care about src/head.html's own tags), with
// the content type a real HTML response carries, `content-length` included, exactly like the
// thing `avecCarteOg` must recompute it against.
function fauxNextHtml(corps = "<!doctype html>\n<html><head><title>Plan d'appartement</title></head><body></body></html>") {
  return async () => new Response(corps, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "content-length": String(corps.length) },
  });
}
function fauxNextJson(corps: DonneeDynamique = { data: null, rev: 0 }) {
  const texte = JSON.stringify(corps);
  return async () => new Response(texte, { status: 200, headers: { "content-type": "application/json" } });
}
const requeteVers = (url: string, headers?: Record<string, string>) => new Request(url, { headers });

// =================================================================================================
//  1. an HTML response gets the three host-built tags, before </head>
// =================================================================================================

await test("carte_og_injectee_sur_reponse_html", async () => {
  const env = { HOUSEHOLD_HOSTS: "plan.example.com" };
  const r = requeteVers("https://plan.example.com/", { Host: "plan.example.com" });
  const res = await middleware(ctx(r, env, fauxNextHtml()));
  const texte = await res.text();
  return expect(res.headers.get("content-type")!.startsWith("text/html"), "content-type doit rester text/html")
      && expect(texte.includes('<meta property="og:url" content="https://plan.example.com/">'),
        "og:url manquant ou faux, vu : " + texte)
      && expect(texte.includes('<meta property="og:image" content="https://plan.example.com/apercu-lien.png">'),
        "og:image manquant ou faux, vu : " + texte)
      && expect(texte.includes('<meta name="twitter:image" content="https://plan.example.com/apercu-lien.png">'),
        "twitter:image manquant ou faux, vu : " + texte)
      && expect(texte.indexOf('og:url') < texte.indexOf('</head>'), "les balises doivent arriver AVANT </head>");
});

await test("carte_og_url_suit_l_hote_de_la_requete", async () => {
  // Same middleware, a DIFFERENT host: proves the tags are built from THIS request, not a
  // hardcoded value left over from the previous test.
  const env = { HOUSEHOLD_HOSTS: "plan.example.com,share.example.com" };
  const r = requeteVers("https://share.example.com/", { Host: "share.example.com" });
  const res = await middleware(ctx(r, env, fauxNextHtml()));
  const texte = await res.text();
  return expect(texte.includes('<meta property="og:url" content="https://share.example.com/">'), "og:url doit suivre l'hôte, vu : " + texte)
      && expect(texte.includes('<meta property="og:image" content="https://share.example.com/apercu-lien.png">'), "og:image doit suivre l'hôte, vu : " + texte);
});

// =================================================================================================
//  2. an API (JSON) response is never touched, on any door that reaches it
// =================================================================================================

await test("carte_og_absente_sur_reponse_json_porte_foyer", async () => {
  const env = { HOUSEHOLD_HOSTS: "plan.example.com" };
  const r = requeteVers("https://plan.example.com/api/plan", { Host: "plan.example.com" });
  const attendu = JSON.stringify({ data: null, rev: 0 });
  const res = await middleware(ctx(r, env, fauxNextJson({ data: null, rev: 0 })));
  const texte = await res.text();
  return expect(texte === attendu, "le corps JSON ne doit pas bouger d'un octet, vu : " + texte)
      && expect(!texte.includes("og:"), "aucune balise og: ne doit apparaître dans une réponse JSON");
});

await test("carte_og_absente_sur_reponse_json_porte_invite", async () => {
  const env = { HOUSEHOLD_HOSTS: "plan.example.com", GUEST_HOST: "share.example.com" };
  const r = requeteVers("https://share.example.com/api/plan", { Host: "share.example.com" });
  const attendu = JSON.stringify({ data: null, rev: 0 });
  const res = await middleware(ctx(r, env, fauxNextJson({ data: null, rev: 0 })));
  const texte = await res.text();
  return expect(texte === attendu, "le corps JSON ne doit pas bouger d'un octet sur la porte invite non plus, vu : " + texte)
      && expect(!texte.includes("og:"), "aucune balise og: ne doit apparaître dans une réponse JSON invitée");
});

// =================================================================================================
//  3. THE TEST THAT MATTERS: nothing from the request (query string included) ever reaches the
//     card, whatever it carries. The token travels in the fragment and is never sent to a server;
//     this proves the card-building code does not undo that by echoing the query string instead.
// =================================================================================================

await test("carte_og_aucun_secret_de_la_requete", async () => {
  const env = { HOUSEHOLD_HOSTS: "plan.example.com" };
  const r = requeteVers("https://plan.example.com/?p=main&k=secret", { Host: "plan.example.com" });
  const res = await middleware(ctx(r, env, fauxNextHtml()));
  const texte = await res.text();
  return expect(!texte.includes("main"), "le nom du plan (?p=main) ne doit apparaître nulle part, vu : " + texte)
      && expect(!texte.includes("secret"), "le jeton (?k=secret) ne doit apparaître nulle part, vu : " + texte)
      && expect(texte.includes('<meta property="og:url" content="https://plan.example.com/">'),
        "og:url doit rester l'origine NUE, sans le chemin ni la requête, vu : " + texte);
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
