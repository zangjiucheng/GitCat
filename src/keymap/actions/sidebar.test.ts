// The sidebar's key actions. The load-bearing assertion is that `c` routes
// through the checkout CONFIRM and never through checkout() — that dialog is
// what handles a dirty working tree, and a bare letter must not decide on the
// user's behalf what happens to uncommitted changes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({ expandSidebar: vi.fn() }));
vi.mock("@/legacy/bridge", () => fns);

const ctrl = vi.hoisted(() => ({
  busy: false,
  locals: [
    { name: "main", upstream: "origin/main" },
    { name: "feat/x", upstream: null },
  ],
  openMenuAt: vi.fn(),
  openTagMenu: vi.fn(),
  openCheckoutConfirm: vi.fn(),
  checkout: vi.fn(),
}));
vi.mock("@/islands/sidebar/sidebar.svelte.ts", () => ({ sidebarCtrl: ctrl }));

import { focusedRef, sidebarKeys } from "./sidebar.ts";

function rows() {
  document.body.innerHTML = `
    <div id="refScroll">
      <div class="ref-item current" tabindex="0" id="cur" data-branch="main"></div>
      <div class="ref-item" tabindex="0" id="other" data-branch="feat/x"></div>
      <div class="ref-item" tabindex="0" id="rem" data-remote="origin/dev"></div>
      <div class="ref-item" tabindex="0" id="tag" data-tag="v1.0.0"><button id="tagbtn"></button></div>
    </div>
    <input id="refFilter" />
    <button id="outside"></button>`;
}

beforeEach(() => {
  rows();
  ctrl.busy = false;
  vi.clearAllMocks();
});

describe("focusedRef", () => {
  it("identifies each row kind", () => {
    document.getElementById("cur")!.focus();
    expect(focusedRef()).toMatchObject({ kind: "branch", name: "main", isCurrent: true });

    document.getElementById("other")!.focus();
    expect(focusedRef()).toMatchObject({ kind: "branch", name: "feat/x", isCurrent: false });

    document.getElementById("rem")!.focus();
    expect(focusedRef()).toMatchObject({ kind: "remote", name: "origin/dev" });

    document.getElementById("tag")!.focus();
    expect(focusedRef()).toMatchObject({ kind: "tag", name: "v1.0.0" });
  });

  it("finds the row from a control inside it", () => {
    document.getElementById("tagbtn")!.focus();
    expect(focusedRef()?.name).toBe("v1.0.0");
  });

  it("is null outside the ref list", () => {
    document.getElementById("outside")!.focus();
    expect(focusedRef()).toBeNull();
  });
});

describe("focusFilter", () => {
  it("expands the sidebar before focusing, and declines with no input", () => {
    expect(sidebarKeys.focusFilter()).toBeUndefined();
    expect(fns.expandSidebar).toHaveBeenCalled();

    document.getElementById("refFilter")!.remove();
    expect(sidebarKeys.focusFilter()).toBe(false);
  });
});

describe("openMenu", () => {
  it("passes the REAL upstream for a branch, not null", () => {
    // legacy's canvas path passes null here, which makes the menu's push/pull
    // entries read as "no upstream" for a branch that has one.
    document.getElementById("cur")!.focus();
    sidebarKeys.openMenu();
    expect(ctrl.openMenuAt).toHaveBeenCalledWith("main", true, "origin/main", expect.any(Number), expect.any(Number));

    document.getElementById("other")!.focus();
    sidebarKeys.openMenu();
    expect(ctrl.openMenuAt).toHaveBeenLastCalledWith("feat/x", false, null, expect.any(Number), expect.any(Number));
  });

  it("opens the checkout confirm for a remote, which has no management menu", () => {
    document.getElementById("rem")!.focus();
    sidebarKeys.openMenu();
    expect(ctrl.openCheckoutConfirm).toHaveBeenCalledWith("origin/dev", true, expect.any(Number), expect.any(Number));
    expect(ctrl.openMenuAt).not.toHaveBeenCalled();
  });

  it("opens the TAG menu for a tag row — tags do have one", () => {
    // The code here used to claim tags had no popover, which left them the one
    // ref kind without the actions chord. openTagMenu takes the anchor element
    // rather than coordinates.
    const el = document.getElementById("tag")!;
    el.focus();
    expect(sidebarKeys.openMenu()).toBeUndefined();
    expect(ctrl.openTagMenu).toHaveBeenCalledWith("v1.0.0", el);
  });

  it("declines with nothing focused", () => {
    document.getElementById("outside")!.focus();
    expect(sidebarKeys.openMenu()).toBe(false);
  });

  it("declines while a mutation is in flight", () => {
    // The ⋮ buttons and the mouse handlers refuse there; a letter must not be
    // the one way around it.
    ctrl.busy = true;
    document.getElementById("cur")!.focus();
    expect(sidebarKeys.openMenu()).toBe(false);
    document.getElementById("other")!.focus();
    expect(sidebarKeys.checkout()).toBe(false);
    expect(ctrl.openMenuAt).not.toHaveBeenCalled();
    expect(ctrl.openCheckoutConfirm).not.toHaveBeenCalled();
  });
});

describe("checkout", () => {
  it("goes through the confirm dialog, never checkout() directly", () => {
    document.getElementById("other")!.focus();
    expect(sidebarKeys.checkout()).toBeUndefined();
    expect(ctrl.openCheckoutConfirm).toHaveBeenCalledWith("feat/x", false, expect.any(Number), expect.any(Number));
    expect(ctrl.checkout).not.toHaveBeenCalled();
  });

  it("marks a remote as remote, so a tracking branch is created", () => {
    document.getElementById("rem")!.focus();
    sidebarKeys.checkout();
    expect(ctrl.openCheckoutConfirm).toHaveBeenCalledWith("origin/dev", true, expect.any(Number), expect.any(Number));
  });

  it("declines on the branch already checked out", () => {
    document.getElementById("cur")!.focus();
    expect(sidebarKeys.checkout()).toBe(false);
    expect(ctrl.openCheckoutConfirm).not.toHaveBeenCalled();
  });

  it("declines on a tag and with nothing focused", () => {
    document.getElementById("tag")!.focus();
    expect(sidebarKeys.checkout()).toBe(false);
    document.getElementById("outside")!.focus();
    expect(sidebarKeys.checkout()).toBe(false);
  });
});
