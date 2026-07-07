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
} from "./main";
