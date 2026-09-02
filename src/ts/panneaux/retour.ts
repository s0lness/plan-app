// src/ts/panneaux/retour.ts: FEEDBACK: a free-text note from inside the app, no account, on
// either door.
//
// THE BUTTON IS NEVER HIDDEN, unlike Share/Invite (hidden or toast off `!SYNC_ON`/household-only):
// the button isn't what can fail here, SENDING is. `envoyer()` NEVER clears the textarea on
// anything but a confirmed 200: losing what someone already typed is the one thing this must never do.

import { $ } from "../noyau/dom.ts";
import { FEEDBACK_URL, SYNC_ON, avecPlan } from "../fil/drapeaux.ts";

let _envoiEnCours = false;

function dire(msg: string, estErreur?: boolean): void {
  const h = $("retourHint");
  if (!h) return;
  h.textContent = msg;
  h.classList.toggle("err", !!estErreur);
}

/** An empty or whitespace-only note is not a report. Mirrors the server's own `texte_requis`
 *  refusal, so the dialog can say so before ever reaching for the network. */
function retourValide(texte: string): boolean {
  return texte.trim().length > 0;
}

async function envoyer(): Promise<void> {
  if (_envoiEnCours) return;
  const ta = $("retourText") as HTMLTextAreaElement | null;
  const contactEl = $("retourContact") as HTMLInputElement | null;
  const btn = $("retourSend") as HTMLButtonElement | null;
  const texte = ta ? ta.value : "";
  if (!retourValide(texte)) { dire("Write something first.", true); return; }

  // THE SANDBOX CASE: file:// and the claude.ai artifact have no network at all (`SYNC_ON`
  // false). The text is left exactly as typed, never cleared, so it can still be copied by
  // hand; this is not a different code path from a failed fetch below, it is the SAME one, taken
  // before a request that could never succeed is even attempted.
  if (!SYNC_ON) {
    dire("This only works in the online app: nothing was sent, but your text is still here.", true);
    return;
  }

  _envoiEnCours = true;
  if (btn) btn.disabled = true;
  try {
    const r = await fetch(avecPlan(FEEDBACK_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        texte,
        contact: contactEl ? contactEl.value : "",
        ua: (typeof navigator !== "undefined" && navigator.userAgent) || "",
      }),
    });
    if (!r.ok) throw r;
    // The dialog closing IS the confirmation (decision 0014, "l'app se tait"): no banner first.
    if (ta) ta.value = "";
    if (contactEl) contactEl.value = "";
    setTimeout(fermerRetour, 300);
  } catch (_) {
    dire("Could not send: check your connection. Your text is still here: try again, or copy it.", true);
  } finally {
    _envoiEnCours = false;
    if (btn) btn.disabled = false;
  }
}

function ouvrirRetour(): void {
  const d = $("retourDlg");
  dire("");
  if (d) d.hidden = false;
  ($("retourText") as HTMLTextAreaElement | null)?.focus();
}

function fermerRetour(): void {
  const d = $("retourDlg");
  if (d) d.hidden = true;
}

export function brancherRetour(): void {
  $("btnFeedback")?.addEventListener("click", ouvrirRetour);
  $("retourClose")?.addEventListener("click", fermerRetour);
  $("retourDlg")?.addEventListener("pointerdown", (e) => { if (e.target === $("retourDlg")) fermerRetour(); });
  $("retourDlg")?.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Escape") { e.stopPropagation(); fermerRetour(); } });
  $("retourSend")?.addEventListener("click", () => { void envoyer(); });
}
