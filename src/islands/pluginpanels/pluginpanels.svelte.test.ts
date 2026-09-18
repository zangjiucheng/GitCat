// Tests for the declarative plugin-panels (PER-45) controller.
//
// Same isolation strategy as plugincommands.svelte.test.ts: legacy/bridge is
// mocked so legacy/main.ts (the whole vanilla canvas app that boots on import)
// never evaluates, and the backend commands (list_plugins / run_plugin_command)
// are mocked so nothing touches a real Tauri IPC. pluginpanels only imports
// cmdk TYPE-ONLY, so pulling this controller in does NOT drag the palette (and
// every island it imports) into the test.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  CUR_REPO: "/repo",
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
  // pluginCommandsCtrl.ctxFor (which both runButton and runCommandOutput go
  // through) reads these for a `commit` command. Since #76 the context is
  // resolved from the MANIFEST when the caller passes none, so a panel widget
  // naming a `commit` command does now reach these.
  state: { selectedRow: -1 },
  BACKEND: { rows: [] as Array<{ sha: string }> },
  TAMA_IMG: { curious: "curious.png" },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    listPlugins: vi.fn(),
    runPluginCommand: vi.fn(),
  },
}));

// IN_TAURI is a live `const` computed from `window.__TAURI__` at import time —
// mock it so the real (non-demo) branches run.
vi.mock("../../ipc/env", () => ({ IN_TAURI: true }));

// The detail island owns the file selection a `file` command's {file} is
// filled from (#76). Mocked so this test does not boot detail's own import
// graph (resolver/blame/filehistory/externaltools) just to read one string.
vi.mock("../detail/detail.svelte.ts", () => ({
  detailCtrl: { selectedFile: null as string | null, commit: {} as unknown },
}));

// ...and the working tree, which keeps its own file selection. `selected` says
// which of the two `#detail` is showing; false here means the commit view.
vi.mock("../workdir/workdir.svelte.ts", () => ({
  workdirCtrl: { selected: false, selectedDiffFile: null as string | null },
}));

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import type { CommandOutput, Plugin, PluginPanel } from "../../ipc/bindings";
import { detailCtrl } from "../detail/detail.svelte.ts";
import { pluginCommandsCtrl } from "../plugincommands/plugincommands.svelte.ts";
import { pluginPanelsCtrl } from "./pluginpanels.svelte.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}

function plugin(partial: Partial<Plugin> & Pick<Plugin, "id" | "name">): Plugin {
  return { version: "1.0.0", description: null, enabled: true, commands: [], hooks: [], panels: [], ...partial };
}

function output(partial: Partial<CommandOutput>): CommandOutput {
  return { stdout: "", exitCode: 0, success: true, ...partial };
}

// Let queued microtasks/timers settle (openPanel used to kick off command-output runs
// without awaiting them).
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function resetCtrl() {
  pluginPanelsCtrl.actions = [];
  pluginPanelsCtrl.loaded = false;
  pluginPanelsCtrl.onActionsChanged = null;
  pluginPanelsCtrl.open = false;
  pluginPanelsCtrl.pluginId = "";
  pluginPanelsCtrl.pluginName = "";
  pluginPanelsCtrl.panel = null;
  pluginPanelsCtrl.outputs = {};
  pluginPanelsCtrl.runningButtons = {};
  // private fields — reset via cast so a prior test never leaks state.
  (pluginPanelsCtrl as unknown as { loading: Promise<void> | null }).loading = null;
  (pluginPanelsCtrl as unknown as { plugins: Plugin[] }).plugins = [];
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCtrl();
});

const INFO_PANEL: PluginPanel = {
  id: "info",
  title: "Acme Info",
  items: [
    { type: "heading", text: "About" },
    { type: "text", text: "Acme does things." },
    { type: "button", label: "Do it", command: "doit" },
    { type: "command-output", command: "status", label: "Status" },
  ],
};

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", () => {
    expect(document.getElementById("cv")).toBeNull();
    expect(pluginPanelsCtrl).toBeDefined();
  });
});

describe("ensureLoaded — building one action per panel", () => {
  it("keeps ENABLED plugins and emits one ActionItem per declared panel", async () => {
    vi.mocked(commands.listPlugins).mockResolvedValueOnce(
      ok([
        plugin({
          id: "acme",
          name: "Acme Tools",
          panels: [
            INFO_PANEL,
            { id: "extra", title: "Acme Extra", items: [{ type: "text", text: "more" }] },
          ],
        }),
        // enabled:false -> its panels are dropped entirely.
        plugin({
          id: "off",
          name: "Disabled",
          enabled: false,
          panels: [{ id: "p", title: "Nope", items: [] }],
        }),
        // no panels -> contributes nothing.
        plugin({ id: "bare", name: "Bare" }),
      ]),
    );

    await pluginPanelsCtrl.ensureLoaded();

    const ids = pluginPanelsCtrl.actions.map((a) => a.id);
    expect(ids).toEqual(["plugin-panel:acme:info", "plugin-panel:acme:extra"]);
    expect(ids).not.toContain("plugin-panel:off:p");
  });

  it("maps a panel to the id/label/hint ActionItem shape", async () => {
    vi.mocked(commands.listPlugins).mockResolvedValueOnce(ok([plugin({ id: "acme", name: "Acme Tools", panels: [INFO_PANEL] })]));

    await pluginPanelsCtrl.ensureLoaded();

    expect(pluginPanelsCtrl.actions[0]).toMatchObject({
      type: "action",
      id: "plugin-panel:acme:info",
      label: "Acme Info",
      hint: "Plugin panel · Acme Tools",
    });
    expect(typeof pluginPanelsCtrl.actions[0].run).toBe("function");
  });

  it("is cached — a second ensureLoaded does not re-hit the backend", async () => {
    vi.mocked(commands.listPlugins).mockResolvedValueOnce(ok([]));

    await pluginPanelsCtrl.ensureLoaded();
    await pluginPanelsCtrl.ensureLoaded();

    expect(commands.listPlugins).toHaveBeenCalledTimes(1);
  });

  it("a backend error leaves the panel actions empty without throwing", async () => {
    vi.mocked(commands.listPlugins).mockResolvedValueOnce(err("registry unreadable"));

    await pluginPanelsCtrl.ensureLoaded();

    expect(pluginPanelsCtrl.actions).toEqual([]);
  });
});

describe("reload — force path notifies the palette", () => {
  it("rebuilds actions and fires onActionsChanged", async () => {
    const spy = vi.fn();
    pluginPanelsCtrl.onActionsChanged = spy;
    vi.mocked(commands.listPlugins).mockResolvedValueOnce(ok([plugin({ id: "acme", name: "Acme", panels: [INFO_PANEL] })]));

    await pluginPanelsCtrl.reload();

    expect(pluginPanelsCtrl.actions.map((a) => a.id)).toEqual(["plugin-panel:acme:info"]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("openPanel — modal state + command-output runs", () => {
  async function loadAcme() {
    vi.mocked(commands.listPlugins).mockResolvedValueOnce(ok([plugin({ id: "acme", name: "Acme Tools", panels: [INFO_PANEL] })]));
    await pluginPanelsCtrl.ensureLoaded();
  }

  it("sets open/pluginId/pluginName/panel from the resolved definition", async () => {
    await loadAcme();
    vi.mocked(commands.runPluginCommand).mockResolvedValue(ok(output({ stdout: "clean" })));

    pluginPanelsCtrl.openPanel("acme", "info");

    expect(pluginPanelsCtrl.open).toBe(true);
    expect(pluginPanelsCtrl.pluginId).toBe("acme");
    expect(pluginPanelsCtrl.pluginName).toBe("Acme Tools");
    expect(pluginPanelsCtrl.panel?.id).toBe("info");
  });

  it("does NOT auto-run command-output items on open (avoids silent repo mutation)", async () => {
    await loadAcme();
    vi.mocked(commands.runPluginCommand).mockResolvedValue(ok(output({ stdout: "on branch main" })));

    pluginPanelsCtrl.openPanel("acme", "info");
    await flush();

    // Opening only seeds idle slots — no backend command runs until the user clicks.
    expect(commands.runPluginCommand).not.toHaveBeenCalled();
    expect(pluginPanelsCtrl.outputs[3]).toMatchObject({ running: false, text: "", error: null });
  });

  it("button widgets also do not auto-run on open", async () => {
    await loadAcme();
    vi.mocked(commands.runPluginCommand).mockResolvedValue(ok(output({ stdout: "x" })));

    pluginPanelsCtrl.openPanel("acme", "info");
    await flush();

    expect(commands.runPluginCommand).not.toHaveBeenCalled();
  });

  it("a non-zero command-output still shows stdout, with an exit note", async () => {
    await loadAcme();
    vi.mocked(commands.runPluginCommand).mockResolvedValue(ok(output({ stdout: "partial", exitCode: 2, success: false })));

    pluginPanelsCtrl.openPanel("acme", "info");
    await flush();
    await pluginPanelsCtrl.runCommandOutput(3);

    expect(pluginPanelsCtrl.outputs[3]).toMatchObject({ text: "partial", error: "Exited 2." });
  });

  it("an IPC error surfaces as the widget's error banner (no throw)", async () => {
    await loadAcme();
    vi.mocked(commands.runPluginCommand).mockResolvedValue(err("no such command"));

    pluginPanelsCtrl.openPanel("acme", "info");
    await flush();
    await pluginPanelsCtrl.runCommandOutput(3);

    expect(pluginPanelsCtrl.outputs[3]).toMatchObject({ running: false, text: "", error: "no such command" });
  });

  it("re-running a command-output widget re-hits the backend and refreshes its output", async () => {
    await loadAcme();
    vi.mocked(commands.runPluginCommand).mockResolvedValue(ok(output({ stdout: "first" })));
    pluginPanelsCtrl.openPanel("acme", "info");
    await flush();
    await pluginPanelsCtrl.runCommandOutput(3);
    expect(pluginPanelsCtrl.outputs[3]?.text).toBe("first");

    vi.mocked(commands.runPluginCommand).mockResolvedValue(ok(output({ stdout: "second" })));
    await pluginPanelsCtrl.runCommandOutput(3);

    expect(pluginPanelsCtrl.outputs[3]?.text).toBe("second");
  });

  it("warns and stays closed when the plugin/panel is no longer available", async () => {
    await loadAcme();

    pluginPanelsCtrl.openPanel("acme", "ghost");

    expect(pluginPanelsCtrl.open).toBe(false);
    expect(bridge.tama.warn).toHaveBeenCalled();
  });
});

describe("runButton — declarative backend call (delegates to plugincommands.invoke)", () => {
  it("calls runPluginCommand with the plugin's own command + open repo", async () => {
    vi.mocked(commands.runPluginCommand).mockResolvedValueOnce(ok(output({ stdout: "done", success: true })));

    await pluginPanelsCtrl.runButton("acme", "doit");

    expect(commands.runPluginCommand).toHaveBeenCalledWith("acme", "doit", expect.objectContaining({ repo: "/repo" }));
    // busy marker is cleared once the run settles.
    expect(pluginPanelsCtrl.runningButtons.doit).toBeUndefined();
  });

  it("clears the busy marker even when the command fails", async () => {
    vi.mocked(commands.runPluginCommand).mockRejectedValueOnce(new Error("boom"));

    await pluginPanelsCtrl.runButton("acme", "doit");

    expect(pluginPanelsCtrl.runningButtons.doit).toBeUndefined();
  });
});

describe("design mode (!IN_TAURI) is graceful", () => {
  it("loads no panels (never hits the backend) and buttons/outputs no-op the IPC", async () => {
    vi.resetModules();
    vi.doMock("../../ipc/env", () => ({ IN_TAURI: false }));
    // A repo IS open here so runButton reaches invoke's !IN_TAURI demo branch
    // (past its missing-repo guard) — the point is that design mode never issues
    // the IPC, not that there's no repo.
    vi.doMock("../../legacy/bridge", () => ({
      CUR_REPO: "/repo",
      tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
      state: { selectedRow: -1 },
      BACKEND: { rows: [] },
      TAMA_IMG: { curious: "curious.png" },
    }));
    vi.doMock("../../ipc/bindings", () => ({
      commands: { listPlugins: vi.fn(), runPluginCommand: vi.fn() },
    }));
    const bindingsDemo = await import("../../ipc/bindings");
    const { pluginPanelsCtrl: ctrl } = await import("./pluginpanels.svelte.ts");

    await ctrl.ensureLoaded();
    expect(ctrl.actions).toEqual([]);
    expect(bindingsDemo.commands.listPlugins).not.toHaveBeenCalled();

    // A button in design mode delegates to invoke's demo branch — no IPC.
    await ctrl.runButton("acme", "doit");
    expect(bindingsDemo.commands.runPluginCommand).not.toHaveBeenCalled();
    expect(ctrl.runningButtons.doit).toBeUndefined();
  });
});

describe("a widget inherits the context its command declared (#76)", () => {
  const filePanel: PluginPanel = {
    id: "review",
    title: "Review",
    items: [{ type: "command-output", command: "lint", label: "Lint" }],
  };
  const acme = plugin({
    id: "acme",
    name: "Acme",
    panels: [filePanel],
    commands: [
      { id: "lint", label: "Lint", run: "lint {file}", handler: null, context: "file", placement: "palette", mutates: false },
    ],
  });

  beforeEach(() => {
    detailCtrl.selectedFile = null;
    // pluginCommandsCtrl caches its manifest read; force a fresh one so this
    // suite's own plugin lands in its context index.
    pluginCommandsCtrl.loaded = false;
    pluginCommandsCtrl.actions = [];
  });

  // openPanel() fires the command-output run itself; these tests want to drive
  // runCommandOutput directly, so open the panel and let that first, unmocked
  // run settle before asserting on a second, deliberate one.
  async function openReview(): Promise<void> {
    vi.mocked(commands.listPlugins).mockResolvedValue(ok([acme]));
    await pluginCommandsCtrl.ensureLoaded();
    await pluginPanelsCtrl.ensureLoaded();
    vi.mocked(commands.runPluginCommand).mockResolvedValue(ok(output({ stdout: "", success: true })));
    pluginPanelsCtrl.openPanel("acme", "review");
    await flush();
    vi.clearAllMocks();
  }

  it("a command-output widget naming a `file` command gets {file} filled", async () => {
    await openReview();
    detailCtrl.selectedFile = "src/app.ts";
    vi.mocked(commands.runPluginCommand).mockResolvedValueOnce(ok(output({ stdout: "clean", success: true })));

    await pluginPanelsCtrl.runCommandOutput(0);

    expect(commands.runPluginCommand).toHaveBeenCalledWith(
      "acme",
      "lint",
      expect.objectContaining({ repo: "/repo", file: "src/app.ts" }),
    );
  });

  it("the same widget shows an error instead of running with an empty {file}", async () => {
    await openReview();
    detailCtrl.selectedFile = null;

    await pluginPanelsCtrl.runCommandOutput(0);

    expect(commands.runPluginCommand).not.toHaveBeenCalled();
    expect(bridge.tama.warn).toHaveBeenCalled();
    // and the spinner must not be left running for output that never comes
    expect(pluginPanelsCtrl.outputs[0]).toEqual(expect.objectContaining({ running: false }));
  });
});
