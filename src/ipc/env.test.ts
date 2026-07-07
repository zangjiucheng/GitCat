// IN_TAURI is computed once, at import time, from `window.__TAURI__.core`. It
// isn't consumed by the island controllers directly (they track their own
// `.demo` flag instead) — this is the one place it's read, so this is where we
// exercise both branches. Vitest doesn't let you mutate a live-bound export,
// so each case sets `window.__TAURI__` *before* a fresh dynamic import
// (paired with `vi.resetModules()` so the module body re-runs).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type WithTauri = typeof window & { __TAURI__?: { core?: unknown } };

afterEach(() => {
  delete (window as WithTauri).__TAURI__;
});

beforeEach(() => {
  vi.resetModules();
});

describe("IN_TAURI", () => {
  it("is false in the plain-browser design-mode environment", async () => {
    delete (window as WithTauri).__TAURI__;
    const { IN_TAURI } = await import("./env");
    expect(IN_TAURI).toBe(false);
  });

  it("is true when window.__TAURI__.core is present (real webview)", async () => {
    (window as WithTauri).__TAURI__ = { core: {} };
    const { IN_TAURI } = await import("./env");
    expect(IN_TAURI).toBe(true);
  });
});
