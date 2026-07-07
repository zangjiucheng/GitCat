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
import Cmdk from "./islands/cmdk/Cmdk.svelte";
import Detail from "./islands/detail/Detail.svelte";
import BisectDrawer from "./islands/bisectdrawer/BisectDrawer.svelte";
import * as bridge from "./legacy/bridge";

mount(Resolver, { target: document.body });
mount(Bisect, { target: document.body });
mount(FilterRepo, { target: document.body });
mount(Cmdk, { target: document.body });
mount(Detail, { target: document.getElementById("detail")! });
mount(BisectDrawer, { target: document.getElementById("pane-bisect")! });

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
