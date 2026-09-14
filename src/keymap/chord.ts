// Chord parsing, matching and formatting. ZERO imports by design: this file is
// loaded by the codegen script under `node --experimental-strip-types`, by
// vitest in jsdom, and at src/main.ts line 5 before any app module exists.
// Nothing here touches the DOM beyond the KeyboardEvent *type*.

export const ALT = 1 << 0;
export const SHIFT = 1 << 1;

export type MatchOn = "code" | "key";
export type Platform = "macos" | "win" | "linux";

export interface Chord {
  /** e.code value ("KeyZ" | "Backslash" | "Digit1") when matchOn === "code";
   *  e.key value ("j" | "G" | "/" | "?" | "Escape") when matchOn === "key". */
  readonly value: string;
  readonly matchOn: MatchOn;
  /** "Mod+" was present. Requires EXACTLY ONE of ctrlKey/metaKey.
   *  Deliberately NOT platform-resolved — see matchChord. */
  readonly mod: boolean;
  /** Exact ALT|SHIFT bits. Compared as an exact mask, never "at least". */
  readonly extra: number;
  /** Shift is layout noise for this key. The SHIFT bit is masked out of BOTH
   *  sides before comparison. Set for bare punctuation: Cmdk.svelte:41-43
   *  states that "/" is Shift-typed on AZERTY and QWERTZ and that rejecting
   *  Shift "would make the key unreachable for those layouts entirely". */
  readonly shiftOptional: boolean;
  /** Windows/Linux AltGr reports ctrlKey && altKey TOGETHER. That exact pair
   *  (and only that pair) is stripped before the compare. Bare punctuation
   *  only — a Mod+ chord has no AltGr story. */
  readonly altGrTolerant: boolean;
  /** The spec string this was parsed from. Used by formatChord, dumpKeymap
   *  and the uniqueness key. */
  readonly spec: string;
}

const CODE_TOKEN =
  /^(?:Key[A-Z]|Digit[0-9]|Backslash|Comma|Period|Slash|Semicolon|Quote|Backquote|Minus|Equal|BracketLeft|BracketRight)$/;
// Named keys match on e.key, NOT e.code: numpad Enter reports code
// "NumpadEnter" but key "Enter", and every handler in the tree today keys off
// e.key for these (legacy/main.ts:1948, :2543; vimnav.svelte.ts:170, :243).
const NAMED_KEY =
  /^(?:Escape|Enter|Tab|Backspace|Delete|Home|End|PageUp|PageDown|Arrow(?:Up|Down|Left|Right)|F(?:[1-9]|1[0-2]))$/;
const LETTER = /^\p{L}$/u;
const DIGIT = /^[0-9]$/;

/**
 * Grammar (PR 1 subset):
 *   "Mod+KeyZ"  "Mod+Shift+KeyU"  "Mod+Backslash"  "Mod+Comma"  "Alt+KeyK"
 *   "j"  "G"          bare letter      -> e.key
 *   "/"  "?"  "+"  "-" bare punctuation -> e.key, shiftOptional, altGrTolerant
 *   "Digit1"          bare digit       -> e.code
 *   "Escape" "Enter"  named key        -> e.key
 *
 * A literal `Ctrl+` token (meaning literal Control on macOS, for a future vim
 * Ctrl-D) is deliberately NOT in the grammar yet: nothing in PR 1 needs it and
 * shipping unused modifier semantics invites a wrong binding later. Add it in
 * the PR that ports vimnav.
 *
 * `matchOn` may be overridden per binding; `shiftOptional` may not — it is a
 * property of the key class, and letting a table row turn it off is how the
 * AZERTY "/" regression comes back.
 */
export function parseChord(spec: string, matchOnOverride?: MatchOn): Chord {
  let rest = spec;
  let mod = false;
  let extra = 0;
  for (;;) {
    if (rest.startsWith("Mod+") && rest.length > 4) { mod = true; rest = rest.slice(4); continue; }
    if (rest.startsWith("Shift+") && rest.length > 6) { extra |= SHIFT; rest = rest.slice(6); continue; }
    if (rest.startsWith("Alt+") && rest.length > 4) { extra |= ALT; rest = rest.slice(4); continue; }
    break;
  }
  if (!rest) throw new Error(`keymap: chord "${spec}" has no key token`);

  let matchOn: MatchOn;
  let shiftOptional = false;
  let altGrTolerant = false;

  if (CODE_TOKEN.test(rest)) {
    matchOn = "code";
  } else if (NAMED_KEY.test(rest)) {
    matchOn = "key";
  } else if (rest.length === 1 && LETTER.test(rest)) {
    // Bare letter: vim keys bind to the GLYPH. vimnav.svelte.ts models tig/gitui,
    // so a Dvorak user pressing the cap labelled "j" must get "j".
    matchOn = "key";
  } else if (rest.length === 1 && DIGIT.test(rest)) {
    throw new Error(`keymap: write a bare digit as "Digit${rest}", not "${rest}"`);
  } else if (rest.length === 1) {
    // Bare punctuation. e.key, and Shift is layout noise.
    // legacy/main.ts:1381-1385 argues the same for "+": "Deliberately e.key and
    // not e.code: e.code is a physical position, and '+' sits on BracketRight
    // on QWERTZ, so only the glyph is portable."
    matchOn = "key";
    shiftOptional = true;
    altGrTolerant = true;
  } else {
    throw new Error(`keymap: unrecognised key token "${rest}" in chord "${spec}"`);
  }

  if (matchOnOverride) matchOn = matchOnOverride;
  return { value: rest, matchOn, mod, extra, shiftOptional, altGrTolerant, spec };
}

/**
 * The whole of the "exact four-bit mask" rule.
 *
 * NOTE on `mod`. Every handler in the tree today accepts meta-OR-ctrl on BOTH
 * platforms (legacy/main.ts:2170, :2183, :2191, :2198, :2207, :2407;
 * main.ts:546, :568; Cmdk.svelte:24; CodeSearch.svelte:17). Resolving Mod to
 * Meta-on-macOS would silently un-bind Ctrl+Z for Mac users on external PC
 * keyboards. `ctrl + meta !== 1` reproduces today's behaviour exactly while
 * still REJECTING ⌃⌘Z, which "at least one" accepted.
 */
export function matchChord(c: Chord, e: KeyboardEvent): boolean {
  let ctrl = e.ctrlKey;
  let alt = e.altKey;
  // AltGr must be stripped BEFORE the ctrl/meta compare, not after: otherwise
  // the ctrl bit rejects the chord before tolerance can ever apply.
  if (c.altGrTolerant && !c.mod && ctrl && alt) { ctrl = false; alt = false; }

  const n = (ctrl ? 1 : 0) + (e.metaKey ? 1 : 0);
  if (c.mod ? n !== 1 : n !== 0) return false;

  let need = c.extra;
  let got = (alt ? ALT : 0) | (e.shiftKey ? SHIFT : 0);
  if (c.shiftOptional) { need &= ~SHIFT; got &= ~SHIFT; }
  if (need !== got) return false;

  return c.matchOn === "code" ? e.code === c.value : e.key === c.value;
}

/** Stable canonical key for the (chord, scope) uniqueness gate and the trie.
 *  Order-insensitive: "Shift+Mod+KeyU" and "Mod+Shift+KeyU" MUST collide. */
export function chordKey(c: Chord): string {
  const m = (c.mod ? "M" : "") + (c.extra & SHIFT ? "S" : "") + (c.extra & ALT ? "A" : "");
  return `${m}|${c.matchOn}:${c.value}`;
}

const DISPLAY: Record<string, string> = {
  Backslash: "\\", Comma: ",", Period: ".", Slash: "/", Semicolon: ";",
  Quote: "'", Backquote: "`", Minus: "-", Equal: "=",
  BracketLeft: "[", BracketRight: "]",
};
function keyLabel(c: Chord): string {
  if (c.matchOn === "key") return c.value.length === 1 ? c.value.toUpperCase() : c.value;
  if (c.value.startsWith("Key")) return c.value.slice(3);
  if (c.value.startsWith("Digit")) return c.value.slice(5);
  return DISPLAY[c.value] ?? c.value;
}

/** "⌘⇧U" on macOS, "Ctrl+Shift+U" elsewhere. */
export function formatChord(c: Chord, platform: Platform): string {
  const mac = platform === "macos";
  const parts: string[] = [];
  if (c.mod) parts.push(mac ? "⌘" : "Ctrl");
  if (c.extra & SHIFT) parts.push(mac ? "⇧" : "Shift");
  if (c.extra & ALT) parts.push(mac ? "⌥" : "Alt");
  parts.push(keyLabel(c));
  return mac ? parts.join("") : parts.join("+");
}

/** muda accelerator form: "CmdOrCtrl+Shift+F". Feeds keymap_generated.rs.
 *  Throws for an e.key-matched chord: muda takes key NAMES, not glyphs, which
 *  is itself why no bare-punctuation binding may declare dispatch:"accelerator". */
export function toAccelerator(c: Chord): string {
  if (c.matchOn !== "code" && !NAMED_KEY.test(c.value)) {
    throw new Error(`keymap: chord "${c.spec}" is glyph-matched and has no accelerator form`);
  }
  const parts: string[] = [];
  if (c.mod) parts.push("CmdOrCtrl");
  if (c.extra & SHIFT) parts.push("Shift");
  if (c.extra & ALT) parts.push("Alt");
  parts.push(c.matchOn === "code" ? keyLabel(c) : c.value);
  return parts.join("+");
}
