// The scope stack, the LIFO Escape path and the focus contract, proved end to
// end on Settings — the first island to push a scope.
//
// These are e2e and not unit tests for two reasons beyond the usual one (there
// is no component-mounting test library here): the Tab trap's visibility filter
// depends on real layout and real computed style, which jsdom does not
// implement at all, and the bug being fixed (#129) is a consequence of listener
// REGISTRATION ORDER across the legacy controller and 36 islands, which only
// exists in a real document.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function skipWizard(page: Page) {
  const wizard = page.locator("#setupWizardScrim");
  await expect(wizard).toHaveClass(/\bon\b/);
  await page.keyboard.press("Escape");
  await expect(wizard).not.toHaveClass(/\bon\b/);
}

const settings = (page: Page) => page.locator(".scrim:has(.modal.settings)");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await skipWizard(page);
});

test("the scope stack is defined at boot and starts with global alone", async ({ page }) => {
  const stack = await page.evaluate(
    () =>
      (window as unknown as { __keymap?: { dump(): { stack: { id: string }[] } } }).__keymap
        ?.dump()
        .stack.map((s) => s.id),
  );
  expect(stack).toEqual(["global"]);
});

test("opening Settings pushes a modal scope, closing it pops", async ({ page }) => {
  const topScope = () =>
    page.evaluate(
      () =>
        (window as unknown as { __keymap?: { dump(): { stack: { id: string }[] } } }).__keymap
          ?.dump()
          .stack.at(-1)?.id,
    );

  await page.keyboard.press("Control+Comma");
  await expect(settings(page)).toHaveClass(/\bon\b/);
  expect(await topScope()).toBe("modal");

  await page.keyboard.press("Escape");
  await expect(settings(page)).not.toHaveClass(/\bon\b/);
  expect(await topScope()).toBe("global");
});

// THE BUG. legacy/main.ts's Escape handler is unguarded and registers at
// module-evaluation time, i.e. before every island mounts — so one Escape both
// dismissed the top overlay and acted on the layer underneath it.
test("Escape closes ONLY the top layer, leaving the expanded diff open", async ({ page }) => {
  // Layer 1: the expanded-diff modal, opened the way e2e/detail-panel-escape
  // does it.
  await page.locator("#gotoHeadBtn").click();
  await page.locator("#detail .d-tabs .d-tab").nth(1).click();
  await expect(page.locator("#diffview")).toBeVisible();
  await page.locator("#diffview .wd-act").click();
  await expect(page.locator("#detail .scrim")).toHaveClass(/\bon\b/);

  // Layer 2: Settings on top of it.
  await page.keyboard.press("Control+Comma");
  await expect(settings(page)).toHaveClass(/\bon\b/);

  await page.keyboard.press("Escape");

  await expect(settings(page)).not.toHaveClass(/\bon\b/);
  // Before the scope stack, this one keypress collapsed the diff too.
  await expect(page.locator("#detail .scrim")).toHaveClass(/\bon\b/);

  // And a second Escape still closes the layer underneath, so nothing is
  // stranded — the fix narrows Escape, it does not consume it.
  await page.keyboard.press("Escape");
  await expect(page.locator("#detail .scrim")).not.toHaveClass(/\bon\b/);
});

// Overlays STACK. Settings' nightly toggle opens About on top of it, and before
// About pushed a scope of its own the modal scope Settings held claimed Escape
// and trapped Tab — so Escape closed Settings behind the About scrim and Tab
// never reached About's controls.
test("a dialog opened over another gets Escape and Tab, not the one beneath", async ({ page }) => {
  await page.keyboard.press("Control+Comma");
  await expect(settings(page)).toHaveClass(/\bon\b/);

  // The nightly-channel toggle is what opens About on top of Settings. Located
  // by its label rather than by index, so re-ordering the panel does not
  // silently point this test at some other checkbox.
  const nightly = page.locator(".modal.settings label", { hasText: /nightly/i }).locator("input");
  await expect(nightly, "the nightly toggle moved — this test needs a path that opens About").toBeVisible();
  await nightly.click();

  const about = page.locator(".modal.about-modal");
  await expect(about).toBeVisible();

  // Tab belongs to the dialog on top.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => !!document.activeElement?.closest(".about-modal")),
      `focus left About on Tab #${i + 1}`,
    ).toBe(true);
  }

  // And so does Escape: About closes, Settings stays.
  await page.keyboard.press("Escape");
  await expect(about).toHaveCount(0);
  await expect(settings(page)).toHaveClass(/\bon\b/);

  // The scope underneath is live again, so the next Escape closes Settings.
  await page.keyboard.press("Escape");
  await expect(settings(page)).not.toHaveClass(/\bon\b/);
});

test("Escape closes the dialog from inside one of its own fields", async ({ page }) => {
  // pushScope focuses INTO the dialog on open, so "focus is in a field" is the
  // normal case, not an edge one. The text-input guard used to deny Escape here
  // and the dialog simply could not be closed by keyboard.
  await page.keyboard.press("Control+Comma");
  await expect(settings(page)).toHaveClass(/\bon\b/);

  const field = page.locator(".modal.settings input").first();
  await expect(field).toBeVisible();
  await field.focus();
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("INPUT");

  await page.keyboard.press("Escape");
  await expect(settings(page)).not.toHaveClass(/\bon\b/);
});

test("Tab is confined to the open dialog", async ({ page }) => {
  await page.keyboard.press("Control+Comma");
  await expect(settings(page)).toHaveClass(/\bon\b/);

  // Twenty tabs is well past the dialog's own control count, so if the trap
  // leaked at all focus would be out in the topbar or the sidebar by now.
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => !!document.activeElement?.closest(".modal.settings"));
    expect(inside, `focus escaped the dialog on Tab #${i + 1}`).toBe(true);
  }

  // Shift+Tab is trapped too, and in the other direction.
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest(".modal.settings"))).toBe(true);
});

// The filter that makes the trap correct. GitCat's scrims hide with
// `visibility:hidden`, NOT display:none, so a CLOSED modal's buttons keep a
// layout box and a non-null offsetParent — an offsetParent-only check would let
// Tab cycle through every closed dialog in the app.
test("Tab never reaches a closed modal's controls", async ({ page }) => {
  await page.keyboard.press("Control+Comma");
  await expect(settings(page)).toHaveClass(/\bon\b/);

  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    const stray = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const scrim = el.closest(".scrim");
      // Focus inside a scrim that is not `on` means the trap walked into a
      // closed dialog.
      return scrim && !scrim.classList.contains("on") ? scrim.className : null;
    });
    expect(stray, `Tab #${i + 1} landed inside a closed scrim`).toBeNull();
  }
});

test("focus moves into the dialog on open and returns to the trigger on close", async ({ page }) => {
  // Give focus to a real, identifiable control first so "returned" is
  // observable rather than a coincidence of <body>.
  const trigger = page.locator("#gotoHeadBtn");
  await trigger.focus();
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("gotoHeadBtn");

  await page.keyboard.press("Control+Comma");
  await expect(settings(page)).toHaveClass(/\bon\b/);
  expect(await page.evaluate(() => !!document.activeElement?.closest(".modal.settings"))).toBe(true);

  await page.keyboard.press("Escape");
  await expect(settings(page)).not.toHaveClass(/\bon\b/);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("gotoHeadBtn");
});

// Documents TODAY's behaviour so that changing it has to be deliberate.
//
// The palette declares layer:"always" in the table, which means the dispatcher
// will resolve it regardless of stack depth — but palette.toggle is still
// mode:"shadow", so Cmdk.svelte's own handler is what actually runs, and that
// handler bails on ANY `.scrim.on`. PR 0 added [data-modal-blocking] to mark
// the scrims that genuinely must not be covered; narrowing the guard to it is
// what will let the palette open over Settings.
//
// That narrowing is not in this PR on purpose: the same `.scrim.on` probe
// appears in five files and the narrowing is correct in three of them and wrong
// in the rest (vimnav's uses need the top scope, not the attribute). When it
// lands, THIS TEST FAILS — which is the point.
test("the palette does not yet open over Settings (pending the scrim-guard narrowing)", async ({ page }) => {
  await page.keyboard.press("Control+Comma");
  await expect(settings(page)).toHaveClass(/\bon\b/);

  await page.keyboard.press("Control+k");
  await expect(page.locator("#cmdk")).not.toHaveClass(/\bon\b/);
});

test("no claimed key ever reaches document-bubble", async ({ page }) => {
  // host.ts's dev canary. A hit here means the suppression listener failed and
  // some legacy handler saw a key the registry had already acted on — the
  // double-fire this whole design exists to make impossible.
  await page.keyboard.press("Control+Comma");
  await expect(settings(page)).toHaveClass(/\bon\b/);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");

  const doubles = await page.evaluate(
    () => (window as unknown as { __keymapDoubleFire?: string[] }).__keymapDoubleFire,
  );
  expect(doubles).toEqual([]);
});
