// src/ts/catalogue/catalogue.ts: the furniture catalogue (dimensions in cm, w = width, h = depth).
// `cat` says WHERE YOU LOOK for the object, `color` says WHAT IT IS (R-4); color lives on the
// item, not the group, so reorganizing sections never repaints saved plans. Sections are rooms
// by use, ordered by how often each is placed (R-5).

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
      { type: "toybox", name: "Toy chest", w: 80, h: 40, color: "var(--store)" },
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
// `cat` says WHERE YOU LOOK (a room by use); `kind` groups "all the storage" or "all the light
// fixtures" across sections. Kept as a table (not a field per entry) so both classifications stay
// readable side by side; `tests/rapide.ts` requires every catalogue type to have a kind. Color
// can't serve for this: `var(--bath)`/`var(--kitchen)` are room colors, not kind colors.
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
  toybox: "Storage",
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
 * A radiator is LOW; wall-mounted fixtures above it (window, wall light, socket, RJ45) don't
 * share its floor spot, so the overlap check (circulation/regles.ts) must never fire for that
 * pair, like `empilables`. A door is excluded on purpose: its floor-level swing is a real
 * obstacle, already caught by the door-swing rule.
 */
export function passeAuDessus(a: string, b: string): boolean {
  const paire = (x: string, y: string): boolean =>
    x === "radiateur" && isWallMount(y) && y !== "door" && y !== "sdoor";
  return paire(a, b) || paire(b, a);
}

/**
 * `type` -> item. Returns `ItemCatalogue | undefined` (`noUncheckedIndexedAccess`): a `type`
 * coming from an old plan or a JSON import may not be in the catalogue, and callers must plan
 * for that.
 */
export const TYPEMAP: Record<string, ItemCatalogue> = {};
for (const g of CATALOG) {
  for (const it of g.items) {
    TYPEMAP[it.type] = { ...it, color: it.color || g.color || "" };
  }
}

// ---- THE CATALOGUE'S PREVIOUS LABELS (R-3) --------------------------------------------------------
// A piece keeps its type's label at creation for life; renaming a catalogue entry must add the
// old label here, or `isChosenName` mistakes it for a typed name and writes it onto the plan.
// Two waves: original English labels (from real plans), then French labels since removed.
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
  bed: ["Lit (160)", "Bed (160)"], // renamed "Bed (160)" -> "Double bed" (R-3)
  door: ["Door", "Porte"],
  sdoor: ["Porte coulissante"],
  window: ["Window", "Fenêtre"],
  plug: ["Prise"],
};

/** Strips a trailing "N" from a name to recover its stem. */
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
