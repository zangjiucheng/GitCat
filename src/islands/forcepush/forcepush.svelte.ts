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
// No Safety Manager snapshot on success: force-push's entire risk lives on the
// REMOTE side (see git_remote.rs's module doc) — nothing local for Undo to
// protect. It DOES move the local remote-tracking ref (origin/<branch>) to match
// your local branch, though, so like doPush()/pushBranch() it reloadGraph()s
// after success to move the origin/* label and reset the branch pill's ahead/
// behind live (the incremental refresh keeps this cheap — no local commits
// change). Reachable from ⌘K and, for the current branch, the sidebar/graph
// branch right-click menu (Sidebar.svelte wires those to forcePushCtrl).

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";
import { sidebarCtrl } from "../sidebar/sidebar.svelte.ts";
import { ICON_BACKUP, ICON_WARNING } from "../../legacy/icons";
import { t, be } from "@/i18n/i18n.svelte.ts";

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
      bridge.tama.warn(t("forcepush.open_repo_first"));
      return;
    }
    const branch = sidebarCtrl.head;
    if (!branch) {
      bridge.tama.warn(t("forcepush.no_branch"));
      return;
    }
    bridge.tama.set("danger");
    if (lease) {
      bridge.tama.say(t("forcepush.arm_say_lease", { branch }), 6000);
      bridge.armDanger({
        title: t("forcepush.title_lease", { branch }),
        steps: false,
        desc: t("forcepush.desc_lease", { branch }),
        lose: t("forcepush.lose_lease", { branch: esc(branch) }),
        note: ICON_BACKUP + " " + t("forcepush.note_lease"),
        name: branch,
        confirmLabel: t("forcepush.confirm_lease"),
        onConfirm: async () => {
          await this.doForcePush(repo, true, branch);
        },
      });
    } else {
      bridge.tama.say(t("forcepush.arm_say_override", { branch }), 6000);
      bridge.armDanger({
        title: t("forcepush.title_override", { branch }),
        steps: false,
        desc: t("forcepush.desc_override", { branch }),
        lose: t("forcepush.lose_override", { branch: esc(branch) }),
        note: ICON_WARNING + " " + t("forcepush.note_override"),
        name: branch,
        confirmLabel: t("forcepush.confirm_override"),
        onConfirm: async () => {
          await this.doForcePush(repo, false, branch);
        },
      });
    }
  }

  private async doForcePush(repo: string, lease: boolean, branch: string) {
    if (!IN_TAURI) {
      bridge.tama.set("celebrate");
      bridge.tama.say(t("forcepush.demo_pushed", { branch }));
      return;
    }
    if (this.busy) return;
    this.busy = true;
    bridge.tama.set("thinking");
    bridge.tama.say(t("forcepush.pushing", { branch }));
    try {
      const res = await commands.forcePush(repo, lease);
      if (res && res.ok) {
        // Force push moves the local remote-tracking ref (origin/<branch>) to
        // match your local branch, so reloadGraph (not just sidebarCtrl.refresh)
        // to move the origin/* label and reset the branch pill's ahead/behind
        // live — same as doPush()/pushBranch(). Cheap: no local commits change.
        await bridge.reloadGraph(true);
        bridge.tama.set("celebrate");
        bridge.tama.say(be(res.message) || t("forcepush.pushed", { branch }), 3200);
      } else {
        bridge.tama.warn(be(res && res.message) || t("forcepush.failed"));
      }
    } catch (e) {
      bridge.tama.warn(t("forcepush.failed_e", { error: String(e) }));
      console.error(e);
    } finally {
      this.busy = false;
    }
  }
}

export const forcePushCtrl = new ForcePushState();
