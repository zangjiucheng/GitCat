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
    createTag: vi.fn(),
    deleteTag: vi.fn(),
    pushTag: vi.fn(),
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
  sidebarCtrl.tagMenu = null;
  sidebarCtrl.newTagOpen = false;
  sidebarCtrl.newTagName = "";
  sidebarCtrl.newTagMessage = "";
  sidebarCtrl.newTagFrom = "";
  sidebarCtrl.hasRepo = false;
  sidebarCtrl.copiedSnapshotSha = "";
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
    expect(sidebarCtrl.hasRepo).toBe(true);
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
    expect(sidebarCtrl.hasRepo).toBe(false);
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

  it("opening the branch menu closes an open tag menu", () => {
    sidebarCtrl.tagMenu = { name: "v1.0.0", x: 0, y: 0 };
    const anchor = { getBoundingClientRect: () => ({ left: 10, bottom: 40 }) } as unknown as HTMLElement;
    sidebarCtrl.openMenu("feature", false, anchor);
    expect(sidebarCtrl.tagMenu).toBeNull();
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
    vi.mocked(commands.createTag).mockResolvedValueOnce({ ok: true, message: "created", backupRef: null });
    sidebarCtrl.startNewTag();
    sidebarCtrl.newTagName = "v1.0.0";
    await sidebarCtrl.confirmNewTag();
    expect(commands.createTag).toHaveBeenCalledWith("/repo", "v1.0.0", null, null);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(sidebarCtrl.newTagOpen).toBe(false);
  });

  it("real mode: passes a non-empty message through as an annotated tag, and the selected target", async () => {
    mockInTauri = true;
    vi.mocked(commands.createTag).mockResolvedValueOnce({ ok: true, message: "created", backupRef: null });
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
    vi.mocked(commands.createTag).mockResolvedValueOnce({ ok: false, message: "tag already exists", backupRef: null });
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
    vi.mocked(commands.deleteTag).mockResolvedValueOnce({ ok: true, message: "deleted", backupRef: "refs/gitgui/deleted-tag/x" });
    sidebarCtrl.deleteTag("v1.0.0");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();
    expect(commands.deleteTag).toHaveBeenCalledWith("/repo", "v1.0.0");
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
  });

  it("onConfirm warns and does not reload on failure", async () => {
    mockInTauri = true;
    vi.mocked(commands.deleteTag).mockResolvedValueOnce({ ok: false, message: "tag does not exist", backupRef: null });
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

  it("reset clears everything including an open menu, tag menu, and hasRepo", () => {
    sidebarCtrl.locals = [{ name: "main", sha: "x", ahead: null, behind: null }];
    sidebarCtrl.head = "main";
    sidebarCtrl.menu = { name: "main", isCurrent: true, x: 0, y: 0 };
    sidebarCtrl.tagMenu = { name: "v1.0.0", x: 0, y: 0 };
    sidebarCtrl.hasRepo = true;
    sidebarCtrl.reset();
    expect(sidebarCtrl.locals).toEqual([]);
    expect(sidebarCtrl.head).toBeNull();
    expect(sidebarCtrl.menu).toBeNull();
    expect(sidebarCtrl.tagMenu).toBeNull();
    expect(sidebarCtrl.hasRepo).toBe(false);
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
