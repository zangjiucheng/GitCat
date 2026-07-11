// Tests for the Export Patches (range-export) controller — the
// Tools-menu/⌘K modal fronting patch.rs's `export_patch` for the two-revision
// range case (see exportpatches.svelte.ts's own doc comment). The
// commit-menu's single-commit "Export as Patch…" calls the same backend
// command directly with `from: null` — that path is exercised in
// commitmenu.svelte.test.ts, not here.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
}));

let mockInTauri = true;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    exportPatch: vi.fn(),
    currentUpstream: vi.fn(),
  },
}));

const saveMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => saveMock(...args),
}));

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { exportPatchesCtrl } from "./exportpatches.svelte.ts";

function ok(message = "Exported 2 commits to /tmp/out.patch."): { ok: true; message: string } {
  return { ok: true, message };
}
function fail(message: string): { ok: false; message: string } {
  return { ok: false, message };
}
function upstreamOk(data: string | null): { status: "ok"; data: string | null } {
  return { status: "ok", data };
}
function upstreamErr(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInTauri = true;
  exportPatchesCtrl.open = false;
  exportPatchesCtrl.from = "";
  exportPatchesCtrl.to = "HEAD";
  exportPatchesCtrl.busy = false;
  exportPatchesCtrl.error = "";
  exportPatchesCtrl.repo = "";
});

describe("show", () => {
  it("resets the form, defaults to to=HEAD, from=blank, and opens", () => {
    vi.mocked(commands.currentUpstream).mockResolvedValueOnce(upstreamOk(null));
    exportPatchesCtrl.show("/repo");

    expect(exportPatchesCtrl.open).toBe(true);
    expect(exportPatchesCtrl.repo).toBe("/repo");
    expect(exportPatchesCtrl.to).toBe("HEAD");
    expect(exportPatchesCtrl.from).toBe("");
    expect(exportPatchesCtrl.error).toBe("");
  });

  it("fills 'from' from current_upstream when one is configured", async () => {
    vi.mocked(commands.currentUpstream).mockResolvedValueOnce(upstreamOk("origin/main"));
    exportPatchesCtrl.show("/repo");
    // loadUpstreamDefault is fired-and-forgotten (void) inside show(); await a
    // microtask tick for the mocked promise to resolve and the field to fill.
    await Promise.resolve();
    await Promise.resolve();

    expect(commands.currentUpstream).toHaveBeenCalledWith("/repo");
    expect(exportPatchesCtrl.from).toBe("origin/main");
  });

  it("leaves 'from' blank when no upstream is configured", async () => {
    vi.mocked(commands.currentUpstream).mockResolvedValueOnce(upstreamOk(null));
    exportPatchesCtrl.show("/repo");
    await Promise.resolve();
    await Promise.resolve();

    expect(exportPatchesCtrl.from).toBe("");
  });

  it("does not clobber a value the user already typed before the upstream round trip resolved", async () => {
    let resolveUpstream!: (v: unknown) => void;
    vi.mocked(commands.currentUpstream).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveUpstream = resolve;
      }) as any,
    );
    exportPatchesCtrl.show("/repo");
    exportPatchesCtrl.from = "user-typed-value";

    resolveUpstream(upstreamOk("origin/main"));
    await Promise.resolve();
    await Promise.resolve();

    expect(exportPatchesCtrl.from).toBe("user-typed-value");
  });

  it("does not fill 'from' when the modal was closed again before the round trip resolved", async () => {
    let resolveUpstream!: (v: unknown) => void;
    vi.mocked(commands.currentUpstream).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveUpstream = resolve;
      }) as any,
    );
    exportPatchesCtrl.show("/repo");
    exportPatchesCtrl.open = false;

    resolveUpstream(upstreamOk("origin/main"));
    await Promise.resolve();
    await Promise.resolve();

    expect(exportPatchesCtrl.from).toBe("");
  });

  it("leaves 'from' blank if the current_upstream round trip errors", async () => {
    vi.mocked(commands.currentUpstream).mockResolvedValueOnce(upstreamErr("no repo"));
    exportPatchesCtrl.show("/repo");
    await Promise.resolve();
    await Promise.resolve();

    expect(exportPatchesCtrl.from).toBe("");
  });

  it("skips the upstream round trip entirely in demo (non-Tauri) mode", () => {
    mockInTauri = false;
    exportPatchesCtrl.show("/repo");
    expect(commands.currentUpstream).not.toHaveBeenCalled();
  });
});

describe("confirm — validation", () => {
  it("rejects an empty 'from'", async () => {
    exportPatchesCtrl.repo = "/repo";
    exportPatchesCtrl.from = "";
    exportPatchesCtrl.to = "HEAD";

    await exportPatchesCtrl.confirm();

    expect(exportPatchesCtrl.error).toMatch(/from/i);
    expect(saveMock).not.toHaveBeenCalled();
    expect(commands.exportPatch).not.toHaveBeenCalled();
  });

  it("rejects a leading-dash 'from'", async () => {
    exportPatchesCtrl.repo = "/repo";
    exportPatchesCtrl.from = "-x";
    exportPatchesCtrl.to = "HEAD";

    await exportPatchesCtrl.confirm();

    expect(exportPatchesCtrl.error).toMatch(/from/i);
    expect(commands.exportPatch).not.toHaveBeenCalled();
  });

  it("rejects an empty 'to'", async () => {
    exportPatchesCtrl.repo = "/repo";
    exportPatchesCtrl.from = "origin/main";
    exportPatchesCtrl.to = "";

    await exportPatchesCtrl.confirm();

    expect(exportPatchesCtrl.error).toMatch(/to/i);
    expect(commands.exportPatch).not.toHaveBeenCalled();
  });

  it("warns instead of proceeding when no repo is open", async () => {
    exportPatchesCtrl.repo = "";
    exportPatchesCtrl.from = "origin/main";
    exportPatchesCtrl.to = "HEAD";

    await exportPatchesCtrl.confirm();

    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });
});

describe("confirm — happy path", () => {
  it("opens save() with a from..to-derived filename, then calls export_patch with the exact repo/from/to/dest", async () => {
    exportPatchesCtrl.repo = "/repo";
    exportPatchesCtrl.from = "origin/main";
    exportPatchesCtrl.to = "HEAD";
    saveMock.mockResolvedValueOnce("/tmp/origin-main..HEAD.patch");
    vi.mocked(commands.exportPatch).mockResolvedValueOnce(ok("Exported 3 commits to /tmp/x.patch."));

    await exportPatchesCtrl.confirm();

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: "origin-main..HEAD.patch",
        filters: [{ name: "Patch files", extensions: ["patch"] }],
      }),
    );
    expect(commands.exportPatch).toHaveBeenCalledWith("/repo", "origin/main", "HEAD", "/tmp/origin-main..HEAD.patch");
    expect(exportPatchesCtrl.open).toBe(false);
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
    expect(bridge.tama.say).toHaveBeenCalledWith("Exported 3 commits to /tmp/x.patch.", 3600);
  });

  it("trims surrounding whitespace off from/to before calling the backend", async () => {
    exportPatchesCtrl.repo = "/repo";
    exportPatchesCtrl.from = "  origin/main  ";
    exportPatchesCtrl.to = "  HEAD  ";
    saveMock.mockResolvedValueOnce("/tmp/out.patch");
    vi.mocked(commands.exportPatch).mockResolvedValueOnce(ok());

    await exportPatchesCtrl.confirm();

    expect(commands.exportPatch).toHaveBeenCalledWith("/repo", "origin/main", "HEAD", "/tmp/out.patch");
  });

  it("does nothing (leaves the form open, untouched) when the save dialog is cancelled", async () => {
    exportPatchesCtrl.repo = "/repo";
    exportPatchesCtrl.from = "origin/main";
    exportPatchesCtrl.to = "HEAD";
    saveMock.mockResolvedValueOnce(null);

    await exportPatchesCtrl.confirm();

    expect(commands.exportPatch).not.toHaveBeenCalled();
    expect(exportPatchesCtrl.open).toBe(false); // unchanged from beforeEach's reset (false), not flipped
  });

  it("surfaces a failed export via the in-form error, keeping the modal open", async () => {
    exportPatchesCtrl.repo = "/repo";
    exportPatchesCtrl.open = true;
    exportPatchesCtrl.from = "origin/main";
    exportPatchesCtrl.to = "HEAD";
    saveMock.mockResolvedValueOnce("/tmp/out.patch");
    vi.mocked(commands.exportPatch).mockResolvedValueOnce(fail("Cannot resolve revision \"origin/main\": no reference found."));

    await exportPatchesCtrl.confirm();

    expect(exportPatchesCtrl.error).toBe('Cannot resolve revision "origin/main": no reference found.');
    expect(exportPatchesCtrl.open).toBe(true);
    expect(bridge.tama.set).not.toHaveBeenCalledWith("celebrate");
  });

  it("surfaces a thrown error via the in-form error too", async () => {
    exportPatchesCtrl.repo = "/repo";
    exportPatchesCtrl.open = true;
    exportPatchesCtrl.from = "origin/main";
    exportPatchesCtrl.to = "HEAD";
    saveMock.mockResolvedValueOnce("/tmp/out.patch");
    vi.mocked(commands.exportPatch).mockRejectedValueOnce(new Error("invoke failed"));

    await exportPatchesCtrl.confirm();

    expect(exportPatchesCtrl.error).toMatch(/invoke failed/);
    expect(exportPatchesCtrl.busy).toBe(false);
  });

  it("is a no-op while already busy (re-entrancy guard)", async () => {
    exportPatchesCtrl.repo = "/repo";
    exportPatchesCtrl.busy = true;
    exportPatchesCtrl.from = "origin/main";
    exportPatchesCtrl.to = "HEAD";

    await exportPatchesCtrl.confirm();

    expect(saveMock).not.toHaveBeenCalled();
    expect(commands.exportPatch).not.toHaveBeenCalled();
  });

  it("demo (non-Tauri) mode celebrates without opening a dialog or calling the backend", async () => {
    mockInTauri = false;
    exportPatchesCtrl.repo = "/repo";
    exportPatchesCtrl.from = "origin/main";
    exportPatchesCtrl.to = "HEAD";

    await exportPatchesCtrl.confirm();

    expect(saveMock).not.toHaveBeenCalled();
    expect(commands.exportPatch).not.toHaveBeenCalled();
    expect(exportPatchesCtrl.open).toBe(false);
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });
});

describe("close", () => {
  it("closes the modal when idle", () => {
    exportPatchesCtrl.open = true;
    exportPatchesCtrl.busy = false;
    exportPatchesCtrl.close();
    expect(exportPatchesCtrl.open).toBe(false);
  });

  it("refuses to close while an export is in flight", () => {
    exportPatchesCtrl.open = true;
    exportPatchesCtrl.busy = true;
    exportPatchesCtrl.close();
    expect(exportPatchesCtrl.open).toBe(true);
  });
});
