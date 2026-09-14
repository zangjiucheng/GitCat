// Pane derivation. The fallback is the interesting case: focus lands outside
// every pane constantly (a topbar button after a click, <body> after something
// was removed), and if that meant "no pane" then every vim key would die the
// moment a user clicked anything in the chrome — which would make this
// migration strictly worse than the window-level handlers it replaces.
import { beforeEach, describe, expect, it } from "vitest";
import { PANES, activePaneScope, focusPane, paneScopeFor } from "./panes.ts";

beforeEach(() => {
  document.body.innerHTML = `
    <button id="topbar">topbar</button>
    <aside data-pane="sidebar" tabindex="-1"><button id="refrow">main</button></aside>
    <main data-pane="graph" tabindex="-1"><canvas id="cv"></canvas></main>
    <section data-pane="detail" tabindex="-1"><div id="file" tabindex="0">a.ts</div></section>`;
});

describe("the pane set", () => {
  it("is three panes, not four", () => {
    // Workdir renders INSIDE #detail (main.ts refuses to mount it a second
    // time), so "workdir" is a state of the detail pane, not a region.
    expect(PANES.map((p) => p.name)).toEqual(["graph", "sidebar", "detail"]);
  });
});

describe("paneScopeFor", () => {
  it.each([
    ["refrow", "sidebar"],
    ["cv", "graph"],
    ["file", "detail"],
  ])("resolves an element inside a pane (#%s)", (id, scope) => {
    expect(paneScopeFor(document.getElementById(id))).toBe(scope);
  });

  it("resolves the pane root itself", () => {
    expect(paneScopeFor(document.querySelector('[data-pane="sidebar"]'))).toBe("sidebar");
  });

  it("falls back to the graph outside every pane", () => {
    expect(paneScopeFor(document.getElementById("topbar"))).toBe("graph");
    expect(paneScopeFor(document.body)).toBe("graph");
    expect(paneScopeFor(null)).toBe("graph");
  });

  it("falls back to the graph for an unknown data-pane value", () => {
    document.body.innerHTML = `<div data-pane="nonsense"><button id="b"></button></div>`;
    expect(paneScopeFor(document.getElementById("b"))).toBe("graph");
  });
});

describe("activePaneScope", () => {
  it("tracks document.activeElement rather than any stored mirror", () => {
    expect(activePaneScope()).toBe("graph"); // nothing focused yet
    document.getElementById("refrow")!.focus();
    expect(activePaneScope()).toBe("sidebar");
    document.getElementById("file")!.focus();
    expect(activePaneScope()).toBe("detail");
  });

  it("returns to the graph when the focused element is removed", () => {
    // The exact case a focusin/focusout mirror gets wrong: focusout fires with
    // a null relatedTarget and NO following focusin, so a stored value goes
    // stale precisely when a pane disappears out from under the cursor.
    const row = document.getElementById("refrow")!;
    row.focus();
    expect(activePaneScope()).toBe("sidebar");
    row.remove();
    expect(activePaneScope()).toBe("graph");
  });
});

describe("focusPane", () => {
  it("prefers a focusable inside the pane over the root", () => {
    expect(focusPane("detail")).toBe(true);
    expect(document.activeElement!.id).toBe("file");
    expect(activePaneScope()).toBe("detail");
  });

  it("falls back to the root when the pane has no tabbable child", () => {
    expect(focusPane("graph")).toBe(true);
    expect((document.activeElement as HTMLElement).dataset.pane).toBe("graph");
    expect(activePaneScope()).toBe("graph");
  });

  it("reports failure for a pane that is not in the document", () => {
    // The binding declines on false rather than swallowing the chord.
    expect(focusPane("workdir")).toBe(false);
  });

  it("round-trips: whatever focusPane sets, activePaneScope reads back", () => {
    for (const p of PANES) {
      expect(focusPane(p.name)).toBe(true);
      expect(activePaneScope()).toBe(p.scope);
    }
  });
});
