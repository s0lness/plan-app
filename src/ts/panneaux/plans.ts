// src/ts/panneaux/plans.ts — THE PLAN SELECTOR.
//
// A plan is a D1 ROW and a Durable Object carrying the same identifier. This panel only knows
// the API: it never touches the current document, publishes nothing, and doesn't know how to
// draw. Switching plans RELOADS THE PAGE, a deliberate decision, explained further below.

import type { Contexte } from "../app/contexte.ts";
import { $ } from "../noyau/dom.ts";
import { escapeHtml } from "../noyau/nombres.ts";
import { PLANS_URL, SYNC_ON, estMenage, memoriserPlan, planCourant } from "../fil/drapeaux.ts";
import { toast } from "../app/toast.ts";
import { ouvrirPartage } from "./partage.ts";

interface PlanListe {
  id: string;
  name: string;
  rev: number;
  updatedAt: string | null;
  updatedBy: string | null;
  bytes: number | null;
}

let _plans: PlanListe[] = [];

const dire = (msg: string): void => {
  const h = $("plansHint");
  if (h) h.textContent = msg;
};

/**
 * SWITCHING PLANS RELOADS THE PAGE, and that's deliberate.
 *
 * Switching "live" would mean: closing the socket, clearing the undo history, dropping the
 * selection, resetting the view, reinitializing the emission mirror and the presence table, that
 * is, redoing by hand everything bootstrapping already does, correctly, along a single path. One
 * forgotten piece of state among those, and one plan's work would get published INTO another:
 * the worst failure this application could have. A reload costs 300 ms and cannot get it wrong.
 */
function ouvrirPlan(id: string): void {
  memoriserPlan(id);
  const u = new URL(location.href);
  u.searchParams.set("p", id);
  location.href = u.toString();
}

async function charger(): Promise<void> {
  dire("Loading…");
  try {
    const r = await fetch(PLANS_URL, { headers: { accept: "application/json" } });
    if (!r.ok) { dire("Could not load the plan list (" + r.status + ")."); return; }
    const j = await r.json() as { plans?: PlanListe[] };
    _plans = Array.isArray(j.plans) ? j.plans : [];
    dire("");
    peindre();
  } catch (_) {
    dire("Could not reach the server. The plan list needs the network.");
  }
}

function peindre(): void {
  const l = $("plansList");
  if (!l) return;
  const courant = planCourant();
  if (!_plans.length) { l.innerHTML = `<div class="plans-empty">No plan yet.</div>`; return; }
  l.innerHTML = _plans.map((p) => {
    const ici = p.id === courant;
    const quand = p.updatedAt ? String(p.updatedAt).slice(0, 10) : "—";
    const vide = !p.bytes || p.bytes <= 6;   // serialized `null` = 4 bytes: a plan never touched
    return `<div class="plan-row${ici ? " here" : ""}" data-id="${escapeHtml(p.id)}">
      <span class="pname" data-id="${escapeHtml(p.id)}" title="Double-click to rename">${escapeHtml(p.name)}</span>
      <span class="pmeta">${vide ? "empty" : quand}</span>
      <button class="btn sm pshare" data-id="${escapeHtml(p.id)}" title="Share this plan by link">Share</button>
      ${ici ? `<span class="pcur">open</span>`
            : `<button class="btn sm popen" data-id="${escapeHtml(p.id)}">Open</button>`}
      ${p.id === "main" ? "" : `<button class="flow-x pdel" data-id="${escapeHtml(p.id)}" title="Delete this plan">×</button>`}
    </div>`;
  }).join("");
}

/** IN-PLACE rename: the name becomes a field, Enter confirms, Escape cancels, blur confirms. */
function editerNom(span: HTMLElement): void {
  const id = String(span.dataset["id"] || "");
  const avant = span.textContent || "";
  const inp = document.createElement("input");
  inp.type = "text";
  inp.maxLength = 60;
  inp.value = avant;
  inp.className = "pname-edit";
  span.replaceWith(inp);
  inp.focus();
  inp.select();
  let fini = false;
  const finir = async (valider: boolean): Promise<void> => {
    if (fini) return;
    fini = true;
    const nom = inp.value.trim();
    if (!valider || !nom || nom === avant) { peindre(); return; }
    try {
      const r = await fetch(PLANS_URL, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, name: nom }),
      });
      if (!r.ok) { dire("Rename refused (" + r.status + ")."); peindre(); return; }
      const p = _plans.find((q) => q.id === id);
      if (p) p.name = nom;
      peindre(); peindreTitre();
    } catch (_) { dire("Rename failed: no network."); peindre(); }
  };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); void finir(true); }
    else if (e.key === "Escape") { e.preventDefault(); void finir(false); }
  });
  inp.addEventListener("blur", () => { void finir(true); });
}

async function creer(): Promise<void> {
  const inp = $("plansNewName") as HTMLInputElement | null;
  const nom = (inp?.value || "").trim();
  if (!nom) { dire("Give the new plan a name first."); inp?.focus(); return; }
  dire("Creating…");
  try {
    const r = await fetch(PLANS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: nom }),
    });
    const j = await r.json() as { ok?: boolean; id?: string; error?: string; max?: number };
    if (!r.ok || !j.ok || !j.id) {
      dire(j.error === "too_many_plans" ? `That is the ${j.max}-plan limit.`
         : j.error === "plan_exists" ? "A plan with that address already exists."
         : "Could not create the plan (" + r.status + ").");
      return;
    }
    if (inp) inp.value = "";
    // A NEW PLAN IS EMPTY: we open it, and the outline wizard opens on its own, exactly as on the
    // very first startup. Nothing is copied from the current plan.
    ouvrirPlan(j.id);
  } catch (_) { dire("Could not create the plan: no network."); }
}

async function supprimer(id: string): Promise<void> {
  const p = _plans.find((q) => q.id === id);
  if (!ctxConfirm(`Delete “${p ? p.name : id}”? This cannot be undone.`)) return;
  try {
    const r = await fetch(PLANS_URL, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!r.ok) { dire("Delete refused (" + r.status + ")."); return; }
    _plans = _plans.filter((q) => q.id !== id);
    peindre();
  } catch (_) { dire("Delete failed: no network."); }
}

/** A single confirmation, isolated so it stays replaceable by the in-house modal later. */
const ctxConfirm = (msg: string): boolean => {
  try { return window.confirm(msg); } catch (_) { return false; }
};

/** The current plan's cached name, for the toolbar Invite button: this panel already fetches
 *  the plan list for its own rows (`_plans`), so the button reads from there instead of firing a
 *  second fetch on every click. Falls back to the id when the list has not loaded yet (e.g. the
 *  very first click, before `charger()` resolves): `ouvrirPartage` still works with an
 *  id-as-name, no second source of truth for plan names is introduced. */
function nomPlanCourant(): string {
  const id = planCourant();
  const p = _plans.find((q) => q.id === id);
  return p ? p.name : id;
}

/** The rail's title carries the current plan's name (or its identifier if the name is missing). */
function peindreTitre(): void {
  const el = $("planName");
  if (!el) return;
  const id = planCourant();
  const p = _plans.find((q) => q.id === id);
  el.textContent = p ? p.name : (id === "main" ? "Flat plan" : id);
}

/** Rename the plan FROM ITS TITLE, in place. Same write path as in the panel (PATCH). */
function editerTitre(el: HTMLElement): void {
  const id = planCourant();
  const avant = el.textContent || "";
  const inp = document.createElement("input");
  inp.type = "text";
  inp.maxLength = 60;
  inp.value = avant;
  inp.className = "plan-name-edit";
  el.replaceWith(inp);
  inp.focus(); inp.select();
  let fini = false;
  const finir = async (valider: boolean): Promise<void> => {
    if (fini) return;
    fini = true;
    const nom = inp.value.trim();
    const span = document.createElement("span");
    span.className = "plan-name";
    span.id = "planName";
    span.title = "Double-click to rename this plan";
    span.textContent = avant;
    inp.replaceWith(span);
    span.addEventListener("dblclick", (e) => { e.preventDefault(); editerTitre(span); });
    if (!valider || !nom || nom === avant) return;
    try {
      const r = await fetch(PLANS_URL, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, name: nom }),
      });
      if (!r.ok) return;
      const p = _plans.find((q) => q.id === id);
      if (p) p.name = nom;
      span.textContent = nom;
    } catch (_) { /* without a network, the title stays as it was */ }
  };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); void finir(true); }
    else if (e.key === "Escape") { e.preventDefault(); void finir(false); }
    else e.stopPropagation();
  });
  inp.addEventListener("blur", () => { void finir(true); });
}

function ouvrirPlans(): void {
  const d = $("plansDlg");
  if (!d) return;
  d.hidden = false;
  void charger();
}

export function brancherPlans(ctx: Contexte): void {
  void ctx;
  $("btnPlans")?.addEventListener("click", () => ouvrirPlans());
  $("plansClose")?.addEventListener("click", () => { const d = $("plansDlg"); if (d) d.hidden = true; });
  $("plansCreate")?.addEventListener("click", () => { void creer(); });
  $("plansNewName")?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") { e.preventDefault(); void creer(); }
  });
  // Delegation: the list is repainted on every change, so no listener lives on its nodes.
  $("plansList")?.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    const share = t?.closest<HTMLElement>(".pshare");
    if (share) {
      const id = String(share.dataset["id"]);
      const p = _plans.find((q) => q.id === id);
      ouvrirPartage(id, p ? p.name : id);
      return;
    }
    const open = t?.closest<HTMLElement>(".popen");
    if (open) { ouvrirPlan(String(open.dataset["id"])); return; }
    const del = t?.closest<HTMLElement>(".pdel");
    if (del) { void supprimer(String(del.dataset["id"])); return; }
  });
  $("plansList")?.addEventListener("dblclick", (e) => {
    const t = e.target as HTMLElement | null;
    const nom = t?.closest<HTMLElement>(".pname");
    if (nom) { e.preventDefault(); editerNom(nom); }
  });
  // THE RAIL'S TITLE IS THE PLAN'S NAME. "Flat plan" said nothing we didn't already know; what
  // we need to read is WHICH one we're looking at, otherwise two tabs on two different plans are
  // indistinguishable.
  //
  // THE NAME LIVES SERVER-SIDE, SO WE ONLY GO THERE IF THERE IS A SERVER. `SYNC_ON` is false under
  // `file://` and in the artifact: an unconditional read there produced a `net::ERR_FAILED` in
  // the console, and a clean console is exactly what `boot-vierge` checks. In the meantime (or
  // failing that), the title carries the plan's IDENTIFIER: never "Flat plan", never a title that
  // doesn't say which one we're looking at.
  peindreTitre();
  // BATCH 3. `/api/plans` is 403 on the guest door in every method, whether invited or
  // local-only (docs/decisions/0004-partage-par-lien.md): fetching it there would only ever
  // produce a failed request nobody reads (the Plans panel itself is hidden for a guest,
  // `fil/invite.ts`). `estMenage()` is already known by this synchronous point for an INVITED
  // tab (the redemption that set it happens before `amorcer()` runs); a fresh LOCAL-ONLY visitor
  // is still `"menage"` here (discovered only after the boot GET answers), so this one fetch can
  // still fire once before that discovery — harmless, and the price of "discover by trying".
  if (SYNC_ON && estMenage()) void charger().then(() => peindreTitre()).catch(() => { /* title = identifier */ });
  // TOOLBAR INVITE BUTTON: opens the Share panel for whatever plan is on screen right now,
  // without going through this panel first. Same gate as the fetch just above (`SYNC_ON` false
  // under `file://`/the artifact, or off the household door): the HTML starts it `hidden`, this
  // is the only place that reveals it, so a mistake fails closed.
  const btnInvite = $("btnInvite");
  if (btnInvite) {
    if (SYNC_ON && estMenage()) btnInvite.hidden = false;
    btnInvite.addEventListener("click", () => ouvrirPartage(planCourant(), nomPlanCourant()));
  }
  $("planName")?.addEventListener("dblclick", (e) => {
    e.preventDefault();
    const el = $("planName");
    if (el) editerTitre(el);
  });
  void toast;
}
