// Tests for the bisect controller.
//
// Same isolation strategy as resolver.svelte.test.ts: legacy/bridge is mocked
// so legacy/main.ts (a whole vanilla canvas app that boots on import) is never
// evaluated. See that file's header comment for the full rationale.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  reloadGraph: vi.fn(async () => {}),
  cheer: vi.fn(),
  highlight: vi.fn(),
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
  TAMA_IMG: { alarm: "alarm.png", happy: "happy.png", curious: "curious.png" },
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
    bisectStart: vi.fn(),
    bisectMark: vi.fn(),
    bisectStatus: vi.fn(),
    bisectReset: vi.fn(),
    bisectRunStart: vi.fn(),
    bisectRunCancel: vi.fn(),
  },
}));

// IN_TAURI is mocked per-describe-block (not globally), same pattern as
// rerere.svelte.test.ts: probeOnOpen is IN_TAURI-guarded (design-mode has no
// backend to probe), so tests need to flip it.
let mockInTauri = false;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import type { BisectStatus, CommitInfo } from "../../ipc/bindings";
import { bisectCtrl } from "./bisect.svelte.ts";

function status(partial: Partial<BisectStatus>): BisectStatus {
  return {
    ok: true,
    inProgress: true,
    current: null,
    badRef: null,
    goodRefs: [],
    remainingRevs: 0,
    estSteps: 0,
    firstBad: null,
    log: [],
    message: "",
    backupRef: null,
    ...partial,
  };
}

const CUR: CommitInfo = { sha: "abc1234", subject: "wip" };
const BAD: CommitInfo = { sha: "bad5678", subject: "the bug" };

function resetBisect() {
  bisectCtrl.open = false;
  bisectCtrl.busy = false;
  bisectCtrl.demo = false;
  bisectCtrl.vm = null;
  bisectCtrl.tamaImg = "";
  bisectCtrl.est0 = 0;
  bisectCtrl.cheered = false;
  bisectCtrl.repo = "";
  bisectCtrl.runCommand = "";
  bisectCtrl.autoRunning = false;
}

type TauriWindow = Window & { __TAURI__?: { event: { listen: ReturnType<typeof vi.fn> } } };

beforeEach(() => {
  vi.clearAllMocks();
  mockInTauri = false;
  resetBisect();
  delete (window as TauriWindow).__TAURI__;
});

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", () => {
    expect(document.getElementById("cv")).toBeNull();
    expect(bisectCtrl).toBeDefined();
  });
});

describe("start", () => {
  it("success opens the modal and syncs the canvas cues", async () => {
    vi.mocked(commands.bisectStart).mockResolvedValueOnce(
      status({ inProgress: true, current: CUR, remainingRevs: 7, estSteps: 3 }),
    );
    vi.mocked(commands.bisectStatus).mockResolvedValueOnce(
      status({ inProgress: true, current: CUR, remainingRevs: 7, estSteps: 3 }),
    );

    await bisectCtrl.start("repo1", "bad", "good");

    expect(commands.bisectStart).toHaveBeenCalledWith("repo1", "bad", ["good"]);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(bridge.syncBisectMarks).toHaveBeenCalled();
    expect(bridge.focusBisectCurrent).toHaveBeenCalled();
    expect(bisectCtrl.open).toBe(true);
    expect(bisectCtrl.busy).toBe(false);
  });

  it("failure (ok:false) does not open the modal", async () => {
    vi.mocked(commands.bisectStart).mockResolvedValueOnce(
      status({ ok: false, inProgress: false, message: "bad ref" }),
    );

    await bisectCtrl.start("repo1", "bad", "good");

    expect(bisectCtrl.open).toBe(false);
    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
  });

  it("warns via Tama instead of starting without a repo", async () => {
    await bisectCtrl.start("", "bad", "good");
    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(commands.bisectStart).not.toHaveBeenCalled();
  });
});

describe("mark", () => {
  it("success updates .vm and re-derives .done/.statText/.fillPct while running", async () => {
    bisectCtrl.repo = "repo1";
    bisectCtrl.est0 = 4;
    vi.mocked(commands.bisectMark).mockResolvedValueOnce(
      status({ inProgress: true, current: CUR, remainingRevs: 2, estSteps: 2 }),
    );
    vi.mocked(commands.bisectStatus).mockResolvedValueOnce(
      status({ inProgress: true, current: CUR, remainingRevs: 2, estSteps: 2 }),
    );

    await bisectCtrl.mark("bad");

    expect(commands.bisectMark).toHaveBeenCalledWith("repo1", "bad");
    expect(bisectCtrl.done).toBe(false);
    expect(bisectCtrl.statText).toBe("2 revisions left · ~2 steps");
    expect(bisectCtrl.fillPct).toBe(50); // 100 * (1 - 2/4)
  });

  it("convergence: .done/.fillPct flip and cheer fires exactly once even across two renders", async () => {
    bisectCtrl.repo = "repo1";
    const converged = status({ inProgress: false, firstBad: BAD, remainingRevs: 0, estSteps: 0 });
    vi.mocked(commands.bisectMark).mockResolvedValueOnce(converged);
    vi.mocked(commands.bisectStatus).mockResolvedValueOnce(converged);

    await bisectCtrl.mark("bad");

    expect(bisectCtrl.done).toBe(true);
    expect(bisectCtrl.fillPct).toBe(100);
    expect(bisectCtrl.statText).toBe("converged — first bad commit isolated");
    expect(bridge.cheer).toHaveBeenCalledTimes(1);

    // Re-render / re-apply the same status a second time (e.g. a second
    // refresh tick) — the one-shot cheer must not fire again.
    vi.mocked(commands.bisectStatus).mockResolvedValueOnce(converged);
    await bisectCtrl.mark("bad");
    expect(bridge.cheer).toHaveBeenCalledTimes(1);
  });

  it("mark failure surfaces a warning but does not throw", async () => {
    bisectCtrl.repo = "repo1";
    vi.mocked(commands.bisectMark).mockResolvedValueOnce(status({ ok: false, message: "no such rev" }));
    vi.mocked(commands.bisectStatus).mockResolvedValueOnce(status({ ok: false, message: "no such rev" }));

    await bisectCtrl.mark("good");

    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(bisectCtrl.busy).toBe(false);
  });

  it("demo mode: routes through bridge.demoBisectMark, no IPC call", () => {
    bisectCtrl.openDemo(status({ inProgress: true, current: CUR, remainingRevs: 5, estSteps: 2 }));
    vi.mocked(bridge.demoBisectMark).mockReturnValueOnce(
      status({ inProgress: true, current: CUR, remainingRevs: 3, estSteps: 1 }) as unknown as ReturnType<
        typeof bridge.demoBisectMark
      >,
    );

    bisectCtrl.mark("skip");

    expect(bridge.demoBisectMark).toHaveBeenCalledWith("skip");
    expect(commands.bisectMark).not.toHaveBeenCalled();
    expect(bisectCtrl.vm?.remainingRevs).toBe(3);
  });

  // Bug 3 regression: defense-in-depth — mark()'s own guard must reject a
  // call while an automated run is active, matching reset()'s existing
  // `busy || autoRunning` pattern. Unreachable via the shipped UI today
  // (`marksDisabled` already disables the mark buttons on `autoRunning`), but
  // there's no backend-side lock against a concurrent `bisect_mark` call
  // either, so this guards a stray/direct call from racing the automated
  // run's own good/bad/skip calls mid-loop.
  it("is a no-op while an automated run is active, even though busy/repo would otherwise allow it", async () => {
    bisectCtrl.repo = "repo1";
    bisectCtrl.busy = false;
    bisectCtrl.autoRunning = true;

    await bisectCtrl.mark("bad");

    expect(commands.bisectMark).not.toHaveBeenCalled();
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
  });
});

// Deferred helper: lets a test hold `bisectRunStart`'s promise open so it can
// fire simulated "bisect-run-progress" events (via the captured listener
// handler) while the awaited call is still pending, exactly like the real
// long-lived backend loop.
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("startRun / cancelRun", () => {
  let mockUnlisten: ReturnType<typeof vi.fn>;
  let mockListen: ReturnType<typeof vi.fn>;
  let capturedHandler: ((e: { payload: BisectStatus }) => void) | null;

  beforeEach(() => {
    mockUnlisten = vi.fn();
    capturedHandler = null;
    // Not `async` — captures the handler SYNCHRONOUSLY (before the returned
    // promise even needs a microtask to resolve), so tests can assert on the
    // subscribe-before-blocking-call ordering deterministically.
    mockListen = vi.fn((_event: string, handler: (e: { payload: BisectStatus }) => void) => {
      capturedHandler = handler;
      return Promise.resolve(mockUnlisten);
    });
    (window as unknown as TauriWindow).__TAURI__ = { event: { listen: mockListen } };
  });

  it("subscribes to bisect-run-progress BEFORE the blocking call, toggles autoRunning, and calls bisectRunStart with repo+command", async () => {
    bisectCtrl.repo = "repo1";
    bisectCtrl.runCommand = "  npm test  ";
    const { promise, resolve } = deferred<BisectStatus>();
    vi.mocked(commands.bisectRunStart).mockReturnValueOnce(promise);

    const runP = bisectCtrl.startRun("repo1");
    await Promise.resolve();
    await Promise.resolve();

    expect(mockListen).toHaveBeenCalledWith("bisect-run-progress", expect.any(Function));
    expect(commands.bisectRunStart).toHaveBeenCalledWith("repo1", "npm test");
    expect(bisectCtrl.autoRunning).toBe(true);

    resolve(status({ inProgress: false, firstBad: BAD }));
    await runP;

    expect(bisectCtrl.autoRunning).toBe(false);
  });

  it("progress events received mid-run update state via the same path a manual mark uses, and the listener is unsubscribed once the run completes", async () => {
    bisectCtrl.repo = "repo1";
    bisectCtrl.runCommand = "npm test";
    const { promise, resolve } = deferred<BisectStatus>();
    vi.mocked(commands.bisectRunStart).mockReturnValueOnce(promise);

    const runP = bisectCtrl.startRun("repo1");
    await Promise.resolve();
    await Promise.resolve();

    expect(capturedHandler).toBeTypeOf("function");
    capturedHandler!({ payload: status({ inProgress: true, current: CUR, remainingRevs: 3, estSteps: 2 }) });

    // same effects applyStatus() gives a manual mark: vm updated + canvas cues driven
    expect(bisectCtrl.vm?.current).toEqual(CUR);
    expect(bisectCtrl.statText).toBe("3 revisions left · ~2 steps");
    expect(bridge.syncBisectMarks).toHaveBeenCalled();
    expect(bridge.focusBisectCurrent).toHaveBeenCalled();
    expect(mockUnlisten).not.toHaveBeenCalled();

    resolve(status({ inProgress: false, firstBad: BAD }));
    await runP;

    expect(mockUnlisten).toHaveBeenCalledTimes(1);
  });

  it("cancelRun calls bisectRunCancel", async () => {
    vi.mocked(commands.bisectRunCancel).mockResolvedValueOnce({ status: "ok", data: null });

    await bisectCtrl.cancelRun();

    expect(commands.bisectRunCancel).toHaveBeenCalled();
  });

  it("refuses to start without a command", async () => {
    bisectCtrl.repo = "repo1";
    bisectCtrl.runCommand = "   ";

    await bisectCtrl.startRun("repo1");

    expect(commands.bisectRunStart).not.toHaveBeenCalled();
    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(bisectCtrl.autoRunning).toBe(false);
  });

  describe("cancelIfRunning", () => {
    it("requests cancellation when an automated run is active", async () => {
      vi.mocked(commands.bisectRunCancel).mockResolvedValueOnce({ status: "ok", data: null });
      bisectCtrl.autoRunning = true;

      await bisectCtrl.cancelIfRunning();

      expect(commands.bisectRunCancel).toHaveBeenCalled();
    });

    it("is a no-op when no run is active", async () => {
      bisectCtrl.autoRunning = false;

      await bisectCtrl.cancelIfRunning();

      expect(commands.bisectRunCancel).not.toHaveBeenCalled();
    });
  });
});

// Bug 2 regression: closing the modal must not silently abandon an in-flight
// automated run — the backend loop is a real, long-lived blocking call that
// keeps executing headlessly otherwise. legacy/main.ts's openRepo() (a whole
// vanilla canvas app that boots on import — see the isolation note at the top
// of this file) shares the exact same guard via bisectCtrl.cancelIfRunning,
// tested directly above; openRepo() itself has no test harness in this
// codebase (every other test mocks legacy/bridge specifically to avoid
// evaluating legacy/main.ts), so it isn't re-tested here.
describe("close", () => {
  it("hides the modal instantly and requests cancellation when an automated run is active", () => {
    bisectCtrl.open = true;
    bisectCtrl.autoRunning = true;

    bisectCtrl.close();

    expect(bisectCtrl.open).toBe(false);
    expect(commands.bisectRunCancel).toHaveBeenCalled();
  });

  it("hides the modal without requesting cancellation when no run is active", () => {
    bisectCtrl.open = true;
    bisectCtrl.autoRunning = false;

    bisectCtrl.close();

    expect(bisectCtrl.open).toBe(false);
    expect(commands.bisectRunCancel).not.toHaveBeenCalled();
  });
});

describe("reset", () => {
  it("success closes and clears the vm", async () => {
    bisectCtrl.open = true;
    bisectCtrl.repo = "repo1";
    bisectCtrl.vm = status({ inProgress: true });
    vi.mocked(commands.bisectReset).mockResolvedValueOnce(status({ ok: true, inProgress: false, message: "done" }));

    await bisectCtrl.reset();

    expect(bisectCtrl.open).toBe(false);
    expect(bisectCtrl.vm).toBeNull();
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(bridge.clearBisectMarks).toHaveBeenCalled();
  });

  it("failure keeps the modal open and retriable — never strand a live bisect", async () => {
    bisectCtrl.open = true;
    bisectCtrl.repo = "repo1";
    bisectCtrl.vm = status({ inProgress: true });
    vi.mocked(commands.bisectReset).mockResolvedValueOnce(
      status({ ok: false, inProgress: true, message: "dirty tree" }),
    );

    await bisectCtrl.reset();

    expect(bisectCtrl.open).toBe(true);
    expect(bisectCtrl.vm).not.toBeNull();
    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
    expect(bisectCtrl.busy).toBe(false);
  });

  it("demo mode: closes without any IPC call", () => {
    bisectCtrl.openDemo(status({ inProgress: true }));

    bisectCtrl.reset();

    expect(bisectCtrl.open).toBe(false);
    expect(bisectCtrl.demo).toBe(false);
    expect(commands.bisectReset).not.toHaveBeenCalled();
    expect(bridge.clearBisectMarks).toHaveBeenCalled();
  });
});

describe("openDemo", () => {
  it("opens the modal, marking demo mode, without any IPC call", () => {
    bisectCtrl.openDemo(status({ inProgress: true, current: CUR, remainingRevs: 10, estSteps: 4 }));

    expect(bisectCtrl.open).toBe(true);
    expect(bisectCtrl.demo).toBe(true);
    expect(bisectCtrl.vm?.current).toEqual(CUR);
    expect(commands.bisectStart).not.toHaveBeenCalled();
    expect(commands.bisectStatus).not.toHaveBeenCalled();
  });
});

describe("probeOnOpen", () => {
  it("a repo with an in-progress bisect resurfaces the modal, syncing the canvas cues like a normal refresh", async () => {
    mockInTauri = true;
    vi.mocked(commands.bisectStatus).mockResolvedValueOnce(
      status({ inProgress: true, current: CUR, remainingRevs: 5, estSteps: 2 }),
    );

    await bisectCtrl.probeOnOpen("repo1");

    expect(commands.bisectStatus).toHaveBeenCalledWith("repo1");
    expect(bisectCtrl.repo).toBe("repo1");
    expect(bisectCtrl.open).toBe(true);
    expect(bisectCtrl.vm?.current).toEqual(CUR);
    expect(bridge.syncBisectMarks).toHaveBeenCalled();
    expect(bridge.focusBisectCurrent).toHaveBeenCalled();
    // passive recovery: a one-time heads-up, but never the busy/"thinking"
    // states start()/mark() use for an active mutation.
    expect(bridge.tama.say).toHaveBeenCalled();
    expect(bridge.tama.set).not.toHaveBeenCalledWith("thinking");
    expect(bisectCtrl.busy).toBe(false);
  });

  it("a repo with no bisect in progress leaves the modal closed and does not warn or error", async () => {
    mockInTauri = true;
    vi.mocked(commands.bisectStatus).mockResolvedValueOnce(status({ inProgress: false, ok: true }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await bisectCtrl.probeOnOpen("repo1");

    expect(commands.bisectStatus).toHaveBeenCalledWith("repo1");
    expect(bisectCtrl.open).toBe(false);
    expect(bisectCtrl.vm).toBeNull();
    expect(bridge.tama.warn).not.toHaveBeenCalled();
    expect(bridge.syncBisectMarks).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("an ok:false status also leaves the modal closed", async () => {
    mockInTauri = true;
    vi.mocked(commands.bisectStatus).mockResolvedValueOnce(status({ ok: false, inProgress: false }));

    await bisectCtrl.probeOnOpen("repo1");

    expect(bisectCtrl.open).toBe(false);
    expect(bridge.syncBisectMarks).not.toHaveBeenCalled();
  });

  it("a null/empty repo is a no-op: no IPC call, nothing opens", async () => {
    mockInTauri = true;

    await bisectCtrl.probeOnOpen("");

    expect(commands.bisectStatus).not.toHaveBeenCalled();
    expect(bisectCtrl.open).toBe(false);
  });

  it("design-mode (!IN_TAURI) is a no-op even with a repo path: no backend to probe", async () => {
    mockInTauri = false;

    await bisectCtrl.probeOnOpen("repo1");

    expect(commands.bisectStatus).not.toHaveBeenCalled();
    expect(bisectCtrl.open).toBe(false);
  });

  it("a thrown/rejected bisectStatus call is caught, not propagated, and leaves the modal closed", async () => {
    mockInTauri = true;
    vi.mocked(commands.bisectStatus).mockRejectedValueOnce(new Error("boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(bisectCtrl.probeOnOpen("repo1")).resolves.toBeUndefined();

    expect(bisectCtrl.open).toBe(false);
    expect(bisectCtrl.vm).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
