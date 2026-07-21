import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const portraits = {
  curious: "curious",
  sleep: "sleep",
  thinking: "thinking",
  shocked: "warn",
  alarm: "danger",
  happy: "celebrate",
  confident: "rescue",
  hero: "greeting",
};

const outputDir = resolve("public/tama/portraits");
await mkdir(outputDir, { recursive: true });

const server = await createServer({
  logLevel: "error",
  server: { host: "127.0.0.1", port: 1431, strictPort: true },
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 380, height: 520 }, deviceScaleFactor: 1 });

  for (const [pose, state] of Object.entries(portraits)) {
    await page.goto(`http://127.0.0.1:1431/scripts/tama-portrait.html?state=${state}`);
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    await page.waitForTimeout(850);
    await page.locator("#mount").screenshot({
      path: resolve(outputDir, `${pose}.png`),
      omitBackground: true,
    });
  }
} finally {
  await browser?.close();
  await server.close();
}
