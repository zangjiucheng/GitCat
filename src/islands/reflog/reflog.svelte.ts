// Reflog rescue — controller (Svelte 5 runes singleton).
//
// Renders INSIDE the existing bottom-drawer pane (#pane-reflog), not a
// full-screen modal — unlike resolver/bisect. Owns the entry list + the
// restore flow. `refresh` is the public, idempotent, safely-repeatable hook
// the drawer-tab click (`ensureDrawerOpen("reflog")`) calls so the list is
// live rather than loaded once at boot (before a repo may even be open).

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";
import type { ReflogEntry } from "../../ipc/bindings";

// Coarse icon per `kind` — best-effort, mirrors the static mockup's glyphs
// (●/⚠/↷/🍒) with a couple of extra fallbacks for shapes `reflog::classify`
// recognizes but the original 4-row demo didn't show.
const ICONS: Record<string, string> = {
  commit: "●",
  reset: "⚠",
  checkout: "⇄",
  rebase: "↷",
  "cherry-pick": "🍒",
  merge: "⑂",
  branch: "⌥",
  pull: "⇣",
  clone: "⎘",
  other: "•",
};

// Canned rows for design-mode (!IN_TAURI) — same spirit as the 4 static
// .log-row divs it replaces, so the browser preview still looks populated.
const DEMO: ReflogEntry[] = [
  { index: 0, sha: "a1b2c3d", message: "commit: Wire login form to API", kind: "commit", committerName: "You", committerEmail: "", ts: 0 },
  { index: 1, sha: "e4f5061", message: "reset: moving to origin/main", kind: "reset", committerName: "You", committerEmail: "", ts: 0 },
  { index: 2, sha: "7788aa9", message: "rebase (finish): returning to refs/heads/main", kind: "rebase", committerName: "You", committerEmail: "", ts: 0 },
  { index: 3, sha: "bb01ccd", message: "cherry-pick: Add form validation", kind: "cherry-pick", committerName: "You", committerEmail: "", ts: 0 },
];

class ReflogState {
  entries = $state<ReflogEntry[]>([]);
  busy = $state(false); // re-entrancy lock while a restore is in flight
  loading = $state(false); // refresh() in flight — separate from `busy` (restore)
  restoringIndex = $state<number | null>(null); // which row's "Restore here" is in flight
  error = $state("");
  demo = $state(false);

  repo = "";

  icon(kind: string): string {
    return ICONS[kind] ?? ICONS.other;
  }

  label(e: ReflogEntry): string {
    return "HEAD@{" + e.index + "}: " + e.message;
  }

  // ── public refresh hook — called on boot AND every time the Reflog drawer
  // tab is selected (ensureDrawerOpen wiring), so it never shows stale data
  // from before a repo was open. Safe to call repeatedly / with repo:null.
  async refresh(repo: string | null): Promise<void> {
    this.repo = repo ?? "";
    this.loading = true;
    try {
      if (!IN_TAURI) {
        // design-mode preview: no backend, seed the canned demo list.
        this.demo = true;
        this.error = "";
        this.entries = DEMO.map((e) => ({ ...e }));
        return;
      }
      this.demo = false;

      if (!this.repo) {
        this.entries = [];
        this.error = "";
        return;
      }

      try {
        const r = await commands.reflog(this.repo);
        if (r.status === "ok") {
          this.entries = r.data;
          this.error = "";
        } else {
          this.entries = [];
          this.error = String(r.error ?? "Could not read the reflog.");
        }
      } catch (e) {
        this.entries = [];
        this.error = "Could not read the reflog — " + e;
      }
    } finally {
      this.loading = false;
    }
  }

  // Restore HEAD to a historical reflog entry. A REAL mutation (moves HEAD),
  // so success reloads the graph + confirms via Tama; failure warns and
  // leaves the panel showing the failure (never silently eaten).
  async restore(index: number): Promise<void> {
    if (this.busy) return;

    if (this.demo) {
      // Design-mode preview: fake the mutation locally, no IPC call — mirrors
      // resolver/bisect's demo-mode conventions.
      const picked = this.entries.find((e) => e.index === index);
      bridge.tama.set("celebrate");
      bridge.tama.say("Restored to " + (picked?.sha ?? "that entry") + " (demo).", 4200);
      return;
    }

    if (!this.repo) {
      bridge.tama.warn("Open a repository first.");
      return;
    }

    this.busy = true;
    this.restoringIndex = index;
    try {
      const res = await commands.reflogRestore(this.repo, index);
      if (res.ok) {
        await bridge.reloadGraph(true);
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Restored.", 4200);
        // Re-pull: the restore itself moved HEAD, so the reflog now has a
        // fresh entry on top (and indices have shifted).
        await this.refresh(this.repo);
      } else {
        bridge.tama.warn(res.message || "Restore failed — try again.");
      }
    } catch (e) {
      bridge.tama.warn("Restore failed — " + e);
    } finally {
      this.busy = false;
      this.restoringIndex = null;
    }
  }
}

export const reflogCtrl = new ReflogState();
