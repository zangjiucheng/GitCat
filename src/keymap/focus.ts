// The focus contract for a scope: what gets focused on open, what Tab may
// reach while it is open, and what gets focus back on close.
//
// Why this is the registry's job and not each island's. Islands mount with
// `mount(..., { target: document.body })` (src/main.ts), which appends them
// AFTER the topbar, the sidebar and #detail in document order. Tab out of any
// open modal therefore walks the whole app chrome — behind an opaque scrim —
// before it reaches the modal's own first control. Four surfaces already
// declare aria-modal="true" with nothing backing it. Every island fixing that
// for itself would be 30 copies of the same 40 lines, each subtly different.
//
// Zero app imports, same three reasons as chord.ts: loadable by the codegen,
// unit-testable without a module graph, and safe to pull in at boot.

/**
 * Is this element hidden, for the purpose of "can Tab reach it"?
 *
 * The visibility check is LOAD-BEARING, not a nicety. GitCat's 31 scrims are
 * toggled with `class:on` rather than being unmounted, so every closed modal's
 * buttons are still in the DOM and still match the focusable selector. Without
 * this filter, Tab inside one open modal would cycle through the controls of
 * every other modal in the app.
 *
 * It tests `visibility`, NOT a layout box, because that is how those scrims
 * actually hide: index.html's `.scrim` rule is `opacity:0; visibility:hidden`,
 * with no `display:none` anywhere. A closed scrim's buttons therefore keep a
 * non-null offsetParent and real client rects — an offsetParent-only check
 * would let every one of them through. `visibility` inherits, so one lookup on
 * the element answers for its whole ancestor chain.
 *
 * The layout branch below catches the other case, an ancestor with
 * `display:none`, which does NOT show up in the element's own computed display.
 */
function hasLayout(doc: Document): boolean {
  // jsdom implements no layout at all: every node reports a null offsetParent
  // and zero client rects, so a layout-based check there would reject the
  // entire document. One probe on <html> says whether the branch can be
  // trusted. The real behaviour is covered in e2e/keymap-scopes.spec.ts.
  return doc.documentElement.getClientRects().length > 0;
}

export function isHidden(el: HTMLElement): boolean {
  const view = el.ownerDocument.defaultView;
  const cs = view?.getComputedStyle(el);
  if (cs && (cs.visibility === "hidden" || cs.visibility === "collapse" || cs.display === "none")) return true;
  if (!hasLayout(el.ownerDocument)) return false;
  // position:fixed legitimately has a null offsetParent, hence the rects check
  // rather than offsetParent alone.
  return el.offsetParent === null && el.getClientRects().length === 0;
}

/** Tab-reachable descendants of `root`, in document order. */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable=true]",
].join(", ");

export function focusablesIn(root: Element): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of root.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (el.hasAttribute("disabled") || el.getAttribute("aria-hidden") === "true") continue;
    if (isHidden(el)) continue;
    out.push(el);
  }
  return out;
}

/**
 * Confine Tab to `root`. Returns true iff the event was handled.
 *
 * Returning false rather than trapping when `root` holds nothing focusable is
 * deliberate: a modal that renders only text would otherwise swallow Tab and
 * strand the user with no way out at all, which is worse than letting focus
 * escape to the chrome behind it.
 */
export function trapTab(e: KeyboardEvent, root: Element): boolean {
  const items = focusablesIn(root);
  if (!items.length) return false;

  const active = document.activeElement as HTMLElement | null;
  const i = active ? items.indexOf(active) : -1;
  const back = e.shiftKey;

  // Focus outside the scope (the usual case on the very first Tab, when the
  // scrim itself or <body> has focus) lands on the first or last item rather
  // than wrapping from an arbitrary position.
  let next: HTMLElement;
  if (i < 0) next = back ? items[items.length - 1] : items[0];
  else if (back) next = i === 0 ? items[items.length - 1] : items[i - 1];
  else next = i === items.length - 1 ? items[0] : items[i + 1];

  next.focus();
  return true;
}

/**
 * What to give focus back to when a scope closes.
 *
 * Captured at push time. `isConnected` is checked at RESTORE time, not here:
 * several overlays (About.svelte is the clearest) destroy the node that had
 * focus rather than toggling `class:on`, so by the time the scope pops the
 * saved node may be gone from the document. Focusing a detached node silently
 * moves focus to <body>, which reads to the user as "the app lost my place".
 */
export function saveFocus(): HTMLElement | null {
  const el = document.activeElement;
  return el && el !== document.body ? (el as HTMLElement) : null;
}

export function restoreFocus(saved: HTMLElement | null): boolean {
  if (!saved || !saved.isConnected) return false;
  // A saved node that has since been hidden (its own modal closed underneath
  // this one) is as useless as a detached one.
  if (isHidden(saved)) return false;
  saved.focus();
  return true;
}

/**
 * Move focus into a scope on open.
 *
 * Prefers an explicit `[data-autofocus]`, then the first focusable, then the
 * container itself — which needs `tabindex="-1"` to accept focus at all, and is
 * the case that matters for a modal whose only content is text: without it,
 * focus stays behind the scrim and the Tab trap has nothing to trap.
 */
export function focusInto(root: HTMLElement): HTMLElement | null {
  const explicit = root.querySelector<HTMLElement>("[data-autofocus]");
  if (explicit) {
    explicit.focus();
    return explicit;
  }
  const first = focusablesIn(root)[0];
  if (first) {
    first.focus();
    return first;
  }
  if (root.tabIndex >= -1) {
    root.focus();
    return root;
  }
  return null;
}
