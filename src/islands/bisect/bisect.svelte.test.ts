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
    bisectStart: vi.fn(),
    bisectMark: vi.fn(),
    bisectStatus: vi.fn(),
    bisectReset: vi.fn(),
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
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInTauri = false;
  resetBisect();
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
