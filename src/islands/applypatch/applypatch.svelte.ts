// Apply Patch — controller (Svelte 5 runes singleton).
//
// Tools-menu/⌘K "Apply Patch…" fronting patch.rs's `apply_patch`
// (`git am --3way`). No island UI of its own — same "just a Tools-menu/⌘K
// entry point, the shared chrome does the rest" shape as forcepush.svelte.ts
// (which also has no companion .svelte file): picks a file via
// @tauri-apps/plugin-dialog's `open()` (file mode, single-select — a mailbox
// blob is always ONE file even for a multi-commit range, see patch.rs's own
// module doc on why `git am` natively handles many "From " message
// boundaries inside a single file), calls the backend, then hands the result
// to the SAME shared resolver.svelte.ts conflict UI every other conflict-
// producing op (cherry-pick/merge/rebase/revert/stash/merge-squash) already
// uses — via `resolver.openFromResult(repo, res, "", "am")`.
//
// `""` for `sha`: an apply_patch call is keyed by a patch FILE, not a single
// commit — it may apply many — so there's no one sha to show in the
// resolver's title/banner the way cherry-pick/merge/revert have (see
// resolver.svelte.ts's MSG.am entry, which never references `sha` either).
//
// The "am" op tag is what makes `abort()`/`continue()`/`skip()` dispatch to
// `git am --abort`/`--continue`/`--skip` (via resolver.svelte.ts's `OPS.am`/
// `SKIP_OPS.am`) rather than `git rebase --abort`/`--continue` — mirrors
// patch.rs's own module doc: the two are EMPIRICALLY CONFIRMED not
// interchangeable against an am-created conflict, even though both share the
// same `.git/rebase-apply` directory.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";
import { resolver } from "../resolver/resolver.svelte.ts";
import { open } from "@tauri-apps/plugin-dialog";

class ApplyPatchState {
  busy = $state(false);

  // Entry point (Tools menu / ⌘K).
  async applyPatch(repo: string): Promise<void> {
    if (this.busy) return;
    if (!repo) {
      bridge.tama.warn("Open a repository first.");
      return;
    }
    if (!IN_TAURI) {
      bridge.tama.set("celebrate");
      bridge.tama.say("Applied patch (demo).");
      return;
    }
    let picked: string | string[] | null;
    try {
      picked = await open({
        title: "Apply Patch",
        multiple: false,
        filters: [{ name: "Patch files", extensions: ["patch", "mbox", "eml", "txt"] }],
      });
    } catch (e) {
      bridge.tama.warn("Could not open the file dialog — " + e);
      console.error(e);
      return;
    }
    if (!picked || Array.isArray(picked)) return; // cancelled (Array.isArray is defensive-only — multiple:false never returns one)
    this.busy = true;
    bridge.tama.set("thinking");
    bridge.tama.say("Applying patch…");
    bridge.tama.event("mutation.caution", { count: 1 });
    try {
      const res = await commands.applyPatch(repo, picked);
      await resolver.openFromResult(repo, res, "", "am");
    } catch (e) {
      bridge.tama.warn("Apply patch failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
    }
  }
}

export const applyPatchCtrl = new ApplyPatchState();
