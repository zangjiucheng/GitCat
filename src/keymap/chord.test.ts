// The matcher. This is the file that has to be right for every other keyboard
// PR in the stack to be safe, because "at least Cmd/Ctrl" instead of an exact
// mask is what produced every bug PR 0 fixed.
import { describe, expect, it } from "vitest";
import { chordKey, formatChord, matchChord, parseChord, toAccelerator } from "./chord.ts";

/** A KeyboardEvent-shaped literal. jsdom's real constructor works too, but the
 *  matcher only ever reads these seven fields and a literal keeps each case on
 *  one line. */
function ev(p: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    ...p,
  } as KeyboardEvent;
}

describe("parseChord — key classes", () => {
  it("routes a Key*/Digit*/punctuation token to e.code", () => {
    expect(parseChord("Mod+KeyZ")).toMatchObject({ value: "KeyZ", matchOn: "code", mod: true });
    expect(parseChord("Digit1")).toMatchObject({ value: "Digit1", matchOn: "code", mod: false });
    expect(parseChord("Mod+Backslash")).toMatchObject({ value: "Backslash", matchOn: "code" });
    expect(parseChord("Mod+Comma")).toMatchObject({ value: "Comma", matchOn: "code" });
  });

  it("routes a named key to e.key, because numpad Enter reports code NumpadEnter", () => {
    expect(parseChord("Escape")).toMatchObject({ value: "Escape", matchOn: "key" });
    expect(parseChord("Enter")).toMatchObject({ value: "Enter", matchOn: "key" });
    expect(parseChord("F1")).toMatchObject({ value: "F1", matchOn: "key" });
    expect(parseChord("ArrowDown")).toMatchObject({ value: "ArrowDown", matchOn: "key" });
  });

  it("routes a bare letter to e.key so a Dvorak user gets the cap they pressed", () => {
    expect(parseChord("j")).toMatchObject({ value: "j", matchOn: "key", shiftOptional: false });
    expect(parseChord("G")).toMatchObject({ value: "G", matchOn: "key" });
  });

  it("makes an UPPERCASE bare letter shiftOptional, because that is how it is typed", () => {
    // Found by an e2e run, not by reading: "S" can only be produced WITH Shift
    // held, so an exact mask demanding shiftKey === false made the chord
    // unmatchable forever — and silently, since nothing throws.
    expect(parseChord("S")).toMatchObject({ value: "S", shiftOptional: true });
    expect(parseChord("j")).toMatchObject({ shiftOptional: false });
  });

  it("makes bare punctuation shiftOptional AND altGrTolerant", () => {
    // "/" is Shift-typed on AZERTY/QWERTZ and "]" is AltGr+9 on QWERTZ.
    for (const p of ["/", "?", "+", "-", "]", "["]) {
      expect(parseChord(p)).toMatchObject({ matchOn: "key", shiftOptional: true, altGrTolerant: true });
    }
  });

  it("refuses a bare digit written as a glyph", () => {
    expect(() => parseChord("1")).toThrow(/write a bare digit as "Digit1"/);
  });

  it("refuses an unrecognised token and an empty key", () => {
    expect(() => parseChord("Mod+Frobnicate")).toThrow(/unrecognised key token/);
    expect(() => parseChord("Mod+")).toThrow(/unrecognised key token|no key token/);
  });

  it("parses modifiers in any order", () => {
    expect(chordKey(parseChord("Mod+Shift+KeyU"))).toBe(chordKey(parseChord("Shift+Mod+KeyU")));
  });
});

describe("matchChord — the exact four-bit mask", () => {
  it("matches the chord it was parsed from", () => {
    expect(matchChord(parseChord("Mod+KeyZ"), ev({ key: "z", code: "KeyZ", metaKey: true }))).toBe(true);
    expect(matchChord(parseChord("Mod+KeyZ"), ev({ key: "z", code: "KeyZ", ctrlKey: true }))).toBe(true);
  });

  // The whole point. Every one of these was accepted by the old
  // `(metaKey||ctrlKey) && key==="z"` form.
  it("rejects every extra modifier on ⌘Z", () => {
    const z = parseChord("Mod+KeyZ");
    expect(matchChord(z, ev({ key: "z", code: "KeyZ", metaKey: true, shiftKey: true }))).toBe(false);
    expect(matchChord(z, ev({ key: "z", code: "KeyZ", metaKey: true, altKey: true }))).toBe(false);
    expect(matchChord(z, ev({ key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(matchChord(z, ev({ key: "z", code: "KeyZ" }))).toBe(false);
  });

  it("rejects ⌃⌘Z — both mod keys at once is not 'Mod'", () => {
    expect(matchChord(parseChord("Mod+KeyZ"), ev({ key: "z", code: "KeyZ", metaKey: true, ctrlKey: true }))).toBe(false);
  });

  it("keeps Mod as meta-OR-ctrl on both platforms", () => {
    // Resolving Mod to Meta-on-macOS would silently unbind Ctrl+Z for a Mac
    // user on an external PC keyboard — which works today.
    const u = parseChord("Mod+Shift+KeyU");
    expect(matchChord(u, ev({ key: "U", code: "KeyU", metaKey: true, shiftKey: true }))).toBe(true);
    expect(matchChord(u, ev({ key: "U", code: "KeyU", ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  // This test used to assert the opposite, and the opposite was the bug: a
  // position match fires ⌘Z when a French user presses the key labelled W —
  // stealing their ⌘W / Close Window — and never fires on the key they have
  // labelled Z.
  it("matches Mod+letter by the GLYPH, not the physical position", () => {
    const z = parseChord("Mod+KeyZ");
    // QWERTZ: the key labelled Z sits on the physical KeyY position.
    expect(matchChord(z, ev({ key: "z", code: "KeyY", metaKey: true }))).toBe(true);
    // AZERTY: the physical KeyZ position prints "w". That is the user's ⌘W.
    expect(matchChord(z, ev({ key: "w", code: "KeyZ", metaKey: true }))).toBe(false);
    // Case-insensitive, so ⌘⇧Z-style chords resolve on the same letter.
    expect(matchChord(parseChord("Mod+Shift+KeyU"), ev({ key: "U", code: "KeyU", metaKey: true, shiftKey: true }))).toBe(true);
  });

  it("keeps Mod+punctuation and Mod+digit on the physical position", () => {
    // "\\" and "," move between layouts as positions — which is why
    // legacy/main.ts chose e.code for ⌘\\ — and digits are in the same place
    // on every Latin layout.
    const bs = parseChord("Mod+Backslash");
    expect(matchChord(bs, ev({ key: "`", code: "Backslash", metaKey: true }))).toBe(true);
    expect(matchChord(bs, ev({ key: "\\", code: "Equal", metaKey: true }))).toBe(false);
    const d1 = parseChord("Mod+Digit1");
    expect(matchChord(d1, ev({ key: "&", code: "Digit1", metaKey: true }))).toBe(true);
  });

  it("matches a bare letter by glyph, not by position", () => {
    const j = parseChord("j");
    expect(matchChord(j, ev({ key: "j", code: "KeyC" }))).toBe(true); // Dvorak
    expect(matchChord(j, ev({ key: "c", code: "KeyJ" }))).toBe(false);
  });

  it("ignores Shift on bare punctuation but not on a lowercase letter", () => {
    expect(matchChord(parseChord("/"), ev({ key: "/", shiftKey: true }))).toBe(true);
    expect(matchChord(parseChord("/"), ev({ key: "/" }))).toBe(true);
    expect(matchChord(parseChord("j"), ev({ key: "j", shiftKey: true }))).toBe(false);
  });

  it("matches an uppercase letter as it is actually typed: Shift held", () => {
    const S = parseChord("S");
    expect(matchChord(S, ev({ key: "S", shiftKey: true }))).toBe(true);
    // Still an exact mask for everything else.
    expect(matchChord(S, ev({ key: "S", shiftKey: true, altKey: true }))).toBe(false);
    expect(matchChord(S, ev({ key: "S", metaKey: true, shiftKey: true }))).toBe(false);
    // And the lowercase chord is untouched: Shift+s reports key "S".
    expect(matchChord(parseChord("s"), ev({ key: "S", shiftKey: true }))).toBe(false);
    expect(matchChord(parseChord("s"), ev({ key: "s" }))).toBe(true);
  });

  it("tolerates AltGr (ctrl+alt together) on bare punctuation only", () => {
    expect(matchChord(parseChord("]"), ev({ key: "]", ctrlKey: true, altKey: true }))).toBe(true);
    // Ctrl alone is not AltGr and must still be rejected.
    expect(matchChord(parseChord("]"), ev({ key: "]", ctrlKey: true }))).toBe(false);
    expect(matchChord(parseChord("]"), ev({ key: "]", altKey: true }))).toBe(false);
    // A letter gets no tolerance — Ctrl+Alt+J is not "j".
    expect(matchChord(parseChord("j"), ev({ key: "j", ctrlKey: true, altKey: true }))).toBe(false);
  });

  it("does not let AltGr tolerance leak into a Mod chord", () => {
    expect(matchChord(parseChord("Mod+Slash"), ev({ code: "Slash", ctrlKey: true, altKey: true }))).toBe(false);
  });

  it("requires no modifier at all for a bare chord", () => {
    expect(matchChord(parseChord("j"), ev({ key: "j", metaKey: true }))).toBe(false);
    expect(matchChord(parseChord("Escape"), ev({ key: "Escape" }))).toBe(true);
    expect(matchChord(parseChord("Escape"), ev({ key: "Escape", ctrlKey: true }))).toBe(false);
  });

  it("honours an explicit matchOn override", () => {
    const asKey = parseChord("Mod+KeyF", "key");
    expect(asKey.matchOn).toBe("key");
    expect(matchChord(asKey, ev({ key: "KeyF", metaKey: true }))).toBe(true);
  });
});

describe("chordKey — the uniqueness key", () => {
  it("collides for the same chord written differently", () => {
    expect(chordKey(parseChord("Mod+Shift+KeyU"))).toBe(chordKey(parseChord("Shift+Mod+KeyU")));
  });

  it("separates chords that differ only by modifier or by match mode", () => {
    const keys = ["Mod+KeyZ", "Mod+Shift+KeyZ", "Alt+KeyZ", "KeyZ"].map((s) => chordKey(parseChord(s)));
    expect(new Set(keys).size).toBe(4);
    // Same glyph, different match mode, must not collide.
    expect(chordKey(parseChord("Slash"))).not.toBe(chordKey(parseChord("/")));
  });
});

describe("formatChord / toAccelerator", () => {
  it("formats per platform", () => {
    expect(formatChord(parseChord("Mod+Shift+KeyU"), "macos")).toBe("⌘⇧U");
    expect(formatChord(parseChord("Mod+Shift+KeyU"), "win")).toBe("Ctrl+Shift+U");
    expect(formatChord(parseChord("Mod+Backslash"), "macos")).toBe("⌘\\");
    expect(formatChord(parseChord("Mod+Comma"), "win")).toBe("Ctrl+,");
  });

  it("emits muda accelerator strings", () => {
    expect(toAccelerator(parseChord("Mod+Shift+F".replace("F", "KeyF")))).toBe("CmdOrCtrl+Shift+F");
    expect(toAccelerator(parseChord("Mod+Backquote"))).toBe("CmdOrCtrl+`");
    expect(toAccelerator(parseChord("Mod+Comma"))).toBe("CmdOrCtrl+,");
  });

  it("refuses an accelerator for a glyph-matched chord", () => {
    // muda takes key NAMES, not glyphs — which is itself why no bare-punctuation
    // binding may declare dispatch:"accelerator".
    expect(() => toAccelerator(parseChord("/"))).toThrow(/glyph-matched/);
    expect(() => toAccelerator(parseChord("j"))).toThrow(/glyph-matched/);
  });

  it("still emits an accelerator for a named key", () => {
    expect(toAccelerator(parseChord("F1"))).toBe("F1");
  });
});
