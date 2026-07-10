// Tests for the Manage Remotes controller.
//
// Same isolation strategy as reflog/plumbing's own test files: legacy/bridge
// is mocked so legacy/main.ts (a whole vanilla canvas app that boots on
// import) is never evaluated. See resolver.svelte.test.ts's header comment
// for the full rationale. IN_TAURI is mocked per-describe-block via
// vi.doMock + dynamic import, same reason plumbing's own test file gives.
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
  CUR_REPO: null,
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    listRemotes: vi.fn(),
    addRemote: vi.fn(),
    renameRemote: vi.fn(),
    setRemoteUrl: vi.fn(),
    removeRemote: vi.fn(),
  },
}));

vi.mock("../../ipc/env", () => ({ IN_TAURI: true }));

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import type { RemoteEntry, RemoteResult } from "../../ipc/bindings";
import { remotesCtrl } from "./remotes.svelte.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}
function result(partial: Partial<RemoteResult>): RemoteResult {
  return { ok: true, message: "", backupRef: null, ...partial };
}

const ORIGIN: RemoteEntry = { name: "origin", url: "https://example.com/acme/gitcat.git", pushUrl: null };
const UPSTREAM: RemoteEntry = {
  name: "upstream",
  url: "https://example.com/upstream/gitcat.git",
  pushUrl: "git@example.com:acme/gitcat.git",
};

function resetCtrl() {
  remotesCtrl.open = false;
  remotesCtrl.remotes = [];
  remotesCtrl.loading = false;
  remotesCtrl.busy = false;
  remotesCtrl.busyTarget = null;
  remotesCtrl.error = "";
  remotesCtrl.demo = false;
  remotesCtrl.newName = "";
  remotesCtrl.newUrl = "";
  remotesCtrl.renamingName = null;
  remotesCtrl.renameInput = "";
  remotesCtrl.editingUrlName = null;
  remotesCtrl.editUrlInput = "";
  remotesCtrl.removingName = null;
  remotesCtrl.repo = "";
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCtrl();
});

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", () => {
    expect(document.getElementById("cv")).toBeNull();
    expect(remotesCtrl).toBeDefined();
  });
});

describe("refresh — real mode (IN_TAURI)", () => {
  it("populates remotes from commands.listRemotes on success", async () => {
    vi.mocked(commands.listRemotes).mockResolvedValueOnce(ok([ORIGIN, UPSTREAM]));

    await remotesCtrl.refresh("repo1");

    expect(commands.listRemotes).toHaveBeenCalledWith("repo1");
    expect(remotesCtrl.remotes).toEqual([ORIGIN, UPSTREAM]);
    expect(remotesCtrl.error).toBe("");
    expect(remotesCtrl.demo).toBe(false);
    expect(remotesCtrl.loading).toBe(false);
  });

  it("surfaces an error and clears the list when the read fails", async () => {
    vi.mocked(commands.listRemotes).mockResolvedValueOnce(err("cannot open repository"));

    await remotesCtrl.refresh("repo1");

    expect(remotesCtrl.remotes).toEqual([]);
    expect(remotesCtrl.error).toContain("cannot open repository");
  });

  it("a thrown IPC rejection is caught, not propagated", async () => {
    vi.mocked(commands.listRemotes).mockRejectedValueOnce(new Error("invoke failed"));

    await expect(remotesCtrl.refresh("repo1")).resolves.toBeUndefined();
    expect(remotesCtrl.remotes).toEqual([]);
    expect(remotesCtrl.error).toContain("invoke failed");
  });

  it("clears the list without erroring when no repo is open", async () => {
    await remotesCtrl.refresh(null);

    expect(commands.listRemotes).not.toHaveBeenCalled();
    expect(remotesCtrl.remotes).toEqual([]);
    expect(remotesCtrl.error).toBe("");
  });
});

describe("show / close (Tools menu / ⌘K entry point)", () => {
  it("show() opens the panel and re-fetches", async () => {
    vi.mocked(commands.listRemotes).mockResolvedValueOnce(ok([ORIGIN]));
    remotesCtrl.show("repo1");
    expect(remotesCtrl.open).toBe(true);
    await Promise.resolve(); // let the fire-and-forget refresh() settle
    expect(commands.listRemotes).toHaveBeenCalledWith("repo1");
  });

  it("close() is blocked while a mutation is in flight", () => {
    remotesCtrl.open = true;
    remotesCtrl.busy = true;
    remotesCtrl.close();
    expect(remotesCtrl.open).toBe(true);
  });

  it("close() otherwise closes it and clears any in-progress row form", () => {
    remotesCtrl.open = true;
    remotesCtrl.renamingName = "origin";
    remotesCtrl.removingName = "upstream";
    remotesCtrl.close();
    expect(remotesCtrl.open).toBe(false);
    expect(remotesCtrl.renamingName).toBeNull();
    expect(remotesCtrl.removingName).toBeNull();
  });
});

describe("addRemote", () => {
  it("happy path: adds, clears the form, refreshes the list AND reloads the graph (sidebar refresh)", async () => {
    remotesCtrl.repo = "repo1";
    remotesCtrl.newName = "origin";
    remotesCtrl.newUrl = "https://example.com/acme/gitcat.git";
    vi.mocked(commands.addRemote).mockResolvedValueOnce(result({ ok: true, message: "Added remote origin." }));
    vi.mocked(commands.listRemotes).mockResolvedValueOnce(ok([ORIGIN]));

    await remotesCtrl.addRemote();

    expect(commands.addRemote).toHaveBeenCalledWith("repo1", "origin", "https://example.com/acme/gitcat.git");
    expect(remotesCtrl.newName).toBe("");
    expect(remotesCtrl.newUrl).toBe("");
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(commands.listRemotes).toHaveBeenCalledWith("repo1"); // this modal's own list re-pulled
    expect(remotesCtrl.remotes).toEqual([ORIGIN]);
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
    expect(remotesCtrl.busy).toBe(false);
    expect(remotesCtrl.busyTarget).toBeNull();
  });

  it("failure: warns via Tama, does not clear the form, does not refresh", async () => {
    remotesCtrl.repo = "repo1";
    remotesCtrl.newName = "origin";
    remotesCtrl.newUrl = "bad";
    vi.mocked(commands.addRemote).mockResolvedValueOnce(result({ ok: false, message: "error: remote origin already exists." }));

    await remotesCtrl.addRemote();

    expect(bridge.tama.warn).toHaveBeenCalledWith("error: remote origin already exists.");
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
    expect(remotesCtrl.newName).toBe("origin"); // kept, so the user isn't forced to retype
  });

  it("blank name or url: no-ops without calling the backend", async () => {
    remotesCtrl.repo = "repo1";
    remotesCtrl.newName = "  ";
    remotesCtrl.newUrl = "https://example.com/x.git";

    await remotesCtrl.addRemote();

    expect(commands.addRemote).not.toHaveBeenCalled();
  });

  it("no repo open: warns without calling the backend", async () => {
    remotesCtrl.newName = "origin";
    remotesCtrl.newUrl = "https://example.com/x.git";

    await remotesCtrl.addRemote();

    expect(commands.addRemote).not.toHaveBeenCalled();
    expect(bridge.tama.warn).toHaveBeenCalledWith("Open a repository first.");
  });
});

describe("rename flow", () => {
  it("startRename seeds the input with the current name; confirmRename renames + refreshes", async () => {
    remotesCtrl.repo = "repo1";
    remotesCtrl.remotes = [ORIGIN];

    remotesCtrl.startRename("origin");
    expect(remotesCtrl.renamingName).toBe("origin");
    expect(remotesCtrl.renameInput).toBe("origin");

    remotesCtrl.renameInput = "upstream";
    vi.mocked(commands.renameRemote).mockResolvedValueOnce(result({ ok: true, message: "Renamed origin → upstream." }));
    vi.mocked(commands.listRemotes).mockResolvedValueOnce(ok([{ ...ORIGIN, name: "upstream" }]));

    await remotesCtrl.confirmRename();

    expect(commands.renameRemote).toHaveBeenCalledWith("repo1", "origin", "upstream");
    expect(remotesCtrl.renamingName).toBeNull();
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(remotesCtrl.remotes[0].name).toBe("upstream");
  });

  it("unchanged/blank name just cancels the form, no backend call", async () => {
    remotesCtrl.startRename("origin");
    remotesCtrl.renameInput = "origin";
    await remotesCtrl.confirmRename();
    expect(commands.renameRemote).not.toHaveBeenCalled();
    expect(remotesCtrl.renamingName).toBeNull();
  });

  it("failure: warns via Tama and leaves the form open", async () => {
    remotesCtrl.repo = "repo1";
    remotesCtrl.startRename("origin");
    remotesCtrl.renameInput = "upstream";
    vi.mocked(commands.renameRemote).mockResolvedValueOnce(result({ ok: false, message: "error: remote upstream already exists." }));

    await remotesCtrl.confirmRename();

    expect(bridge.tama.warn).toHaveBeenCalledWith("error: remote upstream already exists.");
    expect(remotesCtrl.renamingName).toBe("origin");
  });

  it("cancelRename clears the row form", () => {
    remotesCtrl.startRename("origin");
    remotesCtrl.cancelRename();
    expect(remotesCtrl.renamingName).toBeNull();
    expect(remotesCtrl.renameInput).toBe("");
  });
});

describe("set-url (edit URL) flow", () => {
  it("startEditUrl seeds the input with the current URL; confirmEditUrl updates + refreshes", async () => {
    remotesCtrl.repo = "repo1";
    remotesCtrl.startEditUrl("origin", ORIGIN.url);
    expect(remotesCtrl.editingUrlName).toBe("origin");
    expect(remotesCtrl.editUrlInput).toBe(ORIGIN.url);

    remotesCtrl.editUrlInput = "https://example.com/acme/renamed.git";
    vi.mocked(commands.setRemoteUrl).mockResolvedValueOnce(result({ ok: true, message: "Updated origin's URL." }));
    vi.mocked(commands.listRemotes).mockResolvedValueOnce(ok([{ ...ORIGIN, url: "https://example.com/acme/renamed.git" }]));

    await remotesCtrl.confirmEditUrl();

    expect(commands.setRemoteUrl).toHaveBeenCalledWith("repo1", "origin", "https://example.com/acme/renamed.git");
    expect(remotesCtrl.editingUrlName).toBeNull();
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(remotesCtrl.remotes[0].url).toBe("https://example.com/acme/renamed.git");
  });

  it("failure: warns via Tama and leaves the form open", async () => {
    remotesCtrl.repo = "repo1";
    remotesCtrl.startEditUrl("origin", ORIGIN.url);
    remotesCtrl.editUrlInput = "not a url but not empty";
    vi.mocked(commands.setRemoteUrl).mockResolvedValueOnce(result({ ok: false, message: "error: No such remote 'origin'" }));

    await remotesCtrl.confirmEditUrl();

    expect(bridge.tama.warn).toHaveBeenCalledWith("error: No such remote 'origin'");
    expect(remotesCtrl.editingUrlName).toBe("origin");
  });
});

describe("remove flow (inline confirm, no armDanger)", () => {
  it("startRemove arms the row without calling the backend", () => {
    remotesCtrl.startRemove("origin");
    expect(remotesCtrl.removingName).toBe("origin");
    expect(commands.removeRemote).not.toHaveBeenCalled();
  });

  it("cancelRemove disarms without calling the backend", () => {
    remotesCtrl.startRemove("origin");
    remotesCtrl.cancelRemove();
    expect(remotesCtrl.removingName).toBeNull();
    expect(commands.removeRemote).not.toHaveBeenCalled();
  });

  it("confirmRemove: removes, clears the confirm, refreshes the list AND the sidebar (reloadGraph)", async () => {
    remotesCtrl.repo = "repo1";
    remotesCtrl.remotes = [ORIGIN, UPSTREAM];
    remotesCtrl.startRemove("upstream");
    vi.mocked(commands.removeRemote).mockResolvedValueOnce(result({ ok: true, message: "Removed remote upstream." }));
    vi.mocked(commands.listRemotes).mockResolvedValueOnce(ok([ORIGIN]));

    await remotesCtrl.confirmRemove("upstream");

    expect(commands.removeRemote).toHaveBeenCalledWith("repo1", "upstream");
    expect(remotesCtrl.removingName).toBeNull();
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(remotesCtrl.remotes).toEqual([ORIGIN]);
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });

  it("failure: warns via Tama, does not refresh, leaves the confirm armed", async () => {
    remotesCtrl.repo = "repo1";
    remotesCtrl.startRemove("origin");
    vi.mocked(commands.removeRemote).mockResolvedValueOnce(result({ ok: false, message: "error: No such remote: 'origin'" }));

    await remotesCtrl.confirmRemove("origin");

    expect(bridge.tama.warn).toHaveBeenCalledWith("error: No such remote: 'origin'");
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
    expect(remotesCtrl.removingName).toBe("origin");
  });

  it("a thrown IPC rejection warns via Tama and clears busy", async () => {
    remotesCtrl.repo = "repo1";
    vi.mocked(commands.removeRemote).mockRejectedValueOnce(new Error("boom"));

    await remotesCtrl.confirmRemove("origin");

    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(remotesCtrl.busy).toBe(false);
  });

  it("no repo open: warns without calling the backend", async () => {
    await remotesCtrl.confirmRemove("origin");

    expect(commands.removeRemote).not.toHaveBeenCalled();
    expect(bridge.tama.warn).toHaveBeenCalledWith("Open a repository first.");
  });
});

describe("demo mode", () => {
  it("refresh seeds the canned demo list without any IPC call when !IN_TAURI", async () => {
    vi.resetModules();
    vi.doMock("../../ipc/env", () => ({ IN_TAURI: false }));
    const { remotesCtrl: demoCtrl } = await import("./remotes.svelte.ts");

    await demoCtrl.refresh("whatever");

    expect(demoCtrl.demo).toBe(true);
    expect(demoCtrl.remotes.length).toBeGreaterThan(0);
    expect(commands.listRemotes).not.toHaveBeenCalled();
  });

  it("addRemote in demo mode mutates nothing over IPC and still cheers via Tama", async () => {
    vi.resetModules();
    vi.doMock("../../ipc/env", () => ({ IN_TAURI: false }));
    const bridgeDemo = await import("../../legacy/bridge");
    const bindingsDemo = await import("../../ipc/bindings");
    const { remotesCtrl: demoCtrl } = await import("./remotes.svelte.ts");

    await demoCtrl.refresh("whatever");
    demoCtrl.newName = "fork";
    demoCtrl.newUrl = "https://example.com/fork.git";
    await demoCtrl.addRemote();

    expect(bindingsDemo.commands.addRemote).not.toHaveBeenCalled();
    expect(bridgeDemo.tama.say).toHaveBeenCalled();
    expect(demoCtrl.newName).toBe("");
  });

  it("confirmRemove in demo mode mutates nothing over IPC and still cheers via Tama", async () => {
    vi.resetModules();
    vi.doMock("../../ipc/env", () => ({ IN_TAURI: false }));
    const bridgeDemo = await import("../../legacy/bridge");
    const bindingsDemo = await import("../../ipc/bindings");
    const { remotesCtrl: demoCtrl } = await import("./remotes.svelte.ts");

    await demoCtrl.refresh("whatever");
    demoCtrl.startRemove("origin");
    await demoCtrl.confirmRemove("origin");

    expect(bindingsDemo.commands.removeRemote).not.toHaveBeenCalled();
    expect(bridgeDemo.tama.say).toHaveBeenCalled();
    expect(demoCtrl.removingName).toBeNull();
  });
});
