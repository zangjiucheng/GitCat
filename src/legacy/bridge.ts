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
  // Additive, subscribable Tama event bus (legacy/main.ts) — islands call
  // `bridge.tamaBus.subscribe(fn)` to observe the SAME event stream the mascot
  // reacts to. A mid-file `export const` in legacy/main.ts, so this live
  // re-export is TDZ-safe (same reasoning as CUR_REPO above); the ~28 existing
  // `bridge.tama.event(...)` call sites are untouched.
  tamaBus,
  TAMA_IMG,
  // Tama skin registry (PER-47): a plugin skin overlays some/all of the 8
  // built-in poses. `applyTamaSkin(poses)` / `clearTamaSkin()` are mid-file
  // `export const`s and `tamaPose(key)` a mid-file `export function` in
  // legacy/main.ts — same live-re-export TDZ-safety as tamaBus/CUR_REPO above.
  // The settings skin picker calls apply/clear; tamagallery reads tamaPose so
  // the gallery shows the ACTIVE skin's poses (built-ins are the fallback).
  applyTamaSkin,
  clearTamaSkin,
  tamaPose,
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
  goToHead,
  // Jump to a commit by full oid — the sidebar's click-to-jump (see
  // sidebar.svelte.ts's jumpToRef). Returns false when no loaded row has that
  // oid, leaving the "why not" message to the caller, which knows the ref name.
  goToOid,
  // Whether the current graph load has finished streaming. Read by jumpToRef to
  // tell "not loaded yet" from "not in the graph at all". A mid-file `export
  // let` in legacy/main.ts, so this live re-export is TDZ-safe — same reasoning
  // as CUR_REPO above.
  graphStreamComplete,
  openHelpPage,
  // Focus mode — collapse/restore both side panels (⌘\); a hoisted function too.
  toggleFocusMode,
  // design-mode (plain-browser) synthetic data helpers, shared by generateGraph
  // and ⌘K's fallback index when no real repo/BACKEND is loaded.
  hhex,
  msgOf,
  AUTHORS,
  fakeAgo,
  relTime,
  // Absolute-date counterpart to relTime, above — see its own doc comment in
  // legacy/main.ts (used by detail.svelte.ts's commitMeta() to show a real
  // date alongside the relative "X ago" one).
  absTime,
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
  // Settings island's "show all tags on a commit" toggle — applies to the
  // canvas draw loop immediately (module-level cached flag, not read from
  // localStorage per frame), same live-re-export safety as applyThemeMode
  // above (hoisted `function`, no TDZ risk).
  setGraphShowAllTags,
  // Settings island's "label priority" (Tags-first / Branches-first) — reorders
  // the graph's ref labels live, same live-re-export safety as setGraphShowAllTags.
  setGraphLabelPriority,
  // Settings island's "label layout" (Inline / Left column) — flips
  // branchColW live via recomputeLayout(), same live-re-export safety as
  // setGraphLabelPriority above.
  setGraphLabelLayout,
  // Settings island's "Tama" visibility toggle — applies the `.tama-off` CSS
  // class immediately, same live-re-export safety as applyThemeMode/
  // setGraphShowAllTags above (hoisted `function`, no TDZ risk).
  setTamaEnabled,
  // PER-54 Tama customization (frontend-only, persisted by the Settings island
  // in localStorage gitcat.settings). setTamaMotionPreset("default"|"calm"|
  // "lively") scales the sticky/dwell auto-revert hold + swaps the idle
  // behavior; setTamaPoseOverrides({state:poseKey,…}) overrides which of the 8
  // painted poses each FSM state shows ({} = no overrides = built-in POSE map).
  // Both are mid-file hoisted `export function`s in legacy/main.ts — same live-
  // re-export TDZ-safety as setTamaEnabled/applyTamaSkin above.
  setTamaMotionPreset,
  setTamaPoseOverrides,
  // "graph-batch" event handler — legacy/main.ts's own event listener forwards
  // every batch here (mirrors "repo-changed"/refreshFromExternalChange's own
  // shape). Hoisted `function`, no TDZ risk (same reasoning as
  // openRepo/pickRepo above).
  onGraphBatch,
  // Submodule navigation: enterSubmodule(absolutePath) opens the submodule via
  // openRepo above; NAV_STACK is the derived ancestor stack (a live binding, same
  // rationale as CUR_REPO above — read it at call time, e.g.
  // `bridge.NAV_STACK.length`, never destructure it into a local const).
  // Sidebar.svelte's per-row "Open" action calls enterSubmodule directly; the
  // submodule-nav strip's breadcrumb handles going back up to any ancestor (the
  // old topbar "← Back" button that used to is gone).
  enterSubmodule,
  // The jump entry point the submodule-nav strip (src/islands/submodulenav) uses
  // for sibling / breadcrumb / tree jumps: navigateToRepo(absolutePath) == open
  // that repo. openRepo re-derives NAV_STACK from git's superproject chain and
  // refreshes the strip on every open, so nothing tracks a chain by hand.
  // Hoisted `function`, no TDZ risk.
  navigateToRepo,
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

// PER-53: Tama's per-character voice-pitch multiplier lives in the leaf
// legacy/sound.ts (it can't import from legacy/main.ts — see sound.ts's own
// header), so it's re-exported here directly from ./sound rather than through
// ./main. legacy/main.ts's applyTamaSkin(poses, voicePitch)/clearTamaSkin()
// already drive it for the skin picker; this seam lets an island set the pitch
// on its own if it ever needs to. Named `setTamaVoicePitch` to match the other
// `setTama*` bridge verbs (setTamaEnabled above).
export { setVoicePitch as setTamaVoicePitch } from "./sound.ts";
