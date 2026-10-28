// Tests for the running-jobs indicator controller (#133).
//
// Same isolation strategy as syncprogress.svelte.test.ts: legacy/bridge is
// mocked so legacy/main.ts never boots, the keymap registry is a pushScope
// spy, and window.__TAURI__.event is a tiny in-memory bus. The SyncProgress
// controller is replaced by a plain object the tests flip, since all this
// store reads from it is `open` and `jobId` (and, in design mode, the demo
// run's fields).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";

vi.mock("../../legacy/bridge", () => ({
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: { jobCancel: vi.fn(), jobsList: vi.fn() },
}));

let mockInTauri = true;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));

const release = vi.fn();
vi.mock("@/keymap/registry.ts", () => ({
  keymap: { pushScope: vi.fn(() => ({ id: "modal", token: 1, release })) },
}));

vi.mock("../syncprogress/syncprogress.svelte.ts", () => ({
  syncProgressCtrl: { open: false, jobId: null as number | null, canReopen: false, reopen: vi.fn() },
}));

import { commands } from "../../ipc/bindings";
import type { JobInfo } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { keymap } from "@/keymap/registry.ts";
import { syncProgressCtrl } from "../syncprogress/syncprogress.svelte.ts";
import { BACKGROUND_GRACE_MS, elapsed, jobsCtrl } from "./jobs.svelte.ts";

type Cb = (e: { payload: any }) => void;
let listeners: Map<string, Set<Cb>>;
let listen: ReturnType<typeof vi.fn>;

function emit(event: string, payload: unknown) {
  for (const cb of listeners.get(event) ?? []) cb({ payload });
}

function job(partial: Partial<JobInfo> = {}): JobInfo {
  return {
    id: 1,
    kind: "fetch",
    repo: "/work/gitcat",
    label: "",
    startedAtMs: Date.now(),
    background: false,
    stalled: false,
    cancelling: false,
    stallSecs: 60,
    ...partial,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const sp = syncProgressCtrl as unknown as { open: boolean; jobId: number | null };

// The controller is a module singleton; drain it between tests.
function reset() {
  jobsCtrl.close();
  for (const j of [...jobsCtrl.jobs]) jobsCtrl.onFinished({ id: j.id, outcome: "ok" });
  const priv = jobsCtrl as unknown as { inited: boolean; gone: Set<number>; prompted: Set<number> };
  priv.inited = false;
  priv.gone.clear();
  priv.prompted.clear();
}

beforeEach(() => {
  vi.useRealTimers();
  reset();
  vi.clearAllMocks();
  mockInTauri = true;
  sp.open = false;
  sp.jobId = null;
  listeners = new Map();
  listen = vi.fn(async (event: string, cb: Cb) => {
    let set = listeners.get(event);
    if (!set) listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  });
  (window as any).__TAURI__ = { event: { listen } };
});

describe("init", () => {
  it("listens before jobsList and merges without duplicates", async () => {
    const order: string[] = [];
    listen.mockImplementation(async (event: string, cb: Cb) => {
      order.push(`listen:${event}`);
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(cb);
      return () => set!.delete(cb);
    });
    vi.mocked(commands.jobsList).mockImplementation(async () => {
      order.push("jobsList");
      // A job that starts AND one that finishes while jobs_list is in flight.
      emit("job-started", job({ id: 2 }));
      emit("job-finished", { id: 3, outcome: "ok" });
      return [job({ id: 2 }), job({ id: 3 }), job({ id: 4 })];
    });
    await jobsCtrl.init();
    expect(order.slice(0, 3).sort()).toEqual(["listen:job-finished", "listen:job-progress", "listen:job-started"]);
    expect(order[3]).toBe("jobsList");
    expect(jobsCtrl.jobs.map((j) => j.id)).toEqual([2, 4]);

    // Idempotent.
    await jobsCtrl.init();
    expect(commands.jobsList).toHaveBeenCalledTimes(1);
  });

  it("swallows a jobsList failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(commands.jobsList).mockRejectedValue(new Error("boom"));
    await expect(jobsCtrl.init()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    // Listeners still armed: live events keep working.
    emit("job-started", job({ id: 5 }));
    expect(jobsCtrl.count).toBe(1);
    warn.mockRestore();
  });

  it("design mode init is inert", async () => {
    mockInTauri = false;
    await jobsCtrl.init();
    flushSync();
    expect(listen).not.toHaveBeenCalled();
    expect(commands.jobsList).not.toHaveBeenCalled();
    expect(jobsCtrl.jobs).toEqual([]);
  });
});

describe("events", () => {
  it("onStarted/onFinished add and remove", () => {
    jobsCtrl.onStarted(job({ id: 1 }));
    jobsCtrl.onStarted(job({ id: 1 })); // duplicate ignored
    jobsCtrl.onStarted(job({ id: 2, kind: "push", label: "main" }));
    expect(jobsCtrl.count).toBe(2);
    jobsCtrl.onFinished({ id: 1, outcome: "ok" });
    expect(jobsCtrl.jobs.map((j) => j.id)).toEqual([2]);
    jobsCtrl.onFinished({ id: 99, outcome: "ok" }); // unknown: harmless
    expect(jobsCtrl.count).toBe(1);
  });

  it("hides a background job until BACKGROUND_GRACE_MS", () => {
    const t0 = Date.now();
    jobsCtrl.onStarted(job({ id: 3, background: true, startedAtMs: t0 }));
    jobsCtrl.now = t0 + 1000;
    expect(jobsCtrl.count).toBe(0);
    jobsCtrl.now = t0 + BACKGROUND_GRACE_MS;
    expect(jobsCtrl.count).toBe(1);
  });

  it("onProgress flags the row and prompts once; skipped only while SyncProgress is open on that id", () => {
    jobsCtrl.onStarted(job({ id: 4 }));
    jobsCtrl.onProgress({ id: 4, stalled: true, idleSecs: 60 });
    expect(jobsCtrl.jobs[0]).toMatchObject({ stalled: true, idleSecs: 60 });
    expect(jobsCtrl.anyStalled).toBe(true);
    expect(bridge.tama.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bridge.tama.warn).mock.calls[0][0]).toContain("gitcat");

    jobsCtrl.onProgress({ id: 4, stalled: false, idleSecs: 60 });
    expect(jobsCtrl.anyStalled).toBe(false);
    jobsCtrl.onProgress({ id: 4, stalled: true, idleSecs: 60 });
    expect(bridge.tama.warn).toHaveBeenCalledTimes(1); // once per job

    // The open modal on this very job has its own banner.
    sp.open = true;
    sp.jobId = 5;
    jobsCtrl.onStarted(job({ id: 5 }));
    jobsCtrl.onProgress({ id: 5, stalled: true, idleSecs: 60 });
    expect(bridge.tama.warn).toHaveBeenCalledTimes(1);

    // A HIDDEN modal on that job still prompts.
    sp.open = false;
    jobsCtrl.onStarted(job({ id: 6 }));
    sp.jobId = 6;
    jobsCtrl.onProgress({ id: 6, stalled: true, idleSecs: 60 });
    expect(bridge.tama.warn).toHaveBeenCalledTimes(2);
  });

  it("an already-stalled row uses its own job's threshold, not a hard-coded one", () => {
    jobsCtrl.onStarted(job({ id: 11, stalled: true, stallSecs: 90 }));
    expect(jobsCtrl.jobs[0]).toMatchObject({ stalled: true, idleSecs: 90 });
  });

  it("a row that arrives already stalled gets the threshold and the one-time prompt", () => {
    // A reload mid-stall: jobs_list reports stalled, and no job-progress follows.
    jobsCtrl.onStarted(job({ id: 7, stalled: true }));
    expect(jobsCtrl.jobs[0]).toMatchObject({ stalled: true, idleSecs: 60 });
    expect(bridge.tama.warn).toHaveBeenCalledTimes(1);
    jobsCtrl.onProgress({ id: 7, stalled: true, idleSecs: 60 });
    expect(bridge.tama.warn).toHaveBeenCalledTimes(1);
  });
});

describe("cancel", () => {
  it("calls jobCancel and sets cancelling; a cancelled background job toasts", async () => {
    vi.mocked(commands.jobCancel).mockResolvedValue(true);
    jobsCtrl.onStarted(job({ id: 7, label: "origin", background: true }));
    const p = jobsCtrl.cancel(7);
    expect(jobsCtrl.jobs[0].cancelling).toBe(true);
    await p;
    expect(commands.jobCancel).toHaveBeenCalledWith(7);
    await jobsCtrl.cancel(7); // already cancelling: no second call
    expect(commands.jobCancel).toHaveBeenCalledTimes(1);
    jobsCtrl.onFinished({ id: 7, outcome: "cancelled" });
    expect(bridge.tama.say).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bridge.tama.say).mock.calls[0][0]).toContain("origin");
  });

  it("a cancelled FOREGROUND job does not toast: its own caller relays the backend message", async () => {
    vi.mocked(commands.jobCancel).mockResolvedValue(true);
    jobsCtrl.onStarted(job({ id: 9, background: false }));
    await jobsCtrl.cancel(9);
    jobsCtrl.onFinished({ id: 9, outcome: "cancelled" });
    expect(bridge.tama.say).not.toHaveBeenCalled();
  });

  it("a cancelled finish it did not cause does not toast", () => {
    jobsCtrl.onStarted(job({ id: 8 }));
    jobsCtrl.onFinished({ id: 8, outcome: "cancelled" });
    expect(bridge.tama.say).not.toHaveBeenCalled();
  });

  it("a thrown jobCancel reverts the flag and warns", async () => {
    vi.mocked(commands.jobCancel).mockRejectedValue("ipc down");
    jobsCtrl.onStarted(job({ id: 9 }));
    await jobsCtrl.cancel(9);
    expect(jobsCtrl.jobs[0].cancelling).toBe(false);
    expect(bridge.tama.warn).toHaveBeenCalledWith("ipc down");
  });

  it("jobCancel false (already finishing) leaves the row for job-finished", async () => {
    vi.mocked(commands.jobCancel).mockResolvedValue(false);
    jobsCtrl.onStarted(job({ id: 10 }));
    await jobsCtrl.cancel(10);
    expect(jobsCtrl.jobs[0].cancelling).toBe(true);
    expect(bridge.tama.warn).not.toHaveBeenCalled();
  });
});

describe("toggle", () => {
  it("returns false when empty; pushes and releases a modal scope", async () => {
    expect(jobsCtrl.toggle()).toBe(false);
    expect(jobsCtrl.open).toBe(false);

    jobsCtrl.onStarted(job({ id: 11 }));
    expect(jobsCtrl.toggle()).toBe(true);
    expect(jobsCtrl.open).toBe(true);
    await flush();
    expect(keymap.pushScope).toHaveBeenCalledTimes(1);
    expect(vi.mocked(keymap.pushScope).mock.calls[0][0]).toBe("modal");
    const opts = vi.mocked(keymap.pushScope).mock.calls[0][1] as { onEscape: () => void };

    opts.onEscape();
    expect(jobsCtrl.open).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("closes itself when the last job finishes", async () => {
    jobsCtrl.onStarted(job({ id: 12 }));
    jobsCtrl.toggle();
    await flush();
    jobsCtrl.onFinished({ id: 12, outcome: "ok" });
    expect(jobsCtrl.open).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("a close before the tick never pushes a scope", async () => {
    jobsCtrl.onStarted(job({ id: 13 }));
    jobsCtrl.toggle();
    jobsCtrl.close();
    await flush();
    expect(keymap.pushScope).not.toHaveBeenCalled();
  });
});

describe("elapsed", () => {
  it("formats m:ss", () => {
    expect(elapsed(0)).toBe("0:00");
    expect(elapsed(65_400)).toBe("1:05");
    expect(elapsed(3_790_000)).toBe("63:10");
    expect(elapsed(-5)).toBe("0:00");
  });
});

describe("show (reopen a hidden progress modal)", () => {
  const sp = syncProgressCtrl as unknown as { open: boolean; jobId: number | null; canReopen: boolean; reopen: ReturnType<typeof vi.fn> };

  it("is offered only for the modal's own foreground job while it is hidden", () => {
    jobsCtrl.onStarted(job({ id: 21, background: false }));
    jobsCtrl.onStarted(job({ id: 22, background: true }));
    sp.jobId = 21;
    sp.canReopen = false;
    expect(jobsCtrl.canShow(jobsCtrl.jobs[0])).toBe(false);
    sp.canReopen = true;
    expect(jobsCtrl.canShow(jobsCtrl.jobs[0])).toBe(true);
    expect(jobsCtrl.canShow(jobsCtrl.jobs[1])).toBe(false);
    sp.jobId = 99;
    expect(jobsCtrl.canShow(jobsCtrl.jobs[0])).toBe(false);
  });

  it("closes the popover and reopens the modal", () => {
    jobsCtrl.onStarted(job({ id: 23, background: false }));
    sp.jobId = 23;
    sp.canReopen = true;
    jobsCtrl.open = true;
    jobsCtrl.show(23);
    expect(jobsCtrl.open).toBe(false);
    expect(sp.reopen).toHaveBeenCalledTimes(1);
    sp.canReopen = false;
    jobsCtrl.show(23);
    expect(sp.reopen).toHaveBeenCalledTimes(1);
  });
});
