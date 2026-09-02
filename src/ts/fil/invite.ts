// src/ts/fil/invite.ts: THE GUEST CLIENT (decision 0004, batch 3). Everything a browser does
// BEFORE it knows whether it is the household, an invited guest, or a stranger on the guest door:
// token capture from the link's fragment, the exchange with `/api/invite`, the name step,
// local-only mode, and the dead end. On the household door, `preparerAccueil()` resolves
// immediately and nothing here runs again for the tab's life.
//
// How the client learns where it is: (1) a token in the fragment (`#k=`), stored then stripped;
// (2) failing that, a token remembered from a previous visit; (3) failing that, ordinary
// behaviour, with a 403 `porte_refusee`/`invite_invalide` on the boot GET switching to
// local-only mode (wired through `ctx.crochets.accesRefuseSansInvite`).
//
// This module imports `fil/rest.ts` for nothing but `setSyncChip`, and never `main.ts` or
// `fil/presence.ts`: those call INTO this module only through `ctx.crochets`, the same pattern
// `fil/branchement.ts` uses elsewhere, so the module graph stays a DAG.

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
//  the name, `invites.last_name` is, design edge 20)
// =================================================================================================
const JETON_KEY = "plan-invite-token";
const NOM_KEY = "plan-invite-nom";
/**
 * « CETTE ORIGINE EST LA PORTE INVITÉ », retenu dès qu'on l'a découvert une fois: le mode
 * local-seul se découvre APRÈS le premier `amorcer()`, donc sans ce drapeau une deuxième visite
 * lirait la clé du foyer, verrait un appartement vide, et l'écraserait à la première modification.
 * Vit dans le MÊME stockage que le plan qu'il protège.
 */
const PORTE_LOCALE_KEY = "plan-porte-locale";

/**
 * Le drapeau est une SUPPOSITION, donc réversible: un boot read qui RÉUSSIT prouve que cette
 * origine sert bien un plan à cet onglet, ce qui est exactement la condition qui rend la
 * supposition fausse (`ctx.crochets.porteMenageConfirmee`, appelé par `syncBoot`/`pollPull` au
 * même point qu'ils lèvent `bootReconciled`). Ne touche pas `modeCourant()`, figé pour la vie de
 * l'onglet: ceci guérit le PROCHAIN démarrage, pas celui-ci.
 */
export function oublierPorteLocale(): void {
  const etaitPose = litStockage(PORTE_LOCALE_KEY) === "1";
  effaceStockage(PORTE_LOCALE_KEY);
  // Le dire si CET onglet en souffrait: guérir le prochain démarrage sans prévenir laisserait la
  // personne devant une appli qui refuse de partager sans savoir qu'un rechargement suffit.
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

/** STORED FIRST, STRIPPED SECOND: a reload must still find the token even if the strip never
 * reaches the address bar. Falls back to a previously stored token when the hash carries none. */
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

// 8s, the same delay `fil/rest.ts`'s `apiFetch` bounds every other request to. Without it, a
// server that never answers leaves the entire boot waiting forever, with no message and no retry.
const REDEEM_TIMEOUT = 8000;

/** True when the fetch never reached a verdict (network/DNS/timeout), false when the server
 * answered no (403/404): a verdict about the TOKEN vs. one about the NETWORK. */
let _echecTransitoire = false;

async function redeemerInvite(token: string, nom?: string): Promise<ReponseInvite | null> {
  _echecTransitoire = false;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), REDEEM_TIMEOUT);
  try {
    // `guestId` lets the server tell "this device already named itself" apart from "a different
    // visitor opened the same link"; the same durable id `fil/presence.ts` puts on the WS upgrade.
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
    // No network, or the 8s abort: the server was never actually asked, worth trying again.
    _echecTransitoire = true;
    return null;
  } finally {
    clearTimeout(to);
  }
}

// =================================================================================================
//  THE NAME STEP: ONE FIELD, PRE-FOCUSED, ENTER SUBMITS
// =================================================================================================
/** `valeurInitiale` non-empty = a name is already known (returning guest, "change my name"): the
 * close cross appears. Empty = the mandatory first step, nothing to cancel. */
function afficherEtapeNom(planNom: string, valeurInitiale: string, onJoin: (nom: string) => void): void {
  const dlg = $("inviteNameDlg");
  const texte = $("inviteNameText");
  const inp = $("inviteNameInput") as HTMLInputElement | null;
  const btn = $("inviteNameJoin") as HTMLButtonElement | null;
  const fermer = $("inviteNameClose");
  if (!dlg || !inp || !btn) return;
  if (texte) {
    // textContent, never innerHTML: `planNom` is untrusted server data. Deliberately silent on
    // who sent the link: true, and would only add doubt where there was none.
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

/** A transitory redemption failure: nothing is forgotten, nothing dead-ends, the token may still
 * be good. Reuses `#bootNotice` (`fil/rest.ts`'s `showConflitNotice` banner) rather than a new element. */
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

/** An invitation WAS redeemed and this door slammed anyway: revoked, expired, or the plan deleted
 * mid-session. `fil` is `null` only when the very first redemption already failed. */
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

/** A stranger on the guest door: no invitation was ever redeemed here. Reuses `fil.detached`
 * (every network gate in `rest.ts`/`presence.ts` already respects it) rather than a new switch. */
export function entrerLocalSeul(ctx: Contexte, fil: Fil): void {
  if (fil.detached) return;   // defensive: this must fire at most once per tab
  definirModeLocalSeul();
  ecritStockage(PORTE_LOCALE_KEY, "1"); // avant toute lecture (`PORTE_LOCALE_KEY`)
  fil.detached = true;
  try { fil.ws?.close(); } catch (_) { /* already gone, or never opened */ }
  setSyncChip(fil, "local-only");
  masquerCommandesFoyer(); // ce qui ne marche pas en local-seul ne doit pas y etre propose
  afficherBanniereLocale();
  // No server here either, only this browser, same as `!SYNC_ON` (`panneaux/configuration.ts`).
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

/**
 * Trims what only the household door can do. Called from BOTH guest situations: the condition is
 * "not the household door", never "is an invited guest" (a plain local-only visitor needs the
 * same trim, or a control that cannot work there offers itself anyway).
 */
function masquerCommandesFoyer(): void {
  // "Plans…" needs `/api/plans`, refused off the household door. "Load a plan…" sends
  // `plan5.replace`, refused from a guest outright (batch 2).
  const btnPlans = $("btnPlans"); if (btnPlans) btnPlans.hidden = true;
  const btnImport = $("btnImport"); if (btnImport) btnImport.hidden = true;
  // "Invite": `panneaux/plans.ts` reveals it at boot under `SYNC_ON && estMenage()`, before
  // local-only is discovered on the later 403, so it must be re-hidden here, the only place that
  // knows the real answer by the time it matters.
  const btnInvite = $("btnInvite"); if (btnInvite) btnInvite.hidden = true;
}

/**
 * Opens the name step ON DEMAND: the "Name…" button, and `ctx.crochets.guestSansNom` (on a
 * `guest_unnamed` server refusal). Idempotent: the Durable Object refuses every op while the
 * socket carries no name, so several rejections can land within one gesture, and reopening an
 * already-open dialog would steal focus from someone already typing.
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
 * The redemption attempt, pulled out of `preparerAccueil()` so a transitory failure can retry
 * itself: the Retry button's handler is this same function, closed over `jeton`. `true` = the
 * caller may boot; `false` = the dead end already covers the whole screen.
 */
async function tenterRedemption(jeton: string): Promise<boolean> {
  const rep = await redeemerInvite(jeton, nomInviteStocke());
  if (!rep || !rep.planId) {
    if (_echecTransitoire) {
      // Never a blank page: hand control back with a visible message and a way to retry.
      return new Promise<boolean>((resolve) => {
        afficherEchecReseauInvite(() => { resolve(tenterRedemption(jeton)); });
      });
    }
    // A dead token found in storage must not dead-end this origin forever: forget it, so the
    // next visit falls through to local-only.
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
 * Resolves `true` when `amorcer()` may run; `false` when the dead end already covers the whole
 * screen. Blocks on the name step, if one is shown: nobody reaches the wire unnamed. Always
 * resolves, even against a server that never answers (8s timeout) or only after a Retry click.
 */
export async function preparerAccueil(): Promise<boolean> {
  if (!SYNC_ON) return true;   // file:// / the claude.ai artifact: no token was ever meant to reach here
  const jeton = captureJetonInvite();
  if (!jeton) {
    // Déjà venu sans invitation: reprendre le mode local-seul avant qu'`amorcer()` ne lise le
    // stockage, sinon il verrait un appartement vide à la place du plan de la derniere visite.
    if (litStockage(PORTE_LOCALE_KEY) === "1") definirModeLocalSeul();
    return true;               // ordinary path otherwise: `fil/rest.ts` may still discover local-only later
  }
  return tenterRedemption(jeton);
}
