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
  // bisect canvas bridge: island → legacy row-model / cues (kept vanilla)
  syncBisectMarks,
  focusBisectCurrent,
  clearBisectMarks,
  demoBisectStatus,
  demoBisectMark,
  renderBisect,
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
} from "./main";
