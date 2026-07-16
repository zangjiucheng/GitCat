// Tama's sound effects — synthesized with the Web Audio API, no external
// audio asset files at all: a handful of short tones/chimes for her more
// significant moments (TamaMascot.set() in legacy/main.ts calls
// playTamaSound via STATE_SOUND below; a few non-FSM UI actions — clipboard
// copies, via legacy/clipboard.ts's copyToClipboard() — call
// playTamaSound("copy") directly), gated by the Settings "Play sound
// effects" toggle + volume slider (settings.svelte.ts's own
// soundEffectsEnabled/soundEffectsVolume, read fresh on every play — same
// "no extra wiring needed for a mid-session change" idiom cherryPick()'s own
// recordOriginDefault read already established).
//
// Six kinds, not more: hint/warn/danger/celebrate/greeting/copy. A small
// personality-driven app reads best with a tight, memorable sound
// vocabulary — much beyond this and users stop mapping sound to meaning,
// which reads as noise no matter how pleasant each sound is individually.
// idle/sleep/thinking/curious/syncing/rescue deliberately stay silent or
// reuse an existing kind (see STATE_SOUND below) rather than getting their
// own: they fire far too often (every long-running op, every mouse-idle
// nap) to be a distinct "something happened" chime without becoming
// constant noise.
//
// Leaf module: imports ONLY from settings.svelte.ts, never from
// legacy/main.ts itself — main.ts imports THIS, not the other way around,
// so this file can be imported directly in a test without tripping
// legacy/main.ts's own whole-vanilla-app boot side effects (same isolation
// reasoning every other test in this codebase mocks legacy/bridge for).

import { loadSettings } from "../islands/settings/settings.svelte.ts";

export type TamaSoundKind = "hint" | "warn" | "danger" | "celebrate" | "greeting" | "copy";

// Maps each FSM state (TamaMascot.STATES' own keys) to which sound plays on
// ENTERING it — states not listed here play nothing. "greeting" gets its
// own warm little welcome chime now (previously aliased to "hint", which
// made opening the app and a routine notice sound identical); "rescue"
// stays aliased to "hint" — a successful global-undo rewind is a relief,
// not a milestone, so it doesn't need "celebrate"'s bigger flourish.
export const STATE_SOUND: Partial<Record<string, TamaSoundKind>> = {
  hint: "hint",
  greeting: "greeting",
  rescue: "hint",
  warn: "warn",
  confused: "warn",
  danger: "danger",
  celebrate: "celebrate",
};

let sharedCtx: AudioContext | null = null;
let sharedMaster: GainNode | null = null;

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

// One master GainNode every voice routes through, instead of each tone
// connecting straight to ctx.destination — lets the Settings volume slider
// scale ALL of a sound's voices (including layered/echoed ones) with one
// assignment per play, rather than threading a volume multiplier through
// every individual tone() call. Takes no argument (reads sharedCtx itself)
// rather than an ignored-after-first-call `ctx` parameter — sharedCtx is a
// true singleton (getContext() never replaces it once created), so there is
// no second context this could ever need to reconnect to.
function getMaster(): GainNode {
  if (!sharedMaster) {
    sharedMaster = sharedCtx!.createGain();
    sharedMaster.connect(sharedCtx!.destination);
  }
  return sharedMaster;
}

// Humanization: an identical tone replayed dozens of times over a session
// (e.g. "hint" on every branch checkout) reads as mechanical/grating: a
// tiny bit of per-play variance is what keeps repetition from becoming
// noise. `pct` stays well inside "reads as organic" territory for both
// callers below (±1% frequency, ±7% gain — beyond roughly ±3-4% frequency
// starts sounding mistuned) — small enough nobody consciously notices it,
// big enough that no two plays are bit-for-bit identical.
function jitter(value: number, pct: number): number {
  return value * (1 + (Math.random() * 2 - 1) * pct);
}

// One short tone: a quick attack + exponential-decay envelope so it reads
// as a soft blip/chime rather than a harsh flat beep. `delay` (seconds)
// lets a sound stack two/three of these into a tiny melodic phrase.
// `detuneCents` (a few cents, NOT semitones — 100 cents = 1 semitone) lets
// a second voice sit slightly off-pitch from a first one for warmTone's own
// unison-detune layering below, rather than every tone being a single bare
// oscillator. `timingJitterSec`, when given, lets a caller share ONE
// randomized start-time offset across multiple voices of the same note
// (see warmTone below) — omit it to let this call roll its own, for a tone
// that's the only voice of its own note (hint/copy/warn/danger's plain
// tone() calls, and echoTone's own extra delayed tap).
function tone(ctx: AudioContext, master: GainNode, freq: number, dur: number, peak: number, type: OscillatorType = "sine", delay = 0, detuneCents = 0, timingJitterSec?: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = jitter(freq, 0.01);
  osc.detune.value = detuneCents;
  const t0 = ctx.currentTime + delay + (timingJitterSec ?? Math.random() * 0.008);
  const peakG = jitter(peak, 0.07);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(peakG, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
  // Rapid replays (e.g. spam-copying several shas in a row) would otherwise
  // leak a node graph per play until GC eventually catches up — disconnect
  // as soon as each oscillator is done rather than waiting on that.
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
}

// A fundamental + a second voice a few cents detuned (unison chorusing —
// "warmTone" as in warmer timbre, not temperature) reads noticeably richer
// than a single bare oscillator, at a fraction of the code a full additive
// synth would take. The detuned voice sits quieter (0.35x vs 0.75x of
// `peak`) so it thickens the tone rather than becoming audible as a
// separate, slightly-out-of-tune note of its own. Both voices share ONE
// timing-jitter roll so they attack in unison — only their PITCH should
// differ (that's the whole unison-detune effect); if each voice rolled its
// own independent start-time jitter too, the pair would sometimes attack a
// few ms apart instead of together, undermining the effect it exists to create.
function warmTone(ctx: AudioContext, master: GainNode, freq: number, dur: number, peak: number, type: OscillatorType = "sine", delay = 0): void {
  const sharedTimingJitter = Math.random() * 0.008;
  tone(ctx, master, freq, dur, peak * 0.75, type, delay, 0, sharedTimingJitter);
  tone(ctx, master, freq, dur, peak * 0.35, type, delay, 9, sharedTimingJitter);
}

// A cheap slapback echo — one extra, quieter, delayed repeat of the same
// tone — instead of a real convolution reverb (which would need an impulse
// response asset this app deliberately has none of). Reserved for
// celebrate's landing note: a short decaying tail is what makes a
// resolution feel "finished" rather than abruptly cut off. The echo tap
// is a genuinely separate, LATER note event (not part of the same
// simultaneous attack as warmTone's own pair above), so it rolls its own
// independent timing jitter rather than sharing warmTone's.
function echoTone(ctx: AudioContext, master: GainNode, freq: number, dur: number, peak: number, type: OscillatorType, delay: number): void {
  warmTone(ctx, master, freq, dur, peak, type, delay);
  tone(ctx, master, freq, dur, peak * 0.3, type, delay + 0.09);
}

const PLAYERS: Record<TamaSoundKind, (ctx: AudioContext, master: GainNode) => void> = {
  // A light single chime — Tama noticing something worth a gentle nudge.
  hint: (ctx, master) => tone(ctx, master, 659.25, 0.14, 0.05, "sine"),
  // A soft descending pair — a caution, not an alarm.
  warn: (ctx, master) => {
    tone(ctx, master, 392, 0.16, 0.045, "sine");
    tone(ctx, master, 349.23, 0.2, 0.045, "sine", 0.1);
  },
  // A firmer descending pair — reserved for the genuinely irreversible ops.
  danger: (ctx, master) => {
    tone(ctx, master, 440, 0.13, 0.06, "square");
    tone(ctx, master, 293.66, 0.2, 0.05, "square", 0.1);
  },
  // An ascending C5-E5-G5 major triad (the textbook "resolved/positive"
  // interval shape) — warmer/thicker than a bare oscillator via warmTone,
  // with the landing note (G5) given a short slapback tail via echoTone so
  // the celebration has somewhere to land instead of cutting off flat.
  celebrate: (ctx, master) => {
    warmTone(ctx, master, 523.25, 0.15, 0.06, "triangle");
    warmTone(ctx, master, 659.25, 0.15, 0.055, "triangle", 0.08);
    echoTone(ctx, master, 783.99, 0.24, 0.06, "triangle", 0.16);
  },
  // A gentle rising fourth (C5-F5) — a soft "welcome back", deliberately
  // calmer and slower than celebrate's own triad so opening the app never
  // sounds like it's celebrating just for existing.
  greeting: (ctx, master) => {
    warmTone(ctx, master, 523.25, 0.22, 0.05, "sine");
    warmTone(ctx, master, 698.46, 0.32, 0.05, "sine", 0.1);
  },
  // A tiny, near-instant tick for legacy/clipboard.ts's copyToClipboard() —
  // deliberately the smallest/shortest sound here, since it's the one kind
  // several genuinely distinct, deliberate user actions (copying a branch
  // name, then a different commit's sha, then a snapshot sha) all share.
  copy: (ctx, master) => tone(ctx, master, 950, 0.035, 0.045, "sine"),
};

// Per-kind cooldown — guards against a genuine ACCIDENTAL same-tick
// double-fire (e.g. a doubly-bound click handler, or two re-entrant FSM
// transitions in the same synchronous stretch), not against two real,
// separately-timed user actions. Deliberately short (45ms — comfortably
// longer than any such same-tick duplicate, but far shorter than a human
// could physically repeat a deliberate click/action) so it can never
// mistake "the user copied two different things a moment apart" or "two
// DIFFERENT FSM states that happen to alias to the same kind" (e.g.
// warn/confused, or hint/rescue) for a duplicate and swallow one of them —
// both are real, meaningful events this app should never silently drop.
// Measured with performance.now() (real wall-clock milliseconds), not
// ctx.currentTime — the latter does NOT advance while the AudioContext is
// suspended (its default state until the first resume completes), which
// would make the very first two sounds of a session race this check
// incorrectly. `bypassCooldown` (Settings' own "Test" button) skips this
// entirely — a sound the user explicitly asked to preview right now should
// never go silent just because something real happened to play recently.
const MIN_REPLAY_INTERVAL_MS = 45;
const lastPlayedAt: Partial<Record<TamaSoundKind, number>> = {};

// Entry point — TamaMascot.set() calls this on every real state transition
// that has an entry in STATE_SOUND; legacy/clipboard.ts's copyToClipboard()
// calls playTamaSound("copy") directly (copying isn't a Tama FSM state).
// Settings-gated + AudioContext-availability-gated + wrapped in try/catch:
// sound here is purely decorative, so any failure (no AudioContext in this
// environment, a suspended context that can't resume without a user
// gesture yet, …) must never surface to the user or break the app.
export function playTamaSound(kind: TamaSoundKind, opts?: { bypassCooldown?: boolean }): void {
  const now = performance.now();
  // Checked BEFORE loadSettings() (a real localStorage read+parse) on
  // purpose — a call that's about to be suppressed as a duplicate
  // shouldn't still pay for that read.
  if (!opts?.bypassCooldown) {
    const last = lastPlayedAt[kind];
    if (last !== undefined && now - last < MIN_REPLAY_INTERVAL_MS) return;
  }
  const settings = loadSettings();
  if (!settings.soundEffectsEnabled) return;
  const ctx = getContext();
  if (!ctx) return;
  const master = getMaster();
  master.gain.value = settings.soundEffectsVolume;
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  try {
    PLAYERS[kind](ctx, master);
    // Recorded only once we know synthesis didn't throw — a failed play
    // shouldn't consume the cooldown window a real one would have earned.
    if (!opts?.bypassCooldown) lastPlayedAt[kind] = now;
  } catch {
    // decorative only — never let a synthesis hiccup break the app
  }
}
