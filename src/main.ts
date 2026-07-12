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
import Remotes from "./islands/remotes/Remotes.svelte";
import { remotesCtrl } from "./islands/remotes/remotes.svelte.ts";
import { resolver } from "./islands/resolver/resolver.svelte.ts";
import { forcePushCtrl } from "./islands/forcepush/forcepush.svelte.ts";
import ExportPatches from "./islands/exportpatches/ExportPatches.svelte";
import { exportPatchesCtrl } from "./islands/exportpatches/exportpatches.svelte.ts";
import { applyPatchCtrl } from "./islands/applypatch/applypatch.svelte.ts";
import PickaxeSearch from "./islands/pickaxesearch/PickaxeSearch.svelte";
import { pickaxeSearchCtrl } from "./islands/pickaxesearch/pickaxesearch.svelte.ts";
import Dashboard from "./islands/dashboard/Dashboard.svelte";
import { dashboardCtrl } from "./islands/dashboard/dashboard.svelte.ts";
import ExternalTools from "./islands/externaltools/ExternalTools.svelte";
import { externalToolsCtrl } from "./islands/externaltools/externaltools.svelte.ts";
import DanglingRecovery from "./islands/danglingrecovery/DanglingRecovery.svelte";
import { danglingRecoveryCtrl } from "./islands/danglingrecovery/danglingrecovery.svelte.ts";
import RepoFiles from "./islands/repofiles/RepoFiles.svelte";
import { repoFilesCtrl } from "./islands/repofiles/repofiles.svelte.ts";
import FilterRepo from "./islands/filterrepo/FilterRepo.svelte";
import { filterRepoCtrl } from "./islands/filterrepo/filterrepo.svelte.ts";
import RebasePlan from "./islands/rebaseplan/RebasePlan.svelte";
import Blame from "./islands/blame/Blame.svelte";
import FileHistory from "./islands/filehistory/FileHistory.svelte";
import SetupWizard from "./islands/setupwizard/SetupWizard.svelte";
import { setupWizardCtrl } from "./islands/setupwizard/setupwizard.svelte.ts";
import Cmdk from "./islands/cmdk/Cmdk.svelte";
import { cmdkCtrl } from "./islands/cmdk/cmdk.svelte.ts";
import VimNav from "./islands/vimnav/VimNav.svelte";
import About from "./islands/about/About.svelte";
import { aboutCtrl } from "./islands/about/about.svelte.ts";
import Detail from "./islands/detail/Detail.svelte";
import { workdirCtrl } from "./islands/workdir/workdir.svelte.ts";
import BisectDrawer from "./islands/bisectdrawer/BisectDrawer.svelte";
import { openBisectEntry } from "./islands/bisectdrawer/bisectdrawer.svelte.ts";
import Sidebar from "./islands/sidebar/Sidebar.svelte";
import { sidebarCtrl } from "./islands/sidebar/sidebar.svelte.ts";
import { IN_TAURI } from "./ipc/env";
import * as bridge from "./legacy/bridge";

mount(Resolver, { target: document.body });
mount(CommitMenu, { target: document.body });
mount(Bisect, { target: document.body });
mount(FilterRepo, { target: document.body });
mount(RebasePlan, { target: document.body });
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
if (IN_TAURI) {
  if (!bridge.CUR_REPO && !setupWizardCtrl.hasBeenDismissed()) setupWizardCtrl.start();
} else {
  setupWizardCtrl.openDemo();
}

mount(Cmdk, { target: document.body });
mount(VimNav, { target: document.body });
mount(About, { target: document.body });
// Workdir is NOT mounted as its own top-level tree here even though the
// design spec's own §4 "Wiring" prose describes a second `mount(Workdir, …)`
// alongside Detail's — that would double-render the panel: Detail.svelte
// (below) already peer-imports the Workdir COMPONENT (not just its
// controller) and nests `<Workdir />` inline as the leading branch of its own
// `{#if}` chain (exactly as the spec's own Detail.svelte snippet in that same
// section shows), so mounting Workdir a second time onto the identical
// `#detail` node would render the staging panel twice whenever
// `workdirCtrl.selected` is true. One mount point, one source of truth.
mount(Detail, { target: document.getElementById("detail")! });
// Bisect's pre-start floating panel — see index.html's own doc comment on
// the removed DRAWER section for why this (and Reflog/Rerere/Plumbing
// below) are no longer mounted into a permanent drawer pane. MUST mount
// inside #canvasWrap, not document.body: its position:absolute floats
// relative to that element, same as #deltaReadout/.hint.
mount(BisectDrawer, { target: document.getElementById("bisectPanelMount")! });

mount(Sidebar, { target: document.getElementById("sidebarRefs")! });
sidebarCtrl.refresh(bridge.CUR_REPO as unknown as string);

// Reflog/Rerere/Plumbing: on-demand modals now (Tools menu / ⌘K — see
// menu.rs / cmdk.svelte.ts), each opened via its own controller's show()
// rather than mounted into a drawer pane that was always present. No initial
// refresh() call needed here either — show() always re-fetches fresh (see
// each controller's own doc comment), so there's nothing useful to preload
// before the user actually opens one.
mount(Reflog, { target: document.body });
mount(Rerere, { target: document.body });
mount(Plumbing, { target: document.body });
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

// Native app menu -> frontend action bridge (see src-tauri/src/menu.rs).
// Only the items whose action lives in Svelte-controller land forward here —
// the Help links (opened via the opener plugin) and every predefined item
// (Cut/Copy/Paste/Select All/Quit/etc.) are handled entirely on the Rust/OS
// side and never reach this listener. window.__TAURI__ (not a static
// @tauri-apps/api import) matches every other real-Tauri-only call site in
// this codebase (see setupwizard.svelte.ts's pickDirectory/armDropZone).
if (IN_TAURI) {
  const w = window as unknown as { __TAURI__?: any };
  w.__TAURI__?.event.listen("menu-action", (e: { payload: string }) => {
    switch (e.payload) {
      case "open-repo":
        bridge.pickRepo();
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
      case "about":
        aboutCtrl.show();
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
      case "repositories":
        dashboardCtrl.show();
        break;
      case "external-tools":
        externalToolsCtrl.show();
        break;
      case "dangling-recovery":
        danglingRecoveryCtrl.show(bridge.CUR_REPO as unknown as string);
        break;
      case "repo-files":
        repoFilesCtrl.show(bridge.CUR_REPO as unknown as string);
        break;
      case "pull-merge":
        resolver.pullMerge(bridge.CUR_REPO as unknown as string);
        break;
      case "pull-rebase":
        resolver.pullRebase(bridge.CUR_REPO as unknown as string);
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

  // Live refresh: the backend watches the open repo's git-dir and emits this
  // when something changes it from OUTSIDE the app (a terminal commit,
  // another tool, a background fetch, a hook) — see src-tauri/src/watch.rs.
  // Re-entrancy guarded so a burst of external activity can't queue up
  // overlapping reloads.
  let repoChangeReloadInFlight = false;
  w.__TAURI__?.event.listen("repo-changed", async () => {
    if (repoChangeReloadInFlight || !bridge.CUR_REPO) return;
    repoChangeReloadInFlight = true;
    try {
      await bridge.reloadGraph(true);
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
    } finally {
      repoChangeReloadInFlight = false;
    }
  });
}
