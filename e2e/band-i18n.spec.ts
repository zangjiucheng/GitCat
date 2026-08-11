import { test, expect, type Page } from "@playwright/test";

// The pinned "Uncommitted changes" band is CANVAS text — no node, no accessible
// name — which is how it stayed hardcoded English through every locale the app
// shipped without anyone noticing. It is still reachable: hash the pixels of the
// row it occupies and check they change with the language.
//
// Read from the backing store rather than page.screenshot, because a screenshot
// physically cannot see the badge: the dev perf HUD is absolutely positioned
// over the canvas's top-right corner, exactly where the badge is right-aligned,
// and rewrites its fps readout several times a second. getImageData sees the
// canvas alone.
//
// The assertion is "the hash changes", never "the hash is <value>". A golden
// number here would break on any font, theme or antialiasing change and teach
// everyone to delete it.
//
// The row is hashed in two halves and BOTH are asserted, because the band draws
// two independent strings: the label on the left, the status badge right-
// aligned at W-14. One whole-row hash is satisfied by either one changing, which
// is not the guarantee this test is for.
//
// That split has less headroom than it looks. By the time of the comparison the
// badge reads "1 staged · 2 unstaged" rather than "clean", so its ink starts
// around x375 against a midpoint near x313 — roughly 60px, not the ~250 the
// short badge would suggest. A verbose translation of staged_unstaged is what
// erodes it first (the English string alone spans ~236px); a much narrower
// canvas would do it too. Either way the badge crosses into the left half and
// the two-half split quietly degenerates into the whole-row hash it replaced.
//
// WHAT THIS DOES NOT COVER: workdir.n_conflicted — the demo status is fixed at
// conflicted:0, so that branch needs a real repo in a conflicted state. And
// workdir.clean is drawn once, in English, before the band is selected below —
// never in zh, and never inside an assertion.

// Source of truth is ROW_H_BASE in src/legacy/main.ts; the band is exactly one
// row at zoom 1. Nothing ties these together, so a change there silently makes
// this hash the wrong strip and click at the wrong y.
const BAND_CSS_H = 26;
const POLL_MS = 150;
const POLL_N = 40;

async function bandStats(page: Page) {
  return page.evaluate((cssH) => {
    const c = document.getElementById("cv") as HTMLCanvasElement;
    // Derive DPR from the backing store rather than window.devicePixelRatio, so
    // this still lines up when the renderer drops resolution mid-scroll.
    const dpr = c.width / c.getBoundingClientRect().width;
    const rows = Math.round(cssH * dpr);
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, rows).data;
    const mid = Math.floor(c.width / 2);
    let left = 0, right = 0;
    const leftInk = new Set<string>(), rightInk = new Set<string>();
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        const px = d[i] + d[i + 1] * 7 + d[i + 2] * 13;
        if (x < mid) { left = (left * 31 + px) >>> 0; leftInk.add(d[i] + "," + d[i + 1] + "," + d[i + 2]); }
        else { right = (right * 31 + px) >>> 0; rightInk.add(d[i] + "," + d[i + 1] + "," + d[i + 2]); }
      }
    }
    return { left, right, leftInk: leftInk.size, rightInk: rightInk.size };
  }, BAND_CSS_H);
}

type BandStats = Awaited<ReturnType<typeof bandStats>>;

// Poll until two consecutive reads are identical — "the renderer has stopped
// changing".
async function settledBand(page: Page) {
  const seen: BandStats[] = [await bandStats(page)];
  for (let i = 0; i < POLL_N; i++) {
    await page.waitForTimeout(POLL_MS);
    const cur = await bandStats(page);
    const prev = seen[seen.length - 1];
    seen.push(cur);
    if (cur.left === prev.left && cur.right === prev.right) return cur;
  }
  throw new Error(
    `band never settled in ${(POLL_MS * POLL_N) / 1000}s — last three reads ${JSON.stringify(seen.slice(-3))}`,
  );
}

test("the pinned band's text follows the locale, live", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));

  // Design mode: workdirAvailable() is true without Tauri, so the band draws
  // over the synthetic demo graph — no repo fixture and nothing locale-coupled
  // to click through.
  await page.goto("/");
  await expect(page.locator("#cv")).toBeVisible();
  // Design mode opens the setup wizard unconditionally and its scrim covers the
  // canvas, so the band click below would land on the scrim instead. Esc is the
  // app's own way out — same idiom as ref-folder-tree.spec.ts.
  await page.keyboard.press("Escape");
  // toBeHidden, not "class no longer has .on" — .scrim delays its visibility
  // flip (`transition: … visibility 0s linear .16s`), so for that window the
  // class is already off while the element still covers the canvas and eats the
  // click. Losing the click is silent: the band never gets selected and the
  // badge quietly stays on workdir.clean.
  await expect(page.locator("#setupWizardScrim")).toBeHidden();
  // Let the canvas finish painting before taking coordinates off it.
  await settledBand(page);

  // Selecting the band loads the demo working-tree status, which moves the
  // badge off workdir.clean and onto staged_unstaged — the key that carries
  // placeholders, where a dropped {staged} would still read like a sentence.
  // Any x inside the row selects it; 120 is just clear of the dot.
  const box = (await page.locator("#cv").boundingBox())!;
  await page.mouse.click(box.x + 120, box.y + BAND_CSS_H / 2);
  // Park the pointer off the canvas and leave it there. The band's hover tint
  // is a fillRect across the WHOLE row, so a pointer that enters or leaves the
  // row between the two captures changes both halves for a reason that has
  // nothing to do with language — the attribution this test exists to make.
  // selectOption and Escape below do not move it; keep it that way.
  await page.mouse.move(box.x - 5, box.y - 5);
  // Wait for the status to actually arrive before the first capture, because
  // the badge repaint is asynchronous and the settle poll cannot tell "not
  // repainted yet" from "finished": capturing EN with the old `clean` badge and
  // ZH with the new one makes both halves differ whether or not anything is
  // translated. Found exactly that way — without this line, reverting
  // staged_unstaged to hardcoded English still passed.
  //
  // It is also the only proof that the click landed on the band at all. If it
  // missed, the badge stays on workdir.clean — which still translates — so both
  // halves still differ and this test goes green having covered none of the
  // above. Replacing this with a sleep turns a loud failure into a silent one.
  await expect(page.locator("#detail")).toContainText(/\d+ staged/);

  const en = await settledBand(page);
  // Narrow but real: catches a capture taken before the canvas' first paint,
  // where an all-background row would make both later comparisons meaningless.
  // It is NOT a missing-text detector: the left half holds the band's accent dot
  // whenever the band draws at all, and the right half holds the scrollbar
  // whenever there is one (scrollbarGeom returns null on a short graph) — so a
  // half can clear this with no text in it.
  expect(en.leftInk, "canvas looks unpainted — captured before the first frame?").toBeGreaterThan(3);
  expect(en.rightInk, "canvas looks unpainted — captured before the first frame?").toBeGreaterThan(3);

  // Switch language the way a user does, which also exercises legacy/main.ts's
  // i18nEvents "change" handler — its own comment promises the canvas repaints
  // on a switch. The locale picker has no id or test id, and Settings renders a
  // dozen selects, so it is identified by the option it contains.
  await page.keyboard.press("Control+,");
  await expect(page.locator(".modal.settings")).toBeVisible();
  await page.locator('.modal.settings select:has(option[value="zh"])').selectOption("zh");
  await page.keyboard.press("Escape");

  const zh = await settledBand(page);
  expect(zh.left, "the band's LABEL is pixel-identical in en and zh — it is not going through t()").not.toBe(en.left);
  expect(zh.right, "the band's BADGE is pixel-identical in en and zh — it is not going through t()").not.toBe(en.right);

  expect(errors).toEqual([]);
});
