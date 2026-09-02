// src/ts/gestes/pose.ts: PLACEMENT: ARM, AIM, PLACE.
//
// G-21 (you see what you're placing during the gesture: `resolveColor`/`withAlpha` read the CSS
// variable before appending alpha, one implementation `makePlacePreview` for hover/drag/palette),
// G-22 (placement is drag-and-drop, the click arms it; anti-stacking `STACK_RING`, 24 offsets,
// after bounding to the cell), G-1 (armed placement arms through `armGesture`; INHERITED,
// FLAGGED, NOT FIXED: `startPaletteDrag`'s own mouse listeners on `window` don't raise
// `gestureActive`, so a focus loss during that specific drag leaves the ghost on screen), G-16
// (depth follows the wall downward, via `v5PlaceWallMount`).
//
// NO IMPLICIT GLOBAL STATE: plan/view/viewport arrive through `ctx`. What stays private to the
// module is THE ARMED PLACEMENT.

import type { Contexte } from "../app/contexte.ts";
import type { Meuble, Ouverture, PlanV5 } from "../partage/plan.ts";
import type { ItemCatalogue } from "../catalogue/catalogue.ts";
import { v5Touch } from "../app/contexte.ts";
import { TYPEMAP, isWallMount, layerOf } from "../catalogue/catalogue.ts";
import { $, COARSE } from "../noyau/dom.ts";
import { WALL, clamp, safeDim } from "../noyau/nombres.ts";
import { v5Seg } from "../modele/murs.ts";
import { NO_WALL_MSG, meubleSnapReach, meubleWallSnap, wallSnapReach } from "../modele/espace.ts";
import { autoName, mk } from "../modele/creation.ts";
import {
  v5FlushPlaceNarrowed, v5NearestWall, v5PlaceWallMount, v5WallMountSide,
} from "../modele/edition.ts";
import { v5NewId } from "../fil/identite.ts";
import { armGesture } from "./sortie.ts";
import { isTouchEvt, measureMode, spaceHeld } from "./etat-pointeur.ts";
import { pushHistory, undo } from "../historique/pile.ts";
import { save, saveOpts } from "../app/persistance.ts";
import { toast } from "../app/toast.ts";
import { render } from "../rendu/rendu.ts";
import { selReplace } from "../rendu/selection.ts";
import { aptToScreen, screenToApt } from "../rendu/vue.ts";
import { resolveColor, withAlpha } from "../rendu/couleurs.ts";
import { doorArcSVG, pieceIconSVG } from "../rendu/icones.ts";

/** The VIEW's center in apartment cm: the fallback when the cursor has never hovered the plan. */
function viewCenterApt(ctx: Contexte): { x: number; y: number } {
  const r = ctx.viewport.getBoundingClientRect();
  return screenToApt(ctx, r.width / 2, r.height / 2);
}

// ---- PREVIEW, WITH NO MUTATION WHATSOEVER (ported from src/js/05) -------------------------------------------
// Where and how a wall-mounted `type` object will land if dropped at apartment point (ax,ay).
// Returns the final placement + the targeted wall segment (apartment cm), or null if no wall in reach.
// The actual placement stays `v5PlaceWallMount`: a single attachment logic, not two. The probe
// EXISTS so that a refusal has nothing to undo (cf. `placeNewPieceAt`).
// `maxDist` is REQUIRED, like for `v5NearestWall`: the old fallback `wallSnapReach()` depends on the
// current zoom, hence the VIEW; letting it guess here would make the function impure without saying so.

export interface ApercuMural {
  cx: number;
  cy: number;
  /** degrees, already normalized within [0,360[ */
  rot: number;
  w: number;
  h: number;
  /** the targeted wall segment, in apartment cm */
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export function wallMountPreviewApt(
  P: PlanV5 | null | undefined,
  type: string,
  ax: number,
  ay: number,
  maxDist: number,
): ApercuMural | null {
  const t: Partial<ItemCatalogue> = TYPEMAP[type] || {};
  const nw = v5NearestWall(P, ax, ay, maxDist);
  if (!nw) return null;
  const w = nw.w, s = v5Seg(w), ow = Math.min(t.w || 60, s.L);
  let tc = (ax - w.a[0]) * s.ux + (ay - w.a[1]) * s.uy;
  tc = clamp(tc, ow / 2, Math.max(ow / 2, s.L - ow / 2));
  const side = v5WallMountSide(P, w, s, nw.x, nw.y, ax, ay);
  const ang = Math.atan2(s.uy, s.ux) * 180 / Math.PI + (side ? 180 : 0);
  return {
    cx: w.a[0] + s.ux * tc, cy: w.a[1] + s.uy * tc, rot: ((Math.round(ang) % 360) + 360) % 360,
    w: ow, h: t.h || WALL, ax: w.a[0], ay: w.a[1], bx: w.b[0], by: w.b[1],
  };
}

// ---- placing a piece of furniture, centered on an APARTMENT point (or the view's center if apt==null) ----
// A wall-mounted object (window/door/wall light/outlet/RJ45) becomes a parametric OPENING on the
// nearest wall; everything else is a piece of furniture in apartment cm, bounded to its cell.
// Placing a piece whose LAYER is hidden used to create it invisible AND unselectable: you click
// "Wall light" while Lighting is unchecked and (visibly) nothing happens. We turn the relevant
// layer back on when adding. The layer is a PERSONAL setting (js/02): it does not enter
// the history, so Ctrl+Z does remove the object but leaves the layer turned on.
export function ensureLayerVisible(ctx: Contexte, type: string): boolean {
  const L = layerOf(type);
  if (L === "opening") return false;
  const key: "layLight" | "layPlug" | "layFurn" =
    (L === "light") ? "layLight" : (L === "plug" ? "layPlug" : "layFurn");
  if (ctx.etat.opts[key] !== false) return false;
  ctx.etat.opts[key] = true;
  saveOpts(ctx);
  try { ctx.gestes.syncLayerToggles?.(); } catch (_) { /* the toggles will come with their own batch */ }
  return true;
}

// ---- anti-stacking ---------------------------------------------------------------------------
// Ten clicks on the palette used to place ten pieces of furniture at the SAME pixel: the screen showed one, the
// furniture list counted ten, and the occupied area lied. So we offset each successive placement at the
// same point, in a ring around the cursor (as a duplicate does) rather than refusing the
// placement: ten clicks on "Chair" really are ten chairs, simply all visible.
const STACK_RING: readonly (readonly [number, number])[] = [
  [0, 0], [20, 20], [-20, 20], [-20, -20], [20, -20], [40, 0], [0, 40], [-40, 0], [0, -40],
  [40, 40], [-40, 40], [-40, -40], [40, -40], [60, 20], [20, 60], [-60, -20], [-20, -60],
  [60, 60], [-60, 60], [-60, -60], [60, -60], [80, 0], [0, 80], [-80, 0],
];

function unstackPiece(ctx: Contexte, p: Meuble, c: { x: number; y: number }): Meuble {
  const P = ctx.etat.plan;
  const taken = (): boolean =>
    (P.pieces || []).some((q) => q !== p && !isWallMount(q.type) && q.x === p.x && q.y === p.y);
  if (!taken()) return p;
  for (const [dx, dy] of STACK_RING) {
    if (!dx && !dy) continue;
    p.x = Math.round(c.x - p.w / 2) + dx; p.y = Math.round(c.y - p.h / 2) + dy;
    if (!taken()) return p;
  }
  return p;
}

// Same ring, but for a pasted GROUP: we offset the WHOLE group, never an isolated object, otherwise
// the relative layout that pasting promises to preserve would be destroyed on the first try.
// `pts` = each piece's wanted position.
export function unstackGroup(ctx: Contexte, list: Meuble[], pts: { x: number; y: number }[]): boolean {
  const P = ctx.etat.plan;
  const pose = (ox: number, oy: number): void => list.forEach((p, i) => {
    const q = pts[i]!; p.x = q.x + ox; p.y = q.y + oy;
  });
  const taken = (): boolean => list.some((p) => (P.pieces || []).some((q) =>
    q !== p && !isWallMount(q.type) && list.indexOf(q) < 0 && q.x === p.x && q.y === p.y));
  pose(0, 0);
  if (!taken()) return false;
  for (const [dx, dy] of STACK_RING) {
    if (!dx && !dy) continue;
    pose(dx, dy);
    if (!taken()) return true;
  }
  return true;
}

export function placeNewPieceAt(
  ctx: Contexte,
  type: string,
  apt: { x: number; y: number } | null,
): Meuble | Ouverture | null {
  const P = ctx.etat.plan;
  const t: Partial<ItemCatalogue> = TYPEMAP[type] || {};
  const wall = isWallMount(type);
  // A wall-mounted object is NEVER placed outside a wall. We PROBE first (wallMountPreviewApt mutates
  // nothing): a refusal therefore has nothing to undo. Before, we used to push the history then call
  // undo() to catch up, but an undo can rewind further than expected, and it polluted the
  // redo stack.
  const wpt = wall ? (apt || viewCenterApt(ctx)) : null;
  if (wall && !wallMountPreviewApt(P, type, wpt!.x, wpt!.y, wallSnapReach(ctx.vue.scale))) {
    toast(NO_WALL_MSG, { geste: true }); return null;
  }
  pushHistory(ctx);
  ensureLayerVisible(ctx, type);
  if (wall) {
    const op = v5PlaceWallMount(P, type, wpt!.x, wpt!.y, wallSnapReach(ctx.vue.scale), {
      newId: (prefix) => v5NewId(prefix),
      autoName: (base) => autoName(P, base),
    }, ctx.etat.opts);
    if (op) {
      // The old `v5PlaceWallMount` used to paint itself (`v5Touch/selReplace/render/openInspector`);
      // that's screen work, and it is now the caller's responsibility (modele/edition.ts).
      v5Touch(ctx); selReplace(ctx, op.id); render(ctx); ctx.crochets.openInspector?.();
      const dit = v5FlushPlaceNarrowed(); if (dit) toast(dit, { geste: true });
      save(ctx);
      return op;
    }
    toast(NO_WALL_MSG, { geste: true }); undo(ctx); return null;   // safety net (the probe already said yes)
  }
  const c = apt || viewCenterApt(ctx);
  const p = mk(P, type, Math.round(c.x - (t.w || 60) / 2), Math.round(c.y - (t.h || 60) / 2));
  p.id = String(p.id);
  P.pieces.push(p);
  unstackPiece(ctx, p, c);
  // THE WALL MAGNET, at drop time too (same mechanism and reach as the drag): dropped with its back
  // near a wall, a piece of furniture lands flush against it, oriented with the wall, rather than a
  // few centimetres off.
  const aimante = meubleWallSnap(P, p, meubleSnapReach(ctx.vue.scale));
  if (aimante) { p.x = aimante.x; p.y = aimante.y; p.rot = aimante.rot; }
  v5Touch(ctx);
  selReplace(ctx, p.id); render(ctx); ctx.crochets.openInspector?.();
  return p;
}


// ---- SHARED PLACEMENT PREVIEW ------------------------------------------------------------------
// YOU SEE THE OBJECT, NOT A BOX. The ghost used to be a plain rectangle: 1.5 px border,
// `background = t.color+"55"` where `t.color` is `var(--seat)`: so the string `var(--seat)55`,
// which is NOT a valid CSS color, hence IGNORED. All that was left was a one-pixel
// transparent outline, over a busy floor plan: measured headless, the rendered ghost's `backgroundColor`
// = `rgba(0,0,0,0)`. On screen, you literally saw nothing until you let go.
// The ghost now draws the object's REAL ICON (pieceIconSVG, the same drawing as the
// floor plan, door arc included), at the right size (cm × vScale) and the right orientation.
// The targeted wall segment is highlighted, and a REFUSAL is spelled out before the release.
// Everything is position:fixed on <body>, no render() per frame, recomputed in a
// requestAnimationFrame. (No CSS filter: cf. GPU white-screen.) A SINGLE implementation,
// served to armed hover, armed drag AND dragging from the palette: three copies would have
// diverged at the first fix.

export interface ApercuPose {
  /** track the pointer, at the screen's rate */
  move(x: number, y: number): void;
  /** track the pointer NOW (a gesture's first frame: nothing should flicker) */
  moveNow(x: number, y: number): void;
  setShown(v: boolean): void;
  /** idempotent: the ghost never survives the release */
  destroy(): void;
}

export function makePlacePreview(ctx: Contexte, type: string): ApercuPose {
  const t: Partial<ItemCatalogue> = TYPEMAP[type] || {};
  // A type absent from the catalog can come neither from the palette nor from an armed placement. If it
  // happened anyway, its dimensions equal NaN and the browser ignores a NaN width: exactly as
  // in the old client. We do not substitute 60 cm, that would be a ghost lying about what's being placed.
  const tw = t.w ?? NaN, th = t.h ?? NaN;
  const wallish = isWallMount(type);
  const col = resolveColor(t.color);
  const ghost = document.createElement("div");
  ghost.className = "place-ghost";
  ghost.style.borderColor = col;
  ghost.style.background = withAlpha(t.color, t.soft ? 0.12 : 0.18);
  ghost.style.borderRadius = t.round ? "50%" : (t.opening ? "1px" : (type === "gaine" ? "0" : "3px"));
  document.body.appendChild(ghost);
  let hl: HTMLElement | null = null;
  if (wallish) {
    hl = document.createElement("div");
    hl.className = "place-wall-hl";
    document.body.appendChild(hl);
  }
  // A refusal is STATED, it is not guessed from an opacity level. The chip follows the pointer.
  const say = document.createElement("div");
  say.className = "place-say"; say.hidden = true;
  document.body.appendChild(say);
  // `entre`: has the pointer EVER been over the plan? As long as it hasn't, a ghost still on the
  // rail simply shows what's being held (this is the normal start of a drag from the palette, and
  // of a simple click on a thumbnail): attaching an "outside the plan" refusal to it would flash a
  // reproach on every click. Once entered, leaving again is a real bail-out, and that gets said.
  let rafId = 0, cx = 0, cy = 0, dead = false, shown = true, iconKey = "", entre = false;
  // The icon is only rebuilt if the type or the dimensions change (a wall-mounted object shrinks on a
  // short wall): otherwise we'd rebuild an SVG on every mouse frame.
  const setIcon = (w: number, h: number): void => {
    const k = `${type}|${Math.round(w)}|${Math.round(h)}`;
    if (k === iconKey) return;
    iconKey = k;
    let html = "";
    if (type === "door") html += doorArcSVG(w, 0, 1, resolveColor("var(--open)"));   // a brand-new door: hinges on the left, swinging inward
    html += pieceIconSVG(type, w, h);
    ghost.innerHTML = html;
    const d = ghost.querySelector<SVGElement>(".darc");
    if (d) {
      const aw = safeDim(w * ctx.vue.scale); d.style.left = "0px"; d.style.top = "0px";
      d.style.width = aw + "px"; d.style.height = aw + "px";
    }
  };
  const refuse = (msg: string): void => {
    ghost.classList.add("refuse");
    if (hl) hl.hidden = true;
    say.hidden = false; say.textContent = msg;
    say.style.left = cx + "px"; say.style.top = (cy + 22) + "px";
  };
  const accept = (): void => { ghost.classList.remove("refuse"); say.hidden = true; };
  // "Flat" ghost: catalog dimensions, no rotation, centered on the pointer.
  const flat = (): void => {
    const gw = Math.max(3, tw * ctx.vue.scale), gh = Math.max(3, th * ctx.vue.scale);
    setIcon(tw, th);
    ghost.style.transform = "";
    ghost.style.width = gw + "px"; ghost.style.height = gh + "px";
    ghost.style.left = (cx - gw / 2) + "px"; ghost.style.top = (cy - gh / 2) + "px";
  };
  const paint = (): void => {
    rafId = 0;
    if (dead) return;
    ghost.hidden = !shown; say.hidden = say.hidden || !shown; if (hl) hl.hidden = hl.hidden || !shown;
    if (!shown) return;
    const vr = ctx.viewport.getBoundingClientRect();
    const dedans = !(cx < vr.left - 40 || cx > vr.right + 40 || cy < vr.top - 40 || cy > vr.bottom + 40);
    if (dedans) entre = true;
    // Releasing outside the plan places NOTHING (cf. the end of the gesture): the ghost says so before the release.
    if (!dedans) { flat(); if (entre) refuse("Outside the plan: nothing will be placed."); else accept(); return; }
    if (!wallish) { flat(); accept(); return; }
    const apt = screenToApt(ctx, cx - vr.left, cy - vr.top);
    const pv = wallMountPreviewApt(ctx.etat.plan, type, apt.x, apt.y, wallSnapReach(ctx.vue.scale));
    if (!pv) {
      flat();
      refuse("No wall here: bring the cursor closer to a wall.");
      return;
    }
    accept();
    const c = aptToScreen(ctx, pv.cx, pv.cy);
    const gw = Math.max(3, pv.w * ctx.vue.scale), gh = Math.max(3, pv.h * ctx.vue.scale);
    setIcon(pv.w, pv.h);
    ghost.style.width = gw + "px"; ghost.style.height = gh + "px";
    ghost.style.left = (vr.left + c.x - gw / 2) + "px"; ghost.style.top = (vr.top + c.y - gh / 2) + "px";
    ghost.style.transform = `rotate(${pv.rot}deg)`;
    if (hl) {
      const sa = aptToScreen(ctx, pv.ax, pv.ay), sb = aptToScreen(ctx, pv.bx, pv.by);
      const len = Math.hypot(sb.x - sa.x, sb.y - sa.y);
      const ang = Math.atan2(sb.y - sa.y, sb.x - sa.x) * 180 / Math.PI;
      hl.hidden = false;
      hl.style.left = (vr.left + sa.x) + "px"; hl.style.top = (vr.top + sa.y) + "px";
      hl.style.width = len + "px"; hl.style.transform = `rotate(${ang}deg)`;
    }
  };
  return {
    move(x, y) { cx = x; cy = y; if (!rafId) rafId = requestAnimationFrame(paint); },
    moveNow(x, y) { cx = x; cy = y; if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } paint(); },
    // Armed hover has nothing to show as long as the pointer is not over the plan.
    setShown(v) { shown = !!v; if (!shown) { ghost.hidden = true; say.hidden = true; if (hl) hl.hidden = true; } },
    destroy() {
      if (dead) return; dead = true;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      ghost.remove(); say.remove(); if (hl) hl.remove();
    },
  };
}

// ---- PLACEMENT IS A DRAG-AND-DROP, AND THE CLICK ARMS IT ----------------------------------------
// A click on a thumbnail used to make the object APPEAR at the cursor's last known position:
// somewhere other than under the hand, hence unpredictable (and this is exactly what produced "ten
// quick clicks, ten objects at the same pixel"). The placement gesture is now DRAG-AND-DROP, with its
// own preview. The click itself is not left mute (a thumbnail that doesn't respond to a click reads as a
// glitch): it ARMS the placement, exactly like "Draw a wall" arms then gets used, and the
// next tap on the plan places the object UNDER THE POINTER, preview included. This is also the
// TOUCH path: on a finger, a drag from the drawer would require closing the drawer mid-gesture;
// tapping the thumbnail then tapping the spot is robust, and nothing is left landing
// "at the center of the view" without having been designated.

let _poseArme: string | null = null;   // armed type, or null
let posePreview: ApercuPose | null = null;   // preview of the currently armed placement gesture
let poseHoverOn = false;               // is armed hover listening to the pointer?
/** The armed type, or null. Read by the keyboard (Escape / Enter) and by test probes. */
export const poseArme = (): string | null => _poseArme;

function poseArmeLabel(): string {
  const t: Partial<ItemCatalogue> = TYPEMAP[_poseArme || ""] || {};
  return t.name || _poseArme || "";
}

// ---- ARMED = ALREADY IN THE MIDDLE OF PLACING ------------------------------------------------------------
// The preview used to only appear on `pointerdown` over the plan: between the click on the thumbnail and the
// tap, the cursor crossed the plan showing nothing, and you didn't know what you were about to place until
// it was placed. As soon as placement is armed, the ghost FOLLOWS the pointer (hidden while over the
// rail or the toolbar: there's nothing to aim at there).
// The context travels through a closure installed at the same time as the listener: `pointermove` on
// `window` cannot receive it as an argument.
let _hoverMove: ((ev: PointerEvent) => void) | null = null;

function poseHoverMove(ctx: Contexte, ev: PointerEvent): void {
  if (!posePreview) return;
  const vr = ctx.viewport.getBoundingClientRect();
  const dedans = ev.clientX >= vr.left && ev.clientX <= vr.right && ev.clientY >= vr.top && ev.clientY <= vr.bottom;
  posePreview.setShown(dedans);
  if (dedans) posePreview.move(ev.clientX, ev.clientY);
}

function setPoseArme(ctx: Contexte, type: string | null): string | null {
  _poseArme = type || null;
  document.querySelectorAll<HTMLElement>("#palette .pitem").forEach((el) =>
    el.classList.toggle("armed", !!_poseArme && el.dataset["type"] === _poseArme));
  const app = document.querySelector(".app"); if (app) app.classList.toggle("posing", !!_poseArme);
  if (posePreview) { posePreview.destroy(); posePreview = null; }
  if (_poseArme) {
    posePreview = makePlacePreview(ctx, _poseArme);
    posePreview.setShown(false);
    if (!poseHoverOn) {
      _hoverMove = (ev: PointerEvent): void => poseHoverMove(ctx, ev);
      window.addEventListener("pointermove", _hoverMove, true); poseHoverOn = true;
    }
  } else if (poseHoverOn) {
    if (_hoverMove) window.removeEventListener("pointermove", _hoverMove, true);
    _hoverMove = null; poseHoverOn = false;
  }
  return _poseArme;
}

/**
 * Escape (gestes/clavier.ts) and any mode change disarm. Only Escape's caller passes a message:
 * it is the one deliberate "cancel" gesture, the other two disarm as a SIDE EFFECT of something
 * else (retapping the armed thumbnail, another tool taking over) and stay silent, the thumbnail
 * losing its `.armed` highlight already showing it (decision 0014, "l'app se tait").
 * (`cancelPoseArme` in the old client.)
 */
export function annulerPoseArmee(ctx: Contexte, msg?: string): boolean {
  if (!_poseArme) return false;
  setPoseArme(ctx, null);
  if (msg) toast(msg, { geste: true });
  return true;
}

/**
 * Entry point for a TAP on a palette thumbnail, and for `Enter`/`Space` on a focused one
 * (`addPaletteTapped`). A MOUSE click no longer reaches this (decision 0013: the one path for a
 * mouse is `startPaletteDrag`, below); a finger has no drag ghost, so tap-then-tap is what
 * remains for it. Always returns null: placement is ARMED, it hasn't placed anything.
 */
export function armerPose(ctx: Contexte, type: string): string | null {
  if (_poseArme === type) { annulerPoseArmee(ctx); return null; }
  const app = document.querySelector(".app");
  const drawerOpen = !!app && app.classList.contains("rail-open");
  setPoseArme(ctx, type);
  if (drawerOpen) ctx.gestes.railOpen?.(false);   // the drawer covers the plan: you need to see where you're placing
  // A touch has no drag ghost and no hover cursor: this is the ONLY sign of the armed mode it
  // gets, so it stays, unlike the mouse's own toast below (kept too: it names Esc, which nothing
  // else on screen does).
  toast(COARSE
    ? `Tap the plan to place “${poseArmeLabel()}”.`
    : `Click the plan to place “${poseArmeLabel()}” (Esc cancels).`,
    { geste: true });
  return null;
}

/**
 * Pressing on the PLAN consumes the armed placement: press, drag to aim (the preview follows), release.
 * In capture: G-14, an armed tool wins over anything beneath it (same rule as js/53).
 */
function brancherPoseArmeeSurLePlan(ctx: Contexte): void {
  ctx.viewport.addEventListener("pointerdown", (e: PointerEvent) => {
    if (!_poseArme) return;
    if (e.button !== undefined && e.button !== 0) return;
    // surfaces placed WITHIN the viewport keep their own clicks (chat, banners)
    const cible = (e.target instanceof Element) ? e.target : null;
    if (cible && cible.closest(".chat-panel,.chat-btn,.boot-notice,.app-toast")) return;
    if (measureMode() || spaceHeld()) {
      annulerPoseArmee(ctx);
      return;
    }
    e.preventDefault(); e.stopPropagation();
    const type = _poseArme;
    // The armed HOVER preview is already there (setPoseArme): we reuse it, we don't recreate it.
    const pv = posePreview || (posePreview = makePlacePreview(ctx, type));
    pv.setShown(true);
    pv.moveNow(e.clientX, e.clientY);
    let last = { x: e.clientX, y: e.clientY }, annule = false;
    const move = (ev: PointerEvent): void => {
      last = { x: ev.clientX, y: ev.clientY }; pv.setShown(true); pv.move(ev.clientX, ev.clientY);
    };
    const finish = (evt?: Event | null): void => {
      window.removeEventListener("pointermove", move);
      setPoseArme(ctx, null);     // destroys the preview (hover included) and disarms the thumbnail
      pv.destroy();               // idempotent: the gesture's ghost never survives the release
      if (annule) return;
      const ev = evt as PointerEvent | null | undefined;
      const p = (ev && ev.clientX != null) ? { x: ev.clientX, y: ev.clientY } : last;
      const vr = ctx.viewport.getBoundingClientRect();
      if (p.x < vr.left - 40 || p.x > vr.right + 40 || p.y < vr.top - 40 || p.y > vr.bottom + 40) {
        toast("Nothing was placed: the drop point is outside the plan.", { geste: true }); return;
      }
      placeNewPieceAt(ctx, type, screenToApt(ctx, p.x - vr.left, p.y - vr.top));
    };
    const cancel = (): void => { annule = true; };   // the ghost preview vanishing already shows it
    window.addEventListener("pointermove", move);
    armGesture(finish, null, cancel);       // guaranteed end (cf. gestes/sortie.ts)
  }, true);
}

// ---- palette drag-to-place ----
function startPaletteDrag(
  ctx: Contexte,
  e: PointerEvent,
  type: string,
  srcEl: HTMLElement | null,
): void {
  if (isTouchEvt(e)) return;   // touch: no drag ghost; the tap ARMS the placement (armerPose)
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();
  const pv = makePlacePreview(ctx, type);
  pv.moveNow(e.clientX, e.clientY);
  let entre = false;
  const move = (ev: PointerEvent): void => {
    const r = ctx.viewport.getBoundingClientRect();
    if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) entre = true;
    pv.move(ev.clientX, ev.clientY);
  };
  const up = (ev: PointerEvent): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    pv.destroy();
    // outside the viewport (released on the rail, the toolbar...): place nothing
    const vr = ctx.viewport.getBoundingClientRect();
    if (ev.clientX < vr.left - 40 || ev.clientX > vr.right + 40 || ev.clientY < vr.top - 40 || ev.clientY > vr.bottom + 40) {
      // A DRAG THAT BAILS OUT SAYS SO. Two exceptions, both deliberately silent: a simple
      // click on the thumbnail (the pointer never left the rail), and returning to the starting
      // thumbnail (the `click` that follows ARMS the placement and announces it itself, our banner would be
      // covered a frame later by its own).
      const cible = (ev.target instanceof Element) ? ev.target : null;
      const surSource = !!(srcEl && cible && cible.closest("#palette .pitem") === srcEl);
      if (entre && !surSource) toast("Nothing was placed: the thumbnail was released outside the plan.", { geste: true });
      return;
    }
    // A drag that SUCCEEDS replaces the armed intent; a simple click on the thumbnail also
    // passes through here (released on the rail, so no placement) and must NOT disarm anything, otherwise
    // the click would disarm itself a frame after arming.
    setPoseArme(ctx, null);
    placeNewPieceAt(ctx, type, screenToApt(ctx, ev.clientX - vr.left, ev.clientY - vr.top));
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ---- THE WIRING (the palette itself, js/08, is not part of this batch) -----------------------------
// Three listeners per thumbnail in the old client, installed when the palette was BUILT. Here the
// palette isn't built yet when bootstrap calls `brancherPalette`: so we DELEGATE
// from `#palette`, which gives exactly the same three listeners, valid for any
// thumbnail present or yet to come, and which makes the wiring independent of batch ordering.

const vignetteDe = (t: EventTarget | null): HTMLElement | null =>
  (t instanceof Element) ? t.closest<HTMLElement>("#palette .pitem") : null;

let _palBranchee = false;

export function brancherPalette(ctx: Contexte): void {
  if (_palBranchee) return;
  _palBranchee = true;
  brancherPoseArmeeSurLePlan(ctx);
  const pal = $("palette");
  if (!pal) return;
  pal.addEventListener("click", (e) => {
    const it = vignetteDe(e.target); if (!it) return;
    if (e.detail >= 2) return;
    // MOUSE: a plain click arms nothing (decision 0013), only a drag places an object
    // (`startPaletteDrag`, wired on `pointerdown` below). TOUCH: a tap has no drag ghost to hold,
    // so it stays the one way to aim without dragging.
    if (!isTouchEvt(e as unknown as PointerEvent)) return;
    armerPose(ctx, it.dataset["type"] || "");
  });
  pal.addEventListener("keydown", (e) => {
    const it = vignetteDe(e.target); if (!it) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); armerPose(ctx, it.dataset["type"] || ""); }
  });
  pal.addEventListener("pointerdown", (e) => {
    const it = vignetteDe(e.target); if (!it) return;
    startPaletteDrag(ctx, e, it.dataset["type"] || "", it);
  });
}
