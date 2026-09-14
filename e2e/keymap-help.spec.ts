// The "?" overlay, now generated from the binding table.
//
// The scope-first ordering is the feature under test. Modifier chords are
// discoverable — they sit in menus and they are global. Bare letters are not:
// `s` stages in the working tree, `c` checks out in the sidebar, `x` opens a
// menu in three different places. A flat list cannot teach that; opening the
// overlay and seeing THIS PANE's keys first can.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function skipWizard(page: Page) {
  const wizard = page.locator("#setupWizardScrim");
  await expect(wizard).toHaveClass(/\bon\b/);
  await page.keyboard.press("Escape");
  await expect(wizard).not.toHaveClass(/\bon\b/);
}

const overlay = (page: Page) => page.locator("#vimNavHelpScrim");
const headings = (page: Page) => page.locator("#vimNavHelpScrim .d-lab");
const rows = (page: Page) => page.locator("#vimNavHelpScrim .pl-kv div");

async function openHelp(page: Page) {
  await page.keyboard.press("?");
  await expect(overlay(page)).toHaveClass(/\bon\b/);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await skipWizard(page);
});

test("? opens the overlay and Escape closes it", async ({ page }) => {
  await openHelp(page);
  await expect(rows(page).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(overlay(page)).not.toHaveClass(/\bon\b/);
});

test("the active pane's keys come first", async ({ page }) => {
  // A ref ROW, not ⌘2: that focuses the sidebar's first control, which is the
  // ref filter input — and "?" is a typed character, so vimnav rightly refuses
  // to open the overlay from a text field.
  await page.locator('[data-pane="sidebar"] [tabindex="0"]').first().focus();
  await openHelp(page);
  await expect(headings(page).first()).toHaveText(/sidebar/i);

  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Digit1"); // graph
  await openHelp(page);
  await expect(headings(page).first()).toHaveText(/graph/i);
});

test("the working tree's own keys lead when it has focus", async ({ page }) => {
  await page.keyboard.press("Control+Shift+U");
  await expect(page.locator("#detail textarea.wd-msg")).toBeVisible();
  await page.locator("[data-pane='workdir']").first().focus();

  await openHelp(page);
  await expect(headings(page).first()).toHaveText(/working tree/i);
  // And the keys under it are the ones that actually work there.
  const lead = page.locator("#vimNavHelpScrim section").first();
  await expect(lead).toContainText("s");
  await expect(lead.getByText(/stage/i).first()).toBeVisible();
});

test("the overlay reflects the table, not a hand-written copy", async ({ page }) => {
  // The chords this stack added have to be present without anyone having
  // written them into the markup. `x` is one of them.
  await page.keyboard.press("Control+Digit1");
  await openHelp(page);
  await expect(rows(page).filter({ hasText: /actions menu/i }).first()).toBeVisible();

  // And the line the hand-written overlay got wrong is gone: arrows move the
  // selection now, they do not "scroll".
  await expect(rows(page).filter({ hasText: "↑↓ PgUp PgDn Home End" })).toHaveCount(0);
});

test("no chord is listed twice anywhere in the overlay", async ({ page }) => {
  // Across the WHOLE overlay, not per section. Per-section deduping left the
  // other pane's identical row to print: `x` is "open the actions menu" on the
  // graph and in the sidebar, so it appeared in the leading scope group and
  // again under Actions.
  await page.keyboard.press("Control+Digit1");
  await openHelp(page);

  const texts = (await rows(page).allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  expect(texts.length).toBeGreaterThan(5);
  expect(new Set(texts).size).toBe(texts.length);
});

test("s and S read as different keys", async ({ page }) => {
  // Every single character used to be uppercased for display, so stage (s) and
  // stage-all (S) rendered identically in the one surface meant to tell them
  // apart.
  await page.keyboard.press("Control+Shift+U");
  await expect(page.locator("#detail textarea.wd-msg")).toBeVisible();
  await page.locator("[data-pane='workdir']").first().focus();
  await openHelp(page);

  const lead = page.locator("#vimNavHelpScrim section").first();
  const chords = await lead.locator(".pl-kv div .mono").allTextContents();
  expect(chords).toContain("s");
  expect(chords).toContain("S");
});
