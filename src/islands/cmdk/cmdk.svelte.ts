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
import { rerereCtrl } from "../rerere/rerere.svelte.ts";
import { plumbing } from "../plumbing/plumbing.svelte.ts";
import { repoSummaryCtrl } from "../reposummary/reposummary.svelte.ts";
import { remotesCtrl } from "../remotes/remotes.svelte.ts";
import { resolver } from "../resolver/resolver.svelte.ts";
import { forcePushCtrl } from "../forcepush/forcepush.svelte.ts";
import { exportPatchesCtrl } from "../exportpatches/exportpatches.svelte.ts";
import { applyPatchCtrl } from "../applypatch/applypatch.svelte.ts";
import { openTerminalCtrl } from "../openterminal/openterminal.svelte.ts";
import { pickaxeSearchCtrl } from "../pickaxesearch/pickaxesearch.svelte.ts";
import { openBisectEntry } from "../bisectdrawer/bisectdrawer.svelte.ts";
import { dashboardCtrl } from "../dashboard/dashboard.svelte.ts";
import { externalToolsCtrl } from "../externaltools/externaltools.svelte.ts";
import { settingsCtrl } from "../settings/settings.svelte.ts";
import { danglingRecoveryCtrl } from "../danglingrecovery/danglingrecovery.svelte.ts";
import { repoFilesCtrl } from "../repofiles/repofiles.svelte.ts";
import { filterRepoCtrl } from "../filterrepo/filterrepo.svelte.ts";
import { aboutCtrl } from "../about/about.svelte.ts";
import { updaterCtrl } from "../updater/updater.svelte.ts";
import { IN_TAURI } from "../../ipc/env";

export const CMD_CAP = 50;
const CMD_BUF = 250;
const REF_DEFAULT = 12;

type CmdItem = { type: "commit"; row: number; subject: string; sha: string; author: string; hay: string };
type RefItem = { type: "ref"; name: string; kind: string; row: number; sha: string };
type ActionItem = { type: "action"; id: string; label: string; hint: string; run: () => void };
export type CmdkResult = CmdItem | RefItem | ActionItem;

// Small and fixed — every entry always shown when the query is empty, or
// matched by label+hint the same way refs/commits are matched by their own
// text (see matchToks below).
const ACTIONS: ActionItem[] = [
  { type: "action", id: "bisect", label: "Bisect", hint: "Find the first bad commit", run: () => openBisectEntry() },
  {
    type: "action",
    id: "reflog",
    label: "Reflog",
    hint: "Browse and restore a historical HEAD",
    run: () => reflogCtrl.show(bridge.CUR_REPO as unknown as string),
  },
  {
    type: "action",
    id: "rerere",
    label: "Rerere",
    hint: "Recorded conflict-resolution status",
    run: () => rerereCtrl.show(bridge.CUR_REPO as unknown as string),
  },
  { type: "action", id: "plumbing", label: "Plumbing", hint: "Inspect a raw commit, tree, blob, or tag", run: () => plumbing.show() },
  {
    type: "action",
    id: "repo-summary",
    label: "Repository Summary",
    hint: "Churn hotspots, contributor ranking, monthly activity, problem areas",
    run: () => repoSummaryCtrl.show(bridge.CUR_REPO as unknown as string),
  },
  {
    type: "action",
    id: "uncommitted-changes",
    label: "Uncommitted Changes",
    hint: "Jump to the working tree — stage hunks or lines, then commit",
    run: () => bridge.goToUncommitted(),
  },
  {
    type: "action",
    id: "remotes",
    label: "Manage Remotes",
    hint: "Add, rename, edit the URL, or remove a configured remote",
    run: () => remotesCtrl.show(bridge.CUR_REPO as unknown as string),
  },
  {
    type: "action",
    id: "export-patches",
    label: "Export Patches",
    hint: "Export a commit range as a single .patch file (git format-patch)",
    run: () => exportPatchesCtrl.show(bridge.CUR_REPO as unknown as string),
  },
  {
    type: "action",
    id: "apply-patch",
    label: "Apply Patch",
    hint: "Apply a .patch file someone gave you (git am)",
    run: () => applyPatchCtrl.applyPatch(bridge.CUR_REPO as unknown as string),
  },
  {
    type: "action",
    id: "pickaxe-search",
    label: "Search Commit Content",
    hint: "Find commits whose diff touched a string or pattern (git log -S / -G)",
    run: () => pickaxeSearchCtrl.show(bridge.CUR_REPO as unknown as string),
  },
  // Multi-repository dashboard (backlog #11): the ONE action here that does
  // NOT read/forward bridge.CUR_REPO at all — unlike every other entry above,
  // it's reachable whether or not a repo is currently open (see
  // dashboard.svelte.ts's own header doc).
  {
    type: "action",
    id: "repositories",
    label: "Repositories",
    hint: "See every tracked repo's branch/status at a glance, and jump into one",
    run: () => dashboardCtrl.show(),
  },
  // Pluggable external diff/merge tools (backlog #12): like Repositories just
  // above, this is a repo-independent settings modal — no `bridge.CUR_REPO`
  // forwarded (see externaltools.svelte.ts's own header doc).
  {
    type: "action",
    id: "external-tools",
    label: "External Tools",
    hint: "Configure a diff/merge tool to open from GitCat's own UI",
    run: () => externalToolsCtrl.show(),
  },
  // App Settings: theme/cherry-pick-default/auto-update-check prefs plus a
  // Git Identity section — repo-scoped like Reflog/Rerere (forwards
  // bridge.CUR_REPO) since that identity section needs to know which repo,
  // even though the modal itself is reachable with no repo open too.
  {
    type: "action",
    id: "settings",
    label: "Settings",
    hint: "Theme, cherry-pick defaults, update checks, and this repo's git identity",
    run: () => settingsCtrl.show(bridge.CUR_REPO as unknown as string),
  },
  // fsck-based dangling-object recovery (backlog #13): repo-scoped like
  // Reflog/Rerere above (forwards bridge.CUR_REPO), NOT repo-independent like
  // Repositories/External Tools.
  {
    type: "action",
    id: "dangling-recovery",
    label: "Dangling Commits",
    hint: "Recover a commit no ref points to anymore (git fsck)",
    run: () => danglingRecoveryCtrl.show(bridge.CUR_REPO as unknown as string),
  },
  // .gitignore / .mailmap in-app editors (backlog #14, the FINAL backlog
  // item): repo-scoped like Reflog/Rerere/Dangling Commits above, NOT
  // repo-independent like Repositories/External Tools.
  {
    type: "action",
    id: "repo-files",
    label: "Repo Files",
    hint: "Edit .gitignore or .mailmap without leaving GitCat",
    run: () => repoFilesCtrl.show(bridge.CUR_REPO as unknown as string),
  },
  {
    type: "action",
    id: "pull-merge",
    label: "Pull (Merge)",
    hint: "Fetch, then merge the upstream branch into the current branch",
    run: () => resolver.pullMerge(bridge.CUR_REPO as unknown as string),
  },
  {
    type: "action",
    id: "pull-rebase",
    label: "Pull (Rebase)",
    hint: "Fetch, then rebase the current branch onto its upstream",
    run: () => resolver.pullRebase(bridge.CUR_REPO as unknown as string),
  },
  {
    type: "action",
    id: "open-terminal",
    label: "Open Terminal",
    hint: "Open a real terminal at this repository's root",
    run: () => openTerminalCtrl.openTerminal(bridge.CUR_REPO as unknown as string),
  },
  {
    type: "action",
    id: "force-push-lease",
    label: "Force Push (Safe)",
    hint: "--force-with-lease: refuses if the remote moved since the last fetch",
    run: () => forcePushCtrl.forcePushLease(bridge.CUR_REPO as unknown as string),
  },
  {
    type: "action",
    id: "force-push-override",
    label: "Force Push (Override Remote)",
    hint: "Raw --force: unconditionally overwrites the remote branch",
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
    label: "Rewrite History (filter-repo)",
    hint: "Scope, preview, and typed-confirm a git-filter-repo rewrite — the one irreversible-by-Undo operation",
    run: () => (IN_TAURI ? filterRepoCtrl.start(bridge.CUR_REPO as unknown as string) : filterRepoCtrl.openDemo()),
  },
  // Opens the SAME in-app About panel the update check/install UI lives in
  // (see about.svelte.ts + islands/updater) — mirrors menu.rs's
  // "check-for-updates" item exactly (see src/main.ts's own case for it):
  // open About, then immediately kick off a check.
  {
    type: "action",
    id: "check-for-updates",
    label: "Check for Updates…",
    hint: "See what's installed and check GitHub Releases for a newer signed build",
    run: () => {
      aboutCtrl.show();
      updaterCtrl.check();
    },
  },
];

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
    for (const a of ACTIONS) {
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
  }

  close() {
    this.open = false;
  }

  toggle() {
    this.open ? this.close() : this.show();
  }
}

export const cmdkCtrl = new CmdkState();
