// The sidebar, from the keyboard.
//
// `f` is the one that closes a regression this stack itself introduced: PR 1
// deleted the duplicate ⌘⇧F binding that was the ref filter's only keyboard
// route (#131), which left it reachable by pointer alone (#148). It comes back
// here as a scoped letter rather than another ⌘⇧ chord, per #144's first rule.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function skipWizard(page: Page) {
  const wizard = page.locator("#setupWizardScrim");
  await expect(wizard).toHaveClass(/\bon\b/);
  await page.keyboard.press("Escape");
  await expect(wizard).not.toHaveClass(/\bon\b/);
}

const firstBranch = (page: Page) => page.locator("[data-branch]").first();

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await skipWizard(page);
});

test("f focuses the ref filter, restoring the route #148 lost", async ({ page }) => {
  await firstBranch(page).focus();
  await page.keyboard.press("f");
  await expect(page.locator("#refFilter")).toBeFocused();

  // And it is genuinely a text field afterwards: typing filters, it does not
  // re-trigger the binding.
  await page.keyboard.type("ma");
  await expect(page.locator("#refFilter")).toHaveValue("ma");
});

test("f only works from the sidebar — the graph has its own f later", async ({ page }) => {
  await page.keyboard.press("Control+Digit1"); // focus the graph
  await page.keyboard.press("f");
  await expect(page.locator("#refFilter")).not.toBeFocused();
});

test("x opens the focused branch's menu, anchored on the row", async ({ page }) => {
  await firstBranch(page).focus();
  await page.keyboard.press("x");

  const menu = page.locator(".ref-pop").first();
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.y).toBeGreaterThan(0); // anchored, not pinned to the origin
});

test("f then c: filter to a branch, then open its checkout confirm", async ({ page }) => {
  // Only `main` sits at the sidebar's top level; everything else is inside a
  // collapsed folder row. Filtering is the keyboard way to surface one, which
  // makes this a test of the two bindings composing as well as of `c` itself.
  await firstBranch(page).focus();
  await page.keyboard.press("f");
  await expect(page.locator("#refFilter")).toBeFocused();
  await page.keyboard.type("feat");

  const other = page.locator("[data-branch]:not(.current)").first();
  await expect(other).toBeVisible();
  await other.focus();

  // The confirm dialog is what handles a dirty working tree; a bare letter must
  // not decide on the user's behalf what happens to uncommitted changes.
  await page.keyboard.press("c");
  await expect(page.locator(".ref-pop").first()).toBeVisible();
});

test("c declines on the branch already checked out", async ({ page }) => {
  const current = page.locator("[data-branch].current").first();
  await expect(current).toBeVisible();
  await current.focus();
  await page.keyboard.press("c");
  await expect(page.locator(".ref-pop")).toHaveCount(0);
});

test("the sidebar is its own pane, and the ring shows it", async ({ page }) => {
  await firstBranch(page).focus();
  const pane = await page.evaluate(
    () => document.activeElement?.closest("[data-pane]")?.getAttribute("data-pane"),
  );
  expect(pane).toBe("sidebar");

  const ring = await page.evaluate(() => {
    const el = document.querySelector('[data-pane="sidebar"]')!;
    const s = getComputedStyle(el).boxShadow;
    return s !== "none" && s !== "";
  });
  expect(ring).toBe(true);
});

test("no claimed key reaches document-bubble", async ({ page }) => {
  await firstBranch(page).focus();
  await page.keyboard.press("x");
  await page.keyboard.press("Escape");
  const doubles = await page.evaluate(
    () => (window as unknown as { __keymapDoubleFire?: string[] }).__keymapDoubleFire,
  );
  expect(doubles).toEqual([]);
});
