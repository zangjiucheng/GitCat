// Built-in terminal — controller (Svelte 5 runes singleton).
//
// Tools-menu/⌘K/CmdOrCtrl+` "Open Terminal", now a real PTY-backed shell
// embedded in GitCat's own UI (a bottom drawer, see Terminal.svelte) —
// fronts terminal.rs's terminal_spawn/terminal_write/terminal_resize/
// terminal_kill, replacing the old openterminal.svelte.ts, which just
// shelled out to the OS's own Terminal app (no controller state needed
// there beyond a `busy` re-entrancy guard; this one owns a real session's
// whole lifecycle instead).
//
// `onData` is a plain (non-reactive) callback field, not `$state` — it's an
// imperative hook Terminal.svelte's own onMount registers so decoded PTY
// bytes reach its xterm.js instance directly, without this controller ever
// touching a DOM/terminal-emulation library itself (every other controller
// in this codebase stays that way; xterm.js is inherently DOM-bound, so the
// component alone owns the actual `Terminal` instance).
//
// Toggling for the SAME repo just shows/hides the drawer (`open`) without
// touching the underlying shell — closing it is a deliberate act via the ×
// button (`closeSession`), not a side effect of hiding the drawer, so a
// long-running command left in the terminal survives being tucked away.
// Switching to a DIFFERENT repo (or an explicit restart) tears the old
// session down first — a stale shell still `cd`'d into a repo that's no
// longer current would just be confusing to land back on.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

class TerminalState {
  open = $state(false);
  repo = $state("");
  sessionId = $state<string | null>(null);
  busy = $state(false);
  exited = $state(false);

  onData: ((bytes: Uint8Array) => void) | null = null;

  private unlistenOutput: (() => void) | null = null;
  private unlistenExit: (() => void) | null = null;

  // Entry point (Tools menu / ⌘K / CmdOrCtrl+`).
  async toggle(repo: string): Promise<void> {
    if (!repo) {
      bridge.tama.warn("Open a repository first.");
      return;
    }
    if (this.sessionId && this.repo === repo) {
      this.open = !this.open;
      return;
    }
    if (this.sessionId) await this.endSession();
    await this.spawnFor(repo);
  }

  // The exited-banner's own action — a fresh session for the SAME repo.
  async restart(): Promise<void> {
    const repo = this.repo;
    await this.endSession();
    await this.spawnFor(repo);
  }

  // Tucks the drawer away without ending the shell — see this file's own
  // header doc for why hide and close are deliberately different actions.
  hide(): void {
    this.open = false;
  }

  async closeSession(): Promise<void> {
    await this.endSession();
    this.open = false;
  }

  async write(data: string): Promise<void> {
    if (!this.sessionId || !IN_TAURI) return;
    try {
      const res = await commands.terminalWrite(this.sessionId, data);
      if (res.status === "error") console.error(res.error);
    } catch (e) {
      console.error(e);
    }
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (!this.sessionId || !IN_TAURI) return;
    try {
      const res = await commands.terminalResize(this.sessionId, cols, rows);
      if (res.status === "error") console.error(res.error);
    } catch (e) {
      console.error(e);
    }
  }

  private async spawnFor(repo: string): Promise<void> {
    this.repo = repo;
    this.open = true;
    this.exited = false;
    if (!IN_TAURI) return; // demo mode: drawer shows a static preview, no real shell
    this.busy = true;
    try {
      const res = await commands.terminalSpawn(repo);
      if (res.status === "error") {
        bridge.tama.warn(String(res.error ?? "Could not open a terminal."));
        this.open = false;
        return;
      }
      this.sessionId = res.data;
      this.armListeners(res.data);
    } catch (e) {
      bridge.tama.warn("Could not open a terminal — " + e);
      this.open = false;
    } finally {
      this.busy = false;
    }
  }

  private async endSession(): Promise<void> {
    this.stopListening();
    const id = this.sessionId;
    this.sessionId = null;
    this.exited = false;
    if (id && IN_TAURI) {
      try {
        const res = await commands.terminalKill(id);
        if (res.status === "error") console.error(res.error);
      } catch (e) {
        console.error(e);
      }
    }
  }

  // Subscribes BEFORE the caller learns the session's own id back (arming
  // happens right after `terminalSpawn` resolves, so there's no window
  // where early output could arrive unheard) — id-filtered so a listener
  // left over from a just-superseded session can never misapply to the new
  // one, and self-disposes if the session already moved on by the time the
  // (async) subscribe call itself finishes.
  private armListeners(id: string): void {
    const w = window as unknown as { __TAURI__?: { event: { listen: (name: string, handler: (e: { payload: any }) => void) => Promise<() => void> } } };
    if (!w.__TAURI__) return;
    w.__TAURI__.event.listen("terminal-output", (e: { payload: { id: string; data: string } }) => {
      if (e.payload.id !== id) return;
      this.onData?.(base64ToBytes(e.payload.data));
    }).then((un) => {
      if (this.sessionId === id) this.unlistenOutput = un;
      else un();
    });
    w.__TAURI__.event.listen("terminal-exit", (e: { payload: { id: string } }) => {
      if (e.payload.id !== id) return;
      this.exited = true;
    }).then((un) => {
      if (this.sessionId === id) this.unlistenExit = un;
      else un();
    });
  }

  private stopListening(): void {
    this.unlistenOutput?.();
    this.unlistenExit?.();
    this.unlistenOutput = null;
    this.unlistenExit = null;
  }
}

export const terminalCtrl = new TerminalState();
