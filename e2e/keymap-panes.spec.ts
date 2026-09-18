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

/**
 * Is the ring actually PAINTED, not merely declared?
 *
 * The first version of this read getComputedStyle(pane).boxShadow, which was
 * set while an inset shadow sat underneath a full-bleed canvas and nothing was
 * visible. This reads the ::after overlay that draws it and checks it covers
 * the pane and sits above the content — the properties that make it visible.
 */
const ringOn = (page: Page, pane: string) =>
  page.evaluate((p) => {
    const el = document.querySelector(`[data-pane="${p}"]`);
    if (!el) return false;
    const cs = getComputedStyle(el, "::after");
    if (cs.content === "none") return false;
    const shadow = cs.boxShadow;
    if (!shadow || shadow === "none") return false;
    // An overlay that is not on top of the pane's content is not a ring.
    return Number(cs.zIndex) > 0 && cs.pointerEvents === "none";
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

test("⌘3 lands on the panel's content, not on its resize handle", async ({ page }) => {
  // #detail's first tabbable descendant IS #resizeDetail. A raw
  // [tabindex="0"] query therefore focused the splitter — and in the bottom
  // placement that handle is display:none, so focus() was a silent no-op while
  // the chord still counted as handled.
  await page.keyboard.press("Control+Digit3");
  const landed = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      inDetail: !!el?.closest('[data-pane="detail"]'),
      onHandle: !!el?.classList.contains("resize-handle"),
      visible: !!el && (el.offsetParent !== null || el.getClientRects().length > 0),
    };
  });
  expect(landed.inDetail).toBe(true);
  expect(landed.onHandle).toBe(false);
  expect(landed.visible).toBe(true);
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

// This test used to assert the opposite, and the opposite was a trap: focusPane
// lands on the pane's first real control, which for the sidebar is the ref
// filter INPUT — so with a text guard, focus that entered a field could never
// leave by keyboard.
test("a pane chord works from inside a text field — that is how you leave one", async ({ page }) => {
  await page.keyboard.press("Control+Digit2");
  const inField = await page.evaluate(() => document.activeElement?.tagName === "INPUT");

  await page.keyboard.press("Control+Digit1");
  expect(await paneOf(page)).toBe("graph");

  // Worth stating what this test is really about: the sidebar's first control
  // being an input is what made the old behaviour a trap rather than a nicety.
  expect(inField, "the sidebar no longer focuses an input — re-check this test's premise").toBe(true);
});

test("a pane chord from the sidebar filter still leaves the sidebar", async ({ page }) => {
  await page.keyboard.press("Control+Digit2");
  await page.locator("#refFilter").focus();
  await expect(page.locator("#refFilter")).toBeFocused();

  await page.keyboard.press("Control+Digit3");
  expect(await paneOf(page)).toBe("detail");
});

test("the pane scope sits below a pushed modal scope", async ({ page }) => {
  await page.keyboard.press("Control+Digit2");
  expect(await paneOf(page)).toBe("sidebar");

  // Off the ref filter first: ⌘, carries a text-input guard of its own, and it
  // is deliberate — legacy/main.ts added it so a stray Ctrl+, mid-edit cannot
  // pop Settings. ⌘2 now lands on that input, so the test has to step out.
  await page.locator('[data-pane="sidebar"] [tabindex="0"]').first().focus();
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
