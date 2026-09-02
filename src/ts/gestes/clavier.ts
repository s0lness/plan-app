// src/ts/gestes/clavier.ts: THE KEYBOARD AND THE CLIPBOARD.
// Ported from src/js/33-clavier.js.
//
// G-24. THE CLIPBOARD: A SINGLE UNDO STEP, RELATIVE LAYOUT PRESERVED.
// Why, on top of "Duplicate" / `Ctrl+D` (`gestes/selection-actions.ts`): that one places the copy
// RIGHT AWAY and NEXT TO the original. The clipboard travels through time (copy here, paste
// elsewhere later) and it carries a MULTIPLE SELECTION while preserving the relative layout.
//   - a piece of FURNITURE has apartment coordinates: we keep its offset from the group's anchor;
//   - a WALL-MOUNTED OBJECT has NO coordinates, it belongs to a wall. Refusing it would make the
//     gesture useless right where it's most useful (the same outlet in three rooms): we RE-ATTACH it
//     to the wall closest to the paste point. No wall within reach: we SAY SO.
//   - a LOCKED object gets copied, but the copy is born UNLOCKED: "leaving it locked in
//     silence would make it immovable with nothing to explain why."
//   - `Ctrl+C` in a text field stays TEXT.
//
// G-12. ESCAPE DURING A GESTURE = CANCEL THE GESTURE, and nothing else. Before, the furniture kept
// following the mouse, the move was recorded on release, and the only thing Escape
// did was clear the selection out from under the finger.
//
import type { Contexte } from "../app/contexte.ts";
import type { Meuble, Ouverture } from "../partage/plan.ts";
import { pieceById, v5OpeningById, v5Touch, v5WallById } from "../app/contexte.ts";
import { TYPEMAP, isSideable, isWallMount } from "../catalogue/catalogue.ts";
import { $ } from "../noyau/dom.ts";
import { clamp, v5R2 } from "../noyau/nombres.ts";
import { v5OpeningBox, v5Seg } from "../modele/murs.ts";
import { WALL } from "../noyau/nombres.ts";
import { v5LastFit, v5PasteWallMount, v5ResolveOpening } from "../modele/edition.ts";
import { autoName, fabriqueOuverture, mk } from "../modele/creation.ts";
import { wallSnapReach } from "../modele/espace.ts";
import { v5NewId } from "../fil/identite.ts";
import { render } from "../rendu/rendu.ts";
import { clearSel } from "../rendu/selection.ts";
import { screenToApt } from "../rendu/vue.ts";
import { save } from "../app/persistance.ts";
import { toast } from "../app/toast.ts";
import { pushHistory, redo, undo } from "../historique/pile.ts";
import { escapeActiveGesture, gesteActif } from "./sortie.ts";
import { lastCursorApt, measureMode } from "./etat-pointeur.ts";
import { clearGuides, drawGuides } from "./guides.ts";
import { cur, delSel, dupliquerSelection, flipWallMountSide } from "./selection-actions.ts";
import { unstackGroup } from "./pose.ts";
import { annulerPoseArmee, poseArme } from "./pose.ts";
import { v5DeleteSelectedWall, v5DeleteVertex, v5OutilMurTouche, v5SelectWall, v5SetDraw } from "./murs.ts";
import { v5DrawOpeningGuides } from "./ouverture.ts";

// Identifier written into the clipboard to recognize a copy/paste coming from THIS app
// (and silently reject anything coming from elsewhere, cf. `d["app"] !== CLIP_APP` below).
const CLIP_APP = "plan-2d", CLIP_KIND = "meubles", CLIP_V = 1;

interface ItemClip {
  mural: boolean; dx: number; dy: number; type: string;
  name?: string | undefined; w: number; h: number;
  rot?: number | undefined; locked?: boolean | undefined;
  hinge?: unknown; swing?: unknown;
}

/** Memory of THIS tab. Nothing is persisted: a clipboard does not describe the plan. */
let planClip: { items: ItemClip[]; verrous: number } | null = null;
let clipPasteAttendu = 0;

export function planClipInfo(): { n: number; verrous: number; muraux: number } | null {
  return planClip ? {
    n: planClip.items.length, verrous: planClip.verrous,
    muraux: planClip.items.filter((i) => i.mural).length,
  } : null;
}
export function planClipReset(): boolean { planClip = null; return true; }

/** APARTMENT center of a selected object, furniture or wall-mounted (anchor and offsets). */
function clipCenterOf(ctx: Contexte, id: string): { x: number; y: number; piece?: Meuble; opening?: Ouverture } | null {
  const p = pieceById(ctx, id);
  if (p) return { x: p.x + p.w / 2, y: p.y + p.h / 2, piece: p };
  const o = v5OpeningById(ctx, id); if (!o) return null;
  const b = v5OpeningBox(ctx.etat.plan, o, (TYPEMAP[o.type] || { h: WALL }).h || WALL); if (!b) return null;
  return { x: b.cx, y: b.cy, opening: o };
}

function viewCenterApt(ctx: Contexte): { x: number; y: number } {
  const r = ctx.viewport.getBoundingClientRect();
  return screenToApt(ctx, r.width / 2, r.height / 2);
}

/** Copy (or cut) the selection. Returns the number of objects taken. */
export function planCopy(ctx: Contexte, couper: boolean): number {
  const src = [...ctx.selection.ids].map((id) => clipCenterOf(ctx, String(id))).filter(Boolean) as NonNullable<ReturnType<typeof clipCenterOf>>[];
  if (!src.length) { toast("Nothing to copy: select a piece of furniture first.", { geste: true }); return 0; }
  const cx = src.reduce((s, e) => s + e.x, 0) / src.length;
  const cy = src.reduce((s, e) => s + e.y, 0) / src.length;
  const items: ItemClip[] = src.map((e) => {
    const o = e.opening, p = e.piece;
    const base = (o || p)!;
    const it: ItemClip = {
      mural: !!o, dx: Math.round(e.x - cx), dy: Math.round(e.y - cy),
      type: base.type, name: base.name, w: base.w, h: base.h,
    };
    if (o) {
      if (o.hinge !== undefined) it.hinge = o.hinge;
      if (o.swing !== undefined) it.swing = o.swing;
    } else if (p) {
      const bat = p as Meuble & { hinge?: unknown; swing?: unknown };
      it.rot = p.rot || 0; it.locked = !!p.locked;
      if (bat.hinge !== undefined) it.hinge = bat.hinge;
      if (bat.swing !== undefined) it.swing = bat.swing;
    }
    return it;
  });
  planClip = { items, verrous: items.filter((i) => i.locked).length };
  // SYSTEM clipboard, best-effort: it allows pasting into ANOTHER tab. A failure (insecure
  // context, permission denied) is not reported: the internal copy has already succeeded.
  try {
    const s = JSON.stringify({ app: CLIP_APP, kind: CLIP_KIND, v: CLIP_V, items });
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(s).catch(() => { /* see above */ });
  } catch (_) { /* see above */ }
  if (couper) delSel(ctx);           // same rule as Delete: the entire selection leaves
  const n = items.length;
  toast(couper
    ? (n === 1 ? "1 object cut. Ctrl+V puts it back." : `${n} objects cut. Ctrl+V puts them back.`)
    : (n === 1 ? "1 object copied. Ctrl+V pastes it." : `${n} objects copied. Ctrl+V pastes them.`), { geste: true });
  return n;
}

/**
 * Paste: under the cursor if it has already hovered the plan, otherwise offset from the original. SAME
 * reference as placing from the palette (`lastCursorApt`): "two different placement rules for two
 * neighboring gestures would be one more source of error."
 */
export function planPaste(ctx: Contexte): number {
  if (!planClip || !planClip.items.length) {
    toast("Nothing to paste: copy a piece of furniture first (Ctrl+C).", { geste: true }); return 0;
  }
  const lc = lastCursorApt();
  const c = lc || viewCenterApt(ctx);
  const ax = Math.round(c.x) + (lc ? 0 : 15), ay = Math.round(c.y) + (lc ? 0 : 15);
  pushHistory(ctx);                     // G-24: A SINGLE undo step for the whole paste
  const neufs: string[] = [], meubles: Meuble[] = [], voulus: { x: number; y: number }[] = [];
  let sansMur = 0;
  planClip.items.forEach((it) => {
    const x = ax + it.dx, y = ay + it.dy;
    if (it.mural) {
      const op = v5PasteWallMount(ctx.etat.plan, it as never, x, y, wallSnapReach(ctx.vue.scale), fabriqueOuverture(ctx.etat.plan), ctx.etat.opts);
      if (!op) { sansMur++; return; }
      neufs.push(String(op.id));
      return;
    }
    const p = mk(ctx.etat.plan, it.type, Math.round(x - it.w / 2), Math.round(y - it.h / 2)) as Meuble & { hinge?: unknown; swing?: unknown };
    p.id = v5NewId("p");
    p.w = it.w; p.h = it.h; p.rot = it.rot || 0; p.locked = false;
    if (it.hinge !== undefined) p.hinge = it.hinge;
    if (it.swing !== undefined) p.swing = it.swing;
    p.name = autoName(ctx.etat.plan, it.name || p.name);
    ctx.etat.plan.pieces.push(p);
    meubles.push(p); voulus.push({ x: p.x, y: p.y }); neufs.push(String(p.id));
  });
  // G-24. Two truths to measure AFTER bounding, because they don't get stated the same way:
  //   - a TRANSLATION of the whole group keeps the promised relative layout, but moves the
  //     paste away from the requested point;
  //   - a DEFORMATION (each object bounded on its own) BREAKS that promise.
  let deborde = false, recale = 0, deforme = false;
  if (meubles.length) {
    unstackGroup(ctx, meubles, voulus);
    deborde = !v5LastFit();
    const d0 = { x: meubles[0]!.x - voulus[0]!.x, y: meubles[0]!.y - voulus[0]!.y };
    meubles.forEach((p, i) => {
      const d = { x: p.x - voulus[i]!.x, y: p.y - voulus[i]!.y };
      if (Math.abs(d.x - d0.x) > 1 || Math.abs(d.y - d0.y) > 1) deforme = true;
    });
    recale = Math.round(Math.hypot(d0.x, d0.y));
  }
  v5Touch(ctx);
  ctx.selection.ids.clear(); neufs.forEach((id) => ctx.selection.ids.add(id));
  let primaire: string | null = null;
  for (const id of ctx.selection.ids) primaire = id;
  ctx.selection.primaire = primaire;
  render(ctx); if (neufs.length) ctx.crochets.openInspector?.();
  save(ctx);
  // Nothing happens in silence: whatever got refused, unlocked or pushed back gets SAID.
  const dits: string[] = [];
  if (neufs.length) dits.push(neufs.length === 1 ? "1 object pasted." : `${neufs.length} objects pasted.`);
  if (planClip.verrous) dits.push(planClip.verrous === 1
    ? "The locked object was pasted UNLOCKED."
    : "The locked objects were pasted UNLOCKED.");
  if (sansMur) dits.push(sansMur === 1
    ? "1 wall-mounted object was not pasted: no wall within reach of the paste point."
    : `${sansMur} wall-mounted objects were not pasted: no wall within reach of the paste point.`);
  if (deforme) dits.push("The layout could not be kept here: each object was brought back inside a room.");
  else if (recale > 20) dits.push(`The paste was shifted by ${recale} cm to fit inside the plan.`);
  if (deborde) dits.push("A pasted object sticks out of its room.");
  if (!neufs.length && !sansMur) dits.push("Nothing could be pasted.");
  toast(dits.join(" "), { geste: true });
  return neufs.length;
}

/**
 * Payload coming from the SYSTEM clipboard (another tab, another browser). Unknown format:
 * we SAY SO rather than doing nothing.
 */
export function planPasteFromText(ctx: Contexte, txt: unknown): number {
  let d: Record<string, unknown> | null = null;
  try { d = JSON.parse(String(txt || "")) as Record<string, unknown>; } catch (_) { d = null; }
  if (!d || d["app"] !== CLIP_APP || d["kind"] !== CLIP_KIND || !Array.isArray(d["items"]) || !(d["items"] as unknown[]).length) {
    toast("Nothing to paste: the clipboard holds no object from this plan.", { geste: true });
    return 0;
  }
  const brut = d["items"] as Record<string, unknown>[];
  const items: ItemClip[] = brut.filter((i) => i && TYPEMAP[String(i["type"])]).map((i) => {
    const t = TYPEMAP[String(i["type"])]!;
    const nom = typeof i["name"] === "string" ? (i["name"] as string).slice(0, 80) : undefined;
    const it: ItemClip = {
      mural: !!i["mural"], dx: Math.round(+(i["dx"] as number) || 0), dy: Math.round(+(i["dy"] as number) || 0),
      type: String(i["type"]),
      w: clamp(+(i["w"] as number) || (t.w || 60), 1, 3000),
      h: clamp(+(i["h"] as number) || (t.h || 60), 1, 3000),
      rot: +(i["rot"] as number) || 0, locked: !!i["locked"],
    };
    if (nom !== undefined) it.name = nom;
    if (i["hinge"] !== undefined) it.hinge = i["hinge"];
    if (i["swing"] !== undefined) it.swing = i["swing"];
    return it;
  });
  if (!items.length) { toast("Nothing to paste: no object recognised in the clipboard.", { geste: true }); return 0; }
  planClip = { items, verrous: items.filter((i) => i.locked).length };
  return planPaste(ctx);
}

/**
 * A Ctrl+V left to pass through (empty memory) waits for the `paste` event. If it never arrives, the
 * gesture must not stay mute.
 */
function clipAttendrePaste(ctx: Contexte): void {
  const t = clipPasteAttendu = Date.now();
  setTimeout(() => {
    if (clipPasteAttendu === t) {
      clipPasteAttendu = 0;
      toast("Nothing to paste: copy a piece of furniture first (Ctrl+C).", { geste: true });
    }
  }, 200);
  void ctx;
}

/** Wires the system clipboard and the global keyboard. Called once at bootstrap. */
export function brancherClavier(ctx: Contexte): void {
  // The `paste` event asks for NO permission (unlike `navigator.clipboard.readText`):
  // it is the only reading path that cannot pop a dialog box under your fingers.
  window.addEventListener("paste", (e) => {
    const tgt = (e.target || {}) as HTMLElement;
    if (/INPUT|TEXTAREA|SELECT/.test(tgt.tagName || "") || tgt.isContentEditable) return;
    clipPasteAttendu = 0;
    if (planClip && planClip.items.length) return;     // the tab's memory has already been used
    let txt = "";
    try { txt = (e.clipboardData as DataTransfer | null)?.getData("text/plain") || ""; } catch (_) { txt = ""; }
    e.preventDefault();
    planPasteFromText(ctx, txt);
  });

  let lastNudgePush = 0;   // rapid-fire arrow keys are grouped into ONE history entry
  // The guide-clearing timer lives HERE, outside the handler: declared inside it,
  // every keystroke restarted from `null`, `clearTimeout` only canceled a brand-new timer, and the
  // previous one survived to clear the guides of a SUBSEQUENT keystroke.
  let nudgeGuideTimer: ReturnType<typeof setTimeout> | null = null;

  window.addEventListener("keydown", (e) => {
    const tgt = (e.target || {}) as HTMLElement;
    const typing = /INPUT|TEXTAREA|SELECT/.test(tgt.tagName || "") || tgt.isContentEditable;
    // The tape measure owns the keyboard for its narrow scope (a later batch).
    if (measureMode() && !typing) return;
    // G-12. As long as a gesture is armed, Escape ONLY cancels it.
    if (e.key === "Escape" && !typing && escapeActiveGesture()) { e.preventDefault(); return; }
    // THE WALL TOOL OWNS THE KEYBOARD WHILE IT IS ARMED, and only the four keys of its own grammar:
    // digits and Backspace type a length, Enter applies it (or ends the chain), Escape ends the
    // chain then puts the tool away. Everything else falls through to the rules below.
    if (!typing && !e.ctrlKey && !e.metaKey && ctx.ihm.draw && v5OutilMurTouche(ctx, e)) {
      e.preventDefault();
      return;
    }
    // W ARMS THE WALL TOOL, the way one letter arms a tool in every comparable planner. Same
    // toggle as the toolbar button, so there is one armed state and one place that shows it.
    if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && !gesteActif() && !poseArme()
      && (e.key === "w" || e.key === "W")) {
      e.preventDefault();
      v5SetDraw(ctx, !ctx.ihm.draw);
      render(ctx);
      return;
    }
    // G-22. ARMED PLACEMENT (touch only, decision 0013): Escape abandons it. Placing at the view's
    // center through a bare Enter is gone; the object is placed where it was aimed, on the plan.
    if (!typing && poseArme() && e.key === "Escape") {
      e.preventDefault(); annulerPoseArmee(ctx, "Drop cancelled."); return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !typing) {
      const k = (e.key || "").toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(ctx); return; }
      if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(ctx); return; }
      // G-24. `typing` was already ruled out above: a Ctrl+C in the name field stays a TEXT
      // Ctrl+C, the furniture selection has nothing to do with it.
      if (k === "c" && !e.shiftKey && !e.altKey) { e.preventDefault(); planCopy(ctx, false); return; }
      if (k === "x" && !e.shiftKey && !e.altKey) { e.preventDefault(); planCopy(ctx, true); return; }
      if (k === "v" && !e.shiftKey && !e.altKey) {
        // Tab memory: we paste OURSELVES (exact, no permission needed). Empty memory: we
        // LET it pass through, so the `paste` event can bring what another tab copied.
        if (planClip && planClip.items.length) { e.preventDefault(); planPaste(ctx); }
        else clipAttendrePaste(ctx);
        return;
      }
      // Ctrl+D: THE SAME PATH AS THE INSPECTOR'S DUPLICATE BUTTON (decision 0013,
      // `gestes/selection-actions.ts`), never a second gesture (Alt+drag is gone).
      if (k === "d" && !e.shiftKey && !e.altKey) { e.preventDefault(); dupliquerSelection(ctx); return; }
    }
    const p = cur(ctx);
    if (typing) return;
    // Structural commands follow the structural selection. A selected piece remains the target
    // when both selections briefly coexist, because the visible furniture owns the press.
    if (!p && (ctx.ihm.selWall || ctx.selVtx >= 0)) {
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (ctx.ihm.selWall) v5DeleteSelectedWall(ctx);
        else if (ctx.selVtx >= 0) v5DeleteVertex(ctx, ctx.selVtx);
      } else if (e.key === "Escape") {
        if (ctx.ihm.selWall) { v5SelectWall(ctx, null); render(ctx); }
        else { ctx.selVtx = -1; render(ctx); }
      }
      return;
    }
    // The cell card closes on Escape when no selected object owns the key.
    if (!p) {
      if (e.key === "Escape") {
        ctx.crochets.hideInspector?.();
        const rc = $("roomCard"); if (rc) rc.hidden = true;
      }
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const opening = isWallMount(p.type);   // openings + wall lights/outlets slide along the wall
    // Locked: Delete and Escape only; no move, no rotation.
    if ((p as { locked?: boolean }).locked) {
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); delSel(ctx); }
      else if (e.key === "Escape") { clearSel(ctx); ctx.crochets.hideInspector?.(); render(ctx); }
      return;
    }
    const nudge = (dx: number, dy: number): void => {
      const now = Date.now();
      if (now - lastNudgePush > 800) pushHistory(ctx);   // rapid-fire presses grouped into one entry
      lastNudgePush = now;
      const o = p as Ouverture;
      if (opening && o.wallId !== undefined) {
        // An opening is PARAMETRIC (wallId + t0): the move gets projected onto the wall's
        // direction and slides t0. It has neither x nor y.
        const w = v5WallById(ctx, o.wallId);
        if (w) {
          const s = v5Seg(w); const d = dx * s.ux + dy * s.uy;
          o.t0 = v5R2(clamp(o.t0 + d, 0, Math.max(0, s.L - o.w)));
          v5ResolveOpening(ctx.etat.plan, o, Math.sign(d), ctx.etat.opts); v5Touch(ctx);
        }
        render(ctx); v5DrawOpeningGuides(ctx, o);
      } else if (opening) {
        // wall-mounted object ORPHANED from an old plan: no supporting wall, nothing to slide
      } else {
        // NOTHING PUSHES A NUDGED PIECE BACK (decision 0011/0013): a piece flush with a wall must
        // not be shoved off it by an arrow key when the mouse would have left it exactly there.
        const m = p as Meuble;
        m.x += dx; m.y += dy;
        v5Touch(ctx);
        render(ctx); drawGuides(ctx, m, null);
      }
      ctx.crochets.syncInspector?.();
      if (nudgeGuideTimer) clearTimeout(nudgeGuideTimer);
      nudgeGuideTimer = setTimeout(() => clearGuides(ctx), 900);
    };
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); delSel(ctx); }
    // R: ONE MEANING LEFT (decision 0013). A free rotation now has its own path (the handle on the
    // selection, and the Rotate 90° button): R no longer duplicates it. On a wall light / outlet /
    // RJ45, whose rotation is dictated by the wall, R keeps flipping it to the OTHER face.
    else if ((e.key === "r" || e.key === "R") && isSideable(p.type)) {
      e.preventDefault(); flipWallMountSide(ctx, p);
    }
    else if (e.key === "Escape") { clearSel(ctx); ctx.crochets.hideInspector?.(); render(ctx); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); nudge(-step, 0); }
    else if (e.key === "ArrowRight") { e.preventDefault(); nudge(step, 0); }
    else if (e.key === "ArrowUp") { e.preventDefault(); nudge(0, -step); }
    else if (e.key === "ArrowDown") { e.preventDefault(); nudge(0, step); }
  });
}
