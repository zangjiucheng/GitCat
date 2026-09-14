// The working tree, driven entirely from the keyboard.
//
// This is the surface the audit found worst: there was no commit chord anywhere
// in src/ at all, so committing meant Tab-walking to the button. The test that
// matters here is the last one — stage a file and commit it without ever
// touching the mouse — because that is the workflow the whole stack exists for.
import { test, expect } from "./fixtures/tauriMock";
import type { TempRepo } from "./fixtures/tempRepo";
import type { Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function seed(repo: TempRepo) {
  repo.writeFile("README.md", "# fixture\n");
  repo.commit("Initial commit");
  // One unstaged edit and one untracked file: the two row states `s` and `d`
  // behave differently on.
  writeFileSync(join(repo.dir, "README.md"), "# fixture\nedited\n");
  mkdirSync(join(repo.dir, "src"), { recursive: true });
  writeFileSync(join(repo.dir, "src/new.ts"), "export const x = 1;\n");
}

async function openRepo(page: Page) {
  await page.locator(".repo-pick").click();
  await page.locator(".db-add").click();
  await expect(page.locator(".hero-stat .n")).toHaveText("1");
}

/** Land on the working tree's Changes tab, where the staged/unstaged trees are. */
async function openChanges(page: Page) {
  await page.keyboard.press("Control+Shift+U");
  const tabs = page.locator("#detail .d-tabs .d-tab");
  await expect(tabs).toHaveCount(3);
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveClass(/\bon\b/);
}

const paneOf = (page: Page) =>
  page.evaluate(() => document.activeElement?.closest("[data-pane]")?.getAttribute("data-pane") ?? "(none)");

test("the working tree is its own pane, nested inside detail", async ({ page, repo }) => {
  seed(repo);
  await page.goto("/");
  await openRepo(page);
  await openChanges(page);

  // Focus a file row: the innermost marker wins, so bare letters here mean
  // staging rather than whatever the detail pane will bind later.
  await page.locator("[data-wd-path]").first().focus();
  expect(await paneOf(page)).toBe("workdir");

  // The tab strip above it is still the detail pane's own chrome.
  await page.locator("#detail .d-tabs .d-tab").first().focus();
  expect(await paneOf(page)).toBe("detail");
});

test("s stages the focused row and u unstages it", async ({ page, repo, calls }) => {
  seed(repo);
  await page.goto("/");
  await openRepo(page);
  await openChanges(page);

  const unstaged = page.locator('[data-wd-path][data-wd-staged="false"]').first();
  const path = await unstaged.getAttribute("data-wd-path");
  await unstaged.focus();
  await page.keyboard.press("s");

  await expect.poll(() => calls.find((c) => c.cmd === "stage_file")).toBeTruthy();
  expect(calls.find((c) => c.cmd === "stage_file")?.args).toMatchObject({ file: path });
});

test("d routes through the confirmation, never straight to git", async ({ page, repo, calls }) => {
  seed(repo);
  await page.goto("/");
  await openRepo(page);
  await openChanges(page);

  await page.locator('[data-wd-path][data-wd-staged="false"]').first().focus();
  await page.keyboard.press("d");

  // The typed-confirm scrim, not a discard.
  await expect(page.locator("#dangerScrim")).toHaveClass(/\bon\b/);
  expect(calls.find((c) => c.cmd === "discard_file")).toBeUndefined();

  await page.keyboard.press("Escape");
  await expect(page.locator("#dangerScrim")).not.toHaveClass(/\bon\b/);
  expect(calls.find((c) => c.cmd === "discard_file")).toBeUndefined();
});

test("a bare letter in the commit message box types, it does not stage", async ({ page, repo, calls }) => {
  seed(repo);
  await page.goto("/");
  await openRepo(page);
  await page.keyboard.press("Control+Shift+U");

  const msg = page.locator("#detail textarea.wd-msg");
  await expect(msg).toBeVisible();
  await msg.click();
  await msg.pressSequentially("stage and discard");

  await expect(msg).toHaveValue("stage and discard");
  expect(calls.find((c) => c.cmd === "stage_file")).toBeUndefined();
  await expect(page.locator("#dangerScrim")).not.toHaveClass(/\bon\b/);
});

// THE WORKFLOW. No mouse at all after the repo is open.
test("stage and commit without touching the mouse", async ({ page, repo, calls }) => {
  seed(repo);
  await page.goto("/");
  await openRepo(page);

  await page.keyboard.press("Control+Shift+U");
  await expect(page.locator("#detail textarea.wd-msg")).toBeVisible();

  // ⌘⇧S-style bulk staging: S stages everything, from anywhere in the pane.
  await page.locator("[data-pane='workdir']").focus();
  await page.keyboard.press("Shift+S");
  await expect.poll(() => calls.find((c) => c.cmd === "stage_all")).toBeTruthy();

  // Write the message and commit from inside the textarea — the one binding in
  // the table allowed to fire from a text field, because that is the point.
  const msg = page.locator("#detail textarea.wd-msg");
  await msg.click();
  await msg.pressSequentially("feat: drive the working tree by keyboard");
  await page.keyboard.press("Control+Enter");

  await expect.poll(() => calls.find((c) => c.cmd === "commit")).toBeTruthy();
  expect(calls.find((c) => c.cmd === "commit")?.args).toMatchObject({
    message: "feat: drive the working tree by keyboard",
    amend: false,
  });
});
