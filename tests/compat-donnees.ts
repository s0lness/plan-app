#!/usr/bin/env node
// =================================================================================================
//  THE DATA COMPATIBILITY ORACLE: no browser, a few dozen milliseconds.
// =================================================================================================
//   node tests/compat-donnees.ts              # the corpus against the FROZEN fingerprints
//   node tests/compat-donnees.ts --b other/ts # DIFFERENTIAL: src/ts against other modules
//   node tests/compat-donnees.ts --prod       # adds today's PRODUCTION D1 row
//   node tests/compat-donnees.ts --graines N  # N documents drawn from the seed generator (def. 200)
//   node tests/compat-donnees.ts --corpus DIR # adds a PRIVATE corpus from a directory outside the
//                                              # repo (env PLAN_CORPUS_PRIVE is equivalent); off by default
//   node tests/compat-donnees.ts --figer      # REWRITES the fingerprints (a deliberate act, see below)
//
// WHY. The household's plan is in production, it carries real work, and older shapes of it
// exist. Any evolution of the reader (a client rewrite, but also a plain fix inside
// `sanitizeV5Plan`) must render EXACTLY the same plan on these documents. A defect here is
// silent and permanent: nobody sees that an opening depth, a side, or a name just vanished,
// and the very next save engraves it.
//
// WHAT SERVES AS THE ORACLE, and it is not a human judgment call:
//   1. `planFp(sanitizeState(wire))`, the server's 64-bit fingerprint (live-worker/ops.ts), sorted
//      lists, frozen field order. It's the ONLY identity compared over the realtime wire.
//   2. the BYTES of `v5StateWire()`, the exact PUT body and the content of an export (D-16).
//   3. the fingerprint of the canonicalized LOCAL plan, which additionally carries the openings'
//      `h`, `side`, `name` and the walls' `isOutline`, which the wire doesn't always carry. It's
//      THIS fingerprint that sees an inverted read precedence (D-4).
//   4. the FIXED POINT: `migrate(serialize(migrate(d)))` == `migrate(d)`, across the three fingerprints.
//   5. PERSONAL SETTINGS do not cross over: no `opts` in what `serialize()` produces,
//      whatever the input document carried (D-7).
//
// TWO MODES, and they catch two different things:
//   - REFERENCE (default): today's fingerprints against `tests/fixtures/empreintes-compat.json`,
//     versioned. A single implementation is enough; it's what catches a regression in the repo.
//   - DIFFERENTIAL (`--b <dir>`): two directories of MODULES, document by document, fingerprint
//     by fingerprint. It compares a branch or a copy of `src/ts` without resurrecting the old
//     client's brace-splitting fragile reader.
//
// A PRIVATE corpus (`--corpus <dir>`, or the `PLAN_CORPUS_PRIVE` environment variable) adds every
// `*.json` document found in a directory OUTSIDE this repository to the corpus, run through the
// exact same battery of checks as the built-in documents. ITS REFERENCE FINGERPRINTS LIVE IN THAT
// DIRECTORY TOO (`<dir>/empreintes.json`), never in a file inside this repository: `--figer` writes
// both files when the flag is given, but only the one for the built-in corpus when it is absent.
// Off by default, and absent, behaviour is byte-for-byte what it is without this feature: the
// barrier stays reproducible for anyone who clones the repo without such a directory.
//
// `--figer` is a DELIBERATE ACT: it prints every fingerprint that moves and refuses to stay quiet.
// A deliberate reading change gets frozen; a fingerprint that moves without anyone wanting it to is
// exactly the data loss this file exists to prevent.

import type { DonneeDynamique } from "./_types.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transformSync } from "esbuild";

import {
  sanitizeState, planFp, strHash, OpError,
  OPENING_KEYS, OPENING_TYPES, CELL_FLOORS, OPENING_H_MAX, PIECE_WH_MAX, NAME_MAX,
} from "../live-worker/ops.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RACINE = path.join(__dirname, "..");
const FIXTURES = path.join(__dirname, "fixtures");
const EMPREINTES = path.join(FIXTURES, "empreintes-compat.json");
const JOB = path.join(os.tmpdir(), "plan-backups");

const argv = process.argv.slice(2);
const opt = (nom: string, def: DonneeDynamique) => { const i = argv.indexOf(nom); return i >= 0 ? argv[i + 1] : def; };
const FIGER = argv.includes("--figer");
const PROD = argv.includes("--prod");
const DIR_B = opt("--b", null);
const N_GRAINES = Number(opt("--graines", 200));
const VERBEUX = argv.includes("--verbeux");
const CORPUS_PRIVE = opt("--corpus", process.env.PLAN_CORPUS_PRIVE || null);

// =================================================================================================
//  1. THE CLIENT'S READER, IMPORTED FROM THE MODULES (never recopied)
// =================================================================================================
// The `dir` parameter is what keeps the DIFFERENTIAL oracle useful: two module directories, two
// readers, the same battery of fingerprints. No textual extraction remains. A directory without
// the model's entry point is rejected instead of being interpreted as another source shape.
async function construireLecteur(dir: string) {
  const abs = path.isAbsolute(dir) ? dir : path.join(RACINE, dir);
  if (!fs.existsSync(abs)) throw new Error("répertoire de lecture introuvable : " + abs);
  if (!fs.existsSync(path.join(abs, "modele", "etat.ts"))) {
    throw new Error("ce répertoire n'est pas un source client modulaire (pas de modele/etat.ts) : " + abs);
  }

  const mod = (p: DonneeDynamique) => import(pathToFileURL(path.join(abs, p)).href);
  const [ETAT, PERSIST, FIL, CAT, CONTRAT, CREATION]: DonneeDynamique[] = await Promise.all([
    mod("modele/etat.ts"), mod("app/persistance.ts"), mod("fil/pseudo-fil.ts"),
    mod("catalogue/catalogue.ts"), mod("partage/contrat-serveur.ts"), mod("modele/creation.ts"),
  ]);
  for (const [nom, m, cles] of [
    ["modele/etat.ts", ETAT, ["migrate", "defaultState"]],
    ["app/persistance.ts", PERSIST, ["serialize", "saveOpts"]],
    ["fil/pseudo-fil.ts", FIL, ["v5StateWire", "v5OpeningWire"]],
    ["catalogue/catalogue.ts", CAT, ["TYPEMAP", "isWallMount"]],
    ["partage/contrat-serveur.ts", CONTRAT, ["FLOORS"]],
    ["modele/creation.ts", CREATION, ["reglerCompteurs"]],
  ]) {
    const absents = cles.filter((k: string) => m[k] === undefined);
    if (absents.length) throw new Error(`export introuvable dans ${nom} : ${absents.join(", ")}`);
  }

  const MEM: Record<string, string> = {};
  if (!globalThis.localStorage) {
    globalThis.localStorage = {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(MEM, k) ? MEM[k] : null),
      setItem: (k, v) => { MEM[k] = String(v); },
      removeItem: (k) => { delete MEM[k]; },
    } as Storage;
  }

  let etat: DonneeDynamique = null;
  const ctx = { get etat() { return etat; } };
  function _reset() {
    CREATION.reglerCompteurs(1000);
    for (const k of Object.keys(MEM)) delete MEM[k];
    etat = null;
  }
  return {
    lire(doc: DonneeDynamique) { _reset(); etat = ETAT.migrate(doc, null); return etat; },
    defaut() { _reset(); etat = ETAT.defaultState(null); return etat; },
    plan() { return etat && etat.plan; },
    opts() { return etat && etat.opts; },
    serialise() { return PERSIST.serialize(ctx); },
    fil() { return FIL.v5StateWire(etat && etat.plan, !!(etat && etat.setupDone)); },
    optsPersonnels() { if (etat) PERSIST.saveOpts(ctx); return MEM["room-planner-opts"] || null; },
    // BOOTSTRAPPING IS NOT IN THE MODEL: it mixes reading storage, rescuing, and the first
    // assignment of `state`. In the client it lives in
    // `main.ts`, which needs a DOM. Saying so is better than returning a made-up value.
    amorcerOpts() {
      throw new Error("amorcerOpts : l'amorçage vit dans src/ts/main.ts (DOM requis), pas dans le modèle");
    },
    contratClient() {
      _reset();
      const plan = { outline: [] as DonneeDynamique[], walls: [{ id: "w1", a: [0, 0], b: [400, 0], t: 12 }],
        openings: [] as DonneeDynamique[], pieces: [] as DonneeDynamique[], cells: [] as DonneeDynamique[] };
      const cles = Object.keys(FIL.v5OpeningWire(plan, { id: "o1", wallId: "w1", t0: 0, w: 80, h: 12,
        type: "door", side: 0, name: "Porte", hinge: 0, swing: 1 }));
      return {
        sols: [...CONTRAT.FLOORS].sort(),
        typesMuraux: Object.keys(CAT.TYPEMAP).filter((t) => CAT.isWallMount(t)).sort(),
        clesOuvertureFil: cles.sort(),
        borneProfondeur: CONTRAT.OPENING_H_MAX,
        borneMeuble: CONTRAT.PIECE_WH_MAX,
        borneNom: CONTRAT.NAME_MAX,
      };
    },
  };
}

// =================================================================================================
//  2. A DOCUMENT'S FINGERPRINTS
// =================================================================================================
// Canonicalization: sorted keys, entity lists sorted by id, normalized numbers. Two
// implementations have NO reason to produce the same key order or the same list order;
// they must produce the same CONTENT. Without this step, the oracle would go red over `JSON` formatting.
function canon(v: DonneeDynamique): string {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  }
  if (typeof v === "number") return Object.is(v, -0) ? "0" : String(v);
  return JSON.stringify(v);
}
const parId = (a: DonneeDynamique, b: DonneeDynamique) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
function canonPlanLocal(p: DonneeDynamique) {
  if (!p) return "null";
  const tri = (l: DonneeDynamique) => (Array.isArray(l) ? l.slice().sort(parId) : []);
  return canon({ outline: p.outline || [], walls: tri(p.walls), openings: tri(p.openings),
                 pieces: tri(p.pieces), cells: tri(p.cells) });
}

// The FULL survey of a document: what the oracle compares, and nothing else.
// `null` from `migrate()` is a LEGITIMATE verdict ("this is not a plan"): it gets frozen like the
// rest, otherwise a document that stopped being readable would go unnoticed.
function relever(lecteur: DonneeDynamique, doc: DonneeDynamique) {
  const st = lecteur.lire(doc);
  if (!st) return { lu: false };
  const fil = lecteur.fil();
  const ser = lecteur.serialise();
  let fp, refus = null;
  try { fp = planFp(sanitizeState(fil)); }
  catch (e) { refus = (e instanceof OpError ? e.reason : String(e)); fp = "REFUSÉ:" + refus; }

  // FIXED POINT: rereading what the application just saved must give back the same plan.
  const st2 = lecteur.lire(JSON.parse(JSON.stringify(ser)));
  const pointFixe = !!st2
    && canonPlanLocal(st2.plan) === canonPlanLocal(st.plan)
    && canon(lecteur.fil()) === canon(fil);

  return {
    lu: true,
    fp,                                   // 1. the server's fingerprint
    octets: strHash(JSON.stringify(fil)), // 2. the exact PUT body
    local: strHash(canonPlanLocal(st.plan)), // 3. the local plan (h/side/name/isOutline included)
    setupDone: !!st.setupDone,
    n: [ (st.plan.outline || []).length, (st.plan.walls || []).length, (st.plan.openings || []).length,
         (st.plan.pieces || []).length, (st.plan.cells || []).length ].join("/"),
    pointFixe,
    // D-7: the saved blob does NOT carry personal settings, whatever the input carried.
    sansOpts: !Object.prototype.hasOwnProperty.call(ser, "opts"),
  };
}

// =================================================================================================
//  3. THE CORPUS
// =================================================================================================
// Gathered, not assumed: each source is CHECKED when opened, and an absent source gets
// SAID. The household's backups cannot be reconstructed; the day they vanish from
// the machine, the oracle must say so instead of shrinking in silence.
const corpus: DonneeDynamique[] = [];
const manquants = [];
function ajouter(nom: string, quoi: string, doc: DonneeDynamique) { corpus.push({ nom, quoi, doc }); }
function ajouterFichier(nom: string, quoi: string, p: DonneeDynamique, transformer?: DonneeDynamique) {
  if (!fs.existsSync(p)) { manquants.push(nom + " (" + p + ")"); return null; }
  let doc;
  try { doc = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { manquants.push(nom + " (illisible : " + e.message + ")"); return null; }
  if (transformer) doc = transformer(doc);
  if (doc == null) { manquants.push(nom + " (contenu inattendu)"); return null; }
  ajouter(nom, quoi, doc);
  return doc;
}

// ---- 3a. the repo's VERSIONED fixtures ----
// LE CORPUS NE MESURE QUE LE MODÈLE VIVANT (décision 0021). Les deux plans du foyer ci-dessous
// étaient stockés au format v4 ; ils ont été CONVERTIS une fois, dans le dépôt, par le convertisseur
// juste avant qu'il ne soit retiré, et leurs trois empreintes sont restées identiques au caractère
// près : c'est la preuve que la conversion figée ici est exactement celle que l'application faisait
// à chaque ouverture. Ce qui reste des anciens formats est mesuré une fois, dans `tests/rapide.ts` :
// `migrate()` les refuse, et le filet « illisible » garde leurs octets.
ajouterFichier("fixture-plan-reel-77",
  "le plan du foyer, 22 murs / 30 ouvertures / 47 meubles / 10 cellules (converti depuis le v4 d'avant la bascule)",
  path.join(FIXTURES, "plan-reel-77.json"));
ajouterFichier("fixture-plan-rev177", "le plan du foyer à la révision 177 (converti depuis son v4)",
  path.join(FIXTURES, "plan-rev177.json"));
ajouterFichier("export-appartement", "export ENVELOPPÉ {app,version,savedAt,note,state} (v5 murs-seuls, appartement de démonstration)",
  path.join(RACINE, "exemple-appartement.json"));
// A1 (docs/invariants.md C-5) : document INVENTÉ, jamais un appartement réel, qui porte à lui seul
// `leaf`, `tr`, `dmin`, `pair`, `lm` (flux d une source) et `lux` (cible d une piece) ainsi que
// `free`, `hinge`, `swing` (déjà couverts, mais absents des autres fixtures figées) : sans ce
// document le corpus ne peut pas prouver que ces champs survivent une lecture.
ajouterFichier("fixture-plan-champs-recents",
  "v5 murs-seuls INVENTÉ : porte leaf/tr/dmin/pair/hp/off/hs/ratio/lm/lux/free/hinge/swing (C-5)",
  path.join(FIXTURES, "plan-champs-recents.json"));

// ---- 3b. the household's REAL backups (outside the repo, cannot be reconstructed) ----
// They are recopied into `tests/fixtures/` on the first run: a proof that depends on a
// temporary working folder is not a proof.
const DEPUIS_JOB: [string, string, string, ((objet: ReturnType<typeof JSON.parse>) => ReturnType<typeof JSON.parse>) | null][] = [
  ["prod-main-v5-plat", "v5 À PLAT tel que le GET /api/plan le rend (forme serveur)", "prod-main.json", null],
  ["export-u7", "export ENVELOPPÉ d'une session de travail", "u7-export.json", null],
  ["d1-rev283", "la ligne D1 de production figée (rev 283, écrite par le snapshot du Worker)",
   "backup-avant-multiplan.json", (o) => (o && o.data ? (typeof o.data === "string" ? JSON.parse(o.data) : o.data) : null)],
];
for (const [nom, quoi, fichier, transformer] of DEPUIS_JOB) {
  const fige = path.join(FIXTURES, "compat-" + nom + ".json");
  if (!fs.existsSync(fige)) {
    const src = path.join(JOB, fichier);
    if (fs.existsSync(src)) {
      let doc = JSON.parse(fs.readFileSync(src, "utf8"));
      if (transformer) doc = transformer(doc);
      if (doc) fs.writeFileSync(fige, JSON.stringify(doc, null, 0) + "\n");
    }
  }
  ajouterFichier(nom, quoi, fige);
}

// ---- 3c. shapes the frozen corpus does NOT carry, and that decide precedence ----
// NO real document available carries both a RICH nested `plan` and an AMPUTATED flat shape:
// today's D1 row is flat only, and today's wire carries
// `h`/`side`/`name`. Yet that is EXACTLY the case precedence protects (D-4), that of a
// local save written by a client from before the wire was widened. So we manufacture it, from
// a real plan, by repackaging the openings into the OLD shape (`side` in bit 1 of
// `hinge`, neither `h` nor `name`): read forward, it renders the rich openings; read
// backward, it renders whatever the catalog can re-guess. Two different fingerprints.
{
  const base = corpus.find((c) => c.nom === "prod-main-v5-plat");
  if (base) {
    const riche = JSON.parse(JSON.stringify(base.doc));
    const platAncien = {
      outline: riche.outline,
      walls: (riche.walls || []).map((w: DonneeDynamique) => ({ id: w.id, a: w.a, b: w.b, t: w.t })),
      openings: (riche.openings || []).map((o: DonneeDynamique) => ({
        id: o.id, wallId: o.wallId, t0: o.t0, w: o.w, type: o.type,
        hinge: (o.hinge ? 1 : 0) | (o.side ? 2 : 0),          // PACKED shape (before the widening)
        ...(o.type === "door" ? { swing: o.swing != null ? o.swing : 1 } : {}),
      })),
      pieces: riche.pieces, cells: riche.cells, setupDone: true,
    };
    // The RICH openings are made distinct from what the catalog would re-guess, otherwise the
    // two readings would coincide by chance and the document would prove nothing.
    riche.openings = (riche.openings || []).map((o: DonneeDynamique, i: number) => Object.assign({}, o, {
      h: Math.max(1, Math.min(200, (o.h || 12) + 1 + (i % 3))),
      name: "Ouverture " + i,
    }));
    ajouter("local-plan-riche-vs-fil-ancien",
      "enregistrement local : `plan` imbriqué RICHE + forme à plat AMPUTÉE (précédence D-4)",
      Object.assign({ setupDone: true, model: "v5", plan: riche }, platAncien));
    ajouter("fil-ancien-seul",
      "forme à plat SEULE, ouvertures empaquetées (`side` dans le bit 1 de `hinge`)",
      platAncien);
  }
}

// The NEW plan: `defaultState()`, read through the same path as a loaded plan (D-17).
ajouter("__defaut__", "`defaultState()` : appartement neuf 420×360, VIDE (D-17)", null);

// Documents that are NOT plans: `migrate()` must return `null`, and this verdict gets frozen too.
ajouter("refus-vide", "objet vide : `migrate()` refuse (null)", {});
ajouter("refus-rooms-vide", "`rooms: []` : `migrate()` refuse (null)", { rooms: [], envelope: null });
// Décision 0021 : un plan écrit dans une forme d'AVANT le modèle murs-seuls est un REFUS, et ce
// refus est figé ici comme le reste. Il n'est pas perdu pour autant : l'amorçage met ses octets de
// côté tels quels (`rescueUnreadable`, D-2), et `tests/rapide.ts` le prouve.
ajouter("refus-v4-salles", "v4 `rooms[]`+`envelope` : `migrate()` refuse (null), les octets vont au filet", {
  rooms: [{ id: 1, name: "Salon", floor: "parquet", ax: 0, ay: 0,
    room: { poly: [[0, 0], [500, 0], [500, 380], [0, 380]] },
    pieces: [{ id: 1, type: "sofa", name: "Canapé", x: 20, y: 40, w: 200, h: 90, rot: 0 }] }],
  envelope: { poly: [[0, 0], [500, 0], [500, 380], [0, 380]], floor: "parquet", pieces: [] },
  setupDone: true,
});
ajouter("refus-v3-mono-piece", "v1/v2/v3 mono-pièce {room,pieces,opts} : `migrate()` refuse (null)", {
  room: { poly: [[0, 0], [500, 0], [500, 380], [0, 380]], w: 500, l: 380, h: 250 },
  pieces: [{ id: 1, type: "sofa", name: "Canapé", x: 20, y: 40, w: 200, h: 90, rot: 0 }],
  opts: { labels: false, layLight: false, floor: "tile", collapsedCats: ["Kitchen"] },
});
// Un v5 ABÎMÉ (contour de 2 points, écriture coupée) : il tombait sur le chemin ancien format et
// revenait en appartement 420×360 par défaut. Il est maintenant refusé comme le reste, donc mis de
// côté au lieu d'être remplacé par un plan qui n'a jamais existé. C'est un GAIN, et il est figé ici.
ajouter("abime-outline-court", "v5 abîmé (contour de 2 points) : `migrate()` refuse (null)",
  { outline: [[0, 0], [10, 10]], walls: [], openings: [], pieces: [], cells: [] });

// ---- 3d. today's PRODUCTION D1 row (--prod) ----
// It does NOT get frozen: it moves with every save the household makes. It is therefore checked
// DIFFERENTIALLY and against its own properties (fixed point, no opts), never against a frozen fingerprint.
let docProd = null;
if (PROD) {
  const envFile = path.join(RACINE, "..", ".secrets.env");
  const env: Record<string, string> = {};
  if (fs.existsSync(envFile)) {
    for (const l of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
      if (m) env[m[1]] = m[2];
    }
  }
  const tok = env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  const acc = env.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  const DB = "<d1_database_id>";
  if (!tok || !acc) manquants.push("ligne D1 de production (identifiants absents de ~/projects/.secrets.env)");
  else {
    try {
      const out = execFileSync("curl.exe", ["-s", "-4", "-X", "POST",
        `https://api.cloudflare.com/client/v4/accounts/${acc}/d1/database/${DB}/query`,
        "-H", "Authorization: Bearer " + tok, "-H", "Content-Type: application/json",
        "--data", JSON.stringify({ sql: "SELECT rev, updated_by, data FROM plans WHERE id='main'" })],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      const rep = JSON.parse(out);
      const row = rep.success && rep.result && rep.result[0] && rep.result[0].results[0];
      if (!row) throw new Error("réponse sans ligne : " + out.slice(0, 200));
      docProd = JSON.parse(row.data);
      ajouter("__prod__", `ligne D1 de production DU JOUR (rev ${row.rev}, par ${row.updated_by})`, docProd);
    } catch (e) { manquants.push("ligne D1 de production (" + e.message + ")"); }
  }
}

// ---- 3e. an OPTIONAL private corpus, outside the repo, that leaves no trace here ----
// `--corpus <dir>` (or `PLAN_CORPUS_PRIVE`) points at a directory outside this repository.
// Every `*.json` document found there joins the corpus and goes through the SAME battery of
// checks as the built-in fixtures (section 5). Its own frozen fingerprints live NEXT TO IT
// (`<dir>/empreintes.json`, see section 5b): a private document's name and fingerprint must
// never reach a file inside this repository. A directory that is missing or empty is a loud
// failure, not a silently smaller corpus: that silence is exactly what this oracle exists to catch.
let CORPUS_PRIVE_ABS: string | null = null;
const NOMS_PRIVES = new Set<string>();
if (CORPUS_PRIVE) {
  CORPUS_PRIVE_ABS = path.isAbsolute(CORPUS_PRIVE) ? CORPUS_PRIVE : path.join(process.cwd(), CORPUS_PRIVE);
  if (!fs.existsSync(CORPUS_PRIVE_ABS) || !fs.statSync(CORPUS_PRIVE_ABS).isDirectory()) {
    process.stdout.write(`ÉCHEC corpus privé : répertoire introuvable : ${CORPUS_PRIVE_ABS}\n`);
    process.exit(1);
  }
  const fichiers = fs.readdirSync(CORPUS_PRIVE_ABS)
    .filter((f) => f.endsWith(".json") && f !== "empreintes.json")
    .filter((f) => fs.statSync(path.join(CORPUS_PRIVE_ABS as string, f)).isFile())
    .sort();
  if (!fichiers.length) {
    process.stdout.write(`ÉCHEC corpus privé : aucun document *.json dans ${CORPUS_PRIVE_ABS}\n`);
    process.exit(1);
  }
  for (const f of fichiers) {
    const nom = "prive-" + path.basename(f, ".json");
    const doc = ajouterFichier(nom, "document privé : " + f, path.join(CORPUS_PRIVE_ABS, f));
    if (doc) NOMS_PRIVES.add(nom);
  }
}

// =================================================================================================
//  4. THE SEED GENERATOR, WIRED INTO THE ORACLE
// =================================================================================================
// `tests/harnais-graine.ts` already knows how to reproducibly manufacture valid plans: it
// runs at load time, so we EXTRACT the generator from it (same technique as for the client)
// instead of recopying it. A rename over there loudly breaks this one.
// What these documents bring that the frozen corpus doesn't have: geometries nobody ever
// drew. What they can't give: a reference fingerprint, since they're manufactured on
// every run. So we ask them for their properties (fixed point, no opts, accepted by the
// validator) and, in differential mode, the equality of the two readings.
function construireGenerateur() {
  const src = fs.readFileSync(path.join(__dirname, "harnais-graine.ts"), "utf8");
  const decouper = (nom: string) => {
    const i = src.search(new RegExp("^(?:const |let |)?\\s*function\\s+" + nom + "\\s*\\(", "m"));
    if (i < 0) throw new Error("générateur : fonction introuvable dans harnais-graine.ts : " + nom);
    let n = 0, k = src.indexOf("{", i);
    for (; k < src.length; k++) {
      if (src[k] === "{") n++;
      else if (src[k] === "}") { n--; if (!n) break; }
    }
    return transformSync(src.slice(i, k + 1), { loader: "ts", target: "es2022" }).code;
  };
  const listeGestes = /^const GESTES = ([\s\S]*?);$/m.exec(src);
  if (!listeGestes) throw new Error("générateur : GESTES introuvable dans harnais-graine.ts");
  return new Function("sanitizeState", `
    "use strict";
    ${decouper("melange")}
    ${decouper("alea")}
    ${decouper("planDepart")}
    const longueur = (w) => Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const GESTES = ${listeGestes[1]};
    ${decouper("appliquerGeste")}
    // The two gestures that speak to the PROTOCOL (undo, reconnect) make no sense for a
    // document: here we're manufacturing a PLAN, not an interleaving. The rest is played as-is.
    const UTILES = GESTES.filter((g) => g !== "annuler" && g !== "reconnecter");
    return function planParGraine(graine) {
      const rnd = alea(graine);
      const cl = { plan: planDepart(), tag: "g" + (graine % 997), seqId: 0,
                   pousserHistorique() {}, annuler() { return false; } };
      const k = 3 + rnd.entier(18);
      for (let i = 0; i < k; i++) appliquerGeste(cl, rnd.choix(UTILES), rnd);
      return sanitizeState(cl.plan);
    };
  `)(sanitizeState);
}

// The same plan, presented in the FIVE accepted input shapes. It's the data contract from
// `docs/reecriture.md` §3, played out on randomly drawn geometries.
function formesDe(plan: DonneeDynamique, graine: number) {
  const plat = JSON.parse(JSON.stringify(plan));
  return [
    ["plat", plat],
    ["imbrique", { setupDone: true, model: "v5", plan: JSON.parse(JSON.stringify(plat)) }],
    ["enveloppe", { app: "room-planner", version: 5, savedAt: new Date(0).toISOString(), note: "graine " + graine,
                    state: { setupDone: true, model: "v5", plan: JSON.parse(JSON.stringify(plat)) } }],
    ["avec-opts", Object.assign(JSON.parse(JSON.stringify(plat)),
      { opts: { snap: false, labels: false, layLight: false, collapsedCats: ["Kitchen"], tvIn: 55 } })],
  ];
}

// =================================================================================================
//  5. EXECUTION
// =================================================================================================
let passes = 0, echecs = [];
const t0 = Date.now();
function ok(vrai: boolean, quoi: string, detail?: string) {
  if (vrai) { passes++; if (VERBEUX) process.stdout.write("  ok   " + quoi + "\n"); return true; }
  echecs.push({ quoi, detail });
  process.stdout.write("  ÉCHEC " + quoi + (detail ? "\n         " + detail : "") + "\n");
  return false;
}

const A = await construireLecteur("src/ts");
const B = DIR_B ? await construireLecteur(DIR_B) : null;

// ---- 5a. the corpus survey ----
const releves: Record<string, DonneeDynamique> = {};
for (const c of corpus) {
  const doc = c.nom === "__defaut__" ? null : c.doc;
  let r;
  if (c.nom === "__defaut__") {
    A.defaut();
    // `__defaut__` is NOT a historical document: it is manufactured by the client. The naming
    // choice changed at the switchover ("Salon" -> "Room 1") and the old differential mode already
    // named this single exception. We check the current choice, then normalize THIS ONE NAME so
    // the frozen fingerprint keeps watching the whole geometry without being rewritten.
    ok(A.plan()?.cells?.[0]?.name === "Room 1",
      "__defaut__ : le client crée la pièce neuve sous le nom Room 1");
    if (A.plan()?.cells?.[0]) A.plan().cells[0].name = "Salon";
    const st = { plan: A.plan(), setupDone: false };
    const fil = A.fil(), ser = A.serialise();
    r = { lu: true, fp: planFp(sanitizeState(fil)), octets: strHash(JSON.stringify(fil)),
          local: strHash(canonPlanLocal(st.plan)), setupDone: !!ser.setupDone,
          n: [ (st.plan.outline || []).length, (st.plan.walls || []).length, (st.plan.openings || []).length,
               (st.plan.pieces || []).length, (st.plan.cells || []).length ].join("/"),
          pointFixe: relever(A, JSON.parse(JSON.stringify(ser))).pointFixe,
          sansOpts: !Object.prototype.hasOwnProperty.call(ser, "opts") };
  } else {
    r = relever(A, doc);
  }
  releves[c.nom] = r;
  if (r.lu) {
    ok(r.pointFixe, `${c.nom} : point fixe, relire ce qu'on vient d'enregistrer ne change rien`);
    ok(r.sansOpts, `${c.nom} : aucun réglage personnel dans le blob enregistré (D-7)`);
    ok(!String(r.fp).startsWith("REFUSÉ"), `${c.nom} : le validateur du serveur accepte la relecture`,
      String(r.fp).startsWith("REFUSÉ") ? String(r.fp) : null);
  }
}

// ---- 5a bis. THE CLIENT-SERVER CONTRACT, from both sides at once ----
// C-5, the repo's most fragile invariant: a persisted field that isn't declared on BOTH
// sides never travels, WITHOUT a visible error. The server's validator now exports its
// whitelists; confronting them against what the client can write costs four lines and closes
// the entire class of bug. Without this test, the coincidence is only DOCUMENTED twice.
{
  const c = A.contratClient();
  const inconnusServeur = c.typesMuraux.filter((t) => !OPENING_TYPES.has(t));
  ok(inconnusServeur.length === 0,
    "contrat : tout type mural du catalogue client est accepté comme ouverture par le serveur",
    inconnusServeur.length ? "types refusés (donc perdus en silence) : " + inconnusServeur.join(", ") : null);
  const horsListe = c.clesOuvertureFil.filter((k) => !OPENING_KEYS.has(k));
  ok(horsListe.length === 0,
    "contrat : toute clé écrite par v5OpeningWire est dans OPENING_KEYS du serveur",
    horsListe.length ? "clés refusées : " + horsListe.join(", ") : null);
  const solsHorsListe = c.sols.filter((f) => !CELL_FLOORS.has(f));
  ok(solsHorsListe.length === 0, "contrat : les sols du client sont ceux du serveur (CELL_FLOORS)",
    solsHorsListe.length ? solsHorsListe.join(", ") : null);
  // The server bounds what's DANGEROUS, the client bounds what's SENSIBLE: the client bound can
  // be stricter, never wider (G-18). Wider means a value saved locally that will never
  // cross over, and nobody will see it.
  ok(c.borneProfondeur <= OPENING_H_MAX, "contrat : la profondeur bornée par le client tient dans OPENING_H_MAX",
    `client ${c.borneProfondeur} > serveur ${OPENING_H_MAX}`);
  ok(c.borneMeuble <= PIECE_WH_MAX, "contrat : la taille de meuble bornée par le client tient dans PIECE_WH_MAX",
    `client ${c.borneMeuble} > serveur ${PIECE_WH_MAX}`);
  ok(c.borneNom <= NAME_MAX, "contrat : le nom borné par le client tient dans NAME_MAX",
    `client ${c.borneNom} > serveur ${NAME_MAX}`);
}

// ---- 5b. REFERENCE mode: against the frozen fingerprints ----
// Split in two independent passes so a private document's fingerprint never lands in
// `tests/fixtures/empreintes-compat.json`: `estCible` decides which corpus names a given pass
// owns, `cheminEmpreintes` decides where that pass reads and writes its frozen file. Absent
// `--corpus`, `NOMS_PRIVES` is empty and this single call reproduces the old behaviour exactly.
function passeReference(estCible: (nom: string) => boolean, cheminEmpreintes: string, etiquette: string) {
  const fige: DonneeDynamique = fs.existsSync(cheminEmpreintes) ? JSON.parse(fs.readFileSync(cheminEmpreintes, "utf8")) : { documents: {} };
  const nouvelles: Record<string, DonneeDynamique> = {};
  for (const c of corpus) {
    if (c.nom === "__prod__") continue;         // production moves: it doesn't get frozen
    if (!estCible(c.nom)) continue;
    nouvelles[c.nom] = Object.assign({ quoi: c.quoi }, releves[c.nom]);
  }
  if (FIGER) {
    let bouge = 0;
    for (const nom of new Set([...Object.keys(fige.documents || {}), ...Object.keys(nouvelles)])) {
      const av = (fige.documents || {})[nom], ap = nouvelles[nom];
      const a = av && canon(Object.assign({}, av, { quoi: undefined }));
      const b = ap && canon(Object.assign({}, ap, { quoi: undefined }));
      if (a === b) continue;
      bouge++;
      process.stdout.write(`  FIGE ${nom}\n    avant ${a || "(absent)"}\n    après ${b || "(retiré)"}\n`);
    }
    fs.writeFileSync(cheminEmpreintes, JSON.stringify({
      quoi: "Empreintes de lecture du corpus de compatibilité. Écrites par `node tests/compat-donnees.ts --figer`."
          + " Une empreinte qui bouge sans qu'on l'ait voulu EST une perte de données : ne jamais refiger pour faire taire l'oracle.",
      fige: new Date().toISOString(), documents: nouvelles,
    }, null, 1) + "\n");
    process.stdout.write(`\nempreintes figées${etiquette} : ${Object.keys(nouvelles).length} documents, ${bouge} modifié(s)\n`);
    return;
  }
  for (const nom of Object.keys(nouvelles)) {
    const av = (fige.documents || {})[nom];
    if (!av) { ok(false, `${nom} : aucune empreinte de référence`, "lancer --figer si ce document est nouveau"); continue; }
    const a = canon(Object.assign({}, av, { quoi: undefined }));
    const b = canon(Object.assign({}, nouvelles[nom], { quoi: undefined }));
    ok(a === b, `${nom} : empreinte de lecture identique à la référence`,
      a === b ? null : `référence ${a}\n         aujourd'hui ${b}`);
  }
  for (const nom of Object.keys(fige.documents || {})) {
    if (!(nom in nouvelles)) ok(false, `${nom} : document du corpus DISPARU`, "le corpus ne rétrécit pas en silence");
  }
}

// `--figer` targets whichever corpus it's asked about: with `--corpus`, it freezes ONLY the
// private file, so a private-corpus run leaves ZERO trace on `tests/fixtures/empreintes-compat.json`
// (not even a timestamp). Outside `--figer`, both passes run read-only: a private corpus is
// checked in full, alongside the built-in one, and neither writes anything.
if (!(FIGER && CORPUS_PRIVE_ABS)) {
  passeReference((nom) => !NOMS_PRIVES.has(nom), EMPREINTES, "");
}
if (CORPUS_PRIVE_ABS) {
  passeReference((nom) => NOMS_PRIVES.has(nom), path.join(CORPUS_PRIVE_ABS, "empreintes.json"), " (corpus privé)");
}
if (FIGER) process.exit(0);

// ---- 5c. DIFFERENTIAL mode: two readers, document by document ----
if (B) {
  for (const c of corpus) {
    const rA = releves[c.nom];
    const rB = c.nom === "__defaut__" ? (B.defaut(), {
      lu: true, fp: planFp(sanitizeState(B.fil())), octets: strHash(JSON.stringify(B.fil())),
      local: strHash(canonPlanLocal(B.plan())), setupDone: !!B.serialise().setupDone,
      n: rA.n, pointFixe: rA.pointFixe, sansOpts: !Object.prototype.hasOwnProperty.call(B.serialise(), "opts"),
    }) : relever(B, c.doc);
    const a = canon(rA), b = canon(rB);
    ok(a === b, `${c.nom} : les deux lectures rendent la MÊME chose`,
      a === b ? null : `A ${a}\n         B ${b}`);
  }
}

// ---- 5d. the seed generator ----
if (N_GRAINES > 0) {
  const planParGraine = construireGenerateur();
  let vus = 0;
  for (let g = 1; g <= N_GRAINES; g++) {
    let plan;
    try { plan = planParGraine(g); }
    catch (e) { ok(false, `graine ${g} : le générateur a levé`, String(e && e.message)); continue; }
    for (const [forme, doc] of formesDe(plan, g)) {
      const rA = relever(A, doc);
      vus++;
      if (!rA.lu) { ok(false, `graine ${g}/${forme} : document non lu`); continue; }
      if (!rA.pointFixe) { ok(false, `graine ${g}/${forme} : point fixe rompu`); continue; }
      if (!rA.sansOpts) { ok(false, `graine ${g}/${forme} : des réglages personnels ont traversé`); continue; }
      if (String(rA.fp).startsWith("REFUSÉ")) { ok(false, `graine ${g}/${forme} : refusé par le serveur`, String(rA.fp)); continue; }
      if (B) {
        const rB = relever(B, doc);
        if (canon(rA) !== canon(rB)) { ok(false, `graine ${g}/${forme} : les deux lectures divergent`,
          `A ${canon(rA)}\n         B ${canon(rB)}`); continue; }
      }
      passes++;
    }
    // The FOUR shapes of the same plan must converge on the same server fingerprint: that's the
    // property saying an input shape is only packaging.
    const fps = formesDe(plan, g).map(([, doc]) => relever(A, doc).fp);
    ok(new Set(fps).size === 1, `graine ${g} : les quatre formes d'entrée donnent la même empreinte`,
      new Set(fps).size === 1 ? null : fps.join(" "));
  }
  process.stdout.write(`  générateur à graine : ${N_GRAINES} plans, ${vus} documents\n`);
}

// =================================================================================================
//  6. THE VERDICT
// =================================================================================================
const secondes = ((Date.now() - t0) / 1000).toFixed(2);
process.stdout.write(`\ncorpus : ${corpus.length} documents`
  + (docProd ? " (dont la ligne D1 de production du jour)" : "")
  + (DIR_B ? ` · différentiel src/ts contre ${DIR_B}` : "") + "\n");
for (const c of corpus) {
  const r = releves[c.nom];
  process.stdout.write(`  ${r && r.lu ? "·" : "×"} ${c.nom.padEnd(32)} ${c.quoi}\n`);
}
if (manquants.length) {
  process.stdout.write("\nSOURCES ABSENTES (le corpus est plus petit qu'annoncé) :\n");
  manquants.forEach((m) => process.stdout.write("  ! " + m + "\n"));
}
if (echecs.length) {
  process.stdout.write(`\nFAILURES ${echecs.length}/${passes + echecs.length} en ${secondes} s\n`);
  process.exit(1);
}
process.stdout.write(`\nOK ${passes}/${passes} vérifications en ${secondes} s\n`);
