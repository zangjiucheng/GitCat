// Plugin lifecycle hooks (PER-43) — controller.
//
// Plugins declare `hooks: [{ event, run }]` in their manifest. This controller
// fires them automatically when a GitCat lifecycle moment happens, by calling
// the backend `run_hooks(event, ctx)` (which loads the enabled plugins, runs
// every hook matching `event` through the hardened executor, and returns their
// outputs). This file is just the translation layer from a GitCat moment to a
// runHooks() call — it owns no plugin logic.
//
// EVENT SOURCES:
//   • The Tama event bus (PER-41): commit.created → commit-created,
//     undo.performed → undo, mutation.caution / mutation.destructive →
//     pre-mutation. Subscribed in start().
//   • openRepo()'s success tail (legacy/main.ts) → repo-opened (always) and
//     repo-switched (when moving from a different repo). Pushed via onRepoOpened.
//   • post-mutation is NOT wired yet — GitCat has no single post-mutation
//     chokepoint (see the epic PER-38 / PER-43 notes); deferred.
//
// Hooks are fire-and-forget OBSERVERS: this never awaits them before GitCat's
// own operation proceeds, so even a slow pre-mutation hook can't gate/veto a
// mutation. A hook MAY drive a SAFE Tama reaction through the exact same
// `::gitcat.tama` stdout protocol commands use (parseTamaReaction) — so a
// commit-created hook can make Tama react, but never reach a safety-critical
// pose. No reentrancy loop is possible via GitCat: a hook's `git commit`/etc. is
// an external shell call that does not re-fire GitCat's own Tama events.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";
import type { PluginEvent, PlaceholderCtx } from "../../ipc/bindings";
import { parseTamaReaction } from "../plugincommands/plugincommands.svelte.ts";

// Tama-bus event name → plugin hook event. A closed table (own-property gated
// at the call site) — only these GitCat moments map to a hook event.
const BUS_TO_HOOK: Record<string, PluginEvent> = {
  "commit.created": "commit-created",
  "undo.performed": "undo",
  "mutation.caution": "pre-mutation",
  "mutation.destructive": "pre-mutation",
};

class PluginHooksState {
  private started = false;
  private lastRepo: string | null = null;

  // Called once at boot (src/main.ts, inside the IN_TAURI block). Subscribes to
  // the Tama event bus so commit/undo/mutation moments fire matching hooks.
  // Idempotent + design-mode-safe.
  start(): void {
    if (this.started || !IN_TAURI) return;
    this.started = true;
    try {
      bridge.tamaBus.subscribe((name: string) => {
        // own-property check so an inherited key can't map to a bogus event
        const event = Object.prototype.hasOwnProperty.call(BUS_TO_HOOK, name) ? BUS_TO_HOOK[name] : undefined;
        if (event) void this.fire(event);
      });
    } catch (e) {
      console.error("pluginHooks: tamaBus subscribe failed", e);
    }
  }

  // Called from openRepo()'s success tail. Fires repo-opened every time, plus
  // repo-switched when moving from a DIFFERENT repo. `path` is passed explicitly
  // because it's the just-opened repo (CUR_REPO is already set to it by now, but
  // relying on the argument keeps this independent of that ordering).
  onRepoOpened(path: string): void {
    if (!IN_TAURI || !path) return;
    const prev = this.lastRepo;
    this.lastRepo = path;
    void this.fire("repo-opened", path);
    if (prev && prev !== path) void this.fire("repo-switched", path);
  }

  // Translate a GitCat moment into runHooks(event, ctx). Fire-and-forget; each
  // returned hook output is scanned for a SAFE Tama reaction directive.
  private async fire(event: PluginEvent, repoOverride?: string): Promise<void> {
    const repo = repoOverride ?? (bridge.CUR_REPO as unknown as string | null);
    if (!repo) return;
    const ctx: PlaceholderCtx = { repo, sha: null, file: null, files: [], diff: null, branch: null, ref: null };
    try {
      const res = await commands.runHooks(event, ctx);
      if (res.status !== "ok") return;
      for (const hook of res.data) {
        const reaction = parseTamaReaction(hook.output.stdout);
        if (reaction) {
          bridge.tama.set(reaction.state);
          bridge.tama.say(reaction.message);
        }
      }
    } catch (e) {
      console.error("pluginHooks: runHooks failed", e);
    }
  }
}

export const pluginHooksCtrl = new PluginHooksState();
