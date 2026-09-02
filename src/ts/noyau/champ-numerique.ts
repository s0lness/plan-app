// src/ts/noyau/champ-numerique.ts: THE ONLY NUMERIC-INPUT GUARD.
//
// G-17: nothing applies until the value is valid. Three outcomes: an impossible keystroke or a
// value definitively out of bounds REJECTS (back to the last valid value, marked red, with a
// message that gives the bound); an incomplete value (empty, or too small but still growing)
// applies NOTHING, marked "pending"; a valid value applies after a 220ms typing pause.
//
// G-18: the server bounds what's dangerous, the client bounds what's sensible. `bounds()` can
// depend on the current object (an opening's width bounded by its wall's length); HTML
// `min`/`max` are REWRITTEN to match, always at least as strict as the server validator.
// `raison()` completes a rejection whose bound comes from elsewhere ("This wall is 10cm thick...").
//
// CONSEQUENCE FOR TESTS: a programmatically set value requires ~350ms of waiting, or a `blur`.

import { toast } from "../app/toast.ts";

export interface Bornes { min: number; max: number }

export interface ConfigChamp {
  /** The subject of the rejection sentence: "The width", "The depth". */
  label?: string;
  /** The unit written in the rejection sentence. "cm" by default. */
  unit?: string;
  min?: number;
  max?: number;
  /** The REAL bound at this moment. Recomputed on every judgment AND on every `__syncBounds`. */
  bounds?: () => Bornes;
  /** Where the bound comes from, when it's not from the field. Added to the rejection sentence. */
  raison?: () => string;
  /** The last valid value, the one a rejection hands back. */
  get: () => number | null | undefined;
  set: (v: number) => void;
  /** Empty = "no value" and not an error (the TV's inches). */
  optional?: boolean;
  clear?: () => void;
}

/**
 * The field, once wired, carries `__syncBounds()`: it's the caller (the inspector, the assistant)
 * that calls it again when the selected object changes, so the attributes follow.
 */
export interface ChampNumerique extends HTMLInputElement {
  __syncBounds?: () => void;
}

export function numField(el: HTMLElement | null, cfg: ConfigChamp): void {
  if (!el) return;
  const champ = el as ChampNumerique;
  let hold: ReturnType<typeof setTimeout> | 0 = 0;
  const box = (): HTMLElement => champ.closest<HTMLElement>(".in") || champ;
  const mark = (cls: "bad" | "pending" | null): void => {
    const b = box();
    b.classList.toggle("bad", cls === "bad");
    b.classList.toggle("pending", cls === "pending");
  };
  const bounds = (): Bornes => {
    const b = cfg.bounds ? cfg.bounds() : { min: cfg.min as number, max: cfg.max as number };
    return { min: Math.round(Number(b.min) || 0), max: Math.round(Number(b.max) || 0) };
  };
  const label = (): string => cfg.label || "This value";
  const refuse = (msg: string): void => {
    mark("bad"); toast(msg, { geste: true });
    if (hold) clearTimeout(hold);
    hold = 0;
    const v = cfg.get();
    champ.value = (v == null) ? "" : String(v);
    setTimeout(() => { if (box().classList.contains("bad")) mark(null); }, 1600);
  };

  /** "ok" | "pending" | "reject". Applies if "ok". */
  function judge(raw: unknown, committing: boolean): "ok" | "attente" | "refus" {
    const { min, max } = bounds();
    const unite = cfg.unit || "cm";
    if (champ.validity && champ.validity.badInput) {
      refuse(`${label()} must be digits (${min} to ${max} ${unite}).`); return "refus";
    }
    const s = String(raw == null ? "" : raw).trim();
    if (s === "") {
      if (!committing) { mark("pending"); return "attente"; }
      if (cfg.optional) { mark(null); if (cfg.clear) cfg.clear(); return "ok"; }
      refuse(`${label()} cannot be empty (${min} to ${max} ${unite}).`); return "refus";
    }
    if (!/^-?\d+$/.test(s)) {
      refuse(`${label()} must be digits (${min} to ${max} ${unite}).`); return "refus";
    }
    const n = parseInt(s, 10);
    const pourquoi = (): string => { const r = cfg.raison ? cfg.raison() : ""; return r ? (" " + r) : ""; };
    if (n > max || n < 0) {
      refuse(`${label()} must stay between ${min} and ${max} ${unite}: ${n} is refused.` + pourquoi());
      return "refus";
    }
    if (n < min) {
      // A prefix can still grow ("1" will become "180"): we wait, without applying anything.
      if (!committing && String(n).length < String(max).length) { mark("pending"); return "attente"; }
      refuse(`${label()} must stay between ${min} and ${max} ${unite}: ${n} is refused.` + pourquoi());
      return "refus";
    }
    mark(null);
    if (hold) clearTimeout(hold);
    if (committing) cfg.set(n);
    else hold = setTimeout(() => { hold = 0; cfg.set(n); }, 220);
    return "ok";
  }

  champ.addEventListener("input", () => { judge(champ.value, false); });
  champ.addEventListener("blur", () => { if (hold) clearTimeout(hold); hold = 0; judge(champ.value, true); mark(null); });
  champ.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") { if (hold) clearTimeout(hold); hold = 0; judge(champ.value, true); }
  });
  // The HTML attributes follow the real bound: no more `min=10` fronting a clamp at 5.
  champ.__syncBounds = (): void => { const { min, max } = bounds(); champ.min = String(min); champ.max = String(max); };
  champ.__syncBounds();
}

/** Re-call a field's bounds after a change of selected object. */
export function syncBounds(id: HTMLElement | null): void {
  const c = id as ChampNumerique | null;
  if (c && c.__syncBounds) c.__syncBounds();
}
