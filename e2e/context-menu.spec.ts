import { test, expect } from "@playwright/test";

// Design mode (plain browser, no Tauri mock) — the same base `test` as
// sidebar-jump-design/scroll-blit. The context menu itself is frontend-only:
// building the item list, positioning it, and dismissing it never touch the
// backend, so this covers the whole of what a browser can reach. The two
// items that DO call Tauri (reveal / open in file manager) are unit-tested
// against a mocked `commands` instead — there is no backend here to reveal
// anything with.

// In design mode the setup wizard opens at boot unconditionally and its scrim
// swallows every click underneath (see sidebar-jump-design.spec.ts, which
// documents the same dance). Escape is the wizard's own "Skip".
async function skipWizard(page: import("@playwright/test").Page) {
  const wizard = page.locator("#setupWizardScrim");
  await expect(wizard).toHaveClass(/\bon\b/);
  await page.keyboard.press("Escape");
  await expect(wizard).not.toHaveClass(/\bon\b/);
}

// Select a commit so the detail panel's file tree is populated, then hand back
// its first file row.
async function fileRows(page: import("@playwright/test").Page) {
  await page.locator('#refLocal [data-branch="main"]').click();
  // #tree, not "#detail .file": the same file-tree snippet is rendered twice,
  // once inline and once inside the expanded-diff modal, so an unscoped
  // selector matches every row twice.
  const rows = page.locator("#tree .file");
  await expect(rows.first()).toBeVisible();
  return rows;
}

test("right-clicking a commit's file row opens a menu, and dismisses like a popover", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/");
  await skipWizard(page);
  const file = (await fileRows(page)).first();

  await file.click({ button: "right" });

  const menu = page.locator(".ctxmenu");
  await expect(menu).toBeVisible();
  // Three of the row's own actions, a divider, then the three this menu adds.
  await expect(menu.locator(".ctxmenu-item")).toHaveCount(6);
  await expect(menu.locator(".ctxmenu-sep")).toHaveCount(1);

  // The row it points at is the one that got selected, so the menu can never
  // be read as acting on a different file than the highlighted one.
  await expect(file).toHaveClass(/\bactive\b/);

  // Escape dismisses, like every other popover in the app.
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("the menu stays on screen when the click is at the bottom edge", async ({ page }) => {
  await page.goto("/");
  await skipWizard(page);
  const file = (await fileRows(page)).first();

  // Right-click as low in the window as the row allows. A six-item menu
  // opening downward from here would run past the fold, and the backdrop
  // swallows scrolling, so the last items would be unreachable.
  const box = (await file.boundingBox())!;
  const viewport = page.viewportSize()!;
  await file.click({ button: "right", position: { x: 5, y: Math.max(1, box.height - 1) } });

  const menu = page.locator(".ctxmenu");
  await expect(menu).toBeVisible();
  const menuBox = (await menu.boundingBox())!;
  expect(menuBox.y).toBeGreaterThanOrEqual(0);
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width);
});

// Never two menus at once. The backdrop takes the dismissing click, so a
// right-click elsewhere closes the open menu rather than opening a second one
// — one extra click, and the same behaviour the Workdir menu already had.
// What must never happen is the previous row's actions staying on screen.
test("a right-click elsewhere dismisses the menu instead of stacking a second", async ({ page }) => {
  await page.goto("/");
  await skipWizard(page);
  const files = await fileRows(page);
  const count = await files.count();
  test.skip(count < 2, "needs at least two demo files in the commit");

  await files.nth(0).click({ button: "right" });
  await expect(page.locator(".ctxmenu")).toHaveCount(1);
  await page.locator(".ctxmenu-backdrop").click({ button: "right", position: { x: 5, y: 5 } });
  await expect(page.locator(".ctxmenu")).toHaveCount(0);

  await files.nth(1).click({ button: "right" });
  await expect(page.locator(".ctxmenu")).toHaveCount(1);
});

// The bug this covers: folder rows were left without a handler when the file
// rows got one, so right-clicking a folder in the tree did nothing at all.
test("right-clicking a folder row opens its own menu, with no leading divider", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/");
  await skipWizard(page);
  await page.locator('#refLocal [data-branch="main"]').click();

  // #tree for the same reason fileRows() scopes to it: the tree snippet is
  // rendered twice, inline and inside the expanded-diff modal.
  const folder = page.locator("#tree details.dir > summary").first();
  await expect(folder).toBeVisible();

  await folder.click({ button: "right" });

  const menu = page.locator(".ctxmenu");
  await expect(menu).toBeVisible();
  // A folder row carries no icon buttons of its own, so the path trio is the
  // whole menu — open, copy path, copy full path.
  await expect(menu.locator(".ctxmenu-item")).toHaveCount(3);
  // ...and being the only group, it must not draw a divider above its first
  // item. The builder marks one; ContextMenu.svelte drops it at index 0.
  await expect(menu.locator(".ctxmenu-sep")).toHaveCount(0);

  // A right-click must not toggle the folder open or closed — <details>
  // reacts to a plain click, and the handler has to preventDefault so the
  // native menu does not appear either.
  const openState = await folder.evaluate((el) => (el.parentElement as HTMLDetailsElement).open);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  expect(await folder.evaluate((el) => (el.parentElement as HTMLDetailsElement).open)).toBe(openState);

  expect(errors).toEqual([]);
});
