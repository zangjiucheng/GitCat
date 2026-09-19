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

  /**
   * Re-read an installed plugin's manifest from the directory it came from
   * (#66/#67).
   *
   * Exists because the authoring loop was lopsided: a plugin's Luau source is
   * re-read on every invocation, so editing a handler is already live, while
   * the manifest is snapshotted at install and re-installing the same id is
   * refused — editing a command's label meant uninstalling first.
   *
   * The backend preserves `enabled`, refuses a manifest that renamed itself,
   * and validates exactly as install does, so a broken edit leaves the working
   * entry alone. Re-lists rather than patching the one entry, same reason
   * installPlugin does: the backend's ordering is the one to keep.
   */
  async updatePlugin(id: string): Promise<void> {
    if (this.pluginBusyId) return;
    this.pluginsError = "";
    if (!IN_TAURI) {
      bridge.tama.say(t("plugins.demo_install"));
      return;
    }
    this.pluginBusyId = id;
    try {
      const res = await commands.updatePlugin(id);
      if (res.status === "ok") {
        await this.refreshPlugins();
        this.selectedId = id;
        // A changed manifest can add, rename or drop commands and panels.
        await Promise.all([pluginCommandsCtrl.reload(), pluginPanelsCtrl.reload()]);
        bridge.tama.say(t("plugins.updated", { name: res.data.name }));
      } else {
        this.pluginsError = be(res.error) || t("plugins.err_update");
      }
    } catch (e) {
      this.pluginsError = t("plugins.err_update_detail", { err: String(e) });
    } finally {
      this.pluginBusyId = null;
    }
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

    // REVIEW before installing (#69). docs/plugins.md asks the user to install
    // only a plugin they would run in a terminal themselves, and until now the
    // app never showed them the commands — install was this one file picker.
    // preview_plugin_manifest runs the same read+validate the install path
    // runs, so what is shown is exactly what would be installed, and a manifest
    // that fails validation fails HERE rather than after the user has already
    // agreed to something the app could not parse.
    this.pluginInstalling = true;
    try {
      const pre = await commands.previewPluginManifest(picked);
      if (pre.status === "ok") this.pendingInstall = { path: picked, plugin: pre.data };
      else this.pluginsError = be(pre.error) || t("plugins.err_install");
    } catch (e) {
      this.pluginsError = t("plugins.err_install_detail", { err: String(e) });
    } finally {
      this.pluginInstalling = false;
    }
  }

  /**
   * The manifest awaiting the user's decision, and the path it came from.
   * Null whenever no install is pending.
   *
   * Holds the PREVIEWED plugin, not just the path, so the review and the
   * install agree on what was shown — and so the duplicate-id check below can
   * run against the list already in hand rather than a second backend call.
   */
  pendingInstall = $state<{ path: string; plugin: Plugin } | null>(null);

  /**
   * The previewed plugin's id is already installed.
   *
   * The backend rejects this at install (install_from's uniqueness check), so
   * this exists to say so BEFORE the user agrees rather than after — the
   * preview command deliberately does not check it, because the registry it
   * would check against is right here.
   */
  get pendingInstallDuplicate(): boolean {
    const id = this.pendingInstall?.plugin.id;
    return !!id && this.plugins.some((p) => p.id === id);
  }

  cancelInstall(): void {
    this.pendingInstall = null;
  }

  /** Install the plugin the user has just reviewed. */
  async confirmInstall(): Promise<void> {
    const pending = this.pendingInstall;
    if (!pending || this.pluginInstalling) return;
    this.pluginsError = "";
    this.pluginInstalling = true;
    try {
      // By PATH, not by the previewed object: install_from is what writes the
      // registry and it re-reads and re-validates on the way in. The preview is
      // what the user was shown, never a shortcut past that.
      const res = await commands.installPluginFromPath(pending.path);
      if (res.status === "ok") {
        this.pendingInstall = null;
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
