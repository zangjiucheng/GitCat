// Generates the docs/README screenshots by driving the app in its browser
// design/demo mode (the same mode the Playwright e2e suite uses) and capturing
// each screen. Run it with:
//
//   pnpm screenshots
//
// It boots a throwaway Vite dev server on 127.0.0.1:1420 via Vite's programmatic
// API (no child process — so it works the same on macOS/Linux/Windows and shuts
// down cleanly), captures into docs/public/screenshots/, then closes it. These
// are BROWSER-mode shots (demo data, no native window chrome or OS menu) — good
// enough for docs, and easy to regenerate. Swap in native captures anytime by
// overwriting the PNGs of the same name. Set SHOTS_OUT to capture elsewhere.
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdirSync } from "node:fs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = process.env.SHOTS_OUT || fileURLToPath(new URL("../docs/public/screenshots", import.meta.url));
const URL_ = "http://127.0.0.1:1420/"; // 127.0.0.1, not localhost: vite binds IPv4 (see vite.config.ts)
// Design-mode artefacts that shouldn't appear in docs shots: the DEV badge, the
// perf HUD overlay, and the transient top toast. Tama and her speech stay.
const HIDE = ".dev-badge,.hud,#hud,.top-toast{display:none!important}";

mkdirSync(OUT, { recursive: true });

let server;
let browser;
async function shutdown() {
  try {
    await browser?.close();
  } catch {
    /* already closed */
  }
  try {
    await server?.close();
  } catch {
    /* already closed */
  }
}
// Clean up the dev server even if the run is aborted (Ctrl-C) mid-capture.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await shutdown();
    process.exit(1);
  });
}

try {
  // Programmatic Vite server: no `spawn("pnpm", …)` (which fails on Windows,
  // where pnpm is a .cmd shim) and no process-group kill (unsupported on
  // Windows) — `server.close()` tears it down cleanly on every OS. It loads the
  // project's vite.config.ts (root = repo root) itself, so port/host match dev.
  server = await createServer({ root: ROOT, server: { port: 1420, strictPort: true } });
  await server.listen();

  browser = await chromium.launch();

  async function newPage() {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    return ctx.newPage();
  }
  async function boot(page) {
    await page.goto(URL_, { waitUntil: "load" });
    await page.addStyleTag({ content: HIDE });
    await sleep(2600); // let the demo graph paint
  }
  async function shot(page, name) {
    await page.addStyleTag({ content: HIDE });
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log("captured", name);
  }

  // ── English / dark session: graph, palette, detail, settings, light ──────────
  const page = await newPage();
  await boot(page);
  await page.keyboard.press("Escape"); // skip the setup wizard
  await sleep(1500);
  await shot(page, "graph");

  await page.keyboard.press("Meta+k");
  await sleep(900);
  await shot(page, "command-palette");
  await page.keyboard.press("Escape");
  await sleep(400);

  await page.mouse.click(760, 235); // select a commit -> detail panel + diff
  await sleep(1300);
  await shot(page, "commit-detail");

  await page.keyboard.press("Meta+k");
  await sleep(400);
  await page.keyboard.type("settings");
  await sleep(600);
  await page.keyboard.press("Enter");
  await sleep(1000);
  await shot(page, "settings");
  await page.keyboard.press("Escape");
  await sleep(400);

  const themeBtn = page.locator("#themeBtn");
  if (await themeBtn.count()) {
    await themeBtn.click();
    await sleep(1200);
    await shot(page, "graph-light");
  }

  // ── one fresh context per non-English locale ─────────────────────────────────
  // A fresh context each time, not a language switch inside the existing one:
  // the wizard's language step only appears on first run, and it reads
  // localStorage to decide that. Reusing a context would skip straight past it.
  // Labels are the wizard's own buttons, which come from LOCALES in
  // src/i18n/i18n.svelte.ts — add a locale there and it belongs here too.
  for (const [label, name] of [
    ["中文", "chinese"],
    ["한국어", "korean"],
  ]) {
    const page = await newPage();
    await boot(page);
    try {
      await page.getByRole("button", { name: label }).click({ timeout: 3000 });
    } catch {
      console.warn(`"${label}" button not found on the wizard language step`);
    }
    await sleep(600);
    await page.keyboard.press("Escape");
    await sleep(1500);
    await shot(page, name);
  }
} finally {
  await shutdown();
}
