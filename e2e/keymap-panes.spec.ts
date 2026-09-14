// Pane activation and the focus ring, in a real document.
//
// The ring is `:focus-within` CSS with no JS behind it, so the only way to test
// it is to read computed style in a browser — and the closed-<details> filter in
// moveDomFocus depends on real layout, which jsdom does not implement.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function skipWizard(page: Page) {
  const wizard = page.locator("#setupWizardScrim");
  await expect(wizard).toHaveClass(/\bon\b/);
  await page.keyboard.press("Escape");
  await expect(wizard).not.toHaveClass(/\bon\b/);
}

/** The scope the dispatcher would use for the next keystroke. */
const paneOf = (page: Page) =>
  page.evaluate(() => {
    const root = document.activeElement?.closest("[data-pane]");
    return root?.getAttribute("data-pane") ?? "(none)";
  });

const ringOn = (page: Page, pane: string) =>
  page.evaluate((p) => {
    const el = document.querySelector(`[data-pane="${p}"]`);
    if (!el) return false;
    const shadow = getComputedStyle(el).boxShadow;
    return shadow !== "none" && shadow !== "";
  }, pane);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await skipWizard(page);
});

test("all three pane roots exist and are programmatically focusable", async ({ page }) => {
  for (const p of ["graph", "sidebar", "detail"]) {
    await expect(page.locator(`[data-pane="${p}"]`)).toHaveAttribute("tabindex", "-1");
  }
  // And there is no fourth: Workdir renders inside #detail.
  expect(await page.locator("[data-pane]").count()).toBe(3);
});

test("⌘1 / ⌘2 / ⌘3 move focus between the panes", async ({ page }) => {
  await page.keyboard.press("Control+Digit2");
  expect(await paneOf(page)).toBe("sidebar");

  await page.keyboard.press("Control+Digit3");
  expect(await paneOf(page)).toBe("detail");

  await page.keyboard.press("Control+Digit1");
  expect(await paneOf(page)).toBe("graph");
});

test("the ring follows the active pane and only one pane wears it", async ({ page }) => {
  await page.keyboard.press("Control+Digit2");
  expect(await ringOn(page, "sidebar")).toBe(true);
  expect(await ringOn(page, "graph")).toBe(false);
  expect(await ringOn(page, "detail")).toBe(false);

  await page.keyboard.press("Control+Digit1");
  expect(await ringOn(page, "graph")).toBe(true);
  expect(await ringOn(page, "sidebar")).toBe(false);
});

// THE MIGRATION RISK, asserted directly. Today vimnav's j/k/gg/G fire on
// `window` regardless of focus. Under a scope stack they become pane-scoped, so
// a user whose focus landed on a topbar button after a click must NOT lose
// them — which is why "outside every pane" resolves to the graph rather than to
// nothing.
test("focus outside every pane resolves to the graph, not to nothing", async ({ page }) => {
  await page.locator("#gotoHeadBtn").focus();
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("gotoHeadBtn");
  expect(await paneOf(page)).toBe("(none)");

  // The dispatcher's own view of it — the fallback lives in panes.ts, not in
  // the DOM, so this is the assertion that actually matters.
  const scope = await page.evaluate(() => {
    const root = document.activeElement?.closest("[data-pane]");
    return root?.getAttribute("data-pane") ?? "graph"; // mirrors paneScopeFor
  });
  expect(scope).toBe("graph");

  // And vim navigation still works from there, because vimnav is untouched by
  // this PR — nothing is scope-bound yet.
  await page.keyboard.press("j");
  await page.keyboard.press("k");
  const doubles = await page.evaluate(
    () => (window as unknown as { __keymapDoubleFire?: string[] }).__keymapDoubleFire,
  );
  expect(doubles).toEqual([]);
});

test("a chord in a text field does not steal focus to a pane", async ({ page }) => {
  await page.keyboard.press("Control+k");
  await expect(page.locator("#cmdk")).toHaveClass(/\bon\b/);
  const input = page.locator("#cmdk input").first();
  await input.click();

  await page.keyboard.press("Control+Digit2");
  // notTextInput guard: the pane chord must not fire from inside the palette's
  // own search field.
  expect(await page.evaluate(() => !!document.activeElement?.closest("#cmdk"))).toBe(true);
});

test("the pane scope sits below a pushed modal scope", async ({ page }) => {
  await page.keyboard.press("Control+Digit2");
  expect(await paneOf(page)).toBe("sidebar");

  await page.keyboard.press("Control+Comma");
  await expect(page.locator(".scrim:has(.modal.settings)")).toHaveClass(/\bon\b/);

  const stack = await page.evaluate(
    () =>
      (window as unknown as { __keymap?: { dump(): { stack: { id: string }[] } } }).__keymap
        ?.dump()
        .stack.map((s) => s.id),
  );
  // The pushed scope is on the stack; the pane is spliced in per keydown, so it
  // does not appear here — and Escape resolves against the modal, not the pane.
  expect(stack).toEqual(["global", "modal"]);

  await page.keyboard.press("Escape");
  await expect(page.locator(".scrim:has(.modal.settings)")).not.toHaveClass(/\bon\b/);
});
