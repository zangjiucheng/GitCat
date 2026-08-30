import { describe, expect, it, vi } from "vitest";

// COMMIT_VIEW_TABS/WORKTREE_VIEW_TABS live in detailpanel.svelte.ts, which
// (for the placement-driven split axis) imports settingsCtrl from
// settings.svelte.ts — and that in turn imports legacy/bridge, a live
// re-export of legacy/main.ts, a whole vanilla canvas app that boots on
// import and does `$("#cv").getContext("2d")` at module scope, throwing in
// bare jsdom (see resolver.svelte.test.ts's own "isolation" test for the same
// landmine). Mocked the same way detailpanel.svelte.test.ts and
// settings.svelte.test.ts itself mock it, so importing the registry here
// never evaluates the real canvas app.
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

import { COMMIT_VIEW_TABS, WORKTREE_VIEW_TABS } from "./detailpanel.svelte.ts";

describe("TabStrip's contract with the registry", () => {
  // The strip renders whatever it is handed, so the meaningful assertion is
  // that a registry entry needs nothing beyond an id and a label key.
  it("needs only id and labelKey from an entry", () => {
    for (const tab of [...COMMIT_VIEW_TABS, ...WORKTREE_VIEW_TABS]) {
      expect(Object.keys(tab).sort()).toEqual(["id", "labelKey"]);
    }
  });

  it("gives every tab a translatable, namespaced key", () => {
    for (const tab of [...COMMIT_VIEW_TABS, ...WORKTREE_VIEW_TABS]) {
      expect(tab.labelKey).toMatch(/^(detail|workdir)\.[a-z_]+$/);
    }
  });
});
