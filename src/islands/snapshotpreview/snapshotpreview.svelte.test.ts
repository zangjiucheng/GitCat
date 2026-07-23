// Tests for the snapshot-preview controller. Same isolation strategy as the
// other island suites: mock legacy/bridge so the whole vanilla canvas app in
// legacy/main.ts never boots, mock the IPC bindings + IN_TAURI, and drive
// showAt()/close() directly against jsdom.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => {
  const backend = { rows: [] as Array<{ sha: string }> };
  const state = { scrollTarget: 0, selectedRow: -1 };
  return {
    BACKEND: backend,
    get G() {
      return { N: backend.rows.length };
    },
    state,
    layout: { rowH: 20 },
    view: { cssH: 800 },
    clampScroll: (v: number) => Math.max(0, v),
    select: vi.fn((row: number) => {
      state.selectedRow = row;
    }),
    bandH: () => 40,
    cv: { focus: vi.fn() },
    CUR_REPO: "/repo",
    relTime: () => "2h ago",
  };
});

let mockInTauri = true;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: { commitDetail: vi.fn() },
}));

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { snapshotPreviewCtrl } from "./snapshotpreview.svelte.ts";

function snap(over: Record<string, unknown> = {}) {
  return { ref: "refs/gitgui/backup/1-2", ts: 1000, sha: "abc1234def5678", subject: "did a thing", ...over } as any;
}
function detail(over: Record<string, unknown> = {}) {
  return {
    sha: "abc1234def5678",
    shortSha: "abc1234",
    subject: "did a thing",
    body: "",
    message: "did a thing",
    additions: 5,
    deletions: 2,
    filesChanged: 1,
    truncated: false,
    fileTree: [],
    ...over,
  };
}
const okd = (d: unknown) => ({ status: "ok", data: d }) as any;
const errd = (e: string) => ({ status: "error", error: e }) as any;

beforeEach(() => {
  mockInTauri = true;
  (bridge.BACKEND as any).rows = [];
  (bridge.state as any).selectedRow = -1;
  snapshotPreviewCtrl.close();
  vi.clearAllMocks();
});

describe("showAt", () => {
  it("opens, captures the snapshot, and loads its commit detail", async () => {
    vi.mocked(commands.commitDetail).mockResolvedValueOnce(okd(detail()));
    await snapshotPreviewCtrl.showAt(snap(), 100, 200);

    expect(snapshotPreviewCtrl.open).toBe(true);
    expect(snapshotPreviewCtrl.snap?.sha).toBe("abc1234def5678");
    expect(commands.commitDetail).toHaveBeenCalledWith("/repo", "abc1234def5678");
    expect(snapshotPreviewCtrl.detail?.filesChanged).toBe(1);
    expect(snapshotPreviewCtrl.loading).toBe(false);
  });

  it("selects + scrolls to the snapshot's commit when it's a loaded graph row", async () => {
    (bridge.BACKEND as any).rows = [{ sha: "zzz" }, { sha: "abc1234def5678" }, { sha: "yyy" }];
    vi.mocked(commands.commitDetail).mockResolvedValueOnce(okd(detail()));
    await snapshotPreviewCtrl.showAt(snap(), 10, 10);

    expect(bridge.select).toHaveBeenCalledWith(1);
    expect(snapshotPreviewCtrl.inGraph).toBe(true);
  });

  it("matches a full snapshot sha against an abbreviated graph-row sha", async () => {
    (bridge.BACKEND as any).rows = [{ sha: "abc1234" }]; // graph row is abbreviated
    vi.mocked(commands.commitDetail).mockResolvedValueOnce(okd(detail()));
    await snapshotPreviewCtrl.showAt(snap({ sha: "abc1234def5678" }), 10, 10);

    expect(bridge.select).toHaveBeenCalledWith(0);
    expect(snapshotPreviewCtrl.inGraph).toBe(true);
  });

  it("does not touch the graph (inGraph=false) for an off-graph snapshot, but still previews", async () => {
    (bridge.BACKEND as any).rows = [{ sha: "zzz" }, { sha: "yyy" }];
    vi.mocked(commands.commitDetail).mockResolvedValueOnce(okd(detail()));
    await snapshotPreviewCtrl.showAt(snap(), 10, 10);

    expect(bridge.select).not.toHaveBeenCalled();
    expect(snapshotPreviewCtrl.inGraph).toBe(false);
    expect(snapshotPreviewCtrl.detail).not.toBeNull();
  });

  it("surfaces a commit_detail error and clears loading", async () => {
    vi.mocked(commands.commitDetail).mockResolvedValueOnce(errd("bad object"));
    await snapshotPreviewCtrl.showAt(snap(), 10, 10);

    expect(snapshotPreviewCtrl.error).toContain("bad object");
    expect(snapshotPreviewCtrl.detail).toBeNull();
    expect(snapshotPreviewCtrl.loading).toBe(false);
  });

  it("demo mode (no Tauri) shows a synthetic detail without calling the backend", async () => {
    mockInTauri = false;
    await snapshotPreviewCtrl.showAt(snap(), 10, 10);

    expect(commands.commitDetail).not.toHaveBeenCalled();
    expect(snapshotPreviewCtrl.detail?.subject).toBe("did a thing");
    expect(snapshotPreviewCtrl.detail?.fileTree.length).toBeGreaterThan(0);
  });

  it("discards a slow load that resolves after a newer open (token guard)", async () => {
    let resolveFirst!: (v: unknown) => void;
    vi.mocked(commands.commitDetail)
      .mockReturnValueOnce(new Promise((r) => (resolveFirst = r)) as any)
      .mockResolvedValueOnce(okd(detail({ subject: "second" })));

    const p1 = snapshotPreviewCtrl.showAt(snap({ sha: "aaa", subject: "first" }), 10, 10);
    const p2 = snapshotPreviewCtrl.showAt(snap({ sha: "bbb", subject: "second" }), 20, 20);
    await p2;
    expect(snapshotPreviewCtrl.snap?.subject).toBe("second");

    resolveFirst(okd(detail({ subject: "STALE" })));
    await p1;
    // The stale first load must not clobber the second.
    expect(snapshotPreviewCtrl.detail?.subject).not.toBe("STALE");
  });
});

describe("close", () => {
  it("resets all state", async () => {
    vi.mocked(commands.commitDetail).mockResolvedValueOnce(okd(detail()));
    await snapshotPreviewCtrl.showAt(snap(), 10, 10);
    snapshotPreviewCtrl.close();

    expect(snapshotPreviewCtrl.open).toBe(false);
    expect(snapshotPreviewCtrl.snap).toBeNull();
    expect(snapshotPreviewCtrl.detail).toBeNull();
    expect(snapshotPreviewCtrl.inGraph).toBe(false);
  });
});
