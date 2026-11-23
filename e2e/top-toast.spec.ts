import { test, expect, type Page } from "@playwright/test";

// #topToast mirrors Tama's line while a scrim covers her nook (#139). It has to
// be a live region (an aria-modal dialog hides the nook from screen readers),
// only one of the two may speak at a time, and closing the scrim — Escape
// included — must take the toast with it.

// The dev server serves the same module instance the app imported, so this
// reaches the real mascot rather than a copy.
async function say(page: Page, text: string) {
  await page.evaluate(async (t) => {
    const bridge = await import(/* @vite-ignore */ "/src/legacy/bridge.ts");
    bridge.tama.say(t, 20000);
  }, text);
}

test("the top toast is announced while a modal is up, and Escape takes it away with the modal", async ({ page }) => {
  await page.goto("/");

  const toast = page.locator("#topToast");
  const nook = page.locator("#nook");
  await expect(toast).toHaveAttribute("role", "status");
  await expect(toast).not.toHaveAttribute("aria-hidden", /.*/);

  // First run opens the setup wizard, and boot's own greeting lands on the toast
  // over it. Escape closes the wizard and must take that toast with it.
  const wizard = page.locator("#setupWizardScrim");
  await expect(wizard).toHaveClass(/\bon\b/);
  await say(page, "said over the wizard");
  await expect(toast).toHaveClass(/\bshow\b/);
  await page.keyboard.press("Escape");
  await expect(wizard).not.toHaveClass(/\bon\b/);
  await expect(toast).not.toHaveClass(/\bshow\b/);

  // No scrim: the nook speaks, the toast stays out of the way.
  await say(page, "no modal here");
  await expect(toast).not.toHaveClass(/\bshow\b/);
  await expect(nook).toHaveAttribute("aria-live", "polite");

  await page.keyboard.press("Control+,");
  const settings = page.locator(".modal.settings");
  await expect(settings).toBeVisible();

  // Scrim up: the toast shows and speaks; the nook is silenced so a reader
  // that ignores aria-modal doesn't say it twice.
  await say(page, "saved while the modal is open");
  await expect(toast).toHaveClass(/\bshow\b/);
  await expect(toast).toHaveText("saved while the modal is open");
  await expect(nook).toHaveAttribute("aria-live", "off");

  // Escape closes the modal and, with it, the toast — long before its 20s dwell.
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(toast).not.toHaveClass(/\bshow\b/);
  await expect(nook).toHaveAttribute("aria-live", "polite");
});
