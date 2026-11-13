// The graph's ref chips: right-clicking a remote or a tag chip opens that ref's
// own menu (it used to be only "Switch to …?" for a remote and the commit menu
// for a tag), and hovering a chip lights up that branch's history. Against a
// real fixture repo through the mock backend (fixtures/tauriMock.ts).
//
// Chips are painted on the canvas, so a test finds one the way a user does:
// by moving along the row until the label tooltip shows the ref's name.
import { test, expect } from "./fixtures/tauriMock";
import type { Page } from "@playwright/test";
import type { TempRepo } from "./fixtures/tempRepo";

/** main: base (tagged v1) → main work; origin/feature: base → feature work, with no local branch. */
function fixture(repo: TempRepo) {
  repo.writeFile("README.md", "# fixture\n");
  repo.commit("base");
  repo.git("tag", "v1");
  repo.branch("feature");
  repo.checkout("feature");
  repo.writeFile("feature.txt", "f\n");
  repo.commit("feature work");
  repo.git("update-ref", "refs/remotes/origin/feature", "HEAD");
  repo.checkout("main");
  repo.git("branch", "-D", "feature");
  repo.writeFile("main.txt", "m\n");
  repo.commit("main work");
}

async function open(page: Page) {
  await page.goto("/");
  await page.locator(".repo-pick").click();
  await page.locator(".db-add").click();
  await expect(page.locator("#cntLocal")).toHaveText("1");
  await expect(page.locator("#cv")).toBeVisible();
}

/** Where on screen the chip naming `ref` is: scans each row left to right. */
async function chipAt(page: Page, ref: string) {
  const box = (await page.locator("#cv").boundingBox())!;
  const tip = page.locator("#graphLabelTip");
  // A row is 26px, under a pinned one-row "Uncommitted changes" band.
  for (let row = 0; row < 3; row++) {
    const y = box.y + 26 + row * 26 + 13;
    for (let x = box.x + 20; x < box.x + box.width - 220; x += 6) {
      await page.mouse.move(x, y);
      if ((await tip.isVisible()) && (await tip.locator(".rt-name").allInnerTexts()).includes(ref)) return { x, y, row };
    }
  }
  throw new Error(`no chip for ${ref}`);
}

const menu = (page: Page) => page.locator(".ref-pop");

test("right-clicking a remote branch's chip opens its menu", async ({ page, repo, calls }) => {
  fixture(repo);
  await open(page);
  const { x, y } = await chipAt(page, "origin/feature");
  await page.mouse.click(x, y, { button: "right" });

  await expect(menu(page).locator("button")).toHaveText([
    "Checkout",
    "Merge into current…",
    "Rebase current branch onto here",
    "Interactive rebase onto here…",
    "Compare with current branch",
    "Copy name",
  ]);
  await menu(page).getByRole("button", { name: "Compare with current branch" }).click();
  await expect(page.locator(".ref-pop.rs-pop")).toBeVisible();
  expect(calls.find((c) => c.cmd === "commit_range_summary")?.args).toMatchObject({ a: "HEAD", b: "refs/remotes/origin/feature" });
});

test("right-clicking a tag's chip opens the tag menu, not the commit menu", async ({ page, repo }) => {
  fixture(repo);
  await open(page);
  const { x, y } = await chipAt(page, "v1");
  await page.mouse.click(x, y, { button: "right" });

  await expect(menu(page).locator("button")).toHaveText(["Push to origin", "Compare with current branch", "Copy name", "Delete…"]);
});

test("hovering a chip dims the rows that aren't in that branch's history", async ({ page, repo }) => {
  fixture(repo);
  await open(page);
  // Row `row`'s centre line across the whole canvas, RGB: it crosses the
  // commit dot, the lane band and the subject text — a wash in the background
  // colour leaves plain background unchanged, so one background pixel can't show it.
  const line = (row: number) =>
    page.evaluate((row) => {
      const cv = document.getElementById("cv") as HTMLCanvasElement;
      const r = cv.getBoundingClientRect(), k = cv.width / r.width;
      const d = cv.getContext("2d")!.getImageData(0, Math.round((26 + row * 26 + 13) * k), cv.width, 1).data;
      return Array.from(d).filter((_, i) => i % 4 !== 3);
    }, row);
  const moved = async (row: number, before: number[]) => (await line(row)).reduce((n, v, i) => n + Math.abs(v - before[i]), 0);
  const away = { x: 5, y: 26 * 8 }; // below the three rows, on no label

  const { row } = await chipAt(page, "origin/feature");
  const other = row === 0 ? 1 : 0;
  const box = (await page.locator("#cv").boundingBox())!;
  await page.mouse.move(box.x + away.x, box.y + away.y);
  await page.waitForTimeout(400);
  const before = await line(other);

  // The fixture graph is drawn with no edges (one lane), so the traced history
  // is just the hovered commit: every other row dims.
  await chipAt(page, "origin/feature");
  await expect.poll(() => moved(other, before)).toBeGreaterThan(1000);
  const dimmed = await moved(other, before);

  await page.mouse.move(box.x + away.x, box.y + away.y);
  await expect.poll(() => moved(other, before)).toBeLessThan(dimmed / 20);
});
