// Force push — controller (Svelte 5 runes singleton).
//
// Two separately-armed danger flows fronting git_remote.rs's `force_push` —
// that module's own doc comment names this file directly as its sanctioned
// "never force, except here" exception: a branch that's been rebased/amended
// AFTER already being pushed (a routine result of this app's own
// rebase/amend features) otherwise has NO way to publish its rewritten
// history at all, since plain `push` always rejects it as non-fast-forward.
//
// Reuses the SAME shared single-step typed-confirm scrim as delete-branch/
// remove-submodule/deinit-submodule (`bridge.armDanger` — see
// sidebar.svelte.ts's own call sites for the copywriting/structure model)
// rather than a bespoke modal: unlike filter-repo (which needed its own
// separate multi-step wizard because ordinary Safety Manager undo cannot
// protect against it — see filterrepo.svelte.ts's own doc comment),
// force-push never touches local HEAD/branch/working-tree state at all, so
// the existing armDanger scrim is already the right-sized tool for it.
//
// Deliberately TWO entry points, not one flow with a checkbox:
// `forcePushLease` (--force-with-lease: refuses cleanly if the remote moved
// since GitCat's own last fetch) and `forcePushOverride` (raw --force:
// unconditional, can discard other people's already-pushed commits with zero
// recovery path from inside GitCat) each arm their OWN differently-worded
// scrim, with a different typed-confirm title/copy/confirmLabel — so a user
// can never reach raw force by fat-fingering the lease flow's confirm box.
// Both ultimately call the SAME backend command, `force_push(path, lease)`;
// `lease` is the only thing that differs backend-side.
//
// No Safety Manager snapshot and no `bridge.reloadGraph` on success: exactly
// like plain `push`/doPush() in legacy/main.ts, force-push's entire risk
// lives on the REMOTE side (see git_remote.rs's module doc) — nothing local
// changes, so there's nothing local for Undo to protect and no local graph
// state to reload. Only `sidebarCtrl.refresh` runs after a success, mirroring
// doPush()'s own exact post-success call. The existing topbar Push
// button/doPush() itself is completely untouched by this file — these two
// actions are Tools-menu/⌘K-only entry points (see menu.rs, cmdk.svelte.ts,
// and main.ts's "menu-action" switch), following the exact wiring precedent
// resolver.svelte.ts's `pullMerge`/`pullRebase` established for the previous
// backlog item.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";
import { sidebarCtrl } from "../sidebar/sidebar.svelte.ts";

function esc(s: unknown): string {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
}

class ForcePushState {
  busy = $state(false);

  // "Force Push (Safe)" — --force-with-lease. Still gated behind armDanger
  // (a diverged local history can discard commits even with a lease), but
  // the SAFER of the two: refuses instead of overwriting whenever the remote
  // holds anything this repo doesn't already know about.
  forcePushLease(repo: string) {
    this.arm(repo, true);
  }

  // "Force Push (Override Remote)" — raw --force. Unconditional: can
  // permanently discard commits someone else already pushed, with no
  // recovery path from inside GitCat (Safety Manager/Undo only ever
  // protects THIS repo's own local refs, never anything already on a
  // remote).
  forcePushOverride(repo: string) {
    this.arm(repo, false);
  }

  private arm(repo: string, lease: boolean) {
    if (this.busy) return;
    if (!repo) {
      bridge.tama.warn("Open a repository first.");
      return;
    }
    const branch = sidebarCtrl.head;
    if (!branch) {
      bridge.tama.warn("HEAD isn't on a branch — nothing to force-push.");
      return;
    }
    bridge.tama.set("danger");
    if (lease) {
      bridge.tama.say(
        "Force-pushing " + branch + " — type the branch name to arm it. This refuses if the remote moved since my last fetch.",
        6000,
      );
      bridge.armDanger({
        title: "Force push (safe) — " + branch,
        steps: false,
        desc:
          "This overwrites " +
          branch +
          "'s position on the remote with your local history — the usual fix after rebasing or amending a commit you'd already pushed. Unlike a raw force, it refuses instead of overwriting if the remote has anything this repo doesn't already know about (e.g. someone else pushed since your last fetch).",
        lose:
          "<h5>What happens</h5><ul><li>Overwrites <code>" +
          esc(branch) +
          "</code> on the remote to match your local branch</li><li>Refuses cleanly, with no changes made, if the remote moved since your last fetch — fetch and reconcile first, then retry</li><li>Nothing local changes — HEAD, your branch, and your working tree are untouched</li></ul>",
        note:
          "🔁 This only touches the REMOTE — there's nothing local for ⌘Z/Undo to protect here. If it succeeds and it did overwrite prior remote commits, they have no in-app recovery path.",
        name: branch,
        confirmLabel: "Force push",
        onConfirm: async () => {
          await this.doForcePush(repo, true, branch);
        },
      });
    } else {
      bridge.tama.say(
        "Force-pushing " + branch + " — type the branch name to arm it. This overwrites the remote NO MATTER WHAT is there.",
        6000,
      );
      bridge.armDanger({
        title: "Force push — override remote — " + branch,
        steps: false,
        desc:
          "This unconditionally overwrites " +
          branch +
          " on the remote with your local history, even if someone else has pushed commits your local repo doesn't have. Those commits can be permanently discarded with NO recovery path from inside GitCat — only use this if you're certain nobody else's work is on the line.",
        lose:
          "<h5>What happens</h5><ul><li>Overwrites <code>" +
          esc(branch) +
          "</code> on the remote to match your local branch, no matter what is currently there</li><li>Any commits on the remote that your local repo doesn't have are discarded, permanently, the moment this succeeds</li><li>Nothing local changes — HEAD, your branch, and your working tree are untouched</li></ul>",
        note:
          "⚠️ This can destroy OTHER PEOPLE'S work on the remote with no way back from inside GitCat — Safety Manager/Undo only ever protects this repo's own LOCAL refs, never anything already pushed. Prefer Force Push (Safe) unless you specifically need to override someone else's changes.",
        name: branch,
        confirmLabel: "Force push (override)",
        onConfirm: async () => {
          await this.doForcePush(repo, false, branch);
        },
      });
    }
  }

  private async doForcePush(repo: string, lease: boolean, branch: string) {
    if (!IN_TAURI) {
      bridge.tama.set("celebrate");
      bridge.tama.say("Force-pushed " + branch + " (demo).");
      return;
    }
    if (this.busy) return;
    this.busy = true;
    bridge.tama.set("thinking");
    bridge.tama.say("Force-pushing " + branch + "…");
    try {
      const res = await commands.forcePush(repo, lease);
      if (res && res.ok) {
        await sidebarCtrl.refresh(repo);
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Force-pushed " + branch + ".", 3200);
      } else {
        bridge.tama.warn((res && res.message) || "Force push failed.");
      }
    } catch (e) {
      bridge.tama.warn("Force push failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
    }
  }
}

export const forcePushCtrl = new ForcePushState();
