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
  TAMA_IMG: { alarm: "alarm.png", happy: "happy.png" },
  requestRedraw: vi.fn(),
  syncBisectMarks: vi.fn(),
  focusBisectCurrent: vi.fn(),
  clearBisectMarks: vi.fn(),
  demoBisectStatus: vi.fn(),
  demoBisectMark: vi.fn(),
  renderBisect: vi.fn(),
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    cherryPick: vi.fn(),
    cherryPickContinue: vi.fn(),
    cherryPickAbort: vi.fn(),
    mergeStart: vi.fn(),
    mergeContinue: vi.fn(),
    mergeAbort: vi.fn(),
    conflictStatus: vi.fn(),
    resolveConflictFile: vi.fn(),
  },
}));

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import type { ConflictFile, ConflictStatus, MergeResult, PickResult, ResolveResult } from "../../ipc/bindings";
import { resolver } from "./resolver.svelte.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}

const FILE_A: ConflictFile = { path: "a.ts", ours: "o", base: "b", theirs: "t" };
const FILE_B: ConflictFile = { path: "b.ts", ours: "o2", base: "b2", theirs: "t2" };

function pickResult(partial: Partial<PickResult>): PickResult {
  return { ok: true, state: "clean", conflictedFiles: [], message: "", backupRef: null, ...partial };
}

function mergeResult(partial: Partial<MergeResult>): MergeResult {
  return { ok: true, state: "clean", conflictedFiles: [], message: "", backupRef: null, ...partial };
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
}

beforeEach(() => {
  vi.clearAllMocks();
  resetResolver();
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
});

describe("startMerge", () => {
  it("clean result: reloads the graph and closes the modal", async () => {
    vi.mocked(commands.mergeStart).mockResolvedValueOnce(
      mergeResult({ state: "clean", message: "Merged." }),
    );

    await resolver.startMerge("repo1", "sha1");

    expect(commands.mergeStart).toHaveBeenCalledWith("repo1", "sha1");
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
