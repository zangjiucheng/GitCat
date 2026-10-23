// Tests for the sync-progress modal controller (#133: cancel + stall).
//
// Same isolation strategy as bisect.svelte.test.ts: legacy/bridge is mocked so
// legacy/main.ts (a whole vanilla canvas app that boots on import) is never
// evaluated. The keymap registry is mocked too — what matters here is THAT
// begin() pushes a modal scope with the right onEscape, not the registry's own
// stack logic (keymap-scopes.spec.ts covers that end to end).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
  TAMA_IMG: { thinking: "thinking.png" },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: { jobCancel: vi.fn() },
}));

let mockInTauri = true;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));

const release = vi.fn();
let lastScopeOpts: { onEscape?: () => void; autoFocus?: boolean } | null = null;
vi.mock("@/keymap/registry.ts", () => ({
  keymap: {
    pushScope: vi.fn((_id: string, opts: { onEscape?: () => void }) => {
      lastScopeOpts = opts;
      return { id: "modal", token: 1, release };
    }),
  },
}));

import { commands } from "../../ipc/bindings";
import type { JobInfo } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { keymap } from "@/keymap/registry.ts";
import { syncProgressCtrl } from "./syncprogress.svelte.ts";

type Cb = (e: { payload: any }) => void;
// A fake window.__TAURI__.event bus: listen() records callbacks, emit() fires them.
let listeners: Map<string, Set<Cb>>;
let listen: ReturnType<typeof vi.fn>;

function emit(event: string, payload: unknown) {
  for (const cb of listeners.get(event) ?? []) cb({ payload });
}

function started(partial: Partial<JobInfo> = {}): JobInfo {
  return {
    id: 7,
    kind: "fetch",
    repo: "/r",
    label: "",
    startedAtMs: 0,
    background: false,
    stalled: false,
    cancelling: false,
    ...partial,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mockInTauri = true;
  lastScopeOpts = null;
  listeners = new Map();
  listen = vi.fn(async (event: string, cb: Cb) => {
    let set = listeners.get(event);
    if (!set) listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  });
  (window as any).__TAURI__ = { event: { listen } };
  syncProgressCtrl.close();
  vi.mocked(keymap.pushScope).mockClear();
  release.mockClear();
});

describe("begin", () => {
  it("arms listeners before returning and pushes a modal scope", async () => {
    await syncProgressCtrl.begin("Fetching…", "fetch", "/r");
    expect(listen.mock.calls.map((c) => c[0]).sort()).toEqual(["job-progress", "job-started", "sync-progress"]);
    expect(keymap.pushScope).toHaveBeenCalledTimes(1);
    expect(vi.mocked(keymap.pushScope).mock.calls[0][0]).toBe("modal");
    expect(lastScopeOpts?.autoFocus).toBe(false);
    expect(syncProgressCtrl.open).toBe(true);
    expect(syncProgressCtrl.running).toBe(true);

    emit("sync-progress", { phase: "fetch", line: "Receiving objects: 5%" });
    emit("sync-progress", { phase: "pull", line: "stray" });
    expect(syncProgressCtrl.lines).toEqual(["Receiving objects: 5%"]);
  });
});

describe("job-started", () => {
  it("captures jobId for a matching foreground job; background or other repo ignored", async () => {
    await syncProgressCtrl.begin("Fetching…", "fetch", "/r");
    emit("job-started", started({ id: 1, background: true }));
    emit("job-started", started({ id: 2, repo: "/other" }));
    emit("job-started", started({ id: 3, kind: "pull" }));
    expect(syncProgressCtrl.jobId).toBeNull();
    emit("job-started", started({ id: 4 }));
    expect(syncProgressCtrl.jobId).toBe(4);
    emit("job-started", started({ id: 5 }));
    expect(syncProgressCtrl.jobId).toBe(4); // first match wins
  });
});

describe("cancel", () => {
  it("is queued before job-started and sent on arrival", async () => {
    vi.mocked(commands.jobCancel).mockResolvedValue(true);
    await syncProgressCtrl.begin("Fetching…", "fetch", "/r");
    await syncProgressCtrl.cancel();
    expect(syncProgressCtrl.cancelling).toBe(true);
    expect(commands.jobCancel).not.toHaveBeenCalled();
    emit("job-started", started({ id: 9 }));
    await flush();
    expect(commands.jobCancel).toHaveBeenCalledWith(9);
  });

  it("jobCancel false (already gone) leaves state for settle", async () => {
    vi.mocked(commands.jobCancel).mockResolvedValue(false);
    await syncProgressCtrl.begin("Fetching…", "fetch", "/r");
    emit("job-started", started());
    await syncProgressCtrl.cancel();
    expect(commands.jobCancel).toHaveBeenCalledWith(7);
    expect(syncProgressCtrl.cancelling).toBe(true);
    expect(syncProgressCtrl.done).toBe(false);
    syncProgressCtrl.settle(true, "Fetched all remotes.");
    expect(syncProgressCtrl.cancelling).toBe(false);
    expect(syncProgressCtrl.cancelled).toBe(false);
  });

  it("a thrown jobCancel warns and resets cancelling", async () => {
    vi.mocked(commands.jobCancel).mockRejectedValue("boom");
    await syncProgressCtrl.begin("Fetching…", "fetch", "/r");
    emit("job-started", started());
    await syncProgressCtrl.cancel();
    expect(bridge.tama.warn).toHaveBeenCalledWith("boom");
    expect(syncProgressCtrl.cancelling).toBe(false);
  });
});

describe("escape", () => {
  it("cancels while running, hides while cancelling, closes when done", async () => {
    vi.mocked(commands.jobCancel).mockResolvedValue(true);
    await syncProgressCtrl.begin("Fetching…", "fetch", "/r");
    emit("job-started", started());
    // The scope's onEscape IS the controller's escape().
    lastScopeOpts!.onEscape!();
    await flush();
    expect(commands.jobCancel).toHaveBeenCalledWith(7);
    expect(syncProgressCtrl.cancelling).toBe(true);
    expect(syncProgressCtrl.open).toBe(true);

    syncProgressCtrl.escape(); // already cancelling: hide, don't send again
    expect(commands.jobCancel).toHaveBeenCalledTimes(1);
    expect(syncProgressCtrl.open).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);

    await syncProgressCtrl.begin("Fetching…", "fetch", "/r");
    syncProgressCtrl.settle(false, "fatal: nope");
    syncProgressCtrl.escape(); // done: close
    expect(syncProgressCtrl.open).toBe(false);
    expect(commands.jobCancel).toHaveBeenCalledTimes(1);
  });
});

describe("job-progress", () => {
  it("toggles stalled and stallSecs for this job only", async () => {
    await syncProgressCtrl.begin("Pulling…", "pull", "/r");
    emit("job-started", started({ id: 3, kind: "pull" }));
    emit("job-progress", { id: 99, stalled: true, idleSecs: 60 });
    expect(syncProgressCtrl.stalled).toBe(false);
    emit("job-progress", { id: 3, stalled: true, idleSecs: 60 });
    expect(syncProgressCtrl.stalled).toBe(true);
    expect(syncProgressCtrl.stallSecs).toBe(60);
    emit("job-progress", { id: 3, stalled: false, idleSecs: 60 });
    expect(syncProgressCtrl.stalled).toBe(false);
  });
});

describe("settle", () => {
  it("cancelled shows cancelled, not error, and stays open", async () => {
    vi.useFakeTimers();
    await syncProgressCtrl.begin("Pulling…", "pull", "/r");
    syncProgressCtrl.settle(false, "i18n:err_remote.pull_cancelled\u001fsnapshot\u001fsnap1", true);
    expect(syncProgressCtrl.cancelled).toBe(true);
    expect(syncProgressCtrl.error).toBeNull();
    expect(syncProgressCtrl.cancelNote).toContain("snap1");
    expect(syncProgressCtrl.running).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(syncProgressCtrl.open).toBe(true); // only success auto-closes
  });
});

describe("close", () => {
  it("releases scope and listeners; jobId survives until next begin", async () => {
    await syncProgressCtrl.begin("Fetching…", "fetch", "/r");
    emit("job-started", started({ id: 12 }));
    syncProgressCtrl.close();
    expect(release).toHaveBeenCalledTimes(1);
    expect([...listeners.values()].every((s) => s.size === 0)).toBe(true);
    expect(syncProgressCtrl.jobId).toBe(12);
    await syncProgressCtrl.begin("Fetching…", "fetch", "/r");
    expect(syncProgressCtrl.jobId).toBeNull();
  });
});

describe("beginDemo", () => {
  it("resolves cancelled when cancel() is called", async () => {
    mockInTauri = false;
    vi.useFakeTimers();
    const p = syncProgressCtrl.beginDemo("Fetching…", "fetch");
    await vi.advanceTimersByTimeAsync(600);
    expect(syncProgressCtrl.lines.length).toBeGreaterThan(0);
    expect(listen).not.toHaveBeenCalled(); // design mode has no backend events
    await syncProgressCtrl.cancel();
    await expect(p).resolves.toEqual({ ok: false, cancelled: true });
    expect(syncProgressCtrl.cancelled).toBe(true);
    expect(commands.jobCancel).not.toHaveBeenCalled();
  });

  it("shows the stalled banner, then resolves ok", async () => {
    mockInTauri = false;
    vi.useFakeTimers();
    const p = syncProgressCtrl.beginDemo("Pushing…", "push");
    await vi.advanceTimersByTimeAsync(2000);
    expect(syncProgressCtrl.stalled).toBe(true);
    expect(syncProgressCtrl.stallSecs).toBe(60);
    await vi.advanceTimersByTimeAsync(2500);
    await expect(p).resolves.toEqual({ ok: true, cancelled: false });
    expect(syncProgressCtrl.stalled).toBe(false);
  });
});
