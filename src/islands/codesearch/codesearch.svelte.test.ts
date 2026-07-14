// Tests for the Search Code controller.
//
// Same isolation strategy as pickaxesearch.svelte.test.ts: no import of
// legacy/main.ts's boot-on-import canvas app is ever triggered — this
// controller doesn't even import legacy/bridge (unlike pickaxe's own
// jumpToCommit), so only its two peer-island dependencies (fileHistoryCtrl/
// blameCtrl) need mocking.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/bindings", () => ({
  commands: {
    codeSearch: vi.fn(),
  },
}));

let mockInTauri = true;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));

vi.mock("../filehistory/filehistory.svelte.ts", () => ({
  fileHistoryCtrl: { openFor: vi.fn() },
}));
vi.mock("../blame/blame.svelte.ts", () => ({
  blameCtrl: { openFor: vi.fn() },
}));

import { commands } from "../../ipc/bindings";
import type { CodeSearchResults } from "../../ipc/bindings";
import { codeSearchCtrl } from "./codesearch.svelte.ts";
import { fileHistoryCtrl } from "../filehistory/filehistory.svelte.ts";
import { blameCtrl } from "../blame/blame.svelte.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}

const RESULTS: CodeSearchResults = {
  truncated: false,
  matches: [
    { path: "src/a.ts", line: 10, text: "const sessionTtl = 3600;" },
    { path: "src/b.ts", line: 2, text: "export const RATE_LIMIT = 100;" },
  ],
};

function resetCtrl() {
  codeSearchCtrl.open = false;
  codeSearchCtrl.query = "";
  codeSearchCtrl.caseSensitive = false;
  codeSearchCtrl.atCommit = "";
  codeSearchCtrl.busy = false;
  codeSearchCtrl.error = "";
  codeSearchCtrl.data = null;
  codeSearchCtrl.repo = "";
  mockInTauri = true;
  vi.clearAllMocks();
}

beforeEach(() => {
  resetCtrl();
});

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", () => {
    expect(document.getElementById("cv")).toBeNull();
    expect(codeSearchCtrl).toBeDefined();
  });
});

describe("show / close (Tools menu / ⌘K entry point)", () => {
  it("show() opens the panel and records the repo, without clearing a previous result", async () => {
    codeSearchCtrl.repo = "/repo";
    codeSearchCtrl.query = "sessionTtl";
    vi.mocked(commands.codeSearch).mockResolvedValueOnce(ok(RESULTS));
    await codeSearchCtrl.search();

    codeSearchCtrl.open = false;
    codeSearchCtrl.show("/repo");

    expect(codeSearchCtrl.open).toBe(true);
    expect(codeSearchCtrl.repo).toBe("/repo");
    expect(codeSearchCtrl.data).toEqual(RESULTS); // nothing here goes stale on reopen
  });

  it("close() is blocked while a search is in flight", () => {
    codeSearchCtrl.open = true;
    codeSearchCtrl.busy = true;
    codeSearchCtrl.close();
    expect(codeSearchCtrl.open).toBe(true);
  });

  it("close() otherwise closes it", () => {
    codeSearchCtrl.open = true;
    codeSearchCtrl.close();
    expect(codeSearchCtrl.open).toBe(false);
  });
});

describe("search — real mode (IN_TAURI), param forwarding", () => {
  it("forwards repo/query/caseSensitive(false)/atCommit(null) by default", async () => {
    vi.mocked(commands.codeSearch).mockResolvedValueOnce(ok(RESULTS));
    codeSearchCtrl.repo = "/repo";
    codeSearchCtrl.query = "sessionTtl";

    await codeSearchCtrl.search();

    expect(commands.codeSearch).toHaveBeenCalledWith("/repo", "sessionTtl", false, null);
    expect(codeSearchCtrl.data).toEqual(RESULTS);
    expect(codeSearchCtrl.error).toBe("");
    expect(codeSearchCtrl.busy).toBe(false);
  });

  it("forwards caseSensitive:true when checked", async () => {
    vi.mocked(commands.codeSearch).mockResolvedValueOnce(ok(RESULTS));
    codeSearchCtrl.repo = "/repo";
    codeSearchCtrl.query = "Foo";
    codeSearchCtrl.caseSensitive = true;

    await codeSearchCtrl.search();

    expect(commands.codeSearch).toHaveBeenCalledWith("/repo", "Foo", true, null);
  });

  it("a trimmed, non-empty atCommit field scopes the search to that commit", async () => {
    vi.mocked(commands.codeSearch).mockResolvedValueOnce(ok(RESULTS));
    codeSearchCtrl.repo = "/repo";
    codeSearchCtrl.query = "foo";
    codeSearchCtrl.atCommit = "  abc123  ";

    await codeSearchCtrl.search();

    expect(commands.codeSearch).toHaveBeenCalledWith("/repo", "foo", false, "abc123");
  });

  it("a blank atCommit field is sent as null, not an empty string", async () => {
    vi.mocked(commands.codeSearch).mockResolvedValueOnce(ok(RESULTS));
    codeSearchCtrl.repo = "/repo";
    codeSearchCtrl.query = "foo";
    codeSearchCtrl.atCommit = "   ";

    await codeSearchCtrl.search();

    expect(commands.codeSearch).toHaveBeenCalledWith("/repo", "foo", false, null);
  });
});

describe("search — loading / error / empty-results states", () => {
  it("sets busy while the round trip is in flight, then clears it", async () => {
    codeSearchCtrl.repo = "/repo";
    codeSearchCtrl.query = "foo";
    let resolveFn!: (v: unknown) => void;
    vi.mocked(commands.codeSearch).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFn = resolve;
      }) as any,
    );

    const p = codeSearchCtrl.search();
    expect(codeSearchCtrl.busy).toBe(true);
    resolveFn(ok(RESULTS));
    await p;

    expect(codeSearchCtrl.busy).toBe(false);
  });

  it("is a no-op re-entrancy guard while already busy", async () => {
    codeSearchCtrl.repo = "/repo";
    codeSearchCtrl.query = "foo";
    codeSearchCtrl.busy = true;

    await codeSearchCtrl.search();

    expect(commands.codeSearch).not.toHaveBeenCalled();
  });

  it("empty query: local validation error, no IPC call", async () => {
    codeSearchCtrl.repo = "/repo";
    codeSearchCtrl.query = "   ";

    await codeSearchCtrl.search();

    expect(commands.codeSearch).not.toHaveBeenCalled();
    expect(codeSearchCtrl.error).toMatch(/enter something/i);
    expect(codeSearchCtrl.data).toBeNull();
  });

  it("no repo open: refuses without a round trip", async () => {
    codeSearchCtrl.query = "foo";

    await codeSearchCtrl.search();

    expect(commands.codeSearch).not.toHaveBeenCalled();
    expect(codeSearchCtrl.error).toMatch(/open a repository/i);
  });

  it("surfaces a clean backend error and clears data", async () => {
    codeSearchCtrl.repo = "/repo";
    codeSearchCtrl.query = "foo";
    vi.mocked(commands.codeSearch).mockResolvedValueOnce(err("Enter something to search for."));

    await codeSearchCtrl.search();

    expect(codeSearchCtrl.data).toBeNull();
    expect(codeSearchCtrl.error).toBe("Enter something to search for.");
  });

  it("a thrown IPC rejection is surfaced as an error, not left uncaught", async () => {
    codeSearchCtrl.repo = "/repo";
    codeSearchCtrl.query = "foo";
    vi.mocked(commands.codeSearch).mockRejectedValueOnce(new Error("boom"));

    await codeSearchCtrl.search();

    expect(codeSearchCtrl.data).toBeNull();
    expect(codeSearchCtrl.error).toContain("boom");
  });

  it("an ok response with zero matches is stored as an empty (not null) result", async () => {
    codeSearchCtrl.repo = "/repo";
    codeSearchCtrl.query = "no-such-token-anywhere";
    vi.mocked(commands.codeSearch).mockResolvedValueOnce(ok({ truncated: false, matches: [] }));

    await codeSearchCtrl.search();

    expect(codeSearchCtrl.error).toBe("");
    expect(codeSearchCtrl.data).toEqual({ truncated: false, matches: [] });
  });
});

describe("openHistory / openBlame", () => {
  it("openHistory closes the modal and calls fileHistoryCtrl.openFor with repo/atCommit/path", () => {
    codeSearchCtrl.open = true;
    codeSearchCtrl.repo = "/repo";
    codeSearchCtrl.atCommit = " abc123 ";

    codeSearchCtrl.openHistory(RESULTS.matches[0]);

    expect(codeSearchCtrl.open).toBe(false);
    expect(fileHistoryCtrl.openFor).toHaveBeenCalledWith("/repo", "abc123", "src/a.ts");
  });

  it("openHistory passes null atCommit when blank (working-tree search)", () => {
    codeSearchCtrl.repo = "/repo";
    codeSearchCtrl.atCommit = "";

    codeSearchCtrl.openHistory(RESULTS.matches[0]);

    expect(fileHistoryCtrl.openFor).toHaveBeenCalledWith("/repo", null, "src/a.ts");
  });

  it("openBlame closes the modal and calls blameCtrl.openFor with repo/atCommit/path", () => {
    codeSearchCtrl.open = true;
    codeSearchCtrl.repo = "/repo";
    codeSearchCtrl.atCommit = "";

    codeSearchCtrl.openBlame(RESULTS.matches[1]);

    expect(codeSearchCtrl.open).toBe(false);
    expect(blameCtrl.openFor).toHaveBeenCalledWith("/repo", null, "src/b.ts", null);
  });
});

describe("demo mode", () => {
  it("search() seeds the canned demo results without any IPC call when !IN_TAURI", async () => {
    vi.resetModules();
    vi.doMock("../../ipc/env", () => ({ IN_TAURI: false }));
    const bindingsDemo = await import("../../ipc/bindings");
    const { codeSearchCtrl: demoCtrl } = await import("./codesearch.svelte.ts");

    demoCtrl.query = "anything";
    await demoCtrl.search();

    expect(demoCtrl.data).not.toBeNull();
    expect(demoCtrl.data!.matches.length).toBeGreaterThan(0);
    expect(bindingsDemo.commands.codeSearch).not.toHaveBeenCalled();
  });

  it("demo mode still requires a non-empty query before seeding results", async () => {
    vi.resetModules();
    vi.doMock("../../ipc/env", () => ({ IN_TAURI: false }));
    const { codeSearchCtrl: demoCtrl } = await import("./codesearch.svelte.ts");

    demoCtrl.query = "  ";
    await demoCtrl.search();

    expect(demoCtrl.data).toBeNull();
    expect(demoCtrl.error).toMatch(/enter something/i);
  });
});
