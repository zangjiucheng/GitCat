// IN_TAURI lives here — the generated bindings.ts doesn't provide it. True only
// inside the Tauri webview (where window.__TAURI__.core exists); false in the
// plain-browser design mode, which drives the islands' demo branches.
export const IN_TAURI: boolean = !!(
  window as unknown as { __TAURI__?: { core?: unknown } }
).__TAURI__?.core;
