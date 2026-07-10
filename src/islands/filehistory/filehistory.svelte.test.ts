// Tests for the per-file history (rename-following) controller.
//
// Same isolation strategy as blame.svelte.test.ts / reflog.svelte.test.ts /
// cmdk.svelte.test.ts: legacy/bridge is mocked so legacy/main.ts (a whole
// vanilla canvas app that boots on import) is never evaluated. The
// `jumpToCommit` mocks mirror blame.svelte.test.ts's own G/BACKEND/state/
// layout/view/cv shape exactly, since fileHistoryCtrl.jumpToCommit
// deliberately mirrors blameCtrl.jumpToCommit's body.
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
    fileHistory: vi.fn(),
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
import type { FileHistory } from "../../ipc/bindings";
import { fileHistoryCtrl } from "./filehistory.svelte.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}

const HISTORY: FileHistory = {
  file: "src/a.ts",
  atSha: "a1b2c3d4e5f6071829384756a1b2c3d4e5f60718",
  truncated: false,
  entries: [
    {
      sha: "a1b2c3da1b2c3da1b2c3da1b2c3da1b2c3da1b2",
      shortSha: "a1b2c3d",
      subject: "tweak a",
      an: { n: "Dev", e: "d@x.com", t: 0 },
      path: "src/a.ts",
      renamedFrom: null,
    },
    {
      sha: "bb01ccdbb01ccdbb01ccdbb01ccdbb01ccdbb01",
      shortSha: "bb01ccd",
      subject: "rename old -> a",
      an: { n: "Ada", e: "a@x.com", t: 0 },
      path: "src/a.ts",
      renamedFrom: "src/old.ts",
    },
    {
      sha: "e4f5061e4f5061e4f5061e4f5061e4f5061e4f5",
      shortSha: "e4f5061",
      subject: "create old",
      an: { n: "Ada", e: "a@x.com", t: 0 },
      path: "src/old.ts",
      renamedFrom: null,
    },
  ],
};

function setBackendGraph(rows: any[]) {
  (bridge as any).G = { N: rows.length };
  (bridge as any).BACKEND = { rows };
}

function resetCtrl() {
  fileHistoryCtrl.open = false;
  fileHistoryCtrl.loading = false;
  fileHistoryCtrl.error = null;
  fileHistoryCtrl.data = null;
  fileHistoryCtrl.oldPath = null;
  fileHistoryCtrl.repo = "";
  fileHistoryCtrl.file = "";
  fileHistoryCtrl.atCommit = null;
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
    expect(fileHistoryCtrl).toBeDefined();
  });
});

describe("openFor — real mode (IN_TAURI)", () => {
  it("opens, fetches, and populates data on success", async () => {
    vi.mocked(commands.fileHistory).mockResolvedValueOnce(ok(HISTORY));

    await fileHistoryCtrl.openFor("/repo", "abc1234", "src/a.ts");

    expect(commands.fileHistory).toHaveBeenCalledWith("/repo", "src/a.ts", "abc1234");
    expect(fileHistoryCtrl.open).toBe(true);
    expect(fileHistoryCtrl.data).toEqual(HISTORY);
    expect(fileHistoryCtrl.error).toBeNull();
    expect(fileHistoryCtrl.loading).toBe(false);
  });

  it("atCommit: null shows history as of HEAD (the Workdir trigger's call shape)", async () => {
    vi.mocked(commands.fileHistory).mockResolvedValueOnce(ok(HISTORY));

    await fileHistoryCtrl.openFor("/repo", null, "src/a.ts");

    expect(commands.fileHistory).toHaveBeenCalledWith("/repo", "src/a.ts", null);
  });

  it("a rename entry renders with an old-path marker", async () => {
    vi.mocked(commands.fileHistory).mockResolvedValueOnce(ok(HISTORY));

    await fileHistoryCtrl.openFor("/repo", null, "src/a.ts");

    const renamed = fileHistoryCtrl.data!.entries.find((e) => e.renamedFrom != null);
    expect(renamed).toBeDefined();
    expect(renamed!.renamedFrom).toBe("src/old.ts");
  });

  it("surfaces a clean error and clears data on refusal (missing path/etc.)", async () => {
    vi.mocked(commands.fileHistory).mockResolvedValueOnce(err("src/a.ts does not exist at a1b2c3d."));

    await fileHistoryCtrl.openFor("/repo", null, "src/a.ts");

    expect(fileHistoryCtrl.data).toBeNull();
    expect(fileHistoryCtrl.error).toContain("does not exist");
  });

  it("a thrown IPC rejection is surfaced as an error, not left uncaught", async () => {
    vi.mocked(commands.fileHistory).mockRejectedValueOnce(new Error("boom"));

    await fileHistoryCtrl.openFor("/repo", null, "src/a.ts");

    expect(fileHistoryCtrl.data).toBeNull();
    expect(fileHistoryCtrl.error).toContain("boom");
  });

  it("refuses without a round trip when no repo is open", async () => {
    await fileHistoryCtrl.openFor("", null, "src/a.ts");

    expect(commands.fileHistory).not.toHaveBeenCalled();
    expect(fileHistoryCtrl.error).toBeTruthy();
  });

  it("oldPath is kept only when it differs from the queried path", async () => {
    vi.mocked(commands.fileHistory).mockResolvedValue(ok(HISTORY));

    await fileHistoryCtrl.openFor("/repo", null, "src/a.ts", "src/old.ts");
    expect(fileHistoryCtrl.oldPath).toBe("src/old.ts");

    await fileHistoryCtrl.openFor("/repo", null, "src/a.ts", "src/a.ts");
    expect(fileHistoryCtrl.oldPath).toBeNull();
  });

  it("close() clears open/data/error", async () => {
    vi.mocked(commands.fileHistory).mockResolvedValueOnce(ok(HISTORY));
    await fileHistoryCtrl.openFor("/repo", null, "src/a.ts");

    fileHistoryCtrl.close();

    expect(fileHistoryCtrl.open).toBe(false);
    expect(fileHistoryCtrl.data).toBeNull();
    expect(fileHistoryCtrl.error).toBeNull();
  });
});

describe("jumpToCommit — mirrors blameCtrl.jumpToCommit()", () => {
  it("scrolls to and selects the row for a known sha, then closes the modal", async () => {
    setBackendGraph([{ sha: "e4f5061" }, { sha: "bb01ccd" }]);
    vi.mocked(commands.fileHistory).mockResolvedValueOnce(ok(HISTORY));
    await fileHistoryCtrl.openFor("/repo", null, "src/a.ts");

    fileHistoryCtrl.jumpToCommit("bb01ccdbb01ccdbb01ccdbb01ccdbb01ccdbb01");

    expect(fileHistoryCtrl.open).toBe(false);
    expect(bridge.select).toHaveBeenCalledWith(1);
    expect((bridge as any).cv.focus).toHaveBeenCalled();
    expect(bridge.tama.warn).not.toHaveBeenCalled();
  });

  it("warns instead of silently no-op-ing when the commit isn't in the loaded graph", async () => {
    setBackendGraph([{ sha: "e4f5061" }]);
    vi.mocked(commands.fileHistory).mockResolvedValueOnce(ok(HISTORY));
    await fileHistoryCtrl.openFor("/repo", null, "src/a.ts");

    fileHistoryCtrl.jumpToCommit("bb01ccdbb01ccdbb01ccdbb01ccdbb01ccdbb01");

    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("not loaded"));
    expect(bridge.select).not.toHaveBeenCalled();
    expect(fileHistoryCtrl.open).toBe(false); // still closes — this isn't a "cancel the click" situation
  });
});

describe("demo mode", () => {
  it("openFor seeds the canned demo history without any IPC call when !IN_TAURI", async () => {
    vi.resetModules();
    vi.doMock("../../ipc/env", () => ({ IN_TAURI: false }));
    const bindingsDemo = await import("../../ipc/bindings");
    const { fileHistoryCtrl: demoCtrl } = await import("./filehistory.svelte.ts");

    await demoCtrl.openFor("/repo", null, "src/whatever.ts");

    expect(demoCtrl.data).not.toBeNull();
    expect(demoCtrl.data!.entries.length).toBeGreaterThan(0);
    expect(bindingsDemo.commands.fileHistory).not.toHaveBeenCalled();
  });
});
