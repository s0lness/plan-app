// src/ts/modele/aimant-memoire.ts: THE ROTATION A PIECE HAD BEFORE THE WALL MAGNET LAST TURNED IT
// (`meubleWallSnap`, modele/espace.ts, decision 0011, overwrites `rot`).
//
// SESSION MEMORY ONLY: a module-level `Map<id, rot>`, never read from or written to the plan,
// never sent over the wire (C-5), lost on reload deliberately (a plan switch already reloads the
// page, clearing this module's state with everything else).
const avantAimant = new Map<string, number>();

/** Forgets `id`: the person turned the piece herself (rotation handle, "Rotate 90°"), or deleted
 *  it. Idempotent, safe to call on an id that never had an entry (an opening, say). */
export function oublierAvantAimant(id: string): void {
  avantAimant.delete(id);
}

/**
 * PURE DECISION, one call per tick of a drag: given the rotation at `pointerdown` (`rotDepart`)
 * and the wall magnet's verdict this instant (`aimant`, or `null` when out of reach), returns the
 * rotation to apply and remembers what to come back to. Snapped: apply it, remembering
 * `rotDepart` only the first time. Not snapped with something held: return to the held rotation
 * (stays held, not consumed). Not snapped, nothing held: unchanged.
 */
export function rotationAimantee(id: string, rotDepart: number, aimant: number | null): number {
  if (aimant != null) {
    if (!avantAimant.has(id)) avantAimant.set(id, rotDepart);
    return aimant;
  }
  const gardee = avantAimant.get(id);
  return gardee === undefined ? rotDepart : gardee;
}
