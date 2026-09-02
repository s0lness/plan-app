// src/ts/mesure/curseur-pair.ts — A PEER'S CURSOR LABEL, RENDERING ONLY.
//
// ⚠ OUT OF BATCH, DELIBERATE AND ON PURPOSE MINIMAL. Collaboration is stage E4, not this one. But
// `.pc-name` is one of the EIGHT text families that `tests/textes-lisibles.ts` requires to be seen
// ACTUALLY rendered (without which the suite proves nothing about it), and R-1 must be measurable on
// it just like the other seven. So we port EXACTLY what's needed to paint a peer's cursor
// label, and NOTHING else:
//
//   PORTED    : the factory for the `.peer-cur` node (SVG arrow + escaped `.pc-name`), its screen
//              position via `translate3d`, the displayed name and the person's color.
//   NOT PORTED : no WebSocket, no emission, no presence, no badge, no
//              expiry timer, no smoothing rAF loop, no drag ghost,
//              no acknowledgment. `wsUpsertCursor` (src/js/44) remains to be ported IN FULL by the E4
//              batch, which will take this module as a starting point or replace it.
//
// Nothing here is called by the live application: the only caller is the test probe. At rest
// `#peerCursors` is empty, so the render fingerprint never sees a `.pc-name`.

import type { Contexte } from "../app/contexte.ts";
import { $ } from "../noyau/dom.ts";
import { escapeHtml } from "../noyau/nombres.ts";
import { aptToScreen } from "../rendu/vue.ts";

/**
 * IDENTITY: DERIVED FROM THE ADDRESS, NEVER HARDCODED.
 *
 * The previous version carried the household's two names and two hand-assigned colors, on the
 * grounds that a household is "EXACTLY two people, forever". That was true of THAT plan and false
 * of the software: anyone behind Access got an empty name and the accent color, so
 * two strangers were painted the SAME color and both called themselves "?".
 *
 * What replaces it: the name comes from the local part of the address, the color from a STABLE hash
 * of the address into a fixed palette. Deterministic (the same account has the same color on both
 * screens, without any coordination), and with no list to keep up to date.
 *
 * What it costs, and it's accepted: two addresses can land on the same hue. With 8
 * hues and one household, that's unlikely; it's in any case less serious than the old defect,
 * where everyone EXCEPT two people shared a single color.
 */
const PALETTE: readonly string[] = [
  "#1f6f78", "#b04a3d", "#7c8a6b", "#8a6e8e", "#3f6ea8", "#a8763f", "#4f7a5e", "#8f4a6b",
];

/** 32-bit FNV-1a hash: short, no dependency, and the same for a given address. */
function hachage(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Displayed name: the local part of the address, split on separators, each word capitalized, and
 * trailing digits stripped (`jean.dupont42@…` → "Jean Dupont"). An empty address returns "":
 * callers already know how to fall back to something else, and inventing a name would be worse.
 */
function displayNameFromEmail(email: unknown): string {
  const s = String(email || "").trim();
  if (!s) return "";
  const local = (s.split("@")[0] || "").replace(/\d+$/, "");
  const mots = local.split(/[._\-+]+/).filter(Boolean);
  if (!mots.length) return "";
  return mots.map((m) => m.charAt(0).toUpperCase() + m.slice(1).toLowerCase()).join(" ").slice(0, 32);
}

/**
 * PREFERS AN EXPLICITLY SENT NAME (docs/decisions/0004-partage-par-lien.md, "batch 2, wire
 * identity"). A guest's `name` is self-declared and carried on the wire as-is (`peer`, `op`,
 * `cursor`, `drag`, `chat`, `hello.you`/`.peers`): it is NOT an email and must never be run
 * through the local-part derivation above. A household author still has no such field (only a
 * guest chooses one today), so passing its peer object here — instead of just its `.email` — is
 * what lets a GUEST recipient see something better than "?" for a household peer too: the server
 * fills `name` in with an email-derived one for exactly that recipient (`nameForGuestAudience` in
 * `live-worker/worker.ts`), and this function only has to trust whatever arrives.
 *
 * Every EXISTING call site kept passing a bare string (an email, or an author id): the object form
 * is additive, so `displayName(email)` still behaves exactly as before.
 */
export function displayName(o: unknown): string {
  if (o && typeof o === "object" && !Array.isArray(o)) {
    const rec = o as Record<string, unknown>;
    const nom = typeof rec.name === "string" ? rec.name.trim() : "";
    if (nom) return nom.slice(0, 40);
    return displayNameFromEmail(rec.email ?? rec.by);
  }
  return displayNameFromEmail(o);
}

/**
 * Same "prefers an explicit name" rule as `displayName`: the colour hash is keyed on the name when
 * one exists (deterministic across every surface that renders a given guest, independently of
 * whether a `color`/`fallback` happened to be threaded through to this particular call), falling
 * back to the email, then to `fallback`/the accent. Backward compatible: a bare string (or no
 * object at all) behaves exactly as before this batch.
 */
export function personColor(o: unknown, fallback?: string): string {
  let cle = "";
  if (o && typeof o === "object" && !Array.isArray(o)) {
    const rec = o as Record<string, unknown>;
    const nom = typeof rec.name === "string" ? rec.name.trim() : "";
    cle = nom || String(rec.email ?? rec.by ?? "").trim();
  } else {
    cle = String(o || "").trim();
  }
  cle = cle.toLowerCase();
  if (!cle) return fallback || "var(--accent)";
  return PALETTE[hachage(cle) % PALETTE.length]!;
}

/**
 * DUPLICATE-NAME DISPLAY (docs/decisions/0004-partage-par-lien.md, design edge 3). Two peers can
 * end up with the SAME rendered name (two guests who both typed "Marie", or a guest who typed
 * the same label a household member's email derives to): the wire still keys them apart by
 * `tag` (a device is never confused), but the SCREEN would show two identical-looking dots or
 * cursors, which is its own kind of lie.
 *
 * PURE and DISPLAY-ONLY: it never touches what is stored anywhere (the invite row, `wsMe.name`,
 * the wire) — only what THIS call paints. `all` should be the FULL peer set (self included): the
 * discriminator is derived by sorting every collision's `tag` and reading off the target's rank,
 * so every screen that received the same peer list computes the SAME numbering independently,
 * with no coordination and no extra round trip. A target with no `tag` at all (e.g. a value read
 * before the wire ever set one) simply never collides: it always renders plain.
 */
export function dedupedDisplayName(all: Iterable<unknown>, target: unknown): string {
  const nom = displayName(target);
  if (!nom) return nom;
  const tagCible = (target && typeof target === "object" && !Array.isArray(target))
    ? (target as Record<string, unknown>).tag : undefined;
  if (tagCible === undefined || tagCible === null || tagCible === "") return nom;
  const tagsMemeNom = new Set<string>();
  for (const p of all) {
    if (displayName(p) !== nom) continue;
    const t = (p && typeof p === "object" && !Array.isArray(p)) ? (p as Record<string, unknown>).tag : undefined;
    if (t !== undefined && t !== null && t !== "") tagsMemeNom.add(String(t));
  }
  if (tagsMemeNom.size <= 1) return nom;
  const rang = [...tagsMemeNom].sort().indexOf(String(tagCible));
  return rang <= 0 ? nom : `${nom} (${rang + 1})`;
}

function wsCursorArrowSVG(color: string): string {
  return `<svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg"><path d="M1 1 L1 12 L4.2 9 L6.4 13.5 L8.4 12.6 L6.2 8.2 L10.5 8 Z" fill="${color}" stroke="#fff" stroke-width="1"/></svg>`;
}

/**
 * THE NODE FACTORY, AND THERE IS ONLY ONE. The realtime wire (`fil/presence.ts`) and the probe
 * call the SAME function: two copies would have diverged at the first fix, exactly like
 * the three placement previews that `makePlacePreview` replaced.
 *
 * `label` comes from an e-mail RELAYED by the server: it goes into `innerHTML`, so it is ESCAPED,
 * like everything else (R-9). One single rule, no "harmless" exception.
 *
 * SINCE BATCH 2, `label` MAY ALSO BE A GUEST'S SELF-DECLARED NAME — the FIRST untrusted string
 * this client has ever rendered (every name before it came from an Access-verified email). The
 * SAME `escapeHtml` call already covers it: nothing here changed for that reason, which is exactly
 * the point of having one rule instead of a second "harmless" path for the new source.
 *
 * `guest`: design edge 4, "make provenance visible". A household identity is Access-proven; a
 * guest's is self-declared, and someone can name themselves after the owner — the `.guest` class
 * (dashed border, `css/15-collab.css`) is the only thing that tells the two apart on screen.
 */
export function creerNoeudCurseur(label: string, color: string, guest?: boolean): HTMLElement {
  const el = document.createElement("div");
  el.className = guest ? "peer-cur guest" : "peer-cur";
  // `.pc-say` (cursor chat, "/", `fil/dire.ts` + `fil/presence.ts`): built into the SAME
  // `innerHTML` string as `.pc-name`, empty and `hidden`, rather than appended afterward via
  // `appendChild` — this keeps `creerNoeudCurseur`'s DOM footprint exactly what it was
  // (`createElement` + `.className` + one `.innerHTML` write), which `tests/identite-fil.ts`'s
  // minimal DOM stub relies on. Nothing UNTRUSTED goes into this string: `color` is always one
  // of the server's small fixed palette (`colorFor`, `live-worker/ops.ts`), never wire-supplied
  // free text, exactly like `.pc-name`'s own `background:${color}` right above it. The untrusted
  // part — a peer's live-typed text — is applied ONLY afterward, by `majDireCurseur`, and ONLY
  // through `.textContent` (R-9): never baked into this markup.
  el.innerHTML = wsCursorArrowSVG(color)
    + `<span class="pc-name" style="background:${color}">${escapeHtml(label)}</span>`
    + `<span class="pc-say" style="background:${color}" hidden></span>`;
  return el;
}

/**
 * CURSOR CHAT ("/"): paints a PEER'S live text next to their cursor, or clears it. `textContent`
 * ONLY (R-9) — the second untrusted string this client renders, right after a guest's own name.
 * Unlike `creerNoeudCurseur`'s `escapeHtml`-into-`innerHTML` path, there is no `innerHTML` here to
 * escape INTO at all: `textContent` makes the injection class structurally unreachable rather
 * than merely escaped, exactly like `wsAppendChat`'s own chat-text write.
 */
export function majDireCurseur(el: HTMLElement, texte: string | null): void {
  const s = el.querySelector<HTMLElement>(".pc-say");
  if (!s) return;
  if (texte) { s.textContent = texte; s.hidden = false; }
  else { s.textContent = ""; s.hidden = true; }
}

export interface MessageCurseur {
  by?: string | undefined;
  tag?: string | undefined;
  color?: string | undefined;
  name?: string | undefined;
  guest?: boolean | undefined;
  x: number;
  y: number;
}

/** A cursor is indexed by DEVICE (`tag`), never by person: two devices of the same
 *  person used to share the same key and replace one another. */
const curseurs = new Map<string, HTMLElement>();

/**
 * Places (or moves) a peer's cursor. The label comes from an e-mail RELAYED by the server: it
 * goes into `innerHTML`, so it is escaped, like everything else (R-9). One single rule, no
 * "harmless" exception.
 */
export function peindreCurseurPair(ctx: Contexte, msg: MessageCurseur): HTMLElement | null {
  const hote = $("peerCursors"); if (!hote) return null;
  const key = msg.tag ? String(msg.tag) : String(msg.by || "");
  const col = personColor(msg, msg.color);
  let el = curseurs.get(key) || null;
  if (!el || !el.isConnected) {
    el = creerNoeudCurseur(displayName(msg) || "?", col, !!msg.guest);
    hote.appendChild(el);
    curseurs.set(key, el);
  }
  const s = aptToScreen(ctx, msg.x, msg.y);
  // `translate3d`: the write goes through the compositor, no CSS transition so no added delay.
  el.style.transform = `translate3d(${s.x.toFixed(1)}px,${s.y.toFixed(1)}px,0)`;
  el.style.display = "";
  return el;
}
