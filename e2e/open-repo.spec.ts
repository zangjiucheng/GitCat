import { test, expect } from "./fixtures/tauriMock";

test("opening a repo populates the sidebar from the real fixture repo's refs", async ({ page, repo }) => {
  repo.writeFile("README.md", "# fixture\n");
  repo.commit("Initial commit");
  repo.writeFile("src/lib.ts", "export const answer = 42;\n");
  repo.commit("Add lib.ts");
  repo.branch("feature/widget");

  await page.goto("/");
  await page.locator(".repo-pick").click();

  const repoName = repo.dir.replace(/[/\\]+$/, "").split(/[/\\]/).pop()!;
  // .repo-name specifically, not a bare "span" — openRepo()'s loading
  // spinner is ALSO briefly a "span" inside .repo-pick while this resolves
  // (see legacy/main.ts's own comment on that exact line), so a
  // less-specific selector here could pass by matching the spinner's own
  // transient text instead of actually asserting the real chip updated.
  await expect(page.locator(".repo-pick .repo-name")).toHaveText(repoName);

  await expect(page.locator('#refLocal [data-branch="main"]')).toBeVisible();
  await expect(page.locator('#refLocal [data-branch="feature/widget"]')).toBeVisible();
});
