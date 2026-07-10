// Tests for the reflog-rescue controller.
//
// Same isolation strategy as resolver.svelte.test.ts / bisect.svelte.test.ts:
// legacy/bridge is mocked so legacy/main.ts (a whole vanilla canvas app that
// boots on import) is never evaluated. See resolver.svelte.test.ts's header
// comment for the full rationale.
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
    reflog: vi.fn(),
    reflogRestore: vi.fn(),
  },
}));

// IN_TAURI is a live `const` computed from `window.__TAURI__` at import time —
// mock the module so each describe block can control it independently of
// jsdom's `window`.
vi.mock("../../ipc/env", () => ({ IN_TAURI: true }));

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import type { ReflogEntry, UndoResult } from "../../ipc/bindings";
import { reflogCtrl } from "./reflog.svelte.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}

const E0: ReflogEntry = { index: 0, sha: "abc1234", message: "reset: moving to abc1234", kind: "reset", committerName: "You", committerEmail: "you@x.com", ts: 0 };
const E1: ReflogEntry = { index: 1, sha: "def5678", message: "commit: wip", kind: "commit", committerName: "You", committerEmail: "you@x.com", ts: 0 };

function undoResult(partial: Partial<UndoResult>): UndoResult {
  return { ok: true, message: "", restoredTo: null, sealed: null, ...partial };
}

function resetCtrl() {
  reflogCtrl.open = false;
  reflogCtrl.entries = [];
  reflogCtrl.busy = false;
  reflogCtrl.error = "";
  reflogCtrl.demo = false;
  reflogCtrl.repo = "";
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCtrl();
});

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", () => {
    expect(document.getElementById("cv")).toBeNull();
    expect(reflogCtrl).toBeDefined();
  });
});

describe("refresh — real mode (IN_TAURI)", () => {
  it("populates entries from commands.reflog on success", async () => {
    vi.mocked(commands.reflog).mockResolvedValueOnce(ok([E0, E1]));

    await reflogCtrl.refresh("repo1");

    expect(commands.reflog).toHaveBeenCalledWith("repo1");
    expect(reflogCtrl.entries).toEqual([E0, E1]);
    expect(reflogCtrl.error).toBe("");
    expect(reflogCtrl.demo).toBe(false);
  });

  it("surfaces an error and clears the list when the read fails", async () => {
    vi.mocked(commands.reflog).mockResolvedValueOnce(err("cannot open repository"));

    await reflogCtrl.refresh("repo1");

    expect(reflogCtrl.entries).toEqual([]);
    expect(reflogCtrl.error).toContain("cannot open repository");
  });

  it("clears the list without erroring when no repo is open", async () => {
    await reflogCtrl.refresh(null);

    expect(commands.reflog).not.toHaveBeenCalled();
    expect(reflogCtrl.entries).toEqual([]);
    expect(reflogCtrl.error).toBe("");
  });
});

describe("restore — real mode", () => {
  it("success: reloads the graph, Tama celebrates, and the list is re-pulled", async () => {
    reflogCtrl.repo = "repo1";
    reflogCtrl.entries = [E0, E1];
    vi.mocked(commands.reflogRestore).mockResolvedValueOnce(
      undoResult({ ok: true, message: "Restored to HEAD@{1} (def5678).", restoredTo: "def5678", sealed: "refs/gitgui/backup/x" }),
    );
    vi.mocked(commands.reflog).mockResolvedValueOnce(ok([E1]));

    await reflogCtrl.restore(1);

    expect(commands.reflogRestore).toHaveBeenCalledWith("repo1", 1);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
    expect(bridge.tama.say).toHaveBeenCalled();
    expect(bridge.tama.warn).not.toHaveBeenCalled();
    expect(commands.reflog).toHaveBeenCalledWith("repo1"); // re-pulled after restore
    expect(reflogCtrl.entries).toEqual([E1]);
    expect(reflogCtrl.busy).toBe(false);
  });

  it("failure: warns via Tama, does NOT reload the graph, and does not eat the failure", async () => {
    reflogCtrl.repo = "repo1";
    reflogCtrl.entries = [E0, E1];
    vi.mocked(commands.reflogRestore).mockResolvedValueOnce(
      undoResult({ ok: false, message: "Working tree has uncommitted changes.", restoredTo: null, sealed: null }),
    );

    await reflogCtrl.restore(0);

    expect(bridge.tama.warn).toHaveBeenCalledWith("Working tree has uncommitted changes.");
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
    expect(reflogCtrl.entries).toEqual([E0, E1]);
    expect(reflogCtrl.busy).toBe(false);
  });

  it("warns via Tama instead of restoring without a repo", async () => {
    reflogCtrl.repo = "";

    await reflogCtrl.restore(0);

    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(commands.reflogRestore).not.toHaveBeenCalled();
  });

  it("a thrown IPC rejection warns via Tama and clears busy", async () => {
    reflogCtrl.repo = "repo1";
    vi.mocked(commands.reflogRestore).mockRejectedValueOnce(new Error("boom"));

    await reflogCtrl.restore(0);

    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
    expect(reflogCtrl.busy).toBe(false);
  });
});

describe("show / close (Tools menu / ⌘K entry point)", () => {
  it("show() opens the panel and re-fetches", async () => {
    vi.mocked(commands.reflog).mockResolvedValueOnce(ok([E0]));
    reflogCtrl.show("repo1");
    expect(reflogCtrl.open).toBe(true);
    await Promise.resolve(); // let the fire-and-forget refresh() settle
    expect(commands.reflog).toHaveBeenCalledWith("repo1");
  });

  it("close() is blocked while a restore is in flight", () => {
    reflogCtrl.open = true;
    reflogCtrl.busy = true;
    reflogCtrl.close();
    expect(reflogCtrl.open).toBe(true);
  });

  it("close() otherwise closes it", () => {
    reflogCtrl.open = true;
    reflogCtrl.close();
    expect(reflogCtrl.open).toBe(false);
  });
});

describe("demo mode", () => {
  it("refresh seeds the canned demo list without any IPC call when !IN_TAURI", async () => {
    vi.resetModules();
    vi.doMock("../../ipc/env", () => ({ IN_TAURI: false }));
    const { reflogCtrl: demoCtrl } = await import("./reflog.svelte.ts");

    await demoCtrl.refresh("whatever");

    expect(demoCtrl.demo).toBe(true);
    expect(demoCtrl.entries.length).toBeGreaterThan(0);
    expect(commands.reflog).not.toHaveBeenCalled();
  });

  it("restore in demo mode mutates nothing over IPC and still cheers via Tama", async () => {
    vi.resetModules();
    vi.doMock("../../ipc/env", () => ({ IN_TAURI: false }));
    const bridgeDemo = await import("../../legacy/bridge");
    const bindingsDemo = await import("../../ipc/bindings");
    const { reflogCtrl: demoCtrl } = await import("./reflog.svelte.ts");

    await demoCtrl.refresh("whatever");
    await demoCtrl.restore(0);

    expect(bindingsDemo.commands.reflogRestore).not.toHaveBeenCalled();
    expect(bridgeDemo.tama.say).toHaveBeenCalled();
  });
});
