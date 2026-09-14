// The commit graph, from the keyboard.
//
// Design mode is enough here: the synthetic graph has real rows, a real pinned
// band and a real commit menu, and none of these bindings touch the backend.
// The one that needed a real repo (the menu's own git operations) is not what
// is under test — that the menu OPENS, anchored on the selected row, is.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function skipWizard(page: Page) {
  const wizard = page.locator("#setupWizardScrim");
  await expect(wizard).toHaveClass(/\bon\b/);
  await page.keyboard.press("Escape");
  await expect(wizard).not.toHaveClass(/\bon\b/);
}

// The canvas draws its selection, so there is no DOM node for it. The detail
// panel IS the observable consequence: select(row) calls detailCtrl.select(row),
// and selectWorkdir() swaps the panel to the working tree. Asserting on what the
// user actually sees beats reaching for internal state.
const subject = (page: Page) => page.locator("#detail .d-subject").first();
const workdirOpen = (page: Page) => page.locator("#detail textarea.wd-msg");

/** The canvas owns the graph scope; focus it the way ⌘1 does. */
async function focusGraph(page: Page) {
  await page.keyboard.press("Control+Digit1");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await skipWizard(page);
});

test("x opens the commit menu anchored on the SELECTED row, not at 0,0", async ({ page }) => {
  // The gap this closes: all 12 oncontextmenu handlers read e.clientX/clientY,
  // so there was no keyboard route to any of the menu's ten operations.
  await page.locator("#gotoHeadBtn").click();
  await focusGraph(page);
  await page.keyboard.press("x");

  const menu = page.locator(".cm-pop").first();
  await expect(menu).toBeVisible();

  const box = await menu.boundingBox();
  expect(box, "menu has no box — it never opened").toBeTruthy();
  // Anchored on the row, so it must not be pinned to the viewport origin.
  expect(box!.x).toBeGreaterThan(0);
  expect(box!.y).toBeGreaterThan(0);
});

test("Shift+F10 opens the same menu", async ({ page }) => {
  await page.locator("#gotoHeadBtn").click();
  await focusGraph(page);
  await page.keyboard.press("Shift+F10");
  await expect(page.locator(".cm-pop").first()).toBeVisible();
});

test("arrow keys move the SELECTION, not just the viewport", async ({ page }) => {
  // They used to move state.scrollTarget while j/k moved the selection — two
  // contradictory meanings of "navigate" on one surface.
  await page.locator("#gotoHeadBtn").click();
  await focusGraph(page);
  const start = await subject(page).textContent();
  expect(start).toBeTruthy();

  await page.keyboard.press("ArrowDown");
  await expect.poll(() => subject(page).textContent()).not.toBe(start);

  await page.keyboard.press("ArrowUp");
  await expect.poll(() => subject(page).textContent()).toBe(start);
});

test("ArrowUp off the first commit reaches the Uncommitted band", async ({ page }) => {
  // Row -2, outside moveCanvasSelection's [0, N-1] clamp — the row users visit
  // most, and it had no keyboard route at all.
  await focusGraph(page);
  await page.keyboard.press("Home");
  const first = await subject(page).textContent();

  // The band swaps #detail to the working tree — that is the visible proof.
  await page.keyboard.press("ArrowUp");
  await expect(workdirOpen(page)).toBeVisible();

  await page.keyboard.press("ArrowDown");
  await expect(workdirOpen(page)).toHaveCount(0);
  await expect.poll(() => subject(page).textContent()).toBe(first);
});

test("Home and End move the cursor, not just the viewport", async ({ page }) => {
  await focusGraph(page);
  await page.keyboard.press("End");
  await expect(subject(page)).toBeVisible();
  const last = await subject(page).textContent();

  await page.keyboard.press("Home");
  await expect.poll(() => subject(page).textContent()).not.toBe(last);
  const first = await subject(page).textContent();

  await page.keyboard.press("End");
  await expect.poll(() => subject(page).textContent()).toBe(last);
  expect(first).not.toBe(last);
});

test("Escape deselects — but only when there is nothing else to close", async ({ page }) => {
  await page.locator("#gotoHeadBtn").click();
  await focusGraph(page);
  await expect(subject(page)).toBeVisible();

  // With a dialog up, Escape belongs to the dialog. If the graph binding took
  // it here it would deselect AND claim, suppressing the dialog's own handler.
  await page.keyboard.press("Control+Comma");
  const settings = page.locator(".scrim:has(.modal.settings)");
  await expect(settings).toHaveClass(/\bon\b/);
  await page.keyboard.press("Escape");
  await expect(settings).not.toHaveClass(/\bon\b/);
  await expect(subject(page)).toBeVisible(); // still selected

  // Nothing left to close: now it deselects, and the panel empties.
  await focusGraph(page);
  await page.keyboard.press("Escape");
  await expect(subject(page)).toHaveCount(0);
});

test("no claimed key reaches document-bubble", async ({ page }) => {
  await focusGraph(page);
  for (const k of ["ArrowDown", "ArrowUp", "Home", "End", "Escape"]) {
    await page.keyboard.press(k);
  }
  const doubles = await page.evaluate(
    () => (window as unknown as { __keymapDoubleFire?: string[] }).__keymapDoubleFire,
  );
  expect(doubles).toEqual([]);
});
