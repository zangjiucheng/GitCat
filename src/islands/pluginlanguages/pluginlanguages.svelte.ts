// Plugin-contributed syntax-highlighting grammars — controller (Svelte 5
// runes singleton).
//
// Same lazy-load/cache shape as plugincommands.svelte.ts (see its own doc
// comment for the concurrent-caller / force-reload rationale) for the same
// reason: this is another per-window, presentation-only projection of the
// same commands.listPlugins() read, just feeding legacy/main.ts's tokenizer
// (via bridge.registerPluginLanguages) instead of cmdk's palette. There is
// no reactive state here worth a Svelte component reading directly — the
// only consumer is main.ts's own GRAMMARS/pluginExtToLang, mutated as a side
// effect of load().
import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";
import type { Plugin, PluginLanguage } from "../../ipc/bindings";

class PluginLanguagesState {
  // Lazy-load gate: ensureLoaded() only ever hits the backend once; reload()
  // is the explicit force path (plugin install/enable/disable/remove).
  loaded = $state(false);
  private loading: Promise<void> | null = null;

  // Lazy + cached. Concurrent callers share the one in-flight load.
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    const p = this.load();
    this.loading = p;
    try {
      await p;
    } finally {
      if (this.loading === p) this.loading = null;
    }
  }

  // Force a fresh read (plugin registry changed). Shares the in-flight
  // `loading` slot with ensureLoaded() so a force reload can't run load()
  // concurrently with a lazy one.
  async reload(): Promise<void> {
    if (this.loading) await this.loading;
    this.loaded = false;
    const p = this.load();
    this.loading = p;
    try {
      await p;
    } finally {
      if (this.loading === p) this.loading = null;
    }
  }

  private async load(): Promise<void> {
    // Design mode (plain browser) has no plugin backend — register nothing,
    // same discipline as every other island's !IN_TAURI branch.
    if (!IN_TAURI) {
      bridge.registerPluginLanguages([]);
      this.loaded = true;
      return;
    }
    try {
      const res = await commands.listPlugins();
      bridge.registerPluginLanguages(res.status === "ok" ? this.collect(res.data) : []);
    } catch {
      // A failed registry read must never break diff highlighting — it just
      // stays on the built-in ts/generic grammars for this session.
      bridge.registerPluginLanguages([]);
    }
    this.loaded = true;
  }

  // Enabled plugins only (enabled defaults to true when a manifest omits
  // it), flattened in registry order — matches pluginCommandsCtrl's own
  // "keep ENABLED plugins" filter. Order matters: main.ts's
  // registerPluginLanguages resolves an id/extension collision as "last one
  // in this list wins".
  private collect(plugins: Plugin[]): PluginLanguage[] {
    return plugins.filter((p) => p.enabled !== false).flatMap((p) => p.languages ?? []);
  }
}

export const pluginLanguagesCtrl = new PluginLanguagesState();
