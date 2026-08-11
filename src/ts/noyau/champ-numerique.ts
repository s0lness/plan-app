// src/ts/noyau/champ-numerique.ts — THE ONLY NUMERIC-INPUT GUARD.
// Ported from src/js/00-noyau.js (`numField`), without changing a single rule or message.
//
// G-17. NOTHING APPLIES UNTIL THE VALUE IS VALID. Three outcomes, a single truth of
// bound:
//   · impossible keystroke (letters) or value definitively out of bounds -> REJECT: the field goes
//     back to the last valid value, marked in red, with a message that GIVES the bound;
//   · value still incomplete (empty field, or too small but still able to grow: typing
//     "1" before "180") -> we apply NOTHING, the field is marked "pending"; leaving the
//     field (or Enter) decides;
//   · valid value -> applied after a 220 ms pause in typing.
//
// **Before this fix**, the field used to apply on EVERY keystroke, silently folded back onto an
// arbitrary bound: typing letters set the furniture to 10 cm, "1" stored 5, so did "-50", and
// "3000" went through into a 12 m flat. Three bounds contradicted each other (the `min=10`
// attribute, the JS clamp `5..3000`, the server's `1..3000`). And without the typing pause, typing
// "3000" COMMITTED 3, then 30, then 300 along the way, and the final rejection handed back
// 300, a value nobody had wanted.
//
// G-18. THE SERVER BOUNDS WHAT'S DANGEROUS, THE CLIENT BOUNDS WHAT'S SENSIBLE. `bounds()` returns the
// REAL bound and can depend on the current object (an opening's width bounded by its wall's
// length, DEPTH bounded by that wall's THICKNESS, a piece of furniture's dimension bounded by the
// flat). The HTML `min`/`max` attributes are REWRITTEN to match: the field can no longer announce a
// bound the code doesn't respect. The client bound can be stricter than the server validator, never
// wider.
//
// `raison()` completes the rejection when the bound comes from SOMEWHERE OTHER than the field: "This
// wall is 10 cm thick: beyond that, the opening would cross both rooms." Without that
// word, "between 1 and 10 cm" reads as an arbitrary software limit and the gesture repeats without
// understanding why.
//
// CONSEQUENCE FOR TESTS: a value set programmatically requires ~350 ms of waiting, or a
// `blur`.

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
  const label = (): string => cfg.label || "Cette valeur";
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
