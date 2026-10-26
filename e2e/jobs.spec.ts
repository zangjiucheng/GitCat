// The running-jobs chip (#133), end to end against the mocked IPC: job events
// put a chip in the topbar, Mod+Shift+J opens its popover inside a modal
// keyboard scope, Cancel turns into job_cancel, a stall tints the chip, and
// the chip leaves when the job does. The events are emitted by the spec
// itself through __e2eEmit (fixtures/tauriMock.ts), standing in for jobs.rs.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test as base } from "@playwright/test";
import { test, expect } from "./fixtures/tauriMock";

const REPO = "/work/gitcat";

function emit(page: Page, event: string, payload: unknown) {
  return page.evaluate(
    ([e, p]) => (window as unknown as { __e2eEmit: (e: string, p: unknown) => void }).__e2eEmit(e as string, p),
    [event, payload] as const,
  );
}

function jobStarted(id: number, partial: Record<string, unknown> = {}) {
  return {
    id,
    kind: "fetch",
    repo: REPO,
    label: "origin",
    startedAtMs: Date.now(),
    background: false,
    stalled: false,
    cancelling: false,
    ...partial,
  };
}

const chip = (page: Page) => page.locator(".jobs-chip");
const pop = (page: Page) => page.locator(".jobs-pop");

const topScope = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __keymap?: { dump(): { stack: { id: string }[] } } }).__keymap?.dump().stack.at(-1)?.id,
  );

async function boot(page: Page) {
  await page.goto("/");
  await expect(page.locator("#fetchBtn")).toBeVisible();
  await expect(chip(page)).toHaveCount(0);
}

// jobsCtrl.init() subscribes asynchronously at boot, so the first emit could
// land before it has. Re-emitting is harmless (the store dedupes by id), so
// keep emitting until the chip shows.
async function startJob(page: Page, id: number) {
  await expect
    .poll(async () => {
      await emit(page, "job-started", jobStarted(id));
      return chip(page).count();
    })
    .toBe(1);
}

const MOD = process.platform === "darwin" ? "Meta" : "Control";

test("a foreground job shows the chip; the popover cancels it and Escape closes it", async ({ page, calls }) => {
  await boot(page);
  await startJob(page, 21);
  await expect(chip(page)).toHaveText("1");
  await expect(chip(page)).toHaveAccessibleName("1 running");

  await page.keyboard.press(`${MOD}+Shift+KeyJ`);
  await expect(pop(page)).toBeVisible();
  await expect(pop(page)).toContainText("Fetch · origin — gitcat");
  await expect.poll(() => topScope(page)).toBe("modal");

  await page.keyboard.press("Escape");
  await expect(pop(page)).toHaveCount(0);
  expect(await topScope(page)).toBe("global");

  // The chord is a toggle: from inside the popover's modal scope it closes it.
  await page.keyboard.press(`${MOD}+Shift+KeyJ`);
  await expect(pop(page)).toBeVisible();
  await expect.poll(() => topScope(page)).toBe("modal");
  await page.keyboard.press(`${MOD}+Shift+KeyJ`);
  await expect(pop(page)).toHaveCount(0);
  expect(await topScope(page)).toBe("global");

  await chip(page).click();
  await pop(page).getByRole("button", { name: "Cancel Fetch · origin — gitcat" }).click();
  await expect.poll(() => calls.find((c) => c.cmd === "job_cancel")?.args).toEqual({ id: 21 });
  await expect(pop(page).locator(".jobs-row-cancel")).toBeDisabled();

  // The backend finishes it: the chip goes, and the popover with it.
  await emit(page, "job-finished", { id: 21, outcome: "cancelled" });
  await expect(chip(page)).toHaveCount(0);
  expect(await topScope(page)).toBe("global");
});

test("a stall tints the chip and job-finished removes it", async ({ page }) => {
  await boot(page);
  await startJob(page, 22);
  await expect(chip(page)).toBeVisible();
  await expect(chip(page)).not.toHaveClass(/\bstalled\b/);

  await emit(page, "job-progress", { id: 22, stalled: true, idleSecs: 60 });
  await expect(chip(page)).toHaveClass(/\bstalled\b/);
  await chip(page).click();
  await expect(pop(page).locator(".jobs-row-stalled")).toContainText("60s");

  await emit(page, "job-finished", { id: 22, outcome: "ok" });
  await expect(chip(page)).toHaveCount(0);
});

test("Mod+Shift+J does nothing while idle", async ({ page }) => {
  await boot(page);
  await page.keyboard.press(`${MOD}+Shift+KeyJ`);
  await expect(pop(page)).toHaveCount(0);
  expect(await topScope(page)).toBe("global");
});

// Same measurement as topbar-min-width.spec.ts, with the chip showing: the
// chip is the one thing PR4 adds to a bar with ~40px of slack.
test("the topbar still fits at the minimum window width with the chip showing", async ({ page }) => {
  const src = readFileSync(new URL("../src-tauri/src/windows.rs", import.meta.url), "utf8");
  const minW = Math.round(parseFloat(/WINDOW_MIN_W:\s*f64\s*=\s*([\d.]+)/.exec(src)![1]));
  await page.setViewportSize({ width: minW, height: 800 });
  await boot(page);
  await startJob(page, 23);
  await expect(chip(page)).toBeVisible();

  const overflow = await page.evaluate(() => {
    const bar = document.querySelector(".topbar") as HTMLElement;
    return bar.scrollWidth - bar.clientWidth;
  });
  expect(overflow, `the topbar overflows by ${overflow}px at ${minW}px with the jobs chip showing`).toBe(0);
});

// Design mode (no backend): the chip mirrors the SyncProgress demo run, so
// Fetch → Hide shows it, and its Cancel ends the demo as cancelled.
base("design mode: the chip mirrors the demo fetch and cancels it", async ({ page }) => {
  await page.goto("/");
  const wizard = page.locator("#setupWizardScrim");
  await expect(wizard).toHaveClass(/\bon\b/);
  await page.keyboard.press("Escape");
  await expect(wizard).not.toHaveClass(/\bon\b/);

  await page.locator("#fetchBtn").click();
  const modal = page.locator(".scrim:has(.modal.syncprogress)");
  await expect(modal).toHaveClass(/\bon\b/);
  await expect(chip(page)).toHaveCount(1);
  await modal.getByRole("button", { name: "Hide" }).click();
  await expect(modal).not.toHaveClass(/\bon\b/);

  await chip(page).click();
  await pop(page).locator(".jobs-row-cancel").click();
  await expect(chip(page)).toHaveCount(0);
});
