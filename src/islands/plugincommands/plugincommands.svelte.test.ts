// Tests for the plugin-commands (PER-42) controller.
//
// Same isolation strategy as reflog.svelte.test.ts: legacy/bridge is mocked so
// legacy/main.ts (the whole vanilla canvas app that boots on import) never
// evaluates, and the backend commands (list_plugins / run_plugin_command) are
// mocked so nothing touches a real Tauri IPC.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  CUR_REPO: "/repo",
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
  // Canvas selection state the controller reads for a `commit` context —
  // mutable plain objects so each test can set the selected row/rows.
  state: { selectedRow: -1 },
  BACKEND: { rows: [] as Array<{ sha: string }> },
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

// The detail island owns the file selection `{file}` is filled from (#76).
// Mocked for the same reason bridge is: importing the real one drags in the
// resolver/blame/filehistory/externaltools graph this controller has no
// business booting.
vi.mock("../detail/detail.svelte.ts", () => ({ detailCtrl: { selectedFile: null as string | null } }));

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import type { CommandOutput, Plugin } from "../../ipc/bindings";
import { detailCtrl } from "../detail/detail.svelte.ts";
import { parseTamaReaction, pluginCommandsCtrl } from "./plugincommands.svelte.ts";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function err(error: string): { status: "error"; error: string } {
  return { status: "error", error };
}

function plugin(partial: Partial<Plugin> & Pick<Plugin, "id" | "name">): Plugin {
  return { version: "1.0.0", description: null, enabled: true, commands: [], hooks: [], ...partial };
}

function output(partial: Partial<CommandOutput>): CommandOutput {
  return { stdout: "", exitCode: 0, success: true, ...partial };
}

function resetCtrl() {
  pluginCommandsCtrl.actions = [];
  pluginCommandsCtrl.loaded = false;
  pluginCommandsCtrl.onActionsChanged = null;
  (bridge.state as unknown as { selectedRow: number }).selectedRow = -1;
  (bridge.BACKEND as unknown as { rows: Array<{ sha: string }> }).rows = [];
  detailCtrl.selectedFile = null;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCtrl();
});

describe("isolation", () => {
  it("never touches the DOM #cv canvas that legacy/main.ts would require", () => {
    expect(document.getElementById("cv")).toBeNull();
    expect(pluginCommandsCtrl).toBeDefined();
  });
});

describe("ensureLoaded — building the palette actions", () => {
  it("keeps ENABLED plugins and only palette/both-placement commands", async () => {
    vi.mocked(commands.listPlugins).mockResolvedValueOnce(
      ok([
        plugin({
          id: "acme",
          name: "Acme Tools",
          commands: [
            { id: "greet", label: "Greet", run: "echo hi", context: "none", placement: "palette" },
            { id: "menu-only", label: "Menu Only", run: "echo x", context: "none", placement: "menu" },
            { id: "both", label: "Both Places", run: "echo y", context: "commit", placement: "both" },
            // placement omitted -> defaults to "palette", so it's kept.
            { id: "defaulted", label: "Defaulted", run: "echo z", context: "none" },
          ],
        }),
        // enabled: false -> the whole plugin's commands are dropped.
        plugin({
          id: "off",
          name: "Disabled Plugin",
          enabled: false,
          commands: [{ id: "nope", label: "Nope", run: "echo no", placement: "palette" }],
        }),
        // enabled omitted -> treated as enabled.
        plugin({
          id: "impl",
          name: "Implicitly On",
          enabled: undefined,
          commands: [{ id: "run", label: "Run It", run: "echo run", placement: "palette" }],
        }),
      ]),
    );

    await pluginCommandsCtrl.ensureLoaded();

    const ids = pluginCommandsCtrl.actions.map((a) => a.id);
    expect(ids).toEqual(["plugin:acme:greet", "plugin:acme:both", "plugin:acme:defaulted", "plugin:impl:run"]);
    expect(ids).not.toContain("plugin:acme:menu-only");
    expect(ids).not.toContain("plugin:off:nope");
  });

  it("maps each command to the ActionItem id/label/hint shape", async () => {
    vi.mocked(commands.listPlugins).mockResolvedValueOnce(
      ok([plugin({ id: "acme", name: "Acme Tools", commands: [{ id: "greet", label: "Greet", run: "echo hi", placement: "palette" }] })]),
    );

    await pluginCommandsCtrl.ensureLoaded();

    expect(pluginCommandsCtrl.actions[0]).toMatchObject({
      type: "action",
      id: "plugin:acme:greet",
      label: "Greet",
      hint: "Plugin · Acme Tools",
    });
    expect(typeof pluginCommandsCtrl.actions[0].run).toBe("function");
  });

  it("is cached — a second ensureLoaded does not re-hit the backend", async () => {
    vi.mocked(commands.listPlugins).mockResolvedValueOnce(ok([]));

    await pluginCommandsCtrl.ensureLoaded();
    await pluginCommandsCtrl.ensureLoaded();

    expect(commands.listPlugins).toHaveBeenCalledTimes(1);
  });

  it("a backend error leaves the palette actions empty without throwing", async () => {
    vi.mocked(commands.listPlugins).mockResolvedValueOnce(err("registry unreadable"));

    await pluginCommandsCtrl.ensureLoaded();

    expect(pluginCommandsCtrl.actions).toEqual([]);
  });
});

describe("reload — force path notifies the palette", () => {
  it("rebuilds actions and fires onActionsChanged", async () => {
    const spy = vi.fn();
    pluginCommandsCtrl.onActionsChanged = spy;
    vi.mocked(commands.listPlugins).mockResolvedValueOnce(
      ok([plugin({ id: "acme", name: "Acme", commands: [{ id: "greet", label: "Greet", run: "echo", placement: "palette" }] })]),
    );

    await pluginCommandsCtrl.reload();

    expect(pluginCommandsCtrl.actions.map((a) => a.id)).toEqual(["plugin:acme:greet"]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("invoke — declarative backend call", () => {
  it("sends the open repo and calls runPluginCommand", async () => {
    vi.mocked(commands.runPluginCommand).mockResolvedValueOnce(ok(output({ stdout: "done", success: true })));

    await pluginCommandsCtrl.invoke("acme", "greet", "none");

    expect(commands.runPluginCommand).toHaveBeenCalledWith(
      "acme",
      "greet",
      expect.objectContaining({ repo: "/repo", sha: null }),
    );
    expect(bridge.tama.say).toHaveBeenCalled();
    expect(bridge.tama.warn).not.toHaveBeenCalled();
  });

  it("for a `commit` context, gathers the selected commit's sha from the bridge", async () => {
    (bridge.state as unknown as { selectedRow: number }).selectedRow = 1;
    (bridge.BACKEND as unknown as { rows: Array<{ sha: string }> }).rows = [{ sha: "aaaa111" }, { sha: "deadbeef" }];
    vi.mocked(commands.runPluginCommand).mockResolvedValueOnce(ok(output({ stdout: "ok", success: true })));

    await pluginCommandsCtrl.invoke("acme", "onCommit", "commit");

    expect(commands.runPluginCommand).toHaveBeenCalledWith(
      "acme",
      "onCommit",
      expect.objectContaining({ repo: "/repo", sha: "deadbeef" }),
    );
  });

  it("a `commit` context with nothing selected still sends repo (sha null)", async () => {
    (bridge.state as unknown as { selectedRow: number }).selectedRow = -1;
    vi.mocked(commands.runPluginCommand).mockResolvedValueOnce(ok(output({ stdout: "ok", success: true })));

    await pluginCommandsCtrl.invoke("acme", "onCommit", "commit");

    expect(commands.runPluginCommand).toHaveBeenCalledWith(
      "acme",
      "onCommit",
      expect.objectContaining({ repo: "/repo", sha: null }),
    );
  });

  it("a non-zero exit (success:false) warns via Tama", async () => {
    vi.mocked(commands.runPluginCommand).mockResolvedValueOnce(ok(output({ stdout: "boom", exitCode: 2, success: false })));

    await pluginCommandsCtrl.invoke("acme", "greet", "none");

    expect(bridge.tama.warn).toHaveBeenCalled();
    expect(bridge.tama.say).not.toHaveBeenCalled();
  });

  it("an IPC error warns via Tama", async () => {
    vi.mocked(commands.runPluginCommand).mockResolvedValueOnce(err("no such command"));

    await pluginCommandsCtrl.invoke("acme", "greet", "none");

    expect(bridge.tama.warn).toHaveBeenCalled();
  });

  it("a thrown IPC rejection warns via Tama without escaping", async () => {
    vi.mocked(commands.runPluginCommand).mockRejectedValueOnce(new Error("boom"));

    await pluginCommandsCtrl.invoke("acme", "greet", "none");

    expect(bridge.tama.warn).toHaveBeenCalled();
  });
});

describe("parseTamaReaction — pure directive parsing (PER-46)", () => {
  it("maps each SAFE reaction token to its Tama state", () => {
    expect(parseTamaReaction("::gitcat.tama info heads up")).toEqual({ state: "hint", message: "heads up" });
    expect(parseTamaReaction("::gitcat.tama busy crunching")).toEqual({ state: "thinking", message: "crunching" });
    expect(parseTamaReaction("::gitcat.tama ok all green")).toEqual({ state: "celebrate", message: "all green" });
    expect(parseTamaReaction("::gitcat.tama problem it broke")).toEqual({ state: "confused", message: "it broke" });
  });

  it("returns null when there is no directive at all", () => {
    expect(parseTamaReaction("just some normal output\nmore lines")).toBeNull();
    expect(parseTamaReaction("")).toBeNull();
  });

  it("IGNORES any reaction NOT on the safe allowlist — no safety-critical pose is reachable", () => {
    // danger / warn / rescue / undo all mean GitCat ITSELF flagged something —
    // a plugin must never be able to reach them.
    expect(parseTamaReaction("::gitcat.tama danger you are doomed")).toBeNull();
    expect(parseTamaReaction("::gitcat.tama warn rewriting history")).toBeNull();
    expect(parseTamaReaction("::gitcat.tama rescue detached")).toBeNull();
    expect(parseTamaReaction("::gitcat.tama undo rewound")).toBeNull();
    expect(parseTamaReaction("::gitcat.tama alarm boom")).toBeNull();
    expect(parseTamaReaction("::gitcat.tama gibberish whatever")).toBeNull();
  });

  it("rejects inherited Object.prototype keys (own-property check, not truthiness)", () => {
    // A plain-object lookup would resolve these to truthy prototype functions
    // and slip past the allowlist — the own-property gate rejects them.
    for (const k of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      expect(parseTamaReaction(`::gitcat.tama ${k} sneaky`)).toBeNull();
    }
  });

  it("LAST valid directive wins", () => {
    const out = "::gitcat.tama info first\n::gitcat.tama ok second";
    expect(parseTamaReaction(out)).toEqual({ state: "celebrate", message: "second" });
  });

  it("a later IGNORED (unsafe) directive can NOT override an earlier valid one", () => {
    const out = "::gitcat.tama ok worked\n::gitcat.tama danger spoofed";
    expect(parseTamaReaction(out)).toEqual({ state: "celebrate", message: "worked" });
  });

  it("caps the message to ~160 chars", () => {
    const long = "x".repeat(500);
    const r = parseTamaReaction("::gitcat.tama info " + long);
    expect(r).not.toBeNull();
    expect(r!.message.length).toBeLessThanOrEqual(160);
    expect(r!.message.endsWith("…")).toBe(true);
  });

  it("finds a directive on any line and tolerates leading whitespace + CRLF", () => {
    const out = "build log line 1\r\nbuild log line 2\r\n   ::gitcat.tama ok done\r\n";
    expect(parseTamaReaction(out)).toEqual({ state: "celebrate", message: "done" });
  });
});

describe("invoke — plugin → Tama reaction protocol (PER-46)", () => {
  it("a valid directive drives set(state) + say(message) instead of the default say", async () => {
    vi.mocked(commands.runPluginCommand).mockResolvedValueOnce(
      ok(output({ stdout: "::gitcat.tama ok build passed", success: true })),
    );

    await pluginCommandsCtrl.invoke("acme", "build", "none");

    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
    expect(bridge.tama.say).toHaveBeenCalledWith("build passed");
  });

  it.each([
    ["info", "hint"],
    ["busy", "thinking"],
    ["ok", "celebrate"],
    ["problem", "confused"],
  ])("reaction %s maps to state %s", async (reaction, state) => {
    vi.mocked(commands.runPluginCommand).mockResolvedValueOnce(
      ok(output({ stdout: `::gitcat.tama ${reaction} hello`, success: true })),
    );

    await pluginCommandsCtrl.invoke("acme", "cmd", "none");

    expect(bridge.tama.set).toHaveBeenCalledWith(state);
    expect(bridge.tama.say).toHaveBeenCalledWith("hello");
  });

  it("a `danger` reaction is IGNORED — no unsafe state, falls back to the default say", async () => {
    vi.mocked(commands.runPluginCommand).mockResolvedValueOnce(
      ok(output({ stdout: "real work here\n::gitcat.tama danger you are doomed", success: true })),
    );

    await pluginCommandsCtrl.invoke("acme", "cmd", "none");

    // No spoofed state reached, and the danger directive text is NOT shown.
    expect(bridge.tama.set).not.toHaveBeenCalledWith("danger");
    expect(bridge.tama.set).not.toHaveBeenCalledWith("warn");
    expect(bridge.tama.say).toHaveBeenCalledWith("real work here");
  });

  it("an `undo`/garbage reaction is IGNORED — falls back to default", async () => {
    vi.mocked(commands.runPluginCommand).mockResolvedValueOnce(
      ok(output({ stdout: "::gitcat.tama undo rewound everything", success: true })),
    );

    await pluginCommandsCtrl.invoke("acme", "cmd", "none");

    // Only the directive line existed; stripped → generic fallback, no set().
    expect(bridge.tama.set).not.toHaveBeenCalled();
    expect(bridge.tama.say).toHaveBeenCalledWith("Plugin command finished.");
  });

  it("strips the directive line from the shown text (valid directive shows its message only)", async () => {
    vi.mocked(commands.runPluginCommand).mockResolvedValueOnce(
      ok(output({ stdout: "chatter\n::gitcat.tama info the point\nmore chatter", success: true })),
    );

    await pluginCommandsCtrl.invoke("acme", "cmd", "none");

    expect(bridge.tama.say).toHaveBeenCalledWith("the point");
    const said = vi.mocked(bridge.tama.say).mock.calls.map((c) => c[0]).join("|");
    expect(said).not.toContain("::gitcat.tama");
  });

  it("caps the directive message shown via say", async () => {
    const long = "y".repeat(500);
    vi.mocked(commands.runPluginCommand).mockResolvedValueOnce(
      ok(output({ stdout: "::gitcat.tama info " + long, success: true })),
    );

    await pluginCommandsCtrl.invoke("acme", "cmd", "none");

    const said = String(vi.mocked(bridge.tama.say).mock.calls[0][0]);
    expect(said.length).toBeLessThanOrEqual(160);
  });

  it("last valid directive wins through invoke", async () => {
    vi.mocked(commands.runPluginCommand).mockResolvedValueOnce(
      ok(output({ stdout: "::gitcat.tama busy step 1\n::gitcat.tama ok step 2 done", success: true })),
    );

    await pluginCommandsCtrl.invoke("acme", "cmd", "none");

    expect(bridge.tama.set).toHaveBeenCalledTimes(1);
    expect(bridge.tama.set).toHaveBeenCalledWith("celebrate");
    expect(bridge.tama.say).toHaveBeenCalledWith("step 2 done");
  });

  it("no directive present → behavior is unchanged (plain say on success)", async () => {
    vi.mocked(commands.runPluginCommand).mockResolvedValueOnce(ok(output({ stdout: "plain result", success: true })));

    await pluginCommandsCtrl.invoke("acme", "cmd", "none");

    expect(bridge.tama.set).not.toHaveBeenCalled();
    expect(bridge.tama.say).toHaveBeenCalledWith("plain result");
    expect(bridge.tama.warn).not.toHaveBeenCalled();
  });

  it("no directive present → failure still warns (unchanged)", async () => {
    vi.mocked(commands.runPluginCommand).mockResolvedValueOnce(
      ok(output({ stdout: "it failed", exitCode: 1, success: false })),
    );

    await pluginCommandsCtrl.invoke("acme", "cmd", "none");

    expect(bridge.tama.warn).toHaveBeenCalledWith("it failed");
    expect(bridge.tama.set).not.toHaveBeenCalled();
  });
});

describe("invoke — missing repo", () => {
  it("warns and does NOT call runPluginCommand when no repo is open", async () => {
    vi.resetModules();
    vi.doMock("../../legacy/bridge", () => ({
      CUR_REPO: null,
      tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
      state: { selectedRow: -1 },
      BACKEND: { rows: [] },
    }));
    const bridgeNull = await import("../../legacy/bridge");
    const bindingsNull = await import("../../ipc/bindings");
    const { pluginCommandsCtrl: ctrl } = await import("./plugincommands.svelte.ts");

    await ctrl.invoke("acme", "greet", "none");

    expect(bridgeNull.tama.warn).toHaveBeenCalled();
    expect(bindingsNull.commands.runPluginCommand).not.toHaveBeenCalled();
  });
});

describe("invoke — the `file` context fills {file} (#76)", () => {
  // A `file` command placed in the MENU, not the palette: build() drops it from
  // the action list, but a panel button can still name it, so the context index
  // has to carry it. That is what the "ids only" test below leans on.
  const acme = plugin({
    id: "acme",
    name: "Acme",
    commands: [
      { id: "lint", label: "Lint this file", run: "lint {file}", handler: null, context: "file", placement: "palette", mutates: false },
      { id: "count", label: "Count lines", run: "wc -l {file}", handler: null, context: "file", placement: "menu", mutates: false },
    ],
  });

  it("sends the file the detail island has selected", async () => {
    detailCtrl.selectedFile = "src/legacy/main.ts";
    vi.mocked(commands.runPluginCommand).mockResolvedValueOnce(ok(output({ stdout: "clean", success: true })));

    await pluginCommandsCtrl.invoke("acme", "lint", "file");

    expect(commands.runPluginCommand).toHaveBeenCalledWith(
      "acme",
      "lint",
      expect.objectContaining({ repo: "/repo", file: "src/legacy/main.ts" }),
    );
  });

  it("REFUSES to run when no file is selected, rather than expanding {file} to nothing", async () => {
    // The behaviour this whole guard exists for: an unfilled token expands to
    // the empty string, so `rm -rf {repo}/{file}` would become `rm -rf /repo/`.
    detailCtrl.selectedFile = null;

    await pluginCommandsCtrl.invoke("acme", "lint", "file");

    expect(commands.runPluginCommand).not.toHaveBeenCalled();
    expect(bridge.tama.warn).toHaveBeenCalled();
  });

  it("resolves the context from the manifest when the caller has only ids (panel buttons)", async () => {
    // pluginpanels' runButton knows a plugin id and a command id and nothing
    // else. Without the index it would fall through to "none" and send no file.
    vi.mocked(commands.listPlugins).mockResolvedValueOnce(ok([acme]));
    await pluginCommandsCtrl.ensureLoaded();
    detailCtrl.selectedFile = "README.md";
    vi.mocked(commands.runPluginCommand).mockResolvedValueOnce(ok(output({ stdout: "12", success: true })));

    await pluginCommandsCtrl.invoke("acme", "count");

    expect(commands.runPluginCommand).toHaveBeenCalledWith(
      "acme",
      "count",
      expect.objectContaining({ file: "README.md" }),
    );
  });

  it("a disabled plugin's commands are not in the context index", async () => {
    vi.mocked(commands.listPlugins).mockResolvedValueOnce(ok([plugin({ ...acme, enabled: false })]));
    await pluginCommandsCtrl.ensureLoaded();
    detailCtrl.selectedFile = "README.md";
    vi.mocked(commands.runPluginCommand).mockResolvedValueOnce(ok(output({ stdout: "", success: true })));

    // Falls back to "none": no file is gathered, and nothing is refused either.
    await pluginCommandsCtrl.invoke("acme", "count");

    expect(commands.runPluginCommand).toHaveBeenCalledWith("acme", "count", expect.objectContaining({ file: null }));
  });

  it("leaves the `commit` context's existing permissiveness alone", async () => {
    // Deliberately NOT symmetrical with `file`: {sha} has shipped, and plugins
    // may already rely on running without a selection. Changing that belongs in
    // its own change, not smuggled in with a new token.
    (bridge.state as unknown as { selectedRow: number }).selectedRow = -1;
    vi.mocked(commands.runPluginCommand).mockResolvedValueOnce(ok(output({ stdout: "ok", success: true })));

    await pluginCommandsCtrl.invoke("acme", "onCommit", "commit");

    expect(commands.runPluginCommand).toHaveBeenCalledWith("acme", "onCommit", expect.objectContaining({ sha: null }));
  });
});
