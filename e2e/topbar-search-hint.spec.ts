// The topbar's "Search commits, refs, actions…" hint at narrow window widths.
//
// It is a flex item with a 320px preferred width that may shrink, holding a
// label and a ⌘K badge. The label had no `white-space`, so as soon as the bar
// squeezed the box — from about a 1000px window down — the sentence wrapped.
// A two-line hint is 52px tall inside a 46px bar, so it did not merely look
// cramped: it outgrew the bar it sits in.
//
// Asserted as "one line, and the badge is still there" rather than as a pixel
// width, because the label is expected to truncate and how much of it survives
// is a styling detail. The height is the part that was actually wrong.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

// Widths from comfortable down to cramped. 1000 is where the wrap used to
// start; the rest are past it.
const WIDTHS = [1440, 1280, 1100, 1000, 900, 820, 700, 560];

async function skipWizard(page: Page) {
  const wizard = page.locator("#setupWizardScrim");
  await expect(wizard).toHaveClass(/\bon\b/);
  await page.keyboard.press("Escape");
  await expect(wizard).not.toHaveClass(/\bon\b/);
}

test("the search hint stays on one line at every window width", async ({ page }) => {
  await page.goto("/");
  await skipWizard(page);
  await expect(page.locator(".cmd-hint")).toBeVisible();

  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 800 });
    const m = await page.evaluate(() => {
      const hint = document.querySelector(".cmd-hint") as HTMLElement;
      const span = hint.querySelector("span") as HTMLElement;
      const bar = document.querySelector(".topbar") as HTMLElement;
      const r = (el: HTMLElement) => el.getBoundingClientRect();
      const cs = getComputedStyle(span);
      return {
        lines: Math.round(r(span).height / parseFloat(cs.lineHeight || "17")),
        hintH: Math.round(r(hint).height),
        barH: Math.round(r(bar).height),
      };
    });
    expect(m.lines, `at ${w}px the hint label must not wrap`).toBe(1);
    expect(m.hintH, `at ${w}px the hint must fit inside the ${m.barH}px bar`).toBeLessThanOrEqual(m.barH);
  }
});

test("the ⌘K badge survives even when the label is truncated away", async ({ page }) => {
  // The label yields its space first because the badge is the part that says
  // what the box DOES. A hint that truncated the badge instead would have kept
  // its height and lost its meaning.
  await page.goto("/");
  await skipWizard(page);

  for (const w of [1440, 700, 560]) {
    await page.setViewportSize({ width: w, height: 800 });
    const badge = await page.evaluate(() => {
      const hint = document.querySelector(".cmd-hint") as HTMLElement;
      const kbd = hint.querySelector("kbd") as HTMLElement;
      const hb = hint.getBoundingClientRect();
      const kb = kbd.getBoundingClientRect();
      const shown = Math.max(0, Math.min(kb.right, hb.right) - Math.max(kb.left, hb.left));
      return { width: Math.round(kb.width), visible: Math.round(shown), text: (kbd.textContent ?? "").trim() };
    });
    expect(badge.width, `at ${w}px the badge must still be laid out`).toBeGreaterThan(0);
    expect(badge.visible, `at ${w}px the badge must be fully inside the hint`).toBe(badge.width);
    expect(badge.text).toContain("K");
  }
});
