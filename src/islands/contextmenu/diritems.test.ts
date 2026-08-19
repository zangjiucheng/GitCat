// Tests for the three menu items every folder row shares.
//
// Same isolation strategy as fileitems.test.ts, and for the same reason: the
// copy items pull in legacy/clipboard -> sound -> settings -> legacy/bridge,
// and an unmocked bridge evaluates legacy/main.ts, which wants a real #cv
// canvas.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  applyThemeMode: vi.fn(),
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: { openDirInFileManager: vi.fn(async () => ({ status: "ok", data: null })) },
}));

import { commands } from "../../ipc/bindings";
import { dirPathMenuItems } from "./diritems.ts";

function byId(items: ReturnType<typeof dirPathMenuItems>, id: string) {
  const found = items.find((i) => i.id === id);
  if (!found) throw new Error(`no item ${id}`);
  return found;
}

describe("dirPathMenuItems", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
  });

  it("is the same three items, in the same order, wherever it is used", () => {
    expect(dirPathMenuItems("/repo", "src/islands").map((i) => i.id)).toEqual(["open-dir", "copy-path", "copy-full-path"]);
  });

  // These are appended after a surface's own actions, so the divider belongs
  // on the first of them. ContextMenu.svelte drops it when they are the only
  // group, which is Detail's folder rows.
  it("starts a new group", () => {
    const items = dirPathMenuItems("/repo", "src/islands");
    expect(byId(items, "open-dir").separatorBefore).toBe(true);
    expect(byId(items, "copy-path").separatorBefore).toBeFalsy();
  });

  it("copies the relative folder path, and the joined absolute one", () => {
    const items = dirPathMenuItems("/repo", "src/islands");
    byId(items, "copy-path").run();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("src/islands");
    byId(items, "copy-full-path").run();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("/repo/src/islands");
  });

  it("hands the backend the repo and the relative path, not a pre-joined one", () => {
    byId(dirPathMenuItems("/repo", "src/islands"), "open-dir").run();
    expect(commands.openDirInFileManager).toHaveBeenCalledWith("/repo", "src/islands");
  });

  // A folder is OPENED, not revealed — the two verbs differ, and so does the
  // command. Revealing would open the folder's parent with it merely
  // selected, which is the wrong place to be left.
  it("opens the folder rather than revealing it in its parent", () => {
    expect(byId(dirPathMenuItems("/repo", "src"), "open-dir").id).toBe("open-dir");
    expect(dirPathMenuItems("/repo", "src").some((i) => i.id === "reveal")).toBe(false);
  });

  // No repo means there is nothing to open — possible for a frame while a
  // repo is being opened or closed.
  it("disables the open item when there is no repo", () => {
    expect(byId(dirPathMenuItems("", "src"), "open-dir").disabled).toBe(true);
  });

  // Unlike a file row's trio there is no disabled-because-missing case: a
  // folder node exists exactly when something under it does.
  it("never disables a folder for being absent", () => {
    const items = dirPathMenuItems("/repo", "src/islands");
    expect(items.every((i) => !i.disabled)).toBe(true);
  });
});
