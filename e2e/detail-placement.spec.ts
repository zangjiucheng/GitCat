// The detail panel's placement (settings: detailPanelPlacement) is applied by
// Task 1 as a `data-detail-placement` attribute on <html>. This spec checks
// the CSS consequence: the .app grid actually relocates the panel from the
// third column to a full-width bottom row, and the graph gives up height
// instead of width when it does.
import { test, expect } from "@playwright/test";

async function skipWizard(page: import("@playwright/test").Page) {
  const wizard = page.locator("#setupWizardScrim");
  await expect(wizard).toHaveClass(/\bon\b/);
  await page.keyboard.press("Escape");
  await expect(wizard).not.toHaveClass(/\bon\b/);
}

// Placement is applied by a root attribute, so a test can set it directly
// without driving the Settings dialog — which is a separate surface with its
// own tests. Reload so the boot path reads it back the way a real user's
// next launch would.
async function usePlacement(page: import("@playwright/test").Page, v: "right" | "bottom") {
  await page.evaluate((val) => {
    const blob = JSON.parse(localStorage.getItem("gitcat.settings") ?? "{}");
    blob.detailPanelPlacement = val;
    localStorage.setItem("gitcat.settings", JSON.stringify(blob));
  }, v);
  await page.reload();
  await skipWizard(page);
}

test("the panel sits in the right-hand column by default", async ({ page }) => {
  await page.goto("/");
  await skipWizard(page);
  await expect(page.locator("html")).toHaveAttribute("data-detail-placement", "right");
  const areas = await page.locator(".app").evaluate((el) => getComputedStyle(el).gridTemplateAreas);
  expect(areas).toContain("sidebar graph detail");
});

test("the bottom placement puts the panel on its own full-width row", async ({ page }) => {
  await page.goto("/");
  await skipWizard(page);

  // Captured before switching: in the default (right) placement the graph's
  // third column is squeezed by the detail column beside it.
  const rightGraph = await page.locator(".graph").boundingBox();

  await usePlacement(page, "bottom");

  await expect(page.locator("html")).toHaveAttribute("data-detail-placement", "bottom");
  const areas = await page.locator(".app").evaluate((el) => getComputedStyle(el).gridTemplateAreas);
  expect(areas).toContain("detail detail");
  expect(areas).not.toContain("sidebar graph detail");

  // The panel leaves the graph's row entirely (it moves to a full-width row
  // of its own below), so the graph reclaims the column the detail panel used
  // to occupy — it gives up height instead, not width. It still shares its
  // row with the sidebar, so it does not reach the *window's* full width, but
  // it is strictly wider than it was in the right-hand placement.
  const graph = await page.locator(".graph").boundingBox();
  const detail = await page.locator("#detail").boundingBox();
  expect(graph!.width).toBeGreaterThan(rightGraph!.width);
  expect(detail!.y).toBeGreaterThan(graph!.y);
});

test("the bottom panel resizes by dragging its top edge", async ({ page }) => {
  await page.goto("/");
  await skipWizard(page);
  await usePlacement(page, "bottom");

  const before = (await page.locator("#detail").boundingBox())!;
  const handle = page.locator("#resizeDetailBottom");
  const hb = (await handle.boundingBox())!;

  // The wizard scrim (dismissed by usePlacement's reload+skipWizard) has a
  // fade-out transition, so it can still intercept pointer events for a
  // moment after its "on" class is gone. hover() performs Playwright's usual
  // actionability wait (including "receives pointer events" at this exact
  // spot) before the raw page.mouse calls below, which — unlike a locator
  // action — don't wait for that on their own.
  await handle.hover();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, hb.y - 120);
  // The size is committed on release, not during the drag — a guide line
  // tracks the cursor meanwhile, so the panel must still be its old height.
  const midDrag = (await page.locator("#detail").boundingBox())!;
  expect(Math.abs(midDrag.height - before.height)).toBeLessThan(2);
  await page.mouse.up();

  const after = (await page.locator("#detail").boundingBox())!;
  expect(after.height).toBeGreaterThan(before.height + 80);
});

test("only the handle for the current placement is reachable", async ({ page }) => {
  await page.goto("/");
  await skipWizard(page);
  await expect(page.locator("#resizeDetail")).toBeVisible();
  await expect(page.locator("#resizeDetailBottom")).toBeHidden();

  await usePlacement(page, "bottom");
  await expect(page.locator("#resizeDetailBottom")).toBeVisible();
  await expect(page.locator("#resizeDetail")).toBeHidden();
});

test("collapsing via focus mode doesn't desync the two detail handles across a live placement switch", async ({ page }) => {
  await page.goto("/");
  await skipWizard(page);
  await usePlacement(page, "bottom");

  // Focus mode (Ctrl/Cmd+\) collapses the sidebar and whichever detail
  // handle activePanelHandles() resolves for the current placement — here,
  // the bottom one.
  await page.keyboard.press("Control+Backslash");
  await expect(page.locator("#detail")).toHaveClass(/collapsed/);

  // Switch placement LIVE, with no reload — the same call the Settings
  // dialog makes under the hood (setDetailPanelPlacement -> bridge ->
  // main.ts's applyDetailPlacement, which just sets this attribute). Driven
  // directly here since the dialog itself is a separate surface with its
  // own tests, the same convention usePlacement() above uses.
  await page.evaluate(() => document.documentElement.setAttribute("data-detail-placement", "right"));

  // #detail is still .collapsed (a placement switch doesn't touch it), so
  // the newly-active RIGHT handle must agree it's collapsed and be able to
  // reopen it. Before the fix, each handle kept its own private `collapsed`
  // mirror instead of reading the shared class off #detail, so the right
  // handle's own flag was still false here and clicking it did nothing.
  const rightHandle = page.locator("#resizeDetail");
  await expect(rightHandle).toBeVisible();
  await rightHandle.click();
  await expect(page.locator("#detail")).not.toHaveClass(/collapsed/);
});

test("the collapsed bottom rail is fully reachable, not just a thin strip", async ({ page }) => {
  await page.goto("/");
  await skipWizard(page);
  await usePlacement(page, "bottom");

  await page.keyboard.press("Control+Backslash");
  const detailBox = (await page.locator("#detail").boundingBox())!;
  const handleBox = (await page.locator("#resizeDetailBottom").boundingBox())!;
  // The handle's own un-collapsed rule fixes it to top:0;height:6px. Without
  // a collapsed-state override for that axis, the reopen affordance would
  // still be a 6px sliver at the top of the ~28px rail instead of filling
  // it, unlike the sidebar/right-detail rail this CSS was originally written
  // for.
  expect(Math.abs(handleBox.height - detailBox.height)).toBeLessThan(2);
});

test("dragging the bottom panel taller never exceeds 60% of a short viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto("/");
  await skipWizard(page);
  await usePlacement(page, "bottom");

  const handle = page.locator("#resizeDetailBottom");
  const hb = (await handle.boundingBox())!;
  await handle.hover();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  // All the way to the top of the window — far past even the panel's own
  // fixed 720px max — to prove the viewport-relative ceiling, not the fixed
  // max, is what actually stops it on a short screen.
  await page.mouse.move(hb.x + hb.width / 2, 5);
  await page.mouse.up();

  const after = (await page.locator("#detail").boundingBox())!;
  // 60% of a 700px-tall viewport is 420px; a little slack for borders/rounding.
  expect(after.height).toBeLessThan(700 * 0.6 + 10);
  // And it actually grew up near that ceiling, not just failed to move at all.
  expect(after.height).toBeGreaterThan(700 * 0.6 - 40);
});
