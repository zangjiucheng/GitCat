// Every modal has to stay inside the window.
//
// .modal is overflow:hidden. Before the base rule grew a max-height it had no
// height of its own, so a modal whose content outgrew the window was not
// scrolled off — it was CUT OFF. .modal.repofiles at a 400px-tall window was
// 545px of modal with its header AND its footer off-screen, and nothing
// scrolled: the content was not merely out of view, it was unreachable.
//
// The variant list is DERIVED from the markup, not typed out here. An opt-in
// list of "the modals that need a cap" is a second source of truth that
// nothing checks, which is how this class of bug survives in the first place —
// a new modal added tomorrow is covered by this file the day it is written.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(svelte|ts|html)$/.test(name)) out.push(p);
  }
  return out;
}

/** Every `class="modal …"` spelling used anywhere in the app. */
function modalVariants(): string[] {
  const files = [join(ROOT, "index.html"), ...walk(join(ROOT, "src"))];
  const found = new Set<string>();
  for (const f of files) {
    // readFileSync, not grep: src/main.ts contains NUL bytes, so grep reports
    // "Binary file matches" and silently skips it.
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/class="modal([^"]*)"/g)) {
      const extra = m[1].trim();
      // Skip the sibling classes (.modal-head/.modal-body/…) — only real
      // variants of .modal itself, plus the bare `class="modal"` case.
      if (extra === "") found.add("");
      else if (/^[a-z][a-z0-9-]*$/.test(extra)) found.add(extra);
    }
  }
  return [...found].sort();
}

const VARIANTS = modalVariants();

/**
 * Mount a modal of `variant` with content far taller than the window, measure
 * it, then take it back out. Synthetic markup on purpose: the contract under
 * test belongs to the shared .scrim/.modal/.modal-head/.modal-body/.modal-foot
 * chrome, and driving thirty real modals would need thirty backend fixtures.
 */
async function measure(page: Page, variant: string, withBody = true) {
  return page.evaluate(({ v, withBody }) => {
    const scrim = document.createElement("div");
    scrim.className = "scrim on";
    scrim.id = "__heightprobe";
    const rows = Array.from({ length: 120 }, (_, i) => `<p>row ${i}</p>`).join("");
    // Not every modal is built from the head/body/foot chrome — the About
    // dialog is a single padded box of centered content. Those were the blind
    // spot: a probe that always injects a .modal-body cannot see a modal that
    // has none, which is exactly the shape a flex column breaks.
    scrim.innerHTML = withBody
      ? `<div class="modal ${v}">` +
        `<div class="modal-head"><div><h3>probe</h3><p>probe</p></div></div>` +
        `<div class="modal-body">${rows}</div>` +
        `<div class="modal-foot"><button class="btn">close</button></div>` +
        `</div>`
      : `<div class="modal ${v}">${rows}</div>`;
    document.body.appendChild(scrim);
    const modal = scrim.querySelector(".modal") as HTMLElement;
    const head = scrim.querySelector(".modal-head") as HTMLElement | null;
    const foot = scrim.querySelector(".modal-foot") as HTMLElement | null;
    const body = scrim.querySelector(".modal-body") as HTMLElement | null;
    const r = modal.getBoundingClientRect();
    const cut = (el: HTMLElement | null) => {
      if (!el) return false;
      const b = el.getBoundingClientRect();
      return b.top < -0.5 || b.bottom > window.innerHeight + 0.5;
    };
    // A modal with no body has to scroll as a whole instead.
    const scroller = body ?? modal;
    const out = {
      h: Math.round(r.height),
      vh: window.innerHeight,
      overTop: Math.round(Math.max(0, -r.top)),
      overBottom: Math.round(Math.max(0, r.bottom - window.innerHeight)),
      headCut: cut(head),
      footCut: cut(foot),
      bodyScrolls: scroller.scrollHeight - scroller.clientHeight > 1,
    };
    scrim.remove();
    return out;
  }, { v: variant, withBody });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#setupWizardScrim")).toHaveClass(/\bon\b/);
  await page.keyboard.press("Escape");
});

test("no modal variant can outgrow the window", async ({ page }) => {
  expect(VARIANTS.length, "found no modal variants — did the markup change?").toBeGreaterThan(10);
  await page.setViewportSize({ width: 1000, height: 420 });

  const bad: string[] = [];
  for (const v of VARIANTS) {
   for (const withBody of [true, false]) {
    const m = await measure(page, v, withBody);
    if (m.overTop || m.overBottom || m.headCut || m.footCut) {
      bad.push(
        `.modal${v ? "." + v : ""}: ${m.h}px in a ${m.vh}px window` +
          (m.overTop ? `, ${m.overTop}px above the top` : "") +
          (m.overBottom ? `, ${m.overBottom}px below the bottom` : "") +
          (m.headCut ? ", header cut off" : "") +
          (m.footCut ? ", footer cut off" : "") +
          (withBody ? "" : " [no .modal-body]"),
      );
    }
   }
  }
  expect(bad, `modals cut off by the window:\n  ${bad.join("\n  ")}`).toEqual([]);
});

test("what a modal cannot show, it scrolls", async ({ page }) => {
  // Fitting is not enough on its own: a modal that fits by clipping its own
  // content is the same bug wearing a smaller box. The body has to scroll.
  await page.setViewportSize({ width: 1000, height: 420 });

  // .diffx and .blame deliberately opt out — their bodies are flex containers
  // whose CHILDREN scroll (a diff pane, a blame gutter), so an overflow:auto
  // body would add a second, outer scrollbar. They are checked for fit above.
  const OPT_OUT = new Set(["diffx", "blame"]);
  const notScrolling: string[] = [];
  for (const v of VARIANTS) {
    if (OPT_OUT.has(v)) continue;
    for (const withBody of [true, false]) {
      const m = await measure(page, v, withBody);
      if (!m.bodyScrolls) {
        notScrolling.push(`.modal${v ? "." + v : ""} (${m.h}px)${withBody ? "" : " [no .modal-body]"}`);
      }
    }
  }
  expect(notScrolling, `these clip instead of scrolling: ${notScrolling.join(", ")}`).toEqual([]);
});

test("a real modal keeps its header and footer on a short window", async ({ page }) => {
  // The synthetic probes above prove the shared chrome; this one proves a real
  // island rendered through it. Repo Files is 545px tall with the fixture's
  // content — at a 400px window it used to put BOTH its header and its footer
  // off-screen with nothing scrollable in between.
  await page.setViewportSize({ width: 1000, height: 400 });
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator("#cmdkInput")).toBeFocused();
  await page.locator("#cmdkInput").fill("Repo Files");
  await page.keyboard.press("Enter");

  const modal = page.locator(".modal.repofiles");
  await expect(modal).toBeVisible();
  // The open transition is transform:scale(.98) over 200ms; measuring through
  // it reports 98% of every dimension.
  await expect.poll(() => modal.evaluate((el) => getComputedStyle(el).transform)).toBe("none");

  const box = (await modal.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(-0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(400.5);
  await expect(modal.locator(".modal-head")).toBeInViewport({ ratio: 0.99 });
  await expect(modal.locator(".modal-foot")).toBeInViewport({ ratio: 0.99 });
  expect(
    await modal.locator(".modal-body").evaluate((el) => el.scrollHeight - el.clientHeight),
    "the body should scroll rather than clip",
  ).toBeGreaterThan(0);
});

test("a modal that is not built from head/body/foot keeps its own layout", async ({ page }) => {
  // The height cap came with a flex column, which blockifies every direct
  // child. The About dialog has no .modal-body — it centers an inline-block
  // mascot and an inline-block version chip with text-align — so as a flex
  // column both stretched to the full width: 84px centered became 506px flush
  // left. The synthetic probes above could not see it, because they always
  // build a modal that HAS a body.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator("#cmdkInput")).toBeFocused();
  await page.locator("#cmdkInput").fill("Check for Updates");
  await page.keyboard.press("Enter");

  const modal = page.locator(".modal.about-modal");
  await expect(modal).toBeVisible();
  await expect.poll(() => modal.evaluate((el) => getComputedStyle(el).transform)).toBe("none");

  const m = (await modal.boundingBox())!;
  for (const sel of [".about-tama-wrap", ".about-version"]) {
    const el = modal.locator(sel);
    await expect(el).toBeVisible();
    const b = (await el.boundingBox())!;
    expect(b.width, `${sel} was stretched to the modal's full width`).toBeLessThan(m.width * 0.6);
    // and it is still centred, not flush against the padding edge
    const off = Math.abs(b.x + b.width / 2 - (m.x + m.width / 2));
    expect(off, `${sel} is no longer centred`).toBeLessThan(4);
  }
});
