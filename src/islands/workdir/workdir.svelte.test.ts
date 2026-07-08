// Tests for the working-tree (status/stage/unstage/discard/commit/stash)
// controller. Same isolation strategy as sidebar.svelte.test.ts/
// reflog.svelte.test.ts: legacy/bridge is mocked so legacy/main.ts (a whole
// vanilla canvas app that boots on import) is never evaluated.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  CUR_REPO: "/repo",
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
  reloadGraph: vi.fn(async () => {}),
  armDanger: vi.fn(),
  requestRedraw: vi.fn(),
  highlight: (text: string) => text,
}));

let mockInTauri = false;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    workdirStatus: vi.fn(),
    workdirFileDiff: vi.fn(),
    stageFile: vi.fn(),
    unstageFile: vi.fn(),
    stageAll: vi.fn(),
    discardFile: vi.fn(),
    commit: vi.fn(),
    stashList: vi.fn(),
    stashSave: vi.fn(),
    stashApply: vi.fn(),
    stashPop: vi.fn(),
    stashDrop: vi.fn(),
  },
}));

// workdir.svelte.ts routes a stash-apply/pop conflict into the shared
// Resolver (see #7) — mocked wholesale so its own import graph (which pulls
// in ../../legacy/bridge too) never has to be reconciled with this file's
// bridge mock above.
vi.mock("../resolver/resolver.svelte.ts", () => ({
  resolver: { openStashConflict: vi.fn() },
}));

import * as bridge from "../../legacy/bridge";
import { commands } from "../../ipc/bindings";
import { resolver } from "../resolver/resolver.svelte.ts";
import { workdirCtrl } from "./workdir.svelte.ts";
import type { FileChange, StashEntry, WorkdirResult, WorkdirStatus } from "../../ipc/bindings";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}
function wres(partial: Partial<WorkdirResult>): WorkdirResult {
  return { ok: true, message: "", conflictedFiles: [], backupRef: null, backupPatch: null, droppedStashRef: null, ...partial };
}

const STATUS_DIRTY: WorkdirStatus = {
  staged: [{ path: "a.ts", oldPath: null, status: "M" }],
  unstaged: [
    { path: "b.ts", oldPath: null, status: "M" },
    { path: "c.txt", oldPath: null, status: "?" },
  ],
  conflicted: 0,
  branch: "main",
  hasStash: false,
};
const STATUS_CLEAN: WorkdirStatus = { staged: [], unstaged: [], conflicted: 0, branch: "main", hasStash: false };
const STASH_0: StashEntry = { index: 0, sha: "abc1234", branch: "main", message: "WIP on main: abc1234 wip" };

function resetCtrl() {
  workdirCtrl.selected = false;
  workdirCtrl.status = null;
  workdirCtrl.loading = false;
  workdirCtrl.busy = false;
  workdirCtrl.busyTarget = null;
  workdirCtrl.message = "";
  workdirCtrl.amend = false;
  workdirCtrl.selectedDiffFile = null;
  workdirCtrl.selectedDiffStaged = false;
  workdirCtrl.diffHeader = "";
  workdirCtrl.diffRows = [];
  workdirCtrl.diffLoading = false;
  workdirCtrl.stashes = [];
  workdirCtrl.stashOpen = false;
  workdirCtrl.stashMessage = "";
  workdirCtrl.stashIncludeUntracked = false;
  workdirCtrl.stashBusy = false;
  workdirCtrl.stashBusyTarget = null;
  workdirCtrl.pendingStashUndo = false;
  mockInTauri = false;
  vi.clearAllMocks();
}

beforeEach(() => {
  resetCtrl();
});

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", () => {
    expect(document.getElementById("cv")).toBeNull();
    expect(workdirCtrl).toBeDefined();
  });
});

describe("select / deselect", () => {
  it("select() opens the panel and kicks off a status + stash refresh", async () => {
    mockInTauri = true;
    vi.mocked(commands.workdirStatus).mockResolvedValueOnce(ok(STATUS_DIRTY));
    vi.mocked(commands.stashList).mockResolvedValueOnce(ok([STASH_0]));

    workdirCtrl.select("/repo");
    expect(workdirCtrl.selected).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(commands.workdirStatus).toHaveBeenCalledWith("/repo");
    expect(commands.stashList).toHaveBeenCalledWith("/repo");
    expect(workdirCtrl.status).toEqual(STATUS_DIRTY);
    expect(workdirCtrl.stashes).toEqual([STASH_0]);
  });

  it("select() resets any leftover draft message/amend/diff selection", () => {
    workdirCtrl.message = "leftover";
    workdirCtrl.amend = true;
    workdirCtrl.selectedDiffFile = "x.ts";
    workdirCtrl.select("/repo");
    expect(workdirCtrl.message).toBe("");
    expect(workdirCtrl.amend).toBe(false);
    expect(workdirCtrl.selectedDiffFile).toBeNull();
  });

  it("deselect() closes the panel without touching the last-fetched status", () => {
    workdirCtrl.selected = true;
    workdirCtrl.status = STATUS_DIRTY;
    workdirCtrl.deselect();
    expect(workdirCtrl.selected).toBe(false);
    expect(workdirCtrl.status).toEqual(STATUS_DIRTY); // badge stays live while closed
  });
});

describe("refreshStatus", () => {
  it("real mode: populates status from commands.workdirStatus", async () => {
    mockInTauri = true;
    vi.mocked(commands.workdirStatus).mockResolvedValueOnce(ok(STATUS_DIRTY));
    await workdirCtrl.refreshStatus("/repo");
    expect(workdirCtrl.status).toEqual(STATUS_DIRTY);
    expect(bridge.requestRedraw).toHaveBeenCalled();
  });

  it("real mode: logs and leaves status untouched on a read error", async () => {
    mockInTauri = true;
    workdirCtrl.status = STATUS_CLEAN;
    vi.mocked(commands.workdirStatus).mockResolvedValueOnce(err("cannot open repository"));
    await workdirCtrl.refreshStatus("/repo");
    expect(workdirCtrl.status).toEqual(STATUS_CLEAN);
  });

  it("real mode: clears status without an IPC call when no repo is open", async () => {
    mockInTauri = true;
    workdirCtrl.status = STATUS_DIRTY;
    await workdirCtrl.refreshStatus("");
    expect(commands.workdirStatus).not.toHaveBeenCalled();
    expect(workdirCtrl.status).toBeNull();
  });

  it("a stale in-flight request is dropped when a newer refresh supersedes it", async () => {
    mockInTauri = true;
    let resolveFirst: (v: any) => void = () => {};
    vi.mocked(commands.workdirStatus)
      .mockImplementationOnce(() => new Promise((res) => (resolveFirst = res)))
      .mockResolvedValueOnce(ok(STATUS_DIRTY));

    const p1 = workdirCtrl.refreshStatus("/repo");
    const p2 = workdirCtrl.refreshStatus("/repo");
    resolveFirst(ok(STATUS_CLEAN));
    await Promise.all([p1, p2]);

    expect(workdirCtrl.status).toEqual(STATUS_DIRTY); // the newer (second) call wins
  });

  it("drops a stale selected diff when the file no longer appears on that side", async () => {
    mockInTauri = true;
    workdirCtrl.selectedDiffFile = "gone.ts";
    workdirCtrl.selectedDiffStaged = false;
    workdirCtrl.diffRows = [{ kind: "note", text: "x" }];
    vi.mocked(commands.workdirStatus).mockResolvedValueOnce(ok(STATUS_DIRTY)); // "gone.ts" isn't in unstaged
    await workdirCtrl.refreshStatus("/repo");
    expect(workdirCtrl.selectedDiffFile).toBeNull();
    expect(workdirCtrl.diffRows).toEqual([]);
  });
});

describe("selectDiffFile", () => {
  it("real mode: fetches the diff via workdir_file_diff and converts it to DiffRows", async () => {
    mockInTauri = true;
    vi.mocked(commands.workdirStatus).mockResolvedValue(ok(STATUS_CLEAN));
    vi.mocked(commands.stashList).mockResolvedValue(ok([]));
    workdirCtrl.select("/repo"); // sets the private `repo` field selectDiffFile needs
    const fc: FileChange = {
      path: "b.ts",
      oldPath: null,
      status: "M",
      additions: 1,
      deletions: 0,
      binary: false,
      truncated: false,
      lang: "ts",
      hunks: [{ header: "@@ -1,1 +1,2 @@", lines: [{ kind: "+", oldNo: null, newNo: 1, text: "x" }] }],
    };
    vi.mocked(commands.workdirFileDiff).mockResolvedValueOnce(ok(fc));
    await workdirCtrl.selectDiffFile("b.ts", false);
    expect(commands.workdirFileDiff).toHaveBeenCalledWith("/repo", "b.ts", false);
    expect(workdirCtrl.diffRows.some((r) => r.kind === "hunk")).toBe(true);
  });

  it("surfaces a read error as a note row instead of throwing", async () => {
    mockInTauri = true;
    vi.mocked(commands.workdirStatus).mockResolvedValue(ok(STATUS_CLEAN));
    vi.mocked(commands.stashList).mockResolvedValue(ok([]));
    workdirCtrl.select("/repo");
    vi.mocked(commands.workdirFileDiff).mockResolvedValueOnce(err("no such file"));
    await workdirCtrl.selectDiffFile("b.ts", false);
    expect(workdirCtrl.diffRows).toEqual([{ kind: "note", text: "diff unavailable — no such file" }]);
  });
});

describe("stageFile / unstageFile / stageAll", () => {
  it("stageFile: calls stage_file, cheers, and re-fetches status", async () => {
    mockInTauri = true;
    vi.mocked(commands.stageFile).mockResolvedValueOnce(wres({ ok: true, message: "Staged b.ts." }));
    vi.mocked(commands.workdirStatus).mockResolvedValueOnce(ok(STATUS_CLEAN));
    await workdirCtrl.stageFile("/repo", "b.ts");
    expect(commands.stageFile).toHaveBeenCalledWith("/repo", "b.ts");
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
    expect(commands.workdirStatus).toHaveBeenCalledWith("/repo");
    expect(workdirCtrl.busy).toBe(false);
    expect(workdirCtrl.busyTarget).toBeNull();
  });

  it("stageFile: sets busy/busyTarget to the file for the duration of the call", async () => {
    mockInTauri = true;
    let resolveStage: (v: WorkdirResult) => void = () => {};
    vi.mocked(commands.stageFile).mockImplementationOnce(() => new Promise((res) => (resolveStage = res)));
    const p = workdirCtrl.stageFile("/repo", "b.ts");
    expect(workdirCtrl.busy).toBe(true);
    expect(workdirCtrl.busyTarget).toBe("b.ts");
    resolveStage(wres({ ok: true }));
    await p;
    expect(workdirCtrl.busy).toBe(false);
  });

  it("stageFile: warns via Tama and does not re-fetch status on failure", async () => {
    mockInTauri = true;
    vi.mocked(commands.stageFile).mockResolvedValueOnce(wres({ ok: false, message: "not found" }));
    await workdirCtrl.stageFile("/repo", "missing.ts");
    expect(bridge.tama.warn).toHaveBeenCalledWith("not found");
    expect(commands.workdirStatus).not.toHaveBeenCalled();
  });

  it("stageFile: re-entrancy locked while busy", async () => {
    mockInTauri = true;
    workdirCtrl.busy = true;
    await workdirCtrl.stageFile("/repo", "b.ts");
    expect(commands.stageFile).not.toHaveBeenCalled();
  });

  it("unstageFile: calls unstage_file and re-fetches status on success", async () => {
    mockInTauri = true;
    vi.mocked(commands.unstageFile).mockResolvedValueOnce(wres({ ok: true, message: "Unstaged a.ts." }));
    vi.mocked(commands.workdirStatus).mockResolvedValueOnce(ok(STATUS_CLEAN));
    await workdirCtrl.unstageFile("/repo", "a.ts");
    expect(commands.unstageFile).toHaveBeenCalledWith("/repo", "a.ts");
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });

  it("stageAll: uses the __all__ busy sentinel and re-fetches status", async () => {
    mockInTauri = true;
    vi.mocked(commands.stageAll).mockResolvedValueOnce(wres({ ok: true, message: "Staged all changes." }));
    vi.mocked(commands.workdirStatus).mockResolvedValueOnce(ok(STATUS_CLEAN));
    const p = workdirCtrl.stageAll("/repo");
    expect(workdirCtrl.busyTarget).toBe("__all__");
    await p;
    expect(commands.stageAll).toHaveBeenCalledWith("/repo");
    expect(commands.workdirStatus).toHaveBeenCalled();
  });

  it("design mode: stage/unstage/stageAll are cosmetic no-ops with a toast", async () => {
    mockInTauri = false;
    await workdirCtrl.stageFile("/repo", "b.ts");
    await workdirCtrl.unstageFile("/repo", "a.ts");
    await workdirCtrl.stageAll("/repo");
    expect(commands.stageFile).not.toHaveBeenCalled();
    expect(commands.unstageFile).not.toHaveBeenCalled();
    expect(commands.stageAll).not.toHaveBeenCalled();
    expect(bridge.tama.say).toHaveBeenCalledTimes(3);
  });
});

describe("discard", () => {
  it("confirmDiscard arms the shared danger scrim naming the file, and does NOT call discard_file directly", () => {
    workdirCtrl.confirmDiscard("b.ts", false);
    expect(bridge.armDanger).toHaveBeenCalledWith(
      expect.objectContaining({ name: "b.ts", title: expect.stringContaining("b.ts"), onConfirm: expect.any(Function) }),
    );
    expect(commands.discardFile).not.toHaveBeenCalled();
  });

  it("only the dialog's onConfirm invokes discard_file, and re-fetches status after", async () => {
    mockInTauri = true;
    vi.mocked(commands.workdirStatus).mockResolvedValue(ok(STATUS_CLEAN));
    vi.mocked(commands.stashList).mockResolvedValue(ok([]));
    workdirCtrl.select("/repo");
    vi.mocked(commands.discardFile).mockResolvedValueOnce(wres({ ok: true, message: "Discarded b.ts." }));

    workdirCtrl.confirmDiscard("b.ts", false);
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();

    expect(commands.discardFile).toHaveBeenCalledWith("/repo", "b.ts", false);
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });

  it("a cancelled dialog never calls discardFile", () => {
    workdirCtrl.confirmDiscard("b.ts", true);
    expect(commands.discardFile).not.toHaveBeenCalled();
  });
});

describe("commit", () => {
  it("client-side empty-message guard short-circuits before any IPC call", async () => {
    mockInTauri = true;
    workdirCtrl.message = "   ";
    workdirCtrl.amend = false;
    await workdirCtrl.commit("/repo");
    expect(commands.commit).not.toHaveBeenCalled();
    expect(bridge.tama.warn).toHaveBeenCalled();
  });

  it("amend with an empty message is allowed through (keeps the prior message)", async () => {
    mockInTauri = true;
    workdirCtrl.message = "";
    workdirCtrl.amend = true;
    vi.mocked(commands.commit).mockResolvedValueOnce(wres({ ok: true, message: "Amended commit." }));
    await workdirCtrl.commit("/repo");
    expect(commands.commit).toHaveBeenCalledWith("/repo", null, true);
  });

  it("success path: clears message/amend, reloads the graph, and re-fetches status", async () => {
    mockInTauri = true;
    workdirCtrl.message = "fix bug";
    workdirCtrl.amend = false;
    vi.mocked(commands.commit).mockResolvedValueOnce(wres({ ok: true, message: "Committed.", backupRef: "refs/gitgui/backup/x" }));
    vi.mocked(commands.workdirStatus).mockResolvedValueOnce(ok(STATUS_CLEAN));

    await workdirCtrl.commit("/repo");

    expect(commands.commit).toHaveBeenCalledWith("/repo", "fix bug", false);
    expect(workdirCtrl.message).toBe("");
    expect(workdirCtrl.amend).toBe(false);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(commands.workdirStatus).toHaveBeenCalledWith("/repo");
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });

  it("backend refusal is surfaced via tama.warn without touching message/amend or reloading", async () => {
    mockInTauri = true;
    workdirCtrl.message = "fix bug";
    workdirCtrl.amend = false;
    vi.mocked(commands.commit).mockResolvedValueOnce(wres({ ok: false, message: "nothing to commit" }));

    await workdirCtrl.commit("/repo");

    expect(bridge.tama.warn).toHaveBeenCalledWith("nothing to commit");
    expect(workdirCtrl.message).toBe("fix bug");
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
  });

  it("is re-entrancy locked while busy", async () => {
    mockInTauri = true;
    workdirCtrl.busy = true;
    workdirCtrl.message = "x";
    await workdirCtrl.commit("/repo");
    expect(commands.commit).not.toHaveBeenCalled();
  });

  it("design mode is a cosmetic no-op with a toast", async () => {
    mockInTauri = false;
    workdirCtrl.message = "x";
    await workdirCtrl.commit("/repo");
    expect(commands.commit).not.toHaveBeenCalled();
    expect(vi.mocked(bridge.tama.say).mock.calls[0][0]).toEqual(expect.stringContaining("demo"));
  });
});

describe("stash", () => {
  it("refreshStashes: populates from stash_list", async () => {
    mockInTauri = true;
    vi.mocked(commands.stashList).mockResolvedValueOnce(ok([STASH_0]));
    await workdirCtrl.refreshStashes("/repo");
    expect(workdirCtrl.stashes).toEqual([STASH_0]);
  });

  it("a stale in-flight stash_list request is dropped when a newer refresh supersedes it (regression, #9)", async () => {
    mockInTauri = true;
    const STASH_1: StashEntry = { index: 0, sha: "def5678", branch: "main", message: "WIP on main: def5678 newer" };
    let resolveFirst: (v: any) => void = () => {};
    vi.mocked(commands.stashList)
      .mockImplementationOnce(() => new Promise((res) => (resolveFirst = res)))
      .mockResolvedValueOnce(ok([STASH_1]));

    const p1 = workdirCtrl.refreshStashes("/repo");
    const p2 = workdirCtrl.refreshStashes("/repo");
    resolveFirst(ok([STASH_0])); // the OLDER call resolves LAST
    await Promise.all([p1, p2]);

    expect(workdirCtrl.stashes).toEqual([STASH_1]); // the newer (second) call wins
  });

  it("saveStash: calls stash_save with the message/includeUntracked, closes the form, and refreshes status + stashes", async () => {
    mockInTauri = true;
    workdirCtrl.openStashForm();
    workdirCtrl.stashMessage = "wip";
    workdirCtrl.stashIncludeUntracked = true;
    vi.mocked(commands.stashSave).mockResolvedValueOnce(wres({ ok: true, message: "Stashed." }));
    vi.mocked(commands.workdirStatus).mockResolvedValueOnce(ok(STATUS_CLEAN));
    vi.mocked(commands.stashList).mockResolvedValueOnce(ok([STASH_0]));

    await workdirCtrl.saveStash("/repo");

    expect(commands.stashSave).toHaveBeenCalledWith("/repo", "wip", true);
    expect(workdirCtrl.stashOpen).toBe(false);
    expect(commands.workdirStatus).toHaveBeenCalledWith("/repo");
    expect(commands.stashList).toHaveBeenCalledWith("/repo");
  });

  it("saveStash: failure warns via Tama and keeps the form open", async () => {
    mockInTauri = true;
    workdirCtrl.openStashForm();
    vi.mocked(commands.stashSave).mockResolvedValueOnce(wres({ ok: false, message: "nothing to stash" }));
    await workdirCtrl.saveStash("/repo");
    expect(bridge.tama.warn).toHaveBeenCalledWith("nothing to stash");
    expect(workdirCtrl.stashOpen).toBe(true);
  });

  it("applyStash: calls stash_apply and refreshes status + stashes on success", async () => {
    mockInTauri = true;
    vi.mocked(commands.stashApply).mockResolvedValueOnce(wres({ ok: true, message: "Applied stash@{0}." }));
    vi.mocked(commands.workdirStatus).mockResolvedValueOnce(ok(STATUS_DIRTY));
    vi.mocked(commands.stashList).mockResolvedValueOnce(ok([STASH_0]));

    await workdirCtrl.applyStash("/repo", 0);

    // No prior refreshStashes() call in this test -> nothing on record for
    // index 0 yet -> the identity check is skipped (null), same as before #6.
    expect(commands.stashApply).toHaveBeenCalledWith("/repo", 0, null);
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
    expect(commands.workdirStatus).toHaveBeenCalled();
    expect(commands.stashList).toHaveBeenCalled();
  });

  it("popStash: calls stash_pop and refreshes status + stashes on success", async () => {
    mockInTauri = true;
    vi.mocked(commands.stashPop).mockResolvedValueOnce(wres({ ok: true, message: "Popped stash@{0}." }));
    vi.mocked(commands.workdirStatus).mockResolvedValueOnce(ok(STATUS_DIRTY));
    vi.mocked(commands.stashList).mockResolvedValueOnce(ok([]));

    await workdirCtrl.popStash("/repo", 0);

    expect(commands.stashPop).toHaveBeenCalledWith("/repo", 0, null);
    expect(workdirCtrl.stashes).toEqual([]);
  });

  it("applyStash/popStash/dropStash pass the last-fetched sha for that index as the identity check (regression, #6)", async () => {
    mockInTauri = true;
    vi.mocked(commands.stashList).mockResolvedValueOnce(ok([STASH_0]));
    await workdirCtrl.refreshStashes("/repo"); // populates workdirCtrl.stashes with STASH_0's sha

    vi.mocked(commands.stashApply).mockResolvedValueOnce(wres({ ok: true }));
    vi.mocked(commands.workdirStatus).mockResolvedValue(ok(STATUS_CLEAN));
    vi.mocked(commands.stashList).mockResolvedValue(ok([STASH_0]));
    await workdirCtrl.applyStash("/repo", 0);
    expect(commands.stashApply).toHaveBeenCalledWith("/repo", 0, STASH_0.sha);

    vi.mocked(commands.stashPop).mockResolvedValueOnce(wres({ ok: true }));
    await workdirCtrl.popStash("/repo", 0);
    expect(commands.stashPop).toHaveBeenCalledWith("/repo", 0, STASH_0.sha);

    vi.mocked(commands.stashDrop).mockResolvedValueOnce(wres({ ok: true }));
    workdirCtrl.confirmDropStash("/repo", 0);
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();
    expect(commands.stashDrop).toHaveBeenCalledWith("/repo", 0, STASH_0.sha);
  });

  it("a conflicted apply/pop refreshes status/stashes (the entry is kept) and routes into the shared Resolver instead of just a toast (regression, #7)", async () => {
    mockInTauri = true;
    const conflictRes = wres({ ok: false, message: "Apply of stash@{0} hit a conflict in 1 file.", conflictedFiles: ["b.ts"] });
    vi.mocked(commands.stashApply).mockResolvedValueOnce(conflictRes);
    vi.mocked(commands.workdirStatus).mockResolvedValueOnce(ok({ ...STATUS_DIRTY, conflicted: 1 }));
    vi.mocked(commands.stashList).mockResolvedValueOnce(ok([STASH_0]));

    await workdirCtrl.applyStash("/repo", 0);

    expect(commands.workdirStatus).toHaveBeenCalled();
    expect(commands.stashList).toHaveBeenCalled();
    expect(workdirCtrl.stashes).toEqual([STASH_0]); // conflict never drops the stash entry
    expect(resolver.openStashConflict).toHaveBeenCalledWith("/repo", conflictRes);
    expect(bridge.tama.warn).not.toHaveBeenCalled(); // the Resolver's own banner surfaces it now, not a toast
  });

  it("confirmDropStash routes through armDanger like discard, and only onConfirm calls stash_drop", async () => {
    mockInTauri = true;
    vi.mocked(commands.stashDrop).mockResolvedValueOnce(wres({ ok: true, message: "Dropped." }));
    vi.mocked(commands.stashList).mockResolvedValueOnce(ok([]));

    workdirCtrl.confirmDropStash("/repo", 0);
    expect(commands.stashDrop).not.toHaveBeenCalled();
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();

    expect(commands.stashDrop).toHaveBeenCalledWith("/repo", 0, null);
    expect(commands.stashList).toHaveBeenCalledWith("/repo");
  });

  it("is re-entrancy locked while stashBusy", async () => {
    mockInTauri = true;
    workdirCtrl.stashBusy = true;
    await workdirCtrl.applyStash("/repo", 0);
    await workdirCtrl.popStash("/repo", 0);
    expect(commands.stashApply).not.toHaveBeenCalled();
    expect(commands.stashPop).not.toHaveBeenCalled();
  });
});

// Regression coverage for "Undo is broken after stash_apply/stash_pop": the
// backend's dedicated stash_undo_apply command already worked in isolation,
// but nothing decided WHEN global Undo (legacy/main.ts's globalUndo(), not
// importable under vitest — no canvas in jsdom, same isolation note as this
// file's header) should call it instead of undo_last. pendingStashUndo/
// undoKind() are that decision, and they live here specifically so it's
// machine-verifiable — globalUndo() itself is only a thin consumer (see its
// own comment in legacy/main.ts).
describe("pendingStashUndo / undoKind (Bug B: wire stash_undo_apply into global Undo)", () => {
  it("undoKind() defaults to 'ref' (the generic undo_last flow) when nothing stash-shaped is pending", () => {
    expect(workdirCtrl.pendingStashUndo).toBe(false);
    expect(workdirCtrl.undoKind()).toBe("ref");
  });

  it("applyStash: a clean success sets pendingStashUndo and flips undoKind() to 'stash'", async () => {
    mockInTauri = true;
    vi.mocked(commands.stashApply).mockResolvedValueOnce(wres({ ok: true, message: "Applied stash@{0}." }));
    vi.mocked(commands.workdirStatus).mockResolvedValueOnce(ok(STATUS_DIRTY));
    vi.mocked(commands.stashList).mockResolvedValueOnce(ok([STASH_0]));

    await workdirCtrl.applyStash("/repo", 0);

    expect(workdirCtrl.pendingStashUndo).toBe(true);
    expect(workdirCtrl.undoKind()).toBe("stash");
  });

  it("popStash: a clean success sets pendingStashUndo and flips undoKind() to 'stash'", async () => {
    mockInTauri = true;
    vi.mocked(commands.stashPop).mockResolvedValueOnce(wres({ ok: true, message: "Popped stash@{0}." }));
    vi.mocked(commands.workdirStatus).mockResolvedValueOnce(ok(STATUS_CLEAN));
    vi.mocked(commands.stashList).mockResolvedValueOnce(ok([]));

    await workdirCtrl.popStash("/repo", 0);

    expect(workdirCtrl.pendingStashUndo).toBe(true);
    expect(workdirCtrl.undoKind()).toBe("stash");
  });

  it("a conflicted apply does NOT set pendingStashUndo (stash_undo_apply refuses on unresolved conflicts, see workdir.rs)", async () => {
    mockInTauri = true;
    const conflictRes = wres({ ok: false, message: "Apply of stash@{0} hit a conflict in 1 file.", conflictedFiles: ["b.ts"] });
    vi.mocked(commands.stashApply).mockResolvedValueOnce(conflictRes);
    vi.mocked(commands.workdirStatus).mockResolvedValueOnce(ok({ ...STATUS_DIRTY, conflicted: 1 }));
    vi.mocked(commands.stashList).mockResolvedValueOnce(ok([STASH_0]));

    await workdirCtrl.applyStash("/repo", 0);

    expect(workdirCtrl.pendingStashUndo).toBe(false);
    expect(workdirCtrl.undoKind()).toBe("ref");
  });

  it("a failed (non-conflict) apply does NOT set pendingStashUndo", async () => {
    mockInTauri = true;
    vi.mocked(commands.stashApply).mockResolvedValueOnce(wres({ ok: false, message: "could not apply" }));
    await workdirCtrl.applyStash("/repo", 0);
    expect(workdirCtrl.pendingStashUndo).toBe(false);
  });

  it("a subsequent unrelated mutating action (staging a file) clears pendingStashUndo back to false", async () => {
    mockInTauri = true;
    vi.mocked(commands.stashApply).mockResolvedValueOnce(wres({ ok: true }));
    vi.mocked(commands.workdirStatus).mockResolvedValue(ok(STATUS_DIRTY));
    vi.mocked(commands.stashList).mockResolvedValueOnce(ok([STASH_0]));
    await workdirCtrl.applyStash("/repo", 0);
    expect(workdirCtrl.pendingStashUndo).toBe(true); // sanity check before the unrelated action

    vi.mocked(commands.stageFile).mockResolvedValueOnce(wres({ ok: true, message: "Staged b.ts." }));
    await workdirCtrl.stageFile("/repo", "b.ts");

    expect(workdirCtrl.pendingStashUndo).toBe(false);
    expect(workdirCtrl.undoKind()).toBe("ref");
  });

  it("unstageFile/stageAll/commit/saveStash also clear a pending stash-undo", async () => {
    mockInTauri = true;
    vi.mocked(commands.workdirStatus).mockResolvedValue(ok(STATUS_CLEAN));

    workdirCtrl.pendingStashUndo = true;
    vi.mocked(commands.unstageFile).mockResolvedValueOnce(wres({ ok: true }));
    await workdirCtrl.unstageFile("/repo", "a.ts");
    expect(workdirCtrl.pendingStashUndo).toBe(false);

    workdirCtrl.pendingStashUndo = true;
    vi.mocked(commands.stageAll).mockResolvedValueOnce(wres({ ok: true }));
    await workdirCtrl.stageAll("/repo");
    expect(workdirCtrl.pendingStashUndo).toBe(false);

    workdirCtrl.pendingStashUndo = true;
    workdirCtrl.message = "fix bug";
    vi.mocked(commands.commit).mockResolvedValueOnce(wres({ ok: true, message: "Committed." }));
    await workdirCtrl.commit("/repo");
    expect(workdirCtrl.pendingStashUndo).toBe(false);

    workdirCtrl.pendingStashUndo = true;
    vi.mocked(commands.stashSave).mockResolvedValueOnce(wres({ ok: true, message: "Stashed." }));
    vi.mocked(commands.stashList).mockResolvedValueOnce(ok([STASH_0]));
    await workdirCtrl.saveStash("/repo");
    expect(workdirCtrl.pendingStashUndo).toBe(false);
  });

  it("dropping a stash (another stash op) also clears a pending stash-undo from a prior apply/pop", async () => {
    mockInTauri = true;
    workdirCtrl.pendingStashUndo = true;
    vi.mocked(commands.stashDrop).mockResolvedValueOnce(wres({ ok: true, message: "Dropped." }));
    vi.mocked(commands.stashList).mockResolvedValueOnce(ok([]));

    workdirCtrl.confirmDropStash("/repo", 0);
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();

    expect(workdirCtrl.pendingStashUndo).toBe(false);
  });

  it("discarding a file also clears a pending stash-undo from a prior apply/pop", async () => {
    mockInTauri = true;
    vi.mocked(commands.workdirStatus).mockResolvedValue(ok(STATUS_CLEAN));
    vi.mocked(commands.stashList).mockResolvedValue(ok([]));
    workdirCtrl.select("/repo"); // sets the private `repo` field confirmDiscard needs
    workdirCtrl.pendingStashUndo = true;
    vi.mocked(commands.discardFile).mockResolvedValueOnce(wres({ ok: true, message: "Discarded b.ts." }));

    workdirCtrl.confirmDiscard("b.ts", false);
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();

    expect(workdirCtrl.pendingStashUndo).toBe(false);
  });

  it("demo mode never sets pendingStashUndo (globalUndo's IN_TAURI gate means it's never consulted there anyway)", async () => {
    mockInTauri = false;
    await workdirCtrl.applyStash("/repo", 0);
    expect(workdirCtrl.pendingStashUndo).toBe(false);
    expect(workdirCtrl.undoKind()).toBe("ref");
  });
});

describe("demo mode", () => {
  it("select() seeds DEMO_STATUS/DEMO_STASHES with zero IPC calls", async () => {
    vi.resetModules();
    vi.doMock("../../ipc/env", () => ({ IN_TAURI: false }));
    const bindingsDemo = await import("../../ipc/bindings");
    const { workdirCtrl: demoCtrl } = await import("./workdir.svelte.ts");

    demoCtrl.select("");
    await Promise.resolve();
    await Promise.resolve();

    expect(demoCtrl.status).not.toBeNull();
    expect(demoCtrl.stashes.length).toBeGreaterThan(0);
    expect(bindingsDemo.commands.workdirStatus).not.toHaveBeenCalled();
    expect(bindingsDemo.commands.stashList).not.toHaveBeenCalled();
  });

  it("every mutating method is a Tama-only no-op in demo mode", async () => {
    vi.resetModules();
    vi.doMock("../../ipc/env", () => ({ IN_TAURI: false }));
    const bridgeDemo = await import("../../legacy/bridge");
    const bindingsDemo = await import("../../ipc/bindings");
    const { workdirCtrl: demoCtrl } = await import("./workdir.svelte.ts");

    await demoCtrl.stageFile("", "b.ts");
    await demoCtrl.unstageFile("", "a.ts");
    await demoCtrl.stageAll("");
    await demoCtrl.saveStash("");
    await demoCtrl.applyStash("", 0);
    await demoCtrl.popStash("", 0);

    expect(bindingsDemo.commands.stageFile).not.toHaveBeenCalled();
    expect(bindingsDemo.commands.unstageFile).not.toHaveBeenCalled();
    expect(bindingsDemo.commands.stageAll).not.toHaveBeenCalled();
    expect(bindingsDemo.commands.stashSave).not.toHaveBeenCalled();
    expect(bindingsDemo.commands.stashApply).not.toHaveBeenCalled();
    expect(bindingsDemo.commands.stashPop).not.toHaveBeenCalled();
    expect(bridgeDemo.tama.say).toHaveBeenCalled();
  });

  it("discard/drop-stash confirm dialogs still arm in demo mode, and their onConfirm is also a no-op", async () => {
    vi.resetModules();
    vi.doMock("../../ipc/env", () => ({ IN_TAURI: false }));
    const bridgeDemo = await import("../../legacy/bridge");
    const bindingsDemo = await import("../../ipc/bindings");
    const { workdirCtrl: demoCtrl } = await import("./workdir.svelte.ts");

    demoCtrl.confirmDiscard("b.ts", false);
    const ctx = vi.mocked(bridgeDemo.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();

    expect(bindingsDemo.commands.discardFile).not.toHaveBeenCalled();
    expect(bridgeDemo.tama.say).toHaveBeenCalledWith(expect.stringContaining("demo"));
  });
});
