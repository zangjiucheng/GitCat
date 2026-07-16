// Tests for Tama's synthesized sound effects (see sound.ts's own header for
// why this is a leaf module safe to import directly, unlike legacy/main.ts).
//
// No real Web Audio output is ever asserted — only that playTamaSound is
// correctly gated by the Settings toggle/volume and, when it does proceed,
// that it drives a real AudioContext (oscillator/gain nodes created, start/
// stop called) without throwing, via a minimal hand-rolled fake rather than
// a real AudioContext (unavailable in jsdom).
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
  detune = new FakeParam();
  onended: (() => void) | null = null;
  connect = vi.fn(() => this);
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeGain {
  gain = new FakeParam();
  connect = vi.fn(() => this);
  disconnect = vi.fn();
}

class FakeAudioContext {
  state = "running";
  currentTime = 0;
  destination = {};
  resume = vi.fn().mockResolvedValue(undefined);
  createOscillator = vi.fn(() => {
    const o = new FakeOscillator();
    oscInstances.push(o);
    return o;
  });
  createGain = vi.fn(() => {
    const g = new FakeGain();
    gainInstances.push(g);
    return g;
  });
}

let ctxInstances: FakeAudioContext[] = [];
let oscInstances: FakeOscillator[] = [];
let gainInstances: FakeGain[] = [];
// playTamaSound's replay cooldown is timestamped with performance.now()
// (real wall-clock milliseconds), not the fake AudioContext's own
// currentTime — so tests control simulated elapsed time by advancing this
// mocked clock, not ctxInstances[0].currentTime.
let perfNow = 0;

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  ctxInstances = [];
  oscInstances = [];
  gainInstances = [];
  perfNow = 0;
  vi.spyOn(performance, "now").mockImplementation(() => perfNow);
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

  it("reuses the same AudioContext across multiple (distinct-kind) calls instead of creating a new one each time", async () => {
    const { playTamaSound } = await import("./sound.ts");

    playTamaSound("hint");
    playTamaSound("warn");
    playTamaSound("danger");
    playTamaSound("celebrate");
    playTamaSound("greeting");
    playTamaSound("copy");

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

  it("cleans up each oscillator/gain pair via onended instead of leaking nodes on repeated plays", async () => {
    const { playTamaSound } = await import("./sound.ts");

    playTamaSound("copy");

    expect(oscInstances.length).toBeGreaterThan(0);
    for (const osc of oscInstances) {
      expect(osc.onended).toBeTypeOf("function");
      osc.onended!();
      expect(osc.disconnect).toHaveBeenCalled();
    }
  });

  // ── master-gain volume scaling ───────────────────────────────────────────
  describe("volume", () => {
    it("applies the Settings volume to the shared master GainNode, read fresh on every play", async () => {
      localStorage.setItem("gitcat.settings", JSON.stringify({ soundEffectsVolume: 0.3 }));
      const { playTamaSound } = await import("./sound.ts");

      playTamaSound("hint");

      // getMaster() creates the master gain FIRST, before any per-tone gain
      // — gainInstances[0] is always the master across this module's
      // lifetime (getMaster caches it, so it's never recreated on
      // subsequent plays within the same test).
      expect(gainInstances[0].gain.value).toBeCloseTo(0.3);
    });

    it("re-reads the volume on every play, so a mid-session change takes effect immediately", async () => {
      localStorage.setItem("gitcat.settings", JSON.stringify({ soundEffectsVolume: 0.2 }));
      const { playTamaSound } = await import("./sound.ts");

      playTamaSound("hint");
      expect(gainInstances[0].gain.value).toBeCloseTo(0.2);

      // Past the per-kind replay cooldown — otherwise this second "hint"
      // play would itself be suppressed as a same-kind repeat, and the
      // volume re-read never gets exercised.
      perfNow += 1000;
      localStorage.setItem("gitcat.settings", JSON.stringify({ soundEffectsVolume: 0.9 }));
      playTamaSound("hint");
      expect(gainInstances[0].gain.value).toBeCloseTo(0.9);
    });

    it("defaults to 1 (unattenuated — no behavior change for existing users) when nothing has been saved yet", async () => {
      const { playTamaSound } = await import("./sound.ts");

      playTamaSound("hint");

      expect(gainInstances[0].gain.value).toBeCloseTo(1);
    });

    it("sanitizes a corrupted/out-of-range persisted volume instead of assigning it straight to the AudioParam", async () => {
      // A non-finite value assigned directly to a real GainNode's .value
      // throws (WebIDL float coercion) — loadSettings() itself is
      // responsible for never letting this through; see its own test in
      // settings.svelte.test.ts for the read-boundary clamp this exercises.
      localStorage.setItem("gitcat.settings", JSON.stringify({ soundEffectsVolume: "loud" }));
      const { playTamaSound } = await import("./sound.ts");

      expect(() => playTamaSound("hint")).not.toThrow();
      expect(gainInstances[0].gain.value).toBeCloseTo(1);
    });
  });

  // ── per-kind replay cooldown ─────────────────────────────────────────────
  describe("replay cooldown", () => {
    it("suppresses an immediate repeat of the SAME kind (no simulated time elapsed)", async () => {
      const { playTamaSound } = await import("./sound.ts");

      playTamaSound("copy");
      const afterFirst = oscInstances.length;
      playTamaSound("copy"); // mocked performance.now() never advances — simulates a near-instant double-fire

      expect(oscInstances.length).toBe(afterFirst);
    });

    it("plays again once the cooldown window has elapsed", async () => {
      const { playTamaSound } = await import("./sound.ts");

      playTamaSound("copy");
      const afterFirst = oscInstances.length;
      perfNow += 1000; // well past the 45ms cooldown
      playTamaSound("copy");

      expect(oscInstances.length).toBeGreaterThan(afterFirst);
    });

    it("does not suppress a DIFFERENT kind — the cooldown is tracked per kind", async () => {
      const { playTamaSound } = await import("./sound.ts");

      playTamaSound("copy");
      const afterFirst = oscInstances.length;
      playTamaSound("hint"); // different kind, same (unsimulated) instant

      expect(oscInstances.length).toBeGreaterThan(afterFirst);
    });

    it("bypassCooldown always plays regardless of a just-played same-kind sound (Settings' own Test button)", async () => {
      const { playTamaSound } = await import("./sound.ts");

      playTamaSound("celebrate");
      const afterFirst = oscInstances.length;
      playTamaSound("celebrate", { bypassCooldown: true }); // no simulated time elapsed — would normally be suppressed

      expect(oscInstances.length).toBeGreaterThan(afterFirst);
    });

    it("does not record a cooldown timestamp when synthesis itself throws, so a failed play never blocks the next real one", async () => {
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

      playTamaSound("warn"); // throws internally, caught, no-ops

      // Restore a working oscillator factory on the SAME cached context,
      // then replay the same kind with no simulated time elapsed — if the
      // failed attempt above had recorded a cooldown timestamp, this would
      // be suppressed too.
      ctxInstances[0].createOscillator = vi.fn(() => {
        const o = new FakeOscillator();
        oscInstances.push(o);
        return o;
      });
      playTamaSound("warn");

      expect(oscInstances.length).toBeGreaterThan(0);
    });
  });

  // ── unison-voice timing (warmTone) ───────────────────────────────────────
  it("attacks warmTone's two unison voices at the exact same time — only their pitch/detune should differ", async () => {
    const { playTamaSound } = await import("./sound.ts");

    // greeting's first note is a warmTone() call — its fundamental + its
    // detuned unison voice are the first two oscillators created.
    playTamaSound("greeting");

    const [fundamental, detunedVoice] = oscInstances;
    expect(fundamental.start.mock.calls[0][0]).toBe(detunedVoice.start.mock.calls[0][0]);
    // The two voices' whole POINT is differing in pitch, not timing — confirm
    // they're not just coincidentally identical oscillators.
    expect(detunedVoice.detune.value).not.toBe(fundamental.detune.value);
  });
});

describe("STATE_SOUND", () => {
  it("maps the significant FSM states to a sound kind, and leaves the noisy/frequent states unmapped", async () => {
    const { STATE_SOUND } = await import("./sound.ts");

    expect(STATE_SOUND.danger).toBe("danger");
    expect(STATE_SOUND.celebrate).toBe("celebrate");
    expect(STATE_SOUND.warn).toBe("warn");
    expect(STATE_SOUND.confused).toBe("warn");
    expect(STATE_SOUND.idle).toBeUndefined();
    expect(STATE_SOUND.sleep).toBeUndefined();
    expect(STATE_SOUND.syncing).toBeUndefined();
    expect(STATE_SOUND.thinking).toBeUndefined();
    expect(STATE_SOUND.curious).toBeUndefined();
  });

  it("gives greeting its own distinct kind, rather than reusing hint", async () => {
    const { STATE_SOUND } = await import("./sound.ts");

    expect(STATE_SOUND.greeting).toBe("greeting");
  });

  it("keeps rescue aliased to hint — a successful undo is a relief, not a milestone", async () => {
    const { STATE_SOUND } = await import("./sound.ts");

    expect(STATE_SOUND.rescue).toBe("hint");
  });
});
