// src/ts/panneaux/partage.ts — THE OWNER-SIDE SHARE PANEL for one plan
// (docs/decisions/0004-partage-par-lien.md, "batch 4, owner client").
//
// Opened from a "Share" button on a plan row in `panneaux/plans.ts`. Talks only to
// `/api/invites` (create, list, revoke): it never touches the current document, exactly like
// the Plans panel it is opened from.
//
// THE LINK'S SHAPE. A guest link is `<guest origin>/#k=<token>`. This module cannot invent the
// guest origin: it is a DIFFERENT hostname from the one the owner is browsing, and this
// repository is de-identified, so there is no constant to hardcode. The server is the only place
// that knows `GUEST_HOST` (`functions/porte.ts`), and now says so in every `/api/invites`
// response (`guestHost`, `functions/api/invites.ts`). `construireLienInvite` below is the ONE
// place that turns that value plus a token into a URL; when the server has nothing to say
// (`GUEST_HOST` unset), it returns `null` rather than inventing a host that would not work, and
// the UI shows the raw token with an honest line instead of a broken link.
//
// GUESTS NEVER REACH THIS FILE'S UI: the "Share" button lives inside the Plans panel, which
// `fil/invite.ts`'s `finirGuestOnboarding` already hides (`btnPlans`) for the life of a guest
// tab, and `panneaux/plans.ts` already skips its own fetch off the household door. `ouvrirPartage`
// re-checks anyway, the same belt-and-suspenders discipline `functions/api/invites.ts` itself
// uses ("each handler here checks `porteDe()` again anyway"): a future caller of this function
// that forgets the guard must not reopen a door the rest of the codebase keeps shut.

import type { Contexte } from "../app/contexte.ts";
import { $ } from "../noyau/dom.ts";
import { escapeHtml } from "../noyau/nombres.ts";
import { INVITES_URL, SYNC_ON, estMenage } from "../fil/drapeaux.ts";

// =================================================================================================
//  THE WIRE SHAPE (functions/api/invites.ts's `versJson`)
// =================================================================================================
interface InviteApi {
  token: string;
  createdAt: string | null;
  createdBy: string | null;
  expiresAt: string | null;
  revoked: boolean;
  uses: number;
  lastUsedAt: string | null;
  lastName: string | null;
}

// =================================================================================================
//  PURE LOGIC — tested browserless in tests/partage-fil.ts, no DOM, no fetch
// =================================================================================================

/**
 * Mirrors the server's own "live" rule (`functions/api/invites.ts`'s `MAX_INVITES_PAR_PLAN`
 * count): not revoked, not past its expiry. The list is display-only here — the server remains
 * the one place that ENFORCES it — but "the list of a plan's live invites" (design doc) means
 * this filter has to run before painting, otherwise a revoked or expired row would sit in the
 * list looking exactly like a working one.
 */
export function inviteEstVivante(inv: { revoked: boolean; expiresAt: string | null }): boolean {
  if (inv.revoked) return false;
  if (inv.expiresAt) {
    const exp = Date.parse(inv.expiresAt);
    if (!Number.isNaN(exp) && exp <= Date.now()) return false;
  }
  return true;
}

/**
 * `guestHost` comes straight from the server's `GUEST_HOST` (`null` when unset, never `""` —
 * see `functions/api/invites.ts`). Returns `null` rather than a URL built from nothing: a guest
 * host that does not exist must not manufacture a link that looks real and cannot work.
 */
export function construireLienInvite(guestHost: string | null | undefined, token: string): string | null {
  const h = (guestHost || "").trim();
  if (!h || !token) return null;
  return "https://" + h + "/#k=" + token;
}

/** One decimal-free, `.slice(0,10)` date: the SAME convention `panneaux/plans.ts` already uses
 *  for `updatedAt`, so a household member reads dates the same way in both panels. */
const fmtDate = (iso: string | null): string => (iso ? String(iso).slice(0, 10) : "—");

export interface LigneInviteAffichage { created: string; lastUsed: string; uses: string }

/** Pure formatting for one row: no invite has ever been used = "never used", not a blank cell
 *  that could be mistaken for a loading state. A name is appended only when one was ever seen. */
export function ligneInviteAffichage(inv: {
  createdAt: string | null; lastUsedAt: string | null; lastName: string | null; uses: number;
}): LigneInviteAffichage {
  return {
    created: fmtDate(inv.createdAt),
    lastUsed: inv.lastUsedAt ? fmtDate(inv.lastUsedAt) + (inv.lastName ? " · " + inv.lastName : "") : "never used",
    uses: String(inv.uses),
  };
}

// =================================================================================================
//  DOM + FETCH — the panel itself
// =================================================================================================
let _planId: string | null = null;
let _guestHost: string | null = null;
let _invites: InviteApi[] = [];
let _copyTimer: ReturnType<typeof setTimeout> | undefined;

const dire = (msg: string): void => { const h = $("shareHint"); if (h) h.textContent = msg; };

function peindreListe(): void {
  const l = $("shareList");
  if (!l) return;
  const vivantes = _invites.filter(inviteEstVivante);
  if (!vivantes.length) { l.innerHTML = `<div class="share-empty">No live links yet.</div>`; return; }
  l.innerHTML = vivantes.map((inv) => {
    const aff = ligneInviteAffichage(inv);
    return `<div class="invite-row" data-token="${escapeHtml(inv.token)}">
      <div class="istats">
        <span class="istat"><span class="ilbl">created</span><span class="ival">${escapeHtml(aff.created)}</span></span>
        <span class="istat"><span class="ilbl">last used</span><span class="ival">${escapeHtml(aff.lastUsed)}</span></span>
        <span class="istat"><span class="ilbl">uses</span><span class="ival">${escapeHtml(aff.uses)}</span></span>
      </div>
      <button class="btn sm irevoke" data-token="${escapeHtml(inv.token)}">Revoke</button>
    </div>`;
  }).join("");
}

async function chargerInvites(): Promise<void> {
  if (!_planId) return;
  dire("Loading…");
  try {
    const r = await fetch(INVITES_URL + "?p=" + encodeURIComponent(_planId), { headers: { accept: "application/json" } });
    if (!r.ok) { dire("Could not load the links (" + r.status + ")."); return; }
    const j = await r.json() as { invites?: InviteApi[]; guestHost?: string | null };
    _invites = Array.isArray(j.invites) ? j.invites : [];
    _guestHost = j.guestHost ?? null;
    dire("");
    peindreListe();
  } catch (_) { dire("Could not reach the server. The link list needs the network."); }
}

/** The just-created link (or, absent a configured guest host, its raw token) shown ALREADY
 *  SELECTED with a Copy button: the whole point of "create a link" is to hand it to someone else
 *  right away. */
function afficherLienCree(token: string): void {
  const zone = $("shareNew"), inp = $("shareNewLink") as HTMLInputElement | null, fb = $("shareFallback");
  if (zone) zone.hidden = false;
  const lien = construireLienInvite(_guestHost, token);
  if (inp) {
    inp.value = lien || token;
    inp.focus();
    inp.select();
  }
  if (fb) {
    fb.hidden = !!lien;
    if (!lien) fb.textContent = "No sharing address is configured yet: this is the raw token, not a working link.";
  }
}

async function creerLien(): Promise<void> {
  if (!_planId) return;
  const btn = $("shareCreate") as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  dire("Creating…");
  try {
    const r = await fetch(INVITES_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId: _planId }),
    });
    const j = await r.json() as { invite?: InviteApi; guestHost?: string | null; error?: string; max?: number };
    if (!r.ok || !j.invite) {
      dire(j.error === "trop_d_invitations" ? `That plan already has ${j.max} live links. Revoke one first.`
        : "Could not create a link (" + r.status + ").");
      return;
    }
    _guestHost = j.guestHost ?? null;
    _invites = [j.invite, ..._invites];
    peindreListe();
    afficherLienCree(j.invite.token);
    dire("");
  } catch (_) { dire("Could not create a link: no network."); }
  finally { if (btn) btn.disabled = false; }
}

/** Same isolation as `panneaux/plans.ts`'s `ctxConfirm`: one line, replaceable by the in-house
 *  modal later, and it says exactly what revoking does (design doc's copy guidance). */
const confirmerRevocation = (): boolean => {
  try { return window.confirm("Revoke this link? Anyone still connected with it will be disconnected."); }
  catch (_) { return false; }
};

async function revoquer(token: string): Promise<void> {
  if (!token || !confirmerRevocation()) return;
  dire("Revoking…");
  try {
    const r = await fetch(INVITES_URL, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!r.ok) { dire("Revoke failed (" + r.status + ")."); return; }
    // THE ROW DISAPPEARS: a revoked link is no longer "live", so it leaves the list it came
    // from instead of lingering there looking like it still works (design doc's edge case).
    _invites = _invites.filter((i) => i.token !== token);
    peindreListe();
    dire("Link revoked.");
  } catch (_) { dire("Revoke failed: no network."); }
}

export function ouvrirPartage(planId: string, planNom: string): void {
  // Belt-and-suspenders (see header comment): the button that calls this lives inside a panel a
  // guest never reaches, but the check costs nothing and matches how the server-side routes are
  // written.
  if (!SYNC_ON || !estMenage()) return;
  _planId = planId;
  _invites = [];
  _guestHost = null;
  const d = $("shareDlg");
  const nomEl = $("sharePlanName");
  if (nomEl) nomEl.textContent = planNom;
  const zone = $("shareNew"); if (zone) zone.hidden = true;
  const fb = $("shareFallback"); if (fb) fb.hidden = true;
  const l = $("shareList"); if (l) l.innerHTML = "";
  dire("");
  if (d) d.hidden = false;
  void chargerInvites();
}

function fermerPartage(): void {
  const d = $("shareDlg");
  if (d) d.hidden = true;
}

export function brancherPartage(ctx: Contexte): void {
  void ctx;
  $("shareClose")?.addEventListener("click", fermerPartage);
  $("shareDlg")?.addEventListener("pointerdown", (e) => { if (e.target === $("shareDlg")) fermerPartage(); });
  $("shareDlg")?.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Escape") { e.stopPropagation(); fermerPartage(); } });
  $("shareCreate")?.addEventListener("click", () => { void creerLien(); });
  $("shareCopy")?.addEventListener("click", () => {
    const inp = $("shareNewLink") as HTMLInputElement | null;
    const btn = $("shareCopy");
    if (!inp || !btn) return;
    const flash = (): void => {
      btn.textContent = "Copied ✓"; clearTimeout(_copyTimer);
      _copyTimer = setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    };
    const fallback = (): void => { try { inp.select(); document.execCommand("copy"); flash(); } catch (_) { /* nothing more to try */ } };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(inp.value).then(flash, fallback);
    else fallback();
  });
  // Delegation: the list is repainted on every change, so no listener lives on its nodes
  // (same pattern as `panneaux/plans.ts`'s `plansList`).
  $("shareList")?.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    const rev = t?.closest<HTMLElement>(".irevoke");
    if (rev) void revoquer(String(rev.dataset["token"] || ""));
  });
}
