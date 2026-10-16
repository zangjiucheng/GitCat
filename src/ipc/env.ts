// IN_TAURI lives here — the generated bindings.ts doesn't provide it. True only
// inside the Tauri webview (where window.__TAURI__.core exists); false in the
// plain-browser design mode, which drives the islands' demo branches.
export const IN_TAURI: boolean = !!(
  window as unknown as { __TAURI__?: { core?: unknown } }
).__TAURI__?.core;

// True only in a dedicated diff-viewer window — windows.rs's
// open_diff_in_new_window spawns a process whose own window URL carries BOTH
// `?repo=` and `?commit=` (see its own doc comment); legacy/main.ts's boot
// sequence checks this SAME pair to skip the normal repo-wide graph load
// entirely (a diff-only window has nothing else to show) and go straight to
// detailCtrl.selectBySha. A plain property read, not a parsed URLSearchParams
// instance, since this needs to be a stable `const` other modules (detail.
// svelte.ts, Detail.svelte) can import and branch on without each re-parsing
// location.search themselves.
export const DIFF_ONLY_WINDOW: boolean = (() => {
  const p = new URLSearchParams(location.search);
  return !!(p.get("repo") && p.get("commit"));
})();
