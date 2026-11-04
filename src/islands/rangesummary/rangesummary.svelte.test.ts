// Tests for the compare controller's full-diff modal: the since-the-fork
// toggle, labels for revision endpoints, and handing one file to the external
// diff tool. The ordering and the diffs themselves are the backend's
// (src-tauri/tests/compare.rs); this checks what the controller asks for.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
  resolveLang: vi.fn(() => null),
}));

vi.mock("../../ipc/env", () => ({ IN_TAURI: true }));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    commitRangeSummary: vi.fn(),
    commitRangeDiff: vi.fn(),
  },
}));

vi.mock("../externaltools/externaltools.svelte.ts", () => ({
  externalToolsCtrl: { openDiff: vi.fn(async () => {}) },
}));

vi.mock("../pluginlanguages/pluginlanguages.svelte.ts", () => ({
  pluginLanguagesCtrl: { ensureLoaded: vi.fn(async () => {}) },
}));

import { commands, type RangeDiff, type RangeSummary } from "../../ipc/bindings";
import { externalToolsCtrl } from "../externaltools/externaltools.svelte.ts";
import { rangeSummaryCtrl } from "./rangesummary.svelte.ts";

const summary: RangeSummary = {
  from: "aaaaaaa",
  to: "bbbbbbb",
  mergeBase: "ccccccc",
  linear: false,
  ahead: 1,
  behind: 2,
  filesChanged: 3,
  additions: 3,
  deletions: 1,
  commits: [],
  truncated: false,
};

function diff(sinceFork: boolean): RangeDiff {
  return {
    from: sinceFork ? "ccccccc" : "aaaaaaa",
    to: "bbbbbbb",
    fromOid: sinceFork ? "c".repeat(40) : "a".repeat(40),
    toOid: "b".repeat(40),
    canSinceFork: true,
    sinceFork,
    filesChanged: 1,
    additions: 1,
    deletions: 0,
    truncated: false,
    fileTree: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rangeSummaryCtrl.closeDiff();
  rangeSummaryCtrl.close();
  vi.mocked(commands.commitRangeSummary).mockResolvedValue({ status: "ok", data: summary });
  vi.mocked(commands.commitRangeDiff).mockImplementation(async (_p, _a, _b, sinceFork) => ({ status: "ok", data: diff(sinceFork) }));
});

describe("rangeSummaryCtrl", () => {
  it("labels revision endpoints by name and short-shas an oid", async () => {
    await rangeSummaryCtrl.openAt("/r", "HEAD", "refs/heads/side", 0, 0, { a: "main", b: "side" });
    expect(commands.commitRangeSummary).toHaveBeenCalledWith("/r", "HEAD", "refs/heads/side");
    expect([rangeSummaryCtrl.aShort, rangeSummaryCtrl.bShort]).toEqual(["main", "side"]);

    await rangeSummaryCtrl.openAt("/r", "a".repeat(40), "b".repeat(40), 0, 0);
    expect([rangeSummaryCtrl.aShort, rangeSummaryCtrl.bShort]).toEqual(["aaaaaaa", "bbbbbbb"]);
  });

  it("opens tip to tip by default and since the fork on request", async () => {
    await rangeSummaryCtrl.openAt("/r", "HEAD", "refs/heads/side", 0, 0);
    await rangeSummaryCtrl.openDiff();
    expect(commands.commitRangeDiff).toHaveBeenLastCalledWith("/r", "HEAD", "refs/heads/side", false);
    expect(rangeSummaryCtrl.open).toBe(false);

    await rangeSummaryCtrl.openDiff(true);
    expect(commands.commitRangeDiff).toHaveBeenLastCalledWith("/r", "HEAD", "refs/heads/side", true);
    expect(rangeSummaryCtrl.diff?.sinceFork).toBe(true);
  });

  it("the toggle refetches only when it changes something", async () => {
    await rangeSummaryCtrl.openAt("/r", "x", "y", 0, 0);
    await rangeSummaryCtrl.openDiff();
    vi.mocked(commands.commitRangeDiff).mockClear();

    rangeSummaryCtrl.setSinceFork(false);
    expect(commands.commitRangeDiff).not.toHaveBeenCalled();

    rangeSummaryCtrl.setSinceFork(true);
    await vi.waitFor(() => expect(rangeSummaryCtrl.diff?.sinceFork).toBe(true));
    expect(commands.commitRangeDiff).toHaveBeenCalledWith("/r", "x", "y", true);
  });

  it("opens a file in the external tool with the diff's own two trees", async () => {
    await rangeSummaryCtrl.openAt("/r", "x", "y", 0, 0);
    await rangeSummaryCtrl.openDiff(true);
    rangeSummaryCtrl.openExternalDiff("src/a.ts");
    // The merge base, not the anchor: the tool must show what the modal shows.
    expect(externalToolsCtrl.openDiff).toHaveBeenCalledWith("/r", "src/a.ts", false, "c".repeat(40), "b".repeat(40));
  });

  it("does nothing for the external tool before a diff is loaded", () => {
    rangeSummaryCtrl.openExternalDiff("src/a.ts");
    expect(externalToolsCtrl.openDiff).not.toHaveBeenCalled();
  });
});
