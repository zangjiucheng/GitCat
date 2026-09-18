// The sidebar's key actions.
//
// The focused ref is read out of the DOM, like the working tree's rows: local
// branches already carried `data-branch` and tags `data-tag`, so only the
// remote row needed a marker. Reading the DOM rather than a controller cursor
// keeps "which ref" and "which row has focus" the same question — there is no
// second cursor to drift out of sync with the first.

import * as bridge from "@/legacy/bridge";
import { sidebarCtrl } from "@/islands/sidebar/sidebar.svelte.ts";

export type RefKind = "branch" | "remote" | "tag";

export interface FocusedRef {
  readonly kind: RefKind;
  readonly name: string;
  readonly isCurrent: boolean;
  readonly el: HTMLElement;
}

export function focusedRef(doc: Document = document): FocusedRef | null {
  const el = doc.activeElement?.closest?.<HTMLElement>("[data-branch], [data-remote], [data-tag]");
  if (!el) return null;
  const branch = el.getAttribute("data-branch");
  if (branch) {
    // `.current` is the class the row already paints HEAD with, so the keyboard
    // and the eye agree on which branch is checked out.
    return { kind: "branch", name: branch, isCurrent: el.classList.contains("current"), el };
  }
  const remote = el.getAttribute("data-remote");
  if (remote) return { kind: "remote", name: remote, isCurrent: false, el };
  const tag = el.getAttribute("data-tag");
  if (tag) return { kind: "tag", name: tag, isCurrent: false, el };
  return null;
}

/** Anchor a popover on a focused row rather than on a pointer. */
function anchor(el: HTMLElement): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  // Left edge plus a nudge, vertically centred — where a right-click on the
  // row's label would have landed.
  return { x: Math.round(r.left + 12), y: Math.round(r.top + r.height / 2) };
}

function upstreamOf(name: string): string | null {
  const locals = (sidebarCtrl as unknown as { locals?: { name: string; upstream: string | null }[] }).locals;
  return locals?.find((b) => b.name === name)?.upstream ?? null;
}

/** Mutations in flight close every popover and no-op the actions behind them. */
function busy(): boolean {
  return !!(sidebarCtrl as unknown as { busy?: boolean }).busy;
}

export const sidebarKeys = {
  /**
   * Focus the ref filter.
   *
   * Restores the only keyboard route to #refFilter, which PR 1 removed along
   * with the duplicate ⌘⇧F binding (#148). It lives here as a SCOPED `f` rather
   * than as another ⌘⇧ chord, per #144's first rule.
   *
   * Expands the sidebar first, because focusing an input inside a collapsed
   * panel moves focus somewhere the user cannot see.
   */
  focusFilter(): false | void {
    bridge.expandSidebar();
    const el = document.getElementById("refFilter") as HTMLInputElement | null;
    if (!el) return false;
    // Next frame: the expand above changes a CSS variable, and focusing before
    // the panel has any width scrolls the input into a zero-width box.
    requestAnimationFrame(() => {
      el.focus();
      el.select?.();
    });
  },

  /** Open the focused row's actions popover — the sidebar's half of rule 3. */
  openMenu(): false | void {
    const ref = focusedRef();
    if (!ref) return false;
    // The ⋮ buttons and the mouse handlers refuse while a mutation is in
    // flight; a letter must not be the one way around that.
    if (busy()) return false;
    const { x, y } = anchor(ref.el);
    if (ref.kind === "branch") {
      // The real upstream, not null: legacy/main.ts's canvas path passes null
      // here, which makes the menu's push/pull entries read as "no upstream"
      // for a branch that has one.
      sidebarCtrl.openMenuAt(ref.name, ref.isCurrent, upstreamOf(ref.name), x, y);
      return;
    }
    if (ref.kind === "remote") {
      // A remote row has no management menu; its one action is the checkout
      // confirm, which is what double-clicking it opens.
      sidebarCtrl.openCheckoutConfirm(ref.name, true, x, y);
      return;
    }
    // Tags DO have a popover — openTagMenu, the same one the ⋮ button and
    // right-click open. An earlier comment here claimed they did not, which
    // left tag rows as the one ref kind without the actions chord every other
    // row gets. It takes the anchor ELEMENT rather than coordinates.
    sidebarCtrl.openTagMenu(ref.name, ref.el);
  },

  /**
   * Checkout the focused ref.
   *
   * Routed through openCheckoutConfirm, never checkout() directly: that dialog
   * is what handles a dirty working tree, and a bare letter must not decide on
   * the user's behalf what happens to uncommitted changes.
   */
  checkout(): false | void {
    const ref = focusedRef();
    if (!ref || ref.kind === "tag") return false;
    if (ref.isCurrent) return false; // already on it
    // checkout() itself no-ops while busy, so without this the confirm dialog
    // would open, be confirmed, and silently do nothing.
    if (busy()) return false;
    const { x, y } = anchor(ref.el);
    sidebarCtrl.openCheckoutConfirm(ref.name, ref.kind === "remote", x, y);
  },
};
