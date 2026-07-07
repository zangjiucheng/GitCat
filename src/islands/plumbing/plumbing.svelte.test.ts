// Tests for the plumbing playground controller.
//
// Same isolation strategy as resolver/bisect: legacy/bridge is mocked so
// legacy/main.ts (a whole vanilla canvas app that boots on import) is never
// evaluated. See resolver.svelte.test.ts's header comment for the rationale.
//
// IN_TAURI is mocked per-test via vi.doMock + dynamic import (it's a const
// computed at module-eval time from `window.__TAURI__`, so it must be mocked
// BEFORE the controller module is imported, not toggled afterward).
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
  CUR_REPO: null,
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    plumbingInspect: vi.fn(),
  },
}));

import { commands } from "../../ipc/bindings";
import type { PlumbingObject } from "../../ipc/bindings";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}

const COMMIT: PlumbingObject = {
  kind: "commit",
  sha: "a".repeat(40),
  shortSha: "aaaaaaa",
  author: { name: "Ada", email: "ada@example.com", time: 1700000000 },
  committer: { name: "Ada", email: "ada@example.com", time: 1700000000 },
  parents: ["b".repeat(40)],
  tree: "c".repeat(40),
  message: "Wire login form to API",
};

const TREE: PlumbingObject = {
  kind: "tree",
  sha: "d".repeat(40),
  entries: [
    { name: "src", mode: "040000", kind: "tree", oid: "e".repeat(40) },
    { name: "README.md", mode: "100644", kind: "blob", oid: "f".repeat(40) },
  ],
};

const BLOB: PlumbingObject = {
  kind: "blob",
  sha: "1".repeat(40),
  size: 12,
  isBinary: false,
  content: "hello world",
  truncated: false,
};

const TAG: PlumbingObject = {
  kind: "tag",
  sha: "2".repeat(40),
  name: "v1.0",
  tagger: { name: "Ada", email: "ada@example.com", time: 1700000000 },
  message: "Release v1.0",
  targetOid: "a".repeat(40),
  targetKind: "commit",
};

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", async () => {
    const { plumbing } = await import("./plumbing.svelte.ts");
    expect(document.getElementById("cv")).toBeNull();
    expect(plumbing).toBeDefined();
  });
});

describe("inspect — real (IN_TAURI) mode", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("../../ipc/env", () => ({ IN_TAURI: true }));
  });

  it("commit result: stores the resolved commit object", async () => {
    vi.mocked(commands.plumbingInspect).mockResolvedValueOnce(ok(COMMIT));
    const { plumbing } = await import("./plumbing.svelte.ts");

    await plumbing.inspect("repo1", "HEAD");

    expect(commands.plumbingInspect).toHaveBeenCalledWith("repo1", "HEAD");
    expect(plumbing.result).toEqual(COMMIT);
    expect(plumbing.error).toBe("");
    expect(plumbing.busy).toBe(false);
  });

  it("tree result: stores a different object kind cleanly (no leftover commit fields)", async () => {
    vi.mocked(commands.plumbingInspect).mockResolvedValueOnce(ok(TREE));
    const { plumbing } = await import("./plumbing.svelte.ts");

    await plumbing.inspect("repo1", "HEAD^{tree}");

    expect(plumbing.result).toEqual(TREE);
    expect(plumbing.result?.kind).toBe("tree");
    expect(plumbing.error).toBe("");
  });

  it("blob result", async () => {
    vi.mocked(commands.plumbingInspect).mockResolvedValueOnce(ok(BLOB));
    const { plumbing } = await import("./plumbing.svelte.ts");

    await plumbing.inspect("repo1", "HEAD:README.md");

    expect(plumbing.result).toEqual(BLOB);
  });

  it("tag result", async () => {
    vi.mocked(commands.plumbingInspect).mockResolvedValueOnce(ok(TAG));
    const { plumbing } = await import("./plumbing.svelte.ts");

    await plumbing.inspect("repo1", "v1.0");

    expect(plumbing.result).toEqual(TAG);
  });

  it("bad rev: surfaces the backend error, not a crash — result cleared", async () => {
    const { plumbing } = await import("./plumbing.svelte.ts");

    vi.mocked(commands.plumbingInspect).mockResolvedValueOnce(ok(COMMIT));
    await plumbing.inspect("repo1", "HEAD");
    expect(plumbing.result).not.toBeNull();

    vi.mocked(commands.plumbingInspect).mockResolvedValueOnce(err("Not a valid rev in this repository"));
    await plumbing.inspect("repo1", "not-a-real-rev");

    expect(plumbing.result).toBeNull();
    expect(plumbing.error).toBe("Not a valid rev in this repository");
    expect(plumbing.busy).toBe(false);
  });

  it("a thrown IPC error is caught, not propagated", async () => {
    vi.mocked(commands.plumbingInspect).mockRejectedValueOnce(new Error("invoke failed"));
    const { plumbing } = await import("./plumbing.svelte.ts");

    await expect(plumbing.inspect("repo1", "HEAD")).resolves.toBeUndefined();
    expect(plumbing.result).toBeNull();
    expect(plumbing.error).toContain("invoke failed");
  });

  it("empty rev: local validation error, no IPC call", async () => {
    const { plumbing } = await import("./plumbing.svelte.ts");

    await plumbing.inspect("repo1", "   ");

    expect(commands.plumbingInspect).not.toHaveBeenCalled();
    expect(plumbing.error).toMatch(/enter a rev/i);
  });

  it("no repo open: warns without calling the backend", async () => {
    const { plumbing } = await import("./plumbing.svelte.ts");

    await plumbing.inspect(null, "HEAD");

    expect(commands.plumbingInspect).not.toHaveBeenCalled();
    expect(plumbing.error).toMatch(/open a repository/i);
  });
});

describe("inspect — demo (!IN_TAURI) mode", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("../../ipc/env", () => ({ IN_TAURI: false }));
  });

  it("shows a canned example result without any IPC call", async () => {
    const { plumbing } = await import("./plumbing.svelte.ts");

    await plumbing.inspect(null, "anything");

    expect(commands.plumbingInspect).not.toHaveBeenCalled();
    expect(plumbing.demo).toBe(true);
    expect(plumbing.result).not.toBeNull();
    expect(plumbing.result?.kind).toBe("commit");
    expect(plumbing.error).toBe("");
  });
});
