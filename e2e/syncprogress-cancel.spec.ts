// The sync-progress modal's Cancel (#133), end to end against the mocked IPC:
// Escape reaches the modal's keyboard scope and turns into job_cancel for the
// job the modal learned from "job-started", the stalled banner follows
// "job-progress", and closing hands the keyboard back to the global scope.
//
// The streaming commands park in the mock until the spec cancels or finishes
// them (see PendingSync in fixtures/tauriMock.ts); the job events are emitted
// by the spec itself through __e2eEmit, standing in for the backend.
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/tauriMock";
import type { RecordedCall } from "./fixtures/tauriMock";
import type { TempRepo } from "./fixtures/tempRepo";

async function openFixtureRepo(page: Page, repo: TempRepo) {
  repo.writeFile("README.md", "# fixture\n");
  repo.commit("Initial commit");
  await page.goto("/");
  // Same path a user takes (see open-repo.spec.ts): the repo chip opens the
  // dashboard, whose "+ Add repository…" picks the folder and opens it.
  await page.locator(".repo-pick").click();
  await page.locator(".db-add").click();
  const repoName = repo.dir.replace(/[/\\]+$/, "").split(/[/\\]/).pop()!;
  await expect(page.locator(".repo-pick .repo-name")).toHaveText(repoName);
}

async function startFetch(page: Page, calls: RecordedCall[]): Promise<string> {
  const before = calls.filter((c) => c.cmd === "fetch_stream").length;
  await page.locator("#fetchBtn").click();
  await expect(modal(page)).toHaveClass(/\bon\b/);
  await expect.poll(() => calls.filter((c) => c.cmd === "fetch_stream").length).toBe(before + 1);
  return calls.filter((c) => c.cmd === "fetch_stream").at(-1)!.args.path;
}

function emit(page: Page, event: string, payload: unknown) {
  return page.evaluate(
    ([e, p]) => (window as unknown as { __e2eEmit: (e: string, p: unknown) => void }).__e2eEmit(e as string, p),
    [event, payload] as const,
  );
}

function jobStarted(id: number, repo: string) {
  return { id, kind: "fetch", repo, label: "", startedAtMs: Date.now(), background: false, stalled: false, cancelling: false };
}

const modal = (page: Page) => page.locator(".scrim:has(.modal.syncprogress)");

const topScope = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __keymap?: { dump(): { stack: { id: string }[] } } }).__keymap?.dump().stack.at(-1)?.id,
  );

test("Escape cancels the running fetch through job_cancel", async ({ page, repo, calls }) => {
  await openFixtureRepo(page, repo);
  const path = await startFetch(page, calls);
  expect(await topScope(page)).toBe("modal");

  await emit(page, "job-started", jobStarted(7, path));
  await page.keyboard.press("Escape");

  await expect.poll(() => calls.find((c) => c.cmd === "job_cancel")?.args).toEqual({ id: 7 });
  await expect(modal(page).locator(".sync-cancelled")).toContainText("Cancelled.");
  // A cancel is an outcome, not a failure.
  await expect(modal(page).locator(".pl-err")).toHaveCount(0);

  // Done now, so Escape closes — and the keyboard goes back to global.
  await page.keyboard.press("Escape");
  await expect(modal(page)).not.toHaveClass(/\bon\b/);
  expect(await topScope(page)).toBe("global");
});

test("the stalled banner follows job-progress, and a finished fetch closes itself", async ({ page, repo, calls }) => {
  await openFixtureRepo(page, repo);
  const path = await startFetch(page, calls);

  await emit(page, "job-started", jobStarted(8, path));
  await emit(page, "job-progress", { id: 8, stalled: true, idleSecs: 60 });
  await expect(modal(page).locator(".sync-stalled")).toBeVisible();
  await expect(modal(page).locator(".sync-stalled")).toContainText("60s");

  await page.evaluate(() => (window as unknown as { __e2eFinishSync: () => Promise<boolean> }).__e2eFinishSync());
  await expect(modal(page).locator(".sync-status")).toHaveText("Done.");
  await expect(modal(page).locator(".sync-stalled")).toHaveCount(0);
  // Success auto-dismisses (~900 ms), releasing the modal scope.
  await expect(modal(page)).not.toHaveClass(/\bon\b/);
  expect(await topScope(page)).toBe("global");
  expect(calls.some((c) => c.cmd === "job_cancel")).toBe(false);
});

// Hide keeps the op running; its busy topbar button (still enabled, unlike the
// other two) and the jobs chip's Show both bring the modal back.
test("a hidden modal comes back from the busy Fetch button and from the jobs chip", async ({ page, repo, calls }) => {
  await openFixtureRepo(page, repo);
  const path = await startFetch(page, calls);
  await emit(page, "job-started", jobStarted(7, path));

  await modal(page).getByRole("button", { name: "Hide" }).click();
  await expect(modal(page)).not.toHaveClass(/\bon\b/);
  await expect(page.locator("#fetchBtn")).toBeEnabled();
  await expect(page.locator("#pullBtn")).toBeDisabled();

  await page.locator("#fetchBtn").click();
  await expect(modal(page)).toHaveClass(/\bon\b/);
  expect(calls.filter((c) => c.cmd === "fetch_stream")).toHaveLength(1);
  await expect(modal(page).locator(".modal.syncprogress")).toContainText("output while hidden was not kept");

  await modal(page).getByRole("button", { name: "Hide" }).click();
  await expect(modal(page)).not.toHaveClass(/\bon\b/);
  await page.locator(".jobs-chip").click();
  await page.locator(".jobs-row-show").click();
  await expect(modal(page)).toHaveClass(/\bon\b/);

  await page.evaluate(() => (window as unknown as { __e2eFinishSync: () => boolean }).__e2eFinishSync());
  await expect(page.locator("#pullBtn")).toBeEnabled();
});
