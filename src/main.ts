// Frontend entry. Boot the legacy vanilla app (side-effect import: it builds the
// canvas, sidebar, drawer, mascot and starts the RAF loop), then mount the
// Svelte islands over the DOM. Islands render their own scrim markup into
// <body>, so the old #conflictScrim / #bisectScrim blocks are gone from the HTML.
import "./legacy/main.ts";
import { mount } from "svelte";
import Resolver from "./islands/resolver/Resolver.svelte";
import Bisect from "./islands/bisect/Bisect.svelte";
import Reflog from "./islands/reflog/Reflog.svelte";
import { reflogCtrl } from "./islands/reflog/reflog.svelte.ts";
import Rerere from "./islands/rerere/Rerere.svelte";
import { rerereCtrl } from "./islands/rerere/rerere.svelte.ts";
import Plumbing from "./islands/plumbing/Plumbing.svelte";
import FilterRepo from "./islands/filterrepo/FilterRepo.svelte";
import SetupWizard from "./islands/setupwizard/SetupWizard.svelte";
import { setupWizardCtrl } from "./islands/setupwizard/setupwizard.svelte.ts";
import Cmdk from "./islands/cmdk/Cmdk.svelte";
import { cmdkCtrl } from "./islands/cmdk/cmdk.svelte.ts";
import Detail from "./islands/detail/Detail.svelte";
import BisectDrawer from "./islands/bisectdrawer/BisectDrawer.svelte";
import Sidebar from "./islands/sidebar/Sidebar.svelte";
import { sidebarCtrl } from "./islands/sidebar/sidebar.svelte.ts";
import { IN_TAURI } from "./ipc/env";
import * as bridge from "./legacy/bridge";

mount(Resolver, { target: document.body });
mount(Bisect, { target: document.body });
mount(FilterRepo, { target: document.body });
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
mount(Detail, { target: document.getElementById("detail")! });
mount(BisectDrawer, { target: document.getElementById("pane-bisect")! });

mount(Sidebar, { target: document.getElementById("sidebarRefs")! });
sidebarCtrl.refresh(bridge.CUR_REPO as unknown as string);

// Drawer-PANE islands (not modals): mounted straight into their own pane so
// the existing .pane/.pane.on show/hide + drawer-tabs wiring in legacy/main.ts
// governs visibility. The initial refresh() calls below cover the case where
// a repo is already open by the time these mount (or, in browser design mode,
// seed each pane's demo data immediately); ensureDrawerOpen's per-tab hook
// (see legacy/main.ts) keeps reflog/rerere live afterward on every tab click.
mount(Reflog, { target: document.getElementById("pane-reflog")! });
reflogCtrl.refresh(bridge.CUR_REPO);

mount(Rerere, { target: document.getElementById("pane-rerere")! });
rerereCtrl.refresh(bridge.CUR_REPO);

// Plumbing is pure on-demand (no refresh() method exists — see
// plumbing.svelte.ts) so it only needs a mount, never an initial data call.
const plumbingPane = document.getElementById("pane-plumbing");
if (plumbingPane) mount(Plumbing, { target: plumbingPane });

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
    }
  });
}
