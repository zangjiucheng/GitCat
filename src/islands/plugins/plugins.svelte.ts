// Plugins manager — controller (Svelte 5 runes singleton).
//
// A dedicated, VS Code Extensions-style view for INSTALLED plugins. GitCat's
// plugins are LOCAL FILES ONLY — there is no online marketplace to browse, so
// this is a manager (list + detail + enable/disable/remove + install-from-file),
// not a store. Opened from Tools ▸ Plugins… / ⌘K (like Settings / External
// Tools), it OWNS the plugin registry list and every mutation; the Tama skin
// picker in Settings reads this same list (see settingsCtrl.skinnablePlugins),
// so there is one source of truth. This is the old Settings → Plugins tab, moved
// out into its own home — the enable/disable/remove/install logic below is that
// tab's, verbatim, plus the two-pane selection state a dedicated view needs.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";
import { t, be } from "@/i18n/i18n.svelte.ts";
import { open } from "@tauri-apps/plugin-dialog";
import { pluginCommandsCtrl } from "../plugincommands/plugincommands.svelte.ts";
import { pluginPanelsCtrl } from "../pluginpanels/pluginpanels.svelte.ts";
import type { Plugin } from "../../ipc/bindings";

// A one-line summary of what a plugin contributes, for the detail pane. Pure +
// exported for unit testing. Reads only the manifest fields the backend fills
// (commands/hooks/panels/lua/tama); an all-empty plugin yields "Nothing".
export interface PluginContribution {
  commands: number;
  hooks: number;
  panels: number;
  lua: boolean;
  tama: boolean;
}
export function pluginContribution(p: Plugin): PluginContribution {
  return {
    commands: p.commands?.length ?? 0,
    hooks: p.hooks?.length ?? 0,
    panels: p.panels?.length ?? 0,
    lua: !!(p as { lua?: unknown }).lua,
    tama: !!(p as { tama?: unknown }).tama,
  };
}

class PluginsState {
  open = $state(false);
  // The plugin whose detail pane is showing. Kept valid across refresh/remove by
  // reconcileSelection(): it re-points at the first plugin when the current one
  // vanishes, or null when the registry is empty.
  selectedId = $state<string | null>(null);
  // Client-side filter over the already-loaded list (name/id/description) — no
  // round-trip, same idiom as Settings' own Advanced git-config filter.
  filter = $state("");

  // ── registry list + per-row management (moved from the Settings tab) ───────
  // App-level, NOT repo-scoped — the plugin registry is global (see
  // plugin_registry.rs), so refreshPlugins() never reads a repo. Each mutation
  // writes the registry then reloads pluginCommandsCtrl + pluginPanelsCtrl so
  // ⌘K's plugin actions and declarative panels refresh live (PER-42/PER-45).
  plugins = $state<Plugin[]>([]);
  pluginsLoading = $state(false);
  pluginsError = $state("");
  // The plugin whose enable/disable/remove write is in flight — disables just
  // that row's controls (one-target-at-a-time, like remotes.svelte.ts's
  // busyTarget). null when idle.
  pluginBusyId = $state<string | null>(null);
  pluginInstalling = $state(false);
  // Which plugin has its inline "Remove?" confirm showing (remotes.svelte.ts's
  // removingName idiom — a lightweight in-place confirm, no separate modal).
  removingPluginId = $state<string | null>(null);

  // The filtered list the left pane renders. Selection validity is tracked
  // against the FULL list (see `selected`), so filtering never blanks the detail
  // pane — it only narrows what's listed.
  get filteredPlugins(): Plugin[] {
    const q = this.filter.trim().toLowerCase();
    if (!q) return this.plugins;
    return this.plugins.filter(
      (p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q),
    );
  }

  // The selected plugin object (from the full list, so a filtered-out selection
  // still shows its detail), or null.
  get selected(): Plugin | null {
    return this.plugins.find((p) => p.id === this.selectedId) ?? null;
  }

  select(id: string): void {
    this.selectedId = id;
    this.removingPluginId = null; // switching selection cancels a pending confirm
  }

  // Keep selectedId pointing at a real registry entry. Called after any list
  // change (refresh/remove/install). Prefers keeping the current selection;
  // otherwise falls to the first plugin, or null when the registry is empty.
  private reconcileSelection(): void {
    if (this.selectedId && this.plugins.some((p) => p.id === this.selectedId)) return;
    this.selectedId = this.plugins[0]?.id ?? null;
  }

  // Entry point (Tools menu / ⌘K). Re-fetches the registry every open — same
  // "never trust stale state across a reopen" discipline as every other modal.
  show(): void {
    this.filter = "";
    this.pluginsError = "";
    this.removingPluginId = null;
    this.open = true;
    void this.refreshPlugins();
  }

  close(): void {
    this.open = false;
  }

  // enabled defaults to true when a manifest omits it (see Plugin.enabled), so a
  // toggle reads `p.enabled !== false`; every write below sets an explicit bool.
  async refreshPlugins(): Promise<void> {
    this.pluginsError = "";
    this.removingPluginId = null;
    if (!IN_TAURI) {
      // Design mode (plain browser) has no plugin backend — an empty list is
      // the correct, non-confusing demo state (same discipline as the sibling
      // plugincommands controller's own !IN_TAURI branch).
      this.plugins = [];
      this.reconcileSelection();
      return;
    }
    this.pluginsLoading = true;
    try {
      const res = await commands.listPlugins();
      if (res.status === "ok") {
        this.plugins = res.data;
      } else {
        this.pluginsError = be(res.error) || t("plugins.err_list");
      }
    } catch (e) {
      this.pluginsError = t("plugins.err_list_detail", { err: String(e) });
    } finally {
      this.pluginsLoading = false;
      this.reconcileSelection();
    }
  }

  async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    this.pluginsError = "";
    if (!IN_TAURI) {
      this.plugins = this.plugins.map((p) => (p.id === id ? { ...p, enabled } : p));
      bridge.tama.say(enabled ? t("plugins.demo_enable", { id }) : t("plugins.demo_disable", { id }));
      return;
    }
    this.pluginBusyId = id;
    // Optimistic: reflect the toggle locally right away so the checkbox matches
    // the click, then REVERT if the backend write fails — otherwise the one-way
    // `checked={p.enabled}` binding won't snap a failed toggle back. `prev` is
    // the pre-toggle list to restore on failure.
    const prev = this.plugins;
    this.plugins = this.plugins.map((p) => (p.id === id ? { ...p, enabled } : p));
    try {
      const res = await commands.setPluginEnabled(id, enabled);
      if (res.status === "ok") {
        // ⌘K plugin commands AND panels both follow enable/disable live.
        await Promise.all([pluginCommandsCtrl.reload(), pluginPanelsCtrl.reload()]);
      } else {
        this.plugins = prev; // backend rejected — undo the optimistic flip
        this.pluginsError = be(res.error) || t("plugins.err_update");
      }
    } catch (e) {
      this.plugins = prev; // backend threw — undo the optimistic flip
      this.pluginsError = t("plugins.err_update_detail", { err: String(e) });
    } finally {
      this.pluginBusyId = null;
    }
  }

  startRemovePlugin(id: string): void {
    this.removingPluginId = id;
  }

  cancelRemovePlugin(): void {
    this.removingPluginId = null;
  }

  async confirmRemovePlugin(id: string): Promise<void> {
    this.pluginsError = "";
    if (!IN_TAURI) {
      this.plugins = this.plugins.filter((p) => p.id !== id);
      this.removingPluginId = null;
      this.reconcileSelection();
      bridge.tama.say(t("plugins.demo_remove", { id }));
      return;
    }
    this.pluginBusyId = id;
    try {
      const res = await commands.removePlugin(id);
      if (res.status === "ok") {
        this.plugins = this.plugins.filter((p) => p.id !== id);
        this.removingPluginId = null;
        this.reconcileSelection();
        // Drop both its ⌘K commands AND panels immediately.
        await Promise.all([pluginCommandsCtrl.reload(), pluginPanelsCtrl.reload()]);
      } else {
        this.pluginsError = be(res.error) || t("plugins.err_remove");
      }
    } catch (e) {
      this.pluginsError = t("plugins.err_remove_detail", { err: String(e) });
    } finally {
      this.pluginBusyId = null;
    }
  }

  // Pick a plugin.json and install it. The backend's install_plugin_from_path
  // accepts a plugin.json FILE or a DIRECTORY containing one; a single-select
  // file picker filtered to JSON covers both cases (a standalone manifest, or
  // drilling into a plugin folder and picking its plugin.json) — the same
  // @tauri-apps/plugin-dialog `open()` shape applypatch.svelte.ts uses.
  async installPlugin(): Promise<void> {
    if (this.pluginInstalling) return;
    this.pluginsError = "";
    if (!IN_TAURI) {
      bridge.tama.say(t("plugins.demo_install"));
      return;
    }
    let picked: string | string[] | null;
    try {
      picked = await open({
        title: t("plugins.dialog_title"),
        multiple: false,
        filters: [{ name: t("plugins.dialog_filter"), extensions: ["json"] }],
      });
    } catch (e) {
      this.pluginsError = t("plugins.err_dialog_detail", { err: String(e) });
      return;
    }
    if (!picked || Array.isArray(picked)) return; // cancelled (Array.isArray is defensive-only — multiple:false never returns one)
    this.pluginInstalling = true;
    try {
      const res = await commands.installPluginFromPath(picked);
      if (res.status === "ok") {
        // Re-list rather than append res.data — keeps the exact ordering the
        // backend returns and reflects anything else that changed on disk.
        await this.refreshPlugins();
        // Focus the newly installed plugin so its detail pane is what you see.
        this.selectedId = res.data.id;
        // Surface the new plugin's ⌘K commands AND panels.
        await Promise.all([pluginCommandsCtrl.reload(), pluginPanelsCtrl.reload()]);
        bridge.tama.say(t("plugins.installed", { name: res.data.name }));
      } else {
        this.pluginsError = be(res.error) || t("plugins.err_install");
      }
    } catch (e) {
      this.pluginsError = t("plugins.err_install_detail", { err: String(e) });
    } finally {
      this.pluginInstalling = false;
    }
  }
}

export const pluginsCtrl = new PluginsState();
