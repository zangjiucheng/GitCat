// The focus contract. These are jsdom tests, which means one caveat worth
// stating: jsdom reports offsetParent === null for EVERYTHING (it does no
// layout), so the visibility filter cannot be exercised here — it is covered by
// the Playwright tests in e2e/keymap-scopes.spec.ts instead. What is covered
// here is the traversal order, the wrap, and the restore guards.
import { beforeEach, describe, expect, it } from "vitest";
import { focusInto, focusablesIn, restoreFocus, saveFocus, trapTab } from "./focus.ts";

beforeEach(() => {
  document.body.innerHTML = "";
});

function tab(shift = false): KeyboardEvent {
  return { key: "Tab", shiftKey: shift } as KeyboardEvent;
}

describe("focusablesIn", () => {
  it("collects the standard focusables in document order", () => {
    document.body.innerHTML = `
      <div id="r">
        <a href="#x">a</a>
        <button>b</button>
        <input>
        <select></select>
        <textarea></textarea>
        <div tabindex="0">d</div>
        <div contenteditable="true">e</div>
      </div>`;
    const got = focusablesIn(document.getElementById("r")!).map((e) => e.tagName.toLowerCase());
    expect(got).toEqual(["a", "button", "input", "select", "textarea", "div", "div"]);
  });

  it("skips disabled, aria-hidden and tabindex=-1", () => {
    document.body.innerHTML = `
      <div id="r">
        <button disabled>no</button>
        <button aria-hidden="true">no</button>
        <div tabindex="-1">no</div>
        <button id="yes">yes</button>
      </div>`;
    const got = focusablesIn(document.getElementById("r")!);
    expect(got.map((e) => e.id)).toEqual(["yes"]);
  });

  it("does not reach outside its root", () => {
    document.body.innerHTML = `<button id="outside"></button><div id="r"><button id="inside"></button></div>`;
    expect(focusablesIn(document.getElementById("r")!).map((e) => e.id)).toEqual(["inside"]);
  });
});

describe("trapTab", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="before"></button>
      <div id="r"><button id="one"></button><button id="two"></button><button id="three"></button></div>`;
  });

  const root = () => document.getElementById("r")!;

  it("moves forward and wraps at the end", () => {
    document.getElementById("two")!.focus();
    expect(trapTab(tab(), root())).toBe(true);
    expect(document.activeElement!.id).toBe("three");
    trapTab(tab(), root());
    expect(document.activeElement!.id).toBe("one");
  });

  it("moves backward and wraps at the start", () => {
    document.getElementById("one")!.focus();
    trapTab(tab(true), root());
    expect(document.activeElement!.id).toBe("three");
  });

  it("enters at the first item when focus is outside the scope", () => {
    // The usual case on the very first Tab, when the scrim or <body> has focus.
    document.getElementById("before")!.focus();
    trapTab(tab(), root());
    expect(document.activeElement!.id).toBe("one");
  });

  it("enters at the LAST item on Shift+Tab from outside", () => {
    document.getElementById("before")!.focus();
    trapTab(tab(true), root());
    expect(document.activeElement!.id).toBe("three");
  });

  it("declines rather than swallowing Tab when there is nothing to focus", () => {
    // A text-only modal must not strand the user with Tab dead and no way out.
    document.body.innerHTML = `<div id="empty"><p>nothing here</p></div>`;
    expect(trapTab(tab(), document.getElementById("empty")!)).toBe(false);
  });
});

describe("saveFocus / restoreFocus", () => {
  it("round-trips the focused element", () => {
    document.body.innerHTML = `<button id="trigger"></button><button id="other"></button>`;
    document.getElementById("trigger")!.focus();
    const saved = saveFocus();
    document.getElementById("other")!.focus();
    expect(restoreFocus(saved)).toBe(true);
    expect(document.activeElement!.id).toBe("trigger");
  });

  it("treats <body> as nothing worth restoring", () => {
    document.body.innerHTML = `<button id="b"></button>`;
    expect(saveFocus()).toBeNull();
  });

  it("refuses to focus a node that was destroyed while the scope was open", () => {
    // About.svelte and friends unmount their content on close rather than
    // toggling class:on, so the saved node can legitimately be gone by the time
    // the scope pops. Focusing a detached node silently sends focus to <body>,
    // which reads to the user as the app losing their place.
    document.body.innerHTML = `<button id="trigger"></button>`;
    const el = document.getElementById("trigger")!;
    el.focus();
    const saved = saveFocus();
    el.remove();
    expect(restoreFocus(saved)).toBe(false);
  });

  it("is a no-op for a null save", () => {
    expect(restoreFocus(null)).toBe(false);
  });
});

describe("focusInto", () => {
  it("prefers [data-autofocus] over document order", () => {
    document.body.innerHTML = `<div id="r"><button id="first"></button><input id="want" data-autofocus></div>`;
    expect(focusInto(document.getElementById("r")!)!.id).toBe("want");
    expect(document.activeElement!.id).toBe("want");
  });

  it("falls back to the first focusable", () => {
    document.body.innerHTML = `<div id="r"><button id="first"></button><button id="second"></button></div>`;
    expect(focusInto(document.getElementById("r")!)!.id).toBe("first");
  });

  it("falls back to the container itself when it can take focus", () => {
    // The case that matters for a modal whose content is only text: without it
    // focus stays behind the scrim and the trap has nothing to trap.
    document.body.innerHTML = `<div id="r" tabindex="-1"><p>just words</p></div>`;
    expect(focusInto(document.getElementById("r")!)!.id).toBe("r");
    expect(document.activeElement!.id).toBe("r");
  });
});
