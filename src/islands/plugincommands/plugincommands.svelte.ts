// Plugin commands in the ⌘K palette (PER-42) — controller (Svelte 5 runes
// singleton).
//
// The backend (commit 75c5708) owns everything about plugins: `list_plugins`
// returns the installed manifests, and `run_plugin_command(pluginId,
// commandId, ctx)` expands the command's placeholder TEMPLATE and shells out.
// This controller is purely the palette-facing seam: it turns the subset of
// plugin commands that ask to appear in the palette into the SAME
// `ActionItem` shape the static ACTIONS array in cmdk.svelte.ts already uses,
// and — critically — its `run` closure ONLY calls the backend command. It
// never sees, evals, or executes the manifest's `run` string itself; that
// string is a shell template the Rust side alone expands (same trust boundary
// as tool_settings.rs's diff/merge `cmd`). This keeps GitCat's AI-agnostic /
// "we only ever run a user-configured external command" contract intact.
//
// Same "peer-island singleton cmdk imports directly" precedent every other
// ⌘K action already establishes (bisectdrawer/reflog/etc). To avoid a runtime
// import cycle (cmdk imports THIS at runtime), the `ActionItem` shape is
// imported type-only — erased at compile, so nothing here dereferences cmdk at
// module-eval time.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";
import { t } from "../../i18n/i18n.svelte.ts";
import type { Plugin, PluginContext, PlaceholderCtx } from "../../ipc/bindings";
import type { ActionItem } from "../cmdk/cmdk.svelte.ts";

// ─── Plugin → Tama reaction protocol (PER-46) ────────────────────────────────
//
// A plugin command can nudge Tama's mood straight from its OWN stdout, WITHOUT
// a backend command and WITHOUT ever reaching GitCat's safety-critical poses.
//
// A command MAY print a directive line anywhere in stdout:
//
//     ::gitcat.tama <reaction> <message...>
//
// where <reaction> is ONLY one of a fixed SAFE allowlist. The mapping is a
// closed table — GitCat, not the plugin, decides which FSM state each reaction
// resolves to, and every target is a benign/informational pose:
//
//     info    → set("hint")       "here's something to know"
//     busy    → set("thinking")   "I'm working on it"
//     ok      → set("celebrate")  "that went well"
//     problem → set("confused")   "that didn't go well" (same pose warn() uses
//                                  for a real op FAILURE — NOT a caution)
//
// then `bridge.tama.say(<message>)` (trimmed + capped ~160 chars).
//
// GUARD RAILS — a plugin must NOT be able to impersonate a GitCat safety
// warning. The safety-critical states (`warn`/`danger`/`rescue`, every
// `mutation.*`, `undo.performed`) mean GitCat ITSELF flagged a destructive,
// rewrite, or undo situation. NONE of them are reachable here: only the four
// allowlisted tokens above map to a state. ANY other <reaction> token —
// `danger`, `warn`, `rescue`, `undo`, or arbitrary garbage — is IGNORED: no
// state change and no say from the directive. "Last matching line wins" counts
// only VALID (allowlisted) directives, so a plugin can't chase a real `ok` with
// a spoofed `danger` to flip the pose.
//
// The directive line(s) are stripped from the text Tama shows: a valid directive
// shows its own <message> instead of raw stdout; otherwise stray directive-shaped
// lines are removed before the default say/warn. No directive at all → behavior
// is exactly as before.

// SAFE allowlist: plugin reaction token → Tama FSM state. This closed table is
// the ONLY path from plugin stdout to a Tama state; anything not a key is
// rejected.
const TAMA_REACTIONS: Record<string, string> = {
  info: "hint",
  busy: "thinking",
  ok: "celebrate",
  problem: "confused",
};
const TAMA_DIRECTIVE_MAX = 160;
// Captures a syntactically-valid directive: <reaction token> then the message.
const TAMA_DIRECTIVE_RE = /^\s*::gitcat\.tama\s+(\S+)\s*(.*)$/;
// Any line that even LOOKS like a directive (valid reaction or not) — used only
// to keep such lines out of the normally-shown text.
const TAMA_DIRECTIVE_LINE = /^\s*::gitcat\.tama\b.*$/;

// PURE + exported for unit testing: scan stdout for the LAST directive line
// whose <reaction> is on the SAFE allowlist and return its mapped {state,
// message}, or null when no valid directive is present. Directive lines with an
// unrecognized reaction are ignored (they can neither win nor change state), so
// no plugin output can reach a safety-critical pose through this function.
export function parseTamaReaction(stdout: string): { state: string; message: string } | null {
  let result: { state: string; message: string } | null = null;
  for (const line of (stdout || "").split(/\r?\n/)) {
    const m = line.match(TAMA_DIRECTIVE_RE);
    if (!m) continue;
    const key = m[1].toLowerCase();
    // OWN-property check, NOT a truthiness test: a plain-object lookup resolves
    // inherited keys like "constructor"/"toString"/"hasOwnProperty" to truthy
    // prototype functions, which would let a bogus reaction slip past the safe
    // allowlist. hasOwnProperty.call gates on the four real keys only.
    if (!Object.prototype.hasOwnProperty.call(TAMA_REACTIONS, key)) continue;
    result = { state: TAMA_REACTIONS[key], message: capTamaMessage(m[2].trim()) };
  }
  return result;
}

// Trim to a one-liner Tama can actually show.
function capTamaMessage(s: string): string {
  return s.length > TAMA_DIRECTIVE_MAX ? s.slice(0, TAMA_DIRECTIVE_MAX - 1) + "…" : s;
}

// Remove every directive-shaped line (valid or not) from stdout so the default
// say/warn never echoes the raw `::gitcat.tama …` control line back to the user.
function stripTamaDirectives(stdout: string): string {
  return (stdout || "")
    .split(/\r?\n/)
    .filter((l) => !TAMA_DIRECTIVE_LINE.test(l))
    .join("\n");
}

class PluginCommandsState {
  // The palette-ready actions cmdk's filter() reads alongside its static
  // ACTIONS. Rebuilt whole on every (re)load — never mutated in place.
  actions = $state<ActionItem[]>([]);
  // Lazy-load gate: ensureLoaded() only ever hits the backend once; reload()
  // is the explicit force path (plugin install/enable/disable).
  loaded = $state(false);
  private loading: Promise<void> | null = null;

  // cmdk wires this after constructing its singleton (see cmdk.svelte.ts's
  // tail): a force reload() re-runs the open palette's filter so newly
  // installed/enabled plugin commands show up without reopening ⌘K. Kept as a
  // settable callback (not a direct cmdkCtrl import) specifically to avoid the
  // runtime import cycle the type-only ActionItem import already dodges.
  onActionsChanged: (() => void) | null = null;

  // Lazy + cached. Concurrent callers (e.g. two quick ⌘K opens) share the one
  // in-flight load.
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    const p = this.load();
    this.loading = p;
    try {
      await p;
    } finally {
      // Only clear the slot if it's still OURS — a concurrent reload() may have
      // installed its own load() in the meantime (see reload()).
      if (this.loading === p) this.loading = null;
    }
  }

  // Force a fresh read (plugin registry changed) and notify the palette. Shares
  // the in-flight `loading` slot with ensureLoaded() so a force reload can't run
  // load() concurrently with a lazy one (a last-write race on `actions`): wait
  // for any in-flight load first, then force exactly one fresh one. (load() is
  // infallible — it swallows its own errors — so awaiting it never throws.)
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
    // Design mode (plain browser) has no plugin backend — an empty palette is
    // the correct, non-confusing demo state (same discipline as every other
    // island's !IN_TAURI branch).
    if (!IN_TAURI) {
      this.actions = [];
      this.loaded = true;
      return;
    }
    try {
      const res = await commands.listPlugins();
      this.actions = res.status === "ok" ? this.build(res.data) : [];
    } catch {
      // A failed registry read must never break the palette — the static
      // ACTIONS still work; plugin actions simply stay absent this session.
      this.actions = [];
    }
    this.loaded = true;
  }

  // Keep ENABLED plugins (enabled defaults to true when a manifest omits it),
  // and only their commands whose placement reaches the palette ("palette" or
  // "both"; placement defaults to "palette" when omitted).
  private build(plugins: Plugin[]): ActionItem[] {
    const out: ActionItem[] = [];
    for (const p of plugins) {
      if (p.enabled === false) continue;
      for (const c of p.commands ?? []) {
        const placement = c.placement ?? "palette";
        if (placement !== "palette" && placement !== "both") continue;
        out.push({
          type: "action",
          id: `plugin:${p.id}:${c.id}`,
          label: c.label,
          hint: t("plugincommands.hint", { name: p.name }),
          run: () => void this.invoke(p.id, c.id, c.context),
        });
      }
    }
    return out;
  }

  // The one thing a palette entry does: call the backend command. Declarative
  // — this never touches the manifest's `run` template (the Rust side expands
  // it). Builds the PlaceholderCtx from what the bridge actually exposes: the
  // open repo always, plus the selected commit's sha for a `commit` command.
  // (The bridge exposes no selected-file state, so a `file` command falls back
  // to repo-only — see selectedSha's counterpart absence.)
  async invoke(pluginId: string, commandId: string, context?: PluginContext): Promise<void> {
    const repo = bridge.CUR_REPO as unknown as string | null;
    if (!repo) {
      bridge.tama.warn(t("plugincommands.open_repo_first"));
      return;
    }
    const ctx: PlaceholderCtx = { repo, sha: null, file: null, files: [], diff: null, branch: null, ref: null };
    if (context === "commit") {
      const sha = this.selectedSha();
      if (sha) ctx.sha = sha;
    }
    if (!IN_TAURI) {
      bridge.tama.say(t("plugincommands.demo_run"));
      return;
    }
    try {
      const res = await commands.runPluginCommand(pluginId, commandId, ctx);
      if (res.status !== "ok") {
        bridge.tama.warn(String(res.error ?? t("plugincommands.err_failed")));
        return;
      }
      const out = res.data;
      // A valid plugin reaction directive (PER-46) drives Tama through the
      // fixed SAFE table instead of the default surfacing — no safety-critical
      // pose is reachable this way (see parseTamaReaction). Applies on either
      // exit code: the plugin's declared mood wins, but only within the
      // allowlist.
      const reaction = parseTamaReaction(out.stdout || "");
      if (reaction) {
        bridge.tama.set(reaction.state);
        bridge.tama.say(reaction.message);
        return;
      }
      // No valid directive → current behavior, with any stray directive-shaped
      // lines stripped so a rejected/garbage `::gitcat.tama …` line is never
      // shown verbatim.
      const text = this.truncate(stripTamaDirectives(out.stdout || "").trim());
      if (out.success) {
        bridge.tama.say(text || t("plugincommands.finished"));
      } else {
        bridge.tama.warn(text || t("plugincommands.exited", { code: out.exitCode ?? t("plugincommands.on_a_signal") }));
      }
    } catch (e) {
      bridge.tama.warn(t("plugincommands.err_failed_detail", { err: String(e) }));
    }
  }

  // The currently-selected commit's sha, read from the same canvas state the
  // graph itself draws from (bridge.state.selectedRow -> bridge.BACKEND.rows).
  // Null when nothing (or the pinned "Uncommitted changes" row, -2) is
  // selected, or the row has no backing commit yet.
  private selectedSha(): string | null {
    try {
      const st = bridge.state as unknown as { selectedRow: number } | null;
      const row = st ? st.selectedRow : -1;
      if (row == null || row < 0) return null;
      const backend = bridge.BACKEND as unknown as { rows: Array<{ sha?: string }> } | null;
      const m = backend && backend.rows ? backend.rows[row] : null;
      return (m && m.sha) || null;
    } catch {
      return null;
    }
  }

  // Plugin stdout can be anything — collapse whitespace and cap it so Tama's
  // one-line nook stays a one-liner.
  private truncate(s: string, max = 160): string {
    const one = s.replace(/\s+/g, " ").trim();
    return one.length > max ? one.slice(0, max - 1) + "…" : one;
  }
}

export const pluginCommandsCtrl = new PluginCommandsState();
