// Tests for the Plugins manager controller.
//
// The registry MANAGEMENT (list / enable / disable / remove / install) moved
// here out of the Settings modal's old Plugins tab, so these are that tab's
// tests, retargeted to pluginsCtrl — plus the two-pane view's own selection and
// filter logic and the pure pluginContribution() helper. Same isolation shape
// as settings.svelte.test.ts: legacy/bridge is mocked so legacy/main.ts never
// boots, IN_TAURI is a toggleable getter, and the two ⌘K/panel reload seams and
// the file-picker dialog are mocked so nothing real is touched.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    listPlugins: vi.fn(),
    setPluginEnabled: vi.fn(),
    removePlugin: vi.fn(),
    installPluginFromPath: vi.fn(),
  },
}));

// The file picker (@tauri-apps/plugin-dialog's open) goes through an `openMock`
// indirection to sidestep its overloaded type signature (same shape as the
// settings/applypatch tests). Both plugin-registry reload seams are mocked.
const openMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
}));
vi.mock("../plugincommands/plugincommands.svelte.ts", () => ({
  pluginCommandsCtrl: { reload: vi.fn() },
}));
vi.mock("../pluginpanels/pluginpanels.svelte.ts", () => ({
  pluginPanelsCtrl: { reload: vi.fn() },
}));

let mockInTauri = true;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { pluginCommandsCtrl } from "../plugincommands/plugincommands.svelte.ts";
import { pluginPanelsCtrl } from "../pluginpanels/pluginpanels.svelte.ts";
import type { Plugin } from "../../ipc/bindings";
import { pluginsCtrl, pluginContribution } from "./plugins.svelte.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}
function plugin(partial: Partial<Plugin> = {}): Plugin {
  return { id: "demo", name: "Demo", version: "1.0.0", description: null, enabled: true, commands: [], hooks: [], ...partial };
}

function resetCtrl() {
  pluginsCtrl.open = false;
  pluginsCtrl.selectedId = null;
  pluginsCtrl.filter = "";
  pluginsCtrl.plugins = [];
  pluginsCtrl.pluginsLoading = false;
  pluginsCtrl.pluginsError = "";
  pluginsCtrl.pluginBusyId = null;
  pluginsCtrl.pluginInstalling = false;
  pluginsCtrl.removingPluginId = null;
  mockInTauri = true;
  vi.clearAllMocks();
  vi.mocked(commands.listPlugins).mockResolvedValue(ok([]));
}

beforeEach(() => {
  resetCtrl();
});

describe("pluginContribution (pure helper)", () => {
  it("counts commands/hooks/panels and flags lua/tama", () => {
    const p = {
      ...plugin(),
      commands: [{ id: "a" }, { id: "b" }],
      hooks: [{ event: "commit-created" }],
      panels: [{ id: "p" }],
      lua: "main.lua",
      tama: {},
    } as unknown as Plugin;
    expect(pluginContribution(p)).toEqual({ commands: 2, hooks: 1, panels: 1, lua: true, tama: true });
  });

  it("an empty manifest contributes nothing", () => {
    expect(pluginContribution(plugin())).toEqual({ commands: 0, hooks: 0, panels: 0, lua: false, tama: false });
  });
});

describe("refreshPlugins", () => {
  it("populates the list from list_plugins on success", async () => {
    vi.mocked(commands.listPlugins).mockResolvedValueOnce(ok([plugin({ id: "a", name: "Alpha" }), plugin({ id: "b", name: "Beta" })]));

    await pluginsCtrl.refreshPlugins();

    expect(pluginsCtrl.plugins.map((p) => p.id)).toEqual(["a", "b"]);
    expect(pluginsCtrl.pluginsError).toBe("");
    expect(pluginsCtrl.pluginsLoading).toBe(false);
  });

  it("selects the first plugin when nothing is selected yet", async () => {
    vi.mocked(commands.listPlugins).mockResolvedValueOnce(ok([plugin({ id: "a" }), plugin({ id: "b" })]));

    await pluginsCtrl.refreshPlugins();

    expect(pluginsCtrl.selectedId).toBe("a");
    expect(pluginsCtrl.selected?.id).toBe("a");
  });

  it("keeps a still-present selection across a refresh", async () => {
    vi.mocked(commands.listPlugins).mockResolvedValueOnce(ok([plugin({ id: "a" }), plugin({ id: "b" })]));
    await pluginsCtrl.refreshPlugins();
    pluginsCtrl.select("b");

    vi.mocked(commands.listPlugins).mockResolvedValueOnce(ok([plugin({ id: "a" }), plugin({ id: "b" })]));
    await pluginsCtrl.refreshPlugins();

    expect(pluginsCtrl.selectedId).toBe("b");
  });

  it("re-points selection to the first row when the selected plugin vanishes", async () => {
    vi.mocked(commands.listPlugins).mockResolvedValueOnce(ok([plugin({ id: "a" }), plugin({ id: "b" })]));
    await pluginsCtrl.refreshPlugins();
    pluginsCtrl.select("b");

    vi.mocked(commands.listPlugins).mockResolvedValueOnce(ok([plugin({ id: "a" })])); // b removed on disk
    await pluginsCtrl.refreshPlugins();

    expect(pluginsCtrl.selectedId).toBe("a");
  });

  it("surfaces a backend error without crashing", async () => {
    vi.mocked(commands.listPlugins).mockResolvedValueOnce(err("registry unreadable"));

    await pluginsCtrl.refreshPlugins();

    expect(pluginsCtrl.plugins).toEqual([]);
    expect(pluginsCtrl.pluginsError).toContain("registry unreadable");
  });

  it("a rejected round trip is caught and surfaced, not left as an unhandled rejection", async () => {
    vi.mocked(commands.listPlugins).mockRejectedValueOnce(new Error("invoke failed"));

    await pluginsCtrl.refreshPlugins();

    expect(pluginsCtrl.pluginsError).toContain("invoke failed");
    expect(pluginsCtrl.pluginsLoading).toBe(false);
  });

  it("design mode (!IN_TAURI): empty list, no backend call", async () => {
    mockInTauri = false;
    pluginsCtrl.plugins = [plugin()];

    await pluginsCtrl.refreshPlugins();

    expect(commands.listPlugins).not.toHaveBeenCalled();
    expect(pluginsCtrl.plugins).toEqual([]);
    expect(pluginsCtrl.selectedId).toBeNull();
  });
});

describe("show / close", () => {
  it("show() opens, clears the filter, and refreshes the registry", async () => {
    vi.mocked(commands.listPlugins).mockResolvedValueOnce(ok([plugin({ id: "x" })]));
    pluginsCtrl.filter = "stale";

    pluginsCtrl.show();
    await Promise.resolve();
    await Promise.resolve();

    expect(pluginsCtrl.open).toBe(true);
    expect(pluginsCtrl.filter).toBe("");
    expect(commands.listPlugins).toHaveBeenCalled();
    expect(pluginsCtrl.plugins.map((p) => p.id)).toEqual(["x"]);
  });

  it("close() just hides", () => {
    pluginsCtrl.open = true;
    pluginsCtrl.close();
    expect(pluginsCtrl.open).toBe(false);
  });
});

describe("selection + filter", () => {
  it("select() sets the id and cancels any pending remove-confirm", () => {
    pluginsCtrl.plugins = [plugin({ id: "a" }), plugin({ id: "b" })];
    pluginsCtrl.removingPluginId = "a";

    pluginsCtrl.select("b");

    expect(pluginsCtrl.selectedId).toBe("b");
    expect(pluginsCtrl.removingPluginId).toBeNull();
  });

  it("filteredPlugins matches name, id, or description; empty filter returns all", () => {
    pluginsCtrl.plugins = [
      plugin({ id: "commit-lint", name: "Commit Lint", description: "checks subjects" }),
      plugin({ id: "hello", name: "Hello", description: "greets you" }),
    ];

    expect(pluginsCtrl.filteredPlugins.map((p) => p.id)).toEqual(["commit-lint", "hello"]);

    pluginsCtrl.filter = "lint";
    expect(pluginsCtrl.filteredPlugins.map((p) => p.id)).toEqual(["commit-lint"]);

    pluginsCtrl.filter = "greets";
    expect(pluginsCtrl.filteredPlugins.map((p) => p.id)).toEqual(["hello"]);

    pluginsCtrl.filter = "HELLO"; // case-insensitive on id/name
    expect(pluginsCtrl.filteredPlugins.map((p) => p.id)).toEqual(["hello"]);
  });

  it("a filtered-out selection still resolves via `selected` (detail never blanks on filter)", () => {
    pluginsCtrl.plugins = [plugin({ id: "a", name: "Alpha" }), plugin({ id: "b", name: "Beta" })];
    pluginsCtrl.select("a");
    pluginsCtrl.filter = "beta"; // hides "a" from the list

    expect(pluginsCtrl.filteredPlugins.map((p) => p.id)).toEqual(["b"]);
    expect(pluginsCtrl.selected?.id).toBe("a"); // still valid
  });
});

describe("setPluginEnabled", () => {
  it("flips the local copy and reloads BOTH ⌘K commands and panels on success", async () => {
    pluginsCtrl.plugins = [plugin({ id: "a", enabled: true })];
    vi.mocked(commands.setPluginEnabled).mockResolvedValueOnce(ok(null));

    await pluginsCtrl.setPluginEnabled("a", false);

    expect(commands.setPluginEnabled).toHaveBeenCalledWith("a", false);
    expect(pluginsCtrl.plugins[0].enabled).toBe(false);
    expect(pluginCommandsCtrl.reload).toHaveBeenCalled();
    expect(pluginPanelsCtrl.reload).toHaveBeenCalled();
    expect(pluginsCtrl.pluginBusyId).toBeNull();
  });

  it("surfaces a backend failure and reverts the optimistic flip", async () => {
    pluginsCtrl.plugins = [plugin({ id: "a", enabled: true })];
    vi.mocked(commands.setPluginEnabled).mockResolvedValueOnce(err("write failed"));

    await pluginsCtrl.setPluginEnabled("a", false);

    expect(pluginsCtrl.plugins[0].enabled).toBe(true);
    expect(pluginsCtrl.pluginsError).toContain("write failed");
    expect(pluginCommandsCtrl.reload).not.toHaveBeenCalled();
  });

  it("design mode (!IN_TAURI): flips locally with a Tama toast, no IPC and no reload", async () => {
    mockInTauri = false;
    pluginsCtrl.plugins = [plugin({ id: "a", enabled: true })];

    await pluginsCtrl.setPluginEnabled("a", false);

    expect(commands.setPluginEnabled).not.toHaveBeenCalled();
    expect(pluginCommandsCtrl.reload).not.toHaveBeenCalled();
    expect(pluginsCtrl.plugins[0].enabled).toBe(false);
    expect(bridge.tama.say).toHaveBeenCalled();
  });
});

describe("remove (inline confirm)", () => {
  it("start/cancel just toggle removingPluginId, no backend call", () => {
    pluginsCtrl.startRemovePlugin("a");
    expect(pluginsCtrl.removingPluginId).toBe("a");

    pluginsCtrl.cancelRemovePlugin();
    expect(pluginsCtrl.removingPluginId).toBeNull();
    expect(commands.removePlugin).not.toHaveBeenCalled();
  });

  it("confirmRemovePlugin drops the row, clears the confirm, re-points selection, and reloads on success", async () => {
    pluginsCtrl.plugins = [plugin({ id: "a" }), plugin({ id: "b" })];
    pluginsCtrl.select("a");
    pluginsCtrl.removingPluginId = "a";
    vi.mocked(commands.removePlugin).mockResolvedValueOnce(ok(null));

    await pluginsCtrl.confirmRemovePlugin("a");

    expect(commands.removePlugin).toHaveBeenCalledWith("a");
    expect(pluginsCtrl.plugins.map((p) => p.id)).toEqual(["b"]);
    expect(pluginsCtrl.removingPluginId).toBeNull();
    expect(pluginsCtrl.selectedId).toBe("b"); // reconciled away from the removed row
    expect(pluginCommandsCtrl.reload).toHaveBeenCalled();
    expect(pluginPanelsCtrl.reload).toHaveBeenCalled();
  });

  it("keeps the row and surfaces the error on a backend failure", async () => {
    pluginsCtrl.plugins = [plugin({ id: "a" })];
    pluginsCtrl.removingPluginId = "a";
    vi.mocked(commands.removePlugin).mockResolvedValueOnce(err("could not remove"));

    await pluginsCtrl.confirmRemovePlugin("a");

    expect(pluginsCtrl.plugins.map((p) => p.id)).toEqual(["a"]);
    expect(pluginsCtrl.pluginsError).toContain("could not remove");
    expect(pluginCommandsCtrl.reload).not.toHaveBeenCalled();
  });

  it("design mode (!IN_TAURI): drops locally with a Tama toast, no IPC", async () => {
    mockInTauri = false;
    pluginsCtrl.plugins = [plugin({ id: "a" })];
    pluginsCtrl.removingPluginId = "a";

    await pluginsCtrl.confirmRemovePlugin("a");

    expect(commands.removePlugin).not.toHaveBeenCalled();
    expect(pluginsCtrl.plugins).toEqual([]);
    expect(pluginsCtrl.removingPluginId).toBeNull();
    expect(bridge.tama.say).toHaveBeenCalled();
  });
});

describe("installPlugin", () => {
  it("picks a path, installs it, re-lists, selects the new plugin, reloads, and toasts on success", async () => {
    openMock.mockResolvedValueOnce("/plugins/foo/plugin.json");
    vi.mocked(commands.installPluginFromPath).mockResolvedValueOnce(ok(plugin({ id: "foo", name: "Foo" })));
    vi.mocked(commands.listPlugins).mockResolvedValueOnce(ok([plugin({ id: "foo", name: "Foo" })]));

    await pluginsCtrl.installPlugin();

    expect(commands.installPluginFromPath).toHaveBeenCalledWith("/plugins/foo/plugin.json");
    expect(commands.listPlugins).toHaveBeenCalled();
    expect(pluginsCtrl.plugins.map((p) => p.id)).toEqual(["foo"]);
    expect(pluginsCtrl.selectedId).toBe("foo"); // freshly installed one is focused
    expect(pluginCommandsCtrl.reload).toHaveBeenCalled();
    expect(pluginPanelsCtrl.reload).toHaveBeenCalled();
    expect(bridge.tama.say).toHaveBeenCalled();
    expect(pluginsCtrl.pluginInstalling).toBe(false);
  });

  it("does nothing when the picker is cancelled (null)", async () => {
    openMock.mockResolvedValueOnce(null);

    await pluginsCtrl.installPlugin();

    expect(commands.installPluginFromPath).not.toHaveBeenCalled();
    expect(pluginCommandsCtrl.reload).not.toHaveBeenCalled();
  });

  it("surfaces a backend install failure and does NOT reload", async () => {
    openMock.mockResolvedValueOnce("/plugins/bad/plugin.json");
    vi.mocked(commands.installPluginFromPath).mockResolvedValueOnce(err("duplicate id"));

    await pluginsCtrl.installPlugin();

    expect(pluginsCtrl.pluginsError).toContain("duplicate id");
    expect(pluginCommandsCtrl.reload).not.toHaveBeenCalled();
  });

  it("surfaces a dialog failure without calling the backend", async () => {
    openMock.mockRejectedValueOnce(new Error("no dialog"));

    await pluginsCtrl.installPlugin();

    expect(pluginsCtrl.pluginsError).toContain("no dialog");
    expect(commands.installPluginFromPath).not.toHaveBeenCalled();
  });

  it("design mode (!IN_TAURI): no picker, no IPC, just a Tama toast", async () => {
    mockInTauri = false;

    await pluginsCtrl.installPlugin();

    expect(openMock).not.toHaveBeenCalled();
    expect(commands.installPluginFromPath).not.toHaveBeenCalled();
    expect(bridge.tama.say).toHaveBeenCalled();
  });
});
