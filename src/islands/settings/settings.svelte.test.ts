// Tests for the App Settings controller.
//
// Same isolation strategy as externaltools/remotes' own test files: legacy/
// bridge is mocked so legacy/main.ts (a whole vanilla canvas app that boots
// on import) is never evaluated. IN_TAURI is a toggleable getter (same shape
// as externaltools.svelte.test.ts) since this file exercises both the
// real-Tauri and design-mode-demo paths for the Git Identity section.
//
// `localStorage` is stubbed with a real in-memory implementation rather than
// relying on the ambient jsdom one: under Node 25's own (now default-on, and
// unusable without a `--localstorage-file`) native Web Storage global, the
// bare `localStorage` identifier resolves to a broken stub whose methods are
// all `undefined` — even `window.localStorage` inherits it, not jsdom's own
// Storage. loadSettings()/saveSettings() themselves stay correct in the real
// app either way (a real WebView's localStorage is unaffected; the try/catch
// around the actual read/write means a broken store would just silently keep
// falling back to defaults) — but a test that wants to assert real
// round-trip persistence needs something with working getItem/setItem/clear.
import { beforeEach, describe, expect, it, vi } from "vitest";

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => void store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

vi.mock("../../legacy/bridge", () => ({
  applyThemeMode: vi.fn(),
  setGraphShowAllTags: vi.fn(),
  setGraphLabelPriority: vi.fn(),
  setGraphLabelLayout: vi.fn(),
  setTamaEnabled: vi.fn(),
  applyTamaSkin: vi.fn(),
  clearTamaSkin: vi.fn(),
  setTamaMotionPreset: vi.fn(),
  setTamaPoseOverrides: vi.fn(),
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    getGitIdentity: vi.fn(),
    setGitIdentity: vi.fn(),
    pruneSnapshots: vi.fn(),
    listPlugins: vi.fn(),
    setPluginEnabled: vi.fn(),
    removePlugin: vi.fn(),
    installPluginFromPath: vi.fn(),
    loadPluginSkin: vi.fn(),
  },
}));

// The plugin picker (@tauri-apps/plugin-dialog's open) and the ⌘K registry
// force-reload seam (pluginCommandsCtrl.reload) are both mocked so this
// controller test never touches a real dialog or the sibling island. `open`
// goes through an `openMock` indirection (same shape as applypatch/dashboard's
// own tests) to sidestep its overloaded type signature.
const openMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
}));
// pluginsCtrl (imported transitively via settings.svelte.ts's skin picker) pulls
// in both plugin-registry reload seams; mock both so importing it never loads
// the real sibling islands. The skin picker only reads pluginsCtrl.plugins.
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
import { pluginsCtrl } from "../plugins/plugins.svelte.ts";
import type { GitIdentity, Plugin } from "../../ipc/bindings";
import {
  loadSettings,
  saveSettings,
  settingsCtrl,
  pruneSnapshotsPerPolicy,
  applyPersistedTamaSkin,
  applyPersistedTamaMotion,
  hasTamaSkin,
  pickSkinCopyLine,
  tamaPoseLabel,
} from "./settings.svelte.ts";
// The built-in characters are a pure frontend registry (bundled webp asset URLs
// + a voice pitch) — imported for real, not mocked, so the built-in-path tests
// assert against the actual poses/pitch the app ships.
import { BUILTIN_SKINS } from "./builtinskins.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}
function identity(partial: Partial<GitIdentity> = {}): GitIdentity {
  return { name: null, email: null, configured: false, local: false, ...partial };
}
function plugin(partial: Partial<Plugin> = {}): Plugin {
  return { id: "demo", name: "Demo", version: "1.0.0", description: null, enabled: true, commands: [], hooks: [], ...partial };
}
// A plugin that declares a Tama skin. `tama`'s exact shape is the backend's
// (see hasTamaSkin's own note) — cast through unknown so this stays correct
// whatever the regenerated Plugin.tama type turns out to be; the picker only
// reads it for truthiness.
function skinnablePlugin(id: string, name = id): Plugin {
  return { ...plugin({ id, name }), tama: {} } as unknown as Plugin;
}
function skin(poses: Record<string, string>, copy: Record<string, string> = {}): { poses: Record<string, string>; copy: Record<string, string> } {
  return { poses, copy };
}

function resetCtrl() {
  vi.stubGlobal("localStorage", memoryStorage());
  settingsCtrl.open = false;
  settingsCtrl.activeTab = "general";
  settingsCtrl.advancedEntries = [];
  settingsCtrl.advancedFilter = "";
  settingsCtrl.newAdvancedKey = "";
  settingsCtrl.newAdvancedValue = "";
  settingsCtrl.themeMode = "dark";
  settingsCtrl.cherryPickRecordOriginDefault = false;
  settingsCtrl.autoCheckUpdates = true;
  settingsCtrl.soundEffectsEnabled = true;
  settingsCtrl.soundEffectsVolume = 1;
  settingsCtrl.repo = "";
  settingsCtrl.identity = null;
  settingsCtrl.nameInput = "";
  settingsCtrl.emailInput = "";
  settingsCtrl.identityLoading = false;
  settingsCtrl.identitySaving = false;
  settingsCtrl.identityError = "";
  // The plugin registry lives on pluginsCtrl now (its own view); the skin picker
  // just reads it. Reset it here so the skinnablePlugins tests are isolated.
  pluginsCtrl.plugins = [];
  pluginsCtrl.selectedId = null;
  pluginsCtrl.filter = "";
  pluginsCtrl.pluginsError = "";
  pluginsCtrl.pluginBusyId = null;
  pluginsCtrl.pluginInstalling = false;
  pluginsCtrl.removingPluginId = null;
  settingsCtrl.tamaSkinPluginId = null;
  settingsCtrl.tamaSkinBusy = false;
  settingsCtrl.tamaSkinError = "";
  settingsCtrl.tamaMotionPreset = "default";
  settingsCtrl.tamaPoseOverrides = {};
  mockInTauri = true;
  vi.clearAllMocks();
  // Default: an empty registry, so the unconditional refreshPlugins() every
  // show() now fires resolves cleanly in the pre-existing show()/identity
  // tests. Individual plugin tests override this with mockResolvedValueOnce.
  vi.mocked(commands.listPlugins).mockResolvedValue(ok([]));
}

beforeEach(() => {
  resetCtrl();
});

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", () => {
    expect(document.getElementById("cv")).toBeNull();
    expect(settingsCtrl).toBeDefined();
  });
});

describe("snapshot retention settings", () => {
  it("setSnapshotRetentionMode applies and persists", () => {
    settingsCtrl.setSnapshotRetentionMode("hybrid");
    expect(settingsCtrl.snapshotRetentionMode).toBe("hybrid");
    expect(loadSettings().snapshotRetentionMode).toBe("hybrid");
  });

  it("count/days setters floor to >= 1 and truncate fractions, persisting the clamped value", () => {
    settingsCtrl.setSnapshotRetentionCount(0);
    expect(settingsCtrl.snapshotRetentionCount).toBe(1);
    expect(loadSettings().snapshotRetentionCount).toBe(1);

    settingsCtrl.setSnapshotRetentionCount(30.9);
    expect(settingsCtrl.snapshotRetentionCount).toBe(30);

    settingsCtrl.setSnapshotRetentionDays(-5);
    expect(settingsCtrl.snapshotRetentionDays).toBe(1);

    settingsCtrl.setSnapshotRetentionCount(Number.NaN);
    expect(settingsCtrl.snapshotRetentionCount).toBe(1);
  });
});

describe("pruneSnapshotsPerPolicy", () => {
  it("no-ops without touching the backend when the mode is off", async () => {
    saveSettings({ snapshotRetentionMode: "off" });
    await pruneSnapshotsPerPolicy("/repo");
    expect(commands.pruneSnapshots).not.toHaveBeenCalled();
  });

  it("calls prune_snapshots with the configured mode/count/days when not off", async () => {
    saveSettings({ snapshotRetentionMode: "hybrid", snapshotRetentionCount: 10, snapshotRetentionDays: 7 });
    await pruneSnapshotsPerPolicy("/repo");
    expect(commands.pruneSnapshots).toHaveBeenCalledWith("/repo", "hybrid", 10, 7);
  });

  it("no-ops with no repo, and outside Tauri", async () => {
    saveSettings({ snapshotRetentionMode: "count" });
    await pruneSnapshotsPerPolicy("");
    expect(commands.pruneSnapshots).not.toHaveBeenCalled();

    mockInTauri = false;
    await pruneSnapshotsPerPolicy("/repo");
    expect(commands.pruneSnapshots).not.toHaveBeenCalled();
  });

  it("swallows a backend rejection — fire-and-forget never rejects", async () => {
    saveSettings({ snapshotRetentionMode: "age", snapshotRetentionDays: 14 });
    vi.mocked(commands.pruneSnapshots).mockRejectedValueOnce(new Error("boom"));
    await expect(pruneSnapshotsPerPolicy("/repo")).resolves.toBeUndefined();
  });
});

describe("loadSettings / saveSettings — localStorage persistence", () => {
  it("returns defaults when nothing has been saved yet", () => {
    expect(loadSettings()).toEqual({
      themeMode: "dark",
      cherryPickRecordOriginDefault: false,
      autoCheckUpdates: true,
      useNightlyChannel: false,
      soundEffectsEnabled: true,
      soundEffectsVolume: 1,
      showAllCommitTags: false,
      graphLabelPriority: "tag",
      graphLabelLayout: "inline",
      autoFetchEnabled: false,
      autoFetchIntervalMinutes: 15,
      autoMaintenanceEnabled: false,
      snapshotRetentionMode: "off",
      snapshotRetentionCount: 25,
      snapshotRetentionDays: 14,
      tamaEnabled: true,
      tamaSkinPluginId: null,
      tamaMotionPreset: "default",
      tamaPoseOverrides: {},
    });
  });

  it("round-trips a partial save merged over the previous values", () => {
    saveSettings({ themeMode: "light" });
    saveSettings({ cherryPickRecordOriginDefault: true });
    saveSettings({ soundEffectsVolume: 0.9 });

    expect(loadSettings()).toEqual({
      themeMode: "light",
      cherryPickRecordOriginDefault: true,
      autoCheckUpdates: true,
      useNightlyChannel: false,
      soundEffectsEnabled: true,
      soundEffectsVolume: 0.9,
      showAllCommitTags: false,
      graphLabelPriority: "tag",
      graphLabelLayout: "inline",
      autoFetchEnabled: false,
      autoFetchIntervalMinutes: 15,
      autoMaintenanceEnabled: false,
      snapshotRetentionMode: "off",
      snapshotRetentionCount: 25,
      snapshotRetentionDays: 14,
      tamaEnabled: true,
      tamaSkinPluginId: null,
      tamaMotionPreset: "default",
      tamaPoseOverrides: {},
    });
  });

  it("falls back to defaults on corrupt JSON instead of throwing", () => {
    localStorage.setItem("gitcat.settings", "{not valid json");

    expect(loadSettings()).toEqual({
      themeMode: "dark",
      cherryPickRecordOriginDefault: false,
      autoCheckUpdates: true,
      useNightlyChannel: false,
      soundEffectsEnabled: true,
      soundEffectsVolume: 1,
      showAllCommitTags: false,
      graphLabelPriority: "tag",
      graphLabelLayout: "inline",
      autoFetchEnabled: false,
      autoFetchIntervalMinutes: 15,
      autoMaintenanceEnabled: false,
      snapshotRetentionMode: "off",
      snapshotRetentionCount: 25,
      snapshotRetentionDays: 14,
      tamaEnabled: true,
      tamaSkinPluginId: null,
      tamaMotionPreset: "default",
      tamaPoseOverrides: {},
    });
  });

  it("falls back to defaults when localStorage itself throws (e.g. private mode)", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    });

    expect(loadSettings()).toEqual({
      themeMode: "dark",
      cherryPickRecordOriginDefault: false,
      autoCheckUpdates: true,
      useNightlyChannel: false,
      soundEffectsEnabled: true,
      soundEffectsVolume: 1,
      showAllCommitTags: false,
      graphLabelPriority: "tag",
      graphLabelLayout: "inline",
      autoFetchEnabled: false,
      autoFetchIntervalMinutes: 15,
      autoMaintenanceEnabled: false,
      snapshotRetentionMode: "off",
      snapshotRetentionCount: 25,
      snapshotRetentionDays: 14,
      tamaEnabled: true,
      tamaSkinPluginId: null,
      tamaMotionPreset: "default",
      tamaPoseOverrides: {},
    });
  });

  // A non-finite value assigned directly to a real Web Audio GainNode's
  // .value throws — sound.ts's own playTamaSound() trusts loadSettings() to
  // never hand it one, so this clamp has to live HERE, at the read
  // boundary, not just in setSoundEffectsVolume()'s write-side clamp (a
  // hand-edited localStorage blob never goes through that setter at all).
  describe("soundEffectsVolume sanitization (defends sound.ts's own AudioParam assignment)", () => {
    it("clamps an out-of-range persisted volume back into 0-1", () => {
      localStorage.setItem("gitcat.settings", JSON.stringify({ soundEffectsVolume: 5 }));
      expect(loadSettings().soundEffectsVolume).toBe(1);

      localStorage.setItem("gitcat.settings", JSON.stringify({ soundEffectsVolume: -2 }));
      expect(loadSettings().soundEffectsVolume).toBe(0);
    });

    it("falls back to the default when the persisted volume isn't a finite number at all", () => {
      localStorage.setItem("gitcat.settings", JSON.stringify({ soundEffectsVolume: "loud" }));
      expect(loadSettings().soundEffectsVolume).toBe(1);

      localStorage.setItem("gitcat.settings", JSON.stringify({ soundEffectsVolume: null }));
      expect(loadSettings().soundEffectsVolume).toBe(1);
    });
  });
});

describe("show — seeds app-level fields and drives the identity section", () => {
  it("seeds themeMode/cherryPickRecordOriginDefault/autoCheckUpdates/soundEffectsEnabled/soundEffectsVolume/showAllCommitTags/autoFetchEnabled/autoFetchIntervalMinutes/tamaEnabled from localStorage", () => {
    saveSettings({
      themeMode: "system",
      cherryPickRecordOriginDefault: true,
      autoCheckUpdates: false,
      soundEffectsEnabled: false,
      soundEffectsVolume: 0.25,
      showAllCommitTags: true,
      autoFetchEnabled: true,
      autoFetchIntervalMinutes: 60,
      tamaEnabled: false,
      tamaSkinPluginId: "acme-skin",
      tamaMotionPreset: "calm",
      tamaPoseOverrides: { danger: "shocked" },
    });

    settingsCtrl.show(null);

    expect(settingsCtrl.open).toBe(true);
    expect(settingsCtrl.themeMode).toBe("system");
    expect(settingsCtrl.cherryPickRecordOriginDefault).toBe(true);
    expect(settingsCtrl.autoCheckUpdates).toBe(false);
    expect(settingsCtrl.soundEffectsEnabled).toBe(false);
    expect(settingsCtrl.soundEffectsVolume).toBe(0.25);
    expect(settingsCtrl.showAllCommitTags).toBe(true);
    expect(settingsCtrl.autoFetchEnabled).toBe(true);
    expect(settingsCtrl.autoFetchIntervalMinutes).toBe(60);
    expect(settingsCtrl.tamaEnabled).toBe(false);
    expect(settingsCtrl.tamaSkinPluginId).toBe("acme-skin");
    expect(settingsCtrl.tamaMotionPreset).toBe("calm");
    expect(settingsCtrl.tamaPoseOverrides).toEqual({ danger: "shocked" });
  });

  it("with no repo open, clears identity and never calls getGitIdentity", () => {
    settingsCtrl.show(null);

    expect(settingsCtrl.repo).toBe("");
    expect(settingsCtrl.identity).toBeNull();
    expect(commands.getGitIdentity).not.toHaveBeenCalled();
  });

  it("with a repo open, sets repo and fetches its identity", async () => {
    vi.mocked(commands.getGitIdentity).mockResolvedValueOnce(ok(identity({ name: "A", email: "a@x.com", configured: true })));

    settingsCtrl.show("/repo/a");
    await Promise.resolve();
    await Promise.resolve();

    expect(settingsCtrl.repo).toBe("/repo/a");
    expect(commands.getGitIdentity).toHaveBeenCalledWith("/repo/a");
    expect(settingsCtrl.nameInput).toBe("A");
    expect(settingsCtrl.emailInput).toBe("a@x.com");
  });
});

describe("setThemeMode / setCherryPickRecordOriginDefault / setAutoCheckUpdates / setSoundEffectsEnabled — instant apply", () => {
  it("setThemeMode updates state, persists, and applies via bridge.applyThemeMode", () => {
    settingsCtrl.setThemeMode("light");

    expect(settingsCtrl.themeMode).toBe("light");
    expect(bridge.applyThemeMode).toHaveBeenCalledWith("light");
  });

  it("setCherryPickRecordOriginDefault updates state and persists directly (no bridge call)", () => {
    settingsCtrl.setCherryPickRecordOriginDefault(true);

    expect(settingsCtrl.cherryPickRecordOriginDefault).toBe(true);
    expect(loadSettings().cherryPickRecordOriginDefault).toBe(true);
  });

  it("setAutoCheckUpdates updates state and persists directly (no bridge call)", () => {
    settingsCtrl.setAutoCheckUpdates(false);

    expect(settingsCtrl.autoCheckUpdates).toBe(false);
    expect(loadSettings().autoCheckUpdates).toBe(false);
  });

  it("setUseNightlyChannel updates state and persists (opt-in nightly channel, default off)", () => {
    expect(settingsCtrl.useNightlyChannel).toBe(false); // default
    settingsCtrl.setUseNightlyChannel(true);

    expect(settingsCtrl.useNightlyChannel).toBe(true);
    expect(loadSettings().useNightlyChannel).toBe(true);
  });

  it("setSoundEffectsEnabled updates state and persists directly (no bridge call)", () => {
    settingsCtrl.setSoundEffectsEnabled(false);

    expect(settingsCtrl.soundEffectsEnabled).toBe(false);
    expect(loadSettings().soundEffectsEnabled).toBe(false);
  });

  it("setSoundEffectsVolume updates state and persists directly (no bridge call)", () => {
    settingsCtrl.setSoundEffectsVolume(0.3);

    expect(settingsCtrl.soundEffectsVolume).toBe(0.3);
    expect(loadSettings().soundEffectsVolume).toBe(0.3);
  });

  it("setSoundEffectsVolume clamps out-of-range values instead of persisting them as-is", () => {
    settingsCtrl.setSoundEffectsVolume(1.4);
    expect(settingsCtrl.soundEffectsVolume).toBe(1);

    settingsCtrl.setSoundEffectsVolume(-0.2);
    expect(settingsCtrl.soundEffectsVolume).toBe(0);
  });

  it("setShowAllCommitTags updates state, persists, and applies via bridge.setGraphShowAllTags", () => {
    settingsCtrl.setShowAllCommitTags(true);

    expect(settingsCtrl.showAllCommitTags).toBe(true);
    expect(loadSettings().showAllCommitTags).toBe(true);
    expect(bridge.setGraphShowAllTags).toHaveBeenCalledWith(true);
  });

  it("setGraphLabelPriority updates state, persists, and applies via bridge.setGraphLabelPriority", () => {
    settingsCtrl.setGraphLabelPriority("branch");

    expect(settingsCtrl.graphLabelPriority).toBe("branch");
    expect(loadSettings().graphLabelPriority).toBe("branch");
    expect(bridge.setGraphLabelPriority).toHaveBeenCalledWith("branch");
  });

  it("graphLabelLayout defaults to inline, persists, and pushes to the canvas live", () => {
    expect(settingsCtrl.graphLabelLayout).toBe("inline");

    settingsCtrl.setGraphLabelLayout("column");

    expect(settingsCtrl.graphLabelLayout).toBe("column");
    expect(loadSettings().graphLabelLayout).toBe("column");
    expect(bridge.setGraphLabelLayout).toHaveBeenCalledWith("column");
  });

  it("setTamaEnabled updates state, persists, and applies via bridge.setTamaEnabled", () => {
    settingsCtrl.setTamaEnabled(false);

    expect(settingsCtrl.tamaEnabled).toBe(false);
    expect(loadSettings().tamaEnabled).toBe(false);
    expect(bridge.setTamaEnabled).toHaveBeenCalledWith(false);
  });

  it("setAutoFetchEnabled updates state and persists", () => {
    settingsCtrl.setAutoFetchEnabled(true);

    expect(settingsCtrl.autoFetchEnabled).toBe(true);
    expect(loadSettings().autoFetchEnabled).toBe(true);
  });

  it("setAutoFetchIntervalMinutes updates state and persists", () => {
    settingsCtrl.setAutoFetchIntervalMinutes(30);

    expect(settingsCtrl.autoFetchIntervalMinutes).toBe(30);
    expect(loadSettings().autoFetchIntervalMinutes).toBe(30);
  });
});

describe("activeTab — settings modal tabs", () => {
  it("defaults to 'general'", () => {
    expect(settingsCtrl.activeTab).toBe("general");
  });

  it("setActiveTab switches the active tab", () => {
    settingsCtrl.setActiveTab("gitconfig");
    expect(settingsCtrl.activeTab).toBe("gitconfig");
  });

  it("show() resets activeTab back to 'general', even if a different tab was left selected", () => {
    settingsCtrl.setActiveTab("identity");

    settingsCtrl.show(null);

    expect(settingsCtrl.activeTab).toBe("general");
  });
});

describe("filteredAdvancedEntries / editAdvancedEntry — Advanced git-config editor", () => {
  const entries = [
    { key: "core.autocrlf", value: "true" },
    { key: "user.signingkey", value: "ABCDEF" },
    { key: "alias.st", value: "status" },
  ];

  beforeEach(() => {
    settingsCtrl.advancedEntries = entries;
  });

  it("returns every entry unfiltered when advancedFilter is blank", () => {
    expect(settingsCtrl.filteredAdvancedEntries).toEqual(entries);
  });

  it("matches on a key substring", () => {
    settingsCtrl.advancedFilter = "autocrlf";
    expect(settingsCtrl.filteredAdvancedEntries).toEqual([entries[0]]);
  });

  it("matches on a value substring", () => {
    settingsCtrl.advancedFilter = "status";
    expect(settingsCtrl.filteredAdvancedEntries).toEqual([entries[2]]);
  });

  it("matches case-insensitively", () => {
    settingsCtrl.advancedFilter = "SIGNINGKEY";
    expect(settingsCtrl.filteredAdvancedEntries).toEqual([entries[1]]);
  });

  it("returns an empty list when nothing matches", () => {
    settingsCtrl.advancedFilter = "nope-not-here";
    expect(settingsCtrl.filteredAdvancedEntries).toEqual([]);
  });

  it("editAdvancedEntry copies the row's key/value into the add/update form", () => {
    settingsCtrl.editAdvancedEntry(entries[1]);

    expect(settingsCtrl.newAdvancedKey).toBe("user.signingkey");
    expect(settingsCtrl.newAdvancedValue).toBe("ABCDEF");
  });
});

describe("openAdvanced — resets the filter on every (re)open", () => {
  it("clears a leftover advancedFilter when reopening", async () => {
    settingsCtrl.repo = "/repo/a";
    settingsCtrl.advancedFilter = "leftover";
    mockInTauri = false; // demo path: refreshAdvanced just clears advancedEntries, no IPC mock needed

    await settingsCtrl.openAdvanced();

    expect(settingsCtrl.advancedFilter).toBe("");
  });
});

describe("close", () => {
  it("is blocked while an identity save is in flight", () => {
    settingsCtrl.open = true;
    settingsCtrl.identitySaving = true;

    settingsCtrl.close();

    expect(settingsCtrl.open).toBe(true);
  });

  it("otherwise closes it", () => {
    settingsCtrl.open = true;

    settingsCtrl.close();

    expect(settingsCtrl.open).toBe(false);
  });
});

describe("refreshIdentity", () => {
  it("populates identity and the name/email inputs on success", async () => {
    settingsCtrl.repo = "/repo/a";
    vi.mocked(commands.getGitIdentity).mockResolvedValueOnce(ok(identity({ name: "A. Turing", email: "alan@enigma.dev", configured: true })));

    await settingsCtrl.refreshIdentity();

    expect(settingsCtrl.identity?.configured).toBe(true);
    expect(settingsCtrl.nameInput).toBe("A. Turing");
    expect(settingsCtrl.emailInput).toBe("alan@enigma.dev");
    expect(settingsCtrl.identityError).toBe("");
  });

  it("surfaces a backend error without crashing", async () => {
    settingsCtrl.repo = "/repo/a";
    vi.mocked(commands.getGitIdentity).mockResolvedValueOnce(err("not a git repository"));

    await settingsCtrl.refreshIdentity();

    expect(settingsCtrl.identity).toBeNull();
    expect(settingsCtrl.identityError).toContain("not a git repository");
  });

  it("a rejected round trip is caught and surfaced as an error, not an unhandled rejection", async () => {
    settingsCtrl.repo = "/repo/a";
    vi.mocked(commands.getGitIdentity).mockRejectedValueOnce(new Error("invoke failed"));

    await settingsCtrl.refreshIdentity();

    expect(settingsCtrl.identityError).toContain("invoke failed");
    expect(settingsCtrl.identityLoading).toBe(false);
  });

  it("with no repo open, clears identity and never calls the backend", async () => {
    settingsCtrl.repo = "";

    await settingsCtrl.refreshIdentity();

    expect(commands.getGitIdentity).not.toHaveBeenCalled();
    expect(settingsCtrl.identity).toBeNull();
  });

  it("design mode (!IN_TAURI): no IPC call, seeds canned demo identity", async () => {
    mockInTauri = false;
    settingsCtrl.repo = "/repo/a";

    await settingsCtrl.refreshIdentity();

    expect(commands.getGitIdentity).not.toHaveBeenCalled();
    expect(settingsCtrl.identity?.configured).toBe(true);
  });

  it("surfaces local:false as-is when the backend falls back to a global identity", async () => {
    settingsCtrl.repo = "/repo/a";
    vi.mocked(commands.getGitIdentity).mockResolvedValueOnce(
      ok(identity({ name: "Global User", email: "global@example.com", configured: true, local: false })),
    );

    await settingsCtrl.refreshIdentity();

    expect(settingsCtrl.identity?.local).toBe(false);
    expect(settingsCtrl.identity?.configured).toBe(true);
    // The fields still pre-fill from the effective (global-sourced) values —
    // Save would turn this into a repo-local override, but nothing forces that.
    expect(settingsCtrl.nameInput).toBe("Global User");
    expect(settingsCtrl.emailInput).toBe("global@example.com");
  });
});

describe("saveIdentity", () => {
  it("saves trimmed name/email and surfaces a Tama toast on success", async () => {
    settingsCtrl.repo = "/repo/a";
    settingsCtrl.nameInput = "  A. Turing  ";
    settingsCtrl.emailInput = "  alan@enigma.dev  ";
    vi.mocked(commands.setGitIdentity).mockResolvedValueOnce({ ok: true, message: "", backupRef: null, conflictingFiles: [] });

    await settingsCtrl.saveIdentity();

    expect(commands.setGitIdentity).toHaveBeenCalledWith("/repo/a", "A. Turing", "alan@enigma.dev");
    expect(settingsCtrl.identity).toEqual({ name: "A. Turing", email: "alan@enigma.dev", configured: true, local: true });
    expect(bridge.tama.say).toHaveBeenCalled();
  });

  it("surfaces a backend failure message without throwing", async () => {
    settingsCtrl.repo = "/repo/a";
    settingsCtrl.nameInput = "A";
    settingsCtrl.emailInput = "a@x.com";
    vi.mocked(commands.setGitIdentity).mockResolvedValueOnce({ ok: false, message: "could not write .git/config", backupRef: null, conflictingFiles: [] });

    await settingsCtrl.saveIdentity();

    expect(settingsCtrl.identityError).toContain("could not write .git/config");
  });

  it("a rejected round trip is caught and surfaced as an error, not an unhandled rejection", async () => {
    settingsCtrl.repo = "/repo/a";
    settingsCtrl.nameInput = "A";
    settingsCtrl.emailInput = "a@x.com";
    vi.mocked(commands.setGitIdentity).mockRejectedValueOnce(new Error("invoke failed"));

    await settingsCtrl.saveIdentity();

    expect(settingsCtrl.identityError).toContain("invoke failed");
    expect(settingsCtrl.identitySaving).toBe(false);
  });

  it("does nothing when name or email is blank (canSaveIdentity guards it)", async () => {
    settingsCtrl.repo = "/repo/a";
    settingsCtrl.nameInput = "";
    settingsCtrl.emailInput = "a@x.com";

    await settingsCtrl.saveIdentity();

    expect(commands.setGitIdentity).not.toHaveBeenCalled();
  });

  it("design mode (!IN_TAURI): no IPC call, just a Tama toast", async () => {
    mockInTauri = false;
    settingsCtrl.repo = "/repo/a";
    settingsCtrl.nameInput = "A";
    settingsCtrl.emailInput = "a@x.com";

    await settingsCtrl.saveIdentity();

    expect(commands.setGitIdentity).not.toHaveBeenCalled();
    expect(bridge.tama.say).toHaveBeenCalled();
  });
});

// NOTE: plugin registry MANAGEMENT (refreshPlugins/setPluginEnabled/remove/
// install) moved to its own view — see plugins.svelte.test.ts. Settings only
// still touches the plugin list through the Tama skin picker below.

describe("tama skin — hasTamaSkin / pickSkinCopyLine (pure helpers)", () => {
  it("hasTamaSkin is true only when the plugin declares a (truthy) tama field", () => {
    expect(hasTamaSkin(skinnablePlugin("a"))).toBe(true);
    expect(hasTamaSkin(plugin({ id: "b" }))).toBe(false);
  });

  it("pickSkinCopyLine returns null when the skin ships no copy", () => {
    expect(pickSkinCopyLine(null)).toBeNull();
    expect(pickSkinCopyLine(undefined)).toBeNull();
    expect(pickSkinCopyLine({})).toBeNull();
  });

  it("pickSkinCopyLine prefers applied > greeting > hero, else the first line", () => {
    expect(pickSkinCopyLine({ applied: "A", greeting: "G", hero: "H" })).toBe("A");
    expect(pickSkinCopyLine({ greeting: "G", hero: "H" })).toBe("G");
    expect(pickSkinCopyLine({ hero: "H" })).toBe("H");
    expect(pickSkinCopyLine({ other: "O", another: "N" })).toBe("O");
  });

  it("pickSkinCopyLine caps a long line at 160 chars", () => {
    const long = "x".repeat(500);
    expect(pickSkinCopyLine({ applied: long })).toHaveLength(160);
  });
});

describe("tama skin — skinnablePlugins", () => {
  it("lists only ENABLED plugins that declare a tama field (read from pluginsCtrl)", () => {
    pluginsCtrl.plugins = [
      skinnablePlugin("skin-on", "Skin On"),
      plugin({ id: "no-skin", name: "No Skin" }),
      { ...skinnablePlugin("skin-off", "Skin Off"), enabled: false } as unknown as Plugin,
    ];

    expect(settingsCtrl.skinnablePlugins.map((p) => p.id)).toEqual(["skin-on"]);
  });

  it("show() refreshes pluginsCtrl so the skin picker's list is current", async () => {
    vi.mocked(commands.listPlugins).mockResolvedValueOnce(ok([skinnablePlugin("x", "X")]));

    settingsCtrl.show(null);
    await Promise.resolve();
    await Promise.resolve();

    expect(commands.listPlugins).toHaveBeenCalled();
    expect(pluginsCtrl.plugins.map((p) => p.id)).toEqual(["x"]);
  });
});

describe("tama skin — setTamaSkin (interactive picker)", () => {
  it("Default (null) clears the overlay, persists null, and never hits the backend", async () => {
    saveSettings({ tamaSkinPluginId: "acme" });
    settingsCtrl.tamaSkinPluginId = "acme";

    await settingsCtrl.setTamaSkin(null);

    expect(bridge.clearTamaSkin).toHaveBeenCalled();
    expect(commands.loadPluginSkin).not.toHaveBeenCalled();
    expect(settingsCtrl.tamaSkinPluginId).toBeNull();
    expect(loadSettings().tamaSkinPluginId).toBeNull();
  });

  it("Default coerces an empty-string selection to null too", async () => {
    await settingsCtrl.setTamaSkin("");

    expect(bridge.clearTamaSkin).toHaveBeenCalled();
    expect(settingsCtrl.tamaSkinPluginId).toBeNull();
  });

  it("loads the skin, overlays poses, persists the id, and says the skin's copy line", async () => {
    vi.mocked(commands.loadPluginSkin).mockResolvedValueOnce(ok(skin({ hero: "data:hero" }, { applied: "New look, にゃ〜" })));

    await settingsCtrl.setTamaSkin("acme");

    expect(commands.loadPluginSkin).toHaveBeenCalledWith("acme");
    // A skin with no voicePitch forwards `undefined` as the 2nd arg (main.ts's
    // applyTamaSkin reads that as "no change" -> the default 1.0 voice).
    expect(bridge.applyTamaSkin).toHaveBeenCalledWith({ hero: "data:hero" }, undefined);
    expect(settingsCtrl.tamaSkinPluginId).toBe("acme");
    expect(loadSettings().tamaSkinPluginId).toBe("acme");
    expect(bridge.tama.say).toHaveBeenCalledWith("New look, にゃ〜");
    expect(settingsCtrl.tamaSkinError).toBe("");
    expect(settingsCtrl.tamaSkinBusy).toBe(false);
  });

  it("applies a skin with no copy without saying anything", async () => {
    vi.mocked(commands.loadPluginSkin).mockResolvedValueOnce(ok(skin({ hero: "data:hero" })));

    await settingsCtrl.setTamaSkin("acme");

    expect(bridge.applyTamaSkin).toHaveBeenCalledWith({ hero: "data:hero" }, undefined);
    expect(bridge.tama.say).not.toHaveBeenCalled();
  });

  it("forwards a plugin skin's voicePitch through to bridge.applyTamaSkin", async () => {
    vi.mocked(commands.loadPluginSkin).mockResolvedValueOnce(
      ok({ poses: { hero: "data:hero" }, copy: {}, voicePitch: 1.3 } as unknown as { poses: Record<string, string>; copy: Record<string, string> }),
    );

    await settingsCtrl.setTamaSkin("acme");

    expect(bridge.applyTamaSkin).toHaveBeenCalledWith({ hero: "data:hero" }, 1.3);
  });

  it("a backend error reverts the selection to Default, clears the overlay, and surfaces tamaSkinError", async () => {
    vi.mocked(commands.loadPluginSkin).mockResolvedValueOnce(err("no such skin"));

    await settingsCtrl.setTamaSkin("acme");

    expect(bridge.applyTamaSkin).not.toHaveBeenCalled();
    expect(bridge.clearTamaSkin).toHaveBeenCalled();
    expect(settingsCtrl.tamaSkinPluginId).toBeNull();
    expect(loadSettings().tamaSkinPluginId).toBeNull(); // a broken skin never becomes the persisted (boot-applied) one
    expect(settingsCtrl.tamaSkinError).toContain("no such skin");
    expect(settingsCtrl.tamaSkinBusy).toBe(false);
  });

  it("a rejected round trip is caught, reverts to Default, and never leaves an unhandled rejection", async () => {
    vi.mocked(commands.loadPluginSkin).mockRejectedValueOnce(new Error("invoke failed"));

    await settingsCtrl.setTamaSkin("acme");

    expect(bridge.clearTamaSkin).toHaveBeenCalled();
    expect(settingsCtrl.tamaSkinPluginId).toBeNull();
    expect(settingsCtrl.tamaSkinError).toContain("invoke failed");
    expect(settingsCtrl.tamaSkinBusy).toBe(false);
  });

  it("design mode (!IN_TAURI): persists + demos with a toast, no backend and no overlay", async () => {
    mockInTauri = false;

    await settingsCtrl.setTamaSkin("acme");

    expect(commands.loadPluginSkin).not.toHaveBeenCalled();
    expect(bridge.applyTamaSkin).not.toHaveBeenCalled();
    expect(settingsCtrl.tamaSkinPluginId).toBe("acme");
    expect(loadSettings().tamaSkinPluginId).toBe("acme");
    expect(bridge.tama.say).toHaveBeenCalled();
  });
});

describe("tama skin — built-in characters (PER-53)", () => {
  it("ships no built-in characters today; the picker's list mirrors BUILTIN_SKINS (empty)", () => {
    // The hue-shift recolor built-ins (Momo/Sora) were removed — a global recolor
    // tints Tama's skin and reads as "off". The mechanism stays for a future
    // PAINTED built-in; until then alternate characters come from skin plugins.
    expect(BUILTIN_SKINS).toEqual([]);
    expect(settingsCtrl.builtinSkins).toEqual([]);
  });

  it("an unrecognised builtin:* id coerces to Default (clears + persists null), never loading it as a plugin", async () => {
    saveSettings({ tamaSkinPluginId: "builtin:momo" });
    settingsCtrl.tamaSkinPluginId = "builtin:momo";

    await settingsCtrl.setTamaSkin("builtin:does-not-exist");

    expect(commands.loadPluginSkin).not.toHaveBeenCalled();
    expect(bridge.applyTamaSkin).not.toHaveBeenCalled();
    expect(bridge.clearTamaSkin).toHaveBeenCalled();
    expect(settingsCtrl.tamaSkinPluginId).toBeNull();
    expect(loadSettings().tamaSkinPluginId).toBeNull();
  });
});

describe("tama skin — applyPersistedTamaSkin (boot)", () => {
  it("no-ops with no persisted skin", async () => {
    await applyPersistedTamaSkin();

    expect(commands.loadPluginSkin).not.toHaveBeenCalled();
    expect(bridge.applyTamaSkin).not.toHaveBeenCalled();
  });

  it("re-applies a persisted skin's poses on success", async () => {
    saveSettings({ tamaSkinPluginId: "acme" });
    vi.mocked(commands.loadPluginSkin).mockResolvedValueOnce(ok(skin({ hero: "data:hero", sleep: "data:sleep" })));

    await applyPersistedTamaSkin();

    expect(commands.loadPluginSkin).toHaveBeenCalledWith("acme");
    expect(bridge.applyTamaSkin).toHaveBeenCalledWith({ hero: "data:hero", sleep: "data:sleep" }, undefined);
  });

  it("falls back to the built-ins SILENTLY when the persisted skin fails to load (plugin removed/disabled)", async () => {
    saveSettings({ tamaSkinPluginId: "gone" });
    vi.mocked(commands.loadPluginSkin).mockResolvedValueOnce(err("unknown plugin"));

    await applyPersistedTamaSkin();

    expect(bridge.applyTamaSkin).not.toHaveBeenCalled();
    expect(bridge.clearTamaSkin).toHaveBeenCalled();
  });

  it("never rejects even when the backend round trip throws", async () => {
    saveSettings({ tamaSkinPluginId: "acme" });
    vi.mocked(commands.loadPluginSkin).mockRejectedValueOnce(new Error("boom"));

    await expect(applyPersistedTamaSkin()).resolves.toBeUndefined();
    expect(bridge.clearTamaSkin).toHaveBeenCalled();
  });

  // No built-in characters ship today, so any persisted "builtin:*" id is
  // unrecognised on boot and stays on Default (covered below). When a painted
  // built-in is added, add its boot-apply test here.
  it("an unrecognised builtin:* id on boot stays on Default: no apply, no clear, no backend", async () => {
    saveSettings({ tamaSkinPluginId: "builtin:gone" });

    await applyPersistedTamaSkin();

    expect(commands.loadPluginSkin).not.toHaveBeenCalled();
    expect(bridge.applyTamaSkin).not.toHaveBeenCalled();
    expect(bridge.clearTamaSkin).not.toHaveBeenCalled();
  });

  it("design mode (!IN_TAURI): never touches the backend, even with a persisted id", async () => {
    mockInTauri = false;
    saveSettings({ tamaSkinPluginId: "acme" });

    await applyPersistedTamaSkin();

    expect(commands.loadPluginSkin).not.toHaveBeenCalled();
  });
});

describe("tama motion preset (PER-54)", () => {
  it("defaults to 'default'", () => {
    expect(settingsCtrl.tamaMotionPreset).toBe("default");
    expect(loadSettings().tamaMotionPreset).toBe("default");
  });

  it("setTamaMotionPreset updates state, persists, and applies via bridge.setTamaMotionPreset", () => {
    settingsCtrl.setTamaMotionPreset("lively");

    expect(settingsCtrl.tamaMotionPreset).toBe("lively");
    expect(loadSettings().tamaMotionPreset).toBe("lively");
    expect(bridge.setTamaMotionPreset).toHaveBeenCalledWith("lively");
  });

  it("also fires in design mode (!IN_TAURI) — a pure-frontend timing knob", () => {
    mockInTauri = false;
    settingsCtrl.setTamaMotionPreset("calm");

    expect(settingsCtrl.tamaMotionPreset).toBe("calm");
    expect(loadSettings().tamaMotionPreset).toBe("calm");
    expect(bridge.setTamaMotionPreset).toHaveBeenCalledWith("calm");
  });
});

describe("tama expression overrides (PER-54)", () => {
  it("setting an override persists it AND applies the full map via bridge.setTamaPoseOverrides", () => {
    settingsCtrl.setTamaPoseOverride("danger", "shocked");

    expect(settingsCtrl.tamaPoseOverrides).toEqual({ danger: "shocked" });
    expect(loadSettings().tamaPoseOverrides).toEqual({ danger: "shocked" });
    expect(bridge.setTamaPoseOverrides).toHaveBeenCalledWith({ danger: "shocked" });
  });

  it("accumulates multiple overrides into one map", () => {
    settingsCtrl.setTamaPoseOverride("danger", "shocked");
    settingsCtrl.setTamaPoseOverride("idle", "sleep");

    expect(settingsCtrl.tamaPoseOverrides).toEqual({ danger: "shocked", idle: "sleep" });
    expect(loadSettings().tamaPoseOverrides).toEqual({ danger: "shocked", idle: "sleep" });
    expect(bridge.setTamaPoseOverrides).toHaveBeenLastCalledWith({ danger: "shocked", idle: "sleep" });
  });

  it("selecting Default ('') REMOVES just that override and applies the trimmed map", () => {
    settingsCtrl.setTamaPoseOverride("danger", "shocked");
    settingsCtrl.setTamaPoseOverride("idle", "sleep");

    settingsCtrl.setTamaPoseOverride("danger", "");

    expect(settingsCtrl.tamaPoseOverrides).toEqual({ idle: "sleep" });
    expect(loadSettings().tamaPoseOverrides).toEqual({ idle: "sleep" });
    expect(bridge.setTamaPoseOverrides).toHaveBeenLastCalledWith({ idle: "sleep" });
  });

  it("tamaPoseOverride / hasTamaPoseOverrides reflect the current map", () => {
    expect(settingsCtrl.hasTamaPoseOverrides).toBe(false);
    expect(settingsCtrl.tamaPoseOverride("danger")).toBe("");

    settingsCtrl.setTamaPoseOverride("danger", "alarm");

    expect(settingsCtrl.hasTamaPoseOverrides).toBe(true);
    expect(settingsCtrl.tamaPoseOverride("danger")).toBe("alarm");
    expect(settingsCtrl.tamaPoseOverride("idle")).toBe(""); // unset -> Default
  });

  it("resetTamaPoseOverrides clears all overrides, persists {}, and applies {} to the runtime", () => {
    settingsCtrl.setTamaPoseOverride("danger", "shocked");
    settingsCtrl.setTamaPoseOverride("idle", "sleep");

    settingsCtrl.resetTamaPoseOverrides();

    expect(settingsCtrl.tamaPoseOverrides).toEqual({});
    expect(settingsCtrl.hasTamaPoseOverrides).toBe(false);
    expect(loadSettings().tamaPoseOverrides).toEqual({});
    expect(bridge.setTamaPoseOverrides).toHaveBeenLastCalledWith({});
  });

  it("tamaPoseLabel maps a pose key to its friendly label, else the raw key", () => {
    expect(tamaPoseLabel("curious")).toBe("Curious");
    expect(tamaPoseLabel("hero")).toBe("Hero");
    expect(tamaPoseLabel("nope")).toBe("nope");
  });
});

describe("applyPersistedTamaMotion (boot, PER-54)", () => {
  it("applies the persisted preset + overrides to the runtime via both bridge setters", () => {
    saveSettings({ tamaMotionPreset: "lively", tamaPoseOverrides: { danger: "shocked" } });

    applyPersistedTamaMotion();

    expect(bridge.setTamaMotionPreset).toHaveBeenCalledWith("lively");
    expect(bridge.setTamaPoseOverrides).toHaveBeenCalledWith({ danger: "shocked" });
  });

  it("applies the defaults ('default' + {}) as a baseline when nothing is persisted", () => {
    applyPersistedTamaMotion();

    expect(bridge.setTamaMotionPreset).toHaveBeenCalledWith("default");
    expect(bridge.setTamaPoseOverrides).toHaveBeenCalledWith({});
  });

  it("still applies in design mode (!IN_TAURI) — pure-frontend, no backend gate", () => {
    mockInTauri = false;
    saveSettings({ tamaMotionPreset: "calm", tamaPoseOverrides: { idle: "sleep" } });

    applyPersistedTamaMotion();

    expect(bridge.setTamaMotionPreset).toHaveBeenCalledWith("calm");
    expect(bridge.setTamaPoseOverrides).toHaveBeenCalledWith({ idle: "sleep" });
  });
});
