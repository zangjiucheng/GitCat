// Cherry-pick conflict resolver — controller (Svelte 5 runes singleton).
//
// Owns the resolver's UI state + the whole cherry-pick outcome flow. The legacy
// canvas-drag handler calls `resolver.startPick(...)` (real) or `openDemo(...)`
// (browser design mode); the modal buttons call the async methods below. All
// backend calls go through the typed `ipc` layer; cross-cutting UI effects
// (graph reload, mascot, cheer) go through the legacy `bridge`.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import type { ConflictFile, PickResult } from "../../ipc/bindings";

// specta generates `side: string`; keep the precise union at the call boundary.
type ConflictSide = "ours" | "theirs";

const FAKE = [
  {
    path: "src/auth/token.ts",
    ours: "const ttl = 3600;\nrefresh(token);",
    base: "const ttl = 900;\nrefresh(token);",
    theirs: "const ttl = 1800;\nrefresh(token, opts);",
  },
];

class ResolverState {
  open = $state(false);
  busy = $state(false); // re-entrancy lock (was PICK_BUSY)
  demo = $state(false);
  sub = $state("");
  backupRef = $state("");
  tamaImg = $state("");
  files = $state<ConflictFile[]>([]);
  selected = $state<string | null>(null);
  remaining = $state<Set<string>>(new Set()); // reassigned, never mutated in place (Set isn't deep-proxied)

  sha = "";
  repo = "";

  get current(): ConflictFile | null {
    return this.files.find((f) => f.path === this.selected) ?? null;
  }
  get currentLive(): boolean {
    const f = this.current;
    return !!(f && this.remaining.has(f.path));
  }
  get remainingCount(): number {
    return this.remaining.size;
  }

  select(path: string) {
    this.selected = path;
  }

  private reset() {
    this.files = [];
    this.selected = null;
    this.remaining = new Set();
  }
  close() {
    this.open = false;
    this.reset();
  }

  // ── real entry (from the canvas drag handler) ─────────────────────────────
  async startPick(repo: string, sha: string, recordOrigin: boolean) {
    if (this.busy) return;
    if (!repo) {
      bridge.tama.warn("Open a repository first.");
      return;
    }
    this.demo = false;
    this.repo = repo;
    this.busy = true;
    bridge.tama.event("mutation.caution", { count: 1 });
    try {
      const res = await commands.cherryPick(repo, sha, recordOrigin);
      await this.applyOutcome(res, sha);
    } catch (e) {
      bridge.tama.warn("Cherry-pick failed — " + e);
    } finally {
      this.busy = false;
    }
  }

  // Route a cherry_pick / cherry_pick_continue PickResult to the UI.
  private async applyOutcome(res: PickResult, sha: string) {
    switch (res.state) {
      case "clean":
        this.close();
        await bridge.reloadGraph(true);
        bridge.tama.event("snapshot.surfaced");
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Cherry-picked " + (sha || "") + ".", 4200);
        bridge.cheer('Cherry-pick applied. <span class="jp">よし!</span>');
        break;
      case "empty":
        this.close();
        await bridge.reloadGraph(true);
        bridge.tama.set("hint");
        bridge.tama.say(res.message || "Already applied — nothing to pick.", 4200);
        break;
      case "conflict":
        await this.openConflict(res, sha);
        break;
      default: // "error"
        bridge.tama.warn(res.message || "Cherry-pick could not start.");
        break;
    }
  }

  private async openConflict(res: PickResult, sha: string) {
    this.sha = sha || "";
    this.reset();
    this.tamaImg = bridge.TAMA_IMG.alarm;
    const n = res.conflictedFiles ? res.conflictedFiles.length : 0;
    this.sub = n
      ? "Picking " + (sha || "the commit") + " conflicts in " + n + " file" + (n === 1 ? "" : "s") +
        ". Pick a side per file, then Continue — or Abort."
      : "Cherry-pick of " + (sha || "the commit") + " needs review — resolve, then Continue, or Abort.";
    if (res.backupRef) this.backupRef = res.backupRef;
    await this.refresh();
    this.open = true;
  }

  // Pull authoritative unmerged files. conflict_status returns Result<T,E> via
  // the generated client — read r.data on ok, log r.error otherwise.
  private async refresh() {
    let files: ConflictFile[] = [];
    try {
      const r = await commands.conflictStatus(this.repo);
      if (r.status === "ok") files = Array.isArray(r.data.files) ? r.data.files : [];
      else console.error("conflict_status", r.error);
    } catch (e) {
      console.error("conflict_status", e);
    }
    this.files = files;
    this.remaining = new Set(files.map((f) => f.path));
    if (this.selected == null || !this.remaining.has(this.selected)) {
      this.selected = files.length ? files[0].path : null;
    }
  }

  // Take a whole side for the selected file, then re-pull authoritative state.
  async take(side: ConflictSide) {
    const f = this.current;
    if (!f) return;
    if (this.demo) {
      this.remaining = new Set([...this.remaining].filter((p) => p !== f.path));
      const nx = this.files.find((x) => this.remaining.has(x.path));
      if (nx) this.selected = nx.path;
      bridge.tama.say("Took " + side + " for " + f.path + " (demo).");
      return;
    }
    try {
      const r = await commands.resolveConflictFile(this.repo, f.path, side);
      if (!r.ok) bridge.tama.warn(r.message || "Could not resolve " + f.path);
    } catch (e) {
      bridge.tama.warn("Resolve failed — " + e);
      return;
    }
    await this.refresh();
  }

  async abort() {
    if (this.demo) {
      this.close();
      bridge.tama.set("hint");
      bridge.tama.say("Pick aborted — HEAD unchanged.");
      return;
    }
    if (this.busy) return;
    this.busy = true;
    try {
      const r = await commands.cherryPickAbort(this.repo);
      if (r && r.state === "clean") {
        this.close();
        await bridge.reloadGraph(true);
        bridge.tama.set("hint");
        bridge.tama.say(r.message || "Pick aborted — HEAD unchanged.");
      } else {
        bridge.tama.warn((r && r.message) || "Abort failed — try again, or abort from the command line.");
      }
    } catch (e) {
      bridge.tama.warn("Abort failed — " + e);
    } finally {
      this.busy = false;
    }
  }

  async continue() {
    if (this.demo) {
      this.close();
      bridge.tama.set("celebrate");
      bridge.tama.say("Conflict resolved — cherry-pick committed.");
      bridge.cheer('Conflict resolved — pick committed. <span class="jp">よし!</span>');
      return;
    }
    if (this.busy) return;
    this.busy = true;
    try {
      const r = await commands.cherryPickContinue(this.repo);
      if (r.state === "conflict") {
        await this.refresh();
        bridge.tama.warn(r.message || "Still conflicted — resolve the remaining files.");
      } else {
        await this.applyOutcome(r, this.sha);
      }
    } catch (e) {
      bridge.tama.warn("Continue failed — " + e);
    } finally {
      this.busy = false;
    }
  }

  // ── design-mode demo (browser, no Tauri) ──────────────────────────────────
  openDemo(sha: string) {
    this.demo = true;
    this.sha = sha;
    this.tamaImg = bridge.TAMA_IMG.alarm;
    this.backupRef = "refs/gitgui/backup/…demo";
    this.sub = "Picking " + sha + " onto HEAD conflicts in src/auth/token.ts. Snapshot …demo sealed.";
    this.files = FAKE.map((f) => ({ ...f }));
    this.selected = FAKE[0].path;
    this.remaining = new Set([FAKE[0].path]);
    bridge.tama.event("mutation.caution", { count: 1 });
    this.open = true;
  }
}

export const resolver = new ResolverState();
