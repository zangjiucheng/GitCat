// Tests for the plugin lifecycle-hooks controller (PER-43). bridge / bindings /
// env / parseTamaReaction are mocked so nothing real boots; the Tama-bus
// subscriber is captured so we can drive events synchronously.
import { beforeEach, describe, expect, it, vi } from "vitest";

let busSubscriber: ((name: string, payload?: unknown) => void) | null = null;
let mockCurRepo: string | null = "/repo";
const tamaSet = vi.fn();
const tamaSay = vi.fn();

vi.mock("../../legacy/bridge", () => ({
  tamaBus: {
    subscribe: (fn: (name: string, payload?: unknown) => void) => {
      busSubscriber = fn;
      return () => {};
    },
  },
  get CUR_REPO() {
    return mockCurRepo;
  },
  tama: { set: (...a: unknown[]) => tamaSet(...a), say: (...a: unknown[]) => tamaSay(...a) },
}));

let mockInTauri = true;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));

const runHooks = vi.fn();
vi.mock("../../ipc/bindings", () => ({ commands: { runHooks: (...a: unknown[]) => runHooks(...a) } }));

const parseTamaReaction = vi.fn();
vi.mock("../plugincommands/plugincommands.svelte.ts", () => ({
  parseTamaReaction: (...a: unknown[]) => parseTamaReaction(...a),
}));

import { pluginHooksCtrl } from "./pluginhooks.svelte.ts";

function ok<T>(data: T) {
  return { status: "ok", data } as const;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  // Reset the singleton's private state between tests (runtime cast — TS private
  // is compile-time only).
  (pluginHooksCtrl as unknown as { started: boolean }).started = false;
  (pluginHooksCtrl as unknown as { lastRepo: string | null }).lastRepo = null;
  busSubscriber = null;
  mockCurRepo = "/repo";
  mockInTauri = true;
  vi.clearAllMocks();
  runHooks.mockResolvedValue(ok([]));
  parseTamaReaction.mockReturnValue(null);
});

describe("start — Tama-bus subscription", () => {
  it("subscribes once and maps a mapped bus event to its hook event", () => {
    pluginHooksCtrl.start();
    expect(busSubscriber).toBeTypeOf("function");
    busSubscriber!("commit.created");
    expect(runHooks).toHaveBeenCalledWith("commit-created", expect.objectContaining({ repo: "/repo" }));
  });

  it("maps undo + mutation events; ignores unmapped ones", () => {
    pluginHooksCtrl.start();
    busSubscriber!("undo.performed");
    busSubscriber!("mutation.destructive");
    busSubscriber!("mutation.caution");
    busSubscriber!("idle"); // not a hook event
    busSubscriber!("snapshot.surfaced"); // not a hook event
    const events = runHooks.mock.calls.map((c) => c[0]);
    expect(events).toEqual(["undo", "pre-mutation", "pre-mutation"]);
  });

  it("is a no-op in design mode (!IN_TAURI) — never subscribes", () => {
    mockInTauri = false;
    pluginHooksCtrl.start();
    expect(busSubscriber).toBeNull();
  });

  it("skips firing when no repo is open", () => {
    mockCurRepo = null;
    pluginHooksCtrl.start();
    busSubscriber!("commit.created");
    expect(runHooks).not.toHaveBeenCalled();
  });
});

describe("onRepoOpened — repo-opened / repo-switched", () => {
  it("fires repo-opened on first open, and repo-switched only when the repo changed", () => {
    pluginHooksCtrl.onRepoOpened("/a");
    expect(runHooks.mock.calls.map((c) => c[0])).toEqual(["repo-opened"]);
    expect(runHooks).toHaveBeenCalledWith("repo-opened", expect.objectContaining({ repo: "/a" }));

    vi.clearAllMocks();
    pluginHooksCtrl.onRepoOpened("/b"); // different repo → opened + switched
    expect(runHooks.mock.calls.map((c) => c[0])).toEqual(["repo-opened", "repo-switched"]);

    vi.clearAllMocks();
    pluginHooksCtrl.onRepoOpened("/b"); // same repo → opened only
    expect(runHooks.mock.calls.map((c) => c[0])).toEqual(["repo-opened"]);
  });

  it("is a no-op with no path or in design mode", () => {
    pluginHooksCtrl.onRepoOpened("");
    mockInTauri = false;
    pluginHooksCtrl.onRepoOpened("/a");
    expect(runHooks).not.toHaveBeenCalled();
  });
});

describe("hook output → safe Tama reaction", () => {
  it("drives a Tama reaction when a hook's stdout carries a valid directive", async () => {
    runHooks.mockResolvedValue(
      ok([{ pluginId: "p", event: "commit-created", output: { stdout: "::gitcat.tama ok done", exitCode: 0, success: true } }]),
    );
    parseTamaReaction.mockReturnValue({ state: "celebrate", message: "done" });
    pluginHooksCtrl.start();
    busSubscriber!("commit.created");
    await flush();
    expect(tamaSet).toHaveBeenCalledWith("celebrate");
    expect(tamaSay).toHaveBeenCalledWith("done");
  });

  it("does not react when the hook output has no directive", async () => {
    runHooks.mockResolvedValue(ok([{ pluginId: "p", event: "undo", output: { stdout: "plain", exitCode: 0, success: true } }]));
    parseTamaReaction.mockReturnValue(null);
    pluginHooksCtrl.start();
    busSubscriber!("undo.performed");
    await flush();
    expect(tamaSet).not.toHaveBeenCalled();
  });

  it("a runHooks error or rejection never throws or reacts", async () => {
    runHooks.mockResolvedValueOnce({ status: "error", error: "boom" });
    pluginHooksCtrl.start();
    busSubscriber!("commit.created");
    await flush();
    expect(tamaSet).not.toHaveBeenCalled();

    runHooks.mockRejectedValueOnce(new Error("nope"));
    busSubscriber!("commit.created");
    await flush();
    expect(tamaSet).not.toHaveBeenCalled();
  });
});
