// The "author ≠ committer" highlight — the cue that a commit was cherry-picked,
// rebased or applied from a patch.
//
// `.who-split` is a rounded container with overflow:hidden, and the highlight is
// an INSET box-shadow on its children. An inset shadow follows its own
// element's border-box, so with square children the ring was square while the
// container was round: clipping then removed exactly the four outer corners,
// and the highlight read as a box with its corners missing.
//
// Asserted as the geometric cause rather than as pixels: there is no DOM
// screenshot baseline in this suite, and "the child's outer corners match the
// container's" is both the fix and the thing that would silently rot — change
// --r-panel on the container alone and the ring is clipped again.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

const ROW_H = 26; // design-mode row height, same constant band-i18n.spec.ts uses

async function selectRebasedCommit(page: Page) {
  await page.goto("/");
  await expect(page.locator("#cv")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#setupWizardScrim")).toBeHidden();
  const box = (await page.locator("#cv").boundingBox())!;
  // Row 7: design mode marks (r % 7 === 0 && r > 0) as rebased, which is what
  // sets `differ` — see detail.svelte.ts's demo commitMeta.
  await page.mouse.click(box.x + 120, box.y + ROW_H + 7 * ROW_H + ROW_H / 2);
  await expect(page.locator("#detail .who.differ").first()).toBeVisible();
}

test("the differ ring follows the container's rounded corners", async ({ page }) => {
  await selectRebasedCommit(page);

  const geom = await page.evaluate(() => {
    const sp = document.querySelector("#detail .who-split") as HTMLElement;
    const kids = [...sp.querySelectorAll(".who")] as HTMLElement[];
    const c = getComputedStyle(sp);
    const first = getComputedStyle(kids[0]);
    const last = getComputedStyle(kids[kids.length - 1]);
    return {
      container: { tl: c.borderTopLeftRadius, tr: c.borderTopRightRadius, overflow: c.overflow },
      firstTL: first.borderTopLeftRadius,
      firstBL: first.borderBottomLeftRadius,
      lastTR: last.borderTopRightRadius,
      lastBR: last.borderBottomRightRadius,
      // The inner edges stay square — they meet at the 1px divider.
      firstTR: first.borderTopRightRadius,
      lastTL: last.borderTopLeftRadius,
      differs: kids.filter((k) => k.classList.contains("differ")).length,
    };
  });

  // The precondition that makes this matter at all.
  expect(geom.container.overflow).toBe("hidden");
  expect(geom.container.tl).not.toBe("0px");
  expect(geom.differs, "both halves carry the highlight").toBe(2);

  // Outer corners match the container, so the inset ring is drawn along the
  // same arc the clip cuts on.
  expect(geom.firstTL, "the left half's outer corners are square").toBe(geom.container.tl);
  expect(geom.firstBL).toBe(geom.container.tl);
  expect(geom.lastTR, "the right half's outer corners are square").toBe(geom.container.tr);
  expect(geom.lastBR).toBe(geom.container.tr);

  // …and the inner corners are NOT rounded, or the 1px divider would show gaps.
  expect(geom.firstTR).toBe("0px");
  expect(geom.lastTL).toBe("0px");
});

test("the highlight is an inset ring on both halves", async ({ page }) => {
  // Guards the other half of the pairing: rounding the children is only
  // meaningful while the highlight is an inset shadow. If it ever became an
  // outline or a border, the corner rule above would need revisiting.
  await selectRebasedCommit(page);
  const shadows = await page.evaluate(() =>
    [...document.querySelectorAll("#detail .who.differ")].map((k) => getComputedStyle(k).boxShadow),
  );
  expect(shadows.length).toBe(2);
  for (const s of shadows) expect(s, `not an inset ring: ${s}`).toContain("inset");
});

test("a commit whose author IS its committer gets no ring", async ({ page }) => {
  // The cue has to mean something — if every commit were ringed it would say
  // nothing about cherry-picks and rebases.
  await page.goto("/");
  await expect(page.locator("#cv")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#setupWizardScrim")).toBeHidden();
  const box = (await page.locator("#cv").boundingBox())!;
  await page.mouse.click(box.x + 120, box.y + ROW_H + 3 * ROW_H + ROW_H / 2); // row 3: not rebased
  await expect(page.locator("#detail .who").first()).toBeVisible();
  await expect(page.locator("#detail .who.differ")).toHaveCount(0);
});
