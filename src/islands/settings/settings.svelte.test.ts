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
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    getGitIdentity: vi.fn(),
    setGitIdentity: vi.fn(),
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
import type { GitIdentity } from "../../ipc/bindings";
import { loadSettings, saveSettings, settingsCtrl } from "./settings.svelte.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}
function identity(partial: Partial<GitIdentity> = {}): GitIdentity {
  return { name: null, email: null, configured: false, local: false, ...partial };
}

function resetCtrl() {
  vi.stubGlobal("localStorage", memoryStorage());
  settingsCtrl.open = false;
  settingsCtrl.themeMode = "dark";
  settingsCtrl.cherryPickRecordOriginDefault = false;
  settingsCtrl.autoCheckUpdates = true;
  settingsCtrl.repo = "";
  settingsCtrl.identity = null;
  settingsCtrl.nameInput = "";
  settingsCtrl.emailInput = "";
  settingsCtrl.identityLoading = false;
  settingsCtrl.identitySaving = false;
  settingsCtrl.identityError = "";
  mockInTauri = true;
  vi.clearAllMocks();
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

describe("loadSettings / saveSettings — localStorage persistence", () => {
  it("returns defaults when nothing has been saved yet", () => {
    expect(loadSettings()).toEqual({
      themeMode: "dark",
      cherryPickRecordOriginDefault: false,
      autoCheckUpdates: true,
    });
  });

  it("round-trips a partial save merged over the previous values", () => {
    saveSettings({ themeMode: "light" });
    saveSettings({ cherryPickRecordOriginDefault: true });

    expect(loadSettings()).toEqual({
      themeMode: "light",
      cherryPickRecordOriginDefault: true,
      autoCheckUpdates: true,
    });
  });

  it("falls back to defaults on corrupt JSON instead of throwing", () => {
    localStorage.setItem("gitcat.settings", "{not valid json");

    expect(loadSettings()).toEqual({
      themeMode: "dark",
      cherryPickRecordOriginDefault: false,
      autoCheckUpdates: true,
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
    });
  });
});

describe("show — seeds app-level fields and drives the identity section", () => {
  it("seeds themeMode/cherryPickRecordOriginDefault/autoCheckUpdates from localStorage", () => {
    saveSettings({ themeMode: "system", cherryPickRecordOriginDefault: true, autoCheckUpdates: false });

    settingsCtrl.show(null);

    expect(settingsCtrl.open).toBe(true);
    expect(settingsCtrl.themeMode).toBe("system");
    expect(settingsCtrl.cherryPickRecordOriginDefault).toBe(true);
    expect(settingsCtrl.autoCheckUpdates).toBe(false);
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

describe("setThemeMode / setCherryPickRecordOriginDefault / setAutoCheckUpdates — instant apply", () => {
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
