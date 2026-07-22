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
    stageLines: vi.fn(),
    unstageLines: vi.fn(),
    discardLines: vi.fn(),
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
import { workdirCtrl, canBlameWorkdirFile, blameTargetForWorkdirFile, buildWdTree } from "./workdir.svelte.ts";
import type { FileChange, HunkSelection, StashEntry, WorkdirEntry, WorkdirResult, WorkdirStatus } from "../../ipc/bindings";

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
  workdirCtrl.diffFile = null;
  workdirCtrl.diffHunks = [];
  workdirCtrl.diffError = null;
  workdirCtrl.diffLoading = false;
  workdirCtrl.selectedLines = [];
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
    workdirCtrl.diffHunks = [{ header: "@@ -1,1 +1,1 @@", lines: [] }];
    vi.mocked(commands.workdirStatus).mockResolvedValueOnce(ok(STATUS_DIRTY)); // "gone.ts" isn't in unstaged
    await workdirCtrl.refreshStatus("/repo");
    expect(workdirCtrl.selectedDiffFile).toBeNull();
    expect(workdirCtrl.diffHunks).toEqual([]);
  });
});

const FC_MULTI_LINE: FileChange = {
  path: "b.ts",
  oldPath: null,
  status: "M",
  additions: 1,
  deletions: 1,
  binary: false,
  truncated: false,
  lang: "ts",
  hunks: [
    {
      header: "@@ -1,3 +1,3 @@",
      lines: [
        { kind: " ", oldNo: 1, newNo: 1, text: "keep" },
        { kind: "-", oldNo: 2, newNo: null, text: "old line" },
        { kind: "+", oldNo: null, newNo: 2, text: "new line" },
      ],
    },
  ],
};

describe("selectDiffFile", () => {
  it("real mode: fetches the diff via workdir_file_diff and keeps real oldNo/newNo per line (not a recomputed counter)", async () => {
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
    expect(workdirCtrl.diffFile).toEqual(fc);
    expect(workdirCtrl.diffHunks).toEqual([{ header: "@@ -1,1 +1,2 @@", lines: [{ kind: "+", oldNo: null, newNo: 1, text: "x", html: "x" }] }]);
  });

  it("surfaces a read error via diffError instead of throwing", async () => {
    mockInTauri = true;
    vi.mocked(commands.workdirStatus).mockResolvedValue(ok(STATUS_CLEAN));
    vi.mocked(commands.stashList).mockResolvedValue(ok([]));
    workdirCtrl.select("/repo");
    vi.mocked(commands.workdirFileDiff).mockResolvedValueOnce(err("no such file"));
    await workdirCtrl.selectDiffFile("b.ts", false);
    expect(workdirCtrl.diffError).toBe("diff unavailable — no such file");
    expect(workdirCtrl.diffHunks).toEqual([]);
  });

  it("clears any prior line selection when a new diff is selected", async () => {
    mockInTauri = true;
    vi.mocked(commands.workdirStatus).mockResolvedValue(ok(STATUS_CLEAN));
    vi.mocked(commands.stashList).mockResolvedValue(ok([]));
    workdirCtrl.select("/repo");
    vi.mocked(commands.workdirFileDiff).mockResolvedValue(ok(FC_MULTI_LINE));
    await workdirCtrl.selectDiffFile("b.ts", false);
    workdirCtrl.toggleLine("@@ -1,3 +1,3 @@", FC_MULTI_LINE.hunks[0].lines, 1, false);
    expect(workdirCtrl.selectedLinesCount).toBe(1);

    await workdirCtrl.selectDiffFile("b.ts", false);
    expect(workdirCtrl.selectedLinesCount).toBe(0);
  });
});

describe("hunk/line selection", () => {
  beforeEach(async () => {
    mockInTauri = true;
    vi.mocked(commands.workdirStatus).mockResolvedValue(ok(STATUS_CLEAN));
    vi.mocked(commands.stashList).mockResolvedValue(ok([]));
    workdirCtrl.select("/repo");
    vi.mocked(commands.workdirFileDiff).mockResolvedValue(ok(FC_MULTI_LINE));
    await workdirCtrl.selectDiffFile("b.ts", false);
  });

  it("isLineSelected is false for every row until toggled", () => {
    const [ctx, del, add] = FC_MULTI_LINE.hunks[0].lines;
    expect(workdirCtrl.isLineSelected("@@ -1,3 +1,3 @@", ctx)).toBe(false);
    expect(workdirCtrl.isLineSelected("@@ -1,3 +1,3 @@", del)).toBe(false);
    expect(workdirCtrl.isLineSelected("@@ -1,3 +1,3 @@", add)).toBe(false);
  });

  it("toggleLine never selects a context (' ') row", () => {
    const lines = FC_MULTI_LINE.hunks[0].lines;
    workdirCtrl.toggleLine("@@ -1,3 +1,3 @@", lines, 0, false); // the context row, idx 0
    expect(workdirCtrl.selectedLinesCount).toBe(0);
  });

  it("toggleLine checks then unchecks a single '-' or '+' row", () => {
    const lines = FC_MULTI_LINE.hunks[0].lines;
    workdirCtrl.toggleLine("@@ -1,3 +1,3 @@", lines, 1, false); // the '-' row
    expect(workdirCtrl.isLineSelected("@@ -1,3 +1,3 @@", lines[1])).toBe(true);
    expect(workdirCtrl.selectedLinesCount).toBe(1);
    workdirCtrl.toggleLine("@@ -1,3 +1,3 @@", lines, 1, false); // click again -> unchecks
    expect(workdirCtrl.isLineSelected("@@ -1,3 +1,3 @@", lines[1])).toBe(false);
    expect(workdirCtrl.selectedLinesCount).toBe(0);
  });

  it("shift-click extends a contiguous range within the same hunk, skipping context rows", () => {
    const lines = FC_MULTI_LINE.hunks[0].lines;
    workdirCtrl.toggleLine("@@ -1,3 +1,3 @@", lines, 1, false); // '-' row
    workdirCtrl.toggleLine("@@ -1,3 +1,3 @@", lines, 2, true); // shift-click '+' row -> range [1,2]
    expect(workdirCtrl.selectedLinesCount).toBe(2);
    expect(workdirCtrl.isLineSelected("@@ -1,3 +1,3 @@", lines[1])).toBe(true);
    expect(workdirCtrl.isLineSelected("@@ -1,3 +1,3 @@", lines[2])).toBe(true);
  });

  it("a shift-click against a different hunk starts an independent range instead of spanning hunks", () => {
    const lines = FC_MULTI_LINE.hunks[0].lines;
    workdirCtrl.toggleLine("@@ -1,3 +1,3 @@", lines, 1, false);
    workdirCtrl.toggleLine("@@ some-other-hunk@@", lines, 2, true); // different header -> not a range extension
    // Only the single explicit toggle for the "other hunk" line landed (as a plain toggle, not a range).
    expect(workdirCtrl.selectedLinesCount).toBe(2);
    expect(workdirCtrl.isLineSelected("@@ some-other-hunk@@", lines[2])).toBe(true);
  });

  it("hunkSelectionFor collects every +/- line of a hunk regardless of checked state", () => {
    const hunk = workdirCtrl.diffHunks[0];
    const sel = workdirCtrl.hunkSelectionFor(hunk);
    expect(sel.header).toBe("@@ -1,3 +1,3 @@");
    expect(sel.lines).toEqual([
      { kind: "-", oldNo: 2, newNo: null },
      { kind: "+", oldNo: null, newNo: 2 },
    ]);
  });

  it("buildSelectedHunks groups only the checked lines, one HunkSelection per hunk with >=1 checked line", () => {
    const lines = FC_MULTI_LINE.hunks[0].lines;
    workdirCtrl.toggleLine("@@ -1,3 +1,3 @@", lines, 1, false); // just the '-' row
    const hunks = workdirCtrl.buildSelectedHunks();
    expect(hunks).toEqual([{ header: "@@ -1,3 +1,3 @@", lines: [{ kind: "-", oldNo: 2, newNo: null }] }]);
  });

  it("buildSelectedHunks is empty when nothing is checked", () => {
    expect(workdirCtrl.buildSelectedHunks()).toEqual([]);
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

const HUNKS_ONE: HunkSelection[] = [{ header: "@@ -1,3 +1,3 @@", lines: [{ kind: "-", oldNo: 2, newNo: null }] }];

describe("stageLines / unstageLines / discardLines", () => {
  it("stageLines: calls stage_lines, cheers, clears the selection, and re-fetches status + the open diff", async () => {
    mockInTauri = true;
    vi.mocked(commands.workdirStatus).mockResolvedValue(ok(STATUS_CLEAN));
    vi.mocked(commands.stashList).mockResolvedValue(ok([]));
    workdirCtrl.select("/repo");
    vi.mocked(commands.workdirFileDiff).mockResolvedValue(ok(FC_MULTI_LINE));
    await workdirCtrl.selectDiffFile("b.ts", false);
    workdirCtrl.toggleLine("@@ -1,3 +1,3 @@", FC_MULTI_LINE.hunks[0].lines, 1, false);
    expect(workdirCtrl.selectedLinesCount).toBe(1);

    vi.mocked(commands.stageLines).mockResolvedValueOnce(wres({ ok: true, message: "Staged selected lines." }));
    await workdirCtrl.stageLines("/repo", "b.ts", HUNKS_ONE);

    expect(commands.stageLines).toHaveBeenCalledWith("/repo", "b.ts", HUNKS_ONE);
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
    expect(workdirCtrl.selectedLinesCount).toBe(0); // cleared on success
    expect(commands.workdirStatus).toHaveBeenCalledWith("/repo");
    expect(commands.workdirFileDiff).toHaveBeenCalledWith("/repo", "b.ts", false); // re-derives the still-open diff
    expect(workdirCtrl.busy).toBe(false);
  });

  it("stageLines: does nothing with an empty hunk list", async () => {
    mockInTauri = true;
    await workdirCtrl.stageLines("/repo", "b.ts", []);
    expect(commands.stageLines).not.toHaveBeenCalled();
  });

  it("stageLines: sets busy/busyTarget to the file for the duration of the call", async () => {
    mockInTauri = true;
    let resolveStage: (v: WorkdirResult) => void = () => {};
    vi.mocked(commands.stageLines).mockImplementationOnce(() => new Promise((res) => (resolveStage = res)));
    const p = workdirCtrl.stageLines("/repo", "b.ts", HUNKS_ONE);
    expect(workdirCtrl.busy).toBe(true);
    expect(workdirCtrl.busyTarget).toBe("b.ts");
    resolveStage(wres({ ok: true }));
    await p;
    expect(workdirCtrl.busy).toBe(false);
  });

  it("stageLines: warns via Tama and does not re-fetch status on a stale-selection refusal", async () => {
    mockInTauri = true;
    vi.mocked(commands.stageLines).mockResolvedValueOnce(wres({ ok: false, message: "This file's diff has changed since you last looked — refresh and try again." }));
    await workdirCtrl.stageLines("/repo", "b.ts", HUNKS_ONE);
    expect(bridge.tama.warn).toHaveBeenCalledWith("This file's diff has changed since you last looked — refresh and try again.");
    expect(commands.workdirStatus).not.toHaveBeenCalled();
  });

  it("stageLines: re-entrancy locked while busy", async () => {
    mockInTauri = true;
    workdirCtrl.busy = true;
    await workdirCtrl.stageLines("/repo", "b.ts", HUNKS_ONE);
    expect(commands.stageLines).not.toHaveBeenCalled();
  });

  it("unstageLines: calls unstage_lines and re-fetches status + the open (staged) diff on success", async () => {
    mockInTauri = true;
    // "a.ts" still has SOME staged lines left after the partial unstage, so it
    // stays in the staged list and `dropStaleSelectedDiff` does not clear it.
    const STATUS_STILL_STAGED: WorkdirStatus = { ...STATUS_CLEAN, staged: [{ path: "a.ts", oldPath: null, status: "M" }] };
    vi.mocked(commands.workdirStatus).mockResolvedValue(ok(STATUS_STILL_STAGED));
    vi.mocked(commands.stashList).mockResolvedValue(ok([]));
    workdirCtrl.select("/repo");
    vi.mocked(commands.workdirFileDiff).mockResolvedValue(ok(FC_MULTI_LINE));
    await workdirCtrl.selectDiffFile("a.ts", true); // staged side

    vi.mocked(commands.unstageLines).mockResolvedValueOnce(wres({ ok: true, message: "Unstaged selected lines." }));
    await workdirCtrl.unstageLines("/repo", "a.ts", HUNKS_ONE);

    expect(commands.unstageLines).toHaveBeenCalledWith("/repo", "a.ts", HUNKS_ONE);
    expect(commands.workdirFileDiff).toHaveBeenCalledWith("/repo", "a.ts", true); // still the STAGED side
    expect(commands.workdirFileDiff).toHaveBeenCalledTimes(2); // once on select, once re-derived post-mutation
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });

  it("unstageLines: does not re-open the diff if the file dropped off this side after refreshStatus", async () => {
    mockInTauri = true;
    vi.mocked(commands.stashList).mockResolvedValue(ok([]));
    vi.mocked(commands.workdirStatus).mockResolvedValueOnce(ok(STATUS_CLEAN)); // populates status for select()
    workdirCtrl.select("/repo");
    await Promise.resolve();
    vi.mocked(commands.workdirFileDiff).mockResolvedValue(ok(FC_MULTI_LINE));
    await workdirCtrl.selectDiffFile("a.ts", true);

    vi.mocked(commands.unstageLines).mockResolvedValueOnce(wres({ ok: true }));
    // After this unstage, "a.ts" no longer appears in the staged list -> dropStaleSelectedDiff clears selectedDiffFile.
    vi.mocked(commands.workdirStatus).mockResolvedValueOnce(ok(STATUS_CLEAN));
    await workdirCtrl.unstageLines("/repo", "a.ts", HUNKS_ONE);

    expect(workdirCtrl.selectedDiffFile).toBeNull();
    // Only the ONE fetch from selectDiffFile() above happened — none after the mutation.
    expect(commands.workdirFileDiff).toHaveBeenCalledTimes(1);
  });

  it("confirmDiscardLines arms the shared danger scrim naming the file and line count, and does NOT call discard_lines directly", () => {
    workdirCtrl.confirmDiscardLines("b.ts", HUNKS_ONE);
    expect(bridge.armDanger).toHaveBeenCalledWith(
      expect.objectContaining({ name: "b.ts", title: expect.stringContaining("b.ts"), onConfirm: expect.any(Function) }),
    );
    expect(commands.discardLines).not.toHaveBeenCalled();
  });

  it("confirmDiscardLines does nothing with an empty hunk list (never arms the scrim)", () => {
    workdirCtrl.confirmDiscardLines("b.ts", []);
    expect(bridge.armDanger).not.toHaveBeenCalled();
  });

  it("only the dialog's onConfirm invokes discard_lines, and re-fetches status + diff after", async () => {
    mockInTauri = true;
    vi.mocked(commands.workdirStatus).mockResolvedValue(ok(STATUS_CLEAN));
    vi.mocked(commands.stashList).mockResolvedValue(ok([]));
    workdirCtrl.select("/repo");
    vi.mocked(commands.workdirFileDiff).mockResolvedValue(ok(FC_MULTI_LINE));
    await workdirCtrl.selectDiffFile("b.ts", false);
    vi.mocked(commands.discardLines).mockResolvedValueOnce(wres({ ok: true, message: "Discarded selected lines.", backupPatch: "diff --git a/b.ts b/b.ts\n..." }));

    workdirCtrl.confirmDiscardLines("b.ts", HUNKS_ONE);
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();

    expect(commands.discardLines).toHaveBeenCalledWith("/repo", "b.ts", HUNKS_ONE);
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
    expect(commands.workdirStatus).toHaveBeenCalledWith("/repo");
  });

  it("discardLines failure warns via Tama and does not re-fetch status", async () => {
    mockInTauri = true;
    workdirCtrl.select("/repo");
    vi.mocked(commands.discardLines).mockResolvedValueOnce(wres({ ok: false, message: "b.ts is a binary file — line-level staging isn't supported." }));
    vi.mocked(commands.workdirStatus).mockClear();

    workdirCtrl.confirmDiscardLines("b.ts", HUNKS_ONE);
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();

    expect(bridge.tama.warn).toHaveBeenCalledWith("b.ts is a binary file — line-level staging isn't supported.");
  });

  it("design mode: stageLines/unstageLines/discardLines are cosmetic no-ops with a toast", async () => {
    mockInTauri = false;
    await workdirCtrl.stageLines("", "b.ts", HUNKS_ONE);
    await workdirCtrl.unstageLines("", "a.ts", HUNKS_ONE);
    workdirCtrl.confirmDiscardLines("b.ts", HUNKS_ONE);
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();

    expect(commands.stageLines).not.toHaveBeenCalled();
    expect(commands.unstageLines).not.toHaveBeenCalled();
    expect(commands.discardLines).not.toHaveBeenCalled();
    expect(bridge.tama.say).toHaveBeenCalled();
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

  it("selectDiffFile seeds real per-hunk demo FileChange data (not a synthetic DiffRow[]) with zero IPC calls", async () => {
    vi.resetModules();
    vi.doMock("../../ipc/env", () => ({ IN_TAURI: false }));
    const bindingsDemo = await import("../../ipc/bindings");
    const { workdirCtrl: demoCtrl } = await import("./workdir.svelte.ts");

    await demoCtrl.selectDiffFile("src/auth/session.ts", false);

    expect(demoCtrl.diffFile?.path).toBe("src/auth/session.ts");
    expect(demoCtrl.diffHunks.length).toBeGreaterThan(0);
    expect(demoCtrl.diffHunks[0].lines.some((l) => l.kind === "-" && l.oldNo === 19)).toBe(true);
    expect(bindingsDemo.commands.workdirFileDiff).not.toHaveBeenCalled();
  });

  it("hunk/line staging methods are cosmetic no-ops with a toast in demo mode", async () => {
    vi.resetModules();
    vi.doMock("../../ipc/env", () => ({ IN_TAURI: false }));
    const bridgeDemo = await import("../../legacy/bridge");
    const bindingsDemo = await import("../../ipc/bindings");
    const { workdirCtrl: demoCtrl } = await import("./workdir.svelte.ts");

    const hunks = [{ header: "@@ -1,1 +1,1 @@", lines: [{ kind: "-" as const, oldNo: 1, newNo: null }] }];
    await demoCtrl.stageLines("", "b.ts", hunks);
    await demoCtrl.unstageLines("", "a.ts", hunks);
    demoCtrl.confirmDiscardLines("b.ts", hunks);
    const ctx = vi.mocked(bridgeDemo.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();

    expect(bindingsDemo.commands.stageLines).not.toHaveBeenCalled();
    expect(bindingsDemo.commands.unstageLines).not.toHaveBeenCalled();
    expect(bindingsDemo.commands.discardLines).not.toHaveBeenCalled();
    expect(bridgeDemo.tama.say).toHaveBeenCalled();
  });
});

// The Blame button's per-row target-path resolution (Workdir.svelte's
// "Blame" icon calls these directly, always with `atCommit: null` = "HEAD").
// Regression coverage for the bug these two helpers fix: blaming a rename's
// NEW path or a staged-new file's path "at HEAD" always fails on the backend
// (HEAD's own committed tree has neither yet — see blame.rs's
// `blame_at_head_fails_for_a_renames_new_path_when_the_rename_is_only_staged`
// / `blame_at_head_fails_for_a_brand_new_files_path_when_only_staged`), so
// the row must resolve to a path HEAD's tree actually has (or be disabled
// entirely) rather than hand the backend a path guaranteed to 404.
describe("canBlameWorkdirFile / blameTargetForWorkdirFile", () => {
  it("disables Blame for an untracked ('?') row — no history anywhere yet", () => {
    expect(canBlameWorkdirFile({ status: "?" })).toBe(false);
  });

  it("disables Blame for a staged-new ('A') row — nothing committed yet to blame", () => {
    expect(canBlameWorkdirFile({ status: "A" })).toBe(false);
  });

  it("allows Blame for every other status (M/D/R/T), including staged/unstaged renames", () => {
    for (const status of ["M", "D", "R", "T"]) {
      expect(canBlameWorkdirFile({ status })).toBe(true);
    }
  });

  it("a rename ('R') targets oldPath — the identity HEAD's own tree still has", () => {
    expect(blameTargetForWorkdirFile({ path: "new.ts", status: "R", oldPath: "old.ts" })).toBe("old.ts");
  });

  it("falls back to path if a rename row is ever missing oldPath (defensive)", () => {
    expect(blameTargetForWorkdirFile({ path: "new.ts", status: "R", oldPath: null })).toBe("new.ts");
  });

  it("every non-rename status targets its own path unchanged", () => {
    for (const status of ["M", "D", "T"]) {
      expect(blameTargetForWorkdirFile({ path: "f.ts", status, oldPath: null })).toBe("f.ts");
    }
  });
});

describe("buildWdTree — folder-tree grouping for Workdir.svelte's staged/unstaged lists", () => {
  const entry = (path: string, status = "M", oldPath: string | null = null): WorkdirEntry => ({ path, status, oldPath });

  it("root-level files land directly in the root node's own files array", () => {
    const tree = buildWdTree([entry("a.ts"), entry("b.ts")]);
    expect(Object.keys(tree.dirs)).toEqual([]);
    expect(tree.files.map((f) => f.name)).toEqual(["a.ts", "b.ts"]);
  });

  it("nests a file under one directory per path segment", () => {
    const tree = buildWdTree([entry("src/auth/session.ts")]);
    expect(Object.keys(tree.dirs)).toEqual(["src"]);
    expect(Object.keys(tree.dirs.src.dirs)).toEqual(["auth"]);
    expect(tree.dirs.src.dirs.auth.files).toEqual([{ path: "src/auth/session.ts", status: "M", oldPath: null, name: "session.ts" }]);
  });

  it("two files sharing a directory prefix reuse the SAME dir node, not two separate ones", () => {
    const tree = buildWdTree([entry("src/a.ts"), entry("src/b.ts")]);
    expect(Object.keys(tree.dirs)).toEqual(["src"]);
    expect(tree.dirs.src.files.map((f) => f.name)).toEqual(["a.ts", "b.ts"]);
  });

  it("keeps the caller's own array order — no sorting is applied", () => {
    const tree = buildWdTree([entry("z.ts"), entry("a.ts")]);
    expect(tree.files.map((f) => f.name)).toEqual(["z.ts", "a.ts"]);
  });

  it("a leaf's own name is just its final path segment; the full path/status/oldPath survive unchanged", () => {
    const tree = buildWdTree([entry("src/old.ts", "R", "src/renamed-from.ts")]);
    const f = tree.dirs.src.files[0];
    expect(f).toEqual({ path: "src/old.ts", status: "R", oldPath: "src/renamed-from.ts", name: "old.ts" });
  });

  it("an empty entry list produces an empty root with no dirs or files", () => {
    const tree = buildWdTree([]);
    expect(tree.dirs).toEqual({});
    expect(tree.files).toEqual([]);
  });
});

describe("workdirCtrl.stagedTree / unstagedTree — live tree views of status", () => {
  it("groups status.staged and status.unstaged independently, each into its own tree", () => {
    workdirCtrl.status = {
      staged: [{ path: "src/a.ts", status: "M", oldPath: null }],
      unstaged: [{ path: "docs/readme.md", status: "M", oldPath: null }],
      conflicted: 0,
      branch: "main",
      hasStash: false,
    };
    expect(Object.keys(workdirCtrl.stagedTree.dirs)).toEqual(["src"]);
    expect(Object.keys(workdirCtrl.unstagedTree.dirs)).toEqual(["docs"]);
  });

  it("is an empty tree when status is null (no repo open yet)", () => {
    workdirCtrl.status = null;
    expect(workdirCtrl.stagedTree).toEqual({ dirs: {}, files: [] });
    expect(workdirCtrl.unstagedTree).toEqual({ dirs: {}, files: [] });
  });
});
