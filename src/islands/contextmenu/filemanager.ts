// The two file-manager menu actions, with their errors actually shown.
//
// Both commands can genuinely fail — most often on a file from an older commit
// that is no longer on disk, where the OS file manager refuses the path. The
// menu items used to `void` the promise, so that case did nothing at all: the
// menu closed, no window opened, and no explanation appeared. Warning through
// Tama matches how every other failed command in this app reports itself.
//
// Shared by all three item builders rather than repeated in each, since the
// open half has two callers (a folder row and the topbar repo chip).

import { be, t } from "../../i18n/i18n.svelte.ts";
import * as bridge from "../../legacy/bridge";
import { commands } from "../../ipc/bindings";

/** Open the containing folder with `relative` selected. */
export async function revealPath(repo: string, relative: string): Promise<void> {
  const r = await commands.revealPathInFileManager(repo, relative);
  if (r.status === "error") bridge.tama.warn(t("common.warn_reveal_failed", { reason: be(r.error) }));
}

/** Open a directory itself — `relative` empty means the repository. */
export async function openDir(repo: string, relative: string): Promise<void> {
  const r = await commands.openDirInFileManager(repo, relative);
  if (r.status === "error") bridge.tama.warn(t("common.warn_open_dir_failed", { reason: be(r.error) }));
}
