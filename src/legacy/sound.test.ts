// Tests for Tama's synthesized sound effects (see sound.ts's own header for
// why this is a leaf module safe to import directly, unlike legacy/main.ts).
//
// No real Web Audio output is ever asserted — only that playTamaSound is
// correctly gated by the Settings toggle and, when it does proceed, that it
// drives a real AudioContext (oscillator/gain nodes created, start/stop
// called) without throwing, via a minimal hand-rolled fake rather than a
// real AudioContext (unavailable in jsdom).
//
// sound.ts itself only calls loadSettings() — but that lives in
// settings.svelte.ts, which ALSO imports legacy/bridge (and ipc/bindings) at
// module scope purely to expose them to its OWN callers; loading that module
// for real would transitively boot legacy/main.ts (a whole vanilla app that
// assumes a live #cv canvas), so these get mocked here for the same
// isolation reason every other island's test file mocks legacy/bridge.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bridge", () => ({
  applyThemeMode: vi.fn(),
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
}));

vi.mock("../ipc/bindings", () => ({
  commands: { getGitIdentity: vi.fn(), setGitIdentity: vi.fn() },
}));

vi.mock("../ipc/env", () => ({ IN_TAURI: false }));

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

class FakeParam {
  value = 0;
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
}

class FakeOscillator {
  type = "sine";
  frequency = new FakeParam();
  connect = vi.fn(() => this);
  start = vi.fn();
  stop = vi.fn();
}

class FakeGain {
  gain = new FakeParam();
  connect = vi.fn(() => this);
}

class FakeAudioContext {
  state = "running";
  currentTime = 0;
  destination = {};
  resume = vi.fn().mockResolvedValue(undefined);
  createOscillator = vi.fn(() => new FakeOscillator());
  createGain = vi.fn(() => new FakeGain());
}

let ctxInstances: FakeAudioContext[] = [];

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  ctxInstances = [];
  // A plain `function`, not an arrow — arrow functions can't be used with
  // `new`, and sound.ts's getContext() does `new Ctor()`.
  vi.stubGlobal(
    "AudioContext",
    vi.fn(function () {
      const c = new FakeAudioContext();
      ctxInstances.push(c);
      return c;
    }),
  );
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("playTamaSound", () => {
  it("does nothing when sound effects are disabled in settings", async () => {
    localStorage.setItem("gitcat.settings", JSON.stringify({ soundEffectsEnabled: false }));
    const { playTamaSound } = await import("./sound.ts");

    playTamaSound("hint");

    expect(ctxInstances).toHaveLength(0);
  });

  it("plays via a lazily-created AudioContext when sound effects are enabled (the default)", async () => {
    const { playTamaSound } = await import("./sound.ts");

    playTamaSound("hint");

    expect(ctxInstances).toHaveLength(1);
    expect(ctxInstances[0].createOscillator).toHaveBeenCalled();
    expect(ctxInstances[0].createGain).toHaveBeenCalled();
  });

  it("reuses the same AudioContext across multiple calls instead of creating a new one each time", async () => {
    const { playTamaSound } = await import("./sound.ts");

    playTamaSound("hint");
    playTamaSound("warn");
    playTamaSound("danger");
    playTamaSound("celebrate");

    expect(ctxInstances).toHaveLength(1);
  });

  it("resumes a suspended context before playing", async () => {
    vi.stubGlobal(
      "AudioContext",
      vi.fn(function () {
        const c = new FakeAudioContext();
        c.state = "suspended";
        ctxInstances.push(c);
        return c;
      }),
    );
    const { playTamaSound } = await import("./sound.ts");

    playTamaSound("warn");

    expect(ctxInstances[0].resume).toHaveBeenCalled();
  });

  it("silently no-ops when no AudioContext constructor exists in this environment", async () => {
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);
    const { playTamaSound } = await import("./sound.ts");

    expect(() => playTamaSound("celebrate")).not.toThrow();
  });

  it("never throws even if the underlying synthesis itself fails", async () => {
    vi.stubGlobal(
      "AudioContext",
      vi.fn(function () {
        const c = new FakeAudioContext();
        c.createOscillator = vi.fn(() => {
          throw new Error("boom");
        });
        ctxInstances.push(c);
        return c;
      }),
    );
    const { playTamaSound } = await import("./sound.ts");

    expect(() => playTamaSound("danger")).not.toThrow();
  });
});

describe("STATE_SOUND", () => {
  it("maps the significant FSM states to a sound kind, and leaves the noisy/frequent states unmapped", async () => {
    const { STATE_SOUND } = await import("./sound.ts");

    expect(STATE_SOUND.danger).toBe("danger");
    expect(STATE_SOUND.celebrate).toBe("celebrate");
    expect(STATE_SOUND.warn).toBe("warn");
    expect(STATE_SOUND.idle).toBeUndefined();
    expect(STATE_SOUND.sleep).toBeUndefined();
    expect(STATE_SOUND.syncing).toBeUndefined();
  });
});
