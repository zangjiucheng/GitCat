// The path items every FOLDER row gets, wherever the row lives.
//
// The sibling of fileitems.ts, and split from it for one reason: a folder
// takes a different verb. See legacy/platform.ts — revealing a file opens the
// folder containing it with the file selected, which is what you want for a
// file and never what you want for a folder. A folder is a place you go
// INSIDE. Same reason `openDirLabelKey` is its own family of strings.
//
// Both file trees have folder rows (Detail's commit tree, and Workdir's
// staged and unstaged trees), and each already has its own actions to put
// above these, so the trio is built once here for the same reason the file
// one is.

import { t } from "../../i18n/i18n.svelte.ts";
import { commands } from "../../ipc/bindings";
import { copyToClipboard } from "../../legacy/clipboard.ts";
import { joinRepoPath } from "../../legacy/paths.ts";
import { openDirLabelKey } from "../../legacy/platform.ts";
import type { ContextMenuItem } from "./contextmenu.svelte.ts";

/**
 * Open / copy path / copy full path for the folder at `relative` inside
 * `repo`.
 *
 * `relative` is a tree node's own path: repo-relative, forward slashes, no
 * trailing slash — the form both trees already build their nodes with. It is
 * handed to the backend as-is rather than pre-joined, so the join and the
 * check that it cannot escape the repo stay on the side that acts on it (see
 * `file_manager.rs`).
 *
 * Unlike a file row's trio there is no disabled case: a folder in either tree
 * is on disk by construction. A commit's tree can contain a file the commit
 * DELETED, but not a folder that is not there — the tree is built from the
 * paths of the files in it, so a folder exists exactly when something under
 * it does.
 */
export function dirPathMenuItems(repo: string, relative: string): ContextMenuItem[] {
  return [
    {
      id: "open-dir",
      label: t(openDirLabelKey()),
      // The trio always follows a surface's own actions, so the group break
      // belongs here rather than on whatever happens to come before it.
      separatorBefore: true,
      disabled: !repo,
      run: () => void commands.openDirInFileManager(repo, relative),
    },
    { id: "copy-path", label: t("common.copy_path"), run: () => copyToClipboard(relative) },
    { id: "copy-full-path", label: t("common.copy_full_path"), run: () => copyToClipboard(joinRepoPath(repo, relative)) },
  ];
}
