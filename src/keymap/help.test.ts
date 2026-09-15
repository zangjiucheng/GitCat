// The generated overlay. The assertions that matter are the ones a hand-written
// list could not make: that every visible binding appears exactly once, that the
// active scope leads, and that nothing is listed twice.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/legacy/bridge", () => ({ CUR_REPO: "/repo", G: { N: 5 } }));

import { BINDINGS } from "./bindings.ts";
import { helpGroups } from "./help.ts";

const flat = (gs: ReturnType<typeof helpGroups>) => gs.flatMap((g) => g.rows);

describe("coverage", () => {
  it("lists every visible binding, and never a hidden one", () => {
    const rows = flat(helpGroups(BINDINGS, "global", "macos"));
    const shown = new Set(rows.map((r) => r.labelKey));

    for (const b of BINDINGS) {
      if (!b.help || b.help.hidden) continue;
      expect(shown.has(b.labelKey), `${b.id} is missing from the overlay`).toBe(true);
    }
    for (const b of BINDINGS) {
      if (b.help?.hidden) {
        // A hidden row is one deliberately kept off the list (a tombstone, or a
        // duplicate of a chord shown elsewhere) — it must not leak back in
        // UNLESS another visible binding shares its label.
        const alsoVisible = BINDINGS.some(
          (o) => o !== b && o.labelKey === b.labelKey && o.help && !o.help.hidden,
        );
        if (!alsoVisible) expect(shown.has(b.labelKey), `${b.id} is hidden but shown`).toBe(false);
      }
    }
  });

  it("never lists the same chord twice — across the WHOLE overlay, not per group", () => {
    // Per-group deduping was not enough: `x` is "open the actions menu" on the
    // graph AND in the sidebar, so with one of them active it appeared in the
    // leading group and again under Actions. One key, listed twice, in the
    // surface whose job is teaching that it IS one key.
    for (const scope of ["workdir", "graph", "sidebar", "detail"] as const) {
      const rows = flat(helpGroups(BINDINGS, scope, "macos"));
      const keys = rows.map((r) => r.chord + "|" + r.labelKey);
      expect(new Set(keys).size, `duplicate row with ${scope} active`).toBe(keys.length);
    }
  });

  it("keeps s and S apart — they are different keys doing different things", () => {
    // formatChord uppercased every single character, so stage (s) and
    // stage-all (S) rendered as the same glyph, as did unstage/unstage-all.
    const rows = flat(helpGroups(BINDINGS, "workdir", "macos"));
    const chords = rows.map((r) => r.chord);
    expect(chords).toContain("s");
    expect(chords).toContain("S");
    expect(chords).toContain("u");
    expect(chords).toContain("U");
  });

  it("still uppercases the letter in a Mod chord, where there is no twin", () => {
    const rows = flat(helpGroups(BINDINGS, "global", "macos"));
    expect(rows.some((r) => r.chord.includes("⌘⇧U"))).toBe(true);
  });

  it("includes the keys vimnav still owns, so the overlay stays complete", () => {
    // An overlay that silently omitted j/k would be worse than the hand-written
    // one it replaces.
    const rows = flat(helpGroups(BINDINGS, "global", "macos"));
    expect(rows.some((r) => r.chord === "j / k")).toBe(true);
    expect(rows.some((r) => r.chord === "gg / G")).toBe(true);
  });
});

describe("scope-first ordering", () => {
  it("leads with the active scope's own keys", () => {
    // The whole reason this is generated: a flat list of forty rows cannot
    // teach that `s` means stage HERE and `c` means checkout somewhere else.
    const gs = helpGroups(BINDINGS, "workdir", "macos");
    expect(gs[0].titleKey).toBe("vimnav.scope_workdir");
    expect(gs[0].rows.every((r) => r.inScope)).toBe(true);
    expect(gs[0].rows.length).toBeGreaterThan(0);
  });

  it("leads with a different group for a different scope", () => {
    expect(helpGroups(BINDINGS, "sidebar", "macos")[0].titleKey).toBe("vimnav.scope_sidebar");
    expect(helpGroups(BINDINGS, "graph", "macos")[0].titleKey).toBe("vimnav.scope_graph");
  });

  it("does not repeat a scoped binding in the sections below", () => {
    const gs = helpGroups(BINDINGS, "workdir", "macos");
    const lead = new Set(gs[0].rows.map((r) => r.labelKey));
    for (const g of gs.slice(1)) {
      for (const r of g.rows) {
        expect(lead.has(r.labelKey), `${r.labelKey} appears twice`).toBe(false);
      }
    }
  });

  it("falls back to the section list for a scope with no keys of its own", () => {
    const gs = helpGroups(BINDINGS, "global", "macos");
    expect(gs[0].titleKey).not.toMatch(/^vimnav\.scope_/);
    expect(gs.length).toBeGreaterThan(1);
  });
});

describe("formatting", () => {
  it("renders chords per platform", () => {
    const mac = flat(helpGroups(BINDINGS, "global", "macos")).map((r) => r.chord);
    const win = flat(helpGroups(BINDINGS, "global", "win")).map((r) => r.chord);
    expect(mac.some((c) => c.includes("⌘"))).toBe(true);
    expect(win.some((c) => c.includes("Ctrl+"))).toBe(true);
    expect(win.some((c) => c.includes("⌘"))).toBe(false);
  });

  it("joins a binding's alternate chords rather than listing it twice", () => {
    // `x` is also ⇧F10; one row, two spellings.
    const rows = flat(helpGroups(BINDINGS, "graph", "macos"));
    const menu = rows.find((r) => r.labelKey === "vimnav.row_menu");
    expect(menu?.chord).toContain("/");
  });
});
