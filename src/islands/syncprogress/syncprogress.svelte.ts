// Fetch/Pull live-progress modal — controller (Svelte 5 runes singleton).
//
// fetch/pull can be slow (a large remote, or a WSL-routed repo where every git
// call crosses the wsl.exe boundary), and the topbar buttons alone gave no hint
// of what git was doing. The streaming backend commands (fetch_stream /
// pull_stream in git_remote.rs) force git --progress and emit one "sync-progress"
// event per progress segment ("remote: Counting objects…", "Receiving objects:
// 42% (…)", "Resolving deltas: …"); this controller collects those into a
// scrollable log the modal renders live.
//
// Lifecycle mirrors bisect.svelte.ts's runUnlisten pattern: begin() arms the
// event listener BEFORE the caller invokes the command (so the first
// "Counting objects" segment isn't missed), settle()/close() tear it down. Only
// one sync op ever runs at a time (legacy/main.ts's syncBusy single-flight), so
// no request-id is needed; the payload's `phase` is a cheap defensive filter so
// a late event from one op can never leak into a later op's modal.
//
// Cancellation is deliberately NOT wired here yet (see fetch_stream's Rust doc):
// close() only HIDES the modal — the backend op keeps running to completion,
// which is safe (fetch only moves remote-tracking refs; pull is ff-only and
// snapshotted). The user is never trapped behind a stuck fetch.

import { IN_TAURI } from "../../ipc/env";
import { be } from "@/i18n/i18n.svelte.ts";

type Phase = "fetch" | "pull";

class SyncProgressState {
  open = $state(false);
  title = $state("");
  lines = $state<string[]>([]);
  done = $state(false);
  error = $state<string | null>(null);

  // Which op this modal is currently showing — used to filter stray events.
  private phase: Phase = "fetch";
  // Unlisten fn for the "sync-progress" subscription, live only between
  // begin() and settle()/close() (mirrors bisect's runUnlisten).
  private unlisten: (() => void) | null = null;
  // Pending auto-close timer (success only) — cleared if the modal is reopened
  // or closed first, so a quick fetch flashes and dismisses itself.
  private autoCloseTimer: ReturnType<typeof setTimeout> | null = null;

  // Open the modal and start listening. Awaited by doFetch/doPull BEFORE they
  // invoke the streaming command, so no early progress segment is dropped.
  async begin(title: string, phase: Phase): Promise<void> {
    this.clearAutoClose();
    this.title = title;
    this.phase = phase;
    this.lines = [];
    this.done = false;
    this.error = null;
    this.open = true;
    if (!IN_TAURI) return; // browser design mode: doFetch/doPull short-circuit before any invoke
    const w = window as unknown as { __TAURI__?: any };
    this.unlisten =
      (await w.__TAURI__?.event.listen("sync-progress", (e: { payload: { phase: string; line: string } }) => {
        if (e.payload.phase !== this.phase) return; // defensive: never mix a fetch's tail into a pull
        this.lines = [...this.lines, e.payload.line]; // reassign (not push) so runes sees the change
      })) ?? null;
  }

  // The op finished — freeze the log, record any error, stop listening. On
  // SUCCESS the modal auto-dismisses shortly after (a quick fetch just flashes;
  // the Tama toast carries the final message anyway). On FAILURE it stays open
  // so the user can read git's error until they close it.
  settle(ok: boolean, message: string): void {
    this.done = true;
    this.error = ok ? null : be(message) || "Failed.";
    this.stopListening();
    if (ok) {
      this.autoCloseTimer = setTimeout(() => {
        this.autoCloseTimer = null;
        this.close();
      }, 900);
    }
  }

  // Always available (Close button / Esc) — hides the modal. The backend op may
  // still be running; that's intentional and safe (see the header note).
  close(): void {
    this.clearAutoClose();
    this.open = false;
    this.stopListening();
  }

  private stopListening(): void {
    this.unlisten?.();
    this.unlisten = null;
  }

  private clearAutoClose(): void {
    if (this.autoCloseTimer !== null) {
      clearTimeout(this.autoCloseTimer);
      this.autoCloseTimer = null;
    }
  }
}

export const syncProgressCtrl = new SyncProgressState();
