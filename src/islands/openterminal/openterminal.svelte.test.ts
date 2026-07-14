// Tests for the Open Terminal controller — the Tools-menu/⌘K entry point
// fronting terminal.rs's `open_terminal`. No island UI of its own (mirrors
// applypatch.svelte.ts/forcepush.svelte.ts's shape), and simpler than either:
// no dialog, no danger-confirm, just a direct fire-and-forget IPC call.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
}));

let mockInTauri = true;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    openTerminal: vi.fn(),
  },
}));

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { openTerminalCtrl } from "./openterminal.svelte.ts";

function ok(): { status: "ok"; data: null } {
  return { status: "ok", data: null };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInTauri = true;
  openTerminalCtrl.busy = false;
});

describe("openTerminal", () => {
  it("warns instead of calling the backend when no repo is open", async () => {
    await openTerminalCtrl.openTerminal("");

    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(commands.openTerminal).not.toHaveBeenCalled();
  });

  it("calls open_terminal with the repo path on success", async () => {
    vi.mocked(commands.openTerminal).mockResolvedValueOnce(ok());

    await openTerminalCtrl.openTerminal("/repo");

    expect(commands.openTerminal).toHaveBeenCalledWith("/repo");
    expect(bridge.tama.warn).not.toHaveBeenCalled();
  });

  it("surfaces a backend error without throwing", async () => {
    vi.mocked(commands.openTerminal).mockResolvedValueOnce(err("Could not open a terminal — tried: ..."));

    await openTerminalCtrl.openTerminal("/repo");

    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("Could not open a terminal"));
  });

  it("a rejected round trip is caught and surfaced via Tama, not an unhandled rejection", async () => {
    vi.mocked(commands.openTerminal).mockRejectedValueOnce(new Error("invoke failed"));

    await openTerminalCtrl.openTerminal("/repo");

    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("invoke failed"));
    expect(openTerminalCtrl.busy).toBe(false);
  });

  it("is a no-op while already busy (re-entrancy guard)", async () => {
    let resolveCall!: (v: { status: "ok"; data: null }) => void;
    vi.mocked(commands.openTerminal).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCall = resolve;
      }),
    );

    const first = openTerminalCtrl.openTerminal("/repo");
    const second = openTerminalCtrl.openTerminal("/repo");
    resolveCall(ok());
    await Promise.all([first, second]);

    expect(commands.openTerminal).toHaveBeenCalledTimes(1);
  });

  it("design mode (!IN_TAURI): no IPC call, just a Tama toast", async () => {
    mockInTauri = false;

    await openTerminalCtrl.openTerminal("/repo");

    expect(commands.openTerminal).not.toHaveBeenCalled();
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("demo"));
  });
});
