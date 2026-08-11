// src/ts/fil/identite.ts — IDENTIFIERS OF CREATED ENTITIES.
// Ported from src/js/51-v5-pseudo-fil.js (`v5DeviceTag`, `v5NewId`, `v5DerivedId`).
//
// C-8. AN IDENTIFIER OF A CREATED ENTITY CARRIES A DEVICE LABEL (`w20-a3f9c1`). Without it, two
// people drawing a partition at the same instant would both number from THEIR local plan, get the
// same `w20`, and every other wall would disappear without a word. The label comes from `wsMe.tag`
// (the server `hello`, unique per SOCKET, hence distinct for two tabs of the same person),
// otherwise from a draw kept in `sessionStorage`; it is frozen for the life of the tab.
//
// THE SYMMETRIC TRAP: a DERIVED entity that both devices recompute identically (FACADE walls,
// mirroring the outline's edges) must keep an id WITHOUT a label. The "collision" there is the
// INTENDED behavior, otherwise a received `outline.set` would spawn a second facade wall on the
// peer's side and the two plans would diverge.

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

export function v5DeviceTag(): string {
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

const radicauxUtilises = (avecEtiquette: boolean): Set<string> => {
  const P = (_plan && _plan()) || ({} as PlanV5);
  const used = new Set<string>();
  (["walls", "openings", "pieces", "cells"] as const).forEach((k) => {
    const l = (P as unknown as Record<string, { id: unknown }[]>)[k] || [];
    l.forEach((e) => used.add(avecEtiquette ? String(e.id).replace(/-[a-z0-9]+$/, "") : String(e.id)));
  });
  return used;
};

export function v5NewId(prefix: string): string {
  const tag = v5DeviceTag();
  // We number on the STEM (label stripped): the sequence stays readable ("w20-a3f9c1" after w19)
  // instead of restarting at w1 as soon as a label frees up the small numbers.
  const used = radicauxUtilises(true);
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
