// Tests for the sidebar (refs tree + branch context menu) controller.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  CUR_REPO: "/repo",
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
  reloadGraph: vi.fn(async () => {}),
  armDanger: vi.fn(),
  updateBranchPill: vi.fn(),
  relTime: (t: number) => t + "s ago",
  enterSubmodule: vi.fn(),
}));

let mockInTauri = false;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    listRefs: vi.fn(),
    checkout: vi.fn(),
    checkoutDiscard: vi.fn(),
    createBranch: vi.fn(),
    deleteBranch: vi.fn(),
    createTag: vi.fn(),
    deleteTag: vi.fn(),
    pushTag: vi.fn(),
    stashSave: vi.fn(),
    stashList: vi.fn(),
    stashApply: vi.fn(),
    stashPop: vi.fn(),
    submoduleStatus: vi.fn(),
    submoduleInit: vi.fn(),
    submoduleUpdate: vi.fn(),
    submoduleAdd: vi.fn(),
    submoduleSync: vi.fn(),
    submoduleDeinit: vi.fn(),
    submoduleRemove: vi.fn(),
    getVisibleBranches: vi.fn(),
    setVisibleBranches: vi.fn(),
    branchMergeStatus: vi.fn(),
  },
}));

vi.mock("../resolver/resolver.svelte.ts", () => ({
  resolver: {
    openDemo: vi.fn(),
    startRebase: vi.fn(async () => {}),
    startMerge: vi.fn(async () => {}),
    startMergeSquash: vi.fn(async () => {}),
    openStashConflict: vi.fn(async () => {}),
  },
}));

import * as bridge from "../../legacy/bridge";
import { commands } from "../../ipc/bindings";
import { resolver } from "../resolver/resolver.svelte.ts";
import { sidebarCtrl, submoduleAction, submoduleNeedsForceConfirm, submoduleCanOpen, SUBMODULES_ALL, SUBMODULES_SYNC_ALL } from "./sidebar.svelte.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}

function resetAll() {
  sidebarCtrl.locals = [];
  sidebarCtrl.remotes = [];
  sidebarCtrl.tags = [];
  sidebarCtrl.submodules = [];
  sidebarCtrl.head = null;
  sidebarCtrl.visibleLocal = null;
  sidebarCtrl.visibleRemote = null;
  sidebarCtrl.autoMode = false;
  sidebarCtrl.snapshots = [];
  sidebarCtrl.filter = "";
  sidebarCtrl.busy = false;
  sidebarCtrl.menu = null;
  sidebarCtrl.tagMenu = null;
  sidebarCtrl.mergeMenu = null;
  sidebarCtrl.dirtyCheckoutMenu = null;
  sidebarCtrl.checkoutConfirm = null;
  sidebarCtrl.newTagOpen = false;
  sidebarCtrl.newTagName = "";
  sidebarCtrl.newTagMessage = "";
  sidebarCtrl.newTagFrom = "";
  sidebarCtrl.hasRepo = false;
  sidebarCtrl.copiedSnapshotSha = "";
  sidebarCtrl.copiedBranch = "";
  sidebarCtrl.submodulesRecursive = false;
  sidebarCtrl.newSubmoduleOpen = false;
  sidebarCtrl.newSubmoduleUrl = "";
  sidebarCtrl.newSubmodulePath = "";
  sidebarCtrl.newSubmoduleBranch = "";
  mockInTauri = false;
  vi.clearAllMocks();
  // Default: no submodules, so the many pre-existing "refresh"/checkout/etc.
  // tests below that never touch submodule_status at all don't have to care
  // that refresh() now also fires it in parallel — only the "submodules"
  // describe block overrides this per-test.
  vi.mocked(commands.submoduleStatus).mockResolvedValue(ok([]));
  // Default: no branch-visibility filter, same "don't make every other test
  // care about this" reasoning as submoduleStatus above — only the
  // "branch visibility" describe block overrides this per-test.
  vi.mocked(commands.getVisibleBranches).mockResolvedValue(ok({ local: null, remote: null, auto: false }));
}

beforeEach(() => {
  resetAll();
});

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", () => {
    expect(document.getElementById("cv")).toBeNull();
    expect(sidebarCtrl).toBeDefined();
  });
});

describe("refresh", () => {
  it("design mode: seeds demo refs and updates the branch pill", async () => {
    mockInTauri = false;
    await sidebarCtrl.refresh("/repo");
    expect(sidebarCtrl.locals.length).toBeGreaterThan(0);
    expect(sidebarCtrl.head).toBe("main");
    expect(sidebarCtrl.hasRepo).toBe(true);
    expect(commands.listRefs).not.toHaveBeenCalled();
    expect(bridge.updateBranchPill).toHaveBeenCalled();
  });

  it("real mode: populates from commands.listRefs", async () => {
    mockInTauri = true;
    vi.mocked(commands.listRefs).mockResolvedValueOnce(
      ok({
        head: "main",
        locals: [{ name: "main", sha: "abc1234", ahead: 1, behind: 0, upstream: "origin/main" }],
        remotes: [{ name: "origin/main", sha: "abc1234" }],
        tags: [{ name: "v1.0.0", sha: "abc1234" }],
      }),
    );
    await sidebarCtrl.refresh("/repo");
    expect(sidebarCtrl.locals).toEqual([{ name: "main", sha: "abc1234", ahead: 1, behind: 0, upstream: "origin/main" }]);
    expect(sidebarCtrl.head).toBe("main");
    expect(sidebarCtrl.hasRepo).toBe(true);
    expect(bridge.updateBranchPill).toHaveBeenCalledWith("main", sidebarCtrl.locals);
  });

  it("real mode: logs and leaves ref state untouched on error, but hasRepo still flips (a repo IS open, listing just failed)", async () => {
    mockInTauri = true;
    vi.mocked(commands.listRefs).mockResolvedValueOnce(err("repo not found"));
    await sidebarCtrl.refresh("/repo");
    expect(sidebarCtrl.locals).toEqual([]);
    expect(sidebarCtrl.hasRepo).toBe(true);
  });

  it("real mode: no-ops without a repo path, hasRepo stays false", async () => {
    mockInTauri = true;
    await sidebarCtrl.refresh("");
    expect(commands.listRefs).not.toHaveBeenCalled();
    expect(commands.submoduleStatus).not.toHaveBeenCalled();
    expect(sidebarCtrl.hasRepo).toBe(false);
  });

  it("real mode: also populates the branch-visibility filter from commands.getVisibleBranches", async () => {
    mockInTauri = true;
    vi.mocked(commands.getVisibleBranches).mockResolvedValueOnce(ok({ local: ["main"], remote: [], auto: false }));
    await sidebarCtrl.refresh("/repo");
    expect(sidebarCtrl.visibleLocal).toEqual(["main"]);
    expect(sidebarCtrl.visibleRemote).toEqual([]);
    expect(sidebarCtrl.autoMode).toBe(false);
  });

  it("real mode: auto mode recomputes the filter after refs are loaded, using fresh ahead/behind + merge data", async () => {
    mockInTauri = true;
    vi.mocked(commands.listRefs).mockResolvedValueOnce(
      ok({
        head: "main",
        locals: [
          { name: "main", sha: "a", ahead: 0, behind: 0, upstream: "origin/main" },
          { name: "feature", sha: "b", ahead: 2, behind: 0, upstream: "origin/feature" },
          { name: "merged-done", sha: "c", ahead: 0, behind: 0, upstream: "origin/merged-done" },
        ],
        remotes: [],
        tags: [],
      }),
    );
    vi.mocked(commands.getVisibleBranches).mockResolvedValueOnce(ok({ local: null, remote: null, auto: true }));
    vi.mocked(commands.branchMergeStatus).mockResolvedValueOnce(ok({ defaultBranch: "main", merged: ["merged-done"] }));
    vi.mocked(commands.setVisibleBranches).mockResolvedValueOnce(ok(null));

    await sidebarCtrl.refresh("/repo");

    expect(sidebarCtrl.autoMode).toBe(true);
    // main (current) and feature (unpushed) are kept; merged-done is merged
    // into main AND has nothing unpushed, so auto mode hides it.
    expect(sidebarCtrl.visibleLocal).toEqual(["main", "feature"]);
    expect(sidebarCtrl.visibleRemote).toBeNull();
    expect(commands.setVisibleBranches).toHaveBeenCalledWith("/repo", true, ["main", "feature"], null);
  });
});

describe("branch visibility", () => {
  it("isBranchVisible: everything is visible when no filter is set (null)", () => {
    sidebarCtrl.visibleLocal = null;
    sidebarCtrl.visibleRemote = null;
    expect(sidebarCtrl.isBranchVisible("local", "anything")).toBe(true);
    expect(sidebarCtrl.isBranchVisible("remote", "origin/anything")).toBe(true);
  });

  it("isBranchVisible: only names in the set are visible once filtering", () => {
    sidebarCtrl.visibleLocal = ["main"];
    expect(sidebarCtrl.isBranchVisible("local", "main")).toBe(true);
    expect(sidebarCtrl.isBranchVisible("local", "other")).toBe(false);
  });

  it("isFiltering reflects whether either set is non-null", () => {
    sidebarCtrl.visibleLocal = null;
    sidebarCtrl.visibleRemote = null;
    expect(sidebarCtrl.isFiltering).toBe(false);
    sidebarCtrl.visibleLocal = ["main"];
    expect(sidebarCtrl.isFiltering).toBe(true);
  });

  it("toggleBranchVisible: first toggle (hiding one) seeds from the full current list, not empty", async () => {
    mockInTauri = true;
    sidebarCtrl.locals = [
      { name: "main", sha: "a", ahead: null, behind: null, upstream: null },
      { name: "dev", sha: "b", ahead: null, behind: null, upstream: null },
    ];
    sidebarCtrl.visibleLocal = null; // unfiltered
    await sidebarCtrl.toggleBranchVisible("/repo", "local", "dev");
    expect(sidebarCtrl.visibleLocal).toEqual(["main"]);
    expect(commands.setVisibleBranches).toHaveBeenCalledWith("/repo", false, ["main"], null);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
  });

  it("toggleBranchVisible: a manual toggle turns auto mode off (grabbing the wheel exits autopilot)", async () => {
    mockInTauri = true;
    sidebarCtrl.autoMode = true;
    sidebarCtrl.locals = [{ name: "main", sha: "a", ahead: null, behind: null, upstream: null }];
    sidebarCtrl.visibleLocal = ["main"];
    await sidebarCtrl.toggleBranchVisible("/repo", "local", "main");
    expect(sidebarCtrl.autoMode).toBe(false);
    expect(commands.setVisibleBranches).toHaveBeenCalledWith("/repo", false, [], null);
  });

  it("toggleBranchVisible: toggling an already-hidden name back on re-adds just that name", async () => {
    mockInTauri = true;
    sidebarCtrl.visibleLocal = ["main"];
    await sidebarCtrl.toggleBranchVisible("/repo", "local", "dev");
    expect(sidebarCtrl.visibleLocal).toEqual(["main", "dev"]);
  });

  it("toggleBranchVisible: works independently for remote branches", async () => {
    mockInTauri = true;
    sidebarCtrl.remotes = [{ name: "origin/main", sha: "a" }, { name: "origin/dev", sha: "b" }];
    sidebarCtrl.visibleRemote = null;
    await sidebarCtrl.toggleBranchVisible("/repo", "remote", "origin/dev");
    expect(sidebarCtrl.visibleRemote).toEqual(["origin/main"]);
    // toggling a remote must not touch the local filter
    expect(sidebarCtrl.visibleLocal).toBeNull();
  });

  it("showAllBranches resets both sets AND auto mode to null/off, and persists", async () => {
    mockInTauri = true;
    sidebarCtrl.autoMode = true;
    sidebarCtrl.visibleLocal = ["main"];
    sidebarCtrl.visibleRemote = [];
    await sidebarCtrl.showAllBranches("/repo");
    expect(sidebarCtrl.autoMode).toBe(false);
    expect(sidebarCtrl.visibleLocal).toBeNull();
    expect(sidebarCtrl.visibleRemote).toBeNull();
    expect(commands.setVisibleBranches).toHaveBeenCalledWith("/repo", false, null, null);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
  });

  it("toggleAutoMode: turning it on recomputes+persists immediately (current branch + unpushed + unmerged kept)", async () => {
    mockInTauri = true;
    sidebarCtrl.head = "main";
    sidebarCtrl.locals = [
      { name: "main", sha: "a", ahead: 0, behind: 0, upstream: "origin/main" },
      { name: "no-upstream", sha: "b", ahead: null, behind: null, upstream: null },
      { name: "merged-and-pushed", sha: "c", ahead: 0, behind: 0, upstream: "origin/merged-and-pushed" },
    ];
    vi.mocked(commands.branchMergeStatus).mockResolvedValueOnce(ok({ defaultBranch: "main", merged: ["merged-and-pushed"] }));

    await sidebarCtrl.toggleAutoMode("/repo");

    expect(sidebarCtrl.autoMode).toBe(true);
    expect(sidebarCtrl.visibleLocal).toEqual(["main", "no-upstream"]);
    expect(commands.setVisibleBranches).toHaveBeenCalledWith("/repo", true, ["main", "no-upstream"], null);
  });

  it("recomputeAutoVisibility: a branch merged into default but with NO upstream is still hidden (regression — used to stay visible forever)", async () => {
    mockInTauri = true;
    sidebarCtrl.head = "main";
    sidebarCtrl.locals = [
      { name: "main", sha: "a", ahead: 0, behind: 0, upstream: "origin/main" },
      // Never pushed at all (e.g. a local-only topic branch, or its remote
      // counterpart was deleted after a squash-merge) — upstream: null, but
      // it IS fully merged into main. Must be hidden just like a merged
      // branch that happens to have upstream tracking.
      { name: "merged-no-upstream", sha: "b", ahead: null, behind: null, upstream: null },
      { name: "unmerged-no-upstream", sha: "c", ahead: null, behind: null, upstream: null },
    ];
    vi.mocked(commands.branchMergeStatus).mockResolvedValueOnce(ok({ defaultBranch: "main", merged: ["merged-no-upstream"] }));

    await sidebarCtrl.recomputeAutoVisibility("/repo");

    expect(sidebarCtrl.visibleLocal).toEqual(["main", "unmerged-no-upstream"]);
  });

  it("toggleAutoMode: turning it off is a full reset, same as showAllBranches", async () => {
    mockInTauri = true;
    sidebarCtrl.autoMode = true;
    sidebarCtrl.visibleLocal = ["main"];
    await sidebarCtrl.toggleAutoMode("/repo");
    expect(sidebarCtrl.autoMode).toBe(false);
    expect(sidebarCtrl.visibleLocal).toBeNull();
    expect(commands.branchMergeStatus).not.toHaveBeenCalled();
  });

  it("recomputeAutoVisibility: when branch_merge_status can't resolve a default branch, nothing is hidden purely from merge status", async () => {
    mockInTauri = true;
    sidebarCtrl.head = "main";
    sidebarCtrl.locals = [
      { name: "main", sha: "a", ahead: 0, behind: 0, upstream: "origin/main" },
      { name: "old-but-unresolved", sha: "b", ahead: 0, behind: 0, upstream: "origin/old-but-unresolved" },
    ];
    vi.mocked(commands.branchMergeStatus).mockResolvedValueOnce(ok({ defaultBranch: null, merged: [] }));

    await sidebarCtrl.recomputeAutoVisibility("/repo");

    expect(sidebarCtrl.visibleLocal).toEqual(["main", "old-but-unresolved"]);
  });

  it("recomputeAutoVisibility: design mode still filters from local ahead/upstream data, just skipping the merge-status term (no backend to ask)", async () => {
    mockInTauri = false;
    sidebarCtrl.head = "main";
    sidebarCtrl.locals = [
      { name: "main", sha: "a", ahead: 2, behind: null, upstream: "origin/main" },
      { name: "feat/inline-diff", sha: "b", ahead: null, behind: 3, upstream: "origin/feat/inline-diff" },
      { name: "fix/lane-cull", sha: "c", ahead: null, behind: null, upstream: null },
    ];
    await sidebarCtrl.recomputeAutoVisibility("/repo");
    // main (current + ahead) and fix/lane-cull (no upstream) are kept;
    // feat/inline-diff has nothing ahead and a real upstream, so with no
    // merge data to fall back on it's the one case design mode can't tell
    // apart from "already merged" — dropped, same as toggling Auto used to
    // silently do nothing at all (this at least narrows the list visibly).
    expect(sidebarCtrl.visibleLocal).toEqual(["main", "fix/lane-cull"]);
    expect(commands.branchMergeStatus).not.toHaveBeenCalled();
  });

  it("design mode: toggling updates local state only, no IPC call, no graph reload", async () => {
    mockInTauri = false;
    sidebarCtrl.locals = [{ name: "main", sha: "a", ahead: null, behind: null, upstream: null }];
    sidebarCtrl.visibleLocal = null;
    await sidebarCtrl.toggleBranchVisible("/repo", "local", "main");
    expect(sidebarCtrl.visibleLocal).toEqual([]);
    expect(commands.setVisibleBranches).not.toHaveBeenCalled();
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
  });
});

describe("submodules", () => {
  it("design mode: seeds demo submodules covering all 5 statuses", async () => {
    mockInTauri = false;
    await sidebarCtrl.refresh("/repo");
    expect(sidebarCtrl.submodules.length).toBeGreaterThan(0);
    expect(commands.submoduleStatus).not.toHaveBeenCalled();
    expect(new Set(sidebarCtrl.submodules.map((s) => s.status))).toEqual(new Set(["clean", "dirty", "out-of-date", "not-initialized", "conflicted"]));
  });

  it("real mode: populates from commands.submoduleStatus, in parallel with list_refs", async () => {
    mockInTauri = true;
    vi.mocked(commands.listRefs).mockResolvedValueOnce(ok({ head: "main", locals: [], remotes: [], tags: [] }));
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(
      ok([
        { name: "vendor/a", path: "vendor/a", absolutePath: "/repo/vendor/a", url: "https://example.com/a.git", status: "clean", headSha: "aaa1111", workdirSha: "aaa1111" },
        { name: "vendor/b", path: "vendor/b", absolutePath: "/repo/vendor/b", url: "https://example.com/b.git", status: "dirty", headSha: "bbb2222", workdirSha: "bbb2222" },
      ]),
    );
    await sidebarCtrl.refresh("/repo");
    expect(commands.submoduleStatus).toHaveBeenCalledWith("/repo");
    expect(sidebarCtrl.submodules).toEqual([
      { name: "vendor/a", path: "vendor/a", absolutePath: "/repo/vendor/a", url: "https://example.com/a.git", status: "clean", headSha: "aaa1111", workdirSha: "aaa1111" },
      { name: "vendor/b", path: "vendor/b", absolutePath: "/repo/vendor/b", url: "https://example.com/b.git", status: "dirty", headSha: "bbb2222", workdirSha: "bbb2222" },
    ]);
  });

  it("real mode: each of the 5 backend statuses passes through to state unchanged (the view keys its status chip color off this exact string)", async () => {
    mockInTauri = true;
    const fixture = [
      { name: "a", path: "a", absolutePath: "/repo/a", url: null, status: "not-initialized", headSha: "sha1", workdirSha: null },
      { name: "b", path: "b", absolutePath: "/repo/b", url: null, status: "out-of-date", headSha: "sha2", workdirSha: "sha3" },
      { name: "c", path: "c", absolutePath: "/repo/c", url: null, status: "dirty", headSha: "sha4", workdirSha: "sha4" },
      { name: "d", path: "d", absolutePath: "/repo/d", url: null, status: "clean", headSha: "sha5", workdirSha: "sha5" },
      { name: "e", path: "e", absolutePath: "/repo/e", url: null, status: "conflicted", headSha: "sha6", workdirSha: "sha7" },
    ];
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(ok(fixture));
    await sidebarCtrl.refresh("/repo");
    expect(sidebarCtrl.submodules.map((s) => s.status)).toEqual(["not-initialized", "out-of-date", "dirty", "clean", "conflicted"]);
  });

  it("real mode: a conflicted submodule (Bug 3 — merge-conflicted gitlink) reports differing head/workdir shas, never 'clean'", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(
      ok([{ name: "sub", path: "sub", absolutePath: "/repo/sub", url: null, status: "conflicted", headSha: "c1c1c1c", workdirSha: "c0c0c0c" }]),
    );
    await sidebarCtrl.refresh("/repo");
    expect(sidebarCtrl.submodules).toEqual([{ name: "sub", path: "sub", absolutePath: "/repo/sub", url: null, status: "conflicted", headSha: "c1c1c1c", workdirSha: "c0c0c0c" }]);
    expect(sidebarCtrl.submodules[0].status).not.toBe("clean");
  });

  it("real mode: an unreadable submodule (CRASH FIX — cyclic nested-submodule reference) passes through unchanged, never 'clean'", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(
      ok([{ name: "sub", path: "sub", absolutePath: "/repo/sub", url: null, status: "unreadable", headSha: "c1c1c1c", workdirSha: "c0c0c0c" }]),
    );
    await sidebarCtrl.refresh("/repo");
    expect(sidebarCtrl.submodules).toEqual([{ name: "sub", path: "sub", absolutePath: "/repo/sub", url: null, status: "unreadable", headSha: "c1c1c1c", workdirSha: "c0c0c0c" }]);
    expect(sidebarCtrl.submodules[0].status).not.toBe("clean");
  });

  it("real mode: empty list clears submodules", async () => {
    mockInTauri = true;
    sidebarCtrl.submodules = [{ name: "old", path: "old", absolutePath: "/repo/old", url: null, status: "clean", headSha: "x", workdirSha: "x" }];
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(ok([]));
    await sidebarCtrl.refresh("/repo");
    expect(sidebarCtrl.submodules).toEqual([]);
  });

  it("real mode: logs and leaves submodule state untouched on error", async () => {
    mockInTauri = true;
    const prior = [{ name: "old", path: "old", absolutePath: "/repo/old", url: null, status: "clean", headSha: "x", workdirSha: "x" }];
    sidebarCtrl.submodules = prior;
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(err("not a repo"));
    await sidebarCtrl.refresh("/repo");
    expect(sidebarCtrl.submodules).toEqual(prior);
  });

  it("real mode: a list_refs failure doesn't block submodule_status from firing (independent, parallel reads)", async () => {
    mockInTauri = true;
    vi.mocked(commands.listRefs).mockResolvedValueOnce(err("repo not found"));
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(
      ok([{ name: "vendor/a", path: "vendor/a", absolutePath: "/repo/vendor/a", url: null, status: "clean", headSha: "aaa", workdirSha: "aaa" }]),
    );
    await sidebarCtrl.refresh("/repo");
    expect(sidebarCtrl.submodules).toEqual([{ name: "vendor/a", path: "vendor/a", absolutePath: "/repo/vendor/a", url: null, status: "clean", headSha: "aaa", workdirSha: "aaa" }]);
  });
});

describe("submoduleAction (row action gate)", () => {
  it("not-initialized -> init", () => {
    expect(submoduleAction("not-initialized")).toBe("init");
  });

  it("out-of-date -> update", () => {
    expect(submoduleAction("out-of-date")).toBe("update");
  });

  it("dirty -> blocked (a disabled button is shown, not absent)", () => {
    expect(submoduleAction("dirty")).toBe("blocked");
  });

  it("conflicted -> blocked", () => {
    expect(submoduleAction("conflicted")).toBe("blocked");
  });

  it("clean -> null (no action button at all)", () => {
    expect(submoduleAction("clean")).toBeNull();
  });

  it("removed -> null (Bug 6 fix: already staged for removal, nothing left to Init/Update)", () => {
    expect(submoduleAction("removed")).toBeNull();
  });

  it("unreadable -> null (CRASH FIX: cyclic/unreadable submodule, nothing left to Init/Update)", () => {
    expect(submoduleAction("unreadable")).toBeNull();
  });
});

describe("submoduleNeedsForceConfirm (Deinit's confirm gate)", () => {
  it("dirty -> true (a confirm is shown)", () => {
    expect(submoduleNeedsForceConfirm("dirty")).toBe(true);
  });

  it("conflicted -> true", () => {
    expect(submoduleNeedsForceConfirm("conflicted")).toBe(true);
  });

  it("clean -> false (no confirm — Deinit calls straight through)", () => {
    expect(submoduleNeedsForceConfirm("clean")).toBe(false);
  });

  it("out-of-date -> false", () => {
    expect(submoduleNeedsForceConfirm("out-of-date")).toBe(false);
  });

  it("removed -> false (nothing left to deinit — the row offers no Deinit button at all)", () => {
    expect(submoduleNeedsForceConfirm("removed")).toBe(false);
  });

  it("not-initialized -> false", () => {
    expect(submoduleNeedsForceConfirm("not-initialized")).toBe(false);
  });

  it("unreadable -> false (nothing left to deinit — the row offers no Deinit button at all)", () => {
    expect(submoduleNeedsForceConfirm("unreadable")).toBe(false);
  });
});

describe("submoduleCanOpen (Open row-action gate)", () => {
  it("clean -> true", () => {
    expect(submoduleCanOpen("clean")).toBe(true);
  });

  it("dirty -> true (a working tree exists, even though Update is separately blocked)", () => {
    expect(submoduleCanOpen("dirty")).toBe(true);
  });

  it("out-of-date -> true", () => {
    expect(submoduleCanOpen("out-of-date")).toBe(true);
  });

  it("conflicted -> true", () => {
    expect(submoduleCanOpen("conflicted")).toBe(true);
  });

  it("not-initialized -> false (never cloned — nothing on disk to open)", () => {
    expect(submoduleCanOpen("not-initialized")).toBe(false);
  });

  it("removed -> false (Bug 6 fix: already staged for removal, nothing left to open)", () => {
    expect(submoduleCanOpen("removed")).toBe(false);
  });

  it("unreadable -> false (CRASH FIX: cyclic/unreadable submodule, nothing safe to open)", () => {
    expect(submoduleCanOpen("unreadable")).toBe(false);
  });
});

describe("openSubmodule (per-row 'Open')", () => {
  it("design mode is a cosmetic no-op with a toast — never touches bridge.enterSubmodule", () => {
    mockInTauri = false;
    sidebarCtrl.openSubmodule("vendor/lib-a", "/repo/vendor/lib-a");
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("demo"));
    expect(bridge.enterSubmodule).not.toHaveBeenCalled();
  });

  it("real mode: calls bridge.enterSubmodule with the submodule's own absolute path", () => {
    mockInTauri = true;
    sidebarCtrl.openSubmodule("vendor/lib-a", "/repo/vendor/lib-a");
    expect(bridge.enterSubmodule).toHaveBeenCalledWith("/repo/vendor/lib-a");
  });

  it("sets busy/busyTarget (the RELATIVE path, matching Sidebar.svelte's `busyTarget === s.path` spinner check) while enterSubmodule (openRepo) is in flight, clears both once it settles", async () => {
    mockInTauri = true;
    let resolveEnter!: (ok: boolean) => void;
    vi.mocked(bridge.enterSubmodule).mockReturnValueOnce(new Promise((r) => (resolveEnter = r)));

    const p = sidebarCtrl.openSubmodule("vendor/lib-a", "/repo/vendor/lib-a");
    expect(sidebarCtrl.busy).toBe(true);
    expect(sidebarCtrl.busyTarget).toBe("vendor/lib-a");

    resolveEnter(true);
    await p;
    expect(sidebarCtrl.busy).toBe(false);
    expect(sidebarCtrl.busyTarget).toBeNull();
  });

  it("is a no-op re-entrancy guard while a switch is already in flight", () => {
    mockInTauri = true;
    vi.mocked(bridge.enterSubmodule).mockReturnValueOnce(new Promise(() => {})); // never settles
    sidebarCtrl.openSubmodule("vendor/lib-a", "/repo/vendor/lib-a");
    expect(bridge.enterSubmodule).toHaveBeenCalledTimes(1);

    sidebarCtrl.openSubmodule("vendor/lib-b", "/repo/vendor/lib-b");
    expect(bridge.enterSubmodule).toHaveBeenCalledTimes(1); // second click ignored
  });

  it("clears busy/busyTarget even if enterSubmodule rejects, so the row is clickable again", async () => {
    mockInTauri = true;
    vi.mocked(bridge.enterSubmodule).mockRejectedValueOnce(new Error("boom"));

    await sidebarCtrl.openSubmodule("vendor/lib-a", "/repo/vendor/lib-a").catch(() => {});

    expect(sidebarCtrl.busy).toBe(false);
    expect(sidebarCtrl.busyTarget).toBeNull();
  });
});

describe("deinitSubmodule (per-row 'Deinit')", () => {
  it("clean/out-of-date/not-initialized rows call submodule_deinit(force:false) directly, with no armDanger scrim", async () => {
    mockInTauri = true;
    for (const status of ["clean", "out-of-date", "not-initialized"]) {
      vi.mocked(commands.submoduleDeinit).mockResolvedValueOnce({ ok: true, message: "deinitialized", backupRef: null, backupPatch: null });
      vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(ok([]));
      await sidebarCtrl.deinitSubmodule("vendor/a", status);
    }
    expect(bridge.armDanger).not.toHaveBeenCalled();
    expect(commands.submoduleDeinit).toHaveBeenCalledTimes(3);
    expect(commands.submoduleDeinit).toHaveBeenCalledWith("/repo", "vendor/a", false);
  });

  it("dirty/conflicted rows arm the shared danger scrim with submodule-specific copy instead of calling straight through", () => {
    for (const status of ["dirty", "conflicted"]) {
      vi.clearAllMocks();
      sidebarCtrl.deinitSubmodule("vendor/a", status);
      expect(commands.submoduleDeinit).not.toHaveBeenCalled();
      expect(bridge.armDanger).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "vendor/a",
          confirmLabel: "Deinit submodule",
          title: "Deinit submodule — vendor/a",
          onConfirm: expect.any(Function),
        }),
      );
      const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
      expect(ctx.lose).toContain("vendor/a");
      expect(ctx.lose).toContain("gitgui/submodule-backup");
      expect(ctx.desc).toContain(".git/modules");
    }
  });

  it("onConfirm (from the dirty/conflicted scrim) calls submodule_deinit with force:true and refreshes on success", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleDeinit).mockResolvedValueOnce({ ok: true, message: "Deinitialized vendor/a (backup: gitgui/submodule-backup/1-2-0-vendor_a).", backupRef: null, backupPatch: "gitgui/submodule-backup/1-2-0-vendor_a" });
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(ok([]));
    sidebarCtrl.deinitSubmodule("vendor/a", "dirty");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();
    expect(commands.submoduleDeinit).toHaveBeenCalledWith("/repo", "vendor/a", true);
    expect(commands.submoduleStatus).toHaveBeenCalledWith("/repo");
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("backup: gitgui/submodule-backup"), expect.anything());
  });

  it("stale-status race: a force:false call refused with git's own 'local modifications ... use -f' message retries with force:true after window.confirm", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleDeinit)
      .mockResolvedValueOnce({
        ok: false,
        message: "fatal: Submodule work tree 'vendor/a' contains local modifications; use '-f' to discard them",
        backupRef: null,
        backupPatch: null,
      })
      .mockResolvedValueOnce({ ok: true, message: "Deinitialized vendor/a (backup: gitgui/submodule-backup/x).", backupRef: null, backupPatch: "gitgui/submodule-backup/x" });
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(ok([]));
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    // Row looked "clean" at the time of the click -> straight-through call
    // (no scrim shown), but git itself still refuses.
    await sidebarCtrl.deinitSubmodule("vendor/a", "clean");
    expect(commands.submoduleDeinit).toHaveBeenNthCalledWith(1, "/repo", "vendor/a", false);
    expect(commands.submoduleDeinit).toHaveBeenNthCalledWith(2, "/repo", "vendor/a", true);
    expect(commands.submoduleStatus).toHaveBeenCalledWith("/repo");
  });

  it("stale-status race: declining the window.confirm keeps the submodule and does not retry", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleDeinit).mockResolvedValueOnce({
      ok: false,
      message: "fatal: Submodule work tree 'vendor/a' contains local modifications; use '-f' to discard them",
      backupRef: null,
      backupPatch: null,
    });
    vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    await sidebarCtrl.deinitSubmodule("vendor/a", "clean");
    expect(commands.submoduleDeinit).toHaveBeenCalledTimes(1);
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("cancelled"));
  });

  it("real mode: a refusal surfaces via tama.warn and does not refresh (not a silent no-op)", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleDeinit).mockResolvedValueOnce({ ok: false, message: "Cannot open repository: not found", backupRef: null, backupPatch: null });
    await sidebarCtrl.deinitSubmodule("vendor/a", "clean");
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("Cannot open repository"));
    expect(commands.submoduleStatus).not.toHaveBeenCalled();
  });

  it("is re-entrancy locked while busy (direct, non-scrim path)", async () => {
    mockInTauri = true;
    sidebarCtrl.busy = true;
    await sidebarCtrl.deinitSubmodule("vendor/a", "clean");
    expect(commands.submoduleDeinit).not.toHaveBeenCalled();
  });

  it("scopes busy/busyTarget to just the acted-on row while in flight", async () => {
    mockInTauri = true;
    let resolveFn!: (v: { ok: boolean; message: string; backupRef: string | null; backupPatch: string | null }) => void;
    vi.mocked(commands.submoduleDeinit).mockImplementationOnce(() => new Promise((resolve) => (resolveFn = resolve)));
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(ok([]));
    const pending = sidebarCtrl.deinitSubmodule("vendor/a", "clean");
    expect(sidebarCtrl.busy).toBe(true);
    expect(sidebarCtrl.busyTarget).toBe("vendor/a");
    resolveFn({ ok: true, message: "deinitialized", backupRef: null, backupPatch: null });
    await pending;
    expect(sidebarCtrl.busy).toBe(false);
    expect(sidebarCtrl.busyTarget).toBeNull();
  });

  it("design mode is a cosmetic no-op with a toast (direct path)", async () => {
    mockInTauri = false;
    await sidebarCtrl.deinitSubmodule("vendor/a", "clean");
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("demo"));
    expect(commands.submoduleDeinit).not.toHaveBeenCalled();
  });
});

describe("removeSubmodule (per-row 'Remove', always confirmed)", () => {
  it("arms the shared danger scrim regardless of status — clean row", () => {
    sidebarCtrl.removeSubmodule("vendor/a");
    expect(commands.submoduleRemove).not.toHaveBeenCalled();
    expect(bridge.armDanger).toHaveBeenCalledWith(
      expect.objectContaining({ name: "vendor/a", confirmLabel: "Remove submodule", title: "Remove submodule — vendor/a", onConfirm: expect.any(Function) }),
    );
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    expect(ctx.lose).toContain(".gitmodules");
    expect(ctx.desc).toContain("staged");
  });

  it("arms the shared danger scrim regardless of status — dirty row", () => {
    sidebarCtrl.removeSubmodule("vendor/b");
    expect(commands.submoduleRemove).not.toHaveBeenCalled();
    expect(bridge.armDanger).toHaveBeenCalledWith(expect.objectContaining({ name: "vendor/b", confirmLabel: "Remove submodule" }));
  });

  it("onConfirm calls submodule_remove (no force param) and refreshes on success", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleRemove).mockResolvedValueOnce({ ok: true, message: "Removed vendor/a.", backupRef: null, backupPatch: null });
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(ok([]));
    sidebarCtrl.removeSubmodule("vendor/a");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();
    expect(commands.submoduleRemove).toHaveBeenCalledWith("/repo", "vendor/a");
    expect(commands.submoduleStatus).toHaveBeenCalledWith("/repo");
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });

  it("onConfirm surfaces a failure via tama.warn without refreshing", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleRemove).mockResolvedValueOnce({ ok: false, message: "fatal: pathspec did not match any files", backupRef: null, backupPatch: null });
    sidebarCtrl.removeSubmodule("vendor/a");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("pathspec did not match"));
    expect(commands.submoduleStatus).not.toHaveBeenCalled();
  });

  it("is re-entrancy locked while busy", async () => {
    mockInTauri = true;
    sidebarCtrl.busy = true;
    sidebarCtrl.removeSubmodule("vendor/a");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();
    expect(commands.submoduleRemove).not.toHaveBeenCalled();
  });

  it("scopes busy/busyTarget to just the acted-on row while in flight", async () => {
    mockInTauri = true;
    let resolveFn!: (v: { ok: boolean; message: string; backupRef: string | null; backupPatch: string | null }) => void;
    vi.mocked(commands.submoduleRemove).mockImplementationOnce(() => new Promise((resolve) => (resolveFn = resolve)));
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(ok([]));
    sidebarCtrl.removeSubmodule("vendor/a");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    const pending = ctx.onConfirm();
    expect(sidebarCtrl.busy).toBe(true);
    expect(sidebarCtrl.busyTarget).toBe("vendor/a");
    resolveFn({ ok: true, message: "removed", backupRef: null, backupPatch: null });
    await pending;
    expect(sidebarCtrl.busy).toBe(false);
    expect(sidebarCtrl.busyTarget).toBeNull();
  });

  it("design mode is a cosmetic no-op with a toast", async () => {
    mockInTauri = false;
    sidebarCtrl.removeSubmodule("vendor/a");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("demo"));
    expect(commands.submoduleRemove).not.toHaveBeenCalled();
  });
});

describe("initAndUpdateSubmodule (per-row 'Init + update', not-initialized rows)", () => {
  it("design mode is a cosmetic no-op with a toast", async () => {
    mockInTauri = false;
    await sidebarCtrl.initAndUpdateSubmodule("docs/theme");
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("demo"));
    expect(commands.submoduleUpdate).not.toHaveBeenCalled();
  });

  it("real mode: calls submodule_update with init:true, recursive:false and refreshes on success", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleUpdate).mockResolvedValueOnce({ ok: true, message: "initialized", backupRef: null, conflictingFiles: [] });
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(
      ok([{ name: "docs/theme", path: "docs/theme", absolutePath: "/repo/docs/theme", url: "https://example.com/theme.git", status: "clean", headSha: "a", workdirSha: "a" }]),
    );
    await sidebarCtrl.initAndUpdateSubmodule("docs/theme");
    expect(commands.submoduleUpdate).toHaveBeenCalledWith("/repo", "docs/theme", false, true);
    expect(commands.submoduleStatus).toHaveBeenCalledWith("/repo");
    expect(sidebarCtrl.submodules[0].status).toBe("clean");
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });

  it("real mode: a refusal surfaces via tama.warn and does not refresh (not a silent no-op)", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleUpdate).mockResolvedValueOnce({ ok: false, message: "submodule has local changes, update refused", backupRef: null, conflictingFiles: [] });
    await sidebarCtrl.initAndUpdateSubmodule("docs/theme");
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("update refused"));
    expect(commands.submoduleStatus).not.toHaveBeenCalled();
  });

  it("is re-entrancy locked while busy", async () => {
    mockInTauri = true;
    sidebarCtrl.busy = true;
    await sidebarCtrl.initAndUpdateSubmodule("docs/theme");
    expect(commands.submoduleUpdate).not.toHaveBeenCalled();
  });

  it("scopes busy/busyTarget to just the acted-on row (not the whole Submodules section) while in flight", async () => {
    mockInTauri = true;
    let resolveFn!: (v: { ok: boolean; message: string; backupRef: string | null; conflictingFiles: string[] }) => void;
    vi.mocked(commands.submoduleUpdate).mockImplementationOnce(() => new Promise((resolve) => (resolveFn = resolve)));
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(ok([]));
    const pending = sidebarCtrl.initAndUpdateSubmodule("docs/theme");
    expect(sidebarCtrl.busy).toBe(true);
    expect(sidebarCtrl.busyTarget).toBe("docs/theme");
    resolveFn({ ok: true, message: "initialized", backupRef: null, conflictingFiles: [] });
    await pending;
    expect(sidebarCtrl.busy).toBe(false);
    expect(sidebarCtrl.busyTarget).toBeNull();
  });
});

describe("updateSubmodule (per-row 'Update', out-of-date rows)", () => {
  it("design mode is a cosmetic no-op with a toast", async () => {
    mockInTauri = false;
    await sidebarCtrl.updateSubmodule("third_party/tool");
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("demo"));
    expect(commands.submoduleUpdate).not.toHaveBeenCalled();
  });

  it("real mode: calls submodule_update with init:false (already registered+cloned) and refreshes on success", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleUpdate).mockResolvedValueOnce({ ok: true, message: "updated", backupRef: null, conflictingFiles: [] });
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(
      ok([{ name: "third_party/tool", path: "third_party/tool", absolutePath: "/repo/third_party/tool", url: null, status: "clean", headSha: "a", workdirSha: "a" }]),
    );
    await sidebarCtrl.updateSubmodule("third_party/tool");
    expect(commands.submoduleUpdate).toHaveBeenCalledWith("/repo", "third_party/tool", false, false);
    expect(commands.submoduleStatus).toHaveBeenCalledWith("/repo");
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });

  it("real mode: a refusal (dirty submodule) surfaces via tama.warn and does not refresh", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleUpdate).mockResolvedValueOnce({ ok: false, message: "submodule has local changes, update refused", backupRef: null, conflictingFiles: [] });
    await sidebarCtrl.updateSubmodule("third_party/tool");
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("update refused"));
    expect(commands.submoduleStatus).not.toHaveBeenCalled();
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
  });

  it("is re-entrancy locked while busy", async () => {
    mockInTauri = true;
    sidebarCtrl.busy = true;
    await sidebarCtrl.updateSubmodule("third_party/tool");
    expect(commands.submoduleUpdate).not.toHaveBeenCalled();
  });
});

describe("updateAllSubmodules (bulk 'Update all')", () => {
  it("design mode is a cosmetic no-op with a toast", async () => {
    mockInTauri = false;
    await sidebarCtrl.updateAllSubmodules(false);
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("demo"));
    expect(commands.submoduleUpdate).not.toHaveBeenCalled();
  });

  it("real mode: calls submodule_update with submodulePath:null and init:true, passing the recursive flag through", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleUpdate).mockResolvedValueOnce({ ok: true, message: "updated", backupRef: null, conflictingFiles: [] });
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(ok([]));
    await sidebarCtrl.updateAllSubmodules(true);
    expect(commands.submoduleUpdate).toHaveBeenCalledWith("/repo", null, true, true);
  });

  it("real mode: recursive:false is passed through unchanged when the toggle is off", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleUpdate).mockResolvedValueOnce({ ok: true, message: "updated", backupRef: null, conflictingFiles: [] });
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(ok([]));
    await sidebarCtrl.updateAllSubmodules(false);
    expect(commands.submoduleUpdate).toHaveBeenCalledWith("/repo", null, false, true);
  });

  it("real mode: a refusal surfaces via tama.warn and does not refresh", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleUpdate).mockResolvedValueOnce({ ok: false, message: "submodule has local changes, update refused", backupRef: null, conflictingFiles: [] });
    await sidebarCtrl.updateAllSubmodules(false);
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("update refused"));
    expect(commands.submoduleStatus).not.toHaveBeenCalled();
  });

  it("is re-entrancy locked while busy", async () => {
    mockInTauri = true;
    sidebarCtrl.busy = true;
    await sidebarCtrl.updateAllSubmodules(true);
    expect(commands.submoduleUpdate).not.toHaveBeenCalled();
  });

  it("uses the SUBMODULES_ALL sentinel as busyTarget while in flight (distinct from any row's path)", async () => {
    mockInTauri = true;
    let resolveFn!: (v: { ok: boolean; message: string; backupRef: string | null; conflictingFiles: string[] }) => void;
    vi.mocked(commands.submoduleUpdate).mockImplementationOnce(() => new Promise((resolve) => (resolveFn = resolve)));
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(ok([]));
    const pending = sidebarCtrl.updateAllSubmodules(false);
    expect(sidebarCtrl.busy).toBe(true);
    expect(sidebarCtrl.busyTarget).toBe(SUBMODULES_ALL);
    resolveFn({ ok: true, message: "updated", backupRef: null, conflictingFiles: [] });
    await pending;
    expect(sidebarCtrl.busyTarget).toBeNull();
  });
});

describe("syncSubmodule (per-row 'Sync', any status)", () => {
  it("design mode is a cosmetic no-op with a toast", async () => {
    mockInTauri = false;
    await sidebarCtrl.syncSubmodule("vendor/a");
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("demo"));
    expect(commands.submoduleSync).not.toHaveBeenCalled();
  });

  it("real mode: calls submodule_sync with recursive:false and cheers on success", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleSync).mockResolvedValueOnce({ ok: true, message: "synced", backupRef: null, conflictingFiles: [] });
    await sidebarCtrl.syncSubmodule("vendor/a");
    expect(commands.submoduleSync).toHaveBeenCalledWith("/repo", "vendor/a", false);
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });

  it("real mode: a failure surfaces via tama.warn", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleSync).mockResolvedValueOnce({ ok: false, message: "no url found for submodule path", backupRef: null, conflictingFiles: [] });
    await sidebarCtrl.syncSubmodule("vendor/a");
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("no url found"));
  });

  it("is re-entrancy locked while busy", async () => {
    mockInTauri = true;
    sidebarCtrl.busy = true;
    await sidebarCtrl.syncSubmodule("vendor/a");
    expect(commands.submoduleSync).not.toHaveBeenCalled();
  });

  it("scopes busy/busyTarget to just the acted-on row (not the whole Submodules section) while in flight", async () => {
    mockInTauri = true;
    let resolveFn!: (v: { ok: boolean; message: string; backupRef: string | null; conflictingFiles: string[] }) => void;
    vi.mocked(commands.submoduleSync).mockImplementationOnce(() => new Promise((resolve) => (resolveFn = resolve)));
    const pending = sidebarCtrl.syncSubmodule("vendor/a");
    expect(sidebarCtrl.busy).toBe(true);
    expect(sidebarCtrl.busyTarget).toBe("vendor/a");
    resolveFn({ ok: true, message: "synced", backupRef: null, conflictingFiles: [] });
    await pending;
    expect(sidebarCtrl.busy).toBe(false);
    expect(sidebarCtrl.busyTarget).toBeNull();
  });
});

describe("syncAllSubmodules (bulk 'Sync all')", () => {
  it("design mode is a cosmetic no-op with a toast", async () => {
    mockInTauri = false;
    await sidebarCtrl.syncAllSubmodules(false);
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("demo"));
    expect(commands.submoduleSync).not.toHaveBeenCalled();
  });

  it("real mode: calls submodule_sync with submodulePath:null, passing the recursive flag through", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleSync).mockResolvedValueOnce({ ok: true, message: "synced", backupRef: null, conflictingFiles: [] });
    await sidebarCtrl.syncAllSubmodules(true);
    expect(commands.submoduleSync).toHaveBeenCalledWith("/repo", null, true);
  });

  it("real mode: recursive:false is passed through unchanged when the toggle is off", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleSync).mockResolvedValueOnce({ ok: true, message: "synced", backupRef: null, conflictingFiles: [] });
    await sidebarCtrl.syncAllSubmodules(false);
    expect(commands.submoduleSync).toHaveBeenCalledWith("/repo", null, false);
  });

  it("real mode: a failure surfaces via tama.warn", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleSync).mockResolvedValueOnce({ ok: false, message: "no url found for submodule path", backupRef: null, conflictingFiles: [] });
    await sidebarCtrl.syncAllSubmodules(false);
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("no url found"));
  });

  it("is re-entrancy locked while busy", async () => {
    mockInTauri = true;
    sidebarCtrl.busy = true;
    await sidebarCtrl.syncAllSubmodules(true);
    expect(commands.submoduleSync).not.toHaveBeenCalled();
  });

  it("uses the SUBMODULES_SYNC_ALL sentinel as busyTarget while in flight (distinct from SUBMODULES_ALL and any row's path)", async () => {
    mockInTauri = true;
    let resolveFn!: (v: { ok: boolean; message: string; backupRef: string | null; conflictingFiles: string[] }) => void;
    vi.mocked(commands.submoduleSync).mockImplementationOnce(() => new Promise((resolve) => (resolveFn = resolve)));
    const pending = sidebarCtrl.syncAllSubmodules(false);
    expect(sidebarCtrl.busy).toBe(true);
    expect(sidebarCtrl.busyTarget).toBe(SUBMODULES_SYNC_ALL);
    expect(sidebarCtrl.busyTarget).not.toBe(SUBMODULES_ALL);
    resolveFn({ ok: true, message: "synced", backupRef: null, conflictingFiles: [] });
    await pending;
    expect(sidebarCtrl.busyTarget).toBeNull();
  });
});

describe("checkout", () => {
  it("design mode is a cosmetic no-op with a toast", async () => {
    mockInTauri = false;
    await sidebarCtrl.checkout("feature");
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("demo"));
    expect(commands.checkout).not.toHaveBeenCalled();
  });

  it("real mode: reloads the graph and cheers on success", async () => {
    mockInTauri = true;
    vi.mocked(commands.checkout).mockResolvedValueOnce({ ok: true, message: "", backupRef: null, conflictingFiles: [] });
    await sidebarCtrl.checkout("feature");
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });

  it("real mode: warns on failure without reloading", async () => {
    mockInTauri = true;
    vi.mocked(commands.checkout).mockResolvedValueOnce({ ok: false, message: "dirty tree", backupRef: null, conflictingFiles: [] });
    await sidebarCtrl.checkout("feature");
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("dirty tree"));
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
  });

  it("is re-entrancy locked while busy", async () => {
    mockInTauri = true;
    sidebarCtrl.busy = true;
    await sidebarCtrl.checkout("feature");
    expect(commands.checkout).not.toHaveBeenCalled();
  });

  // Backlog #34: a dirty-tree collision (conflictingFiles non-empty) opens
  // the resolution chooser INSTEAD of the plain toast above — every other
  // kind of refusal (bad ref, name collision, …) must still hit that same
  // plain toast unchanged (regression-checked in its own test below).
  it("a dirty-tree collision opens the resolution chooser (not a toast), carrying the colliding files and position", async () => {
    mockInTauri = true;
    vi.mocked(commands.checkout).mockResolvedValueOnce({ ok: false, message: "would be overwritten", backupRef: null, conflictingFiles: ["a.txt", "b.txt"] });
    await sidebarCtrl.checkout("feature", { x: 10, y: 40 });
    expect(sidebarCtrl.dirtyCheckoutMenu).toEqual({ name: "feature", startPoint: null, files: ["a.txt", "b.txt"], x: 10, y: 40 });
    expect(bridge.tama.warn).not.toHaveBeenCalled();
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
  });

  it("a dirty-tree collision with no position given falls back to a default", async () => {
    mockInTauri = true;
    vi.mocked(commands.checkout).mockResolvedValueOnce({ ok: false, message: "would be overwritten", backupRef: null, conflictingFiles: ["a.txt"] });
    await sidebarCtrl.checkout("feature");
    expect(sidebarCtrl.dirtyCheckoutMenu).toEqual({ name: "feature", startPoint: null, files: ["a.txt"], x: 24, y: 80 });
  });

  // Regression check: the plain non-dirty checkout path (including every
  // OTHER kind of refusal) must stay completely unaffected by this feature.
  it("a failure with no conflictingFiles still just toasts the plain error, unaffected by this feature", async () => {
    mockInTauri = true;
    vi.mocked(commands.checkout).mockResolvedValueOnce({ ok: false, message: "not a valid branch name", backupRef: null, conflictingFiles: [] });
    await sidebarCtrl.checkout("feature");
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("not a valid branch name"));
    expect(sidebarCtrl.dirtyCheckoutMenu).toBeNull();
  });
});

describe("checkoutRemote", () => {
  it("with no matching local branch: creates one tracking the remote ref", async () => {
    mockInTauri = true;
    vi.mocked(commands.createBranch).mockResolvedValueOnce({ ok: true, message: "", backupRef: null, conflictingFiles: [] });
    await sidebarCtrl.checkoutRemote("origin/feature-x");
    expect(commands.createBranch).toHaveBeenCalledWith("/repo", "feature-x", "origin/feature-x", true);
    expect(commands.checkout).not.toHaveBeenCalled();
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
  });

  it("with an existing local branch of the same short name: switches to it instead of creating a duplicate", async () => {
    mockInTauri = true;
    sidebarCtrl.locals = [{ name: "feature-x", sha: "a1", ahead: null, behind: null, upstream: null }];
    vi.mocked(commands.checkout).mockResolvedValueOnce({ ok: true, message: "", backupRef: null, conflictingFiles: [] });
    await sidebarCtrl.checkoutRemote("origin/feature-x");
    expect(commands.checkout).toHaveBeenCalledWith("/repo", "feature-x");
    expect(commands.createBranch).not.toHaveBeenCalled();
  });

  it("design mode is a cosmetic no-op with a toast", async () => {
    mockInTauri = false;
    await sidebarCtrl.checkoutRemote("origin/feature-x");
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("demo"));
    expect(commands.createBranch).not.toHaveBeenCalled();
  });

  it("is re-entrancy locked while busy", async () => {
    mockInTauri = true;
    sidebarCtrl.busy = true;
    await sidebarCtrl.checkoutRemote("origin/feature-x");
    expect(commands.createBranch).not.toHaveBeenCalled();
  });

  // Backlog #34: create_branch(checkout:true)'s own dirty-tree collision
  // (byte-identical wording to plain checkout's — see git_write.rs's shared
  // classify_switch_failure) opens the SAME chooser, with startPoint set to
  // the remote ref so its 3 modes know to re-create-and-checkout rather than
  // switch to an already-existing local branch.
  it("a dirty-tree collision creating the new branch opens the chooser with startPoint = the remote ref", async () => {
    mockInTauri = true;
    vi.mocked(commands.createBranch).mockResolvedValueOnce({ ok: false, message: "would be overwritten", backupRef: null, conflictingFiles: ["a.txt"] });
    await sidebarCtrl.checkoutRemote("origin/feature-x", { x: 5, y: 6 });
    expect(sidebarCtrl.dirtyCheckoutMenu).toEqual({ name: "feature-x", startPoint: "origin/feature-x", files: ["a.txt"], x: 5, y: 6 });
    expect(bridge.tama.warn).not.toHaveBeenCalled();
  });

  it("forwards the position through to checkout() when delegating to an existing local branch of the same short name", async () => {
    mockInTauri = true;
    sidebarCtrl.locals = [{ name: "feature-x", sha: "a1", ahead: null, behind: null, upstream: null }];
    vi.mocked(commands.checkout).mockResolvedValueOnce({ ok: false, message: "would be overwritten", backupRef: null, conflictingFiles: ["a.txt"] });
    await sidebarCtrl.checkoutRemote("origin/feature-x", { x: 5, y: 6 });
    expect(sidebarCtrl.dirtyCheckoutMenu).toEqual({ name: "feature-x", startPoint: null, files: ["a.txt"], x: 5, y: 6 });
  });
});

// Backlog #34: dirty-tree resolution chooser — the popover itself (position/
// open-closes-other-popovers-and-vice-versa), then its 3 modes' orchestration.
describe("openDirtyCheckoutMenu / closeDirtyCheckoutMenu (#34)", () => {
  it("positions the chooser clamped to the viewport width", () => {
    sidebarCtrl.openDirtyCheckoutMenu("feature", null, ["a.txt"], window.innerWidth, 40);
    expect(sidebarCtrl.dirtyCheckoutMenu?.x).toBe(window.innerWidth - 260);
    expect(sidebarCtrl.dirtyCheckoutMenu?.y).toBe(40);
  });

  it("closeDirtyCheckoutMenu clears it", () => {
    sidebarCtrl.dirtyCheckoutMenu = { name: "x", startPoint: null, files: [], x: 0, y: 0 };
    sidebarCtrl.closeDirtyCheckoutMenu();
    expect(sidebarCtrl.dirtyCheckoutMenu).toBeNull();
  });

  it("opening it closes an open branch menu, tag menu, submodule menu, and merge menu", () => {
    sidebarCtrl.menu = { name: "main", isCurrent: true, x: 0, y: 0 };
    sidebarCtrl.tagMenu = { name: "v1.0.0", x: 0, y: 0 };
    sidebarCtrl.submoduleMenu = { path: "sub", status: "clean", absolutePath: "/repo/sub", x: 0, y: 0 };
    sidebarCtrl.mergeMenu = { name: "feature", x: 0, y: 0 };
    sidebarCtrl.openDirtyCheckoutMenu("feature", null, ["a.txt"], 10, 40);
    expect(sidebarCtrl.menu).toBeNull();
    expect(sidebarCtrl.tagMenu).toBeNull();
    expect(sidebarCtrl.submoduleMenu).toBeNull();
    expect(sidebarCtrl.mergeMenu).toBeNull();
  });

  it("opening the branch/tag/submodule/merge menu each close an open dirty-checkout chooser", () => {
    const anchor = { getBoundingClientRect: () => ({ left: 10, bottom: 40 }) } as unknown as HTMLElement;

    sidebarCtrl.dirtyCheckoutMenu = { name: "feature", startPoint: null, files: [], x: 0, y: 0 };
    sidebarCtrl.openMenu("feature", false, anchor);
    expect(sidebarCtrl.dirtyCheckoutMenu).toBeNull();

    sidebarCtrl.dirtyCheckoutMenu = { name: "feature", startPoint: null, files: [], x: 0, y: 0 };
    sidebarCtrl.openTagMenu("v1.0.0", anchor);
    expect(sidebarCtrl.dirtyCheckoutMenu).toBeNull();

    sidebarCtrl.dirtyCheckoutMenu = { name: "feature", startPoint: null, files: [], x: 0, y: 0 };
    sidebarCtrl.openSubmoduleMenu("sub", "clean", "/repo/sub", anchor);
    expect(sidebarCtrl.dirtyCheckoutMenu).toBeNull();

    sidebarCtrl.dirtyCheckoutMenu = { name: "feature", startPoint: null, files: [], x: 0, y: 0 };
    sidebarCtrl.openMergeMenu("feature", 10, 40);
    expect(sidebarCtrl.dirtyCheckoutMenu).toBeNull();
  });
});

// A branch row's own click/Enter no longer checks out immediately — it opens
// this confirm popover instead (see CheckoutConfirm's own doc comment).
describe("openCheckoutConfirm / closeCheckoutConfirm", () => {
  it("positions the popover clamped to the viewport width", () => {
    sidebarCtrl.openCheckoutConfirm("feature", false, window.innerWidth, 40);
    expect(sidebarCtrl.checkoutConfirm?.x).toBe(window.innerWidth - 200);
    expect(sidebarCtrl.checkoutConfirm?.y).toBe(40);
  });

  it("records whether the target is a local branch or a remote ref", () => {
    sidebarCtrl.openCheckoutConfirm("feature", false, 10, 40);
    expect(sidebarCtrl.checkoutConfirm?.remote).toBe(false);
    sidebarCtrl.openCheckoutConfirm("origin/feature", true, 10, 40);
    expect(sidebarCtrl.checkoutConfirm?.remote).toBe(true);
  });

  it("closeCheckoutConfirm clears it", () => {
    sidebarCtrl.checkoutConfirm = { name: "feature", remote: false, x: 0, y: 0 };
    sidebarCtrl.closeCheckoutConfirm();
    expect(sidebarCtrl.checkoutConfirm).toBeNull();
  });

  it("opening it closes an open branch menu, tag menu, submodule menu, merge menu, and dirty-checkout chooser", () => {
    sidebarCtrl.menu = { name: "main", isCurrent: true, x: 0, y: 0 };
    sidebarCtrl.tagMenu = { name: "v1.0.0", x: 0, y: 0 };
    sidebarCtrl.submoduleMenu = { path: "sub", status: "clean", absolutePath: "/repo/sub", x: 0, y: 0 };
    sidebarCtrl.mergeMenu = { name: "feature", x: 0, y: 0 };
    sidebarCtrl.dirtyCheckoutMenu = { name: "feature", startPoint: null, files: [], x: 0, y: 0 };
    sidebarCtrl.openCheckoutConfirm("feature", false, 10, 40);
    expect(sidebarCtrl.menu).toBeNull();
    expect(sidebarCtrl.tagMenu).toBeNull();
    expect(sidebarCtrl.submoduleMenu).toBeNull();
    expect(sidebarCtrl.mergeMenu).toBeNull();
    expect(sidebarCtrl.dirtyCheckoutMenu).toBeNull();
  });

  it("opening the branch/tag/submodule/merge menu or the dirty-checkout chooser each close an open checkout confirm", () => {
    const anchor = { getBoundingClientRect: () => ({ left: 10, bottom: 40 }) } as unknown as HTMLElement;

    sidebarCtrl.checkoutConfirm = { name: "feature", remote: false, x: 0, y: 0 };
    sidebarCtrl.openMenu("feature", false, anchor);
    expect(sidebarCtrl.checkoutConfirm).toBeNull();

    sidebarCtrl.checkoutConfirm = { name: "feature", remote: false, x: 0, y: 0 };
    sidebarCtrl.openTagMenu("v1.0.0", anchor);
    expect(sidebarCtrl.checkoutConfirm).toBeNull();

    sidebarCtrl.checkoutConfirm = { name: "feature", remote: false, x: 0, y: 0 };
    sidebarCtrl.openSubmoduleMenu("sub", "clean", "/repo/sub", anchor);
    expect(sidebarCtrl.checkoutConfirm).toBeNull();

    sidebarCtrl.checkoutConfirm = { name: "feature", remote: false, x: 0, y: 0 };
    sidebarCtrl.openMergeMenu("feature", 10, 40);
    expect(sidebarCtrl.checkoutConfirm).toBeNull();

    sidebarCtrl.checkoutConfirm = { name: "feature", remote: false, x: 0, y: 0 };
    sidebarCtrl.openDirtyCheckoutMenu("feature", null, ["a.txt"], 10, 40);
    expect(sidebarCtrl.checkoutConfirm).toBeNull();
  });
});

describe("stashSwitchReapply / stashSwitchLeaveStashed (#34 modes 1 & 2)", () => {
  it("design mode is a cosmetic no-op with a toast", async () => {
    mockInTauri = false;
    await sidebarCtrl.stashSwitchLeaveStashed("feature", null);
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("demo"));
    expect(commands.stashSave).not.toHaveBeenCalled();
  });

  it("is re-entrancy locked while busy", async () => {
    mockInTauri = true;
    sidebarCtrl.busy = true;
    await sidebarCtrl.stashSwitchReapply("feature", null);
    expect(commands.stashSave).not.toHaveBeenCalled();
  });

  it("stashSwitchLeaveStashed: stashes everything (incl. untracked), switches, and never reapplies", async () => {
    mockInTauri = true;
    vi.mocked(commands.stashSave).mockResolvedValueOnce({ ok: true, message: "stashed", backupRef: null, conflictedFiles: [], backupPatch: null, droppedStashRef: null });
    vi.mocked(commands.checkout).mockResolvedValueOnce({ ok: true, message: "", backupRef: null, conflictingFiles: [] });
    await sidebarCtrl.stashSwitchLeaveStashed("feature", null);
    expect(commands.stashSave).toHaveBeenCalledWith("/repo", expect.stringContaining("feature"), true);
    expect(commands.checkout).toHaveBeenCalledWith("/repo", "feature");
    expect(commands.stashPop).not.toHaveBeenCalled();
    expect(commands.stashApply).not.toHaveBeenCalled();
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });

  it("with a startPoint, switches via create_branch (not plain checkout) — the checkoutRemote 'new branch' shape", async () => {
    mockInTauri = true;
    vi.mocked(commands.stashSave).mockResolvedValueOnce({ ok: true, message: "stashed", backupRef: null, conflictedFiles: [], backupPatch: null, droppedStashRef: null });
    vi.mocked(commands.createBranch).mockResolvedValueOnce({ ok: true, message: "", backupRef: null, conflictingFiles: [] });
    await sidebarCtrl.stashSwitchLeaveStashed("feature-x", "origin/feature-x");
    expect(commands.createBranch).toHaveBeenCalledWith("/repo", "feature-x", "origin/feature-x", true);
    expect(commands.checkout).not.toHaveBeenCalled();
  });

  it("stashSwitchReapply: pops stash@{0} back after a clean switch, using the freshly-stashed entry's own sha", async () => {
    mockInTauri = true;
    vi.mocked(commands.stashSave).mockResolvedValueOnce({ ok: true, message: "stashed", backupRef: null, conflictedFiles: [], backupPatch: null, droppedStashRef: null });
    vi.mocked(commands.checkout).mockResolvedValueOnce({ ok: true, message: "", backupRef: null, conflictingFiles: [] });
    vi.mocked(commands.stashList).mockResolvedValueOnce(ok([{ index: 0, sha: "abc1234", branch: null, message: "auto" }]));
    vi.mocked(commands.stashPop).mockResolvedValueOnce({ ok: true, message: "popped", conflictedFiles: [], backupRef: null, backupPatch: null, droppedStashRef: null });
    await sidebarCtrl.stashSwitchReapply("feature", null);
    expect(commands.stashPop).toHaveBeenCalledWith("/repo", 0, "abc1234");
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });

  it("stashSwitchReapply: a reapply conflict opens the SAME shared Resolver a stash-pop conflict already uses, not a new flow", async () => {
    mockInTauri = true;
    vi.mocked(commands.stashSave).mockResolvedValueOnce({ ok: true, message: "stashed", backupRef: null, conflictedFiles: [], backupPatch: null, droppedStashRef: null });
    vi.mocked(commands.checkout).mockResolvedValueOnce({ ok: true, message: "", backupRef: null, conflictingFiles: [] });
    vi.mocked(commands.stashList).mockResolvedValueOnce(ok([{ index: 0, sha: "abc1234", branch: null, message: "auto" }]));
    const conflictRes = { ok: false, message: "conflict", conflictedFiles: ["a.txt"], backupRef: "refs/gitgui/backup/1", backupPatch: null, droppedStashRef: null };
    vi.mocked(commands.stashPop).mockResolvedValueOnce(conflictRes);
    await sidebarCtrl.stashSwitchReapply("feature", null);
    expect(resolver.openStashConflict).toHaveBeenCalledWith("/repo", conflictRes);
    expect(bridge.tama.set).not.toHaveBeenCalledWith("celebrate");
  });

  it("aborts without switching if stash_save itself fails", async () => {
    mockInTauri = true;
    vi.mocked(commands.stashSave).mockResolvedValueOnce({ ok: false, message: "nothing to stash", backupRef: null, conflictedFiles: [], backupPatch: null, droppedStashRef: null });
    await sidebarCtrl.stashSwitchReapply("feature", null);
    expect(commands.checkout).not.toHaveBeenCalled();
    expect(commands.createBranch).not.toHaveBeenCalled();
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("nothing to stash"));
  });

  it("if the switch fails after a successful stash, warns that the changes are safely stashed and never attempts to reapply", async () => {
    mockInTauri = true;
    vi.mocked(commands.stashSave).mockResolvedValueOnce({ ok: true, message: "stashed", backupRef: null, conflictedFiles: [], backupPatch: null, droppedStashRef: null });
    vi.mocked(commands.checkout).mockResolvedValueOnce({ ok: false, message: "not a valid branch name", backupRef: null, conflictingFiles: [] });
    await sidebarCtrl.stashSwitchReapply("bad name", null);
    expect(commands.stashPop).not.toHaveBeenCalled();
    expect(commands.stashApply).not.toHaveBeenCalled();
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("safely stashed"));
  });
});

describe("forceDiscardCheckout (#34 mode 3 — armDanger-gated, never fires without confirmation)", () => {
  it("arms the shared danger scrim with a force-discard context and does NOT call checkout_discard before confirm", () => {
    sidebarCtrl.forceDiscardCheckout("feature", null, 3);
    expect(bridge.armDanger).toHaveBeenCalledWith(
      expect.objectContaining({ name: "feature", confirmLabel: "Discard & switch", onConfirm: expect.any(Function) }),
    );
    expect(commands.checkoutDiscard).not.toHaveBeenCalled();
  });

  it("onConfirm calls checkout_discard with the branch name + startPoint and reloads on success", async () => {
    mockInTauri = true;
    vi.mocked(commands.checkoutDiscard).mockResolvedValueOnce({ ok: true, message: "force-switched", backupRef: "refs/gitgui/backup/1", conflictingFiles: [] });
    sidebarCtrl.forceDiscardCheckout("feature-x", "origin/feature-x", 2);
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();
    expect(commands.checkoutDiscard).toHaveBeenCalledWith("/repo", "feature-x", "origin/feature-x");
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });

  it("onConfirm warns and does not reload on failure", async () => {
    mockInTauri = true;
    vi.mocked(commands.checkoutDiscard).mockResolvedValueOnce({ ok: false, message: "bad ref", backupRef: null, conflictingFiles: [] });
    sidebarCtrl.forceDiscardCheckout("feature", null, 1);
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("bad ref"));
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
  });
});

describe("newBranch", () => {
  it("startNewBranch opens the inline input, cancelNewBranch closes it", () => {
    sidebarCtrl.startNewBranch();
    expect(sidebarCtrl.newBranchOpen).toBe(true);
    sidebarCtrl.newBranchInput = "wip";
    sidebarCtrl.cancelNewBranch();
    expect(sidebarCtrl.newBranchOpen).toBe(false);
    expect(sidebarCtrl.newBranchInput).toBe("");
  });

  it("confirmNewBranch does nothing (just closes) on an empty/blank name", async () => {
    sidebarCtrl.startNewBranch();
    sidebarCtrl.newBranchInput = "   ";
    await sidebarCtrl.confirmNewBranch();
    expect(sidebarCtrl.newBranchOpen).toBe(false);
    expect(commands.createBranch).not.toHaveBeenCalled();
  });

  it("real mode: creates the branch from HEAD (no from selected) and reloads on success", async () => {
    mockInTauri = true;
    vi.mocked(commands.createBranch).mockResolvedValueOnce({ ok: true, message: "created", backupRef: null, conflictingFiles: [] });
    sidebarCtrl.startNewBranch();
    sidebarCtrl.newBranchInput = "feature/new";
    await sidebarCtrl.confirmNewBranch();
    expect(commands.createBranch).toHaveBeenCalledWith("/repo", "feature/new", null, true);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(sidebarCtrl.newBranchOpen).toBe(false);
  });

  it("real mode: passes the selected start point through as create_branch's start_point", async () => {
    mockInTauri = true;
    vi.mocked(commands.createBranch).mockResolvedValueOnce({ ok: true, message: "created", backupRef: null, conflictingFiles: [] });
    sidebarCtrl.startNewBranch();
    sidebarCtrl.newBranchInput = "feature/new";
    sidebarCtrl.newBranchFrom = "origin/main";
    await sidebarCtrl.confirmNewBranch();
    expect(commands.createBranch).toHaveBeenCalledWith("/repo", "feature/new", "origin/main", true);
    expect(sidebarCtrl.newBranchFrom).toBe("");
  });

  it("while a local branch filter is active, a newly created branch is auto-added to it (not left mysteriously hidden)", async () => {
    mockInTauri = true;
    sidebarCtrl.visibleLocal = ["main"];
    sidebarCtrl.visibleRemote = [];
    vi.mocked(commands.createBranch).mockResolvedValueOnce({ ok: true, message: "created", backupRef: null, conflictingFiles: [] });
    sidebarCtrl.startNewBranch();
    sidebarCtrl.newBranchInput = "feature/new";
    await sidebarCtrl.confirmNewBranch();
    expect(sidebarCtrl.visibleLocal).toEqual(["main", "feature/new"]);
    expect(commands.setVisibleBranches).toHaveBeenCalledWith("/repo", false, ["main", "feature/new"], []);
  });

  it("with no filter active, creating a branch never touches setVisibleBranches", async () => {
    mockInTauri = true;
    vi.mocked(commands.createBranch).mockResolvedValueOnce({ ok: true, message: "created", backupRef: null, conflictingFiles: [] });
    sidebarCtrl.startNewBranch();
    sidebarCtrl.newBranchInput = "feature/new";
    await sidebarCtrl.confirmNewBranch();
    expect(commands.setVisibleBranches).not.toHaveBeenCalled();
    expect(sidebarCtrl.visibleLocal).toBeNull();
  });
});

describe("deleteBranch", () => {
  it("arms the shared danger scrim with a delete-branch context", () => {
    sidebarCtrl.deleteBranch("old-feature");
    expect(bridge.armDanger).toHaveBeenCalledWith(
      expect.objectContaining({ name: "old-feature", confirmLabel: "Delete branch", onConfirm: expect.any(Function) }),
    );
  });

  it("onConfirm calls delete_branch and reloads on success", async () => {
    mockInTauri = true;
    vi.mocked(commands.deleteBranch).mockResolvedValueOnce({ ok: true, message: "deleted", backupRef: "refs/gitgui/deleted/x", conflictingFiles: [] });
    sidebarCtrl.deleteBranch("old-feature");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();
    expect(commands.deleteBranch).toHaveBeenCalledWith("/repo", "old-feature", false);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
  });

  it("onConfirm retries with force when not-fully-merged and the user confirms", async () => {
    mockInTauri = true;
    vi.mocked(commands.deleteBranch)
      .mockResolvedValueOnce({ ok: false, message: "branch is not fully merged", backupRef: null, conflictingFiles: [] })
      .mockResolvedValueOnce({ ok: true, message: "force deleted", backupRef: null, conflictingFiles: [] });
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    sidebarCtrl.deleteBranch("old-feature");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();
    expect(commands.deleteBranch).toHaveBeenNthCalledWith(2, "/repo", "old-feature", true);
  });

  it("onConfirm keeps the branch when the user declines the force-delete confirm", async () => {
    mockInTauri = true;
    vi.mocked(commands.deleteBranch).mockResolvedValueOnce({ ok: false, message: "branch is not fully merged", backupRef: null, conflictingFiles: [] });
    vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    sidebarCtrl.deleteBranch("old-feature");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();
    expect(commands.deleteBranch).toHaveBeenCalledTimes(1);
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("cancelled"));
  });
});

describe("openMenu / closeMenu", () => {
  it("positions the menu clamped to the viewport width, from the anchor's rect", () => {
    const anchor = { getBoundingClientRect: () => ({ left: 10, bottom: 40 }) } as unknown as HTMLElement;
    sidebarCtrl.openMenu("feature", false, anchor);
    expect(sidebarCtrl.menu).toEqual({ name: "feature", isCurrent: false, x: 10, y: 44 });
  });

  it("closeMenu clears it", () => {
    sidebarCtrl.menu = { name: "x", isCurrent: false, x: 0, y: 0 };
    sidebarCtrl.closeMenu();
    expect(sidebarCtrl.menu).toBeNull();
  });

  it("opening the branch menu closes an open tag menu", () => {
    sidebarCtrl.tagMenu = { name: "v1.0.0", x: 0, y: 0 };
    const anchor = { getBoundingClientRect: () => ({ left: 10, bottom: 40 }) } as unknown as HTMLElement;
    sidebarCtrl.openMenu("feature", false, anchor);
    expect(sidebarCtrl.tagMenu).toBeNull();
  });

  it("opening the branch menu closes an open merge-strategy menu", () => {
    sidebarCtrl.mergeMenu = { name: "feature", x: 0, y: 0 };
    const anchor = { getBoundingClientRect: () => ({ left: 10, bottom: 40 }) } as unknown as HTMLElement;
    sidebarCtrl.openMenu("main", true, anchor);
    expect(sidebarCtrl.mergeMenu).toBeNull();
  });
});

describe("openTagMenu / closeTagMenu", () => {
  it("positions the tag menu clamped to the viewport width, from the anchor's rect", () => {
    const anchor = { getBoundingClientRect: () => ({ left: 10, bottom: 40 }) } as unknown as HTMLElement;
    sidebarCtrl.openTagMenu("v1.0.0", anchor);
    expect(sidebarCtrl.tagMenu).toEqual({ name: "v1.0.0", x: 10, y: 44 });
  });

  it("closeTagMenu clears it", () => {
    sidebarCtrl.tagMenu = { name: "v1.0.0", x: 0, y: 0 };
    sidebarCtrl.closeTagMenu();
    expect(sidebarCtrl.tagMenu).toBeNull();
  });

  it("opening the tag menu closes an open branch menu", () => {
    sidebarCtrl.menu = { name: "main", isCurrent: true, x: 0, y: 0 };
    const anchor = { getBoundingClientRect: () => ({ left: 10, bottom: 40 }) } as unknown as HTMLElement;
    sidebarCtrl.openTagMenu("v1.0.0", anchor);
    expect(sidebarCtrl.menu).toBeNull();
  });

  it("opening the tag menu closes an open submodule menu", () => {
    sidebarCtrl.submoduleMenu = { path: "sub", status: "clean", absolutePath: "/repo/sub", x: 0, y: 0 };
    const anchor = { getBoundingClientRect: () => ({ left: 10, bottom: 40 }) } as unknown as HTMLElement;
    sidebarCtrl.openTagMenu("v1.0.0", anchor);
    expect(sidebarCtrl.submoduleMenu).toBeNull();
  });
});

describe("openSubmoduleMenu / closeSubmoduleMenu", () => {
  it("positions the submodule menu clamped to the viewport width, from the anchor's rect, capturing status/absolutePath", () => {
    const anchor = { getBoundingClientRect: () => ({ left: 10, bottom: 40 }) } as unknown as HTMLElement;
    sidebarCtrl.openSubmoduleMenu("vendor/lib", "dirty", "/repo/vendor/lib", anchor);
    expect(sidebarCtrl.submoduleMenu).toEqual({ path: "vendor/lib", status: "dirty", absolutePath: "/repo/vendor/lib", x: 10, y: 44 });
  });

  it("closeSubmoduleMenu clears it", () => {
    sidebarCtrl.submoduleMenu = { path: "sub", status: "clean", absolutePath: "/repo/sub", x: 0, y: 0 };
    sidebarCtrl.closeSubmoduleMenu();
    expect(sidebarCtrl.submoduleMenu).toBeNull();
  });

  it("opening the submodule menu closes an open branch menu and an open tag menu", () => {
    sidebarCtrl.menu = { name: "main", isCurrent: true, x: 0, y: 0 };
    sidebarCtrl.tagMenu = { name: "v1.0.0", x: 0, y: 0 };
    const anchor = { getBoundingClientRect: () => ({ left: 10, bottom: 40 }) } as unknown as HTMLElement;
    sidebarCtrl.openSubmoduleMenu("sub", "clean", "/repo/sub", anchor);
    expect(sidebarCtrl.menu).toBeNull();
    expect(sidebarCtrl.tagMenu).toBeNull();
  });

  it("opening the branch menu closes an open submodule menu", () => {
    sidebarCtrl.submoduleMenu = { path: "sub", status: "clean", absolutePath: "/repo/sub", x: 0, y: 0 };
    const anchor = { getBoundingClientRect: () => ({ left: 10, bottom: 40 }) } as unknown as HTMLElement;
    sidebarCtrl.openMenu("feature", false, anchor);
    expect(sidebarCtrl.submoduleMenu).toBeNull();
  });
});

// Backlog #7: the "Merge into current…" strategy chooser, a SECOND-level
// popover opened from inside the branch popover's own button (reusing its
// already-computed x/y — see sidebarCtrl.openMergeMenu's own doc comment).
describe("openMergeMenu / closeMergeMenu (#7)", () => {
  it("positions the merge menu clamped to the viewport width, from the passed-in coordinates", () => {
    sidebarCtrl.openMergeMenu("feature", 10, 44);
    expect(sidebarCtrl.mergeMenu).toEqual({ name: "feature", x: 10, y: 44 });
  });

  it("closeMergeMenu clears it", () => {
    sidebarCtrl.mergeMenu = { name: "feature", x: 0, y: 0 };
    sidebarCtrl.closeMergeMenu();
    expect(sidebarCtrl.mergeMenu).toBeNull();
  });

  it("opening the merge menu closes an open branch menu, tag menu, and submodule menu", () => {
    sidebarCtrl.menu = { name: "feature", isCurrent: false, x: 0, y: 0 };
    sidebarCtrl.tagMenu = { name: "v1.0.0", x: 0, y: 0 };
    sidebarCtrl.submoduleMenu = { path: "sub", status: "clean", absolutePath: "/repo/sub", x: 0, y: 0 };
    sidebarCtrl.openMergeMenu("feature", 10, 44);
    expect(sidebarCtrl.menu).toBeNull();
    expect(sidebarCtrl.tagMenu).toBeNull();
    expect(sidebarCtrl.submoduleMenu).toBeNull();
  });

  it("opening the branch/tag/submodule menu each close an open merge menu", () => {
    const anchor = { getBoundingClientRect: () => ({ left: 10, bottom: 40 }) } as unknown as HTMLElement;

    sidebarCtrl.mergeMenu = { name: "feature", x: 0, y: 0 };
    sidebarCtrl.openTagMenu("v1.0.0", anchor);
    expect(sidebarCtrl.mergeMenu).toBeNull();

    sidebarCtrl.mergeMenu = { name: "feature", x: 0, y: 0 };
    sidebarCtrl.openSubmoduleMenu("sub", "clean", "/repo/sub", anchor);
    expect(sidebarCtrl.mergeMenu).toBeNull();
  });
});

// Backlog #7: the three ff/no-ff choices funnel through resolver.startMerge's
// now-optional `strategy` param; Squash goes through the NEW startMergeSquash
// entry point instead (see resolver.svelte.test.ts for its clean/conflict
// handling — this file only checks that sidebarCtrl calls the right resolver
// method with the right args).
describe("mergeInto (#7)", () => {
  it("design mode opens the resolver's merge demo (strategy-agnostic, same convention as rebaseOnto's demo)", async () => {
    mockInTauri = false;
    await sidebarCtrl.mergeInto("feature", "no-ff");
    expect(resolver.openDemo).toHaveBeenCalledWith("feature", "merge");
    expect(resolver.startMerge).not.toHaveBeenCalled();
  });

  it("real mode: \"auto\" forwards straight through to resolver.startMerge", async () => {
    mockInTauri = true;
    await sidebarCtrl.mergeInto("feature", "auto");
    expect(resolver.startMerge).toHaveBeenCalledWith("/repo", "feature", "auto");
  });

  it("real mode: \"no-ff\" forwards straight through to resolver.startMerge", async () => {
    mockInTauri = true;
    await sidebarCtrl.mergeInto("feature", "no-ff");
    expect(resolver.startMerge).toHaveBeenCalledWith("/repo", "feature", "no-ff");
  });

  it("real mode: \"ff-only\" forwards straight through to resolver.startMerge", async () => {
    mockInTauri = true;
    await sidebarCtrl.mergeInto("feature", "ff-only");
    expect(resolver.startMerge).toHaveBeenCalledWith("/repo", "feature", "ff-only");
  });
});

describe("squashInto (#7)", () => {
  it("design mode opens the resolver's merge-squash demo", async () => {
    mockInTauri = false;
    await sidebarCtrl.squashInto("feature");
    expect(resolver.openDemo).toHaveBeenCalledWith("feature", "merge-squash");
    expect(resolver.startMergeSquash).not.toHaveBeenCalled();
  });

  it("real mode calls resolver.startMergeSquash with the repo + target branch", async () => {
    mockInTauri = true;
    await sidebarCtrl.squashInto("feature");
    expect(resolver.startMergeSquash).toHaveBeenCalledWith("/repo", "feature");
  });
});

describe("newTag", () => {
  it("startNewTag opens the inline form, cancelNewTag closes it", () => {
    sidebarCtrl.startNewTag();
    expect(sidebarCtrl.newTagOpen).toBe(true);
    sidebarCtrl.newTagName = "v1.0.0";
    sidebarCtrl.newTagMessage = "release";
    sidebarCtrl.cancelNewTag();
    expect(sidebarCtrl.newTagOpen).toBe(false);
    expect(sidebarCtrl.newTagName).toBe("");
    expect(sidebarCtrl.newTagMessage).toBe("");
  });

  it("confirmNewTag does nothing (just closes) on an empty/blank name", async () => {
    sidebarCtrl.startNewTag();
    sidebarCtrl.newTagName = "   ";
    await sidebarCtrl.confirmNewTag();
    expect(sidebarCtrl.newTagOpen).toBe(false);
    expect(commands.createTag).not.toHaveBeenCalled();
  });

  it("real mode: creates a lightweight tag at HEAD (no message, no from) and reloads on success", async () => {
    mockInTauri = true;
    vi.mocked(commands.createTag).mockResolvedValueOnce({ ok: true, message: "created", backupRef: null, conflictingFiles: [] });
    sidebarCtrl.startNewTag();
    sidebarCtrl.newTagName = "v1.0.0";
    await sidebarCtrl.confirmNewTag();
    expect(commands.createTag).toHaveBeenCalledWith("/repo", "v1.0.0", null, null);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(sidebarCtrl.newTagOpen).toBe(false);
  });

  it("real mode: passes a non-empty message through as an annotated tag, and the selected target", async () => {
    mockInTauri = true;
    vi.mocked(commands.createTag).mockResolvedValueOnce({ ok: true, message: "created", backupRef: null, conflictingFiles: [] });
    sidebarCtrl.startNewTag();
    sidebarCtrl.newTagName = "v1.0.0";
    sidebarCtrl.newTagMessage = "release notes";
    sidebarCtrl.newTagFrom = "origin/main";
    await sidebarCtrl.confirmNewTag();
    expect(commands.createTag).toHaveBeenCalledWith("/repo", "v1.0.0", "origin/main", "release notes");
    expect(sidebarCtrl.newTagFrom).toBe("");
  });

  it("real mode: warns and does not reload on failure", async () => {
    mockInTauri = true;
    vi.mocked(commands.createTag).mockResolvedValueOnce({ ok: false, message: "tag already exists", backupRef: null, conflictingFiles: [] });
    sidebarCtrl.startNewTag();
    sidebarCtrl.newTagName = "v1.0.0";
    await sidebarCtrl.confirmNewTag();
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("tag already exists"));
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
    expect(sidebarCtrl.newTagOpen).toBe(true);
  });
});

describe("deleteTag", () => {
  it("arms the shared danger scrim with a delete-tag context", () => {
    sidebarCtrl.deleteTag("v1.0.0");
    expect(bridge.armDanger).toHaveBeenCalledWith(
      expect.objectContaining({ name: "v1.0.0", confirmLabel: "Delete tag", onConfirm: expect.any(Function) }),
    );
  });

  it("onConfirm calls delete_tag and reloads on success", async () => {
    mockInTauri = true;
    vi.mocked(commands.deleteTag).mockResolvedValueOnce({ ok: true, message: "deleted", backupRef: "refs/gitgui/deleted-tag/x", conflictingFiles: [] });
    sidebarCtrl.deleteTag("v1.0.0");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();
    expect(commands.deleteTag).toHaveBeenCalledWith("/repo", "v1.0.0");
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
  });

  it("onConfirm warns and does not reload on failure", async () => {
    mockInTauri = true;
    vi.mocked(commands.deleteTag).mockResolvedValueOnce({ ok: false, message: "tag does not exist", backupRef: null, conflictingFiles: [] });
    sidebarCtrl.deleteTag("v1.0.0");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("tag does not exist"));
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
  });
});

describe("pushTag", () => {
  it("design mode is a cosmetic no-op with a toast", async () => {
    mockInTauri = false;
    await sidebarCtrl.pushTag("v1.0.0");
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("demo"));
    expect(commands.pushTag).not.toHaveBeenCalled();
  });

  it("real mode: pushes the tag to origin (default remote) and cheers on success", async () => {
    mockInTauri = true;
    vi.mocked(commands.pushTag).mockResolvedValueOnce({ ok: true, message: "pushed", backupRef: null });
    await sidebarCtrl.pushTag("v1.0.0");
    expect(commands.pushTag).toHaveBeenCalledWith("/repo", null, "v1.0.0");
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });

  it("real mode: warns on failure", async () => {
    mockInTauri = true;
    vi.mocked(commands.pushTag).mockResolvedValueOnce({ ok: false, message: "rejected", backupRef: null });
    await sidebarCtrl.pushTag("v1.0.0");
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("rejected"));
  });

  it("is re-entrancy locked while busy", async () => {
    mockInTauri = true;
    sidebarCtrl.busy = true;
    await sidebarCtrl.pushTag("v1.0.0");
    expect(commands.pushTag).not.toHaveBeenCalled();
  });
});

describe("rebaseOnto", () => {
  it("design mode opens the resolver's rebase demo", async () => {
    mockInTauri = false;
    await sidebarCtrl.rebaseOnto("main");
    expect(resolver.openDemo).toHaveBeenCalledWith("main", "rebase");
    expect(resolver.startRebase).not.toHaveBeenCalled();
  });

  it("real mode calls resolver.startRebase with the repo + target branch", async () => {
    mockInTauri = true;
    await sidebarCtrl.rebaseOnto("main");
    expect(resolver.startRebase).toHaveBeenCalledWith("/repo", "main");
  });
});

describe("setSnapshots / reset", () => {
  it("setSnapshots copies the array", () => {
    const snaps = [{ ref: "refs/gitgui/backup/1", ts: 100, sha: "abc1234", subject: "x" }];
    sidebarCtrl.setSnapshots(snaps);
    expect(sidebarCtrl.snapshots).toEqual(snaps);
    expect(sidebarCtrl.snapshots).not.toBe(snaps);
  });

  it("reset clears everything including an open menu, tag menu, submodule menu, merge menu, hasRepo, and submodules", () => {
    sidebarCtrl.locals = [{ name: "main", sha: "x", ahead: null, behind: null, upstream: null }];
    sidebarCtrl.head = "main";
    sidebarCtrl.menu = { name: "main", isCurrent: true, x: 0, y: 0 };
    sidebarCtrl.tagMenu = { name: "v1.0.0", x: 0, y: 0 };
    sidebarCtrl.submoduleMenu = { path: "sub", status: "clean", absolutePath: "/repo/sub", x: 0, y: 0 };
    sidebarCtrl.mergeMenu = { name: "feature", x: 0, y: 0 };
    sidebarCtrl.dirtyCheckoutMenu = { name: "feature", startPoint: null, files: ["a.txt"], x: 0, y: 0 };
    sidebarCtrl.hasRepo = true;
    sidebarCtrl.submodules = [{ name: "vendor/a", path: "vendor/a", absolutePath: "/repo/vendor/a", url: null, status: "clean", headSha: "x", workdirSha: "x" }];
    sidebarCtrl.reset();
    expect(sidebarCtrl.locals).toEqual([]);
    expect(sidebarCtrl.head).toBeNull();
    expect(sidebarCtrl.menu).toBeNull();
    expect(sidebarCtrl.tagMenu).toBeNull();
    expect(sidebarCtrl.submoduleMenu).toBeNull();
    expect(sidebarCtrl.mergeMenu).toBeNull();
    expect(sidebarCtrl.dirtyCheckoutMenu).toBeNull();
    expect(sidebarCtrl.hasRepo).toBe(false);
    expect(sidebarCtrl.submodules).toEqual([]);
  });
});

describe("copySnapshotSha", () => {
  it("writes to the clipboard and clears the copied flag after a delay", () => {
    vi.useFakeTimers();
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });

    sidebarCtrl.copySnapshotSha("abc1234");
    expect(writeText).toHaveBeenCalledWith("abc1234");
    expect(sidebarCtrl.copiedSnapshotSha).toBe("abc1234");

    vi.advanceTimersByTime(900);
    expect(sidebarCtrl.copiedSnapshotSha).toBe("");
    vi.useRealTimers();
  });
});

describe("copyBranchName", () => {
  it("writes to the clipboard and clears the copied flag after a delay", () => {
    vi.useFakeTimers();
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });

    sidebarCtrl.copyBranchName("feature/inline-diff");
    expect(writeText).toHaveBeenCalledWith("feature/inline-diff");
    expect(sidebarCtrl.copiedBranch).toBe("feature/inline-diff");

    vi.advanceTimersByTime(900);
    expect(sidebarCtrl.copiedBranch).toBe("");
    vi.useRealTimers();
  });

  it("a later copy's own timeout doesn't clear feedback for an even-later copy of a DIFFERENT name", () => {
    vi.useFakeTimers();
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });

    sidebarCtrl.copyBranchName("main");
    vi.advanceTimersByTime(500);
    sidebarCtrl.copyBranchName("dev"); // a second copy before the first's timeout fires
    expect(sidebarCtrl.copiedBranch).toBe("dev");

    vi.advanceTimersByTime(500); // main's original 900ms timeout fires here — must be a no-op now
    expect(sidebarCtrl.copiedBranch).toBe("dev");

    vi.advanceTimersByTime(400); // dev's own 900ms timeout
    expect(sidebarCtrl.copiedBranch).toBe("");
    vi.useRealTimers();
  });
});
