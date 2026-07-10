// Rerere panel — controller (Svelte 5 runes singleton).
//
// A real .scrim/.modal now, opened on demand (Tools menu / ⌘K — see menu.rs
// / cmdk.svelte.ts), same as resolver/bisect — it used to render INSIDE an
// always-visible drawer pane with no open/close lifecycle of its own; that
// drawer is gone (see index.html's own doc comment on the old DRAWER
// section). `refresh` is the public, idempotent hook `show()` calls so the
// status is always current rather than however stale it was last time.
//
// Read/write split mirrors the backend: `rerereStatus` is a read (Result<T,E>
// via the generated client), `rerereSetEnabled` is a plain WriteResult (never
// rejects — ok:false + message on failure).

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";
import type { RerereStatus } from "../../ipc/bindings";

/// One row the view renders (reuses the existing .rr-row/.h/.rr-badge/.mut
/// classes). `isPath` distinguishes a live-conflict path (real filename) from
/// a historical rr-cache id (see rerere.rs's doc for why history has no path).
export type RerereRow = {
  key: string;
  label: string;
  resolved: boolean;
  isPath: boolean;
};

const DEMO: RerereStatus = {
  enabled: true,
  configured: true,
  cacheDirPresent: true,
  entries: [],
  liveConflict: true,
  livePaths: [
    { path: "src/auth/token.ts", resolved: true },
    { path: "package-lock.json", resolved: true },
    { path: "src/graph/layout.rs", resolved: false },
  ],
};

/// First 12 hex chars of an rr-cache id, for a compact but still-searchable label.
function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) + "…" : id;
}

class RerereState {
  open = $state(false);
  vm = $state<RerereStatus | null>(null);
  busy = $state(false);
  demo = $state(false);

  repo = "";

  // Entry point (Tools menu / ⌘K).
  show(repo: string | null): void {
    this.open = true;
    void this.refresh(repo);
  }

  close(): void {
    if (this.busy) return;
    this.open = false;
  }

  get rows(): RerereRow[] {
    if (!this.vm) return [];
    const live = this.vm.livePaths.map((p) => ({
      key: "path:" + p.path,
      label: p.path,
      resolved: p.resolved,
      isPath: true,
    }));
    const hist = this.vm.entries.map((e) => ({
      key: "id:" + e.id,
      label: shortId(e.id),
      resolved: e.resolved,
      isPath: false,
    }));
    return [...live, ...hist];
  }

  get enabled(): boolean {
    return !!this.vm?.enabled;
  }

  /// Explains WHY the toggle reads the way it does — the effective state can
  /// come from an explicit config value or git's own cache-dir-exists
  /// fallback (see rerere.rs's doc); surfacing this avoids a confusing "on"
  /// the user never explicitly asked for.
  get sourceNote(): string {
    if (!this.vm) return "";
    if (this.vm.configured != null) return this.vm.configured ? "set for this repo" : "disabled for this repo";
    return this.vm.cacheDirPresent ? "default — on (rr-cache already exists)" : "default — off";
  }

  get hasRepo(): boolean {
    return IN_TAURI ? !!this.repo : true; // demo mode always has "a repo"
  }

  /// Public refresh hook (see module doc). Safe to call repeatedly: a call
  /// while one is already in flight is a no-op (the in-flight call already
  /// converges to the latest truth); calling with the same repo again is a
  /// harmless re-fetch.
  async refresh(repo: string | null): Promise<void> {
    if (!IN_TAURI) {
      this.loadDemo();
      return;
    }
    this.demo = false;
    if (!repo) {
      this.repo = "";
      this.vm = null;
      return;
    }
    if (this.busy) return;
    this.repo = repo;
    this.busy = true;
    try {
      const r = await commands.rerereStatus(repo);
      if (r.status === "ok") this.vm = r.data;
      else console.error("rerere_status", r.error);
    } catch (e) {
      console.error("rerere_status", e);
    } finally {
      this.busy = false;
    }
  }

  /// Flip `rerere.enabled` for the open repo (repo-local only — see rerere.rs).
  async setEnabled(enabled: boolean): Promise<void> {
    if (this.busy) return;
    if (this.demo || !IN_TAURI) {
      if (this.vm) this.vm = { ...this.vm, enabled, configured: enabled };
      bridge.tama.say(enabled ? "Rerere enabled (demo)." : "Rerere disabled (demo).");
      return;
    }
    if (!this.repo) {
      bridge.tama.warn("Open a repository first.");
      return;
    }
    this.busy = true;
    try {
      const r = await commands.rerereSetEnabled(this.repo, enabled);
      if (!r.ok) bridge.tama.warn(r.message || "Could not update rerere.enabled.");
      await this.refreshReal(this.repo);
    } catch (e) {
      bridge.tama.warn("Could not update rerere.enabled — " + e);
    } finally {
      this.busy = false;
    }
  }

  // Internal: re-fetch without the busy re-entrancy guard (setEnabled already
  // holds it) or the demo short-circuit (setEnabled already decided we're real).
  private async refreshReal(repo: string): Promise<void> {
    try {
      const r = await commands.rerereStatus(repo);
      if (r.status === "ok") this.vm = r.data;
      else console.error("rerere_status", r.error);
    } catch (e) {
      console.error("rerere_status", e);
    }
  }

  private loadDemo() {
    this.demo = true;
    this.vm = { ...DEMO, livePaths: DEMO.livePaths.map((p) => ({ ...p })) };
  }
}

export const rerereCtrl = new RerereState();
