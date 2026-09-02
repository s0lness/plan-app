// src/ts/modele/etat.ts: THE STATE, AND THE ONLY ENTRY POINT FOR PAYLOADS.
// Porté de src/js/02-etat-migrations.js (`makeState`, `bindState`, `migrate`, `defaultState`).
//
// WHAT CHANGES COMPARED TO THE OLD CLIENT, AND THIS IS THE REASON THIS MODULE EXISTS:
// `localStorage` does NOT appear here. The old js/02 mixed three things into one file evaluated
// at load time: format conversion, reading storage, and bootstrapping (rescue backups,
// `bootOpts`, the first assignment of `state`). Only the first is PURE, and it is the only one
// that remains. Bootstrapping lives in `main.ts`, which calls `migrate()` with whatever it read,
// and decides the fallback (D-2: "neither a plan, nor no plan", it is the caller that decides,
// never the conversion).
//
// Hence the `optsLocaux` parameter: it replaces the old client's global `localOpts` variable,
// with EXACTLY the same precedence (`optsLocaux || cleanOpts(opts)`). Personal settings exist
// from the end of bootstrap onward; from that point a plan received from the server, an import,
// or an undo can no longer write to them (D-7). As long as they do not exist yet (`null`), the
// payload's `opts` serves as the seed, exactly once.

import { cleanOpts, normalizeOpeningFacing, sanitizeV5Plan } from "./migrations.ts";
import type { Options } from "./migrations.ts";
import { v5RebuildCells } from "./cellules.ts";
import { v5AdoptOpening } from "../fil/pseudo-fil.ts";
import { prochainRuid, readLegacyRooms, rectPoly } from "./lecture-v4.ts";
import type { PlanAncien } from "./salles-anciennes.ts";
import { buildV5FromV4 } from "./conversion-v4.ts";
import type { Meuble, PlanV5 } from "../partage/plan.ts";

/**
 * The application's state. `pieces` is a non-enumerable ACCESSOR (D-18), not a copy: see
 * `bindState`. `setupDone` can be `undefined`, "we don't know yet", which bootstrap later
 * decides one way or the other, and that is not the same thing as `false`.
 */
export interface Etat {
  plan: PlanV5;
  opts: Options;
  setupDone: boolean | undefined;
  model: "v5";
  /** the plan's furniture, ALWAYS read through `state.plan` */
  readonly pieces: Meuble[];
}

/**
 * D-18: `state.pieces` is the plan's furniture, exposed through an ACCESSOR (non-enumerable)
 * and not a copied alias. A plan replacement (remote op, undo, reload) can therefore no longer
 * leave behind a stale reference that someone keeps editing.
 * NON-ENUMERABLE is a detail that matters: `Object.defineProperty` does this by default, and it
 * is what keeps `pieces` from showing up as a duplicate of the plan in `JSON.stringify(state)`.
 */
export function bindState<T extends { plan?: PlanV5 | null | undefined }>(s: T): T & { readonly pieces: Meuble[] } {
  Object.defineProperty(s, "pieces", {
    configurable: true,
    get(): Meuble[] { return (s.plan && s.plan.pieces) || []; },
  });
  return s as T & { readonly pieces: Meuble[] };
}

/**
 * Assembles a state from an ALREADY sanitized plan.
 * `optsLocaux` = personal settings if they already exist (`null` otherwise): they ALWAYS win
 * over the payload's `opts`, exactly like the old global `localOpts`.
 */
function makeState(
  plan: PlanV5,
  opts: Partial<Options> | null | undefined,
  setupDone: boolean | undefined,
  optsLocaux: Options | null,
): Etat {
  // Cells are DERIVED: a payload that carries none (minimal server payload, hand-edited plan)
  // must restart from detection, not from an apartment with no rooms.
  if (!plan.cells.length) v5RebuildCells(plan);
  return bindState({
    plan: normalizeOpeningFacing(plan)!,
    opts: optsLocaux || cleanOpts(opts),
    setupDone,
    model: "v5" as const,
  });
}

/**
 * Turns ANY accepted payload into a walls-only state:
 *  - already walls-only (local `plan` copy, or flat server shape outline/walls/...) -> sanitized;
 *  - legacy format (v4 `rooms[]`+`envelope`, or single-room v1/v2/v3) -> READ then CONVERTED.
 * Returns `null` if the payload is neither: the caller decides the fallback (D-2).
 *
 * PRECEDENCE IS A DATA INVARIANT (D-4, docs/reecriture.md §3), not a style detail: the SERVER
 * shape is the FLAT plan, but `st.plan` (nested) remains accepted and takes PRIORITY, because it
 * is the COMPLETE local copy: it also carries the openings' `h`/`side`/`name`, which the wire has
 * not always carried (strict server keys). Reversing this silently erases the depth, side, and
 * name of every opening, and the first save then bakes it in.
 */
export function migrate(raw: unknown, optsLocaux?: Options | null): Etat | null {
  if (!raw) return null;
  let st = raw as Record<string, unknown>;
  // wrapped export: {app:"room-planner", state:{...}}
  if (st["app"] === "room-planner" && st["state"]) st = st["state"] as Record<string, unknown>;
  const flatV5 = (st["outline"] !== undefined || st["walls"] !== undefined)
    ? sanitizeV5Plan({
      outline: st["outline"], walls: st["walls"], cells: st["cells"], pieces: st["pieces"],
      openings: (Array.isArray(st["openings"]) ? (st["openings"] as unknown[]) : []).map(v5AdoptOpening),
    })
    : null;
  const plan = sanitizeV5Plan(st["plan"]) || flatV5;
  const locaux = optsLocaux || null;
  const opts = st["opts"] as Partial<Options> | null | undefined;
  const setupDone = st["setupDone"] as boolean | undefined;
  if (plan) return makeState(plan, opts, setupDone, locaux);
  const legacy = readLegacyRooms(st);
  if (!legacy) return null;
  const res = buildV5FromV4(legacy);
  const conv = res && res.plan && sanitizeV5Plan(res.plan);
  if (!conv) return null;
  return makeState(conv, opts, setupDone, locaux);
}

/**
 * The plan for a fresh install: a single-room apartment (420x360), EMPTY. Written in the
 * LEGACY format then converted through the SAME path as a loaded plan, one single converter,
 * hence one single behavior to verify (D-17).
 * It used to come furnished with four objects (sofa, coffee table, shelf, armchair): so on a
 * fresh page the setup wizard opened on top of an already-furnished living room, asking to
 * define the outline while showing ANOTHER, furnished, home behind the modal. A blank plan is
 * blank.
 */
export function defaultState(optsLocaux?: Options | null): Etat {
  const legacy: PlanAncien = {
    rooms: [{
      id: prochainRuid(), name: "Room 1", floor: "parquet", ax: 0, ay: 0,
      room: { poly: rectPoly(420, 360) }, pieces: [],
    }],
    envelope: null,
  };
  const res = buildV5FromV4(legacy);
  return makeState(res.plan as PlanV5, null, undefined, optsLocaux || null);
}
