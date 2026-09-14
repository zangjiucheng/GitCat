// End-to-end coverage for the modifier masks and text-input guards added in
// the keyboard-safety pass (see the keymap tracking issue).
//
// WHY e2e and not unit tests: every one of these handlers lives in a `.svelte`
// component or in legacy/main.ts. There is no component-mounting test library in
// this repo — the vitest suites target controllers and pure modules — and
// legacy/main.ts is a whole canvas app that boots on import, which is exactly
// why every other suite mocks it away. A real keydown against the real DOM is
// the only place these are observable.
//
// Each test asserts a NEGATIVE (the chord did nothing) next to the matching
// POSITIVE (the intended chord still works). A negative on its own would keep
// passing if the feature broke entirely.
import { test, expect } from "@playwright/test";
import { test as repoTest, expect as repoExpect } from "./fixtures/tauriMock";
import type { Page } from "@playwright/test";

// Same helper as e2e/detail-panel-escape.spec.ts — specs that load the app
// without the tauriMock fixture have to dismiss the wizard themselves.
async function skipWizard(page: Page) {
  const wizard = page.locator("#setupWizardScrim");
  await expect(wizard).toHaveClass(/\bon\b/);
  await page.keyboard.press("Escape");
  await expect(wizard).not.toHaveClass(/\bon\b/);
}

test.describe("command palette modifier mask", () => {
  // Cmdk.svelte's "/" branch tested no modifiers at all, so ⌘/ , Ctrl+/ and ⌥/
  // all opened the palette. Shift is deliberately still allowed: "/" is
  // Shift-typed on AZERTY and QWERTZ, and rejecting it would make the key
  // unreachable on those layouts.
  test("Alt+/ does not open the palette, but a bare / does", async ({ page }) => {
    await page.goto("/");
    await skipWizard(page);
    const cmdk = page.locator("#cmdk");

    await page.keyboard.press("Alt+Slash");
    await expect(cmdk).not.toHaveClass(/\bon\b/);

    await page.keyboard.press("Control+Slash");
    await expect(cmdk).not.toHaveClass(/\bon\b/);

    await page.keyboard.press("Slash");
    await expect(cmdk).toHaveClass(/\bon\b/);
  });
});

test.describe("global undo", () => {
  // legacy/main.ts's handler matched "at least Cmd/Ctrl", so ⌘⇧Z — Redo in
  // every other desktop app — performed a real Undo, as did ⌥⌘Z. In design mode
  // globalUndo() calls cheer(), which is what #tamaCheer shows.
  test("Ctrl+Shift+Z does not undo; Ctrl+Z does", async ({ page }) => {
    await page.goto("/");
    await skipWizard(page);
    // #tamaCheer is shown with `.show`, not the `.on` every scrim uses.
    const cheer = page.locator("#tamaCheer");

    await page.keyboard.press("Control+Shift+Z");
    await expect(cheer).not.toHaveClass(/\bshow\b/);

    await page.keyboard.press("Control+Alt+Z");
    await expect(cheer).not.toHaveClass(/\bshow\b/);

    await page.keyboard.press("Control+Z");
    await expect(cheer).toHaveClass(/\bshow\b/);
  });
});

// The ⌘F guard needs a repo open: CodeSearch.svelte returns early when
// bridge.CUR_REPO is empty, so in plain design mode this test would pass for
// the wrong reason. tauriMock opens a real fixture repo.
repoTest.describe("code search text-input guard", () => {
  repoTest("Ctrl+F while typing a commit message does not open Search Code", async ({ page, repo }) => {
    // One commit so the graph has a row (the hero stat below is the signal that
    // load_graph's batch actually arrived), plus a dirty file so the working
    // tree has something to commit — same seeding as e2e/staging.spec.ts.
    repo.writeFile("README.md", "# fixture\n");
    repo.commit("Initial commit");
    repo.writeFile("docs/plan.md", "the plan\n");

    await page.goto("/");
    await page.locator(".repo-pick").click();
    await page.locator(".db-add").click();
    await repoExpect(page.locator(".hero-stat .n")).toHaveText("1");

    // Ctrl+Shift+U lands on the working tree, whose Commit tab holds the
    // message textarea (see e2e/staging.spec.ts's openChangesTab).
    await page.keyboard.press("Control+Shift+U");
    const msg = page.locator("#detail textarea.wd-msg");
    await repoExpect(msg).toBeVisible();

    const codeSearch = page.locator(".scrim:has(.modal.codesearch)");
    await msg.click();
    await msg.pressSequentially("fix: guard the find chord");
    await page.keyboard.press("Control+f");
    await repoExpect(codeSearch).not.toHaveClass(/\bon\b/);
    // The message must still be intact — the point of the guard is that the
    // keystroke belonged to the field.
    await repoExpect(msg).toHaveValue("fix: guard the find chord");

    // Same chord with focus outside a text field still opens it, so the guard
    // narrowed the binding rather than breaking it.
    await page.locator("canvas#cv").click({ position: { x: 20, y: 20 } });
    await page.keyboard.press("Control+f");
    await repoExpect(codeSearch).toHaveClass(/\bon\b/);
  });
});
