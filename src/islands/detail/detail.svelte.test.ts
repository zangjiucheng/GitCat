// Tests for the commit detail panel controller.
//
// Same isolation strategy as the other islands' tests: legacy/bridge is
// mocked so legacy/main.ts never evaluates. Design-mode (bridge.BACKEND
// null) exercises the demo-data path; "live" tests set bridge.BACKEND to
// drive the real commitMeta()/commands.commitDetail() path.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  G: null,
  BACKEND: null,
  CUR_REPO: "/repo",
  AUTHORS: [{ n: "Demo Author", e: "demo@gitcat.dev" }],
  hhex: (r: number) => "0000" + r,
  msgOf: (r: number) => "demo message " + r,
  fakeAgo: (r: number) => r + "m",
  relTime: (t: number) => t + "s ago",
  highlight: (src: string) => src,
  TAMA_IMG: { hero: "hero.png" },
  pickRepo: vi.fn(),
}));

let mockInTauri = false;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));

vi.mock("../resolver/resolver.svelte.ts", () => ({
  resolver: {
    openDemo: vi.fn(),
    startRevert: vi.fn(async () => {}),
  },
}));

import * as bridge from "../../legacy/bridge";
import { commands } from "../../ipc/bindings";
import { resolver } from "../resolver/resolver.svelte.ts";
import { detailCtrl } from "./detail.svelte.ts";

vi.mock("../../ipc/bindings", () => ({
  commands: {
    commitDetail: vi.fn(),
  },
}));

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}

function setDemoGraph(N = 5) {
  (bridge as any).G = { N, isMerge: new Array(N).fill(0), refs: new Array(N).fill(null), snapRows: [], snapTs: {} };
  (bridge as any).BACKEND = null;
}

// Same shape as setDemoGraph, but marks `mergeRow` as a merge commit
// (G.isMerge[mergeRow] = 1) — for the revertDisabled / merge-commit guard
// tests below.
function setDemoGraphWithMerge(mergeRow: number, N = 5) {
  const isMerge = new Array(N).fill(0);
  isMerge[mergeRow] = 1;
  (bridge as any).G = { N, isMerge, refs: new Array(N).fill(null), snapRows: [], snapTs: {} };
  (bridge as any).BACKEND = null;
}

function setBackendGraph(rows: any[]) {
  (bridge as any).G = { N: rows.length, isMerge: rows.map(() => 0), snapRows: [], snapTs: {} };
  (bridge as any).BACKEND = { rows };
}

function resetDetail() {
  detailCtrl.commit = null;
  detailCtrl.hero = null;
  detailCtrl.bodyText = "";
  detailCtrl.copied = false;
  detailCtrl.diffstat = null;
  detailCtrl.treeLoading = false;
  detailCtrl.diffLoading = false;
  detailCtrl.selectedFile = null;
  detailCtrl.diffHeader = "";
  detailCtrl.diffRows = [];
  (bridge as any).G = null;
  (bridge as any).BACKEND = null;
  vi.clearAllMocks();
}

beforeEach(() => {
  resetDetail();
});

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", () => {
    expect(document.getElementById("cv")).toBeNull();
    expect(detailCtrl).toBeDefined();
  });
});

describe("showHero / showEmpty", () => {
  it("showHero sets the loaded hero and clears any selected commit", () => {
    setDemoGraph();
    detailCtrl.select(0);
    detailCtrl.showHero(128, 293.4);
    expect(detailCtrl.hero).toEqual({ kind: "loaded", n: 128, ms: 293.4 });
    expect(detailCtrl.commit).toBeNull();
  });

  it("showEmpty sets the empty hero and clears any selected commit", () => {
    setDemoGraph();
    detailCtrl.select(0);
    detailCtrl.showEmpty();
    expect(detailCtrl.hero).toEqual({ kind: "empty" });
    expect(detailCtrl.commit).toBeNull();
  });
});

describe("deselect", () => {
  it("after showHero + select, restores the same loaded hero (clicking empty canvas space)", () => {
    setDemoGraph();
    detailCtrl.showHero(128, 293.4);
    detailCtrl.select(0);
    expect(detailCtrl.commit).not.toBeNull();
    detailCtrl.deselect();
    expect(detailCtrl.hero).toEqual({ kind: "loaded", n: 128, ms: 293.4 });
    expect(detailCtrl.commit).toBeNull();
  });

  it("after showEmpty + select, restores the empty hero", () => {
    setDemoGraph();
    detailCtrl.showEmpty();
    detailCtrl.select(0);
    detailCtrl.deselect();
    expect(detailCtrl.hero).toEqual({ kind: "empty" });
    expect(detailCtrl.commit).toBeNull();
  });
});

describe("select (design mode / demo data)", () => {
  it("populates commit + demo diffstat/tree synchronously (no backend)", () => {
    setDemoGraph();
    detailCtrl.select(2);
    expect(detailCtrl.hero).toBeNull();
    expect(detailCtrl.commit?.row).toBe(2);
    expect(detailCtrl.commit?.subject).toBe("demo message 2");
    expect(detailCtrl.diffstat).not.toBeNull();
    expect(detailCtrl.tree.files.length + Object.keys(detailCtrl.tree.dirs).length).toBeGreaterThan(0);
    expect(commands.commitDetail).not.toHaveBeenCalled();
  });

  it("selects the first file's diff by default", () => {
    setDemoGraph();
    detailCtrl.select(0);
    expect(detailCtrl.selectedFile).toBe("src/auth/session.ts");
    expect(detailCtrl.diffRows.length).toBeGreaterThan(0);
  });

  it("selectFile switches to an explicit path", () => {
    setDemoGraph();
    detailCtrl.select(0);
    detailCtrl.selectFile("src/auth/token.ts");
    expect(detailCtrl.selectedFile).toBe("src/auth/token.ts");
    expect(detailCtrl.diffHeader).toBe("src/auth/token.ts");
  });
});

describe("select (live / real repo)", () => {
  it("shows a loading state, then loads the real diff via commands.commitDetail", async () => {
    setBackendGraph([{ sha: "aaa1111", subject: "Fix bug", an: { n: "Dev", e: "d@x.dev", t: 100 }, cm: { n: "Dev", e: "d@x.dev", t: 100 }, refs: [] }]);
    let resolveDetail: (v: any) => void;
    vi.mocked(commands.commitDetail).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDetail = resolve;
      }) as any,
    );

    detailCtrl.select(0);
    expect(detailCtrl.treeLoading).toBe(true);
    expect(detailCtrl.diffLoading).toBe(true);
    expect(detailCtrl.bodyText).toBe("loading…");

    resolveDetail!(
      ok({
        sha: "aaa1111",
        shortSha: "aaa1111",
        subject: "Fix bug",
        body: "Full message body.",
        message: "Fix bug\n\nFull message body.",
        additions: 5,
        deletions: 2,
        filesChanged: 1,
        truncated: false,
        fileTree: [
          {
            path: "a.ts",
            oldPath: null,
            status: "M",
            additions: 5,
            deletions: 2,
            binary: false,
            truncated: false,
            lang: "ts",
            hunks: [{ header: "@@ -1,2 +1,2 @@", lines: [{ kind: "+", oldNo: null, newNo: 1, text: "hi" }] }],
          },
        ],
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(detailCtrl.bodyText).toBe("Full message body.");
    expect(detailCtrl.treeLoading).toBe(false);
    expect(detailCtrl.diffLoading).toBe(false);
    expect(detailCtrl.diffstat?.add).toBe(5);
    expect(detailCtrl.selectedFile).toBe("a.ts");
  });

  it("a stale in-flight response is ignored once a newer selection supersedes it", async () => {
    setBackendGraph([
      { sha: "aaa1111", subject: "one", an: { n: "Dev", e: "d@x.dev", t: 100 }, cm: { n: "Dev", e: "d@x.dev", t: 100 }, refs: [] },
      { sha: "bbb2222", subject: "two", an: { n: "Dev", e: "d@x.dev", t: 100 }, cm: { n: "Dev", e: "d@x.dev", t: 100 }, refs: [] },
    ]);
    let resolveFirst: (v: any) => void;
    vi.mocked(commands.commitDetail).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }) as any,
    );
    vi.mocked(commands.commitDetail).mockResolvedValueOnce(
      ok({
        sha: "bbb2222",
        shortSha: "bbb2222",
        subject: "two",
        body: "second",
        message: "two",
        additions: 1,
        deletions: 1,
        filesChanged: 1,
        truncated: false,
        fileTree: [],
      }),
    );

    detailCtrl.select(0); // in-flight, never resolved yet
    detailCtrl.select(1); // supersedes it
    await Promise.resolve();
    await Promise.resolve();
    expect(detailCtrl.bodyText).toBe("second");

    // Now the stale first response arrives — must be a no-op.
    resolveFirst!(ok({ sha: "aaa1111", shortSha: "aaa1111", subject: "one", body: "first (stale)", message: "one", additions: 0, deletions: 0, filesChanged: 0, truncated: false, fileTree: [] }));
    await Promise.resolve();
    await Promise.resolve();
    expect(detailCtrl.bodyText).toBe("second");
  });

  it("shows an error note in the diff view when commit_detail fails", async () => {
    setBackendGraph([{ sha: "aaa1111", subject: "one", an: { n: "Dev", e: "d@x.dev", t: 100 }, cm: { n: "Dev", e: "d@x.dev", t: 100 }, refs: [] }]);
    vi.mocked(commands.commitDetail).mockResolvedValueOnce(err("repo not found"));

    detailCtrl.select(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(detailCtrl.diffRows).toEqual([{ kind: "note", text: expect.stringContaining("repo not found") }]);
    expect(detailCtrl.treeLoading).toBe(false);
    expect(detailCtrl.diffLoading).toBe(false);
  });
});

describe("copySha", () => {
  it("flips copied on then off after a delay", () => {
    vi.useFakeTimers();
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
    setDemoGraph();
    detailCtrl.select(0);
    detailCtrl.copySha();
    expect(detailCtrl.copied).toBe(true);
    vi.advanceTimersByTime(900);
    expect(detailCtrl.copied).toBe(false);
    vi.useRealTimers();
  });
});

describe("coverage", () => {
  it("is null when no snapshot covers the selected row", () => {
    setDemoGraph();
    detailCtrl.select(0);
    expect(detailCtrl.coverage).toBeNull();
  });

  it("reports the nearest snapshot at or before the selected row", () => {
    (bridge as any).G = { N: 10, isMerge: new Array(10).fill(0), refs: new Array(10).fill(null), snapRows: [2, 6], snapTs: { 2: "5m", 6: "1m" } };
    detailCtrl.select(7);
    expect(detailCtrl.coverage).toEqual({ ago: "1m" });
  });
});

// The "Revert commit" button — the app's entry point for git revert (see
// Detail.svelte / detail.svelte.ts's revertCommit() doc comment for why: no
// per-commit-row context menu exists anywhere, and revert always applies onto
// HEAD given only the source commit, so the drag gestures cherry-pick/merge
// use don't fit). Detail.svelte only ever renders this button inside the
// `{:else if detailCtrl.commit}` branch of its `{#if workdirCtrl.selected}
// {:else if detailCtrl.hero} {:else if detailCtrl.commit}` chain — the SAME
// chain that already keeps the hero card and the workdir pinned row's own
// panel mutually exclusive with the commit detail view. So "not shown for
// the hero/empty state or the workdir pinned row" is structurally guaranteed
// by that chain (there's no separate .svelte-component render harness in
// this repo — every other island's test suite is controller-only, same as
// this file); what IS unit-testable here is the controller-level guard this
// button's handler relies on: revertCommit() is a no-op without a selected
// commit (covers hero/empty), and calls the right backend entry point with
// the right repo+sha when one is selected.
describe("revertCommit", () => {
  it("is a no-op when there is no selected commit (hero/empty state)", async () => {
    setDemoGraph();
    detailCtrl.showEmpty();
    expect(detailCtrl.commit).toBeNull();

    await detailCtrl.revertCommit();

    expect(resolver.startRevert).not.toHaveBeenCalled();
    expect(resolver.openDemo).not.toHaveBeenCalled();
  });

  it("design mode (not IN_TAURI) opens the resolver's revert demo, not startRevert", async () => {
    mockInTauri = false;
    setDemoGraph();
    detailCtrl.select(0);

    await detailCtrl.revertCommit();

    expect(resolver.openDemo).toHaveBeenCalledWith(detailCtrl.commit!.sha, "revert");
    expect(resolver.startRevert).not.toHaveBeenCalled();
  });

  it("real mode calls resolver.startRevert with the repo and the selected commit's sha", async () => {
    mockInTauri = true;
    setBackendGraph([{ sha: "aaa1111", subject: "one", an: { n: "Dev", e: "d@x.dev", t: 100 }, cm: { n: "Dev", e: "d@x.dev", t: 100 }, refs: [] }]);
    vi.mocked(commands.commitDetail).mockResolvedValueOnce(
      ok({
        sha: "aaa1111",
        shortSha: "aaa1111",
        subject: "one",
        body: "",
        message: "one",
        additions: 0,
        deletions: 0,
        filesChanged: 0,
        truncated: false,
        fileTree: [],
      }),
    );
    detailCtrl.select(0);
    await Promise.resolve();
    await Promise.resolve();

    await detailCtrl.revertCommit();

    expect(resolver.startRevert).toHaveBeenCalledWith("/repo", "aaa1111");
    expect(resolver.openDemo).not.toHaveBeenCalled();
  });

  it("is a no-op for a merge commit even if somehow invoked (belt-and-braces alongside the disabled button)", async () => {
    mockInTauri = true;
    setDemoGraphWithMerge(2);
    detailCtrl.select(2);
    expect(detailCtrl.commit?.merge).toBe(true);

    await detailCtrl.revertCommit();

    expect(resolver.startRevert).not.toHaveBeenCalled();
    expect(resolver.openDemo).not.toHaveBeenCalled();
  });
});

// The "Revert commit" button's disabled state (Detail.svelte:
// `disabled={detailCtrl.revertDisabled}`). Like `revertCommit()` above, there
// is no .svelte-component render harness in this repo, so what's tested here
// is the controller-level getter the template's `disabled` attribute reads —
// same rationale as the `revertCommit` suite's doc comment. Covers: disabled
// for a merge commit (git revert, like cherry-pick, needs `-m`/`--mainline`
// for a merge commit and revert_start deliberately doesn't support it — see
// legacy/main.ts's `legalPick`'s equivalent `G.isMerge[src]` guard for
// cherry-pick's drag gesture), enabled for a normal commit, and disabled
// while `resolver.busy` (the pre-existing re-entrancy guard, now folded into
// the same getter).
describe("revertDisabled (merge-commit guard)", () => {
  it("is disabled when the selected commit is a merge", () => {
    setDemoGraphWithMerge(2);
    detailCtrl.select(2);
    expect(detailCtrl.commit?.merge).toBe(true);
    expect(detailCtrl.revertDisabled).toBe(true);
  });

  it("is enabled for a normal (non-merge) commit", () => {
    setDemoGraph();
    detailCtrl.select(0);
    expect(detailCtrl.commit?.merge).toBe(false);
    expect(detailCtrl.revertDisabled).toBe(false);
  });

  it("is disabled while resolver.busy, regardless of merge state", () => {
    setDemoGraph();
    detailCtrl.select(0);
    expect(detailCtrl.commit?.merge).toBe(false);
    (resolver as any).busy = true;
    try {
      expect(detailCtrl.revertDisabled).toBe(true);
    } finally {
      (resolver as any).busy = false;
    }
  });
});
