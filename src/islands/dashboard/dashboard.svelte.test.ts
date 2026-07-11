// Tests for the multi-repository dashboard controller (backlog #11).
//
// Same isolation strategy as remotes/pickaxesearch's own test files:
// legacy/bridge is mocked so legacy/main.ts (a whole vanilla canvas app that
// boots on import) is never evaluated. IN_TAURI is a toggleable getter (same
// shape as pickaxesearch.svelte.test.ts / applypatch.svelte.test.ts) since
// this file exercises both the real-Tauri and design-mode-demo paths.
// @tauri-apps/plugin-dialog's `open()` is mocked exactly like
// applypatch.svelte.test.ts's own openMock, for addRepository()'s native
// folder picker.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  CUR_REPO: null,
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
  relTime: (t: number) => "t" + t,
  openRepo: vi.fn(async () => true),
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    listTrackedRepos: vi.fn(),
    addTrackedRepo: vi.fn(),
    removeTrackedRepo: vi.fn(),
    dashboardRepoStatus: vi.fn(),
  },
}));

let mockInTauri = true;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));

const openMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
}));

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import type { DashboardRepoStatus, TrackedRepo } from "../../ipc/bindings";
import { dashboardCtrl } from "./dashboard.svelte.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}

function tracked(path: string, lastOpenedAt: number | null = null): TrackedRepo {
  return { path, lastOpenedAt };
}

function status(partial: Partial<DashboardRepoStatus> = {}): DashboardRepoStatus {
  return {
    branch: "main",
    detached: false,
    ahead: 0,
    behind: 0,
    dirty: false,
    conflicted: 0,
    headSha: "a1b2c3d",
    lastSubject: "tweak things",
    lastCommitTime: 1_700_000_000,
    ...partial,
  };
}

// Resolves on the next microtask — lets an already-fired-but-not-yet-settled
// Promise.allSettled batch make progress without picking a fixed status yet.
function tick(): Promise<void> {
  return Promise.resolve();
}

function resetCtrl() {
  dashboardCtrl.open = false;
  dashboardCtrl.demo = false;
  dashboardCtrl.rows = [];
  dashboardCtrl.loading = false;
  dashboardCtrl.error = "";
  dashboardCtrl.addBusy = false;
  dashboardCtrl.removingPath = null;
  mockInTauri = true;
  vi.clearAllMocks();
}

beforeEach(() => {
  resetCtrl();
});

describe("show / close", () => {
  it("show() opens the modal and triggers a refresh", async () => {
    vi.mocked(commands.listTrackedRepos).mockResolvedValueOnce(ok([]));
    dashboardCtrl.show();

    expect(dashboardCtrl.open).toBe(true);
    await tick();
    expect(commands.listTrackedRepos).toHaveBeenCalledTimes(1);
  });

  it("close() is blocked while a native dialog / add-mutation is in flight", () => {
    dashboardCtrl.open = true;
    dashboardCtrl.addBusy = true;
    dashboardCtrl.close();
    expect(dashboardCtrl.open).toBe(true);
  });

  it("close() otherwise closes it", () => {
    dashboardCtrl.open = true;
    dashboardCtrl.close();
    expect(dashboardCtrl.open).toBe(false);
  });
});

describe("refresh — listing + parallel per-row status fetch", () => {
  it("lists tracked repos, then fetches every row's status IN PARALLEL (not sequentially)", async () => {
    vi.mocked(commands.listTrackedRepos).mockResolvedValueOnce(ok([tracked("/repo/a"), tracked("/repo/b")]));

    type StatusResult = { status: "ok"; data: DashboardRepoStatus } | { status: "error"; error: string };
    let resolveA!: (v: StatusResult) => void;
    let resolveB!: (v: StatusResult) => void;
    vi.mocked(commands.dashboardRepoStatus).mockImplementation((path: string) => {
      if (path === "/repo/a") return new Promise((r) => (resolveA = r));
      return new Promise((r) => (resolveB = r));
    });

    const p = dashboardCtrl.refresh();
    // Give the list fetch + the two fanned-out status calls a chance to fire.
    await tick();
    await tick();

    // Both calls must already be in flight before EITHER resolves — proof
    // this is Promise.allSettled over a mapped array, not a sequential
    // await-in-a-loop (which would only have called the first one by now).
    expect(commands.dashboardRepoStatus).toHaveBeenCalledTimes(2);
    expect(commands.dashboardRepoStatus).toHaveBeenCalledWith("/repo/a");
    expect(commands.dashboardRepoStatus).toHaveBeenCalledWith("/repo/b");
    expect(dashboardCtrl.rows.every((r) => r.loading)).toBe(true);

    resolveB(ok(status({ branch: "feat/b" })));
    resolveA(ok(status({ branch: "main" })));
    await p;

    expect(dashboardCtrl.rows.find((r) => r.path === "/repo/a")?.status?.branch).toBe("main");
    expect(dashboardCtrl.rows.find((r) => r.path === "/repo/b")?.status?.branch).toBe("feat/b");
    expect(dashboardCtrl.rows.every((r) => !r.loading)).toBe(true);
  });

  it("the tracked list persists across a reload — a second refresh() reflects whatever the (mocked) backend now returns", async () => {
    vi.mocked(commands.listTrackedRepos).mockResolvedValueOnce(ok([tracked("/repo/a")]));
    vi.mocked(commands.dashboardRepoStatus).mockResolvedValueOnce(ok(status()));
    await dashboardCtrl.refresh();
    expect(dashboardCtrl.rows.map((r) => r.path)).toEqual(["/repo/a"]);

    // Simulate an app restart: a FRESH refresh() call against whatever the
    // backend's JSON file now holds (persisted from the previous session).
    vi.mocked(commands.listTrackedRepos).mockResolvedValueOnce(ok([tracked("/repo/a"), tracked("/repo/b")]));
    vi.mocked(commands.dashboardRepoStatus).mockResolvedValueOnce(ok(status()));
    await dashboardCtrl.refresh();

    expect(dashboardCtrl.rows.map((r) => r.path)).toEqual(["/repo/a", "/repo/b"]);
    // /repo/a's already-fetched status must be PRESERVED, not re-fetched —
    // only /repo/b (genuinely new) triggers a second dashboardRepoStatus call.
    expect(commands.dashboardRepoStatus).toHaveBeenCalledTimes(2);
  });

  it("show() forces a full re-fetch of every row, even one already fetched earlier this session", async () => {
    // Regression test for a real bug an adversarial review caught: the first
    // draft's `refresh()` (called by `show()`) preserved any status a row
    // already had, matched by path — so once /repo/a's status was fetched
    // ONCE, closing and reopening the dashboard never re-checked it again
    // for the rest of the app session, directly contradicting the code's
    // own doc comment claim that it "always re-fetches". `show()` now
    // passes `forceRefetchAll: true` through to `refresh()`, so a repo
    // whose branch changed (a terminal commit, another tool) behind the
    // app's back IS reflected the next time the dashboard is opened.
    vi.mocked(commands.listTrackedRepos).mockResolvedValueOnce(ok([tracked("/repo/a")]));
    vi.mocked(commands.dashboardRepoStatus).mockResolvedValueOnce(ok(status({ branch: "main" })));
    dashboardCtrl.show(); // fire-and-forget refresh(true)
    await tick();
    await tick();
    await tick();
    expect(dashboardCtrl.rows.find((r) => r.path === "/repo/a")?.status?.branch).toBe("main");

    dashboardCtrl.close();

    // Reopen: even though /repo/a already has a fetched status, show() must
    // re-fetch it — simulating the branch having changed in the meantime.
    vi.mocked(commands.listTrackedRepos).mockResolvedValueOnce(ok([tracked("/repo/a")]));
    vi.mocked(commands.dashboardRepoStatus).mockResolvedValueOnce(ok(status({ branch: "feature/new" })));
    dashboardCtrl.show();
    await tick();
    await tick();
    await tick();

    expect(commands.dashboardRepoStatus).toHaveBeenCalledTimes(2);
    expect(dashboardCtrl.rows.find((r) => r.path === "/repo/a")?.status?.branch).toBe("feature/new");
  });

  it("a repo whose path no longer resolves is shown as broken, without crashing the rest of the list", async () => {
    vi.mocked(commands.listTrackedRepos).mockResolvedValueOnce(ok([tracked("/repo/good"), tracked("/repo/gone")]));
    vi.mocked(commands.dashboardRepoStatus).mockImplementation((path: string) =>
      path === "/repo/good" ? Promise.resolve(ok(status())) : Promise.resolve(err("Could not open repository — no such file or directory")),
    );

    await dashboardCtrl.refresh();

    const good = dashboardCtrl.rows.find((r) => r.path === "/repo/good");
    const gone = dashboardCtrl.rows.find((r) => r.path === "/repo/gone");
    expect(good?.status).not.toBeNull();
    expect(good?.error).toBeNull();
    expect(gone?.status).toBeNull();
    expect(gone?.error).toMatch(/no such file/i);
    expect(dashboardCtrl.error).toBe(""); // list-level error stays clean — this is a per-row concern
  });

  it("a rejected (thrown) status round-trip is also captured per-row, not left uncaught", async () => {
    vi.mocked(commands.listTrackedRepos).mockResolvedValueOnce(ok([tracked("/repo/flaky")]));
    vi.mocked(commands.dashboardRepoStatus).mockRejectedValueOnce(new Error("IPC timeout"));

    await dashboardCtrl.refresh();

    const row = dashboardCtrl.rows[0];
    expect(row.error).toContain("IPC timeout");
    expect(row.status).toBeNull();
  });

  it("a list-level failure clears the rows and sets a top-level error, without any status round-trips", async () => {
    vi.mocked(commands.listTrackedRepos).mockResolvedValueOnce(err("Could not read the registry file."));

    await dashboardCtrl.refresh();

    expect(dashboardCtrl.rows).toEqual([]);
    expect(dashboardCtrl.error).toBe("Could not read the registry file.");
    expect(commands.dashboardRepoStatus).not.toHaveBeenCalled();
  });

  it("demo (non-Tauri) mode seeds canned rows, including one already-broken row, without any IPC calls", async () => {
    mockInTauri = false;

    await dashboardCtrl.refresh();

    expect(dashboardCtrl.demo).toBe(true);
    expect(dashboardCtrl.rows.length).toBeGreaterThan(0);
    expect(dashboardCtrl.rows.some((r) => r.error)).toBe(true);
    expect(commands.listTrackedRepos).not.toHaveBeenCalled();
  });
});

describe("addRepository — native folder picker", () => {
  it("does nothing when the folder dialog is cancelled", async () => {
    openMock.mockResolvedValueOnce(null);

    await dashboardCtrl.addRepository();

    expect(commands.addTrackedRepo).not.toHaveBeenCalled();
  });

  it("adds the picked path, merges it into rows, and fetches status only for the new row", async () => {
    vi.mocked(commands.listTrackedRepos).mockResolvedValueOnce(ok([tracked("/repo/a")]));
    vi.mocked(commands.dashboardRepoStatus).mockResolvedValueOnce(ok(status({ branch: "main" })));
    await dashboardCtrl.refresh();
    vi.mocked(commands.dashboardRepoStatus).mockClear();

    openMock.mockResolvedValueOnce("/repo/new");
    vi.mocked(commands.addTrackedRepo).mockResolvedValueOnce(ok([tracked("/repo/a"), tracked("/repo/new")]));
    vi.mocked(commands.dashboardRepoStatus).mockResolvedValueOnce(ok(status({ branch: "feat/new" })));

    await dashboardCtrl.addRepository();

    expect(commands.addTrackedRepo).toHaveBeenCalledWith("/repo/new");
    // Only the genuinely new row triggers a status round-trip — /repo/a's
    // already-known status must be preserved, not re-fetched.
    expect(commands.dashboardRepoStatus).toHaveBeenCalledTimes(1);
    expect(commands.dashboardRepoStatus).toHaveBeenCalledWith("/repo/new");
    expect(dashboardCtrl.rows.find((r) => r.path === "/repo/a")?.status?.branch).toBe("main");
    expect(dashboardCtrl.rows.find((r) => r.path === "/repo/new")?.status?.branch).toBe("feat/new");
  });

  it("demo (non-Tauri) mode never opens a dialog", async () => {
    mockInTauri = false;

    await dashboardCtrl.addRepository();

    expect(openMock).not.toHaveBeenCalled();
    expect(bridge.tama.say).toHaveBeenCalled();
  });

  it("warns instead of throwing if the dialog itself errors", async () => {
    openMock.mockRejectedValueOnce(new Error("dialog plugin unavailable"));

    await dashboardCtrl.addRepository();

    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("dialog plugin unavailable"));
    expect(commands.addTrackedRepo).not.toHaveBeenCalled();
  });

  it("warns on a backend error and leaves the list untouched", async () => {
    openMock.mockResolvedValueOnce("/repo/bad");
    vi.mocked(commands.addTrackedRepo).mockResolvedValueOnce(err("Not a git repository."));

    await dashboardCtrl.addRepository();

    expect(bridge.tama.warn).toHaveBeenCalledWith("Not a git repository.");
    expect(dashboardCtrl.rows).toEqual([]);
  });

  it("is a no-op re-entrancy guard while an add is already in flight", async () => {
    dashboardCtrl.addBusy = true;

    await dashboardCtrl.addRepository();

    expect(openMock).not.toHaveBeenCalled();
  });
});

describe("removeRepository — list-only, never touches disk", () => {
  it("removes the row via removeTrackedRepo and updates the list, calling no other mutating command", async () => {
    vi.mocked(commands.listTrackedRepos).mockResolvedValueOnce(ok([tracked("/repo/a"), tracked("/repo/b")]));
    vi.mocked(commands.dashboardRepoStatus).mockResolvedValue(ok(status()));
    await dashboardCtrl.refresh();

    vi.mocked(commands.removeTrackedRepo).mockResolvedValueOnce(ok([tracked("/repo/b")]));
    await dashboardCtrl.removeRepository("/repo/a");

    expect(commands.removeTrackedRepo).toHaveBeenCalledWith("/repo/a");
    expect(commands.addTrackedRepo).not.toHaveBeenCalled();
    expect(dashboardCtrl.rows.map((r) => r.path)).toEqual(["/repo/b"]);
  });

  it("removing a broken (path-no-longer-resolves) row is exactly this same list-only mutation", async () => {
    vi.mocked(commands.listTrackedRepos).mockResolvedValueOnce(ok([tracked("/repo/gone")]));
    vi.mocked(commands.dashboardRepoStatus).mockResolvedValueOnce(err("no such file or directory"));
    await dashboardCtrl.refresh();
    expect(dashboardCtrl.rows[0].error).toBeTruthy();

    vi.mocked(commands.removeTrackedRepo).mockResolvedValueOnce(ok([]));
    await dashboardCtrl.removeRepository("/repo/gone");

    expect(commands.removeTrackedRepo).toHaveBeenCalledWith("/repo/gone");
    expect(dashboardCtrl.rows).toEqual([]);
  });

  it("demo mode removes locally without any backend call", async () => {
    mockInTauri = false;
    await dashboardCtrl.refresh();
    const firstPath = dashboardCtrl.rows[0].path;

    await dashboardCtrl.removeRepository(firstPath);

    expect(commands.removeTrackedRepo).not.toHaveBeenCalled();
    expect(dashboardCtrl.rows.find((r) => r.path === firstPath)).toBeUndefined();
  });

  it("warns on a backend error and leaves the row in place", async () => {
    vi.mocked(commands.listTrackedRepos).mockResolvedValueOnce(ok([tracked("/repo/a")]));
    vi.mocked(commands.dashboardRepoStatus).mockResolvedValueOnce(ok(status()));
    await dashboardCtrl.refresh();

    vi.mocked(commands.removeTrackedRepo).mockResolvedValueOnce(err("Could not write the registry file."));
    await dashboardCtrl.removeRepository("/repo/a");

    expect(bridge.tama.warn).toHaveBeenCalledWith("Could not write the registry file.");
    expect(dashboardCtrl.rows.map((r) => r.path)).toEqual(["/repo/a"]);
  });

  it("is a no-op re-entrancy guard while a removal is already in flight", async () => {
    dashboardCtrl.removingPath = "/repo/a";

    await dashboardCtrl.removeRepository("/repo/a");

    expect(commands.removeTrackedRepo).not.toHaveBeenCalled();
  });
});

describe("openRepository — hands off to the existing bridge.openRepo(), tearing down current state", () => {
  it("closes the dashboard, then calls bridge.openRepo with exactly the row's path", async () => {
    dashboardCtrl.open = true;

    await dashboardCtrl.openRepository("/repo/a");

    expect(dashboardCtrl.open).toBe(false);
    expect(bridge.openRepo).toHaveBeenCalledWith("/repo/a");
  });

  it("demo (non-Tauri) mode closes and says a canned line, without touching bridge.openRepo", async () => {
    mockInTauri = false;
    dashboardCtrl.open = true;
    dashboardCtrl.demo = true;

    await dashboardCtrl.openRepository("/home/demo/acme-web");

    expect(dashboardCtrl.open).toBe(false);
    expect(bridge.openRepo).not.toHaveBeenCalled();
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("acme-web"));
  });
});
