// src/ts/modele/aimant-memoire.ts: THE ROTATION A PIECE HAD BEFORE THE WALL MAGNET LAST TURNED IT.
//
// Owner's request, word for word: "si je le fais 'stick' à un mur par inadvertance qu'il puisse
// reprendre son orientation originale si je le détache du mur". `meubleWallSnap` (modele/espace.ts,
// decision 0011) overwrites `rot` with the wall's angle; nothing used to remember what it replaced.
//
// SESSION MEMORY ONLY: a module-level `Map<id, rot>`, never read from or written to the plan, never
// sent over the wire (nothing to declare in C-5), lost on reload. That loss is deliberate, not a
// gap: switching plans already reloads the page (`panneaux/plans.ts`), which clears this module's
// state along with everything else, so a plan change never needs its own cleanup call here.
const avantAimant = new Map<string, number>();

/** Forgets `id`: the person turned the piece herself (rotation handle, "Rotate 90°"), or deleted
 *  it. Idempotent, safe to call on an id that never had an entry (an opening, say). */
export function oublierAvantAimant(id: string): void {
  avantAimant.delete(id);
}

/**
 * PURE DECISION, one call per tick of a drag: given the rotation the piece had at `pointerdown`
 * (`rotDepart`), and the wall magnet's verdict THIS INSTANT (`aimant`: its rotation, or `null` when
 * the back is out of reach), returns the rotation to apply, and remembers what to come back to.
 *
 * - Snapped now (`aimant` given): apply it. The first time this id gets snapped since the last
 *   manual rotation or deletion, `rotDepart` is what we remember, so a SECOND snap in the same
 *   drag (or a later one) does not overwrite an already-held original with the wall's own angle.
 * - Not snapped now, and something is held for `id`: the back left the wall, so come back to the
 *   held rotation. It stays held (not consumed): pulling a piece to mid-room and letting go, then
 *   dragging it again later, must still come back to the SAME original, not to wherever the last
 *   gesture happened to start.
 * - Not snapped, nothing held: `rotDepart` unchanged, there is nothing to remember or restore.
 */
export function rotationAimantee(id: string, rotDepart: number, aimant: number | null): number {
  if (aimant != null) {
    if (!avantAimant.has(id)) avantAimant.set(id, rotDepart);
    return aimant;
  }
  const gardee = avantAimant.get(id);
  return gardee === undefined ? rotDepart : gardee;
}
