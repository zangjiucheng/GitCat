// Tests for the vim-nav controller. Same isolation strategy as
// filterrepo.svelte.test.ts / resolver.svelte.test.ts / bisect.svelte.test.ts:
// legacy/bridge is mocked so legacy/main.ts (a whole vanilla canvas app that
// boots on import) is never evaluated. See that file's header comment for
// the full rationale.
//
// Canvas-selection movement (moveCanvasSelection/jumpCanvasSelection/
// pageCanvasSelection) IS covered here against the mock below, but real
// canvas/scroll behavior is only truly verified by hand (see the plan's
// manual verification checklist) — this suite proves the row-index math,
// not the pixels.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => {
  const state = { selectedRow: -1, scrollTarget: 0 };
  const layout = { rowH: 20 };
  const view = { cssH: 200 };
  return {
    state,
    layout,
    view,
    G: { N: 100 },
    clampScroll: vi.fn((v: number) => Math.max(0, v)),
    select: vi.fn((row: number) => {
      state.selectedRow = row;
    }),
  };
});

import * as bridge from "../../legacy/bridge";
import {
  isTextInputFocused,
  moveDomFocus,
  moveCanvasSelection,
  jumpCanvasSelection,
  pageCanvasSelection,
  noteGKey,
  noteNonGKey,
  handleGlobalKeydown,
  vimnavCtrl,
} from "./vimnav.svelte.ts";

beforeEach(() => {
  document.body.innerHTML = "";
  (bridge.state as any).selectedRow = -1;
  (bridge.state as any).scrollTarget = 0;
  noteNonGKey();
});

describe("isTextInputFocused", () => {
  it("is true for input/textarea/select/contenteditable, false for a plain element", () => {
    document.body.innerHTML = `
      <input id="i" /><textarea id="t"></textarea><select id="s"></select>
      <div id="ce" contenteditable="true"></div><div id="plain"></div>
    `;
    expect(isTextInputFocused(document.getElementById("i"))).toBe(true);
    expect(isTextInputFocused(document.getElementById("t"))).toBe(true);
    expect(isTextInputFocused(document.getElementById("s"))).toBe(true);
    expect(isTextInputFocused(document.getElementById("ce"))).toBe(true);
    expect(isTextInputFocused(document.getElementById("plain"))).toBe(false);
  });

  it("is true for an element nested inside a contenteditable ancestor", () => {
    document.body.innerHTML = `<div contenteditable="true"><span id="inner">x</span></div>`;
    expect(isTextInputFocused(document.getElementById("inner"))).toBe(true);
  });

  it("is false for null (nothing focused)", () => {
    expect(isTextInputFocused(null)).toBe(false);
  });
});

describe("moveDomFocus", () => {
  function setUpList() {
    document.body.innerHTML = `
      <div data-vimnav-list>
        <div id="r0" tabindex="0"></div>
        <div id="r1" tabindex="0"></div>
        <div id="r2" tabindex="0"></div>
      </div>
    `;
  }

  it("returns false when nothing is focused inside a vimnav-list", () => {
    document.body.innerHTML = `<div id="r0" tabindex="0"></div>`;
    document.getElementById("r0")!.focus();
    expect(moveDomFocus(1)).toBe(false);
  });

  it("moves focus to the next row", () => {
    setUpList();
    document.getElementById("r0")!.focus();
    expect(moveDomFocus(1)).toBe(true);
    expect(document.activeElement?.id).toBe("r1");
  });

  it("moves focus to the previous row", () => {
    setUpList();
    document.getElementById("r2")!.focus();
    expect(moveDomFocus(-1)).toBe(true);
    expect(document.activeElement?.id).toBe("r1");
  });

  it("stops at the last row instead of wrapping", () => {
    setUpList();
    document.getElementById("r2")!.focus();
    expect(moveDomFocus(1)).toBe(true);
    expect(document.activeElement?.id).toBe("r2");
  });

  it("stops at the first row instead of wrapping", () => {
    setUpList();
    document.getElementById("r0")!.focus();
    expect(moveDomFocus(-1)).toBe(true);
    expect(document.activeElement?.id).toBe("r0");
  });

  it("lands on the first row when the container itself has focus", () => {
    document.body.innerHTML = `
      <div data-vimnav-list tabindex="-1" id="container">
        <div id="r0" tabindex="0"></div>
        <div id="r1" tabindex="0"></div>
      </div>
    `;
    document.getElementById("container")!.focus();
    expect(moveDomFocus(1)).toBe(true);
    expect(document.activeElement?.id).toBe("r0");
  });
});

describe("canvas selection movement", () => {
  it("moveCanvasSelection starts at row 0 going forward with nothing selected", () => {
    moveCanvasSelection(1);
    expect(bridge.state.selectedRow).toBe(0);
  });

  it("moveCanvasSelection starts at the last row going backward with nothing selected", () => {
    moveCanvasSelection(-1);
    expect(bridge.state.selectedRow).toBe(99);
  });

  it("moveCanvasSelection steps by one and clamps at the bounds", () => {
    (bridge.state as any).selectedRow = 5;
    moveCanvasSelection(1);
    expect(bridge.state.selectedRow).toBe(6);

    (bridge.state as any).selectedRow = 0;
    moveCanvasSelection(-1);
    expect(bridge.state.selectedRow).toBe(0);

    (bridge.state as any).selectedRow = 99;
    moveCanvasSelection(1);
    expect(bridge.state.selectedRow).toBe(99);
  });

  it("jumpCanvasSelection jumps to the first/last row", () => {
    jumpCanvasSelection("first");
    expect(bridge.state.selectedRow).toBe(0);
    jumpCanvasSelection("last");
    expect(bridge.state.selectedRow).toBe(99);
  });

  it("pageCanvasSelection moves by roughly half a viewport's rows and clamps", () => {
    // view.cssH=200, layout.rowH=20 -> half-page = floor((200*0.5)/20) = 5 rows
    (bridge.state as any).selectedRow = 10;
    pageCanvasSelection(1);
    expect(bridge.state.selectedRow).toBe(15);
    pageCanvasSelection(-1);
    expect(bridge.state.selectedRow).toBe(10);

    (bridge.state as any).selectedRow = 97;
    pageCanvasSelection(1);
    expect(bridge.state.selectedRow).toBe(99);
  });
});

describe("handleGlobalKeydown — modifier guard (regression: Ctrl/Cmd+K used to also scroll the canvas)", () => {
  // BUG: `e.key` is the same "k" whether or not Ctrl/Cmd is held — the bare
  // j/k/g/G/? bindings used to match on `e.key` alone, so Ctrl/Cmd+K (opening
  // the command palette, handled entirely elsewhere by Cmdk.svelte) ALSO
  // tripped this file's own "k" -> move-selection-up handler underneath it.
  function key(k: string, opts: Partial<KeyboardEventInit> = {}): KeyboardEvent {
    return new KeyboardEvent("keydown", { key: k, cancelable: true, ...opts });
  }

  it("Ctrl+K does not move the canvas selection, and leaves the event unhandled for the command palette", () => {
    const e = key("k", { ctrlKey: true });
    handleGlobalKeydown(e);
    expect(bridge.state.selectedRow).toBe(-1);
    expect(e.defaultPrevented).toBe(false);
  });

  it("Cmd+K (metaKey, e.g. macOS) is likewise left alone", () => {
    const e = key("k", { metaKey: true });
    handleGlobalKeydown(e);
    expect(bridge.state.selectedRow).toBe(-1);
    expect(e.defaultPrevented).toBe(false);
  });

  it("a bare k/j (no modifier) still moves the canvas selection — the fix only excludes the modified case", () => {
    const upEvent = key("k");
    handleGlobalKeydown(upEvent);
    expect(bridge.state.selectedRow).toBe(99); // nothing selected yet — "up" wraps to the last row, matching moveCanvasSelection's own test above
    expect(upEvent.defaultPrevented).toBe(true);

    (bridge.state as any).selectedRow = -1;
    handleGlobalKeydown(key("j"));
    expect(bridge.state.selectedRow).toBe(0);
  });

  it("Ctrl+G and Ctrl+? are likewise left alone, not just Ctrl+K", () => {
    handleGlobalKeydown(key("g", { ctrlKey: true }));
    handleGlobalKeydown(key("G", { ctrlKey: true }));
    handleGlobalKeydown(key("?", { ctrlKey: true }));
    expect(bridge.state.selectedRow).toBe(-1);
    expect(vimnavCtrl.helpOpen).toBe(false);
  });

  it("a bare ? (no modifier) still opens the help overlay", () => {
    handleGlobalKeydown(key("?"));
    expect(vimnavCtrl.helpOpen).toBe(true);
    vimnavCtrl.closeHelp();
  });

  it("Ctrl+D/Ctrl+U still fire — the one binding that DOES require a modifier — unaffected by the fix", () => {
    (bridge.state as any).selectedRow = 10;
    handleGlobalKeydown(key("d", { ctrlKey: true }));
    expect(bridge.state.selectedRow).toBe(15); // matches pageCanvasSelection's own test above

    handleGlobalKeydown(key("u", { ctrlKey: true }));
    expect(bridge.state.selectedRow).toBe(10);
  });

  it("a bare d/u (no modifier) does nothing — only the Ctrl/Cmd form is bound", () => {
    (bridge.state as any).selectedRow = 10;
    handleGlobalKeydown(key("d"));
    expect(bridge.state.selectedRow).toBe(10);
  });

  it("Alt+K is also excluded, defensively, even though nothing in this app binds Alt+letter today", () => {
    const e = key("k", { altKey: true });
    handleGlobalKeydown(e);
    expect(bridge.state.selectedRow).toBe(-1);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("gg chord detection", () => {
  it("does not fire on the first g", () => {
    expect(noteGKey(1000)).toBe(false);
  });

  it("fires when a second g arrives within the timeout", () => {
    noteGKey(1000);
    expect(noteGKey(1300)).toBe(true);
  });

  it("does not fire when the second g arrives after the timeout", () => {
    noteGKey(1000);
    expect(noteGKey(2000)).toBe(false);
  });

  it("resets after firing so a third g starts a fresh chord", () => {
    noteGKey(1000);
    expect(noteGKey(1200)).toBe(true);
    expect(noteGKey(1250)).toBe(false);
  });

  it("noteNonGKey clears a pending chord", () => {
    noteGKey(1000);
    noteNonGKey();
    expect(noteGKey(1100)).toBe(false); // treated as a fresh first "g", not a completion
  });
});
