// End-to-end coverage for the working-tree panel's staging controls —
// stage/unstage a file, stage a whole folder, discard a file (through the
// typed-confirm scrim), commit, and reach the Stash tab — in BOTH panel
// placements (right/bottom, see e2e/detail-placement.spec.ts).
//
// WHY this exists: feat/detail-panel-placement reorganised the six stacked
// working-tree sections into three tabs (Commit / Changes / Stash) and let
// the panel sit either down the right side or along the bottom. The staging
// LOGIC didn't change (workdir.svelte.ts changed by one comment; the markup
// inside each section is byte-identical per `git diff -w`) — what changed is
// WHERE those controls live, which is exactly the kind of change that can
// leave a button unreachable (clipped by a fixed-size pane, stranded behind
// a tab, hidden under an overlay) without any unit test noticing. There was
// no test anywhere that staged a file; this closes that gap.
//
// Each test's real assertion is "the control was reachable and fired": it
// clicks/types through the real DOM in a real placement, then checks the
// mock backend's `calls` log (e2e/fixtures/tauriMock.ts) for the exact
// command + arguments the real backend would have received. It deliberately
// does NOT assert on post-mutation DOM state (e.g. a staged file moving
// sections) — the mock records-and-answers rather than replaying the
// mutation against the fixture repo (see tauriMock.ts's own doc comments on
// `RecordedCall` and `stage_file` et al.), so a state-based assertion would
// only be testing the mock's own git plumbing, not the app.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures/tauriMock";
import type { TempRepo } from "./fixtures/tempRepo";
import type { Page } from "@playwright/test";

// Unlike e2e/detail-placement.spec.ts's own skipWizard helper (used by specs
// that load the app WITHOUT this fixture), nothing here needs to dismiss the
// setup wizard: tauriMock's installTauriMock already seeds
// "gitcat.setupWizardDismissed" before every navigation (see e2e/open-repo.spec.ts,
// which drives `.repo-pick` directly for the same reason).

// Placement is read from the `gitcat.settings` localStorage blob at boot
// (settings.svelte.ts's `BOOT.detailPanelPlacement`) — setting it via
// addInitScript BEFORE the first `page.goto("/")` seeds it ahead of that
// read, same as e2e/detail-placement.spec.ts's `usePlacement` helper, but
// without that helper's reload (nothing has booted yet here to reload).
async function setPlacement(page: Page, v: "right" | "bottom") {
  await page.addInitScript((val) => {
    const blob = JSON.parse(localStorage.getItem("gitcat.settings") ?? "{}");
    blob.detailPanelPlacement = val;
    localStorage.setItem("gitcat.settings", JSON.stringify(blob));
  }, v);
}

// Every way into a repo funnels through the repositories dashboard (see
// e2e/open-repo.spec.ts) — the topbar chip opens it, and its "+ Add
// repository…" is what actually picks a folder (the mocked native picker
// always returns the fixture repo's own dir) and opens it. The hero stat's
// commit count is the DOM signal that `load_graph`'s "graph-batch" actually
// arrived, i.e. that the repo is genuinely open before Ctrl+Shift+U is used
// to jump to the working tree.
async function openRepo(page: Page) {
  await page.locator(".repo-pick").click();
  await page.locator(".db-add").click();
  await expect(page.locator(".hero-stat .n")).toHaveText("1");
}

// One commit, then real, uncommitted working-tree state: a staged file
// inside a folder (docs/plan.md), an unstaged edit to a tracked root file
// (README.md), an unstaged/untracked file inside a folder (src/feature/new.ts,
// the "stage a whole folder" target), and an untracked root file with a short
// name (todo.txt, the discard target — its name has to be typed verbatim into
// the confirm scrim). `repo.writeFile` itself runs `git add`, which is right
// for the staged file but wrong for the two unstaged ones, so those are
// written directly with `node:fs` instead of going through it.
function setupWorkdirRepo(repo: TempRepo) {
  repo.writeFile("README.md", "# fixture\n");
  repo.commit("Initial commit");

  repo.writeFile("docs/plan.md", "the plan\n");

  writeFileSync(join(repo.dir, "README.md"), "# fixture\nedited\n");

  mkdirSync(join(repo.dir, "src/feature"), { recursive: true });
  writeFileSync(join(repo.dir, "src/feature/new.ts"), "export const x = 1;\n");

  writeFileSync(join(repo.dir, "todo.txt"), "todo\n");
}

// Jump to the working tree (Ctrl+Shift+U — see legacy/main.ts's
// goToUncommitted, driven the same way by e2e/detail-panel-escape.spec.ts and
// e2e/detail-placement.spec.ts) and land on its "changes" tab (index 1 of 3 —
// Commit/Changes/Stash), where the staged/unstaged trees live.
async function openChangesTab(page: Page) {
  await page.keyboard.press("Control+Shift+U");
  const tabs = page.locator("#detail .d-tabs .d-tab");
  await expect(tabs).toHaveCount(3);
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveClass(/\bon\b/);
}

// Live guard, called once per test right after `page.goto("/")`: if the
// `setPlacement` seeding above ever stopped working — a localStorage key
// rename, a future settings-blob migration/validation, an init-script
// ordering change — every test in the `for (const placement …)` loop
// below would keep passing while silently exercising the "right" layout
// twice instead of genuinely covering both placements. This spec is the
// evidence staging is reachable in EITHER placement, so that failure mode
// has to be loud, not silent.
async function expectPlacementApplied(page: Page, placement: "right" | "bottom") {
  await expect(page.locator("html")).toHaveAttribute("data-detail-placement", placement);
}

for (const placement of ["right", "bottom"] as const) {
  test.describe(`placement: ${placement}`, () => {
    test.beforeEach(async ({ page }) => {
      await setPlacement(page, placement);
    });

    test("stage one file, unstage another", async ({ page, repo, calls }) => {
      setupWorkdirRepo(repo);
      await page.goto("/");
      await expectPlacementApplied(page, placement);
      await openRepo(page);
      await openChangesTab(page);

      // Scoped to the inline changes-tab file list (.d-split-files), not
      // page-wide: Workdir.svelte also renders the SAME staged/unstaged trees
      // a second time inside the (visually hidden until opened) expanded-diff
      // modal, so an unscoped locator would hit a strict-mode "2 elements"
      // violation even though only one copy is ever visible.
      const files = page.locator("#detail .d-split-files");

      // Unstaged (README.md, edited on disk but never `git add`ed) -> Stage.
      const stageBtn = files.getByRole("button", { name: "Stage README.md", exact: true });
      await expect(stageBtn).toBeVisible();
      await stageBtn.click();
      await expect
        .poll(() => calls.some((c) => c.cmd === "stage_file" && c.args.path === repo.dir && c.args.file === "README.md"))
        .toBe(true);

      // Staged (docs/plan.md, from setupWorkdirRepo) -> Unstage.
      const unstageBtn = files.getByRole("button", { name: "Unstage docs/plan.md", exact: true });
      await expect(unstageBtn).toBeVisible();
      await unstageBtn.click();
      await expect
        .poll(() => calls.some((c) => c.cmd === "unstage_file" && c.args.path === repo.dir && c.args.file === "docs/plan.md"))
        .toBe(true);
    });

    test("stage a whole folder", async ({ page, repo, calls }) => {
      setupWorkdirRepo(repo);
      await page.goto("/");
      await expectPlacementApplied(page, placement);
      await openRepo(page);
      await openChangesTab(page);

      // src/feature (unstaged — holds only the untracked new.ts) -> its
      // folder-row "+" button, not a per-file stage. Scoped to the inline
      // pane, not page-wide — see the "stage a file" test's own comment on
      // the hidden expanded-diff modal's duplicate tree.
      const stageFolderBtn = page.locator("#detail .d-split-files").getByRole("button", { name: "Stage folder src/feature", exact: true });
      await expect(stageFolderBtn).toBeVisible();
      await stageFolderBtn.click();
      await expect
        .poll(() => calls.some((c) => c.cmd === "stage_file" && c.args.path === repo.dir && c.args.file === "src/feature"))
        .toBe(true);
    });

    test("discard a file", async ({ page, repo, calls }) => {
      setupWorkdirRepo(repo);
      await page.goto("/");
      await expectPlacementApplied(page, placement);
      await openRepo(page);
      await openChangesTab(page);

      // todo.txt is untracked, so it only carries a right-click row menu
      // (confirmDiscard's own oncontextmenu — see Workdir.svelte's
      // unstagedDirNode), not a visible discard button on the row itself.
      // Scoped to the inline pane, not page-wide — see the "stage a file"
      // test's own comment on the hidden expanded-diff modal's duplicate tree.
      const row = page
        .locator("#detail .d-split-files .wd-file")
        .filter({ has: page.locator(".wd-path", { hasText: /^todo\.txt$/ }) });
      await expect(row).toBeVisible();
      await row.click({ button: "right" });
      const menuItem = page.locator(".wd-rowmenu-item.danger");
      await expect(menuItem).toBeVisible();
      await menuItem.click();

      // The typed-confirm scrim (bridge.armDanger — a single global
      // #dangerScrim shared with every other danger flow in the app, not
      // scoped to #detail). Armed only once the input EXACTLY matches the
      // file's own name.
      const scrim = page.locator("#dangerScrim");
      await expect(scrim).toHaveClass(/\bon\b/);
      const dangerGo = page.locator("#dangerGo");
      await expect(dangerGo).toBeDisabled();
      await page.locator("#confirmInput").fill("todo.txt");
      await expect(dangerGo).toBeEnabled();
      await dangerGo.click();

      await expect
        .poll(() =>
          calls.some(
            (c) => c.cmd === "discard_file" && c.args.path === repo.dir && c.args.file === "todo.txt" && c.args.untracked === true,
          ),
        )
        .toBe(true);
    });

    test("type a commit message and commit", async ({ page, repo, calls }) => {
      setupWorkdirRepo(repo);
      await page.goto("/");
      await expectPlacementApplied(page, placement);
      await openRepo(page);
      // The Commit tab is index 0 — the default tab a fresh working-tree
      // selection lands on, so no tab click needed here.
      await page.keyboard.press("Control+Shift+U");
      await expect(page.locator("#detail .d-tabs .d-tab")).toHaveCount(3);

      const msgBox = page.locator("#detail .wd-msg");
      await expect(msgBox).toBeVisible();
      await msgBox.fill("A staging e2e commit");
      const commitBtn = page.locator("#detail .wd-commit-row .btn");
      await expect(commitBtn).toBeEnabled();
      await commitBtn.click();

      await expect
        .poll(() =>
          calls.some(
            (c) => c.cmd === "commit" && c.args.path === repo.dir && c.args.message === "A staging e2e commit" && c.args.amend === false,
          ),
        )
        .toBe(true);
    });

    test("open the Stash tab", async ({ page, repo, calls }) => {
      setupWorkdirRepo(repo);
      await page.goto("/");
      await expectPlacementApplied(page, placement);
      await openRepo(page);
      await page.keyboard.press("Control+Shift+U");

      const tabs = page.locator("#detail .d-tabs .d-tab");
      await expect(tabs).toHaveCount(3);
      await tabs.nth(2).click();
      await expect(tabs.nth(2)).toHaveClass(/\bon\b/);

      // Reaching the tab alone only proves navigation, not that a control ON
      // it still fires — so drive the "+ Stash changes…" form all the way
      // through a save, the way a user actually would.
      const newStashBtn = page.locator("#detail .wd-stash-new");
      await expect(newStashBtn).toBeVisible();
      await newStashBtn.click();

      const stashForm = page.locator("#detail .wd-stash-form");
      await expect(stashForm).toBeVisible();
      await stashForm.locator("> input").fill("e2e stash");
      await stashForm.locator(".wd-amend input[type=checkbox]").check();
      await stashForm.locator("button.btn:not(.ghost)").click();

      await expect
        .poll(() =>
          calls.some(
            (c) => c.cmd === "stash_save" && c.args.path === repo.dir && c.args.message === "e2e stash" && c.args.includeUntracked === true,
          ),
        )
        .toBe(true);
    });
  });
}
