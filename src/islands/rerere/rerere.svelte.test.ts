// Tests for the rerere panel controller.
//
// Same isolation strategy as resolver.svelte.test.ts / bisect.svelte.test.ts:
// legacy/bridge is mocked so legacy/main.ts (a whole vanilla canvas app that
// boots on import) is never evaluated. See resolver.svelte.test.ts's header
// for the full rationale.
//
// IN_TAURI is mocked per-describe-block (not globally) since the controller's
// behavior genuinely branches on it (demo vs real IPC) — this mirrors how
// ipc/env.ts computes it from `window.__TAURI__`, just faked for the test.
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
    rerereStatus: vi.fn(),
    rerereSetEnabled: vi.fn(),
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
import type { RerereStatus, WriteResult } from "../../ipc/bindings";
import { rerereCtrl } from "./rerere.svelte.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}

function status(partial: Partial<RerereStatus>): RerereStatus {
  return {
    enabled: false,
    configured: null,
    cacheDirPresent: false,
    entries: [],
    liveConflict: false,
    livePaths: [],
    ...partial,
  };
}

function writeResult(partial: Partial<WriteResult>): WriteResult {
  return { ok: true, message: "", backupRef: null, conflictingFiles: [], ...partial };
}

function resetCtrl() {
  rerereCtrl.open = false;
  rerereCtrl.vm = null;
  rerereCtrl.busy = false;
  rerereCtrl.demo = false;
  rerereCtrl.repo = "";
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInTauri = false;
  resetCtrl();
});

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", () => {
    expect(document.getElementById("cv")).toBeNull();
    expect(rerereCtrl).toBeDefined();
  });
});

describe("refresh — demo mode (!IN_TAURI)", () => {
  it("loads canned data matching the mockup's 3-row spirit, without any IPC call", async () => {
    mockInTauri = false;

    await rerereCtrl.refresh(null);

    expect(rerereCtrl.demo).toBe(true);
    expect(commands.rerereStatus).not.toHaveBeenCalled();
    expect(rerereCtrl.vm).not.toBeNull();
    expect(rerereCtrl.vm!.liveConflict).toBe(true);
    expect(rerereCtrl.rows).toHaveLength(3);
    expect(rerereCtrl.rows.map((r) => r.label)).toEqual([
      "src/auth/token.ts",
      "package-lock.json",
      "src/graph/layout.rs",
    ]);
    expect(rerereCtrl.rows.filter((r) => r.resolved)).toHaveLength(2);
    expect(rerereCtrl.rows.every((r) => r.isPath)).toBe(true);
    expect(rerereCtrl.enabled).toBe(true);
  });
});

describe("refresh — real mode (IN_TAURI)", () => {
  it("with no repo open: clears vm without calling the backend", async () => {
    mockInTauri = true;

    await rerereCtrl.refresh(null);

    expect(rerereCtrl.vm).toBeNull();
    expect(rerereCtrl.demo).toBe(false);
    expect(commands.rerereStatus).not.toHaveBeenCalled();
  });

  it("populates vm/rows from a successful rerere_status call", async () => {
    mockInTauri = true;
    vi.mocked(commands.rerereStatus).mockResolvedValueOnce(
      ok(
        status({
          enabled: true,
          configured: true,
          entries: [{ id: "748cc9703f9b97e2d674b54dcbbfa3afe026807d", resolved: true }],
        }),
      ),
    );

    await rerereCtrl.refresh("/repo");

    expect(commands.rerereStatus).toHaveBeenCalledWith("/repo");
    expect(rerereCtrl.demo).toBe(false);
    expect(rerereCtrl.repo).toBe("/repo");
    expect(rerereCtrl.enabled).toBe(true);
    expect(rerereCtrl.rows).toHaveLength(1);
    expect(rerereCtrl.rows[0]).toEqual({
      key: "id:748cc9703f9b97e2d674b54dcbbfa3afe026807d",
      label: "748cc9703f9b…",
      resolved: true,
      isPath: false,
    });
  });

  it("logs and leaves vm untouched on a backend error result", async () => {
    mockInTauri = true;
    rerereCtrl.vm = status({ enabled: true });
    vi.mocked(commands.rerereStatus).mockResolvedValueOnce({ status: "error", error: "boom" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await rerereCtrl.refresh("/repo");

    expect(rerereCtrl.vm!.enabled).toBe(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("a call while one is already in flight is a no-op (busy guard)", async () => {
    mockInTauri = true;
    rerereCtrl.busy = true;

    await rerereCtrl.refresh("/repo");

    expect(commands.rerereStatus).not.toHaveBeenCalled();
  });
});

describe("setEnabled", () => {
  it("demo mode: flips vm locally, no IPC call", async () => {
    mockInTauri = false;
    await rerereCtrl.refresh(null);

    await rerereCtrl.setEnabled(false);

    expect(rerereCtrl.enabled).toBe(false);
    expect(commands.rerereSetEnabled).not.toHaveBeenCalled();
    expect(bridge.tama.say).toHaveBeenCalled();
  });

  it("real mode: calls rerere_set_enabled then re-fetches status", async () => {
    mockInTauri = true;
    rerereCtrl.repo = "/repo";
    rerereCtrl.vm = status({ enabled: false, configured: false });
    vi.mocked(commands.rerereSetEnabled).mockResolvedValueOnce(writeResult({ ok: true }));
    vi.mocked(commands.rerereStatus).mockResolvedValueOnce(ok(status({ enabled: true, configured: true })));

    await rerereCtrl.setEnabled(true);

    expect(commands.rerereSetEnabled).toHaveBeenCalledWith("/repo", true);
    expect(commands.rerereStatus).toHaveBeenCalledWith("/repo");
    expect(rerereCtrl.enabled).toBe(true);
  });

  it("real mode without an open repo: warns via Tama, no IPC call", async () => {
    mockInTauri = true;
    rerereCtrl.repo = "";

    await rerereCtrl.setEnabled(true);

    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(commands.rerereSetEnabled).not.toHaveBeenCalled();
  });

  it("real mode failure (ok:false): warns but still refreshes", async () => {
    mockInTauri = true;
    rerereCtrl.repo = "/repo";
    vi.mocked(commands.rerereSetEnabled).mockResolvedValueOnce(writeResult({ ok: false, message: "nope" }));
    vi.mocked(commands.rerereStatus).mockResolvedValueOnce(ok(status({})));

    await rerereCtrl.setEnabled(true);

    expect(bridge.tama.warn).toHaveBeenCalledWith("nope");
    expect(commands.rerereStatus).toHaveBeenCalled();
  });
});

describe("show / close (Tools menu / ⌘K entry point)", () => {
  it("show() opens the panel and re-fetches", async () => {
    mockInTauri = true;
    vi.mocked(commands.rerereStatus).mockResolvedValueOnce(ok(status({ enabled: true })));
    rerereCtrl.show("/repo");
    expect(rerereCtrl.open).toBe(true);
    await Promise.resolve();
    expect(commands.rerereStatus).toHaveBeenCalledWith("/repo");
  });

  it("close() is blocked while busy", () => {
    rerereCtrl.open = true;
    rerereCtrl.busy = true;
    rerereCtrl.close();
    expect(rerereCtrl.open).toBe(true);
  });

  it("close() otherwise closes it", () => {
    rerereCtrl.open = true;
    rerereCtrl.close();
    expect(rerereCtrl.open).toBe(false);
  });
});

describe("sourceNote", () => {
  it("explains an explicit local config value", async () => {
    mockInTauri = true;
    rerereCtrl.vm = status({ configured: true });
    expect(rerereCtrl.sourceNote).toBe("set for this repo");
    rerereCtrl.vm = status({ configured: false });
    expect(rerereCtrl.sourceNote).toBe("disabled for this repo");
  });

  it("explains the cache-dir-exists fallback when unset", async () => {
    rerereCtrl.vm = status({ configured: null, cacheDirPresent: true });
    expect(rerereCtrl.sourceNote).toBe("default — on (rr-cache already exists)");
    rerereCtrl.vm = status({ configured: null, cacheDirPresent: false });
    expect(rerereCtrl.sourceNote).toBe("default — off");
  });
});
