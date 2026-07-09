// Tests for the sidebar (refs tree + branch context menu) controller.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  CUR_REPO: "/repo",
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
  reloadGraph: vi.fn(async () => {}),
  armDanger: vi.fn(),
  updateBranchPill: vi.fn(),
  relTime: (t: number) => t + "s ago",
}));

let mockInTauri = false;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    listRefs: vi.fn(),
    checkout: vi.fn(),
    createBranch: vi.fn(),
    deleteBranch: vi.fn(),
    createTag: vi.fn(),
    deleteTag: vi.fn(),
    pushTag: vi.fn(),
    submoduleStatus: vi.fn(),
    submoduleInit: vi.fn(),
    submoduleUpdate: vi.fn(),
    submoduleAdd: vi.fn(),
    submoduleSync: vi.fn(),
  },
}));

vi.mock("../resolver/resolver.svelte.ts", () => ({
  resolver: {
    openDemo: vi.fn(),
    startRebase: vi.fn(async () => {}),
  },
}));

import * as bridge from "../../legacy/bridge";
import { commands } from "../../ipc/bindings";
import { resolver } from "../resolver/resolver.svelte.ts";
import { sidebarCtrl, submoduleAction, SUBMODULES_ALL, SUBMODULES_SYNC_ALL } from "./sidebar.svelte.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}

function resetAll() {
  sidebarCtrl.locals = [];
  sidebarCtrl.remotes = [];
  sidebarCtrl.tags = [];
  sidebarCtrl.submodules = [];
  sidebarCtrl.head = null;
  sidebarCtrl.snapshots = [];
  sidebarCtrl.filter = "";
  sidebarCtrl.busy = false;
  sidebarCtrl.menu = null;
  sidebarCtrl.tagMenu = null;
  sidebarCtrl.newTagOpen = false;
  sidebarCtrl.newTagName = "";
  sidebarCtrl.newTagMessage = "";
  sidebarCtrl.newTagFrom = "";
  sidebarCtrl.hasRepo = false;
  sidebarCtrl.copiedSnapshotSha = "";
  sidebarCtrl.submodulesRecursive = false;
  sidebarCtrl.newSubmoduleOpen = false;
  sidebarCtrl.newSubmoduleUrl = "";
  sidebarCtrl.newSubmodulePath = "";
  sidebarCtrl.newSubmoduleBranch = "";
  mockInTauri = false;
  vi.clearAllMocks();
  // Default: no submodules, so the many pre-existing "refresh"/checkout/etc.
  // tests below that never touch submodule_status at all don't have to care
  // that refresh() now also fires it in parallel — only the "submodules"
  // describe block overrides this per-test.
  vi.mocked(commands.submoduleStatus).mockResolvedValue(ok([]));
}

beforeEach(() => {
  resetAll();
});

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", () => {
    expect(document.getElementById("cv")).toBeNull();
    expect(sidebarCtrl).toBeDefined();
  });
});

describe("refresh", () => {
  it("design mode: seeds demo refs and updates the branch pill", async () => {
    mockInTauri = false;
    await sidebarCtrl.refresh("/repo");
    expect(sidebarCtrl.locals.length).toBeGreaterThan(0);
    expect(sidebarCtrl.head).toBe("main");
    expect(sidebarCtrl.hasRepo).toBe(true);
    expect(commands.listRefs).not.toHaveBeenCalled();
    expect(bridge.updateBranchPill).toHaveBeenCalled();
  });

  it("real mode: populates from commands.listRefs", async () => {
    mockInTauri = true;
    vi.mocked(commands.listRefs).mockResolvedValueOnce(
      ok({
        head: "main",
        locals: [{ name: "main", sha: "abc1234", ahead: 1, behind: 0 }],
        remotes: [{ name: "origin/main", sha: "abc1234" }],
        tags: [{ name: "v1.0.0", sha: "abc1234" }],
      }),
    );
    await sidebarCtrl.refresh("/repo");
    expect(sidebarCtrl.locals).toEqual([{ name: "main", sha: "abc1234", ahead: 1, behind: 0 }]);
    expect(sidebarCtrl.head).toBe("main");
    expect(sidebarCtrl.hasRepo).toBe(true);
    expect(bridge.updateBranchPill).toHaveBeenCalledWith("main", sidebarCtrl.locals);
  });

  it("real mode: logs and leaves ref state untouched on error, but hasRepo still flips (a repo IS open, listing just failed)", async () => {
    mockInTauri = true;
    vi.mocked(commands.listRefs).mockResolvedValueOnce(err("repo not found"));
    await sidebarCtrl.refresh("/repo");
    expect(sidebarCtrl.locals).toEqual([]);
    expect(sidebarCtrl.hasRepo).toBe(true);
  });

  it("real mode: no-ops without a repo path, hasRepo stays false", async () => {
    mockInTauri = true;
    await sidebarCtrl.refresh("");
    expect(commands.listRefs).not.toHaveBeenCalled();
    expect(commands.submoduleStatus).not.toHaveBeenCalled();
    expect(sidebarCtrl.hasRepo).toBe(false);
  });
});

describe("submodules", () => {
  it("design mode: seeds demo submodules covering all 5 statuses", async () => {
    mockInTauri = false;
    await sidebarCtrl.refresh("/repo");
    expect(sidebarCtrl.submodules.length).toBeGreaterThan(0);
    expect(commands.submoduleStatus).not.toHaveBeenCalled();
    expect(new Set(sidebarCtrl.submodules.map((s) => s.status))).toEqual(new Set(["clean", "dirty", "out-of-date", "not-initialized", "conflicted"]));
  });

  it("real mode: populates from commands.submoduleStatus, in parallel with list_refs", async () => {
    mockInTauri = true;
    vi.mocked(commands.listRefs).mockResolvedValueOnce(ok({ head: "main", locals: [], remotes: [], tags: [] }));
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(
      ok([
        { name: "vendor/a", path: "vendor/a", url: "https://example.com/a.git", status: "clean", headSha: "aaa1111", workdirSha: "aaa1111" },
        { name: "vendor/b", path: "vendor/b", url: "https://example.com/b.git", status: "dirty", headSha: "bbb2222", workdirSha: "bbb2222" },
      ]),
    );
    await sidebarCtrl.refresh("/repo");
    expect(commands.submoduleStatus).toHaveBeenCalledWith("/repo");
    expect(sidebarCtrl.submodules).toEqual([
      { name: "vendor/a", path: "vendor/a", url: "https://example.com/a.git", status: "clean", headSha: "aaa1111", workdirSha: "aaa1111" },
      { name: "vendor/b", path: "vendor/b", url: "https://example.com/b.git", status: "dirty", headSha: "bbb2222", workdirSha: "bbb2222" },
    ]);
  });

  it("real mode: each of the 5 backend statuses passes through to state unchanged (the view keys its status chip color off this exact string)", async () => {
    mockInTauri = true;
    const fixture = [
      { name: "a", path: "a", url: null, status: "not-initialized", headSha: "sha1", workdirSha: null },
      { name: "b", path: "b", url: null, status: "out-of-date", headSha: "sha2", workdirSha: "sha3" },
      { name: "c", path: "c", url: null, status: "dirty", headSha: "sha4", workdirSha: "sha4" },
      { name: "d", path: "d", url: null, status: "clean", headSha: "sha5", workdirSha: "sha5" },
      { name: "e", path: "e", url: null, status: "conflicted", headSha: "sha6", workdirSha: "sha7" },
    ];
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(ok(fixture));
    await sidebarCtrl.refresh("/repo");
    expect(sidebarCtrl.submodules.map((s) => s.status)).toEqual(["not-initialized", "out-of-date", "dirty", "clean", "conflicted"]);
  });

  it("real mode: a conflicted submodule (Bug 3 — merge-conflicted gitlink) reports differing head/workdir shas, never 'clean'", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(
      ok([{ name: "sub", path: "sub", url: null, status: "conflicted", headSha: "c1c1c1c", workdirSha: "c0c0c0c" }]),
    );
    await sidebarCtrl.refresh("/repo");
    expect(sidebarCtrl.submodules).toEqual([{ name: "sub", path: "sub", url: null, status: "conflicted", headSha: "c1c1c1c", workdirSha: "c0c0c0c" }]);
    expect(sidebarCtrl.submodules[0].status).not.toBe("clean");
  });

  it("real mode: empty list clears submodules", async () => {
    mockInTauri = true;
    sidebarCtrl.submodules = [{ name: "old", path: "old", url: null, status: "clean", headSha: "x", workdirSha: "x" }];
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(ok([]));
    await sidebarCtrl.refresh("/repo");
    expect(sidebarCtrl.submodules).toEqual([]);
  });

  it("real mode: logs and leaves submodule state untouched on error", async () => {
    mockInTauri = true;
    const prior = [{ name: "old", path: "old", url: null, status: "clean", headSha: "x", workdirSha: "x" }];
    sidebarCtrl.submodules = prior;
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(err("not a repo"));
    await sidebarCtrl.refresh("/repo");
    expect(sidebarCtrl.submodules).toEqual(prior);
  });

  it("real mode: a list_refs failure doesn't block submodule_status from firing (independent, parallel reads)", async () => {
    mockInTauri = true;
    vi.mocked(commands.listRefs).mockResolvedValueOnce(err("repo not found"));
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(
      ok([{ name: "vendor/a", path: "vendor/a", url: null, status: "clean", headSha: "aaa", workdirSha: "aaa" }]),
    );
    await sidebarCtrl.refresh("/repo");
    expect(sidebarCtrl.submodules).toEqual([{ name: "vendor/a", path: "vendor/a", url: null, status: "clean", headSha: "aaa", workdirSha: "aaa" }]);
  });
});

describe("submoduleAction (row action gate)", () => {
  it("not-initialized -> init", () => {
    expect(submoduleAction("not-initialized")).toBe("init");
  });

  it("out-of-date -> update", () => {
    expect(submoduleAction("out-of-date")).toBe("update");
  });

  it("dirty -> blocked (a disabled button is shown, not absent)", () => {
    expect(submoduleAction("dirty")).toBe("blocked");
  });

  it("conflicted -> blocked", () => {
    expect(submoduleAction("conflicted")).toBe("blocked");
  });

  it("clean -> null (no action button at all)", () => {
    expect(submoduleAction("clean")).toBeNull();
  });
});

describe("initAndUpdateSubmodule (per-row 'Init + update', not-initialized rows)", () => {
  it("design mode is a cosmetic no-op with a toast", async () => {
    mockInTauri = false;
    await sidebarCtrl.initAndUpdateSubmodule("docs/theme");
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("demo"));
    expect(commands.submoduleUpdate).not.toHaveBeenCalled();
  });

  it("real mode: calls submodule_update with init:true, recursive:false and refreshes on success", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleUpdate).mockResolvedValueOnce({ ok: true, message: "initialized", backupRef: null });
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(
      ok([{ name: "docs/theme", path: "docs/theme", url: "https://example.com/theme.git", status: "clean", headSha: "a", workdirSha: "a" }]),
    );
    await sidebarCtrl.initAndUpdateSubmodule("docs/theme");
    expect(commands.submoduleUpdate).toHaveBeenCalledWith("/repo", "docs/theme", false, true);
    expect(commands.submoduleStatus).toHaveBeenCalledWith("/repo");
    expect(sidebarCtrl.submodules[0].status).toBe("clean");
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });

  it("real mode: a refusal surfaces via tama.warn and does not refresh (not a silent no-op)", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleUpdate).mockResolvedValueOnce({ ok: false, message: "submodule has local changes, update refused", backupRef: null });
    await sidebarCtrl.initAndUpdateSubmodule("docs/theme");
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("update refused"));
    expect(commands.submoduleStatus).not.toHaveBeenCalled();
  });

  it("is re-entrancy locked while busy", async () => {
    mockInTauri = true;
    sidebarCtrl.busy = true;
    await sidebarCtrl.initAndUpdateSubmodule("docs/theme");
    expect(commands.submoduleUpdate).not.toHaveBeenCalled();
  });

  it("scopes busy/busyTarget to just the acted-on row (not the whole Submodules section) while in flight", async () => {
    mockInTauri = true;
    let resolveFn!: (v: { ok: boolean; message: string; backupRef: string | null }) => void;
    vi.mocked(commands.submoduleUpdate).mockImplementationOnce(() => new Promise((resolve) => (resolveFn = resolve)));
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(ok([]));
    const pending = sidebarCtrl.initAndUpdateSubmodule("docs/theme");
    expect(sidebarCtrl.busy).toBe(true);
    expect(sidebarCtrl.busyTarget).toBe("docs/theme");
    resolveFn({ ok: true, message: "initialized", backupRef: null });
    await pending;
    expect(sidebarCtrl.busy).toBe(false);
    expect(sidebarCtrl.busyTarget).toBeNull();
  });
});

describe("updateSubmodule (per-row 'Update', out-of-date rows)", () => {
  it("design mode is a cosmetic no-op with a toast", async () => {
    mockInTauri = false;
    await sidebarCtrl.updateSubmodule("third_party/tool");
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("demo"));
    expect(commands.submoduleUpdate).not.toHaveBeenCalled();
  });

  it("real mode: calls submodule_update with init:false (already registered+cloned) and refreshes on success", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleUpdate).mockResolvedValueOnce({ ok: true, message: "updated", backupRef: null });
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(
      ok([{ name: "third_party/tool", path: "third_party/tool", url: null, status: "clean", headSha: "a", workdirSha: "a" }]),
    );
    await sidebarCtrl.updateSubmodule("third_party/tool");
    expect(commands.submoduleUpdate).toHaveBeenCalledWith("/repo", "third_party/tool", false, false);
    expect(commands.submoduleStatus).toHaveBeenCalledWith("/repo");
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });

  it("real mode: a refusal (dirty submodule) surfaces via tama.warn and does not refresh", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleUpdate).mockResolvedValueOnce({ ok: false, message: "submodule has local changes, update refused", backupRef: null });
    await sidebarCtrl.updateSubmodule("third_party/tool");
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("update refused"));
    expect(commands.submoduleStatus).not.toHaveBeenCalled();
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
  });

  it("is re-entrancy locked while busy", async () => {
    mockInTauri = true;
    sidebarCtrl.busy = true;
    await sidebarCtrl.updateSubmodule("third_party/tool");
    expect(commands.submoduleUpdate).not.toHaveBeenCalled();
  });
});

describe("updateAllSubmodules (bulk 'Update all')", () => {
  it("design mode is a cosmetic no-op with a toast", async () => {
    mockInTauri = false;
    await sidebarCtrl.updateAllSubmodules(false);
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("demo"));
    expect(commands.submoduleUpdate).not.toHaveBeenCalled();
  });

  it("real mode: calls submodule_update with submodulePath:null and init:true, passing the recursive flag through", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleUpdate).mockResolvedValueOnce({ ok: true, message: "updated", backupRef: null });
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(ok([]));
    await sidebarCtrl.updateAllSubmodules(true);
    expect(commands.submoduleUpdate).toHaveBeenCalledWith("/repo", null, true, true);
  });

  it("real mode: recursive:false is passed through unchanged when the toggle is off", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleUpdate).mockResolvedValueOnce({ ok: true, message: "updated", backupRef: null });
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(ok([]));
    await sidebarCtrl.updateAllSubmodules(false);
    expect(commands.submoduleUpdate).toHaveBeenCalledWith("/repo", null, false, true);
  });

  it("real mode: a refusal surfaces via tama.warn and does not refresh", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleUpdate).mockResolvedValueOnce({ ok: false, message: "submodule has local changes, update refused", backupRef: null });
    await sidebarCtrl.updateAllSubmodules(false);
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("update refused"));
    expect(commands.submoduleStatus).not.toHaveBeenCalled();
  });

  it("is re-entrancy locked while busy", async () => {
    mockInTauri = true;
    sidebarCtrl.busy = true;
    await sidebarCtrl.updateAllSubmodules(true);
    expect(commands.submoduleUpdate).not.toHaveBeenCalled();
  });

  it("uses the SUBMODULES_ALL sentinel as busyTarget while in flight (distinct from any row's path)", async () => {
    mockInTauri = true;
    let resolveFn!: (v: { ok: boolean; message: string; backupRef: string | null }) => void;
    vi.mocked(commands.submoduleUpdate).mockImplementationOnce(() => new Promise((resolve) => (resolveFn = resolve)));
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(ok([]));
    const pending = sidebarCtrl.updateAllSubmodules(false);
    expect(sidebarCtrl.busy).toBe(true);
    expect(sidebarCtrl.busyTarget).toBe(SUBMODULES_ALL);
    resolveFn({ ok: true, message: "updated", backupRef: null });
    await pending;
    expect(sidebarCtrl.busyTarget).toBeNull();
  });
});

describe("syncSubmodule (per-row 'Sync', any status)", () => {
  it("design mode is a cosmetic no-op with a toast", async () => {
    mockInTauri = false;
    await sidebarCtrl.syncSubmodule("vendor/a");
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("demo"));
    expect(commands.submoduleSync).not.toHaveBeenCalled();
  });

  it("real mode: calls submodule_sync with recursive:false and cheers on success", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleSync).mockResolvedValueOnce({ ok: true, message: "synced", backupRef: null });
    await sidebarCtrl.syncSubmodule("vendor/a");
    expect(commands.submoduleSync).toHaveBeenCalledWith("/repo", "vendor/a", false);
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });

  it("real mode: a failure surfaces via tama.warn", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleSync).mockResolvedValueOnce({ ok: false, message: "no url found for submodule path", backupRef: null });
    await sidebarCtrl.syncSubmodule("vendor/a");
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("no url found"));
  });

  it("is re-entrancy locked while busy", async () => {
    mockInTauri = true;
    sidebarCtrl.busy = true;
    await sidebarCtrl.syncSubmodule("vendor/a");
    expect(commands.submoduleSync).not.toHaveBeenCalled();
  });

  it("scopes busy/busyTarget to just the acted-on row (not the whole Submodules section) while in flight", async () => {
    mockInTauri = true;
    let resolveFn!: (v: { ok: boolean; message: string; backupRef: string | null }) => void;
    vi.mocked(commands.submoduleSync).mockImplementationOnce(() => new Promise((resolve) => (resolveFn = resolve)));
    const pending = sidebarCtrl.syncSubmodule("vendor/a");
    expect(sidebarCtrl.busy).toBe(true);
    expect(sidebarCtrl.busyTarget).toBe("vendor/a");
    resolveFn({ ok: true, message: "synced", backupRef: null });
    await pending;
    expect(sidebarCtrl.busy).toBe(false);
    expect(sidebarCtrl.busyTarget).toBeNull();
  });
});

describe("syncAllSubmodules (bulk 'Sync all')", () => {
  it("design mode is a cosmetic no-op with a toast", async () => {
    mockInTauri = false;
    await sidebarCtrl.syncAllSubmodules(false);
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("demo"));
    expect(commands.submoduleSync).not.toHaveBeenCalled();
  });

  it("real mode: calls submodule_sync with submodulePath:null, passing the recursive flag through", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleSync).mockResolvedValueOnce({ ok: true, message: "synced", backupRef: null });
    await sidebarCtrl.syncAllSubmodules(true);
    expect(commands.submoduleSync).toHaveBeenCalledWith("/repo", null, true);
  });

  it("real mode: recursive:false is passed through unchanged when the toggle is off", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleSync).mockResolvedValueOnce({ ok: true, message: "synced", backupRef: null });
    await sidebarCtrl.syncAllSubmodules(false);
    expect(commands.submoduleSync).toHaveBeenCalledWith("/repo", null, false);
  });

  it("real mode: a failure surfaces via tama.warn", async () => {
    mockInTauri = true;
    vi.mocked(commands.submoduleSync).mockResolvedValueOnce({ ok: false, message: "no url found for submodule path", backupRef: null });
    await sidebarCtrl.syncAllSubmodules(false);
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("no url found"));
  });

  it("is re-entrancy locked while busy", async () => {
    mockInTauri = true;
    sidebarCtrl.busy = true;
    await sidebarCtrl.syncAllSubmodules(true);
    expect(commands.submoduleSync).not.toHaveBeenCalled();
  });

  it("uses the SUBMODULES_SYNC_ALL sentinel as busyTarget while in flight (distinct from SUBMODULES_ALL and any row's path)", async () => {
    mockInTauri = true;
    let resolveFn!: (v: { ok: boolean; message: string; backupRef: string | null }) => void;
    vi.mocked(commands.submoduleSync).mockImplementationOnce(() => new Promise((resolve) => (resolveFn = resolve)));
    const pending = sidebarCtrl.syncAllSubmodules(false);
    expect(sidebarCtrl.busy).toBe(true);
    expect(sidebarCtrl.busyTarget).toBe(SUBMODULES_SYNC_ALL);
    expect(sidebarCtrl.busyTarget).not.toBe(SUBMODULES_ALL);
    resolveFn({ ok: true, message: "synced", backupRef: null });
    await pending;
    expect(sidebarCtrl.busyTarget).toBeNull();
  });
});

describe("checkout", () => {
  it("design mode is a cosmetic no-op with a toast", async () => {
    mockInTauri = false;
    await sidebarCtrl.checkout("feature");
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("demo"));
    expect(commands.checkout).not.toHaveBeenCalled();
  });

  it("real mode: reloads the graph and cheers on success", async () => {
    mockInTauri = true;
    vi.mocked(commands.checkout).mockResolvedValueOnce({ ok: true, message: "", backupRef: null });
    await sidebarCtrl.checkout("feature");
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });

  it("real mode: warns on failure without reloading", async () => {
    mockInTauri = true;
    vi.mocked(commands.checkout).mockResolvedValueOnce({ ok: false, message: "dirty tree", backupRef: null });
    await sidebarCtrl.checkout("feature");
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("dirty tree"));
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
  });

  it("is re-entrancy locked while busy", async () => {
    mockInTauri = true;
    sidebarCtrl.busy = true;
    await sidebarCtrl.checkout("feature");
    expect(commands.checkout).not.toHaveBeenCalled();
  });
});

describe("checkoutRemote", () => {
  it("with no matching local branch: creates one tracking the remote ref", async () => {
    mockInTauri = true;
    vi.mocked(commands.createBranch).mockResolvedValueOnce({ ok: true, message: "", backupRef: null });
    await sidebarCtrl.checkoutRemote("origin/feature-x");
    expect(commands.createBranch).toHaveBeenCalledWith("/repo", "feature-x", "origin/feature-x", true);
    expect(commands.checkout).not.toHaveBeenCalled();
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
  });

  it("with an existing local branch of the same short name: switches to it instead of creating a duplicate", async () => {
    mockInTauri = true;
    sidebarCtrl.locals = [{ name: "feature-x", sha: "a1", ahead: null, behind: null }];
    vi.mocked(commands.checkout).mockResolvedValueOnce({ ok: true, message: "", backupRef: null });
    await sidebarCtrl.checkoutRemote("origin/feature-x");
    expect(commands.checkout).toHaveBeenCalledWith("/repo", "feature-x");
    expect(commands.createBranch).not.toHaveBeenCalled();
  });

  it("design mode is a cosmetic no-op with a toast", async () => {
    mockInTauri = false;
    await sidebarCtrl.checkoutRemote("origin/feature-x");
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("demo"));
    expect(commands.createBranch).not.toHaveBeenCalled();
  });

  it("is re-entrancy locked while busy", async () => {
    mockInTauri = true;
    sidebarCtrl.busy = true;
    await sidebarCtrl.checkoutRemote("origin/feature-x");
    expect(commands.createBranch).not.toHaveBeenCalled();
  });
});

describe("newBranch", () => {
  it("startNewBranch opens the inline input, cancelNewBranch closes it", () => {
    sidebarCtrl.startNewBranch();
    expect(sidebarCtrl.newBranchOpen).toBe(true);
    sidebarCtrl.newBranchInput = "wip";
    sidebarCtrl.cancelNewBranch();
    expect(sidebarCtrl.newBranchOpen).toBe(false);
    expect(sidebarCtrl.newBranchInput).toBe("");
  });

  it("confirmNewBranch does nothing (just closes) on an empty/blank name", async () => {
    sidebarCtrl.startNewBranch();
    sidebarCtrl.newBranchInput = "   ";
    await sidebarCtrl.confirmNewBranch();
    expect(sidebarCtrl.newBranchOpen).toBe(false);
    expect(commands.createBranch).not.toHaveBeenCalled();
  });

  it("real mode: creates the branch from HEAD (no from selected) and reloads on success", async () => {
    mockInTauri = true;
    vi.mocked(commands.createBranch).mockResolvedValueOnce({ ok: true, message: "created", backupRef: null });
    sidebarCtrl.startNewBranch();
    sidebarCtrl.newBranchInput = "feature/new";
    await sidebarCtrl.confirmNewBranch();
    expect(commands.createBranch).toHaveBeenCalledWith("/repo", "feature/new", null, true);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(sidebarCtrl.newBranchOpen).toBe(false);
  });

  it("real mode: passes the selected start point through as create_branch's start_point", async () => {
    mockInTauri = true;
    vi.mocked(commands.createBranch).mockResolvedValueOnce({ ok: true, message: "created", backupRef: null });
    sidebarCtrl.startNewBranch();
    sidebarCtrl.newBranchInput = "feature/new";
    sidebarCtrl.newBranchFrom = "origin/main";
    await sidebarCtrl.confirmNewBranch();
    expect(commands.createBranch).toHaveBeenCalledWith("/repo", "feature/new", "origin/main", true);
    expect(sidebarCtrl.newBranchFrom).toBe("");
  });
});

describe("deleteBranch", () => {
  it("arms the shared danger scrim with a delete-branch context", () => {
    sidebarCtrl.deleteBranch("old-feature");
    expect(bridge.armDanger).toHaveBeenCalledWith(
      expect.objectContaining({ name: "old-feature", confirmLabel: "Delete branch", onConfirm: expect.any(Function) }),
    );
  });

  it("onConfirm calls delete_branch and reloads on success", async () => {
    mockInTauri = true;
    vi.mocked(commands.deleteBranch).mockResolvedValueOnce({ ok: true, message: "deleted", backupRef: "refs/gitgui/deleted/x" });
    sidebarCtrl.deleteBranch("old-feature");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();
    expect(commands.deleteBranch).toHaveBeenCalledWith("/repo", "old-feature", false);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
  });

  it("onConfirm retries with force when not-fully-merged and the user confirms", async () => {
    mockInTauri = true;
    vi.mocked(commands.deleteBranch)
      .mockResolvedValueOnce({ ok: false, message: "branch is not fully merged", backupRef: null })
      .mockResolvedValueOnce({ ok: true, message: "force deleted", backupRef: null });
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    sidebarCtrl.deleteBranch("old-feature");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();
    expect(commands.deleteBranch).toHaveBeenNthCalledWith(2, "/repo", "old-feature", true);
  });

  it("onConfirm keeps the branch when the user declines the force-delete confirm", async () => {
    mockInTauri = true;
    vi.mocked(commands.deleteBranch).mockResolvedValueOnce({ ok: false, message: "branch is not fully merged", backupRef: null });
    vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    sidebarCtrl.deleteBranch("old-feature");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();
    expect(commands.deleteBranch).toHaveBeenCalledTimes(1);
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("cancelled"));
  });
});

describe("openMenu / closeMenu", () => {
  it("positions the menu clamped to the viewport width, from the anchor's rect", () => {
    const anchor = { getBoundingClientRect: () => ({ left: 10, bottom: 40 }) } as unknown as HTMLElement;
    sidebarCtrl.openMenu("feature", false, anchor);
    expect(sidebarCtrl.menu).toEqual({ name: "feature", isCurrent: false, x: 10, y: 44 });
  });

  it("closeMenu clears it", () => {
    sidebarCtrl.menu = { name: "x", isCurrent: false, x: 0, y: 0 };
    sidebarCtrl.closeMenu();
    expect(sidebarCtrl.menu).toBeNull();
  });

  it("opening the branch menu closes an open tag menu", () => {
    sidebarCtrl.tagMenu = { name: "v1.0.0", x: 0, y: 0 };
    const anchor = { getBoundingClientRect: () => ({ left: 10, bottom: 40 }) } as unknown as HTMLElement;
    sidebarCtrl.openMenu("feature", false, anchor);
    expect(sidebarCtrl.tagMenu).toBeNull();
  });
});

describe("openTagMenu / closeTagMenu", () => {
  it("positions the tag menu clamped to the viewport width, from the anchor's rect", () => {
    const anchor = { getBoundingClientRect: () => ({ left: 10, bottom: 40 }) } as unknown as HTMLElement;
    sidebarCtrl.openTagMenu("v1.0.0", anchor);
    expect(sidebarCtrl.tagMenu).toEqual({ name: "v1.0.0", x: 10, y: 44 });
  });

  it("closeTagMenu clears it", () => {
    sidebarCtrl.tagMenu = { name: "v1.0.0", x: 0, y: 0 };
    sidebarCtrl.closeTagMenu();
    expect(sidebarCtrl.tagMenu).toBeNull();
  });

  it("opening the tag menu closes an open branch menu", () => {
    sidebarCtrl.menu = { name: "main", isCurrent: true, x: 0, y: 0 };
    const anchor = { getBoundingClientRect: () => ({ left: 10, bottom: 40 }) } as unknown as HTMLElement;
    sidebarCtrl.openTagMenu("v1.0.0", anchor);
    expect(sidebarCtrl.menu).toBeNull();
  });
});

describe("newTag", () => {
  it("startNewTag opens the inline form, cancelNewTag closes it", () => {
    sidebarCtrl.startNewTag();
    expect(sidebarCtrl.newTagOpen).toBe(true);
    sidebarCtrl.newTagName = "v1.0.0";
    sidebarCtrl.newTagMessage = "release";
    sidebarCtrl.cancelNewTag();
    expect(sidebarCtrl.newTagOpen).toBe(false);
    expect(sidebarCtrl.newTagName).toBe("");
    expect(sidebarCtrl.newTagMessage).toBe("");
  });

  it("confirmNewTag does nothing (just closes) on an empty/blank name", async () => {
    sidebarCtrl.startNewTag();
    sidebarCtrl.newTagName = "   ";
    await sidebarCtrl.confirmNewTag();
    expect(sidebarCtrl.newTagOpen).toBe(false);
    expect(commands.createTag).not.toHaveBeenCalled();
  });

  it("real mode: creates a lightweight tag at HEAD (no message, no from) and reloads on success", async () => {
    mockInTauri = true;
    vi.mocked(commands.createTag).mockResolvedValueOnce({ ok: true, message: "created", backupRef: null });
    sidebarCtrl.startNewTag();
    sidebarCtrl.newTagName = "v1.0.0";
    await sidebarCtrl.confirmNewTag();
    expect(commands.createTag).toHaveBeenCalledWith("/repo", "v1.0.0", null, null);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(sidebarCtrl.newTagOpen).toBe(false);
  });

  it("real mode: passes a non-empty message through as an annotated tag, and the selected target", async () => {
    mockInTauri = true;
    vi.mocked(commands.createTag).mockResolvedValueOnce({ ok: true, message: "created", backupRef: null });
    sidebarCtrl.startNewTag();
    sidebarCtrl.newTagName = "v1.0.0";
    sidebarCtrl.newTagMessage = "release notes";
    sidebarCtrl.newTagFrom = "origin/main";
    await sidebarCtrl.confirmNewTag();
    expect(commands.createTag).toHaveBeenCalledWith("/repo", "v1.0.0", "origin/main", "release notes");
    expect(sidebarCtrl.newTagFrom).toBe("");
  });

  it("real mode: warns and does not reload on failure", async () => {
    mockInTauri = true;
    vi.mocked(commands.createTag).mockResolvedValueOnce({ ok: false, message: "tag already exists", backupRef: null });
    sidebarCtrl.startNewTag();
    sidebarCtrl.newTagName = "v1.0.0";
    await sidebarCtrl.confirmNewTag();
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("tag already exists"));
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
    expect(sidebarCtrl.newTagOpen).toBe(true);
  });
});

describe("deleteTag", () => {
  it("arms the shared danger scrim with a delete-tag context", () => {
    sidebarCtrl.deleteTag("v1.0.0");
    expect(bridge.armDanger).toHaveBeenCalledWith(
      expect.objectContaining({ name: "v1.0.0", confirmLabel: "Delete tag", onConfirm: expect.any(Function) }),
    );
  });

  it("onConfirm calls delete_tag and reloads on success", async () => {
    mockInTauri = true;
    vi.mocked(commands.deleteTag).mockResolvedValueOnce({ ok: true, message: "deleted", backupRef: "refs/gitgui/deleted-tag/x" });
    sidebarCtrl.deleteTag("v1.0.0");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();
    expect(commands.deleteTag).toHaveBeenCalledWith("/repo", "v1.0.0");
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
  });

  it("onConfirm warns and does not reload on failure", async () => {
    mockInTauri = true;
    vi.mocked(commands.deleteTag).mockResolvedValueOnce({ ok: false, message: "tag does not exist", backupRef: null });
    sidebarCtrl.deleteTag("v1.0.0");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    await ctx.onConfirm();
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("tag does not exist"));
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
  });
});

describe("pushTag", () => {
  it("design mode is a cosmetic no-op with a toast", async () => {
    mockInTauri = false;
    await sidebarCtrl.pushTag("v1.0.0");
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("demo"));
    expect(commands.pushTag).not.toHaveBeenCalled();
  });

  it("real mode: pushes the tag to origin (default remote) and cheers on success", async () => {
    mockInTauri = true;
    vi.mocked(commands.pushTag).mockResolvedValueOnce({ ok: true, message: "pushed", backupRef: null });
    await sidebarCtrl.pushTag("v1.0.0");
    expect(commands.pushTag).toHaveBeenCalledWith("/repo", null, "v1.0.0");
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });

  it("real mode: warns on failure", async () => {
    mockInTauri = true;
    vi.mocked(commands.pushTag).mockResolvedValueOnce({ ok: false, message: "rejected", backupRef: null });
    await sidebarCtrl.pushTag("v1.0.0");
    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("rejected"));
  });

  it("is re-entrancy locked while busy", async () => {
    mockInTauri = true;
    sidebarCtrl.busy = true;
    await sidebarCtrl.pushTag("v1.0.0");
    expect(commands.pushTag).not.toHaveBeenCalled();
  });
});

describe("rebaseOnto", () => {
  it("design mode opens the resolver's rebase demo", async () => {
    mockInTauri = false;
    await sidebarCtrl.rebaseOnto("main");
    expect(resolver.openDemo).toHaveBeenCalledWith("main", "rebase");
    expect(resolver.startRebase).not.toHaveBeenCalled();
  });

  it("real mode calls resolver.startRebase with the repo + target branch", async () => {
    mockInTauri = true;
    await sidebarCtrl.rebaseOnto("main");
    expect(resolver.startRebase).toHaveBeenCalledWith("/repo", "main");
  });
});

describe("setSnapshots / reset", () => {
  it("setSnapshots copies the array", () => {
    const snaps = [{ ref: "refs/gitgui/backup/1", ts: 100, sha: "abc1234", subject: "x" }];
    sidebarCtrl.setSnapshots(snaps);
    expect(sidebarCtrl.snapshots).toEqual(snaps);
    expect(sidebarCtrl.snapshots).not.toBe(snaps);
  });

  it("reset clears everything including an open menu, tag menu, hasRepo, and submodules", () => {
    sidebarCtrl.locals = [{ name: "main", sha: "x", ahead: null, behind: null }];
    sidebarCtrl.head = "main";
    sidebarCtrl.menu = { name: "main", isCurrent: true, x: 0, y: 0 };
    sidebarCtrl.tagMenu = { name: "v1.0.0", x: 0, y: 0 };
    sidebarCtrl.hasRepo = true;
    sidebarCtrl.submodules = [{ name: "vendor/a", path: "vendor/a", url: null, status: "clean", headSha: "x", workdirSha: "x" }];
    sidebarCtrl.reset();
    expect(sidebarCtrl.locals).toEqual([]);
    expect(sidebarCtrl.head).toBeNull();
    expect(sidebarCtrl.menu).toBeNull();
    expect(sidebarCtrl.tagMenu).toBeNull();
    expect(sidebarCtrl.hasRepo).toBe(false);
    expect(sidebarCtrl.submodules).toEqual([]);
  });
});

describe("copySnapshotSha", () => {
  it("writes to the clipboard and clears the copied flag after a delay", () => {
    vi.useFakeTimers();
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });

    sidebarCtrl.copySnapshotSha("abc1234");
    expect(writeText).toHaveBeenCalledWith("abc1234");
    expect(sidebarCtrl.copiedSnapshotSha).toBe("abc1234");

    vi.advanceTimersByTime(900);
    expect(sidebarCtrl.copiedSnapshotSha).toBe("");
    vi.useRealTimers();
  });
});
