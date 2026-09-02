// src/ts/fil/invite.ts — THE GUEST CLIENT (docs/decisions/0004-partage-par-lien.md, batch 3).
//
// EVERYTHING a browser does BEFORE it knows whether it is the household, an invited guest, or a
// stranger on the guest door with nothing: token capture from the link's fragment, the exchange
// with `/api/invite`, the name step, local-only mode, and the dead end. Nothing here talks to the
// household door differently: on it, `captureJetonInvite()` finds no token, `preparerAccueil()`
// resolves immediately, and NOTHING in this file ever runs again for the life of the tab.
//
// HOW THE CLIENT LEARNS WHERE IT IS, and this is the one paragraph to read before touching this
// file:
//   1. A token in the fragment (`#k=`), captured, stored, and stripped from the address bar
//      BEFORE the strip (stored first, in case `history.replaceState` is refused).
//   2. Failing that, a token remembered from a previous visit (`localStorage`): the invite
//      cookie may have expired even though the token has not, so it is worth trying again.
//   3. Failing THAT, ordinary behaviour, unchanged — with one addition, wired from `fil/rest.ts`
//      through `ctx.crochets.accesRefuseSansInvite`: if the boot GET answers 403 with
//      `porte_refusee`/`invite_invalide`, this is the guest door WITHOUT an invitation, and the
//      tab switches to LOCAL-ONLY mode. Discover-by-trying: it only changes a path that already
//      meant "something is wrong" today.
//
// WHY THIS MODULE DOES NOT IMPORT `fil/rest.ts` FOR ANYTHING BUT `setSyncChip`, AND NEVER IMPORTS
// `main.ts` OR `fil/presence.ts`: `rest.ts` and `presence.ts` call INTO this module only through
// `ctx.crochets` (`accesRefuseSansInvite`, `accesRefuseInvite`), the SAME pattern
// `fil/branchement.ts` already uses for every other cross-batch wire. A direct import the other
// way would be a cycle (`rest.ts` -> `invite.ts` -> `rest.ts`); the crochet indirection is not a
// style choice, it is what makes the module graph a DAG.

import type { Contexte } from "../app/contexte.ts";
import type { Fil } from "./etat.ts";
import { $ } from "../noyau/dom.ts";
import {
  SYNC_ON, definirModeInvite, definirModeLocalSeul, estLocalSeul, planNomInvite,
} from "./drapeaux.ts";
import { setSyncChip } from "./rest.ts";
import { toast } from "../app/toast.ts";
import { wsSend } from "./emission.ts";
import { assistant } from "../panneaux/configuration.ts";
import { hashSansJeton, jetonDepuisHash } from "./jeton-hash.ts";
import { guestIdCourant } from "./identite.ts";

// =================================================================================================
//  LOCAL STORAGE: THE TOKEN AND NAME KEPT ACROSS RELOADS (a CACHE, never the source of truth for
//  the name — `invites.last_name` is, design edge 20)
// =================================================================================================
const JETON_KEY = "plan-invite-token";
const NOM_KEY = "plan-invite-nom";
/**
 * « CETTE ORIGINE EST LA PORTE INVITÉ », retenu dès qu'on l'a découvert une fois.
 *
 * Le mode local-seul se découvre APRÈS coup, sur le 403 du GET d'amorçage, alors qu'`amorcer()`
 * a déjà lu ET écrit le stockage de façon SYNCHRONE, donc sous la clé du foyer. Première visite :
 * sans importance, il n'y a rien à perdre. DEUXIÈME visite : le plan dessiné la fois d'avant vit
 * sous la clé local-seul, l'amorçage lit la clé nue, l'écran affiche un appartement VIDE, et la
 * première modification l'enregistre par-dessus le vrai travail. Une perte silencieuse, à la
 * deuxième visite, sur des données que personne d'autre n'a.
 *
 * Ce drapeau vit dans le MÊME stockage que le plan qu'il protège : si l'un disparaît, l'autre
 * aussi, donc il ne peut pas mentir sur des données qui existeraient encore.
 */
const PORTE_LOCALE_KEY = "plan-porte-locale";

/**
 * THE FLAG IS A GUESS, AND A GUESS CAN BE WRONG. Written on a 403 that looked like the guest door
 * with no invitation (see above); read back synchronously, before confirmation, so a returning
 * visitor doesn't fall onto the household's storage key by mistake. But an origin can start
 * serving the household plan again — a misconfigured `HOUSEHOLD_HOSTS`/Access app fixed, a
 * hostname moved — and the flag would then dead-end every later visit to a plan this browser
 * could otherwise reach, FOREVER, on a stale guess.
 *
 * Wired to `ctx.crochets.porteMenageConfirmee` (`main.ts`), called from `fil/rest.ts`'s `syncBoot`
 * and `pollPull` right where they lift `bootReconciled`: a boot read that SUCCEEDED is proof this
 * origin does serve a plan to this tab, which is exactly the condition that makes the guess wrong.
 * Idempotent, and cheap enough to call on every poll: clearing an already-absent key is a no-op.
 * Does NOT touch `modeCourant()` — that mode is frozen for the life of THIS tab (`drapeaux.ts`),
 * on purpose, the same as `SYNC_ON`; what this heals is the NEXT boot's guess, not this one's.
 */
export function oublierPorteLocale(): void {
  const etaitPose = litStockage(PORTE_LOCALE_KEY) === "1";
  effaceStockage(PORTE_LOCALE_KEY);
  // ET ON LE DIT, si l'onglet est justement celui qui en souffrait. Guérir le PROCHAIN démarrage
  // sans prévenir laisse cette personne devant une application qui refuse toujours de partager,
  // sans raison visible et sans savoir qu'un rechargement suffit : deux rechargements en réalité,
  // le premier nettoyant le drapeau et le second repartant en mode foyer. Personne ne devine ça.
  // Le mode reste figé pour la vie de l'onglet (`drapeaux.ts`), donc le seul geste utile est de
  // recharger, et c'est exactement ce que la phrase demande.
  if (etaitPose && estLocalSeul()) {
    toast("This tab is in local-only mode by mistake. Reload the page to reconnect to the shared plan.", { geste: true });
  }
}

function litStockage(cle: string): string | null {
  try { return localStorage.getItem(cle); } catch (_) { return null; }
}
function ecritStockage(cle: string, v: string): void {
  try { localStorage.setItem(cle, v); } catch (_) { /* private browsing: the session still works, it just is not remembered */ }
}
function effaceStockage(cle: string): void {
  try { localStorage.removeItem(cle); } catch (_) { /* nothing to reclaim */ }
}

// NOT exported: each of these four has exactly one caller, and it lives in this same file
// (`preparerAccueil`, `appliquerNomInvite`, `finirGuestOnboarding`). `tests/exports-morts.ts`
// enforces the rule this follows: a symbol used only locally does not need to be exported.
// `nomInviteStocke` USED TO be a fifth here, until `nomInviteConnu()` below gave it a second
// caller outside this file.
const jetonInviteStocke = (): string | null => litStockage(JETON_KEY);
const stockerJetonInvite = (t: string): void => ecritStockage(JETON_KEY, t);
const oublierJetonInvite = (): void => effaceStockage(JETON_KEY);
const nomInviteStocke = (): string => litStockage(NOM_KEY) || "";
const stockerNomInvite = (n: string): void => ecritStockage(NOM_KEY, n);

/**
 * Wired to `ctx.crochets.guestNomLocal` (`main.ts`), read by `fil/presence.ts` on `hello`: this
 * DEVICE's own remembered name, the one thing `invites.last_name` (ONE slot, shared by the whole
 * link) cannot always carry for every device at once. See `wsReaffirmerNomSurAccueil` for why.
 */
export function nomInviteConnu(): string { return nomInviteStocke(); }

/**
 * STORED FIRST, STRIPPED SECOND. A reload must still find the token even if the strip never
 * reaches the address bar (a browser that ignores `replaceState`, or throws). Falls back to a
 * previously stored token when the hash carries none: a returning guest, or the invite cookie
 * having expired while the token itself has not.
 */
function captureJetonInvite(): string | null {
  const deHash = jetonDepuisHash(location.hash);
  if (deHash) {
    stockerJetonInvite(deHash);
    try {
      history.replaceState(null, "", location.pathname + location.search + hashSansJeton(location.hash));
    } catch (_) { /* refused: the token still works, it just stays visible in the bar */ }
    return deHash;
  }
  return jetonInviteStocke();
}

// =================================================================================================
//  THE EXCHANGE: A TOKEN BECOMES A SESSION (`POST /api/invite`)
// =================================================================================================
interface ReponseInvite {
  planId?: string;
  planName?: string;
  role?: string;
  name?: string | null;
}

// 8 s, the SAME delay `fil/rest.ts`'s `apiFetch` bounds every other request to (not imported: this
// module takes nothing from `rest.ts` but `setSyncChip`, see the header). Without it, a server
// that never answers left `redeemerInvite()`, and therefore `preparerAccueil()`, and therefore the
// entire boot, waiting forever: a definitive blank page, never a message, never a chance to retry.
const REDEEM_TIMEOUT = 8000;

/**
 * Set by `redeemerInvite()` on its OWN failure branch: true when the fetch itself never reached a
 * verdict (no network, DNS failure, or the timeout above aborting it), false when the server
 * answered and said no (403/404). The two are NOT the same failure: a 403/404 is a verdict about
 * the TOKEN (forget it, dead-end); a transitory failure is a verdict about the NETWORK, and the
 * token may still be perfectly good a moment later.
 */
let _echecTransitoire = false;

async function redeemerInvite(token: string, nom?: string): Promise<ReponseInvite | null> {
  _echecTransitoire = false;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), REDEEM_TIMEOUT);
  try {
    // `guestId` is what lets the SERVER tell "this device already named itself on this link" apart
    // from "a different visitor just opened the same link" (functions/api/invite.ts). Sent on
    // EVERY redemption, named or not: the durable per-browser id from `identite.ts`, the same one
    // `fil/presence.ts` puts on the WebSocket upgrade.
    const corps: Record<string, unknown> = { token, guestId: guestIdCourant() };
    if (nom) corps.name = nom;
    const res = await fetch("/api/invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(corps),
      signal: ac.signal,
    });
    if (!res.ok) return null;   // 403 (household door), 404 (unknown/revoked/expired/deleted): one dead end
    const j = await res.json() as ReponseInvite;
    if (!j || !j.planId) return null;
    return j;
  } catch (_) {
    // no network, or the 8 s abort above: the server was never actually asked, so this is worth
    // trying again, unlike the 403/404 branch above which IS the server's answer.
    _echecTransitoire = true;
    return null;
  } finally {
    clearTimeout(to);
  }
}

// =================================================================================================
//  THE NAME STEP: ONE FIELD, PRE-FOCUSED, ENTER SUBMITS
// =================================================================================================
/**
 * `valeurInitiale` non-empty = a name is ALREADY known (returning guest, or "change my name"):
 * the close cross appears, because there is something to close back TO. Empty = the mandatory
 * first step: nobody reaches the wire unnamed (design edge 17), so there is nothing to cancel.
 */
function afficherEtapeNom(planNom: string, valeurInitiale: string, onJoin: (nom: string) => void): void {
  const dlg = $("inviteNameDlg");
  const texte = $("inviteNameText");
  const inp = $("inviteNameInput") as HTMLInputElement | null;
  const btn = $("inviteNameJoin") as HTMLButtonElement | null;
  const fermer = $("inviteNameClose");
  if (!dlg || !inp || !btn) return;
  if (texte) {
    // textContent, never innerHTML: `planNom` is server data, and a guest's own name (read back
    // here on a "change name" reopen) is the first UNTRUSTED string this client renders at all
    // (design edge 1). One rule, no exception for "it's probably fine".
    // Le plan, puis la question. Ce qui manque ici est volontaire : on n'annonce PAS qu'on ignore
    // qui a envoyé le lien. C'est vrai, et sans intérêt pour la personne qui arrive ; le dire
    // n'ajoute qu'un doute là où il n'y en avait pas.
    texte.textContent = "You have been invited to work on « " + planNom + " ». What should we call you?";
  }
  inp.value = valeurInitiale || "";
  const majBouton = (): void => { btn.disabled = !inp.value.trim(); };
  majBouton();
  inp.oninput = majBouton;
  const valider = (): void => {
    const nom = inp.value.trim().slice(0, 40);
    if (!nom) return;
    dlg.hidden = true;
    onJoin(nom);
  };
  inp.onkeydown = (e) => { if (e.key === "Enter" && !btn.disabled) { e.preventDefault(); valider(); } };
  btn.onclick = valider;
  if (fermer) {
    fermer.hidden = !valeurInitiale;
    fermer.onclick = () => { dlg.hidden = true; };
  }
  dlg.hidden = false;
  setTimeout(() => inp.focus(), 20);
}

// =================================================================================================
//  THE DEAD END: A FULL SCREEN, NEVER A BANNER, NOTHING BEHIND IT
// =================================================================================================
/** `sauvegarde`: `null` = irrelevant (the very first redemption failed, nothing was ever edited);
 *  otherwise whether the last change is known to be saved (edge 7: revoked mid-gesture must state
 *  this ACCURATELY, never vaguely). */
function afficherImpasse(sauvegarde: boolean | null): void {
  const el = $("inviteDeadEnd");
  const txt = $("inviteDeadEndSaved");
  if (txt) {
    if (sauvegarde === null) { txt.hidden = true; }
    else {
      txt.hidden = false;
      txt.textContent = sauvegarde ? "Your last change was saved." : "Your last change could not be saved.";
    }
  }
  if (el) el.hidden = false;
  // A race (redeemed, then revoked before the name was even chosen) must not leave the name
  // step floating ON TOP of the dead end: the dead end is the ONLY thing on screen, ever.
  const nomDlg = $("inviteNameDlg");
  if (nomDlg) nomDlg.hidden = true;
}

/**
 * A TRANSITORY redemption failure (network error, or the 8 s timeout above): unlike the dead end,
 * NOTHING here is forgotten and NOTHING dead-ends, because the token may still be good. Reuses `#bootNotice`
 * (the same persistent banner `fil/rest.ts`'s `showConflitNotice` writes to, same one
 * dynamically-inserted-button pattern) rather than inventing a second banner element for one more
 * kind of failure.
 */
function afficherEchecReseauInvite(reessayer: () => void): void {
  const ban = $("bootNotice"), txt = $("bootNoticeText");
  if (!ban || !txt) return;
  txt.textContent = "Could not reach the server to accept this invitation. Check your connection and retry.";
  ban.hidden = false;
  $("inviteRetry")?.remove();   // a repeated failure must not stack a second button behind the first
  const x = $("bootNoticeX");
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "btn sm pri"; btn.id = "inviteRetry";
  btn.textContent = "Retry";
  btn.addEventListener("click", () => { ban.hidden = true; btn.remove(); reessayer(); }, { once: true });
  ban.insertBefore(btn, x || null);
}

let _impasseAffichee = false;

/**
 * Wired to `ctx.crochets.accesRefuseInvite` (`main.ts`). An invitation WAS redeemed and this
 * door slammed anyway: revoked, expired, or the plan deleted mid-session. `fil` is `null` only
 * when the VERY FIRST redemption already failed (no session ever existed to detach from).
 */
export function entrerImpasseInvite(fil: Fil | null): void {
  if (_impasseAffichee) return;
  _impasseAffichee = true;
  if (fil) {
    fil.detached = true;   // no more op, PUT, or poll leaves from here: there is nowhere for it to go
    try { fil.ws?.close(); } catch (_) { /* already gone, or the DO already closed it (4001) */ }
  }
  const enAttente = !!fil && (fil.unacked.size > 0 || fil.dirtySincePut || fil.putInFlight);
  afficherImpasse(fil ? !enAttente : null);
}

// =================================================================================================
//  LOCAL-ONLY MODE: THE PUBLIC PLANNER
// =================================================================================================
let _banniereWiree = false;
function afficherBanniereLocale(): void {
  const b = $("localBanner");
  if (!b) return;
  b.hidden = false;
  if (_banniereWiree) return;
  _banniereWiree = true;
  $("localBannerX")?.addEventListener("click", () => { b.hidden = true; });
  // Reuses the ORDINARY "Save to file…" action rather than a second copy of it: one exporter,
  // one behaviour, this button just makes it impossible to miss.
  $("localBannerSave")?.addEventListener("click", () => { $("btnExport")?.click(); });
}

/**
 * Wired to `ctx.crochets.accesRefuseSansInvite` (`main.ts`), called from `fil/rest.ts`'s boot GET
 * catch ONLY: no invitation was ever redeemed on this tab, and the door refused it anyway — a
 * stranger on the guest door. Reuses `fil.detached` (the SAME mechanics as `js/41`'s "tab detached
 * from sharing" — every network gate in `rest.ts`/`presence.ts` already respects it) rather than
 * inventing a parallel stop switch: the effect wanted here, "no PUT, no poll, no WebSocket
 * reconnect", is EXACTLY that flag's existing contract.
 */
export function entrerLocalSeul(ctx: Contexte, fil: Fil): void {
  if (fil.detached) return;   // defensive: this must fire at most once per tab
  definirModeLocalSeul();
  // Retenu pour que la PROCHAINE visite parte directement sur la bonne clé, avant toute lecture.
  // Voir `PORTE_LOCALE_KEY` : sans ça, le travail de cette visite-ci est invisible à la suivante,
  // puis écrasé.
  ecritStockage(PORTE_LOCALE_KEY, "1");
  fil.detached = true;
  try { fil.ws?.close(); } catch (_) { /* already gone, or never opened */ }
  setSyncChip(fil, "local-only");
  // Le bac à sable est une porte invité comme une autre : ce qui n'y marche pas ne doit pas y être
  // proposé. Voir `masquerCommandesFoyer`, et la capture d'écran qui a produit ce correctif.
  masquerCommandesFoyer();
  afficherBanniereLocale();
  // The wizard opens exactly as it would under `file://` (`panneaux/configuration.ts`'s own
  // `!SYNC_ON` branch): there is no server here either, only this browser, and a never-configured
  // visitor should not have to stumble onto the outline screen by accident.
  if (!ctx.etat.setupDone) assistant.ouvrir?.();
}

// =================================================================================================
//  A REDEEMED GUEST: TRIM THE UI, WIRE "CHANGE MY NAME"
// =================================================================================================
async function appliquerNomInvite(fil: Fil, nom: string): Promise<void> {
  stockerNomInvite(nom);
  const jeton = jetonInviteStocke();
  // Persists to `invites.last_name` (best-effort: a network hiccup here must not undo a name
  // already accepted locally) AND, if the socket is already live, pushed immediately via
  // `{t:"name"}` so this tab's OWN dot/cursor update without waiting for a reconnect.
  if (jeton) { try { await redeemerInvite(jeton, nom); } catch (_) { /* best-effort */ } }
  fil.wsMe.name = nom;
  if (fil.wsOpen) wsSend(fil, { t: "name", name: nom });
}

/** Called once, right after `amorcer()` returns, ONLY when the tab is in `"invite"` mode. */
/**
 * TRIM WHAT ONLY THE HOUSEHOLD DOOR CAN DO. Called from BOTH guest situations, and that is the
 * whole point of it being its own function.
 *
 * MEASURED, from a real visitor: this used to run only for an INVITED guest
 * (`if (estInvite())` in `main.ts`). Someone who simply opens the guest address with no link is
 * NOT invited, they are in local-only mode, so nothing was trimmed: they saw "Plans…", opened it,
 * typed "living room", pressed Create, and got «⁠Could not create the plan (403)⁠». The server was
 * right, `/api/plans` is closed on that door. The screen was wrong: it offered a control that
 * cannot work there, and the only thing the person learned is that the app is broken.
 *
 * The condition is "not the household door", never "is an invited guest".
 */
function masquerCommandesFoyer(): void {
  // "Plans…" needs `/api/plans`, refused off the household door. "Load a plan…" sends
  // `plan5.replace`, which the server refuses from a guest outright (batch 2); in local-only mode
  // it would work, but on a plan nobody else will ever see, which is worse than absent.
  const btnPlans = $("btnPlans"); if (btnPlans) btnPlans.hidden = true;
  const btnImport = $("btnImport"); if (btnImport) btnImport.hidden = true;
  // ET « Invite », POUR UNE RAISON DE TEMPS. `panneaux/plans.ts` le révèle à l'amorçage sous
  // `SYNC_ON && estMenage()`, or le mode local-seul se découvre APRÈS, sur le 403 : au moment où
  // la question est posée la réponse est encore « foyer », donc le bouton apparaît, et plus rien
  // ne le reprend. Vu en PRODUCTION sur le bac à sable, après avoir corrigé les deux autres.
  // Cacher ici, à la découverte, est le seul endroit qui connaisse la vraie réponse.
  const btnInvite = $("btnInvite"); if (btnInvite) btnInvite.hidden = true;
}

/**
 * Opens the name step ON DEMAND: the "Name…" button, AND `ctx.crochets.guestSansNom` (wired in
 * `main.ts`, called from `fil/presence.ts` on a `guest_unnamed` server refusal). Idempotent —
 * checked BEFORE reopening — because the second caller can fire in a BURST: the Durable Object
 * refuses every op with `guest_unnamed` while the socket carries no name (`live-worker/worker.ts`),
 * so several rejections can land within one gesture, and reopening an ALREADY OPEN dialog on each
 * would steal focus back from someone who has already started typing.
 *
 * WHY THIS EXISTS AT ALL: `invites.last_name` is ONE row shared by every device holding the link,
 * never a per-socket identity (`functions/ws.ts` now resolves the wire's name by matching
 * `guestId`, the SAME device-scoped rule `functions/api/invite.ts` applies to the redemption
 * response). A device whose `guestId` does not own the row therefore connects with an EMPTY name,
 * which the server correctly refuses to let write — but until this fix, the ONLY sign of that was
 * a throttled toast easy to miss (measured live: a guest could see the plan, every edit visibly
 * did nothing, and the reason scrolled past). Popping the SAME name step a fresh guest sees on
 * arrival turns "editing silently does nothing" into "of course, I still need to say who I am."
 */
export function ouvrirEtapeNomInvite(fil: Fil): void {
  const dlg = $("inviteNameDlg");
  if (dlg && dlg.hidden === false) return;   // already open: a burst of refusals must not restart it
  afficherEtapeNom(planNomInvite() || "", fil.wsMe.name || nomInviteStocke(),
    (nom) => { void appliquerNomInvite(fil, nom); });
}

export function finirGuestOnboarding(ctx: Contexte, fil: Fil): void {
  void ctx;
  masquerCommandesFoyer();

  const btnNom = $("btnGuestName");
  if (btnNom) {
    btnNom.hidden = false;
    btnNom.addEventListener("click", () => ouvrirEtapeNomInvite(fil));
  }
}

// =================================================================================================
//  BOOT ORCHESTRATION: WHAT `main.ts` CALLS BEFORE `amorcer()`
// =================================================================================================
/**
 * The redemption attempt, PULLED OUT of `preparerAccueil()` so a transitory failure (see
 * `_echecTransitoire`) can retry itself without `preparerAccueil()` needing to be called again:
 * the Retry button's handler is this same function, closed over `jeton`. Resolves exactly like
 * `preparerAccueil()` did before this batch: `true` = `amorcer()` may run, `false` = the dead end
 * already covers the whole screen.
 */
async function tenterRedemption(jeton: string): Promise<boolean> {
  const rep = await redeemerInvite(jeton, nomInviteStocke());
  if (!rep || !rep.planId) {
    if (_echecTransitoire) {
      // NEVER a blank page: the server was never actually asked, so nothing about the token is
      // known yet. Hand control back with a visible message and a way to try again, exactly the
      // rule this branch exists to satisfy.
      return new Promise<boolean>((resolve) => {
        afficherEchecReseauInvite(() => { resolve(tenterRedemption(jeton)); });
      });
    }
    // A dead token found IN STORAGE (not just a freshly-broken link) should not dead-end this
    // origin FOREVER: forget it, so the next visit to the bare guest URL falls through to
    // local-only instead of retrying a link that can never work again.
    oublierJetonInvite();
    entrerImpasseInvite(null);
    return false;
  }
  definirModeInvite(rep.planId, rep.planName || rep.planId);
  stockerJetonInvite(jeton);

  if (rep.name) { stockerNomInvite(rep.name); return true; }   // returning guest, or a name sent above: skip the step

  return new Promise<boolean>((resolve) => {
    afficherEtapeNom(rep.planName || rep.planId!, "", (nom) => {
      stockerNomInvite(nom);
      void (async () => {
        try { await redeemerInvite(jeton, nom); } catch (_) { /* best-effort: the socket falls back to "?" if this failed */ }
        resolve(true);
      })();
    });
  });
}

/**
 * Resolves `true` when `amorcer()` may run (ordinary household boot, local-only-to-be-discovered,
 * or an invitation that is ALREADY named and ready to go); `false` when the dead end already
 * covers the whole screen and nothing else should start. Blocks on the name step, if one is shown:
 * nobody reaches the wire unnamed. ALWAYS resolves, even against a server that never answers
 * (`redeemerInvite`'s 8 s timeout) or one reachable only after a Retry click (`tenterRedemption`).
 */
export async function preparerAccueil(): Promise<boolean> {
  if (!SYNC_ON) return true;   // file:// / the claude.ai artifact: no token was ever meant to reach here
  const jeton = captureJetonInvite();
  if (!jeton) {
    // AUCUN JETON, MAIS DÉJÀ VENU ICI SANS INVITATION : on reprend le mode local-seul TOUT DE
    // SUITE, avant qu'`amorcer()` ne lise le stockage, sinon il lirait la clé du foyer et
    // afficherait un appartement vide à la place du plan dessiné la dernière fois (puis
    // l'écraserait à la première modification). Le 403 d'amorçage confirmera, sans rien changer.
    if (litStockage(PORTE_LOCALE_KEY) === "1") definirModeLocalSeul();
    return true;               // ordinary path otherwise: `fil/rest.ts` may still discover local-only later
  }
  return tenterRedemption(jeton);
}
