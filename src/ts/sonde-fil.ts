// src/ts/sonde-fil.ts — THE PROBE SLICE FOR THE SYNC BATCH (E4).
// Replaces, for this batch alone, the corresponding entries of src/js/57-sondes-test.js.
//
// WHY ONE FILE PER BATCH: `js/57` was "the repo's most likely git conflict point", and
// `esbuild` measured TWO GENUINELY DUPLICATE KEYS in it (`wallsMode`, `pieceTol`), the last of
// which silently won. A typed object per batch closes both problems.
//
// EVERY ACCESSOR IN THIS FILE IS A `get`, AND THIS IS MANDATORY. `installerSonde` carries the
// slices via `Object.defineProperties(…, getOwnPropertyDescriptors(…))` and not via
// `Object.assign`: the latter COPIES an accessor's VALUE instead of carrying the accessor itself,
// so `wsFp`, `serverRev`, `acksOn`, `retransmits`, and `syncDetached` would have become SNAPSHOTS
// taken at install time, and every suite would have read the same value for its whole life.
//
// THREE TEST RIGS, AND THEY DO NOT HAVE THE SAME NEEDS:
//   A. `collab-annuler`, `model-v5-fil-serveur`: `file://`, no WebSocket at all. The wire is
//      simulated: `wsFeed` as input, `outLog`/`opLog` as output, `wsForceOpen` to open it.
//   B. `collab-accuses`: the REAL `PlanRoom` runs INSIDE the page and frames are pumped by
//      hand. `outLog(true)` must return a LIVE array: the bench reads the new entries on every
//      pump cycle. This is the hardest constraint in this file.
//   C. `plan-abime`, `repli-d1-live`, `repli-conflit`: real browsers, a real Pages Function,
//      real SQLite, and `/ws` never served (the realtime server is dead BY OMISSION). These
//      suites ask almost nothing of this file: they read the real DOM (`#syncChip`,
//      `#bootNotice`, `#conflitDl`) and `localStorage`.

import type { Contexte } from "./app/contexte.ts";
import type { Fil } from "./fil/etat.ts";
import type { Cellule, EtatFil, Op, OuvertureFil, PlanV5, Pt } from "./partage/plan.ts";
import type { Options } from "./modele/migrations.ts";
import type { ResultatRestauration } from "./modele/restauration.ts";
import { $ } from "./noyau/dom.ts";
import { OPTS_KEY } from "./noyau/nombres.ts";
import { estSolConnu } from "./partage/contrat-serveur.ts";
import { v5CellById, v5OpeningById, v5Touch, pieceById } from "./app/contexte.ts";
import { save, serialize } from "./app/persistance.ts";
import { render } from "./rendu/rendu.ts";
import { histApplyOp } from "./historique/rejeu.ts";
import { v5DerivedId } from "./fil/identite.ts";
import { v5OpeningWire } from "./fil/pseudo-fil.ts";
import { ws5DiffOps } from "./fil/miroir.ts";
import { v5NoteForeignOrphans } from "./modele/edition.ts";
import { v5RebuildCells } from "./modele/cellules.ts";
import { bornerLesMeubles, v5TryCreateWall } from "./gestes/murs.ts";
import { v5RestoreBackup } from "./modele/restauration.ts";
import {
  WS_ACK_RTO, etatFilCourant, wsAckTick, wsOnSave, wsShadowFromServer, wsShadowSync,
} from "./fil/emission.ts";
import { wsApplyGhostsToDOM, wsApplyRemoteOp, wsRevertRefused } from "./fil/reception.ts";
import { wsOnDown, wsOnMessage } from "./fil/presence.ts";
import { puceTexte, serverHasPlan } from "./fil/rest.ts";

type FamilleMiroir = "walls" | "openings" | "pieces" | "cells";

export interface VidageMiroir {
  outline: string | null;
  walls: string[];
  openings: string[];
  pieces: string[];
  cells: string[];
}

export interface SondeFil {
  // ---- the wire: open, feed, log --------------------------------------------------
  wire(): EtatFil;
  wsFeed(msg: unknown): true;
  wsForceOpen(on: boolean): boolean;
  opLog(on: boolean): Op[];
  outLog(on: boolean): unknown[];
  readonly wsFp: string | null;
  readonly serverRev: number;
  readonly syncDetached: boolean;
  readonly chipText: string | null;
  forceDiff(): void;
  applyRemote(op: Op): void;
  serverHasPlan(d: unknown): boolean;

  // ---- the two mirrors -------------------------------------------------------------------------
  shadowSync(): void;
  shadowDump(): VidageMiroir;
  shadowOf(fam: FamilleMiroir, id: unknown): string | null;
  shadowFromServer(st: unknown): VidageMiroir;
  shadowAckDump(): VidageMiroir;
  shadowAckOf(fam: FamilleMiroir, id: unknown): string | null;
  diffContreAcquitte(): string[];

  // ---- acknowledgements and retransmission -------------------------------------------------------
  readonly acksOn: boolean;
  readonly retransmits: number;
  unackedOps(): { n: number; kind: string | undefined; age: number }[];
  ageUnacked(ms?: number | null): number;
  ackTickNow(): { unacked: number; retransmis: number };
  pendingOps(): { n: number; kind: string | undefined; undo: string[] }[];
  revertRefused(n: number): boolean;
  wsSimulerChute(): { unacked: number; aRejouer: boolean };

  // ---- identity, presence, ghosts -------------------------------------------------------------
  newDerivedId(prefix: string): string;
  wsMeInfo(): { email: string | null; tag: string | null; name: string | null; guest: boolean; guestId: string | null };
  wsPeerKeys(): string[];
  peerDots(): { txt: string | null; title: string; self: boolean; bg: string }[];
  peerCursors(): { label: string | null; hidden: boolean; transform: string }[];
  ghostIds(): string[];
  ghostPose(pieceId: unknown): { left: string; top: string; ghost: boolean; outline: string } | null;

  // ---- what the sync suites ask of the MODEL ----------------------------------------
  readonly model: string;
  rebuildCells(plan?: PlanV5 | null): Cellule[] | undefined;
  setCell(id: unknown, name?: string, floor?: string): { id: string; name: string; floor: string } | null;
  setPos(id: unknown, x: number, y: number): { x: number; y: number } | null;
  clampPieces(): unknown;
  noteForeignOrphans(): true;
  openingWire(id: unknown): OuvertureFil | null;
  histApplyOp(plan: PlanV5, op: Op): PlanV5;
  drawWall(a: Pt, b: Pt, opts?: unknown): { id: string | null; toast: string | null };
  nouveauGeste(): true;
  restoreBackup(): ResultatRestauration;

  // ---- D-7: the personal settings NEVER cross over --------------------------------------
  setLayer(which: "light" | "plug" | "furn", on: boolean): { light: boolean; plug: boolean; furn: boolean };
  opts(): Options;
  storedOpts(): Partial<Options> | null;
  serializedHasOpts(): boolean;
}

const vidage = (m: Fil["ws5"]): VidageMiroir => ({
  outline: m.outline,
  walls: [...m.walls.keys()].sort(),
  openings: [...m.openings.keys()].sort(),
  pieces: [...m.pieces.keys()].sort(),
  cells: [...m.cells.keys()].sort(),
});

export function sondeFil(ctx: Contexte, fil: Fil): SondeFil {
  return {
    // `wire()` takes NO ARGUMENT on the hook side, while `v5StateWire(plan, setupDone)` takes
    // two: the historical signature is untouchable (the suites call it bare), so the closure
    // over `ctx` happens HERE. Same reason as `v5OpeningBox` in `sonde.ts`.
    wire: () => etatFilCourant(ctx),
    wsFeed(msg: unknown): true { wsOnMessage(ctx, fil, JSON.stringify(msg)); return true; },
    wsForceOpen(on: boolean): boolean { fil.wsOpen = !!on; return fil.wsOpen; },
    // The TWO logs return a LIVE array once armed: the `collab-accuses` bench uses them as a
    // client -> server pipe and reads the new entries on every pump cycle.
    opLog(on: boolean): Op[] {
      if (on) { fil.opLog = []; return fil.opLog; }
      const l = fil.opLog; fil.opLog = null; return l || [];
    },
    outLog(on: boolean): unknown[] {
      if (on) { fil.outLog = []; return fil.outLog; }
      const l = fil.outLog; fil.outLog = null; return l || [];
    },
    get wsFp() { return fil.wsFp; },
    get serverRev() { return fil.serverRev; },
    get syncDetached() { return fil.detached; },
    get chipText() { return puceTexte(); },
    // Forces diff-based emission by pretending to be "online". This is THE trigger for every
    // wire scenario: under `file://` the socket does not exist, so `wsOnSave` would bail out
    // right away.
    forceDiff(): void {
      const o = fil.wsOpen;
      fil.wsOpen = true;
      try { wsOnSave(ctx, fil); } finally { fil.wsOpen = o; }
    },
    applyRemote(op: Op): void { wsApplyRemoteOp(ctx, fil, op); },
    serverHasPlan,

    shadowSync(): void { wsShadowSync(ctx, fil); },
    shadowDump: () => vidage(fil.ws5),
    shadowOf: (fam, id) => fil.ws5[fam].get(String(id)) || null,
    shadowFromServer(st: unknown): VidageMiroir { wsShadowFromServer(ctx, fil, st); return vidage(fil.ws5); },
    shadowAckDump: () => vidage(fil.ws5Ack),
    shadowAckOf: (fam, id) => fil.ws5Ack[fam].get(String(id)) || null,
    // The ops the server would be missing if the link dropped RIGHT NOW (diff against the
    // ACKNOWLEDGED state).
    diffContreAcquitte: () => ws5DiffOps(etatFilCourant(ctx), fil.ws5Ack).map((o) => o.kind),

    get acksOn() { return fil.wsAcksOn; },
    get retransmits() { return fil.retransmits; },
    unackedOps: () => [...fil.unacked.entries()].map(([n, e]) => ({ n, kind: e.kind, age: Date.now() - e.t })),
    // Ages the queue to exercise the guard delay without waiting 2.5 s of real time.
    ageUnacked(ms?: number | null): number {
      const d = (ms == null ? WS_ACK_RTO + 1 : ms);
      fil.unacked.forEach((e) => { e.t -= d; });
      return fil.unacked.size;
    },
    ackTickNow(): { unacked: number; retransmis: number } {
      wsAckTick(ctx, fil);
      return { unacked: fil.unacked.size, retransmis: fil.retransmits };
    },
    pendingOps: () => [...fil.pending.entries()].map(([n, e]) => ({
      n, kind: e.kind, undo: (e.undo || []).map((o) => o.kind),
    })),
    revertRefused: (n: number) => wsRevertRefused(ctx, fil, n),
    // Link drop through the REAL path: it is what decides the recovery on return.
    wsSimulerChute(): { unacked: number; aRejouer: boolean } {
      wsOnDown(ctx, fil);
      return { unacked: fil.unacked.size, aRejouer: fil.hadUnacked };
    },

    newDerivedId: (prefix: string) => v5DerivedId(prefix),
    wsMeInfo: () => ({
      email: fil.wsMe.email || null, tag: fil.wsMe.tag || null,
      name: fil.wsMe.name || null, guest: !!fil.wsMe.guest, guestId: fil.wsMe.guestId || null,
    }),
    wsPeerKeys: () => [...fil.peers.keys()],
    peerDots(): { txt: string | null; title: string; self: boolean; bg: string }[] {
      const b = $("peers");
      if (!b || b.hidden) return [];
      return [...b.querySelectorAll<HTMLElement>(".peer-dot")].map((d) => ({
        txt: d.textContent, title: d.title, self: d.classList.contains("self"), bg: d.style.background,
      }));
    },
    peerCursors: () => [...document.querySelectorAll<HTMLElement>("#peerCursors .peer-cur")].map((e) => ({
      label: e.querySelector(".pc-name")?.textContent ?? null,
      hidden: e.style.display === "none",
      transform: e.style.transform,
    })),
    // The ghosts' DOM render goes through an rAF loop: it is forced before counting.
    ghostIds(): string[] { wsApplyGhostsToDOM(ctx, fil); return [...fil.ghosts.keys()]; },
    ghostPose(pieceId: unknown) {
      const el = ctx.canvas.querySelector<HTMLElement>(`.piece[data-id="${CSS.escape(String(pieceId))}"]`);
      if (!el) return null;
      return {
        left: el.style.left, top: el.style.top,
        ghost: el.classList.contains("peer-ghost"), outline: el.style.outlineColor,
      };
    },

    get model() { return String(ctx.etat.model); },
    rebuildCells(plan?: PlanV5 | null): Cellule[] | undefined {
      const P = plan || ctx.etat.plan;
      v5RebuildCells(P);
      if (P === ctx.etat.plan) v5Touch(ctx);
      return P ? P.cells : undefined;
    },
    setCell(id: unknown, name?: string, floor?: string) {
      const c = v5CellById(ctx, id);
      if (!c) return null;
      if (name !== undefined) c.name = name;
      if (floor !== undefined && estSolConnu(floor)) c.floor = floor;
      v5Touch(ctx); render(ctx); save(ctx);
      return { id: String(c.id), name: c.name, floor: String(c.floor) };
    },
    // RAW placement, no snapping: used to set up an exact starting state (the bench's base gesture).
    setPos(id: unknown, x: number, y: number) {
      const p = pieceById(ctx, id);
      if (!p) return null;
      p.x = Math.round(x); p.y = Math.round(y);
      v5Touch(ctx); render(ctx);
      return { x: p.x, y: p.y };
    },
    // THE OLD `v5ClampPieces()` RETURNED A NUMBER AND SPOKE THE BANNER ITSELF. The port split
    // it: the model returns `{perdus, message}`, the caller speaks it. So the probe must point
    // at the FULL PATH (`bornerLesMeubles`), not the bare model, otherwise it returns an object
    // where the suites expect a count, and the banner is never spoken. Measured: two red
    // `deux-appareils` cases (`mon_propre_orphelin_est_annonce`,
    // `un_orphelin_venu_du_fil_est_repare_en_silence`), both on "seen [object Object]".
    clampPieces: () => bornerLesMeubles(ctx),
    noteForeignOrphans(): true { v5NoteForeignOrphans(ctx.etat.plan); return true; },
    openingWire(id: unknown): OuvertureFil | null {
      const o = v5OpeningById(ctx, id);
      return o ? v5OpeningWire(ctx.etat.plan, o) : null;
    },
    histApplyOp(plan: PlanV5, op: Op): PlanV5 { histApplyOp(plan, op); return plan; },
    // Drawn by the SAME code as the pointer: duplicate refusal and message included.
    drawWall(a: Pt, b: Pt, opts?: unknown) {
      const w = v5TryCreateWall(ctx, [a[0], a[1]], [b[0], b[1]], (opts || {}) as Parameters<typeof v5TryCreateWall>[3]);
      const el = ctx.viewport.querySelector<HTMLElement>(".app-toast");
      return { id: w ? String(w.id) : null, toast: (el && !el.hidden) ? el.textContent : null };
    },
    // C-15. Simulates the start of a NEW gesture: this is the grouping unit for gesture banners.
    nouveauGeste(): true {
      document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      return true;
    },
    restoreBackup: () => v5RestoreBackup(ctx),

    // D-7. THE PERSONAL SETTINGS NEVER CROSS OVER, IN EITHER DIRECTION. `setLayer` goes through
    // the REAL checkbox: this is the only way to prove that the user's path really writes to
    // the personal key and nowhere else.
    setLayer(which, on: boolean) {
      const el = $(which === "light" ? "optLayLight" : (which === "plug" ? "optLayPlug" : "optLayFurn")) as HTMLInputElement | null;
      if (el) { el.checked = !!on; el.dispatchEvent(new Event("change", { bubbles: true })); }
      const o = ctx.etat.opts;
      return { light: !!o.layLight, plug: !!o.layPlug, furn: !!o.layFurn };
    },
    opts: () => JSON.parse(JSON.stringify(ctx.etat.opts)) as Options,
    storedOpts(): Partial<Options> | null {
      try { return JSON.parse(localStorage.getItem(OPTS_KEY) || "null") as Partial<Options> | null; }
      catch (_) { return null; }
    },
    // Does the serialized state (D1 PUT body, export content) STILL carry settings?
    serializedHasOpts: () => Object.prototype.hasOwnProperty.call(serialize(ctx), "opts"),
  };
}
