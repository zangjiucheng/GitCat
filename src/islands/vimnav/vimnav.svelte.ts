// Vim-style keyboard navigation — controller (Svelte 5 runes singleton).
//
// Two complementary mechanisms, no bespoke per-surface state needed except
// for the canvas:
//   1. Canvas commit graph: j/k actually MOVE state.selectedRow (auto-
//      scrolling to keep it visible) — today's Arrow keys only scroll (see
//      legacy/main.ts's cv keydown handler), they're left untouched. gg/G
//      jump to the first/last commit; Ctrl-D/Ctrl-U move by roughly half a
//      viewport's worth of rows.
//   2. Generic DOM-list traversal: when focus is on a [tabindex="0"] row
//      inside a [data-vimnav-list] container (sidebar ref rows, the
//      filter-repo restore-backup list, the conflict resolver's file list,
//      the detail panel's file tree), j/k moves focus to the next/previous
//      such row. Every one of those rows ALREADY has its own Enter/Space
//      handler wired (checkout, select backup, select file, …) — this is
//      purely a focus-mover, it adds no new activation logic anywhere.
//
// Always-on, no setting: nothing in GitCat's existing keybinding catalog
// conflicts with h/j/k/l/g/G/Ctrl-D/Ctrl-U//, and both gitui and tig (the
// tools this feature is modeled on) ship vim-nav on by default. "?" toggles
// a minimal help overlay so the feature is still discoverable.
//
// This island never imports ipc/env — like every other controller, the
// real/demo decision belongs to main.ts, not here (this feature has no
// demo-mode branch at all: it's pure keyboard plumbing, identical in both).

import * as bridge from "../../legacy/bridge";

// ── text-input guard ────────────────────────────────────────────────────
// The one existing precedent for this anywhere in the codebase is
// legacy/main.ts's Cmd/Ctrl+Z handler (`!e.target.closest("input,textarea,
// [contenteditable=true]")`) — extended here to also exclude `select`,
// since Sidebar.svelte's branch-from dropdown wasn't covered by the
// original and would otherwise have "j"/"k" hijacked while open.
export function isTextInputFocused(el: Element | null): boolean {
  return !!el?.closest("input, textarea, select, [contenteditable=true]");
}

// ── generic DOM-list focus traversal ────────────────────────────────────
// Never wraps (stops at the first/last row) — matches how a real cursor
// doesn't wrap in tig/gitui. Returns whether a [data-vimnav-list] container
// was found at all, so the caller knows whether to fall back to moving the
// canvas selection instead.
export function moveDomFocus(dir: 1 | -1): boolean {
  const active = document.activeElement;
  if (!active) return false;
  const container = active.closest("[data-vimnav-list]");
  if (!container) return false;
  const rows = Array.from(container.querySelectorAll<HTMLElement>('[tabindex="0"]'));
  if (!rows.length) return true;
  const idx = rows.indexOf(active as HTMLElement);
  if (idx < 0) {
    // Focus is inside the container but not itself on a navigable row (e.g.
    // the container itself has focus) — land on the first/last row.
    rows[dir > 0 ? 0 : rows.length - 1].focus();
    return true;
  }
  const next = idx + dir;
  if (next >= 0 && next < rows.length) rows[next].focus();
  return true;
}

// ── canvas commit-graph selection ───────────────────────────────────────
// scrollRowIntoView mirrors the one formula cmdk.svelte.ts's jump()/
// bisectdrawer.svelte.ts's focusBisectCurrent()/legacy main.ts's
// reloadGraph() each independently duplicate — factored into one place
// here rather than a fourth copy.
function scrollRowIntoView(row: number) {
  bridge.state.scrollTarget = bridge.clampScroll(row * bridge.layout.rowH - bridge.view.cssH * 0.4);
}

export function moveCanvasSelection(dir: 1 | -1) {
  const n: number = bridge.G?.N ?? 0;
  if (!n) return;
  const cur: number = bridge.state.selectedRow;
  const next = cur < 0 ? (dir > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, cur + dir));
  bridge.select(next);
  scrollRowIntoView(next);
}

export function jumpCanvasSelection(pos: "first" | "last") {
  const n: number = bridge.G?.N ?? 0;
  if (!n) return;
  const row = pos === "first" ? 0 : n - 1;
  bridge.select(row);
  scrollRowIntoView(row);
}

export function pageCanvasSelection(dir: 1 | -1) {
  const n: number = bridge.G?.N ?? 0;
  if (!n) return;
  const rowH = bridge.layout.rowH || 1;
  const rowsPerHalfPage = Math.max(1, Math.floor((bridge.view.cssH * 0.5) / rowH));
  const cur: number = bridge.state.selectedRow < 0 ? 0 : bridge.state.selectedRow;
  const next = Math.max(0, Math.min(n - 1, cur + dir * rowsPerHalfPage));
  bridge.select(next);
  scrollRowIntoView(next);
}

// ── "gg" chord detection ─────────────────────────────────────────────────
// A bare "g" arms a short window; a second "g" within it completes the
// chord (mirrors vim/tig's gg = jump-to-top). Module-level, not $state:
// this is never rendered, just a timing latch.
const GG_TIMEOUT_MS = 600;
let pendingGAt = 0;

export function noteNonGKey() {
  pendingGAt = 0;
}

/** Call on every bare "g" keydown; returns true once the SECOND "g" of a
 * "gg" chord arrives within GG_TIMEOUT_MS (and resets the pending state). */
export function noteGKey(now: number = Date.now()): boolean {
  if (pendingGAt && now - pendingGAt <= GG_TIMEOUT_MS) {
    pendingGAt = 0;
    return true;
  }
  pendingGAt = now;
  return false;
}

function anyOtherScrimOpen(): boolean {
  return !!document.querySelector(".scrim.on");
}

// ── help overlay (the only reactive state this island owns) ────────────
class VimNavState {
  helpOpen = $state(false);

  toggleHelp() {
    if (!this.helpOpen && anyOtherScrimOpen()) return; // don't cover another open modal
    this.helpOpen = !this.helpOpen;
  }
  closeHelp() {
    this.helpOpen = false;
  }
}
export const vimnavCtrl = new VimNavState();

// ── the single global dispatch entry point (view wires this to keydown) ─
// "/" is deliberately NOT handled here — Cmdk.svelte's own onWindowKeydown
// owns it (opens the same palette as Ctrl/Cmd+K), guarded by
// isTextInputFocused the same way, so there's exactly one place that binding
// lives rather than two competing handlers.
export function handleGlobalKeydown(e: KeyboardEvent) {
  if (isTextInputFocused(e.target as Element | null)) return;

  if (e.key === "Escape") {
    if (vimnavCtrl.helpOpen) {
      e.preventDefault();
      vimnavCtrl.closeHelp();
    }
    return;
  }

  // BUG FIX: every bare vim-style binding below (j/k/g/G/?) used to match on
  // `e.key` alone — but `KeyboardEvent.key` is the SAME "k" whether or not
  // Ctrl/Cmd is held, only `e.ctrlKey`/`e.metaKey` say so separately. That
  // meant Ctrl/Cmd+K (opening the command palette — Cmdk.svelte's own
  // separate listener) ALSO tripped this file's "k" -> scroll-up handler:
  // the palette opened AND the canvas selection moved underneath it. Only
  // Ctrl/Cmd+D and +U (page down/up, just below) are actually MEANT to fire
  // with a modifier held — every bare-letter binding here must NOT, so
  // `noModifier` gates all of them at once. Alt is included defensively
  // (nothing in this app currently binds an Alt+letter shortcut, but a bare
  // vim key firing under Alt would be equally wrong on principle); Shift is
  // deliberately EXCLUDED from this check — "G" and "?" are themselves only
  // reachable via Shift on a standard layout, so excluding it would break
  // them entirely, not guard them.
  const noModifier = !e.ctrlKey && !e.metaKey && !e.altKey;

  if (noModifier && e.key === "?") {
    e.preventDefault();
    vimnavCtrl.toggleHelp();
    return;
  }
  if (vimnavCtrl.helpOpen) return; // don't act on nav keys while help is up

  if (noModifier && (e.key === "j" || e.key === "k")) {
    e.preventDefault();
    const dir = e.key === "j" ? 1 : -1;
    noteNonGKey();
    if (moveDomFocus(dir)) return;
    if (!anyOtherScrimOpen()) moveCanvasSelection(dir);
    return;
  }
  if (noModifier && e.key === "g") {
    const completed = noteGKey();
    if (completed) {
      e.preventDefault();
      if (!anyOtherScrimOpen()) jumpCanvasSelection("first");
    }
    return;
  }
  if (noModifier && e.key === "G") {
    noteNonGKey();
    e.preventDefault();
    if (!anyOtherScrimOpen()) jumpCanvasSelection("last");
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === "d" || e.key === "u")) {
    noteNonGKey();
    e.preventDefault();
    if (!anyOtherScrimOpen()) pageCanvasSelection(e.key === "d" ? 1 : -1);
    return;
  }
  noteNonGKey();
}
