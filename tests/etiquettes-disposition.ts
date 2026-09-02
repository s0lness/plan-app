#!/usr/bin/env node
// =============================================================================
//  ROOM LABEL PLACEMENT: NO BROWSER (the layout math is PURE)
// =============================================================================
// Reproduces, WITHOUT a browser, the defect measured on the owner's real 103 m2 apartment: room
// labels and furniture labels used to be laid out INDEPENDENTLY, so a furniture name could sit
// right under a room's name, and two room labels never knew about each other. Ten room labels,
// zero collision awareness between the two families.
//
//   node tests/etiquettes-disposition.ts
//
//   une_seule_cellule_prend_son_ancre           nothing to avoid: stays at the pole
//   un_meuble_sous_le_pole_fait_ceder            the label steps away from a furniture obstacle
//   deux_cellules_ne_s_empilent_pas              two room labels never share the same box
//   la_plus_grande_cellule_choisit_en_premier    priority is AREA, not array order, not id
//   aucune_place_ne_reste_silence_jamais_recouvrement  a truly full room DROPS rather than overlaps
//   jamais_hors_de_sa_propre_cellule             a nudge never crosses into a neighbor's polygon
//   determinisme_meme_resultat_deux_fois         same input, byte-identical output, twice
//   la_largeur_suit_le_texte                     a longer name gets a wider box
import {
  disposerEtiquettesCellules, largeurEtiquetteCellule, seChevauchent, HAUTEUR_ETIQUETTE_CELLULE,
  type CandidatEtiquetteCellule, type RectPx,
} from "../src/ts/rendu/etiquettes-disposition.ts";

let ok = 0, ko = 0;
const rates: string[] = [];
function test(nom: string, fn: (a: (c: unknown, m: string) => void) => void) {
  const fails: string[] = [];
  try { fn((c: unknown, m: string) => { if (!c) fails.push(m); }); } catch (e) { fails.push("EXCEPTION: " + ((e as Error)?.stack || String(e))); }
  if (fails.length) { ko++; rates.push(nom); } else ok++;
  console.log(`  ${fails.length ? "FAIL " : "ok   "} ${nom}`);
  fails.forEach((f) => console.log("        - " + f));
}

const C = (o: Partial<CandidatEtiquetteCellule> & { id: string }): CandidatEtiquetteCellule =>
  Object.assign({ ax: 0, ay: 0, texte: "Pièce", aire: 100 }, o);

// ---------------------------------------------------------------------------------------------
test("une_seule_cellule_prend_son_ancre", (a) => {
  const res = disposerEtiquettesCellules([C({ id: "a", ax: 200, ay: 150 })], []);
  const p = res.get("a");
  a(!!p, "la seule cellule doit être placée");
  a(p!.x === 200 && p!.y === 150, `sans obstacle, l'ancre elle-même convient, vu ${JSON.stringify(p)}`);
});

test("un_meuble_sous_le_pole_fait_ceder", (a) => {
  // A furniture obstacle sits exactly on the natural anchor: the room label must move away
  // from it, not paint over it.
  const obstacle: RectPx = { x: 180, y: 130, w: 40, h: 40 };
  const res = disposerEtiquettesCellules([C({ id: "a", ax: 200, ay: 150, texte: "Cuisine" })], [obstacle]);
  const p = res.get("a");
  a(!!p, "un obstacle localisé laisse de la place ailleurs dans la cellule");
  const w = largeurEtiquetteCellule("Cuisine");
  const rect: RectPx = { x: p!.x - w / 2, y: p!.y - HAUTEUR_ETIQUETTE_CELLULE / 2, w, h: HAUTEUR_ETIQUETTE_CELLULE };
  a(!seChevauchent(rect, obstacle), "la boîte retenue ne doit plus chevaucher l'obstacle");
});

test("deux_cellules_ne_s_empilent_pas", (a) => {
  // Same anchor for two different rooms (degenerate on purpose): the second must yield to the
  // first rather than being painted on top of it.
  const res = disposerEtiquettesCellules([
    C({ id: "grande", ax: 300, ay: 300, texte: "Salon", aire: 999 }),
    C({ id: "petite", ax: 300, ay: 300, texte: "SDB", aire: 1 }),
  ], []);
  const pa = res.get("grande")!, pb = res.get("petite");
  a(!!pa, "la plus grande cellule doit être placée");
  a(!!pb, "assez de champ libre autour de l'ancre pour que la seconde trouve aussi une place");
  if (pa && pb) {
    const wa = largeurEtiquetteCellule("Salon"), wb = largeurEtiquetteCellule("SDB");
    const ra: RectPx = { x: pa.x - wa / 2, y: pa.y - HAUTEUR_ETIQUETTE_CELLULE / 2, w: wa, h: HAUTEUR_ETIQUETTE_CELLULE };
    const rb: RectPx = { x: pb.x - wb / 2, y: pb.y - HAUTEUR_ETIQUETTE_CELLULE / 2, w: wb, h: HAUTEUR_ETIQUETTE_CELLULE };
    a(!seChevauchent(ra, rb), `deux étiquettes de cellule ne doivent jamais se chevaucher, vu ${JSON.stringify({ ra, rb })}`);
  }
});

test("la_plus_grande_cellule_choisit_en_premier", (a) => {
  // Same anchor, same conflict either way: the LARGER cell (by `aire`) must win the anchor spot,
  // regardless of array order or id ordering.
  const grande = C({ id: "z-grande", ax: 100, ay: 100, texte: "X", aire: 500 });
  const petite = C({ id: "a-petite", ax: 100, ay: 100, texte: "X", aire: 1 });
  const res = disposerEtiquettesCellules([petite, grande], []); // petite listed FIRST in the array
  const pg = res.get("z-grande");
  a(!!pg && pg.x === 100 && pg.y === 100, `la plus grande garde son ancre malgré l'ordre du tableau, vu ${JSON.stringify(pg)}`);
});

test("aucune_place_ne_reste_silence_jamais_recouvrement", (a) => {
  // A genuinely tiny room, walled in by furniture on every side WITHIN ITS OWN POLYGON (the real
  // caller, `rendu/calque.ts`, always passes `dansCellule`; a real 1.5 m2 room reproduces this
  // exactly): the label must be DROPPED (null), never forced onto one of them, and it must never
  // escape into free space that belongs to a neighboring room.
  const grille: RectPx[] = [];
  for (let dx = -3; dx <= 3; dx++) {
    for (let dy = -3; dy <= 3; dy++) {
      grille.push({ x: 500 + dx * 30 - 15, y: 500 + dy * 30 - 15, w: 30, h: 30 });
    }
  }
  const res = disposerEtiquettesCellules([
    C({ id: "coincee", ax: 500, ay: 500, texte: "Débarras", dansCellule: (x, y) => Math.abs(x - 500) < 105 && Math.abs(y - 500) < 105 }),
  ], grille);
  a(res.get("coincee") === null, `une cellule totalement encerclée doit céder son étiquette (silence), vu ${JSON.stringify(res.get("coincee"))}`);
});

test("jamais_hors_de_sa_propre_cellule", (a) => {
  // `dansCellule` confines the search to x < 250: even with the anchor blocked and open space
  // on the OTHER side of that line, the label must never be placed past it (that space belongs
  // to a neighboring room).
  const obstacle: RectPx = { x: 180, y: 130, w: 40, h: 40 };
  const res = disposerEtiquettesCellules([
    C({ id: "a", ax: 200, ay: 150, texte: "Petite pièce", dansCellule: (x) => x < 250 }),
  ], [obstacle]);
  const p = res.get("a");
  if (p) a(p.x < 250, `un déplacement ne doit jamais quitter le polygone de sa cellule, vu x=${p.x}`);
  // Either a spot within bounds was found, or the label yielded (both acceptable), what must
  // NEVER happen is a spot at x >= 250, checked above.
});

test("determinisme_meme_resultat_deux_fois", (a) => {
  const candidats: CandidatEtiquetteCellule[] = [
    C({ id: "cuisine", ax: 300, ay: 400, texte: "Cuisine", aire: 2030 }),
    C({ id: "salon", ax: 700, ay: 300, texte: "Salon", aire: 3030 }),
    C({ id: "p2", ax: 320, ay: 410, texte: "Pièce 2", aire: 350 }),
    C({ id: "p3", ax: 305, ay: 405, texte: "Pièce 3", aire: 150 }),
  ];
  const obstacles: RectPx[] = [{ x: 280, y: 390, w: 60, h: 30 }, { x: 690, y: 290, w: 50, h: 25 }];
  const r1 = disposerEtiquettesCellules(candidats, obstacles);
  const r2 = disposerEtiquettesCellules(candidats.slice(), obstacles.slice());
  a(JSON.stringify([...r1]) === JSON.stringify([...r2]), "même entrée, même sortie, à chaque appel");
});

test("la_largeur_suit_le_texte", (a) => {
  a(largeurEtiquetteCellule("Salon") < largeurEtiquetteCellule("Chambre invitée"),
    "un nom plus long réclame une boîte plus large");
  a(largeurEtiquetteCellule("") >= 20, "même un nom vide garde une largeur minimale");
});

// ---------------------------------------------------------------------------------------------
console.log(`\n${ko ? `FAILURES ${ko}/${ok + ko}` : `OK ${ok}/${ok}`}`);
rates.forEach((n) => console.log("  FAIL " + n));
process.exit(ko ? 1 : 0);
