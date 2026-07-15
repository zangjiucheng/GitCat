// Tests for the built-in terminal controller.
//
// Same isolation strategy as bisect.svelte.test.ts: legacy/bridge is mocked
// so legacy/main.ts never evaluates, and window.__TAURI__.event.listen is
// hand-mocked (no typed/generated event helper exists in this codebase for
// backend-push events — see terminal.svelte.ts's own header doc).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  CUR_REPO: "/repo",
  tama: { warn: vi.fn(), say: vi.fn() },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    terminalSpawn: vi.fn(),
    terminalWrite: vi.fn(),
    terminalResize: vi.fn(),
    terminalKill: vi.fn(),
  },
}));

let mockInTauri = false;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { terminalCtrl } from "./terminal.svelte.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}

type TauriWindow = Window & { __TAURI__?: { event: { listen: ReturnType<typeof vi.fn> } } };

let mockListen: ReturnType<typeof vi.fn>;
let handlers: Record<string, (e: { payload: any }) => void>;
let unlistenMocks: Record<string, ReturnType<typeof vi.fn>>;

function resetTerminal() {
  terminalCtrl.open = false;
  terminalCtrl.repo = "";
  terminalCtrl.sessionId = null;
  terminalCtrl.busy = false;
  terminalCtrl.exited = false;
  terminalCtrl.onData = null;
  mockInTauri = false;
  vi.clearAllMocks();
  handlers = {};
  unlistenMocks = { "terminal-output": vi.fn(), "terminal-exit": vi.fn() };
  mockListen = vi.fn((name: string, handler: (e: { payload: any }) => void) => {
    handlers[name] = handler;
    return Promise.resolve(unlistenMocks[name]);
  });
  (window as unknown as TauriWindow).__TAURI__ = { event: { listen: mockListen } };
}

beforeEach(() => {
  resetTerminal();
});

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", () => {
    expect(document.getElementById("cv")).toBeNull();
    expect(terminalCtrl).toBeDefined();
  });
});

describe("toggle", () => {
  it("warns and does nothing when no repo is open", async () => {
    await terminalCtrl.toggle("");
    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(terminalCtrl.open).toBe(false);
    expect(commands.terminalSpawn).not.toHaveBeenCalled();
  });

  it("design mode (not IN_TAURI) opens the drawer with a static preview, spawning nothing", async () => {
    mockInTauri = false;
    await terminalCtrl.toggle("/repo");
    expect(terminalCtrl.open).toBe(true);
    expect(terminalCtrl.repo).toBe("/repo");
    expect(terminalCtrl.sessionId).toBeNull();
    expect(terminalCtrl.busy).toBe(false);
    expect(commands.terminalSpawn).not.toHaveBeenCalled();
  });

  it("real mode spawns a session, subscribes to its events, and opens the drawer", async () => {
    mockInTauri = true;
    vi.mocked(commands.terminalSpawn).mockResolvedValueOnce(ok("term-1"));

    await terminalCtrl.toggle("/repo");

    expect(commands.terminalSpawn).toHaveBeenCalledWith("/repo");
    expect(terminalCtrl.sessionId).toBe("term-1");
    expect(terminalCtrl.open).toBe(true);
    expect(terminalCtrl.busy).toBe(false);
    expect(mockListen).toHaveBeenCalledWith("terminal-output", expect.any(Function));
    expect(mockListen).toHaveBeenCalledWith("terminal-exit", expect.any(Function));
  });

  it("sets busy true for the duration of a slow spawn", async () => {
    mockInTauri = true;
    let resolveSpawn: (v: any) => void;
    vi.mocked(commands.terminalSpawn).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSpawn = resolve;
      }) as any,
    );

    const p = terminalCtrl.toggle("/repo");
    await Promise.resolve();
    expect(terminalCtrl.busy).toBe(true);

    resolveSpawn!(ok("term-1"));
    await p;
    expect(terminalCtrl.busy).toBe(false);
  });

  it("an error status warns and closes the drawer back up without a session", async () => {
    mockInTauri = true;
    vi.mocked(commands.terminalSpawn).mockResolvedValueOnce(err("no shell available"));

    await terminalCtrl.toggle("/repo");

    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(terminalCtrl.open).toBe(false);
    expect(terminalCtrl.sessionId).toBeNull();
  });

  it("a thrown/rejected spawn warns and closes the drawer back up", async () => {
    mockInTauri = true;
    vi.mocked(commands.terminalSpawn).mockRejectedValueOnce(new Error("invoke failed"));

    await terminalCtrl.toggle("/repo");

    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(terminalCtrl.open).toBe(false);
  });

  it("toggling again for the SAME repo with a live session just shows/hides the drawer — no new spawn", async () => {
    mockInTauri = true;
    vi.mocked(commands.terminalSpawn).mockResolvedValueOnce(ok("term-1"));
    await terminalCtrl.toggle("/repo");
    expect(terminalCtrl.open).toBe(true);

    await terminalCtrl.toggle("/repo");
    expect(terminalCtrl.open).toBe(false);
    expect(terminalCtrl.sessionId).toBe("term-1");
    expect(commands.terminalSpawn).toHaveBeenCalledTimes(1);
    expect(commands.terminalKill).not.toHaveBeenCalled();

    await terminalCtrl.toggle("/repo");
    expect(terminalCtrl.open).toBe(true);
    expect(commands.terminalSpawn).toHaveBeenCalledTimes(1);
  });

  it("toggling for a DIFFERENT repo kills the old session before spawning a new one", async () => {
    mockInTauri = true;
    vi.mocked(commands.terminalSpawn).mockResolvedValueOnce(ok("term-1"));
    vi.mocked(commands.terminalKill).mockResolvedValueOnce(ok(null));
    vi.mocked(commands.terminalSpawn).mockResolvedValueOnce(ok("term-2"));
    await terminalCtrl.toggle("/repo-a");
    expect(terminalCtrl.sessionId).toBe("term-1");

    await terminalCtrl.toggle("/repo-b");

    expect(commands.terminalKill).toHaveBeenCalledWith("term-1");
    expect(commands.terminalSpawn).toHaveBeenCalledWith("/repo-b");
    expect(terminalCtrl.sessionId).toBe("term-2");
    expect(terminalCtrl.repo).toBe("/repo-b");
  });
});

describe("hide / closeSession / restart", () => {
  it("hide() only tucks the drawer away — the session survives", async () => {
    mockInTauri = true;
    vi.mocked(commands.terminalSpawn).mockResolvedValueOnce(ok("term-1"));
    await terminalCtrl.toggle("/repo");

    terminalCtrl.hide();

    expect(terminalCtrl.open).toBe(false);
    expect(terminalCtrl.sessionId).toBe("term-1");
    expect(commands.terminalKill).not.toHaveBeenCalled();
  });

  it("closeSession() kills the session and closes the drawer", async () => {
    mockInTauri = true;
    vi.mocked(commands.terminalSpawn).mockResolvedValueOnce(ok("term-1"));
    vi.mocked(commands.terminalKill).mockResolvedValueOnce(ok(null));
    await terminalCtrl.toggle("/repo");

    await terminalCtrl.closeSession();

    expect(commands.terminalKill).toHaveBeenCalledWith("term-1");
    expect(terminalCtrl.sessionId).toBeNull();
    expect(terminalCtrl.open).toBe(false);
    expect(unlistenMocks["terminal-output"]).toHaveBeenCalledTimes(1);
    expect(unlistenMocks["terminal-exit"]).toHaveBeenCalledTimes(1);
  });

  it("restart() ends the old session and spawns a fresh one for the same repo", async () => {
    mockInTauri = true;
    vi.mocked(commands.terminalSpawn).mockResolvedValueOnce(ok("term-1"));
    vi.mocked(commands.terminalKill).mockResolvedValueOnce(ok(null));
    vi.mocked(commands.terminalSpawn).mockResolvedValueOnce(ok("term-2"));
    await terminalCtrl.toggle("/repo");
    terminalCtrl.exited = true;

    await terminalCtrl.restart();

    expect(commands.terminalKill).toHaveBeenCalledWith("term-1");
    expect(terminalCtrl.sessionId).toBe("term-2");
    expect(terminalCtrl.exited).toBe(false);
    expect(terminalCtrl.open).toBe(true);
    expect(terminalCtrl.repo).toBe("/repo");
  });
});

describe("write / resize", () => {
  it("write is a no-op without a live session", async () => {
    await terminalCtrl.write("ls\n");
    expect(commands.terminalWrite).not.toHaveBeenCalled();
  });

  it("write is a no-op in design mode even with a session id set", async () => {
    mockInTauri = false;
    terminalCtrl.sessionId = "term-1";
    await terminalCtrl.write("ls\n");
    expect(commands.terminalWrite).not.toHaveBeenCalled();
  });

  it("write forwards to commands.terminalWrite for a real live session", async () => {
    mockInTauri = true;
    vi.mocked(commands.terminalSpawn).mockResolvedValueOnce(ok("term-1"));
    await terminalCtrl.toggle("/repo");
    vi.mocked(commands.terminalWrite).mockResolvedValueOnce(ok(null));

    await terminalCtrl.write("echo hi\n");

    expect(commands.terminalWrite).toHaveBeenCalledWith("term-1", "echo hi\n");
  });

  it("resize forwards cols/rows to commands.terminalResize for a real live session", async () => {
    mockInTauri = true;
    vi.mocked(commands.terminalSpawn).mockResolvedValueOnce(ok("term-1"));
    await terminalCtrl.toggle("/repo");
    vi.mocked(commands.terminalResize).mockResolvedValueOnce(ok(null));

    await terminalCtrl.resize(120, 40);

    expect(commands.terminalResize).toHaveBeenCalledWith("term-1", 120, 40);
  });

  it("resize is a no-op without a live session", async () => {
    await terminalCtrl.resize(80, 24);
    expect(commands.terminalResize).not.toHaveBeenCalled();
  });
});

describe("terminal-output / terminal-exit events", () => {
  it("decodes base64 output and hands the raw bytes to onData, ignoring events for a superseded session", async () => {
    mockInTauri = true;
    vi.mocked(commands.terminalSpawn).mockResolvedValueOnce(ok("term-1"));
    await terminalCtrl.toggle("/repo");

    const received: Uint8Array[] = [];
    terminalCtrl.onData = (bytes) => received.push(bytes);

    // "hi" base64-encoded, matching the live session's own id.
    handlers["terminal-output"]({ payload: { id: "term-1", data: "aGk=" } });
    expect(received).toHaveLength(1);
    expect(new TextDecoder().decode(received[0])).toBe("hi");

    // A stale id (e.g. a slow in-flight event from an already-superseded
    // session) must never reach onData.
    handlers["terminal-output"]({ payload: { id: "term-0-stale", data: "aGk=" } });
    expect(received).toHaveLength(1);
  });

  it("terminal-exit for the live session's id sets exited; a mismatched id is ignored", async () => {
    mockInTauri = true;
    vi.mocked(commands.terminalSpawn).mockResolvedValueOnce(ok("term-1"));
    await terminalCtrl.toggle("/repo");

    handlers["terminal-exit"]({ payload: { id: "term-0-stale" } });
    expect(terminalCtrl.exited).toBe(false);

    handlers["terminal-exit"]({ payload: { id: "term-1" } });
    expect(terminalCtrl.exited).toBe(true);
  });
});
