import { test, expect } from "./fixtures/tauriMock";

test("clicking a branch in the sidebar selects its tip commit in the graph", async ({ page, repo }) => {
  repo.writeFile("README.md", "# fixture\n");
  repo.commit("Initial commit");
  repo.branch("feature/widget");
  repo.checkout("feature/widget");
  repo.writeFile("widget.ts", "export const widget = 1;\n");
  repo.commit("Add the widget"); // feature/widget's tip, NOT main's
  repo.checkout("main");

  await page.goto("/");
  await page.locator(".repo-pick").click();
  await page.locator(".db-add").click();
  await expect(page.locator("#cntLocal")).toHaveText("2");

  // `feature/widget` lives under a `feature` folder, and folders start closed
  // unless HEAD is inside them — HEAD is `main` here, so open it first.
  const featureFolder = page
    .locator("#refLocal .ref-folder")
    .filter({ has: page.locator(".rname", { hasText: /^feature$/ }) });
  await featureFolder.click();

  await page.locator('#refLocal [data-branch="feature/widget"]').click();

  // Canvas selection isn't in the DOM, but select(row) drives the detail
  // panel — so the panel is a faithful read of which row got selected. The
  // subject text is unique to feature/widget's tip (main's tip is "Initial
  // commit"), so this proves goToOid's 40-char join against the row shas
  // isn't silently broken by a width mismatch (e.g. comparing against a
  // 7-char prefix) — though with only two commits in this fixture, a
  // truncated-prefix implementation would happen to pass too.
  await expect(page.locator("#detail")).toContainText("Add the widget");
});

test("double-clicking a branch still opens the checkout confirm", async ({ page, repo }) => {
  repo.writeFile("README.md", "# fixture\n");
  repo.commit("Initial commit");
  repo.branch("release");

  await page.goto("/");
  await page.locator(".repo-pick").click();
  await page.locator(".db-add").click();
  await expect(page.locator("#cntLocal")).toHaveText("2");

  await page.locator('#refLocal [data-branch="release"]').dblclick();

  // `.ref-pop` is shared by eight different popovers in Sidebar.svelte (menu,
  // pushMenu, renameMenu, mergeMenu, dirtyCheckoutMenu, checkoutConfirm,
  // tagMenu, submoduleMenu) — only checkoutConfirm's own heading reads
  // "Switch to <name>?" (the generic branch menu's equivalent action is a
  // plain "Checkout" button, no heading at all), so asserting that text is
  // what actually pins THIS popover, for THIS branch, not just any of the
  // eight lighting up.
  await expect(page.locator(".ref-pop")).toContainText("Switch to release?");
});

test("Enter on a branch row's own ⋮ button opens the branch menu, not a graph jump", async ({ page, repo }) => {
  repo.writeFile("README.md", "# fixture\n");
  repo.commit("Initial commit");
  repo.branch("release");

  await page.goto("/");
  await page.locator(".repo-pick").click();
  await page.locator(".db-add").click();
  await expect(page.locator("#cntLocal")).toHaveText("2");

  // Focus the row's own "Branch actions" ⋮ button directly (rather than
  // Tab-ing there) and press Enter on IT, not the row. The row's onkeydown
  // fires during bubble regardless of which descendant the key event
  // started on, so an unguarded preventDefault there would cancel the
  // button's own Enter-activates-click default action and jump the graph
  // instead of opening the menu — the regression this test guards against.
  await page.locator('#refLocal [data-branch="release"] .ref-menu').focus();
  await page.keyboard.press("Enter");

  await expect(page.locator(".ref-pop")).toContainText("Checkout");
});
