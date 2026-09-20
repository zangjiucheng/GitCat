// The Author/Committer pair on a narrow detail panel.
//
// The block is a two-column grid inside a container with `overflow:hidden`.
// A grid item defaults to `min-width:auto`, which means it cannot shrink below
// its own min-content width — and the min-content width of an email address is
// the whole address, because there is nothing in it a line may break at. So
// each cell held itself at the width of the longest address it contained, two
// of them sat inside a container far narrower than their sum, and the overflow
// rule turned the excess into "gone" rather than "scrollable".
//
// Measured before the fix, with a 73-character address:
//
//   --detail-w  Committer visible
//   344 (default)  48%
//   264 (the small-screen media value)  11%
//   230 and below  0%
//
// So this was never only a small-screen problem: half the Committer column was
// already missing at the default width. These tests assert the property that
// was violated — every cell fully inside the box that clips it — rather than a
// pixel layout, which would break on any future restyle without meaning
// anything had regressed.
import { test, expect } from "./fixtures/tauriMock";
import type { Page } from "@playwright/test";

const LONG_NAME = "Maximiliana Featherstonehaugh-Wetherby";
const LONG_EMAIL = "maximiliana.featherstonehaugh-wetherby@engineering.example-corporation.test";

/** Widths worth checking: the default, both media-query values, and narrower
 *  still, since the panel has its own splitter and a user can drag past any of
 *  them at any window size. */
const WIDTHS = [344, 300, 264, 230, 200, 150];

/** The one address long enough to reproduce this, committed and selected. */
async function openCommitByAuthor(page: Page, repo: { git(...a: string[]): string; writeFile(p: string, c: string): void; commit(m: string): string }) {
  repo.git("config", "user.name", LONG_NAME);
  repo.git("config", "user.email", LONG_EMAIL);
  repo.writeFile("README.md", "# fixture\n");
  repo.commit("Initial commit");

  await page.goto("/");
  await page.locator(".repo-pick").click();
  await page.locator(".db-add").click();
  await expect(page.locator(".hero-stat .n")).toHaveText("1");
  await page.locator("canvas#cv").click({ position: { x: 30, y: 30 } });
  await expect(page.locator(".who-split")).toBeVisible();
}

test("neither Author nor Committer is clipped away, at any panel width", async ({ page, repo }) => {
  await openCommitByAuthor(page, repo);

  for (const w of WIDTHS) {
    await page.evaluate((v) => document.documentElement.style.setProperty("--detail-w", v + "px"), w);
    const visible = await page.evaluate(() => {
      const split = document.querySelector(".who-split") as HTMLElement;
      const box = split.getBoundingClientRect();
      return [...document.querySelectorAll(".who")].map((el) => {
        const b = el.getBoundingClientRect();
        const shown = Math.max(0, Math.min(b.right, box.right) - Math.max(b.left, box.left));
        return Math.round((shown / b.width) * 100);
      });
    });
    expect(visible, `at --detail-w:${w}px both cells must be fully inside the clipping box`).toEqual([100, 100]);
  }
});

test("the pair stacks once the panel is too narrow for two readable columns", async ({ page, repo }) => {
  await openCommitByAuthor(page, repo);

  // The query is on the CONTAINER, and a container query resolves against the
  // CONTENT box — the section carries 14px of padding each side, so the 280px
  // threshold trips at a panel around 308px. Asserted through the resulting
  // column count rather than the number, so the threshold can move without
  // this test becoming a second place to edit.
  const columns = async () =>
    (await page.evaluate(() => getComputedStyle(document.querySelector(".who-split") as HTMLElement).gridTemplateColumns))
      .split(" ").length;

  await page.evaluate(() => document.documentElement.style.setProperty("--detail-w", "344px"));
  expect(await columns(), "the default width is wide enough to compare the two side by side").toBe(2);

  for (const w of [300, 264, 200, 150]) {
    await page.evaluate((v) => document.documentElement.style.setProperty("--detail-w", v + "px"), w);
    expect(await columns(), `at --detail-w:${w}px the pair should be stacked`).toBe(1);
  }
});

test("a long address wraps inside its cell instead of forcing the cell wider", async ({ page, repo }) => {
  await openCommitByAuthor(page, repo);
  await page.evaluate(() => document.documentElement.style.setProperty("--detail-w", "344px"));

  const m = await page.evaluate(() => {
    const cell = document.querySelector(".who") as HTMLElement;
    const em = cell.querySelector(".em") as HTMLElement;
    return {
      // The cell is now free to be narrower than the address it holds...
      cellW: Math.round(cell.getBoundingClientRect().width),
      // ...because the address breaks. Nothing overflows its own box, so
      // nothing is silently cut by the container's overflow:hidden.
      emOverflow: em.scrollWidth - em.clientWidth,
      emLines: Math.round(em.getBoundingClientRect().height / 14),
    };
  });

  expect(m.emOverflow, "a wrapped address must not overflow its own box").toBe(0);
  expect(m.cellW, "the cell must be free to be narrower than the address").toBeLessThan(200);
  expect(m.emLines, "the address should wrap rather than sit on one clipped line").toBeGreaterThan(1);
});
