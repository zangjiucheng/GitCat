// IN_TAURI lives here — the generated bindings.ts doesn't provide it. True only
// inside the Tauri webview (where window.__TAURI__.core exists); false in the
// plain-browser design mode, which drives the islands' demo branches.
export const IN_TAURI: boolean = !!(
  window as unknown as { __TAURI__?: { core?: unknown } }
).__TAURI__?.core;

// True on macOS. Gates the "Install 'gitcat' command in PATH" action/section,
// which is macOS-only (Linux packages already put gitcat on PATH; Windows is a
// planned follow-up — see cli_shim.rs / install_cli_shim). navigator.platform
// is "MacIntel" on a Mac WKWebView; userAgent is the fallback.
export const IS_MAC: boolean = /Mac/i.test(
  navigator.platform || navigator.userAgent || "",
);
