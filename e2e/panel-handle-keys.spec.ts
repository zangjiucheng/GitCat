import { test, expect, type Page } from "@playwright/test";

// The outer panel edges are focusable controls, and the keyboard now does what
// the pointer does (#136): Enter/Space toggles, arrows resize in Splitter's
// 8/32px steps, Home resets, shrinking past the minimum collapses.

async function skipWizard(page: Page) {
  const wizard = page.locator("#setupWizardScrim");
  await expect(wizard).toHaveClass(/\bon\b/);
  await page.keyboard.press("Escape");
  await expect(wizard).not.toHaveClass(/\bon\b/);
}

const cssPx = (page: Page, v: string) =>
  page.evaluate((name) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)), v);

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await skipWizard(page);
});

test("the sidebar edge resizes with arrows, resets with Home, and Enter toggles it both ways", async ({ page }) => {
  const handle = page.locator("#resizeSidebar");
  const sidebar = page.locator(".sidebar");
  const start = await cssPx(page, "--sidebar-w");
  await handle.focus();

  await page.keyboard.press("ArrowRight");
  expect(await cssPx(page, "--sidebar-w")).toBe(start + 8);
  await page.keyboard.press("Shift+ArrowLeft");
  expect(await cssPx(page, "--sidebar-w")).toBe(start + 8 - 32);
  await page.keyboard.press("Home");
  expect(await cssPx(page, "--sidebar-w")).toBe(start);

  // Enter used to only ever expand; on an open panel it now collapses.
  await page.keyboard.press("Enter");
  await expect(sidebar).toHaveClass(/\bcollapsed\b/);
  await page.keyboard.press("Enter");
  await expect(sidebar).not.toHaveClass(/\bcollapsed\b/);
  expect(await cssPx(page, "--sidebar-w")).toBe(start);
});

test("the right-hand detail edge grows with ← and collapses when shrunk past its minimum", async ({ page }) => {
  const handle = page.locator("#resizeDetail");
  const detail = page.locator("#detail");
  const start = await cssPx(page, "--detail-w");
  await handle.focus();

  // The key points where the edge goes: ← moves this edge left, so wider.
  await page.keyboard.press("ArrowLeft");
  expect(await cssPx(page, "--detail-w")).toBe(start + 8);

  for (let i = 0; i < 20 && !(await detail.evaluate((el) => el.classList.contains("collapsed"))); i++) {
    await page.keyboard.press("Shift+ArrowRight");
  }
  await expect(detail).toHaveClass(/\bcollapsed\b/);

  // From collapsed, a key that grows the panel reopens it.
  await page.keyboard.press("ArrowLeft");
  await expect(detail).not.toHaveClass(/\bcollapsed\b/);
});

test("the terminal drawer's edge is focusable and resizes with ↑/↓", async ({ page }) => {
  // Design mode has no repo to spawn a shell in, so open the drawer directly —
  // this test is about its edge, not the session.
  await page.evaluate(async () => {
    const m = await import(/* @vite-ignore */ "/src/islands/terminal/terminal.svelte.ts");
    m.terminalCtrl.open = true;
  });
  const drag = page.locator(".term-drawer.on .term-drag");
  await expect(drag).toBeVisible();
  const start = await cssPx(page, "--term-h");
  // The drawer focuses its own terminal shortly after it opens; take focus
  // back each time rather than racing that.
  await drag.focus();
  await page.keyboard.press("ArrowUp");
  expect(await cssPx(page, "--term-h")).toBe(start + 8);
  await drag.focus();
  await page.keyboard.press("Home");
  expect(await cssPx(page, "--term-h")).toBe(start);
});
