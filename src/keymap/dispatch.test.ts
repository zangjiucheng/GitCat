// The dispatcher, tested against hand-built tables rather than the real one, so
// a change to bindings.ts can never silently rewrite what these assert.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/legacy/bridge", () => ({ CUR_REPO: "/repo", G: { N: 0 } }));

import { compile } from "./compile.ts";
import { dispatch, resetDispatchMemo } from "./dispatch.ts";
import type { ScopeId, ScopeSpec } from "./scopes.ts";
import type { Binding, GuardTable } from "./types.ts";

// Real GuardNames only — the union in types.ts is deliberately closed, so a
// test cannot invent one. `graphHasRows` stands in for "a guard that fails" and
// `inTauri` for "a guard that passes"; the point under test is the dispatcher's
// handling of a guard result, not which guard produced it.
const GUARDS: GuardTable = {
  repoOpen: () => true,
  notTextInput: () => true,
  notTextInputOrSelect: () => true,
  noScrimOpen: () => true,
  notInTerminal: () => true,
  graphHasRows: () => false,
  inTauri: () => true,
};

function ev(p: Partial<KeyboardEvent> & { target?: unknown }): KeyboardEvent {
  return {
    key: "", code: "", keyCode: 0, isComposing: false,
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    target: null,
    ...p,
  } as KeyboardEvent;
}

function run(
  bindings: Binding[],
  e: KeyboardEvent,
  stack: ScopeId[] = ["global"],
  specs: Array<[ScopeId, ScopeSpec]> = [],
) {
  resetDispatchMemo();
  return dispatch(e, stack, new Map(specs), compile(bindings, GUARDS), "linux");
}

const live = (over: Partial<Binding> & { id: string }): Binding =>
  ({ chords: ["Mod+KeyJ"], scope: "global", dispatch: "js", labelKey: "vimnav.palette", ...over }) as Binding;

beforeEach(resetDispatchMemo);

describe("IME", () => {
  // grep -rn isComposing src/ returned nothing before this PR, and zh + ko both
  // ship. A Pinyin or Hangul user composes over every bare letter in the table.
  it.each([
    ["isComposing", { isComposing: true }],
    ["keyCode 229", { keyCode: 229 }],
    ["key Process", { key: "Process" }],
    ["key Dead", { key: "Dead" }],
  ])("bails on %s before reading the chord", (_label, extra) => {
    const fired = vi.fn();
    const r = run([live({ id: "a", chords: ["j"], run: fired })], ev({ key: "j", ...extra }));
    expect(r.ran).toBeNull();
    expect(fired).not.toHaveBeenCalled();
  });
});

describe("shadow mode", () => {
  it("counts a match, runs nothing, and claims nothing", () => {
    const fired = vi.fn();
    const r = run([live({ id: "a", chords: ["j"], mode: "shadow", owns: "x", run: fired } as never)], ev({ key: "j" }));
    expect(r.shadowed.map((c) => c.b.id)).toEqual(["a"]);
    expect(r.ran).toBeNull();
    expect(r.claim).toBe(false);
    expect(r.preventDefault).toBe(false);
    expect(fired).not.toHaveBeenCalled();
  });

  it("CONTINUES the walk so a shadow row cannot mask a live one", () => {
    // The shadow row is the INNER one here: the walk runs innermost-first, so
    // returning at a shadow match would make the outer live row permanently
    // unreachable while the shadow counter still read as success.
    const fired = vi.fn();
    const r = run(
      [
        live({ id: "liveOuter", chords: ["j"], run: fired }),
        live({ id: "shadowInner", chords: ["j"], scope: "graph", mode: "shadow", owns: "x" } as never),
      ],
      ev({ key: "j" }),
      ["global", "graph"],
    );
    expect(r.ran?.b.id).toBe("liveOuter");
    expect(r.shadowed.map((c) => c.b.id)).toEqual(["shadowInner"]);
    expect(fired).toHaveBeenCalledTimes(1);
  });
});

describe("guards", () => {
  it("skips a binding whose guard fails", () => {
    const r = run([live({ id: "a", chords: ["j"], when: ["graphHasRows"], run: () => {} } as never)], ev({ key: "j" }));
    expect(r.ran).toBeNull();
  });

  it("skips a binding when focus is in a text field", () => {
    const target = { closest: (s: string) => (s.includes("textarea") ? {} : null) };
    const r = run([live({ id: "a", chords: ["j"], run: () => {} })], ev({ key: "j", target: target as unknown as EventTarget }));
    expect(r.ran).toBeNull();
  });

  it("honours allowInTextInput", () => {
    const target = { closest: () => ({}) };
    const r = run(
      [live({ id: "a", chords: ["Mod+Enter"], allowInTextInput: true, run: () => {} } as never)],
      ev({ key: "Enter", metaKey: true, target: target as unknown as EventTarget }),
    );
    expect(r.ran?.b.id).toBe("a");
  });

  it("only the select-inclusive variant rejects a focused <select>", () => {
    const target = { closest: (s: string) => (s.includes("select") ? {} : null) };
    expect(run([live({ id: "a", chords: ["j"], when: ["notTextInput"], run: () => {} } as never)], ev({ key: "j", target: target as unknown as EventTarget })).ran?.b.id).toBe("a");
    expect(run([live({ id: "b", chords: ["j"], when: ["notTextInputOrSelect"], run: () => {} } as never)], ev({ key: "j", target: target as unknown as EventTarget })).ran).toBeNull();
  });

  it("filters by platform", () => {
    const r = run([live({ id: "a", chords: ["j"], platform: "macos", run: () => {} } as never)], ev({ key: "j" }));
    expect(r.ran).toBeNull();
  });
});

describe("the scope walk", () => {
  it("runs the innermost scope first", () => {
    const r = run(
      [live({ id: "outer", chords: ["j"], run: () => {} }), live({ id: "inner", chords: ["j"], scope: "graph", run: () => {} } as never)],
      ev({ key: "j" }),
      ["global", "graph"],
    );
    expect(r.ran?.b.id).toBe("inner");
  });

  it("falls through outward when run() returns false", () => {
    const r = run(
      [
        live({ id: "outer", chords: ["j"], run: () => {} }),
        live({ id: "inner", chords: ["j"], scope: "graph", run: () => false } as never),
      ],
      ev({ key: "j" }),
      ["global", "graph"],
    );
    expect(r.ran?.b.id).toBe("outer");
  });

  it("stops descending at a modal scope", () => {
    const r = run(
      [live({ id: "outer", chords: ["j"], run: () => {} }), live({ id: "m", chords: ["x"], scope: "palette", run: () => {} } as never)],
      ev({ key: "j" }),
      ["global", "palette"],
      [["palette", { id: "palette", rank: 100, modal: true, escape: "own" } as ScopeSpec]],
    );
    expect(r.ran).toBeNull();
  });

  it("resolves a layer:always binding regardless of stack depth", () => {
    const r = run(
      [live({ id: "palette", chords: ["Mod+KeyK"], layer: "always", when: ["inTauri"], run: () => {} } as never)],
      // key AND code: Mod+letter matches the glyph now, so a code-only event
      // is no longer a valid ⌘K.
      ev({ key: "k", code: "KeyK", metaKey: true }),
      ["global", "palette"],
      [["palette", { id: "palette", rank: 100, modal: true, escape: "own" } as ScopeSpec]],
    );
    expect(r.ran?.b.id).toBe("palette");
  });
});

describe("Escape", () => {
  it("resolves against the TOP scope only and never falls through", () => {
    // This is what lets the ~36 island Escape handlers keep working until each
    // opts in, one at a time: the outer binding must NOT also fire.
    const outer = vi.fn();
    const r = run(
      [
        live({ id: "outer", chords: ["Escape"], run: outer }),
        live({ id: "inner", chords: ["Escape"], scope: "graph", run: () => {} } as never),
      ],
      ev({ key: "Escape" }),
      ["global", "graph"],
    );
    expect(r.ran?.b.id).toBe("inner");
    expect(outer).not.toHaveBeenCalled();
  });

  it("resolves from inside a text field, because Escape is not typed text", () => {
    // Found while fixing a stacked-overlay bug: the default text-input deny
    // applied to Escape too, so a dialog could not be closed from any of its
    // own inputs — which is MOST of the time, since pushScope focuses into the
    // dialog on open. The exemption lives in the Escape path rather than on
    // each binding, so no future scope can forget it.
    const target = { closest: () => ({}) };
    const fired = vi.fn();
    const r = run(
      [live({ id: "close", chords: ["Escape"], run: fired })],
      ev({ key: "Escape", target: target as unknown as EventTarget }),
    );
    expect(r.ran?.b.id).toBe("close");
    expect(fired).toHaveBeenCalled();
  });

  it("still applies the text guard to non-Escape keys in the same scope", () => {
    const target = { closest: () => ({}) };
    const r = run(
      [live({ id: "letter", chords: ["j"], run: () => {} })],
      ev({ key: "j", target: target as unknown as EventTarget }),
    );
    expect(r.ran).toBeNull();
  });

  it("a live binding with no run() would swallow the key — so compile refuses it", () => {
    // fire() only consults run() when it exists, so a live row without one
    // claims the chord, preventDefaults it and does nothing. This used to be
    // documented as an accepted edge; it was not an edge at all — three
    // accelerator-only rows were in exactly that shape and were eating ⌘N, ⌘⇧N
    // and ⌘`. The dispatcher behaviour is unchanged; the table can no longer
    // express the shape.
    expect(() => run([live({ id: "noRun", chords: ["Escape"], run: undefined } as never)], ev({ key: "Escape" })))
      .toThrow(/has no run\(\)/);
  });

  it("runs the top scope's Escape binding", () => {
    const r = run(
      [live({ id: "outer", chords: ["Escape"], run: () => {} })],
      ev({ key: "Escape" }),
      ["global"],
    );
    expect(r.ran?.b.id).toBe("outer");
  });
});

describe("fast paths", () => {
  it("returns immediately on an empty table", () => {
    resetDispatchMemo();
    const r = dispatch(ev({ key: "j" }), ["global"], new Map(), compile([], GUARDS), "linux");
    expect(r.ran).toBeNull();
    expect(r.shadowed).toHaveLength(0);
  });

  it("returns nothing when no bucket matches the event", () => {
    const r = run([live({ id: "a", chords: ["j"], run: () => {} })], ev({ key: "q", code: "KeyQ" }));
    expect(r.ran).toBeNull();
  });
});
