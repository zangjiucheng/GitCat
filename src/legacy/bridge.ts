// Typed seam onto the legacy vanilla module for the Svelte islands.
//
// LIVE re-exports (`export … from`), never eager reads: the legacy↔island import
// cycle is TDZ-safe only because a live binding defers dereference to call time,
// after every module has finished evaluating. `Tama`/`TAMA_IMG` are const-
// initialised partway through legacy/main.ts, so an eager `const x = legacy.Tama`
// here would hit the temporal dead zone — a live re-export never does.
//
// These are `any` (legacy is @ts-nocheck); the type-safety win lives in ../ipc.
export {
  reloadGraph,
  cheer,
  highlight,
  Tama as tama,
  TAMA_IMG,
  requestRedraw,
  // the open repo's absolute path (or null when none is open) — a live
  // binding (see the file header): read it as `bridge.CUR_REPO` at call time,
  // never destructure it into a local const, or you'll freeze a stale value.
  CUR_REPO,
  // canvas/graph state (⌘K, and later islands, reach into these to jump to a
  // row) — `G`/`BACKEND` are live/reassigned bindings, read at call time like
  // `CUR_REPO`; `state`/`layout`/`view`/`cv` are stable object refs whose
  // PROPERTIES mutate in place, so re-exporting the reference is safe.
  G,
  BACKEND,
  state,
  layout,
  view,
  cv,
  clampScroll,
  select,
  // design-mode (plain-browser) synthetic data helpers, shared by generateGraph
  // and ⌘K's fallback index when no real repo/BACKEND is loaded.
  hhex,
  msgOf,
  AUTHORS,
  fakeAgo,
  relTime,
  // native folder-picker flow (the empty-state hero's "Open a repository…" button)
  pickRepo,
  // drawer-wide tab-switching chrome (stateless, shared by all 4 drawer tabs)
  ensureDrawerOpen,
  // shared single-step destructive-confirm scrim (delete-branch reuses this;
  // filter-repo has its own dedicated multi-step wizard instead, see FilterRepo.svelte)
  armDanger,
  // topbar branch pill (#pillBranch/#pillAb) — stays legacy-owned, sidebarCtrl
  // calls this after every refresh rather than touching those DOM nodes itself.
  updateBranchPill,
  // real "open a repository" hand-off (native picker -> load_graph -> render)
  // — the setup wizard's final step calls this exactly like pickRepo() does.
  // Safe to live-re-export: a hoisted `function` declaration, not a `const`,
  // so there's no TDZ risk (see file header).
  openRepo,
} from "./main";

// bisect canvas bridge: bisectCtrl (the real modal, src/islands/bisect) syncs
// its live/demo status INTO the drawer's local row-model via these — moved
// here (not ./main) when the bisect drawer chrome itself became an island;
// bisectCtrl's own code is UNCHANGED, it still calls bridge.syncBisectMarks
// etc. exactly as before, only the re-export source moved.
export {
  syncBisectMarks,
  focusBisectCurrent,
  clearBisectMarks,
  demoBisectStatus,
  demoBisectMark,
} from "../islands/bisectdrawer/bisectdrawer.svelte.ts";
