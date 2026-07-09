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
  await expect(page.locator(".repo-pick span").first()).toHaveText(repoName);

  await expect(page.locator('#refLocal [data-branch="main"]')).toBeVisible();
  await expect(page.locator('#refLocal [data-branch="feature/widget"]')).toBeVisible();
});
