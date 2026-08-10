// Tests for the submodule-navigator controller. Same isolation strategy as the
// other island tests: bridge (a live re-export of legacy/main.ts, which boots the
// whole canvas app on import) and the sidebar module are mocked so neither is
// ever evaluated here. NAV_STACK / CUR_REPO stand in for whatever openRepo has
// derived from git's superproject chain; navigateToRepo(absolutePath) is the jump.
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockNavStack: string[] = [];
let mockCurRepo = "";
// Hoisted so the (hoisted) vi.mock factory below can reference it eagerly
// without hitting the temporal dead zone.
const { navigateToRepo } = vi.hoisted(() => ({ navigateToRepo: vi.fn(async () => true) }));

vi.mock("../../legacy/bridge", () => ({
  get NAV_STACK() {
    return mockNavStack;
  },
  get CUR_REPO() {
    return mockCurRepo;
  },
  navigateToRepo,
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn() },
}));

let mockInTauri = false;
vi.mock("../../ipc/env", () => ({
  get IN_TAURI() {
    return mockInTauri;
  },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: { submoduleStatus: vi.fn() },
}));

// The real submoduleCanOpen logic, without pulling the sidebar's whole graph.
vi.mock("../sidebar/sidebar.svelte.ts", () => ({
  submoduleCanOpen: (s: string) => ["clean", "dirty", "out-of-date", "conflicted"].includes(s),
}));

import { commands } from "../../ipc/bindings";
import { submoduleNavCtrl, horizontalWheelDelta } from "./submodulenav.svelte.ts";
import type { SubmoduleInfo } from "../../ipc/bindings";

function ok<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}
function sub(path: string, absolutePath: string, status: string): SubmoduleInfo {
  return { name: path, path, absolutePath, url: null, status, headSha: null, workdirSha: null };
}

beforeEach(() => {
  mockNavStack = [];
  mockCurRepo = "";
  mockInTauri = true;
  submoduleNavCtrl.reset();
  vi.clearAllMocks();
  navigateToRepo.mockResolvedValue(true);
});

describe("refresh — breadcrumb + siblings", () => {
  it("at the top level, lists the repo's own submodules as dive-in tabs (none current)", async () => {
    mockNavStack = [];
    mockCurRepo = "/repo";
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(
      ok([sub("vendor/lib-a", "/repo/vendor/lib-a", "clean"), sub("vendor/lib-b", "/repo/vendor/lib-b", "dirty")]),
    );

    await submoduleNavCtrl.refresh("/repo");

    expect(commands.submoduleStatus).toHaveBeenCalledWith("/repo");
    expect(submoduleNavCtrl.path.map((c) => c.name)).toEqual(["repo"]);
    expect(submoduleNavCtrl.path[0].current).toBe(true);
    expect(submoduleNavCtrl.siblings.map((s) => s.name)).toEqual(["vendor/lib-a", "vendor/lib-b"]);
    expect(submoduleNavCtrl.siblings.every((s) => !s.current)).toBe(true);
    expect(submoduleNavCtrl.visible).toBe(true);
  });

  it("inside a submodule, siblings come from the PARENT and the current one is flagged", async () => {
    mockNavStack = ["/repo"]; // openRepo derived this from git's superproject chain
    mockCurRepo = "/repo/vendor/lib-a";
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(
      ok([sub("vendor/lib-a", "/repo/vendor/lib-a", "clean"), sub("vendor/lib-b", "/repo/vendor/lib-b", "dirty")]),
    );

    await submoduleNavCtrl.refresh("/repo/vendor/lib-a");

    expect(commands.submoduleStatus).toHaveBeenCalledWith("/repo"); // parent, not the current repo
    expect(submoduleNavCtrl.path.map((c) => c.name)).toEqual(["repo", "lib-a"]);
    expect(submoduleNavCtrl.path[1].current).toBe(true);
    const cur = submoduleNavCtrl.siblings.find((s) => s.absolutePath === "/repo/vendor/lib-a");
    const other = submoduleNavCtrl.siblings.find((s) => s.absolutePath === "/repo/vendor/lib-b");
    expect(cur?.current).toBe(true);
    expect(other?.current).toBe(false);
  });

  it("marks the current sibling even when CUR_REPO's spelling differs (trailing slash / separators)", async () => {
    // openRepo may set CUR_REPO from the OS picker while submodule_status builds
    // its absolutePath via git2 — samePath() bridges the cosmetic difference.
    mockNavStack = ["/repo"];
    mockCurRepo = "/repo/vendor/lib-a/"; // trailing slash
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(ok([sub("vendor/lib-a", "/repo/vendor/lib-a", "clean")]));
    await submoduleNavCtrl.refresh(mockCurRepo);
    expect(submoduleNavCtrl.siblings[0].current).toBe(true);
  });

  it("a plain repo with no submodules keeps the strip hidden", async () => {
    mockNavStack = [];
    mockCurRepo = "/repo";
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(ok([]));
    await submoduleNavCtrl.refresh("/repo");
    expect(submoduleNavCtrl.siblings).toEqual([]);
    expect(submoduleNavCtrl.visible).toBe(false);
  });

  it("marks not-initialized / removed siblings as not-openable", async () => {
    mockNavStack = [];
    mockCurRepo = "/repo";
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(
      ok([sub("a", "/repo/a", "clean"), sub("b", "/repo/b", "not-initialized")]),
    );
    await submoduleNavCtrl.refresh("/repo");
    expect(submoduleNavCtrl.siblings.find((s) => s.name === "a")?.canOpen).toBe(true);
    expect(submoduleNavCtrl.siblings.find((s) => s.name === "b")?.canOpen).toBe(false);
  });
});

describe("jumps = navigateToRepo(absolutePath) (openRepo re-derives the chain)", () => {
  it("jumpToSibling opens the sibling", async () => {
    mockNavStack = ["/repo"];
    mockCurRepo = "/repo/vendor/lib-a";
    await submoduleNavCtrl.jumpToSibling({
      name: "vendor/lib-b", absolutePath: "/repo/vendor/lib-b", status: "dirty", canOpen: true, current: false,
    });
    expect(navigateToRepo).toHaveBeenCalledWith("/repo/vendor/lib-b");
  });

  it("jumpToSibling is a no-op for the current sibling or a non-openable one", async () => {
    await submoduleNavCtrl.jumpToSibling({ name: "x", absolutePath: "/repo/x", status: "clean", canOpen: true, current: true });
    await submoduleNavCtrl.jumpToSibling({ name: "y", absolutePath: "/repo/y", status: "not-initialized", canOpen: false, current: false });
    expect(navigateToRepo).not.toHaveBeenCalled();
  });

  it("jumpToCrumb(0) opens the root; the current crumb is a no-op", async () => {
    mockNavStack = ["/repo"];
    mockCurRepo = "/repo/vendor/lib-a";
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(ok([sub("vendor/lib-a", "/repo/vendor/lib-a", "clean")]));
    await submoduleNavCtrl.refresh("/repo/vendor/lib-a");

    await submoduleNavCtrl.jumpToCrumb(0); // root
    expect(navigateToRepo).toHaveBeenCalledWith("/repo");

    navigateToRepo.mockClear();
    await submoduleNavCtrl.jumpToCrumb(1); // current — no-op
    expect(navigateToRepo).not.toHaveBeenCalled();
  });

  it("jumping to the already-open repo is a no-op", async () => {
    mockCurRepo = "/repo/vendor/lib-a";
    await submoduleNavCtrl.jumpTo("/repo/vendor/lib-a", "sib:/repo/vendor/lib-a");
    expect(navigateToRepo).not.toHaveBeenCalled();
  });

  it("a second jump is ignored while one is in flight (busy guard)", async () => {
    mockCurRepo = "/repo";
    let release: (v: boolean) => void = () => {};
    navigateToRepo.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const p = submoduleNavCtrl.jumpTo("/repo/a", "sib:/repo/a");
    expect(submoduleNavCtrl.busy).toBe(true);
    await submoduleNavCtrl.jumpTo("/repo/b", "sib:/repo/b"); // ignored
    release(true);
    await p;
    expect(navigateToRepo).toHaveBeenCalledTimes(1);
    expect(navigateToRepo).toHaveBeenCalledWith("/repo/a");
    expect(submoduleNavCtrl.busy).toBe(false);
  });
});

describe("full-tree popover", () => {
  it("walks submodule_status recursively, tagging the current node", async () => {
    mockNavStack = ["/repo"];
    mockCurRepo = "/repo/vendor/lib-a";
    vi.mocked(commands.submoduleStatus).mockImplementation(async (p: string) => {
      if (p === "/repo") return ok([sub("vendor/lib-a", "/repo/vendor/lib-a", "clean"), sub("third_party/tool", "/repo/third_party/tool", "out-of-date")]);
      if (p === "/repo/vendor/lib-a") return ok([sub("sub/nested", "/repo/vendor/lib-a/sub/nested", "clean")]);
      return ok([]);
    });

    await submoduleNavCtrl.toggleTree();

    expect(submoduleNavCtrl.treeOpen).toBe(true);
    const root = submoduleNavCtrl.tree!;
    expect(root.isRoot).toBe(true);
    expect(root.name).toBe("repo");
    expect(root.children.map((c) => c.name)).toEqual(["vendor/lib-a", "third_party/tool"]);

    const libA = root.children[0];
    expect(libA.current).toBe(true);
    expect(libA.children.map((c) => c.name)).toEqual(["sub/nested"]);
  });

  it("does not descend into a non-openable node", async () => {
    mockNavStack = [];
    mockCurRepo = "/repo";
    vi.mocked(commands.submoduleStatus).mockImplementation(async (p: string) => {
      if (p === "/repo") return ok([sub("gone", "/repo/gone", "not-initialized")]);
      return ok([sub("should-not-load", "/repo/gone/x", "clean")]);
    });

    await submoduleNavCtrl.toggleTree();

    expect(submoduleNavCtrl.tree!.children[0].children).toEqual([]);
    // Only the root level was queried — the not-initialized node was never walked.
    expect(commands.submoduleStatus).toHaveBeenCalledTimes(1);
  });

  it("toggleTree a second time closes it", async () => {
    mockCurRepo = "/repo";
    vi.mocked(commands.submoduleStatus).mockResolvedValue(ok([]));
    await submoduleNavCtrl.toggleTree();
    expect(submoduleNavCtrl.treeOpen).toBe(true);
    await submoduleNavCtrl.toggleTree();
    expect(submoduleNavCtrl.treeOpen).toBe(false);
  });
});

describe("reset", () => {
  it("clears the strip so its grid row collapses", async () => {
    mockCurRepo = "/repo";
    vi.mocked(commands.submoduleStatus).mockResolvedValueOnce(ok([sub("a", "/repo/a", "clean")]));
    await submoduleNavCtrl.refresh("/repo");
    expect(submoduleNavCtrl.visible).toBe(true);
    submoduleNavCtrl.reset();
    expect(submoduleNavCtrl.visible).toBe(false);
    expect(submoduleNavCtrl.path).toEqual([]);
    expect(submoduleNavCtrl.siblings).toEqual([]);
  });
});

describe("horizontalWheelDelta — wheel-to-scroll on the overflowing strip", () => {
  const overflow = { scrollWidth: 800, clientWidth: 400 };
  const noOverflow = { scrollWidth: 300, clientWidth: 400 };

  it("returns 0 when the strip doesn't overflow (nothing to scroll)", () => {
    expect(horizontalWheelDelta({ deltaX: 0, deltaY: 120, deltaMode: 0, ...noOverflow })).toBe(0);
  });

  it("translates a vertical mouse wheel into horizontal px when overflowing", () => {
    expect(horizontalWheelDelta({ deltaX: 0, deltaY: 120, deltaMode: 0, ...overflow })).toBe(120);
    expect(horizontalWheelDelta({ deltaX: 0, deltaY: -80, deltaMode: 0, ...overflow })).toBe(-80);
  });

  it("leaves a horizontal-dominant trackpad gesture alone (native deltaX scroll)", () => {
    expect(horizontalWheelDelta({ deltaX: 90, deltaY: 30, deltaMode: 0, ...overflow })).toBe(0);
    // Equal magnitudes count as horizontal-dominant → not hijacked.
    expect(horizontalWheelDelta({ deltaX: 50, deltaY: 50, deltaMode: 0, ...overflow })).toBe(0);
  });

  it("scales line-based deltas (deltaMode 1, typical mouse wheel) by ~16px/line", () => {
    expect(horizontalWheelDelta({ deltaX: 0, deltaY: 3, deltaMode: 1, ...overflow })).toBe(48);
  });
});

describe("refresh with no repo open", () => {
  beforeEach(() => {
    mockInTauri = true;
    mockNavStack = [];
    mockCurRepo = "";
    submoduleNavCtrl.reset();
  });

  // REGRESSION: src/main.ts calls this once at boot, with whatever
  // `bridge.CUR_REPO` currently is — and at boot with no repo open that is
  // `null`. `refresh` used to take it as `string` (the call site casts through
  // `as unknown as string`) and hand it straight to `basename()`, which does
  // `p.replace(...)`. Result: an uncaught TypeError on every launch that opens
  // without a repo, from a line the type-checker had been told to trust.
  it("does not throw when there is no repo yet", async () => {
    await expect(submoduleNavCtrl.refresh(null)).resolves.toBeUndefined();
  });

  it("leaves the strip empty rather than inventing a breadcrumb for nothing", async () => {
    await submoduleNavCtrl.refresh(null);
    expect(submoduleNavCtrl.path).toEqual([]);
    expect(submoduleNavCtrl.siblings).toEqual([]);
  });

  it("treats an empty-string repo the same way", async () => {
    await submoduleNavCtrl.refresh("");
    expect(submoduleNavCtrl.path).toEqual([]);
  });

  it("clears a strip that was already populated, so a closed repo can't leave one behind", async () => {
    submoduleNavCtrl.path = [{ name: "gitcat", absolutePath: "/repo", current: true }];
    await submoduleNavCtrl.refresh(null);
    expect(submoduleNavCtrl.path).toEqual([]);
  });

  // The no-repo guard must stay BELOW the `!IN_TAURI` branch. Design mode has no
  // repo at all (CUR_REPO is null there for the whole session — see
  // legacy/main.ts's own note on workdirAvailable), so a guard placed first
  // would empty the browser preview's demo strip instead of showing it.
  it("still shows the demo strip in design mode, where the repo is always null", async () => {
    mockInTauri = false;
    await submoduleNavCtrl.refresh(null);
    expect(submoduleNavCtrl.path.map((c) => c.name)).toEqual(["gitcat"]);
    expect(submoduleNavCtrl.siblings.length).toBeGreaterThan(0);
    expect(submoduleNavCtrl.visible).toBe(true);
    expect(commands.submoduleStatus).not.toHaveBeenCalled();
  });
});
