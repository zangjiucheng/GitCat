// Scopes. PR 1 declares the union and the API and registers NOTHING beyond
// "global"; the scope stack is exercised only by unit tests. Scopes arrive
// island by island from PR 2 onward.

export type ScopeId =
  | "global"      // bottom of the stack, always present, never popped
  | "graph"       // the commit canvas (legacy/main.ts:1374's element listener)
  | "list"        // focus inside [data-vimnav-list] (vimnav.svelte.ts:47)
  | "detail" | "workdir" | "sidebar" | "terminal"
  | "palette"     // Cmdk (Cmdk.svelte:96)
  | "modal"       // any ordinary island scrim
  | "help"        // #helpScrim (legacy/main.ts:1946) and the "?" overlay
  | "lightbox"    // PreviewLightbox
  | "danger";     // #dangerScrim / TamaConfirm — the [data-modal-blocking] pair

/**
 * `escape` has NO DEFAULT on purpose.
 *
 * legacy/main.ts:2543 is `document.addEventListener("keydown",e=>{ if
 * (e.key==="Escape"){ disarmDanger(); } })` — no open-check, no guard, no
 * preventDefault — so today Escape typed into ANY modal stacked above the
 * danger scrim silently disarms the armed destructive confirmation behind it.
 * Forcing every scope to declare its Escape contract is how that class of bug
 * stops being writable.
 *
 *   "own"         this scope's Escape binding runs and dispatch STOPS.
 *   "transparent" Escape continues to the scope below.
 *   "native"      dispatch stops and does NOT preventDefault — for the
 *                 terminal, where Escape is a real character readline and vim
 *                 both want (Terminal.svelte registers no
 *                 attachCustomKeyEventHandler; see Cmdk.svelte:26-29).
 */
export interface ScopeSpec {
  readonly id: ScopeId;
  /** Higher wins. The stack is kept sorted by (rank, activation order). */
  readonly rank: number;
  /** The walk STOPS at this scope: nothing below it is reachable. The typed
   *  replacement for the `document.querySelector(".scrim.on")` probe repeated
   *  at vimnav.svelte.ts:139, Cmdk.svelte:30 and :45, CodeSearch.svelte:23. */
  readonly modal?: true;
  readonly escape: "own" | "transparent" | "native";
  /** Debug label for dump(); normally the controller's file name. */
  readonly owner?: string;
}

/**
 * Per-ACTIVATION options, as opposed to ScopeSpec's per-scope ones. Two
 * different modals both push scope "modal" but each brings its own element,
 * so this is what pushScope takes and ScopeSpec is what defineScope takes.
 */
export interface ScopeOpts {
  /** The scope's DOM root. Required for the Tab trap and for focusing into it;
   *  omit only for a scope with no UI of its own. */
  readonly el?: HTMLElement | null;
  /** Confine Tab to `el` while this is the top scope. Default true when `el`
   *  is given. Set false for a surface that owns Tab itself — the palette
   *  cycles results with it, and the terminal must hand it to the shell. */
  readonly trapTab?: boolean;
  /** Move focus into `el` on push. Default true when `el` is given. */
  readonly autoFocus?: boolean;
  /** Give focus back to whatever had it, on release. Default true. */
  readonly restoreFocus?: boolean;
  /**
   * How this activation closes. The table carries ONE `modal.close` binding
   * for Escape; the activation supplies the behaviour, so migrating an island
   * adds no table row and the close logic stays with the controller that owns
   * the state. Omit for a scope Escape should pass through.
   */
  readonly onEscape?: () => void;
}

export interface ScopeHandle {
  readonly id: ScopeId;
  readonly token: number;
  /** Idempotent. A double release is a no-op, not a pop of someone else's
   *  scope — which is what the token is for. */
  release(): void;
}

/**
 * Chords the OS or a Tauri PREDEFINED menu item already owns. None of these can
 * ever appear in ACCELERATORS, so the (chord, scope) uniqueness gate is blind
 * to a collision with them unless it is told. Sourced from menu.rs:3-8 (the
 * predefined Edit items — the comment there notes those shortcuts "don't work
 * at all in a Tauri webview's text inputs" without them) and menu.rs:82
 * (File's .close_window()).
 */
export const RESERVED: readonly { readonly chord: string; readonly why: string }[] = [
  { chord: "Mod+KeyX", why: "predefined Edit > Cut (menu.rs:3-8)" },
  { chord: "Mod+KeyC", why: "predefined Edit > Copy (menu.rs:3-8)" },
  { chord: "Mod+KeyV", why: "predefined Edit > Paste (menu.rs:3-8)" },
  { chord: "Mod+KeyA", why: "predefined Edit > Select All (menu.rs:3-8)" },
  { chord: "Mod+KeyW", why: "predefined File > .close_window() (menu.rs:82)" },
  { chord: "Mod+KeyQ", why: "predefined Quit (menu.rs:61, and File on non-macOS :87)" },
  { chord: "Mod+KeyM", why: "predefined Window > minimize (macOS)" },
  { chord: "Mod+KeyH", why: "macOS Hide (app menu)" },
];
