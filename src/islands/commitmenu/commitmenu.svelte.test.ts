// Tests for the commit-row context menu controller.
//
// Same isolation strategy as the other islands' tests: legacy/bridge is
// mocked (never touches the real canvas), ipc/env's IN_TAURI is a mutable
// mock getter, and resolver.svelte.ts is mocked so we can assert exactly
// which of its entry points (startPick/startMerge/startRevert/openDemo) each
// context-menu action reaches — this controller owns no conflict-resolution
// logic of its own, it's purely a new entry point onto the resolver's
// existing ones (see commitmenu.svelte.ts's module doc).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
  reloadGraph: vi.fn(async () => {}),
}));

let mockInTauri = false;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    createBranch: vi.fn(),
    createTag: vi.fn(),
  },
}));

vi.mock("../resolver/resolver.svelte.ts", () => ({
  resolver: {
    openDemo: vi.fn(),
    startPick: vi.fn(async () => {}),
    startMerge: vi.fn(async () => {}),
    startRevert: vi.fn(async () => {}),
  },
}));

import * as bridge from "../../legacy/bridge";
import { commands } from "../../ipc/bindings";
import { resolver } from "../resolver/resolver.svelte.ts";
import { commitMenuCtrl } from "./commitmenu.svelte.ts";

function ok(message = "ok"): { ok: true; message: string; backupRef: null; conflictingFiles: string[] } {
  return { ok: true, message, backupRef: null, conflictingFiles: [] };
}
function fail(message = "nope"): { ok: false; message: string; backupRef: null; conflictingFiles: string[] } {
  return { ok: false, message, backupRef: null, conflictingFiles: [] };
}

function resetMenu() {
  commitMenuCtrl.open = false;
  commitMenuCtrl.view = "menu";
  commitMenuCtrl.x = 0;
  commitMenuCtrl.y = 0;
  commitMenuCtrl.repo = "";
  commitMenuCtrl.sha = "";
  commitMenuCtrl.shortSha = "";
  commitMenuCtrl.subject = "";
  commitMenuCtrl.isMerge = false;
  commitMenuCtrl.branchName = "";
  commitMenuCtrl.tagName = "";
  commitMenuCtrl.tagMessage = "";
  commitMenuCtrl.busy = false;
  commitMenuCtrl.pendingLabel = "";
}

beforeEach(() => {
  mockInTauri = false;
  vi.clearAllMocks();
  resetMenu();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn() },
    configurable: true,
  });
});

describe("openAt", () => {
  it("sets the target commit/position and resets the view to menu", () => {
    commitMenuCtrl.openAt("/repo", "abc1234567890", "Fix the thing", false, 120, 240);
    expect(commitMenuCtrl.open).toBe(true);
    expect(commitMenuCtrl.repo).toBe("/repo");
    expect(commitMenuCtrl.sha).toBe("abc1234567890");
    expect(commitMenuCtrl.shortSha).toBe("abc1234");
    expect(commitMenuCtrl.subject).toBe("Fix the thing");
    expect(commitMenuCtrl.isMerge).toBe(false);
    expect(commitMenuCtrl.x).toBe(120);
    expect(commitMenuCtrl.y).toBe(240);
    expect(commitMenuCtrl.view).toBe("menu");
  });

  it("resets to the menu view even if a previous popover was left mid-sub-form", () => {
    commitMenuCtrl.openAt("/repo", "aaa1111", "one", false, 0, 0);
    commitMenuCtrl.startBranchHere();
    commitMenuCtrl.branchName = "wip";
    expect(commitMenuCtrl.view).toBe("branch");

    commitMenuCtrl.openAt("/repo", "bbb2222", "two", true, 10, 20);
    expect(commitMenuCtrl.view).toBe("menu");
    expect(commitMenuCtrl.branchName).toBe("");
    expect(commitMenuCtrl.isMerge).toBe(true);
  });

  // Regression test: right-clicking a DIFFERENT commit row while a previous
  // create-branch/create-tag request is still in flight (busy===true, spinner
  // showing) must NOT retarget the popover. Before this fix, openAt() reset
  // EVERY field unconditionally — including `busy` back to false — which let
  // a second mutating action fire before the first had resolved, exactly what
  // `busy` exists to prevent (same class of protection CommitMenu.svelte's own
  // outside-click/Escape closers already have).
  it("refuses to retarget/reset state while busy, then works again once busy clears", () => {
    commitMenuCtrl.openAt("/repo", "aaa1111", "one", false, 100, 200);
    commitMenuCtrl.startBranchHere();
    commitMenuCtrl.branchName = "wip";
    commitMenuCtrl.busy = true; // simulate an in-flight createBranch/createTag call

    // A right-click on a different commit row while busy: must be a no-op.
    commitMenuCtrl.openAt("/repo", "ccc3333", "a different commit", true, 999, 888);
    expect(commitMenuCtrl.sha).toBe("aaa1111"); // NOT retargeted to ccc3333
    expect(commitMenuCtrl.subject).toBe("one");
    expect(commitMenuCtrl.view).toBe("branch"); // NOT reset to "menu"
    expect(commitMenuCtrl.branchName).toBe("wip"); // NOT blanked
    expect(commitMenuCtrl.x).toBe(100); // position untouched
    expect(commitMenuCtrl.y).toBe(200);
    expect(commitMenuCtrl.busy).toBe(true); // still busy — the guard itself survives

    // Once the in-flight request resolves (busy clears), a new right-click
    // retargets the popover normally again.
    commitMenuCtrl.busy = false;
    commitMenuCtrl.openAt("/repo", "ccc3333", "a different commit", true, 999, 888);
    expect(commitMenuCtrl.sha).toBe("ccc3333");
    expect(commitMenuCtrl.subject).toBe("a different commit");
    expect(commitMenuCtrl.isMerge).toBe(true);
    expect(commitMenuCtrl.view).toBe("menu");
    expect(commitMenuCtrl.branchName).toBe("");
    expect(commitMenuCtrl.x).toBe(999);
    expect(commitMenuCtrl.y).toBe(888);
  });
});

describe("cherryPick", () => {
  it("is a no-op when the target is a merge commit (mirrors legalPick's guard)", async () => {
    commitMenuCtrl.openAt("/repo", "aaa1111", "a merge", true, 0, 0);
    await commitMenuCtrl.cherryPick();
    expect(resolver.startPick).not.toHaveBeenCalled();
    expect(resolver.openDemo).not.toHaveBeenCalled();
    expect(commitMenuCtrl.open).toBe(true); // untouched — guard returns before close()
  });

  it("design mode (not IN_TAURI): opens the resolver's demo and closes the menu", async () => {
    mockInTauri = false;
    commitMenuCtrl.openAt("/repo", "aaa1111", "one", false, 0, 0);
    await commitMenuCtrl.cherryPick();
    expect(resolver.openDemo).toHaveBeenCalledWith("aaa1111");
    expect(resolver.startPick).not.toHaveBeenCalled();
    expect(commitMenuCtrl.open).toBe(false);
  });

  it("real mode: calls resolver.startPick with the repo+sha and closes the menu", async () => {
    mockInTauri = true;
    commitMenuCtrl.openAt("/repo", "aaa1111", "one", false, 0, 0);
    await commitMenuCtrl.cherryPick();
    expect(resolver.startPick).toHaveBeenCalledWith("/repo", "aaa1111", false);
    expect(resolver.openDemo).not.toHaveBeenCalled();
    expect(commitMenuCtrl.open).toBe(false);
  });

  // Loading-indicator regression: this action used to call close() BEFORE
  // awaiting resolver.startPick, so the popover vanished instantly with no
  // visible feedback for the whole real IPC round-trip (see
  // commitmenu.svelte.ts's pendingLabel doc comment for the full "why" —
  // matches the audit that added a spinner convention across every OTHER
  // mutating surface in this app, commit 5d0ab24). Assert the popover stays
  // open, busy, with a pending label WHILE the call is in flight, and only
  // closes once it resolves.
  it("real mode: stays open with a spinner/pendingLabel while startPick is in flight, closes once it resolves", async () => {
    mockInTauri = true;
    let resolveStartPick!: () => void;
    (resolver.startPick as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveStartPick = resolve; })
    );
    commitMenuCtrl.openAt("/repo", "aaa1111", "one", false, 0, 0);
    const p = commitMenuCtrl.cherryPick();
    await Promise.resolve(); // let the async fn run up to the await
    expect(commitMenuCtrl.open).toBe(true); // still open — NOT closed immediately
    expect(commitMenuCtrl.busy).toBe(true);
    expect(commitMenuCtrl.pendingLabel).toBe("Cherry-picking…");
    resolveStartPick();
    await p;
    expect(commitMenuCtrl.open).toBe(false);
    expect(commitMenuCtrl.busy).toBe(false);
  });

  it("real mode: a second cherryPick/merge/revert call while one is already in flight is a no-op", async () => {
    mockInTauri = true;
    let resolveStartPick!: () => void;
    (resolver.startPick as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveStartPick = resolve; })
    );
    commitMenuCtrl.openAt("/repo", "aaa1111", "one", false, 0, 0);
    const p = commitMenuCtrl.cherryPick();
    await Promise.resolve();
    await commitMenuCtrl.merge(); // busy===true — must no-op, not fire a second mutating action
    expect(resolver.startMerge).not.toHaveBeenCalled();
    resolveStartPick();
    await p;
  });
});

describe("merge", () => {
  it("has NO isMerge guard — merging a merge commit's tip is legal", async () => {
    mockInTauri = true;
    commitMenuCtrl.openAt("/repo", "mmm9999", "a merge", true, 0, 0);
    await commitMenuCtrl.merge();
    expect(resolver.startMerge).toHaveBeenCalledWith("/repo", "mmm9999");
  });

  it("design mode: opens the resolver's merge demo and closes the menu", async () => {
    mockInTauri = false;
    commitMenuCtrl.openAt("/repo", "aaa1111", "one", false, 0, 0);
    await commitMenuCtrl.merge();
    expect(resolver.openDemo).toHaveBeenCalledWith("aaa1111", "merge");
    expect(resolver.startMerge).not.toHaveBeenCalled();
    expect(commitMenuCtrl.open).toBe(false);
  });

  it("real mode: calls resolver.startMerge and closes the menu", async () => {
    mockInTauri = true;
    commitMenuCtrl.openAt("/repo", "aaa1111", "one", false, 0, 0);
    await commitMenuCtrl.merge();
    expect(resolver.startMerge).toHaveBeenCalledWith("/repo", "aaa1111");
    expect(commitMenuCtrl.open).toBe(false);
  });

  it("real mode: stays open with a spinner/pendingLabel while startMerge is in flight, closes once it resolves", async () => {
    mockInTauri = true;
    let resolveStartMerge!: () => void;
    (resolver.startMerge as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveStartMerge = resolve; })
    );
    commitMenuCtrl.openAt("/repo", "aaa1111", "one", false, 0, 0);
    const p = commitMenuCtrl.merge();
    await Promise.resolve();
    expect(commitMenuCtrl.open).toBe(true);
    expect(commitMenuCtrl.busy).toBe(true);
    expect(commitMenuCtrl.pendingLabel).toBe("Merging…");
    resolveStartMerge();
    await p;
    expect(commitMenuCtrl.open).toBe(false);
  });
});

describe("revert", () => {
  it("is a no-op when the target is a merge commit (mirrors detailCtrl.revertDisabled)", async () => {
    commitMenuCtrl.openAt("/repo", "aaa1111", "a merge", true, 0, 0);
    await commitMenuCtrl.revert();
    expect(resolver.startRevert).not.toHaveBeenCalled();
    expect(resolver.openDemo).not.toHaveBeenCalled();
    expect(commitMenuCtrl.open).toBe(true);
  });

  it("design mode: opens the resolver's revert demo and closes the menu", async () => {
    mockInTauri = false;
    commitMenuCtrl.openAt("/repo", "aaa1111", "one", false, 0, 0);
    await commitMenuCtrl.revert();
    expect(resolver.openDemo).toHaveBeenCalledWith("aaa1111", "revert");
    expect(resolver.startRevert).not.toHaveBeenCalled();
    expect(commitMenuCtrl.open).toBe(false);
  });

  it("real mode: calls resolver.startRevert and closes the menu", async () => {
    mockInTauri = true;
    commitMenuCtrl.openAt("/repo", "aaa1111", "one", false, 0, 0);
    await commitMenuCtrl.revert();
    expect(resolver.startRevert).toHaveBeenCalledWith("/repo", "aaa1111");
    expect(commitMenuCtrl.open).toBe(false);
  });

  it("real mode: stays open with a spinner/pendingLabel while startRevert is in flight, closes once it resolves", async () => {
    mockInTauri = true;
    let resolveStartRevert!: () => void;
    (resolver.startRevert as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveStartRevert = resolve; })
    );
    commitMenuCtrl.openAt("/repo", "aaa1111", "one", false, 0, 0);
    const p = commitMenuCtrl.revert();
    await Promise.resolve();
    expect(commitMenuCtrl.open).toBe(true);
    expect(commitMenuCtrl.busy).toBe(true);
    expect(commitMenuCtrl.pendingLabel).toBe("Reverting…");
    resolveStartRevert();
    await p;
    expect(commitMenuCtrl.open).toBe(false);
  });
});

describe("create branch here", () => {
  it("startBranchHere opens the sub-form", () => {
    commitMenuCtrl.openAt("/repo", "aaa1111", "one", false, 0, 0);
    commitMenuCtrl.startBranchHere();
    expect(commitMenuCtrl.view).toBe("branch");
    expect(commitMenuCtrl.branchName).toBe("");
  });

  it("cancelBranchForm steps back to the menu view without closing the popover", () => {
    commitMenuCtrl.openAt("/repo", "aaa1111", "one", false, 0, 0);
    commitMenuCtrl.startBranchHere();
    commitMenuCtrl.branchName = "wip";
    commitMenuCtrl.cancelBranchForm();
    expect(commitMenuCtrl.view).toBe("menu");
    expect(commitMenuCtrl.branchName).toBe("");
    expect(commitMenuCtrl.open).toBe(true);
  });

  it("confirmBranch is a client-side no-op on a blank name", async () => {
    commitMenuCtrl.openAt("/repo", "aaa1111", "one", false, 0, 0);
    commitMenuCtrl.startBranchHere();
    commitMenuCtrl.branchName = "   ";
    await commitMenuCtrl.confirmBranch();
    expect(commands.createBranch).not.toHaveBeenCalled();
    expect(commitMenuCtrl.view).toBe("menu"); // cancelBranchForm ran
    expect(commitMenuCtrl.open).toBe(true); // popover itself stays open
  });

  it("design mode: does not call createBranch, just closes with a demo toast", async () => {
    mockInTauri = false;
    commitMenuCtrl.openAt("/repo", "aaa1111", "one", false, 0, 0);
    commitMenuCtrl.startBranchHere();
    commitMenuCtrl.branchName = "feature/x";
    await commitMenuCtrl.confirmBranch();
    expect(commands.createBranch).not.toHaveBeenCalled();
    expect(bridge.tama.say).toHaveBeenCalled();
    expect(commitMenuCtrl.open).toBe(false);
  });

  it("real mode: creates the branch AT the target commit's sha (not HEAD) and always checks it out", async () => {
    mockInTauri = true;
    vi.mocked(commands.createBranch).mockResolvedValueOnce(ok("created"));
    commitMenuCtrl.openAt("/repo", "aaa1111", "one", false, 0, 0);
    commitMenuCtrl.startBranchHere();
    commitMenuCtrl.branchName = "feature/x";
    await commitMenuCtrl.confirmBranch();
    expect(commands.createBranch).toHaveBeenCalledWith("/repo", "feature/x", "aaa1111", true);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(commitMenuCtrl.open).toBe(false);
  });

  it("real mode: a failed create_branch keeps the sub-form open (not closed) for a retry", async () => {
    mockInTauri = true;
    vi.mocked(commands.createBranch).mockResolvedValueOnce(fail("branch exists"));
    commitMenuCtrl.openAt("/repo", "aaa1111", "one", false, 0, 0);
    commitMenuCtrl.startBranchHere();
    commitMenuCtrl.branchName = "feature/x";
    await commitMenuCtrl.confirmBranch();
    expect(bridge.tama.warn).toHaveBeenCalledWith("branch exists");
    expect(commitMenuCtrl.open).toBe(true);
    expect(commitMenuCtrl.view).toBe("branch");
    expect(commitMenuCtrl.busy).toBe(false);
  });
});

describe("create tag here", () => {
  it("startTagHere opens the sub-form", () => {
    commitMenuCtrl.openAt("/repo", "aaa1111", "one", false, 0, 0);
    commitMenuCtrl.startTagHere();
    expect(commitMenuCtrl.view).toBe("tag");
    expect(commitMenuCtrl.tagName).toBe("");
    expect(commitMenuCtrl.tagMessage).toBe("");
  });

  it("confirmTag is a client-side no-op on a blank name", async () => {
    commitMenuCtrl.openAt("/repo", "aaa1111", "one", false, 0, 0);
    commitMenuCtrl.startTagHere();
    commitMenuCtrl.tagName = "  ";
    await commitMenuCtrl.confirmTag();
    expect(commands.createTag).not.toHaveBeenCalled();
    expect(commitMenuCtrl.view).toBe("menu");
  });

  it("real mode: creates the tag AT the target commit's sha (not HEAD), lightweight when no message", async () => {
    mockInTauri = true;
    vi.mocked(commands.createTag).mockResolvedValueOnce(ok("created"));
    commitMenuCtrl.openAt("/repo", "aaa1111", "one", false, 0, 0);
    commitMenuCtrl.startTagHere();
    commitMenuCtrl.tagName = "v1.0.0";
    await commitMenuCtrl.confirmTag();
    expect(commands.createTag).toHaveBeenCalledWith("/repo", "v1.0.0", "aaa1111", null);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(commitMenuCtrl.open).toBe(false);
  });

  it("real mode: an annotated tag passes the trimmed message through", async () => {
    mockInTauri = true;
    vi.mocked(commands.createTag).mockResolvedValueOnce(ok("created"));
    commitMenuCtrl.openAt("/repo", "aaa1111", "one", false, 0, 0);
    commitMenuCtrl.startTagHere();
    commitMenuCtrl.tagName = "v1.0.0";
    commitMenuCtrl.tagMessage = "  release notes  ";
    await commitMenuCtrl.confirmTag();
    expect(commands.createTag).toHaveBeenCalledWith("/repo", "v1.0.0", "aaa1111", "release notes");
  });

  it("design mode: does not call createTag, just closes with a demo toast", async () => {
    mockInTauri = false;
    commitMenuCtrl.openAt("/repo", "aaa1111", "one", false, 0, 0);
    commitMenuCtrl.startTagHere();
    commitMenuCtrl.tagName = "v1.0.0";
    await commitMenuCtrl.confirmTag();
    expect(commands.createTag).not.toHaveBeenCalled();
    expect(bridge.tama.say).toHaveBeenCalled();
    expect(commitMenuCtrl.open).toBe(false);
  });
});

describe("copy actions", () => {
  it("copyShortSha writes the 7-char short sha and closes the menu", () => {
    commitMenuCtrl.openAt("/repo", "abcdef1234567", "one", false, 0, 0);
    commitMenuCtrl.copyShortSha();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("abcdef1");
    expect(commitMenuCtrl.open).toBe(false);
  });

  it("copyFullSha writes the full sha and closes the menu", () => {
    commitMenuCtrl.openAt("/repo", "abcdef1234567", "one", false, 0, 0);
    commitMenuCtrl.copyFullSha();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("abcdef1234567");
    expect(commitMenuCtrl.open).toBe(false);
  });

  it("copyMessage writes the commit subject and closes the menu", () => {
    commitMenuCtrl.openAt("/repo", "abcdef1234567", "Fix the thing", false, 0, 0);
    commitMenuCtrl.copyMessage();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Fix the thing");
    expect(commitMenuCtrl.open).toBe(false);
  });

  it("work identically in demo mode — no IN_TAURI gate", () => {
    mockInTauri = false;
    commitMenuCtrl.openAt("/repo", "abcdef1234567", "one", false, 0, 0);
    commitMenuCtrl.copyFullSha();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("abcdef1234567");
  });
});

describe("close", () => {
  it("resets every field back to blank/menu", () => {
    commitMenuCtrl.openAt("/repo", "aaa1111", "one", true, 55, 66);
    commitMenuCtrl.startTagHere();
    commitMenuCtrl.tagName = "v1";
    commitMenuCtrl.close();
    expect(commitMenuCtrl.open).toBe(false);
    expect(commitMenuCtrl.view).toBe("menu");
    expect(commitMenuCtrl.repo).toBe("");
    expect(commitMenuCtrl.sha).toBe("");
    expect(commitMenuCtrl.shortSha).toBe("");
    expect(commitMenuCtrl.subject).toBe("");
    expect(commitMenuCtrl.isMerge).toBe(false);
    expect(commitMenuCtrl.tagName).toBe("");
    expect(commitMenuCtrl.busy).toBe(false);
  });
});
