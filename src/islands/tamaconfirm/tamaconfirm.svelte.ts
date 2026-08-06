// Tama-styled in-app confirm dialog — controller (Svelte 5 runes singleton).
//
// A lightweight, promise-based yes/no confirmation with Tama's face and the
// app's own modal chrome — for prompts that should NOT use an OS-native dialog
// (`window.confirm` / the dialog plugin's `ask`): those are unreliable in the
// release WKWebView (a synchronous confirm can silently return false when the
// UI thread is busy — see globalUndo's own history) and feel foreign to the app.
//
// NOT the heavy type-to-confirm danger gate (`armDanger` in legacy/main.ts) —
// that's for genuinely destructive, irreversible rewrites. This is for benign /
// reversible confirmations (e.g. "stash your changes, undo, then put them back?").
//
// Promise-based (like the mainlinepicker chooser) so a caller reads as a plain
// `const ok = await tamaConfirmCtrl.ask({...})`.

import { t } from "../../i18n/i18n.svelte.ts";

type Kind = "info" | "warning" | "danger";

type TamaConfirmOpts = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  kind?: Kind;
};

class TamaConfirmState {
  open = $state(false);
  title = $state("");
  message = $state("");
  confirmLabel = $state(t("tamaconfirm.confirm"));
  cancelLabel = $state(t("common.cancel"));
  kind = $state<Kind>("info");
  // Resolver for the in-flight ask() promise; null when nothing is open.
  private resolveFn: ((v: boolean) => void) | null = null;

  // Show the dialog and resolve true (confirm) / false (cancel, Esc, or a second
  // ask() opening over this one).
  ask(opts: TamaConfirmOpts): Promise<boolean> {
    this.settle(false); // never leave a prior dialog hanging
    this.title = opts.title;
    this.message = opts.message;
    this.confirmLabel = opts.confirmLabel ?? t("tamaconfirm.confirm");
    this.cancelLabel = opts.cancelLabel ?? t("common.cancel");
    this.kind = opts.kind ?? "info";
    this.open = true;
    return new Promise((resolve) => {
      this.resolveFn = resolve;
    });
  }

  confirm(): void {
    this.settle(true);
  }

  cancel(): void {
    this.settle(false);
  }

  private settle(v: boolean): void {
    this.open = false;
    const r = this.resolveFn;
    this.resolveFn = null;
    r?.(v);
  }
}

export const tamaConfirmCtrl = new TamaConfirmState();
