// Generates the docs/README screenshots by driving the app in its browser
// design/demo mode (the same mode the Playwright e2e suite uses) and capturing
// each screen. Run it with:
//
//   pnpm screenshots
//
// It starts a throwaway Vite dev server on 127.0.0.1:1420, captures into
// docs/public/screenshots/, then shuts the server down. These are BROWSER-mode
// shots (demo data, no native window chrome or OS menu) — good enough for docs,
// and easy to regenerate. Swap in native captures anytime by overwriting the
// PNGs of the same name.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdirSync } from "node:fs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = fileURLToPath(new URL("../docs/public/screenshots", import.meta.url));
const URL_ = "http://127.0.0.1:1420/"; // 127.0.0.1, not localhost: vite binds IPv4 (see vite.config.ts)
// Design-mode artefacts that shouldn't appear in docs shots: the DEV badge, the
// perf HUD overlay, and the transient top toast. Tama and her speech stay.
const HIDE = ".dev-badge,.hud,#hud,.top-toast{display:none!important}";

mkdirSync(OUT, { recursive: true });

// ── throwaway dev server ─────────────────────────────────────────────────────
const vite = spawn("pnpm", ["exec", "vite", "--port", "1420", "--strictPort"], {
  cwd: ROOT,
  stdio: "ignore",
  detached: true,
});
async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(URL_);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error("vite dev server never came up on " + URL_);
}
function stopServer() {
  try {
    process.kill(-vite.pid); // kill the whole process group
  } catch {
    /* already gone */
  }
}

try {
  await waitForServer();
  const browser = await chromium.launch();

  async function newPage() {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    return page;
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

  // ── fresh context (clean localStorage) for the Chinese UI ────────────────────
  const zh = await newPage();
  await boot(zh);
  try {
    await zh.getByRole("button", { name: "中文" }).click({ timeout: 3000 });
  } catch {
    console.warn("Chinese button not found on the wizard language step");
  }
  await sleep(600);
  await zh.keyboard.press("Escape");
  await sleep(1500);
  await shot(zh, "chinese");

  await browser.close();
} finally {
  stopServer();
}
