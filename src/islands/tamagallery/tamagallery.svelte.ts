// Tama Gallery — controller (Svelte 5 runes singleton).
//
// A hidden Easter egg: click the nook portrait 7 times within ~2.5s (see
// legacy/main.ts's own click counter, right next to the gaze()/idle-sleep
// code) to open this. Every painted pose GitCat has of Tama in one grid —
// click a card to "play" that pose live in the real nook behind this
// modal, via the SAME TamaMascot state machine every other Tama surface
// in the app already drives (bridge.tama.set(...)) — a genuine playground,
// not just a static gallery.
//
// Deliberately not reachable any other way: no menu entry, no ⌘K action,
// no visible button hints this exists anywhere in the UI.

import * as bridge from "../../legacy/bridge";

export type PoseCard = { key: string; label: string; previewState: string };

// `previewState` is whichever FSM state maps to this pose in
// TamaMascot.POSE (several states share one pose — see that map's own
// comment) — just one representative state per pose is enough to "wear" it.
export const POSES: PoseCard[] = [
  { key: "curious", label: "Curious", previewState: "curious" },
  { key: "thinking", label: "Thinking", previewState: "thinking" },
  { key: "shocked", label: "Uh oh…", previewState: "warn" },
  { key: "alarm", label: "Alert!", previewState: "danger" },
  { key: "happy", label: "Celebrating", previewState: "celebrate" },
  { key: "confident", label: "Got this", previewState: "rescue" },
  { key: "sleep", label: "Napping", previewState: "sleep" },
  { key: "hero", label: "Hello!", previewState: "greeting" },
];

// Resolves a pose's image lazily, never at module load: bridge.ts's own
// TAMA_IMG re-export is TDZ-hazardous read eagerly (see that file's header
// doc) — legacy/main.ts hasn't finished initializing TAMA_IMG yet at the
// point this module's own top-level code runs (it sits in the same import
// graph, well before legacy/main.ts's own body executes). Safe to call
// from the gallery's template, which only ever renders after boot.
export function poseImg(key: string): string {
  return (bridge.TAMA_IMG as Record<string, string>)[key] ?? "";
}

class TamaGalleryState {
  open = $state(false);
  activeKey = $state<string | null>(null);

  show(): void {
    this.open = true;
  }

  // Closing resets the real nook back to idle — playing in here shouldn't
  // leave the mascot stuck showing whatever was last previewed. Several
  // preview states are "sticky" (see TamaMascot.STATES) and would
  // otherwise sit there until some unrelated real event changes it next.
  close(): void {
    this.open = false;
    this.activeKey = null;
    bridge.tama.event("idle");
  }

  preview(pose: PoseCard): void {
    this.activeKey = pose.key;
    bridge.tama.set(pose.previewState);
  }
}

export const tamaGalleryCtrl = new TamaGalleryState();
