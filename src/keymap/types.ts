import type { Chord, MatchOn, Platform } from "./chord.ts";
import type { ScopeId } from "./scopes.ts";

export type GuardName =
  | "repoOpen"
  | "notTextInput"        // input,textarea,[contenteditable=true] — the LEGACY form
  | "notTextInputOrSelect" // + select — vimnav.svelte.ts:36's stricter form
  | "noScrimOpen"          // document.querySelector(".scrim.on")
  | "noPopoverOpen"        // document.querySelector(".ref-pop") — NOT a scrim; see guards.ts
  | "notInTerminal"        // e.target.closest(".term-drawer")
  | "graphHasRows"
  | "inTauri";

export type HelpSection = "search" | "sync" | "view" | "navigate" | "actions";

export interface KeyCtx {
  readonly event: KeyboardEvent;
  readonly scope: ScopeId;
  readonly platform: Platform;
}

export type Guard = (ctx: KeyCtx) => boolean;
export type GuardTable = Readonly<Record<GuardName, Guard>>;

/**
 * The toggle rule, as a TYPE rather than only a registration-time throw.
 *
 * On Windows/Linux a native accelerator AND the webview keydown both fire, so a
 * toggle bound to both cancels itself and the surface never opens. menu.rs:118
 * already refuses an accelerator for the "cmdk" item for exactly this reason
 * ("⌘K already works via the existing JS keydown listener"). Making it a
 * discriminated union catches it in `pnpm check` instead of at app boot; the
 * runtime throw stays as a second layer for a future plugin-supplied path.
 */
export type DispatchRule =
  | { readonly dispatch: "js" | "accelerator"; readonly toggle?: true }
  | { readonly dispatch: "both"; readonly toggle?: never };

interface BindingBase {
  readonly id: string;
  /** One chord, or >1 for a SEQUENCE (e.g. ["g","g"]). PR 1 ships no sequences. */
  readonly chords: readonly string[];
  readonly scope: ScopeId;
  readonly when?: readonly GuardName[];

  /**
   * DEFAULT FALSE — opt in, never opt out. Typed as the LITERAL `true`, not
   * `boolean`: `allowInTextInput: false` is a compile error, so the dangerous
   * default can never be written out in one diff and flipped in the next.
   */
  readonly allowInTextInput?: true;

  /** Resolved before the stack walk regardless of depth. Reserve for the
   *  palette and "?"; every entry here is a binding that cannot be shadowed. */
  readonly layer?: "always";

  /**
   * OPTIONAL. An accelerator-only entry has no JS side at all: menu.rs:318-322
   * says "new-window" is "handled directly here, not forwarded to the frontend
   * ... there's nothing for JS to do". A mandatory run() forces a fake one, and
   * a fake one eventually gets called.
   *
   * Returning `false` means "matched, but not handled after all": the walk
   * continues OUTWARD from the scope below, and preventDefault has NOT been
   * called yet, so the event can still reach a legacy listener. Contract for
   * authors: DECIDE FIRST, ACT SECOND — a run() that does half its work before
   * returning false will double-fire. This is a review rule, not a testable
   * invariant; it is written down here because it cannot be enforced.
   */
  run?(ctx: KeyCtx): void | false;

  /** Default true. `false` for anything whose browser default must survive. */
  readonly preventDefault?: false;

  readonly destructive?: true;
  /** The muda item id from menu.rs's MenuItemBuilder::with_id. Only bindings
   *  with dispatch "accelerator"|"both" AND a menu id reach keymap_generated.rs. */
  readonly menu?: { readonly id: string };
  readonly help?: { readonly section: HelpSection; readonly order: number; readonly hidden?: true };
  /** Gated against the `en` locale ONLY. See i18n.svelte.ts:13-20. */
  readonly labelKey: string;
  readonly platform?: Platform;
  /** Per-binding override of parseChord's class rule. shiftOptional is
   *  deliberately NOT overridable. */
  readonly matchOn?: MatchOn;

  // ── migration fields. Deleted from this type once the table is all live. ──
  /**
   * "shadow": the dispatcher MATCHES, counts, and continues walking — no claim,
   * no run, no preventDefault. The old listener stays authoritative.
   * Default "live".
   */
  readonly mode?: "shadow" | "live";
  /**
   * Required while mode === "shadow": a free-text pointer to the listener this
   * binding shadows, mirrored by a `// @keymap-owns <id>` comment above it.
   * CI asserts exactly one marker for a shadow binding and ZERO for a live one.
   */
  readonly owns?: string;
}

export type Binding = BindingBase & DispatchRule;

/** Post-compilation. Never constructed by hand. */
export interface Compiled {
  readonly b: Binding;
  readonly seq: readonly Chord[];
  readonly guards: readonly Guard[];
}

export interface Tables {
  /** Compiled entries whose FIRST chord is e.code-matched, bucketed by code. */
  readonly byCode: ReadonlyMap<string, readonly Compiled[]>;
  readonly byKey: ReadonlyMap<string, readonly Compiled[]>;
  readonly always: readonly Compiled[];
  readonly escapeByScope: ReadonlyMap<ScopeId, Compiled>;
  /** id -> compiled, for dump() and the tests. */
  readonly byId: ReadonlyMap<string, Compiled>;
  readonly size: number;
}
