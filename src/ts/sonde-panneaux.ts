// src/ts/sonde-panneaux.ts: THE PROBE SLICE FOR THE "panneaux" SUB-BATCH (E3c).
// One probe file PER BATCH: `js/57-sondes-test.js` was "the repo's most likely git conflict
// point", and two keys were genuinely duplicated in it.
//
// TRAP PAID FOR BY THE PREVIOUS BATCH: `Object.assign` COPIES an accessor's VALUE. Anything
// that must stay LIVE is written as `get x()` here, and `sonde.ts` carries the DESCRIPTORS.
//
// A MISSING ENTRY IS AN ENTRY NOT YET PORTED, never an abandoned entry.
import type { Contexte } from "./app/contexte.ts";
import type { Meuble, Ouverture } from "./partage/plan.ts";
import { pieceById } from "./app/contexte.ts";
import { $ } from "./noyau/dom.ts";
import { cur } from "./gestes/selection-actions.ts";
import { openInspector, setDim } from "./panneaux/inspecteur.ts";
import { renommerCelluleEnLigne, renommerMeubleEnLigne } from "./panneaux/renommer-en-ligne.ts";
import { histInfo } from "./historique/pile.ts";

/** The visible state of an inspector button: offered, or removed, or grayed out. */
export interface EtatBouton { hidden: boolean; disabled: boolean }

export interface SondePanneaux {
  openInspector(): void;
  /** Sets a dimension via the inspector's path (same clamp as typing), renders the primary object. */
  setInspectorDim(which: string, val: unknown): Meuble | Ouverture | undefined;
  /** Inspector buttons actually offered for selection `id`. "Bring to front" is gone (decision
   * 0013): paint order is automatic, there is no button left to probe here. */
  inspectorButtons(id?: unknown): {
    dup: EtatBouton | null; rot90: EtatBouton | null;
    side: EtatBouton | null; del: EtatBouton | null; inspHidden: boolean;
  };
  /** A REAL click on an inspector button, even a hidden one (proves it does nothing anymore). */
  clickInspector(key: string): {
    before: { pieces: number; undo: number };
    after: { pieces: number; undo: number };
    hidden: boolean;
  } | null;
  /**
   * Rename a PIECE OF FURNITURE through the REAL inline path (decision 0013: double-click on the
   * label, not the inspector). Drives the actual DOM field this creates (`.label-edit`) rather
   * than duplicating its logic, so the bound it enforces (`NAME_MAX`) is proven on the real code,
   * not on a copy of it. The element passed for positioning plays no part in the write.
   */
  renameFurnitureInline(id: unknown, texte: string): string | null;
  /** Same, for a CELL's name. */
  renameCellInline(id: unknown, texte: string): string | null;
}

export function sondePanneaux(ctx: Contexte): SondePanneaux {
  return {
    openInspector: () => openInspector(ctx),
    setInspectorDim(which: string, val: unknown) { setDim(ctx, which, val); return cur(ctx); },

    inspectorButtons(id?: unknown) {
      if (id != null) { ctx.selection.ids.clear(); ctx.selection.ids.add(String(id)); ctx.selection.primaire = String(id); }
      openInspector(ctx);
      const g = (k: string): EtatBouton | null => {
        const b = $(k) as HTMLButtonElement | null;
        return b ? { hidden: !!b.hidden, disabled: !!b.disabled } : null;
      };
      const insp = $("inspector");
      return {
        dup: g("iDup"), rot90: g("iRot90"), side: g("iSide"), del: g("iDel"),
        inspHidden: !insp || !!insp.hidden,
      };
    },
    clickInspector(key: string) {
      const b = $(key) as HTMLButtonElement | null; if (!b) return null;
      const lire = (): { pieces: number; undo: number } =>
        ({ pieces: ctx.etat.plan.pieces.length, undo: histInfo().undo });
      const before = lire();
      b.click();
      return { before, after: lire(), hidden: !!b.hidden };
    },

    renameFurnitureInline(id: unknown, texte: string) {
      renommerMeubleEnLigne(ctx, String(id), document.body);
      const inp = document.querySelector<HTMLInputElement>(".label-edit"); if (!inp) return null;
      inp.value = texte;
      inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      return pieceById(ctx, id)?.name ?? null;
    },
    renameCellInline(id: unknown, texte: string) {
      renommerCelluleEnLigne(ctx, String(id), document.body);
      const inp = document.querySelector<HTMLInputElement>(".label-edit"); if (!inp) return null;
      inp.value = texte;
      inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      const c = (ctx.etat.plan.cells || []).find((q) => String(q.id) === String(id));
      return c ? c.name : null;
    },
  };
}
