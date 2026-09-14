// The equivalence measurement for the keymap registry's shadow mode.
//
// PR 1 ships the whole table as mode:"shadow": the dispatcher matches a chord,
// increments a counter and then does NOTHING — no claim, no run, no
// preventDefault. Every legacy listener therefore stays authoritative. That is
// what makes the PR provably inert rather than argued-inert.
//
// The value over an empty table is that the matcher runs in production from day
// one and its agreement with each old handler is MEASURED before anyone deletes
// a listener. Each test below presses a chord and asserts BOTH halves:
//   1. the legacy effect still happened (nothing was suppressed), and
//   2. the shadow counter for the binding that will replace it went up by one.
//
// A counter that stays at 0 means the binding's chord spec, mask or matchOn
// disagrees with the handler it is supposed to replace — which is exactly the
// bug that would otherwise only surface in the PR that flips it live.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function skipWizard(page: Page) {
  const wizard = page.locator("#setupWizardScrim");
  await expect(wizard).toHaveClass(/\bon\b/);
  await page.keyboard.press("Escape");
  await expect(wizard).not.toHaveClass(/\bon\b/);
}

/** window.__keymap is dev-only (registry.ts), and Playwright drives the vite
 *  dev server, so it is present here and absent in a production build. */
async function shadowCount(page: Page, id: string): Promise<number> {
  return page.evaluate(
    ([key]) =>
      ((window as unknown as { __keymap?: { dump(): { shadow: Record<string, number> } } }).__keymap?.dump()
        .shadow[key] ?? 0),
    [id],
  );
}

async function reset(page: Page) {
  await page.evaluate(() =>
    (window as unknown as { __keymap?: { resetCounters(): void } }).__keymap?.resetCounters(),
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await skipWizard(page);
  await reset(page);
});

test("the registry is loaded, populated and entirely in shadow mode", async ({ page }) => {
  const dump = await page.evaluate(
    () =>
      (
        window as unknown as {
          __keymap?: { dump(): { bindings: { id: string; mode: string }[]; fires: Record<string, number> } };
        }
      ).__keymap?.dump(),
  );
  expect(dump, "window.__keymap is missing — did boot.ts stop loading?").toBeTruthy();
  expect(dump!.bindings.length).toBeGreaterThan(10);

  // Everything is still shadow except two enumerated sets: the accelerator-only
  // rows, which have no JS side to shadow, and the live bindings a later PR has
  // deliberately flipped. Keeping this an explicit list rather than a predicate
  // means flipping one more shows up as a diff here, which is the whole point.
  const ACCELERATOR_ONLY = ["branch.new", "window.new", "terminal.toggle"];
  const LIVE = ["modal.close", "pane.graph", "pane.sidebar", "pane.detail", "workdir.commit", "workdir.amend", "workdir.stage", "workdir.unstage", "workdir.stageAll", "workdir.unstageAll", "workdir.discard", "canvas.menu", "canvas.down", "canvas.up", "canvas.first", "canvas.last", "canvas.deselect"];
  const notShadow = dump!.bindings.filter((b) => b.mode !== "shadow").map((b) => b.id).sort();
  expect(notShadow).toEqual([...ACCELERATOR_ONLY, ...LIVE].sort());
});

test("Ctrl+Z: the legacy undo still fires AND edit.undo shadows it", async ({ page }) => {
  const cheer = page.locator("#tamaCheer");

  await page.keyboard.press("Control+Z");
  await expect(cheer).toHaveClass(/\bshow\b/); // legacy ran — nothing was suppressed
  expect(await shadowCount(page, "edit.undo")).toBe(1);
  expect(await shadowCount(page, "edit.redoUnsupported")).toBe(0);
});

test("Ctrl+Shift+Z shadows the redo tombstone, not undo", async ({ page }) => {
  await page.keyboard.press("Control+Shift+Z");
  expect(await shadowCount(page, "edit.redoUnsupported")).toBe(1);
  expect(await shadowCount(page, "edit.undo")).toBe(0);
});

test("Ctrl+K and / both shadow the palette, and the palette still opens", async ({ page }) => {
  const cmdk = page.locator("#cmdk");

  await page.keyboard.press("Control+k");
  await expect(cmdk).toHaveClass(/\bon\b/);
  expect(await shadowCount(page, "palette.toggle")).toBe(1);

  await page.keyboard.press("Escape");
  await expect(cmdk).not.toHaveClass(/\bon\b/);
  // Closing the palette leaves focus on its own (now hidden) input, and "/" is
  // a real typed character — the guard is supposed to swallow it there. Move
  // focus out first, or this would test the guard instead of the chord.
  const canvas = page.locator("canvas#cv");
  await expect(canvas).toBeVisible();
  await canvas.click({ position: { x: 20, y: 20 } });
  await expect
    .poll(() => page.evaluate(() => !document.activeElement?.closest("#cmdk")))
    .toBe(true);
  await reset(page);

  await page.keyboard.press("Slash");
  await expect(cmdk).toHaveClass(/\bon\b/);
  expect(await shadowCount(page, "palette.slash")).toBe(1);
});

test("the sync chords shadow one binding each, not all three", async ({ page }) => {
  // One legacy listener (legacy/main.ts) splits into three table rows here, so
  // this is the test that proves the split is faithful.
  await page.keyboard.press("Control+Shift+D");
  expect(await shadowCount(page, "remote.fetch")).toBe(1);
  expect(await shadowCount(page, "remote.pull")).toBe(0);
  expect(await shadowCount(page, "remote.push")).toBe(0);
});

test("navigation chords shadow their bindings and still move the view", async ({ page }) => {
  await page.keyboard.press("Control+Shift+U");
  expect(await shadowCount(page, "nav.uncommitted")).toBe(1);
  // Legacy still owns the jump: the working-tree panel is what ⌘⇧U produces.
  await expect(page.locator("#detail .d-subject")).toBeVisible();

  await reset(page);
  await page.keyboard.press("Control+Shift+H");
  expect(await shadowCount(page, "nav.head")).toBe(1);
});

test("⌘\\ shadows focus mode, matched on e.code", async ({ page }) => {
  await page.keyboard.press("Control+Backslash");
  expect(await shadowCount(page, "view.focusMode")).toBe(1);
});

test("a chord in a text field shadows nothing", async ({ page }) => {
  // The guards run before the counter, so a shadow count here would mean the
  // binding would have fired over the user's typing once flipped live.
  await page.keyboard.press("Control+k");
  await expect(page.locator("#cmdk")).toHaveClass(/\bon\b/);
  await reset(page);

  const input = page.locator("#cmdk input").first();
  await input.click();
  await page.keyboard.press("Control+Z");
  expect(await shadowCount(page, "edit.undo")).toBe(0);
});

// The three accelerator-only rows have no JS side. They must never claim a key:
// fire() treats a missing run() as a successful claim, so before the fix ⌘N,
// ⌘⇧N and ⌘` were preventDefault'd and stopImmediatePropagation'd — with the
// PR asserting inertness the whole time.
test("accelerator-only chords are not claimed", async ({ page }) => {
  const prevented = await page.evaluate(() => {
    const out: Record<string, boolean> = {};
    for (const [name, init] of [
      ["Ctrl+N", { key: "n", code: "KeyN", ctrlKey: true }],
      ["Ctrl+Shift+N", { key: "N", code: "KeyN", ctrlKey: true, shiftKey: true }],
      ["Ctrl+`", { key: "`", code: "Backquote", ctrlKey: true }],
    ] as const) {
      const e = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
      document.body.dispatchEvent(e);
      out[name] = e.defaultPrevented;
    }
    return out;
  });
  expect(prevented).toEqual({ "Ctrl+N": false, "Ctrl+Shift+N": false, "Ctrl+`": false });

  // And nothing was recorded as having run.
  const fires = await page.evaluate(
    () => (window as unknown as { __keymap?: { dump(): { fires: Record<string, number> } } }).__keymap?.dump().fires,
  );
  expect(fires).toEqual({});
});

// ⌘K has no text guard in Cmdk.svelte — deliberately, since it is how the
// auto-focused palette closes. The shadow row has to match that or the
// equivalence measurement reads 0 for the close path while the legacy handler
// still toggles.
test("the palette chord shadows from inside the palette's own input", async ({ page }) => {
  await page.keyboard.press("Control+k");
  await expect(page.locator("#cmdk")).toHaveClass(/\bon\b/);
  await page.locator("#cmdk input").first().click();
  await reset(page);

  await page.keyboard.press("Control+k");
  expect(await shadowCount(page, "palette.toggle")).toBe(1);
});

test("an unbound chord shadows nothing at all", async ({ page }) => {
  await page.keyboard.press("Control+Shift+Y");
  const dump = await page.evaluate(
    () =>
      (window as unknown as { __keymap?: { dump(): { shadow: Record<string, number> } } }).__keymap?.dump()
        .shadow,
  );
  expect(dump).toEqual({});
});
