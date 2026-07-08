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

import * as bridge from "../../legacy/bridge";
import { commands } from "../../ipc/bindings";
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
