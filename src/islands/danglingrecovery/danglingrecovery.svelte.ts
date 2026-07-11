// fsck-based dangling-object recovery (backlog #13) — controller (Svelte 5
// runes singleton).
//
// Structural mirror of Reflog Rescue (reflog.svelte.ts): a real .scrim/.modal,
// opened on demand (Tools menu / ⌘K — see menu.rs/cmdk.svelte.ts). `refresh`
// is the public, idempotent, safely-repeatable hook `show()` calls, so the
// list is always live rather than however stale it was the last time this was
// open — same discipline as every other on-demand modal in this app.
//
// THE ONE DELIBERATE DIFFERENCE from Reflog Rescue's own recovery action
// (`reflogRestore`, which moves HEAD/the current branch via `reset --hard`):
// a dangling commit found via fsck has no existing relationship to the
// current branch the way a reflog entry does, so recovering it must NEVER
// move HEAD/the current branch out from under the user. The recovery action
// here is instead `commands.createBranch(repo, name, sha, false)` — the
// EXISTING create-branch command, called with `checkout` hardcoded to
// `false` (unlike commitmenu.svelte.ts's own "Create branch here…" flow,
// which always passes `checkout:true` for its own "create + immediately
// switch to it" convention) — this just makes the recovered history reachable
// again via a fresh branch name, full stop. See fsck.rs's own module doc for
// why plain `create_branch` is sufficient with no new backend command.
//
// Per-row inline "Recover as new branch…" form mirrors remotes.svelte.ts's
// startRename/cancelRename/confirmRename shape exactly (its own `busyTarget`
// keyed by sha, for a per-row spinner) — with one addition: startRecover
// seeds the input with a SUGGESTED default name (`recovered/<short-sha>`)
// rather than starting blank, since a dangling commit's sha (unlike an
// existing remote/branch name being renamed) isn't something a user would
// otherwise think to type — mirrors commitmenu.svelte.ts's own "Create branch
// here…" step's inline-input-with-a-sensible-default shape, per this backlog
// item's own brief.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";
import type { DanglingCommit } from "../../ipc/bindings";

// Canned demo rows (design-mode only) — same spirit as reflog.svelte.ts's own
// DEMO constant, so the browser preview still shows a populated modal without
// a real backend.
const DEMO: DanglingCommit[] = [
  {
    sha: "a1b2c3da1b2c3da1b2c3da1b2c3da1b2c3da1b2",
    shortSha: "a1b2c3d",
    subject: "WIP: experiment with a new auth flow",
    an: { n: "You", e: "you@example.com", t: 0 },
  },
  {
    sha: "e4f5061e4f5061e4f5061e4f5061e4f5061e4f5",
    shortSha: "e4f5061",
    subject: "quick fix before the demo (discarded by a hard reset)",
    an: { n: "You", e: "you@example.com", t: 0 },
  },
];

class DanglingRecoveryState {
  open = $state(false);
  loading = $state(false); // refresh() in flight
  error = $state("");
  commits = $state<DanglingCommit[]>([]);
  truncated = $state(false); // hit the backend's defensive MAX_DANGLING cap
  demo = $state(false);

  // Per-row inline "Recover as new branch…" form — same shape as
  // remotes.svelte.ts's renamingName/renameInput, keyed by the dangling
  // commit's full sha (stable identity; short shas could theoretically
  // collide, however unlikely).
  recoveringSha = $state<string | null>(null);
  branchName = $state("");
  busy = $state(false); // re-entrancy guard for the createBranch call in flight
  busyTarget = $state<string | null>(null); // which sha, for a per-row spinner

  repo = "";

  // Entry point (Tools menu / ⌘K). Always re-fetches — see refresh()'s own
  // "never stale" doc above.
  show(repo: string | null): void {
    this.open = true;
    void this.refresh(repo);
  }

  close(): void {
    if (this.busy) return; // mid-recover — same guard as every other modal's Escape handler
    this.open = false;
    this.cancelRecover();
  }

  // ── public refresh hook — safe to call repeatedly / with repo:null, same
  // contract as reflogCtrl.refresh/remotesCtrl.refresh.
  async refresh(repo: string | null): Promise<void> {
    this.repo = repo ?? "";
    this.loading = true;
    try {
      if (!IN_TAURI) {
        // design-mode preview: no backend, seed the canned demo list.
        this.demo = true;
        this.error = "";
        this.commits = DEMO.map((c) => ({ ...c }));
        this.truncated = false;
        return;
      }
      this.demo = false;

      if (!this.repo) {
        this.commits = [];
        this.truncated = false;
        this.error = "";
        return;
      }

      try {
        const r = await commands.danglingCommits(this.repo);
        if (r.status === "ok") {
          this.commits = r.data.commits;
          this.truncated = r.data.truncated;
          this.error = "";
        } else {
          this.commits = [];
          this.truncated = false;
          this.error = String(r.error ?? "Could not run git fsck.");
        }
      } catch (e) {
        this.commits = [];
        this.truncated = false;
        this.error = "Could not run git fsck — " + e;
      }
    } finally {
      this.loading = false;
    }
  }

  // Opens the inline "Recover as new branch…" form for one row, seeded with a
  // suggested default name — see module doc for why (unlike
  // remotes.svelte.ts's startRename, which seeds the input with the name
  // being edited, there is no existing name here to reuse; a raw sha is not a
  // useful starting point for a human-chosen branch name).
  startRecover(c: DanglingCommit): void {
    if (this.busy) return;
    this.recoveringSha = c.sha;
    this.branchName = "recovered/" + c.shortSha;
  }

  cancelRecover(): void {
    this.recoveringSha = null;
    this.branchName = "";
  }

  // Mirrors commitmenu.svelte.ts's confirmBranch (blank-name guard, demo-mode
  // message, keep-the-form-open-and-spinnered while busy, reloadGraph+cheer
  // on success) with the ONE difference this backlog item calls for:
  // `checkout` is always `false` — see module doc for why recovering a
  // dangling commit must never move HEAD/the current branch.
  async confirmRecover(): Promise<void> {
    const sha = this.recoveringSha;
    if (!sha) return;
    const name = this.branchName.trim();
    if (!name) {
      this.cancelRecover();
      return;
    }
    if (this.busy) return;
    const commit = this.commits.find((c) => c.sha === sha);
    const shortSha = commit?.shortSha ?? sha.slice(0, 7);

    if (this.demo) {
      // Design-mode preview: fake the mutation locally, no IPC call — mirrors
      // reflogCtrl.restore's/commitmenu's own demo-mode conventions.
      this.cancelRecover();
      bridge.tama.set("celebrate");
      bridge.tama.say("Recovered " + shortSha + " as " + name + " (demo).", 4200);
      return;
    }

    if (!this.repo) {
      bridge.tama.warn("Open a repository first.");
      return;
    }

    this.busy = true;
    this.busyTarget = sha;
    bridge.tama.set("thinking");
    bridge.tama.say("Recovering " + shortSha + " as " + name + "…");
    try {
      // checkout:false — see module doc. create_branch itself re-validates
      // the sha still resolves (a resolution failure surfaces as a clean
      // `ok:false` + git's own message, never a crash) and snapshots first.
      const res = await commands.createBranch(this.repo, name, sha, false);
      if (res && res.ok) {
        this.cancelRecover();
        await bridge.reloadGraph(true);
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Recovered as " + name + ".", 3600);
        // Re-pull: the recovered commit is no longer dangling now that a real
        // ref points at it — without this, a stale row would keep offering to
        // "recover" something that's already been recovered.
        await this.refresh(this.repo);
      } else {
        bridge.tama.warn((res && res.message) || "Could not recover " + shortSha + ".");
      }
    } catch (e) {
      bridge.tama.warn("Recover failed — " + e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }
}

export const danglingRecoveryCtrl = new DanglingRecoveryState();
