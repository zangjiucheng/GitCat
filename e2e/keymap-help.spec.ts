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

/**
 * Assert a heading, and that it is a TRANSLATED string rather than a raw key.
 *
 * /sidebar/i and /graph/i both match the untranslated key "vimnav.scope_sidebar"
 * — so when the scope labels went missing from every locale, two of these
 * assertions passed anyway and only /working tree/i caught it. Every heading
 * check goes through here now.
 */
async function expectHeading(page: Page, re: RegExp) {
  const h = headings(page).first();
  await expect(h).toHaveText(re);
  await expect(h, "heading is an unresolved i18n key").not.toHaveText(/^vimnav\./);
}
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

test("every heading and row is translated, not a raw key", async ({ page }) => {
  // The generated overlay pulls labelKeys straight out of the table, so a key
  // that exists in no locale renders as itself. That is invisible unless
  // something checks — and it silently cost three scope headings their text.
  await page.keyboard.press("Control+Digit1");
  await openHelp(page);

  for (const t of await headings(page).allTextContents()) {
    expect(t, `untranslated heading: ${t}`).not.toMatch(/^(vimnav|menu|legacy)\./);
  }
  for (const t of await rows(page).allTextContents()) {
    expect(t, `untranslated row: ${t}`).not.toMatch(/(vimnav|menu|legacy)\.[a-z_]+/);
  }
});

test("? opens the overlay and Escape closes it", async ({ page }) => {
  await openHelp(page);
  await expect(rows(page).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(overlay(page)).not.toHaveClass(/\bon\b/);
});

test("the overlay fits the window, and what it cannot fit is reachable by keyboard", async ({
  page,
}) => {
  // Generating the list changed its length: the hand-written overlay was two
  // <section>s that happened to fill a 2x1 grid, the generated one is six. The
  // modal had a width but no max-height, and .modal is overflow:hidden — so it
  // rendered 829px tall at EVERY window size, and on anything shorter than
  // ~900px the last rows and the whole footer were cut off with no scrollbar
  // and no key that could reach them. Nothing in this file looked at geometry,
  // so it went out in PR 8 unnoticed.
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.locator('[data-pane="sidebar"] [tabindex="0"]').first().focus();
  await openHelp(page);

  const vh = page.viewportSize()!.height;
  const box = (await page.locator("#vimNavHelpScrim .modal.kbd-help").boundingBox())!;
  expect(box.y, "the overlay is cut off at the top").toBeGreaterThanOrEqual(0);
  expect(box.y + box.height, "the overlay is cut off at the bottom").toBeLessThanOrEqual(vh);
  await expect(page.locator("#vimNavHelpScrim .modal-foot")).toBeInViewport();

  // Overflow is fine — unreachable overflow is not. This is the one surface
  // that teaches keyboard use, and on macOS WebKit a bare overflow:auto div is
  // not tab-focusable, so the body has to be handed focus for arrows to work.
  const body = page.locator("#vimNavHelpScrim .modal-body");
  const over = await body.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(over, "nothing overflows at this size — shorten the window").toBeGreaterThan(0);

  await page.keyboard.press("End");
  await expect
    .poll(() => body.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeLessThanOrEqual(1);
  await expect(rows(page).last()).toBeInViewport();
});

test("closing the overlay gives focus back to the pane it was opened from", async ({ page }) => {
  // It takes focus to be scrollable, and the scrim hides with visibility —
  // not display — so without handing focus back it would sit on a node the
  // user can no longer see, and j/k would have nothing to move.
  const row = page.locator('[data-pane="sidebar"] [tabindex="0"]').first();
  await row.focus();
  await openHelp(page);
  await expect(page.locator("#vimNavHelpScrim .modal-body")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(overlay(page)).not.toHaveClass(/\bon\b/);
  await expect(row).toBeFocused();
});

test("the active pane's keys come first", async ({ page }) => {
  // A ref ROW, not ⌘2: that focuses the sidebar's first control, which is the
  // ref filter input — and "?" is a typed character, so vimnav rightly refuses
  // to open the overlay from a text field.
  await page.locator('[data-pane="sidebar"] [tabindex="0"]').first().focus();
  await openHelp(page);
  await expectHeading(page, /sidebar/i);

  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Digit1"); // graph
  await openHelp(page);
  await expectHeading(page, /graph/i);
});

test("the working tree's own keys lead when it has focus", async ({ page }) => {
  await page.keyboard.press("Control+Shift+U");
  await expect(page.locator("#detail textarea.wd-msg")).toBeVisible();
  await page.locator("[data-pane='workdir']").first().focus();

  await openHelp(page);
  await expectHeading(page, /working tree/i);
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
