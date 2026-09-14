// Tab cycling. The subtlety is that the panel has TWO views with separate
// active tabs (switching to the working tree and back must not lose which
// commit tab you were reading), and which one `t` acts on comes from the pane
// marker under focus, not from any state the keymap keeps.
import { beforeEach, describe, expect, it, vi } from "vitest";

const ctrl = vi.hoisted(() => {
  // Mirrors the real registries: the commit view has two tabs, the working
  // tree three (the stash is genuinely a separate thing).
  const COMMIT = [{ id: "commit" }, { id: "changes" }];
  const WORKTREE = [{ id: "commit" }, { id: "changes" }, { id: "stash" }];
  return {
    commitTab: "commit",
    worktreeTab: "commit",
    tabsFor: (v: string) => (v === "commit" ? COMMIT : WORKTREE),
    activeFor(v: string) {
      return v === "commit" ? this.commitTab : this.worktreeTab;
    },
    select: vi.fn(function (this: typeof ctrl, v: string, id: string) {
      if (v === "commit") this.commitTab = id;
      else this.worktreeTab = id;
    }),
  };
});
vi.mock("@/islands/detailpanel/detailpanel.svelte.ts", () => ({ detailPanelCtrl: ctrl }));

const wd = vi.hoisted(() => ({ selected: false }));
vi.mock("@/islands/workdir/workdir.svelte.ts", () => ({ workdirCtrl: wd }));

import { detailKeys } from "./detail.ts";

/** Which view is SHOWING — the same signal DetailPanel derives from. */
function showing(view: "commit" | "worktree") {
  wd.selected = view === "worktree";
}

/** Where focus happens to be. Deliberately independent of `showing`. */
function focusIn(pane: string) {
  document.body.innerHTML = `<div data-pane="${pane}" tabindex="-1"><button id="x"></button></div>`;
  document.getElementById("x")!.focus();
}

beforeEach(() => {
  ctrl.commitTab = "commit";
  ctrl.worktreeTab = "commit";
  wd.selected = false;
  vi.clearAllMocks();
});

describe("cycleTab", () => {
  it("advances the commit view's tab when focus is in the detail pane", () => {
    showing("commit");
    detailKeys.cycleTab(1);
    expect(ctrl.select).toHaveBeenCalledWith("commit", "changes");
  });

  it("advances the WORKTREE view's tab when the working tree is showing", () => {
    // The two views keep separate active tabs, so `t` must not cross over.
    showing("worktree");
    detailKeys.cycleTab(1);
    expect(ctrl.select).toHaveBeenCalledWith("worktree", "changes");
    expect(ctrl.commitTab).toBe("commit"); // untouched
  });

  it("follows the VISIBLE view, not the pane under focus", () => {
    // Workdir's own tab strip, the expanded-diff header and #detail's chrome
    // all live in the parent `detail` pane. A focus-based answer cycled the
    // hidden commit tabs while the working tree was on screen — the visible
    // strip did not move, and switching back to a commit landed on a different
    // tab than the one you left.
    showing("worktree");
    focusIn("detail");
    detailKeys.cycleTab(1);
    expect(ctrl.select).toHaveBeenCalledWith("worktree", "changes");
    expect(ctrl.commitTab).toBe("commit");
  });

  it("wraps at the end rather than dead-ending on the last tab", () => {
    // `t` is one key; a strip with no wrap would need a second one to escape.
    showing("commit");
    ctrl.commitTab = "changes";
    detailKeys.cycleTab(1);
    expect(ctrl.select).toHaveBeenCalledWith("commit", "commit");
  });

  it("wraps backwards too", () => {
    showing("commit");
    detailKeys.cycleTab(-1);
    expect(ctrl.select).toHaveBeenCalledWith("commit", "changes");
  });

  it("cycles all three of the working tree's tabs", () => {
    showing("worktree");
    detailKeys.cycleTab(1);
    expect(ctrl.select).toHaveBeenLastCalledWith("worktree", "changes");
    detailKeys.cycleTab(1);
    expect(ctrl.select).toHaveBeenLastCalledWith("worktree", "stash");
    detailKeys.cycleTab(1);
    expect(ctrl.select).toHaveBeenLastCalledWith("worktree", "commit");
  });

  it("lands on the first tab when the active one is unknown", () => {
    // The view changed under us; guessing an offset from -1 would land on the
    // last tab instead, which reads as the key going backwards.
    showing("commit");
    ctrl.commitTab = "gone";
    detailKeys.cycleTab(1);
    expect(ctrl.select).toHaveBeenCalledWith("commit", "commit");
  });

  it("uses the commit view when the working tree is not selected", () => {
    showing("commit");
    document.body.innerHTML = `<button id="y"></button>`;
    document.getElementById("y")!.focus();
    detailKeys.cycleTab(1);
    expect(ctrl.select).toHaveBeenCalledWith("commit", "changes");
  });

  it("declines when the view has fewer than two tabs", () => {
    const orig = ctrl.tabsFor;
    ctrl.tabsFor = () => [{ id: "only" }];
    showing("commit");
    expect(detailKeys.cycleTab(1)).toBe(false);
    expect(ctrl.select).not.toHaveBeenCalled();
    ctrl.tabsFor = orig;
  });
});
