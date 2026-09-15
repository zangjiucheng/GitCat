// Compare two commits (#49), driven the way a user reaches it: select one
// commit on the canvas, right-click another.
//
// Design mode (plain browser, no Tauri) — the controller answers with its own
// DEMO summary there, so the whole gesture is reachable without a backend.
//
// This file exists because of a bug nothing else could have caught. The commit
// menu's own handler SELECTS the row you right-click, at the top of the same
// listener that later reads the compare anchor — so by the time the anchor was
// read it was already the right-clicked row, the "different commit" guard was
// always false, and the menu item never appeared at all. The backend was fully
// tested and entirely correct; the entry point did not work.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

// The pinned "Uncommitted changes" band takes exactly one row's height above
// row 0 (bandH() === layout.rowH), and a design-mode row is 26 CSS px — the
// same constant e2e/band-i18n.spec.ts clicks the band with.
const ROW_H = 26;
const rowY = (boxY: number, row: number) => boxY + ROW_H + row * ROW_H + ROW_H / 2;
/** Clear of the lane dot, inside the row's message area. */
const ROW_X = 120;

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.locator("#cv")).toBeVisible();
  // Design mode opens the setup wizard unconditionally and its scrim covers
  // the canvas, so every click below would land on the scrim instead.
  await page.keyboard.press("Escape");
  await expect(page.locator("#setupWizardScrim")).toBeHidden();
  return (await page.locator("#cv").boundingBox())!;
}

const menu = (page: Page) => page.locator(".ref-pop.cm-pop");
const compareItem = (page: Page) => menu(page).getByRole("button", { name: /compare with/i });
const popover = (page: Page) => page.locator(".ref-pop.rs-pop");

test("right-clicking a second commit offers to compare it with the selected one", async ({ page }) => {
  const box = await ready(page);

  await page.mouse.click(box.x + ROW_X, rowY(box.y, 0)); // select row 0
  await page.mouse.click(box.x + ROW_X, rowY(box.y, 2), { button: "right" });

  await expect(menu(page)).toBeVisible();
  await expect(compareItem(page), "the compare item never appeared").toBeVisible();
  // And it names the commit that was selected BEFORE the right-click — not the
  // one just right-clicked, which is what the bug produced.
  const headerSha = await menu(page).locator(".cm-head .sha").innerText();
  const label = await compareItem(page).innerText();
  expect(label, `the anchor is the right-clicked row itself: ${label}`).not.toContain(headerSha.trim());
});

test("choosing it opens the summary popover", async ({ page }) => {
  const box = await ready(page);
  await page.mouse.click(box.x + ROW_X, rowY(box.y, 0));
  await page.mouse.click(box.x + ROW_X, rowY(box.y, 2), { button: "right" });
  await compareItem(page).click();

  await expect(menu(page), "the menu should step aside").toBeHidden();
  await expect(popover(page)).toBeVisible();
  // The two endpoints, and the numbers.
  await expect(popover(page).locator(".cm-head .sha")).toContainText("…");
  await expect(popover(page).locator(".rs-stat")).toBeVisible();
  await expect(popover(page).locator(".rs-commit").first()).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(popover(page)).toBeHidden();
});

test("right-clicking the commit that is already selected offers nothing to compare", async ({ page }) => {
  // "Compare with myself" is not a thing, and this is also the state the buggy
  // version was permanently stuck in.
  const box = await ready(page);
  await page.mouse.click(box.x + ROW_X, rowY(box.y, 1));
  await page.mouse.click(box.x + ROW_X, rowY(box.y, 1), { button: "right" });

  await expect(menu(page)).toBeVisible();
  await expect(compareItem(page)).toHaveCount(0);
});

test("right-clicking with nothing selected offers nothing to compare", async ({ page }) => {
  const box = await ready(page);
  await page.mouse.click(box.x + ROW_X, rowY(box.y, 3), { button: "right" });

  await expect(menu(page)).toBeVisible();
  await expect(compareItem(page)).toHaveCount(0);
});

test("Escape closes a canvas popover — the commit menu as well as this one", async ({ page }) => {
  // A REGRESSION the keymap stack introduced and this branch happened to trip
  // over. `canvas.deselect` binds Escape in the graph scope, which is the pane
  // fallback — and right-clicking the canvas leaves focus ON the canvas. So the
  // binding stayed live over an open popover, claimed Escape at window-capture
  // and stopped it upstream of the island's own <svelte:window> handler.
  //
  // `noScrimOpen` did not cover it and could not: a `.ref-pop` is a bare
  // positioned div with no backdrop, so `.scrim.on` never matched one.
  const box = await ready(page);

  // The pre-existing commit menu first — it was broken before this branch.
  await page.mouse.click(box.x + ROW_X, rowY(box.y, 2), { button: "right" });
  await expect(menu(page)).toBeVisible();
  await expect(
    page.locator("#cv"),
    "the precondition: focus is on the canvas, which is what made the graph scope active",
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu(page), "Escape did not reach the commit menu").toBeHidden();

  // …and the compare popover, which is the same kind of surface.
  await page.mouse.click(box.x + ROW_X, rowY(box.y, 0));
  await page.mouse.click(box.x + ROW_X, rowY(box.y, 2), { button: "right" });
  await compareItem(page).click();
  await expect(popover(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover(page)).toBeHidden();
});

test("the arrows do not move the graph selection behind an open popover", async ({ page }) => {
  // Same guard, the other half of what it protects: with the menu up, the
  // canvas bindings used to keep claiming ArrowUp/Down and quietly retarget
  // the selection underneath it — so dismissing the menu left you somewhere
  // else entirely.
  const box = await ready(page);
  await page.mouse.click(box.x + ROW_X, rowY(box.y, 2), { button: "right" });
  await expect(menu(page)).toBeVisible();
  const before = await menu(page).locator(".cm-head .sha").innerText();

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");

  // Re-open on the same row: if the arrows had moved the selection, the menu
  // would now be keyed to a different commit.
  await page.mouse.click(box.x + ROW_X, rowY(box.y, 2), { button: "right" });
  await expect(menu(page).locator(".cm-head .sha")).toHaveText(before);
});
