import { test, expect } from "@playwright/test";

// #81: the four plain modal islands are mounted on FIRST OPEN, not at boot.
//
// The distinction these tests turn on is "absent from the DOM" versus "present
// and hidden". Every one of these modals was previously mounted into
// document.body at boot and rendered a hidden scrim; a `toBeHidden()` assertion
// passes either way, so it cannot tell the two apart. `toHaveCount(0)` can.

const MODALS = [
  { name: "Settings", selector: ".modal.settings" },
  { name: "Plugins", selector: ".modal.plugins-modal" },
  { name: "External Tools", selector: ".modal.external-tools" },
  { name: "Tama Gallery", selector: ".modal.tama-gallery" },
  // #82/#83: the three that needed more than the mechanical change. Terminal
  // carries xterm's 334 kB and must stay mounted once opened; BisectDrawer is
  // the one island that does not go into document.body; PluginPanel is reached
  // through the plugin panel registry rather than a fixed call site.
  { name: "Terminal", selector: ".term-drawer" },
  { name: "Bisect drawer", selector: ".bisect-panel" },
  { name: "Plugin panel", selector: ".modal.pluginpanel" },
];

test("none of the lazily mounted modals is in the DOM at boot", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await page.waitForTimeout(300);

  for (const m of MODALS) {
    await expect(page.locator(m.selector), `${m.name} must not be mounted before it is opened`).toHaveCount(0);
  }

  // The controllers, unlike the views, stay eager — boot code reads them. If a
  // controller had been lazified too, the menu/⌘K wiring that calls into it at
  // boot would have thrown by now.
  expect(errors).toEqual([]);
});

test("opening one mounts exactly that one, and only once", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");
  await page.waitForTimeout(300);

  const settings = page.locator(".modal.settings");
  await expect(settings).toHaveCount(0);

  await page.keyboard.press("Control+,");
  await expect(settings, "Ctrl+, should load and mount Settings").toBeVisible();

  // Its siblings must still be absent — opening one modal must not drag the
  // other three in with it, which is what a single shared chunk would do.
  for (const m of MODALS.filter((m) => m.name !== "Settings")) {
    await expect(page.locator(m.selector), `${m.name} must still be absent`).toHaveCount(0);
  }

  // Close and reopen: the view stays mounted and is merely hidden now, so this
  // must not produce a SECOND copy in document.body. The guard in
  // mountOnFirstOpen is set before its dynamic import is awaited precisely so
  // a fast close/open cannot race two mounts.
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(settings).toHaveCount(1);
  await page.keyboard.press("Control+,");
  await expect(settings).toBeVisible();
  await expect(settings, "reopening must not mount a second copy").toHaveCount(1);

  // A failed chunk load would surface here rather than as a silent unhandled
  // rejection — mountOnFirstOpen catches and logs.
  expect(errors).toEqual([]);
});
