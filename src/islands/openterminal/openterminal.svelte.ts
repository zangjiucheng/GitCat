// Open Terminal — controller (Svelte 5 runes singleton).
//
// Tools-menu/⌘K "Open Terminal" fronting terminal.rs's `open_terminal`,
// which launches the OS's own terminal application at the repo's root. No
// island UI of its own — same "just a Tools-menu/⌘K entry point, the shared
// chrome does the rest" shape as applypatch.svelte.ts/forcepush.svelte.ts
// (neither has a companion .svelte file either).
//
// Replaces the old submodule "run a command in every submodule" bulk-runner
// (see sidebar.svelte.ts's git history) — repo-global, not per-submodule,
// and a real external shell instead of an in-app command runner.
//
// No Safety Manager snapshot and no `bridge.reloadGraph`/`sidebarCtrl.refresh`
// on success: opening a terminal window never touches this repo's refs/
// index/working tree itself, same "nothing this action does is snapshot-
// shaped" reasoning as `tool_settings.rs`'s `open_diff_tool`.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";

class OpenTerminalState {
  busy = $state(false);

  // Entry point (Tools menu / ⌘K).
  async openTerminal(repo: string): Promise<void> {
    if (this.busy) return;
    if (!repo) {
      bridge.tama.warn("Open a repository first.");
      return;
    }
    if (!IN_TAURI) {
      bridge.tama.say("This is where a terminal would open, at " + repo + " (demo).");
      return;
    }
    this.busy = true;
    try {
      const res = await commands.openTerminal(repo);
      if (res.status === "error") {
        bridge.tama.warn(String(res.error ?? "Could not open a terminal."));
      }
    } catch (e) {
      bridge.tama.warn("Could not open a terminal — " + e);
      console.error(e);
    } finally {
      this.busy = false;
    }
  }
}

export const openTerminalCtrl = new OpenTerminalState();
