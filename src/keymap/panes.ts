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
import { focusablesIn } from "./focus.ts";

/** Marks a pane root in index.html. Three of them; see PANES below. */
export const PANE_ATTR = "data-pane";

/**
 * The three pane roots, and the scope each maps to.
 *
 * There are three TOP-LEVEL panes and one nested one. `main.ts` refuses to
 * mount Workdir a second time because it renders INSIDE #detail, swapped in by
 * DetailPanel when the working tree is selected — so the audit's ⌘1..4 is
 * ⌘1..3, and "workdir" is reached by focusing the detail pane rather than by a
 * chord of its own. It still gets a marker, because `closest()` resolves to the
 * innermost one and that is exactly what makes a bare `s` mean "stage" only
 * where staging exists.
 */
export const PANES: readonly { readonly name: string; readonly scope: ScopeId }[] = [
  { name: "graph", scope: "graph" },
  { name: "sidebar", scope: "sidebar" },
  { name: "detail", scope: "detail" },
  // NESTED inside the detail pane, not a fourth region: Workdir.svelte's
  // .d-view sits inside #detail, and paneScopeFor uses closest(), so focus in
  // the working tree resolves to "workdir" and focus on the detail pane's own
  // chrome (the tab strip) still resolves to "detail". That is what makes a
  // bare `s` mean "stage" only where staging exists, without a pushed scope
  // that would stay active after focus left for the sidebar.
  { name: "workdir", scope: "workdir" },
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
  // focusablesIn, NOT a raw [tabindex="0"] query. The raw query returns the
  // first tabbable DESCENDANT, and #detail's is #resizeDetail — its own resize
  // handle — so ⌘3 focused the splitter rather than the panel's content. Worse,
  // that handle is display:none in the bottom placement, so focus() was a
  // silent no-op while the chord still counted as handled. focusablesIn filters
  // hidden nodes (a collapsed pane, a closed <details>) for exactly this.
  //
  // Resize handles are skipped outright: they are chrome for sizing the pane,
  // never a place a "go to this pane" chord should land.
  const inner = focusablesIn(root).find((el) => !el.classList.contains("resize-handle"));
  (inner ?? root).focus();
  return true;
}
