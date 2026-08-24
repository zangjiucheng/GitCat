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
