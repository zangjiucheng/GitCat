// Running-jobs indicator — controller (Svelte 5 runes singleton). #133.
//
// Every fetch/pull/push is a registered job in the backend (jobs.rs), which
// announces it on "job-started", flips its stalled flag on "job-progress" and
// drops it on "job-finished". The SyncProgress modal shows ONE of them, and
// only while it is open; Hide, the silent auto-fetch and the resolver's quiet
// pulls all leave a job running with nothing on screen that can stop it. This
// is that something: a compact topbar chip (spinner + count) with a popover that
// lists each job and cancels it through the same job_cancel the modal uses.
//
// Lifecycle. init() runs once at boot and subscribes FIRST, then asks
// jobs_list for whatever was already running (a reload mid-fetch) and merges
// by id — so a job that starts in between is seen by one or the other and
// never by neither. A job that finished in that window is remembered in
// `gone`, so a stale jobs_list row cannot bring it back.
//
// Background jobs (auto-fetch) are held back for BACKGROUND_GRACE_MS: a quick
// silent fetch would otherwise flash a chip into the topbar every few minutes.
// `now` ticks once a second, and only while something is running, to let them
// through and to drive the per-row elapsed clock.
//
// Stalls. jobs.rs reports "no git output for NETWORK_STALL" — reported, never
// acted on. The first stall of a job raises a Tama warning pointing here,
// unless the SyncProgress modal is open on that very job (its own banner says
// it already); a hidden modal still prompts, since nobody is looking at it.
//
// Design mode (no backend) has no jobs to list; instead the indicator mirrors
// the SyncProgress demo run, so Fetch → Hide shows the chip, the stall and a
// working Cancel exactly as they would look in the app.

import { tick, untrack } from "svelte";
import { IN_TAURI } from "../../ipc/env";
import { commands } from "../../ipc/bindings";
import type { JobFinished, JobInfo, JobKind, JobProgress } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { be, t } from "@/i18n/i18n.svelte.ts";
import { keymap } from "@/keymap/registry.ts";
import type { ScopeHandle } from "@/keymap/scopes.ts";
import { syncProgressCtrl } from "../syncprogress/syncprogress.svelte.ts";

export type JobView = JobInfo & { idleSecs: number };

export const BACKGROUND_GRACE_MS = 5000;

// jobs.rs NETWORK_STALL: the idle threshold "job-progress" reports at the
// transition. JobInfo.stalled carries no number, so a row that arrives
// already stalled uses this.
const NETWORK_STALL_SECS = 60;

type TauriEvent<T> = { payload: T };
type Listen = <T>(event: string, cb: (e: TauriEvent<T>) => void) => Promise<() => void>;

// Design mode's mirrored SyncProgress demo run. Negative, so it can never
// collide with a backend id (those start at 1).
const DEMO_JOB_ID = -1;

function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

/** "Fetch · origin — gitcat": the kind (localized), the backend's machine
 *  detail when there is one, and which repo. */
export function jobLabel(j: Pick<JobInfo, "kind" | "label" | "repo">): string {
  let s = t("jobs.kind_" + j.kind);
  if (j.label) s += " · " + j.label;
  return s + " — " + basename(j.repo);
}

/** Elapsed time as m:ss (minutes keep counting past 59 — a sync is not a
 *  stopwatch, and an hour-long clone reads fine as 63:10). */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

class JobsState {
  jobs = $state<JobView[]>([]);
  open = $state(false);
  now = $state(Date.now());

  // Ids already finished — guards the init() merge against a jobs_list
  // snapshot taken just before the job ended.
  private gone = new Set<number>();
  // Ids whose stall has already been prompted for; one warning per job.
  private prompted = new Set<number>();
  // Ids this indicator cancelled, so their "job-finished" can say so.
  private cancelledHere = new Set<number>();
  private inited = false;
  private ticker: ReturnType<typeof setInterval> | null = null;
  // The popover's keyboard scope (Escape + focus restore), pushed by
  // toggle() and released by close(). From the controller, per pushScope's
  // own doc — not from a component $effect.
  private scope: ScopeHandle | null = null;

  get visible(): JobView[] {
    return this.jobs.filter((j) => !j.background || this.now - j.startedAtMs >= BACKGROUND_GRACE_MS);
  }

  get count(): number {
    return this.visible.length;
  }

  get anyStalled(): boolean {
    return this.visible.some((j) => j.stalled);
  }

  // Subscribe, then catch up. Idempotent, and never throws: a broken event
  // bridge must cost the indicator, not the app boot that awaits this.
  async init(): Promise<void> {
    if (this.inited) return;
    this.inited = true;
    if (!IN_TAURI) {
      this.mirrorDemo();
      return;
    }
    try {
      const listen = (window as unknown as { __TAURI__?: { event: { listen: Listen } } }).__TAURI__?.event.listen;
      if (!listen) return;
      await Promise.all([
        listen<JobInfo>("job-started", (e) => this.onStarted(e.payload)),
        listen<JobProgress>("job-progress", (e) => this.onProgress(e.payload)),
        listen<JobFinished>("job-finished", (e) => this.onFinished(e.payload)),
      ]);
      const running = await commands.jobsList();
      for (const j of running) if (!this.gone.has(j.id)) this.onStarted(j);
    } catch (e) {
      console.warn("jobs: init failed", e);
    }
  }

  onStarted(i: JobInfo): void {
    if (this.jobs.some((j) => j.id === i.id)) return; // already merged
    this.jobs = [...this.jobs, { ...i, stalled: false, idleSecs: 0 }];
    this.syncTicker();
    // A jobs_list row can already be stalled (a reload mid-stall), and
    // "job-progress" fires only on change — so replay the transition: it
    // fills in the threshold JobInfo lacks and runs the one-time prompt.
    if (i.stalled) this.onProgress({ id: i.id, stalled: true, idleSecs: NETWORK_STALL_SECS });
  }

  onProgress(p: JobProgress): void {
    const j = this.jobs.find((x) => x.id === p.id);
    if (!j) return;
    this.patch(p.id, { stalled: p.stalled, idleSecs: p.idleSecs });
    if (!p.stalled || this.prompted.has(p.id)) return;
    // The open modal on this job already shows its own banner — don't say it
    // twice. (The demo run has no backend id; the modal is always showing it.)
    if (syncProgressCtrl.open && (syncProgressCtrl.jobId === p.id || p.id === DEMO_JOB_ID)) return;
    this.prompted.add(p.id);
    bridge.tama.warn(t("jobs.stalled_prompt", { label: jobLabel(j) }));
  }

  onFinished(f: JobFinished): void {
    this.gone.add(f.id);
    const j = this.jobs.find((x) => x.id === f.id);
    this.prompted.delete(f.id);
    const ours = this.cancelledHere.delete(f.id);
    if (!j) return;
    this.jobs = this.jobs.filter((x) => x.id !== f.id);
    if (ours && f.outcome === "cancelled") bridge.tama.say(t("jobs.cancelled_toast", { label: jobLabel(j) }));
    this.syncTicker();
    if (this.open && this.count === 0) this.close();
  }

  // Optimistic: the row shows "cancelling" at once. false from the backend
  // means the job was already finishing — its "job-finished" is on the way.
  async cancel(id: number): Promise<void> {
    const j = this.jobs.find((x) => x.id === id);
    if (!j || j.cancelling) return;
    this.patch(id, { cancelling: true });
    this.cancelledHere.add(id);
    if (id === DEMO_JOB_ID) {
      void syncProgressCtrl.cancel();
      return;
    }
    try {
      await commands.jobCancel(id);
    } catch (e) {
      this.cancelledHere.delete(id);
      this.patch(id, { cancelling: false });
      bridge.tama.warn(be(String(e)));
    }
  }

  // The chip and Mod+Shift+J. Returns false — so the key is declined, not
  // swallowed — when there is nothing to show.
  toggle(): boolean {
    if (this.open) {
      this.close();
      return true;
    }
    if (this.count === 0) return false;
    this.open = true;
    // After a tick, so the popover element exists for the scope to focus.
    void tick().then(() => {
      if (!this.open || this.scope) return;
      this.scope = keymap.pushScope("modal", {
        el: document.querySelector<HTMLElement>(".jobs-pop"),
        onEscape: () => this.close(),
        restoreFocus: true,
      });
    });
    return true;
  }

  close(): void {
    this.open = false;
    this.scope?.release();
    this.scope = null;
  }

  private patch(id: number, changes: Partial<JobView>): void {
    this.jobs = this.jobs.map((j) => (j.id === id ? { ...j, ...changes } : j));
  }

  // One 1 s ticker, alive only while something is running.
  private syncTicker(): void {
    this.now = Date.now();
    if (this.jobs.length > 0 && !this.ticker) {
      this.ticker = setInterval(() => {
        this.now = Date.now();
      }, 1000);
    } else if (this.jobs.length === 0 && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  // Design mode: follow syncProgressCtrl's demo run as if it were a job.
  private mirrorDemo(): void {
    $effect.root(() => {
      $effect(() => {
        const running = syncProgressCtrl.running;
        const stalled = syncProgressCtrl.stalled;
        const secs = syncProgressCtrl.stallSecs;
        untrack(() => this.onDemo(running, stalled, secs));
      });
    });
  }

  private onDemo(running: boolean, stalled: boolean, secs: number): void {
    const has = this.jobs.some((j) => j.id === DEMO_JOB_ID);
    if (running && !has) {
      this.gone.delete(DEMO_JOB_ID);
      this.onStarted({
        id: DEMO_JOB_ID,
        kind: demoKind(syncProgressCtrl.title),
        repo: "/demo/gitcat",
        label: "",
        startedAtMs: Date.now(),
        background: false,
        stalled: false,
        cancelling: false,
      });
    } else if (!running && has) {
      this.onFinished({ id: DEMO_JOB_ID, outcome: syncProgressCtrl.cancelled ? "cancelled" : "ok" });
      return;
    }
    if (running && this.jobs.find((j) => j.id === DEMO_JOB_ID)?.stalled !== stalled) {
      this.onProgress({ id: DEMO_JOB_ID, stalled, idleSecs: secs });
    }
  }
}

// The demo modal only exposes its (localized) title, which legacy/main.ts
// sets from topbar.fetching/pulling/pushing.
function demoKind(title: string): JobKind {
  if (title === t("topbar.pulling")) return "pull";
  if (title === t("topbar.pushing")) return "push";
  return "fetch";
}

export const jobsCtrl = new JobsState();
