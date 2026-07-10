// Tests for the force-push controller — the two armDanger-gated entry points
// fronting git_remote.rs's `force_push` (see forcepush.svelte.ts's own doc
// comment for the "why armDanger, why two separate flows" rationale).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
  armDanger: vi.fn(),
}));

let mockInTauri = true;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    forcePush: vi.fn(),
  },
}));

vi.mock("../sidebar/sidebar.svelte.ts", () => ({
  sidebarCtrl: {
    head: "main",
    refresh: vi.fn(async () => {}),
  },
}));

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { sidebarCtrl } from "../sidebar/sidebar.svelte.ts";
import { forcePushCtrl } from "./forcepush.svelte.ts";

function ok(message = "Force-pushed main (lease)."): { ok: true; message: string; backupRef: null } {
  return { ok: true, message, backupRef: null };
}
function fail(message: string): { ok: false; message: string; backupRef: null } {
  return { ok: false, message, backupRef: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInTauri = true;
  forcePushCtrl.busy = false;
  (sidebarCtrl as any).head = "main";
});

describe("forcePushLease", () => {
  it("arms the shared danger scrim with a force-push-safe context, typed-confirm on the branch name", () => {
    forcePushCtrl.forcePushLease("/repo");

    expect(bridge.tama.set).toHaveBeenCalledWith("danger");
    expect(bridge.armDanger).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Force push (safe) — main",
        name: "main",
        confirmLabel: "Force push",
        onConfirm: expect.any(Function),
      }),
    );
  });

  it("onConfirm calls force_push with lease:true and refreshes the sidebar on success", async () => {
    vi.mocked(commands.forcePush).mockResolvedValueOnce(ok("Force-pushed main (lease)."));
    forcePushCtrl.forcePushLease("/repo");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;

    await ctx.onConfirm();

    expect(commands.forcePush).toHaveBeenCalledWith("/repo", true);
    expect(sidebarCtrl.refresh).toHaveBeenCalledWith("/repo");
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
    expect(bridge.tama.say).toHaveBeenCalledWith("Force-pushed main (lease).", 3200);
    expect(bridge.tama.warn).not.toHaveBeenCalled();
  });

  it("onConfirm surfaces a rejected lease push's own message via warn, and does not refresh", async () => {
    vi.mocked(commands.forcePush).mockResolvedValueOnce(fail("! [rejected] main -> main (stale info)"));
    forcePushCtrl.forcePushLease("/repo");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;

    await ctx.onConfirm();

    expect(commands.forcePush).toHaveBeenCalledWith("/repo", true);
    expect(bridge.tama.warn).toHaveBeenCalledWith("! [rejected] main -> main (stale info)");
    expect(sidebarCtrl.refresh).not.toHaveBeenCalled();
  });

  it("onConfirm surfaces a thrown error via warn instead of pretending success", async () => {
    vi.mocked(commands.forcePush).mockRejectedValueOnce(new Error("boom"));
    forcePushCtrl.forcePushLease("/repo");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;

    await ctx.onConfirm();

    expect(bridge.tama.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
    expect(sidebarCtrl.refresh).not.toHaveBeenCalled();
  });
});

describe("forcePushOverride", () => {
  it("arms the shared danger scrim with its OWN, scarier context and confirmLabel", () => {
    forcePushCtrl.forcePushOverride("/repo");

    expect(bridge.armDanger).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Force push — override remote — main",
        name: "main",
        confirmLabel: "Force push (override)",
        onConfirm: expect.any(Function),
      }),
    );
  });

  it("onConfirm calls force_push with lease:false and refreshes the sidebar on success", async () => {
    vi.mocked(commands.forcePush).mockResolvedValueOnce(ok("Force-pushed main (forced)."));
    forcePushCtrl.forcePushOverride("/repo");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;

    await ctx.onConfirm();

    expect(commands.forcePush).toHaveBeenCalledWith("/repo", false);
    expect(sidebarCtrl.refresh).toHaveBeenCalledWith("/repo");
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });

  it("onConfirm failure warns and does not refresh", async () => {
    vi.mocked(commands.forcePush).mockResolvedValueOnce(fail("This branch has no upstream yet — use Push to publish it first."));
    forcePushCtrl.forcePushOverride("/repo");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;

    await ctx.onConfirm();

    expect(bridge.tama.warn).toHaveBeenCalledWith("This branch has no upstream yet — use Push to publish it first.");
    expect(sidebarCtrl.refresh).not.toHaveBeenCalled();
  });
});

describe("guard rails", () => {
  it("warns instead of arming anything when no repo is open", () => {
    forcePushCtrl.forcePushLease("");
    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(bridge.armDanger).not.toHaveBeenCalled();
  });

  it("warns instead of arming anything when HEAD isn't on a branch", () => {
    (sidebarCtrl as any).head = null;
    forcePushCtrl.forcePushOverride("/repo");
    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(bridge.armDanger).not.toHaveBeenCalled();
  });

  it("re-entrancy: arming again while a force-push is still in flight is a no-op", async () => {
    let resolvePush!: (v: unknown) => void;
    vi.mocked(commands.forcePush).mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePush = resolve;
      }) as any,
    );
    forcePushCtrl.forcePushLease("/repo");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;
    const inFlight = ctx.onConfirm();

    expect(forcePushCtrl.busy).toBe(true);
    forcePushCtrl.forcePushOverride("/repo"); // arm() bails out early while busy
    expect(bridge.armDanger).toHaveBeenCalledTimes(1);

    resolvePush(ok());
    await inFlight;
    expect(forcePushCtrl.busy).toBe(false);
  });

  it("demo mode (no Tauri) celebrates without calling the backend", async () => {
    mockInTauri = false;
    forcePushCtrl.forcePushLease("/repo");
    const ctx = vi.mocked(bridge.armDanger).mock.calls[0][0] as any;

    await ctx.onConfirm();

    expect(commands.forcePush).not.toHaveBeenCalled();
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
  });
});
