import { test, expect } from "@playwright/test";

// Design mode (plain browser, no Tauri mock — same base `test` as
// scroll-blit/settings-shortcut, NOT e2e/fixtures/tauriMock's, which is the
// whole point: this covers the path where there is no backend at all).
//
// Design mode has no BACKEND, so it has no commit oids: legacy/main.ts's
// loadGraph takes the `else { G = generateGraph(N) }` branch, and the demo
// sidebar's shas (sidebar.svelte.ts's DEMO_LOCALS) are invented 7-char strings
// that match nothing. goToOid therefore can NEVER succeed here — which is why
// jumpToRef falls back to goToRefLabel, matching the synthetic graph's own ref
// labels ("main" is generateGraph's refs[0]). Without that fallback every ref
// click in the browser preview warns instead of demoing the jump.
test("clicking a demo branch in design mode jumps to its labelled row", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");

  // In design mode the setup wizard opens at boot UNCONDITIONALLY (src/main.ts's
  // `else { setupWizardCtrl.openDemo() }` — the dismissed flag only gates the
  // real-app branch), and its scrim swallows every sidebar click. Escape is the
  // wizard's own "Skip", which just reveals the demo graph already underneath.
  const wizard = page.locator("#setupWizardScrim");
  await expect(wizard).toHaveClass(/\bon\b/);
  await page.keyboard.press("Escape");
  await expect(wizard).not.toHaveClass(/\bon\b/);

  // The panel starts on Tama's hero card — `.d-subject` belongs to the commit
  // view only, so its absence/presence is a faithful read of "did a row get
  // selected", the same signal the Tauri-backed jump specs assert on.
  await expect(page.locator("#detail .tama-hero")).toBeVisible();
  await expect(page.locator("#detail .d-subject")).toHaveCount(0);

  await page.locator('#refLocal [data-branch="main"]').click();

  await expect(page.locator("#detail .d-subject")).toHaveCount(1);
  // …and no scolding: before the fallback, this click produced
  // sidebar.jump_not_reachable in Tama's line (#toastLine).
  await expect(page.locator("#toastLine")).not.toContainText("isn't in the loaded graph");

  expect(errors).toEqual([]);
});
