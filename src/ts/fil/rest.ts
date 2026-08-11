// src/ts/fil/rest.ts — THE REST FALLBACK ON D1, AND THE CHIP THAT MUST NEVER LIE.
// Ported from src/js/41-sync-rest.js, in full.
//
// THIS MODULE IS THE ONLY SAFETY NET WHEN THE WORKER GOES DOWN. When real time is alive, it FALLS
// ENTIRELY SILENT (the Durable Object writes the D1 row itself); when the link dies, it takes back
// over: a GET poll every 4 s, a PUT debounced by one second. Three of the folder's five measured
// data losses are recorded here, and the three guards that close them are:
//
//  D-8   NOTHING GOES OUT UNTIL THE FIRST READ HAS ANSWERED (`bootReconciled`). The push is
//        debounced and did not wait for the bootstrap GET: a change made in the first second of a
//        slow page would publish what THIS device believed it had. A device whose local storage
//        is damaged believes it has the default apartment.
//  D-9   `rev` IS THE LOCK, MORE THAN A PIECE OF INFORMATION. The blind PUT let two people on the
//        fallback overwrite each other in silence (measured: two writes accepted, rev 3 then 5,
//        the row carrying only the second person's work). The PUT therefore carries the revision
//        WHOSE CONTENT WE HAVE, and a refusal gets RE-READ, it is never rewritten.
//  C-1   D1 IS ONLY AUTHORITATIVE WHEN REAL TIME IS NOT AUTHORITATIVE. `syncBoot` starts with a
//        GET; if the Durable Object's `hello` arrives BEFORE the response, that response
//        describes a plan up to 30 s stale (the D1 snapshot is carried by an alarm). Measured: an
//        F5 brought back the plan from the beginning, 20 pieces of furniture lost, the chip
//        showing "live ✓", without a word.
//
// THE OLD CONTRACT IS KEPT, AND THIS IS NOT FOLKLORE: a PUT WITHOUT `rev` is still accepted by the
// Function (blind write), for a tab open before the deployment. This client ALWAYS sends `rev`;
// what it tolerates is a server that answers without `rev` (`serverRev` then does not move) and a
// 409 response with no body (we re-read on the next poll instead of adopting).

import type { Contexte } from "../app/contexte.ts";
import type { EtatPuce, Fil, RefusRevision } from "./etat.ts";
import { wsLive } from "./etat.ts";
import { SYNC_ON, SYNC_URL, avecPlan } from "./drapeaux.ts";
import { $ } from "../noyau/dom.ts";
import { toast } from "../app/toast.ts";
import { displayName } from "../mesure/curseur-pair.ts";
import { migrate } from "../modele/etat.ts";
import { save, serialize } from "../app/persistance.ts";
import { applyReplacedState, pushHistory } from "../historique/pile.ts";
import { fitView } from "../rendu/vue.ts";
import { gesteActif } from "../gestes/sortie.ts";
import { assistant } from "../panneaux/configuration.ts";

const PUSH_DEBOUNCE = 1000;     // ms after the last save() before a PUT goes out
const POLL_EVERY = 4000;        // ms between two GET polls
const POLL_FRESH_GUARD = 2500;  // we skip a pull if a local change is fresher than this
const CONFLIT_KEY = "room-planner-v4-conflit";   // [{at, par, rev, state}], the versions set aside
const CONFLIT_MAX = 5;                           // beyond this, the oldest one drops out
const FETCH_TIMEOUT = 8000;

/** What `GET /api/plan` returns, and what a 409's body carries in addition (`data` = the winning state). */
interface ReponsePlan {
  data?: unknown;
  rev?: number;
  updatedAt?: string;
  updatedBy?: string;
}

interface ErreurApi extends Error {
  status?: number;
  payload?: ReponsePlan | null;
}

// =================================================================================================
//  THE STATE CHIP (D-10)
// =================================================================================================
// States: "live ✓" (WS), "slow sync" (D1 fallback), "not saved" (the read goes through, the
// WRITE does not), "offline", "local" (detached tab). NO SIXTH STATE. A GET poll that succeeds
// does not prove we know how to write: `putFailed` stops the chip from repainting "slow sync"
// over a failed PUT.

const hhmm = (d: unknown): string => {
  const t = d instanceof Date ? d : new Date(String(d));
  return isNaN(t.getTime()) ? "" : `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
};

function chipTooltip(fil: Fil): string {
  if (!fil.lastServerBy && !fil.lastServerAt) return "";
  const who = displayName(fil.lastServerBy) || "?";
  return `Last write: ${who}${fil.lastServerAt ? " · " + (hhmm(fil.lastServerAt) || fil.lastServerAt) : ""}`;
}

// Anti-flicker: `textContent` is only touched on a real string change, and the "sync ✓ HH:MM"
// timestamp is FROZEN at the moment of the last real transition (poll ticks that merely reaffirm
// "ok" must not advance it).
let _chipText: string | null = null;
let _okStamp = "";

function ecrirePuce(fil: Fil, chip: HTMLElement, texte: string, off: boolean): void {
  chip.classList.toggle("off", !!off);
  if (texte !== _chipText) { chip.textContent = texte; _chipText = texte; }
  chip.title = off ? "Changes kept locally, retrying automatically" : chipTooltip(fil);
}

export function setSyncChip(fil: Fil, kind: EtatPuce): void {
  const chip = $("syncChip");
  if (!chip) return;
  if (!SYNC_ON) { chip.hidden = true; return; }
  if (fil.detached && kind !== "local") return;   // detached tab: the chip stays "local"
  // WS alive: the collaboration layer owns the chip ("live ✓"), we ignore the D1 fallback.
  if (wsLive(fil) && kind !== "__ws__") return;
  chip.hidden = false;
  if (kind === "__ws__") {
    _okStamp = ""; chip.classList.remove("slow"); ecrirePuce(fil, chip, "live ✓", false); return;
  }
  if (kind === "saving") { ecrirePuce(fil, chip, "saving…", false); return; }
  if (kind === "local") {
    _okStamp = ""; chip.classList.remove("slow"); ecrirePuce(fil, chip, "local", true);
    chip.title = "Plan restored on this device: changes are not shared.";
    return;
  }
  // "slow sync": real time has dropped, we are on the D1 fallback (4 s poll). DISTINCT from
  // "offline": a silent WS outage must NEVER pass for mere delay.
  if (kind === "slow") {
    _okStamp = ""; chip.classList.add("slow"); ecrirePuce(fil, chip, "slow sync", false);
    chip.title = "Real time unavailable: deferred sync (~4 s). Reconnecting automatically.";
    return;
  }
  if (kind === "offline") {
    _okStamp = ""; chip.classList.remove("slow"); ecrirePuce(fil, chip, "offline", true); return;
  }
  // The read goes through, the WRITE does not: the peer will not see what is on screen. A
  // revision refusal is not a TRANSPORT state, the link works, the read works, so what changes is
  // not the state, it is the TITLE. The explanation and the recovery live in the banner.
  if (kind === "unsaved") {
    _okStamp = ""; chip.classList.remove("slow"); ecrirePuce(fil, chip, "not saved", true);
    chip.title = fil.putConflict
      ? "Someone wrote to the shared plan before you. Your version has been set aside and the household plan is being re-read."
      : "The last change could not be sent to the shared plan. Retrying automatically.";
    return;
  }
  if (typeof kind === "object" && kind.by !== undefined) {
    chip.classList.remove("slow"); _okStamp = "";
    const dn = displayName(kind.by);
    ecrirePuce(fil, chip, dn ? ("changed by " + dn) : "changed remotely", false);
    return;
  }
  // "ok" OUTSIDE WS = D1 fallback: we display "slow sync", never "sync ✓". On the live link the
  // chip is already driven by `__ws__` and this branch is never reached.
  if (!wsLive(fil)) {
    _okStamp = ""; chip.classList.add("slow"); ecrirePuce(fil, chip, "slow sync", false);
    chip.title = "Real time unavailable: deferred sync (~4 s). Reconnecting automatically.";
    return;
  }
  chip.classList.remove("slow");
  if (!_okStamp || _chipText === "saving…" || _chipText === "offline"
    || (_chipText && _chipText.indexOf("changed by") === 0)) {
    _okStamp = "sync ✓ " + hhmm(new Date());
  }
  ecrirePuce(fil, chip, _okStamp, false);
}

/** A transient message, then back to "ok". */
function chipOkAfter(fil: Fil, msg: EtatPuce): void {
  if (fil.chipRevertTimer) clearTimeout(fil.chipRevertTimer);
  setSyncChip(fil, msg);
  fil.chipRevertTimer = setTimeout(() => setSyncChip(fil, "ok"), 4000);
}

/** Test probe: the chip's current text, without going through the DOM on the suite's side. */
export const puceTexte = (): string | null => _chipText;

// =================================================================================================
//  THE REST TRANSPORT
// =================================================================================================

/** `fetch` with an 8 s abort. A REVISION REFUSAL (409) carries its body up to the caller. */
function apiFetch(opts?: RequestInit): Promise<ReponsePlan | null> {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
  const init: RequestInit = Object.assign(
    { signal: ac.signal, headers: { "Content-Type": "application/json" } },
    opts || {},
  );
  return fetch(avecPlan(SYNC_URL), init).then((r) => {
    clearTimeout(to);
    if (!r.ok) {
      // The 409's body carries the winning revision, author, AND state: the caller must be able
      // to re-read RIGHT THERE, right away, without a second round trip (which would reopen the
      // same race).
      return r.json().catch(() => null).then((p: ReponsePlan | null) => {
        const e = new Error("HTTP " + r.status) as ErreurApi;
        e.status = r.status; e.payload = p;
        throw e;
      });
    }
    return r.json() as Promise<ReponsePlan | null>;
  }).finally(() => clearTimeout(to));
}

// =================================================================================================
//  WHAT WE ARE ALLOWED TO PUBLISH, AND WHAT WE ARE ALLOWED TO ADOPT
// =================================================================================================

/**
 * D-8, the throttling point of EVERY PUT. The fresh-install default embeds a Living Room with
 * four pieces of furniture: a brand-new device that starts facing an EMPTY household plan must
 * not publish it and overwrite the "not yet configured" state. We therefore require that the
 * wizard have been carried through to completion HERE (`setupDone`), or that a real server plan
 * have been adopted (adoption forces `setupDone`). And a state that does not pass back through
 * `migrate()` never goes out: D-2, an unreadable plan does not get to pass for a plan.
 */
export function putableState(ctx: Contexte): ReturnType<typeof serialize> | null {
  if (SYNC_ON && ctx.etat.setupDone !== true) return null;
  const s = serialize(ctx);
  const m = migrate(JSON.parse(JSON.stringify(s)));
  if (!m || !m.plan) return null;
  return s;
}

/**
 * Does the household have a plan on the server? TWO POSSIBLE SHAPES, and recognizing only one is
 * a measured defect: testing `rooms` alone made an ALREADY CONVERTED shared plan look like
 * "empty household" and reopened the first-launch wizard. A single point of truth for
 * hello / pull / bootstrap.
 */
export function serverHasPlan(d: unknown): boolean {
  if (!d || typeof d !== "object") return false;
  const o = d as { rooms?: unknown; outline?: unknown; walls?: unknown };
  if (Array.isArray(o.rooms) && o.rooms.length) return true;
  if (Array.isArray(o.outline) && o.outline.length > 2) return true;
  if (Array.isArray(o.walls) && o.walls.length) return true;
  return false;
}

const mirrorOf = (s: unknown): string | null => {
  try { return JSON.stringify(s); } catch (_) { return null; }
};

/**
 * ONLY TO BE CALLED AFTER AN ADOPTION THAT WAS REALLY APPLIED. During a gesture,
 * `applyReplacedState` QUEUES instead: `serialize()` then still describes the local state and the
 * mirror would lie in the one dangerous direction, the one that SILENCES real local work.
 */
export function noteServerMirror(ctx: Contexte, fil: Fil): void {
  if (gesteActif()) { fil.serverMirror = null; return; }
  try { fil.serverMirror = mirrorOf(serialize(ctx)); } catch (_) { fil.serverMirror = null; }
}

/**
 * D-12. THE FIRST ADOPTION RECENTERS THE VIEW, LATER ONES DO NOT. A brand-new device frames the
 * default apartment (420x360) before the real plan arrives: without recentering it overflows the
 * viewport and one has to reach for "Fit" to see their home. A LATER adoption, on the other hand,
 * lands while someone is working: making the view jump for them would be worse.
 */
export function adoptServerState(ctx: Contexte, fil: Fil, ns: ReturnType<typeof migrate>): void {
  // During a gesture, `applyReplacedState` QUEUES instead of applying: recentering now would
  // frame the OLD plan and would burn the first time for nothing.
  const enFile = gesteActif();
  applyReplacedState(ctx, ns);
  if (!enFile && !fil.firstAdoptDone) { fil.firstAdoptDone = true; fitView(ctx); }
}

/**
 * TWO GUARDS, AND THEY MUST NOT BE CONFUSED.
 * `adoptSafe`: replacing the whole state would break something IN PROGRESS (a gesture, a modal,
 *   editing an outline). An INTERFACE guard, it ALWAYS holds.
 * `pullSafe`: in addition, a spontaneous poll must not replace fresh local work nobody has
 *   announced yet. A DATA guard. After a revision refusal it NO LONGER holds: the local version
 *   has been set aside AND announced, waiting for it would leave the screen lying for 4 more seconds.
 */
export function adoptSafe(ctx: Contexte): boolean {
  const setup = $("setup"), xfer = $("xfer");
  return !ctx.editRoom && !gesteActif()
    && !!(setup && setup.hidden) && !!(xfer && xfer.hidden);
}

export function pullSafe(ctx: Contexte, fil: Fil): boolean {
  return adoptSafe(ctx) && (Date.now() - fil.lastLocalChange > POLL_FRESH_GUARD);
}

/**
 * ADOPTION of a state coming from the server: the body of a polling GET, or the body of a 409
 * refusal. `pushHistory()` FIRST, it is THIS CALL that makes Ctrl+Z able to bring back onto the
 * screen the local version that is about to be replaced. Returns true if the adoption happened.
 */
export function adoptPayload(
  ctx: Contexte, fil: Fil, rev: number, data: unknown, opts?: { refus?: boolean } | null,
): boolean {
  if (!data || typeof data !== "object") return false;
  if (!((opts && opts.refus) ? adoptSafe(ctx) : pullSafe(ctx, fil))) return false;
  const ns = migrate(data, ctx.etat.opts);   // a server plan still in the old format is CONVERTED here
  if (!ns || !ns.plan) return false;
  pushHistory(ctx);                  // the remote overwrite is undoable
  fil.suppressPush = true;
  try { adoptServerState(ctx, fil, ns); } finally { fil.suppressPush = false; }
  fil.serverRev = rev;
  // We just FELL IN LINE with the household plan: there is nothing left from here to publish.
  noteServerMirror(ctx, fil);
  return true;
}

// =================================================================================================
//  THE REFUSED VERSION IS SET ASIDE, NEVER DISCARDED (D-9)
// =================================================================================================

interface EntreeConflit { at: string; par: string; rev: number | undefined; state: unknown }

export function conflitList(): EntreeConflit[] {
  try {
    const l = JSON.parse(localStorage.getItem(CONFLIT_KEY) || "[]") as EntreeConflit[];
    return Array.isArray(l) ? l : [];
  } catch (_) { return []; }
}

function stashConflit(mine: unknown, info: RefusRevision): number {
  let list = conflitList();
  list.push({ at: new Date().toISOString(), par: info.by || "", rev: info.rev, state: mine });
  while (list.length > CONFLIT_MAX) list.shift();
  try { localStorage.setItem(CONFLIT_KEY, JSON.stringify(list)); } catch (_) { /* cf. D-15 */ }
  return list.length;
}

/**
 * The recovery file. `state` = the most recent one, so it goes back through "Charger un plan…" as
 * is (same envelope as an export); `ecartes` carries EVERY version that has been set aside, so
 * nothing gets lost along the way.
 */
export function downloadConflits(): boolean {
  const list = conflitList();
  if (!list.length) return false;
  const last = list[list.length - 1]!;
  const blob = new Blob([JSON.stringify({
    app: "room-planner", version: 4, savedAt: new Date().toISOString(),
    state: last.state, ecartes: list,
  }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "plan-ma-version-ecartee.json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

/**
 * The PERSISTENT banner (`#bootNotice`): a loss of work is not told through a message that
 * fades away on its own. It carries the "Recover my version" button.
 */
let _conflitWired = false;
function showConflitNotice(info: RefusRevision, n: number): void {
  const qui = displayName(info.by) || "someone else";
  const quand = info.at ? (" (" + (hhmm(info.at) || info.at) + ")") : "";
  const combien = n > 1 ? (n + " of your versions have been set aside") : "your version has been set aside";
  const msg = "Your change was not saved: " + qui
    + " wrote to the shared plan before you" + quand
    + ". The household plan was re-read and " + combien + ". Ctrl+Z brings your version back on screen.";
  try { toast("Change not saved: " + qui + " had already written. The shared plan was re-read."); } catch (_) { /* nothing */ }
  const ban = $("bootNotice"), txt = $("bootNoticeText");
  if (!ban || !txt) return;
  txt.textContent = msg;
  ban.hidden = false;
  if (_conflitWired) return;
  _conflitWired = true;
  const x = $("bootNoticeX");
  if (x) x.addEventListener("click", () => { ban.hidden = true; });
  const dl = document.createElement("button");
  dl.type = "button"; dl.className = "btn sm"; dl.id = "conflitDl";
  dl.textContent = "Recover my version";
  dl.addEventListener("click", () => downloadConflits());
  ban.insertBefore(dl, x || null);
}

/**
 * D-9. A REFUSAL GETS RE-READ, IT NEVER GETS REWRITTEN. Three things, in this order: set aside
 * (nothing disappears), SAY IT (chip + banner), then re-read. `dirtySincePut` falls back to
 * false, the refused change does not go out again on its own, otherwise two devices would bounce
 * the same write back and forth indefinitely.
 */
function onPutRefused(ctx: Contexte, fil: Fil, mine: unknown, p: ReponsePlan | null | undefined): void {
  fil.dirtySincePut = false;
  fil.putFailed = true;
  fil.putConflict = {
    by: (p && p.updatedBy) || "",
    at: (p && p.updatedAt) || "",
    rev: (p && typeof p.rev === "number") ? p.rev : -1,
  };
  if (fil.putConflict.by) fil.lastServerBy = fil.putConflict.by;
  if (fil.putConflict.at) fil.lastServerAt = fil.putConflict.at;
  const n = stashConflit(mine, fil.putConflict);
  setSyncChip(fil, "unsaved");
  showConflitNotice(fil.putConflict, n);
  try { ctx.crochets.crumb?.("synchro", "revision refused:" + fil.putConflict.rev); } catch (_) { /* nothing */ }
  // RE-READ. The refusal's body already carries the winning state: we adopt it right away if it
  // is safe, otherwise the poll will take care of it (its revision is ahead of `serverRev`, which
  // has not moved).
  if (fil.putConflict.rev >= 0 && p && adoptPayload(ctx, fil, fil.putConflict.rev, p.data, { refus: true })) {
    fil.putFailed = false; fil.putConflict = null;
    setSyncChip(fil, "ok");
  }
}

// =================================================================================================
//  THE THREE LOOPS: PUSH, POLL, BOOTSTRAP
// =================================================================================================

export function doPut(ctx: Contexte, fil: Fil): void {
  // WS alive: the Durable Object owns the D1 snapshot, the PUT has nothing to do there.
  if (!SYNC_ON || fil.detached || fil.putInFlight || wsLive(fil)) return;
  // D-8. The first read has not answered: we publish nothing, we retry. (We do not touch the
  // chip: it already says "saving…" or "offline", and both are true.)
  if (!fil.bootReconciled) { fil.dirtySincePut = true; schedulePush(ctx, fil); return; }
  // We know there is a row on the other side, but not which one: without a comparison base, the
  // PUT would go BLIND again. We wait for the read that will give it to us (4 s poll).
  if (fil.serverRev < 0) { fil.dirtySincePut = true; schedulePush(ctx, fil); return; }
  // A revision refusal does not get replayed: rewriting would ask for the same refusal again, set
  // aside the same version again, and light the banner back up. It is the poll (or the refusal's
  // body) that unblocks it.
  if (fil.putConflict) { fil.dirtySincePut = true; return; }
  const s = putableState(ctx);
  if (!s) {
    fil.dirtySincePut = false;
    // Two very different cases behind the same `null`: not yet configured here (there is NOTHING
    // to share, the chip has nothing to announce), or configured but the state does not pass back
    // through `migrate()` (it will NEVER go out, it must be said).
    if (ctx.etat.setupDone === true) { fil.putFailed = true; setSyncChip(fil, "unsaved"); }
    return;
  }
  // NOTHING TO PUBLISH: what I have is EXACTLY what the server has. The common case is ADOPTION
  // (startup, poll, a 409's body): the earlier debounced push was still queued and would have
  // republished exactly what we just received. One extra revision for nothing is enough to make
  // the neighbor's PUT get refused with a 409, even though it did nothing wrong.
  const mine = mirrorOf(s);
  if (fil.serverMirror !== null && mine !== null && mine === fil.serverMirror) {
    fil.dirtySincePut = false;
    if (!fil.putFailed) setSyncChip(fil, "ok");
    return;
  }
  fil.putInFlight = true; fil.dirtySincePut = false;
  setSyncChip(fil, "saving");
  // D-9. `rev` = the revision WHOSE CONTENT WE HAVE. The server only writes if the row is still there.
  apiFetch({ method: "PUT", body: JSON.stringify({ state: s, rev: fil.serverRev }) }).then((res) => {
    fil.putInFlight = false; fil.putFailed = false; fil.putConflict = null;
    fil.serverMirror = mine;   // the server now holds EXACTLY this body
    if (res && typeof res.rev === "number") fil.serverRev = res.rev;
    if (res) {
      fil.lastServerBy = res.updatedBy || fil.lastServerBy;
      fil.lastServerAt = res.updatedAt || fil.lastServerAt;
    }
    setSyncChip(fil, "ok");
    if (fil.dirtySincePut) schedulePush(ctx, fil);   // other changes arrived while it was in flight
  }).catch((err: ErreurApi) => {
    fil.putInFlight = false;
    // 409: the row moved under us. This is NOT an outage, not "offline", not a reason to resend.
    // We set aside, we announce, we re-read.
    if (err && err.status === 409) { onPutRefused(ctx, fil, s, err.payload); return; }
    fil.dirtySincePut = true;                  // we will retry on the next save() or poll tick
    fil.putFailed = true;
    setSyncChip(fil, "offline");
  });
}

export function schedulePush(ctx: Contexte, fil: Fil): void {
  if (!SYNC_ON || fil.detached || wsLive(fil)) return;   // WS alive: ops replace the PUT
  if (fil.putInFlight) { fil.dirtySincePut = true; return; }   // no overlap
  if (fil.pushTimer) clearTimeout(fil.pushTimer);
  fil.pushTimer = setTimeout(() => doPut(ctx, fil), PUSH_DEBOUNCE);
}

/**
 * Marks a local change WITHOUT sending anything. Called by `save()` EVEN DURING A GESTURE: the
 * freshness guard in `pullSafe()` must run for the whole drag, not just at its end.
 */
export function syncTouchLocal(fil: Fil): void {
  if (!SYNC_ON || fil.detached || fil.suppressPush) return;
  fil.lastLocalChange = Date.now();
}

/** What `save()` triggers downstream, on every real local write. */
export function syncOnSave(ctx: Contexte, fil: Fil): void {
  if (!SYNC_ON || fil.detached || fil.suppressPush) return;
  fil.lastLocalChange = Date.now();
  schedulePush(ctx, fil);
}

export function pollPull(ctx: Contexte, fil: Fil): void {
  if (!SYNC_ON || fil.detached || document.hidden || wsLive(fil)) return;
  apiFetch({ method: "GET" }).then((res) => {
    fil.bootReconciled = true;   // a read succeeded: we know what is on the other side
    if (!res) return;
    if (res.updatedBy) fil.lastServerBy = res.updatedBy;
    if (res.updatedAt) fil.lastServerAt = res.updatedAt;
    const rev = typeof res.rev === "number" ? res.rev : -1;
    if (rev > fil.serverRev && adoptPayload(ctx, fil, rev, res.data)) {
      // An adoption REPAIRS a revision refusal: the screen shows the household plan again, the
      // chip no longer has anything to hold against the write.
      if (fil.putConflict) { fil.putConflict = null; fil.putFailed = false; fil.dirtySincePut = false; }
      chipOkAfter(fil, { by: res.updatedBy || "" });
      return;
    }
    // The household has nothing to adopt (row absent, or empty plan): we still take its revision
    // as the base of the compare-and-swap, otherwise bootstrapping a fresh household would have no
    // base and would never write. NEVER do this when the server has a plan we have not adopted:
    // writing on a base we have not read is precisely the hole we are closing (D-9).
    if (fil.serverRev < 0 && !serverHasPlan(res.data)) fil.serverRev = rev;
    // Caught up / nothing to apply: we reflect a healthy link, unless a PUT is in flight. A FAILED
    // PUT that was not replayed must stay visible: reading the shared plan never proved we knew
    // how to write to it, and it is the write the peer is missing (D-10).
    if (!fil.putInFlight) {
      if (fil.putFailed) { setSyncChip(fil, "unsaved"); if (fil.dirtySincePut) schedulePush(ctx, fil); }
      else setSyncChip(fil, "ok");
    }
    // A device that was offline on its first visit (wizard dismissed) reaches the server HERE. If
    // the household plan is confirmed empty, this is the real first launch -> wizard.
    if (!serverHasPlan(res.data) && pullSafe(ctx, fil)) maybeOpenSetupFromServer(ctx);
  }).catch(() => { if (!fil.putInFlight) setSyncChip(fil, "offline"); });
}

export function syncBoot(ctx: Contexte, fil: Fil): void {
  if (!SYNC_ON || fil.detached) return;
  setSyncChip(fil, "saving");   // "saving…" reads as "busy" during reconciliation
  apiFetch({ method: "GET" }).then((res) => {
    fil.bootReconciled = true;   // we know what is on the other side: pushes can go out
    if (res) {
      if (res.updatedBy) fil.lastServerBy = res.updatedBy;
      if (res.updatedAt) fil.lastServerAt = res.updatedAt;
    }
    const rev = (res && typeof res.rev === "number") ? res.rev : 0;
    // C-1. REAL TIME HAS ALREADY SPOKEN: ADOPT NOTHING FROM A D1 READ. The Durable Object's
    // `hello` carries the household plan to the second; the D1 row, on the other hand, is only
    // refreshed by a 30 s alarm. This particular read left BEFORE the `hello` and arrives AFTER:
    // adopting it means replacing the current plan with a stale one, then SAVING IT. Measured: an
    // F5 brought back the plan from half a minute ago, 20 pieces of furniture lost from both
    // sessions, the chip showing "live ✓", without a word and with no way back. The publication
    // lock, though, is duly lifted.
    if (wsLive(fil)) { fil.serverRev = rev; return; }
    if (res && res.data && typeof res.data === "object") {
      const ns = migrate(res.data, ctx.etat.opts);   // a server plan in the old format is CONVERTED here
      if (ns && ns.plan) {
        fil.suppressPush = true;
        try { adoptServerState(ctx, fil, ns); save(ctx); } finally { fil.suppressPush = false; }
        fil.serverRev = rev;
        noteServerMirror(ctx, fil);      // adopting means falling in line: nothing new to publish
        setSyncChip(fil, "ok");
        return;
      }
    }
    // The server confirmed EMPTY: this is the household's real first launch.
    fil.serverRev = rev;
    // D-8. We only bootstrap the server IF the wizard has really been carried through to
    // completion on this device: the default embeds a Living Room with four pieces of furniture,
    // so a test like "rooms have furniture" would publish the intact default before anyone had
    // done anything.
    if (!wsLive(fil) && ctx.etat.setupDone === true && putableState(ctx)) { doPut(ctx, fil); }
    else {
      setSyncChip(fil, "ok");
      maybeOpenSetupFromServer(ctx);
    }
  // The GET FAILED: the publication lock STAYS SET. We still have not seen the household plan, so
  // we still do not have the right to overwrite it. `pollPull` will lift it as soon as a read
  // succeeds; until then everything stays local and the chip says "offline".
  }).catch(() => { setSyncChip(fil, "offline"); });
}

/**
 * THE SERVER TOLD US THE SHARED PLAN IS EMPTY. We open the first-launch wizard IF AND ONLY IF
 * this device's local state is still trivial. `SYNC_ON` only: under `file://` it is the
 * bootstrap guard that decides. Never opens when the server actually has a plan (guaranteed by
 * the callers, who test `serverHasPlan`).
 */
export function maybeOpenSetupFromServer(ctx: Contexte): void {
  if (!SYNC_ON) return;
  if (ctx.etat.setupDone) return;                  // already configured here: adoption/bootstrap owns the case
  if (assistant.estOuvert?.()) return;             // already open
  const xfer = $("xfer");
  if (ctx.editRoom || !(xfer && xfer.hidden)) return;   // do not tear the person away from an edit
  assistant.ouvrir?.();
}

/** The periodic poll and the tab wake-up. Called once, at bootstrap. */
export function brancherSondage(ctx: Contexte, fil: Fil): void {
  if (!SYNC_ON) return;
  setInterval(() => pollPull(ctx, fil), POLL_EVERY);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pollPull(ctx, fil); });
}
