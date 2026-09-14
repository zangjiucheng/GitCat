import { isClaimed } from "./claim.ts";
import { keymap } from "./registry.ts";

let installed: (() => void) | null = null;

/**
 * TWO listeners. This is the load-bearing detail.
 *
 * Listener A — window, CAPTURE. Matches, runs, and marks. It does NOT stop
 *   propagation here. Capture on window is unconditionally the first node on a
 *   keydown's path, ahead of the canvas element listener (legacy/main.ts:1374),
 *   all 8 legacy document-bubble handlers, src/main.ts:545/:565, and all 36
 *   island <svelte:window> handlers. Mount order is irrelevant to that.
 *
 * Listener B — document, CAPTURE. `if (isClaimed(e)) e.stopImmediatePropagation()`.
 *   The earliest point that can suppress EXACTLY the old world without also
 *   suppressing something that already ran.
 *
 * Why not do the suppression in A. src/main.ts:485-487 registers a
 * {passive:true, capture:true} keydown on WINDOW to stamp lastUserActivityAt,
 * and boot.ts (line 5) registers A before it on the same node and phase.
 * stopImmediatePropagation() there would stop every claimed chord resetting the
 * idle clock, and `git maintenance run --auto` would fire on a user who is
 * actively driving the app by keyboard (MAINTENANCE_IDLE_MS = 5*60_000,
 * main.ts:479-500). That is a real, findable bug created by the obvious
 * one-listener design.
 *
 * Why not a <svelte:window> component host. Bubble phase, so all 8 legacy
 * document handlers would run first and the registry could never be
 * authoritative. And there is no component-mounting test library in this repo
 * (e2e/keymap-safety.spec.ts:4-9), so the single most safety-critical file
 * would be reachable only from chromium-only Playwright.
 *
 * In PR 1 nothing is ever claimed, so listener B never fires. That is the
 * zero-behaviour-change proof: it is structural, not argued.
 */
export function installHost(): void {
  if (installed) return;

  const onCapture = (e: KeyboardEvent) => {
    // An exception here must never stop propagation, so the old world survives
    // a bug in the new one. (A throw in a listener does not stop propagation,
    // but it does print — swallow it to one console.error instead of one per key.)
    try { keymap.handle(e); } catch (err) { console.error("keymap: dispatch threw", err); }
  };
  const onSuppress = (e: KeyboardEvent) => {
    if (isClaimed(e)) e.stopImmediatePropagation();
  };

  window.addEventListener("keydown", onCapture, { capture: true });
  document.addEventListener("keydown", onSuppress, { capture: true });

  // Dev canary: if listener B is doing its job, a claimed event can NEVER reach
  // document-bubble. Any hit is a structural failure, surfaced in the console
  // and assertable from Playwright. Same import.meta.env.DEV gate as the perf
  // HUD at legacy/main.ts:2559.
  let onCanary: ((e: KeyboardEvent) => void) | null = null;
  if (import.meta.env.DEV) {
    const w = window as unknown as { __keymapDoubleFire?: string[] };
    w.__keymapDoubleFire = [];
    onCanary = (e: KeyboardEvent) => {
      if (!isClaimed(e)) return;
      const d = `${e.code}/${e.key}`;
      console.error("keymap: claimed event reached document-bubble", d);
      w.__keymapDoubleFire!.push(d);
    };
    document.addEventListener("keydown", onCanary);
  }

  installed = () => {
    window.removeEventListener("keydown", onCapture, { capture: true });
    document.removeEventListener("keydown", onSuppress, { capture: true });
    if (onCanary) document.removeEventListener("keydown", onCanary);
    installed = null;
  };
}

/** Tests only. */
export function uninstallHost(): void { installed?.(); }
