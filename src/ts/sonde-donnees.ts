// src/ts/sonde-donnees.ts: THE "DATA AND THUMBNAILS" PROBE SLICE (E3c).
//
// One probe file PER BATCH: `js/57-sondes-test.js` was "the repo's most likely git conflict
// point", and two keys were genuinely duplicated in it.
//
// TRAP PAID FOR BY THE PREVIOUS BATCH: `Object.assign` COPIES an accessor's VALUE. Anything
// that must stay LIVE is written as `get x()` here, and `sonde.ts` carries the DESCRIPTORS.
//
// What this slice covers, and nothing else: the `serialize`/`migrate` round trip, the outline's
// axiality, and the two palette-THUMBNAIL measurements. The rules they probe are all ported
// elsewhere: here we only reach out a hand.

import type { Contexte } from "./app/contexte.ts";
import type { Etat } from "./modele/etat.ts";
import { migrate } from "./modele/etat.ts";
import { sanitizeV5Plan } from "./modele/migrations.ts";
import { pieceIconViewH, wallMountMarkerMetrics } from "./rendu/icones.ts";

/**
 * The overflow, in px, of ONE palette thumbnail outside its `.prev` slot (44 x 30). Positive =
 * it overflows. `l/t/r/b` measure the `<svg>`'s BOX, `il/it/ir/ib` the INK actually painted.
 */
export interface DebordementVignette {
  type: string | undefined;
  l: number; t: number; r: number; b: number;
  il: number; it: number; ir: number; ib: number;
  w: number; h: number;
}

export interface SondeDonnees {
  migrate(brut: unknown): Etat | null;
  sanitizeV5Plan: typeof sanitizeV5Plan;
  allEdgesAxisAligned(tolCm?: number | null): boolean;
  pieceIconViewH: typeof pieceIconViewH;
  wallMountMarkerMetrics: typeof wallMountMarkerMetrics;
  paletteIconOverflow(): DebordementVignette[];
}

export function sondeDonnees(ctx: Contexte): SondeDonnees {
  return {
    // ---- reading a plan ----------------------------------------------------------------------
    migrate: (brut: unknown): Etat | null => migrate(brut),
    sanitizeV5Plan,

    // ---- outline geometry -------------------------------------------------------------------
    /** Is the outline entirely axial, within `tolCm` (0.5 cm by default)? */
    allEdgesAxisAligned(tolCm?: number | null): boolean {
      const t = (tolCm == null) ? 0.5 : tolCm;
      const poly = ctx.etat.plan.outline || [];
      const n = poly.length;
      for (let i = 0; i < n; i++) {
        const a = poly[i]!, b = poly[(i + 1) % n]!;
        if (Math.abs(a[0] - b[0]) > t && Math.abs(a[1] - b[1]) > t) return false;
      }
      return true;
    },

    // ---- palette thumbnails -------------------------------------------------------------------
    pieceIconViewH,
    wallMountMarkerMetrics,
    /**
     * `pieceIconSVG` sets `overflow:visible` on wall-mounted objects, because their marker MUST
     * stick out into the room, on the PLAN. In the palette, the slot is only 44 x 30 px: this
     * overflow, expressed in cm, was worth ~45 px and covered the neighboring slot. So we
     * measure the `<svg>`'s BOX AND the painted INK (union of the children's rectangles): with
     * `overflow:visible`, the drawing came out of the slot without the box moving. The ink is
     * re-clipped to the box when the svg does not overflow, the same way the browser does
     * (otherwise a deliberately clipped stroke, e.g. the duct's hatching, would wrongly count).
     */
    paletteIconOverflow(): DebordementVignette[] {
      const out: DebordementVignette[] = [];
      document.querySelectorAll<HTMLElement>("#palette .pitem").forEach((it) => {
        const prev = it.querySelector(".prev"), svg = it.querySelector<SVGElement>("svg");
        if (!prev || !svg) return;
        const a = prev.getBoundingClientRect(), b = svg.getBoundingClientRect();
        let il = Infinity, it2 = Infinity, ir = -Infinity, ib = -Infinity;
        svg.querySelectorAll("*").forEach((n) => {
          const r = n.getBoundingClientRect();
          if (!r.width && !r.height) return;
          il = Math.min(il, r.left); it2 = Math.min(it2, r.top);
          ir = Math.max(ir, r.right); ib = Math.max(ib, r.bottom);
        });
        if (!isFinite(il)) { il = b.left; it2 = b.top; ir = b.right; ib = b.bottom; }
        if (getComputedStyle(svg).overflow !== "visible") {
          il = Math.max(il, b.left); it2 = Math.max(it2, b.top);
          ir = Math.min(ir, b.right); ib = Math.min(ib, b.bottom);
        }
        out.push({
          type: it.dataset["type"],
          l: +(a.left - b.left).toFixed(2), t: +(a.top - b.top).toFixed(2),
          r: +(b.right - a.right).toFixed(2), b: +(b.bottom - a.bottom).toFixed(2),
          il: +(a.left - il).toFixed(2), it: +(a.top - it2).toFixed(2),
          ir: +(ir - a.right).toFixed(2), ib: +(ib - a.bottom).toFixed(2),
          w: +b.width.toFixed(2), h: +b.height.toFixed(2),
        });
      });
      return out;
    },
  };
}
