// The detail panel must not flash when it is re-selected with what it is
// already showing.
//
// reloadGraph() runs after every commit, pull, push and bisect step, and on
// every file-watcher tick that notices the repo moved. It empties BACKEND,
// re-streams it, and restores the selection by SHA through pendingReselect —
// which lands in detailCtrl.select() with the same commit it was already
// showing. That used to tear the whole panel down (body -> "loading…", file
// tree and diff -> empty, both spinners on) and spend a round trip rebuilding
// byte-identical content, because a commit's message and diff cannot change
// while its sha does not.
//
// Re-clicking the branch that is already selected drives the same path:
// goToOid -> focusRow -> select(row) with an unchanged sha.
import { test, expect } from "./fixtures/tauriMock";
import type { Page } from "@playwright/test";

/**
 * Watch #detail for the duration of `act` and report whether it ever went
 * blank or put a spinner up.
 *
 * Sampled through a MutationObserver rather than checked after the fact: the
 * flash is transient — by the time the reload finishes, the panel looks
 * exactly as it did before, which is precisely why this was easy to miss and
 * annoying to watch.
 */
async function watchWhile(page: Page, subject: string, act: () => Promise<void>) {
  await page.evaluate(() => {
    const w = window as unknown as { __flash: string[] };
    w.__flash = [];
    const el = document.getElementById("detail")!;
    const sample = () => w.__flash.push(el.textContent || "");
    sample();
    new MutationObserver(sample).observe(el, { childList: true, subtree: true, characterData: true });
  });
  await act();
  await page.waitForTimeout(400);
  const frames: string[] = await page.evaluate(() => (window as unknown as { __flash: string[] }).__flash);
  return {
    frames: frames.length,
    lostSubject: frames.filter((f) => !f.includes(subject)).length,
    showedLoading: frames.filter((f) => /loading…/.test(f)).length,
  };
}

test("re-selecting the commit already on screen does not flash the panel", async ({ page, repo }) => {
  repo.writeFile("README.md", "# fixture\n");
  repo.commit("Initial commit");
  repo.writeFile("widget.ts", "export const widget = 1;\n");
  repo.commit("Add the widget");

  await page.goto("/");
  await page.locator(".repo-pick").click();
  await page.locator(".db-add").click();
  await expect(page.locator("#cntLocal")).toHaveText("1");

  await page.locator('#refLocal [data-branch="main"]').click();
  await expect(page.locator("#detail")).toContainText("Add the widget");
  await expect(page.locator("#detail .file")).not.toHaveCount(0);
  const filesBefore = await page.locator("#detail .file").allTextContents();

  const seen = await watchWhile(page, "Add the widget", async () => {
    await page.locator('#refLocal [data-branch="main"]').click(); // same sha
  });

  expect(seen.showedLoading, 'the panel flashed "loading…"').toBe(0);
  expect(seen.lostSubject, "the panel went blank mid-refresh").toBe(0);
  // And it is still the same panel afterwards, not a rebuilt one.
  expect(await page.locator("#detail .file").allTextContents()).toEqual(filesBefore);
});

test("switching to a different commit still loads it", async ({ page, repo }) => {
  // The guard is the sha, not "select() ran" — a real switch must still fetch.
  repo.writeFile("README.md", "# fixture\n");
  repo.commit("Initial commit");
  repo.branch("feature/widget");
  repo.checkout("feature/widget");
  repo.writeFile("widget.ts", "export const widget = 1;\n");
  repo.commit("Add the widget");
  repo.checkout("main");

  await page.goto("/");
  await page.locator(".repo-pick").click();
  await page.locator(".db-add").click();
  await expect(page.locator("#cntLocal")).toHaveText("2");

  const folder = page
    .locator("#refLocal .ref-folder")
    .filter({ has: page.locator(".rname", { hasText: /^feature$/ }) });
  await folder.click();

  await page.locator('#refLocal [data-branch="feature/widget"]').click();
  await expect(page.locator("#detail")).toContainText("Add the widget");

  await page.locator('#refLocal [data-branch="main"]').click();
  await expect(page.locator("#detail")).toContainText("Initial commit");
  await expect(page.locator("#detail")).not.toContainText("Add the widget");
});

test("the working tree keeps the diff you were reading across a refresh", async ({ page, repo }) => {
  // selectWorkdir() -> workdirCtrl.select(CUR_REPO) runs again after every git
  // operation, because reloadGraph() hands the pinned row back through
  // pendingReselect just as it hands a commit back by sha. select() used to
  // clear the open diff unconditionally, so staging one file blanked the diff
  // of whatever file you were actually looking at.
  //
  // Pressing ⌘⇧U while the working tree is already open drives the same call.
  repo.writeFile("README.md", "# fixture\n");
  repo.commit("Initial commit");
  repo.writeFile("todo.txt", "buy milk\n");

  await page.goto("/");
  await page.locator(".repo-pick").click();
  await page.locator(".db-add").click();

  await page.keyboard.press("Control+Shift+U");
  const tabs = page.locator("#detail .d-tabs .d-tab");
  await expect(tabs).toHaveCount(3);
  await tabs.nth(1).click();

  const row = page
    .locator("#detail .wd-file")
    .filter({ has: page.locator(".wd-path", { hasText: /^todo\.txt$/ }) });
  await row.first().click();
  const diff = page.locator("#detail .diffview:not(.diffx-diff)");
  await expect(diff).toBeVisible();
  await expect(diff).toContainText("buy milk");

  await page.keyboard.press("Control+Shift+U"); // same repo, panel already open

  await expect(diff, "the open diff was dropped by a refresh").toContainText("buy milk");
});
