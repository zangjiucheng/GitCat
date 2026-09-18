// What a plugin runs, shown in the app (#69 / #70).
//
// docs/plugins.md and SECURITY.md both say the same thing: there is no sandbox
// for a shell `run`, so "a plugin can do anything the command you wrote can
// do", and you should install only a plugin you would run yourself. The panel
// showed COUNTS — "3 commands" — and `grep -rn "mutates" src/` found zero UI
// reads. The app asked for a security judgement using information it declined
// to show.
//
// The unit tests cover the install FLOW (picking previews, nothing installs
// until confirmed). This covers the RENDERING, which is the half a controller
// test cannot see — and the half that, if it silently rendered nothing, would
// leave the feature looking present and being useless.
import { test, expect } from "./fixtures/tauriMock";
import type { Page } from "@playwright/test";

async function openPlugins(page: Page) {
  await page.goto("/");
  // The wizard only opens when no repo is configured, which the mock fixture
  // is not; Escape is harmless either way.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator("#cmdkInput")).toBeFocused();
  await page.locator("#cmdkInput").fill("Plugins");
  await page.keyboard.press("Enter");
  await expect(page.locator(".modal.plugins-modal")).toBeVisible();
}

const panel = (page: Page) => page.locator(".modal.plugins-modal");

test("the audit view shows the command lines, not a count of them", async ({ page }) => {
  await openPlugins(page);
  await panel(page).locator(".pl-row").first().click();

  // The `run` templates themselves, verbatim and unexpanded — {repo} is
  // resolved per invocation, and showing it expanded would be showing one run
  // rather than what the manifest says.
  await expect(panel(page).locator(".pm-run").filter({ hasText: "git status --short" })).toBeVisible();
  await expect(panel(page).locator(".pm-run").filter({ hasText: "git clean -fd -- {repo}" })).toBeVisible();

  // And the hook, which matters more than any command: it runs on its own.
  await expect(panel(page).locator(".pm-run").filter({ hasText: "echo tidied" })).toBeVisible();
});

test("an action that writes to the repo is marked, and an action that does not is not", async ({ page }) => {
  // The single most important thing on this surface. A badge everything
  // carried would say nothing.
  await openPlugins(page);
  await panel(page).locator(".pl-row").first().click();

  const clean = panel(page).locator(".pm-item").filter({ hasText: "Clean untracked" });
  const status = panel(page).locator(".pm-item").filter({ hasText: "Show status" });
  await expect(clean.locator(".pm-badge")).toBeVisible();
  await expect(status.locator(".pm-badge")).toHaveCount(0);
  await expect(clean).toHaveClass(/\bmutates\b/);

  // …and it is summarised up front, so it need not be hunted for.
  await expect(panel(page).locator(".pm-warn")).toBeVisible();
});

test("the source directory is shown — it is part of what is being trusted", async ({ page }) => {
  // Everything the manifest references resolves relative to this, and the
  // panel used not to show where a plugin even lived.
  await openPlugins(page);
  await panel(page).locator(".pl-row").first().click();
  await expect(panel(page).locator(".pm-dir")).toHaveText("/tmp/plugins/tidy");
});

test("the panel no longer reports contributions as bare counts", async ({ page }) => {
  // Guards the actual change rather than only the addition: if the counts list
  // came back alongside, a reader would have two answers to one question.
  await openPlugins(page);
  await panel(page).locator(".pl-row").first().click();
  await expect(panel(page).locator(".pl-contrib")).toHaveCount(0);
});
