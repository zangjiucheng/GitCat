// Tests for the shared right-click menu's controller.
//
// The controller owns only "which items, and where" — rendering, viewport
// clamping and dismissal live in ContextMenu.svelte. Everything asserted
// here is what a caller can get wrong: running a disabled item, running an
// item after the menu was dismissed, or leaving one menu's items on screen
// when another opens.
import { describe, expect, it, vi } from "vitest";

import { contextMenuCtrl } from "./contextmenu.svelte.ts";

function item(label: string, extra: Record<string, unknown> = {}) {
  return { id: label, label, run: vi.fn(), ...extra };
}

describe("contextMenuCtrl", () => {
  it("starts closed", () => {
    contextMenuCtrl.close();
    expect(contextMenuCtrl.menu).toBeNull();
  });

  it("opens with the items and the click point", () => {
    contextMenuCtrl.open([item("Blame")], 120, 340);
    expect(contextMenuCtrl.menu?.items).toHaveLength(1);
    expect(contextMenuCtrl.menu?.x).toBe(120);
    expect(contextMenuCtrl.menu?.y).toBe(340);
    contextMenuCtrl.close();
  });

  // Right-clicking a second row while the first row's menu is still up must
  // REPLACE it. Appending would leave the previous row's actions on screen
  // pointing at a file the user is no longer looking at.
  it("a second open replaces the first menu rather than stacking", () => {
    contextMenuCtrl.open([item("first")], 0, 0);
    contextMenuCtrl.open([item("second"), item("third")], 10, 10);
    expect(contextMenuCtrl.menu?.items.map((i) => i.label)).toEqual(["second", "third"]);
    contextMenuCtrl.close();
  });

  // The menu has to be gone BEFORE the action runs: several of these open a
  // dialog or a confirm scrim, and a still-mounted backdrop would swallow
  // the first click in it.
  it("closes before running, so an action that opens a dialog is not dismissed by its own backdrop", () => {
    const seen: Array<unknown> = [];
    const it0 = { id: "open", label: "open something", run: () => seen.push(contextMenuCtrl.menu) };
    contextMenuCtrl.open([it0], 0, 0);
    contextMenuCtrl.run(it0);
    expect(seen).toEqual([null]);
    expect(contextMenuCtrl.menu).toBeNull();
  });

  it("a disabled item does nothing at all, and leaves the menu open", () => {
    const disabled = item("Show in file manager", { disabled: true });
    contextMenuCtrl.open([disabled], 0, 0);
    contextMenuCtrl.run(disabled);
    expect(disabled.run).not.toHaveBeenCalled();
    expect(contextMenuCtrl.menu).not.toBeNull();
    contextMenuCtrl.close();
  });

  // close() is wired to a backdrop click, Escape, and a window scroll, so it
  // lands on an already-closed menu routinely.
  it("closing twice is harmless", () => {
    contextMenuCtrl.open([item("x")], 0, 0);
    contextMenuCtrl.close();
    contextMenuCtrl.close();
    expect(contextMenuCtrl.menu).toBeNull();
  });

  // A right-click that produces no applicable action should not flash an
  // empty box — the caller can pass its list straight through without
  // filtering for emptiness first.
  it("opening with no items is a no-op", () => {
    contextMenuCtrl.open([], 5, 5);
    expect(contextMenuCtrl.menu).toBeNull();
  });
});
