// The topbar repo chip's right-click menu.
//
// GitCat has no repo tabs to hang this on — one repo per window, by design
// (see src-tauri/src/windows.rs) — so the chip that names the open repo is
// where the repo-level actions live.

import { t } from "../../i18n/i18n.svelte.ts";
import { openDir } from "./filemanager.ts";
import { copyToClipboard } from "../../legacy/clipboard.ts";
import { openDirLabelKey } from "../../legacy/platform.ts";
import { terminalCtrl } from "../terminal/terminal.svelte.ts";
import type { ContextMenuItem } from "./contextmenu.svelte.ts";

/**
 * Terminal / open in file manager / copy path, for the currently open repo.
 *
 * Empty when no repo is open: the chip is a "pick a repo" button then, and
 * every action here would apply to nothing. `contextMenuCtrl.open([])` is a
 * no-op, so the right-click simply produces no menu rather than a box of
 * dead entries.
 */
export function repoMenuItems(repo: string): ContextMenuItem[] {
  if (!repo) return [];
  return [
    {
      id: "terminal",
      // The built-in drawer, not an OS terminal window. GitCat replaced the
      // old shell-out-to-Terminal.app action with this on purpose (see
      // src-tauri/src/terminal.rs's module doc); a menu entry that launched
      // an external terminal would quietly undo that.
      label: t("menu.open_terminal"),
      run: () => void terminalCtrl.toggle(repo),
    },
    {
      id: "open-dir",
      label: t(openDirLabelKey()),
      // open_path, not reveal: a repo is a folder you want to be inside.
      // Revealing a directory opens its PARENT with the repo selected.
      //
      // The empty relative is the repo itself — the same command a folder row
      // uses, so the two cannot drift apart (see diritems.ts).
      run: () => void openDir(repo, ""),
    },
    { id: "copy-path", label: t("common.copy_path"), run: () => copyToClipboard(repo) },
  ];
}
