import { test, expect } from "./fixtures/tauriMock";

test("opening a repo populates the sidebar from the real fixture repo's refs", async ({ page, repo }) => {
  repo.writeFile("README.md", "# fixture\n");
  repo.commit("Initial commit");
  repo.writeFile("src/lib.ts", "export const answer = 42;\n");
  repo.commit("Add lib.ts");
  repo.branch("feature/widget");

  await page.goto("/");
  // The topbar chip opens the repositories dashboard rather than a folder
  // picker — every way into a repo funnels through it now (see legacy/main.ts's
  // own `.repo-pick` handler and dashboard.svelte.ts's addRepository), and its
  // "+ Add repository…" is what actually picks a folder and then opens it.
  await page.locator(".repo-pick").click();
  await page.locator(".db-add").click();

  const repoName = repo.dir.replace(/[/\\]+$/, "").split(/[/\\]/).pop()!;
  // .repo-name specifically, not a bare "span" — openRepo()'s loading
  // spinner is ALSO briefly a "span" inside .repo-pick while this resolves
  // (see legacy/main.ts's own comment on that exact line), so a
  // less-specific selector here could pass by matching the spinner's own
  // transient text instead of actually asserting the real chip updated.
  await expect(page.locator(".repo-pick .repo-name")).toHaveText(repoName);

  // History arrives only via "graph-batch" after load_graph returns — not from
  // the invoke itself. The detail hero's commit count is the DOM half of
  // "onGraphBatch ran": sidebar list_refs can pass while the graph stays empty
  // if the mock never emits batches. Two commits from the fixture above.
  await expect(page.locator(".hero-stat .n")).toHaveText("2");

  // The count chip is the folder-shape-independent half of "list_refs was
  // read": it reports how many local branches came back, whatever the tree
  // does with them. (The Local <details> defaults open, so its rows render.)
  await expect(page.locator("#cntLocal")).toHaveText("2");
  // `main` is a loose branch, so it's a top-level row straight away.
  await expect(page.locator('#refLocal [data-branch="main"]')).toBeVisible();

  // `feature/widget` lives under a `feature` folder, and folders start closed —
  // `repo.branch()` runs `git branch` without checking out, so HEAD is still
  // `main` and the open-by-default-on-the-HEAD-path rule doesn't apply here.
  // A closed folder renders no rows for its children at all, so open it first.
  const featureFolder = page
    .locator("#refLocal .ref-folder")
    .filter({ has: page.locator(".rname", { hasText: /^feature$/ }) });
  await expect(featureFolder).toBeVisible();
  await featureFolder.click();
  await expect(page.locator('#refLocal [data-branch="feature/widget"]')).toBeVisible();
});
