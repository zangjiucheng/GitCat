// Declarative plugin panels (PER-45) — controller (Svelte 5 runes singleton).
//
// A plugin manifest MAY declare `panels: PluginPanel[]`, each a small,
// DECLARATIVE surface built from a FIXED widget vocabulary GitCat itself
// renders — heading / text / button / command-output (see `PanelItem` in the
// bindings). There is NO plugin CODE here: a `button` or `command-output`
// widget only ever names an existing command id WITHIN THE SAME plugin, and
// the sole thing this controller does with it is call the SAME declarative
// backend path PER-42 already uses — `commands.runPluginCommand(pluginId,
// commandId, ctx)`. Nothing on this side ever sees, evals, or expands the
// manifest's `run` shell template; the Rust side alone does that (identical
// trust boundary to plugincommands.svelte.ts). This keeps GitCat's
// AI-agnostic / "we only ever run a user-configured external command"
// contract intact.
//
// This file is a sibling of plugincommands.svelte.ts and mirrors its two
// seams:
//   (a) it turns each declared panel into ONE `ActionItem` (the exact shape
//       cmdk's static ACTIONS use) so a panel opens straight from ⌘K, and
//   (b) it owns a real `.scrim`/`.modal` (PluginPanel.svelte) that renders the
//       panel's widgets.
//
// Import-cycle note (same discipline plugincommands already established):
// cmdk imports THIS module at runtime, so `ActionItem` is imported TYPE-ONLY
// (erased at compile, nothing dereferences cmdk at module-eval time), and the
// palette is notified of a registry reload via a settable `onActionsChanged`
// callback rather than a direct cmdkCtrl import. `parseTamaReaction` is reused
// from plugincommands (a plain pure function; plugincommands imports neither
// this module nor cmdk at runtime, so there is no cycle).

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";
import { t } from "@/i18n/i18n.svelte.ts";
import { parseTamaReaction, pluginCommandsCtrl } from "../plugincommands/plugincommands.svelte.ts";
import type { Plugin, PluginPanel, PlaceholderCtx } from "../../ipc/bindings";
import type { ActionItem } from "../cmdk/cmdk.svelte.ts";

// The live render state of a single `command-output` widget: its captured
// stdout, whether a run is in flight (spinner), and an error banner when the
// run couldn't start / exited non-zero. Keyed by the item's INDEX within the
// panel so two command-output widgets that happen to name the same command id
// stay independently addressable/re-runnable.
export type PanelOutput = { running: boolean; text: string; error: string | null };

class PluginPanelsState {
  // ── palette seam (cmdk reads `actions`; see file header) ─────────────────
  // Rebuilt whole on every (re)load, never mutated in place — same contract as
  // plugincommands' own `actions`.
  actions = $state<ActionItem[]>([]);
  loaded = $state(false);
  private loading: Promise<void> | null = null;

  // cmdk wires this after constructing its singleton so a force reload()
  // re-runs the open palette's filter (a panel appears/disappears the moment a
  // plugin is installed/enabled/removed, without reopening ⌘K). A settable
  // callback, NOT a cmdkCtrl import, to avoid the runtime cycle the type-only
  // ActionItem import already dodges.
  onActionsChanged: (() => void) | null = null;

  // The enabled plugin manifests last read, kept so openPanel() can resolve a
  // panel definition (and the plugin's display name) without a second fetch.
  // Plain field (not $state) — read only at action-build / open time, never
  // rendered directly.
  private plugins: Plugin[] = [];

  // ── modal state (PluginPanel.svelte renders these) ───────────────────────
  // Boolean `open` matches every other GitCat modal's `class:on={ctrl.open}`
  // idiom; the panel-opening METHOD is `openPanel()` (a JS class can't own both
  // a field and a method named `open`, so this mirrors the codebase's
  // universal field-`open` + opener-method convention — Reflog/Plumbing/
  // Settings all use `.open` + `show()`).
  open = $state(false);
  pluginId = $state("");
  pluginName = $state("");
  panel = $state<PluginPanel | null>(null);
  // Curious while browsing a panel — same lazy-init-to-"" convention every
  // other controller's tamaImg uses (a field initializer can't safely read
  // bridge.TAMA_IMG at this singleton's construction time; set for real in
  // openPanel()).
  tamaImg = $state("");
  // Per-`command-output`-widget state, keyed by item index (see PanelOutput).
  outputs = $state<Record<number, PanelOutput>>({});
  // Which button command ids are currently running — disables just that
  // button and shows its spinner (same one-target-at-a-time shape as
  // settings' savingConfigKey).
  runningButtons = $state<Record<string, boolean>>({});

  // ── lazy load / force reload (identical machinery to plugincommands) ──────
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

  // Force a fresh read (plugin registry changed) and notify the palette. Shares
  // the in-flight `loading` slot with ensureLoaded() so a force reload can't
  // race a lazy one on `actions`; load() swallows its own errors, so awaiting
  // it never throws.
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
    this.onActionsChanged?.();
  }

  private async load(): Promise<void> {
    // Design mode (plain browser) has no plugin backend — no panels is the
    // correct, non-confusing demo state (same discipline as plugincommands /
    // settings' Plugins tab).
    if (!IN_TAURI) {
      this.plugins = [];
      this.actions = [];
      this.loaded = true;
      return;
    }
    try {
      const res = await commands.listPlugins();
      const list = res.status === "ok" ? res.data : [];
      this.plugins = list;
      this.actions = this.build(list);
    } catch {
      // A failed registry read must never break the palette — the static
      // ACTIONS still work; plugin panels simply stay absent this session.
      this.plugins = [];
      this.actions = [];
    }
    this.loaded = true;
  }

  // Keep ENABLED plugins (enabled defaults to true when a manifest omits it),
  // and turn EACH declared panel into one palette entry. `panels` is
  // `#[serde(default)]` on the backend, so a manifest with none contributes
  // nothing (the `?? []` also tolerates a pre-panels registry pre-regen).
  private build(plugins: Plugin[]): ActionItem[] {
    const out: ActionItem[] = [];
    for (const p of plugins) {
      if (p.enabled === false) continue;
      for (const panel of p.panels ?? []) {
        out.push({
          type: "action",
          id: `plugin-panel:${p.id}:${panel.id}`,
          label: panel.title,
          hint: `Plugin panel · ${p.name}`,
          run: () => this.openPanel(p.id, panel.id),
        });
      }
    }
    return out;
  }

  // Open a panel by (pluginId, panelId): resolve its definition from the last
  // loaded registry, seed the modal, and kick off every `command-output`
  // widget's run. Named openPanel() rather than open() — see the `open` field's
  // own doc above.
  openPanel(pluginId: string, panelId: string): void {
    const p = this.plugins.find((pl) => pl.id === pluginId && pl.enabled !== false);
    const panel = p?.panels?.find((pn) => pn.id === panelId) ?? null;
    if (!p || !panel) {
      // The registry changed out from under an already-open palette (plugin
      // removed/disabled between listing and clicking) — fail soft.
      bridge.tama.warn(t("pluginpanels.gone"));
      return;
    }
    this.pluginId = pluginId;
    this.pluginName = p.name;
    this.panel = panel;
    this.outputs = {};
    this.runningButtons = {};
    this.tamaImg = bridge.TAMA_IMG.curious;
    this.open = true;
    // Run each command-output widget on open. forEach index is the stable key
    // the view reads back via outputs[i] and re-run passes to runCommandOutput.
    panel.items.forEach((item, i) => {
      if (item.type === "command-output") void this.runCommandOutput(i);
    });
  }

  close(): void {
    this.open = false;
  }

  // Repo-only placeholder context — the declarative path expands the command's
  // OWN template against this on the backend. Panels carry no per-widget
  // commit/file selection, so (unlike plugincommands.invoke's `commit`-context
  // sha gathering) this is deliberately just the open repo. Read CUR_REPO at
  // call time (live binding — never destructured).
  private ctx(): PlaceholderCtx {
    const repo = bridge.CUR_REPO as unknown as string | null;
    return { repo: repo ?? null, sha: null, file: null, files: [], diff: null, branch: null, ref: null };
  }

  private setOutput(index: number, value: PanelOutput): void {
    this.outputs = { ...this.outputs, [index]: value };
  }

  // Run (or re-run) the `command-output` widget at `index` and capture its
  // stdout into the reactive `outputs` map for the <pre> to show. UNLIKE a
  // button, this surface is INLINE — the stdout is shown verbatim, not routed
  // through Tama — though a valid PER-46 directive in the output may still
  // nudge Tama's mood (purely additive; the safe allowlist means no
  // safety-critical pose is reachable — see parseTamaReaction).
  async runCommandOutput(index: number): Promise<void> {
    const panel = this.panel;
    if (!panel) return;
    const item = panel.items[index];
    if (!item || item.type !== "command-output") return;
    const pluginId = this.pluginId;

    this.setOutput(index, { running: true, text: "", error: null });

    if (!IN_TAURI) {
      // Design-mode preview: no backend to run against.
      this.setOutput(index, { running: false, text: t("pluginpanels.demo_output", { command: item.command }), error: null });
      return;
    }

    try {
      const res = await commands.runPluginCommand(pluginId, item.command, this.ctx());
      if (res.status !== "ok") {
        this.setOutput(index, { running: false, text: "", error: String(res.error ?? t("pluginpanels.err_command_failed")) });
        return;
      }
      const out = res.data;
      const reaction = parseTamaReaction(out.stdout || "");
      if (reaction) {
        bridge.tama.set(reaction.state);
        bridge.tama.say(reaction.message);
      }
      this.setOutput(index, {
        running: false,
        text: out.stdout ?? "",
        // Show the stdout regardless; a non-zero exit adds a small note beside
        // it rather than replacing the (often still useful) output.
        error: out.success ? null : t("pluginpanels.exited", { code: out.exitCode ?? t("pluginpanels.on_a_signal") }),
      });
    } catch (e) {
      this.setOutput(index, { running: false, text: "", error: t("pluginpanels.err_command_failed_detail", { err: String(e) }) });
    }
  }

  // Run a `button` widget's command. It only ever names an existing command id
  // within THIS plugin, and this is the SAME declarative call plugincommands
  // makes — delegated to pluginCommandsCtrl.invoke() so success/failure surface
  // through Tama EXACTLY like a ⌘K plugin command (PER-46 reactions, non-zero
  // warn, !IN_TAURI demo, missing-repo guard — all reused, nothing duplicated).
  // The `runningButtons` marker is purely the panel's own busy/spinner state.
  async runButton(pluginId: string, command: string): Promise<void> {
    this.runningButtons = { ...this.runningButtons, [command]: true };
    try {
      await pluginCommandsCtrl.invoke(pluginId, command);
    } finally {
      const next = { ...this.runningButtons };
      delete next[command];
      this.runningButtons = next;
    }
  }
}

export const pluginPanelsCtrl = new PluginPanelsState();
