// Tests for the bisect DRAWER controller — distinct from bisect.svelte.test.ts,
// which covers the real in-progress MODAL. This one covers the always-visible
// drawer's own pre-start row-model (arming good/bad/skip before a real bisect
// exists) and its sync-from-bisectCtrl bridge functions.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  BACKEND: null,
  CUR_REPO: "/repo",
  state: { selectedRow: -1, scrollTarget: 0 },
  layout: { rowH: 22 },
  view: { cssH: 400 },
  clampScroll: (v: number) => (v < 0 ? 0 : v),
  select: vi.fn(),
  requestRedraw: vi.fn(),
  ensureDrawerOpen: vi.fn(),
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
  hhex: (r: number) => "hex" + r,
  msgOf: (r: number) => "msg" + r,
}));

let mockInTauri = false;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));

vi.mock("../bisect/bisect.svelte.ts", () => ({
  bisectCtrl: {
    running: false,
    start: vi.fn(async () => {}),
    reset: vi.fn(),
    reopen: vi.fn(),
    openDemo: vi.fn(),
  },
}));

import * as bridge from "../../legacy/bridge";
import { bisectCtrl } from "../bisect/bisect.svelte.ts";
import { bisectDrawerCtrl, syncBisectMarks, focusBisectCurrent, clearBisectMarks, demoBisectStatus, demoBisectMark } from "./bisectdrawer.svelte.ts";

function resetAll() {
  bisectDrawerCtrl.good = null;
  bisectDrawerCtrl.bad = null;
  bisectDrawerCtrl.cur = null;
  bisectDrawerCtrl.skips = new Set();
  (bisectCtrl as any).running = false;
  (bridge as any).state.selectedRow = -1;
  (bridge as any).BACKEND = null;
  mockInTauri = false;
  vi.clearAllMocks();
}

beforeEach(() => {
  resetAll();
});

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", () => {
    expect(document.getElementById("cv")).toBeNull();
    expect(bisectDrawerCtrl).toBeDefined();
  });
});

describe("active / candidates", () => {
  it("is null until both good and bad are set", () => {
    bisectDrawerCtrl.good = 5;
    expect(bisectDrawerCtrl.active()).toBeNull();
  });

  it("normalizes lo/hi regardless of good/bad order", () => {
    bisectDrawerCtrl.good = 10;
    bisectDrawerCtrl.bad = 2;
    expect(bisectDrawerCtrl.active()).toEqual({ lo: 2, hi: 10, good: 10, bad: 2 });
  });

  it("candidates excludes both ends and any skipped row", () => {
    bisectDrawerCtrl.good = 0;
    bisectDrawerCtrl.bad = 5;
    bisectDrawerCtrl.skips = new Set([2]);
    expect(bisectDrawerCtrl.candidates()).toEqual([1, 3, 4]);
  });
});

describe("view getters", () => {
  it("stepsText/fillPct/rangeCells are all inert with no active range", () => {
    expect(bisectDrawerCtrl.stepsText).toBe("≈0 steps left");
    expect(bisectDrawerCtrl.fillPct).toBe(0);
    expect(bisectDrawerCtrl.rangeCells).toEqual([]);
  });

  it("curHtml shows the default hint with no active range", () => {
    expect(bisectDrawerCtrl.curHtml).toContain("Select a commit in the graph");
  });

  it("curHtml shows the isolated first-bad message when no candidates remain", () => {
    bisectDrawerCtrl.good = 4;
    bisectDrawerCtrl.bad = 5;
    expect(bisectDrawerCtrl.curHtml).toContain("First bad commit isolated");
    expect(bisectDrawerCtrl.curHtml).toContain("hex5");
  });

  it("curHtml shows the next-candidate message otherwise", () => {
    bisectDrawerCtrl.good = 0;
    bisectDrawerCtrl.bad = 10;
    expect(bisectDrawerCtrl.curHtml).toContain("Testing next");
  });

  it("rangeCells marks skipped rows as culled", () => {
    bisectDrawerCtrl.good = 0;
    bisectDrawerCtrl.bad = 3;
    bisectDrawerCtrl.skips = new Set([2]);
    const cells = bisectDrawerCtrl.rangeCells;
    expect(cells.some((c) => c.culled)).toBe(true);
  });
});

describe("mark", () => {
  it("warns and does nothing when a real bisect is already running", () => {
    (bisectCtrl as any).running = true;
    (bridge as any).state.selectedRow = 3;
    bisectDrawerCtrl.mark("good");
    expect(bisectDrawerCtrl.good).toBeNull();
    expect(bridge.tama.warn).not.toHaveBeenCalled(); // uses say(), not warn() — matches legacy
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("already running"));
  });

  it("warns and does nothing when no row is selected", () => {
    (bridge as any).state.selectedRow = -1;
    bisectDrawerCtrl.mark("bad");
    expect(bisectDrawerCtrl.bad).toBeNull();
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("Pick a commit"));
  });

  it("marks the selected row good, clearing it from bad if present", () => {
    (bridge as any).state.selectedRow = 4;
    bisectDrawerCtrl.bad = 4;
    bisectDrawerCtrl.mark("good");
    expect(bisectDrawerCtrl.good).toBe(4);
    expect(bisectDrawerCtrl.bad).toBeNull();
    expect(bridge.ensureDrawerOpen).toHaveBeenCalledWith("bisect");
  });

  it("marks the selected row bad, clearing it from good if present", () => {
    (bridge as any).state.selectedRow = 4;
    bisectDrawerCtrl.good = 4;
    bisectDrawerCtrl.mark("bad");
    expect(bisectDrawerCtrl.bad).toBe(4);
    expect(bisectDrawerCtrl.good).toBeNull();
  });

  it("adds the selected row to skips", () => {
    (bridge as any).state.selectedRow = 7;
    bisectDrawerCtrl.mark("skip");
    expect(bisectDrawerCtrl.skips.has(7)).toBe(true);
  });
});

describe("reset", () => {
  it("delegates to bisectCtrl.reset() when a real bisect is running", () => {
    (bisectCtrl as any).running = true;
    bisectDrawerCtrl.good = 2;
    bisectDrawerCtrl.reset();
    expect(bisectCtrl.reset).toHaveBeenCalled();
    expect(bisectDrawerCtrl.good).toBe(2); // untouched — bisectCtrl.reset() drives the real sync path
  });

  it("clears the local row-model when nothing is running", () => {
    bisectDrawerCtrl.good = 2;
    bisectDrawerCtrl.bad = 6;
    bisectDrawerCtrl.skips = new Set([3]);
    bisectDrawerCtrl.reset();
    expect(bisectDrawerCtrl.good).toBeNull();
    expect(bisectDrawerCtrl.bad).toBeNull();
    expect(bisectDrawerCtrl.skips.size).toBe(0);
    expect(bisectCtrl.reset).not.toHaveBeenCalled();
  });
});

describe("start", () => {
  it("reopens the modal when a real bisect is already running", async () => {
    (bisectCtrl as any).running = true;
    await bisectDrawerCtrl.start();
    expect(bisectCtrl.reopen).toHaveBeenCalled();
  });

  it("prompts for a good commit when none is armed", async () => {
    bisectDrawerCtrl.bad = 5;
    await bisectDrawerCtrl.start();
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("Select a known-good commit"));
    expect(bisectCtrl.start).not.toHaveBeenCalled();
  });

  it("design mode: opens bisectCtrl's demo modal instead of calling the backend", async () => {
    mockInTauri = false;
    bisectDrawerCtrl.good = 0;
    bisectDrawerCtrl.bad = 10;
    await bisectDrawerCtrl.start();
    expect(bisectCtrl.openDemo).toHaveBeenCalled();
    expect(bisectCtrl.start).not.toHaveBeenCalled();
  });

  it("real mode: calls bisectCtrl.start with the repo + resolved shas", async () => {
    mockInTauri = true;
    (bridge as any).BACKEND = { rows: [{ sha: "goodsha" }, {}, {}, {}, {}, { sha: "badsha" }] };
    bisectDrawerCtrl.good = 0;
    bisectDrawerCtrl.bad = 5;
    await bisectDrawerCtrl.start();
    expect(bisectCtrl.start).toHaveBeenCalledWith("/repo", "badsha", "goodsha");
  });

  it("bad defaults to row 0 (HEAD) when unset", async () => {
    mockInTauri = true;
    bisectDrawerCtrl.good = 3;
    await bisectDrawerCtrl.start();
    expect(bisectCtrl.start).toHaveBeenCalledWith("/repo", "hex0", "hex3");
  });
});

describe("bridge functions (syncBisectMarks / focusBisectCurrent / clearBisectMarks / demoBisectStatus / demoBisectMark)", () => {
  it("syncBisectMarks resolves good/bad/cur rows from a real BisectStatus via BACKEND shas", () => {
    (bridge as any).BACKEND = { rows: [{ sha: "g" }, { sha: "mid" }, { sha: "b" }] };
    syncBisectMarks({ firstBad: null, badRef: "b", goodRefs: ["g"], current: { sha: "g" } } as any);
    expect(bisectDrawerCtrl.bad).toBe(2);
    expect(bisectDrawerCtrl.good).toBe(0);
  });

  it("syncBisectMarks(null) clears everything", () => {
    bisectDrawerCtrl.good = 1;
    bisectDrawerCtrl.bad = 2;
    syncBisectMarks(null);
    expect(bisectDrawerCtrl.good).toBeNull();
    expect(bisectDrawerCtrl.bad).toBeNull();
  });

  it("focusBisectCurrent selects + scrolls to the current row", () => {
    bisectDrawerCtrl.cur = 4;
    focusBisectCurrent();
    expect(bridge.select).toHaveBeenCalledWith(4);
  });

  it("focusBisectCurrent is a no-op when cur is null", () => {
    focusBisectCurrent();
    expect(bridge.select).not.toHaveBeenCalled();
  });

  it("clearBisectMarks clears good/bad/cur/skips", () => {
    bisectDrawerCtrl.good = 1;
    bisectDrawerCtrl.skips = new Set([2]);
    clearBisectMarks();
    expect(bisectDrawerCtrl.good).toBeNull();
    expect(bisectDrawerCtrl.skips.size).toBe(0);
  });

  it("demoBisectStatus reports converged once no candidates remain", () => {
    bisectDrawerCtrl.good = 4;
    bisectDrawerCtrl.bad = 5;
    const st = demoBisectStatus() as any;
    expect(st.inProgress).toBe(false);
    expect(st.firstBad.sha).toBe("hex5");
  });

  it("demoBisectMark marks the current candidate and re-derives status", () => {
    bisectDrawerCtrl.good = 0;
    bisectDrawerCtrl.bad = 10;
    bisectDrawerCtrl.cur = 5; // as if demoBisectStatus had already run
    const st = demoBisectMark("bad") as any;
    expect(bisectDrawerCtrl.bad).toBe(5);
    expect(st).toBeDefined();
  });
});
