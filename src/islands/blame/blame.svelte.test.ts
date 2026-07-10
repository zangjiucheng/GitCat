// Tests for the blame (line-annotation) controller.
//
// Same isolation strategy as reflog.svelte.test.ts / cmdk.svelte.test.ts:
// legacy/bridge is mocked so legacy/main.ts (a whole vanilla canvas app that
// boots on import) is never evaluated. The `jumpToCommit` mocks mirror
// cmdk.svelte.test.ts's own G/BACKEND/state/layout/view/cv shape exactly,
// since jumpToCommit deliberately mirrors cmdk's jump() body.
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
  highlight: (text: string) => text,
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    blameFile: vi.fn(),
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
import type { FileBlame } from "../../ipc/bindings";
import { blameCtrl } from "./blame.svelte.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}

const BLAME: FileBlame = {
  path: "src/a.ts",
  atSha: "a1b2c3d4e5f6071829384756a1b2c3d4e5f60718",
  lang: "ts",
  totalLines: 3,
  truncated: false,
  lines: ["one", "two", "three"],
  hunks: [
    { sha: "e4f5061e4f5061e4f5061e4f5061e4f5061e4f5", shortSha: "e4f5061", author: { n: "Dev", e: "d@x.com", t: 0 }, startLine: 1, linesInHunk: 2, origPath: null },
    { sha: "bb01ccdbb01ccdbb01ccdbb01ccdbb01ccdbb01", shortSha: "bb01ccd", author: { n: "Ada", e: "a@x.com", t: 0 }, startLine: 3, linesInHunk: 1, origPath: "old.ts" },
  ],
};

function setBackendGraph(rows: any[]) {
  (bridge as any).G = { N: rows.length };
  (bridge as any).BACKEND = { rows };
}

function resetCtrl() {
  blameCtrl.open = false;
  blameCtrl.loading = false;
  blameCtrl.error = null;
  blameCtrl.data = null;
  blameCtrl.ignoreWhitespace = false;
  blameCtrl.oldPath = null;
  blameCtrl.repo = "";
  blameCtrl.file = "";
  blameCtrl.atCommit = null;
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
    expect(blameCtrl).toBeDefined();
  });
});

describe("openFor — real mode (IN_TAURI)", () => {
  it("opens, fetches, and populates data on success", async () => {
    vi.mocked(commands.blameFile).mockResolvedValueOnce(ok(BLAME));

    await blameCtrl.openFor("/repo", "abc1234", "src/a.ts");

    expect(commands.blameFile).toHaveBeenCalledWith("/repo", "src/a.ts", "abc1234", false);
    expect(blameCtrl.open).toBe(true);
    expect(blameCtrl.data).toEqual(BLAME);
    expect(blameCtrl.error).toBeNull();
    expect(blameCtrl.loading).toBe(false);
  });

  it("atCommit: null blames HEAD (the Workdir trigger's call shape)", async () => {
    vi.mocked(commands.blameFile).mockResolvedValueOnce(ok(BLAME));

    await blameCtrl.openFor("/repo", null, "src/a.ts");

    expect(commands.blameFile).toHaveBeenCalledWith("/repo", "src/a.ts", null, false);
  });

  it("surfaces a clean error and clears data on refusal (binary/missing/etc.)", async () => {
    vi.mocked(commands.blameFile).mockResolvedValueOnce(err("src/a.ts is a binary file — blame is not available for binary content."));

    await blameCtrl.openFor("/repo", null, "src/a.ts");

    expect(blameCtrl.data).toBeNull();
    expect(blameCtrl.error).toContain("binary file");
  });

  it("a thrown IPC rejection is surfaced as an error, not left uncaught", async () => {
    vi.mocked(commands.blameFile).mockRejectedValueOnce(new Error("boom"));

    await blameCtrl.openFor("/repo", null, "src/a.ts");

    expect(blameCtrl.data).toBeNull();
    expect(blameCtrl.error).toContain("boom");
  });

  it("refuses without a round trip when no repo is open", async () => {
    await blameCtrl.openFor("", null, "src/a.ts");

    expect(commands.blameFile).not.toHaveBeenCalled();
    expect(blameCtrl.error).toBeTruthy();
  });

  it("oldPath is kept only when it differs from the blamed path", async () => {
    vi.mocked(commands.blameFile).mockResolvedValue(ok(BLAME));

    await blameCtrl.openFor("/repo", null, "src/a.ts", "src/old.ts");
    expect(blameCtrl.oldPath).toBe("src/old.ts");

    await blameCtrl.openFor("/repo", null, "src/a.ts", "src/a.ts");
    expect(blameCtrl.oldPath).toBeNull();
  });

  it("toggleIgnoreWhitespace flips the flag and refetches with it", async () => {
    vi.mocked(commands.blameFile).mockResolvedValue(ok(BLAME));
    await blameCtrl.openFor("/repo", "abc1234", "src/a.ts");
    vi.mocked(commands.blameFile).mockClear();

    await blameCtrl.toggleIgnoreWhitespace();

    expect(blameCtrl.ignoreWhitespace).toBe(true);
    expect(commands.blameFile).toHaveBeenCalledWith("/repo", "src/a.ts", "abc1234", true);
  });

  it("close() clears open/data/error", async () => {
    vi.mocked(commands.blameFile).mockResolvedValueOnce(ok(BLAME));
    await blameCtrl.openFor("/repo", null, "src/a.ts");

    blameCtrl.close();

    expect(blameCtrl.open).toBe(false);
    expect(blameCtrl.data).toBeNull();
    expect(blameCtrl.error).toBeNull();
  });
});

describe("rows — flattened per-line display", () => {
  it("expands hunks into one row per line, marking only the first line of each hunk", async () => {
    vi.mocked(commands.blameFile).mockResolvedValueOnce(ok(BLAME));
    await blameCtrl.openFor("/repo", null, "src/a.ts");

    const rows = blameCtrl.rows;
    expect(rows.map((r) => r.text)).toEqual(["one", "two", "three"]);
    expect(rows.map((r) => r.isFirst)).toEqual([true, false, true]);
    expect(rows.map((r) => r.hunk.shortSha)).toEqual(["e4f5061", "e4f5061", "bb01ccd"]);
    expect(rows.map((r) => r.tint)).toEqual(["a", "a", "b"]);
  });

  it("is empty when there is no data yet", () => {
    expect(blameCtrl.rows).toEqual([]);
  });
});

describe("jumpToCommit — mirrors cmdk.svelte.ts's jump()", () => {
  it("scrolls to and selects the row for a known sha, then closes the modal", async () => {
    setBackendGraph([{ sha: "e4f5061" }, { sha: "bb01ccd" }]);
    vi.mocked(commands.blameFile).mockResolvedValueOnce(ok(BLAME));
    await blameCtrl.openFor("/repo", null, "src/a.ts");

    blameCtrl.jumpToCommit("bb01ccdbb01ccdbb01ccdbb01ccdbb01ccdbb01");

    expect(blameCtrl.open).toBe(false);
    expect(bridge.select).toHaveBeenCalledWith(1);
    expect((bridge as any).cv.focus).toHaveBeenCalled();
    expect(bridge.tama.warn).not.toHaveBeenCalled();
  });

  it("warns instead of silently no-op-ing when the commit isn't in the loaded graph", async () => {
    setBackendGraph([{ sha: "e4f5061" }]);
    vi.mocked(commands.blameFile).mockResolvedValueOnce(ok(BLAME));
    await blameCtrl.openFor("/repo", null, "src/a.ts");

    blameCtrl.jumpToCommit("bb01ccdbb01ccdbb01ccdbb01ccdbb01ccdbb01");

    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("not loaded"));
    expect(bridge.select).not.toHaveBeenCalled();
    expect(blameCtrl.open).toBe(false); // still closes — this isn't a "cancel the click" situation
  });
});

describe("demo mode", () => {
  it("openFor seeds the canned demo blame without any IPC call when !IN_TAURI", async () => {
    vi.resetModules();
    vi.doMock("../../ipc/env", () => ({ IN_TAURI: false }));
    const bindingsDemo = await import("../../ipc/bindings");
    const { blameCtrl: demoCtrl } = await import("./blame.svelte.ts");

    await demoCtrl.openFor("/repo", null, "src/whatever.ts");

    expect(demoCtrl.data).not.toBeNull();
    expect(demoCtrl.data!.lines.length).toBeGreaterThan(0);
    expect(bindingsDemo.commands.blameFile).not.toHaveBeenCalled();
  });
});
