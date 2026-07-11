// Tests for the Apply Patch controller — the Tools-menu/⌘K entry point
// fronting patch.rs's `apply_patch` (`git am --3way`). No island UI of its
// own (mirrors forcepush.svelte.ts's shape) — picks a file via
// @tauri-apps/plugin-dialog's open(), calls the backend, then hands the
// result to the shared resolver.svelte.ts conflict UI tagged "am" (see
// applypatch.svelte.ts's own doc comment for the full "am" vs "rebase"
// disambiguation rationale).
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
    applyPatch: vi.fn(),
  },
}));

const openMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
}));

vi.mock("../resolver/resolver.svelte.ts", () => ({
  resolver: {
    openFromResult: vi.fn(async () => {}),
  },
}));

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { resolver } from "../resolver/resolver.svelte.ts";
import { applyPatchCtrl } from "./applypatch.svelte.ts";

function clean(message = "Applied 2 commits via git am."): {
  ok: true;
  state: "clean";
  conflictedFiles: string[];
  message: string;
  backupRef: string | null;
} {
  return { ok: true, state: "clean", conflictedFiles: [], message, backupRef: null };
}
function conflict(files: string[], message = "Applying the patch conflicts in 1 file. Resolve them, then Continue — or Skip this commit, or Abort."): {
  ok: false;
  state: "conflict";
  conflictedFiles: string[];
  message: string;
  backupRef: string | null;
} {
  return { ok: false, state: "conflict", conflictedFiles: files, message, backupRef: "refs/gitcat/backup/1" };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInTauri = true;
  applyPatchCtrl.busy = false;
});

describe("applyPatch", () => {
  it("warns instead of opening a dialog when no repo is open", async () => {
    await applyPatchCtrl.applyPatch("");

    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(openMock).not.toHaveBeenCalled();
  });

  it("opens a single-select file dialog scoped to patch-like extensions", async () => {
    openMock.mockResolvedValueOnce(null); // cancelled — just inspect the call shape
    await applyPatchCtrl.applyPatch("/repo");

    expect(openMock).toHaveBeenCalledWith(
      expect.objectContaining({
        multiple: false,
        filters: [{ name: "Patch files", extensions: ["patch", "mbox", "eml", "txt"] }],
      }),
    );
  });

  it("does nothing when the file dialog is cancelled", async () => {
    openMock.mockResolvedValueOnce(null);
    await applyPatchCtrl.applyPatch("/repo");

    expect(commands.applyPatch).not.toHaveBeenCalled();
    expect(resolver.openFromResult).not.toHaveBeenCalled();
  });

  it("calls apply_patch with the exact repo and picked file path, then hands a clean result to the resolver tagged 'am'", async () => {
    openMock.mockResolvedValueOnce("/tmp/feature.patch");
    vi.mocked(commands.applyPatch).mockResolvedValueOnce(clean("Applied 2 commits via git am."));

    await applyPatchCtrl.applyPatch("/repo");

    expect(commands.applyPatch).toHaveBeenCalledWith("/repo", "/tmp/feature.patch");
    expect(resolver.openFromResult).toHaveBeenCalledWith("/repo", clean("Applied 2 commits via git am."), "", "am");
  });

  it("hands a conflict result to the resolver the same way, with the real conflicted-file list", async () => {
    openMock.mockResolvedValueOnce("/tmp/feature.patch");
    const res = conflict(["src/lib.rs"]);
    vi.mocked(commands.applyPatch).mockResolvedValueOnce(res);

    await applyPatchCtrl.applyPatch("/repo");

    expect(resolver.openFromResult).toHaveBeenCalledWith("/repo", res, "", "am");
  });

  it("warns instead of throwing if the file dialog itself errors", async () => {
    openMock.mockRejectedValueOnce(new Error("dialog plugin unavailable"));

    await applyPatchCtrl.applyPatch("/repo");

    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("dialog plugin unavailable"));
    expect(commands.applyPatch).not.toHaveBeenCalled();
  });

  it("warns instead of throwing if the backend call itself rejects", async () => {
    openMock.mockResolvedValueOnce("/tmp/feature.patch");
    vi.mocked(commands.applyPatch).mockRejectedValueOnce(new Error("invoke failed"));

    await applyPatchCtrl.applyPatch("/repo");

    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("invoke failed"));
    expect(resolver.openFromResult).not.toHaveBeenCalled();
    expect(applyPatchCtrl.busy).toBe(false);
  });

  it("is a no-op while already busy (re-entrancy guard)", async () => {
    let resolveOpen!: (v: unknown) => void;
    openMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOpen = resolve;
      }),
    );
    const first = applyPatchCtrl.applyPatch("/repo");
    // busy flips true only after the dialog resolves and the backend call
    // starts, so drive the dialog forward first.
    resolveOpen("/tmp/feature.patch");
    vi.mocked(commands.applyPatch).mockResolvedValueOnce(clean());
    await Promise.resolve();

    const second = applyPatchCtrl.applyPatch("/repo");
    await Promise.all([first, second]);

    expect(openMock).toHaveBeenCalledTimes(1);
  });

  it("demo (non-Tauri) mode celebrates without opening a dialog or calling the backend", async () => {
    mockInTauri = false;
    await applyPatchCtrl.applyPatch("/repo");

    expect(openMock).not.toHaveBeenCalled();
    expect(commands.applyPatch).not.toHaveBeenCalled();
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });
});
