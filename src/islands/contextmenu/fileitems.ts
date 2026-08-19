// The three menu items every file row gets, wherever the row lives.
//
// Both file lists in the app — a commit's changed files (Detail) and the
// working tree (Workdir) — want exactly these, in exactly this order, and
// each already has its own unrelated actions to put above them. Building the
// trio here means the wording, the ordering, the divider and the
// disabled rules are decided once instead of drifting apart between two
// surfaces that look identical to a user.

import { t } from "../../i18n/i18n.svelte.ts";
import { commands } from "../../ipc/bindings";
import { copyToClipboard } from "../../legacy/clipboard.ts";
import { joinRepoPath } from "../../legacy/paths.ts";
import { revealLabelKey } from "../../legacy/platform.ts";
import type { ContextMenuItem } from "./contextmenu.svelte.ts";

/**
 * Reveal / copy path / copy full path for `relative` inside `repo`.
 *
 * `relative` is git's own spelling (repo-relative, forward slashes) — the
 * form both file lists already hold. It is handed to the backend as-is
 * rather than pre-joined: the join, and the check that it cannot escape the
 * repo, belong on the side that will act on it (see `file_manager.rs`).
 *
 * `onDisk` is false for a file the selected commit DELETED. There is nothing
 * to show for those, so reveal is disabled — but kept visible, so the menu
 * does not change shape from row to row and the items below it do not move
 * under the cursor. Copying a deleted file's path stays useful, and often is
 * exactly what you wanted it for.
 */
export function filePathMenuItems(repo: string, relative: string, opts: { onDisk?: boolean } = {}): ContextMenuItem[] {
  const onDisk = opts.onDisk !== false;
  return [
    {
      id: "reveal",
      label: t(revealLabelKey()),
      // The trio always follows a surface's own actions, so the group break
      // belongs here rather than on whatever happens to come before it.
      separatorBefore: true,
      disabled: !onDisk || !repo,
      run: () => void commands.revealPathInFileManager(repo, relative),
    },
    { id: "copy-path", label: t("common.copy_path"), run: () => copyToClipboard(relative) },
    { id: "copy-full-path", label: t("common.copy_full_path"), run: () => copyToClipboard(joinRepoPath(repo, relative)) },
  ];
}
