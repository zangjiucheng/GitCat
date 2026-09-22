// ⌥1-9 in the command palette.
//
// The modifier is ⌥ and not ⌘ because ⌘1/2/3 are live pane-focus chords
// claimed at window CAPTURE (keymap/host.ts), upstream of the palette input's
// own handler — taking them back would mean pushing the `palette` scope, which
// scopedefs.ts defines and nothing activates. A partial ⌘4-9 would be worse
// than either.
//
// The detail that makes this worth an e2e rather than a unit test: on macOS
// ⌥1 is a dead-key combination reporting `key: "¡"`, ⌥2 "™", ⌥3 "£". The
// handler matches on `e.code`, and only a real browser produces the pairing of
// code and key that proves it.
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
}

test("⌥ plus a digit runs that row, not the selected one", async ({ page }) => {
  await page.goto("/");
  await skipWizard(page);
  await openPalette(page);
  await page.locator("#cmdkInput").fill("check update");

  const rows = page.locator(".cmdk-row");
  await expect(rows.first()).toBeVisible();
  const second = (await rows.nth(1).locator(".ttl").textContent())?.trim();
  expect(second, "this test needs a second row to aim at").toBeTruthy();

  // Selection is on row 1; ⌥2 must take row 2 regardless.
  await expect(rows.nth(0)).toHaveClass(/\bon\b/);
  await page.keyboard.press("Alt+Digit2");

  // Whatever row 2 was, running it closed the palette — that is the observable
  // difference between "jumped" and "typed a character into the field".
  await expect(page.locator("#cmdk")).not.toHaveClass(/\bon\b/);
});

test("the digits are on the rows, and stop at nine", async ({ page }) => {
  await page.goto("/");
  await skipWizard(page);
  await openPalette(page);

  const rows = page.locator(".cmdk-row");
  const n = await rows.count();
  expect(n, "the empty query should list the whole curated menu").toBeGreaterThan(9);

  for (let i = 0; i < 9; i++) {
    await expect(rows.nth(i).locator(".cmdk-num"), `row ${i + 1} should carry its number`).toHaveText(String(i + 1));
  }
  await expect(rows.nth(9).locator(".cmdk-num"), "the tenth row has no shortcut").toHaveText("");

  // The gutter still exists past nine, so the chips do not slide left.
  const gutters = await rows.evaluateAll((els) =>
    els.slice(0, 12).map((el) => Math.round((el.querySelector(".kind") as HTMLElement).getBoundingClientRect().left)),
  );
  expect(new Set(gutters).size, `the kind chips must all start at the same x, got ${gutters.join(",")}`).toBe(1);
});

test("a bare digit still types into the search field", async ({ page }) => {
  // The shortcut must not cost the ability to search for "v1" or a sha.
  await page.goto("/");
  await skipWizard(page);
  await openPalette(page);

  const input = page.locator("#cmdkInput");
  await input.fill("");
  await page.keyboard.press("Digit1");
  await expect(input).toHaveValue("1");
  await expect(page.locator("#cmdk"), "typing a digit must not run anything").toHaveClass(/\bon\b/);
});
