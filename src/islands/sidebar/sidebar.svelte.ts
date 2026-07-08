// Sidebar (refs tree + branch context menu) — controller (Svelte 5 runes
// singleton). Last of the four remaining legacy-UI migrations.
//
// Reads/mutates via the typed `commands` client (list_refs/checkout/
// create_branch/delete_branch — all already existed, this switches the raw
// `tinvoke` calls to the typed client like every other island). Peer-imports
// `resolver` directly (same shape as bisectDrawerCtrl peer-importing
// bisectCtrl) for the branch-menu's "Rebase current branch onto here" action
// — that entry point (added in commit 76f4cdd) must keep working unchanged.
//
// The branch context menu (`.ref-pop`) used to be an imperatively-appended
// `document.body` node with its own outside-click listener; here it's plain
// Svelte state (`menu`) positioned via inline style, closed via
// `<svelte:window onpointerdown>` in the view — same visual behavior, no
// manual DOM node lifecycle.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { resolver } from "../resolver/resolver.svelte.ts";
import { IN_TAURI } from "../../ipc/env";
import type { LocalBranch, SimpleRef, Snapshot } from "../../ipc/bindings";

// Demo data (design-mode only) — mirrors the static markup this replaces, so
// the browser preview still shows a populated sidebar without a real repo.
const DEMO_LOCALS: LocalBranch[] = [
  { name: "main", sha: "a1b2c3d", ahead: 2, behind: null },
  { name: "feat/inline-diff", sha: "b2c3d4e", ahead: null, behind: 3 },
  { name: "fix/lane-cull", sha: "c3d4e5f", ahead: null, behind: null },
  { name: "release/0.3", sha: "d4e5f60", ahead: null, behind: null },
];
const DEMO_REMOTES: SimpleRef[] = [
  { name: "origin/main", sha: "a1b2c3d" },
  { name: "origin/feat/inline-diff", sha: "b2c3d4e" },
  { name: "origin/topic/rerere", sha: "e5f6071" },
  { name: "upstream/main", sha: "f60718a" },
  { name: "upstream/dev", sha: "60718a9" },
];
const DEMO_TAGS: SimpleRef[] = [
  { name: "v0.3.0", sha: "a1b2c3d" },
  { name: "v0.2.0", sha: "718a9bc" },
  { name: "nightly-2026-07-05", sha: "18a9bcd" },
];

export type BranchMenu = { name: string; isCurrent: boolean; x: number; y: number };

class SidebarState {
  locals = $state<LocalBranch[]>([]);
  remotes = $state<SimpleRef[]>([]);
  tags = $state<SimpleRef[]>([]);
  head = $state<string | null>(null);
  snapshots = $state<Snapshot[]>([]);
  filter = $state("");
  busy = $state(false);
  menu = $state<BranchMenu | null>(null);
  newBranchOpen = $state(false);
  newBranchInput = $state("");
  // "" means branch from HEAD (the default create_branch already had) —
  // otherwise a local/remote ref name to pass as create_branch's start_point,
  // which the backend has supported since M2a; this just exposes it in the UI.
  newBranchFrom = $state("");

  async refresh(repo: string) {
    if (!IN_TAURI) {
      this.locals = DEMO_LOCALS;
      this.remotes = DEMO_REMOTES;
      this.tags = DEMO_TAGS;
      this.head = "main";
      bridge.updateBranchPill(this.head, this.locals);
      return;
    }
    if (!repo) return;
    try {
      const r = await commands.listRefs(repo);
      if (r.status !== "ok") {
        console.error("list_refs", r.error);
        return;
      }
      this.locals = r.data.locals || [];
      this.remotes = r.data.remotes || [];
      this.tags = r.data.tags || [];
      this.head = r.data.head;
      bridge.updateBranchPill(this.head, this.locals);
    } catch (e) {
      console.error("list_refs", e);
    }
  }

  setSnapshots(snaps: Snapshot[]) {
    this.snapshots = Array.isArray(snaps) ? snaps.slice() : [];
  }

  reset() {
    this.locals = [];
    this.remotes = [];
    this.tags = [];
    this.head = null;
    this.snapshots = [];
    this.menu = null;
  }

  async checkout(name: string) {
    if (!IN_TAURI) {
      bridge.tama.set("hint");
      bridge.tama.say("Checked out " + name + " (demo).");
      return;
    }
    if (this.busy) return;
    this.busy = true;
    bridge.tama.set("thinking");
    bridge.tama.say("Checking out " + name + "…");
    try {
      const res = await commands.checkout(bridge.CUR_REPO as unknown as string, name);
      if (res && res.ok) {
        await bridge.reloadGraph(true);
        bridge.tama.set("celebrate");
        bridge.tama.say("On " + name + " now. にゃ〜", 3200);
      } else {
        bridge.tama.warn((res && res.message) || "Couldn't check out " + name + " — you may have uncommitted changes.");
      }
    } catch (e) {
      bridge.tama.warn("Checkout failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
    }
  }

  // Check out a REMOTE branch (e.g. "origin/feature-x") — previously remote
  // rows in the sidebar were display-only, with no way to start working on
  // someone else's branch at all. Mirrors `git checkout <shortname>`'s own
  // DWIM: if a local branch with the short name already exists, just switch
  // to it (assume it's the one tracking this remote); otherwise create one
  // via create_branch's existing start_point param — git's default
  // branch.autoSetupMerge sets up tracking automatically since the start
  // point is a remote-tracking ref, no extra plumbing needed here.
  async checkoutRemote(remoteRef: string) {
    if (this.busy) return;
    const slash = remoteRef.indexOf("/");
    const shortName = slash >= 0 ? remoteRef.slice(slash + 1) : remoteRef;
    if (this.locals.some((b) => b.name === shortName)) {
      await this.checkout(shortName);
      return;
    }
    if (!IN_TAURI) {
      bridge.tama.set("hint");
      bridge.tama.say("Checked out " + shortName + " tracking " + remoteRef + " (demo).");
      return;
    }
    this.busy = true;
    bridge.tama.set("thinking");
    bridge.tama.say("Creating " + shortName + " to track " + remoteRef + "…");
    try {
      const res = await commands.createBranch(bridge.CUR_REPO as unknown as string, shortName, remoteRef, true);
      if (res && res.ok) {
        await bridge.reloadGraph(true);
        bridge.tama.set("celebrate");
        bridge.tama.say("On " + shortName + " now, tracking " + remoteRef + ". にゃ〜", 3200);
      } else {
        bridge.tama.warn((res && res.message) || "Couldn't check out " + remoteRef + ".");
      }
    } catch (e) {
      bridge.tama.warn("Checkout failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
    }
  }

  // Tauri's webview (WKWebView on macOS in particular) doesn't implement
  // window.prompt() — it returns null immediately with no dialog ever shown,
  // so the old prompt()-based flow silently did nothing. Swap it for an
  // inline input in the "＋ New branch…" row itself instead (same shape as
  // every other island's typed-input flow, just without a whole modal for
  // one field).
  startNewBranch() {
    this.newBranchInput = "";
    this.newBranchFrom = "";
    this.newBranchOpen = true;
  }

  cancelNewBranch() {
    this.newBranchOpen = false;
    this.newBranchInput = "";
    this.newBranchFrom = "";
  }

  async confirmNewBranch() {
    const name = this.newBranchInput.trim();
    if (!name) {
      this.cancelNewBranch();
      return;
    }
    const from = this.newBranchFrom || null; // "" (HEAD) -> null, same as create_branch's own default
    this.newBranchOpen = false;
    this.newBranchInput = "";
    this.newBranchFrom = "";
    if (!IN_TAURI) {
      bridge.tama.set("hint");
      bridge.tama.say("Created " + name + (from ? " from " + from : "") + " (demo).");
      return;
    }
    bridge.tama.set("thinking");
    bridge.tama.say("Creating " + name + "…");
    try {
      const res = await commands.createBranch(bridge.CUR_REPO as unknown as string, name, from, true);
      if (res && res.ok) {
        await bridge.reloadGraph(true);
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Branch " + name + " created.", 3200);
      } else {
        bridge.tama.warn((res && res.message) || "Couldn't create " + name + ".");
      }
    } catch (e) {
      bridge.tama.warn("Create failed — " + e);
      console.error(e);
    }
  }

  deleteBranch(name: string) {
    bridge.tama.set("danger");
    bridge.tama.say("Deleting " + name + " — type the branch name to arm it. I pin its tip first.", 6000);
    bridge.armDanger({
      title: "Delete branch — " + name,
      steps: false,
      desc: "This removes the local branch ref. Its tip is pinned to a backup first, so the commits stay recoverable by sha.",
      lose:
        '<h5>What happens</h5><ul><li>Removes local branch <code>' +
        esc(name) +
        "</code></li><li>Its tip is pinned under <code>refs/gitgui/deleted/…</code> — recover with ＋ New branch → the printed sha</li></ul>",
      note: "🔁 I pin the branch tip before deleting; ⌘Z restores your CURRENT branch position (not the deleted branch).",
      name,
      confirmLabel: "Delete branch",
      onConfirm: async () => {
        await this.doDeleteBranch(name, false);
      },
    });
  }

  private async doDeleteBranch(name: string, force: boolean) {
    if (!IN_TAURI) {
      bridge.tama.set("celebrate");
      bridge.tama.say("Deleted " + name + " (demo).");
      return;
    }
    try {
      let res = await commands.deleteBranch(bridge.CUR_REPO as unknown as string, name, force);
      if (res && !res.ok && !force && /not (fully )?merged/i.test(res.message || "")) {
        if (confirm(name + " is not fully merged. Force-delete anyway? (the tip is pinned to a backup)")) {
          res = await commands.deleteBranch(bridge.CUR_REPO as unknown as string, name, true);
        } else {
          bridge.tama.warn("Kept " + name + " — delete cancelled.");
          return;
        }
      }
      if (res && res.ok) {
        await bridge.reloadGraph(true);
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Deleted " + name + ".", 4200);
      } else {
        bridge.tama.warn((res && res.message) || "Couldn't delete " + name + ".");
      }
    } catch (e) {
      bridge.tama.warn("Delete failed — " + e);
      console.error(e);
    }
  }

  openMenu(name: string, isCurrent: boolean, anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect();
    this.menu = { name, isCurrent, x: Math.min(r.left, window.innerWidth - 168), y: r.bottom + 4 };
  }

  closeMenu() {
    this.menu = null;
  }

  async rebaseOnto(name: string) {
    if (!IN_TAURI) {
      resolver.openDemo(name, "rebase"); // ---- design-mode demo ----
      return;
    }
    await resolver.startRebase(bridge.CUR_REPO as unknown as string, name); // ---- real rebase (Svelte island) ----
  }
}

function esc(s: unknown): string {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
}

export const sidebarCtrl = new SidebarState();
