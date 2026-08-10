// Sidebar ref folder tree — the VIEW half of the "/"-segmented grouping.
//
// `buildRefRows` and the collapse-state controller are covered exhaustively by
// sidebar.svelte.test.ts. What only a browser can check is the wiring: that the
// rows the tree emits actually render in that order, that the collapse keys the
// markup passes are the ones the controller expects, and that the summary's
// collapse-all control appears when it should.
//
// Runs in plain DESIGN MODE (no tauriMock fixture, so IN_TAURI is false and the
// sidebar seeds its own DEMO_* refs). Nothing here needs a backend: grouping,
// ordering and collapse state are all pure frontend, and the demo refs are
// shaped to exercise them (see DEMO_LOCALS/REMOTES/TAGS in sidebar.svelte.ts).
//
// This is the ONLY spec that knows refs are grouped — open-repo.spec.ts asserts
// the local-branch count and `main`, neither of which depends on the shape — so
// changing the tree can only ever break tests that are about the tree.
import { test, expect, type Page } from "@playwright/test";

// NOTE for anyone adding a spec here: a sidebar section is a <details> with no
// `open` attribute, so its rows render into the DOM but are HIDDEN until the
// group is expanded. Expand it before asserting visibility or clicking a row.
/** Ordered "kind:label" of every ref row in a section, as actually rendered. */
async function rows(page: Page, sel: string): Promise<string[]> {
  return page.$$eval(`${sel} > div`, (els) =>
    els
      .map((el) => {
        const name = el.querySelector(".rname")?.textContent?.trim() ?? "";
        if (el.classList.contains("ref-folder")) return `${el.classList.contains("collapsed") ? "closed" : "open"}:${name}`;
        // Skip the trailing "＋ New branch…/New tag…" row — it's a .ref-item too
        // but it isn't a ref, and it carries no data-branch/data-tag.
        if (el.classList.contains("ref-item") && !el.querySelector(".nb")) return `leaf:${name}`;
        return "";
      })
      .filter(Boolean),
  );
}

/** A folder row in `sel` whose LABEL is exactly `label` (the row's own text also carries its count badge). */
function folder(page: Page, sel: string, label: string) {
  return page.locator(`${sel} .ref-folder`).filter({ has: page.locator(".rname", { hasText: new RegExp(`^${label}$`) }) });
}

async function openSidebar(page: Page): Promise<void> {
  await page.goto("/");
  // Design mode opens the setup wizard unconditionally (openDemo ignores the
  // dismissal flag on purpose), and its scrim swallows every sidebar click. Esc
  // is the app's own way out — it reveals what's already underneath.
  await page.keyboard.press("Escape");
  await expect(page.locator("#setupWizardScrim")).not.toHaveClass(/\bon\b/);
  // Open-idempotent on purpose: which sections default open is the app's
  // business (Local does, since 8a73662), and a blind summary click on an
  // already-open <details> COLLAPSES it. Only click the ones actually shut.
  for (const section of ["Local", "Remote", "Tags"]) {
    const summary = page.locator(".ref-group > summary", { hasText: section }).first();
    const isOpen = await summary.evaluate((el) => (el.parentElement as HTMLDetailsElement).open);
    if (!isOpen) await summary.click();
  }
  await expect(page.locator("#refLocal .ref-folder").first()).toBeVisible();
}

test("groups local branches into folders, every folder before every plain branch", async ({ page }) => {
  await openSidebar(page);
  // feat/ fix/ release/ are folders; main is a loose branch and therefore last.
  // All closed: nothing has been clicked, and the demo HEAD (`main`) is not
  // inside a folder, so the current-branch exception doesn't apply here.
  expect(await rows(page, "#refLocal")).toEqual(["closed:feat", "closed:fix", "closed:release", "leaf:main"]);
});

test("a leaf shows only its own last segment but still addresses the full ref", async ({ page }) => {
  await openSidebar(page);
  await folder(page, "#refLocal", "fix").click();
  const leaf = page.locator('#refLocal .ref-item[data-branch="fix/lane-cull"]');
  await expect(leaf).toBeVisible();
  await expect(leaf.locator(".rname")).toHaveText("lane-cull");
  // The full name stays reachable for the hover tip.
  await expect(leaf.locator(".rname")).toHaveAttribute("data-fullname", "fix/lane-cull");
});

test("orders release lines numerically, not lexicographically", async ({ page }) => {
  await openSidebar(page);
  await folder(page, "#refLocal", "release").click();
  // Lexicographic ordering would put 1.10 before 1.9.
  expect(await rows(page, "#refLocal")).toEqual([
    "closed:feat",
    "closed:fix",
    "open:release",
    "leaf:0.3",
    "leaf:1.9",
    "leaf:1.10",
    "leaf:main",
  ]);
});

test("each remote is its own outermost folder, with its branches nested inside", async ({ page }) => {
  await openSidebar(page);
  // A remote's own node starts OPEN — the section is already behind one click,
  // so shutting the remotes too would mean two before a branch appears. The
  // folders INSIDE each remote follow the normal closed default.
  expect(await rows(page, "#refRemote")).toEqual([
    "open:origin",
    "closed:feat",
    "closed:topic",
    "leaf:main",
    "open:upstream",
    "closed:feat",
    "leaf:dev",
    "leaf:main",
  ]);

  // Collapsing a remote hides everything it contains, in one click.
  await folder(page, "#refRemote", "origin").click();
  expect(await rows(page, "#refRemote")).toEqual([
    "closed:origin",
    "open:upstream",
    "closed:feat",
    "leaf:dev",
    "leaf:main",
  ]);
  await folder(page, "#refRemote", "origin").click();

  // A remote's children must sit to the RIGHT of the remote itself — indentation
  // is the only thing on screen that says they belong to it.
  const originIndent = await folder(page, "#refRemote", "origin").evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
  const featIndent = await folder(page, "#refRemote", "feat").first().evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
  expect(featIndent).toBeGreaterThan(originIndent);
});

test("two remotes' same-named folders collapse independently", async ({ page }) => {
  await openSidebar(page);
  const feats = page.locator("#refRemote .ref-folder").filter({ has: page.locator(".rname", { hasText: /^feat$/ }) });
  // One `feat/` under origin, one under upstream — same label, different folders.
  await expect(feats).toHaveCount(2);
  await feats.first().click();
  await expect(feats.nth(0)).not.toHaveClass(/\bcollapsed\b/);
  await expect(feats.nth(1)).toHaveClass(/\bcollapsed\b/);
});

test("groups tags by the same tree", async ({ page }) => {
  await openSidebar(page);
  expect(await rows(page, "#refTags")).toEqual([
    "closed:v1.0",
    "leaf:nightly-2026-07-05",
    "leaf:v0.2.0",
    "leaf:v0.3.0",
  ]);
  await folder(page, "#refTags", "v1.0").click();
  expect(await rows(page, "#refTags")).toEqual([
    "open:v1.0",
    "leaf:rc1",
    "leaf:rc2",
    "leaf:nightly-2026-07-05",
    "leaf:v0.2.0",
    "leaf:v0.3.0",
  ]);
});

test("a typed filter force-expands a collapsed folder without clearing its state", async ({ page }) => {
  await openSidebar(page);
  await expect(folder(page, "#refLocal", "release")).toHaveClass(/\bcollapsed\b/);

  await page.locator("#refFilter").fill("release/");
  await expect(page.locator('#refLocal .ref-item[data-branch="release/1.9"]')).toBeVisible();

  // Clearing the box must put it back the way it was, not leave it expanded.
  await page.locator("#refFilter").fill("");
  await expect(folder(page, "#refLocal", "release")).toHaveClass(/\bcollapsed\b/);
});

test("the collapse-all control is offered only when it would mean something", async ({ page }) => {
  await openSidebar(page);
  const foldButtons = page.locator(".ref-group > summary .fold-btn");
  await expect(foldButtons).toHaveCount(3); // Local, Remote, Tags all have folders

  // While filtering, every folder renders force-expanded, so a collapse-all
  // button would both mislabel itself and overwrite collapse state on click.
  await page.locator("#refFilter").fill("release/");
  await expect(foldButtons).toHaveCount(0);

  await page.locator("#refFilter").fill("");
  await expect(foldButtons).toHaveCount(3);
});

test("collapse-all folds every folder of one section and leaves the others alone", async ({ page }) => {
  await openSidebar(page);
  await folder(page, "#refLocal", "feat").click();
  await folder(page, "#refLocal", "release").click();
  await expect(folder(page, "#refLocal", "feat")).not.toHaveClass(/\bcollapsed\b/);

  const localFold = page.locator(".ref-group", { has: page.locator("#refLocal") }).locator("summary .fold-btn");
  await localFold.click();
  await expect(folder(page, "#refLocal", "feat")).toHaveClass(/\bcollapsed\b/);
  await expect(folder(page, "#refLocal", "release")).toHaveClass(/\bcollapsed\b/);

  // Clicking again expands them all back — one control, both directions.
  await localFold.click();
  await expect(folder(page, "#refLocal", "feat")).not.toHaveClass(/\bcollapsed\b/);
  await expect(folder(page, "#refLocal", "release")).not.toHaveClass(/\bcollapsed\b/);
});
