import { test, expect } from "./fixtures/tauriMock";

test("clicking a branch in the sidebar selects its tip commit in the graph", async ({ page, repo }) => {
  repo.writeFile("README.md", "# fixture\n");
  repo.commit("Initial commit");
  repo.branch("feature/widget");
  repo.checkout("feature/widget");
  repo.writeFile("widget.ts", "export const widget = 1;\n");
  repo.commit("Add the widget"); // feature/widget's tip, NOT main's
  repo.checkout("main");

  await page.goto("/");
  await page.locator(".repo-pick").click();
  await page.locator(".db-add").click();
  await expect(page.locator("#cntLocal")).toHaveText("2");

  // `feature/widget` lives under a `feature` folder, and folders start closed
  // unless HEAD is inside them — HEAD is `main` here, so open it first.
  const featureFolder = page
    .locator("#refLocal .ref-folder")
    .filter({ has: page.locator(".rname", { hasText: /^feature$/ }) });
  await featureFolder.click();

  await page.locator('#refLocal [data-branch="feature/widget"]').click();

  // Canvas selection isn't in the DOM, but select(row) drives the detail
  // panel — so the panel is a faithful read of which row got selected. The
  // subject text is unique to feature/widget's tip (main's tip is "Initial
  // commit"), so this proves goToOid's 40-char join against the row shas
  // isn't silently broken by a width mismatch (e.g. comparing against a
  // 7-char prefix) — though with only two commits in this fixture, a
  // truncated-prefix implementation would happen to pass too.
  await expect(page.locator("#detail")).toContainText("Add the widget");
});

test("double-clicking a branch still opens the checkout confirm", async ({ page, repo }) => {
  repo.writeFile("README.md", "# fixture\n");
  repo.commit("Initial commit");
  repo.branch("release");

  await page.goto("/");
  await page.locator(".repo-pick").click();
  await page.locator(".db-add").click();
  await expect(page.locator("#cntLocal")).toHaveText("2");

  await page.locator('#refLocal [data-branch="release"]').dblclick();

  // `.ref-pop` is shared by eight different popovers in Sidebar.svelte (menu,
  // pushMenu, renameMenu, mergeMenu, dirtyCheckoutMenu, checkoutConfirm,
  // tagMenu, submoduleMenu) — only checkoutConfirm's own heading reads
  // "Switch to <name>?" (the generic branch menu's equivalent action is a
  // plain "Checkout" button, no heading at all), so asserting that text is
  // what actually pins THIS popover, for THIS branch, not just any of the
  // eight lighting up.
  await expect(page.locator(".ref-pop")).toContainText("Switch to release?");
});

test("double-clicking a branch jumps once, not twice, before the confirm opens", async ({ page, repo }) => {
  repo.writeFile("README.md", "# fixture\n");
  repo.commit("Initial commit");
  repo.branch("release");

  await page.goto("/");
  await page.locator(".repo-pick").click();
  await page.locator(".db-add").click();
  await expect(page.locator("#cntLocal")).toHaveText("2");

  // The DOM delivers click, click, dblclick — so before the `e.detail > 1`
  // guard, checkout-by-double-click ran the jump TWICE, each one a real
  // `commit_detail` round-trip. That's invisible in the DOM (both jumps land on
  // the same row), so count the IPC calls instead. Wrapping
  // `window.__TAURI_INTERNALS__.invoke` from the test works because
  // @tauri-apps/api/core reads it at call time, not at import time — see
  // tauriMock.ts's own header.
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>;
    w.__e2eDetailCalls = 0;
    const inner = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (cmd: string, args: unknown) => {
      if (cmd === "commit_detail") w.__e2eDetailCalls++;
      return inner(cmd, args);
    };
  });

  await page.locator('#refLocal [data-branch="release"]').dblclick();
  await expect(page.locator(".ref-pop")).toContainText("Switch to release?");

  expect(await page.evaluate(() => (window as unknown as Record<string, any>).__e2eDetailCalls)).toBe(1);
});

test("Enter on a branch row's own ⋮ button opens the branch menu, not a graph jump", async ({ page, repo }) => {
  repo.writeFile("README.md", "# fixture\n");
  repo.commit("Initial commit");
  repo.branch("release");

  await page.goto("/");
  await page.locator(".repo-pick").click();
  await page.locator(".db-add").click();
  await expect(page.locator("#cntLocal")).toHaveText("2");

  // Focus the row's own "Branch actions" ⋮ button directly (rather than
  // Tab-ing there) and press Enter on IT, not the row. The row's onkeydown
  // fires during bubble regardless of which descendant the key event
  // started on, so an unguarded preventDefault there would cancel the
  // button's own Enter-activates-click default action and jump the graph
  // instead of opening the menu — the regression this test guards against.
  await page.locator('#refLocal [data-branch="release"] .ref-menu').focus();
  await page.keyboard.press("Enter");

  await expect(page.locator(".ref-pop")).toContainText("Checkout");
});

test("Enter on a branch row itself still jumps to its tip", async ({ page, repo }) => {
  repo.writeFile("README.md", "# fixture\n");
  repo.commit("Initial commit");
  repo.branch("feature/widget");
  repo.checkout("feature/widget");
  repo.writeFile("widget.ts", "export const widget = 1;\n");
  repo.commit("Add the widget"); // feature/widget's tip, NOT main's
  repo.checkout("main");

  await page.goto("/");
  await page.locator(".repo-pick").click();
  await page.locator(".db-add").click();
  await expect(page.locator("#cntLocal")).toHaveText("2");

  const featureFolder = page
    .locator("#refLocal .ref-folder")
    .filter({ has: page.locator(".rname", { hasText: /^feature$/ }) });
  await featureFolder.click();

  // The previous test pins that a DESCENDANT's own Enter (the ⋮ button)
  // isn't hijacked by the row's onkeydown guard — this pins the other half:
  // the row's OWN Enter must still fire the jump. A guard that over-fired
  // (e.g. dropped the `e.target !== e.currentTarget` check entirely) would
  // pass that test while silently killing the keyboard jump on every row.
  await page.locator('#refLocal [data-branch="feature/widget"]').focus();
  await page.keyboard.press("Enter");

  await expect(page.locator("#detail")).toContainText("Add the widget");
});

test("a remote row's own ⋮ button opens the checkout confirm", async ({ page, repo }) => {
  repo.writeFile("README.md", "# fixture\n");
  repo.commit("Initial commit");
  // The fixture's only remote branch — a plain ref write is enough, since
  // the mock's list_refs (tauriMock.ts) reads refs/remotes/* straight off
  // disk the same way a real `git for-each-ref` would; no actual remote or
  // fetch is needed for the sidebar to render it.
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");

  await page.goto("/");
  await page.locator(".repo-pick").click();
  await page.locator(".db-add").click();
  await expect(page.locator("#cntRemote")).toHaveText("1");

  // Unlike Local's <details>, Remote's starts closed — expand it before its
  // row is reachable at all. Click the twisty rather than the summary's
  // bounding-box centre, which could land on one of its own manage buttons.
  const remoteGroup = page.locator("details.ref-group", { has: page.locator("#refRemote") });
  await remoteGroup.locator("summary .tw").click();

  await page.locator("#refRemote .ref-item .ref-menu").click();

  // Same pinning rationale as the double-click case above: `.ref-pop` is
  // shared by eight popovers, and only checkoutConfirm's own heading reads
  // "Switch to <name>?".
  await expect(page.locator(".ref-pop")).toContainText("Switch to origin/main?");
});

test("Enter on a tag row's own ⋮ button opens the tag menu, not a graph jump", async ({ page, repo }) => {
  repo.writeFile("README.md", "# fixture\n");
  repo.commit("Initial commit");
  repo.git("tag", "v1.0.0");

  await page.goto("/");
  await page.locator(".repo-pick").click();
  await page.locator(".db-add").click();
  await expect(page.locator("#cntTags")).toHaveText("1");

  // Tags' <details> starts closed, like Remote's — expand via the twisty
  // rather than the summary's centre, which could land on a manage button.
  const tagGroup = page.locator("details.ref-group", { has: page.locator("#refTags") });
  await tagGroup.locator("summary .tw").click();

  // A tag row's Enter now JUMPS, like every other ref row — deliberate (Enter
  // mirrors click). This pins the other half of that trade: the tag menu is
  // still reachable from the keyboard, via the row's own ⋮, exactly as a branch
  // row's is. Same bubble-phase hazard as the branch case above — the row's
  // onkeydown sees this Enter too, and an unguarded preventDefault there would
  // swallow the button's own activation and jump instead.
  await page.locator('#refTags [data-tag="v1.0.0"] .ref-menu').focus();
  await page.keyboard.press("Enter");

  // Only the TAG menu offers "Push to origin" + "Delete…" as its whole content;
  // the branch menu's own push entry lives behind a separate pushMenu popover.
  await expect(page.locator(".ref-pop")).toContainText("Push to origin");
  // …and the graph did NOT jump. Assert the hero is still SHOWN rather than only
  // that `.d-subject` is absent: a bare toHaveCount(0) is satisfied on the first
  // poll, and `.d-subject` appears only after an async commit_detail round-trip,
  // so on the regression this guards (the row's onkeydown swallowing the ⋮'s own
  // Enter, opening the menu AND jumping) the negative would race the round-trip
  // and pass vacuously. `.tama-hero` and the commit view are mutually exclusive
  // branches of Detail.svelte, so requiring the hero rules the jump out
  // positively; the count check stays as the direct statement of "no commit view".
  await expect(page.locator("#detail .tama-hero")).toBeVisible();
  await expect(page.locator("#detail .d-subject")).toHaveCount(0);
});
