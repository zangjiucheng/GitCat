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
async function watchWhile(page: Page, subject: string, file: string, act: () => Promise<void>) {
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
    lostFile: frames.filter((f) => !f.includes(file)).length,
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

  // The Changes tab, explicitly. The panel opens on Commit, and the only
  // `.file` rows in the DOM until Changes is opened belong to the expanded-
  // diff modal's own hidden copy of the tree — asserting on those compares a
  // hidden element with itself and passes no matter what the user sees.
  const tabs = page.locator("#detail .d-tabs .d-tab");
  await tabs.filter({ hasText: /changes/i }).click();
  const files = page.locator("#detail .file:visible");
  await expect(files).not.toHaveCount(0);
  const filesBefore = await files.allTextContents();

  const seen = await watchWhile(page, "Add the widget", "widget.ts", async () => {
    await page.locator('#refLocal [data-branch="main"]').click(); // same sha
  });

  expect(seen.showedLoading, 'the panel flashed "loading…"').toBe(0);
  expect(seen.lostSubject, "the panel went blank mid-refresh").toBe(0);
  expect(seen.lostFile, "the file tree emptied mid-refresh").toBe(0);
  // And it is still the same tree afterwards, not a rebuilt one.
  await expect(files).not.toHaveCount(0);
  expect(await files.allTextContents()).toEqual(filesBefore);
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

test("switching commits crossfades in place instead of shuffling the panel", async ({ page, repo }) => {
  // The commit view is wrapped in {#key c.sha} with transition:fade, and
  // `transition:` is BIDIRECTIONAL — the outgoing view keeps its space for the
  // whole 120ms while it fades. As a flex column that meant the incoming view
  // was laid out BELOW the outgoing one, both squeezed to half height, and
  // then the new one snapped to the top when the old was finally removed.
  //
  // Measured on a 642px panel before the fix:
  //   frame 0   1 view   top  78            height 642
  //   frame 3   2 views  tops 78 and 399    heights 321, 321
  //
  // That is the panel "rendering low and then flashing up". Overlapping both
  // views in a single grid cell makes it a real crossfade: same position, same
  // height, only opacity moves.
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
  await page
    .locator("#refLocal .ref-folder")
    .filter({ has: page.locator(".rname", { hasText: /^feature$/ }) })
    .click();

  await page.locator('#refLocal [data-branch="main"]').click();
  await expect(page.locator("#detail")).toContainText("Initial commit");

  // Sample every frame: the shuffle lasts only as long as the fade, so a
  // before/after comparison cannot see it.
  await page.evaluate(() => {
    const w = window as unknown as { __f: { views: number; tops: number[]; heights: number[] }[] };
    w.__f = [];
    let n = 0;
    const det = document.getElementById("detail")!;
    const tick = () => {
      const views = [...det.querySelectorAll(".d-view")] as HTMLElement[];
      w.__f.push({
        views: views.length,
        tops: views.map((v) => Math.round(v.getBoundingClientRect().top)),
        heights: views.map((v) => Math.round(v.getBoundingClientRect().height)),
      });
      if (n++ < 60) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await page.locator('#refLocal [data-branch="feature/widget"]').click();
  await page.waitForTimeout(1000);

  const frames = await page.evaluate(
    () => (window as unknown as { __f: { views: number; tops: number[]; heights: number[] }[] }).__f,
  );
  // The crossfade has to actually have happened, or this proves nothing.
  expect(Math.max(...frames.map((f) => f.views)), "no crossfade was observed").toBe(2);

  const tops = [...new Set(frames.flatMap((f) => f.tops))];
  const heights = [...new Set(frames.flatMap((f) => f.heights))];
  expect(tops, `the panel moved vertically mid-transition: tops ${tops.join(", ")}`).toHaveLength(1);
  expect(heights, `the panel changed height mid-transition: ${heights.join(", ")}`).toHaveLength(1);
});
