// src/ts/sonde-config.ts: THE PROBE SLICE FOR THE "config" SUB-BATCH (E3c).
// One probe file PER BATCH: `js/57-sondes-test.js` was "the repo's most likely git conflict
// point", and two keys were genuinely duplicated in it.
//
// TRAP PAID FOR BY THE PREVIOUS BATCH: `Object.assign` COPIES an accessor's VALUE. Anything
// that must stay LIVE is written as `get x()` here, and `sonde.ts` carries the DESCRIPTORS.
//
// WHAT THE OLD HOOK EXPOSED FROM THIS BATCH: NOTHING. Verified, `src/js/57-sondes-test.js`
// carries no "setup" or "menu" entry: the 23 suites drive the assistant and the "File" menu
// through the real DOM (`#setupStart`, `#suW`, `#btnMenu`), with a real mouse, which is the
// right level. So this file adds NO test dependency: it gives the same typed view to a future
// suite that would want to set a state without going through thirty milliseconds of typing.

import type { Contexte } from "./app/contexte.ts";
import { SETUP_BORNES, assistant } from "./panneaux/configuration.ts";
import { menuPied } from "./panneaux/menu-pied.ts";

export interface SondeConfig {
  /** Is the assistant on screen? LIVE: accessor, never a snapshot. */
  readonly setupOuvert: boolean;
  /** Is the "File" menu unfolded? LIVE. */
  readonly menuOuvert: boolean;
  /** The bounds ANNOUNCED by the form (G-18): 100..3000 cm. */
  readonly setupBornes: { min: number; max: number };
  openSetup(): void;
  closeSetup(): void;
  /** Pick a shape card without going through a click (the draft follows, so does the preview). */
  setupPickShape(s: "rect" | "l"): void;
  setMenuOpen(on: boolean): void;
}

export function sondeConfig(_ctx: Contexte): SondeConfig {
  return {
    get setupOuvert() { return !!assistant.estOuvert?.(); },
    get menuOuvert() { return !!menuPied.estOuvert?.(); },
    get setupBornes() { return { min: SETUP_BORNES.min, max: SETUP_BORNES.max }; },
    openSetup: () => { assistant.ouvrir?.(); },
    closeSetup: () => { assistant.fermer?.(); },
    setupPickShape: (s: "rect" | "l") => { assistant.pickShape?.(s); },
    setMenuOpen: (on: boolean) => { menuPied.ouvrir?.(!!on); },
  };
}
