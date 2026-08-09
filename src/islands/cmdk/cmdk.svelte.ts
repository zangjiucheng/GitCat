// ⌘K command palette — controller (Svelte 5 runes singleton).
//
// Fuzzy-searches commits + refs already loaded into the canvas's own graph
// state (`bridge.G`/`bridge.BACKEND`) — there is no dedicated backend command,
// this is pure frontend logic over data `load_graph`/`list_refs` already
// fetched elsewhere. Jumping to a result reaches directly into the canvas's
// scroll/select state through the bridge, the same "island pokes the shared
// canvas state" shape bisect/resolver already use.
//
// ACTIONS below are a second, much smaller result kind: the 4 tools that used
// to live in a permanent bottom drawer (Bisect/Reflog/Rerere/Plumbing — see
// index.html's own doc comment on the removed DRAWER section) and are now
// also reachable from here, same peer-island-import precedent
// bisectdrawer.svelte.ts already established (see that file's own doc
// comment) rather than routing through legacy/bridge.ts.

import * as bridge from "../../legacy/bridge";
import { reflogCtrl } from "../reflog/reflog.svelte.ts";
import { vimnavCtrl } from "../vimnav/vimnav.svelte.ts";
import { rerereCtrl } from "../rerere/rerere.svelte.ts";
import { plumbing } from "../plumbing/plumbing.svelte.ts";
import { repoSummaryCtrl } from "../reposummary/reposummary.svelte.ts";
import { remotesCtrl } from "../remotes/remotes.svelte.ts";
import { resolver } from "../resolver/resolver.svelte.ts";
import { forcePushCtrl } from "../forcepush/forcepush.svelte.ts";
import { resetHeadCtrl } from "../resethead/resethead.svelte.ts";
import { sidebarCtrl } from "../sidebar/sidebar.svelte.ts";
import { exportPatchesCtrl } from "../exportpatches/exportpatches.svelte.ts";
import { applyPatchCtrl } from "../applypatch/applypatch.svelte.ts";
import { terminalCtrl } from "../terminal/terminal.svelte.ts";
import { pickaxeSearchCtrl } from "../pickaxesearch/pickaxesearch.svelte.ts";
import { codeSearchCtrl } from "../codesearch/codesearch.svelte.ts";
import { openBisectEntry } from "../bisectdrawer/bisectdrawer.svelte.ts";
import { dashboardCtrl } from "../dashboard/dashboard.svelte.ts";
import { externalToolsCtrl } from "../externaltools/externaltools.svelte.ts";
import { pluginsCtrl } from "../plugins/plugins.svelte.ts";
import { settingsCtrl } from "../settings/settings.svelte.ts";
import { danglingRecoveryCtrl } from "../danglingrecovery/danglingrecovery.svelte.ts";
import { repoFilesCtrl } from "../repofiles/repofiles.svelte.ts";
import { filterRepoCtrl } from "../filterrepo/filterrepo.svelte.ts";
import { multimergeCtrl } from "../multimerge/multimerge.svelte.ts";
import { aboutCtrl } from "../about/about.svelte.ts";
import { updaterCtrl } from "../updater/updater.svelte.ts";
import { pluginCommandsCtrl } from "../plugincommands/plugincommands.svelte.ts";
import { pluginPanelsCtrl } from "../pluginpanels/pluginpanels.svelte.ts";
import { IN_TAURI } from "../../ipc/env";
import { t } from "@/i18n/i18n.svelte.ts";
import { commands } from "../../ipc/bindings";

export const CMD_CAP = 50;
const CMD_BUF = 250;
const REF_DEFAULT = 12;

type CmdItem = { type: "commit"; row: number; subject: string; sha: string; author: string; hay: string };
// `hidden` = a branch/remote that EXISTS but isn't currently loaded into the
// graph (unchecked in the sidebar's branch-visibility). It has no row; picking it
// makes it visible instead of jumping (see jump()).
type RefItem = { type: "ref"; name: string; kind: string; row: number; sha: string; hidden?: boolean };
// Exported so the plugin-commands controller can build entries of this exact
// shape (plugincommands.svelte.ts imports it type-only, to avoid a runtime
// import cycle with this module).
export type ActionItem = { type: "action"; id: string; label: string; hint: string; run: () => void };
export type CmdkResult = CmdItem | RefItem | ActionItem;

// Backs the macOS-only "Install 'gitcat' command in PATH" action below. Writes
// a `code`-style launcher via the Rust command and reports the outcome as a
// Tama toast (the same say/warn pair the setup wizard and sidebar already use).
async function installGitcatCommand(): Promise<void> {
  try {
    const res = await commands.installCliShim();
    if (res.status === "ok") {
      bridge.tama.say(
        `Installed the gitcat command at ${res.data}. Open a new terminal and run gitcat . inside any repo. にゃ〜`,
        6000,
      );
    } else {
      bridge.tama.warn(res.error || "Couldn't install the gitcat command.", 6000);
    }
  } catch (e) {
    bridge.tama.warn("Couldn't install the gitcat command. " + e, 6000);
  }
}

// Small and fixed — every entry always shown when the query is empty, or
// matched by label+hint the same way refs/commits are matched by their own
// text (see matchToks below). Built as a FUNCTION (not a module-level const)
// so each label/hint is translated with the CURRENT locale on every rebuild —
// filter() calls this, so a language switch is reflected the next time the
// palette filters (i.e. the next open / keystroke).
function buildActions(): ActionItem[] {
  return [
  { type: "action", id: "bisect", label: t("cmdk.bisect"), hint: t("cmdk.bisect_h"), run: () => openBisectEntry() },
  {
    type: "action",
    id: "reflog",
    label: t("cmdk.reflog"),
    hint: t("cmdk.reflog_h"),
    run: () => reflogCtrl.show(bridge.CUR_REPO as unknown as string),
  },
  {
    type: "action",
    id: "rerere",
    label: t("cmdk.rerere"),
    hint: t("cmdk.rerere_h"),
    run: () => rerereCtrl.show(bridge.CUR_REPO as unknown as string),
  },
  { type: "action", id: "plumbing", label: t("cmdk.plumbing"), hint: t("cmdk.plumbing_h"), run: () => plumbing.show() },
  {
    type: "action",
    id: "repo-summary",
    label: t("cmdk.repo_summary"),
    hint: t("cmdk.repo_summary_h"),
    run: () => repoSummaryCtrl.show(bridge.CUR_REPO as unknown as string),
  },
  {
    type: "action",
    id: "uncommitted-changes",
    label: t("cmdk.uncommitted"),
    hint: t("cmdk.uncommitted_h"),
    run: () => bridge.goToUncommitted(),
  },
  {
    type: "action",
    id: "goto-head",
    label: t("cmdk.goto_head"),
    hint: t("cmdk.goto_head_h"),
    run: () => bridge.goToHead(),
  },
  {
    type: "action",
    id: "focus-mode",
    label: t("cmdk.focus_mode"),
    hint: t("cmdk.focus_mode_h"),
    run: () => bridge.toggleFocusMode(),
  },
  {
    type: "action",
    id: "shortcuts",
    label: t("cmdk.shortcuts"),
    hint: t("cmdk.shortcuts_h"),
    run: () => vimnavCtrl.openHelp(),
  },
  {
    type: "action",
    id: "help",
    label: t("cmdk.help"),
    hint: t("cmdk.help_h"),
    run: () => bridge.openHelpPage(),
  },
  {
    type: "action",
    id: "remotes",
    label: t("cmdk.remotes"),
    hint: t("cmdk.remotes_h"),
    run: () => remotesCtrl.show(bridge.CUR_REPO as unknown as string),
  },
  {
    type: "action",
    id: "export-patches",
    label: t("cmdk.export_patches"),
    hint: t("cmdk.export_patches_h"),
    run: () => exportPatchesCtrl.show(bridge.CUR_REPO as unknown as string),
  },
  {
    type: "action",
    id: "apply-patch",
    label: t("cmdk.apply_patch"),
    hint: t("cmdk.apply_patch_h"),
    run: () => applyPatchCtrl.applyPatch(bridge.CUR_REPO as unknown as string),
  },
  {
    type: "action",
    id: "pickaxe-search",
    label: t("cmdk.pickaxe"),
    hint: t("cmdk.pickaxe_h"),
    run: () => pickaxeSearchCtrl.show(bridge.CUR_REPO as unknown as string),
  },
  {
    type: "action",
    id: "author-search",
    label: t("cmdk.author_search"),
    hint: t("cmdk.author_search_h"),
    run: () => pickaxeSearchCtrl.showAuthor(bridge.CUR_REPO as unknown as string),
  },
  {
    type: "action",
    id: "code-search",
    label: t("cmdk.code_search"),
    hint: t("cmdk.code_search_h"),
    run: () => codeSearchCtrl.show(bridge.CUR_REPO as unknown as string),
  },
  // Multi-repository dashboard (backlog #11): the ONE action here that does
  // NOT read/forward bridge.CUR_REPO at all — unlike every other entry above,
  // it's reachable whether or not a repo is currently open (see
  // dashboard.svelte.ts's own header doc).
  {
    type: "action",
    id: "repositories",
    label: t("cmdk.repositories"),
    hint: t("cmdk.repositories_h"),
    run: () => dashboardCtrl.show(),
  },
  // Pluggable external diff/merge tools (backlog #12): like Repositories just
  // above, this is a repo-independent settings modal — no `bridge.CUR_REPO`
  // forwarded (see externaltools.svelte.ts's own header doc).
  {
    type: "action",
    id: "external-tools",
    label: t("cmdk.external_tools"),
    hint: t("cmdk.external_tools_h"),
    run: () => externalToolsCtrl.show(),
  },
  // Plugins manager — app-level like External Tools (no repo needed), its own
  // VS Code Extensions-style view (see plugins.svelte.ts).
  {
    type: "action",
    id: "plugins",
    label: t("cmdk.plugins"),
    hint: t("cmdk.plugins_h"),
    run: () => pluginsCtrl.show(),
  },
  // App Settings: theme/cherry-pick-default/auto-update-check prefs plus a
  // Git Identity section — repo-scoped like Reflog/Rerere (forwards
  // bridge.CUR_REPO) since that identity section needs to know which repo,
  // even though the modal itself is reachable with no repo open too.
  {
    type: "action",
    id: "settings",
    label: t("cmdk.settings"),
    hint: t("cmdk.settings_h"),
    run: () => settingsCtrl.show(bridge.CUR_REPO as unknown as string),
  },
  // fsck-based dangling-object recovery (backlog #13): repo-scoped like
  // Reflog/Rerere above (forwards bridge.CUR_REPO), NOT repo-independent like
  // Repositories/External Tools.
  {
    type: "action",
    id: "dangling-recovery",
    label: t("cmdk.dangling"),
    hint: t("cmdk.dangling_h"),
    run: () => danglingRecoveryCtrl.show(bridge.CUR_REPO as unknown as string),
  },
  // .gitignore / .mailmap in-app editors (backlog #14, the FINAL backlog
  // item): repo-scoped like Reflog/Rerere/Dangling Commits above, NOT
  // repo-independent like Repositories/External Tools.
  {
    type: "action",
    id: "repo-files",
    label: t("cmdk.repo_files"),
    hint: t("cmdk.repo_files_h"),
    run: () => repoFilesCtrl.show(bridge.CUR_REPO as unknown as string),
  },
  // Multi-branch merge (octopus or sequential — see multimerge.svelte.ts's
  // own header doc): repo-global like Pickaxe/Dangling Commits above (not
  // tied to any one branch's own context menu), so it lives here rather than
  // a per-branch-row menu item.
  {
    type: "action",
    id: "multi-merge",
    label: t("cmdk.multi_merge"),
    hint: t("cmdk.multi_merge_h"),
    run: () => multimergeCtrl.show(bridge.CUR_REPO as unknown as string),
  },
  {
    type: "action",
    id: "pull-merge",
    label: t("cmdk.pull_merge"),
    hint: t("cmdk.pull_merge_h"),
    run: () => resolver.pullMerge(bridge.CUR_REPO as unknown as string),
  },
  {
    type: "action",
    id: "pull-rebase",
    label: t("cmdk.pull_rebase"),
    hint: t("cmdk.pull_rebase_h"),
    run: () => resolver.pullRebase(bridge.CUR_REPO as unknown as string),
  },
  {
    type: "action",
    id: "open-terminal",
    label: t("cmdk.open_terminal"),
    hint: t("cmdk.open_terminal_h"),
    run: () => terminalCtrl.toggle(bridge.CUR_REPO as unknown as string),
  },
  {
    type: "action",
    id: "reset-head",
    label: t("cmdk.reset_head"),
    hint: t("cmdk.reset_head_h"),
    run: () => resetHeadCtrl.promptForHash(bridge.CUR_REPO as unknown as string),
  },
  {
    type: "action",
    id: "force-push-lease",
    label: t("cmdk.force_push_lease"),
    hint: t("cmdk.force_push_lease_h"),
    run: () => forcePushCtrl.forcePushLease(bridge.CUR_REPO as unknown as string),
  },
  {
    type: "action",
    id: "force-push-override",
    label: t("cmdk.force_push_override"),
    hint: t("cmdk.force_push_override_h"),
    run: () => forcePushCtrl.forcePushOverride(bridge.CUR_REPO as unknown as string),
  },
  // git-filter-repo (backlog M5c): used to be its own permanent red topbar
  // button, the one Tools-worthy feature that wasn't reachable from here —
  // now consistent with every action above it. IN_TAURI branch mirrors the
  // old #filterRepoBtn click handler / menu.rs's "filter-repo" case in
  // src/main.ts (filterRepoCtrl.start() doc comment: this decision belongs
  // to the caller, not the controller).
  {
    type: "action",
    id: "filter-repo",
    label: t("cmdk.filter_repo"),
    hint: t("cmdk.filter_repo_h"),
    run: () => (IN_TAURI ? filterRepoCtrl.start(bridge.CUR_REPO as unknown as string) : filterRepoCtrl.openDemo()),
  },
  // Opens the SAME in-app About panel the update check/install UI lives in
  // (see about.svelte.ts + islands/updater) — mirrors menu.rs's
  // "check-for-updates" item exactly (see src/main.ts's own case for it):
  // open About, then immediately kick off a check.
  {
    type: "action",
    id: "check-for-updates",
    label: t("cmdk.check_updates"),
    hint: t("cmdk.check_updates_h"),
    run: () => {
      aboutCtrl.show();
      updaterCtrl.check();
    },
  },
  // "Install 'gitcat' command in PATH" — macOS/Linux/Windows, the way VS Code
  // puts its own `code` installer in the palette. Hidden in browser design mode
  // (no backend), where install_cli_shim could only return an error.
  ...(IN_TAURI
    ? [
        {
          type: "action",
          id: "install-cli",
          label: t("cmdk.install_cli"),
          hint: t("cmdk.install_cli_h"),
          run: () => void installGitcatCommand(),
        } as ActionItem,
      ]
    : []),
  ];
}

function esc(s: unknown): string {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
}

export const shortSha = (s: unknown) => String(s || "").slice(0, 8);

function matchToks(hay: string, toks: string[]): boolean {
  for (let i = 0; i < toks.length; i++) if (hay.indexOf(toks[i]) < 0) return false;
  return true;
}

class CmdkState {
  open = $state(false);
  query = $state("");
  results = $state<CmdkResult[]>([]);
  toks = $state<string[]>([]);
  sel = $state(0);

  private items: CmdItem[] = [];
  private refs: RefItem[] = [];
  private cacheG: unknown = null;

  private buildCmdIndex(): CmdItem[] {
    const out: CmdItem[] = [];
    const G: any = bridge.G,
      BACKEND: any = bridge.BACKEND;
    const N = G ? G.N : 0;
    for (let r = 0; r < N; r++) {
      let subject: string, sha: string, author: string;
      if (BACKEND) {
        const m = BACKEND.rows[r];
        if (!m) continue;
        subject = m.subject;
        sha = m.sha;
        author = (m.an && m.an.n) || "";
      } else {
        subject = bridge.msgOf(r);
        sha = bridge.hhex(r);
        author = bridge.AUTHORS[(Math.imul(r, 2654435761) >>> 5) % bridge.AUTHORS.length].n;
      }
      out.push({ type: "commit", row: r, subject, sha, author, hay: (subject + " " + sha + " " + author).toLowerCase() });
    }
    return out;
  }

  private buildRefIndex(): RefItem[] {
    const seen = new Set<string>();
    const out: RefItem[] = [];
    const G: any = bridge.G,
      BACKEND: any = bridge.BACKEND;
    const N = G ? G.N : 0;
    const norm = (t: string) => (t === "tag" ? "tag" : t === "remote" ? "remote" : t === "head" ? "head" : "branch");
    if (BACKEND) {
      for (let r = 0; r < N; r++) {
        const m = BACKEND.rows[r];
        if (!m || !m.refs) continue;
        for (const rf of m.refs) {
          if (!rf || seen.has(rf.n)) continue;
          seen.add(rf.n);
          out.push({ type: "ref", name: rf.n, kind: norm(rf.t), row: r, sha: m.sha });
        }
      }
    } else {
      out.push({ type: "ref", name: "HEAD", kind: "head", row: 0, sha: bridge.hhex(0) });
      seen.add("HEAD");
      for (let r = 0; r < N; r++) {
        const g = G.refs[r];
        if (!g || seen.has(g.label)) continue;
        seen.add(g.label);
        out.push({ type: "ref", name: g.label, kind: norm(g.kind), row: r, sha: bridge.hhex(r) });
      }
    }
    // Also index branches/remotes that EXIST but aren't loaded into the graph —
    // i.e. unchecked in the sidebar's branch-visibility filter. Without this, a
    // hidden branch is unsearchable; here it shows up in ⌘K and picking it makes
    // it visible (jump() handles the `hidden` flag). `seen` already holds every
    // loaded ref, so only the genuinely-hidden ones get added.
    try {
      for (const b of sidebarCtrl.locals) {
        if (!b || seen.has(b.name)) continue;
        seen.add(b.name);
        out.push({ type: "ref", name: b.name, kind: "branch", row: -1, sha: b.sha || "", hidden: true });
      }
      for (const r of sidebarCtrl.remotes) {
        if (!r || seen.has(r.name)) continue;
        seen.add(r.name);
        out.push({ type: "ref", name: r.name, kind: "remote", row: -1, sha: (r as { sha?: string }).sha || "", hidden: true });
      }
    } catch {
      /* sidebar not ready yet — the loaded refs above still work */
    }
    return out;
  }

  private cmdScore(it: CmdItem, toks: string[]): number {
    let s = 0;
    const subj = it.subject.toLowerCase(),
      sha = it.sha.toLowerCase();
    for (const t of toks) {
      if (sha.startsWith(t)) s -= 60;
      if (subj.startsWith(t)) s -= 25;
      const p = it.hay.indexOf(t);
      s += p < 0 ? 300 : p;
    }
    return s + it.row * 0.001;
  }

  // Escape-and-highlight the first token match in `text` (recursive, mirrors
  // the legacy hlEsc). Used by the view for both commit/ref rows.
  hl(text: unknown, toks: string[] = this.toks): string {
    const str = String(text);
    if (!toks.length) return esc(str);
    const low = str.toLowerCase();
    let at = -1,
      len = 0;
    for (const t of toks) {
      const i = low.indexOf(t);
      if (i >= 0 && (at < 0 || i < at)) {
        at = i;
        len = t.length;
      }
    }
    if (at < 0) return esc(str);
    return esc(str.slice(0, at)) + "<mark>" + esc(str.slice(at, at + len)) + "</mark>" + this.hl(str.slice(at + len), toks);
  }

  filter(q: string) {
    this.query = q;
    const trimmed = (q || "").trim().toLowerCase();
    const toks = trimmed ? trimmed.split(/\s+/) : [];
    this.toks = toks;
    const res: CmdkResult[] = [];
    for (const a of buildActions()) {
      if (!toks.length || matchToks((a.label + " " + a.hint).toLowerCase(), toks)) res.push(a);
    }
    // Plugin-contributed commands (PER-42) are matched by label+hint exactly
    // like the static ACTIONS above; they're lazily loaded on palette open
    // (see show()), so this is empty until listPlugins() resolves.
    for (const a of pluginCommandsCtrl.actions) {
      if (!toks.length || matchToks((a.label + " " + a.hint).toLowerCase(), toks)) res.push(a);
    }
    // Plugin-contributed PANELS (PER-45) — one entry per declared panel, matched
    // by label+hint exactly like the commands above and lazily loaded on the
    // same palette open (see show()).
    for (const a of pluginPanelsCtrl.actions) {
      if (!toks.length || matchToks((a.label + " " + a.hint).toLowerCase(), toks)) res.push(a);
    }
    if (!toks.length) {
      for (let i = 0; i < this.refs.length && res.length < REF_DEFAULT; i++) res.push(this.refs[i]);
    } else {
      for (let i = 0; i < this.refs.length && res.length < CMD_CAP; i++) {
        const rf = this.refs[i];
        if (matchToks(rf.name.toLowerCase(), toks)) res.push(rf);
      }
    }
    if (res.length < CMD_CAP) {
      const buf: CmdItem[] = [];
      for (let i = 0; i < this.items.length; i++) {
        const it = this.items[i];
        if (!toks.length) {
          buf.push(it);
          if (buf.length >= CMD_CAP) break;
        } else if (matchToks(it.hay, toks)) {
          buf.push(it);
          if (buf.length >= CMD_BUF) break;
        }
      }
      if (toks.length) buf.sort((a, b) => this.cmdScore(a, toks) - this.cmdScore(b, toks));
      for (let i = 0; i < buf.length && res.length < CMD_CAP; i++) res.push(buf[i]);
    }
    this.results = res;
    this.sel = 0;
  }

  get hasData(): boolean {
    const G: any = bridge.G;
    return !!(G && G.N);
  }

  setSel(i: number) {
    const n = this.results.length;
    if (!n) {
      this.sel = 0;
      return;
    }
    this.sel = ((i % n) + n) % n;
  }

  jump(it: CmdkResult | undefined) {
    if (!it) return;
    if (it.type === "action") {
      this.close();
      it.run();
      return;
    }
    if (it.type === "ref" && it.hidden) {
      // A hidden branch (unchecked in the sidebar) has no loaded row — make it
      // VISIBLE so it streams into the graph, rather than jumping to nothing.
      this.close();
      void sidebarCtrl.toggleBranchVisible(
        bridge.CUR_REPO as unknown as string,
        it.kind === "remote" ? "remote" : "local",
        it.name,
      );
      return;
    }
    const row = it.row;
    this.close();
    const G: any = bridge.G;
    if (row == null || row < 0 || !G || row >= G.N) return;
    // Position within the scrollable viewport BELOW the pinned "Uncommitted
    // changes" header (view.cssH-bandH()), not the full canvas height — see
    // legacy/main.ts's bandH() doc comment.
    bridge.state.scrollTarget = bridge.clampScroll(row * bridge.layout.rowH - (bridge.view.cssH - bridge.bandH()) * 0.4);
    bridge.select(row);
    try {
      bridge.cv.focus();
    } catch (_) {
      /* best-effort focus, never blocks the jump */
    }
  }

  show() {
    if (this.cacheG !== bridge.G) {
      this.items = this.buildCmdIndex();
      this.refs = this.buildRefIndex();
      this.cacheG = bridge.G;
    }
    this.open = true;
    this.filter("");
    // Lazily pull in plugin-contributed palette commands AND panels, then
    // re-run the current filter so they appear (both cached after the first
    // open). Two independent lazy loads, each re-filters when it resolves.
    void pluginCommandsCtrl.ensureLoaded().then(() => {
      if (this.open) this.filter(this.query);
    });
    void pluginPanelsCtrl.ensureLoaded().then(() => {
      if (this.open) this.filter(this.query);
    });
  }

  close() {
    this.open = false;
  }

  toggle() {
    this.open ? this.close() : this.show();
  }
}

export const cmdkCtrl = new CmdkState();

// Review nit: when the plugin registry is force-reloaded (install/enable/
// disable), refresh an already-open palette in place so the change shows up
// without reopening ⌘K. Wired here (not via a cmdkCtrl import inside
// plugincommands) to keep that module free of a runtime cycle back into this one.
pluginCommandsCtrl.onActionsChanged = () => {
  if (cmdkCtrl.open) cmdkCtrl.filter(cmdkCtrl.query);
};
// Same live-refresh seam for plugin PANELS (PER-45) — a force reload of the
// panel registry (install/enable/remove) re-filters an already-open palette in
// place. Wired here, not via a cmdkCtrl import inside pluginpanels, to keep
// that module free of a runtime cycle back into this one.
pluginPanelsCtrl.onActionsChanged = () => {
  if (cmdkCtrl.open) cmdkCtrl.filter(cmdkCtrl.query);
};
