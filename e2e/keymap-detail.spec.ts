// The detail panel from the keyboard, and the one audit finding that was not
// about a missing shortcut at all:
//
//   "on macOS WebKit a bare overflow:auto div is not tab-focusable, and
//    .diffview has no tabindex — so a long diff is literally unreadable
//    without a pointer, while Chromium's keyboard-focusable-scrollers make the
//    same build behave differently on Windows/Linux."
//
// Chromium DOES focus scrollable regions on its own, so this suite cannot
// reproduce the WebKit half — what it asserts is that the region now carries an
// EXPLICIT tabindex, which is what makes the two engines behave the same.
//
// There is deliberately no "arrow keys scroll it" test. Scrolling a focused
// scroll container is the browser's own behaviour, not this code's, and I could
// not build a fixture whose diff actually overflows: design mode's synthetic
// diff is shorter than the region's 320px max-height, and the mock backend's
// commit diff did not fill it either. A test that passed because nothing
// overflowed would assert nothing at all, which is worse than not having one.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function skipWizard(page: Page) {
  const wizard = page.locator("#setupWizardScrim");
  await expect(wizard).toHaveClass(/\bon\b/);
  await page.keyboard.press("Escape");
  await expect(wizard).not.toHaveClass(/\bon\b/);
}

const tabs = (page: Page) => page.locator("#detail .d-tabs .d-tab");
const activeTab = (page: Page) => page.locator("#detail .d-tabs .d-tab.on");

/** Open a commit so the panel has tabs and a diff.
 *  The commit view has TWO tabs (Commit / Changes); only the working tree gets
 *  a third, for the stash. */
async function openCommit(page: Page) {
  await page.locator("#gotoHeadBtn").click();
  await expect(tabs(page)).toHaveCount(2);
}

// The design-mode tests keep their own beforeEach: the repo-backed test at the
// bottom uses tauriMock, which already seeds setupWizardDismissed, so a shared
// skipWizard would wait forever there.
test.describe("design mode", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await skipWizard(page);
  });

  test("the diff region is focusable and labelled", async ({ page }) => {
    await openCommit(page);
    await tabs(page).nth(1).click();

    const diff = page.locator("#diffview");
    await expect(diff).toBeVisible();
    await expect(diff).toHaveAttribute("tabindex", "0");
    await expect(diff).toHaveAttribute("role", "region");
    await expect(diff).toHaveAttribute("aria-label", /.+/);
  });

  test("t cycles the panel's tabs and wraps", async ({ page }) => {
    await openCommit(page);
    await page.locator("#detail").focus();

    const first = await activeTab(page).textContent();
    await page.keyboard.press("t");
    await expect.poll(() => activeTab(page).textContent()).not.toBe(first);

    // Two tabs in the commit view, so one more press comes back round — a strip
    // with no wrap would dead-end here and need a second key to escape.
    await page.keyboard.press("t");
    await expect.poll(() => activeTab(page).textContent()).toBe(first);
  });

  test("t in the working tree does not move the commit view's tab", async ({ page }) => {
    // The two views keep separate active tabs, so switching away and back must
    // not lose which commit tab you were reading.
    await openCommit(page);
    await page.locator("#detail").focus();
    await page.keyboard.press("t");
    const commitTab = await activeTab(page).textContent();

    await page.keyboard.press("Control+Shift+U"); // to the working tree
    await expect(page.locator("#detail textarea.wd-msg")).toBeVisible();
    // No pane focusing needed: which view `t` acts on comes from
    // workdirCtrl.selected, the same signal DetailPanel derives from.
    await page.keyboard.press("t");

    await page.locator("#gotoHeadBtn").click(); // back to the commit view
    await expect.poll(() => activeTab(page).textContent()).toBe(commitTab);
  });

  test("t does nothing while typing in the commit message", async ({ page }) => {
    await page.keyboard.press("Control+Shift+U");
    const msg = page.locator("#detail textarea.wd-msg");
    await expect(msg).toBeVisible();
    const before = await activeTab(page).textContent();

    await msg.click();
    await msg.pressSequentially("tttt");
    await expect(msg).toHaveValue("tttt");
    expect(await activeTab(page).textContent()).toBe(before);
  });

  test("t follows the VISIBLE view even when focus is on the panel chrome", async ({ page }) => {
    // Workdir's own tab strip lives in the parent `detail` pane. Deriving the
    // view from the pane under focus cycled the HIDDEN commit tabs while the
    // working tree was on screen: the visible strip did not move, and going
    // back to a commit landed on a different tab than the one you left.
    await openCommit(page);
    const commitTabBefore = await activeTab(page).textContent();

    await page.keyboard.press("Control+Shift+U");
    await expect(page.locator("#detail textarea.wd-msg")).toBeVisible();

    // Focus the TAB STRIP itself — chrome of the detail pane, not the workdir one.
    await tabs(page).first().focus();
    const wtBefore = await activeTab(page).textContent();
    await page.keyboard.press("t");
    await expect.poll(() => activeTab(page).textContent()).not.toBe(wtBefore);

    // The commit view's own tab is untouched.
    await page.locator("#gotoHeadBtn").click();
    await expect.poll(() => activeTab(page).textContent()).toBe(commitTabBefore);
  });

  test("no claimed key reaches document-bubble", async ({ page }) => {
    await openCommit(page);
    await page.locator("#detail").focus();
    await page.keyboard.press("t");
    const doubles = await page.evaluate(
      () => (window as unknown as { __keymapDoubleFire?: string[] }).__keymapDoubleFire,
    );
    expect(doubles).toEqual([]);
  });
});
