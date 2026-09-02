#!/usr/bin/env node
// THE PRE-DEPLOY BARRIER, IN ONE COMMAND.
//
//   node tests/all.ts                 # everything, in parallel, concurrency inferred from cores
//   node tests/all.ts --jobs 2        # force the concurrency
//   node tests/all.ts --seq           # one by one (to compare, or on a loaded machine)
//   node tests/all.ts run model-v5    # only run suites whose name contains this
//   node tests/all.ts --repeat 5      # rerun the whole barrier 5 times (stability proof)
//   node tests/all.ts --list          # list the suites and exit
//   node tests/all.ts --part 1/2      # une suite sur deux ; deux passages couvrent tout
//   node tests/all.ts --sans-verrou   # run even if another barrier holds the lock (see below)
//
// WHAT THE DEFAULT MODE MEASURES, AND THAT IS THE WHOLE POINT OF THE SWITCHOVER (batch E5c): the
// SERVED file, i.e. `index.html`, now produced from `src/ts` by `node build.ts`. Before the
// switchover, `--next` meant "the new client" and the default measured the old one. The two
// roles are SWAPPED, not duplicated: `--next` no longer exists, because letting two modes
// point at the same file would be exactly the trap this device exists to prevent.
//
// Each suite is its own PROCESS: it opens its own Chrome on a debugging port
// assigned by the system (`--remote-debugging-port=0`, port read back from ITS profile's
// `DevToolsActivePort`), its own profile in its own `mkdtemp`, and its own local HTTP server on
// `listen(0)`. Nothing is shared for writing between two suites, so nothing forces them to be
// serialized.
//
// Output: one line per suite, the total, and the DETAIL of failures only. Nonzero exit code
// as soon as one suite fails.

import type { VerdictSonde } from "./_types.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
// THE BROWSER CAP IS A MACHINE CAP, NOT A PROCESS CAP. `JOBS` below bounds THIS barrier; it cannot
// see the eight other worktrees, each of which was politely holding its own cap of 8. On 19/08/2026
// at 11:11 that arithmetic froze the workstation for seven minutes: Chrome from 44 to 264
// processes, 1,98 GB free, a run queue of 318 on 12 cores. The permit pool served by local-agent
// (`:5100`) counts BROWSERS across every worktree at once, so a suite waits for a real slot instead
// of for a slot this process alone believes in. ONE PERMIT = ONE BROWSER, which is why the count
// comes from `suite.chrome` and not from the number of suites. The two caps compose: `JOBS` still
// limits how many suites this barrier starts, the pool limits how many browsers exist anywhere.
// If local-agent is unreachable the helper warns once and runs anyway: a barrier must never be
// blocked by the supervisor.
import { withBrowserPermits } from "file:///C:/Users/sylve/projects/local-agent/sem-client.ts";

interface EntreeSuite {
  f: string;
  chrome: number;
  args?: string[];
}
interface ResultatSuite { suite: EntreeSuite; code: number | null; out: string; ms: number }
interface VerdictSuite { n: number; total: number; texte: string }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const NODE = process.execPath;

// The order is that of measured DESCENDING DURATIONS: the longest one starts first, otherwise
// it finishes alone while everything else is already done (the classic "long pole").
//
// ---- THE POINT NEVER TO LOSE SIGHT OF IN THIS LIST ----------------------------------------
// The 26 browser suites open `index.html` by default: that's the TYPED client and the file
// actually served. The others read `src/ts` directly, check pure computation, or are
// agnostic of the client. There is no longer a second copy nor an old client source.
const SUITES: EntreeSuite[] = [
  { f: "tests/gestes-precision.ts",        chrome: 1 },
  { f: "tests/collab-annuler.ts",          chrome: 1 },
  { f: "tests/model-v5-fil-serveur.ts",    chrome: 1 },
  { f: "tests/model-v5-modele-defaut.ts",  chrome: 1 },
  { f: "tests/repli-d1-live.ts",           chrome: 3 },
  { f: "tests/model-v5-edition.ts",        chrome: 1 },
  { f: "tests/model-v5-ancien-plan.ts",    chrome: 1 },
  { f: "tests/model-v5-conversion-rendu.ts", chrome: 1 },
  { f: "tests/gestes-usage-reel.ts",       chrome: 1 },
  { f: "tests/chaise-dossier-geste.ts",    chrome: 1 },   // REAL MOUSE: a chair docked against a table faces it (backrest outward), relative to the table's OWN rotation, round trip exact

  { f: "tests/geste-ami.ts",               chrome: 1 },   // REAL MOUSE + KEYBOARD: Ctrl/Cmd no-grid drag, D-held dimensions peek
  { f: "tests/chasse-usage.ts",            chrome: 1 },   // REAL MOUSE + KEYBOARD: re-grabbing a selected wall no longer deletes it, Escape mid-drag no longer wastes a Ctrl+Z
  { f: "tests/repli-conflit.ts",           chrome: 2 },
  { f: "tests/faces-pose-copie.ts",        chrome: 1 },
  { f: "tests/deux-appareils.ts",          chrome: 1 },
  { f: "tests/curseur-dire.ts",            chrome: 1 },   // cursor chat ("/"), real mouse + keyboard: opens, follows the pointer, closes on Escape, plan untouched
  { f: "tests/curseur-dire-deux-appareils.ts", chrome: 1 },   // cursor chat's WIRE half, style of deux-appareils.ts: letter-by-letter, disappears on close, XSS
  { f: "tests/collab-accuses.ts",          chrome: 1 },
  { f: "tests/garde-fous.ts",              chrome: 1 },
  { f: "tests/gestes-perte-de-travail.ts", chrome: 1 },
  { f: "tests/ouverture-redim.ts",         chrome: 1 },
  { f: "tests/run.ts",                     chrome: 1 },
  { f: "tests/apercu-pose.ts",             chrome: 1 },
  { f: "tests/plan-abime.ts",              chrome: 2 },
  { f: "tests/porte-invitee.ts",           chrome: 2 },   // the guest door in a real browser: token capture, name step, dead end, local-only
  { f: "tests/partage-navigateur.ts",      chrome: 2 },   // the Share button in a real browser: household door, silent-return fix, local-only self-heal
  { f: "tests/retour-navigateur.ts",       chrome: 2 },   // the Feedback button in a real browser: both doors, server received it, text survives a failed send
  { f: "tests/interactions.ts",            chrome: 1 },
  { f: "tests/mur-outil-geste.ts",         chrome: 1 },   // single-segment wall tool, real mouse+keyboard: stays armed across walls, endpoint snap shares the exact point, a drawn wall keeps its length, D-held guides on a wall write nothing
  { f: "tests/jonction-glisser-mur-geste.ts", chrome: 1 }, // real mouse: three hand-drawn walls, drag the shared one, junctions hold, one Ctrl+Z restores all three
  { f: "tests/poignees-survol-geste.ts",    chrome: 1 }, // real mouse: wall handles on hover, dedicated move target, body draws, facade selects, short-wall crowding
  { f: "tests/sans-mode-geste.ts",          chrome: 1 }, // real mouse and finger: one aim-based canvas with no persistent structural toggle
  { f: "tests/bouts-de-mur-geste.ts",      chrome: 1 },   // real mouse: a wall's own endpoint handle is hittable and extends it, the wall body still drags the whole wall, a clean click writes nothing
  { f: "tests/coude-mur-geste.ts",         chrome: 1 },   // real mouse: midpoint elbow handle, wall body remains reachable, clean click writes nothing
  { f: "tests/facade-glisse-geste.ts",     chrome: 1 },   // real mouse: a facade half SLIDES, the outline never bends, corner drags carry the whole straight run
  { f: "tests/facade-colle-geste.ts",      chrome: 1 },   // real mouse: a facade lands EXACTLY on the line of a parallel facade, the guide says so, Ctrl gives the ordinary positions back
  { f: "tests/avancee-suit-la-piece-geste.ts", chrome: 1 }, // real mouse: a recess stops on the room's own partition rather than on the facade's cut, the partition never moves, the neighbour's window stays put
  { f: "tests/mur-droit-geste.ts",         chrome: 1 },   // real mouse: the square-up button exists ONLY on a crooked wall, straightens the real plan's w3/w7, spares a deliberate oblique, and nothing straightens itself
  { f: "tests/facade-controles-geste.ts",  chrome: 1 },   // real mouse: a hovered facade offers its "+" and its weld link, never a cross nor endpoint handles, and the outline's own "+" stays reachable
  { f: "tests/sol-suit-la-main-geste.ts",  chrome: 1 },   // real mouse: the painted floor follows the hand during the drag instead of jumping on release, and a typed room name survives a room being swept away and reopened
  { f: "tests/selection-visible.ts",       chrome: 1 },
  { f: "tests/textes-lisibles.ts",         chrome: 1 },
  { f: "tests/etiquettes-recouvrement.ts", chrome: 1 },   // room labels vs furniture labels vs each other, real DOM, the owner's real apartment
  { f: "tests/boot-vierge.ts",             chrome: 1 },
  // IT EXISTED, GREEN, AND THE BARRIER DID NOT LAUNCH IT. Six checks on the DELIVERABLE
  // itself (a single file, zero network request, no external tag): exactly the kind of guard
  // whose absence goes unnoticed, since everything else stays green.
  { f: "tests/artefact-autonome.ts",       chrome: 1 },
  { f: "tests/etiquette-renommer.ts",      chrome: 1 },
  { f: "tests/train-ouvertures.ts",        chrome: 1 },
  // ---- the four that read the SOURCE, not the artifact: they read src/ts ----------------
  { f: "tests/harnais-graine.ts",          chrome: 0 },                        // src/ts, by import
  { f: "tests/rapide.ts",                  chrome: 0 },                        // src/ts, by import
  // THE DATA ORACLE directly confronts a reading of src/ts against the frozen fingerprints.
  { f: "tests/compat-donnees.ts",          chrome: 0 },
  { f: "tests/repartir-espacement.ts",     chrome: 0 },   // PURE computation: no browser
  { f: "tests/fenetre-battement.ts",       chrome: 0 },   // PURE tracing: no browser
  { f: "tests/mur-libre.ts",               chrome: 0 },   // PURE geometry: no browser
  { f: "tests/cellules-perf.ts",           chrome: 0 },   // PURE: what cell detection COSTS, and that it still returns the same bytes as before the grids
  { f: "tests/jonction-glisser-mur.ts",    chrome: 0 },   // PURE geometry: junctions carried by a wall drag, outline left alone, one-hop chains, exact round trip, the wire diff
  { f: "tests/bouts-de-mur.ts",            chrome: 0 },   // PURE geometry: a wall endpoint's snap cascade (junction, segment, outline, then 45°, then the grid) and the `free` rule
  { f: "tests/coude-mur.ts",               chrome: 0 },   // PURE geometry: midpoint split, opening ownership and absolute positions
  { f: "tests/sans-grille.ts",             chrome: 0 },   // PURE: the Ctrl/Cmd modifier and the relative grid math, no browser
  { f: "tests/projection.ts",              chrome: 0 },   // PURE optics: no browser
  { f: "tests/etiquettes-disposition.ts",  chrome: 0 },   // PURE placement math: room labels vs furniture obstacles, no browser
  { f: "tests/chaise-dossier.ts",          chrome: 0 },   // PURE geometry: snapChairToTable's rotation, relative to the table's OWN rot, no browser
  { f: "tests/exports-morts.ts",           chrome: 0 },   // reads the SOURCE: no browser
  { f: "tests/no-dead-selectors.ts",       chrome: 0 },                        // CSS classes taken by src/ts
  { f: "tests/porte.ts",                   chrome: 0 },   // door + identity: functions/porte.ts, no browser
  { f: "tests/invitation.ts",              chrome: 0 },   // the invite: functions/api/invite(s).ts, no browser
  { f: "tests/retour.ts",                  chrome: 0 },   // the feedback drop: functions/api/feedback.ts, no browser
  { f: "tests/carte-og.ts",                chrome: 0 },   // the link preview card: functions/_middleware.ts, no browser
  { f: "tests/identite-fil.ts",            chrome: 0 },   // wire identity, client side: src/ts/fil/etat.ts + mesure/curseur-pair.ts, no browser
  { f: "tests/invite-fil.ts",              chrome: 0 },   // guest client pure logic: token-from-hash, storage key per mode, duplicate-name display, no browser
  { f: "tests/partage-fil.ts",             chrome: 0 },   // owner share panel pure logic: link construction, guestHost fallback, live filter, row formatting, no browser
  // The SERVER validator doesn't know about the client: same file, same verdict, in both modes.
  { f: "live-worker/test-local.ts",        chrome: 0 },
];

// ---- arguments ---------------------------------------------------------------------------------
const argv = process.argv.slice(2);
/** `--sans-reprise`: no second chance, the raw barrier. Useful for MEASURING instability. */
const NO_RETRY = argv.includes("--sans-reprise");
const flag = (n: string) => argv.includes(n);
const opt = (n: string, d: string | number) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const filters = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && /^(--jobs|--repeat|--part)$/.test(argv[i - 1])));

// These suites launch REAL Chrome instances (several processes each, CPU-hungry when rendering).
// A concurrency of N runs up to ~2N browsers: we target roughly two thirds of the cores,
// bounded to [2, 10].
//
// FIGURES FROM 2026-08-05, 12 cores, fixed machine (the old pair of 4 tasks = 885s /
// 8 tasks = 524s dates from before: the CPU was capped at ~2700MHz and 8 cores out of 12 were
// parked, it no longer means anything). Whole barrier, 28 suites, 4479 checks:
//   8 tasks, CLEAN machine .................. 334s
//  10 tasks, CLEAN machine .................. 311s
//   6 tasks, another session running ......... 393s
//   8 tasks, another session running ......... 572s
// AFTER THE SWITCHOVER, 8 tasks, clean machine, 28 suites, 4495 checks (compat-donnees goes
// from 1064 to 1080 in differential mode), `--repeat 3`: 287.8s . 293.3s . 289.7s, i.e. ~290s per
// round and 14.8 min for the three. This barrier's time is dominated by Chrome regardless, not
// by the client's JS. The three longest ones account for it on their own: model-v5-modele-defaut
// ~226s, gestes-precision ~201s, model-v5-fil-serveur ~188s.
// THE TRAP IN THESE MEASUREMENTS: another agent session running its own suites at the same time
// weighs more than the concurrency setting itself. Before concluding anything about
// `--jobs`, check that NO other `node tests/...` is running, otherwise the numbers compare nothing.
// The 7% between 8 and 10 tasks sits inside that noise: the default stays two thirds of the cores.
const CORES = os.cpus().length || 4;
const JOBS = flag("--seq") ? 1 : Math.max(2, Math.min(10, Number(opt("--jobs", Math.floor(CORES * 2 / 3))) || 2));
const REPEAT = Math.max(1, Number(opt("--repeat", 1)) || 1);

let liste = SUITES.filter((s) => !filters.length || filters.some((f) => s.f.includes(f)));
if (!liste.length) { console.error("Aucune suite ne correspond à " + JSON.stringify(filters)); process.exit(1); }

// COUPER LA BARRIÈRE EN TRANCHES, SANS LA TRIER PAR NOM. `--part 1/2` prend une suite sur deux,
// `--part 2/2` les autres: DEUX passages couvrent exactement les 67 suites, sans trou ni doublon,
// ce qu'un filtre par sous-chaîne ne sait pas garantir. Le découpage est en QUINCONCE et non par
// blocs, parce que la liste est triée par durée décroissante: un découpage par blocs mettrait les
// trois suites les plus longues dans la même tranche, et l'une des deux durerait le double.
// À quoi ça sert: un lancement qui ne peut pas dépasser un plafond de temps (une session d'agent,
// une tâche planifiée, un CI qui coupe) reste capable de passer la barrière ENTIÈRE, en deux fois.
// Ce n'est pas une façon de lancer moins de tests, c'est une façon de tous les lancer quand même.
const partArg = String(opt("--part", ""));
if (partArg) {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(partArg);
  if (!m) { console.error("--part attend « i/n », par exemple --part 1/2"); process.exit(1); }
  const i = Number(m[1]), n = Number(m[2]);
  if (!(n >= 1 && i >= 1 && i <= n)) { console.error(`--part ${partArg} : i doit aller de 1 à n`); process.exit(1); }
  liste = liste.filter((_, k) => k % n === (i - 1));
  console.log(`tranche ${i}/${n} : ${liste.length} suite(s) sur ${SUITES.length}`);
}

// The flag from the porting period. It doesn't just get ignored: someone who types it
// believes they're measuring the typed client SEPARATELY, when it IS what the barrier measures by
// default. Letting it pass silently would hand out a green whose meaning is no longer known.
if (flag("--next")) {
  console.error("--next n'existe plus : le client typé EST la cible par défaut depuis la bascule (lot E5c).");
  console.error("  node tests/all.ts            -> index.html        (le client servi)");
  process.exit(1);
}

const APP = path.join(ROOT, "index.html");
if (!fs.existsSync(APP)) {
  console.error("index.html est absent : `node build.ts` d'abord.");
  process.exit(1);
}
if (flag("--list")) { liste.forEach((s) => console.log(s.f)); process.exit(0); }

// ---- ONE BARRIER AT A TIME ---------------------------------------------------------------
// On 2026-08-17, THREE barriers ran at once on this machine and not one of them finished: each
// had been launched by a different agent told to verify its own work. Sixty-odd browsers fought
// over twelve cores, every suite ran past the bounds it measures itself against, and the run that
// eventually printed a verdict was measuring the other two, not the code. Five suites launched at
// 08:10 were still alive at 13:25.
//
// Same guard as the performance sampler's `Global\pcmon-sylve` mutex, in the only shape Node
// offers on Windows: a lock file holding the owner's PID, ignored the moment that PID is gone, so
// a barrier killed with Ctrl+C never blocks the next one. `--sans-verrou` steps over it, for the
// deliberate case of comparing two barriers side by side.
const VERROU = path.join(os.tmpdir(), "plan-barriere.lock");
function pidVivant(pid: number): boolean {
  // `kill(pid, 0)` sends nothing: it only asks whether the process can be signalled. EPERM means
  // it exists and belongs to someone else, which still counts as alive.
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
if (!flag("--sans-verrou")) {
  let tenuPar = 0;
  try { tenuPar = Number(fs.readFileSync(VERROU, "utf8").trim()) || 0; } catch { /* pas de verrou */ }
  if (tenuPar && tenuPar !== process.pid && pidVivant(tenuPar)) {
    console.error(`Une barrière tourne déjà sur cette machine (PID ${tenuPar}).`);
    console.error(`Deux barrières en parallèle ne mesurent plus le code, elles se mesurent l'une l'autre.`);
    console.error(`  attendez qu'elle finisse, ou  node tests/all.ts --sans-verrou  pour passer outre.`);
    process.exit(1);
  }
  try { fs.writeFileSync(VERROU, String(process.pid)); } catch { /* pas de verrou possible : on continue */ }
  process.on("exit", () => {
    // Only the holder erases it: a run that stepped over the lock must not free someone else's.
    try { if (Number(fs.readFileSync(VERROU, "utf8").trim()) === process.pid) fs.rmSync(VERROU, { force: true }); }
    catch { /* déjà parti */ }
  });
}

// ---- reading a suite's verdict -------------------------------------------------------------
// Suites don't all have the same last word. We read what they say, we don't guess it:
// the exit code remains the referee, the count is only for the report.
function verdict(out: string, code: number | null): VerdictSuite {
  const m1 = /OK (\d+)\/(\d+)/.exec(out);
  if (m1) return { n: +m1[1], total: +m1[2], texte: `${m1[1]}/${m1[2]}` };
  const m2 = /FAILURES (\d+)\/(\d+)/.exec(out);
  if (m2) return { n: +m2[2] - +m2[1], total: +m2[2], texte: `${+m2[2] - +m2[1]}/${m2[2]}` };
  const m3 = /OK (\d+) assertions/.exec(out);
  if (m3) return { n: +m3[1], total: +m3[1], texte: `${m3[1]} assertions` };
  return { n: code === 0 ? 1 : 0, total: 1, texte: code === 0 ? "ok" : "échec" };
}

// The lines that describe a failure, and only those: it's all we reprint.
function extraitEchecs(out: string): string[] {
  const lignes = out.split(/\r?\n/);
  const gard = [];
  for (let i = 0; i < lignes.length; i++) {
    const l = lignes[i];
    if (/^\s*(FAIL|✗|ERREUR|ERROR)\b/.test(l) || /^\s*FAIL\s/.test(l) || /^ASSERT/.test(l)) {
      gard.push(l);
      if (lignes[i + 1] && /^\s{5,}/.test(lignes[i + 1])) gard.push(lignes[i + 1]);
    }
  }
  return gard.length ? gard : lignes.filter((l) => l.trim()).slice(-12);
}

// ---- no leaks: a private TEMP per suite, and we kill the tree living in it ------------------
// On Windows, killing a suite's node does NOT kill the Chrome instances it launched: dozens of
// them piled up per round, plus their profile under %TEMP%, and the machine slowed down until it
// started making the suites lie (47s -> 246s -> 496s for model-v5 within the same session).
//
// The fix has two parts:
//  1. each suite gets its OWN TEMP (`os.tmpdir()` reads `TEMP`/`TMP`), so EVERYTHING it
//     writes (Chrome profiles, screenshots, work files) lands under an identifiable folder;
//  2. when its process dies, we kill ONLY the `chrome.exe` instances whose command line contains
//     that folder, tree and all (`taskkill /F /T`), then erase the folder.
//
// SAFEGUARD: the filter is the suite's PRIVATE PATH, never the process name. The user's own
// browser, which obviously doesn't carry that path, cannot be touched.
const dossiersVivants = new Set<string>();
const dossiersCrees = new Set<string>();

// ---- the barrier does NOT HOG the machine ----------------------------------------------------
// Machine supervision over 6h on 2026-08-05: the two worst moments of the day for
// responsiveness were the two runs of this barrier. System run queue at 260 then 324
// threads waiting on 12 cores, and keyboard typing lagging in EVERY application.
//
// THE POINT TO NEVER REMOVE WHILE THINKING YOU'RE OPTIMIZING: CPU was only at 52-58% during
// these peaks. There ARE free cycles left. The problem is therefore not saturation, it's SCHEDULING
// FAIRNESS: at equal priority, ~16 Chrome instances statistically win their arbitrations against
// the foreground application's key handling. Lowering `--jobs` would treat a saturation
// that doesn't exist, and would cost minutes per run for nothing.
//
// The fix is therefore PRIORITY, not concurrency: the barrier runs at BELOW_NORMAL and only
// loses its arbitrations against interactive work.
//
// AND ABOVE ALL, MEASURED, AGAINST INTUITION: on Windows, priority class inheritance is NOT
// ENOUGH. The suite's node, the browser process, the `utility` and `crashpad-handler` processes
// do inherit it (base priority 6), but Chrome itself RESETS the class of its RENDERERS
// (8 when the page is visible, 4 otherwise) and of its `gpu-process` (10): those inherit nothing.
// Lowering only the node produces the worst of both worlds, a PRIORITY INVERSION where the
// CDP driver runs below the renderers it drives. Measured on 2026-08-05, 8x `tests/interactions.ts`:
//   normal priority              71s . avg queue 325 . keyboard jitter p95 63ms
//   node alone lowered          181s . avg queue 254 . keyboard jitter p95 28ms   <- 2.6x slower
//   WHOLE tree lowered          113s . avg queue 158 . keyboard jitter p95 15ms   <- kept
// Hence the watcher below, which also lowers the barrier's chrome.exe instances.
//
// SAFEGUARD, the same one as for the kill: the filter is the PATH of the barrier's private
// folders (`<TEMP>/plan-run-...`), never the process name. The user's own browser, which
// doesn't carry that path, cannot be slowed down. And we never touch a process already
// below BELOW_NORMAL (hidden-page renderers, which Chrome sets to 4).
// `PLAN_TESTS_PRIORITE=normale` returns the barrier to normal priority: it's the only way to
// REPLAY the comparison above one day, on another machine or after a Chrome update.
// This is not a comfort setting, it's the measuring instrument.
const PREFIXE_PRIVE = path.join(os.tmpdir(), "plan-run-");
const PRIORITE_BASSE = process.env.PLAN_TESTS_PRIORITE !== "normale";

function abaissePriorite(pid: number) {
  if (!PRIORITE_BASSE) return;
  try { os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* the process is already dead */ }
}

let surveillantPriorite: VerdictSonde = null;
if (PRIORITE_BASSE && process.platform === "win32") {
  const ps =
    `$p='${PREFIXE_PRIVE.replace(/'/g, "''")}';` +
    `while ($true) {` +
    `  try { Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |` +
    `    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($p) -and $_.Priority -gt 6 } |` +
    `    ForEach-Object { try { (Get-Process -Id $_.ProcessId -ErrorAction Stop).PriorityClass='BelowNormal' } catch {} } } catch {}` +
    `  Start-Sleep -Milliseconds 1500 }`;
  surveillantPriorite = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps],
    { stdio: "ignore", windowsHide: true });
  surveillantPriorite.on("error", () => { surveillantPriorite = null; });
  surveillantPriorite.unref();
}
const arreteSurveillant = () => { try { surveillantPriorite?.kill(); } catch { /* already gone */ } };

function tueArbresEtEfface(dir: string): Promise<void> {
  return new Promise<void>((res) => {
    const efface = () => {
      for (let i = 0; i < 4; i++) {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); break; }
        catch { /* Chrome releases its locks with some delay */ }
      }
      dossiersVivants.delete(dir);
      res();
    };
    if (process.platform !== "win32") return efface();
    const ps =
      `$d='${dir.replace(/'/g, "''")}';` +
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
      `Where-Object { $_.CommandLine -and $_.CommandLine.Contains($d) } | ` +
      `ForEach-Object { & taskkill.exe /F /T /PID $_.ProcessId 2>$null | Out-Null }`;
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps],
      { stdio: "ignore", windowsHide: true });
    p.on("error", efface);
    p.on("close", efface);
  });
}

// ---- SAYING WHAT IS RUNNING, WHILE IT RUNS -----------------------------------------------------
// The barrier only spoke when a suite FINISHED. On 2026-08-17 that meant five hours of a blank
// terminal while five suites were stuck, with no way to tell a slow run from a dead one without
// going to look at the process list. A suite now announces itself when it STARTS, and every
// minute the barrier names what is still in flight and for how long. A stall becomes visible in
// sixty seconds instead of never.
const enVol = new Map<string, number>();
const battement = setInterval(() => {
  if (!enVol.size) return;
  const t = [...enVol].map(([f, d]) => path.basename(f, ".ts") + " " + ((Date.now() - d) / 1000).toFixed(0) + " s");
  process.stdout.write("  ...   " + enVol.size + " en cours : " + t.join(" · ") + "\n");
}, 60000);
battement.unref();

const PROPRIETAIRE_PERMIS = "plan-app/" + path.basename(ROOT);
// QUINZE MINUTES, ET LE CHIFFRE VIENT D'UNE MESURE, PAS D'UNE INTUITION. La première version
// coupait à cinq minutes et a tué deux suites saines dès sa première barrière complète
// (`gestes-precision`, `repli-d1-live`). Mesuré ensuite, cette suite lancée SEULE sur une machine
// au repos : 247 s au total et **100 s sans écrire une ligne**, parce qu'un cas à la vraie souris
// enchaîne 300 objets sans rien dire entre deux verdicts. Sous une barrière chargée, où un
// ralentissement d'un facteur trois est ordinaire, ces 100 s deviennent 300 et le garde tuait
// exactement quand la machine est occupée, c'est-à-dire quand la barrière tourne.
// 900 s laisse neuf fois la pire attente observée, tout en restant sans commune mesure avec un
// blocage, qui lui est infini. `PLAN_TESTS_SILENCE=0` le désarme, pour le jour où quelqu'un
// attache un débogueur à une suite et la laisse attendre.
const SILENCE_MAX = Number(process.env.PLAN_TESTS_SILENCE ?? 900_000) || Infinity;

function lance(suite: EntreeSuite): Promise<ResultatSuite> {
  // A suite that opens no browser takes no permit: it costs CPU, not Chrome, and making it queue
  // behind the browsers would only slow the barrier down without freeing a single process.
  if (!suite.chrome) return lanceVraiment(suite);
  return withBrowserPermits(suite.chrome, PROPRIETAIRE_PERMIS, () => lanceVraiment(suite));
}

function lanceVraiment(suite: EntreeSuite): Promise<ResultatSuite> {
  return new Promise<ResultatSuite>((res) => {
    const t0 = Date.now();
    const nom = path.basename(suite.f, ".ts").replace(/[^a-z0-9-]/gi, "");
    const priv = fs.mkdtempSync(path.join(os.tmpdir(), "plan-run-" + nom + "-"));
    dossiersVivants.add(priv);
    dossiersCrees.add(priv);
    enVol.set(suite.f, t0);
    process.stdout.write("  ..    " + suite.f + "\n");
    const p = spawn(NODE, [suite.f, ...(suite.args || [])], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TEMP: priv, TMP: priv },
    });
    abaissePriorite(p.pid);
    let out = "";
    // A SUITE THAT FREEZES IS KILLED, IT IS NOT WAITED FOR. The orphan sweep only recovers what a
    // DEAD process left behind; a suite still alive and stuck on a promise that will never settle
    // keeps its slot, its browser and now its machine permit, forever, and the barrier reports
    // nothing at all. So we watch the only signal that proves a suite is still working: it talks.
    // Every case prints its verdict line, and the quietest one on this machine takes ~40 s, so
    // five silent minutes is not slowness, it is a hang. Killing it turns an infinite wait into a
    // named failure, and `withBrowserPermits` releases the permit in its `finally`.
    let dernierMot = Date.now(), fige = false;
    const parle = (d: unknown): void => { out += d; dernierMot = Date.now(); };
    p.stdout.on("data", parle);
    p.stderr.on("data", parle);
    const chien = setInterval(() => {
      if (Date.now() - dernierMot < SILENCE_MAX) return;
      fige = true;
      out += `\n[barriere] suite muette pendant ${Math.round(SILENCE_MAX / 1000)} s: arret force.\n`;
      try { p.kill(); } catch { /* already gone */ }
    }, 15_000);
    (chien as { unref?: () => void }).unref?.();
    const fin = (code: number | null, err?: Error) => {
      clearInterval(chien);
      enVol.delete(suite.f);
      const r = { suite, code: fige ? (code || 1) : code, out: err ? out + String(err) : out, ms: Date.now() - t0 };
      tueArbresEtEfface(priv).then(() => res(r));
    };
    p.on("error", (e) => fin(1, e));
    p.on("close", (code) => fin(code));
  });
}

// A suite ALSO leaks while it's running: it opens dozens of Chrome instances in a row and only
// kills the browser process itself, its renderers survive as ORPHANS, and eat the machine until
// they make the waiting suites lie. We sweep them up along the way, on the only condition that
// proves they no longer serve anyone: their PARENT process no longer exists. The filter is still
// the suite's private folder, so the user's own browser (parent alive, path absent) is out of
// reach twice over.
let balayageEnCours = false;
function balayeOrphelins() {
  if (balayageEnCours || !dossiersVivants.size || process.platform !== "win32") return;
  balayageEnCours = true;
  const liste = [...dossiersVivants].map((d) => `'${d.replace(/'/g, "''")}'`).join(",");
  const ps =
    `$dirs=@(${liste});` +
    `$tous=Get-CimInstance Win32_Process;` +
    `$vivants=@{};foreach($p in $tous){$vivants[[int]$p.ProcessId]=$true};` +
    `foreach($p in $tous){ if($p.Name -eq 'chrome.exe' -and $p.CommandLine -and ` +
    `-not $vivants[[int]$p.ParentProcessId]){ foreach($d in $dirs){ ` +
    `if($p.CommandLine.Contains($d)){ & taskkill.exe /F /T /PID $p.ProcessId 2>$null | Out-Null; break } } } }`;
  const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps],
    { stdio: "ignore", windowsHide: true });
  const fin = () => { balayageEnCours = false; };
  p.on("error", fin);
  p.on("close", fin);
}
const minuterie = setInterval(balayeOrphelins, 8000);
minuterie.unref();

// Keyboard interrupt: we don't leave Chrome instances behind either.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    arreteSurveillant();
    await Promise.all([...dossiersVivants].map(tueArbresEtEfface));
    process.exit(130);
  });
}

async function unTour(tour: number): Promise<ResultatSuite[]> {
  const file = liste.slice();
  const faits: ResultatSuite[] = [];
  const enCours = new Set<Promise<void>>();
  await new Promise<void>((fini) => {
    const suivant = () => {
      while (enCours.size < JOBS && file.length) {
        const s = file.shift();
        const pr = lance(s).then((r) => {
          enCours.delete(pr);
          faits.push(r);
          const ok = r.code === 0;
          const v = verdict(r.out, r.code);
          process.stdout.write(
            (ok ? "  ok   " : "  ÉCHEC ") + r.suite.f.padEnd(38) +
            String(v.texte).padStart(14) + "  " + (r.ms / 1000).toFixed(1).padStart(6) + " s\n");
          suivant();
        });
        enCours.add(pr);
      }
      if (!enCours.size && !file.length) fini();
    };
    suivant();
  });
  faits.sort((a, b) => liste.indexOf(a.suite) - liste.indexOf(b.suite));
  return faits;
}

// ---- execution ---------------------------------------------------------------------------------
let sortie = 0;
const debut = Date.now();
for (let tour = 1; tour <= REPEAT; tour++) {
  if (REPEAT > 1) process.stdout.write(`\n===== tour ${tour}/${REPEAT} =====\n`);
  else process.stdout.write(`barrière (client SERVI, ${path.relative(ROOT, APP).replace(/\\/g, "/")}) : ` +
    `${liste.length} suites, ${JOBS} en parallèle (${CORES} cœurs)\n`);
  const t0 = Date.now();
  const faits = await unTour(tour);
  let rates = faits.filter((r) => r.code !== 0);

  // ---- THE SECOND CHANCE, ALONE ------------------------------------------------------------
  // MEASUREMENT, NOT INTUITION: in one day, EIGHT distinct suites fell while running in parallel
  // and passed again ALONE on the first retry. None had a real defect; all are time-sensitive
  // (render waits, CDP round trips, 220ms timers), and the machine ALSO carries the
  // browser of the person working. The decisive counter-test: at `--jobs 4`, the same
  // suites took 1487s, 1560s and 1649s versus 330-500s at 8, so the load did NOT come from the
  // barrier's own parallelism, but from whatever else was running alongside it.
  //
  // So we replay suites that fell ONCE, ALONE, with nothing else in parallel. This is not
  // "retry until it passes":
  //   . a single extra attempt, never two;
  //   . SEQUENTIAL, so under the calmest conditions the barrier can offer;
  //   . a real defect fails BOTH times and stays red;
  //   . and above all, every catch-up is PRINTED and counted. A barrier that hides its own
  //     instability is worse than a slow barrier: eventually nobody believes it anymore.
  const rattrapees: string[] = [];
  if (rates.length && !NO_RETRY) {
    process.stdout.write(`\n~ ${rates.length} suite(s) tombée(s) : nouvel essai SEUL (séquentiel)\n`);
    for (const r of rates) {
      const bis = await lance(r.suite);
      const v = verdict(bis.out, bis.code);
      const ok = bis.code === 0;
      process.stdout.write(
        (ok ? "  ok*  " : "  ÉCHEC ") + bis.suite.f.padEnd(38) +
        String(v.texte).padStart(14) + "  " + (bis.ms / 1000).toFixed(1).padStart(6) + " s\n");
      const i = faits.indexOf(r);
      if (i >= 0) faits[i] = bis;
      if (ok) rattrapees.push(bis.suite.f);
    }
    rates = faits.filter((q) => q.code !== 0);
  }
  let n = 0, total = 0;
  for (const r of faits) { const v = verdict(r.out, r.code); n += v.n; total += v.total; }
  process.stdout.write(
    `\n${rates.length ? "ÉCHEC" : "OK"} ${n}/${total} vérifications · ` +
    `${faits.length - rates.length}/${faits.length} suites · ` +
    `${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
  // A catch-up is NEVER kept quiet: it's counted and named, even when everything ends up green.
  if (rattrapees.length) {
    process.stdout.write(
      `\n${rattrapees.length} suite(s) vertes SEULES après être tombées en parallèle :\n` +
      rattrapees.map((f) => "   · " + f).join("\n") +
      `\nCe n'est pas un défaut du code, c'est la machine : fermez ce qui tourne à côté, ou\n` +
      `lancez \`node tests/all.ts --sans-reprise\` pour voir la barrière brute.\n`);
  }
  if (rates.length) {
    sortie = 1;
    for (const r of rates) {
      process.stdout.write(`\n---- ${r.suite.f} (code ${r.code}) ----\n`);
      process.stdout.write(extraitEchecs(r.out).join("\n") + "\n");
    }
  }
}

arreteSurveillant();
// Final pass: Chrome releases its locks late, one or two folders resist the first
// erase attempt. We leave NOTHING behind.
for (const d of dossiersCrees) {
  if (!fs.existsSync(d)) continue;
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* oh well */ }
}

if (REPEAT > 1)
  process.stdout.write(`\n${sortie ? "AU MOINS UN TOUR A ÉCHOUÉ" : "LES " + REPEAT + " TOURS SONT VERTS"}` +
    ` · ${((Date.now() - debut) / 1000 / 60).toFixed(1)} min\n`);
process.exit(sortie);
