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
    suggestCommitMsgCommand: vi.fn(),
    saveNamedTool: vi.fn(),
    removeNamedTool: vi.fn(),
    setActiveTool: vi.fn(),
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
  return {
    diffTool: null,
    mergeTool: null,
    commitMsgCommand: null,
    tools: [],
    activeDiffToolId: null,
    activeMergeToolId: null,
    activeCommitToolId: null,
    ...partial,
  };
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
  externalToolsCtrl.commitCmd = "";
  externalToolsCtrl.suggesting = false;
  externalToolsCtrl.tools = [];
  externalToolsCtrl.activeDiffToolId = null;
  externalToolsCtrl.activeMergeToolId = null;
  externalToolsCtrl.activeCommitToolId = null;
  externalToolsCtrl.toolsBusy = false;
  externalToolsCtrl.resetToolForm();
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
      null,
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

    expect(commands.setToolSettings).toHaveBeenCalledWith(null, null, null);
  });

  it("saves the commit-message command (trimmed; blank => null)", async () => {
    externalToolsCtrl.commitCmd = "  aicommit  ";
    vi.mocked(commands.setToolSettings).mockResolvedValueOnce(ok(settings({ commitMsgCommand: "aicommit" })));
    await externalToolsCtrl.save();
    expect(commands.setToolSettings).toHaveBeenCalledWith(null, null, "aicommit");

    externalToolsCtrl.commitCmd = "   ";
    vi.mocked(commands.setToolSettings).mockResolvedValueOnce(ok(settings()));
    await externalToolsCtrl.save();
    expect(commands.setToolSettings).toHaveBeenLastCalledWith(null, null, null);
  });

  it("loads the commit-message command from settings into the form", async () => {
    vi.mocked(commands.getToolSettings).mockResolvedValueOnce(ok(settings({ commitMsgCommand: "opencommit --dry-run" })));
    await externalToolsCtrl.refresh();
    expect(externalToolsCtrl.commitCmd).toBe("opencommit --dry-run");
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

describe("suggestOllama — one-click prefill of an ollama commit-message command", () => {
  it("fills the command box (not saved) when the backend returns a suggestion", async () => {
    mockInTauri = true;
    vi.mocked(commands.suggestCommitMsgCommand).mockResolvedValueOnce(
      ok('git diff --staged | ollama run llama3.2 --hidethinking "write a commit message"'),
    );
    await externalToolsCtrl.suggestOllama();
    expect(externalToolsCtrl.commitCmd).toBe('git diff --staged | ollama run llama3.2 --hidethinking "write a commit message"');
    // Prefill only — never auto-saves.
    expect(commands.setToolSettings).not.toHaveBeenCalled();
    expect(externalToolsCtrl.error).toBe("");
  });

  it("explains when ollama isn't set up (backend returns null), leaving the box untouched", async () => {
    mockInTauri = true;
    externalToolsCtrl.commitCmd = "my-existing";
    vi.mocked(commands.suggestCommitMsgCommand).mockResolvedValueOnce(ok(null));
    await externalToolsCtrl.suggestOllama();
    expect(externalToolsCtrl.commitCmd).toBe("my-existing");
    expect(externalToolsCtrl.error).toMatch(/ollama/i);
  });

  it("surfaces a backend error", async () => {
    mockInTauri = true;
    vi.mocked(commands.suggestCommitMsgCommand).mockResolvedValueOnce(err("boom"));
    await externalToolsCtrl.suggestOllama();
    expect(externalToolsCtrl.error).toBe("boom");
  });

  it("is a demo no-op outside Tauri (never calls the command)", async () => {
    mockInTauri = false;
    await externalToolsCtrl.suggestOllama();
    expect(commands.suggestCommitMsgCommand).not.toHaveBeenCalled();
  });
});

// PER-44: named tools — add / remove / select active, alongside the singleton
// fields. Each CRUD command returns the whole ToolSettings, which the
// controller re-applies (same re-render-without-a-round-trip contract as
// remotes).
describe("named tools (PER-44)", () => {
  it("refresh() loads the named-tools list and the active selection into state", async () => {
    vi.mocked(commands.getToolSettings).mockResolvedValueOnce(
      ok(
        settings({
          tools: [
            { id: "vscode", name: "VS Code", kind: "diff", cmd: "code --diff $LOCAL $REMOTE" },
            { id: "kdiff3", name: "KDiff3", kind: "merge", cmd: "kdiff3 $BASE $LOCAL $REMOTE -o $MERGED" },
          ],
          activeDiffToolId: "vscode",
        }),
      ),
    );

    await externalToolsCtrl.refresh();

    expect(externalToolsCtrl.tools).toHaveLength(2);
    expect(externalToolsCtrl.activeDiffToolId).toBe("vscode");
    expect(externalToolsCtrl.isActive({ id: "vscode", name: "VS Code", kind: "diff", cmd: "x" })).toBe(true);
    expect(externalToolsCtrl.isActive({ id: "kdiff3", name: "KDiff3", kind: "merge", cmd: "x" })).toBe(false);
  });

  it("saveTool() upserts via saveNamedTool and re-applies the backend's returned settings", async () => {
    externalToolsCtrl.formId = "  vscode  ";
    externalToolsCtrl.formName = "  VS Code  ";
    externalToolsCtrl.formKind = "diff";
    externalToolsCtrl.formCmd = "  code --diff $LOCAL $REMOTE  ";
    vi.mocked(commands.saveNamedTool).mockResolvedValueOnce(
      ok(settings({ tools: [{ id: "vscode", name: "VS Code", kind: "diff", cmd: "code --diff $LOCAL $REMOTE" }] })),
    );

    await externalToolsCtrl.saveTool();

    // Sent trimmed; the id field is the upsert key.
    expect(commands.saveNamedTool).toHaveBeenCalledWith({ id: "vscode", name: "VS Code", kind: "diff", cmd: "code --diff $LOCAL $REMOTE" });
    expect(externalToolsCtrl.tools).toHaveLength(1);
    // The form resets after a successful save.
    expect(externalToolsCtrl.formId).toBe("");
    expect(externalToolsCtrl.editingId).toBeNull();
  });

  it("saveTool() with any blank field is a local validation error, no IPC call", async () => {
    externalToolsCtrl.formId = "vscode";
    externalToolsCtrl.formName = "";
    externalToolsCtrl.formCmd = "code";

    await externalToolsCtrl.saveTool();

    expect(commands.saveNamedTool).not.toHaveBeenCalled();
    expect(externalToolsCtrl.error).toContain("id, a name and a command");
  });

  it("saveTool() surfaces a backend validation error (e.g. bad id charset)", async () => {
    externalToolsCtrl.formId = "vscode";
    externalToolsCtrl.formName = "VS Code";
    externalToolsCtrl.formCmd = "code";
    vi.mocked(commands.saveNamedTool).mockResolvedValueOnce(err('Tool id "my.tool" must start with a lowercase letter'));

    await externalToolsCtrl.saveTool();

    expect(externalToolsCtrl.error).toContain("must start with a lowercase letter");
    // On error the form is NOT reset (the user can fix and retry).
    expect(externalToolsCtrl.formId).toBe("vscode");
  });

  it("startEditTool() loads a tool into the form and pins its id; Update keeps id fixed", async () => {
    externalToolsCtrl.startEditTool({ id: "vscode", name: "VS Code", kind: "diff", cmd: "code --diff $LOCAL $REMOTE" });
    expect(externalToolsCtrl.editingId).toBe("vscode");
    expect(externalToolsCtrl.formName).toBe("VS Code");

    externalToolsCtrl.formCmd = "code --wait --diff $LOCAL $REMOTE";
    vi.mocked(commands.saveNamedTool).mockResolvedValueOnce(
      ok(settings({ tools: [{ id: "vscode", name: "VS Code", kind: "diff", cmd: "code --wait --diff $LOCAL $REMOTE" }] })),
    );
    await externalToolsCtrl.saveTool();
    expect(commands.saveNamedTool).toHaveBeenCalledWith({ id: "vscode", name: "VS Code", kind: "diff", cmd: "code --wait --diff $LOCAL $REMOTE" });
  });

  it("removeTool() calls removeNamedTool and re-applies the returned settings", async () => {
    externalToolsCtrl.tools = [{ id: "vscode", name: "VS Code", kind: "diff", cmd: "code" }];
    vi.mocked(commands.removeNamedTool).mockResolvedValueOnce(ok(settings()));

    await externalToolsCtrl.removeTool("vscode");

    expect(commands.removeNamedTool).toHaveBeenCalledWith("vscode");
    expect(externalToolsCtrl.tools).toHaveLength(0);
  });

  it("toggleActive() selects an inactive tool, then clears it when already active", async () => {
    const tool = { id: "vscode", name: "VS Code", kind: "diff" as const, cmd: "code" };
    externalToolsCtrl.tools = [tool];

    // Not active yet -> selects it.
    vi.mocked(commands.setActiveTool).mockResolvedValueOnce(ok(settings({ tools: [tool], activeDiffToolId: "vscode" })));
    await externalToolsCtrl.toggleActive(tool);
    expect(commands.setActiveTool).toHaveBeenLastCalledWith("diff", "vscode");
    expect(externalToolsCtrl.activeDiffToolId).toBe("vscode");

    // Now active -> toggling clears it (null).
    vi.mocked(commands.setActiveTool).mockResolvedValueOnce(ok(settings({ tools: [tool], activeDiffToolId: null })));
    await externalToolsCtrl.toggleActive(tool);
    expect(commands.setActiveTool).toHaveBeenLastCalledWith("diff", null);
    expect(externalToolsCtrl.activeDiffToolId).toBeNull();
  });

  it("re-entrancy: a named-tool op already in flight ignores a second call", async () => {
    externalToolsCtrl.toolsBusy = true;
    externalToolsCtrl.formId = "vscode";
    externalToolsCtrl.formName = "VS Code";
    externalToolsCtrl.formCmd = "code";

    await externalToolsCtrl.saveTool();
    await externalToolsCtrl.removeTool("vscode");
    await externalToolsCtrl.setActive("diff", "vscode");

    expect(commands.saveNamedTool).not.toHaveBeenCalled();
    expect(commands.removeNamedTool).not.toHaveBeenCalled();
    expect(commands.setActiveTool).not.toHaveBeenCalled();
  });

  it("design mode (!IN_TAURI): named-tool CRUD mutates locally with no IPC call", async () => {
    mockInTauri = false;
    externalToolsCtrl.demo = true;
    externalToolsCtrl.formId = "vscode";
    externalToolsCtrl.formName = "VS Code";
    externalToolsCtrl.formKind = "diff";
    externalToolsCtrl.formCmd = "code --diff $LOCAL $REMOTE";

    await externalToolsCtrl.saveTool();
    expect(commands.saveNamedTool).not.toHaveBeenCalled();
    expect(externalToolsCtrl.tools).toHaveLength(1);

    await externalToolsCtrl.setActive("diff", "vscode");
    expect(commands.setActiveTool).not.toHaveBeenCalled();
    expect(externalToolsCtrl.activeDiffToolId).toBe("vscode");

    await externalToolsCtrl.removeTool("vscode");
    expect(commands.removeNamedTool).not.toHaveBeenCalled();
    expect(externalToolsCtrl.tools).toHaveLength(0);
    // Removing the active tool clears the selection locally too.
    expect(externalToolsCtrl.activeDiffToolId).toBeNull();
  });
});
