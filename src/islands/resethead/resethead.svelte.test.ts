// Tests for the reset-HEAD controller — the two armDanger-gated entry points
// fronting git_write.rs's `reset_head_to_commit` (see resethead.svelte.ts's
// own doc comment). Same isolation strategy as forcepush.svelte.test.ts:
// mock bridge/env/bindings, drive the armed scrim's onConfirm directly, and
// (unlike force-push) exercise the mode-radio / hash-input DOM reads under
// jsdom.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
  armDanger: vi.fn(),
  reloadGraph: vi.fn(async () => {}),
}));

let mockInTauri = true;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    resetHeadToCommit: vi.fn(),
  },
}));

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { resetHeadCtrl } from "./resethead.svelte.ts";

const SHA = "abc1234def5678";
const SHORT = "abc1234";

function ok(message = "Reset HEAD to abc1234 (mixed, snapshot 1-2)."): any {
  return { ok: true, message, backupRef: "refs/gitgui/backup/1-2", conflictingFiles: [] };
}
function fail(message: string): any {
  return { ok: false, message, backupRef: null, conflictingFiles: [] };
}

// Inject the controls the controller reads back out of the (mocked-away) danger
// scrim, so a test can drive a specific mode / typed hash through onConfirm.
function setModeRadio(mode: "soft" | "mixed" | "hard") {
  document.body.innerHTML += `<input type="radio" name="gcResetMode" value="${mode}" checked>`;
}
function setHashInput(value: string) {
  document.body.innerHTML += `<input id="gcResetHash" value="${value}">`;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInTauri = true;
  resetHeadCtrl.busy = false;
  document.body.innerHTML = "";
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("resetToKnownCommit", () => {
  it("arms the shared danger scrim, typed-confirm on the short sha", () => {
    resetHeadCtrl.resetToKnownCommit("/repo", SHA, SHORT, "Fix the bug");

    expect(bridge.tama.set).toHaveBeenCalledWith("danger");
    expect(bridge.armDanger).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Reset HEAD to " + SHORT,
        name: SHORT,
        confirmLabel: "Reset HEAD",
        onConfirm: expect.any(Function),
      }),
    );
  });

  it("onConfirm defaults to mixed when no radio is present, resets and reloads the graph", async () => {
    vi.mocked(commands.resetHeadToCommit).mockResolvedValueOnce(ok());
    resetHeadCtrl.resetToKnownCommit("/repo", SHA, SHORT, "Fix the bug");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;

    await ctx.onConfirm();

    expect(commands.resetHeadToCommit).toHaveBeenCalledWith("/repo", SHA, "mixed");
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
    expect(bridge.tama.warn).not.toHaveBeenCalled();
  });

  it("onConfirm reads the selected mode radio (hard) and passes it through", async () => {
    vi.mocked(commands.resetHeadToCommit).mockResolvedValueOnce(ok());
    resetHeadCtrl.resetToKnownCommit("/repo", SHA, SHORT, "Fix the bug");
    setModeRadio("hard");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;

    await ctx.onConfirm();

    expect(commands.resetHeadToCommit).toHaveBeenCalledWith("/repo", SHA, "hard");
  });

  it("onConfirm surfaces a failed reset's message via warn, and does not reload", async () => {
    vi.mocked(commands.resetHeadToCommit).mockResolvedValueOnce(fail("Safety snapshot failed, aborting: no commit to snapshot"));
    resetHeadCtrl.resetToKnownCommit("/repo", SHA, SHORT, "Fix the bug");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;

    await ctx.onConfirm();

    expect(bridge.tama.warn).toHaveBeenCalledWith("Safety snapshot failed, aborting: no commit to snapshot");
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
  });

  it("onConfirm surfaces a thrown error via warn instead of pretending success", async () => {
    vi.mocked(commands.resetHeadToCommit).mockRejectedValueOnce(new Error("boom"));
    resetHeadCtrl.resetToKnownCommit("/repo", SHA, SHORT, "Fix the bug");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;

    await ctx.onConfirm();

    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
    expect(bridge.reloadGraph).not.toHaveBeenCalled();
  });
});

describe("promptForHash", () => {
  it("arms the scrim with its own title and a literal 'reset' typed-confirm", () => {
    resetHeadCtrl.promptForHash("/repo");

    expect(bridge.armDanger).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Reset HEAD to a commit",
        name: "reset",
        confirmLabel: "Reset HEAD",
        onConfirm: expect.any(Function),
      }),
    );
  });

  it("onConfirm with an empty hash field warns and never touches the backend", async () => {
    resetHeadCtrl.promptForHash("/repo");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;

    await ctx.onConfirm(); // no #gcResetHash in the DOM -> empty

    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(commands.resetHeadToCommit).not.toHaveBeenCalled();
  });

  it("onConfirm reads the typed hash + mode and resets to it", async () => {
    vi.mocked(commands.resetHeadToCommit).mockResolvedValueOnce(ok());
    resetHeadCtrl.promptForHash("/repo");
    setHashInput("deadbee");
    setModeRadio("soft");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;

    await ctx.onConfirm();

    expect(commands.resetHeadToCommit).toHaveBeenCalledWith("/repo", "deadbee", "soft");
    expect(bridge.reloadGraph).toHaveBeenCalledWith(true);
  });
});

describe("guard rails", () => {
  it("warns instead of arming anything when no repo is open", () => {
    resetHeadCtrl.resetToKnownCommit("", SHA, SHORT, "x");
    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(bridge.armDanger).not.toHaveBeenCalled();
  });

  it("promptForHash also refuses with no repo", () => {
    resetHeadCtrl.promptForHash("");
    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(bridge.armDanger).not.toHaveBeenCalled();
  });

  it("re-entrancy: arming again while a reset is still in flight is a no-op", async () => {
    let resolveReset!: (v: unknown) => void;
    vi.mocked(commands.resetHeadToCommit).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveReset = resolve;
      }) as any,
    );
    resetHeadCtrl.resetToKnownCommit("/repo", SHA, SHORT, "x");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    const inFlight = ctx.onConfirm();

    expect(resetHeadCtrl.busy).toBe(true);
    resetHeadCtrl.promptForHash("/repo"); // bails out early while busy
    expect(bridge.armDanger).toHaveBeenCalledTimes(1);

    resolveReset(ok());
    await inFlight;
    expect(resetHeadCtrl.busy).toBe(false);
  });

  it("demo mode (no Tauri) celebrates without calling the backend", async () => {
    mockInTauri = false;
    resetHeadCtrl.resetToKnownCommit("/repo", SHA, SHORT, "x");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;

    await ctx.onConfirm();

    expect(commands.resetHeadToCommit).not.toHaveBeenCalled();
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });
});
