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
  // Height of the pinned "Uncommitted changes" header this frame (0 when it
  // isn't shown) — every "scroll a row into view" computation outside this
  // file (⌘K jump-to-row, the bisect drawer's focus-current) must subtract
  // it from the usable viewport height exactly like legacy/main.ts's own
  // draw()/hitTest()/zoomAt()/reloadGraph() do. Hoisted `function`, so no
  // TDZ risk (same reasoning as select/openRepo above).
  bandH,
  select,
  // selects the pinned "Uncommitted changes" row (state.selectedRow=-2) and
  // opens workdirCtrl's staging/commit view in #detail — the workdir-row
  // counterpart to select(row)/deselect() above. Hoisted `function`, so no
  // TDZ risk (same reasoning as select/openRepo above).
  selectWorkdir,
  // fast jump to the pinned "Uncommitted changes" row (Tools menu / ⌘K,
  // "Uncommitted Changes" — see menu.rs/cmdk.svelte.ts): selectWorkdir() plus
  // a scroll reset, so a user deep in history lands somewhere oriented.
  // Hoisted `function`, so no TDZ risk (same reasoning as select/openRepo above).
  goToUncommitted,
  // design-mode (plain-browser) synthetic data helpers, shared by generateGraph
  // and ⌘K's fallback index when no real repo/BACKEND is loaded.
  hhex,
  msgOf,
  AUTHORS,
  fakeAgo,
  relTime,
  // native folder-picker flow (the empty-state hero's "Open a repository…" button)
  pickRepo,
  // "Close Repository" (File menu, see src/main.ts's "menu-action" listener)
  // — the only in-app way back to the empty/default state without quitting.
  closeRepo,
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
  // remote sync (fetch/pull/push) — the topbar buttons' own handlers, reused
  // by the native menu's "menu-action" listener (see src/main.ts) so both
  // entry points share one implementation.
  doFetch,
  doPull,
  doPush,
  // Settings island (src/islands/settings) calls this for its theme picker —
  // applies "system"/"light"/"dark" to the DOM AND persists via
  // settings.svelte.ts's saveSettings(), same live-re-export safety as
  // openRepo/pickRepo above (hoisted `function`, no TDZ risk).
  applyThemeMode,
  // Submodule navigation stack: enterSubmodule(absolutePath) pushes the
  // current repo then opens the submodule via openRepo above;
  // goBackToParent() pops and reopens the popped path. NAV_STACK is the
  // stack itself (a live binding, same rationale as CUR_REPO above — read it
  // at call time, e.g. `bridge.NAV_STACK.length`, never destructure it into
  // a local const). Sidebar.svelte's per-row "Open" action calls
  // enterSubmodule directly; the topbar "← Back to <parent repo name>"
  // affordance is legacy-owned chrome (see legacy/main.ts's own
  // updateBackToParentBtn), so it doesn't need a bridge re-export of its own.
  enterSubmodule,
  goBackToParent,
  NAV_STACK,
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
