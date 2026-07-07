// Tests for the filter-repo wizard controller.
//
// Same isolation strategy as resolver.svelte.test.ts / bisect.svelte.test.ts:
// legacy/bridge is mocked so legacy/main.ts (a whole vanilla canvas app that
// boots on import) is never evaluated. See that file's header comment for
// the full rationale.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  reloadGraph: vi.fn(async () => {}),
  cheer: vi.fn(),
  highlight: vi.fn(),
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
  TAMA_IMG: { alarm: "alarm.png", happy: "happy.png", shocked: "shocked.png" },
  requestRedraw: vi.fn(),
  syncBisectMarks: vi.fn(),
  focusBisectCurrent: vi.fn(),
  clearBisectMarks: vi.fn(),
  demoBisectStatus: vi.fn(),
  demoBisectMark: vi.fn(),
  renderBisect: vi.fn(),
  CUR_REPO: "/repo",
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    filterRepoPreview: vi.fn(),
    filterRepoRun: vi.fn(),
    filterRepoRestore: vi.fn(),
    filterRepoListBackups: vi.fn(),
  },
}));

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import type { FilterRepoBackupInfo, FilterRepoPreview, FilterRepoResult } from "../../ipc/bindings";
import { filterRepoCtrl, REWRITE_PHRASE, RESTORE_PHRASE } from "./filterrepo.svelte.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}

function preview(partial: Partial<FilterRepoPreview> = {}): FilterRepoPreview {
  return { available: true, currentBranch: "main", totalCommits: 42, touchedCommits: 7, ...partial };
}
function result(partial: Partial<FilterRepoResult> = {}): FilterRepoResult {
  return { ok: true, message: "History rewritten.", backupBundle: "/repo/.git/gitgui/x.bundle", commitsBefore: 42, commitsAfter: 35, ...partial };
}
function backup(partial: Partial<FilterRepoBackupInfo> = {}): FilterRepoBackupInfo {
  return {
    id: "b1",
    bundlePath: "/repo/.git/gitgui/filter-repo-backups/b1.bundle",
    ts: 1700000000,
    headBranch: "refs/heads/main",
    headSha: "abc123",
    refCount: 4,
    description: "pre-filter-repo backup (4 refs)",
    ...partial,
  };
}

function resetCtrl() {
  filterRepoCtrl.open = false;
  filterRepoCtrl.busy = false;
  filterRepoCtrl.demo = false;
  filterRepoCtrl.step = "scope";
  filterRepoCtrl.tamaImg = "";
  filterRepoCtrl.pathsText = "";
  filterRepoCtrl.invert = true;
  filterRepoCtrl.preview = null;
  filterRepoCtrl.previewError = "";
  filterRepoCtrl.confirmText = "";
  filterRepoCtrl.result = null;
  filterRepoCtrl.backups = [];
  filterRepoCtrl.backupsError = "";
  filterRepoCtrl.selectedBackupId = null;
  filterRepoCtrl.restoreConfirmText = "";
  filterRepoCtrl.restoreResult = null;
  filterRepoCtrl.restoreBusy = false;
  filterRepoCtrl.repo = "";
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCtrl();
});

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", () => {
    expect(document.getElementById("cv")).toBeNull();
    expect(filterRepoCtrl).toBeDefined();
  });
});

describe("start", () => {
  it("opens the wizard at the scope step and pings the mascot", () => {
    filterRepoCtrl.start("repo1");

    expect(filterRepoCtrl.open).toBe(true);
    expect(filterRepoCtrl.demo).toBe(false);
    expect(filterRepoCtrl.step).toBe("scope");
    expect(filterRepoCtrl.repo).toBe("repo1");
    expect(bridge.tama.event).toHaveBeenCalledWith("mutation.destructive", { label: "git filter-repo" });
  });

  it("warns via Tama instead of opening without a repo", () => {
    filterRepoCtrl.start("");
    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(filterRepoCtrl.open).toBe(false);
  });
});

describe("openDemo", () => {
  it("opens the wizard in demo mode with no IPC calls", () => {
    filterRepoCtrl.openDemo();

    expect(filterRepoCtrl.open).toBe(true);
    expect(filterRepoCtrl.demo).toBe(true);
    expect(filterRepoCtrl.step).toBe("scope");
    expect(commands.filterRepoPreview).not.toHaveBeenCalled();
  });
});

describe("runPreview", () => {
  it("refuses an empty scope without calling the backend", async () => {
    filterRepoCtrl.start("repo1");
    filterRepoCtrl.pathsText = "   \n  ";

    await filterRepoCtrl.runPreview();

    expect(filterRepoCtrl.previewError).toMatch(/at least one path/i);
    expect(commands.filterRepoPreview).not.toHaveBeenCalled();
    expect(filterRepoCtrl.step).toBe("scope");
  });

  it("success (binary available) advances to the preview step", async () => {
    filterRepoCtrl.start("repo1");
    filterRepoCtrl.pathsText = "secrets.env\nbuild/";
    filterRepoCtrl.invert = true;
    vi.mocked(commands.filterRepoPreview).mockResolvedValueOnce(ok(preview({ available: true })));

    await filterRepoCtrl.runPreview();

    expect(commands.filterRepoPreview).toHaveBeenCalledWith("repo1", ["secrets.env", "build/"], true);
    expect(filterRepoCtrl.step).toBe("preview");
    expect(filterRepoCtrl.preview?.available).toBe(true);
    expect(filterRepoCtrl.canProceedToConfirm).toBe(true);
  });

  it("binary missing: preview succeeds but proceeding to confirm is blocked", async () => {
    filterRepoCtrl.start("repo1");
    filterRepoCtrl.pathsText = "secrets.env";
    vi.mocked(commands.filterRepoPreview).mockResolvedValueOnce(ok(preview({ available: false })));

    await filterRepoCtrl.runPreview();

    expect(filterRepoCtrl.step).toBe("preview");
    expect(filterRepoCtrl.preview?.available).toBe(false);
    expect(filterRepoCtrl.canProceedToConfirm).toBe(false);

    filterRepoCtrl.proceedToConfirm();
    expect(filterRepoCtrl.step).toBe("preview"); // blocked — stays put
  });

  it("backend error surfaces previewError and stays on scope", async () => {
    filterRepoCtrl.start("repo1");
    filterRepoCtrl.pathsText = "secrets.env";
    vi.mocked(commands.filterRepoPreview).mockResolvedValueOnce(err("cannot open repository"));

    await filterRepoCtrl.runPreview();

    expect(filterRepoCtrl.step).toBe("scope");
    expect(filterRepoCtrl.previewError).toMatch(/cannot open repository/);
  });

  it("demo mode: canned preview, no IPC call", async () => {
    filterRepoCtrl.openDemo();
    filterRepoCtrl.pathsText = "anything";

    await filterRepoCtrl.runPreview();

    expect(filterRepoCtrl.step).toBe("preview");
    expect(filterRepoCtrl.preview?.available).toBe(true);
    expect(commands.filterRepoPreview).not.toHaveBeenCalled();
  });
});

describe("typed-confirm gate", () => {
  it("canRun is false until the exact phrase is typed, true once it matches", async () => {
    filterRepoCtrl.start("repo1");
    filterRepoCtrl.pathsText = "secrets.env";
    vi.mocked(commands.filterRepoPreview).mockResolvedValueOnce(ok(preview({ available: true })));
    await filterRepoCtrl.runPreview();
    filterRepoCtrl.proceedToConfirm();
    expect(filterRepoCtrl.step).toBe("confirm");

    expect(filterRepoCtrl.canRun).toBe(false);

    filterRepoCtrl.confirmText = "rewrite history"; // wrong case
    expect(filterRepoCtrl.canRun).toBe(false);

    filterRepoCtrl.confirmText = REWRITE_PHRASE + " "; // trimmed exact match
    expect(filterRepoCtrl.canRun).toBe(true);

    filterRepoCtrl.confirmText = REWRITE_PHRASE.slice(0, -1); // near miss
    expect(filterRepoCtrl.canRun).toBe(false);
  });

  it("runFilterRepo is a no-op while canRun is false", async () => {
    filterRepoCtrl.start("repo1");
    filterRepoCtrl.pathsText = "secrets.env";
    vi.mocked(commands.filterRepoPreview).mockResolvedValueOnce(ok(preview({ available: true })));
    await filterRepoCtrl.runPreview();
    filterRepoCtrl.proceedToConfirm();

    await filterRepoCtrl.runFilterRepo();

    expect(commands.filterRepoRun).not.toHaveBeenCalled();
    expect(filterRepoCtrl.step).toBe("confirm");
  });
});

async function armToConfirm(scope = "secrets.env") {
  filterRepoCtrl.start("repo1");
  filterRepoCtrl.pathsText = scope;
  vi.mocked(commands.filterRepoPreview).mockResolvedValueOnce(ok(preview({ available: true })));
  await filterRepoCtrl.runPreview();
  filterRepoCtrl.proceedToConfirm();
  filterRepoCtrl.confirmText = REWRITE_PHRASE;
}

describe("runFilterRepo", () => {
  it("success: calls the backend with the scope, reloads the graph, shows the result", async () => {
    await armToConfirm();
    vi.mocked(commands.filterRepoRun).mockResolvedValueOnce(result({ ok: true, message: "done" }));

    await filterRepoCtrl.runFilterRepo();

    expect(commands.filterRepoRun).toHaveBeenCalledWith("repo1", ["secrets.env"], true);
    expect(filterRepoCtrl.step).toBe("result");
    expect(filterRepoCtrl.result?.ok).toBe(true);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });

  it("failure (ok:false): shows the result with the backup bundle, does not reload the graph", async () => {
    await armToConfirm();
    vi.mocked(commands.filterRepoRun).mockResolvedValueOnce(
      result({ ok: false, message: "working tree dirty", backupBundle: null, commitsBefore: null, commitsAfter: null }),
    );

    await filterRepoCtrl.runFilterRepo();

    expect(filterRepoCtrl.step).toBe("result");
    expect(filterRepoCtrl.result?.ok).toBe(false);
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
    expect(bridge.tama.warn).toHaveBeenCalled();
  });

  it("demo mode: fakes a successful result, no IPC call", async () => {
    filterRepoCtrl.openDemo();
    filterRepoCtrl.pathsText = "secrets.env";
    await filterRepoCtrl.runPreview();
    filterRepoCtrl.proceedToConfirm();
    filterRepoCtrl.confirmText = REWRITE_PHRASE;

    await filterRepoCtrl.runFilterRepo();

    expect(commands.filterRepoRun).not.toHaveBeenCalled();
    expect(filterRepoCtrl.step).toBe("result");
    expect(filterRepoCtrl.result?.ok).toBe(true);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
  });
});

describe("restore view", () => {
  it("openRestore populates the backup list from filter_repo_list_backups", async () => {
    filterRepoCtrl.start("repo1");
    vi.mocked(commands.filterRepoListBackups).mockResolvedValueOnce(ok([backup({ id: "b1" }), backup({ id: "b2" })]));

    await filterRepoCtrl.openRestore();

    expect(filterRepoCtrl.step).toBe("restore");
    expect(commands.filterRepoListBackups).toHaveBeenCalledWith("repo1");
    expect(filterRepoCtrl.backups).toHaveLength(2);
  });

  it("list-backups error surfaces backupsError", async () => {
    filterRepoCtrl.start("repo1");
    vi.mocked(commands.filterRepoListBackups).mockResolvedValueOnce(err("cannot open repository"));

    await filterRepoCtrl.openRestore();

    expect(filterRepoCtrl.backupsError).toMatch(/cannot open repository/);
    expect(filterRepoCtrl.backups).toHaveLength(0);
  });

  it("typed-confirm gate: canRestore requires a selected backup AND the exact phrase", async () => {
    filterRepoCtrl.start("repo1");
    vi.mocked(commands.filterRepoListBackups).mockResolvedValueOnce(ok([backup({ id: "b1" })]));
    await filterRepoCtrl.openRestore();

    expect(filterRepoCtrl.canRestore).toBe(false);

    filterRepoCtrl.selectBackup("b1");
    expect(filterRepoCtrl.canRestore).toBe(false); // still needs the phrase

    filterRepoCtrl.restoreConfirmText = "restore"; // wrong case
    expect(filterRepoCtrl.canRestore).toBe(false);

    filterRepoCtrl.restoreConfirmText = RESTORE_PHRASE;
    expect(filterRepoCtrl.canRestore).toBe(true);
  });

  it("runRestore success: calls the backend, reloads the graph", async () => {
    filterRepoCtrl.start("repo1");
    vi.mocked(commands.filterRepoListBackups).mockResolvedValueOnce(ok([backup({ id: "b1" })]));
    await filterRepoCtrl.openRestore();
    filterRepoCtrl.selectBackup("b1");
    filterRepoCtrl.restoreConfirmText = RESTORE_PHRASE;
    vi.mocked(commands.filterRepoRestore).mockResolvedValueOnce(
      result({ ok: true, message: "Restored 4/4 ref(s).", commitsBefore: null, commitsAfter: 42 }),
    );

    await filterRepoCtrl.runRestore();

    expect(commands.filterRepoRestore).toHaveBeenCalledWith("repo1", "b1");
    expect(filterRepoCtrl.restoreResult?.ok).toBe(true);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
  });

  it("runRestore failure: surfaces the message, does not reload the graph", async () => {
    filterRepoCtrl.start("repo1");
    vi.mocked(commands.filterRepoListBackups).mockResolvedValueOnce(ok([backup({ id: "b1" })]));
    await filterRepoCtrl.openRestore();
    filterRepoCtrl.selectBackup("b1");
    filterRepoCtrl.restoreConfirmText = RESTORE_PHRASE;
    vi.mocked(commands.filterRepoRestore).mockResolvedValueOnce(
      result({ ok: false, message: "Failures: refs/heads/main: ...", commitsBefore: null }),
    );

    await filterRepoCtrl.runRestore();

    expect(filterRepoCtrl.restoreResult?.ok).toBe(false);
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
    expect(bridge.tama.warn).toHaveBeenCalled();
  });

  it("runRestore is a no-op while canRestore is false", async () => {
    filterRepoCtrl.start("repo1");
    vi.mocked(commands.filterRepoListBackups).mockResolvedValueOnce(ok([backup({ id: "b1" })]));
    await filterRepoCtrl.openRestore();
    filterRepoCtrl.selectBackup("b1"); // no phrase typed yet

    await filterRepoCtrl.runRestore();

    expect(commands.filterRepoRestore).not.toHaveBeenCalled();
  });

  it("openRestoreDemo: canned backups, restore is faked with no IPC call", async () => {
    filterRepoCtrl.openDemo();

    await filterRepoCtrl.openRestoreDemo();

    expect(filterRepoCtrl.step).toBe("restore");
    expect(filterRepoCtrl.backups.length).toBeGreaterThan(0);
    expect(commands.filterRepoListBackups).not.toHaveBeenCalled();

    filterRepoCtrl.selectBackup(filterRepoCtrl.backups[0].id);
    filterRepoCtrl.restoreConfirmText = RESTORE_PHRASE;
    await filterRepoCtrl.runRestore();

    expect(commands.filterRepoRestore).not.toHaveBeenCalled();
    expect(filterRepoCtrl.restoreResult?.ok).toBe(true);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
  });
});

describe("close", () => {
  it("resets every step of the wizard", async () => {
    await armToConfirm();
    vi.mocked(commands.filterRepoRun).mockResolvedValueOnce(result());
    await filterRepoCtrl.runFilterRepo();

    filterRepoCtrl.close();

    expect(filterRepoCtrl.open).toBe(false);
    expect(filterRepoCtrl.step).toBe("scope");
    expect(filterRepoCtrl.pathsText).toBe("");
    expect(filterRepoCtrl.preview).toBeNull();
    expect(filterRepoCtrl.result).toBeNull();
    expect(filterRepoCtrl.confirmText).toBe("");
  });
});
