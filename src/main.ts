// Frontend entry. Boot the legacy vanilla app (side-effect import: it builds the
// canvas, sidebar, mascot and starts the RAF loop), then mount the Svelte
// islands over the DOM. Islands render their own scrim markup into <body>,
// so the old #conflictScrim / #bisectScrim blocks are gone from the HTML.
import "./legacy/main.ts";
import { mount } from "svelte";
import Resolver from "./islands/resolver/Resolver.svelte";
import CommitMenu from "./islands/commitmenu/CommitMenu.svelte";
import Bisect from "./islands/bisect/Bisect.svelte";
import Reflog from "./islands/reflog/Reflog.svelte";
import { reflogCtrl } from "./islands/reflog/reflog.svelte.ts";
import Rerere from "./islands/rerere/Rerere.svelte";
import { rerereCtrl } from "./islands/rerere/rerere.svelte.ts";
import Plumbing from "./islands/plumbing/Plumbing.svelte";
import { plumbing } from "./islands/plumbing/plumbing.svelte.ts";
import SyncProgress from "./islands/syncprogress/SyncProgress.svelte";
import MainlinePicker from "./islands/mainlinepicker/MainlinePicker.svelte";
import TamaConfirm from "./islands/tamaconfirm/TamaConfirm.svelte";
import RepoSummary from "./islands/reposummary/RepoSummary.svelte";
import { repoSummaryCtrl } from "./islands/reposummary/reposummary.svelte.ts";
import { pluginHooksCtrl } from "./islands/pluginhooks/pluginhooks.svelte.ts";
import Remotes from "./islands/remotes/Remotes.svelte";
import { remotesCtrl } from "./islands/remotes/remotes.svelte.ts";
import { resolver } from "./islands/resolver/resolver.svelte.ts";
import { forcePushCtrl } from "./islands/forcepush/forcepush.svelte.ts";
import { resetHeadCtrl } from "./islands/resethead/resethead.svelte.ts";
import ExportPatches from "./islands/exportpatches/ExportPatches.svelte";
import { exportPatchesCtrl } from "./islands/exportpatches/exportpatches.svelte.ts";
import { applyPatchCtrl } from "./islands/applypatch/applypatch.svelte.ts";
import Terminal from "./islands/terminal/Terminal.svelte";
import { terminalCtrl } from "./islands/terminal/terminal.svelte.ts";
import TamaGallery from "./islands/tamagallery/TamaGallery.svelte";
import PickaxeSearch from "./islands/pickaxesearch/PickaxeSearch.svelte";
import { pickaxeSearchCtrl } from "./islands/pickaxesearch/pickaxesearch.svelte.ts";
import CodeSearch from "./islands/codesearch/CodeSearch.svelte";
import { codeSearchCtrl } from "./islands/codesearch/codesearch.svelte.ts";
import Dashboard from "./islands/dashboard/Dashboard.svelte";
import { dashboardCtrl } from "./islands/dashboard/dashboard.svelte.ts";
import ExternalTools from "./islands/externaltools/ExternalTools.svelte";
import { externalToolsCtrl } from "./islands/externaltools/externaltools.svelte.ts";
import Plugins from "./islands/plugins/Plugins.svelte";
import { pluginsCtrl } from "./islands/plugins/plugins.svelte.ts";
import Settings from "./islands/settings/Settings.svelte";
import { settingsCtrl, loadSettings } from "./islands/settings/settings.svelte.ts";
import DanglingRecovery from "./islands/danglingrecovery/DanglingRecovery.svelte";
import { danglingRecoveryCtrl } from "./islands/danglingrecovery/danglingrecovery.svelte.ts";
import RepoFiles from "./islands/repofiles/RepoFiles.svelte";
import { repoFilesCtrl } from "./islands/repofiles/repofiles.svelte.ts";
import FilterRepo from "./islands/filterrepo/FilterRepo.svelte";
import { filterRepoCtrl } from "./islands/filterrepo/filterrepo.svelte.ts";
import RebasePlan from "./islands/rebaseplan/RebasePlan.svelte";
import MultiMerge from "./islands/multimerge/MultiMerge.svelte";
import Blame from "./islands/blame/Blame.svelte";
import FileHistory from "./islands/filehistory/FileHistory.svelte";
import SetupWizard from "./islands/setupwizard/SetupWizard.svelte";
import { setupWizardCtrl } from "./islands/setupwizard/setupwizard.svelte.ts";
import Cmdk from "./islands/cmdk/Cmdk.svelte";
import { cmdkCtrl } from "./islands/cmdk/cmdk.svelte.ts";
import PluginPanel from "./islands/pluginpanels/PluginPanel.svelte";
import VimNav from "./islands/vimnav/VimNav.svelte";
import SnapshotPreview from "./islands/snapshotpreview/SnapshotPreview.svelte";
import About from "./islands/about/About.svelte";
import { aboutCtrl } from "./islands/about/about.svelte.ts";
import { updaterCtrl } from "./islands/updater/updater.svelte.ts";
import DetailPanel from "./islands/detailpanel/DetailPanel.svelte";
import { workdirCtrl } from "./islands/workdir/workdir.svelte.ts";
import BisectDrawer from "./islands/bisectdrawer/BisectDrawer.svelte";
import { openBisectEntry } from "./islands/bisectdrawer/bisectdrawer.svelte.ts";
import Sidebar from "./islands/sidebar/Sidebar.svelte";
import { sidebarCtrl } from "./islands/sidebar/sidebar.svelte.ts";
import SubmoduleNav from "./islands/submodulenav/SubmoduleNav.svelte";
import { submoduleNavCtrl } from "./islands/submodulenav/submodulenav.svelte.ts";
import { IN_TAURI } from "./ipc/env";
import * as bridge from "./legacy/bridge";
import { dlog } from "./devlog";
import { commands } from "./ipc/bindings";
import ContextMenu from "./islands/contextmenu/ContextMenu.svelte";

// Shared right-click menu. Mounted first because every other island can
// open it, and it renders nothing until one does. Surfaces call
// contextMenuCtrl.open(items, x, y) from their own oncontextmenu handler
// rather than each rendering a popover of their own.
mount(ContextMenu, { target: document.body });
mount(Resolver, { target: document.body });
mount(CommitMenu, { target: document.body });
mount(Bisect, { target: document.body });
mount(FilterRepo, { target: document.body });
mount(RebasePlan, { target: document.body });
mount(MultiMerge, { target: document.body });
// Blame (line-annotation view) — unlike Reflog/Rerere/Plumbing below, this is
// NOT reachable from the Tools menu or ⌘K: it inherently needs a (commit,
// file) target that only exists in file-tree context (Detail.svelte's file
// tree / Workdir.svelte's staged+unstaged rows each call blameCtrl.openFor()
// directly), so there's no menu entry to wire in src/main.ts's "menu-action"
// listener below. See blame.svelte.ts's own header doc.
mount(Blame, { target: document.body });
// File History (per-file, rename-following commit list) — same direct-call,
// not-in-the-Tools-menu/⌘K reasoning as Blame immediately above (see
// filehistory.svelte.ts's own header doc): Detail.svelte's file tree /
// Workdir.svelte's staged+unstaged rows call fileHistoryCtrl.openFor()
// directly from a sibling "History" icon button next to each row's Blame one.
mount(FileHistory, { target: document.body });
mount(SetupWizard, { target: document.body });

// Setup wizard: auto-opens at boot, ON TOP of the untouched bootEmpty() hero
// card (real app, no repo open yet) or the synthetic demo graph (browser
// design mode) — see setupwizard.svelte.ts's header for why Esc/"Skip" simply
// reveals what's already underneath rather than falling back to anything
// special-cased here. Reading bridge.CUR_REPO here (not destructured) is safe
// because legacy/main.ts's top-level bootEmpty() has already run to completion
// by this point (module evaluation order). Only a FIRST run, not every launch
// with no repo open — hasBeenDismissed() persists across launches (see
// setupwizard.svelte.ts) once the user has skipped or finished it once.
// A launch that names a repo — `gitcat <folder>` from a terminal, the
// Dashboard's "Open in New Window", or a submodule deep-link — carries a
// ?repo= (or ?repoError= when the path isn't a repo) query param, and is never
// a first-run onboarding moment. bridge.CUR_REPO is still null here (legacy/
// main.ts kicks off openRepo() without awaiting it, and CUR_REPO is only set
// after it resolves), so gate on the launch arg itself; otherwise the wizard
// pops on top of the very repo the user explicitly asked to open.
const launchParams = new URLSearchParams(location.search);
const launchedWithRepoArg = launchParams.has("repo") || launchParams.has("repoError");
if (IN_TAURI) {
  if (!bridge.CUR_REPO && !launchedWithRepoArg && !setupWizardCtrl.hasBeenDismissed())
    setupWizardCtrl.start();
} else {
  setupWizardCtrl.openDemo();
}

mount(Cmdk, { target: document.body });
mount(VimNav, { target: document.body });
mount(SnapshotPreview, { target: document.body });
mount(About, { target: document.body });
// Workdir is NOT mounted as its own top-level tree here even though the
// design spec's own §4 "Wiring" prose describes a second `mount(Workdir, …)`
// alongside Detail's — that would double-render the panel: DetailPanel.svelte
// (below) is the #detail slot's single owner, peer-importing both the Detail
// and Workdir COMPONENTS (not just their controllers) and picking between
// them itself based on `workdirCtrl.selected`, so mounting Workdir a second
// time onto the identical `#detail` node would render the staging panel
// twice. One mount point, one source of truth.
mount(DetailPanel, { target: document.getElementById("detail")! });
// Bisect's pre-start floating panel — see index.html's own doc comment on
// the removed DRAWER section for why this (and Reflog/Rerere/Plumbing
// below) are no longer mounted into a permanent drawer pane. MUST mount
// inside #canvasWrap, not document.body: its position:absolute floats
// relative to that element, same as #deltaReadout.
mount(BisectDrawer, { target: document.getElementById("bisectPanelMount")! });

mount(Sidebar, { target: document.getElementById("sidebarRefs")! });
sidebarCtrl.refresh(bridge.CUR_REPO as unknown as string);

// Submodule navigator strip (grid row under the topbar). legacy/main.ts's boot
// open / navigateToRepo / pickRepo each call submoduleNavCtrl.refresh()
// themselves; this seed only puts the strip in a defined state before the first
// of those lands.
mount(SubmoduleNav, { target: document.getElementById("submoduleNavMount")! });
// Handed over as-is rather than cast to `string` like the CUR_REPO reads
// elsewhere in this file: mount runs before any repo is open (legacy/main.ts
// starts openRepo() without awaiting it, and openRepo awaits before it assigns
// CUR_REPO), so on a real launch this reads null. refresh() takes
// `string | null` and resets to the empty strip for it.
submoduleNavCtrl.refresh(bridge.CUR_REPO);

// Reflog/Rerere/Plumbing: on-demand modals now (Tools menu / ⌘K — see
// menu.rs / cmdk.svelte.ts), each opened via its own controller's show()
// rather than mounted into a drawer pane that was always present. No initial
// refresh() call needed here either — show() always re-fetches fresh (see
// each controller's own doc comment), so there's nothing useful to preload
// before the user actually opens one.
mount(Reflog, { target: document.body });
mount(Rerere, { target: document.body });
mount(Plumbing, { target: document.body });
// Declarative plugin panels (PER-45): same on-demand-modal treatment as
// Reflog/Rerere/Plumbing above — opened from ⌘K (one entry per declared
// panel, contributed by pluginPanelsCtrl, see cmdk.svelte.ts), never mounted
// into a drawer. Purely declarative: it renders a plugin's DECLARED widgets
// (heading/text/button/command-output) and only ever runs that plugin's OWN
// commands via the same runPluginCommand path PER-42 uses.
mount(PluginPanel, { target: document.body });
// Fetch/Pull live-progress modal — opened by doFetch/doPull (legacy/main.ts),
// which is reached from both the topbar buttons and the native Fetch/Pull menu.
mount(SyncProgress, { target: document.body });
// Mainline-parent chooser — opened by resolver.startPick when the picked
// commit is a merge (git needs `cherry-pick -m <n>`).
mount(MainlinePicker, { target: document.body });
// Tama-styled in-app confirm (promise-based `tamaConfirmCtrl.ask`) — the app's
// own yes/no dialog instead of an OS-native one (e.g. the dirty-tree Undo).
mount(TamaConfirm, { target: document.body });
// Repository Summary: same on-demand-modal treatment as Reflog/Rerere/
// Plumbing above, PLUS it also opens itself automatically the very first
// time a given repo is opened in GitCat — see openRepo()'s own call to
// reposummaryCtrl.maybeAutoShow (legacy/main.ts) and reposummary.svelte.ts's
// own header doc.
mount(RepoSummary, { target: document.body });
// Manage Remotes: repo-global (not tied to any file/commit — the OPPOSITE
// case from Blame above), so it gets the same Tools-menu/⌘K/on-demand-modal
// treatment as Reflog/Rerere/Plumbing rather than Blame's direct-call one.
mount(Remotes, { target: document.body });
// Export Patches (range export modal, backlog #9): same on-demand-modal
// treatment as Remotes/Reflog/Rerere/Plumbing above. Apply Patch has no
// mount of its own — like Force Push, it's a Tools-menu/⌘K entry point with
// no bespoke UI (see applypatch.svelte.ts's own doc comment): it opens a
// native file dialog directly and, on a conflict, hands off to the
// ALREADY-mounted Resolver above.
mount(ExportPatches, { target: document.body });
// Pickaxe / diff-content search (backlog #10): same on-demand-modal
// treatment as Export Patches/Remotes/Reflog/Rerere/Plumbing above — repo-
// global (not tied to any file/commit target), so — unlike Blame/File
// History — it's reachable from the Tools menu/⌘K rather than a file-tree
// row (see pickaxesearch.svelte.ts's own header doc).
mount(PickaxeSearch, { target: document.body });
// Search Code: same on-demand-modal treatment as Pickaxe just above — repo-
// global full-text search of the current checkout (or a chosen historical
// commit), complementing Pickaxe's own diff/commit search (see
// codesearch.svelte.ts's own header doc).
mount(CodeSearch, { target: document.body });
// Multi-repository dashboard (backlog #11): same on-demand-modal treatment
// as Pickaxe Search/Export Patches/Remotes/Reflog/Rerere/Plumbing above, but
// — unlike every one of those — reachable with or without a repo open (see
// dashboard.svelte.ts's own header doc): also rendered from the empty-hero
// card's own button (Detail.svelte), not just the Tools menu/⌘K.
mount(Dashboard, { target: document.body });
// Pluggable external diff/merge tools (backlog #12): same on-demand-modal
// treatment as Dashboard/Pickaxe Search/Export Patches/Remotes/Reflog/Rerere/
// Plumbing above — an app-level settings modal reachable whether or not a
// repo is open (see externaltools.svelte.ts's own header doc), not tied to
// any file/commit target itself (unlike its own "Open in external diff"/
// "Resolve with external tool" buttons, which live on Detail.svelte/
// Workdir.svelte's file rows and Resolver.svelte instead).
mount(ExternalTools, { target: document.body });
// Plugins manager (PER-49 follow-up): the installed-plugin registry moved out
// of the old Settings → Plugins tab into its own VS Code Extensions-style
// two-pane view — app-level (no repo needed) like External Tools/Dashboard, so
// the same on-demand-modal + Tools-menu/⌘K treatment. It OWNS the plugin list;
// the Settings Tama skin picker now reads pluginsCtrl.plugins.
mount(Plugins, { target: document.body });
// App Settings: theme/cherry-pick-default/auto-update-check prefs (app-level,
// like External Tools/Dashboard above) plus a Git Identity section scoped to
// whichever repo is open (forwards bridge.CUR_REPO, like Remotes) — see
// settings.svelte.ts's own header doc for why these live in localStorage
// rather than a new Rust settings file.
mount(Settings, { target: document.body });
// fsck-based dangling-object recovery (backlog #13): same on-demand-modal
// treatment as External Tools/Dashboard/Pickaxe Search/Export Patches/
// Remotes/Reflog/Rerere/Plumbing above — repo-scoped (forwards
// bridge.CUR_REPO) like Reflog/Rerere, not repo-independent like
// Repositories/External Tools (see danglingrecovery.svelte.ts's own header
// doc).
mount(DanglingRecovery, { target: document.body });
// .gitignore / .mailmap in-app editors (backlog #14, the FINAL backlog
// item): same on-demand-modal treatment as Dangling Commits/External Tools/
// Dashboard/Pickaxe Search/Export Patches/Remotes/Reflog/Rerere/Plumbing
// above — repo-scoped (forwards bridge.CUR_REPO) like Reflog/Rerere/Dangling
// Commits, not repo-independent like Repositories/External Tools (see
// repofiles.svelte.ts's own header doc).
mount(RepoFiles, { target: document.body });
// Built-in terminal: a real PTY-backed shell embedded in GitCat's own UI (a
// bottom drawer) — see terminal.svelte.ts's own header doc. Unlike every
// on-demand modal above, this ISN'T a .scrim overlay, so it stays mounted
// and visually toggled (`.term-drawer.on`) rather than shown/hidden by a
// controller-owned boolean gating the whole component's render, keeping its
// one xterm.js instance alive (and its scrollback intact) across hide/show.
mount(Terminal, { target: document.body });
// Tama Gallery: a hidden Easter egg (see tamagallery.svelte.ts's own header
// doc) — same on-demand-modal treatment as every other one above, but with
// no menu/⌘K entry point anywhere; legacy/main.ts's own click-counter on
// the nook portrait is the only way in.
mount(TamaGallery, { target: document.body });

// Native app menu -> frontend action bridge (see src-tauri/src/menu.rs).
// Only the items whose action lives in Svelte-controller land forward here —
// the Help links (opened via the opener plugin) and every predefined item
// (Cut/Copy/Paste/Select All/Quit/etc.) are handled entirely on the Rust/OS
// side and never reach this listener. window.__TAURI__ (not a static
// @tauri-apps/api import) matches every other real-Tauri-only call site in
// this codebase (see setupwizard.svelte.ts's pickDirectory/armDropZone).
// Live refresh: the backend watches the open repo's git-dir and emits
// "repo-changed" when something changes it from OUTSIDE the app (a terminal
// commit, another tool, a background fetch, a hook) — see
// src-tauri/src/watch.rs. Declared at module scope (not inside the
// `if (IN_TAURI)` block below) so the manual Refresh button can call it
// unconditionally, exactly like doFetch/doPull/doPush's own click listeners
// are always registered and branch on IN_TAURI internally — a listener
// registered only inside that block would silently do nothing when clicked
// in browser design mode.
//
// ADVERSARIALLY-FOUND FIX: the old re-entrancy guard just returned early on
// a second event arriving mid-refresh, silently dropping it — fine for an
// event that's merely redundant with one already in flight, but wrong for
// the LAST event in a burst (a rebase, a squash, several quick commits):
// if that final "things have settled" event landed while a still-running
// refresh (its own or an unrelated one) held the guard, nothing else would
// ever refresh again and the UI stayed stale until some other, unrelated
// action happened to trigger a reload. `repoChangePending` now remembers
// "at least one more refresh is owed" and the loop below drains it once
// the in-flight pass finishes, so the true final state always eventually
// gets reflected — this is also what the manual Refresh button below
// calls, so a click while an auto-refresh is already running coalesces
// with it instead of racing it.
let repoChangeReloadInFlight = false;
let repoChangePending = false;
let repoChangePendingForceFull = false;
// `forceFull` (the manual Refresh button passes true): re-walk the whole graph
// instead of the incremental fast path — the button is the "resync everything
// now" escape hatch, so it must never miss an external ref/commit change (e.g. a
// branch created outside the app). The automatic watcher/poll callers leave it
// false and keep the cheap fast path.
async function refreshFromExternalChange(forceFull = false) {
  if (!bridge.CUR_REPO) return;
  if (repoChangeReloadInFlight) {
    repoChangePending = true;
    repoChangePendingForceFull = repoChangePendingForceFull || forceFull;
    return;
  }
  repoChangeReloadInFlight = true;
  let nextForceFull = forceFull;
  try {
    for (;;) {
      await bridge.reloadGraph(true, nextForceFull);
      // Working-tree state (stage/unstage/dirty files) can change from
      // OUTSIDE the app exactly like refs can (an external `git add`, a
      // terminal edit, a save from another editor) — keep the pinned row's
      // badge and, if open, the staging panel itself live. The stash list is
      // its own separate read (`git stash` from a terminal fires this same
      // event — confirmed via watch.rs) and was previously never refreshed
      // here, so an external stash change could silently invalidate the
      // index the panel was showing (see stash_apply/pop/drop's
      // `expected_sha` identity check on the backend for the other half of
      // this fix).
      const repo = bridge.CUR_REPO as unknown as string;
      await Promise.all([workdirCtrl.refreshStatus(repo), workdirCtrl.refreshStashes(repo)]);
      if (!repoChangePending) break;
      repoChangePending = false;
      nextForceFull = repoChangePendingForceFull;
      repoChangePendingForceFull = false;
    }
  } finally {
    repoChangeReloadInFlight = false;
  }
}

// Backup for watch.rs's OS-level file watcher — real-world file-watching
// (FSEvents/inotify) has known environment-specific failure modes that have
// nothing to do with this app's own logic (a packaged build lacking a
// filesystem-watch permission grant, a signing/sandboxing quirk, an unusual
// filesystem) where the watcher can silently never fire even though the repo
// itself is perfectly readable — confirmed via `watch.rs`'s own real
// filesystem-level test suite that the watch MECHANISM is correct in
// isolation, which only sharpens how much an environment-specific gap
// explains a report of "manual refresh works, automatic never happens".
// Polls the SAME cheap, no-walk read the multi-repo dashboard already uses
// per tracked repo (branch/head-sha/dirty/conflicted — never a full graph
// load) and, whenever that snapshot differs from the last one seen, calls
// the exact same refreshFromExternalChange() the real watcher calls — so the
// two mechanisms share one definition of "changed" and can never disagree;
// whichever notices first wins, the other's own next check just finds
// nothing new. `pollSnapshot` resets to null whenever no repo is open (or
// between polls that land on a different repo than they started against, if
// the user switches repos faster than POLL_MS) so neither a stale snapshot
// nor the very first poll for a freshly-opened repo is ever mistaken for a
// real external change.
const POLL_MS = 4000;
let pollSnapshot: string | null = null;
// The commit-identity part of the last snapshot (branch + HEAD sha), tracked
// separately so a change can be classified: if only dirty/conflicted moved and
// branch + HEAD are identical, it's a pure WORKING-TREE change (an edit, or a
// terminal `git add`) — the commit graph is unchanged, so only the working-tree
// status (the uncommitted-changes badge) needs refreshing, never the graph.
let pollCommitId: string | null = null;
if (IN_TAURI) {
  setInterval(async () => {
    if (!bridge.CUR_REPO) {
      pollSnapshot = null;
      pollCommitId = null;
      return;
    }
    const path = bridge.CUR_REPO as unknown as string;
    try {
      const res = await commands.dashboardRepoStatus(path);
      if (res.status !== "ok" || bridge.CUR_REPO !== path) return; // repo closed/switched mid-request
      // Space-joined is unambiguous: a git ref name can't contain a space, and
      // the sha/dirty/conflicted fields are hex/boolean/number.
      const commitId = `${res.data.branch} ${res.data.headSha}`;
      const snap = `${commitId} ${res.data.dirty} ${res.data.conflicted}`;
      if (pollSnapshot !== null && pollSnapshot !== snap) {
        if (pollCommitId === commitId) {
          // Branch + HEAD unchanged ⇒ working-tree only: refresh just the status,
          // never touch the graph (not even the cheap refs re-check).
          dlog("trigger", "status poll: working-tree only — refresh status, skip graph");
          void workdirCtrl.refreshStatus(path);
        } else {
          dlog("trigger", "status poll: HEAD/branch moved — external refresh");
          void refreshFromExternalChange();
        }
      }
      pollSnapshot = snap;
      pollCommitId = commitId;
    } catch {
      // best-effort, same as watch_repo — a transient poll failure just tries again next tick
    }
  }, POLL_MS);
}

// Auto-fetch (Settings' own "Periodically fetch from all remotes" toggle) —
// keeps ahead/behind counts and incoming remote changes current without a
// manual Pull. Same shape as the poll just above: a single module-level
// timestamp (not per-repo — harmless to carry over across a repo switch,
// this only gates TIMING, unlike pollSnapshot above which gates a real
// correctness comparison and so must never leak across repos), IN_TAURI-
// gated, re-reads bridge.CUR_REPO and loadSettings() fresh on every tick
// rather than restarting the interval when the user flips the Settings
// toggle or changes the interval — so neither ever needs wiring beyond
// persisting to localStorage.
//
// AUTO_FETCH_CHECK_MS is how often we check whether a fetch is DUE, not the
// fetch interval itself (that's user-configurable, in whole minutes, via
// settingsCtrl.autoFetchIntervalMinutes) — a coarse 30s check is plenty
// granular against a multi-minute interval without polling pointlessly often.
// Deliberately silent either way (no Tama toast, no spinner) even on
// failure: this is meant to be fully ambient background upkeep, exactly
// like the dashboard-status poll above, not a user-facing action — a
// stale/offline network just tries again next tick, same as that poll's own
// best-effort contract.
const AUTO_FETCH_CHECK_MS = 30_000;
let lastAutoFetchAt = 0;
if (IN_TAURI) {
  setInterval(async () => {
    const path = bridge.CUR_REPO as unknown as string | null;
    if (!path) return;
    const s = loadSettings();
    if (!s.autoFetchEnabled) return;
    if (Date.now() < lastAutoFetchAt + s.autoFetchIntervalMinutes * 60_000) return;
    lastAutoFetchAt = Date.now();
    try {
      const res = await commands.fetch(path, null);
      if (!res.ok) console.warn("auto-fetch:", res.message);
    } catch (e) {
      console.error("auto-fetch failed unexpectedly", e);
    }
  }, AUTO_FETCH_CHECK_MS);
}

// Background git maintenance (Settings ▸ General ▸ "Run git maintenance … when
// idle", default OFF). Unlike auto-fetch above, this is IDLE-gated, not on a
// fixed cadence: it only fires once the user has left the app alone for a while,
// and at most once an hour, so it never competes with active work. `git
// maintenance run --auto` (see maintenance.rs) is cheap when nothing is due,
// touches no remote/credential, and changes no history — purely object-database
// housekeeping (commit-graph/gc/repack) that keeps the graph walk + status fast.
// Silent + best-effort like the auto-fetch/poll loops: a failure (e.g. a
// concurrent git process holding the lock) is logged and simply retried later.
const MAINTENANCE_CHECK_MS = 120_000; // re-evaluate every 2 min
const MAINTENANCE_IDLE_MS = 5 * 60_000; // "idle" = no real user input for 5 min
const MAINTENANCE_MIN_INTERVAL_MS = 60 * 60_000; // at most once an hour
let lastUserActivityAt = Date.now();
let lastMaintenanceAt = 0;
// Any real user input resets the idle clock. Passive + capture so it never costs
// anything on the input path and still counts input handled inside the islands.
for (const ev of ["pointerdown", "keydown", "wheel", "pointermove"] as const) {
  window.addEventListener(ev, () => (lastUserActivityAt = Date.now()), { passive: true, capture: true });
}
if (IN_TAURI) {
  setInterval(async () => {
    const path = bridge.CUR_REPO as unknown as string | null;
    if (!path) return;
    const s = loadSettings();
    if (!s.autoMaintenanceEnabled) return;
    const now = Date.now();
    if (now - lastUserActivityAt < MAINTENANCE_IDLE_MS) return; // still active — leave the repo alone
    if (now - lastMaintenanceAt < MAINTENANCE_MIN_INTERVAL_MS) return; // ran recently
    lastMaintenanceAt = now;
    try {
      const res = await commands.runGitMaintenance(path);
      if (res.status !== "ok") console.warn("git maintenance:", res.error);
    } catch (e) {
      console.error("git maintenance failed unexpectedly", e);
    }
  }, MAINTENANCE_CHECK_MS);
}

// Manual refresh (topbar button) — the explicit escape hatch for exactly
// the gap the fix above closes: if a user ever suspects the graph is out
// of sync with the repo on disk, this forces the same full resync
// (graph + sidebar refs/branch-pill + Safety snapshots, via reloadGraph;
// plus workdir status + stashes) rather than requiring them to reopen the
// repo. Reuses refreshFromExternalChange so a click during an already-
// in-flight auto-refresh coalesces with it instead of firing a redundant
// second one. Registered unconditionally (see this block's own opening
// comment) — the handler itself branches on IN_TAURI first.
document.getElementById("refreshBtn")?.addEventListener("click", () => {
  // IN_TAURI checked FIRST, same order as doFetch/doPull/doPush's own demo
  // branch: in browser design mode CUR_REPO stays null even though the
  // synthetic graph stands in for an open repo throughout (see
  // legacy/main.ts's workdirAvailable() doc comment) — checking CUR_REPO
  // first would misleadingly warn "Open a repository first" over a graph
  // that's clearly already showing commits.
  if (!IN_TAURI) {
    bridge.tama.set("hint");
    bridge.tama.say("Refreshed (demo). にゃ〜", 3200);
    return;
  }
  if (!bridge.CUR_REPO) {
    bridge.tama.warn("Open a repository first.");
    return;
  }
  // forceFull: the manual button is the "resync everything" escape hatch — a
  // guaranteed full re-walk, not an incremental fast refresh (see
  // refreshFromExternalChange / reloadGraph).
  refreshFromExternalChange(true);
});

// Ctrl/⌘ + , opens Settings. The native menu registers this accelerator too
// (menu.rs), but muda's Win32 accelerator handling of the literal "," key
// doesn't reliably fire on Windows — this frontend fallback makes the shortcut
// work there. On macOS the native accelerator consumes the event first, so this
// rarely runs; if both ever fire, settingsCtrl.show() is idempotent (a no-op
// when already open), so opening again is harmless. Ignored while typing so a
// stray Ctrl+, in a field can't pop Settings mid-edit.
window.addEventListener("keydown", (e) => {
  if (
    (e.metaKey || e.ctrlKey) &&
    !e.altKey &&
    !e.shiftKey &&
    e.key === "," &&
    !(e.target as HTMLElement | null)?.closest("input,textarea,[contenteditable=true]")
  ) {
    e.preventDefault();
    settingsCtrl.show(bridge.CUR_REPO as unknown as string);
  }
});

// Same story for ⌘/Ctrl+O (open the repositories dashboard). The native
// accelerator (menu.rs → "open-repo") fires reliably on macOS, but on Windows
// Ctrl+O is swallowed by the WebView2's own "open file" default before muda's
// accelerator sees it, so the menu action never runs. This frontend fallback
// preventDefaults the key and opens the dashboard directly; on macOS the native
// menu consumes it first, and dashboardCtrl.show() is idempotent if both fire.
// Ignored while typing so a stray Ctrl+O in a field can't pop the modal.
window.addEventListener("keydown", (e) => {
  if (
    (e.metaKey || e.ctrlKey) &&
    !e.altKey &&
    !e.shiftKey &&
    (e.key === "o" || e.key === "O") &&
    !(e.target as HTMLElement | null)?.closest("input,textarea,[contenteditable=true]")
  ) {
    e.preventDefault();
    dashboardCtrl.show();
  }
});

if (IN_TAURI) {
  const w = window as unknown as { __TAURI__?: any };
  w.__TAURI__?.event.listen("menu-action", (e: { payload: string }) => {
    switch (e.payload) {
      case "open-repo":
        // Open the repositories dashboard (⌘O) — the app's single "open a
        // repository" entry point (recent/tracked list with search, plus its
        // own "+ Add repository…" native picker), matching the empty-hero
        // "Open a repository…" button and the topbar repo-name pick. Was a bare
        // native folder dialog (bridge.pickRepo), which bypassed the modal.
        dashboardCtrl.show();
        break;
      case "close-repo":
        bridge.closeRepo();
        break;
      case "new-branch":
        sidebarCtrl.startNewBranch();
        break;
      case "toggle-theme":
        document.getElementById("themeBtn")?.dispatchEvent(new MouseEvent("click"));
        break;
      case "cmdk":
        cmdkCtrl.show();
        break;
      case "fetch":
        bridge.doFetch();
        break;
      case "pull":
        bridge.doPull();
        break;
      case "push":
        bridge.doPush();
        break;
      case "refresh":
        // Same "dispatch a click on the real button" indirection as
        // toggle-theme above — refreshBtn's own listener already lives in
        // this file (see refreshFromExternalChange), no bridge export needed.
        document.getElementById("refreshBtn")?.dispatchEvent(new MouseEvent("click"));
        break;
      case "about":
        aboutCtrl.show();
        break;
      case "check-for-updates":
        // Opens the SAME About panel the update UI already lives in (see
        // About.svelte) rather than a separate flow — one place to both see
        // what's installed and check/install what's newer. show() is a
        // no-op if already open.
        aboutCtrl.show();
        updaterCtrl.check();
        break;
      case "bisect":
        openBisectEntry();
        break;
      case "reflog":
        reflogCtrl.show(bridge.CUR_REPO as unknown as string);
        break;
      case "rerere":
        rerereCtrl.show(bridge.CUR_REPO as unknown as string);
        break;
      case "plumbing":
        plumbing.show();
        break;
      case "repo-summary":
        repoSummaryCtrl.show(bridge.CUR_REPO as unknown as string);
        break;
      case "remotes":
        remotesCtrl.show(bridge.CUR_REPO as unknown as string);
        break;
      case "export-patches":
        exportPatchesCtrl.show(bridge.CUR_REPO as unknown as string);
        break;
      case "apply-patch":
        applyPatchCtrl.applyPatch(bridge.CUR_REPO as unknown as string);
        break;
      case "pickaxe-search":
        pickaxeSearchCtrl.show(bridge.CUR_REPO as unknown as string);
        break;
      case "code-search":
        codeSearchCtrl.show(bridge.CUR_REPO as unknown as string);
        break;
      case "repositories":
        dashboardCtrl.show();
        break;
      case "external-tools":
        externalToolsCtrl.show();
        break;
      case "plugins":
        pluginsCtrl.show();
        break;
      case "settings":
        settingsCtrl.show(bridge.CUR_REPO as unknown as string);
        break;
      case "dangling-recovery":
        danglingRecoveryCtrl.show(bridge.CUR_REPO as unknown as string);
        break;
      case "repo-files":
        repoFilesCtrl.show(bridge.CUR_REPO as unknown as string);
        break;
      case "uncommitted-changes":
        bridge.goToUncommitted();
        break;
      case "pull-merge":
        resolver.pullMerge(bridge.CUR_REPO as unknown as string);
        break;
      case "pull-rebase":
        resolver.pullRebase(bridge.CUR_REPO as unknown as string);
        break;
      case "open-terminal":
        terminalCtrl.toggle(bridge.CUR_REPO as unknown as string);
        break;
      case "reset-head":
        resetHeadCtrl.promptForHash(bridge.CUR_REPO as unknown as string);
        break;
      case "force-push-lease":
        forcePushCtrl.forcePushLease(bridge.CUR_REPO as unknown as string);
        break;
      case "force-push-override":
        forcePushCtrl.forcePushOverride(bridge.CUR_REPO as unknown as string);
        break;
      case "filter-repo":
        // The IN_TAURI decision belongs to the caller here too — same
        // convention filterRepoCtrl.start()'s own doc comment describes
        // (mirrors resolver.startPick/bisectCtrl.start), now that this is
        // the wizard's only entry point (its old dedicated #filterRepoBtn
        // click handler in legacy/main.ts did the same branch).
        if (IN_TAURI) filterRepoCtrl.start(bridge.CUR_REPO as unknown as string);
        else filterRepoCtrl.openDemo();
        break;
    }
  });

  // Live refresh: notify refreshFromExternalChange (module scope, declared
  // above this `if (IN_TAURI)` block — see its own doc comment) whenever the
  // backend's file-watcher reports an external git-dir change.
  w.__TAURI__?.event.listen("repo-changed", () => {
    dlog("trigger", "file watcher: repo-changed (external git-dir change)");
    void refreshFromExternalChange();
  });

  // PER-43: start the plugin lifecycle-hook dispatcher — subscribes to the Tama
  // event bus so commit/undo/mutation moments fire matching plugin hooks. (The
  // repo-open/switch hooks are pushed from openRepo()'s tail in legacy/main.ts.)
  pluginHooksCtrl.start();

  // Streaming graph load: the "graph-batch" event listener is registered inside
  // legacy/main.ts (next to onGraphBatch, BEFORE its boot-time openRepo), not
  // here — a new window opens its repo during boot, so the listener must be up
  // before main.ts's own body runs. (Batches were briefly delivered via a
  // per-load ipc Channel to dodge an emit deadlock; reverted because a Channel
  // didn't reach a second app instance's window — the backend now emits via
  // emit_on_main, deadlock-free.)

  // Silent startup update probe — delayed so it never competes with the
  // repo-load/graph-layout work a cold launch is already doing. `check(true)`
  // settles quietly back to "idle" on "up to date"/error (see its own doc
  // comment); it only actually surfaces here when a real update WAS found.
  // Gated behind the Settings modal's "Automatically check for updates on
  // launch" toggle (default on, matching this probe's original always-on
  // behavior).
  //
  // ADVERSARIALLY-FOUND FIX: this used to only nudge Tama with a toast
  // pointing at "Help ▸ About" — a real update sat there ready to install,
  // but the user had to go find it themselves. Auto-opening the About panel
  // (same one the manual "Check for Updates…" menu item/button opens; safe
  // to call any time, no repo needed — see about.svelte.ts's own doc
  // comment) instead puts its "Download & Install" button directly in front
  // of them the moment a real update is found, VS Code's own "here's the
  // update, click to install" convention rather than a hint to go dig for it.
  if (loadSettings().autoCheckUpdates) {
    setTimeout(async () => {
      await updaterCtrl.check(true);
      if (updaterCtrl.phase === "available") {
        bridge.tama.set("hint");
        bridge.tama.say("GitCat v" + updaterCtrl.version + " is available. にゃ〜", 4200);
        aboutCtrl.show();
      }
    }, 4000);
  }
}
