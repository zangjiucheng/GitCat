// The palette owns the keyboard while it is open (#184).
//
// scopedefs.ts had declared a `palette` scope — rank 200, modal — since the
// keymap landed, and nothing ever pushed it. With only `global` on the stack
// there was nothing above the pane-focus chords to stop them, so ⌘1 moved
// focus to the canvas BEHIND an open palette and left a modal on screen that
// could no longer be typed into.
//
// These assert the two halves that have to both be true: global chords stop,
// and the palette's own keys do not.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function skipWizard(page: Page) {
  const wizard = page.locator("#setupWizardScrim");
  await expect(wizard).toHaveClass(/\bon\b/);
  await page.keyboard.press("Escape");
  await expect(wizard).not.toHaveClass(/\bon\b/);
}

async function openPalette(page: Page) {
  await page.keyboard.press("Control+k");
  await expect(page.locator("#cmdk")).toHaveClass(/\bon\b/);
  await expect(page.locator("#cmdkInput")).toBeFocused();
}

const focusedId = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement)?.id || document.activeElement?.tagName || "");

test("a pane chord cannot take focus out from under the open palette", async ({ page }) => {
  await page.goto("/");
  await skipWizard(page);
  await openPalette(page);

  await page.keyboard.press("Control+Digit1"); // pane.graph — live, scope "global"

  expect(await focusedId(page), "focus must stay in the palette's input").toBe("cmdkInput");
  await expect(page.locator("#cmdk"), "and the palette must still be open").toHaveClass(/\bon\b/);

  // The same chord works normally once the palette is gone, so this narrowed
  // the binding rather than breaking it.
  await page.keyboard.press("Escape");
  await expect(page.locator("#cmdk")).not.toHaveClass(/\bon\b/);
  await page.keyboard.press("Control+Digit1");
  expect(await focusedId(page)).toBe("cv");
});

test("⌘K still closes it, because palette.toggle is layer:always", async ({ page }) => {
  // dispatch.ts resolves layer:"always" BEFORE the stack walk, which is what
  // keeps the toggle reachable from inside a modal scope that stops the walk.
  // Without that this fix would have made the palette uncloseable by its own
  // chord.
  await page.goto("/");
  await skipWizard(page);
  await openPalette(page);
  await page.keyboard.press("Control+k");
  await expect(page.locator("#cmdk")).not.toHaveClass(/\bon\b/);
});

test("the scope is released on close, not left on the stack", async ({ page }) => {
  // A leaked modal scope would be invisible until the NEXT chord silently did
  // nothing, which is a far worse bug than the one being fixed.
  await page.goto("/");
  await skipWizard(page);

  for (let i = 0; i < 3; i++) {
    await openPalette(page);
    await page.keyboard.press("Escape");
    await expect(page.locator("#cmdk")).not.toHaveClass(/\bon\b/);
  }

  await page.keyboard.press("Control+Digit1");
  expect(await focusedId(page), "after three open/close cycles the app must still take its own chords").toBe("cv");
});
