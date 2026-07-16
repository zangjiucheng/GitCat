// Tests for the shared copy-to-clipboard + confirmation-tick helper (see
// its own header for why the tick is gated on the clipboard write actually
// succeeding). Same isolation strategy as sound.test.ts: this leaf module
// transitively imports settings.svelte.ts (via sound.ts), which imports
// legacy/bridge/ipc/bindings/ipc/env purely to expose them to ITS OWN
// callers — mocked here for the same reason every other test in this
// codebase mocks legacy/bridge.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bridge", () => ({
  applyThemeMode: vi.fn(),
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
}));

vi.mock("../ipc/bindings", () => ({
  commands: { getGitIdentity: vi.fn(), setGitIdentity: vi.fn() },
}));

vi.mock("../ipc/env", () => ({ IN_TAURI: false }));

// vi.mock() factories are hoisted above regular imports/consts — vi.hoisted()
// is the supported way to define a mock fn the factory can reference safely.
const { playTamaSound } = vi.hoisted(() => ({ playTamaSound: vi.fn() }));
vi.mock("./sound.ts", () => ({ playTamaSound }));

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

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  playTamaSound.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyToClipboard", () => {
  it("writes the given text to the clipboard and plays the copy tick once the write succeeds", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { copyToClipboard } = await import("./clipboard.ts");

    copyToClipboard("feat/inline-diff");
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith("feat/inline-diff");
    expect(playTamaSound).toHaveBeenCalledWith("copy");
  });

  it("does NOT play the tick when the clipboard write rejects — a failed copy stays silent rather than confirming a false success", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { copyToClipboard } = await import("./clipboard.ts");

    copyToClipboard("abc1234");
    await Promise.resolve();
    await Promise.resolve();

    expect(playTamaSound).not.toHaveBeenCalled();
  });

  it("does nothing (and never throws) when navigator.clipboard doesn't exist", async () => {
    vi.stubGlobal("navigator", {});
    const { copyToClipboard } = await import("./clipboard.ts");

    expect(() => copyToClipboard("x")).not.toThrow();
    await Promise.resolve();

    expect(playTamaSound).not.toHaveBeenCalled();
  });
});
