// What a plugin runs, shown in the app (#69 / #70).
//
// docs/plugins.md and SECURITY.md both say the same thing: there is no sandbox
// for a shell `run`, so "a plugin can do anything the command you wrote can
// do", and you should install only a plugin you would run yourself. The panel
// showed COUNTS — "3 commands" — and `grep -rn "mutates" src/` found zero UI
// reads. The app asked for a security judgement using information it declined
// to show.
//
// The unit tests cover the install FLOW (picking previews, nothing installs
// until confirmed). This covers the RENDERING, which is the half a controller
// test cannot see — and the half that, if it silently rendered nothing, would
// leave the feature looking present and being useless.
import { test, expect } from "./fixtures/tauriMock";
import type { Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

async function openPlugins(page: Page) {
  await page.goto("/");
  // The wizard only opens when no repo is configured, which the mock fixture
  // is not; Escape is harmless either way.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator("#cmdkInput")).toBeFocused();
  await page.locator("#cmdkInput").fill("Plugins");
  await page.keyboard.press("Enter");
  await expect(page.locator(".modal.plugins-modal")).toBeVisible();
}

const panel = (page: Page) => page.locator(".modal.plugins-modal");

test("the audit view shows the command lines, not a count of them", async ({ page }) => {
  await openPlugins(page);
  await panel(page).locator(".pl-row").first().click();

  // The `run` templates themselves, verbatim and unexpanded — {repo} is
  // resolved per invocation, and showing it expanded would be showing one run
  // rather than what the manifest says.
  await expect(panel(page).locator(".pm-run").filter({ hasText: "git status --short" })).toBeVisible();
  await expect(panel(page).locator(".pm-run").filter({ hasText: "git clean -fd -- {repo}" })).toBeVisible();

  // And the hook, which matters more than any command: it runs on its own.
  await expect(panel(page).locator(".pm-run").filter({ hasText: "echo tidied" })).toBeVisible();
});

test("an action that writes to the repo is marked, and an action that does not is not", async ({ page }) => {
  // The single most important thing on this surface. A badge everything
  // carried would say nothing.
  await openPlugins(page);
  await panel(page).locator(".pl-row").first().click();

  const clean = panel(page).locator(".pm-item").filter({ hasText: "Clean untracked" });
  const status = panel(page).locator(".pm-item").filter({ hasText: "Show status" });
  await expect(clean.locator(".pm-badge")).toBeVisible();
  await expect(status.locator(".pm-badge")).toHaveCount(0);
  await expect(clean).toHaveClass(/\bmutates\b/);

  // …and it is summarised up front, so it need not be hunted for.
  await expect(panel(page).locator(".pm-warn")).toBeVisible();
});

test("the source directory is shown — it is part of what is being trusted", async ({ page }) => {
  // Everything the manifest references resolves relative to this, and the
  // panel used not to show where a plugin even lived.
  await openPlugins(page);
  await panel(page).locator(".pl-row").first().click();
  await expect(panel(page).locator(".pm-dir")).toHaveText("/tmp/plugins/tidy");
});

test("the panel no longer reports contributions as bare counts", async ({ page }) => {
  // Guards the actual change rather than only the addition: if the counts list
  // came back alongside, a reader would have two answers to one question.
  await openPlugins(page);
  await panel(page).locator(".pl-row").first().click();
  await expect(panel(page).locator(".pl-contrib")).toHaveCount(0);
});

// -- the install review itself (#69) -----------------------------------------

/** Write a manifest into the fixture repo, where the mock's picker returns it. */
function writeManifest(repo: { dir: string }, manifest: unknown) {
  writeFileSync(join(repo.dir, "plugin.json"), JSON.stringify(manifest, null, 2));
}

const REVIEW_DEMO = {
  id: "review-demo",
  name: "Review Demo",
  version: "1.0.0",
  description: "A plugin written to exercise the install-review screen.",
  commands: [
    { id: "status", label: "Show short status", run: "git -C {repo} status --short", context: "repo", placement: "palette" },
    { id: "wipe", label: "Delete untracked files", run: "git -C {repo} clean -fdx", context: "repo", placement: "both", mutates: true },
  ],
  hooks: [{ event: "repo-opened", run: "git -C {repo} fetch --prune", mutates: true }],
};

async function pickPlugin(page: Page) {
  await panel(page).getByRole("button", { name: /install from file/i }).click();
  await expect(panel(page).locator(".pl-review")).toBeVisible();
}

test("picking a file reviews it and installs nothing", async ({ page, repo }) => {
  writeManifest(repo, REVIEW_DEMO);
  await openPlugins(page);
  await pickPlugin(page);

  // The command lines, from the real file the picker handed back.
  await expect(panel(page).locator(".pm-run").filter({ hasText: "git -C {repo} clean -fdx" })).toBeVisible();
  await expect(panel(page).locator(".pm-warn")).toContainText("2");
  // Still not installed: the list behind the review is untouched.
  await expect(panel(page).getByRole("button", { name: /^Install$/ })).toBeVisible();
});

test("the review is laid out like the rest of the panel, not flush against its edge", async ({ page, repo }) => {
  // Reported from a build: the review sat hard against the modal's left edge
  // while the toolbar above it was inset, because .pl-body carries padding:0 —
  // the split view's two panes bring their own, and the review had none.
  writeManifest(repo, REVIEW_DEMO);
  await openPlugins(page);
  await pickPlugin(page);

  const box = await panel(page).evaluate((m) => {
    const body = m.querySelector(".modal-body") as HTMLElement;
    const review = m.querySelector(".pl-review") as HTMLElement;
    const head = m.querySelector(".modal-head") as HTMLElement;
    const b = body.getBoundingClientRect();
    const r = review.getBoundingClientRect();
    const firstRun = (m.querySelector(".pm-run") as HTMLElement).getBoundingClientRect();
    return {
      leftGutter: Math.round(r.left - b.left),
      rightGutter: Math.round(b.right - r.right),
      // What the heading above it uses, as the reference for "like the rest".
      headPadLeft: Math.round(parseFloat(getComputedStyle(head).paddingLeft)),
      runLeftGutter: Math.round(firstRun.left - b.left),
      runRightGutter: Math.round(b.right - firstRun.right),
    };
  });

  // Measured on the CONTENT, not on .pl-review itself: padding lives inside the
  // element, so the container's own box is flush with the body by definition
  // and says nothing about what the eye sees.
  expect(box.runLeftGutter, "the content is flush against the modal's left edge").toBeGreaterThan(8);
  // Symmetric — an uneven gutter is read as "pushed to one side", which is
  // exactly how this was reported.
  expect(
    Math.abs(box.runLeftGutter - box.runRightGutter),
    `uneven gutters: ${box.runLeftGutter}px left vs ${box.runRightGutter}px right`,
  ).toBeLessThanOrEqual(2);
});

test("cancelling returns to the list without installing", async ({ page, repo }) => {
  writeManifest(repo, REVIEW_DEMO);
  await openPlugins(page);
  await pickPlugin(page);

  await panel(page).getByRole("button", { name: /^Cancel$/ }).click();
  await expect(panel(page).locator(".pl-review")).toHaveCount(0);
  await expect(panel(page).locator(".pl-row")).not.toHaveCount(0); // back to the list
});

test("confirming installs it, and the audit view then shows the same thing", async ({ page, repo }) => {
  // The pairing #70 exists for: what you agreed to and what is on your machine
  // have to be the same view, or the comparison is meaningless.
  writeManifest(repo, REVIEW_DEMO);
  await openPlugins(page);
  await pickPlugin(page);
  const reviewed = await panel(page).locator(".pm-run").allTextContents();

  await panel(page).getByRole("button", { name: /^Install$/ }).click();
  await expect(panel(page).locator(".pl-review")).toHaveCount(0);

  await panel(page).locator(".pl-row").filter({ hasText: "Review Demo" }).click();
  expect(await panel(page).locator(".pm-run").allTextContents()).toEqual(reviewed);
});

test("a manifest the backend refuses never reaches the review", async ({ page, repo }) => {
  writeManifest(repo, { ...REVIEW_DEMO, mutatez: true }); // an unknown key (#64)
  await openPlugins(page);
  await panel(page).getByRole("button", { name: /install from file/i }).click();

  await expect(panel(page).locator(".pl-review")).toHaveCount(0);
  await expect(panel(page).locator(".pl-err, .mut").filter({ hasText: /mutatez/ }).first()).toBeVisible();
});

// -- re-reading an edited manifest (#66 / #67) --------------------------------

test("Update re-reads the manifest from disk, without an uninstall", async ({ page, repo }) => {
  // The asymmetry this closes: a plugin's Luau source is re-read on every
  // command invocation, so editing a handler was already live — while the
  // manifest was snapshotted at install and re-installing the same id is
  // refused, so editing a command's label meant uninstalling first.
  writeManifest(repo, REVIEW_DEMO);
  await openPlugins(page);
  await pickPlugin(page);
  await panel(page).getByRole("button", { name: /^Install$/ }).click();
  await panel(page).locator(".pl-row").filter({ hasText: "Review Demo" }).click();
  await expect(panel(page).locator(".pm-run").filter({ hasText: "git -C {repo} clean -fdx" })).toBeVisible();

  // Edit the manifest on disk, the way an author would.
  writeManifest(repo, {
    ...REVIEW_DEMO,
    name: "Review Demo (edited)",
    commands: [{ id: "status", label: "Renamed command", run: "git -C {repo} status --porcelain", context: "repo", placement: "palette" }],
    hooks: [],
  });

  await panel(page).getByRole("button", { name: /^Update$/ }).click();

  await expect(panel(page).locator(".pm-run").filter({ hasText: "git -C {repo} status --porcelain" })).toBeVisible();
  await expect(panel(page).locator(".pm-run").filter({ hasText: "clean -fdx" })).toHaveCount(0);
  await expect(panel(page).locator(".pl-row").filter({ hasText: "Review Demo (edited)" })).toBeVisible();
  // The command that no longer declares mutates must stop being badged.
  await expect(panel(page).locator(".pm-badge")).toHaveCount(0);
});

test("Update does not re-enable a plugin you disabled", async ({ page, repo }) => {
  // `enabled` defaults to TRUE when a manifest omits it — and REVIEW_DEMO
  // omits it — so an update that trusted the file would switch a disabled
  // plugin back on behind the user's back.
  writeManifest(repo, REVIEW_DEMO);
  await openPlugins(page);
  await pickPlugin(page);
  await panel(page).getByRole("button", { name: /^Install$/ }).click();
  await panel(page).locator(".pl-row").filter({ hasText: "Review Demo" }).click();

  await panel(page).getByRole("switch").click();
  await expect(panel(page).locator(".pl-enable-label")).toHaveText(/disabled/i);

  await panel(page).getByRole("button", { name: /^Update$/ }).click();

  await expect(panel(page).locator(".pl-enable-label"), "Update switched it back on").toHaveText(/disabled/i);
});
