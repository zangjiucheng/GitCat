/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({

  plugins: [svelte()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    // Bind IPv4 loopback (not the default `localhost`, which macOS resolves to
    // IPv6 ::1) so it matches tauri.conf.json's devUrl 127.0.0.1:1420 — otherwise
    // the `tauri dev` readiness poll waits forever even though Vite is up.
    // TAURI_DEV_HOST still wins for LAN/mobile dev.
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  // Vitest — Svelte 5 islands (src/islands/**) run under jsdom. See
  // src/islands/**/*.svelte.test.ts for the controller test suites.
  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.{test,spec}.ts"],
  },
}));
