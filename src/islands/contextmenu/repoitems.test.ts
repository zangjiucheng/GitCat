// Tests for the topbar repo chip's right-click menu.
//
// Same isolation reasoning as fileitems.test.ts: the copy item reaches
// legacy/clipboard -> sound -> settings -> legacy/bridge, and an unmocked
// bridge evaluates legacy/main.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../legacy/bridge", () => ({
  applyThemeMode: vi.fn(),
  tama: { set: vi.fn(), say: vi.fn(), warn: vi.fn(), event: vi.fn() },
}));

vi.mock("../../ipc/bindings", () => ({
  commands: { openDirInFileManager: vi.fn(async () => ({ status: "ok", data: null })) },
}));

vi.mock("../terminal/terminal.svelte.ts", () => ({
  terminalCtrl: { toggle: vi.fn(async () => {}) },
}));

import { commands } from "../../ipc/bindings";
import { terminalCtrl } from "../terminal/terminal.svelte.ts";
import { repoMenuItems } from "./repoitems.ts";

function byId(items: ReturnType<typeof repoMenuItems>, id: string) {
  const found = items.find((i) => i.id === id);
  if (!found) throw new Error(`no item ${id}; got ${items.map((i) => i.id).join(", ")}`);
  return found;
}

describe("repoMenuItems", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
  });

  it("offers a terminal, the file manager, and the path", () => {
    expect(repoMenuItems("/repo").map((i) => i.id)).toEqual(["terminal", "open-dir", "copy-path"]);
  });

  // The built-in drawer, not an OS terminal window. GitCat replaced the
  // shell-out deliberately (see src-tauri/src/terminal.rs's module doc), and a
  // menu item that reopened that decision would be a regression in disguise.
  it("opens the built-in terminal at the repo", () => {
    byId(repoMenuItems("/repo"), "terminal").run();
    expect(terminalCtrl.toggle).toHaveBeenCalledWith("/repo");
  });

  // open, not reveal: a repo is a folder you want to land inside, whereas
  // revealing a directory opens its PARENT with the repo merely selected.
  //
  // The empty relative is what makes the repo chip and a folder row share one
  // command — see diritems.ts. Pinned here so a later "tidy up the unused
  // argument" cannot silently split them apart again.
  it("opens the repo folder itself, via the same command a folder row uses", () => {
    byId(repoMenuItems("/repo"), "open-dir").run();
    expect(commands.openDirInFileManager).toHaveBeenCalledWith("/repo", "");
  });

  it("copies the repo's own absolute path", () => {
    byId(repoMenuItems("C:\\Users\\me\\proj"), "copy-path").run();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("C:\\Users\\me\\proj");
  });

  // With no repo open the chip is a "pick a repo" button, and every item here
  // would act on nothing. An empty list means contextMenuCtrl.open() is a
  // no-op, so the right-click falls through to no menu at all rather than a
  // box of dead entries.
  it("has nothing to offer when no repo is open", () => {
    expect(repoMenuItems("")).toEqual([]);
    expect(repoMenuItems(null as unknown as string)).toEqual([]);
  });
});
