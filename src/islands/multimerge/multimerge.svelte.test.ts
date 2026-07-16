// Tests for the multi-branch merge controller (octopus + sequential).
//
// Isolation: multimerge.svelte.ts imports `../../legacy/bridge` (a live
// re-export of `../../legacy/main`, a vanilla script that boots a whole canvas
// app as an import side effect and throws in bare jsdom) AND
// `../resolver/resolver.svelte.ts` (the conflict handoff target) — both
// mocked below, mirroring rebaseplan.svelte.test.ts's own `vi.mock`
// scaffolding exactly.
import { beforeEach, describe, expect, it, vi } from "vitest";

// CUR_REPO is a toggleable getter (same shape as dashboard.svelte.test.ts's
// own) — one test simulates the app switching to a DIFFERENT repo while a
// queue conflict from THIS repo is still unresolved, to prove the stale
// onQueueContinue/onQueueAbort callbacks refuse to act against the wrong repo.
let mockCurRepo: string | null = "repo1";
vi.mock("../../legacy/bridge", () => ({
  reloadGraph: vi.fn(async () => {}),
  cheer: vi.fn(),
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
  get CUR_REPO() {
    return mockCurRepo;
  },
}));

// Real-mode by default (mirrors rebaseplan.svelte.test.ts's own IN_TAURI mock
// scaffolding) — the "demo mode" describe block below flips this back to
// false via vi.resetModules()/vi.doMock for the browser-design-mode path.
let mockInTauri = true;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    listRefs: vi.fn(),
    mergeStartMulti: vi.fn(),
    mergeQueueContinue: vi.fn(),
    mergeQueueAbort: vi.fn(),
    mergeQueueStatus: vi.fn(),
  },
}));

vi.mock("../resolver/resolver.svelte.ts", () => ({
  resolver: {
    openFromResult: vi.fn(),
  },
}));

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { resolver } from "../resolver/resolver.svelte.ts";
import type { LocalBranch, MergeQueueStatus, MergeResult, RefList } from "../../ipc/bindings";
import { multimergeCtrl } from "./multimerge.svelte.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}

function branch(partial: Partial<LocalBranch>): LocalBranch {
  return { name: "b", sha: "0".repeat(40), ahead: null, behind: null, upstream: null, ...partial };
}

function refList(partial: Partial<RefList>): RefList {
  return { head: "main", locals: [], remotes: [], tags: [], ...partial };
}

function mergeResult(partial: Partial<MergeResult>): MergeResult {
  return { ok: true, state: "clean", conflictedFiles: [], message: "", backupRef: null, blockedByLocalChanges: false, ...partial };
}

function queueStatus(partial: Partial<MergeQueueStatus>): MergeQueueStatus {
  return { inProgress: false, current: null, remaining: [], done: [], ...partial };
}

const B1 = branch({ name: "feat/a", sha: "1".repeat(40) });
const B2 = branch({ name: "feat/b", sha: "2".repeat(40) });
const B3 = branch({ name: "feat/c", sha: "3".repeat(40) });

function resetCtrl() {
  multimergeCtrl.open = false;
  multimergeCtrl.busy = false;
  multimergeCtrl.demo = false;
  multimergeCtrl.head = "";
  multimergeCtrl.branches = [];
  multimergeCtrl.selected = new Set();
  multimergeCtrl.mode = "sequential";
  multimergeCtrl.strategy = "auto";
  multimergeCtrl.resuming = false;
  multimergeCtrl.queueCurrent = null;
  multimergeCtrl.queueRemaining = [];
  multimergeCtrl.queueDoneList = [];
  multimergeCtrl.repo = "";
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInTauri = true;
  mockCurRepo = "repo1";
  resetCtrl();
});

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", () => {
    expect(document.getElementById("cv")).toBeNull();
    expect(multimergeCtrl).toBeDefined();
  });
});

describe("show", () => {
  it("no queue in progress: lists local branches, excluding HEAD's own branch", async () => {
    vi.mocked(commands.mergeQueueStatus).mockResolvedValueOnce(queueStatus({}));
    vi.mocked(commands.listRefs).mockResolvedValueOnce(ok(refList({ head: "main", locals: [branch({ name: "main" }), B1, B2] })));

    await multimergeCtrl.show("repo1");

    expect(multimergeCtrl.open).toBe(true);
    expect(multimergeCtrl.resuming).toBe(false);
    expect(multimergeCtrl.head).toBe("main");
    expect(multimergeCtrl.branches.map((b) => b.name)).toEqual(["feat/a", "feat/b"]);
  });

  it("a queue already in progress: shows the resume view instead of the picker, but STILL fetches branch names for display", async () => {
    vi.mocked(commands.mergeQueueStatus).mockResolvedValueOnce(
      queueStatus({ inProgress: true, current: B1.sha, remaining: [B2.sha], done: [] }),
    );
    vi.mocked(commands.listRefs).mockResolvedValueOnce(ok(refList({ head: "main", locals: [branch({ name: "main" }), B1, B2] })));

    await multimergeCtrl.show("repo1");

    expect(multimergeCtrl.open).toBe(true);
    expect(multimergeCtrl.resuming).toBe(true);
    expect(multimergeCtrl.queueCurrent).toBe(B1.sha);
    expect(multimergeCtrl.queueRemaining).toEqual([B2.sha]);
    // ADVERSARIALLY-FOUND FIX: branches must be populated even when resuming,
    // so the resume view's labelFor() can show real names, not raw shas.
    expect(commands.listRefs).toHaveBeenCalledWith("repo1");
    expect(multimergeCtrl.labelFor(B1.sha)).toBe(B1.name);
  });

  it("a queue in progress with an UNRESOLVABLE list_refs still opens the resume view (labelFor falls back to short shas)", async () => {
    vi.mocked(commands.mergeQueueStatus).mockResolvedValueOnce(
      queueStatus({ inProgress: true, current: B1.sha, remaining: [], done: [] }),
    );
    vi.mocked(commands.listRefs).mockResolvedValueOnce(err("boom"));

    await multimergeCtrl.show("repo1");

    expect(multimergeCtrl.open).toBe(true);
    expect(multimergeCtrl.resuming).toBe(true);
    expect(bridge.tama.warn).not.toHaveBeenCalled(); // the resume view is still useful without names
  });

  it("warns via Tama instead of opening without a repo", async () => {
    await multimergeCtrl.show("");
    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(multimergeCtrl.open).toBe(false);
    expect(commands.mergeQueueStatus).not.toHaveBeenCalled();
  });

  it("a list_refs error warns and never opens", async () => {
    vi.mocked(commands.mergeQueueStatus).mockResolvedValueOnce(queueStatus({}));
    vi.mocked(commands.listRefs).mockResolvedValueOnce(err("boom"));

    await multimergeCtrl.show("repo1");

    expect(multimergeCtrl.open).toBe(false);
    expect(bridge.tama.warn).toHaveBeenCalledWith("boom");
  });

  it("busy/re-entrancy: a second show() call while one is in flight is a no-op", async () => {
    multimergeCtrl.busy = true;
    await multimergeCtrl.show("repo1");
    expect(commands.mergeQueueStatus).not.toHaveBeenCalled();
  });
});

describe("toggle / selectedCount / canMerge", () => {
  it("toggle adds and removes a branch name from the selection", () => {
    multimergeCtrl.toggle("feat/a");
    expect(multimergeCtrl.selected.has("feat/a")).toBe(true);
    expect(multimergeCtrl.selectedCount).toBe(1);

    multimergeCtrl.toggle("feat/a");
    expect(multimergeCtrl.selected.has("feat/a")).toBe(false);
    expect(multimergeCtrl.selectedCount).toBe(0);
  });

  it("canMerge requires at least two selected branches and not busy", () => {
    expect(multimergeCtrl.canMerge).toBe(false);
    multimergeCtrl.toggle("feat/a");
    expect(multimergeCtrl.canMerge).toBe(false);
    multimergeCtrl.toggle("feat/b");
    expect(multimergeCtrl.canMerge).toBe(true);
    multimergeCtrl.busy = true;
    expect(multimergeCtrl.canMerge).toBe(false);
  });
});

describe("setMode / setStrategy", () => {
  it("set the mode and strategy fields directly", () => {
    multimergeCtrl.setMode("octopus");
    expect(multimergeCtrl.mode).toBe("octopus");
    multimergeCtrl.setStrategy("no-ff");
    expect(multimergeCtrl.strategy).toBe("no-ff");
  });
});

// ADVERSARIALLY-FOUND FIX: the resume view used to render raw commit SHAs
// (the backend sidecar's own keying) instead of branch names.
describe("labelFor", () => {
  it("resolves a known sha to its branch name", () => {
    multimergeCtrl.branches = [B1, B2];
    expect(multimergeCtrl.labelFor(B1.sha)).toBe(B1.name);
  });

  it("falls back to a short sha for one not in `branches` (e.g. deleted since the queue started)", () => {
    multimergeCtrl.branches = [B1];
    expect(multimergeCtrl.labelFor(B2.sha)).toBe(B2.sha.slice(0, 7));
  });
});

describe("merge", () => {
  function selectTwo() {
    multimergeCtrl.repo = "repo1";
    multimergeCtrl.branches = [B1, B2, B3];
    multimergeCtrl.selected = new Set([B1.name, B2.name]);
  }

  it("is a no-op with fewer than two branches selected", async () => {
    multimergeCtrl.repo = "repo1";
    multimergeCtrl.branches = [B1];
    multimergeCtrl.selected = new Set([B1.name]);

    await multimergeCtrl.merge();

    expect(commands.mergeStartMulti).not.toHaveBeenCalled();
  });

  it("busy/re-entrancy: a second merge() call while one is in flight is a no-op", async () => {
    selectTwo();
    multimergeCtrl.busy = true;

    await multimergeCtrl.merge();

    expect(commands.mergeStartMulti).not.toHaveBeenCalled();
  });

  it("octopus, clean: calls merge_start_multi with shas resolved from selected names, mode octopus, strategy null", async () => {
    selectTwo();
    multimergeCtrl.mode = "octopus";
    vi.mocked(commands.mergeStartMulti).mockResolvedValueOnce(mergeResult({ state: "clean", message: "Merged." }));

    await multimergeCtrl.merge();

    expect(commands.mergeStartMulti).toHaveBeenCalledWith("repo1", [B1.sha, B2.sha], "octopus", null);
    expect(multimergeCtrl.open).toBe(false);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(bridge.cheer).toHaveBeenCalled();
    expect(multimergeCtrl.busy).toBe(false);
  });

  it("octopus, conflict-unsupported: warns via Tama and never opens the resolver", async () => {
    selectTwo();
    multimergeCtrl.mode = "octopus";
    vi.mocked(commands.mergeStartMulti).mockResolvedValueOnce(
      mergeResult({ ok: false, state: "octopus-conflict-unsupported", message: "try Sequential instead" }),
    );

    await multimergeCtrl.merge();

    expect(bridge.tama.warn).toHaveBeenCalledWith("try Sequential instead");
    expect(resolver.openFromResult).not.toHaveBeenCalled();
  });

  it("sequential, passes the chosen strategy (ignored for octopus)", async () => {
    selectTwo();
    multimergeCtrl.mode = "sequential";
    multimergeCtrl.strategy = "no-ff";
    vi.mocked(commands.mergeStartMulti).mockResolvedValueOnce(mergeResult({ state: "clean" }));
    vi.mocked(commands.mergeQueueStatus).mockResolvedValueOnce(queueStatus({}));

    await multimergeCtrl.merge();

    expect(commands.mergeStartMulti).toHaveBeenCalledWith("repo1", [B1.sha, B2.sha], "sequential", "no-ff");
  });

  it("sequential, both steps clean: asks merge_queue_status for ground truth, chains through, then finishes", async () => {
    selectTwo();
    multimergeCtrl.mode = "sequential";
    vi.mocked(commands.mergeStartMulti).mockResolvedValueOnce(mergeResult({ state: "clean", message: "step 1" }));
    // First status check: one step already done, one still queued (not
    // driven by a client-side counter — see advanceOrFinish's own doc
    // comment on why this must come from the backend).
    vi.mocked(commands.mergeQueueStatus).mockResolvedValueOnce(queueStatus({ inProgress: true, done: [B1.sha], remaining: [B2.sha] }));
    vi.mocked(commands.mergeQueueContinue).mockResolvedValueOnce(mergeResult({ state: "clean", message: "step 2" }));
    // Second status check: nothing left — the queue is genuinely finished.
    vi.mocked(commands.mergeQueueStatus).mockResolvedValueOnce(queueStatus({ inProgress: false }));

    await multimergeCtrl.merge();

    expect(commands.mergeQueueStatus).toHaveBeenCalledTimes(2);
    expect(commands.mergeQueueContinue).toHaveBeenCalledTimes(1);
    expect(bridge.cheer).toHaveBeenCalledTimes(1); // only ONE final cheer, not once per step
  });

  it("sequential, a clean result but the queue already reports nothing in progress: finishes without calling merge_queue_continue", async () => {
    selectTwo();
    multimergeCtrl.mode = "sequential";
    vi.mocked(commands.mergeStartMulti).mockResolvedValueOnce(mergeResult({ state: "clean" }));
    vi.mocked(commands.mergeQueueStatus).mockResolvedValueOnce(queueStatus({ inProgress: false }));

    await multimergeCtrl.merge();

    expect(commands.mergeQueueContinue).not.toHaveBeenCalled();
    expect(bridge.cheer).toHaveBeenCalledTimes(1);
  });

  it("sequential, first step conflicts: hands off to the resolver with an onQueueContinue callback", async () => {
    selectTwo();
    multimergeCtrl.mode = "sequential";
    const res = mergeResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"] });
    vi.mocked(commands.mergeStartMulti).mockResolvedValueOnce(res);

    await multimergeCtrl.merge();

    expect(resolver.openFromResult).toHaveBeenCalledWith("repo1", res, B1.name, "merge", expect.any(Function), expect.any(Function));
    // The queue must NOT have been auto-advanced yet — only once the resolver
    // itself calls the callback back (simulated below).
    expect(commands.mergeQueueContinue).not.toHaveBeenCalled();
    expect(commands.mergeQueueStatus).not.toHaveBeenCalled();
  });

  it("sequential, conflict resolved via the resolver's onQueueContinue: asks the queue status and advances", async () => {
    selectTwo();
    multimergeCtrl.mode = "sequential";
    const res = mergeResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"] });
    vi.mocked(commands.mergeStartMulti).mockResolvedValueOnce(res);
    vi.mocked(commands.mergeQueueStatus).mockResolvedValueOnce(queueStatus({ inProgress: true, remaining: [B2.sha] }));
    vi.mocked(commands.mergeQueueContinue).mockResolvedValueOnce(mergeResult({ state: "clean" }));
    vi.mocked(commands.mergeQueueStatus).mockResolvedValueOnce(queueStatus({ inProgress: false }));

    await multimergeCtrl.merge();
    const onQueueContinue = vi.mocked(resolver.openFromResult).mock.calls[0][4] as () => void;
    await onQueueContinue();

    expect(commands.mergeQueueContinue).toHaveBeenCalledTimes(1);
    expect(bridge.cheer).toHaveBeenCalledTimes(1);
  });

  it("sequential, conflict aborted via the resolver's onQueueAbort: cancels the whole queue", async () => {
    selectTwo();
    multimergeCtrl.mode = "sequential";
    const res = mergeResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"] });
    vi.mocked(commands.mergeStartMulti).mockResolvedValueOnce(res);
    vi.mocked(commands.mergeQueueAbort).mockResolvedValueOnce(mergeResult({ state: "clean", message: "cancelled" }));

    await multimergeCtrl.merge();
    const onQueueAbort = vi.mocked(resolver.openFromResult).mock.calls[0][5] as () => void;
    await onQueueAbort();

    expect(commands.mergeQueueAbort).toHaveBeenCalledWith("repo1");
    expect(bridge.tama.say).toHaveBeenCalledWith("cancelled", 3200);
    // A cancelled queue must NOT auto-advance — it's done, not "keep going".
    expect(commands.mergeQueueContinue).not.toHaveBeenCalled();
  });

  it("octopus mode never passes onQueueContinue/onQueueAbort callbacks on conflict", async () => {
    selectTwo();
    multimergeCtrl.mode = "octopus";
    const res = mergeResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"] });
    vi.mocked(commands.mergeStartMulti).mockResolvedValueOnce(res);

    await multimergeCtrl.merge();

    expect(resolver.openFromResult).toHaveBeenCalledWith("repo1", res, B1.name, "merge", undefined, undefined);
  });

  it("error result: warns via Tama, no crash", async () => {
    selectTwo();
    vi.mocked(commands.mergeStartMulti).mockResolvedValueOnce(mergeResult({ ok: false, state: "error", message: "bad revision" }));

    await multimergeCtrl.merge();

    expect(bridge.tama.warn).toHaveBeenCalledWith("bad revision");
  });

  it("demo mode: never calls the backend, cheers directly", async () => {
    selectTwo();
    multimergeCtrl.demo = true;

    await multimergeCtrl.merge();

    expect(commands.mergeStartMulti).not.toHaveBeenCalled();
    expect(multimergeCtrl.open).toBe(false);
    expect(bridge.cheer).toHaveBeenCalled();
  });
});

// ADVERSARIALLY-FOUND FIX: onQueueContinue/onQueueAbort close over the repo
// the queue started in. Without a live re-check, switching to a DIFFERENT
// repo (reachable via the native OS menu bar, which bypasses this app's own
// DOM overlay) while a queue conflict sits unresolved let a LATER, unrelated
// repo's conflict resolution fire the stale callback against the wrong repo.
describe("cross-repo guard (onQueueContinue/onQueueAbort)", () => {
  it("onQueueContinue is a no-op once the app has moved on to a different repo", async () => {
    multimergeCtrl.repo = "repo1";
    multimergeCtrl.branches = [B1, B2];
    multimergeCtrl.selected = new Set([B1.name, B2.name]);
    const res = mergeResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"] });
    vi.mocked(commands.mergeStartMulti).mockResolvedValueOnce(res);

    await multimergeCtrl.merge();
    const onQueueContinue = vi.mocked(resolver.openFromResult).mock.calls[0][4] as () => void;

    mockCurRepo = "repo2"; // the app switched to a different repo in the meantime
    await onQueueContinue();

    expect(commands.mergeQueueStatus).not.toHaveBeenCalled();
    expect(commands.mergeQueueContinue).not.toHaveBeenCalled();
  });

  it("onQueueAbort is a no-op once the app has moved on to a different repo", async () => {
    multimergeCtrl.repo = "repo1";
    multimergeCtrl.branches = [B1, B2];
    multimergeCtrl.selected = new Set([B1.name, B2.name]);
    const res = mergeResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"] });
    vi.mocked(commands.mergeStartMulti).mockResolvedValueOnce(res);

    await multimergeCtrl.merge();
    const onQueueAbort = vi.mocked(resolver.openFromResult).mock.calls[0][5] as () => void;

    mockCurRepo = "repo2";
    await onQueueAbort();

    expect(commands.mergeQueueAbort).not.toHaveBeenCalled();
  });
});

// ADVERSARIALLY-FOUND FIX: `busy` only spans one top-level call, but
// advanceOrFinish also runs as resolver's onQueueContinue callback, entirely
// outside any top-level call here — without a SEPARATE mutex, a user could
// reopen the picker and click Continue while an automatic advance is still
// in flight, racing a second concurrent merge_queue_continue call.
describe("queueBusy mutex (concurrent advance guard)", () => {
  it("resumeContinue() is a no-op while an automatic advanceOrFinish (via onQueueContinue) is still in flight", async () => {
    multimergeCtrl.repo = "repo1";
    multimergeCtrl.branches = [B1, B2];
    multimergeCtrl.selected = new Set([B1.name, B2.name]);
    const res = mergeResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"] });
    vi.mocked(commands.mergeStartMulti).mockResolvedValueOnce(res);
    await multimergeCtrl.merge();
    const onQueueContinue = vi.mocked(resolver.openFromResult).mock.calls[0][4] as () => Promise<void>;

    // Hold mergeQueueStatus open so advanceOrFinish's own queueBusy window
    // stays open long enough for a concurrent resumeContinue() to race it.
    let resolveStatus!: (v: MergeQueueStatus) => void;
    vi.mocked(commands.mergeQueueStatus).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );

    const advancePromise = onQueueContinue();
    await multimergeCtrl.resumeContinue(); // must be a no-op — queueBusy is already held

    resolveStatus(queueStatus({ inProgress: false }));
    await advancePromise;

    expect(commands.mergeQueueContinue).not.toHaveBeenCalled(); // status said "nothing in progress" — finish(), not continue()
    expect(commands.mergeQueueStatus).toHaveBeenCalledTimes(1); // only the FIRST call's own status check ran
  });
});

describe("resumeContinue / resumeCancel", () => {
  function setResuming() {
    multimergeCtrl.repo = "repo1";
    multimergeCtrl.resuming = true;
    multimergeCtrl.open = true;
    multimergeCtrl.queueCurrent = B1.sha;
    multimergeCtrl.queueRemaining = [B2.sha];
    multimergeCtrl.queueDoneList = [];
  }

  it("resumeContinue: advances the queue and finishes once nothing remains", async () => {
    setResuming();
    vi.mocked(commands.mergeQueueContinue).mockResolvedValueOnce(mergeResult({ state: "clean" }));
    vi.mocked(commands.mergeQueueStatus).mockResolvedValueOnce(queueStatus({ inProgress: false }));

    await multimergeCtrl.resumeContinue();

    expect(commands.mergeQueueContinue).toHaveBeenCalledTimes(1);
    expect(bridge.cheer).toHaveBeenCalledTimes(1);
    expect(multimergeCtrl.open).toBe(false);
  });

  it("resumeContinue: a conflict hands off to the resolver with onQueueContinue", async () => {
    setResuming();
    const res = mergeResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"] });
    vi.mocked(commands.mergeQueueContinue).mockResolvedValueOnce(res);

    await multimergeCtrl.resumeContinue();

    expect(resolver.openFromResult).toHaveBeenCalledWith("repo1", res, "", "merge", expect.any(Function), expect.any(Function));
  });

  it("resumeContinue: busy/re-entrancy is a no-op", async () => {
    setResuming();
    multimergeCtrl.busy = true;

    await multimergeCtrl.resumeContinue();

    expect(commands.mergeQueueContinue).not.toHaveBeenCalled();
  });

  it("resumeCancel: success closes the modal and reloads the graph", async () => {
    setResuming();
    vi.mocked(commands.mergeQueueAbort).mockResolvedValueOnce(mergeResult({ state: "clean", message: "cancelled" }));

    await multimergeCtrl.resumeCancel();

    expect(multimergeCtrl.open).toBe(false);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(bridge.tama.say).toHaveBeenCalledWith("cancelled", 3200);
  });

  it("resumeCancel: failure warns and leaves the resume view open", async () => {
    setResuming();
    vi.mocked(commands.mergeQueueAbort).mockResolvedValueOnce(mergeResult({ ok: false, state: "error", message: "could not abort" }));

    await multimergeCtrl.resumeCancel();

    expect(bridge.tama.warn).toHaveBeenCalledWith("could not abort");
    expect(multimergeCtrl.open).toBe(true);
  });
});

describe("close", () => {
  it("clears open, selected, and resuming", () => {
    multimergeCtrl.open = true;
    multimergeCtrl.selected = new Set(["feat/a"]);
    multimergeCtrl.resuming = true;

    multimergeCtrl.close();

    expect(multimergeCtrl.open).toBe(false);
    expect(multimergeCtrl.selected.size).toBe(0);
    expect(multimergeCtrl.resuming).toBe(false);
  });
});

// Browser design-mode path (no Tauri backend) — mirrors rebaseplan.svelte.test.ts's
// own "demo mode" describe block: reset modules and re-mock ../../ipc/env so
// IN_TAURI is false from FIRST import, proving show() takes the demo branch
// with zero IPC calls rather than merely toggling a flag after the fact.
describe("demo mode (browser, no Tauri)", () => {
  it("show() seeds canned demo branches with zero IPC calls", async () => {
    vi.resetModules();
    vi.doMock("../../ipc/env", () => ({ IN_TAURI: false }));
    const bindingsDemo = await import("../../ipc/bindings");
    const { multimergeCtrl: demoCtrl } = await import("./multimerge.svelte.ts");

    await demoCtrl.show("");

    expect(demoCtrl.open).toBe(true);
    expect(demoCtrl.demo).toBe(true);
    expect(demoCtrl.branches.length).toBeGreaterThan(0);
    expect(bindingsDemo.commands.mergeQueueStatus).not.toHaveBeenCalled();
    expect(bindingsDemo.commands.listRefs).not.toHaveBeenCalled();
  });
});
