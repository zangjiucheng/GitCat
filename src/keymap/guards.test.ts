// The guard table, plus the one duplication this PR deliberately kept.
//
// dispatch.ts's textProbe carries TWO text-input variants: the 3-selector form
// every legacy handler uses, and vimnav.svelte.ts:36's select-inclusive form.
// Unifying them is a real behaviour change (⌘Z with Sidebar.svelte's branch-from
// <select> focused would stop undoing), so it belongs in its own PR. These tests
// are what stop the two implementations drifting apart in the meantime.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/legacy/bridge", () => ({
  get CUR_REPO() {
    return repo;
  },
  get G() {
    return graph;
  },
}));

let repo: string | null = "/repo";
let graph: { N: number } | null = { N: 12 };

import { GUARDS } from "./guards.ts";
import { isTextInputFocused } from "../islands/vimnav/vimnav.svelte.ts";

function ctx(target: Element | null) {
  return { event: { target } as unknown as KeyboardEvent, scope: "global", platform: "linux" } as never;
}

beforeEach(() => {
  repo = "/repo";
  graph = { N: 12 };
  document.body.innerHTML = "";
});

describe("repoOpen", () => {
  it("follows bridge.CUR_REPO", () => {
    expect(GUARDS.repoOpen(ctx(null))).toBe(true);
    repo = null;
    expect(GUARDS.repoOpen(ctx(null))).toBe(false);
    repo = "";
    expect(GUARDS.repoOpen(ctx(null))).toBe(false);
  });
});

describe("noScrimOpen", () => {
  it("bails only while a .scrim.on is in the document", () => {
    expect(GUARDS.noScrimOpen(ctx(null))).toBe(true);
    document.body.innerHTML = `<div class="scrim on"></div>`;
    expect(GUARDS.noScrimOpen(ctx(null))).toBe(false);
  });

  it("still uses .scrim.on, NOT [data-modal-blocking]", () => {
    // PR 0 added the attribute and it has zero readers on this branch on
    // purpose: switching to it would stop ⌘K bailing over Settings, Bisect and
    // the expanded diff, which is a behaviour change and belongs in PR 2.
    document.body.innerHTML = `<div class="scrim" data-modal-blocking></div>`;
    expect(GUARDS.noScrimOpen(ctx(null))).toBe(true);
  });
});

describe("notInTerminal", () => {
  it("bails inside .term-drawer and nowhere else", () => {
    document.body.innerHTML = `<div class="term-drawer"><textarea id="t"></textarea></div><input id="o">`;
    expect(GUARDS.notInTerminal(ctx(document.getElementById("t")))).toBe(false);
    expect(GUARDS.notInTerminal(ctx(document.getElementById("o")))).toBe(true);
    expect(GUARDS.notInTerminal(ctx(null))).toBe(true);
  });
});

describe("graphHasRows", () => {
  it("reads bridge.G.N and tolerates a null graph", () => {
    expect(GUARDS.graphHasRows(ctx(null))).toBe(true);
    graph = { N: 0 };
    expect(GUARDS.graphHasRows(ctx(null))).toBe(false);
    graph = null;
    expect(GUARDS.graphHasRows(ctx(null))).toBe(false);
  });
});

describe("the text-input probe variants agree with vimnav", () => {
  const SELECTORS_3 = "input, textarea, [contenteditable=true]";
  const SELECTORS_4 = "input, textarea, select, [contenteditable=true]";

  it.each([
    ["input", `<input id="x">`, true, true],
    ["textarea", `<textarea id="x"></textarea>`, true, true],
    ["contenteditable", `<div id="x" contenteditable="true"></div>`, true, true],
    // The one genuine difference, and the reason the two forms are not unified.
    ["select", `<select id="x"></select>`, false, true],
    ["button", `<button id="x"></button>`, false, false],
    ["div", `<div id="x"></div>`, false, false],
  ])("%s", (_name, html, in3, in4) => {
    document.body.innerHTML = html;
    const el = document.getElementById("x")!;
    expect(!!el.closest(SELECTORS_3)).toBe(in3);
    expect(!!el.closest(SELECTORS_4)).toBe(in4);
    // vimnav's exported helper is the select-inclusive one.
    expect(isTextInputFocused(el)).toBe(in4);
  });

  it("matches a descendant of a text field, not just the field itself", () => {
    document.body.innerHTML = `<div contenteditable="true"><span id="x">hi</span></div>`;
    const el = document.getElementById("x")!;
    expect(!!el.closest(SELECTORS_3)).toBe(true);
    expect(isTextInputFocused(el)).toBe(true);
  });
});
