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

// `run` is part of the base now: compile refuses a LIVE js binding without one,
// because fire() would claim the chord and do nothing with it.
const base = {
  chords: ["Mod+KeyJ"],
  scope: "global",
  dispatch: "js",
  labelKey: "vimnav.palette",
  run: () => {},
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

  it("puts no accelerator-only row in the real table's dispatch buckets", () => {
    const t = compile(BINDINGS, GUARDS);
    const reachable = new Set<string>();
    for (const list of [...t.byCode.values(), ...t.byKey.values()]) {
      for (const c of list) reachable.add(c.b.id);
    }
    for (const c of t.always) reachable.add(c.b.id);
    for (const c of t.escapeByScope.values()) reachable.add(c.b.id);
    for (const x of BINDINGS) {
      if (x.dispatch === "accelerator") expect(reachable.has(x.id), `${x.id} is reachable`).toBe(false);
    }
  });

  // The LIVE set, enumerated. Every other JS row must still be shadow, so
  // flipping one live is a visible decision in this list rather than a quiet
  // property change in a 300-line table. PR 1 shipped this list empty.
  const LIVE = ["modal.close", "pane.graph", "pane.sidebar", "pane.detail", "workdir.commit", "workdir.amend", "workdir.stage", "workdir.unstage", "workdir.stageAll", "workdir.unstageAll", "workdir.discard", "canvas.menu", "canvas.down", "canvas.up", "canvas.first", "canvas.last", "canvas.deselect"];

  it("keeps every JS binding in shadow mode except the enumerated live ones", () => {
    for (const x of BINDINGS) {
      if (x.dispatch === "accelerator") expect(x.mode, x.id).toBeUndefined();
      else if (LIVE.includes(x.id)) expect(x.mode, x.id).toBeUndefined();
      else expect(x.mode, x.id).toBe("shadow");
    }
  });

  it("gives every shadow binding a run() of undefined, and every live one a run()", () => {
    // A shadow run() is unreachable by construction; leaving one defined would
    // be a loaded gun for whoever flips the row. The converse matters too: a
    // live binding with no run() silently swallows its chord (see
    // dispatch.test.ts's "a live binding with no run() still claims the key").
    for (const x of BINDINGS) {
      if (x.mode === "shadow") expect(x.run, x.id).toBeUndefined();
      else if (x.dispatch !== "accelerator") expect(typeof x.run, x.id).toBe("function");
    }
  });

  it("gives every live JS binding a scope that is either global or pushable", () => {
    // A live binding in a scope nothing ever pushes is dead weight that reads
    // as working. "global" is legitimate for a binding that must work from
    // anywhere — the pane-focus chords are exactly that — but a SCOPED live
    // binding has to name a scope some controller actually pushes.
    // "modal" is pushed by an island; "workdir" is derived from focus by
    // panes.ts. Either way the scope is reachable, which is what matters.
    const PUSHED = ["modal", "workdir", "graph"]; // grows as islands migrate
    for (const id of LIVE) {
      const x = BINDINGS.find((y) => y.id === id)!;
      expect(x, id).toBeTruthy();
      if (x.scope !== "global") expect(PUSHED, id).toContain(x.scope);
    }
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

  it("rejects a live js binding with no run(), which would swallow its chord", () => {
    expect(() => compile([b({ id: "a", run: undefined } as never)], GUARDS))
      .toThrow(/has no run\(\)/);
    // shadow and accelerator rows legitimately have none.
    expect(() => compile([b({ id: "s", mode: "shadow", owns: "x", run: undefined } as never)], GUARDS)).not.toThrow();
    expect(() =>
      compile([b({ id: "m", dispatch: "accelerator", menu: { id: "x" }, run: undefined } as never)], GUARDS),
    ).not.toThrow();
  });

  it("keeps accelerator-only rows OUT of the dispatch tables", () => {
    // They have no JS side at all — the native menu owns the chord. Leaving
    // them in the buckets made fire() claim and preventDefault ⌘N, ⌘⇧N and ⌘`,
    // which is precisely the inertness this PR claims not to break.
    const t = compile(
      [b({ id: "acc", dispatch: "accelerator", menu: { id: "x" }, run: undefined } as never)],
      GUARDS,
    );
    expect(t.byCode.size).toBe(0);
    expect(t.byKey.size).toBe(0);
    expect(t.always).toHaveLength(0);
    // Still registered, so codegen and the uniqueness gate can see it.
    expect(t.byId.has("acc")).toBe(true);
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
