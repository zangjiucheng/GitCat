// Tama's sound effects — synthesized with the Web Audio API, no external
// audio asset files at all: a handful of short tones/chimes for the FSM's
// more significant transitions (TamaMascot.set() in legacy/main.ts calls
// playTamaSound via STATE_SOUND below), gated by the Settings "Play sound
// effects" toggle (settings.svelte.ts's own soundEffectsEnabled, read fresh
// on every play — same "no extra wiring needed for a mid-session change"
// idiom cherryPick()'s own recordOriginDefault read already established).
//
// Leaf module: imports ONLY from settings.svelte.ts, never from
// legacy/main.ts itself — main.ts imports THIS, not the other way around,
// so this file can be imported directly in a test without tripping
// legacy/main.ts's own whole-vanilla-app boot side effects (same isolation
// reasoning every other test in this codebase mocks legacy/bridge for).

import { loadSettings } from "../islands/settings/settings.svelte.ts";

export type TamaSoundKind = "hint" | "warn" | "danger" | "celebrate";

// Maps each FSM state (TamaMascot.STATES' own keys) to which sound plays on
// ENTERING it — states not listed here play nothing. Deliberately excludes
// idle/sleep/thinking/curious/syncing: those fire far too often (every
// long-running op, every mouse-idle nap) to be a discrete "something
// happened" chime without turning into constant noise.
export const STATE_SOUND: Partial<Record<string, TamaSoundKind>> = {
  hint: "hint",
  greeting: "hint",
  rescue: "hint",
  warn: "warn",
  confused: "warn",
  danger: "danger",
  celebrate: "celebrate",
};

let sharedCtx: AudioContext | null = null;

// Lazily creates ONE shared AudioContext — never eagerly at module load,
// both because most browsers refuse to let audio actually produce sound
// before a user gesture anyway, and because constructing one costs a real
// (if small) resource that a user with sound effects permanently disabled
// should never pay for.
function getContext(): AudioContext | null {
  if (sharedCtx) return sharedCtx;
  const Ctor = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  sharedCtx = new Ctor();
  return sharedCtx;
}

// One short tone: a quick attack + exponential-decay envelope so it reads
// as a soft blip/chime rather than a harsh flat beep. `delay` (seconds)
// lets a sound stack two/three of these into a tiny melodic phrase.
function tone(ctx: AudioContext, freq: number, dur: number, peak: number, type: OscillatorType = "sine", delay = 0): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t0 = ctx.currentTime + delay;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

const PLAYERS: Record<TamaSoundKind, (ctx: AudioContext) => void> = {
  // A light single chime — Tama noticing something worth a gentle nudge.
  hint: (ctx) => tone(ctx, 659.25, 0.14, 0.05, "sine"),
  // A soft descending pair — a caution, not an alarm.
  warn: (ctx) => {
    tone(ctx, 392, 0.16, 0.045, "sine");
    tone(ctx, 349.23, 0.2, 0.045, "sine", 0.1);
  },
  // A firmer descending pair — reserved for the genuinely irreversible ops.
  danger: (ctx) => {
    tone(ctx, 440, 0.13, 0.06, "square");
    tone(ctx, 293.66, 0.2, 0.05, "square", 0.1);
  },
  // An ascending two-note "ta-da".
  celebrate: (ctx) => {
    tone(ctx, 523.25, 0.15, 0.055, "triangle");
    tone(ctx, 783.99, 0.22, 0.055, "triangle", 0.09);
  },
};

// Entry point — TamaMascot.set() calls this on every real state transition
// that has an entry in STATE_SOUND. Settings-gated + AudioContext-
// availability-gated + wrapped in try/catch: sound here is purely
// decorative, so any failure (no AudioContext in this environment, a
// suspended context that can't resume without a user gesture yet, …) must
// never surface to the user or break the app.
export function playTamaSound(kind: TamaSoundKind): void {
  if (!loadSettings().soundEffectsEnabled) return;
  const ctx = getContext();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  try {
    PLAYERS[kind](ctx);
  } catch {
    // decorative only — never let a synthesis hiccup break the app
  }
}
