// Tests for the three menu items every file row shares.
//
// Same isolation strategy as clipboard.test.ts, and for the same reason: the
// copy items pull in legacy/clipboard -> sound -> settings -> legacy/bridge,
// and an unmocked bridge evaluates legacy/main.ts, which wants a real #cv
// canvas.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  applyThemeMode: vi.fn(),
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: { revealPathInFileManager: vi.fn(async () => ({ status: "ok", data: null })) },
}));

import { commands } from "../../ipc/bindings";
import { contextMenuCtrl } from "./contextmenu.svelte.ts";
import { filePathMenuItems } from "./fileitems.ts";

function byId(items: ReturnType<typeof filePathMenuItems>, id: string) {
  const found = items.find((i) => i.id === id);
  if (!found) throw new Error(`no item ${id}`);
  return found;
}

describe("filePathMenuItems", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
  });

  it("is the same three items, in the same order, wherever it is used", () => {
    expect(filePathMenuItems("/repo", "src/a.ts").map((i) => i.id)).toEqual(["reveal", "copy-path", "copy-full-path"]);
  });

  // These are appended after a surface's own actions, so the divider belongs
  // on the first of them — not on whatever happens to precede it.
  it("starts a new group", () => {
    const items = filePathMenuItems("/repo", "src/a.ts");
    expect(byId(items, "reveal").separatorBefore).toBe(true);
    expect(byId(items, "copy-path").separatorBefore).toBeFalsy();
  });

  it("copies git's own relative spelling, and the joined absolute path", () => {
    const items = filePathMenuItems("/repo", "src/a.ts");
    byId(items, "copy-path").run();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("src/a.ts");
    byId(items, "copy-full-path").run();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("/repo/src/a.ts");
  });

  it("reveal hands the backend the repo and the relative path, not a pre-joined one", () => {
    byId(filePathMenuItems("/repo", "src/a.ts"), "reveal").run();
    expect(commands.revealPathInFileManager).toHaveBeenCalledWith("/repo", "src/a.ts");
  });

  // `onDisk: false` is the commit-deleted-this-file case. Disabled, not
  // dropped, so the menu keeps its shape between rows.
  it("disables reveal when the file is not on disk, leaving both copies live", () => {
    const items = filePathMenuItems("/repo", "gone.ts", { onDisk: false });
    expect(byId(items, "reveal").disabled).toBe(true);
    expect(byId(items, "copy-path").disabled).toBeFalsy();
    expect(byId(items, "copy-full-path").disabled).toBeFalsy();
    contextMenuCtrl.open(items, 0, 0);
    contextMenuCtrl.run(byId(items, "reveal"));
    expect(commands.revealPathInFileManager).not.toHaveBeenCalled();
    contextMenuCtrl.close();
  });

  // No repo means nothing to reveal INTO — possible for a frame while a repo
  // is being opened or closed.
  it("disables reveal when there is no repo", () => {
    expect(byId(filePathMenuItems("", "src/a.ts"), "reveal").disabled).toBe(true);
  });
});
