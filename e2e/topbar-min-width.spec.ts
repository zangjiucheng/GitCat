// The topbar must fit at the narrowest window the app can actually be.
//
// This exists because of a bug report I over-diagnosed. Sweeping the viewport
// showed the topbar overflowing badly — 99px at 820, 359px at 560 — with the
// spill clipped by `body{overflow:hidden}` rather than reachable, so real
// buttons were off-screen. All true, and all unreachable: `page.setViewportSize`
// ignores the window's own minimum, and windows.rs pins that at 960 CSS px with
// no zoom wired up anywhere in the app. The topbar's floor is ~919px, so there
// is about 41px of margin that resizing can never cross.
//
// What is left is thin, though. At 960 everything except the search hint is
// already at its minimum width, so the next thing added to this bar — one more
// button, a longer label in some locale — is what spends the last of it. That
// is the regression this pins: not a layout, just "it fits", asserted at the
// one width where fitting is required.
import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/** Read the floor from windows.rs rather than copying it, so lowering the
 *  window minimum automatically tightens this test instead of silently leaving
 *  it checking a width the app no longer has. */
function windowMinWidth(): number {
  const src = readFileSync(new URL("../src-tauri/src/windows.rs", import.meta.url), "utf8");
  const m = /WINDOW_MIN_W:\s*f64\s*=\s*([\d.]+)/.exec(src);
  if (!m) throw new Error("WINDOW_MIN_W not found in windows.rs — this test needs it to know what width to check");
  return Math.round(parseFloat(m[1]));
}

// Every locale, because the labels are what vary: `sync-actions` is 215px in
// English, 202 in Chinese and 180 in Korean, and a future locale could be
// wider than any of them.
const LOCALES = ["en", "zh", "ko"];

async function skipWizard(page: Page) {
  const wizard = page.locator("#setupWizardScrim");
  await expect(wizard).toHaveClass(/\bon\b/);
  await page.keyboard.press("Escape");
  await expect(wizard).not.toHaveClass(/\bon\b/);
}

test("the topbar fits at the minimum window width, in every locale", async ({ page }) => {
  const minW = windowMinWidth();

  for (const loc of LOCALES) {
    await page.addInitScript((l) => localStorage.setItem("gitcat.locale", l), loc);
    await page.setViewportSize({ width: minW, height: 800 });
    await page.goto("/");
    await skipWizard(page);

    const m = await page.evaluate(() => {
      const bar = document.querySelector(".topbar") as HTMLElement;
      const hint = bar.querySelector(".cmd-hint") as HTMLElement;
      return {
        overflow: bar.scrollWidth - bar.clientWidth,
        // The hint is the only part with slack left, so how much it has is the
        // real headroom number — reported on failure, since "overflow: 12"
        // alone does not say how close the bar was before whatever broke it.
        hintW: Math.round(hint.getBoundingClientRect().width),
        hintMin: parseInt(getComputedStyle(hint).minWidth, 10),
      };
    });

    expect(
      m.overflow,
      `at the ${minW}px minimum window width, locale "${loc}", the topbar is ${m.overflow}px wider than itself — ` +
        `content past that edge is clipped by body{overflow:hidden}, not scrollable, so it is simply gone. ` +
        `The search hint was at ${m.hintW}px against a ${m.hintMin}px floor, which is where the remaining slack lives.`,
    ).toBe(0);
  }
});
