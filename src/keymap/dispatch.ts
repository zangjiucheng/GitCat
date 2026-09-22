import { matchChord } from "./chord.ts";
import type { Platform } from "./chord.ts";
import type { ScopeId, ScopeSpec } from "./scopes.ts";
import type { Compiled, GuardName, KeyCtx, Tables } from "./types.ts";

export const SEQUENCE_TIMEOUT_MS = 600; // generalises GG_TIMEOUT_MS (vimnav.svelte.ts:120)

export interface DispatchResult {
  /** The binding that ran. null when nothing was handled. */
  readonly ran: Compiled | null;
  /** A shadow binding that MATCHED. The equivalence measurement. */
  readonly shadowed: readonly Compiled[];
  /** True iff the caller should claim() + preventDefault. */
  readonly claim: boolean;
  readonly preventDefault: boolean;
}

const NONE: DispatchResult = { ran: null, shadowed: [], claim: false, preventDefault: false };

/** Reassigned in place every keydown. `run` MUST NOT retain it. */
const CTX: { event: KeyboardEvent; scope: ScopeId; platform: Platform } = {
  event: null as unknown as KeyboardEvent,
  scope: "global",
  platform: "linux",
};

// Per-event memo for the text-input probe, so a keydown that reaches three
// candidate bindings does ONE closest() rather than three.
let memoEvent: KeyboardEvent | null = null;
let memoText = false;
let memoSelect = false;

function textProbe(e: KeyboardEvent, withSelect: boolean): boolean {
  if (memoEvent !== e) {
    const el = e.target as Element | null;
    // Two variants, deliberately NOT unified. legacy/main.ts:2170, :2183, :2191,
    // :2198, :2207, :2409 and main.ts:552, :573 all use the 3-selector form;
    // vimnav.svelte.ts:30-37 adds `select` and documents why (Sidebar.svelte:431's
    // branch-from dropdown). Unifying is a real behaviour change — ⌘Z with that
    // dropdown focused would stop undoing — so it belongs in its own PR, not
    // here, and each binding names the variant its old handler used.
    memoText = !!el?.closest?.("input, textarea, [contenteditable=true]");
    memoSelect = !!el?.closest?.("input, textarea, select, [contenteditable=true]");
    memoEvent = e;
  }
  return withSelect ? memoSelect : memoText;
}

function guardsPass(
  c: Compiled,
  e: KeyboardEvent,
  scope: ScopeId,
  platform: Platform,
  /** Escape's dedicated path passes false — see the call site. */
  probeText = true,
): boolean {
  const b = c.b;
  if (b.platform && b.platform !== platform) return false;
  if (probeText && !b.allowInTextInput) {
    const wantsSelect = (b.when as readonly GuardName[] | undefined)?.includes("notTextInputOrSelect");
    if (textProbe(e, !!wantsSelect)) return false;
  }
  if (c.guards.length) {
    CTX.event = e; CTX.scope = scope; CTX.platform = platform;
    for (let i = 0; i < c.guards.length; i++) {
      if (!c.guards[i](CTX as KeyCtx)) return false;
    }
  }
  return true;
}

function fire(c: Compiled, e: KeyboardEvent, scope: ScopeId, platform: Platform, shadowed: Compiled[]): DispatchResult | null {
  // mode:"shadow" — count and CONTINUE the walk. Returning here instead would
  // let a shadow entry permanently mask a live twin in the same scope.
  if (c.b.mode === "shadow") { shadowed.push(c); return null; }
  CTX.event = e; CTX.scope = scope; CTX.platform = platform;
  if (c.b.run && c.b.run(CTX as KeyCtx) === false) return null; // declined — keep walking
  return { ran: c, shadowed, claim: true, preventDefault: c.b.preventDefault !== false };
}

/**
 * The single keydown decision. Pure: it reads the event and the tables, mutates
 * only module-local scratch, and never touches the DOM except through
 * `e.target.closest` inside textProbe.
 *
 * `stack` is outermost-first (["global", ...]); the walk runs top -> bottom.
 */
export function dispatch(
  e: KeyboardEvent,
  stack: readonly ScopeId[],
  specs: ReadonlyMap<ScopeId, ScopeSpec>,
  tables: Tables,
  platform: Platform,
): DispatchResult {
  // 0. IME bail, FIRST, before anything reads e.key.
  //    `grep -rn isComposing src/` returns nothing today and zh + ko both ship
  //    (i18n.svelte.ts:22). A Pinyin or Hangul user composes over bare j/k/g/?/
  //    constantly. Both tests are needed: isComposing is false for the FIRST
  //    keydown of a composition on several Windows/Linux IMEs, where only
  //    keyCode === 229 marks it.
  if (e.isComposing || e.keyCode === 229 || e.key === "Process" || e.key === "Dead") return NONE;

  // 1. Empty-table fast path. This is what makes the first commit of PR 1
  //    provably inert before the table is populated.
  if (tables.size === 0) return NONE;

  const shadowed: Compiled[] = [];

  // 2. Escape — a DEDICATED path, taken before layer:"always" and before the
  //    stack walk. Top scope only, then STOP. The "stop" is what lets the 36
  //    island Escape handlers keep working until each opts in, one at a time.
  // A BARE Escape only. The dedicated path exists for the dismiss GESTURE, and
  // it deliberately does not run matchChord — `escapeByScope` holds one entry
  // per scope and fires it on the key alone. That was fine while Escape was
  // never part of a larger chord, and stopped being fine the moment one was
  // needed: `terminal.focusOut` is Shift+Escape, and without this test the
  // terminal scope's `escape: "native"` swallowed it here, before the stack
  // walk could ever see it (found by the test, not by reading).
  //
  // The behaviour change is that a MODIFIED Escape no longer closes a dialog.
  // That was never designed — it fell out of the key-only match — and a
  // modified Escape is a different chord, which is the thing the rest of this
  // function already believes.
  if (e.key === "Escape" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    for (let i = stack.length - 1; i >= 0; i--) {
      const s = stack[i];
      const spec = specs.get(s);
      if (spec?.escape === "transparent") continue;
      if (spec?.escape === "native") return NONE;
      const c = tables.escapeByScope.get(s);
      // The text-input probe is SKIPPED for Escape, and it has to be: Escape
      // cannot be typed into a field, so the default deny would mean a dialog
      // could not be closed from any of its own inputs — which is most of the
      // time, since pushScope focuses into the dialog on open. Making it an
      // implicit property of the Escape path rather than an allowInTextInput
      // flag on each binding means no future scope can forget it.
      if (c && guardsPass(c, e, s, platform, false)) {
        const r = fire(c, e, s, platform, shadowed);
        if (r) return r;
      }
      break; // top non-transparent scope only
    }
    return shadowed.length ? { ...NONE, shadowed } : NONE;
  }

  // 3. layer:"always" — resolved regardless of stack depth.
  for (let i = 0; i < tables.always.length; i++) {
    const c = tables.always[i];
    if (!matchChord(c.seq[0], e)) continue;
    if (!guardsPass(c, e, c.b.scope, platform)) continue;
    const r = fire(c, e, c.b.scope, platform, shadowed);
    if (r) return r;
  }

  // 4. Stack walk, top -> bottom. Two Map.get calls on strings ALREADY
  //    materialised on the event — no template-literal key is ever built.
  const ca = tables.byCode.get(e.code);
  const cb = tables.byKey.get(e.key);
  if (!ca && !cb) return shadowed.length ? { ...NONE, shadowed } : NONE;

  for (let i = stack.length - 1; i >= 0; i--) {
    const s = stack[i];
    for (let bucket = 0; bucket < 2; bucket++) {
      const list = bucket === 0 ? ca : cb;
      if (!list) continue;
      for (let j = 0; j < list.length; j++) { // index loop: WebKit's baseline tier
        const c = list[j];                    // does not reliably elide an iterator
        if (c.b.scope !== s) continue;
        if (c.b.layer === "always") continue;  // already tried in step 3
        if (!matchChord(c.seq[0], e)) continue;
        if (!guardsPass(c, e, s, platform)) continue;
        const r = fire(c, e, s, platform, shadowed);
        if (r) return r;
      }
    }
    if (specs.get(s)?.modal) break; // a modal scope terminates the descent
  }

  return shadowed.length ? { ...NONE, shadowed } : NONE;
}

/** Tests only. */
export function resetDispatchMemo(): void { memoEvent = null; }
