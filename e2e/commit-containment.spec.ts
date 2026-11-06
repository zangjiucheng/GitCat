// "Is this commit on my branch?" — the detail panel's On branches section,
// against a real fixture repo (the mock backend answers commit_containment
// with real git; see fixtures/tauriMock.ts). Commits are selected through the
// sidebar's click-to-jump, which selects a branch's tip.
import { test, expect } from "./fixtures/tauriMock";
import type { Page } from "@playwright/test";

async function open(page: Page) {
  await page.goto("/");
  await page.locator(".repo-pick").click();
  await page.locator(".db-add").click();
  await expect(page.locator("#cntLocal")).toHaveText("2");
}

const section = (page: Page) => page.locator("#detail section", { has: page.locator(".contain-refs, .contain-head") });

test("a commit only on another branch says it's not on the current one, and where it is", async ({ page, repo }) => {
  repo.writeFile("README.md", "# fixture\n");
  repo.commit("base");
  repo.branch("fix");
  repo.checkout("fix");
  repo.writeFile("fix.txt", "fixed\n");
  repo.commit("The fix");
  repo.checkout("main");
  await open(page);

  await page.locator('#refLocal [data-branch="fix"]').click();
  await expect(page.locator("#detail")).toContainText("The fix");
  await expect(section(page).locator(".contain-head")).toHaveText(/not on main/i);
  await expect(section(page).locator(".contain-refs .row-chip")).toHaveText(["fix"]);

  await page.locator('#refLocal [data-branch="main"]').click();
  await expect(section(page).locator(".contain-head")).toHaveText(/on main/i);
  await expect(section(page).locator(".contain-head")).not.toHaveText(/not/i);
  await expect(section(page).locator(".contain-refs .row-chip")).toHaveText(["fix", "main"]);
});

test("a commit cherry-picked onto the current branch points at its copy", async ({ page, repo }) => {
  repo.writeFile("README.md", "# fixture\n");
  repo.commit("base");
  repo.branch("fix");
  repo.checkout("fix");
  repo.writeFile("fix.txt", "fixed\n");
  repo.commit("The fix");
  repo.checkout("main");
  repo.git("cherry-pick", "-x", "fix");
  const copy = repo.git("rev-parse", "HEAD");
  await open(page);

  await page.locator('#refLocal [data-branch="fix"]').click();
  await expect(section(page).locator(".contain-head")).toHaveText(/not on main/i);
  const link = section(page).locator(".contain-copy button");
  await expect(section(page).locator(".contain-copy")).toContainText(/cherry-picked/i);
  await expect(link).toHaveText(copy.slice(0, 7));

  await link.click();
  // The old view fades out under the new one for a moment ({#key c.sha}).
  await expect(page.locator("#hashCopy")).toHaveCount(1);
  await expect(page.locator("#hashCopy")).toHaveText(new RegExp("^" + copy.slice(0, 7)));
});
