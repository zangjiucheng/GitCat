// Fetch/Pull/Push live-progress modal — controller (Svelte 5 runes singleton).
//
// fetch/pull/push can be slow (a large remote, or a WSL-routed repo where every
// git call crosses the wsl.exe boundary), and the topbar buttons alone gave no
// hint of what git was doing. The streaming backend commands (fetch_stream /
// pull_stream / push_stream in git_remote.rs) force git --progress and emit one
// "sync-progress" event per progress segment ("remote: Counting objects…",
// "Receiving objects: 42% (…)", "Resolving deltas: …"); this controller
// collects those into a scrollable log the modal renders live.
//
// Lifecycle mirrors bisect.svelte.ts's runUnlisten pattern: begin() arms the
// event listeners BEFORE the caller invokes the command (so neither the first
// "Counting objects" segment nor the "job-started" event is missed),
// settle()/close() tear them down. Only one sync op ever runs at a time
// (legacy/main.ts's syncBusy single-flight), so no request-id is needed; the
// payload's `phase` is a cheap defensive filter so a late event from one op can
// never leak into a later op's modal.
//
// Cancellation (#133). Each streaming op is a registered job (jobs.rs). The
// modal learns its id from "job-started" — the one that is foreground, of this
// phase, on this repo; the silent auto-fetch is `background`, so it can't be
// mistaken for it — and Cancel calls job_cancel(id). A Cancel clicked before
// "job-started" arrives is queued and sent on arrival. The backend kills git's
// whole process tree, cleans up only the locks it created, and resolves the
// command with `cancelled: true`, which settle() shows as a neutral outcome.
// "job-progress" drives the stalled banner: no git output for a minute is
// REPORTED ("looks stuck — cancel?"), never acted on by itself.
//
// Escape cancels while running (owner decision; the body copy says so), hides
// while a cancel is already in flight, and closes once done. Hide only hides:
// the op keeps running in the background and its buttons stay busy.

import { IN_TAURI } from "../../ipc/env";
import { commands } from "../../ipc/bindings";
import type { JobInfo, JobProgress } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { be } from "@/i18n/i18n.svelte.ts";
import { keymap } from "@/keymap/registry.ts";
import type { ScopeHandle } from "@/keymap/scopes.ts";

export type Phase = "fetch" | "pull" | "push";

type TauriEvent<T> = { payload: T };
type Listen = <T>(event: string, cb: (e: TauriEvent<T>) => void) => Promise<() => void>;

const DEMO_REPO = "/demo/gitcat";
const DEMO_TICK_MS = 250;

class SyncProgressState {
  open = $state(false);
  title = $state("");
  lines = $state<string[]>([]);
  done = $state(false);
  error = $state<string | null>(null);
  cancelling = $state(false);
  cancelled = $state(false);
  // The backend's message for a cancelled op (what was cleaned up, how to
  // Undo a pull) — shown under "Cancelled." in the neutral status style.
  cancelNote = $state("");
  stalled = $state(false);
  stallSecs = $state(0);

  // True from begin() until the next begin(); with `done`, gives `running`.
  private begun = $state(false);
  // The job this modal is showing, from "job-started". Deliberately NOT
  // cleared by close(): a hidden op is still that job, and the jobs indicator
  // compares against it to avoid prompting twice for the same stall.
  private job = $state<number | null>(null);

  // Which op/repo this modal is currently showing — used to filter events.
  private phase: Phase = "fetch";
  private repo = "";
  // A Cancel that came before "job-started" did; sent as soon as it arrives.
  private cancelQueued = false;
  // Unlisten fns for this op's subscriptions, live only between begin() and
  // settle()/close() (mirrors bisect's runUnlisten).
  private unlisteners: (() => void)[] = [];
  // Bumped by begin() and close(), so subscriptions that finish arming after
  // the modal moved on are dropped instead of leaking.
  private gen = 0;
  // Pending auto-close timer (success only) — cleared if the modal is reopened
  // or closed first, so a quick fetch flashes and dismisses itself.
  private autoCloseTimer: ReturnType<typeof setTimeout> | null = null;
  // The modal's keyboard scope (Escape + Tab trap), pushed by begin() and
  // released by close(). From the controller, per pushScope's own doc.
  private scope: ScopeHandle | null = null;
  // Design mode's canned run, so cancel() can end it.
  private demo: { cancel: () => void; stop: () => void } | null = null;

  get running(): boolean {
    return this.begun && !this.done;
  }

  get jobId(): number | null {
    return this.job;
  }

  // Open the modal and start listening. Awaited by doFetch/doPull/doPush
  // BEFORE they invoke the streaming command, so no early event is dropped.
  async begin(title: string, phase: Phase, repo: string): Promise<void> {
    this.clearAutoClose();
    this.stopListening();
    this.demo?.stop();
    this.demo = null;
    this.title = title;
    this.phase = phase;
    this.repo = repo;
    this.lines = [];
    this.done = false;
    this.error = null;
    this.cancelling = false;
    this.cancelled = false;
    this.cancelNote = "";
    this.stalled = false;
    this.stallSecs = 0;
    this.job = null;
    this.cancelQueued = false;
    this.begun = true;
    this.open = true;
    this.scope ??= keymap.pushScope("modal", {
      el: document.querySelector<HTMLElement>(".modal.syncprogress"),
      autoFocus: false,
      onEscape: () => this.escape(),
      restoreFocus: true,
    });
    if (!IN_TAURI) return; // design mode: beginDemo drives the modal instead
    const gen = ++this.gen;
    const listen = (window as unknown as { __TAURI__?: { event: { listen: Listen } } }).__TAURI__?.event.listen;
    if (!listen) return;
    const subs = await Promise.all([
      listen<{ phase: string; line: string }>("sync-progress", (e) => {
        if (e.payload.phase !== this.phase) return; // defensive: never mix a fetch's tail into a pull
        this.lines = [...this.lines, e.payload.line]; // reassign (not push) so runes sees the change
      }),
      listen<JobInfo>("job-started", (e) => this.onJobStarted(e.payload)),
      listen<JobProgress>("job-progress", (e) => {
        if (e.payload.id !== this.job) return;
        this.stalled = e.payload.stalled;
        this.stallSecs = e.payload.idleSecs;
      }),
    ]);
    // Closed (or re-begun) while the subscriptions were still being set up:
    // they belong to nobody now.
    if (gen !== this.gen) {
      for (const u of subs) u();
      return;
    }
    this.unlisteners.push(...subs);
  }

  private onJobStarted(p: JobInfo): void {
    if (this.job != null || p.background || p.kind !== this.phase || p.repo !== this.repo) return;
    this.job = p.id;
    if (this.cancelQueued) {
      this.cancelQueued = false;
      void this.sendCancel(p.id);
    }
  }

  // The op finished — freeze the log, record the outcome, stop listening. On
  // SUCCESS the modal auto-dismisses shortly after (a quick fetch just flashes;
  // the Tama toast carries the final message anyway). On FAILURE or CANCEL it
  // stays open so the user can read what happened until they close it.
  settle(ok: boolean, message: string, cancelled = false): void {
    this.done = true;
    this.cancelling = false;
    this.stalled = false;
    this.cancelled = cancelled;
    this.cancelNote = cancelled ? be(message) : "";
    this.error = ok || cancelled ? null : be(message) || "Failed.";
    this.stopListening();
    if (ok) {
      this.autoCloseTimer = setTimeout(() => {
        this.autoCloseTimer = null;
        this.close();
      }, 900);
    }
  }

  // Stop the running op. A no-op once it is done or a cancel is already in
  // flight. Before "job-started" has told us the id, the cancel is queued.
  async cancel(): Promise<void> {
    if (!this.running || this.cancelling) return;
    this.cancelling = true;
    if (this.demo) {
      this.demo.cancel();
      return;
    }
    if (!IN_TAURI) return;
    if (this.job == null) {
      this.cancelQueued = true;
      return;
    }
    await this.sendCancel(this.job);
  }

  private async sendCancel(id: number): Promise<void> {
    try {
      // false = the job already finished (benign race); its own result is on
      // the way and settle() will show it, so there is nothing to do here.
      await commands.jobCancel(id);
    } catch (e) {
      bridge.tama.warn(be(String(e)));
      this.cancelling = false;
    }
  }

  // The modal's Escape: cancel while running, hide while a cancel is already
  // in flight (a second Escape must not feel dead), close once done.
  escape(): void {
    if (this.running && !this.cancelling) void this.cancel();
    else this.close();
  }

  // Hide/Close — hides the modal and drops its listeners and keyboard scope.
  // A still-running backend op keeps going unless it was cancelled; that's
  // intentional and safe (see the header note).
  close(): void {
    this.clearAutoClose();
    this.open = false;
    this.gen++;
    this.stopListening();
    this.scope?.release();
    this.scope = null;
  }

  // Browser design mode: the same modal, fed canned progress so the log, the
  // stalled banner and Cancel can all be seen without a backend. Resolves
  // {ok:true} after ~4 s, or {cancelled:true} as soon as cancel() is called.
  async beginDemo(title: string, phase: Phase): Promise<{ ok: boolean; cancelled: boolean }> {
    await this.begin(title, phase, DEMO_REPO);
    return new Promise((resolve) => {
      let elapsed = 0;
      let n = 0;
      const timer = setInterval(() => {
        elapsed += DEMO_TICK_MS;
        if (elapsed < 1500) {
          // Feeding the log.
          n += 1;
          this.lines = [...this.lines, n === 1 ? "remote: Counting objects: 100% (42/42), done." : `Receiving objects: ${Math.min(n * 15, 60)}% (${n * 6}/42)`];
        } else if (elapsed < 3000) {
          // A silent stretch long enough to show the stalled banner.
          if (!this.stalled) {
            this.stalled = true;
            this.stallSecs = 60;
          }
        } else if (elapsed < 4000) {
          this.stalled = false;
          this.lines = [...this.lines, `Receiving objects: ${elapsed < 3500 ? 80 : 100}% (42/42), done.`];
        } else {
          end();
          this.settle(true, "");
          resolve({ ok: true, cancelled: false });
        }
      }, DEMO_TICK_MS);
      const end = () => {
        clearInterval(timer);
        this.demo = null;
      };
      this.demo = {
        cancel: () => {
          end();
          const snapshot = phase === "pull" ? "\u001fsnapshot\u001fgitcat-backup-demo" : "";
          this.settle(false, `i18n:err_remote.${phase}_cancelled${snapshot}`, true);
          resolve({ ok: false, cancelled: true });
        },
        // Superseded by a new begin(): end quietly.
        stop: () => {
          end();
          resolve({ ok: false, cancelled: true });
        },
      };
    });
  }

  private stopListening(): void {
    for (const u of this.unlisteners.splice(0)) u();
  }

  private clearAutoClose(): void {
    if (this.autoCloseTimer !== null) {
      clearTimeout(this.autoCloseTimer);
      this.autoCloseTimer = null;
    }
  }
}

export const syncProgressCtrl = new SyncProgressState();
