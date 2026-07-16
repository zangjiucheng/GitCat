// Tests for the setup wizard controller — currently focused on skip()'s
// "don't throw away an already-validated repo" fix (see its own doc comment
// in setupwizard.svelte.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";

// The test environment's bare `localStorage` is a broken all-undefined stub
// (see settings.svelte.test.ts's own comment on this) — stub a real in-memory
// implementation so markDismissed()/hasBeenDismissed() don't throw.
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
  TAMA_IMG: { hero: "hero.png", thinking: "thinking.png" },
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn() },
  openRepo: vi.fn(async () => true),
}));

vi.mock("../../ipc/bindings", () => ({
  commands: {
    getGitIdentity: vi.fn(),
    setGitIdentity: vi.fn(),
  },
}));

import * as bridge from "../../legacy/bridge";
import { commands } from "../../ipc/bindings";
import { setupWizardCtrl } from "./setupwizard.svelte.ts";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", memoryStorage());
  setupWizardCtrl.start();
});

async function pickAndValidate(identity: { name: string | null; email: string | null; configured: boolean; local: boolean }) {
  vi.mocked(commands.getGitIdentity).mockResolvedValueOnce({ status: "ok", data: identity });
  setupWizardCtrl.toPick();
  (setupWizardCtrl as any).repoPath = "/repo/picked";
  await (setupWizardCtrl as any).validate();
}

describe("skip", () => {
  it("opens an already-validated repo instead of discarding it (configured identity -> done step)", async () => {
    await pickAndValidate({ name: "a", email: "a@b.c", configured: true, local: true });
    expect(setupWizardCtrl.step).toBe("done");

    await setupWizardCtrl.skip();

    expect(bridge.openRepo).toHaveBeenCalledWith("/repo/picked");
    expect(setupWizardCtrl.open).toBe(false);
    expect(setupWizardCtrl.repoPath).toBeNull();
  });

  it("opens an already-validated repo when skipping FROM the identity step (unconfigured identity)", async () => {
    await pickAndValidate({ name: null, email: null, configured: false, local: false });
    expect(setupWizardCtrl.step).toBe("identity");

    await setupWizardCtrl.skip();

    expect(bridge.openRepo).toHaveBeenCalledWith("/repo/picked");
  });

  it("does not call openRepo when skipping before ever validating a repo", async () => {
    setupWizardCtrl.toPick();

    await setupWizardCtrl.skip();

    expect(bridge.openRepo).not.toHaveBeenCalled();
    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("No rush"), expect.any(Number));
  });

  it("falls back to the 'open anytime' toast when openRepo fails", async () => {
    await pickAndValidate({ name: "a", email: "a@b.c", configured: true, local: true });
    vi.mocked(bridge.openRepo).mockResolvedValueOnce(false);

    await setupWizardCtrl.skip();

    expect(bridge.tama.say).toHaveBeenCalledWith(expect.stringContaining("No rush"), expect.any(Number));
  });

  it("demo mode never calls the real openRepo, even with a validated repo", async () => {
    setupWizardCtrl.openDemo();
    setupWizardCtrl.toPick();
    (setupWizardCtrl as any).repoPath = "/home/demo/my-project";
    await (setupWizardCtrl as any).validate();

    await setupWizardCtrl.skip();

    expect(bridge.openRepo).not.toHaveBeenCalled();
  });

  it("does nothing while busy (re-entrancy guard)", async () => {
    setupWizardCtrl.busy = true;

    await setupWizardCtrl.skip();

    expect(bridge.openRepo).not.toHaveBeenCalled();
    expect(setupWizardCtrl.open).toBe(true);
  });
});
