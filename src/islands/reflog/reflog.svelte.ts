// Reflog rescue — controller (Svelte 5 runes singleton).
//
// A real .scrim/.modal, opened on demand (Tools menu / ⌘K — see menu.rs /
// cmdk.svelte.ts) — it used to render permanently inside a bottom-drawer
// pane, but that drawer is gone (see index.html's own doc comment on the
// old DRAWER section). Owns the entry list + the restore flow. `refresh` is
// the public, idempotent, safely-repeatable hook `show()` calls so the list
// is always live rather than however stale it was the last time this was open.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";
import { ICON_WARNING, ICON_CHERRY } from "../../legacy/icons";
import type { ReflogEntry } from "../../ipc/bindings";

// Coarse icon per `kind` — best-effort, mirrors the static mockup's glyphs
// (●/⚠/↷/🍒) with a couple of extra fallbacks for shapes `reflog::classify`
// recognizes but the original 4-row demo didn't show. "reset"/"cherry-pick"
// are real pictographic emoji (ICON_WARNING/ICON_CHERRY, rendered via
// Reflog.svelte's own {@html icon(...)} — see icons.ts's own header for why
// these two specifically are string constants, not Svelte components); the
// rest are plain Unicode dingbats, which (unlike color emoji) already render
// consistently enough across platforms not to need replacing.
const ICONS: Record<string, string> = {
  commit: "●",
  reset: ICON_WARNING,
  checkout: "⇄",
  rebase: "↷",
  "cherry-pick": ICON_CHERRY,
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
  open = $state(false);
  entries = $state<ReflogEntry[]>([]);
  busy = $state(false); // re-entrancy lock while a restore is in flight
  loading = $state(false); // refresh() in flight — separate from `busy` (restore)
  restoringIndex = $state<number | null>(null); // which row's "Restore here" is in flight
  error = $state("");
  demo = $state(false);
  // curious while browsing entries (mirrors bisect's own browsing/hunting
  // expression), confident once a restore actually lands — same "successful
  // rescue" framing as globalUndo's TAMA_IMG.confident. Lazy-init to "" (set
  // for real in show()) — a field initializer can't safely read
  // bridge.TAMA_IMG: it runs at this singleton's construction (module-import)
  // time, which can race legacy/main.ts's own `const TAMA_IMG=` (see every
  // other controller's tamaImg field for the same convention).
  tamaImg = $state("");

  repo = "";

  icon(kind: string): string {
    return ICONS[kind] ?? ICONS.other;
  }

  label(e: ReflogEntry): string {
    return "HEAD@{" + e.index + "}: " + e.message;
  }

  // Entry point (Tools menu / ⌘K). Always re-fetches — see refresh()'s own
  // "never stale" doc above — so reopening always reflects whatever the
  // repo's reflog looks like right now, not whatever it looked like the last
  // time this was open.
  show(repo: string | null): void {
    this.open = true;
    this.tamaImg = bridge.TAMA_IMG.curious; // reset — a prior session may have left this on confident
    void this.refresh(repo);
  }

  close(): void {
    if (this.busy) return; // mid-restore — same guard as every other modal's Escape handler
    this.open = false;
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
      this.tamaImg = bridge.TAMA_IMG.confident;
      bridge.tama.set("celebrate");
      const msg = "Restored to " + (picked?.sha ?? "that entry") + " (demo).";
      bridge.tama.say(msg, 4200);
      bridge.cheer(msg, bridge.TAMA_IMG.confident);
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
        this.tamaImg = bridge.TAMA_IMG.confident;
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Restored.", 4200);
        bridge.cheer(res.message || "Restored.", bridge.TAMA_IMG.confident);
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
