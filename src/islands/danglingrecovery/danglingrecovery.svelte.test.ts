// Tests for the fsck-based dangling-object recovery controller (backlog #13).
//
// Same isolation strategy as reflog.svelte.test.ts / remotes' own test file:
// legacy/bridge is mocked so legacy/main.ts (a whole vanilla canvas app that
// boots on import) is never evaluated. IN_TAURI is a toggleable getter (same
// shape as dashboard.svelte.test.ts/pickaxesearch.svelte.test.ts) since this
// file exercises both the real-Tauri and design-mode-demo paths.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  reloadGraph: vi.fn(async () => {}),
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
  relTime: (t: number) => "a while ago (" + t + ")",
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    danglingCommits: vi.fn(),
    createBranch: vi.fn(),
  },
}));

let mockInTauri = true;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import type { DanglingCommit, DanglingCommits, WriteResult } from "../../ipc/bindings";
import { danglingRecoveryCtrl } from "./danglingrecovery.svelte.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}

const C0: DanglingCommit = {
  sha: "a1b2c3da1b2c3da1b2c3da1b2c3da1b2c3da1b2",
  shortSha: "a1b2c3d",
  subject: "WIP: experiment",
  an: { n: "You", e: "you@x.com", t: 100 },
};
const C1: DanglingCommit = {
  sha: "e4f5061e4f5061e4f5061e4f5061e4f5061e4f5",
  shortSha: "e4f5061",
  subject: "discarded by a hard reset",
  an: { n: "You", e: "you@x.com", t: 50 },
};

function commits(list: DanglingCommit[], truncated = false): DanglingCommits {
  return { commits: list, truncated };
}

function writeResult(partial: Partial<WriteResult>): WriteResult {
  return { ok: true, message: "", backupRef: null, conflictingFiles: [], ...partial };
}

function resetCtrl() {
  danglingRecoveryCtrl.open = false;
  danglingRecoveryCtrl.loading = false;
  danglingRecoveryCtrl.error = "";
  danglingRecoveryCtrl.commits = [];
  danglingRecoveryCtrl.truncated = false;
  danglingRecoveryCtrl.demo = false;
  danglingRecoveryCtrl.recoveringSha = null;
  danglingRecoveryCtrl.branchName = "";
  danglingRecoveryCtrl.busy = false;
  danglingRecoveryCtrl.busyTarget = null;
  danglingRecoveryCtrl.repo = "";
  mockInTauri = true;
  vi.clearAllMocks();
}

beforeEach(() => {
  resetCtrl();
});

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", () => {
    expect(document.getElementById("cv")).toBeNull();
    expect(danglingRecoveryCtrl).toBeDefined();
  });
});

describe("refresh — real mode (IN_TAURI)", () => {
  it("populates commits + truncated from commands.danglingCommits on success", async () => {
    vi.mocked(commands.danglingCommits).mockResolvedValueOnce(ok(commits([C0, C1], true)));

    await danglingRecoveryCtrl.refresh("repo1");

    expect(commands.danglingCommits).toHaveBeenCalledWith("repo1");
    expect(danglingRecoveryCtrl.commits).toEqual([C0, C1]);
    expect(danglingRecoveryCtrl.truncated).toBe(true);
    expect(danglingRecoveryCtrl.error).toBe("");
    expect(danglingRecoveryCtrl.demo).toBe(false);
  });

  it("shows a clean empty state (not an error) when nothing is dangling", async () => {
    vi.mocked(commands.danglingCommits).mockResolvedValueOnce(ok(commits([])));

    await danglingRecoveryCtrl.refresh("repo1");

    expect(danglingRecoveryCtrl.commits).toEqual([]);
    expect(danglingRecoveryCtrl.error).toBe("");
  });

  it("surfaces an error and clears the list when the read fails", async () => {
    vi.mocked(commands.danglingCommits).mockResolvedValueOnce(err("cannot open repository"));

    await danglingRecoveryCtrl.refresh("repo1");

    expect(danglingRecoveryCtrl.commits).toEqual([]);
    expect(danglingRecoveryCtrl.error).toContain("cannot open repository");
  });

  it("a thrown IPC rejection surfaces an error too", async () => {
    vi.mocked(commands.danglingCommits).mockRejectedValueOnce(new Error("boom"));

    await danglingRecoveryCtrl.refresh("repo1");

    expect(danglingRecoveryCtrl.commits).toEqual([]);
    expect(danglingRecoveryCtrl.error).toContain("boom");
  });

  it("clears the list without erroring when no repo is open", async () => {
    await danglingRecoveryCtrl.refresh(null);

    expect(commands.danglingCommits).not.toHaveBeenCalled();
    expect(danglingRecoveryCtrl.commits).toEqual([]);
    expect(danglingRecoveryCtrl.error).toBe("");
  });

  it("sets loading true while the request is in flight, false once settled", async () => {
    let resolveFn!: (v: { status: "ok"; data: DanglingCommits }) => void;
    vi.mocked(commands.danglingCommits).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFn = resolve;
      }),
    );
    const p = danglingRecoveryCtrl.refresh("repo1");
    expect(danglingRecoveryCtrl.loading).toBe(true);
    resolveFn(ok(commits([])));
    await p;
    expect(danglingRecoveryCtrl.loading).toBe(false);
  });
});

describe("startRecover — suggested default branch name", () => {
  it("seeds branchName with recovered/<short-sha>", () => {
    danglingRecoveryCtrl.startRecover(C0);

    expect(danglingRecoveryCtrl.recoveringSha).toBe(C0.sha);
    expect(danglingRecoveryCtrl.branchName).toBe("recovered/" + C0.shortSha);
  });

  it("is a no-op while a recover is already in flight", () => {
    danglingRecoveryCtrl.busy = true;
    danglingRecoveryCtrl.startRecover(C0);

    expect(danglingRecoveryCtrl.recoveringSha).toBeNull();
  });

  it("cancelRecover clears the form back out", () => {
    danglingRecoveryCtrl.startRecover(C0);
    danglingRecoveryCtrl.cancelRecover();

    expect(danglingRecoveryCtrl.recoveringSha).toBeNull();
    expect(danglingRecoveryCtrl.branchName).toBe("");
  });
});

describe("confirmRecover — real mode", () => {
  it("calls createBranch with the dangling sha, the chosen name, and checkout:false — never moving HEAD", async () => {
    danglingRecoveryCtrl.repo = "repo1";
    danglingRecoveryCtrl.commits = [C0, C1];
    danglingRecoveryCtrl.startRecover(C0);
    danglingRecoveryCtrl.branchName = "my-recovered-branch";
    vi.mocked(commands.createBranch).mockResolvedValueOnce(writeResult({ ok: true, message: "Created branch my-recovered-branch." }));
    vi.mocked(commands.danglingCommits).mockResolvedValueOnce(ok(commits([C1]))); // re-pulled after recover

    await danglingRecoveryCtrl.confirmRecover();

    expect(commands.createBranch).toHaveBeenCalledWith("repo1", "my-recovered-branch", C0.sha, false);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
    expect(bridge.tama.warn).not.toHaveBeenCalled();
    // form closed + list re-pulled (the recovered commit is no longer dangling)
    expect(danglingRecoveryCtrl.recoveringSha).toBeNull();
    expect(commands.danglingCommits).toHaveBeenCalledWith("repo1");
    expect(danglingRecoveryCtrl.commits).toEqual([C1]);
    expect(danglingRecoveryCtrl.busy).toBe(false);
  });

  it("failure: warns via Tama, does NOT reload the graph, and leaves the form open", async () => {
    danglingRecoveryCtrl.repo = "repo1";
    danglingRecoveryCtrl.commits = [C0];
    danglingRecoveryCtrl.startRecover(C0);
    danglingRecoveryCtrl.branchName = "taken-name";
    vi.mocked(commands.createBranch).mockResolvedValueOnce(writeResult({ ok: false, message: "A branch named taken-name already exists." }));

    await danglingRecoveryCtrl.confirmRecover();

    expect(bridge.tama.warn).toHaveBeenCalledWith("A branch named taken-name already exists.");
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
    expect(danglingRecoveryCtrl.recoveringSha).toBe(C0.sha); // form stays open on failure
    expect(danglingRecoveryCtrl.busy).toBe(false);
  });

  it("a thrown IPC rejection warns via Tama and clears busy", async () => {
    danglingRecoveryCtrl.repo = "repo1";
    danglingRecoveryCtrl.commits = [C0];
    danglingRecoveryCtrl.startRecover(C0);
    vi.mocked(commands.createBranch).mockRejectedValueOnce(new Error("boom"));

    await danglingRecoveryCtrl.confirmRecover();

    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
    expect(danglingRecoveryCtrl.busy).toBe(false);
  });

  it("a blank branch name cancels the form instead of calling createBranch", async () => {
    danglingRecoveryCtrl.repo = "repo1";
    danglingRecoveryCtrl.commits = [C0];
    danglingRecoveryCtrl.startRecover(C0);
    danglingRecoveryCtrl.branchName = "   ";

    await danglingRecoveryCtrl.confirmRecover();

    expect(commands.createBranch).not.toHaveBeenCalled();
    expect(danglingRecoveryCtrl.recoveringSha).toBeNull();
  });

  it("warns via Tama instead of recovering without a repo", async () => {
    danglingRecoveryCtrl.repo = "";
    danglingRecoveryCtrl.commits = [C0];
    danglingRecoveryCtrl.startRecover(C0);
    danglingRecoveryCtrl.branchName = "x";

    await danglingRecoveryCtrl.confirmRecover();

    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(commands.createBranch).not.toHaveBeenCalled();
  });

  it("is a no-op with no row being recovered", async () => {
    danglingRecoveryCtrl.repo = "repo1";
    danglingRecoveryCtrl.recoveringSha = null;

    await danglingRecoveryCtrl.confirmRecover();

    expect(commands.createBranch).not.toHaveBeenCalled();
  });
});

describe("show / close (Tools menu / ⌘K entry point)", () => {
  it("show() opens the panel and re-fetches", async () => {
    vi.mocked(commands.danglingCommits).mockResolvedValueOnce(ok(commits([C0])));
    danglingRecoveryCtrl.show("repo1");
    expect(danglingRecoveryCtrl.open).toBe(true);
    await Promise.resolve(); // let the fire-and-forget refresh() settle
    expect(commands.danglingCommits).toHaveBeenCalledWith("repo1");
  });

  it("close() is blocked while a recover is in flight", () => {
    danglingRecoveryCtrl.open = true;
    danglingRecoveryCtrl.busy = true;
    danglingRecoveryCtrl.close();
    expect(danglingRecoveryCtrl.open).toBe(true);
  });

  it("close() otherwise closes it and clears any open recover form", () => {
    danglingRecoveryCtrl.open = true;
    danglingRecoveryCtrl.recoveringSha = C0.sha;
    danglingRecoveryCtrl.close();
    expect(danglingRecoveryCtrl.open).toBe(false);
    expect(danglingRecoveryCtrl.recoveringSha).toBeNull();
  });
});

describe("demo mode", () => {
  beforeEach(() => {
    mockInTauri = false;
  });

  it("refresh seeds a canned demo list without any IPC call", async () => {
    await danglingRecoveryCtrl.refresh("whatever");

    expect(danglingRecoveryCtrl.demo).toBe(true);
    expect(danglingRecoveryCtrl.commits.length).toBeGreaterThan(0);
    expect(commands.danglingCommits).not.toHaveBeenCalled();
  });

  it("recover in demo mode mutates nothing over IPC and still cheers via Tama", async () => {
    await danglingRecoveryCtrl.refresh("whatever");
    const first = danglingRecoveryCtrl.commits[0];
    danglingRecoveryCtrl.startRecover(first);

    await danglingRecoveryCtrl.confirmRecover();

    expect(commands.createBranch).not.toHaveBeenCalled();
    expect(bridge.tama.say).toHaveBeenCalled();
    expect(danglingRecoveryCtrl.recoveringSha).toBeNull();
  });
});
