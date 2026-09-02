// src/ts/fil/drapeaux.ts: WHERE THE SYNC LAYER HAS THE RIGHT TO EXIST.
// This module imports nothing, deliberately: it is the ROOT of the sync layer's import graph, so
// none of its constants can ever be read in a temporal dead zone from a cycle.
//
// D-11 / C-1. SYNC IS CUT OFF EVERYWHERE EXCEPT ON THE APPLICATION'S OWN ORIGIN. Under `file://`
// and inside an iframe, `SYNC_ON` is FALSE: no GET, no PUT, no WebSocket, no `POST /api/err`. This
// is what lets the test suites bring up the client without touching the household plan.

/** Is the application running inside an iframe (claude.ai artifact)? */
export const EMBEDDED: boolean = ((): boolean => {
  try { return window.self !== window.top; } catch (_) { return true; }
})();

/** Sync only exists top-level over http(s). See the header. */
export const SYNC_ON: boolean = !EMBEDDED && /^https?:$/.test(location.protocol);

/** The client's REST routes. `/ws` is built at connection time (protocol varies). */
export const SYNC_URL = "/api/plan";
export const PLANS_URL = "/api/plans";
/** Owner-side sharing (batch 4, docs/decisions/0004-partage-par-lien.md): create, list, revoke. */
export const INVITES_URL = "/api/invites";
/** The feedback drop ("retour-utilisateur"): reachable from EITHER door, see functions/api/feedback.ts. */
export const FEEDBACK_URL = "/api/feedback";
/** The versions the live plan set aside (`conflict`), held by the Durable Object and relayed by
 *  functions/api/orphans.ts. HOUSEHOLD DOOR ONLY: a discarded version is a piece of the household's
 *  plan, so a guest gets a 403 here and must never be offered a button that leads to one. */
export const ORPHANS_URL = "/api/orphans";

// ---- THE GUEST DOOR: WHICH KIND OF SESSION THIS TAB IS (decision 0004, batch 3) ---------------
// `SYNC_ON` says whether the network exists at all; `mode` says whether this origin may WRITE
// into someone else's plan. Three values: `"menage"` (household door, the default), `"invite"`
// (a redeemed invitation), `"local"` (guest door without an invitation, discovered by a 403 on
// the boot GET). Once `"local"` or `"invite"` is set, it never reverts for the tab's life.
export type ModePlan = "menage" | "invite" | "local";
let _mode: ModePlan = "menage";
// Only known once `"invite"` is entered: the id and human name of the plan the token names.
let _planIdInvite: string | null = null;
let _planNomInvite: string | null = null;

export const modeCourant = (): ModePlan => _mode;
export const estMenage = (): boolean => _mode === "menage";
export const estInvite = (): boolean => _mode === "invite";
export const estLocalSeul = (): boolean => _mode === "local";
export const planIdInvite = (): string | null => _planIdInvite;
export const planNomInvite = (): string | null => _planNomInvite;

/** Called once, right after `POST /api/invite` succeeds. Irreversible for the tab's life. */
export function definirModeInvite(planId: string, planNom: string): void {
  _mode = "invite";
  _planIdInvite = planId;
  _planNomInvite = planNom;
}

/** Called once, when the boot GET answers 403 `porte_refusee`/`invite_invalide` WITHOUT an
 *  invitation ever having been redeemed: the guest door, visited by a stranger. */
export function definirModeLocalSeul(): void {
  if (_mode === "menage") _mode = "local";
}

// ---- WHICH PLAN THIS TAB IS LOOKING AT --------------------------------------------------------
// `main` is the household plan and the default. The URL rules, not local storage: a shared link
// (`?p=studio`) must open THAT plan; storage only finds one's last plan when the URL says nothing.
const PLAN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const CLE_PLAN = "plan-dernier-plan";

/** A tab's plan is frozen at load time, never re-resolved (D-19). */
const _plan: string = (() => {
  try {
    const q = new URLSearchParams(location.search).get("p");
    if (q && PLAN_ID_RE.test(q.toLowerCase())) return q.toLowerCase();
  } catch (_) { /* no usable URL: fall through below */ }
  try {
    const m = localStorage.getItem(CLE_PLAN);
    if (m && PLAN_ID_RE.test(m)) return m;
  } catch (_) { /* storage refused: `main` */ }
  return "main";
})();

export function planCourant(): string { return _plan; }

export function memoriserPlan(id: string): void {
  try { localStorage.setItem(CLE_PLAN, id); } catch (_) { /* without memory, we start over at `main` */ }
}

/** `/api/plan?p=…`, `/ws?p=…`: the plan travels in the open in the URL, never implicit. */
export function avecPlan(base: string, id?: string): string {
  const p = id || planCourant();
  return base + (base.indexOf("?") >= 0 ? "&" : "?") + "p=" + encodeURIComponent(p);
}
export const ERR_URL = "/api/err";

/**
 * The CONTAINER label on the wire (cursors, ghosts). The server only relays it, and there is
 * only ONE space, the apartment: it is constant. Asking "which room is the cursor in" no longer
 * makes sense since the walls-only model.
 */
export const WIRE_ROOM = "__apt__";
