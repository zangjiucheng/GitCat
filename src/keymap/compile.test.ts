// compile() is the gate. It runs in CI (this file) and again at boot
// (registry.register), so a table that fails here cannot start the app either.
import { describe, expect, it, vi } from "vitest";

// guards.ts is the one module in src/keymap/ that reads app state, so it
// imports @/legacy/bridge — which re-exports legacy/main.ts, a canvas app that
// boots on import and dies in jsdom at `cv.getContext("2d")`. Same isolation
// every other controller suite uses (see workdir.svelte.test.ts's header).
vi.mock("@/legacy/bridge", () => ({ CUR_REPO: "/repo", G: { N: 0 } }));

import { compile, dumpKeymap } from "./compile.ts";
import { BINDINGS } from "./bindings.ts";
import { GUARDS } from "./guards.ts";
import type { Binding } from "./types.ts";

const base = {
  chords: ["Mod+KeyJ"],
  scope: "global",
  dispatch: "js",
  labelKey: "vimnav.palette",
} as const;

function b(over: Partial<Binding> & { id: string }): Binding {
  return { ...base, ...over } as Binding;
}

describe("the real table compiles", () => {
  it("compiles and registers every binding", () => {
    const t = compile(BINDINGS, GUARDS);
    expect(t.size).toBe(BINDINGS.length);
    expect(t.byId.size).toBe(BINDINGS.length);
  });

  it("ships entirely in shadow mode except the accelerator-only rows", () => {
    // The property that makes PR 1 inert. A row with a JS side that is NOT
    // shadow would run, so this is the assertion that has to fail first if
    // someone flips a binding live without meaning to.
    for (const x of BINDINGS) {
      if (x.dispatch === "accelerator") expect(x.mode, x.id).toBeUndefined();
      else expect(x.mode, x.id).toBe("shadow");
    }
  });

  it("gives every shadow binding a run() of undefined", () => {
    // A shadow run() is unreachable by construction; leaving one defined would
    // be a loaded gun for whoever flips the row.
    for (const x of BINDINGS) expect(x.run, x.id).toBeUndefined();
  });
});

describe("registration throws", () => {
  it("rejects a duplicate binding id", () => {
    expect(() => compile([b({ id: "a" }), b({ id: "a", chords: ["Mod+KeyQ2" as never] })], GUARDS))
      .toThrow(/duplicate binding id|unrecognised/);
  });

  it("rejects dispatch:both + toggle — the Rust/JS double-fire", () => {
    expect(() =>
      compile([b({ id: "a", dispatch: "both", menu: { id: "x" }, toggle: true } as never)], GUARDS),
    ).toThrow(/both.*toggle/s);
  });

  it("rejects an accelerator binding with no menu id", () => {
    expect(() => compile([b({ id: "a", dispatch: "accelerator" } as never)], GUARDS))
      .toThrow(/no menu\.id/);
  });

  it("rejects shadow bookkeeping mistakes in both directions", () => {
    expect(() => compile([b({ id: "a", mode: "shadow" } as never)], GUARDS))
      .toThrow(/must declare owns/);
    expect(() => compile([b({ id: "a", owns: "somewhere" } as never)], GUARDS))
      .toThrow(/must not declare owns/);
  });

  it("rejects a destructive binding reachable from a text field", () => {
    expect(() =>
      compile([b({ id: "a", destructive: true, allowInTextInput: true } as never)], GUARDS),
    ).toThrow(/destructive.*allowInTextInput/);
  });

  it("rejects an unguarded layer:always binding", () => {
    expect(() => compile([b({ id: "a", layer: "always" } as never)], GUARDS))
      .toThrow(/must carry at least one guard/);
  });

  it("rejects an unknown guard name and an empty chord list", () => {
    expect(() => compile([b({ id: "a", when: ["nope"] } as never)], GUARDS)).toThrow(/unknown guard/);
    expect(() => compile([b({ id: "a", chords: [] } as never)], GUARDS)).toThrow(/no chords/);
  });

  it("rejects a chord the OS owns", () => {
    expect(() => compile([b({ id: "a", chords: ["Mod+KeyW"] })], GUARDS))
      .toThrow(/close_window/);
    expect(() => compile([b({ id: "a", chords: ["Mod+KeyC"] })], GUARDS))
      .toThrow(/Copy/);
  });

  it("rejects the same chord twice in one scope — including shadow vs live", () => {
    // Live-only uniqueness has a hole: a shadow row ordered first makes its live
    // twin permanently unreachable while the shadow counter still reads 1.
    expect(() =>
      compile(
        [
          b({ id: "a", mode: "shadow", owns: "x" } as never),
          b({ id: "live", chords: ["Mod+KeyJ"] }),
        ],
        GUARDS,
      ),
    ).toThrow(/bound twice in scope "global"/);
  });

  it("allows the same chord in DIFFERENT scopes", () => {
    // Bare "s" legitimately means stage / squash / skip / flip-side — which is
    // why the uniqueness key is (chord, scope) and not chord alone.
    expect(() =>
      compile([b({ id: "a", chords: ["s"] }), b({ id: "c", chords: ["s"], scope: "canvas" } as never)], GUARDS),
    ).not.toThrow();
  });

  it("rejects two Escape bindings in one scope", () => {
    // Caught by the (chord, scope) uniqueness gate, which runs first — so
    // compile()'s own `two Escape bindings` branch is belt-and-braces and
    // currently unreachable for the same scope. Asserting the message that is
    // actually thrown, not the one we might wish for.
    expect(() =>
      compile([b({ id: "a", chords: ["Escape"] }), b({ id: "b2", chords: ["Escape"] })], GUARDS),
    ).toThrow(/Escape is bound twice in scope "global"/);
  });

  it("allows one Escape per scope", () => {
    expect(() =>
      compile(
        [b({ id: "a", chords: ["Escape"] }), b({ id: "m", chords: ["Escape"], scope: "modal:cmdk" } as never)],
        GUARDS,
      ),
    ).not.toThrow();
  });
});

describe("dumpKeymap", () => {
  it("is sorted, stable and one line per binding", () => {
    const out = dumpKeymap(BINDINGS);
    const lines = out.trimEnd().split("\n");
    expect(lines).toHaveLength(BINDINGS.length);
    expect([...lines].sort()).toEqual(lines);
    expect(dumpKeymap(BINDINGS)).toBe(out);
  });
});
