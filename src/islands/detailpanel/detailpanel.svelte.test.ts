import { beforeEach, describe, expect, it, vi } from "vitest";

// detailpanel.svelte.ts imports settingsCtrl from settings.svelte.ts for
// Correction 2's split-axis derivation. settings.svelte.ts in turn imports
// legacy/bridge, which re-exports legacy/main.ts — a whole vanilla canvas app
// that boots on import and does `$("#cv").getContext("2d")` at module scope,
// throwing in bare jsdom (see resolver.svelte.test.ts's own "isolation" test
// for the same landmine). Mocked the same way settings.svelte.test.ts itself
// mocks it, so importing settingsCtrl here never evaluates the real canvas app.
vi.mock("../../legacy/bridge", () => ({
  applyThemeMode: vi.fn(),
  setGraphShowAllTags: vi.fn(),
  setGraphLabelPriority: vi.fn(),
  setGraphLabelLayout: vi.fn(),
  setDetailPanelPlacement: vi.fn(),
  setTamaEnabled: vi.fn(),
  applyTamaSkin: vi.fn(),
  clearTamaSkin: vi.fn(),
  setTamaMotionPreset: vi.fn(),
  setTamaPoseOverrides: vi.fn(),
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
}));

import { COMMIT_VIEW_TABS, WORKTREE_VIEW_TABS, detailPanelCtrl } from "./detailpanel.svelte.ts";

describe("the tab registries", () => {
  // Tabs are data, not markup branches, so adding one later is an array
  // entry. These assertions pin the sets and their order.
  it("gives the commit view two tabs", () => {
    expect(COMMIT_VIEW_TABS.map((t) => t.id)).toEqual(["commit", "changes"]);
  });

  it("gives the working tree three, with the stash last", () => {
    expect(WORKTREE_VIEW_TABS.map((t) => t.id)).toEqual(["commit", "changes", "stash"]);
  });

  // Each view names strings in its OWN namespace. The two "commit" tabs
  // deliberately do not share a key: one is the commit you are reading, the
  // other the commit you are writing, and a translator must be able to tell
  // them apart even though English collides.
  it("points each tab at a key in its own view's namespace", () => {
    expect(COMMIT_VIEW_TABS.map((t) => t.labelKey)).toEqual(["detail.tab_commit", "detail.changes"]);
    expect(WORKTREE_VIEW_TABS.map((t) => t.labelKey)).toEqual(["workdir.commit", "workdir.changes", "workdir.stash"]);
  });
});

describe("detailPanelCtrl", () => {
  beforeEach(() => {
    detailPanelCtrl.select("commit", "commit");
    detailPanelCtrl.select("worktree", "commit");
  });

  it("starts each view on its first tab", () => {
    expect(detailPanelCtrl.activeFor("commit")).toBe("commit");
    expect(detailPanelCtrl.activeFor("worktree")).toBe("commit");
  });

  // The two views keep separate active tabs: switching to the working tree
  // and back must not lose which commit tab you were reading.
  it("remembers each view's tab independently", () => {
    detailPanelCtrl.select("commit", "changes");
    detailPanelCtrl.select("worktree", "stash");
    expect(detailPanelCtrl.activeFor("commit")).toBe("changes");
    expect(detailPanelCtrl.activeFor("worktree")).toBe("stash");
  });

  // A tab id the view does not have must not become the active one — that
  // would render an empty panel with no way back.
  it("ignores a tab the view does not declare", () => {
    detailPanelCtrl.select("commit", "stash");
    expect(detailPanelCtrl.activeFor("commit")).toBe("commit");
  });

  it("hands back the right registry per view", () => {
    expect(detailPanelCtrl.tabsFor("commit")).toBe(COMMIT_VIEW_TABS);
    expect(detailPanelCtrl.tabsFor("worktree")).toBe(WORKTREE_VIEW_TABS);
  });
});
