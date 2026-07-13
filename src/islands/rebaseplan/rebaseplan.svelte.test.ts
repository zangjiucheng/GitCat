// Tests for the interactive-rebase planner controller.
//
// Isolation: rebaseplan.svelte.ts imports `../../legacy/bridge` (a live
// re-export of `../../legacy/main`, a vanilla script that boots a whole canvas
// app as an import side effect and throws in bare jsdom) AND
// `../resolver/resolver.svelte.ts` (the conflict/editing handoff target) —
// both mocked below, mirroring resolver.svelte.test.ts's own `vi.mock`
// scaffolding exactly.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  reloadGraph: vi.fn(async () => {}),
  cheer: vi.fn(),
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
  selectWorkdir: vi.fn(),
}));

// Real-mode by default (mirrors workdir.svelte.test.ts's own IN_TAURI mock
// scaffolding) — the "demo mode" describe block below flips this back to
// false via vi.resetModules()/vi.doMock for the browser-design-mode path.
let mockInTauri = true;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    rebaseInteractivePlan: vi.fn(),
    rebaseInteractiveStart: vi.fn(),
  },
}));

vi.mock("../resolver/resolver.svelte.ts", () => ({
  resolver: {
    open: false,
    op: "cherry-pick",
    editing: false,
    openFromResult: vi.fn(),
  },
}));

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { resolver } from "../resolver/resolver.svelte.ts";
import type { PlanCommit, RebaseResult } from "../../ipc/bindings";
import { rebasePlanCtrl } from "./rebaseplan.svelte.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}

function planCommit(partial: Partial<PlanCommit>): PlanCommit {
  return { sha: "0".repeat(40), shortSha: "0000000", subject: "subject", ...partial };
}

function rebaseResult(partial: Partial<RebaseResult>): RebaseResult {
  return { ok: true, state: "clean", conflictedFiles: [], message: "", backupRef: null, blockedByLocalChanges: false, ...partial };
}

const C1 = planCommit({ sha: "1".repeat(40), shortSha: "1111111", subject: "add one.txt" });
const C2 = planCommit({ sha: "2".repeat(40), shortSha: "2222222", subject: "add two.txt" });
const C3 = planCommit({ sha: "3".repeat(40), shortSha: "3333333", subject: "add three.txt" });

function resetPlan() {
  rebasePlanCtrl.open = false;
  rebasePlanCtrl.busy = false;
  rebasePlanCtrl.demo = false;
  rebasePlanCtrl.onto = "";
  rebasePlanCtrl.rows = [];
  rebasePlanCtrl.repo = "";
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInTauri = true;
  resetPlan();
});

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", () => {
    expect(document.getElementById("cv")).toBeNull();
    expect(rebasePlanCtrl).toBeDefined();
  });
});

describe("openFor", () => {
  it("populates rows from rebase_interactive_plan, all defaulted to pick, in the order returned", async () => {
    vi.mocked(commands.rebaseInteractivePlan).mockResolvedValueOnce(ok([C1, C2, C3]));

    await rebasePlanCtrl.openFor("repo1", "main");

    expect(commands.rebaseInteractivePlan).toHaveBeenCalledWith("repo1", "main");
    expect(rebasePlanCtrl.open).toBe(true);
    expect(rebasePlanCtrl.onto).toBe("main");
    expect(rebasePlanCtrl.rows.map((r) => r.sha)).toEqual([C1.sha, C2.sha, C3.sha]);
    expect(rebasePlanCtrl.rows.every((r) => r.action === "pick")).toBe(true);
  });

  it("warns via Tama instead of opening the planner without a repo", async () => {
    await rebasePlanCtrl.openFor("", "main");
    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(commands.rebaseInteractivePlan).not.toHaveBeenCalled();
    expect(rebasePlanCtrl.open).toBe(false);
  });

  it("an empty plan (already up to date) warns instead of opening an empty planner", async () => {
    vi.mocked(commands.rebaseInteractivePlan).mockResolvedValueOnce(ok([]));

    await rebasePlanCtrl.openFor("repo1", "main");

    expect(rebasePlanCtrl.open).toBe(false);
    expect(bridge.tama.say).toHaveBeenCalled();
  });

  it("a plan error warns and never opens the planner", async () => {
    vi.mocked(commands.rebaseInteractivePlan).mockResolvedValueOnce(err("bad revision"));

    await rebasePlanCtrl.openFor("repo1", "bogus");

    expect(rebasePlanCtrl.open).toBe(false);
    expect(bridge.tama.warn).toHaveBeenCalledWith("bad revision");
  });

  it("busy/re-entrancy: a second openFor() call while one is in flight is a no-op", async () => {
    rebasePlanCtrl.busy = true;
    await rebasePlanCtrl.openFor("repo1", "main");
    expect(commands.rebaseInteractivePlan).not.toHaveBeenCalled();
  });
});

describe("reorder", () => {
  it("splices rows without any backend call (pure client-side until start())", () => {
    rebasePlanCtrl.rows = [
      { ...C1, action: "pick" },
      { ...C2, action: "pick" },
      { ...C3, action: "pick" },
    ];

    rebasePlanCtrl.reorder(0, 2);

    expect(rebasePlanCtrl.rows.map((r) => r.sha)).toEqual([C2.sha, C3.sha, C1.sha]);
    expect(commands.rebaseInteractivePlan).not.toHaveBeenCalled();
    expect(commands.rebaseInteractiveStart).not.toHaveBeenCalled();
  });

  it("ignores an out-of-range index instead of corrupting rows", () => {
    rebasePlanCtrl.rows = [
      { ...C1, action: "pick" },
      { ...C2, action: "pick" },
    ];

    rebasePlanCtrl.reorder(0, 5);

    expect(rebasePlanCtrl.rows.map((r) => r.sha)).toEqual([C1.sha, C2.sha]);
  });

  it("a no-op reorder (same index twice) changes nothing", () => {
    rebasePlanCtrl.rows = [
      { ...C1, action: "pick" },
      { ...C2, action: "pick" },
    ];

    rebasePlanCtrl.reorder(1, 1);

    expect(rebasePlanCtrl.rows.map((r) => r.sha)).toEqual([C1.sha, C2.sha]);
  });
});

describe("setAction", () => {
  it("sets the action for the matching row by sha", () => {
    rebasePlanCtrl.rows = [
      { ...C1, action: "pick" },
      { ...C2, action: "pick" },
    ];

    rebasePlanCtrl.setAction(C2.sha, "drop");

    expect(rebasePlanCtrl.rows[0].action).toBe("pick");
    expect(rebasePlanCtrl.rows[1].action).toBe("drop");
  });

  it("refuses to set squash on row index 0 (client-side mirror of the backend rule)", () => {
    rebasePlanCtrl.rows = [
      { ...C1, action: "pick" },
      { ...C2, action: "pick" },
    ];

    rebasePlanCtrl.setAction(C1.sha, "squash");

    expect(rebasePlanCtrl.rows[0].action).toBe("pick");
  });

  it("refuses to set fixup on row index 0 (client-side mirror of the backend rule)", () => {
    rebasePlanCtrl.rows = [
      { ...C1, action: "pick" },
      { ...C2, action: "pick" },
    ];

    rebasePlanCtrl.setAction(C1.sha, "fixup");

    expect(rebasePlanCtrl.rows[0].action).toBe("pick");
  });

  it("still allows squash/fixup on a NON-first row", () => {
    rebasePlanCtrl.rows = [
      { ...C1, action: "pick" },
      { ...C2, action: "pick" },
    ];

    rebasePlanCtrl.setAction(C2.sha, "squash");

    expect(rebasePlanCtrl.rows[1].action).toBe("squash");
  });

  it("is a no-op for an unknown sha", () => {
    rebasePlanCtrl.rows = [{ ...C1, action: "pick" }];

    rebasePlanCtrl.setAction("deadbeef", "drop");

    expect(rebasePlanCtrl.rows[0].action).toBe("pick");
  });
});

describe("start", () => {
  it("clean result: closes the planner, reloads the graph, and cheers", async () => {
    rebasePlanCtrl.open = true;
    rebasePlanCtrl.onto = "main";
    rebasePlanCtrl.rows = [{ ...C1, action: "pick" }, { ...C2, action: "drop" }];
    vi.mocked(commands.rebaseInteractiveStart).mockResolvedValueOnce(
      rebaseResult({ state: "clean", message: "Rebased." }),
    );

    await rebasePlanCtrl.start();

    expect(commands.rebaseInteractiveStart).toHaveBeenCalledWith("", "main", [
      { sha: C1.sha, action: "pick" },
      { sha: C2.sha, action: "drop" },
    ]);
    expect(rebasePlanCtrl.open).toBe(false);
    expect(rebasePlanCtrl.rows).toHaveLength(0);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(bridge.cheer).toHaveBeenCalled();
    expect(rebasePlanCtrl.busy).toBe(false);
  });

  it("empty result: closes the planner and reloads the graph without cheering", async () => {
    rebasePlanCtrl.open = true;
    rebasePlanCtrl.rows = [{ ...C1, action: "pick" }];
    vi.mocked(commands.rebaseInteractiveStart).mockResolvedValueOnce(
      rebaseResult({ ok: false, state: "empty", message: "Already up to date." }),
    );

    await rebasePlanCtrl.start();

    expect(rebasePlanCtrl.open).toBe(false);
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(bridge.cheer).not.toHaveBeenCalled();
  });

  it("conflict result: hands off into the resolver's shared conflict UI", async () => {
    rebasePlanCtrl.open = true;
    rebasePlanCtrl.onto = "main";
    rebasePlanCtrl.rows = [{ ...C1, action: "pick" }];
    const res = rebaseResult({ ok: false, state: "conflict", conflictedFiles: ["a.ts"] });
    vi.mocked(commands.rebaseInteractiveStart).mockResolvedValueOnce(res);

    await rebasePlanCtrl.start();

    expect(rebasePlanCtrl.open).toBe(false); // the planner itself closes...
    expect(resolver.openFromResult).toHaveBeenCalledWith("", res, "main", "rebase");
  });

  it("editing result: hands off into the resolver's editing-banner mode", async () => {
    rebasePlanCtrl.open = true;
    rebasePlanCtrl.onto = "main";
    rebasePlanCtrl.rows = [{ ...C1, action: "edit" }];
    const res = rebaseResult({ ok: false, state: "editing", message: "Paused to edit 1111111." });
    vi.mocked(commands.rebaseInteractiveStart).mockResolvedValueOnce(res);

    await rebasePlanCtrl.start();

    expect(rebasePlanCtrl.open).toBe(false);
    expect(resolver.openFromResult).toHaveBeenCalledWith("", res, "main", "rebase");
  });

  it("error result: warns via Tama and leaves the planner open", async () => {
    rebasePlanCtrl.open = true;
    rebasePlanCtrl.rows = [{ ...C1, action: "pick" }];
    vi.mocked(commands.rebaseInteractiveStart).mockResolvedValueOnce(
      rebaseResult({ ok: false, state: "error", message: "out of date" }),
    );

    await rebasePlanCtrl.start();

    expect(rebasePlanCtrl.open).toBe(true);
    expect(bridge.tama.warn).toHaveBeenCalledWith("out of date");
  });

  it("busy/re-entrancy: a second start() call while one is in flight is a no-op", async () => {
    rebasePlanCtrl.rows = [{ ...C1, action: "pick" }];
    rebasePlanCtrl.busy = true;

    await rebasePlanCtrl.start();

    expect(commands.rebaseInteractiveStart).not.toHaveBeenCalled();
  });

  it("is a no-op with no rows", async () => {
    rebasePlanCtrl.rows = [];

    await rebasePlanCtrl.start();

    expect(commands.rebaseInteractiveStart).not.toHaveBeenCalled();
  });

  it("demo mode: closes without any IPC call and cheers", async () => {
    rebasePlanCtrl.demo = true;
    rebasePlanCtrl.open = true;
    rebasePlanCtrl.rows = [{ ...C1, action: "pick" }];

    await rebasePlanCtrl.start();

    expect(rebasePlanCtrl.open).toBe(false);
    expect(commands.rebaseInteractiveStart).not.toHaveBeenCalled();
    expect(bridge.cheer).toHaveBeenCalled();
  });
});

describe("close", () => {
  it("clears open and rows", () => {
    rebasePlanCtrl.open = true;
    rebasePlanCtrl.rows = [{ ...C1, action: "pick" }];

    rebasePlanCtrl.close();

    expect(rebasePlanCtrl.open).toBe(false);
    expect(rebasePlanCtrl.rows).toHaveLength(0);
  });
});

describe("canStart", () => {
  it("is false with no rows, true with rows and not busy, false while busy", () => {
    rebasePlanCtrl.rows = [];
    expect(rebasePlanCtrl.canStart).toBe(false);

    rebasePlanCtrl.rows = [{ ...C1, action: "pick" }];
    expect(rebasePlanCtrl.canStart).toBe(true);

    rebasePlanCtrl.busy = true;
    expect(rebasePlanCtrl.canStart).toBe(false);
  });
});

// Browser design-mode path (no Tauri backend) — mirrors workdir.svelte.test.ts's
// own "demo mode" describe block: reset modules and re-mock ../../ipc/env so
// IN_TAURI is false from FIRST import, proving openFor() takes the demo
// branch with zero IPC calls rather than merely toggling a flag after the
// fact.
describe("demo mode (browser, no Tauri)", () => {
  it("openFor() seeds canned demo rows with zero IPC calls", async () => {
    vi.resetModules();
    vi.doMock("../../ipc/env", () => ({ IN_TAURI: false }));
    const bindingsDemo = await import("../../ipc/bindings");
    const { rebasePlanCtrl: demoCtrl } = await import("./rebaseplan.svelte.ts");

    await demoCtrl.openFor("", "main");

    expect(demoCtrl.open).toBe(true);
    expect(demoCtrl.demo).toBe(true);
    expect(demoCtrl.rows.length).toBeGreaterThan(0);
    expect(demoCtrl.rows.every((r) => r.action === "pick")).toBe(true);
    expect(bindingsDemo.commands.rebaseInteractivePlan).not.toHaveBeenCalled();
  });
});
