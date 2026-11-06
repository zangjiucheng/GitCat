// Compare a branch or tag with the current branch, from the sidebar, and the
// full diff's two extras: the since-the-fork toggle and opening one file in
// the external diff tool. Driven against a real fixture repo through the
// mock backend (fixtures/tauriMock.ts), whose compare commands answer with
// real git and record what the UI asked for.
import { test, expect } from "./fixtures/tauriMock";
import type { Page } from "@playwright/test";
import type { TempRepo } from "./fixtures/tempRepo";

/** main and release forked after "base": each side then adds its own file. */
function forked(repo: TempRepo) {
  repo.writeFile("README.md", "# fixture\n");
  const base = repo.commit("base");
  repo.branch("release");
  repo.checkout("release");
  repo.writeFile("release.txt", "r\n");
  const release = repo.commit("release work");
  repo.checkout("main");
  repo.writeFile("main.txt", "m\n");
  repo.commit("main work");
  repo.git("tag", "v1", release);
  return { base, release };
}

async function open(page: Page) {
  await page.goto("/");
  await page.locator(".repo-pick").click();
  await page.locator(".db-add").click();
  await expect(page.locator("#cntLocal")).toHaveText("2");
}

const popover = (page: Page) => page.locator(".ref-pop.rs-pop");
const diffModal = (page: Page) => page.locator(".modal.diffx.rs-diffx");
const fileNames = (page: Page) => diffModal(page).locator(".diffx-files .file .fname");

test("a branch's menu compares it with the current branch", async ({ page, repo, calls }) => {
  forked(repo);
  await open(page);

  await page.locator('#refLocal [data-branch="release"]').click({ button: "right" });
  await page.locator(".ref-pop").getByRole("button", { name: /compare with current branch/i }).click();

  await expect(popover(page)).toBeVisible();
  await expect(popover(page).locator(".cm-head .sha")).toHaveText(/main\s*…\s*release/);
  expect(calls.find((c) => c.cmd === "commit_range_summary")?.args).toMatchObject({ a: "HEAD", b: "refs/heads/release" });
  await expect(popover(page)).toContainText(/diverged/i);
});

test("the current branch's own menu does not offer to compare it with itself", async ({ page, repo }) => {
  forked(repo);
  await open(page);
  await page.locator('#refLocal [data-branch="main"]').click({ button: "right" });
  await expect(page.locator(".ref-pop").getByRole("button", { name: /checkout/i })).toBeVisible();
  await expect(page.locator(".ref-pop").getByRole("button", { name: /compare with current branch/i })).toHaveCount(0);
});

test("a tag's menu compares it too", async ({ page, repo, calls }) => {
  forked(repo);
  await open(page);
  // The tags section starts folded.
  await page.locator("summary", { has: page.locator("#cntTags") }).click();
  await page.locator('#refTags [data-tag="v1"]').click({ button: "right" });
  await page.locator(".ref-pop").getByRole("button", { name: /compare with current branch/i }).click();
  await expect(popover(page)).toBeVisible();
  expect(calls.find((c) => c.cmd === "commit_range_summary")?.args).toMatchObject({ a: "HEAD", b: "refs/tags/v1" });
});

test("a diverged pair can show only the other side's changes, and switch back", async ({ page, repo, calls }) => {
  const { base } = forked(repo);
  await open(page);
  await page.locator('#refLocal [data-branch="release"]').click({ button: "right" });
  await page.locator(".ref-pop").getByRole("button", { name: /compare with current branch/i }).click();

  await popover(page).getByRole("button", { name: /only release's changes/i }).click();
  await expect(diffModal(page)).toBeVisible();
  await expect(fileNames(page)).toHaveText(["release.txt"]);
  await expect(diffModal(page).getByRole("button", { name: /since the fork/i })).toHaveAttribute("aria-pressed", "true");
  // The header names the merge base, which is what this diff starts from.
  await expect(diffModal(page).locator(".diffx-head-main p")).toContainText(base.slice(0, 7));

  await diffModal(page).getByRole("button", { name: /tip to tip/i }).click();
  // Tip to tip also shows main's own work (reversed): main.txt goes away.
  await expect(fileNames(page)).toHaveText(["main.txt", "release.txt"]);
  const asked = calls.filter((c) => c.cmd === "commit_range_diff").map((c) => c.args.sinceFork);
  expect(asked).toEqual([true, false]);
});

test("a file of the range diff opens in the external diff tool with the diff's own trees", async ({ page, repo, calls }) => {
  const { base, release } = forked(repo);
  await open(page);
  await page.locator('#refLocal [data-branch="release"]').click({ button: "right" });
  await page.locator(".ref-pop").getByRole("button", { name: /compare with current branch/i }).click();
  await popover(page).getByRole("button", { name: /only release's changes/i }).click();

  await diffModal(page).locator('button.wd-act[aria-label="Open in external diff for release.txt"]').click();
  await expect.poll(() => calls.find((c) => c.cmd === "open_diff_tool")?.args).toMatchObject({
    file: "release.txt",
    staged: false,
    fromRev: base,
    toRev: release,
  });
});
