// Tests for the sidebar (refs tree + branch context menu) controller.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  CUR_REPO: "/repo",
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
  reloadGraph: vi.fn(async () => {}),
  armDanger: vi.fn(),
  updateBranchPill: vi.fn(),
  relTime: (t: number) => t + "s ago",
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
    createBranch: vi.fn(),
    deleteBranch: vi.fn(),
  },
}));

vi.mock("../resolver/resolver.svelte.ts", () => ({
  resolver: {
    openDemo: vi.fn(),
    startRebase: vi.fn(async () => {}),
  },
}));

import * as bridge from "../../legacy/bridge";
import { commands } from "../../ipc/bindings";
import { resolver } from "../resolver/resolver.svelte.ts";
import { sidebarCtrl } from "./sidebar.svelte.ts";

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
  sidebarCtrl.head = null;
  sidebarCtrl.snapshots = [];
  sidebarCtrl.filter = "";
  sidebarCtrl.busy = false;
  sidebarCtrl.menu = null;
  mockInTauri = false;
  vi.clearAllMocks();
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
    expect(commands.listRefs).not.toHaveBeenCalled();
    expect(bridge.updateBranchPill).toHaveBeenCalled();
  });

  it("real mode: populates from commands.listRefs", async () => {
    mockInTauri = true;
    vi.mocked(commands.listRefs).mockResolvedValueOnce(
      ok({
        head: "main",
        locals: [{ name: "main", sha: "abc1234", ahead: 1, behind: 0 }],
        remotes: [{ name: "origin/main", sha: "abc1234" }],
        tags: [{ name: "v1.0.0", sha: "abc1234" }],
      }),
    );
    await sidebarCtrl.refresh("/repo");
    expect(sidebarCtrl.locals).toEqual([{ name: "main", sha: "abc1234", ahead: 1, behind: 0 }]);
    expect(sidebarCtrl.head).toBe("main");
    expect(bridge.updateBranchPill).toHaveBeenCalledWith("main", sidebarCtrl.locals);
  });

  it("real mode: logs and leaves state untouched on error", async () => {
    mockInTauri = true;
    vi.mocked(commands.listRefs).mockResolvedValueOnce(err("repo not found"));
    await sidebarCtrl.refresh("/repo");
    expect(sidebarCtrl.locals).toEqual([]);
  });

  it("real mode: no-ops without a repo path", async () => {
    mockInTauri = true;
    await sidebarCtrl.refresh("");
    expect(commands.listRefs).not.toHaveBeenCalled();
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
    vi.mocked(commands.checkout).mockResolvedValueOnce({ ok: true, message: "", backupRef: null });
    await sidebarCtrl.checkout("feature");
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });

  it("real mode: warns on failure without reloading", async () => {
    mockInTauri = true;
    vi.mocked(commands.checkout).mockResolvedValueOnce({ ok: false, message: "dirty tree", backupRef: null });
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
});

describe("checkoutRemote", () => {
  it("with no matching local branch: creates one tracking the remote ref", async () => {
    mockInTauri = true;
    vi.mocked(commands.createBranch).mockResolvedValueOnce({ ok: true, message: "", backupRef: null });
    await sidebarCtrl.checkoutRemote("origin/feature-x");
    expect(commands.createBranch).toHaveBeenCalledWith("/repo", "feature-x", "origin/feature-x", true);
    expect(commands.checkout).not.toHaveBeenCalled();
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
  });

  it("with an existing local branch of the same short name: switches to it instead of creating a duplicate", async () => {
    mockInTauri = true;
    sidebarCtrl.locals = [{ name: "feature-x", sha: "a1", ahead: null, behind: null }];
    vi.mocked(commands.checkout).mockResolvedValueOnce({ ok: true, message: "", backupRef: null });
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
    vi.mocked(commands.createBranch).mockResolvedValueOnce({ ok: true, message: "created", backupRef: null });
    sidebarCtrl.startNewBranch();
    sidebarCtrl.newBranchInput = "feature/new";
    await sidebarCtrl.confirmNewBranch();
    expect(commands.createBranch).toHaveBeenCalledWith("/repo", "feature/new", null, true);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(sidebarCtrl.newBranchOpen).toBe(false);
  });

  it("real mode: passes the selected start point through as create_branch's start_point", async () => {
    mockInTauri = true;
    vi.mocked(commands.createBranch).mockResolvedValueOnce({ ok: true, message: "created", backupRef: null });
    sidebarCtrl.startNewBranch();
    sidebarCtrl.newBranchInput = "feature/new";
    sidebarCtrl.newBranchFrom = "origin/main";
    await sidebarCtrl.confirmNewBranch();
    expect(commands.createBranch).toHaveBeenCalledWith("/repo", "feature/new", "origin/main", true);
    expect(sidebarCtrl.newBranchFrom).toBe("");
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
    vi.mocked(commands.deleteBranch).mockResolvedValueOnce({ ok: true, message: "deleted", backupRef: "refs/gitgui/deleted/x" });
    sidebarCtrl.deleteBranch("old-feature");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();
    expect(commands.deleteBranch).toHaveBeenCalledWith("/repo", "old-feature", false);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
  });

  it("onConfirm retries with force when not-fully-merged and the user confirms", async () => {
    mockInTauri = true;
    vi.mocked(commands.deleteBranch)
      .mockResolvedValueOnce({ ok: false, message: "branch is not fully merged", backupRef: null })
      .mockResolvedValueOnce({ ok: true, message: "force deleted", backupRef: null });
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    sidebarCtrl.deleteBranch("old-feature");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();
    expect(commands.deleteBranch).toHaveBeenNthCalledWith(2, "/repo", "old-feature", true);
  });

  it("onConfirm keeps the branch when the user declines the force-delete confirm", async () => {
    mockInTauri = true;
    vi.mocked(commands.deleteBranch).mockResolvedValueOnce({ ok: false, message: "branch is not fully merged", backupRef: null });
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

  it("reset clears everything including an open menu", () => {
    sidebarCtrl.locals = [{ name: "main", sha: "x", ahead: null, behind: null }];
    sidebarCtrl.head = "main";
    sidebarCtrl.menu = { name: "main", isCurrent: true, x: 0, y: 0 };
    sidebarCtrl.reset();
    expect(sidebarCtrl.locals).toEqual([]);
    expect(sidebarCtrl.head).toBeNull();
    expect(sidebarCtrl.menu).toBeNull();
  });
});
