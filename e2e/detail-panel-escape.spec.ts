import { test, expect } from "@playwright/test";

// Regression coverage for the Task 6 refactor (DetailPanel.svelte owning the
// #detail slot instead of Detail.svelte nesting Workdir inside itself).
//
// The expanded-diff modal's Escape handler used to live on Detail.svelte's
// own <svelte:window> — safe ONLY because Detail used to be the #detail
// slot's permanent mount (main.ts mounted it once, at boot, and never
// destroyed it). Once DetailPanel started swapping Detail for Workdir
// whenever the working tree is selected, Detail can now be unmounted —
// taking that listener with it — while `detailCtrl.diffExpanded` (controller
// state, not component state) stays true. Escape then did nothing, and
// switching back to a commit view found the modal still open. The fix moved
// the listener to DetailPanel.svelte, the component that IS now permanently
// mounted.
//
// This drives exactly that path with real keyboard/DOM interactions — no
// canvas clicks needed: #gotoHeadBtn (topbar) and Ctrl+Shift+U (the "jump to
// Uncommitted Changes" shortcut — see legacy/main.ts's goToUncommitted
// binding) are both reachable in plain design mode (no repo, no Tauri
// backend), same as e2e/sidebar-jump-design.spec.ts's HEAD-selection path.
//
// #diffview (id, not class) is the "which view" signal, not .d-subject —
// Workdir.svelte reuses the .d-subject class for its own "Uncommitted
// changes" header, so a class-only check can't tell the two views apart.
// #diffview is only ever rendered by Detail.svelte.
async function skipWizard(page: import("@playwright/test").Page) {
  const wizard = page.locator("#setupWizardScrim");
  await expect(wizard).toHaveClass(/\bon\b/);
  await page.keyboard.press("Escape");
  await expect(wizard).not.toHaveClass(/\bon\b/);
}

test("Escape still closes the expanded diff after a trip through the working tree", async ({ page }) => {
  await page.goto("/");
  await skipWizard(page);

  // Select HEAD (design mode's synthetic graph marks row 0 "head") so the
  // panel shows a real commit with a diff instead of the empty-state hero.
  await page.locator("#gotoHeadBtn").click();
  await expect(page.locator("#diffview")).toBeVisible();

  // Open the expanded-diff modal from the commit view's inline diff header.
  await page.locator("#diffview .wd-act").click();
  await expect(page.locator("#detail .scrim")).toHaveClass(/\bon\b/);

  // Jump to the working tree WITHOUT closing the modal first — this is what
  // unmounts Detail (and, pre-fix, its Escape listener along with it) while
  // detailCtrl.diffExpanded stays true.
  await page.keyboard.press("Control+Shift+U");
  await expect(page.locator("#diffview")).toHaveCount(0);

  // The old bug: nothing was listening for Escape anymore at this point.
  await page.keyboard.press("Escape");

  // Switch back to the commit view and check the modal's underlying state
  // actually changed, not just that it was temporarily offscreen.
  await page.locator("#gotoHeadBtn").click();
  await expect(page.locator("#diffview")).toBeVisible();
  await expect(page.locator("#detail .scrim")).not.toHaveClass(/\bon\b/);
});
