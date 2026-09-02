// src/ts/catalogue/catalogue.ts: the furniture catalogue (dimensions in cm, w = width, h = depth).
// Ported from src/js/01-catalogue.js, WITHOUT RENAMING A SINGLE LABEL (docs/reecriture.md §7.5).
//
// TWO COLUMNS THAT DON'T SAY THE SAME THING (R-4): `cat` says WHERE YOU LOOK for the object (the
// rail's section); `color` says WHAT IT IS (the tint it's painted). The color used to be
// carried by the GROUP, so moving an object from one section to another would REPAINT it in all
// the plans already saved. It's been moved down to the ITEM; a batch that reorganizes sections never
// touches `color`.
//
// SECTIONS ARE ROOMS BY USE, NOT FAMILIES OF OBJECTS (R-5), and go from the most placed
// to the least placed (counted on the household's plan, 77 objects: 39, then 13, 9, 9, 7).

export interface ItemCatalogue {
  type: string;
  name: string;
  /** width along the wall, cm */
  w: number;
  /** depth, cm */
  h: number;
  /** through opening (door / sliding door / window) */
  opening?: boolean;
  /** device screwed ONTO a face (wall light / socket / RJ45) */
  wallMount?: boolean;
  round?: boolean;
  soft?: boolean;
  /** LIES ON THE FLOOR: painted under the walls, because a wall rises from the floor it covers. */
  auSol?: boolean;
  /** removed from the palette, but existing plans still carry it */
  legacy?: boolean;
  color: string;
}

export interface RubriqueCatalogue {
  cat: string;
  items: ItemCatalogue[];
  color?: string;
}

export const CATALOG: RubriqueCatalogue[] = [
  {
    cat: "Openings & fixtures", items: [
      { type: "door", name: "Door", w: 80, h: 12, opening: true, color: "var(--open)" },
      { type: "sdoor", name: "Sliding door", w: 90, h: 12, opening: true, color: "var(--open)" },
      { type: "window", name: "Window", w: 120, h: 12, opening: true, color: "var(--open)" },
      { type: "radiateur", name: "Radiator", w: 80, h: 12, color: "var(--struct)" },
      { type: "plug", name: "Socket", w: 10, h: 6, wallMount: true, color: "var(--open)" },
      { type: "rj45", name: "RJ45", w: 10, h: 6, wallMount: true, color: "var(--open)" },
      { type: "sconce", name: "Wall light", w: 25, h: 12, wallMount: true, color: "var(--open)" },
      { type: "ceil", name: "Ceiling light", w: 30, h: 30, round: true, soft: true, color: "var(--open)" },
      { type: "gaine", name: "Service duct", w: 40, h: 40, color: "var(--struct)" },
      // The staircase is STRUCTURE, not furniture: it holds its floor spot and doesn't get pushed
      // around. It's here, with the duct and the radiator, for that reason and not because it
      // opens.
      { type: "stairs", name: "Staircase", w: 100, h: 250, color: "var(--struct)" },
    ],
  },
  {
    cat: "Living & dining", items: [
      { type: "sofa3", name: "3-seat sofa", w: 220, h: 95, color: "var(--seat)" },
      { type: "sofa2", name: "2-seat sofa", w: 150, h: 90, color: "var(--seat)" },
      { type: "arm", name: "Armchair", w: 85, h: 85, color: "var(--seat)" },
      { type: "ottoman", name: "Ottoman", w: 70, h: 55, color: "var(--seat)" },
      { type: "dining", name: "Dining table", w: 150, h: 90, color: "var(--table)" },
      { type: "chair", name: "Chair", w: 45, h: 50, color: "var(--table)" },
      { type: "coffee", name: "Coffee table", w: 110, h: 60, color: "var(--table)" },
      { type: "side", name: "Side table", w: 45, h: 45, color: "var(--table)" },
      { type: "biblio", name: "Bookcase", w: 120, h: 40, color: "var(--store)" },
      { type: "shelf", name: "Shelf", w: 90, h: 30, color: "var(--store)" },
      { type: "tv", name: "TV unit", w: 180, h: 45, color: "var(--store)" },
      { type: "sideb", name: "Sideboard", w: 160, h: 45, color: "var(--store)" },
      { type: "console", name: "Console table", w: 100, h: 35, color: "var(--table)" },
      { type: "stool", name: "Stool", w: 35, h: 35, round: true, color: "var(--seat)" },
      { type: "highchair", name: "High chair", w: 50, h: 55, color: "var(--seat)" },
      { type: "tvscreen", name: "TV", w: 120, h: 10, color: "var(--open)" },
      { type: "projector", name: "Projector", w: 35, h: 30, color: "var(--open)" },
      { type: "pscreen", name: "Projection screen", w: 200, h: 10, color: "var(--open)" },
      { type: "rug", name: "Rug", w: 200, h: 290, soft: true, auSol: true, color: "var(--decor)" },
      { type: "lamp", name: "Floor lamp", w: 40, h: 40, round: true, color: "var(--open)" },
      { type: "plant", name: "Plant", w: 50, h: 50, round: true, color: "var(--decor)" },
    ],
  },
  {
    cat: "Bedroom", items: [
      // TWO BEDS, AND ONLY TWO: single or double. `bed` KEEPS its type and its
      // geometry (160×210) because saved plans carry it; only its LABEL changes,
      // and the old one moves at the same time into `LEGACY_TYPE_NAMES` (R-3).
      { type: "bed1", name: "Single bed", w: 90, h: 200, color: "var(--decor)" },
      { type: "bed", name: "Double bed", w: 160, h: 210, color: "var(--decor)" },
      { type: "bedside", name: "Bedside table", w: 45, h: 40, color: "var(--store)" },
      { type: "dresser", name: "Chest of drawers", w: 100, h: 45, color: "var(--store)" },
      { type: "armoire", name: "Wardrobe", w: 120, h: 60, color: "var(--store)" },
      { type: "placard", name: "Closet", w: 100, h: 60, color: "var(--store)" },
      { type: "desk", name: "Desk", w: 130, h: 65, color: "var(--store)" },
      { type: "crib", name: "Cot", w: 70, h: 130, color: "var(--decor)" },
      { type: "langer", name: "Changing table", w: 85, h: 55, color: "var(--store)" },
    ],
  },
  {
    cat: "Bathroom", items: [
      { type: "lavabo", name: "Washbasin", w: 60, h: 45, color: "var(--bath)" },
      { type: "wc", name: "Toilet", w: 40, h: 60, color: "var(--bath)" },
      { type: "shower", name: "Shower", w: 90, h: 90, color: "var(--bath)" },
      { type: "bath", name: "Bathtub", w: 170, h: 75, color: "var(--bath)" },
      { type: "washer", name: "Washing machine", w: 60, h: 60, color: "var(--bath)" },
      // The dryer STACKS on the washer: same floor footprint, set on top. Nothing
      // in the model forbids two objects at the same spot, so stacking requires no
      // exception; what it requires is that the SAME footprint be possible without the placement
      // helper pushing them apart (see `EMPILABLES`).
      { type: "dryer", name: "Tumble dryer", w: 60, h: 60, color: "var(--bath)" },
    ],
  },
  {
    cat: "Kitchen", items: [
      { type: "counter", name: "Worktop", w: 120, h: 65, color: "var(--kitchen)" },
      { type: "sink", name: "Sink", w: 60, h: 65, color: "var(--kitchen)" },
      { type: "hob", name: "Hob", w: 60, h: 52, color: "var(--kitchen)" },
      { type: "fridge", name: "Fridge", w: 60, h: 65, color: "var(--kitchen)" },
      { type: "oven", name: "Oven", w: 60, h: 65, color: "var(--kitchen)" },
      { type: "microwave", name: "Microwave", w: 50, h: 38, color: "var(--kitchen)" },
      { type: "dw", name: "Dishwasher", w: 60, h: 65, color: "var(--kitchen)" },
      { type: "island", name: "Kitchen island", w: 180, h: 90, color: "var(--kitchen)" },
    ],
  },
];

// ---- THE SECOND TAXONOMY: BY OBJECT KIND (R-4bis) -------------------------------------------------
// `cat` says WHERE YOU LOOK for the object: a room by use (Bedroom, Kitchen...). That's the right
// classification when furnishing a room. It is NOT one when you're looking for "all the storage" or
// "all the light fixtures", because they're scattered across five sections.
//
// WHY A TABLE AND NOT A FIELD ON EACH ENTRY: kind is INFORMATION ABOUT THE TYPE,
// not about the catalogue row. Placing it next to the catalogue keeps it readable at a glance (you
// see the families AND what they contain), whereas a field repeated 54 times reads line by
// line. The price is that a type added to the catalogue can be forgotten here: `tests/rapide.ts`
// therefore requires that EVERY type in the catalogue have a kind, and fails if a batch forgets one.
//
// COLOR COULD NOT SERVE, and that was the temptation: it already says "what it is" (R-4).
// But `var(--bath)` and `var(--kitchen)` are ROOM colors, not kind colors: they file
// the washer with the bathtub and the oven with the sink. Deriving kind from color would
// therefore have reproduced the by-room classification under another name.
export const KIND_ORDER: readonly string[] = [
  "Seating", "Tables", "Beds", "Storage", "Kitchen units", "Appliances",
  "Bathroom", "Audio & video", "Lighting", "Power & data", "Openings", "Structure", "Soft & decor",
];

export const KIND_BY_TYPE: Record<string, string> = {
  sofa3: "Seating", sofa2: "Seating", arm: "Seating", ottoman: "Seating", chair: "Seating",
  stool: "Seating", highchair: "Seating",
  dining: "Tables", coffee: "Tables", side: "Tables", console: "Tables",
  bed: "Beds", bed1: "Beds", crib: "Beds",
  biblio: "Storage", shelf: "Storage", tv: "Storage", sideb: "Storage", armoire: "Storage",
  placard: "Storage", desk: "Storage", langer: "Storage", bedside: "Storage", dresser: "Storage",
  counter: "Kitchen units", sink: "Kitchen units", island: "Kitchen units",
  fridge: "Appliances", oven: "Appliances", hob: "Appliances", dw: "Appliances",
  microwave: "Appliances", washer: "Appliances", dryer: "Appliances",
  lavabo: "Bathroom", wc: "Bathroom", shower: "Bathroom", bath: "Bathroom",
  tvscreen: "Audio & video", projector: "Audio & video", pscreen: "Audio & video",
  lamp: "Lighting", ceil: "Lighting", sconce: "Lighting",
  plug: "Power & data", rj45: "Power & data",
  door: "Openings", sdoor: "Openings", window: "Openings",
  gaine: "Structure", radiateur: "Structure", stairs: "Structure",
  rug: "Soft & decor", plant: "Soft & decor",
};

/** A type's kind, or "Other" for a type coming from an old plan or an import. */
export function kindOf(type: string): string {
  return KIND_BY_TYPE[type] || "Other";
}

/**
 * The catalogue GROUPED by kind, in `KIND_ORDER` order. Returns the SAME shape as `CATALOG`
 * so the palette has only one construction path: it's the SOURCE that changes, not the
 * rendering (otherwise two layouts would diverge at the first fix, like the three placement
 * previews that `makePlacePreview` replaced).
 */
export function catalogueParNature(): RubriqueCatalogue[] {
  const par = new Map<string, ItemCatalogue[]>();
  for (const g of CATALOG) {
    for (const it of g.items) {
      const k = kindOf(it.type);
      const l = par.get(k);
      if (l) l.push(it); else par.set(k, [it]);
    }
  }
  const out: RubriqueCatalogue[] = [];
  for (const k of KIND_ORDER) {
    const items = par.get(k);
    if (items && items.length) out.push({ cat: k, items });
  }
  // "Other" brings up the rear if it exists: never silently lost.
  const autres = par.get("Other");
  if (autres && autres.length) out.push({ cat: "Other", items: autres });
  return out;
}

/**
 * Pairs of objects where one sits ON the other: same floor footprint, intentional stacking. Used
 * only by the placement helper, which would otherwise treat them as an overlap to fix.
 * The relation is SYMMETRIC and reads both ways (`empilables("washer","dryer")`).
 */
const EMPILABLES: ReadonlyArray<readonly [string, string]> = [
  ["washer", "dryer"],
];

export function empilables(a: string, b: string): boolean {
  return EMPILABLES.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

/**
 * A radiator is LOW; a window, a wall light, a socket, an RJ45 sit on the wall ABOVE it: none of
 * them occupies the radiator's floor spot, or vice versa, so "two objects in the same place"
 * (circulation/regles.ts) must never fire for that pair, in EITHER order, exactly like `empilables`.
 *
 * A DOOR IS NOT ONE OF THEM, on purpose: `isWallMount` says a door and a window are the same kind
 * of thing (both `opening`), but a door has a floor-level swing and a passage you actually walk
 * through, a window doesn't. You don't pass OVER a radiator to walk through a doorway, so a door
 * (or a sliding door) in front of a radiator stays a real obstacle for this predicate; it is
 * already caught anyway by the door-swing rule (Rule 2), which is untouched by this predicate.
 */
export function passeAuDessus(a: string, b: string): boolean {
  const paire = (x: string, y: string): boolean =>
    x === "radiateur" && isWallMount(y) && y !== "door" && y !== "sdoor";
  return paire(a, b) || paire(b, a);
}

/**
 * `type` -> item. The construction is the SAME as in the old client (`it.color || g.color`):
 * `tests/rapide.ts` used to redo it identically on its own side, it's now done HERE, once,
 * and imported by the tests.
 *
 * The return type is `ItemCatalogue | undefined` (`noUncheckedIndexedAccess`): a `type` coming
 * from an old plan or a JSON import is NOT necessarily in the catalogue, and all the code reading it
 * must plan for that. It was true before too, but nothing enforced it.
 */
export const TYPEMAP: Record<string, ItemCatalogue> = {};
for (const g of CATALOG) {
  for (const it of g.items) {
    TYPEMAP[it.type] = { ...it, color: it.color || g.color || "" };
  }
}

// ---- THE CATALOGUE'S PREVIOUS LABELS (R-3) --------------------------------------------------------
// A piece of furniture is born with its type's label and KEEPS it for its whole life: renaming an
// entry leaves behind furniture carrying the OLD label. Without this table, `isChosenName` takes
// them for TYPED names and writes them onto the plan: measured, four "Chair" around a
// table that itself carries a fifth, "Table".
// TWO WAVES, AND THEY STACK: the original English labels (recorded from the PLANS, never
// invented), then the French labels removed on 2026-08-05.
export const LEGACY_TYPE_NAMES: Record<string, string[]> = {
  sofa3: ["Canapé 3 places"],
  sofa2: ["Canapé 2 places"],
  arm: ["Fauteuil"],
  ottoman: ["Pouf"],
  coffee: ["Coffee table", "Table basse"],
  dining: ["Table", "Table à manger"],
  side: ["Bout de canapé"],
  chair: ["Chair", "Chaise"],
  tv: ["Meuble TV"],
  shelf: ["Étagère"],
  biblio: ["Bibliothèque"],
  sideb: ["Buffet"],
  desk: ["Bureau"],
  armoire: ["Armoire"],
  placard: ["Placard"],
  langer: ["Table à langer"],
  counter: ["Plan de travail"],
  sink: ["Évier"],
  hob: ["Plaque de cuisson"],
  fridge: ["Réfrigérateur"],
  oven: ["Four (colonne)"],
  dw: ["Lave-vaisselle"],
  island: ["Îlot central"],
  wc: ["Toilettes"],
  bath: ["Baignoire"],
  shower: ["Douche"],
  lavabo: ["Lavabo"],
  washer: ["Machine à laver"],
  sconce: ["Applique"],
  lamp: ["Lampadaire"],
  ceil: ["Plafonnier"],
  gaine: ["Gaine technique"],
  radiateur: ["Radiateur"],
  rug: ["Tapis"],
  plant: ["Plante"],
  // THIRD WAVE (2026-08-06): "Bed (160)" was renamed to "Double bed" the day the single
  // bed appeared next to it. Without this entry, any bed already placed would carry a name taken
  // for a TYPED name and would get written onto the plan.
  bed: ["Lit (160)", "Bed (160)"],
  door: ["Door", "Porte"],
  sdoor: ["Porte coulissante"],
  window: ["Window", "Fenêtre"],
  plug: ["Prise"],
};

/** Strips a trailing "N" from a name to recover its stem (js/07). */
export function baseName(name: unknown): string {
  return String(name || "").replace(/\s+\d+$/, "").trim() || String(name || "");
}

/** Is this object an OPENING (door / sliding door / window)? */
function isOpeningType(type: string): boolean {
  return !!TYPEMAP[type]?.opening;
}

/** Is this object attached to the wall (opening OR surface-mounted device)? Drives the magnet and rotation. */
/** Does this type LIE ON THE FLOOR (a rug)? Such a piece is painted under the walls. */
export function estAuSol(type: string): boolean {
  const t = TYPEMAP[type];
  return !!(t && t.auSol);
}

export function isWallMount(type: string): boolean {
  const t = TYPEMAP[type];
  return !!(t && (t.opening || t.wallMount));
}

/**
 * NON-opening wall-mounted objects: their only face parameter is which side of the wall, so
 * "Switch side" is reserved for them. Doors and windows keep hinge / direction.
 */
export function isSideable(type: string): boolean {
  return type === "sconce" || type === "plug" || type === "rj45";
}

/**
 * Wall-overlap family. Only two objects of the SAME family constrain each other on a wall.
 * `rj45` shares the sockets' family: side by side with no overlap (same housing).
 */
export function fam(type: string): "sconce" | "plug" | "opening" {
  if (type === "sconce") return "sconce";
  if (type === "plug" || type === "rj45") return "plug";
  return "opening";
}

export type Calque = "opening" | "light" | "plug" | "furn";

/** An object's layer for the visibility toggles. Openings are structure. */
export function layerOf(type: string): Calque {
  if (isOpeningType(type)) return "opening"; // always visible
  if (type === "sconce" || type === "lamp" || type === "ceil") return "light";
  if (type === "plug" || type === "rj45") return "plug";
  return "furn";
}

/** The three layer toggles, which live in the PERSONAL SETTINGS (D-7). */
export interface CalquesVisibles {
  layFurn?: boolean | undefined;
  layLight?: boolean | undefined;
  layPlug?: boolean | undefined;
}

/**
 * Is this object visible? The layers are a PERSONAL setting: they're passed as an argument
 * rather than read from a global `state`, which makes it impossible to have them travel by mistake.
 */
export function pieceVisible(p: { type: string }, calques: CalquesVisibles): boolean {
  const L = layerOf(p.type);
  if (L === "opening") return true;
  if (L === "light") return calques.layLight !== false;
  if (L === "plug") return calques.layPlug !== false;
  return calques.layFurn !== false;
}
