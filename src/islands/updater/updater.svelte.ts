// App updater — controller (Svelte 5 runes singleton).
//
// Checks GitCat's own GitHub Releases (via tauri.conf.json's
// `plugins.updater.endpoints` — GitHub's stable
// `releases/latest/download/latest.json` URL, which only ever resolves once
// a release is PUBLISHED and non-prerelease — see release.yml's own comment)
// for a newer signed build, and can download + install + relaunch into it.
// Backed directly by Tauri's own `updater`/`process` plugins (their own JS
// API, e.g. `@tauri-apps/plugin-updater`) — NOT this app's specta command
// layer, which is unrelated. Every real build is minisign-signed by CI (see
// release.yml); an update whose signature doesn't verify against
// tauri.conf.json's `pubkey` is refused by the plugin itself before it ever
// reaches here.
//
// In browser design-mode (no Tauri backend) there is nothing real to check
// against, so `check()` just settles on "up-to-date" after a short delay —
// a fabricated "update available" demo would invite clicking Install with
// nothing real behind it, unlike this app's other islands (which mostly
// demo real UI flows against canned data, not backend-dependent facts).

import { IN_TAURI } from "../../ipc/env";
import type { Update } from "@tauri-apps/plugin-updater";

type Phase = "idle" | "checking" | "up-to-date" | "available" | "downloading" | "ready" | "error";

class UpdaterState {
  phase = $state<Phase>("idle");
  version = $state<string | null>(null);
  currentVersion = $state<string | null>(null);
  notes = $state<string | null>(null);
  // 0-100, or null while the download's total content-length isn't known yet
  // (some hosts omit Content-Length) — the view falls back to an
  // indeterminate spinner in that case rather than a stuck-at-0 bar.
  progress = $state<number | null>(null);
  error = $state<string | null>(null);

  private update: Update | null = null;
  private downloaded = 0;
  private total = 0;

  // `silent` is true for the background startup probe (see legacy/main.ts's
  // boot sequence) — settles quietly back to "idle" on "up to date"/error
  // instead of surfacing anything, so it never interrupts someone who didn't
  // ask. A manual check (About panel / Help menu) always shows its outcome,
  // including "you're already up to date".
  async check(silent = false) {
    if (this.phase === "checking" || this.phase === "downloading") return;
    this.error = null;
    this.phase = "checking";
    if (!IN_TAURI) {
      await new Promise((r) => setTimeout(r, 600));
      this.phase = silent ? "idle" : "up-to-date";
      return;
    }
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const u = await check();
      if (!u) {
        this.phase = silent ? "idle" : "up-to-date";
        return;
      }
      this.update = u;
      this.version = u.version;
      this.currentVersion = u.currentVersion;
      this.notes = u.body || null;
      this.phase = "available";
    } catch (e) {
      this.error = "Couldn't check for updates — " + e;
      this.phase = silent ? "idle" : "error";
    }
  }

  async downloadAndInstall() {
    if (!this.update || this.phase === "downloading") return;
    this.phase = "downloading";
    this.progress = null;
    this.downloaded = 0;
    this.total = 0;
    try {
      await this.update.downloadAndInstall((ev) => {
        if (ev.event === "Started") {
          this.total = ev.data.contentLength || 0;
        } else if (ev.event === "Progress") {
          this.downloaded += ev.data.chunkLength;
          this.progress = this.total ? Math.min(100, Math.round((this.downloaded / this.total) * 100)) : null;
        } else if (ev.event === "Finished") {
          this.progress = 100;
        }
      });
      this.phase = "ready";
    } catch (e) {
      this.error = "Download failed — " + e;
      this.phase = "error";
    }
  }

  async restart() {
    if (!IN_TAURI) return;
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  }

  // Dismisses an "available"/"error" state without acting on it — the
  // "Not now"/"Dismiss" affordance. Never called while "downloading" (no
  // dismiss button is shown then — see Updater.svelte) or "ready" (finishing
  // the restart is the only way out of a state that's already installed).
  dismiss() {
    this.phase = "idle";
    this.error = null;
  }
}

export const updaterCtrl = new UpdaterState();
