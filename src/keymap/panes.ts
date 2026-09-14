// Which pane is "active", for the purposes of a bare single-letter binding.
//
// THE DESIGN DECISION, because everything else follows from it: the active pane
// is DERIVED from document.activeElement at dispatch time, never stored.
//
// The stored alternative is what the audit originally proposed — a focusin
// listener maintaining a `$state` mirror — and it is wrong in a way that only
// shows up as an intermittent bug. `focusout` fires with relatedTarget null and
// NO following focusin whenever the focused element is removed or hidden, which
// is routine here: DetailPanel swaps Detail and Workdir whenever the working
// tree is selected, and every scrim hides its contents with class:on. A mirror
// therefore goes stale exactly when a pane disappears out from under the
// cursor, and a stale mirror sends the next keystroke to a pane that is no
// longer on screen.
//
// Deriving costs one closest() per keydown, on an event whose target is already
// in hand, and cannot go stale by construction.
//
// THE FALLBACK IS LOAD-BEARING. Focus lands outside every pane constantly — on
// a topbar button after a click, or on <body> after something was removed. If
// that meant "no pane", every vim key would die the moment a user clicked
// anything in the chrome, which would make this migration strictly worse than
// the window-level handlers it replaces. Outside-any-pane resolves to the
// graph, which is where those keys live today.

import type { ScopeId } from "./scopes.ts";

/** Marks a pane root in index.html. Three of them; see PANES below. */
export const PANE_ATTR = "data-pane";

/**
 * The three pane roots, and the scope each maps to.
 *
 * There is no workdir pane. `main.ts` refuses to mount Workdir a second time —
 * it renders INSIDE #detail, swapped in by DetailPanel when the working tree is
 * selected — so "workdir" is a state of the detail pane, not a region of its
 * own. The audit's ⌘1..4 is therefore ⌘1..3, and the workdir scope is pushed by
 * Workdir's own controller rather than derived from focus.
 */
export const PANES: readonly { readonly name: string; readonly scope: ScopeId }[] = [
  { name: "graph", scope: "graph" },
  { name: "sidebar", scope: "sidebar" },
  { name: "detail", scope: "detail" },
];

/** The pane scope for an element, or the graph when it is in none of them. */
export function paneScopeFor(el: Element | null): ScopeId {
  const root = el?.closest?.(`[${PANE_ATTR}]`);
  const name = root?.getAttribute(PANE_ATTR);
  const hit = name ? PANES.find((p) => p.name === name) : undefined;
  return hit ? hit.scope : "graph";
}

/** The pane scope right now. */
export function activePaneScope(doc: Document = document): ScopeId {
  return paneScopeFor(doc.activeElement);
}

/**
 * Move focus to a pane root and return whether it worked.
 *
 * Deliberately a plain .focus() rather than a scope override: DOM focus and
 * keyboard scope then cannot disagree, because the scope is read back out of
 * the focus this call just set. Anything that focuses a pane — a click, Tab, a
 * jump, this function — activates it by the same path.
 *
 * NOT routed through bridge.goToUncommitted() for the detail pane, tempting as
 * that is: it ends in `cv.focus()`, which would hand focus straight back to the
 * canvas and make the very next keystroke report "graph".
 */
export function focusPane(name: string, doc: Document = document): boolean {
  const root = doc.querySelector<HTMLElement>(`[${PANE_ATTR}="${name}"]`);
  if (!root) return false;
  // Prefer something already focusable inside the pane so the ring lands on a
  // real control; fall back to the root, which carries tabindex="-1".
  const inner = root.querySelector<HTMLElement>('[tabindex="0"]:not([disabled])');
  (inner ?? root).focus();
  return true;
}
