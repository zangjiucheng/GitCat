// Tests for the pickaxe / diff-content search controller.
//
// Same isolation strategy as blame.svelte.test.ts / filehistory.svelte.test.ts
// / plumbing.svelte.test.ts: legacy/bridge is mocked so legacy/main.ts (a
// whole vanilla canvas app that boots on import) is never evaluated. The
// `jumpToCommit` mocks mirror filehistory.svelte.test.ts's own G/BACKEND/
// state/layout/view/cv shape exactly, since pickaxeSearchCtrl.jumpToCommit
// deliberately mirrors fileHistoryCtrl.jumpToCommit's body.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  G: null,
  BACKEND: null,
  CUR_REPO: null,
  state: { scrollTarget: 0, maxScroll: 1000 },
  layout: { rowH: 22 },
  view: { cssH: 400 },
  cv: { focus: vi.fn() },
  bandH: vi.fn(() => 0),
  clampScroll: (v: number) => (v < 0 ? 0 : v > 1000 ? 1000 : v),
  select: vi.fn(),
  hhex: (r: number) => "hex" + r,
  relTime: (t: number) => "t" + t,
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    pickaxeSearch: vi.fn(),
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
import type { PickaxeResults } from "../../ipc/bindings";
import { pickaxeSearchCtrl } from "./pickaxesearch.svelte.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}

const RESULTS: PickaxeResults = {
  truncated: false,
  entries: [
    {
      sha: "a1b2c3da1b2c3da1b2c3da1b2c3da1b2c3da1b2",
      shortSha: "a1b2c3d",
      subject: "tweak session ttl",
      an: { n: "Dev", e: "d@x.com", t: 0 },
    },
    {
      sha: "bb01ccdbb01ccdbb01ccdbb01ccdbb01ccdbb01",
      shortSha: "bb01ccd",
      subject: "add rate limiting",
      an: { n: "Ada", e: "a@x.com", t: 0 },
    },
  ],
};

function setBackendGraph(rows: any[]) {
  (bridge as any).G = { N: rows.length };
  (bridge as any).BACKEND = { rows };
}

function resetCtrl() {
  pickaxeSearchCtrl.open = false;
  pickaxeSearchCtrl.query = "";
  pickaxeSearchCtrl.mode = "added-removed";
  pickaxeSearchCtrl.regex = false;
  pickaxeSearchCtrl.allRefs = false;
  pickaxeSearchCtrl.file = "";
  pickaxeSearchCtrl.busy = false;
  pickaxeSearchCtrl.error = "";
  pickaxeSearchCtrl.data = null;
  pickaxeSearchCtrl.repo = "";
  (bridge as any).G = null;
  (bridge as any).BACKEND = null;
  mockInTauri = true;
  vi.clearAllMocks();
}

beforeEach(() => {
  resetCtrl();
});

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", () => {
    expect(document.getElementById("cv")).toBeNull();
    expect(pickaxeSearchCtrl).toBeDefined();
  });
});

describe("show / close (Tools menu / ⌘K entry point)", () => {
  it("show() opens the panel and records the repo, without clearing a previous result", async () => {
    pickaxeSearchCtrl.repo = "/repo";
    pickaxeSearchCtrl.query = "sessionTtl";
    vi.mocked(commands.pickaxeSearch).mockResolvedValueOnce(ok(RESULTS));
    await pickaxeSearchCtrl.search();

    pickaxeSearchCtrl.open = false;
    pickaxeSearchCtrl.show("/repo");

    expect(pickaxeSearchCtrl.open).toBe(true);
    expect(pickaxeSearchCtrl.repo).toBe("/repo");
    expect(pickaxeSearchCtrl.data).toEqual(RESULTS); // unlike reflog/rerere, nothing to go stale here
  });

  it("close() is blocked while a search is in flight", () => {
    pickaxeSearchCtrl.open = true;
    pickaxeSearchCtrl.busy = true;
    pickaxeSearchCtrl.close();
    expect(pickaxeSearchCtrl.open).toBe(true);
  });

  it("close() otherwise closes it", () => {
    pickaxeSearchCtrl.open = true;
    pickaxeSearchCtrl.close();
    expect(pickaxeSearchCtrl.open).toBe(false);
  });
});

describe("search — real mode (IN_TAURI), query-param building per mode/flag combination", () => {
  it("added-removed mode, no regex, no all-refs, no file scope: forwards exactly those defaults", async () => {
    vi.mocked(commands.pickaxeSearch).mockResolvedValueOnce(ok(RESULTS));
    pickaxeSearchCtrl.repo = "/repo";
    pickaxeSearchCtrl.query = "sessionTtl";

    await pickaxeSearchCtrl.search();

    expect(commands.pickaxeSearch).toHaveBeenCalledWith("/repo", "sessionTtl", "added-removed", false, false, null, null);
    expect(pickaxeSearchCtrl.data).toEqual(RESULTS);
    expect(pickaxeSearchCtrl.error).toBe("");
    expect(pickaxeSearchCtrl.busy).toBe(false);
  });

  it("added-removed mode with regex checked: forwards regex:true", async () => {
    vi.mocked(commands.pickaxeSearch).mockResolvedValueOnce(ok(RESULTS));
    pickaxeSearchCtrl.repo = "/repo";
    pickaxeSearchCtrl.query = "sess.*Ttl";
    pickaxeSearchCtrl.regex = true;

    await pickaxeSearchCtrl.search();

    expect(commands.pickaxeSearch).toHaveBeenCalledWith("/repo", "sess.*Ttl", "added-removed", true, false, null, null);
  });

  it("diff-match mode: forwards mode:'diff-match', regex passed through as whatever the field holds (backend ignores it)", async () => {
    vi.mocked(commands.pickaxeSearch).mockResolvedValueOnce(ok(RESULTS));
    pickaxeSearchCtrl.repo = "/repo";
    pickaxeSearchCtrl.query = "TODO";
    pickaxeSearchCtrl.mode = "diff-match";

    await pickaxeSearchCtrl.search();

    expect(commands.pickaxeSearch).toHaveBeenCalledWith("/repo", "TODO", "diff-match", false, false, null, null);
  });

  it("search all branches checked: forwards allRefs:true", async () => {
    vi.mocked(commands.pickaxeSearch).mockResolvedValueOnce(ok(RESULTS));
    pickaxeSearchCtrl.repo = "/repo";
    pickaxeSearchCtrl.query = "foo";
    pickaxeSearchCtrl.allRefs = true;

    await pickaxeSearchCtrl.search();

    expect(commands.pickaxeSearch).toHaveBeenCalledWith("/repo", "foo", "added-removed", false, true, null, null);
  });

  it("a trimmed, non-empty file field scopes the search to that path", async () => {
    vi.mocked(commands.pickaxeSearch).mockResolvedValueOnce(ok(RESULTS));
    pickaxeSearchCtrl.repo = "/repo";
    pickaxeSearchCtrl.query = "foo";
    pickaxeSearchCtrl.file = "  src/auth/session.ts  ";

    await pickaxeSearchCtrl.search();

    expect(commands.pickaxeSearch).toHaveBeenCalledWith("/repo", "foo", "added-removed", false, false, "src/auth/session.ts", null);
  });

  it("a blank file field is sent as null, not an empty string", async () => {
    vi.mocked(commands.pickaxeSearch).mockResolvedValueOnce(ok(RESULTS));
    pickaxeSearchCtrl.repo = "/repo";
    pickaxeSearchCtrl.query = "foo";
    pickaxeSearchCtrl.file = "   ";

    await pickaxeSearchCtrl.search();

    expect(commands.pickaxeSearch).toHaveBeenCalledWith("/repo", "foo", "added-removed", false, false, null, null);
  });

  it("every flag combined at once builds the exact combined argv shape", async () => {
    vi.mocked(commands.pickaxeSearch).mockResolvedValueOnce(ok(RESULTS));
    pickaxeSearchCtrl.repo = "/repo";
    pickaxeSearchCtrl.query = "sess.*";
    pickaxeSearchCtrl.regex = true;
    pickaxeSearchCtrl.allRefs = true;
    pickaxeSearchCtrl.file = "src/a.ts";

    await pickaxeSearchCtrl.search();

    expect(commands.pickaxeSearch).toHaveBeenCalledWith("/repo", "sess.*", "added-removed", true, true, "src/a.ts", null);
  });
});

describe("search — loading / error / empty-results states", () => {
  it("sets busy while the round trip is in flight, then clears it", async () => {
    pickaxeSearchCtrl.repo = "/repo";
    pickaxeSearchCtrl.query = "foo";
    let resolveFn!: (v: unknown) => void;
    vi.mocked(commands.pickaxeSearch).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFn = resolve;
      }) as any,
    );

    const p = pickaxeSearchCtrl.search();
    expect(pickaxeSearchCtrl.busy).toBe(true);
    resolveFn(ok(RESULTS));
    await p;

    expect(pickaxeSearchCtrl.busy).toBe(false);
  });

  it("is a no-op re-entrancy guard while already busy", async () => {
    pickaxeSearchCtrl.repo = "/repo";
    pickaxeSearchCtrl.query = "foo";
    pickaxeSearchCtrl.busy = true;

    await pickaxeSearchCtrl.search();

    expect(commands.pickaxeSearch).not.toHaveBeenCalled();
  });

  it("empty query: local validation error, no IPC call", async () => {
    pickaxeSearchCtrl.repo = "/repo";
    pickaxeSearchCtrl.query = "   ";

    await pickaxeSearchCtrl.search();

    expect(commands.pickaxeSearch).not.toHaveBeenCalled();
    expect(pickaxeSearchCtrl.error).toMatch(/enter something/i);
    expect(pickaxeSearchCtrl.data).toBeNull();
  });

  it("no repo open: refuses without a round trip", async () => {
    pickaxeSearchCtrl.query = "foo";

    await pickaxeSearchCtrl.search();

    expect(commands.pickaxeSearch).not.toHaveBeenCalled();
    expect(pickaxeSearchCtrl.error).toMatch(/open a repository/i);
  });

  it("surfaces a clean backend error and clears data", async () => {
    pickaxeSearchCtrl.repo = "/repo";
    pickaxeSearchCtrl.query = "foo";
    vi.mocked(commands.pickaxeSearch).mockResolvedValueOnce(err("Enter something to search for."));

    await pickaxeSearchCtrl.search();

    expect(pickaxeSearchCtrl.data).toBeNull();
    expect(pickaxeSearchCtrl.error).toBe("Enter something to search for.");
  });

  it("a thrown IPC rejection is surfaced as an error, not left uncaught", async () => {
    pickaxeSearchCtrl.repo = "/repo";
    pickaxeSearchCtrl.query = "foo";
    vi.mocked(commands.pickaxeSearch).mockRejectedValueOnce(new Error("boom"));

    await pickaxeSearchCtrl.search();

    expect(pickaxeSearchCtrl.data).toBeNull();
    expect(pickaxeSearchCtrl.error).toContain("boom");
  });

  it("an ok response with zero matches is stored as an empty (not null) result", async () => {
    pickaxeSearchCtrl.repo = "/repo";
    pickaxeSearchCtrl.query = "no-such-token-anywhere";
    vi.mocked(commands.pickaxeSearch).mockResolvedValueOnce(ok({ truncated: false, entries: [] }));

    await pickaxeSearchCtrl.search();

    expect(pickaxeSearchCtrl.error).toBe("");
    expect(pickaxeSearchCtrl.data).toEqual({ truncated: false, entries: [] });
    expect(pickaxeSearchCtrl.data!.entries.length).toBe(0);
  });
});

describe("jumpToCommit — mirrors fileHistoryCtrl.jumpToCommit()", () => {
  it("scrolls to and selects the row for a known sha, then closes the modal", async () => {
    setBackendGraph([{ sha: "a1b2c3d" }, { sha: "bb01ccd" }]);
    pickaxeSearchCtrl.repo = "/repo";
    pickaxeSearchCtrl.query = "foo";
    vi.mocked(commands.pickaxeSearch).mockResolvedValueOnce(ok(RESULTS));
    await pickaxeSearchCtrl.search();

    pickaxeSearchCtrl.jumpToCommit("bb01ccdbb01ccdbb01ccdbb01ccdbb01ccdbb01");

    expect(pickaxeSearchCtrl.open).toBe(false);
    expect(bridge.select).toHaveBeenCalledWith(1);
    expect((bridge as any).cv.focus).toHaveBeenCalled();
    expect(bridge.tama.warn).not.toHaveBeenCalled();
  });

  it("warns instead of silently no-op-ing when the commit isn't in the loaded graph", async () => {
    setBackendGraph([{ sha: "a1b2c3d" }]);
    pickaxeSearchCtrl.repo = "/repo";
    pickaxeSearchCtrl.query = "foo";
    vi.mocked(commands.pickaxeSearch).mockResolvedValueOnce(ok(RESULTS));
    await pickaxeSearchCtrl.search();

    pickaxeSearchCtrl.jumpToCommit("bb01ccdbb01ccdbb01ccdbb01ccdbb01ccdbb01");

    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("not loaded"));
    expect(bridge.select).not.toHaveBeenCalled();
    expect(pickaxeSearchCtrl.open).toBe(false); // still closes — this isn't a "cancel the click" situation
  });
});

describe("demo mode", () => {
  it("search() seeds the canned demo results without any IPC call when !IN_TAURI", async () => {
    vi.resetModules();
    vi.doMock("../../ipc/env", () => ({ IN_TAURI: false }));
    const bindingsDemo = await import("../../ipc/bindings");
    const { pickaxeSearchCtrl: demoCtrl } = await import("./pickaxesearch.svelte.ts");

    demoCtrl.query = "anything";
    await demoCtrl.search();

    expect(demoCtrl.data).not.toBeNull();
    expect(demoCtrl.data!.entries.length).toBeGreaterThan(0);
    expect(bindingsDemo.commands.pickaxeSearch).not.toHaveBeenCalled();
  });

  it("demo mode still requires a non-empty query before seeding results", async () => {
    vi.resetModules();
    vi.doMock("../../ipc/env", () => ({ IN_TAURI: false }));
    const { pickaxeSearchCtrl: demoCtrl } = await import("./pickaxesearch.svelte.ts");

    demoCtrl.query = "  ";
    await demoCtrl.search();

    expect(demoCtrl.data).toBeNull();
    expect(demoCtrl.error).toMatch(/enter something/i);
  });
});
