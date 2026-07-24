// Pluggable external diff/merge tools (backlog #12) — settings-modal
// controller (Svelte 5 runes singleton) PLUS `openDiff()`, the one call site
// Detail.svelte's file-tree row and Workdir.svelte's staged/unstaged rows all
// use directly for their own "Open in external diff" button — same
// "peer-island singleton with a single openFor-style entry point" shape
// blame.svelte.ts/filehistory.svelte.ts already establish (see e.g.
// Workdir.svelte's own direct `blameCtrl.openFor(...)` call sites) rather
// than routing through detailCtrl/workdirCtrl themselves: opening a diff tool
// touches nothing about either controller's own state.
//
// App-level (NOT per-repo) settings — same "reachable at any time, no
// CUR_REPO needed" shape dashboard.svelte.ts's own header doc describes for
// THAT modal: `get_tool_settings`/`set_tool_settings` (tool_settings.rs) take
// no repo path at all, so `show()`/`save()` below never read bridge.CUR_REPO
// either. Resolver.svelte's "Resolve with external tool" button, and every
// diff-tool button, DO still pass a repo — that's the file/commit CONTEXT the
// action is scoped to, not this settings modal's own data.
//
// Whole-form overwrite on Save (mirrors `set_tool_settings`'s own contract:
// the settings modal always submits both slots at once) — there is no
// per-field autosave and no read-modify-write dance needed here, unlike e.g.
// remotes.svelte.ts's four independent mutations against one list.
//
// `openDiff()` is FIRE-AND-FORGET on the backend (see `open_diff_tool`'s own
// doc comment): this wrapper's only job is surfacing a clean refusal/error
// via Tama — there is nothing about repo state to refresh either way, so
// unlike `take()`/`resolveConflictWithExternalTool` there is no `busy` lock
// or follow-up `refresh()` here.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";
import type { ExternalTool, ToolSettings } from "../../ipc/bindings";

class ExternalToolsState {
  open = $state(false);
  loading = $state(false); // getToolSettings() in flight
  saving = $state(false); // setToolSettings() in flight
  error = $state("");
  demo = $state(false);

  // Flat name/cmd fields per slot rather than holding `ExternalTool | null`
  // directly — a plain two-`<input>` form needs two bindable strings per
  // tool; `toTool()` below reassembles the `ExternalTool | null` shape only
  // at Save time (blank name => the whole slot clears to `null`, exactly like
  // `normalize_tool`'s own contract on the backend — see tool_settings.rs).
  diffName = $state("");
  diffCmd = $state("");
  mergeName = $state("");
  mergeCmd = $state("");
  // A shell command that prints a commit message (e.g. `aicommit`,
  // `opencommit --dry-run`, a script). No name/charset constraint — it's an
  // arbitrary command, not a git-subsection tool name. GitCat runs it and drops
  // the output in the commit box; it connects to no AI itself.
  commitCmd = $state("");

  // Entry point (Tools menu / ⌘K). Always re-fetches — same "never trust
  // stale settings across a reopen" discipline as every other on-demand
  // modal in this app (rerere/remotes/reflog's own `show()`s).
  show(): void {
    this.open = true;
    void this.refresh();
  }

  close(): void {
    if (this.saving) return; // mid-save — same guard as every other modal's Close
    this.open = false;
  }

  private applySettings(s: ToolSettings): void {
    this.diffName = s.diffTool?.name ?? "";
    this.diffCmd = s.diffTool?.cmd ?? "";
    this.mergeName = s.mergeTool?.name ?? "";
    this.mergeCmd = s.mergeTool?.cmd ?? "";
    this.commitCmd = s.commitMsgCommand ?? "";
  }

  async refresh(): Promise<void> {
    this.error = "";
    if (!IN_TAURI) {
      // Design-mode preview: no backend to read from. Leaving the fields
      // exactly as blank as a genuine first run would be is itself a valid,
      // non-confusing demo state (an unconfigured settings form), so there is
      // no canned non-empty DEMO constant to seed here unlike e.g.
      // dashboard.svelte.ts's DEMO_ROWS.
      this.demo = true;
      return;
    }
    this.demo = false;
    this.loading = true;
    try {
      const res = await commands.getToolSettings();
      if (res.status === "ok") {
        this.applySettings(res.data);
      } else {
        this.error = String(res.error ?? "Could not load external tool settings.");
      }
    } catch (e) {
      this.error = "Could not load external tool settings — " + e;
    } finally {
      this.loading = false;
    }
  }

  // Blank name => `null` (clears the slot). Blank cmd => `null` (falls back
  // to git's own knowledge of `name`) — same two rules `normalize_tool`
  // itself enforces server-side; trimming here too just avoids a round trip
  // for the most common typo (leading/trailing whitespace).
  private toTool(name: string, cmd: string): ExternalTool | null {
    const n = name.trim();
    if (!n) return null;
    const c = cmd.trim();
    return { name: n, cmd: c || null };
  }

  async save(): Promise<void> {
    if (this.saving) return;
    if (!IN_TAURI || this.demo) {
      bridge.tama.say("This is where your external tool preferences would save (demo).");
      this.open = false;
      return;
    }
    this.saving = true;
    this.error = "";
    try {
      const res = await commands.setToolSettings(
        this.toTool(this.diffName, this.diffCmd),
        this.toTool(this.mergeName, this.mergeCmd),
        this.commitCmd.trim() || null,
      );
      if (res.status === "ok") {
        this.applySettings(res.data);
        bridge.tama.say("External tool preferences saved.");
        this.open = false;
      } else {
        this.error = String(res.error ?? "Could not save external tool settings.");
      }
    } catch (e) {
      this.error = "Could not save external tool settings — " + e;
    } finally {
      this.saving = false;
    }
  }

  // "Open in external diff" — see module doc for why this is a direct
  // singleton call rather than something routed through detailCtrl/
  // workdirCtrl. `staged`/a rev range are mutually exclusive at the backend
  // (see `open_diff_tool`'s own doc) — callers pass exactly one shape:
  //   * workdir UNSTAGED row: `staged=false, fromRev=null, toRev=null`
  //   * workdir STAGED row:   `staged=true,  fromRev=null, toRev=null`
  //   * a historical commit's file (Detail.svelte): `staged=false,
  //     fromRev=<sha>^, toRev=<sha>` — reproduces that commit's own diff for
  //     EVERY file status (A/M/D/R/T/C), no per-status special case needed
  //     (see tool_settings.rs's module doc).
  async openDiff(repo: string, file: string, staged: boolean, fromRev: string | null = null, toRev: string | null = null): Promise<void> {
    if (!IN_TAURI) {
      bridge.tama.say("This is where " + file + " would open in your external diff tool (demo).");
      return;
    }
    try {
      const res = await commands.openDiffTool(repo, file, staged, fromRev, toRev);
      if (res.status === "error") {
        bridge.tama.warn(String(res.error ?? "Could not open the external diff tool."));
      }
    } catch (e) {
      bridge.tama.warn("Could not open the external diff tool — " + e);
    }
  }
}

export const externalToolsCtrl = new ExternalToolsState();
