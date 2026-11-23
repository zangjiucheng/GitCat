import { test, expect, type Page } from "@playwright/test";

// LLM Resolver in design mode: there's no backend and no model, so this checks
// the wiring — the Suggest button appears only once AI is turned on in
// Settings → AI, fills the hunk's textarea with a note, and Undo puts the
// previous text back. The request itself is covered by tests/ai_resolve.rs.

async function skipWizard(page: Page) {
  const wizard = page.locator("#setupWizardScrim");
  await expect(wizard).toHaveClass(/\bon\b/);
  await page.keyboard.press("Escape");
  await expect(wizard).not.toHaveClass(/\bon\b/);
}

async function openDemoResolver(page: Page) {
  await page.evaluate(async () => {
    const m = await import(/* @vite-ignore */ "/src/islands/resolver/resolver.svelte.ts");
    m.resolver.openDemo("abc1234", "merge");
  });
  await expect(page.locator(".cf-edit-textarea").first()).toBeVisible();
}

test("Suggest appears only with AI on, fills the hunk, and Undo restores it", async ({ page }) => {
  await page.goto("/");
  await skipWizard(page);

  // Off by default: no Suggest button.
  await openDemoResolver(page);
  await expect(page.locator(".cf-ai-suggest")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Turn it on in Settings → AI.
  await page.keyboard.press("Control+,");
  await page.getByRole("tab", { name: "AI" }).click();
  await expect(page.locator(".ai-privacy")).toBeVisible();
  await page.getByLabel("Suggest resolutions for conflicts").check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".modal.settings").getByText("Saved.", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await openDemoResolver(page);
  const area = page.locator(".cf-edit-textarea").first();
  const before = await area.inputValue();
  await page.locator(".cf-ai-suggest").first().click();
  await expect(page.locator(".cf-ai-note")).toBeVisible();
  const after = await area.inputValue();
  expect(after).not.toBe(before);

  await page.getByRole("button", { name: "Undo suggestion" }).click();
  await expect(page.locator(".cf-ai-note")).toHaveCount(0);
  expect(await area.inputValue()).toBe(before);
});
