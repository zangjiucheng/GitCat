// Tests for the External Tools settings controller (backlog #12).
//
// Same isolation strategy as remotes/dashboard's own test files: legacy/
// bridge is mocked so legacy/main.ts (a whole vanilla canvas app that boots
// on import) is never evaluated. IN_TAURI is a toggleable getter (same shape
// as dashboard.svelte.test.ts/pickaxesearch.svelte.test.ts) since this file
// exercises both the real-Tauri and design-mode-demo paths — including
// `openDiff()`'s own demo branch, used directly by Detail.svelte/
// Workdir.svelte's file-row buttons.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  CUR_REPO: null,
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    getToolSettings: vi.fn(),
    setToolSettings: vi.fn(),
    openDiffTool: vi.fn(),
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
import type { ToolSettings } from "../../ipc/bindings";
import { externalToolsCtrl } from "./externaltools.svelte.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}

function settings(partial: Partial<ToolSettings> = {}): ToolSettings {
  return { diffTool: null, mergeTool: null, ...partial };
}

function resetCtrl() {
  externalToolsCtrl.open = false;
  externalToolsCtrl.loading = false;
  externalToolsCtrl.saving = false;
  externalToolsCtrl.error = "";
  externalToolsCtrl.demo = false;
  externalToolsCtrl.diffName = "";
  externalToolsCtrl.diffCmd = "";
  externalToolsCtrl.mergeName = "";
  externalToolsCtrl.mergeCmd = "";
  mockInTauri = true;
  vi.clearAllMocks();
}

beforeEach(() => {
  resetCtrl();
});

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", () => {
    expect(document.getElementById("cv")).toBeNull();
    expect(externalToolsCtrl).toBeDefined();
  });
});

describe("show / refresh — settings load", () => {
  it("show() opens the modal and loads the persisted settings", async () => {
    vi.mocked(commands.getToolSettings).mockResolvedValueOnce(
      ok(settings({ diffTool: { name: "meld", cmd: null }, mergeTool: { name: "mytool", cmd: "mytool $BASE $LOCAL $REMOTE $MERGED" } })),
    );

    externalToolsCtrl.show();
    expect(externalToolsCtrl.open).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(commands.getToolSettings).toHaveBeenCalledTimes(1);
    expect(externalToolsCtrl.diffName).toBe("meld");
    expect(externalToolsCtrl.diffCmd).toBe("");
    expect(externalToolsCtrl.mergeName).toBe("mytool");
    expect(externalToolsCtrl.mergeCmd).toBe("mytool $BASE $LOCAL $REMOTE $MERGED");
  });

  it("an unset slot loads back as blank fields, not an error", async () => {
    vi.mocked(commands.getToolSettings).mockResolvedValueOnce(ok(settings()));

    await externalToolsCtrl.refresh();

    expect(externalToolsCtrl.diffName).toBe("");
    expect(externalToolsCtrl.mergeName).toBe("");
    expect(externalToolsCtrl.error).toBe("");
  });

  it("surfaces a backend error without crashing", async () => {
    vi.mocked(commands.getToolSettings).mockResolvedValueOnce(err("could not read settings"));

    await externalToolsCtrl.refresh();

    expect(externalToolsCtrl.error).toContain("could not read settings");
  });

  it("rejected round trip is caught and surfaced as an error, not an unhandled rejection", async () => {
    vi.mocked(commands.getToolSettings).mockRejectedValueOnce(new Error("invoke failed"));

    await externalToolsCtrl.refresh();

    expect(externalToolsCtrl.error).toContain("invoke failed");
    expect(externalToolsCtrl.loading).toBe(false);
  });

  it("design mode (!IN_TAURI): no IPC call at all, fields stay whatever they already were", async () => {
    mockInTauri = false;

    await externalToolsCtrl.refresh();

    expect(commands.getToolSettings).not.toHaveBeenCalled();
    expect(externalToolsCtrl.demo).toBe(true);
  });
});

describe("save — whole-form overwrite", () => {
  it("sends both slots at once, trimmed, and re-applies the backend's own (normalized) response", async () => {
    externalToolsCtrl.diffName = "  meld  ";
    externalToolsCtrl.diffCmd = "   ";
    externalToolsCtrl.mergeName = "mytool";
    externalToolsCtrl.mergeCmd = "  mytool $BASE $LOCAL $REMOTE $MERGED  ";
    vi.mocked(commands.setToolSettings).mockResolvedValueOnce(
      ok(settings({ diffTool: { name: "meld", cmd: null }, mergeTool: { name: "mytool", cmd: "mytool $BASE $LOCAL $REMOTE $MERGED" } })),
    );

    await externalToolsCtrl.save();

    expect(commands.setToolSettings).toHaveBeenCalledWith(
      { name: "meld", cmd: null },
      { name: "mytool", cmd: "mytool $BASE $LOCAL $REMOTE $MERGED" },
    );
    expect(externalToolsCtrl.open).toBe(false);
    expect(bridge.tama.say).toHaveBeenCalled();
  });

  it("a blank name clears that slot to null (not an empty-string ExternalTool)", async () => {
    externalToolsCtrl.diffName = "";
    externalToolsCtrl.diffCmd = "some stray leftover cmd";
    externalToolsCtrl.mergeName = "";
    externalToolsCtrl.mergeCmd = "";
    vi.mocked(commands.setToolSettings).mockResolvedValueOnce(ok(settings()));

    await externalToolsCtrl.save();

    expect(commands.setToolSettings).toHaveBeenCalledWith(null, null);
  });

  it("surfaces a backend validation error (e.g. bad charset) without closing the modal", async () => {
    externalToolsCtrl.open = true;
    externalToolsCtrl.diffName = "diff.tool";
    vi.mocked(commands.setToolSettings).mockResolvedValueOnce(err("Tool name \"diff.tool\" may only contain letters, digits, '-' and '_'."));

    await externalToolsCtrl.save();

    expect(externalToolsCtrl.error).toContain("may only contain letters");
    expect(externalToolsCtrl.open).toBe(true);
  });

  it("re-entrancy guard: a save already in flight ignores a second call", async () => {
    externalToolsCtrl.saving = true;

    await externalToolsCtrl.save();

    expect(commands.setToolSettings).not.toHaveBeenCalled();
  });

  it("design mode (!IN_TAURI): no IPC call, just a Tama toast and modal close", async () => {
    mockInTauri = false;
    externalToolsCtrl.open = true;

    await externalToolsCtrl.save();

    expect(commands.setToolSettings).not.toHaveBeenCalled();
    expect(externalToolsCtrl.open).toBe(false);
    expect(bridge.tama.say).toHaveBeenCalled();
  });
});

describe("close", () => {
  it("is blocked while a save is in flight", () => {
    externalToolsCtrl.open = true;
    externalToolsCtrl.saving = true;

    externalToolsCtrl.close();

    expect(externalToolsCtrl.open).toBe(true);
  });

  it("otherwise closes it", () => {
    externalToolsCtrl.open = true;

    externalToolsCtrl.close();

    expect(externalToolsCtrl.open).toBe(false);
  });
});

// openDiff() is the single call site Detail.svelte's file-tree row and
// Workdir.svelte's staged/unstaged rows all call directly (see module doc) —
// these three cases are exactly the three row shapes those buttons wire up,
// each asserted with the EXACT argument shape that row passes.
describe("openDiff — the 3 call-site shapes", () => {
  it("workdir UNSTAGED row: staged=false, no revision range", async () => {
    vi.mocked(commands.openDiffTool).mockResolvedValueOnce(ok(null));

    await externalToolsCtrl.openDiff("/repo", "src/a.ts", false);

    expect(commands.openDiffTool).toHaveBeenCalledWith("/repo", "src/a.ts", false, null, null);
  });

  it("workdir STAGED row: staged=true, no revision range", async () => {
    vi.mocked(commands.openDiffTool).mockResolvedValueOnce(ok(null));

    await externalToolsCtrl.openDiff("/repo", "src/a.ts", true);

    expect(commands.openDiffTool).toHaveBeenCalledWith("/repo", "src/a.ts", true, null, null);
  });

  it("a historical commit's file (Detail.svelte): staged=false, fromRev=<sha>^, toRev=<sha>", async () => {
    vi.mocked(commands.openDiffTool).mockResolvedValueOnce(ok(null));

    await externalToolsCtrl.openDiff("/repo", "src/a.ts", false, "abc1234^", "abc1234");

    expect(commands.openDiffTool).toHaveBeenCalledWith("/repo", "src/a.ts", false, "abc1234^", "abc1234");
  });

  it("a clean refusal (no tool configured) is surfaced via Tama, never thrown", async () => {
    vi.mocked(commands.openDiffTool).mockResolvedValueOnce(err("No external diff tool configured. Set one via Tools ▸ External Tools…."));

    await externalToolsCtrl.openDiff("/repo", "src/a.ts", false);

    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("No external diff tool configured"));
  });

  it("a rejected round trip is caught and surfaced via Tama, not an unhandled rejection", async () => {
    vi.mocked(commands.openDiffTool).mockRejectedValueOnce(new Error("invoke failed"));

    await externalToolsCtrl.openDiff("/repo", "src/a.ts", false);

    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("invoke failed"));
  });

  it("design mode (!IN_TAURI): no IPC call, just a Tama toast", async () => {
    mockInTauri = false;

    await externalToolsCtrl.openDiff("/repo", "src/a.ts", false);

    expect(commands.openDiffTool).not.toHaveBeenCalled();
    expect(bridge.tama.say).toHaveBeenCalled();
  });
});
