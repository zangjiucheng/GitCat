// Multi-repository dashboard (backlog #11) — controller (Svelte 5 runes
// singleton).
//
// A real .scrim/.modal, same shape as Reflog/Rerere/Plumbing/Remotes/
// PickaxeSearch — but UNLIKE every one of those, this one does NOT need
// `CUR_REPO` to be set: it's reachable at ANY time (repo open or not), since
// the whole point is checking on OTHER repos without leaving — or reaching —
// the currently open one. show()/refresh() below never read bridge.CUR_REPO.
//
// Backing list: an app-level "tracked repos" registry (repo_registry.rs,
// a small JSON file under Tauri's own app_config_dir — see that module's own
// doc comment on why this is Rust-owned file I/O rather than a frontend
// storage plugin) — NOT anything scoped to the currently open repo. Rows
// accumulate automatically (legacy/main.ts's openRepo() calls
// `commands.trackRepoOpened` on every successful open — see that file's own
// comment on the call site) plus manually via addRepository() below.
//
// Per-row status is ONE cheap backend read (`dashboard_repo_status` —
// current branch + its own ahead/behind, dirty/clean, HEAD's tip subject/
// time) — deliberately NEVER `load_graph`/`build_graph` (a full commit-graph
// walk), see dashboard.rs's own module doc for why a dashboard must never
// trigger that per tracked repo. Every tracked repo's status is fetched in
// PARALLEL (Promise.allSettled, not a sequential loop) when the dashboard
// opens — one repo being slow, or its path no longer resolving to a valid
// git repo at all (moved/deleted since it was tracked), must never block or
// crash the rest of the list; see fetchStatus()'s catch below, which turns
// either kind of failure into that one row's own `error` field instead.
//
// Row-list rebuilds (`applyTrackedList`) always PRESERVE any status a row
// already has (matched by path) rather than blindly replacing every row with
// a fresh "loading" placeholder — so add/remove only ever (re-)fetches
// status for a row that's genuinely new, not the whole list again.
//
// "Open" hands off to the EXISTING `bridge.openRepo()` (full teardown +
// reload of CUR_REPO/BACKEND, the same call pickRepo/enterSubmodule/
// goBackToParent already use) — this app has no multi-window/multi-repo-in-
// memory support, and building one just for this dashboard is explicitly out
// of scope (see the design notes this feature shipped against). "Remove"
// only ever mutates the TRACKED LIST (repo_registry.rs's own doc comment on
// remove_tracked_repo) — never anything on disk.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";
import { open } from "@tauri-apps/plugin-dialog";
import type { DashboardRepoStatus, TrackedRepo } from "../../ipc/bindings";

export type DashboardRow = {
  path: string;
  lastOpenedAt: number | null;
  loading: boolean; // dashboard_repo_status round-trip in flight (or never yet attempted)
  status: DashboardRepoStatus | null;
  error: string | null; // set on a failed/invalid-path status read — shown as "broken", never crashes the list
};

// Last path segment, display-only — own copy of legacy/main.ts's
// repoBasename() (not exported via bridge.ts), same "duplicate the small
// helper per owning module" convention pickaxeSearchCtrl.jumpToCommit's own
// doc comment describes for the sha-lookup body.
export function repoBasename(path: string): string {
  return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || path;
}

// Canned rows for design-mode (!IN_TAURI) — same spirit as every other
// island's DEMO constant, including one deliberately BROKEN row so the
// "path no longer resolves" state still demos in the browser preview.
const now = () => Math.floor(Date.now() / 1000);
const DEMO_ROWS: DashboardRow[] = [
  {
    path: "/home/demo/acme-web",
    lastOpenedAt: now() - 300,
    loading: false,
    error: null,
    status: {
      branch: "main",
      detached: false,
      ahead: 2,
      behind: 0,
      dirty: true,
      conflicted: 0,
      headSha: "a1b2c3d",
      lastSubject: "tune cache headers on the asset pipeline",
      lastCommitTime: now() - 3600,
    },
  },
  {
    path: "/home/demo/acme-api",
    lastOpenedAt: now() - 86400,
    loading: false,
    error: null,
    status: {
      branch: "feat/rate-limit",
      detached: false,
      ahead: 0,
      behind: 3,
      dirty: false,
      conflicted: 0,
      headSha: "bb01ccd",
      lastSubject: "add rate limiting middleware",
      lastCommitTime: now() - 7200,
    },
  },
  {
    path: "/home/demo/old-prototype",
    lastOpenedAt: null,
    loading: false,
    error: "This path no longer resolves to a repository.",
    status: null,
  },
];

class DashboardState {
  open = $state(false);
  demo = $state(false);
  rows = $state<DashboardRow[]>([]);
  loading = $state(false); // listTrackedRepos round-trip in flight
  error = $state(""); // list-level failure (couldn't even read the registry)
  addBusy = $state(false); // native folder dialog / addTrackedRepo in flight
  removingPath = $state<string | null>(null); // which row's removeTrackedRepo is in flight

  // Entry point (Tools menu / ⌘K, and the empty-hero card's own button — see
  // Detail.svelte). Forces a full re-fetch of every row's status, not just
  // whatever happens to still be `loading` — an adversarial review caught
  // that `refresh()` alone does NOT do this (see its own doc below), so a
  // repo whose branch/dirty state changed behind the app's back (a terminal
  // commit, another tool) would show stale status for the rest of the app
  // session once fetched here once. `show()` is the one call site that must
  // never trust ANY existing status as current.
  show(): void {
    this.open = true;
    void this.refresh(true);
  }

  close(): void {
    if (this.addBusy) return; // native dialog / add mutation in flight
    this.open = false;
  }

  // `forceRefetchAll`: only `show()` passes `true` (see its own comment).
  // Internal callers that already know exactly which rows are new/changed —
  // addRepository()/removeRepository() below — call `applyTrackedList`
  // directly instead of going through `refresh()` at all, so they keep the
  // "only a genuinely new row starts loading" optimization without needing
  // this flag.
  async refresh(forceRefetchAll = false): Promise<void> {
    this.error = "";
    if (!IN_TAURI) {
      this.demo = true;
      this.rows = DEMO_ROWS.map((r) => ({ ...r, status: r.status ? { ...r.status } : null }));
      return;
    }
    this.demo = false;
    this.loading = true;
    try {
      const res = await commands.listTrackedRepos();
      if (res.status === "ok") {
        this.applyTrackedList(res.data, forceRefetchAll);
      } else {
        this.rows = [];
        this.error = String(res.error ?? "Could not list tracked repositories.");
        return;
      }
    } catch (e) {
      this.rows = [];
      this.error = "Could not list tracked repositories — " + e;
      return;
    } finally {
      this.loading = false;
    }
    await this.fetchPendingStatuses();
  }

  // Merge a fresh TrackedRepo[] from the backend into `rows`. By default,
  // preserves any status/error a row already has (matched by path) — see
  // module doc for why: only a row that's genuinely new should start
  // `loading` when called from addRepository()/removeRepository(), which
  // already know nothing else in the list could have changed. When
  // `forceRefetchAll` is true (only `show()`'s call, via `refresh(true)`),
  // EVERY row is reset to `loading` regardless of any cached status, so a
  // fresh dashboard open always re-checks reality rather than trusting
  // whatever it last saw earlier in the session.
  private applyTrackedList(list: TrackedRepo[], forceRefetchAll = false): void {
    const existing = new Map(this.rows.map((r) => [r.path, r]));
    this.rows = list.map((t) => {
      const prev = forceRefetchAll ? undefined : existing.get(t.path);
      return prev ? { ...prev, lastOpenedAt: t.lastOpenedAt } : { path: t.path, lastOpenedAt: t.lastOpenedAt, loading: true, status: null, error: null };
    });
  }

  // Fires one dashboard_repo_status call per row still marked `loading`, all
  // at once (Promise.allSettled — never a sequential loop): a handful to a
  // couple dozen tracked repos means a handful to a couple dozen concurrent,
  // independent IPC round-trips, not a chain of them. allSettled (not all)
  // because fetchStatus below already catches its own failure per-row —
  // nothing here should ever reject.
  private async fetchPendingStatuses(): Promise<void> {
    const pending = this.rows.filter((r) => r.loading).map((r) => r.path);
    if (!pending.length) return;
    await Promise.allSettled(pending.map((p) => this.fetchStatus(p)));
  }

  private async fetchStatus(path: string): Promise<void> {
    try {
      const res = await commands.dashboardRepoStatus(path);
      if (res.status === "ok") {
        this.updateRow(path, { loading: false, status: res.data, error: null });
      } else {
        this.updateRow(path, { loading: false, status: null, error: String(res.error ?? "Could not read this repository's status.") });
      }
    } catch (e) {
      this.updateRow(path, { loading: false, status: null, error: "Could not read this repository's status — " + e });
    }
  }

  private updateRow(path: string, patch: Partial<DashboardRow>): void {
    this.rows = this.rows.map((r) => (r.path === path ? { ...r, ...patch } : r));
  }

  // "+ Add repository…" — native directory picker (same @tauri-apps/plugin-
  // dialog `open()` applyPatchCtrl.applyPatch already uses, just
  // `directory:true` instead of a file filter) for a repo not yet opened
  // through the app this session, so it wouldn't otherwise be auto-tracked.
  async addRepository(): Promise<void> {
    if (this.addBusy) return;
    if (!IN_TAURI || this.demo) {
      bridge.tama.say("This is where you'd pick a folder to track (demo).");
      return;
    }
    let dir: string | string[] | null;
    try {
      dir = await open({ directory: true, title: "Add a repository to track" });
    } catch (e) {
      bridge.tama.warn("Could not open the folder dialog — " + e);
      return;
    }
    if (!dir || Array.isArray(dir)) return; // cancelled (Array.isArray is defensive-only — multiple isn't set)
    this.addBusy = true;
    try {
      const res = await commands.addTrackedRepo(dir);
      if (res.status === "ok") {
        this.applyTrackedList(res.data);
        this.error = "";
        // Always open it immediately — the empty-hero/sidebar/topbar's own
        // "Open a repository…" all funnel here now (see Detail.svelte/
        // Sidebar.svelte/legacy/main.ts's `.repo-pick` handler), and picking
        // a folder should feel like "go there", not "file it away for
        // later": leaving a freshly-added repo merely tracked (even when
        // some OTHER repo was already open) meant hunting for its new row in
        // this same list and clicking Open a second time. Same pick-a-
        // folder-and-go feel the old direct-to-native-dialog buttons had.
        await this.openRepository(dir);
      } else {
        bridge.tama.warn(String(res.error ?? "Could not add that repository."));
      }
    } catch (e) {
      bridge.tama.warn("Could not add that repository — " + e);
    } finally {
      this.addBusy = false;
    }
  }

  // "Remove from list" — removes from the TRACKED LIST only (repo_registry.rs's
  // own doc comment), never touches anything on disk. Also the only escape
  // hatch for a row whose path no longer resolves (moved/deleted repo).
  async removeRepository(path: string): Promise<void> {
    if (this.removingPath) return;
    if (!IN_TAURI || this.demo) {
      this.rows = this.rows.filter((r) => r.path !== path);
      return;
    }
    this.removingPath = path;
    try {
      const res = await commands.removeTrackedRepo(path);
      if (res.status === "ok") {
        this.applyTrackedList(res.data);
      } else {
        bridge.tama.warn(String(res.error ?? "Could not remove that repository from the list."));
      }
    } catch (e) {
      bridge.tama.warn("Could not remove that repository from the list — " + e);
    } finally {
      this.removingPath = null;
    }
  }

  // "Open" — always closes the dashboard first (not a "cancel the click"
  // situation, same discipline as pickaxeSearchCtrl.jumpToCommit's own doc
  // comment), then hands off to the SAME openRepo() every other repo-
  // switching action in this app already uses: full teardown of whatever is
  // currently open, real graph/workdir/branches reload for the new one.
  // openRepo() itself already reports its own failure via a Tama toast (see
  // legacy/main.ts) — nothing further to surface here on a bad path.
  async openRepository(path: string): Promise<void> {
    this.open = false;
    if (!IN_TAURI || this.demo) {
      bridge.tama.say("This is where " + repoBasename(path) + " would open (demo).");
      return;
    }
    await bridge.openRepo(path);
  }
}

export const dashboardCtrl = new DashboardState();
export type { DashboardRepoStatus, TrackedRepo };
