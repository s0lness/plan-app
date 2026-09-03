// src/ts/fil/identite.ts: IDENTIFIERS OF CREATED ENTITIES.
// C-8: a created entity's id carries a device label (`w20-a3f9c1`), from `wsMe.tag` or a draw
// kept in `sessionStorage`, frozen for the tab's life. A DERIVED entity (facade walls, mirroring
// the outline) keeps an id WITHOUT a label on purpose: both devices recompute it identically.

import type { PlanV5 } from "../partage/plan.ts";

const V5_TAG_KEY = "plan-device-tag";
let v5_tag: string | null = null;

/** The SERVER's label when it exists. Set by the collaboration batch (`hello`). */
let _tagServeur: (() => string | null | undefined) | null = null;
export function brancherTagServeur(fn: () => string | null | undefined): void { _tagServeur = fn; }

const clean = (v: unknown): string | null => {
  const s = String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  return s.length >= 4 ? s : null;
};

function v5DeviceTag(): string {
  if (v5_tag) return v5_tag;
  const srv = _tagServeur ? clean(_tagServeur()) : null;
  if (srv) return (v5_tag = srv);
  let t: string | null = null;
  try { t = clean(sessionStorage.getItem(V5_TAG_KEY)); } catch (_) { t = null; }
  if (!t) {
    t = clean(Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)) || "000000";
    try { sessionStorage.setItem(V5_TAG_KEY, t); } catch (_) { /* sessionStorage refused: the draw holds for the page */ }
  }
  return (v5_tag = t);
}

/** The current plan, so numbering does not reuse a stem already taken. */
let _plan: (() => PlanV5 | null | undefined) | null = null;
export function brancherPlanIdentite(fn: () => PlanV5 | null | undefined): void { _plan = fn; }

const radicauxUtilises = (avecEtiquette: boolean, plan?: PlanV5 | null): Set<string> => {
  const P = plan || (_plan && _plan()) || ({} as PlanV5);
  const used = new Set<string>();
  (["walls", "openings", "pieces", "cells"] as const).forEach((k) => {
    const l = (P as unknown as Record<string, { id: unknown }[]>)[k] || [];
    l.forEach((e) => used.add(avecEtiquette ? String(e.id).replace(/-[a-z0-9]+$/, "") : String(e.id)));
  });
  return used;
};

export function v5NewId(prefix: string, plan?: PlanV5 | null): string {
  const tag = v5DeviceTag();
  // We number on the STEM (label stripped): the sequence stays readable ("w20-a3f9c1" after w19)
  // instead of restarting at w1 as soon as a label frees up the small numbers.
  // A pure model operation may pass the plan it is editing. The ordinary UI path keeps using the
  // plan wired at boot, so existing callers and their identifiers remain unchanged.
  const used = radicauxUtilises(true, plan);
  let n = 1, base: string;
  do { base = prefix + (n++); } while (used.has(base));
  return base + "-" + tag;
}

/** C-8, the derived case: no label, local numbering, as before. */
export function v5DerivedId(prefix: string): string {
  const used = radicauxUtilises(false);
  let n = 1, id: string;
  do { id = prefix + (n++); } while (used.has(id));
  return id;
}

// ---- GUEST CLIENT: A GUEST'S OWN SECOND TAB (decision 0004, edge 8) ---------------------------
// `v5DeviceTag` is per SOCKET, so it can't tell "my other tab" from "a different guest". `guestId`
// is per BROWSER PROFILE (`localStorage`, not `sessionStorage`), read back identically by every
// tab on this device; `wsSameAccount` (`fil/etat.ts`) compares it like an email on the household door.
const GUEST_ID_KEY = "plan-guest-id";
// Same shape the server re-validates (`functions/ws.ts`, `live-worker/worker.ts`): not a
// credential, just narrow enough to carry nothing but itself.
const GUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function guestIdCourant(): string {
  let g: string | null = null;
  try { g = localStorage.getItem(GUEST_ID_KEY); } catch (_) { g = null; }
  if (g && GUEST_ID_RE.test(g)) return g;
  const octets = new Uint8Array(8);
  try { crypto.getRandomValues(octets); }
  catch (_) { for (let i = 0; i < octets.length; i++) octets[i] = Math.floor(Math.random() * 256); }
  g = Array.from(octets, (b) => b.toString(16).padStart(2, "0")).join("");
  try { localStorage.setItem(GUEST_ID_KEY, g); } catch (_) { /* private browsing: works for this load, just not remembered */ }
  return g;
}
