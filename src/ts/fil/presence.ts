// src/ts/fil/presence.ts: THE SOCKET, THE MESSAGE ROUTER, PRESENCE, CURSORS, CHAT.
// Ported from src/js/44-collab-presence.js, in full.
//
// ---- C-7. TECHNICAL IDENTITY IS THE DEVICE, EMAIL IS THE HUMAN IDENTITY --------------------------
// The household has two accounts, but ONE person has several devices (the computer on the table,
// the phone in the apartment) behind a SINGLE Access identity. As long as everything was decided
// on the address, the same person's second device was mistaken for ONESELF:
//   - its ops did not enter the replay journal, so a SINGLE Ctrl+Z destroyed its work on BOTH
//     screens AND in the server's plan, without a banner;
//   - neither its dot, nor its cursor, nor its ghosts appeared, so nothing warned that another
//     device was writing.
// `wsPeers` and `wsCursors` are therefore indexed by DEVICE (`tag`, unique per socket). The render
// keeps the PERSON's name and color; my other device is distinguished by an outline ring
// (`.peer-dot.self`), the "your other device" tooltip, and the "Other device" label.
// A SERVER WITHOUT `tag` MAKES THE CLIENT FALL BACK TO EMAIL, exactly as before.
//
// ---- BANNERS ARE THROTTLED, CONFLICTS ARE NOT (C-15) ----------------------------------------------
// A gesture can produce a burst of ops all refused for the same reason (one per cell, one per
// piece of furniture): one banner per op would flood the screen. ONLY ONE per reason and per 5 s
// window. BUT THE UNDO IS STILL DONE EVEN WHEN THE BANNER IS THROTTLED: a burst of refusals must
// not let the following divergences through. And a `conflict` is NOT a refused op: it goes
// through neither `WS_ERR_MSG` nor its throttling.

import type { Contexte } from "../app/contexte.ts";
import type { Fil, Pair } from "./etat.ts";
import type { Fp, Op } from "../partage/plan.ts";
import { wsDevKey, wsFromMe, wsSameAccount } from "./etat.ts";
import { SYNC_ON, WIRE_ROOM, avecPlan, estInvite } from "./drapeaux.ts";
import { guestIdCourant } from "./identite.ts";
import { $ } from "../noyau/dom.ts";
import { toast } from "../app/toast.ts";
import { migrate } from "../modele/etat.ts";
import { histNoteRemoteOp } from "../historique/pile.ts";
import { assistant } from "../panneaux/configuration.ts";
import { aptToScreen, screenToApt } from "../rendu/vue.ts";
import { creerNoeudCurseur, dedupedDisplayName, displayName, personColor } from "../mesure/curseur-pair.ts";
import {
  opsNonAcquittees, wsAckOp, wsAckDisarm, wsPublishWholePlan, wsRetransmit, wsSend,
  wsShadowAdopted, wsShadowFromServer,
} from "./emission.ts";
import { wsApplyRemoteDrag, wsApplyRemoteOp, wsRejouerNonAcquittees, wsRevertRefused } from "./reception.ts";
import {
  adoptServerState, maybeOpenSetupFromServer, pollPull, serverHasPlan, setSyncChip,
  showConflitFilNotice, surPlanSupprime,
} from "./rest.ts";

// `o` may be a peer/message OBJECT (batch 2: `.name` preferred) or a bare email string, exactly
// like `displayName`/`personColor`, see their header notes.
const initial = (o: unknown): string => {
  const n = displayName(o);
  if (n) return n[0]!.toUpperCase();
  const email = (o && typeof o === "object" && !Array.isArray(o))
    ? ((o as Record<string, unknown>).email ?? (o as Record<string, unknown>).by) : o;
  const s = String(email || "?").trim();
  return (s[0] || "?").toUpperCase();
};

// =================================================================================================
//  PRESENCE: ONE DOT PER DEVICE, NOT ONE PER PERSON (C-7)
// =================================================================================================

function wsRenderPeers(fil: Fil): void {
  const box = $("peers");
  if (!box) return;
  // We exclude OUR own socket only. Filtering on email used to erase the person's second device:
  // nothing on screen said that another device was writing into the plan.
  const others = [...fil.peers.values()].filter((p) => !wsFromMe(fil, p));
  box.innerHTML = "";
  if (!fil.wsOpen || !others.length) { box.hidden = true; return; }
  box.hidden = false;
  const tousLesPairs = [...fil.peers.values()];
  others.forEach((p) => {
    const d = document.createElement("span");
    d.className = "peer-dot";
    d.style.background = personColor(p, p.color);
    d.textContent = initial(p);
    // Design edge 3: two peers can pick the SAME name (two guests, or a guest naming themselves
    // after a household member's derived name). Display only, disambiguated from the FULL peer
    // set (self included: the discriminator must be the SAME on every screen), never the stored
    // name, which is what the wire and the invite row keep.
    const dn = dedupedDisplayName(tousLesPairs, p);
    if (wsSameAccount(fil, p)) {
      d.classList.add("self");
      d.title = (dn || p.email || "") + " (your other device)";
    } else if (p.guest) {
      // Design edge 4: make provenance visible. A household identity is Access-proven; a guest's
      // is self-declared (they typed it themselves), and someone COULD name themselves after the
      // owner, the dashed ring (`.peer-dot.guest`, css/15-collab.css) plus this tooltip are what
      // tell the two apart, since the name alone cannot.
      d.classList.add("guest");
      d.title = (dn || "?") + " (guest, self-declared name)";
    } else {
      // Name in plain sight, email as secondary information on hover.
      d.title = dn ? (dn + " (" + (p.email || "") + ")") : String(p.email || "");
    }
    box.appendChild(d);
  });
}

// =================================================================================================
//  PEER CURSORS
// =================================================================================================
// Target updated IMMEDIATELY, rendered via `translate3d` in a shared rAF loop (soft smoothing,
// convergence <= 80 ms). No CSS transition, hence no added delay.

const WS_LERP = 0.35;                 // ~80 ms convergence at 60 fps

function wsUpsertCursor(
  ctx: Contexte, fil: Fil,
  msg: {
    by?: string; tag?: string; color?: string; name?: string; guest?: boolean;
    room?: unknown; x?: number | null; y?: number | null;
  },
): void {
  if (wsFromMe(fil, msg)) return;
  const key = wsDevKey(msg);
  if (msg.room == null || msg.x == null || msg.y == null) { wsHideCursor(fil, key); return; }
  const col = personColor(msg, msg.color);
  let c = fil.cursors.get(key);
  if (!c) {
    // MY OWN account on ANOTHER device does not carry MY name on my own screen: that would be me.
    // It announces itself for what it is.
    const label = wsSameAccount(fil, msg) ? "Other device" : (dedupedDisplayName([...fil.peers.values()], msg) || "?");
    const el = creerNoeudCurseur(label, col, !!msg.guest);
    $("peerCursors")?.appendChild(el);
    const s = aptToScreen(ctx, msg.x, msg.y);
    c = { color: col, el, ax: msg.x, ay: msg.y, sx: s.x, sy: s.y, tx: s.x, ty: s.y, timer: null };
    fil.cursors.set(key, c);
    wsPaintCursor(c, true);
  }
  c.ax = msg.x; c.ay = msg.y;
  const s = aptToScreen(ctx, msg.x, msg.y);
  c.tx = s.x; c.ty = s.y;
  // DOM write IN THE SAME TICK as reception (received -> painted budget ~0): we advance
  // immediately one step toward the target and paint. The rAF loop continues the smoothing.
  c.sx += (c.tx - c.sx) * WS_LERP;
  c.sy += (c.ty - c.sy) * WS_LERP;
  wsPaintCursor(c, false);
  c.el.style.display = "";
  wsEnsureCursorLoop(fil);
  if (c.timer) clearTimeout(c.timer);
  c.timer = setTimeout(() => wsHideCursor(fil, key), 4000);
}

function wsPaintCursor(c: { el: HTMLElement; sx: number; sy: number; tx: number; ty: number }, snap: boolean): void {
  if (snap) { c.sx = c.tx; c.sy = c.ty; }
  c.el.style.transform = `translate3d(${c.sx.toFixed(1)}px,${c.sy.toFixed(1)}px,0)`;
}

/** Single rAF loop: each cursor glides toward its target; it stops once everything has arrived. */
function wsCursorTick(fil: Fil): void {
  fil.curRafLoop = 0;
  let moving = false;
  fil.cursors.forEach((c) => {
    if (c.el.style.display === "none") return;
    const dx = c.tx - c.sx, dy = c.ty - c.sy;
    if (Math.abs(dx) < 0.4 && Math.abs(dy) < 0.4) {
      if (c.sx !== c.tx || c.sy !== c.ty) { c.sx = c.tx; c.sy = c.ty; wsPaintCursor(c, false); }
      return;
    }
    c.sx += dx * WS_LERP; c.sy += dy * WS_LERP;
    wsPaintCursor(c, false);
    moving = true;
  });
  if (moving) wsEnsureCursorLoop(fil);
}

function wsEnsureCursorLoop(fil: Fil): void {
  if (!fil.curRafLoop) fil.curRafLoop = requestAnimationFrame(() => wsCursorTick(fil));
}

function wsHideCursor(fil: Fil, key: string): void {
  const c = fil.cursors.get(key);
  if (c) c.el.style.display = "none";
}

function wsRemoveCursor(fil: Fil, key: string): void {
  const c = fil.cursors.get(key);
  if (c) { if (c.timer) clearTimeout(c.timer); c.el.remove(); fil.cursors.delete(key); }
}

/** Reprojection when the transform changes (zoom, pan, resize): SNAP, no smoothing. */
export function wsReprojectCursors(ctx: Contexte, fil: Fil): void {
  fil.cursors.forEach((c) => {
    if (c.el.style.display === "none") return;
    const s = aptToScreen(ctx, c.ax, c.ay);
    c.tx = s.x; c.ty = s.y;
    wsPaintCursor(c, true);
  });
}

// =================================================================================================
//  CHAT
// =================================================================================================

interface MessageChat { by?: string; name?: string; guest?: boolean; text?: string; ts?: number }

/**
 * BUILT ENTIRELY VIA `createElement`/`textContent`, no `innerHTML` at all, unlike the version
 * this replaces. That earlier version DID escape the sender's display name (`escapeHtml(who)`),
 * but interpolated `initial(msg.by)` STRAIGHT into the template UNESCAPED: a name is now a guest's
 * OWN typed string (design edge 1, "the first untrusted string this client has ever rendered"),
 * and `initial()` returns its first code point verbatim. A single `<`, `>` or `"` character is not
 * itself an exploitable full tag, but "provably safe" (the standard this batch sets) means never
 * relying on that, especially in the ONE spot in this codebase that still built markup by hand.
 * `textContent` makes the class of bug structurally unreachable rather than merely unencountered.
 */
// PLUS EXPORTÉE : ses deux seuls appelants sont dans ce fichier (l'historique rejoué du `hello`,
// et un message reçu). L'`export` était de la dette gelée dans tests/fixtures/exports-morts-connus.json,
// et le cliquet descend ici pour une vraie raison, la fonction devient privée au module, plutôt
// que parce qu'un commentaire d'une suite prononce son nom, ce que la détection textuelle de
// tests/exports-morts.ts prendrait pour un appelant.
function wsAppendChat(fil: Fil, msg: MessageChat): void {
  const list = $("chatList");
  if (!list) return;
  const row = document.createElement("div");
  row.className = "chat-msg";
  const col = personColor(msg);
  // NOT deduplicated: a chat entry (server's `chatWire`) carries no `tag`, so there is nothing
  // reliable to disambiguate AGAINST here (unlike a peer dot or a cursor, both keyed by device).
  // Two "Marie"s in the chat history read the same as two "Marie"s ever did; the screen-wide lie
  // the discriminator fixes is two SIMULTANEOUS dots or cursors that look identical, not a log.
  const who = displayName(msg) || "?";
  const dot = document.createElement("span");
  dot.className = "cd";
  dot.style.background = col;
  dot.textContent = initial(msg);
  const body = document.createElement("span");
  body.className = "cb";
  const whoEl = document.createElement("span");
  whoEl.className = msg.guest ? "cwho guest" : "cwho";
  whoEl.textContent = who;
  const textEl = document.createElement("span");
  textEl.className = "ctext";
  // The TEXT is the only data on the wire that is entirely free-form: `textContent` always was,
  // and still is, the only thing it ever goes through.
  textEl.textContent = String(msg.text || "");
  body.appendChild(whoEl);
  body.appendChild(textEl);
  row.appendChild(dot);
  row.appendChild(body);
  row.title = new Date(msg.ts || Date.now()).toTimeString().slice(0, 5);
  list.appendChild(row);
  const panneau = $("chatPanel");
  if (panneau && !panneau.hidden) { list.scrollTop = list.scrollHeight; }
  else { fil.chatUnread++; wsUpdateBadge(fil); }
}

function wsUpdateBadge(fil: Fil): void {
  const b = $("chatBadge");
  if (!b) return;
  b.textContent = String(fil.chatUnread);
  b.hidden = fil.chatUnread <= 0;
}

// =================================================================================================
//  THE SERVER'S ERROR REASONS: SAYING THAT THE CHANGE IS LOST
// =================================================================================================

const WS_ERR_MSG: Record<string, string> = {
  too_big: "The shared plan has reached its maximum size: the last change was NOT saved.",
  persist_fail: "The server could not save the last change. Do it again.",
  state_shape: "The shared plan refused this send: the last change was NOT saved.",
  op_fail: "The shared plan refused this change: it was NOT saved.",
  bad_json: "Sending to the shared plan failed: the last change was NOT saved.",
  unknown_t: "Message refused by the shared plan: the last change was NOT saved.",
  // Batch 2, guest-only refusals (docs/decisions/0004-partage-par-lien.md).
  guest_unnamed: "Choose a name before editing: the last change was NOT saved.",
  guest_no_replace: "Guests cannot replace the whole plan: the last change was NOT saved.",
  rate_limited: "Too many changes at once on this link: the last change was NOT saved. Try again shortly.",
};

const WS_ERR_THROTTLE = 5000;
const WS_ERR_SUITE_ANNULEE = " It has been undone here: this screen shows the shared plan again.";
const WS_ERR_SUITE_RELECTURE = " The shared plan is being re-read to bring this screen back in line.";

function wsErrToast(fil: Fil, reason: string, suite: string): boolean {
  const now = Date.now();
  const last = fil.errSeen.get(reason) || 0;
  if (now - last < WS_ERR_THROTTLE) return false;
  fil.errSeen.set(reason, now);
  return toast((WS_ERR_MSG[reason]
    || "Change refused by the shared plan (" + reason + "): it was NOT saved.")
    + suite);
}

/**
 * The shared plan is no longer on the same model as this tab: our ops are refused, editing
 * further leads nowhere. We reload (the server state becomes the truth). ONLY ONE reload per
 * session: without this guard, a durably upset server loops on reloading.
 */
function wsModelConflict(fil: Fil): void {
  if (fil.conflictHandled) return;
  fil.conflictHandled = true;
  try { fil.ws?.close(); } catch (_) { /* already gone */ }
  try {
    if (sessionStorage.getItem("plan-model-reload")) {
      toast("The shared plan changed model. Reload the page.");
      return;
    }
    sessionStorage.setItem("plan-model-reload", "1");
  } catch (_) { /* sessionStorage refused: we reload anyway, once */ }
  toast("The shared plan changed model: reloading…");
  setTimeout(() => { try { location.reload(); } catch (_) { /* nothing */ } }, 400);
}

// =================================================================================================
//  THE INCOMING MESSAGE ROUTER
// =================================================================================================

export function wsOnMessage(ctx: Contexte, fil: Fil, raw: string): void {
  let msg: Record<string, unknown>;
  try { msg = JSON.parse(raw) as Record<string, unknown>; } catch (_) { return; }
  switch (msg["t"]) {
    case "hello": {
      fil.wsMe = (msg["you"] as Fil["wsMe"]) || fil.wsMe;
      // Batch 2: `name`/`guest`/`guestId` are NEW keys an older server never sends (`you` then
      // simply lacks them), and `wsSameAccount` compares them unconditionally, normalize once,
      // here, rather than have every reader guard against `undefined`.
      fil.wsMe.name = fil.wsMe.name || "";
      fil.wsMe.guest = !!fil.wsMe.guest;
      fil.wsMe.guestId = fil.wsMe.guestId || "";
      // THIS DEVICE'S OWN NAME BEATS WHAT THE SHARED INVITE ROW HAPPENS TO SAY RIGHT NOW.
      // `functions/ws.ts` resolves the wire name from `invites.last_name`, ONE slot shared by
      // every device holding the link: whichever device last redeemed the token WITH a name owns
      // it, so a second guest active on the same link can find that slot reclaimed by the OTHER
      // device by the time IT reconnects (a network blip, the heartbeat's dead-socket close, no
      // `/api/invite` POST happens on a plain reconnect, only on a fresh page load). The device's
      // OWN choice never left `localStorage`: reassert it on the wire the moment the server hands
      // back nothing, rather than let this socket sit silently unnamed until `guest_unnamed`
      // rejects its first edit.
      if (fil.wsMe.guest && !fil.wsMe.name) {
        const nomLocal = ctx.crochets.guestNomLocal?.() || "";
        if (nomLocal) { fil.wsMe.name = nomLocal; wsSend(fil, { t: "name", name: nomLocal }); }
      }
      // C-4. Does this server acknowledge receipt? In front of an OLDER server (`acks` absent),
      // all the resend machinery stays dormant: without acknowledgement, it would republish the
      // whole plan every 2.5 s. The client then behaves EXACTLY as before this fix.
      fil.wsAcksOn = !!msg["acks"];
      // C-3. WHAT THE SERVER HAS NEVER RECEIVED, computed BEFORE any adoption: adoption overwrites
      // the local state, so afterward it would be too late.
      const rejeu = (fil.wsAcksOn && fil.hadUnacked && !!ctx.etat.plan)
        ? opsNonAcquittees(ctx, fil) : null;
      fil.peers.clear();
      (msg["peers"] as Pair[] | undefined || []).forEach((p) => fil.peers.set(wsDevKey(p), p));
      wsRenderPeers(fil);
      // Adopt the server state if its CONTENT FINGERPRINT differs from the last one announced
      // (C-2: we no longer compare counters). `serverHasPlan` recognizes BOTH shapes, walls-only
      // and the old one, because testing `rooms` alone made an ALREADY CONVERTED shared plan look
      // like "empty household" and reopened the first-launch wizard.
      const helloHasRooms = serverHasPlan(msg["state"]);
      let adopted = false;
      if (msg["fp"] !== fil.wsFp && helloHasRooms) {
        const ns = migrate(msg["state"], ctx.etat.opts);
        if (ns && ns.plan) {
          fil.wsSuppress = true;
          try { adoptServerState(ctx, fil, ns); } finally { fil.wsSuppress = false; }
          adopted = true;
        }
      }
      fil.wsFp = (msg["fp"] as Fp | undefined) ?? null;
      if (helloHasRooms) assistant.fermer?.();
      // C-6. EMISSION MIRROR: after an adoption, the local state IS the server state, so BOTH
      // mirrors describe it. WITHOUT adoption, they are built on what the SERVER holds: copying
      // it from the local state made the diff blind to everything missing on the other side.
      if (adopted) wsShadowAdopted(ctx, fil); else wsShadowFromServer(ctx, fil, msg["state"]);
      // FRESH HOUSEHOLD. The shared plan is empty. If THIS device already has a configured plan,
      // it is the one that bootstraps the household: without this publication, two people would
      // each configure their own apartment and never share anything.
      if (!helloHasRooms) {
        if (ctx.etat.setupDone === true && ctx.etat.plan
          && Array.isArray(ctx.etat.plan.outline) && ctx.etat.plan.outline.length > 2) {
          wsPublishWholePlan(ctx, fil);
        } else {
          maybeOpenSetupFromServer(ctx);
        }
      } else if (rejeu) {
        // RESUME: the work that was in flight when the link dropped goes out again, ON TOP OF the
        // state the server just imposed. Useless when the server had no plan: the full publication
        // above has already sent all of it.
        wsRejouerNonAcquittees(ctx, fil, rejeu);
      }
      fil.hadUnacked = false;
      // Replay the chat queue (the last 50). The initial history DOES NOT COUNT as unread.
      const cl = $("chatList"); if (cl) cl.innerHTML = "";
      fil.chatUnread = 0; wsUpdateBadge(fil);
      (msg["chat"] as MessageChat[] | undefined || []).forEach((m) => wsAppendChat(fil, m));
      fil.chatUnread = 0; wsUpdateBadge(fil);
      const cb = $("chatBtn"); if (cb) cb.hidden = false;
      setSyncChip(fil, "__ws__");
      break;
    }

    // The server re-emits every op to EVERYONE, the author included (ops are idempotent). Only
    // those from a PEER enter the undo journal: replaying our own ops on top of our snapshot
    // would undo the undo (C-9). A REFUSED op (facade) never happened here: journaling it would
    // replay it on the first Ctrl+Z and redo precisely the disappearance we just prevented.
    // C-7: the filter is on the DEVICE. On email, an op coming from the SAME person's other
    // device never entered the journal, measured: a single Ctrl+Z on the computer would move the
    // piece dragged on the phone back, make the chair placed there disappear, and lose the
    // rename, on BOTH screens and in the server's plan, without a banner.
    case "op": {
      const mienne = wsFromMe(fil, msg as Pair);
      const refuse = wsApplyRemoteOp(ctx, fil, msg["op"] as Op);
      // THE JOURNAL IS DECIDED ON `tag`, NEVER ON `by`. The technical identity is the DEVICE;
      // `by` is the HUMAN one, and a GUEST has none: `functions/ws.ts` forwards an EMPTY
      // `X-Plan-Email` for the invite door, and the server only projects `by` toward a household
      // audience anyway (`live-worker/worker.ts`). Gating on `by` therefore kept every op laid
      // down by a guest out of the replay journal, so one Ctrl+Z by the household destroyed the
      // guest's work on both screens and in the shared plan, without a banner: exactly the C-7
      // defect, on the other door. A `tag` different from ours is all it takes to say "someone
      // else". Without any `tag` (a server from before C-7), we fall back to `by`, as before.
      const distante = msg["tag"] ? true : !!msg["by"];
      if (distante && !mienne && !refuse) histNoteRemoteOp(msg["op"] as Op);
      // C-3. THE ECHO OF OUR OWN OP IS THE ACKNOWLEDGEMENT: it carries `tag` (it is ours) and `n`
      // (WHICH ONE). It proves the op WAS APPLIED, and it carries the fingerprint of the plan
      // that resulted. Without `n` (older server) we cannot point at anything: we CLEAR the
      // queue rather than resend into the void.
      if (mienne) {
        if (msg["n"] !== undefined && msg["n"] !== null) wsAckOp(fil, msg["n"] as number);
        else fil.unacked.clear();
      }
      fil.wsFp = (msg["fp"] as Fp | undefined) ?? null;
      break;
    }

    // Duplicate: the server had already processed this number, so it replayed nothing and there
    // is no echo to carry the acknowledgement. This message carries it, and nothing else changes.
    case "ack":
      if (wsFromMe(fil, msg as Pair)) wsAckOp(fil, msg["n"] as number);
      if (msg["fp"]) fil.wsFp = msg["fp"] as Fp;
      break;

    // A NUMBER IS MISSING AT THE SERVER: one of our ops was lost en route. We do not wait for our
    // own guard delay, we resend right away what is missing, at its CURRENT value.
    case "gap":
      if (wsFromMe(fil, msg as Pair)) wsRetransmit(ctx, fil);
      break;

    // FULL STATE pushed by the server. Two reasons: `sync` (we requested it) and `d1_adopt` (real
    // time took back a write deposited in D1 by the REST fallback during an outage).
    case "state": {
      const ns = migrate(msg["state"], ctx.etat.opts);
      if (ns && ns.plan) {
        fil.wsSuppress = true;
        try { adoptServerState(ctx, fil, ns); } finally { fil.wsSuppress = false; }
      }
      fil.wsFp = (msg["fp"] as Fp | undefined) ?? null;
      // The server's full state is authoritative: the optimistic AND the acknowledged mirrors
      // both describe it.
      wsShadowAdopted(ctx, fil);
      if (msg["reason"] === "d1_adopt") {
        toast("The shared plan took back the changes made while the link was down.");
      }
      break;
    }

    // CONFLICT: the server kept ITS version, ours (made offline) could not merge. This is NOT a
    // refused op, nothing to do with `WS_ERR_MSG` or its throttling, it is a fact about the
    // shared plan, and it only happens once per foreign write.
    // "They are held on the server" was true and unreachable: nothing could ask for them. It is
    // now `GET /api/orphans` (household door only), and the announcement is the PERSISTENT banner
    // carrying the button, like every other loss of work in this codebase, instead of a message
    // that fades away on its own.
    case "conflict":
      showConflitFilNotice();
      break;

    case "drag":
      if (!wsFromMe(fil, msg as Pair)) {
        wsApplyRemoteDrag(ctx, fil, msg as unknown as Parameters<typeof wsApplyRemoteDrag>[2]);
      }
      break;

    case "cursor":
      wsUpsertCursor(ctx, fil, msg as Parameters<typeof wsUpsertCursor>[2]);
      break;

    case "peer":
      fil.peers.clear();
      (msg["peers"] as Pair[] | undefined || []).forEach((p) => fil.peers.set(wsDevKey(p), p));
      // Remove the cursors of DEVICES that left (same key on both sides).
      [...fil.cursors.keys()].forEach((k) => { if (!fil.peers.has(k)) wsRemoveCursor(fil, k); });
      wsRenderPeers(fil);
      break;

    case "chat":
      if (msg["msg"]) wsAppendChat(fil, msg["msg"] as MessageChat);
      break;

    case "pong":
      // Continuous, free check: the `pong` carries the server plan's fingerprint. If it is not
      // the one we believe, a message slipped past us -> we request the full state again. No
      // loop possible: the `state` that answers resets `wsFp` to the server's fingerprint.
      // WARNING, THIS SAFETY NET DOES NOT COVER LOST OUTGOING OPS (see `fil/emission.ts`).
      if (msg["fp"] && msg["fp"] !== fil.wsFp) wsSend(fil, { t: "sync" });
      break;

    case "err": {
      const reason = String(msg["reason"] || "unknown");
      console.warn("plan-live err:", reason);
      // `op_shape` = the server is on the OTHER model than us (a tab left open on the old format
      // wakes up while the shared plan is already converted). We cannot keep editing into the
      // void: we reload to start over from the server state.
      if (reason === "op_shape" || reason === "unknown_kind") { wsModelConflict(fil); break; }
      // WE UNDO BEFORE WE SPEAK (C-11), and the undo happens EVEN WHEN THE BANNER IS THROTTLED:
      // a burst of refusals must not let the following divergences through.
      const defait = wsRevertRefused(ctx, fil, msg["n"] as number | null | undefined);
      wsErrToast(fil, reason, defait ? WS_ERR_SUITE_ANNULEE : WS_ERR_SUITE_RELECTURE);
      // A THROTTLED TOAST IS NOT ENOUGH FOR THIS ONE REASON. Every other `guest_unnamed` write
      // this guest attempts is silently undone, and the toast that explains why is capped to one
      // per 5 s: a session of real edits can lose the ONLY sentence that says why nothing is
      // sticking. The name step is what happens next instead, every time, `ouvrirEtapeNomInvite`
      // is idempotent, so a burst of refusals within one gesture reopens nothing that is already
      // open.
      if (reason === "guest_unnamed") ctx.crochets.guestSansNom?.();
      // `too_big` / `persist_fail`: the link is HEALTHY, the server just refused THIS write.
      // Closing the socket would fix nothing (the next send would hit the same wall) and would
      // lose presence, cursors, and chat. We keep the link open.
      if (reason === "state_shape" || reason === "op_fail") {
        try { fil.ws?.close(); } catch (_) { /* already gone */ }
      }
      break;
    }
  }
}

// =================================================================================================
//  LINK HEALTH, CONNECTION, BACKOFF
// =================================================================================================

function wsStartHeartbeat(fil: Fil): void {
  if (fil.heartbeat) clearInterval(fil.heartbeat);
  fil.heartbeat = setInterval(() => {
    if (!fil.ws || fil.ws.readyState !== 1) return;
    // Dead socket: no INCOMING traffic in 25 s -> we close, the backoff reconnects.
    if (fil.lastInbound && (Date.now() - fil.lastInbound > 25000)) {
      try { fil.ws.close(); } catch (_) { /* already gone */ }
      return;
    }
    // Application-level ping. If the server ignores it, any other traffic is enough for the watchdog.
    try { fil.ws.send(JSON.stringify({ t: "ping", ts: Date.now() })); } catch (_) { /* nothing */ }
  }, 10000);
}

export function wsConnect(ctx: Contexte, fil: Fil): void {
  if (!SYNC_ON || fil.detached) return;
  try {
    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    let url = avecPlan(proto + location.host + "/ws");
    // BATCH 3. `?g=` identifies THIS guest's own second tab (design edge 8): a browser cannot
    // set a header on a WebSocket upgrade, so the invite token travels as the session cookie
    // (functions/api/invite.ts) and this small, non-credential id travels in the query, it
    // grants nothing by itself, `functions/ws.ts` still requires the cookie to open the socket at
    // all. Household sockets never send it (`estInvite()` false there): `wsMe.guestId` then stays
    // empty, exactly as before this batch.
    if (estInvite()) url += "&g=" + encodeURIComponent(guestIdCourant());
    fil.ws = new WebSocket(url);
  } catch (_) { wsScheduleReconnect(ctx, fil); return; }
  fil.ws.addEventListener("open", () => {
    try { fil.ws?.send(JSON.stringify({ t: "hello" })); } catch (_) { /* nothing */ }
    fil.lastInbound = Date.now();
    wsStartHeartbeat(fil);
  });
  fil.ws.addEventListener("message", (e) => {
    fil.lastInbound = Date.now();
    if (!fil.wsOpen) { fil.wsOpen = true; fil.wsReconnectDelay = 1000; }   // first message = live
    wsOnMessage(ctx, fil, String((e as MessageEvent).data));
  });
  fil.ws.addEventListener("close", (e) => wsOnDown(ctx, fil, (e as CloseEvent).code));
  fil.ws.addEventListener("error", () => { try { fil.ws?.close(); } catch (_) { /* nothing */ } });
}

/**
 * `code` (batch 3): the WebSocket close code. `4001` is `live-worker/worker.ts`'s
 * `REVOKE_CLOSE_CODE`, sent ONLY by `/revoke` closing a guest's live socket on purpose, the
 * "revoked mid-gesture" edge case (design edge 7). It is checked BEFORE any of the ordinary
 * reconnect machinery below runs: a revoked link must never schedule a reconnect attempt (there
 * is nothing left to reconnect TO), and the dead-end screen states plainly whether the last
 * change was saved, which `ctx.crochets.accesRefuseInvite` reads off `fil` before anything below
 * clears it.
 */
export function wsOnDown(ctx: Contexte, fil: Fil, code?: number): void {
  if (estInvite() && code === 4001) { ctx.crochets.accesRefuseInvite?.(); return; }
  // `4004` is `plan_deleted`, sent by `/purge` when `functions/api/plans.ts`'s DELETE removes the
  // plan. Like 4001 it is checked BEFORE the reconnect machinery: there is nothing left to
  // reconnect to, and retrying would reopen a socket onto a plan that no longer exists. Same
  // reaction whichever witness arrives first, see `surPlanSupprime`.
  if (code === 4004) { surPlanSupprime(ctx, fil); return; }
  const was = fil.wsOpen;
  fil.wsOpen = false;
  fil.ws = null;
  // We no longer know what the real-time server holds: the fingerprint is STALE. And if the link
  // was ALIVE, the D1 fallback takes back over without knowing what the row contains (for all
  // that time it was the Durable Object writing it): we reset its counter to -1 so the first poll
  // reconciles. On a plain connection FAILURE (`was` false), none of that: the fallback never
  // stopped being the source, and lowering it would re-adopt the row on every attempt, with the
  // "changed by …" chip every time.
  fil.wsFp = null;
  if (was) fil.serverRev = -1;
  // C-3. What was waiting for an acknowledgement when the link dropped is NOT lost: the
  // ACKNOWLEDGED mirror survives, and the next `hello` pulls exactly the work to put back from
  // it. The sequence-number queue, on the other hand, dies with the socket (the numbers belong
  // to THAT socket).
  fil.hadUnacked = fil.hadUnacked || fil.unacked.size > 0;
  fil.unacked.clear();
  wsAckDisarm(fil);
  fil.wsAcksOn = false;
  if (fil.heartbeat) { clearInterval(fil.heartbeat); fil.heartbeat = null; }
  // Clean up presence, cursors, ghosts.
  fil.peers.clear();
  wsRenderPeers(fil);
  [...fil.cursors.keys()].forEach((k) => wsRemoveCursor(fil, k));
  fil.ghosts.clear();
  const cb = $("chatBtn"); if (cb) cb.hidden = true;
  const cp = $("chatPanel"); if (cp) cp.hidden = true;
  // Live dropped -> D1 fallback (poll + PUT): "slow sync", NEVER "offline". A silent WS outage
  // must not look like a healthy sync, nor like a total absence of network.
  if (was && !fil.detached) setSyncChip(fil, "slow");
  if (SYNC_ON && !fil.detached) pollPull(ctx, fil);   // kick the fallback off right away
  wsScheduleReconnect(ctx, fil);
}

function wsScheduleReconnect(ctx: Contexte, fil: Fil): void {
  if (!SYNC_ON || fil.detached) return;
  if (fil.wsReconnectTimer) clearTimeout(fil.wsReconnectTimer);
  fil.wsReconnectTimer = setTimeout(() => {
    wsConnect(ctx, fil);
    fil.wsReconnectDelay = Math.min(30000, fil.wsReconnectDelay * 2);
  }, fil.wsReconnectDelay);
}

// =================================================================================================
//  WHAT GOES OUT CONTINUOUSLY: CURSORS AND DRAG GHOSTS
// =================================================================================================
// The hottest path in the application: we capture every `pointermove`, keep only the LAST point,
// and emit it on the next rAF. Zero timer, zero work per movement beyond a variable write.

function wsFlushCursor(fil: Fil): void {
  fil.curRafId = 0;
  if (!fil.wsOpen || !fil.curPending) return;
  const p = fil.curPending;
  fil.curPending = null;
  // The cursor travels in APARTMENT cm; `room` is just a label relayed as-is.
  wsSend(fil, { t: "cursor", room: WIRE_ROOM, x: p.x, y: p.y });
}

export function brancherCurseursSortants(ctx: Contexte, fil: Fil): void {
  // E3b already sets a `pointermove` on the viewport for `lastCursorApt` (placing from the
  // palette). We do not touch it: we add OUR OWN, which only emits. Two passive listeners on the
  // same event cost less than a coupling between the gestures batch and the collaboration batch,
  // exactly the kind of tacit coupling `__wsDragStart` had created in the old client.
  ctx.viewport.addEventListener("pointermove", (e) => {
    if (!fil.wsOpen) return;
    const vr = ctx.viewport.getBoundingClientRect();
    const apt = screenToApt(ctx, e.clientX - vr.left, e.clientY - vr.top);
    fil.curPending = { x: Math.round(apt.x), y: Math.round(apt.y) };
    if (!fil.curRafId) fil.curRafId = requestAnimationFrame(() => wsFlushCursor(fil));
  }, { passive: true });
  ctx.viewport.addEventListener("pointerleave", () => {
    if (fil.curRafId) { cancelAnimationFrame(fil.curRafId); fil.curRafId = 0; }
    fil.curPending = null;
    if (fil.wsOpen) wsSend(fil, { t: "cursor", room: null, x: null, y: null });
  });
}

/** Outgoing ghost during a drag, throttled to ~40 ms: the observer sees continuous movement. */
export function wsEmitDrag(fil: Fil, p: { id: unknown; x: number; y: number; rot?: number }): void {
  if (!fil.wsOpen) return;
  const now = Date.now();
  if (now - fil.lastDrag < 40) return;
  fil.lastDrag = now;
  wsSend(fil, {
    t: "drag", room: WIRE_ROOM, pieceId: String(p.id),
    x: Math.round(p.x), y: Math.round(p.y), rot: Math.round(p.rot || 0),
  });
}

/**
 * GROUP drag: one ghost per moved piece of furniture, same global throttling. We CAP the burst so
 * a huge selection does not flood the socket; the final `piece.set` (emitted by `wsOnSave` on
 * release) carries the real position of EVERY piece anyway.
 */
export function wsEmitDragMulti(fil: Fil, moved: { pc: { id: unknown; x: number; y: number; rot?: number } }[]): void {
  if (!fil.wsOpen || !moved || !moved.length) return;
  const now = Date.now();
  if (now - fil.lastDrag < 40) return;
  fil.lastDrag = now;
  const CAP = 24;
  for (let k = 0; k < moved.length && k < CAP; k++) {
    const pc = moved[k]!.pc;
    wsSend(fil, {
      t: "drag", room: WIRE_ROOM, pieceId: String(pc.id),
      x: Math.round(pc.x), y: Math.round(pc.y), rot: Math.round(pc.rot || 0),
    });
  }
}

/** Chat: its four buttons, wired once. */
export function brancherChat(fil: Fil): void {
  const ouvrir = (): void => {
    const p = $("chatPanel"), b = $("chatBtn"), l = $("chatList");
    if (p) p.hidden = false;
    if (b) b.hidden = true;
    fil.chatUnread = 0; wsUpdateBadge(fil);
    if (l) l.scrollTop = l.scrollHeight;
    setTimeout(() => $("chatText")?.focus(), 20);
  };
  const fermer = (): void => {
    const p = $("chatPanel"), b = $("chatBtn");
    if (p) p.hidden = true;
    if (fil.wsOpen && b) b.hidden = false;
  };
  const envoyer = (): void => {
    const inp = $("chatText") as HTMLInputElement | null;
    if (!inp) return;
    const t = (inp.value || "").slice(0, 500).trim();
    if (!t) return;
    wsSend(fil, { t: "chat", text: t });
    inp.value = "";
  };
  $("chatBtn")?.addEventListener("click", ouvrir);
  $("chatClose")?.addEventListener("click", fermer);
  $("chatSend")?.addEventListener("click", envoyer);
  $("chatText")?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") { e.preventDefault(); envoyer(); }
  });
}

/** The real-time wire starts AFTER the D1 bootstrap (js/45, last line of the old manifest). */
export function demarrerFil(ctx: Contexte, fil: Fil): void {
  if (SYNC_ON) wsConnect(ctx, fil);
}
