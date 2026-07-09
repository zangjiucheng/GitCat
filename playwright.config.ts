import { defineConfig, devices } from "@playwright/test";

// E2E runs the real Svelte frontend in a real browser via `vite`'s dev
// server (plain browser mode — IN_TAURI is false until e2e/fixtures/tauriMock.ts
// patches it in per-test), NOT the packaged Tauri app. See tauriMock.ts's file
// header for why (Playwright can't drive Tauri's native webview) and for the
// scope this does and doesn't cover.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm exec vite --port 1420 --strictPort",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
