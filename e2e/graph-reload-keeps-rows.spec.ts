// A full graph reload must not blank the canvas while it waits for the stream.
//
// reloadGraph() (Undo, reset HEAD, pull, Refresh, …) used to empty BACKEND/G
// the moment it started. On CPython the backend takes ~2s to its first batch,
// so for those 2s the graph showed nothing but the pinned "Uncommitted
// changes" header. The old rows now stay on screen (dimmed, pointer-inert)
// until that first batch, and are swapped for the new ones in the same task.
//
// The mock's __e2eHoldGraph parks load_graph's batch to open that window on
// purpose; the Refresh button drives the same forceFull reloadGraph path.
import { test, expect } from "./fixtures/tauriMock";
import type { Page } from "@playwright/test";

/** Share of sampled pixels in the top half of #cv that differ from the empty
 *  background — rows (dots, edges, text) push it up; a header-only canvas
 *  leaves just one row's worth. */
async function paintedShare(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.getElementById("cv") as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    const at = (x: number, y: number) => (y * c.width + x) * 4;
    const b = at(Math.floor(c.width / 2), c.height - 2); // well below a 4-row graph
    let painted = 0, total = 0;
    for (let y = 0; y < c.height / 2; y += 2) {
      for (let x = 0; x < c.width; x += 3) {
        const i = at(x, y);
        total++;
        if (Math.abs(d[i] - d[b]) + Math.abs(d[i + 1] - d[b + 1]) + Math.abs(d[i + 2] - d[b + 2]) > 24) painted++;
      }
    }
    return painted / total;
  });
}

test("Refresh keeps the old rows on screen until the new stream's first batch", async ({ page, repo }) => {
  for (const name of ["one", "two", "three"]) {
    repo.writeFile(`${name}.txt`, `${name}\n`);
    repo.commit(`Add ${name}`);
  }

  await page.goto("/");
  await page.locator(".repo-pick").click();
  await page.locator(".db-add").click();
  await expect(page.locator(".hero-stat .n")).toHaveText("3");
  await page.waitForTimeout(300); // a settled frame of the loaded graph
  const before = await paintedShare(page);

  // New history the reload has to pick up, then hold its batch.
  repo.writeFile("four.txt", "four\n");
  repo.commit("Add four");
  await page.evaluate(() => { (window as any).__e2eHoldGraph = true; });
  await page.locator("#refreshBtn").click();

  const cv = page.locator("#cv");
  await expect(cv, "the old rows should be marked stale while the reload waits").toHaveClass(/graph-stale/);
  await page.waitForTimeout(300); // several rAF frames: anything that would blank it has had its chance
  // The hero count is reset by the swap (loadGraph(0)); still 3 means the old
  // graph is the one on screen, not an emptied one.
  await expect(page.locator(".hero-stat .n")).toHaveText("3");
  expect(await cv.evaluate((el) => getComputedStyle(el).pointerEvents), "stale rows must not take clicks").toBe("none");
  const held = await paintedShare(page);
  expect(held, `canvas went blank mid-reload (painted ${held.toFixed(3)} vs ${before.toFixed(3)} before)`)
    .toBeGreaterThan(before * 0.9);

  await page.evaluate(() => (window as any).__e2eReleaseGraph());
  await expect(page.locator(".hero-stat .n")).toHaveText("4");
  await expect(cv).not.toHaveClass(/graph-stale/);
  expect(await cv.evaluate((el) => getComputedStyle(el).pointerEvents)).not.toBe("none");
  await page.waitForTimeout(300);
  expect(await paintedShare(page), "the new rows should be painted").toBeGreaterThan(before * 0.9);
});
