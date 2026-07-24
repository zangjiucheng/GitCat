// Tests for the ⌘K command palette controller.
//
// Same isolation strategy as the other islands' tests: legacy/bridge is
// mocked so legacy/main.ts (a whole vanilla canvas app that boots on import)
// is never evaluated. cmdk is pure frontend logic over bridge.G/bridge.BACKEND
// (no IPC command of its own), so this file mutates those two mock fields
// directly between cases instead of mocking ipc/bindings.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  G: null,
  BACKEND: null,
  CUR_REPO: null,
  state: { scrollTarget: 0, maxScroll: 1000 },
  layout: { rowH: 22 },
  view: { cssH: 400 },
  cv: { focus: vi.fn() },
  bandH: vi.fn(() => 0),
  clampScroll: (v: number) => (v < 0 ? 0 : v > 1000 ? 1000 : v),
  select: vi.fn(),
  goToUncommitted: vi.fn(),
  toggleFocusMode: vi.fn(),
  hhex: (r: number) => "hex" + r,
  msgOf: (r: number) => "demo message " + r,
  AUTHORS: [{ n: "Demo Author", e: "demo@gitcat.dev" }],
  TAMA_IMG: { curious: "curious.png", confident: "confident.png" },
}));

import * as bridge from "../../legacy/bridge";
import { cmdkCtrl } from "./cmdk.svelte.ts";
import { plumbing } from "../plumbing/plumbing.svelte.ts";

function setBackendGraph(rows: any[]) {
  (bridge as any).G = { N: rows.length };
  (bridge as any).BACKEND = { rows };
}

function resetCmdk() {
  cmdkCtrl.open = false;
  cmdkCtrl.query = "";
  cmdkCtrl.results = [];
  cmdkCtrl.toks = [];
  cmdkCtrl.sel = 0;
  (bridge as any).G = null;
  (bridge as any).BACKEND = null;
  vi.clearAllMocks();
}

beforeEach(() => {
  resetCmdk();
});

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", () => {
    expect(document.getElementById("cv")).toBeNull();
    expect(cmdkCtrl).toBeDefined();
  });
});

describe("show/close/toggle", () => {
  it("show() opens the palette and seeds an empty-query result set", () => {
    setBackendGraph([{ sha: "aaa1111", subject: "Add feature", an: { n: "Dev" }, refs: [] }]);
    cmdkCtrl.show();
    expect(cmdkCtrl.open).toBe(true);
    expect(cmdkCtrl.query).toBe("");
  });

  it("toggle() flips open state", () => {
    setBackendGraph([]);
    cmdkCtrl.toggle();
    expect(cmdkCtrl.open).toBe(true);
    cmdkCtrl.toggle();
    expect(cmdkCtrl.open).toBe(false);
  });

  it("close() is a no-op when already closed", () => {
    cmdkCtrl.close();
    expect(cmdkCtrl.open).toBe(false);
  });
});

describe("filter", () => {
  it("with no query, always includes the 27 static tool actions plus loaded commits (no refs in this fixture)", () => {
    setBackendGraph([{ sha: "aaa1111", subject: "Add feature", an: { n: "Dev" }, refs: [] }]);
    cmdkCtrl.show();
    const kinds = cmdkCtrl.results.map((r: any) => r.type);
    expect(kinds.filter((t) => t === "action").length).toBe(27);
    expect(kinds.filter((t) => t === "commit").length).toBe(1);
  });

  it("matches an action by label", () => {
    setBackendGraph([{ sha: "aaa1111", subject: "Add feature", an: { n: "Dev" }, refs: [] }]);
    cmdkCtrl.show();
    cmdkCtrl.filter("bisect");
    expect(cmdkCtrl.results.length).toBe(1);
    expect((cmdkCtrl.results[0] as any).type).toBe("action");
    expect((cmdkCtrl.results[0] as any).id).toBe("bisect");
  });

  it("matches an action by hint text too", () => {
    setBackendGraph([]);
    cmdkCtrl.show();
    cmdkCtrl.filter("conflict-resolution");
    expect(cmdkCtrl.results.length).toBe(1);
    expect((cmdkCtrl.results[0] as any).id).toBe("rerere");
  });

  it("matches a commit by subject token", () => {
    setBackendGraph([
      { sha: "aaa1111", subject: "Fix off-by-one bug", an: { n: "Dev" }, refs: [] },
      { sha: "bbb2222", subject: "Add rate limiting", an: { n: "Dev" }, refs: [] },
    ]);
    cmdkCtrl.show();
    cmdkCtrl.filter("rate");
    expect(cmdkCtrl.results.length).toBe(1);
    expect((cmdkCtrl.results[0] as any).sha).toBe("bbb2222");
  });

  it("matches a commit by short sha prefix", () => {
    setBackendGraph([
      { sha: "aaa1111", subject: "Fix off-by-one bug", an: { n: "Dev" }, refs: [] },
      { sha: "bbb2222", subject: "Add rate limiting", an: { n: "Dev" }, refs: [] },
    ]);
    cmdkCtrl.show();
    cmdkCtrl.filter("bbb");
    expect(cmdkCtrl.results.length).toBe(1);
    expect((cmdkCtrl.results[0] as any).subject).toBe("Add rate limiting");
  });

  it("matches a ref by name", () => {
    setBackendGraph([{ sha: "aaa1111", subject: "Add feature", an: { n: "Dev" }, refs: [{ n: "main", t: "head" }] }]);
    cmdkCtrl.show();
    cmdkCtrl.filter("main");
    expect(cmdkCtrl.results.length).toBe(1);
    expect((cmdkCtrl.results[0] as any).type).toBe("ref");
  });

  it("resets sel to 0 on every filter call", () => {
    setBackendGraph([
      { sha: "aaa1111", subject: "one", an: { n: "Dev" }, refs: [] },
      { sha: "bbb2222", subject: "two", an: { n: "Dev" }, refs: [] },
    ]);
    cmdkCtrl.show();
    cmdkCtrl.setSel(1);
    cmdkCtrl.filter("t");
    expect(cmdkCtrl.sel).toBe(0);
  });
});

describe("setSel", () => {
  it("wraps forward past the last result", () => {
    setBackendGraph([
      { sha: "aaa1111", subject: "one", an: { n: "Dev" }, refs: [] },
      { sha: "bbb2222", subject: "two", an: { n: "Dev" }, refs: [] },
    ]);
    cmdkCtrl.show();
    cmdkCtrl.filter("");
    cmdkCtrl.setSel(cmdkCtrl.results.length); // one past the end
    expect(cmdkCtrl.sel).toBe(0);
  });

  it("wraps backward before the first result", () => {
    setBackendGraph([{ sha: "aaa1111", subject: "one", an: { n: "Dev" }, refs: [{ n: "main", t: "head" }] }]);
    cmdkCtrl.show();
    cmdkCtrl.filter("");
    cmdkCtrl.setSel(-1);
    expect(cmdkCtrl.sel).toBe(cmdkCtrl.results.length - 1);
  });

  it("is a no-op (sel stays 0) when there are truly no results (the 7 static actions don't match either)", () => {
    setBackendGraph([]);
    cmdkCtrl.show();
    cmdkCtrl.filter("zzz-nothing-matches-this-xyz");
    expect(cmdkCtrl.results.length).toBe(0);
    cmdkCtrl.setSel(3);
    expect(cmdkCtrl.sel).toBe(0);
  });
});

describe("jump", () => {
  it("closes the palette, scrolls, and selects the row", () => {
    setBackendGraph([{ sha: "aaa1111", subject: "one", an: { n: "Dev" }, refs: [] }]);
    cmdkCtrl.show();
    cmdkCtrl.jump({ type: "commit", row: 0, subject: "one", sha: "aaa1111", author: "Dev", hay: "" });
    expect(cmdkCtrl.open).toBe(false);
    expect(bridge.select).toHaveBeenCalledWith(0);
    expect((bridge as any).cv.focus).toHaveBeenCalled();
  });

  it("does nothing for an undefined item", () => {
    cmdkCtrl.jump(undefined);
    expect(bridge.select).not.toHaveBeenCalled();
  });

  it("runs an action item's run() and closes, without touching row-based select/scroll", () => {
    plumbing.open = false;
    cmdkCtrl.jump({ type: "action", id: "plumbing", label: "Plumbing", hint: "", run: () => plumbing.show() });
    expect(cmdkCtrl.open).toBe(false);
    expect(plumbing.open).toBe(true);
    expect(bridge.select).not.toHaveBeenCalled();
  });

  it("closes but does not select when the row is out of range (stale index after a reload)", () => {
    setBackendGraph([{ sha: "aaa1111", subject: "one", an: { n: "Dev" }, refs: [] }]);
    cmdkCtrl.show();
    cmdkCtrl.jump({ type: "commit", row: 99, subject: "gone", sha: "zzz", author: "Dev", hay: "" });
    expect(cmdkCtrl.open).toBe(false);
    expect(bridge.select).not.toHaveBeenCalled();
  });

  it("the Uncommitted Changes action calls bridge.goToUncommitted()", () => {
    setBackendGraph([]);
    cmdkCtrl.show();
    cmdkCtrl.filter("uncommitted");
    expect(cmdkCtrl.results.length).toBe(1);
    cmdkCtrl.jump(cmdkCtrl.results[0]);
    expect(bridge.goToUncommitted).toHaveBeenCalled();
  });

  it("the Toggle Focus Mode action calls bridge.toggleFocusMode()", () => {
    setBackendGraph([]);
    cmdkCtrl.show();
    cmdkCtrl.filter("focus");
    expect(cmdkCtrl.results.length).toBe(1);
    cmdkCtrl.jump(cmdkCtrl.results[0]);
    expect(bridge.toggleFocusMode).toHaveBeenCalled();
  });
});

describe("hasData", () => {
  it("is false with no graph loaded", () => {
    expect(cmdkCtrl.hasData).toBe(false);
  });

  it("is true once a graph is loaded", () => {
    setBackendGraph([{ sha: "aaa1111", subject: "one", an: { n: "Dev" }, refs: [] }]);
    expect(cmdkCtrl.hasData).toBe(true);
  });
});

describe("hl", () => {
  it("escapes HTML with no active tokens", () => {
    cmdkCtrl.toks = [];
    expect(cmdkCtrl.hl("<script>")).toBe("&lt;script&gt;");
  });

  it("wraps the matched token in <mark>", () => {
    cmdkCtrl.toks = ["rate"];
    expect(cmdkCtrl.hl("Add rate limiting")).toBe("Add <mark>rate</mark> limiting");
  });
});
