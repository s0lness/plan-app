// src/ts/noyau.ts: THE PURE CORE'S ENTRY POINT (E2).
//
// Everything this module re-exports is WITHOUT DOM, WITHOUT global `state`, WITHOUT storage:
// geometry, old-format reading, serialization, emission diffing, undo replay, and the
// catalogue. This is exactly what `tests/rapide.ts` and `tests/harnais-graine.ts` used to CARVE
// out of the source by counting braces; both TypeScript benches import it instead of carving it.
//
// This file is NOT `main.ts`: the core does not yet have a taker in the application (E3 will
// wire it up), so `index-next.html` does not change by one byte at this batch. `tsc --noEmit`
// still typechecks the whole thing: `tsconfig.json` includes `src/ts/**/*.ts`, not `main.ts`'s
// import graph.

export * from "./partage/contrat-serveur.ts";
export * from "./partage/plan.ts";
export * from "./noyau/nombres.ts";
export * from "./catalogue/catalogue.ts";
export * from "./geometrie/polygones.ts";
export * from "./modele/aires.ts";
export * from "./modele/conversion.ts";
export * from "./modele/murs.ts";
export * from "./modele/cellules.ts";
export * from "./modele/migrations.ts";
export * from "./fil/pseudo-fil.ts";
export * from "./fil/miroir.ts";
export * from "./historique/rejeu.ts";
export * from "./rendu/noms.ts";
export * from "./rendu/arc-porte.ts";
export * from "./rendu/etiquettes-disposition.ts";
