// Tests for the .gitignore/.mailmap in-app editor controller (backlog #14,
// the FINAL backlog item).
//
// Same isolation strategy as danglingrecovery.svelte.test.ts / reflog's own
// test file: legacy/bridge is mocked so legacy/main.ts (a whole vanilla
// canvas app that boots on import) is never evaluated. IN_TAURI is a
// toggleable getter (same shape as dashboard.svelte.test.ts/
// pickaxesearch.svelte.test.ts) since this file exercises both the
// real-Tauri and design-mode-demo paths.
//
// workdirCtrl is imported REAL (unmocked), like resolver.svelte.test.ts does
// for the same module — `refreshStatus` is spied on rather than mocked out
// of a fake module, so the assertion that .gitignore saves trigger it (and
// .mailmap saves do NOT) verifies the actual wiring, not a stand-in.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    readRepoFile: vi.fn(),
    writeRepoFile: vi.fn(),
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
import { workdirCtrl } from "../workdir/workdir.svelte.ts";
import { repoFilesCtrl } from "./repofiles.svelte.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}

function resetCtrl() {
  repoFilesCtrl.open = false;
  repoFilesCtrl.file = ".gitignore";
  repoFilesCtrl.content = "";
  repoFilesCtrl.loading = false;
  repoFilesCtrl.error = "";
  repoFilesCtrl.busy = false;
  repoFilesCtrl.demo = false;
  mockInTauri = true;
  vi.clearAllMocks();
}

beforeEach(() => {
  resetCtrl();
});

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", () => {
    expect(document.getElementById("cv")).toBeNull();
    expect(repoFilesCtrl).toBeDefined();
  });
});

describe("load — real mode (IN_TAURI)", () => {
  it("loads .gitignore content on show()", async () => {
    vi.mocked(commands.readRepoFile).mockResolvedValueOnce(ok("node_modules/\n"));

    repoFilesCtrl.show("repo1");
    await Promise.resolve();
    await Promise.resolve();

    expect(commands.readRepoFile).toHaveBeenCalledWith("repo1", ".gitignore");
    expect(repoFilesCtrl.content).toBe("node_modules/\n");
    expect(repoFilesCtrl.error).toBe("");
    expect(repoFilesCtrl.open).toBe(true);
  });

  it("a missing file reads as empty content, not an error", async () => {
    vi.mocked(commands.readRepoFile).mockResolvedValueOnce(ok(""));

    await repoFilesCtrl.load("repo1", ".mailmap");

    expect(repoFilesCtrl.content).toBe("");
    expect(repoFilesCtrl.error).toBe("");
  });

  it("selectFile switches tabs and re-fetches the other file's content fresh", async () => {
    vi.mocked(commands.readRepoFile).mockResolvedValueOnce(ok("gitignore content\n"));
    await repoFilesCtrl.load("repo1", ".gitignore");
    expect(repoFilesCtrl.content).toBe("gitignore content\n");

    vi.mocked(commands.readRepoFile).mockResolvedValueOnce(ok("mailmap content\n"));
    repoFilesCtrl.selectFile(".mailmap");
    await Promise.resolve();
    await Promise.resolve();

    expect(commands.readRepoFile).toHaveBeenCalledWith("repo1", ".mailmap");
    expect(repoFilesCtrl.file).toBe(".mailmap");
    expect(repoFilesCtrl.content).toBe("mailmap content\n");
  });

  it("selectFile is a no-op while a save is in flight", () => {
    repoFilesCtrl.busy = true;
    repoFilesCtrl.file = ".gitignore";
    repoFilesCtrl.selectFile(".mailmap");

    expect(repoFilesCtrl.file).toBe(".gitignore");
    expect(commands.readRepoFile).not.toHaveBeenCalled();
  });

  it("selectFile is a no-op when already on that tab", () => {
    repoFilesCtrl.file = ".gitignore";
    repoFilesCtrl.selectFile(".gitignore");

    expect(commands.readRepoFile).not.toHaveBeenCalled();
  });

  it("surfaces an error and clears content when the read fails", async () => {
    vi.mocked(commands.readRepoFile).mockResolvedValueOnce(err("cannot open repository"));

    await repoFilesCtrl.load("repo1", ".gitignore");

    expect(repoFilesCtrl.content).toBe("");
    expect(repoFilesCtrl.error).toContain("cannot open repository");
  });

  it("a thrown IPC rejection on load surfaces an error too", async () => {
    vi.mocked(commands.readRepoFile).mockRejectedValueOnce(new Error("boom"));

    await repoFilesCtrl.load("repo1", ".gitignore");

    expect(repoFilesCtrl.content).toBe("");
    expect(repoFilesCtrl.error).toContain("boom");
  });

  it("shows a clean message instead of erroring when no repo is open", async () => {
    await repoFilesCtrl.load(null, ".gitignore");

    expect(commands.readRepoFile).not.toHaveBeenCalled();
    expect(repoFilesCtrl.content).toBe("");
    expect(repoFilesCtrl.error).toContain("Open a repository");
  });

  it("sets loading true while the request is in flight, false once settled", async () => {
    let resolveFn!: (v: { status: "ok"; data: string }) => void;
    vi.mocked(commands.readRepoFile).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFn = resolve;
      }),
    );
    const p = repoFilesCtrl.load("repo1", ".gitignore");
    expect(repoFilesCtrl.loading).toBe(true);
    resolveFn(ok(""));
    await p;
    expect(repoFilesCtrl.loading).toBe(false);
  });
});

describe("save — real mode", () => {
  it("calls writeRepoFile with the current file name + edited content", async () => {
    vi.spyOn(workdirCtrl, "refreshStatus").mockResolvedValueOnce(undefined);
    vi.mocked(commands.readRepoFile).mockResolvedValueOnce(ok("dist/\n"));
    await repoFilesCtrl.load("repo1", ".gitignore");
    repoFilesCtrl.content = "dist/\n*.log\n"; // simulate the user editing the loaded content
    vi.mocked(commands.writeRepoFile).mockResolvedValueOnce({ ok: true, message: "Saved .gitignore." });

    await repoFilesCtrl.save();

    expect(commands.writeRepoFile).toHaveBeenCalledWith("repo1", ".gitignore", "dist/\n*.log\n");
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
    expect(bridge.tama.warn).not.toHaveBeenCalled();
  });

  it("saving .gitignore triggers a workdir status refresh", async () => {
    const spy = vi.spyOn(workdirCtrl, "refreshStatus").mockResolvedValueOnce(undefined);
    vi.mocked(commands.readRepoFile).mockResolvedValueOnce(ok(""));
    await repoFilesCtrl.load("repo1", ".gitignore");
    vi.mocked(commands.writeRepoFile).mockResolvedValueOnce({ ok: true, message: "Saved .gitignore." });

    await repoFilesCtrl.save();

    expect(spy).toHaveBeenCalledWith("repo1");
  });

  it("saving .mailmap does NOT trigger a workdir status refresh", async () => {
    const spy = vi.spyOn(workdirCtrl, "refreshStatus").mockResolvedValueOnce(undefined);
    vi.mocked(commands.readRepoFile).mockResolvedValueOnce(ok(""));
    await repoFilesCtrl.load("repo1", ".mailmap");
    vi.mocked(commands.writeRepoFile).mockResolvedValueOnce({ ok: true, message: "Saved .mailmap." });

    await repoFilesCtrl.save();

    expect(commands.writeRepoFile).toHaveBeenCalledWith("repo1", ".mailmap", "");
    expect(spy).not.toHaveBeenCalled();
  });

  it("failure: warns via Tama and does not refresh workdir status", async () => {
    const spy = vi.spyOn(workdirCtrl, "refreshStatus").mockResolvedValueOnce(undefined);
    vi.mocked(commands.readRepoFile).mockResolvedValueOnce(ok(""));
    await repoFilesCtrl.load("repo1", ".gitignore");
    vi.mocked(commands.writeRepoFile).mockResolvedValueOnce({ ok: false, message: "Could not write .gitignore: permission denied" });

    await repoFilesCtrl.save();

    expect(bridge.tama.warn).toHaveBeenCalledWith("Could not write .gitignore: permission denied");
    expect(spy).not.toHaveBeenCalled();
    expect(repoFilesCtrl.busy).toBe(false);
  });

  it("a thrown IPC rejection on save warns via Tama and clears busy", async () => {
    vi.mocked(commands.readRepoFile).mockResolvedValueOnce(ok(""));
    await repoFilesCtrl.load("repo1", ".gitignore");
    vi.mocked(commands.writeRepoFile).mockRejectedValueOnce(new Error("boom"));

    await repoFilesCtrl.save();

    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(repoFilesCtrl.busy).toBe(false);
  });

  it("warns via Tama instead of saving without a repo", async () => {
    repoFilesCtrl.file = ".gitignore";
    await repoFilesCtrl.load(null, ".gitignore");

    await repoFilesCtrl.save();

    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(commands.writeRepoFile).not.toHaveBeenCalled();
  });

  it("is a no-op while a save is already in flight", async () => {
    vi.mocked(commands.readRepoFile).mockResolvedValueOnce(ok(""));
    await repoFilesCtrl.load("repo1", ".gitignore");
    repoFilesCtrl.busy = true;

    await repoFilesCtrl.save();

    expect(commands.writeRepoFile).not.toHaveBeenCalled();
  });
});

describe("show / close (Tools menu / ⌘K entry point)", () => {
  it("show() opens the panel on the .gitignore tab and loads its content", async () => {
    vi.mocked(commands.readRepoFile).mockResolvedValueOnce(ok("*.log\n"));

    repoFilesCtrl.show("repo1");

    expect(repoFilesCtrl.open).toBe(true);
    expect(repoFilesCtrl.file).toBe(".gitignore");
    await Promise.resolve();
    await Promise.resolve();
    expect(commands.readRepoFile).toHaveBeenCalledWith("repo1", ".gitignore");
  });

  it("close() is blocked while a save is in flight", () => {
    repoFilesCtrl.open = true;
    repoFilesCtrl.busy = true;
    repoFilesCtrl.close();
    expect(repoFilesCtrl.open).toBe(true);
  });

  it("close() otherwise closes it", () => {
    repoFilesCtrl.open = true;
    repoFilesCtrl.busy = false;
    repoFilesCtrl.close();
    expect(repoFilesCtrl.open).toBe(false);
  });
});

describe("demo mode", () => {
  beforeEach(() => {
    mockInTauri = false;
  });

  it("load seeds canned demo content without any IPC call", async () => {
    await repoFilesCtrl.load("whatever", ".gitignore");

    expect(repoFilesCtrl.demo).toBe(true);
    expect(repoFilesCtrl.content.length).toBeGreaterThan(0);
    expect(commands.readRepoFile).not.toHaveBeenCalled();
  });

  it("save in demo mode mutates nothing over IPC and still cheers via Tama", async () => {
    await repoFilesCtrl.load("whatever", ".gitignore");

    await repoFilesCtrl.save();

    expect(commands.writeRepoFile).not.toHaveBeenCalled();
    expect(bridge.tama.say).toHaveBeenCalled();
  });
});
