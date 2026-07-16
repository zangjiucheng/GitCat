// Tests for the cherry-pick conflict resolver controller.
//
// Isolation: `resolver.svelte.ts` imports `../../legacy/bridge`, which live
// re-exports from `../../legacy/main`, a vanilla script that boots a whole
// canvas app as an import side effect (throws in bare jsdom — no #cv element).
// `vi.mock` below is hoisted above the import graph, so `legacy/main.ts` is
// NEVER evaluated; we assert that explicitly in the first test.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  reloadGraph: vi.fn(async () => {}),
  cheer: vi.fn(),
  highlight: vi.fn(),
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
  TAMA_IMG: { alarm: "alarm.png", happy: "happy.png", thinking: "thinking.png" },
  requestRedraw: vi.fn(),
  syncBisectMarks: vi.fn(),
  focusBisectCurrent: vi.fn(),
  clearBisectMarks: vi.fn(),
  demoBisectStatus: vi.fn(),
  demoBisectMark: vi.fn(),
  renderBisect: vi.fn(),
  selectWorkdir: vi.fn(),
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    cherryPick: vi.fn(),
    cherryPickContinue: vi.fn(),
    cherryPickAbort: vi.fn(),
    mergeStart: vi.fn(),
    mergeContinue: vi.fn(),
    mergeAbort: vi.fn(),
    rebaseStart: vi.fn(),
    rebaseContinue: vi.fn(),
    rebaseSkip: vi.fn(),
    rebaseAbort: vi.fn(),
    revertStart: vi.fn(),
    revertContinue: vi.fn(),
    revertAbort: vi.fn(),
    stashConflictAbort: vi.fn(),
    stashConflictContinue: vi.fn(),
    stashSave: vi.fn(),
    stashList: vi.fn(),
    stashPop: vi.fn(),
    workdirStatus: vi.fn(),
    mergeSquash: vi.fn(),
    mergeSquashAbort: vi.fn(),
    mergeSquashContinue: vi.fn(),
    conflictStatus: vi.fn(),
    resolveConflictFile: vi.fn(),
    resolveConflictWithExternalTool: vi.fn(),
    conflictFileHunks: vi.fn(),
    resolveConflictHunks: vi.fn(),
    currentUpstream: vi.fn(),
    fetch: vi.fn(),
  },
}));

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import type {
  ConflictFile,
  ConflictFileHunks,
  ConflictStatus,
  MergeResult,
  MergeSquashResult,
  PickResult,
  RebaseResult,
  ResolveResult,
  RevertResult,
  StashResolveResult,
  WorkdirResult,
} from "../../ipc/bindings";
import { resolver } from "./resolver.svelte.ts";
// Real (unmocked) module — resolver.svelte.ts imports the real `workdirCtrl`
// singleton to hand a resolved/clean squash off to (see `openSquashStaged`);
// asserting against it directly here (rather than mocking it) verifies the
// actual wiring, same rationale as this file exercising `resolver` itself
// unmocked.
import { workdirCtrl } from "../workdir/workdir.svelte.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}

function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}

function remoteResult(partial: { ok: boolean; message?: string; backupRef?: string | null }) {
  return { message: "", backupRef: null, ...partial };
}

const FILE_A: ConflictFile = { path: "a.ts", ours: "o", base: "b", theirs: "t" };
const FILE_B: ConflictFile = { path: "b.ts", ours: "o2", base: "b2", theirs: "t2" };

function pickResult(partial: Partial<PickResult>): PickResult {
  return { ok: true, state: "clean", conflictedFiles: [], message: "", backupRef: null, blockedByLocalChanges: false, ...partial };
}

function mergeResult(partial: Partial<MergeResult>): MergeResult {
  return { ok: true, state: "clean", conflictedFiles: [], message: "", backupRef: null, blockedByLocalChanges: false, ...partial };
}

function rebaseResult(partial: Partial<RebaseResult>): RebaseResult {
  return { ok: true, state: "clean", conflictedFiles: [], message: "", backupRef: null, blockedByLocalChanges: false, ...partial };
}

function revertResult(partial: Partial<RevertResult>): RevertResult {
  return { ok: true, state: "clean", conflictedFiles: [], message: "", backupRef: null, blockedByLocalChanges: false, ...partial };
}

function stashResolveResult(partial: Partial<StashResolveResult>): StashResolveResult {
  return { ok: true, state: "clean", conflictedFiles: [], message: "", backupRef: null, ...partial };
}

function mergeSquashResult(partial: Partial<MergeSquashResult>): MergeSquashResult {
  return { ok: true, state: "staged", conflictedFiles: [], message: "", backupRef: null, suggestedMessage: null, ...partial };
}

function workdirResult(partial: Partial<WorkdirResult>): WorkdirResult {
  return { ok: false, message: "", conflictedFiles: [], backupRef: null, backupPatch: null, droppedStashRef: null, ...partial };
}

function conflictStatus(files: ConflictFile[], inProgress = true, op = "cherry-pick"): ConflictStatus {
  return { inProgress, op, files };
}

function resetResolver() {
  resolver.open = false;
  resolver.busy = false;
  resolver.demo = false;
  resolver.sub = "";
  resolver.backupRef = "";
  resolver.tamaImg = "";
  resolver.files = [];
  resolver.selected = null;
  resolver.remaining = new Set();
  resolver.repo = "";
  resolver.sha = "";
  resolver.op = "cherry-pick";
  resolver.dirtyBlock = null;
  resolver.dirtyBlockStuck = null;
  resolver.editMode = false;
  resolver.editLoading = false;
  resolver.editBinary = false;
  resolver.editHunks = [];
  resolver.editValues = [];
  resolver.queueContinue = null;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetResolver();
  workdirCtrl.message = ""; // real (unmocked) singleton — reset between tests, see the import's own comment
  // Default to "genuinely clean" so every EXISTING stash-and-retry test
  // (written before this post-stash verification existed) doesn't need to
  // know or care about it — only the tests that specifically exercise the
  // "stash silently left something behind" case override this.
  vi.mocked(commands.workdirStatus).mockResolvedValue(
    ok({ staged: [], unstaged: [], conflicted: 0, branch: "main", hasStash: false }),
  );
});

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", () => {
    // legacy/main.ts does `$("#cv").getContext("2d")` at import time, which
    // throws in bare jsdom. If it had been evaluated, importing this test
    // module would already have thrown before reaching this assertion.
    expect(document.getElementById("cv")).toBeNull();
    expect(resolver).toBeDefined();
  });
});

describe("openDemo", () => {
  it("populates files/selected/remaining/open and pings the mascot", () => {
    resolver.openDemo("deadbee");

    expect(resolver.open).toBe(true);
    expect(resolver.demo).toBe(true);
    expect(resolver.files).toHaveLength(1);
    expect(resolver.files[0].path).toBe("src/auth/token.ts");
    expect(resolver.selected).toBe("src/auth/token.ts");
    expect(resolver.remaining.has("src/auth/token.ts")).toBe(true);
    expect(resolver.remaining.size).toBe(1);
    expect(bridge.tama.event).toHaveBeenCalledWith("mutation.caution", { count: 1 });
  });
});

describe("startPick", () => {
  it("clean result: reloads the graph and closes the modal", async () => {
    vi.mocked(commands.cherryPick).mockResolvedValueOnce(
      pickResult({ state: "clean", message: "Cherry-picked.", backupRef: "refs/gitgui/backup/x" }),
    );

    await resolver.startPick("repo1", "sha1", true);

    expect(commands.cherryPick).toHaveBeenCalledWith("repo1", "sha1", true);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(resolver.open).toBe(false);
    expect(resolver.busy).toBe(false);
  });

  it("conflict result: opens the modal and populates files from conflict_status", async () => {
    vi.mocked(commands.cherryPick).mockResolvedValueOnce(
      pickResult({
        state: "conflict",
        conflictedFiles: ["a.ts", "b.ts"],
        backupRef: "refs/gitgui/backup/y",
      }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_A, FILE_B])));

    await resolver.startPick("repo1", "sha2", false);

    expect(resolver.open).toBe(true);
    expect(resolver.busy).toBe(false);
    expect(resolver.files).toEqual([FILE_A, FILE_B]);
    expect(resolver.remaining.size).toBe(2);
    expect(resolver.backupRef).toBe("refs/gitgui/backup/y");
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
  });

  it("warns via Tama instead of opening the modal without a repo", async () => {
    await resolver.startPick("", "sha", true);
    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(commands.cherryPick).not.toHaveBeenCalled();
    expect(resolver.open).toBe(false);
  });

  it("a plain error (not blockedByLocalChanges) still just warns via Tama — no dirtyBlock chooser", async () => {
    vi.mocked(commands.cherryPick).mockResolvedValueOnce(
      pickResult({ ok: false, state: "error", message: "bad revision", blockedByLocalChanges: false }),
    );
    await resolver.startPick("repo1", "sha4", true);
    expect(bridge.tama.warn).toHaveBeenCalledWith("bad revision");
    expect(resolver.dirtyBlock).toBeNull();
    expect(resolver.open).toBe(false);
  });

  it("a blockedByLocalChanges error opens the dirty-tree chooser instead of a plain toast", async () => {
    vi.mocked(commands.cherryPick).mockResolvedValueOnce(
      pickResult({ ok: false, state: "error", message: "would be overwritten by merge", blockedByLocalChanges: true }),
    );
    await resolver.startPick("repo1", "sha5", true);
    expect(bridge.tama.warn).not.toHaveBeenCalled();
    expect(resolver.dirtyBlock).not.toBeNull();
    expect(resolver.dirtyBlock?.message).toBe("would be overwritten by merge");
    expect(resolver.dirtyBlock?.verb).toBe("Cherry-pick");
    expect(resolver.open).toBe(false);
  });
});

describe("startMerge", () => {
  it("clean result: reloads the graph and closes the modal", async () => {
    vi.mocked(commands.mergeStart).mockResolvedValueOnce(
      mergeResult({ state: "clean", message: "Merged." }),
    );

    await resolver.startMerge("repo1", "sha1");

    // Regression check (backlog #7): startMerge's own default `strategy`
    // arg forwards `null` (== "auto", today's exact pre-#7 behavior) to
    // commands.mergeStart when the caller passes none — every existing
    // caller (drag gesture, commit-menu Merge, pullMerge) calls startMerge
    // with exactly these two args, unchanged.
    expect(commands.mergeStart).toHaveBeenCalledWith("repo1", "sha1", null);
    expect(commands.cherryPick).not.toHaveBeenCalled();
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(resolver.open).toBe(false);
    expect(resolver.busy).toBe(false);
  });

  it("conflict result: opens the modal, sets op to merge, and populates files from conflict_status", async () => {
    vi.mocked(commands.mergeStart).mockResolvedValueOnce(
      mergeResult({
        ok: false,
        state: "conflict",
        conflictedFiles: ["a.ts", "b.ts"],
        backupRef: "refs/gitgui/backup/z",
      }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(
      ok(conflictStatus([FILE_A, FILE_B], true, "merge")),
    );

    await resolver.startMerge("repo1", "sha3");

    expect(resolver.open).toBe(true);
    expect(resolver.busy).toBe(false);
    expect(resolver.op).toBe("merge");
    expect(resolver.files).toEqual([FILE_A, FILE_B]);
    expect(resolver.remaining.size).toBe(2);
    expect(resolver.backupRef).toBe("refs/gitgui/backup/z");
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
  });

  it("warns via Tama instead of opening the modal without a repo", async () => {
    await resolver.startMerge("", "sha");
    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(commands.mergeStart).not.toHaveBeenCalled();
    expect(resolver.open).toBe(false);
  });

  // Backlog #7: the Sidebar's new "Merge into current…" strategy chooser is
  // the ONLY caller that ever passes an explicit non-default strategy — see
  // sidebar.svelte.ts's `mergeInto`.
  it("forwards an explicit strategy straight through to commands.mergeStart", async () => {
    vi.mocked(commands.mergeStart).mockResolvedValueOnce(mergeResult({ state: "clean", message: "Merged." }));
    await resolver.startMerge("repo1", "feature", "no-ff");
    expect(commands.mergeStart).toHaveBeenCalledWith("repo1", "feature", "no-ff");
  });

  it("forwards \"ff-only\" straight through to commands.mergeStart", async () => {
    vi.mocked(commands.mergeStart).mockResolvedValueOnce(mergeResult({ state: "clean", message: "Merged." }));
    await resolver.startMerge("repo1", "feature", "ff-only");
    expect(commands.mergeStart).toHaveBeenCalledWith("repo1", "feature", "ff-only");
  });
});

// Backlog #7's squash-merge entry point. Unlike every other op's "clean",
// merge_squash's success is "staged" (see MergeSquashResult's own doc
// comment) — it hands off to the ALREADY-BUILT Workdir commit UI with
// `.git/SQUASH_MSG`'s captured content prefilled, instead of closing+cheering.
describe("startMergeSquash (squash-merge, #7)", () => {
  it("staged (clean) result: closes the modal, hands off to Workdir with the suggested message prefilled", async () => {
    vi.mocked(commands.mergeSquash).mockResolvedValueOnce(
      mergeSquashResult({ state: "staged", message: "Squashed feature into the index.", suggestedMessage: "Squash commit 'feature'" }),
    );

    await resolver.startMergeSquash("repo1", "feature");

    expect(commands.mergeSquash).toHaveBeenCalledWith("repo1", "feature");
    expect(resolver.open).toBe(false);
    expect(resolver.busy).toBe(false);
    expect(bridge.selectWorkdir).toHaveBeenCalled();
    expect(workdirCtrl.message).toBe("Squash commit 'feature'");
    // Squash never commits/moves a ref, so it must never reach the
    // "clean"-only reloadGraph/cheer path every other op's success takes.
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
    expect(bridge.cheer).not.toHaveBeenCalled();
  });

  it("staged result with no suggested message: hands off with an empty prefill, not \"undefined\"/null", async () => {
    vi.mocked(commands.mergeSquash).mockResolvedValueOnce(
      mergeSquashResult({ state: "staged", suggestedMessage: null }),
    );

    await resolver.startMergeSquash("repo1", "feature");

    expect(workdirCtrl.message).toBe("");
  });

  it("conflict result: opens the modal, sets op to merge-squash, and populates files from conflict_status", async () => {
    vi.mocked(commands.mergeSquash).mockResolvedValueOnce(
      mergeSquashResult({
        ok: false,
        state: "conflict",
        conflictedFiles: ["a.ts", "b.ts"],
        backupRef: "refs/gitgui/backup/sq1",
      }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(
      ok(conflictStatus([FILE_A, FILE_B], true, "merge-squash")),
    );

    await resolver.startMergeSquash("repo1", "feature");

    expect(resolver.open).toBe(true);
    expect(resolver.busy).toBe(false);
    expect(resolver.op).toBe("merge-squash");
    expect(resolver.files).toEqual([FILE_A, FILE_B]);
    expect(resolver.remaining.size).toBe(2);
    expect(resolver.backupRef).toBe("refs/gitgui/backup/sq1");
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
    expect(bridge.selectWorkdir).not.toHaveBeenCalled();
  });

  it("warns via Tama instead of opening the modal without a repo", async () => {
    await resolver.startMergeSquash("", "sha");
    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(commands.mergeSquash).not.toHaveBeenCalled();
    expect(resolver.open).toBe(false);
  });

  it("a merge-squash conflict's abort calls mergeSquashAbort, never mergeAbort/stashConflictAbort", async () => {
    vi.mocked(commands.mergeSquash).mockResolvedValueOnce(
      mergeSquashResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"] }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_A], true, "merge-squash")));
    await resolver.startMergeSquash("repo1", "feature");
    expect(resolver.op).toBe("merge-squash");

    vi.mocked(commands.mergeSquashAbort).mockResolvedValueOnce(
      mergeSquashResult({ state: "clean", message: "Squash-merge conflict aborted." }),
    );

    await resolver.abort();

    expect(commands.mergeSquashAbort).toHaveBeenCalledWith("repo1");
    expect(commands.mergeAbort).not.toHaveBeenCalled();
    expect(commands.stashConflictAbort).not.toHaveBeenCalled();
    expect(resolver.open).toBe(false);
  });

  it("a merge-squash conflict's continue calls mergeSquashContinue and, once resolved, hands off to Workdir (not close+cheer)", async () => {
    vi.mocked(commands.mergeSquash).mockResolvedValueOnce(
      mergeSquashResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"] }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_A], true, "merge-squash")));
    await resolver.startMergeSquash("repo1", "feature");

    vi.mocked(commands.mergeSquashContinue).mockResolvedValueOnce(
      mergeSquashResult({ state: "staged", message: "Squash-merge conflict resolved.", suggestedMessage: "resolved squash msg" }),
    );

    await resolver.continue();

    expect(commands.mergeSquashContinue).toHaveBeenCalledWith("repo1");
    expect(commands.mergeContinue).not.toHaveBeenCalled();
    expect(resolver.open).toBe(false);
    expect(bridge.selectWorkdir).toHaveBeenCalled();
    expect(workdirCtrl.message).toBe("resolved squash msg");
    expect(bridge.cheer).not.toHaveBeenCalled();
  });

  it("still conflicted continue: stays open, does not hand off to Workdir", async () => {
    vi.mocked(commands.mergeSquash).mockResolvedValueOnce(
      mergeSquashResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts", "b.ts"] }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_A, FILE_B], true, "merge-squash")));
    await resolver.startMergeSquash("repo1", "feature");

    vi.mocked(commands.mergeSquashContinue).mockResolvedValueOnce(
      mergeSquashResult({ ok: false, state: "conflict", conflictedFiles: ["b.ts"], message: "Still conflicted in 1 file." }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_B], true, "merge-squash")));

    await resolver.continue();

    expect(resolver.open).toBe(true);
    expect(resolver.files).toEqual([FILE_B]);
    expect(bridge.selectWorkdir).not.toHaveBeenCalled();
  });
});

describe("startRebase", () => {
  it("clean result: reloads the graph and closes the modal", async () => {
    vi.mocked(commands.rebaseStart).mockResolvedValueOnce(
      rebaseResult({ state: "clean", message: "Rebased." }),
    );

    await resolver.startRebase("repo1", "main");

    expect(commands.rebaseStart).toHaveBeenCalledWith("repo1", "main");
    expect(commands.mergeStart).not.toHaveBeenCalled();
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(resolver.open).toBe(false);
    expect(resolver.busy).toBe(false);
  });

  it("conflict result: opens the modal, sets op to rebase, and populates files from conflict_status", async () => {
    vi.mocked(commands.rebaseStart).mockResolvedValueOnce(
      rebaseResult({
        ok: false,
        state: "conflict",
        conflictedFiles: ["a.ts", "b.ts"],
        backupRef: "refs/gitgui/backup/r1",
      }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(
      ok(conflictStatus([FILE_A, FILE_B], true, "rebase")),
    );

    await resolver.startRebase("repo1", "main");

    expect(resolver.open).toBe(true);
    expect(resolver.busy).toBe(false);
    expect(resolver.op).toBe("rebase");
    expect(resolver.files).toEqual([FILE_A, FILE_B]);
    expect(resolver.remaining.size).toBe(2);
    expect(resolver.backupRef).toBe("refs/gitgui/backup/r1");
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
  });

  it("warns via Tama instead of opening the modal without a repo", async () => {
    await resolver.startRebase("", "main");
    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(commands.rebaseStart).not.toHaveBeenCalled();
    expect(resolver.open).toBe(false);
  });
});

// Pull-with-strategy: fetch + upstream lookup orchestrated in front of
// startMerge/startRebase (see the module doc's "pullMerge"/"pullRebase" note
// and resolver.svelte.ts's pullWithStrategy). Backend calls mocked below are
// currentUpstream (Result<string|null,string>) and fetch (RemoteResult) —
// mergeStart/rebaseStart are the SAME mocks startMerge/startRebase already
// exercise above, so a "clean"/"conflict" outcome here reuses those code
// paths verbatim.
describe("pullMerge", () => {
  it("happy path: upstream found, fetch succeeds, mergeStart clean -> graph reload, modal stays closed", async () => {
    vi.mocked(commands.currentUpstream).mockResolvedValueOnce(ok("origin/main"));
    vi.mocked(commands.fetch).mockResolvedValueOnce(remoteResult({ ok: true, message: "Fetched origin." }));
    vi.mocked(commands.mergeStart).mockResolvedValueOnce(mergeResult({ state: "clean", message: "Merged." }));

    await resolver.pullMerge("repo1");

    expect(commands.currentUpstream).toHaveBeenCalledWith("repo1");
    expect(commands.fetch).toHaveBeenCalledWith("repo1", null);
    // Regression check (backlog #7): pullMerge -> pullWithStrategy ->
    // startMerge still never passes a strategy of its own — see the note on
    // the "startMerge" describe block above.
    expect(commands.mergeStart).toHaveBeenCalledWith("repo1", "origin/main", null);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(resolver.open).toBe(false);
    expect(resolver.busy).toBe(false);
  });

  it("conflict result: opens the Resolver with op set to merge, populated from conflict_status", async () => {
    vi.mocked(commands.currentUpstream).mockResolvedValueOnce(ok("origin/main"));
    vi.mocked(commands.fetch).mockResolvedValueOnce(remoteResult({ ok: true }));
    vi.mocked(commands.mergeStart).mockResolvedValueOnce(
      mergeResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts", "b.ts"], backupRef: "refs/gitgui/backup/pm1" }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_A, FILE_B], true, "merge")));

    await resolver.pullMerge("repo1");

    expect(resolver.open).toBe(true);
    expect(resolver.busy).toBe(false);
    expect(resolver.op).toBe("merge");
    expect(resolver.files).toEqual([FILE_A, FILE_B]);
    expect(resolver.backupRef).toBe("refs/gitgui/backup/pm1");
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
  });

  it("fetch failure aborts before merge is attempted", async () => {
    vi.mocked(commands.currentUpstream).mockResolvedValueOnce(ok("origin/main"));
    vi.mocked(commands.fetch).mockResolvedValueOnce(remoteResult({ ok: false, message: "Could not resolve host." }));

    await resolver.pullMerge("repo1");

    expect(commands.fetch).toHaveBeenCalledWith("repo1", null);
    expect(commands.mergeStart).not.toHaveBeenCalled();
    expect(bridge.tama.warn).toHaveBeenCalledWith("Could not resolve host.");
    expect(resolver.open).toBe(false);
    expect(resolver.busy).toBe(false);
  });

  it("no upstream configured: warns and never calls fetch or mergeStart", async () => {
    vi.mocked(commands.currentUpstream).mockResolvedValueOnce(ok(null));

    await resolver.pullMerge("repo1");

    expect(commands.currentUpstream).toHaveBeenCalledWith("repo1");
    expect(commands.fetch).not.toHaveBeenCalled();
    expect(commands.mergeStart).not.toHaveBeenCalled();
    expect(bridge.tama.warn).toHaveBeenCalledWith("This branch has no upstream to pull from.");
    expect(resolver.busy).toBe(false);
  });

  it("currentUpstream itself erroring warns and never calls fetch or mergeStart", async () => {
    vi.mocked(commands.currentUpstream).mockResolvedValueOnce(err("Cannot open repository: not found"));

    await resolver.pullMerge("repo1");

    expect(commands.fetch).not.toHaveBeenCalled();
    expect(commands.mergeStart).not.toHaveBeenCalled();
    expect(bridge.tama.warn).toHaveBeenCalledWith("Cannot open repository: not found");
    expect(resolver.busy).toBe(false);
  });

  it("warns via Tama instead of doing anything without a repo", async () => {
    await resolver.pullMerge("");
    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(commands.currentUpstream).not.toHaveBeenCalled();
    expect(resolver.busy).toBe(false);
  });

  it("re-entrancy: a call while already busy is a no-op", async () => {
    resolver.busy = true;
    await resolver.pullMerge("repo1");
    expect(commands.currentUpstream).not.toHaveBeenCalled();
  });
});

describe("pullRebase", () => {
  it("happy path: upstream found, fetch succeeds, rebaseStart clean -> graph reload, modal stays closed", async () => {
    vi.mocked(commands.currentUpstream).mockResolvedValueOnce(ok("origin/main"));
    vi.mocked(commands.fetch).mockResolvedValueOnce(remoteResult({ ok: true, message: "Fetched origin." }));
    vi.mocked(commands.rebaseStart).mockResolvedValueOnce(rebaseResult({ state: "clean", message: "Rebased." }));

    await resolver.pullRebase("repo1");

    expect(commands.currentUpstream).toHaveBeenCalledWith("repo1");
    expect(commands.fetch).toHaveBeenCalledWith("repo1", null);
    expect(commands.rebaseStart).toHaveBeenCalledWith("repo1", "origin/main");
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(resolver.open).toBe(false);
    expect(resolver.busy).toBe(false);
  });

  it("conflict result: opens the Resolver with op set to rebase, populated from conflict_status", async () => {
    vi.mocked(commands.currentUpstream).mockResolvedValueOnce(ok("origin/main"));
    vi.mocked(commands.fetch).mockResolvedValueOnce(remoteResult({ ok: true }));
    vi.mocked(commands.rebaseStart).mockResolvedValueOnce(
      rebaseResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"], backupRef: "refs/gitgui/backup/pr1" }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_A], true, "rebase")));

    await resolver.pullRebase("repo1");

    expect(resolver.open).toBe(true);
    expect(resolver.busy).toBe(false);
    expect(resolver.op).toBe("rebase");
    expect(resolver.files).toEqual([FILE_A]);
    expect(resolver.backupRef).toBe("refs/gitgui/backup/pr1");
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
  });

  it("fetch failure aborts before rebase is attempted", async () => {
    vi.mocked(commands.currentUpstream).mockResolvedValueOnce(ok("origin/main"));
    vi.mocked(commands.fetch).mockResolvedValueOnce(remoteResult({ ok: false, message: "Connection timed out." }));

    await resolver.pullRebase("repo1");

    expect(commands.fetch).toHaveBeenCalledWith("repo1", null);
    expect(commands.rebaseStart).not.toHaveBeenCalled();
    expect(bridge.tama.warn).toHaveBeenCalledWith("Connection timed out.");
    expect(resolver.open).toBe(false);
    expect(resolver.busy).toBe(false);
  });

  it("no upstream configured: warns and never calls fetch or rebaseStart", async () => {
    vi.mocked(commands.currentUpstream).mockResolvedValueOnce(ok(null));

    await resolver.pullRebase("repo1");

    expect(commands.fetch).not.toHaveBeenCalled();
    expect(commands.rebaseStart).not.toHaveBeenCalled();
    expect(bridge.tama.warn).toHaveBeenCalledWith("This branch has no upstream to pull from.");
    expect(resolver.busy).toBe(false);
  });

  it("warns via Tama instead of doing anything without a repo", async () => {
    await resolver.pullRebase("");
    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(commands.currentUpstream).not.toHaveBeenCalled();
    expect(resolver.busy).toBe(false);
  });
});

describe("startRevert", () => {
  it("clean result: reloads the graph and closes the modal", async () => {
    vi.mocked(commands.revertStart).mockResolvedValueOnce(
      revertResult({ state: "clean", message: "Reverted." }),
    );

    await resolver.startRevert("repo1", "sha1", true);

    expect(commands.revertStart).toHaveBeenCalledWith("repo1", "sha1", true);
    expect(commands.mergeStart).not.toHaveBeenCalled();
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(resolver.open).toBe(false);
    expect(resolver.busy).toBe(false);
  });

  it("defaults signoff to false when omitted", async () => {
    vi.mocked(commands.revertStart).mockResolvedValueOnce(revertResult({ state: "clean" }));

    await resolver.startRevert("repo1", "sha1");

    expect(commands.revertStart).toHaveBeenCalledWith("repo1", "sha1", false);
  });

  it("conflict result: opens the modal, sets op to revert, and populates files from conflict_status", async () => {
    vi.mocked(commands.revertStart).mockResolvedValueOnce(
      revertResult({
        ok: false,
        state: "conflict",
        conflictedFiles: ["a.ts", "b.ts"],
        backupRef: "refs/gitgui/backup/rv1",
      }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(
      ok(conflictStatus([FILE_A, FILE_B], true, "revert")),
    );

    await resolver.startRevert("repo1", "sha7", false);

    expect(resolver.open).toBe(true);
    expect(resolver.busy).toBe(false);
    expect(resolver.op).toBe("revert");
    expect(resolver.files).toEqual([FILE_A, FILE_B]);
    expect(resolver.remaining.size).toBe(2);
    expect(resolver.backupRef).toBe("refs/gitgui/backup/rv1");
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
  });

  it("warns via Tama instead of opening the modal without a repo", async () => {
    await resolver.startRevert("", "sha");
    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(commands.revertStart).not.toHaveBeenCalled();
    expect(resolver.open).toBe(false);
  });
});

// Backlog: dirty-tree/index block chooser (mirrors sidebar.svelte.ts's own
// stashSwitchReapply/stashSwitchLeaveStashed tests above). `triggerDirtyBlock`
// drives the chooser open through a REAL startPick call (rather than poking
// `resolver.dirtyBlock` directly) so `.retry` closes over the real repo/sha
// args, exactly like production use.
describe("dirtyBlock (stash-and-retry chooser)", () => {
  async function triggerDirtyBlock() {
    vi.mocked(commands.cherryPick).mockResolvedValueOnce(
      pickResult({ ok: false, state: "error", message: "would be overwritten by merge", blockedByLocalChanges: true }),
    );
    await resolver.startPick("repo1", "sha9", true);
    expect(resolver.dirtyBlock).not.toBeNull();
  }

  it("cancelDirtyBlock clears the chooser without stashing anything", async () => {
    await triggerDirtyBlock();
    resolver.cancelDirtyBlock();
    expect(resolver.dirtyBlock).toBeNull();
    expect(commands.stashSave).not.toHaveBeenCalled();
  });

  it("is re-entrancy locked while busy", async () => {
    await triggerDirtyBlock();
    resolver.busy = true;
    await resolver.stashAndRetryDirtyBlock();
    expect(commands.stashSave).not.toHaveBeenCalled();
  });

  it("design mode is a cosmetic no-op with a toast", async () => {
    resolver.demo = true;
    resolver.dirtyBlock = { message: "blocked", verb: "Cherry-pick", retry: vi.fn() };
    await resolver.stashAndRetryDirtyBlock();
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("demo"));
    expect(commands.stashSave).not.toHaveBeenCalled();
    expect(resolver.dirtyBlock).toBeNull();
  });

  it("stashes everything, retries the SAME start call, and never reapplies", async () => {
    await triggerDirtyBlock();
    vi.mocked(commands.stashSave).mockResolvedValueOnce(workdirResult({ ok: true, message: "stashed" }));
    vi.mocked(commands.cherryPick).mockResolvedValueOnce(pickResult({ state: "clean", message: "Cherry-picked." }));

    await resolver.stashAndRetryDirtyBlock();

    expect(commands.stashSave).toHaveBeenCalledWith("repo1", expect.stringContaining("cherry-pick"), true);
    expect(commands.cherryPick).toHaveBeenLastCalledWith("repo1", "sha9", true);
    expect(commands.stashPop).not.toHaveBeenCalled();
    expect(resolver.dirtyBlock).toBeNull();
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(resolver.busy).toBe(false);
  });

  it("does not stash or retry when stash_save itself fails for a real reason", async () => {
    await triggerDirtyBlock();
    vi.mocked(commands.stashSave).mockResolvedValueOnce(workdirResult({ ok: false, message: "some other stash failure" }));

    await resolver.stashAndRetryDirtyBlock();

    expect(commands.cherryPick).toHaveBeenCalledTimes(1); // only triggerDirtyBlock's original call — never retried
    // Shown INLINE (dirtyBlockStuck), not via a bridge.tama.warn toast — see
    // that field's own doc comment: a toast in the sidebar's Tama nook is
    // invisible while this modal's scrim sits on top of it.
    expect(resolver.dirtyBlockStuck).toContain("some other stash failure");
    expect(resolver.dirtyBlock).not.toBeNull(); // chooser stays open
    expect(resolver.busy).toBe(false);
  });

  // Regression test: stash_save's own pre-flight check ("Nothing to stash —
  // the working tree is clean.") can fire even though the op that opened
  // this chooser just refused — e.g. the block is caused by something
  // outside plain `git status`'s view (a modified submodule pointer), or the
  // tree simply changed again in between. The old behavior dead-ended here
  // with a discouraging toast and never retried at all; it must now retry
  // directly instead, since there's nothing to reapply either way.
  it("retries directly (no stash, no reapply) when stash_save finds nothing to stash", async () => {
    await triggerDirtyBlock();
    vi.mocked(commands.stashSave).mockResolvedValueOnce(
      workdirResult({ ok: false, message: "Nothing to stash — the working tree is clean." }),
    );
    vi.mocked(commands.cherryPick).mockResolvedValueOnce(pickResult({ state: "clean", message: "Cherry-picked." }));

    await resolver.stashAndRetryDirtyBlockReapply();

    expect(commands.cherryPick).toHaveBeenLastCalledWith("repo1", "sha9", true);
    expect(commands.stashList).not.toHaveBeenCalled();
    expect(commands.stashPop).not.toHaveBeenCalled();
    expect(bridge.tama.warn).not.toHaveBeenCalled();
    expect(resolver.dirtyBlock).toBeNull();
    expect(resolver.busy).toBe(false);
  });

  it("reapply mode: pops the freshly-created stash back after a clean retry, using its own sha", async () => {
    await triggerDirtyBlock();
    vi.mocked(commands.stashSave).mockResolvedValueOnce(workdirResult({ ok: true, message: "stashed" }));
    vi.mocked(commands.cherryPick).mockResolvedValueOnce(pickResult({ state: "clean", message: "Cherry-picked." }));
    vi.mocked(commands.stashList).mockResolvedValueOnce(ok([{ index: 0, sha: "abc1234", branch: null, message: "auto" }]));
    vi.mocked(commands.stashPop).mockResolvedValueOnce(workdirResult({ ok: true, message: "popped" }));

    await resolver.stashAndRetryDirtyBlockReapply();

    expect(commands.stashPop).toHaveBeenCalledWith("repo1", 0, "abc1234");
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });

  it("a reapply conflict routes to the SAME shared Resolver stash-conflict flow, not a new one", async () => {
    await triggerDirtyBlock();
    vi.mocked(commands.stashSave).mockResolvedValueOnce(workdirResult({ ok: true, message: "stashed" }));
    vi.mocked(commands.cherryPick).mockResolvedValueOnce(pickResult({ state: "clean", message: "Cherry-picked." }));
    vi.mocked(commands.stashList).mockResolvedValueOnce(ok([{ index: 0, sha: "abc1234", branch: null, message: "auto" }]));
    const conflictRes = workdirResult({ ok: false, message: "conflict", conflictedFiles: ["a.txt"], backupRef: "refs/gitgui/backup/1" });
    vi.mocked(commands.stashPop).mockResolvedValueOnce(conflictRes);
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_A], true, "stash")));

    await resolver.stashAndRetryDirtyBlockReapply();

    expect(resolver.open).toBe(true);
    expect(resolver.op).toBe("stash");
  });

  it("if the retry lands on a real conflict, the stash is left alone — no auto-reapply attempted", async () => {
    await triggerDirtyBlock();
    vi.mocked(commands.stashSave).mockResolvedValueOnce(workdirResult({ ok: true, message: "stashed" }));
    vi.mocked(commands.cherryPick).mockResolvedValueOnce(
      pickResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"], backupRef: "refs/gitgui/backup/9" }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_A])));

    await resolver.stashAndRetryDirtyBlockReapply();

    expect(resolver.open).toBe(true);
    expect(commands.stashList).not.toHaveBeenCalled();
    expect(commands.stashPop).not.toHaveBeenCalled();
  });

  it("if the retry hits ANOTHER dirty-tree block, the stash is left alone and the new chooser opens", async () => {
    await triggerDirtyBlock();
    vi.mocked(commands.stashSave).mockResolvedValueOnce(workdirResult({ ok: true, message: "stashed" }));
    vi.mocked(commands.cherryPick).mockResolvedValueOnce(
      pickResult({ ok: false, state: "error", message: "still blocked", blockedByLocalChanges: true }),
    );

    await resolver.stashAndRetryDirtyBlockReapply();

    expect(resolver.dirtyBlock).not.toBeNull();
    expect(resolver.dirtyBlock?.message).toBe("still blocked");
    expect(commands.stashList).not.toHaveBeenCalled();
    expect(commands.stashPop).not.toHaveBeenCalled();
  });

  // Regression test: a path staged as an embedded git repository (a
  // submodule directory added without a matching .gitmodules entry) blocks
  // cherry-pick/merge/rebase/revert exactly like any other dirty-tree
  // collision, but `git stash push -u` — empirically verified against a
  // repo built to reproduce this exact shape — reports SUCCESS (or "nothing
  // to stash") without touching it at all, so retrying used to hit the
  // identical refusal every time with no explanation. This must be caught
  // BEFORE retrying, not after.
  it("does not retry when stash reports success but workdir_status shows something is still stuck", async () => {
    await triggerDirtyBlock();
    vi.mocked(commands.stashSave).mockResolvedValueOnce(workdirResult({ ok: true, message: "stashed" }));
    vi.mocked(commands.workdirStatus).mockResolvedValueOnce(
      ok({ staged: [{ path: "vendor/widget-lib", oldPath: null, status: "A" }], unstaged: [], conflicted: 0, branch: "main", hasStash: true }),
    );

    await resolver.stashAndRetryDirtyBlock();

    expect(commands.cherryPick).toHaveBeenCalledTimes(1); // only triggerDirtyBlock's original call — never retried
    expect(resolver.dirtyBlockStuck).toContain("vendor/widget-lib");
    expect(resolver.dirtyBlock).not.toBeNull(); // chooser stays open — nothing was resolved
    expect(resolver.busy).toBe(false);
  });

  it("does not retry when stash reports nothing-to-stash but workdir_status shows something is still stuck", async () => {
    await triggerDirtyBlock();
    vi.mocked(commands.stashSave).mockResolvedValueOnce(
      workdirResult({ ok: false, message: "Nothing to stash — the working tree is clean." }),
    );
    vi.mocked(commands.workdirStatus).mockResolvedValueOnce(
      ok({ staged: [{ path: "vendor/widget-lib", oldPath: null, status: "A" }], unstaged: [], conflicted: 0, branch: "main", hasStash: false }),
    );

    await resolver.stashAndRetryDirtyBlock();

    expect(commands.cherryPick).toHaveBeenCalledTimes(1);
    expect(resolver.dirtyBlockStuck).toContain("vendor/widget-lib");
    expect(resolver.dirtyBlock).not.toBeNull();
  });
});

describe("op-dispatch (abort/continue resolve to the op reported by conflict_status)", () => {
  it("a merge conflict's abort calls mergeAbort, never cherryPickAbort", async () => {
    vi.mocked(commands.mergeStart).mockResolvedValueOnce(
      mergeResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"] }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(
      ok(conflictStatus([FILE_A], true, "merge")),
    );
    await resolver.startMerge("repo1", "sha4");
    expect(resolver.op).toBe("merge");

    vi.mocked(commands.mergeAbort).mockResolvedValueOnce(
      mergeResult({ state: "clean", message: "Merge aborted." }),
    );

    await resolver.abort();

    expect(commands.mergeAbort).toHaveBeenCalledWith("repo1");
    expect(commands.cherryPickAbort).not.toHaveBeenCalled();
    expect(resolver.open).toBe(false);
  });

  it("a merge conflict's continue calls mergeContinue, never cherryPickContinue", async () => {
    vi.mocked(commands.mergeStart).mockResolvedValueOnce(
      mergeResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"] }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(
      ok(conflictStatus([FILE_A], true, "merge")),
    );
    await resolver.startMerge("repo1", "sha5");

    vi.mocked(commands.mergeContinue).mockResolvedValueOnce(
      mergeResult({ state: "clean", message: "Merge committed." }),
    );

    await resolver.continue();

    expect(commands.mergeContinue).toHaveBeenCalledWith("repo1");
    expect(commands.cherryPickContinue).not.toHaveBeenCalled();
    expect(resolver.open).toBe(false);
  });

  it("a cherry-pick conflict's abort still calls cherryPickAbort, never mergeAbort (regression)", async () => {
    vi.mocked(commands.cherryPick).mockResolvedValueOnce(
      pickResult({ state: "conflict", conflictedFiles: ["a.ts"], backupRef: "refs/gitgui/backup/y" }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_A])));
    await resolver.startPick("repo1", "sha6", false);
    expect(resolver.op).toBe("cherry-pick");

    vi.mocked(commands.cherryPickAbort).mockResolvedValueOnce(
      pickResult({ state: "clean", message: "Pick aborted." }),
    );

    await resolver.abort();

    expect(commands.cherryPickAbort).toHaveBeenCalledWith("repo1");
    expect(commands.mergeAbort).not.toHaveBeenCalled();
  });

  it("a rebase conflict's abort calls rebaseAbort, never mergeAbort/cherryPickAbort", async () => {
    vi.mocked(commands.rebaseStart).mockResolvedValueOnce(
      rebaseResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"] }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(
      ok(conflictStatus([FILE_A], true, "rebase")),
    );
    await resolver.startRebase("repo1", "main");
    expect(resolver.op).toBe("rebase");

    vi.mocked(commands.rebaseAbort).mockResolvedValueOnce(
      rebaseResult({ state: "clean", message: "Rebase aborted." }),
    );

    await resolver.abort();

    expect(commands.rebaseAbort).toHaveBeenCalledWith("repo1");
    expect(commands.mergeAbort).not.toHaveBeenCalled();
    expect(commands.cherryPickAbort).not.toHaveBeenCalled();
    expect(resolver.open).toBe(false);
  });

  it("a rebase conflict's continue calls rebaseContinue, never mergeContinue/cherryPickContinue", async () => {
    vi.mocked(commands.rebaseStart).mockResolvedValueOnce(
      rebaseResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"] }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(
      ok(conflictStatus([FILE_A], true, "rebase")),
    );
    await resolver.startRebase("repo1", "main");

    vi.mocked(commands.rebaseContinue).mockResolvedValueOnce(
      rebaseResult({ state: "clean", message: "Rebase complete." }),
    );

    await resolver.continue();

    expect(commands.rebaseContinue).toHaveBeenCalledWith("repo1");
    expect(commands.mergeContinue).not.toHaveBeenCalled();
    expect(commands.cherryPickContinue).not.toHaveBeenCalled();
    expect(resolver.open).toBe(false);
  });

  it("continuing a rebase past one conflict into a SECOND conflict keeps the modal open with the new file list", async () => {
    vi.mocked(commands.rebaseStart).mockResolvedValueOnce(
      rebaseResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"] }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(
      ok(conflictStatus([FILE_A], true, "rebase")),
    );
    await resolver.startRebase("repo1", "main");

    // rebase_continue's own state-inspection classifies landing on the next
    // conflicting commit as "conflict" again (see git_rebase.rs) — the
    // resolver's existing generic conflict handling in continue() must react
    // identically to this as it does to cherry-pick/merge conflicts.
    vi.mocked(commands.rebaseContinue).mockResolvedValueOnce(
      rebaseResult({ ok: false, state: "conflict", conflictedFiles: ["b.ts"] }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(
      ok(conflictStatus([FILE_B], true, "rebase")),
    );

    await resolver.continue();

    expect(resolver.open).toBe(true);
    expect(resolver.op).toBe("rebase");
    expect(resolver.files.map((f) => f.path)).toEqual(["b.ts"]);
    expect(bridge.tama.warn).toHaveBeenCalled();
  });

  it("a revert conflict's abort calls revertAbort, never mergeAbort/cherryPickAbort/rebaseAbort", async () => {
    vi.mocked(commands.revertStart).mockResolvedValueOnce(
      revertResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"] }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(
      ok(conflictStatus([FILE_A], true, "revert")),
    );
    await resolver.startRevert("repo1", "sha8", false);
    expect(resolver.op).toBe("revert");

    vi.mocked(commands.revertAbort).mockResolvedValueOnce(
      revertResult({ state: "clean", message: "Revert aborted." }),
    );

    await resolver.abort();

    expect(commands.revertAbort).toHaveBeenCalledWith("repo1");
    expect(commands.mergeAbort).not.toHaveBeenCalled();
    expect(commands.cherryPickAbort).not.toHaveBeenCalled();
    expect(commands.rebaseAbort).not.toHaveBeenCalled();
    expect(resolver.open).toBe(false);
  });

  it("a revert conflict's continue calls revertContinue, never mergeContinue/cherryPickContinue/rebaseContinue", async () => {
    vi.mocked(commands.revertStart).mockResolvedValueOnce(
      revertResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"] }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(
      ok(conflictStatus([FILE_A], true, "revert")),
    );
    await resolver.startRevert("repo1", "sha9", false);

    vi.mocked(commands.revertContinue).mockResolvedValueOnce(
      revertResult({ state: "clean", message: "Revert committed." }),
    );

    await resolver.continue();

    expect(commands.revertContinue).toHaveBeenCalledWith("repo1");
    expect(commands.mergeContinue).not.toHaveBeenCalled();
    expect(commands.cherryPickContinue).not.toHaveBeenCalled();
    expect(commands.rebaseContinue).not.toHaveBeenCalled();
    expect(resolver.open).toBe(false);
  });

  it("re-derives op from a live conflict_status refresh (self-describing across take())", async () => {
    // Started as a cherry-pick optimistically, but the live repo state (as
    // conflict_status reports it) says merge — refresh() must correct .op.
    resolver.repo = "repo1";
    resolver.demo = false;
    resolver.op = "cherry-pick";
    resolver.files = [FILE_A];
    resolver.selected = FILE_A.path;
    resolver.remaining = new Set([FILE_A.path]);

    vi.mocked(commands.resolveConflictFile).mockResolvedValueOnce({
      ok: true,
      remaining: 0,
      message: "",
    } satisfies ResolveResult);
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([], true, "merge")));

    await resolver.take("theirs");

    expect(resolver.op).toBe("merge");
  });

  it("refresh() re-derives op as revert from a live conflict_status report", async () => {
    // Started as a cherry-pick optimistically, but the live repo state (as
    // conflict_status reports it) says revert — refresh() must correct .op.
    resolver.repo = "repo1";
    resolver.demo = false;
    resolver.op = "cherry-pick";
    resolver.files = [FILE_A];
    resolver.selected = FILE_A.path;
    resolver.remaining = new Set([FILE_A.path]);

    vi.mocked(commands.resolveConflictFile).mockResolvedValueOnce({
      ok: true,
      remaining: 0,
      message: "",
    } satisfies ResolveResult);
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([], true, "revert")));

    await resolver.take("theirs");

    expect(resolver.op).toBe("revert");
  });
});

describe("take", () => {
  it("resolving the last remaining file empties .remaining and .files", async () => {
    resolver.repo = "repo1";
    resolver.demo = false;
    resolver.files = [FILE_A];
    resolver.selected = FILE_A.path;
    resolver.remaining = new Set([FILE_A.path]);

    vi.mocked(commands.resolveConflictFile).mockResolvedValueOnce({
      ok: true,
      remaining: 0,
      message: "",
    } satisfies ResolveResult);
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([])));

    await resolver.take("theirs");

    expect(commands.resolveConflictFile).toHaveBeenCalledWith("repo1", FILE_A.path, "theirs");
    expect(resolver.remaining.size).toBe(0);
    expect(resolver.files).toHaveLength(0);
    expect(resolver.selected).toBeNull();
  });

  it("demo mode: mutates local state only, no IPC call", () => {
    resolver.openDemo("sha");
    const path = resolver.files[0].path;

    resolver.take("theirs");

    expect(resolver.remaining.has(path)).toBe(false);
    expect(commands.resolveConflictFile).not.toHaveBeenCalled();
    expect(bridge.tama.say).toHaveBeenCalled();
  });
});

describe("resolveWithExternalTool (backlog #12)", () => {
  it("calls the backend for the CURRENT selected file, then re-pulls authoritative conflict state on success", async () => {
    resolver.repo = "repo1";
    resolver.demo = false;
    resolver.files = [FILE_A, FILE_B];
    resolver.selected = FILE_A.path;
    resolver.remaining = new Set([FILE_A.path, FILE_B.path]);

    vi.mocked(commands.resolveConflictWithExternalTool).mockResolvedValueOnce({
      ok: true,
      remaining: 1,
      message: "Resolved a.ts with the external tool. 1 file(s) still conflicted.",
    } satisfies ResolveResult);
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_B])));

    await resolver.resolveWithExternalTool();

    expect(commands.resolveConflictWithExternalTool).toHaveBeenCalledWith("repo1", FILE_A.path);
    // Remaining-conflict state refreshed from the live conflict_status
    // response — FILE_A resolved and dropped, FILE_B still outstanding.
    expect(resolver.files).toEqual([FILE_B]);
    expect(resolver.remaining.has(FILE_A.path)).toBe(false);
    expect(resolver.remaining.has(FILE_B.path)).toBe(true);
    expect(resolver.selected).toBe(FILE_B.path);
  });

  it("resolving the LAST remaining file empties .remaining and .files, same as take()", async () => {
    resolver.repo = "repo1";
    resolver.demo = false;
    resolver.files = [FILE_A];
    resolver.selected = FILE_A.path;
    resolver.remaining = new Set([FILE_A.path]);

    vi.mocked(commands.resolveConflictWithExternalTool).mockResolvedValueOnce({
      ok: true,
      remaining: 0,
      message: "",
    } satisfies ResolveResult);
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([])));

    await resolver.resolveWithExternalTool();

    expect(resolver.remaining.size).toBe(0);
    expect(resolver.files).toHaveLength(0);
    expect(resolver.selected).toBeNull();
  });

  it("a failed resolution (tool exited non-zero) surfaces the backend's message via Tama and still refreshes", async () => {
    resolver.repo = "repo1";
    resolver.demo = false;
    resolver.files = [FILE_A];
    resolver.selected = FILE_A.path;
    resolver.remaining = new Set([FILE_A.path]);

    vi.mocked(commands.resolveConflictWithExternalTool).mockResolvedValueOnce({
      ok: false,
      remaining: 1,
      message: "The external tool did not report a successful resolution for a.ts.",
    } satisfies ResolveResult);
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_A])));

    await resolver.resolveWithExternalTool();

    expect(bridge.tama.warn).toHaveBeenCalledWith("The external tool did not report a successful resolution for a.ts.");
    expect(resolver.remaining.has(FILE_A.path)).toBe(true);
  });

  it("is a no-op when there is no selected file", async () => {
    resolver.selected = null;

    await resolver.resolveWithExternalTool();

    expect(commands.resolveConflictWithExternalTool).not.toHaveBeenCalled();
  });

  it("re-entrancy guard: a resolution already in flight ignores a second call", async () => {
    resolver.repo = "repo1";
    resolver.demo = false;
    resolver.files = [FILE_A];
    resolver.selected = FILE_A.path;
    resolver.remaining = new Set([FILE_A.path]);
    resolver.busy = true;

    await resolver.resolveWithExternalTool();

    expect(commands.resolveConflictWithExternalTool).not.toHaveBeenCalled();
  });

  it("demo mode: mutates local state only, no IPC call", () => {
    resolver.openDemo("sha");
    const path = resolver.files[0].path;

    resolver.resolveWithExternalTool();

    expect(resolver.remaining.has(path)).toBe(false);
    expect(commands.resolveConflictWithExternalTool).not.toHaveBeenCalled();
    expect(bridge.tama.say).toHaveBeenCalled();
  });
});

describe("in-app hunk-level resolution editor", () => {
  function fileHunks(partial: Partial<ConflictFileHunks> = {}): ConflictFileHunks {
    return { path: FILE_A.path, binary: false, hunks: [], ...partial };
  }

  describe("openEditMode", () => {
    it("fetches hunks for the current file and enters edit mode, seeding conflict hunks from ours", async () => {
      resolver.repo = "repo1";
      resolver.demo = false;
      resolver.files = [FILE_A];
      resolver.selected = FILE_A.path;
      resolver.remaining = new Set([FILE_A.path]);
      vi.mocked(commands.conflictFileHunks).mockResolvedValueOnce(
        ok(
          fileHunks({
            hunks: [
              { kind: "context", context: "shared line\n", ours: null, base: null, theirs: null },
              { kind: "conflict", context: null, ours: "ours text\n", base: "base text\n", theirs: "theirs text\n" },
            ],
          }),
        ),
      );

      await resolver.openEditMode();

      expect(commands.conflictFileHunks).toHaveBeenCalledWith("repo1", FILE_A.path);
      expect(resolver.editMode).toBe(true);
      expect(resolver.editBinary).toBe(false);
      expect(resolver.editHunks).toHaveLength(2);
      // context seeds from its own fixed text; the conflict hunk seeds from "ours".
      expect(resolver.editValues).toEqual(["shared line\n", "ours text\n"]);
    });

    it("a binary conflict opens with editBinary=true and no hunks, instead of refusing to open", async () => {
      resolver.repo = "repo1";
      resolver.files = [FILE_A];
      resolver.selected = FILE_A.path;
      resolver.remaining = new Set([FILE_A.path]);
      vi.mocked(commands.conflictFileHunks).mockResolvedValueOnce(ok(fileHunks({ binary: true, hunks: [] })));

      await resolver.openEditMode();

      expect(resolver.editMode).toBe(true);
      expect(resolver.editBinary).toBe(true);
      expect(resolver.editHunks).toHaveLength(0);
    });

    it("a backend error surfaces via Tama and does not enter edit mode", async () => {
      resolver.repo = "repo1";
      resolver.files = [FILE_A];
      resolver.selected = FILE_A.path;
      resolver.remaining = new Set([FILE_A.path]);
      vi.mocked(commands.conflictFileHunks).mockResolvedValueOnce(err("a.ts is not conflicted."));

      await resolver.openEditMode();

      expect(resolver.editMode).toBe(false);
      expect(bridge.tama.warn).toHaveBeenCalledWith("a.ts is not conflicted.");
    });

    it("is a no-op when there is no selected file", async () => {
      resolver.selected = null;

      await resolver.openEditMode();

      expect(commands.conflictFileHunks).not.toHaveBeenCalled();
      expect(resolver.editMode).toBe(false);
    });

    it("demo mode: simulates a single conflict hunk from the canned FAKE data, no IPC call", async () => {
      resolver.openDemo("sha");
      const f = resolver.files[0];

      await resolver.openEditMode();

      expect(commands.conflictFileHunks).not.toHaveBeenCalled();
      expect(resolver.editMode).toBe(true);
      expect(resolver.editBinary).toBe(false);
      expect(resolver.editHunks).toEqual([{ kind: "conflict", context: null, ours: f.ours, base: f.base, theirs: f.theirs }]);
      expect(resolver.editValues).toEqual([f.ours]);
    });

    // ADVERSARIALLY-FOUND FIX: a second, independent guard (on top of
    // select()'s own editLoading refusal) for the case some other future
    // path moves `selected` during the await.
    it("discards a stale fetch result if the selected file changed while it was in flight", async () => {
      resolver.repo = "repo1";
      resolver.files = [FILE_A, FILE_B];
      resolver.selected = FILE_A.path;
      resolver.remaining = new Set([FILE_A.path, FILE_B.path]);
      let resolveFetch!: (v: Awaited<ReturnType<typeof commands.conflictFileHunks>>) => void;
      vi.mocked(commands.conflictFileHunks).mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
      );

      const pending = resolver.openEditMode();
      // Simulate `selected` moving during the await (bypassing select()'s own
      // guard directly, to prove THIS guard is independent of it).
      resolver.selected = FILE_B.path;
      resolveFetch(
        ok(fileHunks({ hunks: [{ kind: "conflict", context: null, ours: "A ours\n", base: "A base\n", theirs: "A theirs\n" }] })),
      );
      await pending;

      expect(resolver.editMode).toBe(false);
      expect(resolver.editHunks).toHaveLength(0);
    });
  });

  describe("useSide / setEditValue / editJoined", () => {
    beforeEach(() => {
      resolver.editHunks = [
        { kind: "context", context: "before\n", ours: null, base: null, theirs: null },
        { kind: "conflict", context: null, ours: "ours text\n", base: "base text\n", theirs: "theirs text\n" },
        { kind: "context", context: "after\n", ours: null, base: null, theirs: null },
      ];
      resolver.editValues = ["before\n", "ours text\n", "after\n"];
    });

    it("useSide quick-fills the conflict hunk's value from the chosen side", () => {
      resolver.useSide(1, "theirs");
      expect(resolver.editValues[1]).toBe("theirs text\n");

      resolver.useSide(1, "ours");
      expect(resolver.editValues[1]).toBe("ours text\n");
    });

    it("useSide is a no-op on a context hunk (nothing to quick-fill)", () => {
      resolver.useSide(0, "theirs");
      expect(resolver.editValues[0]).toBe("before\n");
    });

    it("setEditValue freely overwrites a hunk's value, including after a quick-fill", () => {
      resolver.useSide(1, "theirs");
      resolver.setEditValue(1, "hand-typed final text\n");
      expect(resolver.editValues[1]).toBe("hand-typed final text\n");
    });

    it("editJoined concatenates every hunk's current value in order", () => {
      resolver.useSide(1, "theirs");
      expect(resolver.editJoined).toBe("before\ntheirs text\nafter\n");
    });
  });

  describe("closeEditMode", () => {
    it("clears edit-mode state back to its defaults", () => {
      resolver.editMode = true;
      resolver.editBinary = true;
      resolver.editHunks = [{ kind: "context", context: "x", ours: null, base: null, theirs: null }];
      resolver.editValues = ["x"];

      resolver.closeEditMode();

      expect(resolver.editMode).toBe(false);
      expect(resolver.editBinary).toBe(false);
      expect(resolver.editHunks).toHaveLength(0);
      expect(resolver.editValues).toHaveLength(0);
    });
  });

  describe("select — switching files exits edit mode", () => {
    it("closes edit mode when selecting a DIFFERENT file", () => {
      resolver.files = [FILE_A, FILE_B];
      resolver.selected = FILE_A.path;
      resolver.editMode = true;
      resolver.editHunks = [{ kind: "context", context: "x", ours: null, base: null, theirs: null }];

      resolver.select(FILE_B.path);

      expect(resolver.selected).toBe(FILE_B.path);
      expect(resolver.editMode).toBe(false);
      expect(resolver.editHunks).toHaveLength(0);
    });

    it("re-selecting the SAME file leaves edit mode untouched", () => {
      resolver.files = [FILE_A];
      resolver.selected = FILE_A.path;
      resolver.editMode = true;
      resolver.editHunks = [{ kind: "context", context: "x", ours: null, base: null, theirs: null }];

      resolver.select(FILE_A.path);

      expect(resolver.editMode).toBe(true);
      expect(resolver.editHunks).toHaveLength(1);
    });

    // ADVERSARIALLY-FOUND FIX: switching files while a hunk fetch is in
    // flight used to leave the OLD file's fetch result landing against
    // whichever file the user had switched to by then.
    it("refuses to switch files while a hunk fetch is in flight (editLoading)", () => {
      resolver.files = [FILE_A, FILE_B];
      resolver.selected = FILE_A.path;
      resolver.editLoading = true;

      resolver.select(FILE_B.path);

      expect(resolver.selected).toBe(FILE_A.path); // unchanged — the switch was refused
    });

    it("switching files works normally again once editLoading clears", () => {
      resolver.files = [FILE_A, FILE_B];
      resolver.selected = FILE_A.path;
      resolver.editLoading = false;

      resolver.select(FILE_B.path);

      expect(resolver.selected).toBe(FILE_B.path);
    });
  });

  describe("saveEditResolution", () => {
    it("saves the joined text, exits edit mode, and re-pulls authoritative conflict state on success", async () => {
      resolver.repo = "repo1";
      resolver.demo = false;
      resolver.files = [FILE_A, FILE_B];
      resolver.selected = FILE_A.path;
      resolver.remaining = new Set([FILE_A.path, FILE_B.path]);
      resolver.editMode = true;
      resolver.editHunks = [{ kind: "conflict", context: null, ours: "ours\n", base: "base\n", theirs: "theirs\n" }];
      resolver.editValues = ["hand-resolved\n"];

      vi.mocked(commands.resolveConflictHunks).mockResolvedValueOnce({
        ok: true,
        remaining: 1,
        message: "Saved.",
      } satisfies ResolveResult);
      vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_B])));

      await resolver.saveEditResolution();

      expect(commands.resolveConflictHunks).toHaveBeenCalledWith("repo1", FILE_A.path, "hand-resolved\n");
      expect(resolver.editMode).toBe(false);
      expect(resolver.files).toEqual([FILE_B]);
      expect(resolver.remaining.has(FILE_A.path)).toBe(false);
    });

    it("a backend failure surfaces via Tama and LEAVES edit mode open so the user doesn't lose their draft", async () => {
      resolver.repo = "repo1";
      resolver.demo = false;
      resolver.files = [FILE_A];
      resolver.selected = FILE_A.path;
      resolver.remaining = new Set([FILE_A.path]);
      resolver.editMode = true;
      resolver.editValues = ["hand-resolved\n"];

      vi.mocked(commands.resolveConflictHunks).mockResolvedValueOnce({
        ok: false,
        remaining: 1,
        message: "cannot write a.ts: permission denied",
      } satisfies ResolveResult);
      vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_A])));

      await resolver.saveEditResolution();

      expect(bridge.tama.warn).toHaveBeenCalledWith("cannot write a.ts: permission denied");
      expect(resolver.editMode).toBe(true);
      expect(resolver.editValues).toEqual(["hand-resolved\n"]);
    });

    it("is a no-op when there is no selected file", async () => {
      resolver.selected = null;

      await resolver.saveEditResolution();

      expect(commands.resolveConflictHunks).not.toHaveBeenCalled();
    });

    it("re-entrancy guard: a save already in flight ignores a second call", async () => {
      resolver.repo = "repo1";
      resolver.demo = false;
      resolver.files = [FILE_A];
      resolver.selected = FILE_A.path;
      resolver.remaining = new Set([FILE_A.path]);
      resolver.busy = true;

      await resolver.saveEditResolution();

      expect(commands.resolveConflictHunks).not.toHaveBeenCalled();
    });

    it("demo mode: mutates local state only, no IPC call", () => {
      resolver.openDemo("sha");
      const path = resolver.files[0].path;
      resolver.editMode = true;

      resolver.saveEditResolution();

      expect(resolver.remaining.has(path)).toBe(false);
      expect(resolver.editMode).toBe(false);
      expect(commands.resolveConflictHunks).not.toHaveBeenCalled();
      expect(bridge.tama.say).toHaveBeenCalled();
    });
  });
});

describe("abort", () => {
  it("success (clean) closes the modal and reloads the graph", async () => {
    resolver.open = true;
    resolver.repo = "repo1";
    vi.mocked(commands.cherryPickAbort).mockResolvedValueOnce(
      pickResult({ state: "clean", message: "Pick aborted." }),
    );

    await resolver.abort();

    expect(resolver.open).toBe(false);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
  });

  it("failure keeps the modal open — never strand a live pick", async () => {
    resolver.open = true;
    resolver.repo = "repo1";
    vi.mocked(commands.cherryPickAbort).mockResolvedValueOnce(
      pickResult({ ok: false, state: "error", message: "abort failed" }),
    );

    await resolver.abort();

    expect(resolver.open).toBe(true);
    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
  });

  it("demo mode: closes without any IPC call", async () => {
    resolver.openDemo("sha");

    await resolver.abort();

    expect(resolver.open).toBe(false);
    expect(commands.cherryPickAbort).not.toHaveBeenCalled();
    expect(bridge.tama.say).toHaveBeenCalled();
  });
});

describe("continue", () => {
  it("state 'conflict' keeps it open and refreshes the file list", async () => {
    resolver.open = true;
    resolver.repo = "repo1";
    resolver.sha = "sha1";
    vi.mocked(commands.cherryPickContinue).mockResolvedValueOnce(
      pickResult({ state: "conflict", conflictedFiles: ["c.ts"] }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(
      ok(conflictStatus([{ path: "c.ts", ours: "", base: "", theirs: "" }])),
    );

    await resolver.continue();

    expect(resolver.open).toBe(true);
    expect(resolver.files.map((f) => f.path)).toEqual(["c.ts"]);
    expect(bridge.tama.warn).toHaveBeenCalled();
  });

  it("state 'clean' closes the modal", async () => {
    resolver.open = true;
    resolver.repo = "repo1";
    resolver.sha = "sha1";
    vi.mocked(commands.cherryPickContinue).mockResolvedValueOnce(
      pickResult({ state: "clean", message: "Committed." }),
    );

    await resolver.continue();

    expect(resolver.open).toBe(false);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
  });

  it("demo mode: closes without any IPC call and cheers", async () => {
    resolver.openDemo("sha");

    await resolver.continue();

    expect(resolver.open).toBe(false);
    expect(commands.cherryPickContinue).not.toHaveBeenCalled();
    expect(bridge.cheer).toHaveBeenCalled();
  });
});

describe("queueContinue hook (multimergeCtrl's sequential-mode advance)", () => {
  it("openFromResult stores the onQueueContinue callback for a conflict result", async () => {
    const cb = vi.fn();
    const res = mergeResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"] });
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_A], true, "merge")));

    await resolver.openFromResult("repo1", res, "sha1", "merge", cb);

    expect(resolver.queueContinue).toBe(cb);
  });

  it("openFromResult ALSO stores the onQueueAbort callback, independent of onQueueContinue", async () => {
    const onContinue = vi.fn();
    const onAbort = vi.fn();
    const res = mergeResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"] });
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_A], true, "merge")));

    await resolver.openFromResult("repo1", res, "sha1", "merge", onContinue, onAbort);

    expect(resolver.queueContinue).toBe(onContinue);
    expect(resolver.queueAbort).toBe(onAbort);
  });

  it("a successful continue() fires the callback exactly once and clears it", async () => {
    const cb = vi.fn();
    resolver.open = true;
    resolver.repo = "repo1";
    resolver.op = "merge";
    resolver.queueContinue = cb;
    vi.mocked(commands.mergeContinue).mockResolvedValueOnce(mergeResult({ state: "clean", message: "Merged." }));

    await resolver.continue();

    expect(cb).toHaveBeenCalledTimes(1);
    expect(resolver.queueContinue).toBeNull();
  });

  it("continue() landing on ANOTHER conflict (still mid-sequence) does NOT fire the callback yet", async () => {
    const cb = vi.fn();
    resolver.open = true;
    resolver.repo = "repo1";
    resolver.op = "rebase"; // the shared "still conflicted" branch is generic across ops
    resolver.queueContinue = cb;
    vi.mocked(commands.rebaseContinue).mockResolvedValueOnce(
      rebaseResult({ ok: false, state: "conflict", conflictedFiles: ["b.ts"] }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_B], true, "rebase")));

    await resolver.continue();

    expect(cb).not.toHaveBeenCalled();
    expect(resolver.queueContinue).toBe(cb); // still pending — this exact conflict hasn't resolved yet
  });

  it("abort() success discards queueContinue WITHOUT firing it — a queue must never silently ADVANCE on abort", async () => {
    const cb = vi.fn();
    resolver.open = true;
    resolver.repo = "repo1";
    resolver.op = "merge";
    resolver.queueContinue = cb;
    vi.mocked(commands.mergeAbort).mockResolvedValueOnce(mergeResult({ state: "clean", message: "Merge aborted." }));

    await resolver.abort();

    expect(cb).not.toHaveBeenCalled();
    expect(resolver.queueContinue).toBeNull();
  });

  it("abort() success FIRES queueAbort exactly once and clears it — the queue's own cleanup hook", async () => {
    const onAbort = vi.fn();
    resolver.open = true;
    resolver.repo = "repo1";
    resolver.op = "merge";
    resolver.queueAbort = onAbort;
    vi.mocked(commands.mergeAbort).mockResolvedValueOnce(mergeResult({ state: "clean", message: "Merge aborted." }));

    await resolver.abort();

    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(resolver.queueAbort).toBeNull();
  });

  it("abort() failure fires neither queueContinue nor queueAbort — never strand a live pick with a fired cleanup", async () => {
    const onContinue = vi.fn();
    const onAbort = vi.fn();
    resolver.open = true;
    resolver.repo = "repo1";
    resolver.op = "merge";
    resolver.queueContinue = onContinue;
    resolver.queueAbort = onAbort;
    vi.mocked(commands.mergeAbort).mockResolvedValueOnce(mergeResult({ ok: false, state: "error", message: "abort failed" }));

    await resolver.abort();

    expect(onContinue).not.toHaveBeenCalled();
    expect(onAbort).not.toHaveBeenCalled();
  });

  it("a fresh openFromResult call with no callbacks clears any stale queueContinue/queueAbort from a prior conflict", async () => {
    resolver.queueContinue = vi.fn();
    resolver.queueAbort = vi.fn();
    const res = mergeResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"] });
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_A], true, "merge")));

    await resolver.openFromResult("repo1", res, "sha1", "merge");

    expect(resolver.queueContinue).toBeNull();
    expect(resolver.queueAbort).toBeNull();
  });
});

describe("skip", () => {
  it("is a no-op when the current op is not rebase (cherry-pick/merge have no skip concept)", async () => {
    resolver.open = true;
    resolver.repo = "repo1";
    resolver.op = "cherry-pick";

    await resolver.skip();

    expect(commands.rebaseSkip).not.toHaveBeenCalled();
    expect(resolver.open).toBe(true);
  });

  it("state 'conflict' (landed on the next conflicting commit) keeps the modal open and refreshes", async () => {
    resolver.open = true;
    resolver.repo = "repo1";
    resolver.op = "rebase";
    vi.mocked(commands.rebaseSkip).mockResolvedValueOnce(
      rebaseResult({ ok: false, state: "conflict", conflictedFiles: ["b.ts"] }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(
      ok(conflictStatus([FILE_B], true, "rebase")),
    );

    await resolver.skip();

    expect(commands.rebaseSkip).toHaveBeenCalledWith("repo1");
    expect(resolver.open).toBe(true);
    expect(resolver.files.map((f) => f.path)).toEqual(["b.ts"]);
    expect(bridge.tama.warn).toHaveBeenCalled();
  });

  it("state 'clean' (skipped commit finished the rebase) closes the modal and reloads the graph", async () => {
    resolver.open = true;
    resolver.repo = "repo1";
    resolver.op = "rebase";
    vi.mocked(commands.rebaseSkip).mockResolvedValueOnce(
      rebaseResult({ state: "clean", message: "Skipped — rebased onto main." }),
    );

    await resolver.skip();

    expect(resolver.open).toBe(false);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
  });

  it("demo mode: closes without any IPC call", async () => {
    resolver.openDemo("sha", "rebase");

    await resolver.skip();

    expect(resolver.open).toBe(false);
    expect(commands.rebaseSkip).not.toHaveBeenCalled();
    expect(bridge.tama.say).toHaveBeenCalled();
  });
});

// Regression coverage for finding #7's frontend half: a stash-apply/pop
// conflict (surfaced by workdirCtrl.applyOrPopStash, NOT one of resolver's
// own startX() entry points — see openStashConflict's own doc comment) must
// route into this SAME shared modal, wired to the real
// stash_conflict_abort/stash_conflict_continue backend commands, instead of
// only ever showing a Tama toast.
describe("openStashConflict (stash-apply/pop conflict, #7)", () => {
  it("opens the modal with op set to stash and populates files from conflict_status", async () => {
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_A], true, "stash")));

    await resolver.openStashConflict(
      "repo1",
      workdirResult({ conflictedFiles: ["a.ts"], backupRef: "refs/gitgui/backup/s1" }),
    );

    expect(resolver.open).toBe(true);
    expect(resolver.op).toBe("stash");
    expect(resolver.files).toEqual([FILE_A]);
    expect(resolver.backupRef).toBe("refs/gitgui/backup/s1");
  });

  it("a stash conflict's abort calls stashConflictAbort, never mergeAbort/cherryPickAbort/rebaseAbort", async () => {
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_A], true, "stash")));
    await resolver.openStashConflict("repo1", workdirResult({ conflictedFiles: ["a.ts"] }));
    expect(resolver.op).toBe("stash");

    vi.mocked(commands.stashConflictAbort).mockResolvedValueOnce(
      stashResolveResult({ state: "clean", message: "Reset back to before the stash was applied." }),
    );

    await resolver.abort();

    expect(commands.stashConflictAbort).toHaveBeenCalledWith("repo1");
    expect(commands.mergeAbort).not.toHaveBeenCalled();
    expect(commands.cherryPickAbort).not.toHaveBeenCalled();
    expect(commands.rebaseAbort).not.toHaveBeenCalled();
    expect(resolver.open).toBe(false);
  });

  it("a stash conflict's continue calls stashConflictContinue, never the other ops' continue commands", async () => {
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_A], true, "stash")));
    await resolver.openStashConflict("repo1", workdirResult({ conflictedFiles: ["a.ts"] }));

    vi.mocked(commands.stashConflictContinue).mockResolvedValueOnce(
      stashResolveResult({ state: "clean", message: "Stash finished." }),
    );

    await resolver.continue();

    expect(commands.stashConflictContinue).toHaveBeenCalledWith("repo1");
    expect(commands.mergeContinue).not.toHaveBeenCalled();
    expect(commands.cherryPickContinue).not.toHaveBeenCalled();
    expect(commands.rebaseContinue).not.toHaveBeenCalled();
    expect(resolver.open).toBe(false);
  });

  it("continue keeps the modal open and refreshes when still conflicted", async () => {
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_A], true, "stash")));
    await resolver.openStashConflict("repo1", workdirResult({ conflictedFiles: ["a.ts"] }));

    vi.mocked(commands.stashConflictContinue).mockResolvedValueOnce(
      stashResolveResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"], message: "still unmerged" }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_A], true, "stash")));

    await resolver.continue();

    expect(resolver.open).toBe(true);
    expect(bridge.tama.warn).toHaveBeenCalled();
  });

  it("refresh() re-derives .op as stash from a live conflict_status report", async () => {
    resolver.repo = "repo1";
    resolver.demo = false;
    resolver.op = "cherry-pick";
    resolver.files = [FILE_A];
    resolver.selected = FILE_A.path;
    resolver.remaining = new Set([FILE_A.path]);

    vi.mocked(commands.resolveConflictFile).mockResolvedValueOnce({ ok: true, remaining: 0, message: "" } satisfies ResolveResult);
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([], true, "stash")));

    await resolver.take("theirs");

    expect(resolver.op).toBe("stash");
  });
});

// Interactive-rebase "editing" state (a `git rebase -i` paused cleanly at an
// `edit` todo line — see git_rebase.rs's classify() and this module's own
// "interactive-rebase editing state" doc note). Distinct from a genuine
// conflict: no file list, no conflict_status round trip, and a different
// affordance (background the modal, hand off to Workdir).
describe("interactive-rebase 'editing' state", () => {
  it("startRebase's applyOutcome routes an 'editing' result into the no-file-list mode, without a conflict_status round trip", async () => {
    vi.mocked(commands.rebaseStart).mockResolvedValueOnce(
      rebaseResult({
        ok: false,
        state: "editing",
        message: "Paused to edit 1111111 — amend it, then Continue.",
        backupRef: "refs/gitgui/backup/e1",
      }),
    );

    await resolver.startRebase("repo1", "main");

    expect(resolver.open).toBe(true);
    expect(resolver.op).toBe("rebase");
    expect(resolver.editing).toBe(true);
    expect(resolver.files).toHaveLength(0);
    expect(resolver.sub).toBe("Paused to edit 1111111 — amend it, then Continue.");
    expect(resolver.backupRef).toBe("refs/gitgui/backup/e1");
    expect(commands.conflictStatus).not.toHaveBeenCalled();
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
  });

  it("title reads distinctly from a genuine conflict while editing", async () => {
    vi.mocked(commands.rebaseStart).mockResolvedValueOnce(rebaseResult({ ok: false, state: "editing" }));
    await resolver.startRebase("repo1", "main");
    expect(resolver.title).toBe("Rebase paused to edit a commit");
  });

  it("openFromResult (the planner's hand-off entry point) routes 'editing' identically to startRebase", async () => {
    const res = rebaseResult({ ok: false, state: "editing", message: "Paused to edit abc1234." });

    await resolver.openFromResult("repo1", res, "main");

    expect(resolver.open).toBe(true);
    expect(resolver.op).toBe("rebase");
    expect(resolver.editing).toBe(true);
    expect(resolver.files).toHaveLength(0);
    expect(resolver.sub).toBe("Paused to edit abc1234.");
    expect(commands.conflictStatus).not.toHaveBeenCalled();
  });

  it("openFromResult also routes a 'conflict' result into the normal file-list mode (planner and linear rebase share ONE conflict UI)", async () => {
    const res = rebaseResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"] });
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_A], true, "rebase")));

    await resolver.openFromResult("repo1", res, "main");

    expect(resolver.open).toBe(true);
    expect(resolver.editing).toBe(false);
    expect(resolver.files).toEqual([FILE_A]);
  });

  it("openWorkdirToAmend backgrounds the modal (keeps .editing true) and hands off to the Workdir panel", async () => {
    vi.mocked(commands.rebaseStart).mockResolvedValueOnce(rebaseResult({ ok: false, state: "editing" }));
    await resolver.startRebase("repo1", "main");
    expect(resolver.open).toBe(true);

    resolver.openWorkdirToAmend();

    expect(resolver.open).toBe(false);
    expect(resolver.editing).toBe(true);
    expect(bridge.selectWorkdir).toHaveBeenCalled();
  });

  it("openWorkdirToAmend is a no-op when not editing (e.g. a genuine conflict)", async () => {
    vi.mocked(commands.rebaseStart).mockResolvedValueOnce(
      rebaseResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"] }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_A], true, "rebase")));
    await resolver.startRebase("repo1", "main");

    resolver.openWorkdirToAmend();

    expect(resolver.open).toBe(true); // unchanged — the guard refused
    expect(bridge.selectWorkdir).not.toHaveBeenCalled();
  });

  it("reopen() brings the modal back to the foreground without losing .editing", async () => {
    vi.mocked(commands.rebaseStart).mockResolvedValueOnce(rebaseResult({ ok: false, state: "editing" }));
    await resolver.startRebase("repo1", "main");
    resolver.openWorkdirToAmend();
    expect(resolver.open).toBe(false);

    resolver.reopen();

    expect(resolver.open).toBe(true);
    expect(resolver.editing).toBe(true);
  });

  it("reopen() is a no-op when not editing", () => {
    resolver.open = false;
    resolver.editing = false;

    resolver.reopen();

    expect(resolver.open).toBe(false);
  });

  it("skip() is a no-op while editing — no rebaseSkip call, modal stays open", async () => {
    vi.mocked(commands.rebaseStart).mockResolvedValueOnce(rebaseResult({ ok: false, state: "editing" }));
    await resolver.startRebase("repo1", "main");

    await resolver.skip();

    expect(commands.rebaseSkip).not.toHaveBeenCalled();
    expect(resolver.open).toBe(true);
  });

  it("continue() from an editing pause dispatches rebaseContinue — the SAME OPS entry a genuine conflict uses, no special-casing", async () => {
    vi.mocked(commands.rebaseStart).mockResolvedValueOnce(rebaseResult({ ok: false, state: "editing" }));
    await resolver.startRebase("repo1", "main");

    vi.mocked(commands.rebaseContinue).mockResolvedValueOnce(rebaseResult({ state: "clean", message: "Rebased." }));

    await resolver.continue();

    expect(commands.rebaseContinue).toHaveBeenCalledWith("repo1");
    expect(resolver.open).toBe(false);
    expect(resolver.editing).toBe(false); // close() -> reset() clears it
  });

  it("continuing from one edit-pause into ANOTHER falls back into the editing mode again automatically", async () => {
    vi.mocked(commands.rebaseStart).mockResolvedValueOnce(
      rebaseResult({ ok: false, state: "editing", message: "Paused to edit 1111111." }),
    );
    await resolver.startRebase("repo1", "main");

    vi.mocked(commands.rebaseContinue).mockResolvedValueOnce(
      rebaseResult({ ok: false, state: "editing", message: "Paused to edit 2222222." }),
    );

    await resolver.continue();

    expect(resolver.open).toBe(true);
    expect(resolver.editing).toBe(true);
    expect(resolver.sub).toBe("Paused to edit 2222222.");
    expect(commands.conflictStatus).not.toHaveBeenCalled();
  });

  // Regression guard (bug fix): continue()'s "still conflicted" branch used to
  // ONLY call refresh() and never reset `.editing` back to false. Scenario:
  // plan is [pick A, edit B, pick C] where C conflicts. Paused at edit B
  // (.editing=true), the user amends via Workdir and clicks Continue;
  // rebaseContinue lands on C's real conflict (state:'conflict'). Since
  // Resolver.svelte gates its ENTIRE file-list/three-way-diff UI on
  // `{#if resolver.editing}` (showing the edit banner instead), a stuck
  // `.editing` flag stranded the user on "Rebase paused to edit a commit" /
  // "Open Workdir to amend…" even though `conflictedFiles` was already
  // correctly populated below — only Abort worked. `.editing` must flip back
  // to false so Resolver.svelte's gate actually switches to the real
  // conflict-resolution UI.
  it("continue() from an editing pause landing on a REAL conflict clears .editing so the conflict UI (not the edit banner) can render", async () => {
    vi.mocked(commands.rebaseStart).mockResolvedValueOnce(
      rebaseResult({ ok: false, state: "editing", message: "Paused to edit 1111111." }),
    );
    await resolver.startRebase("repo1", "main");
    expect(resolver.editing).toBe(true);

    vi.mocked(commands.rebaseContinue).mockResolvedValueOnce(
      rebaseResult({ ok: false, state: "conflict", conflictedFiles: ["c.ts"] }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_A], true, "rebase")));

    await resolver.continue();

    // This IS Resolver.svelte's gating condition (`{#if resolver.editing}` /
    // `{:else}` renders the file-list/three-way-diff) — false here is exactly
    // what makes the modal switch off the edit banner.
    expect(resolver.editing).toBe(false);
    expect(resolver.open).toBe(true);
    expect(resolver.files.map((f) => f.path)).toEqual(["a.ts"]);
    expect(bridge.tama.warn).toHaveBeenCalled();
  });

  it("abort() from an editing pause dispatches rebaseAbort — the SAME OPS entry a genuine conflict uses", async () => {
    vi.mocked(commands.rebaseStart).mockResolvedValueOnce(rebaseResult({ ok: false, state: "editing" }));
    await resolver.startRebase("repo1", "main");

    vi.mocked(commands.rebaseAbort).mockResolvedValueOnce(rebaseResult({ state: "clean", message: "Rebase aborted." }));

    await resolver.abort();

    expect(commands.rebaseAbort).toHaveBeenCalledWith("repo1");
    expect(resolver.open).toBe(false);
    expect(resolver.editing).toBe(false);
  });

  it("a genuine conflict's openConflict always clears a stale .editing flag (belt-and-suspenders)", async () => {
    resolver.editing = true; // simulate a stale flag left over from a prior editing pause
    vi.mocked(commands.rebaseStart).mockResolvedValueOnce(
      rebaseResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"] }),
    );
    vi.mocked(commands.conflictStatus).mockResolvedValueOnce(ok(conflictStatus([FILE_A], true, "rebase")));

    await resolver.startRebase("repo1", "main");

    expect(resolver.editing).toBe(false);
    expect(resolver.files).toEqual([FILE_A]);
  });
});
