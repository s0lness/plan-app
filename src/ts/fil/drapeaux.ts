// src/ts/fil/drapeaux.ts — WHERE THE SYNC LAYER HAS THE RIGHT TO EXIST.
// Ported from src/js/39-sync-drapeaux.js (`SYNC_ON`, `SYNC_URL`), from src/js/00 (`EMBEDDED`) and
// from src/js/44 (`WIRE_ROOM`).
//
// THIS MODULE IMPORTS NOTHING, AND THAT IS DELIBERATE. It is the ROOT of the sync layer's import
// graph: `exportation/transfert.ts` takes `EMBEDDED` from it instead of defining it, and every
// `src/ts/fil/*` module takes `SYNC_ON` from it. A leaf module cannot take part in any import
// cycle, so none of its constants can ever be read in a temporal dead zone. It is the same
// precaution the old manifest took by placing `js/00-noyau.js` first, but guaranteed by the graph
// instead of a convention (AGENTS.md, "migrate() runs in js/02, very early").
//
// D-11 / C-1. SYNC IS CUT OFF EVERYWHERE EXCEPT ON THE APPLICATION'S OWN ORIGIN.
// Under `file://` and inside the claude.ai artifact iframe, `SYNC_ON` is FALSE: no GET, no PUT,
// no WebSocket, no `POST /api/err`. This is not an optimization, it is what lets the test suites
// bring up the client without ever touching the household plan, and it is why the two-browser
// suites spin up a local HTTP server: `SYNC_ON` is only true over http(s).

/** Is the application running inside an iframe (claude.ai artifact)? */
export const EMBEDDED: boolean = ((): boolean => {
  try { return window.self !== window.top; } catch (_) { return true; }
})();

/** Sync only exists top-level over http(s). See the header. */
export const SYNC_ON: boolean = !EMBEDDED && /^https?:$/.test(location.protocol);

/** The client's two REST routes. `/ws` is built at connection time (protocol varies). */
export const SYNC_URL = "/api/plan";
export const PLANS_URL = "/api/plans";

// ---- THE GUEST DOOR: WHICH KIND OF SESSION THIS TAB IS (batch 3) -----------------------------
// `SYNC_ON` alone answers "are we a real, top-level http(s) origin, capable of the network at
// all". It says NOTHING about whether this particular origin is willing to let us WRITE into
// someone else's plan: that is `mode`, a MUTABLE piece of state alongside the const, so this
// module keeps importing nothing (docs/decisions/0004-partage-par-lien.md, batch 3).
//
// Three values: `"menage"` (the household door, or a not-yet-discovered guest door: the default,
// so nothing changes for a household member the instant this file loads), `"invite"` (a redeemed
// invitation: set the moment `POST /api/invite` succeeds, in `fil/invite.ts`), `"local"` (the
// guest door WITHOUT an invitation, discovered by TRYING: the boot GET answers 403 and nothing
// else about this origin can be trusted to say so sooner). Once `"local"` or `"invite"` is set,
// it never reverts for the life of the tab: a reload is what re-decides, exactly like `SYNC_ON`.
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
// `main` is the household plan and the default: a tab that asks for nothing falls onto it, so
// nothing changes for anyone not using multi-plans.
//
// THE URL RULES, NOT LOCAL STORAGE. A shared link (`?p=studio`) must open THAT plan, otherwise
// two people sending each other a link are not looking at the same thing. Local storage only
// serves to find one's last plan when the URL says nothing.
const PLAN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const CLE_PLAN = "plan-dernier-plan";

/**
 * A TAB'S PLAN IS FROZEN AT LOAD TIME, AND THIS IS A FIX.
 *
 * Measured defect: resolution used to be redone ON EVERY CALL, falling back to local storage
 * when the URL said nothing. But the household plan's tab has NO `?p=` in its URL. Creating a
 * second plan wrote "cave" to storage, and that tab, always open, always displaying the house,
 * started answering "cave" and PUBLISHED THE HOUSE INTO THE NEW PLAN. Seen from the screen: the
 * outline wizard opens in the new tab, then the house appears. This is exactly the failure that
 * reloading on every plan change was supposed to make impossible, and it snuck in through the
 * door of storage shared between tabs.
 *
 * Frozen once, two tabs can no longer step on each other: storage only serves to choose the plan
 * for the NEXT load, never to change that of a tab already alive.
 */
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
