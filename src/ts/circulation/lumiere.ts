// src/ts/circulation/lumiere.ts: IS THE ROOM LIT ENOUGH? A MAP OF LEVELS, NOT A SIMULATION.
//
// What this does NOT claim to be: a photometric render. No bounce, no reflectance, no shadow cast
// by furniture, no directional beam. What it does claim: every light fixture radiates its flux
// evenly around itself, the level reaching a point is the sum of `lm / (4*pi*d^2)` in approximate
// lux, and A WALL STOPS IT. That last point is the whole reason the map is worth drawing: a
// ceiling light in the corridor tells you nothing about the bedroom next door.
//
// THE WALL CUT IS DONE BY CELL MEMBERSHIP, not by a ray/segment test. It is the same rule and it
// is cheaper: the circulation grid already knows which plan cell each of its squares falls in
// (`indexCelluleDans`), so "the ray crosses a wall" and "the two points are not in the same cell"
// answer identically for a straight-walled home, and the second answer costs one point-in-polygon
// instead of one intersection per wall per square. A door does NOT leak light here, deliberately:
// what the owner asked is whether a ROOM is lit, and a room borrowing its neighbour's ceiling
// light is exactly the answer that would be wrong.
//
// The flux table lives HERE, in the code, never in the plan's data: a default is not a value
// somebody chose. What somebody chooses is `lm` on the object (and `lux` on the room), and those
// two ARE persisted, bounded, and travel (C-5).

import type { CelluleFlow, Grille, ObjetFlow } from "./etat.ts";
import { indexCelluleDans } from "./contexte.ts";
import { clamp, WALL } from "../noyau/nombres.ts";

/** Luminous flux, lumens. The server bounds `lm` to this range, like `tr` (see AGENTS.md). */
export const LM_MIN = 0, LM_MAX = 20000;
/** A room's own lighting target, lux. */
export const LUX_MIN = 0, LUX_MAX = 2000;

/**
 * DEFAULT FLUX PER CATALOGUE TYPE, lumens. Only the three fixtures the catalogue actually holds
 * are listed: `ceil` (ceiling light), `sconce` (wall light) and `lamp` (floor lamp). There is no
 * table lamp in the catalogue; the day one is added, its line goes here (500 lm at 60 cm) and
 * nothing else changes.
 */
export const FLUX_DEFAUT: Record<string, number> = { ceil: 1500, sconce: 400, lamp: 900 };

/** A window is a DAY source: 2000 lm per metre of opening width, and only in Day mode. */
export const FLUX_FENETRE_PAR_M = 2000;

/**
 * HEIGHT OF THE SOURCE ABOVE THE FLOOR, cm. It is what keeps the level finite directly under a
 * fixture: the distance used is the SLANT distance, `dx^2 + dy^2 + height^2`.
 */
export const HAUTEUR_CM: Record<string, number> = { ceil: 240, sconce: 180, lamp: 150, window: 120 };

/** Target when the room's name says nothing and nobody typed a `lux`. */
export const CIBLE_DEFAUT = 150;

/**
 * TARGET BY USE, read off the room's NAME. First match in this order wins, so a "Cuisine bureau"
 * is a kitchen: the list is ordered by how specific the use is, not alphabetically.
 * Accents are stripped before matching, so "Entrée" and "Entree" are the same word.
 */
const CIBLES: ReadonlyArray<readonly [readonly string[], number]> = [
  [["cuisine", "kitchen"], 300],
  [["bureau", "office", "desk"], 500],
  [["salle de bain", "bathroom"], 200],
  [["chambre", "bedroom"], 100],
  [["salon", "living"], 150],
  [["couloir", "hall", "entree"], 100],
];

/** Lowercase, accents stripped: "Entrée" and "entree" must not be two different rooms. */
function plie(nom: unknown): string {
  return String(nom || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * The room's target, in lux. A `lux` TYPED ON THE CELL always wins: the keyword list is a guess
 * about the use, the typed value is a statement about it.
 */
export function cibleLux(nom: unknown, lux?: number | undefined): number {
  const n = Number(lux);
  if (lux !== undefined && isFinite(n) && n > 0) return clamp(n, LUX_MIN, LUX_MAX);
  const s = plie(nom);
  for (const [mots, cible] of CIBLES) {
    for (const m of mots) if (s.includes(m)) return cible;
  }
  return CIBLE_DEFAUT;
}

/** Does this catalogue type emit light? A window only does so by day, which `sourcesLumiere` knows. */
export function estLumiere(type: string): boolean {
  return type === "window" || FLUX_DEFAUT[type] !== undefined;
}

export interface SourceLumiere {
  /** where the light comes FROM, apartment cm (a wall fixture stays on its wall) */
  x: number;
  y: number;
  /** height above the floor, cm */
  hcm: number;
  /** luminous flux, lumens */
  lm: number;
  /** index of the plan cell this source lights, or -1 (it lights none) */
  ci: number;
}

/** The flux a light object radiates, its own `lm` if it carries one, else its type's default. */
export function fluxDe(o: ObjetFlow): number {
  const propre = Number((o as unknown as { lm?: number }).lm);
  if ((o as unknown as { lm?: number }).lm !== undefined && isFinite(propre) && propre >= 0) {
    return clamp(propre, LM_MIN, LM_MAX);
  }
  if (o.type === "window") return FLUX_FENETRE_PAR_M * (Math.max(o.w, 0) / 100);
  return FLUX_DEFAUT[o.type] ?? 0;
}

/**
 * A wall-carried fixture (wall light, window) sits ON the wall's median line, where
 * point-in-polygon answers ambiguously. We step off the wall along its own normal (local +y,
 * the same convention `doorPassage` uses) to find the room it lights; if that side is not a room,
 * we try the other one, which is what an outline window does.
 */
function celluleEclairee(o: ObjetFlow, cells: CelluleFlow[], cx: number, cy: number): number {
  const surMur = o.type === "window" || o.type === "sconce";
  if (!surMur) return indexCelluleDans(cells, cx, cy);
  const rad = (o.rot || 0) * Math.PI / 180;
  const nx = Math.sin(rad), ny = Math.cos(rad);
  const off = WALL / 2 + 8;
  for (const sgn of [1, -1]) {
    const k = indexCelluleDans(cells, cx + nx * off * sgn, cy + ny * off * sgn);
    if (k >= 0) return k;
  }
  return -1;
}

/**
 * The light sources of a plan, in apartment cm. `jour` = Day mode: windows count as sources only
 * then. Openings (wall light, window) arrive here as `ObjetFlow` like any piece of furniture,
 * because `buildAptContext` already flattens both families into one list.
 */
export function sourcesLumiere(objets: ObjetFlow[], cells: CelluleFlow[], jour: boolean): SourceLumiere[] {
  const out: SourceLumiere[] = [];
  for (const o of objets) {
    if (!estLumiere(o.type)) continue;
    if (o.type === "window" && !jour) continue;
    const lm = fluxDe(o);
    if (!(lm > 0)) continue;
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    const ci = celluleEclairee(o, cells, cx, cy);
    if (ci < 0) continue;
    out.push({ x: cx, y: cy, hcm: HAUTEUR_CM[o.type] ?? 240, lm, ci });
  }
  return out;
}

export interface CarteLumiere {
  /** level at each grid square, approximate lux; 0 on a blocked square */
  lux: Float64Array;
  /** plan cell of each grid square, -1 outside every room */
  ci: Int32Array;
  /** average level per plan cell, same indexing as `cells` */
  moyennes: number[];
}

/**
 * The map, over the SAME grid Circulation walks on (one grid per plan, no second discretization).
 * A square under a piece of furniture is `blocked`, so it holds no level and weighs nothing in the
 * average: the question is how lit the floor you STAND on is.
 */
export function carteLumiere(g: Grille, sources: SourceLumiere[], cells: CelluleFlow[]): CarteLumiere {
  const n = g.gw * g.gh;
  const lux = new Float64Array(n);
  const ci = new Int32Array(n).fill(-1);
  const somme = new Float64Array(cells.length);
  const compte = new Int32Array(cells.length);
  for (let gy = 0; gy < g.gh; gy++) {
    for (let gx = 0; gx < g.gw; gx++) {
      const i = gy * g.gw + gx;
      if (g.blocked[i]) continue;
      const x = g.ox + (gx + 0.5) * g.cs, y = g.oy + (gy + 0.5) * g.cs;
      const k = indexCelluleDans(cells, x, y);
      ci[i] = k;
      if (k < 0) continue;
      let niveau = 0;
      for (const s of sources) {
        if (s.ci !== k) continue;          // THE WALL CUT: a source lights its own room, and only it
        const dx = x - s.x, dy = y - s.y;
        const d2 = (dx * dx + dy * dy + s.hcm * s.hcm) / 10000;   // metres squared
        if (d2 > 0) niveau += s.lm / (4 * Math.PI * d2);
      }
      lux[i] = niveau;
      somme[k]! += niveau;
      compte[k]! += 1;
    }
  }
  const moyennes = cells.map((_, k) => (compte[k] ? somme[k]! / compte[k]! : 0));
  return { lux, ci, moyennes };
}

/** Where a level sits against its target: green / orange / red, the room sheet's three bands. */
export type BandeLumiere = "ok" | "warn" | "bad";

export function bandeLumiere(moyenne: number, cible: number): BandeLumiere {
  if (!(cible > 0)) return "ok";
  const r = moyenne / cible;
  if (r >= 1) return "ok";
  if (r >= 0.7) return "warn";
  return "bad";
}
