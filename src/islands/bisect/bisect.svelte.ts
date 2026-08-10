// Bisect — controller (Svelte 5 runes singleton).
//
// Owns the in-progress modal + the whole bisect IPC flow (start/mark/status/
// reset). The vanilla canvas stays the source of truth for the on-graph cues:
// the legacy `bisect` row-model + `dirty` flag drive draw() every frame, and
// this controller pokes them through the bridge (`syncBisectMarks`,
// `focusBisectCurrent`, `requestRedraw` is implicit in those) after each step.
// The legacy drawer arms good/bad rows and calls `bisectCtrl.start/openDemo`.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";
import { t, be } from "@/i18n/i18n.svelte.ts";
import type { BisectStatus } from "../../ipc/bindings";

// specta generates `term: string`; keep the precise union at the call boundary.
type BisectTerm = "good" | "bad" | "skip";

function escHtml(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

class BisectState {
  open = $state(false);
  busy = $state(false);
  // Which good/bad/skip button `busy` is currently for — lets the modal
  // spinner sit on the one actually pressed instead of all three at once.
  activeTerm = $state<BisectTerm | null>(null);
  demo = $state(false);
  vm = $state<BisectStatus | null>(null);
  tamaImg = $state("");

  // ── automated run (bisect run <command>) ──────────────────────────────────
  // `runCommand` is just the input's bound value. `autoRunning` is deliberately
  // its own flag, distinct from BOTH `busy` (guards a single short start/mark/
  // reset IPC round-trip) and the `running` GETTER below (session-active,
  // "is a bisect happening at all" — already used by bisectdrawer.svelte.ts,
  // so that name was taken): `autoRunning` reflects the entire lifetime of a
  // backend loop blocking on `bisectRunStart` for as long as it takes to
  // converge/abort/cancel.
  runCommand = $state("");
  autoRunning = $state(false);
  // Unlisten fn for the "bisect-run-progress" subscription, live only while a
  // run is in flight — see startRun().
  private runUnlisten: (() => void) | null = null;

  est0 = 0; // baseline estSteps for the progress bar
  cheered = false; // one-shot celebrate
  repo = "";

  // ── derived view (was renderBisectScrim) ──────────────────────────────────
  get done(): boolean {
    return !!this.vm?.firstBad;
  }
  get inProgress(): boolean {
    return !!this.vm?.inProgress;
  }
  get running(): boolean {
    return !!this.vm && (this.vm.inProgress || !!this.vm.firstBad || this.demo);
  }
  get statText(): string {
    if (this.done) return t("bisect.stat_converged");
    const rem = this.vm?.remainingRevs ?? 0;
    const steps = this.vm?.estSteps ?? 0;
    const revs = t(rem === 1 ? "bisect.stat_revisions_one" : "bisect.stat_revisions_other", { n: rem.toLocaleString() });
    const stp = t(steps === 1 ? "bisect.stat_steps_one" : "bisect.stat_steps_other", { n: steps });
    return revs + " · " + stp;
  }
  get fillPct(): number {
    if (this.done) return 100;
    const steps = this.vm?.estSteps ?? 0;
    return Math.max(4, Math.round(100 * (1 - steps / Math.max(this.est0 || steps || 1, 1))));
  }
  get hint(): string {
    if (this.done) return t("bisect.hint_done");
    if (this.autoRunning) return t("bisect.hint_auto");
    return t("bisect.hint_mark");
  }
  get marksDisabled(): boolean {
    return this.busy || this.autoRunning || !this.inProgress;
  }

  // vm + progress baseline + one-shot cheer on convergence.
  private applyVM(st: BisectStatus | null) {
    this.vm = st;
    if (st && !st.firstBad && st.estSteps != null && this.est0 === 0) {
      this.est0 = Math.max(st.estSteps, 1);
    }
    if (st?.firstBad) {
      this.tamaImg = bridge.TAMA_IMG.happy;
      if (!this.cheered) {
        this.cheered = true;
        bridge.tama.set("celebrate");
        bridge.tama.say(t("bisect.say_found", { sha: st.firstBad.sha }), 4600);
        bridge.cheer(t("bisect.cheer", { sha: escHtml(st.firstBad.sha) }));
      }
    }
  }

  // vm + drive the canvas cues + scroll to the commit under test.
  private applyStatus(st: BisectStatus | null) {
    this.applyVM(st);
    bridge.syncBisectMarks(st); // row-model + dirty (canvas repaints next frame)
    bridge.focusBisectCurrent(); // select + scroll to bisect.cur
  }

  private async refresh() {
    let st: BisectStatus | null = null;
    try {
      st = await commands.bisectStatus(this.repo);
    } catch (e) {
      console.error("bisect_status", e);
    }
    this.applyStatus(st);
  }

  // ── on-open probe: resume a bisect left running from a prior session ─────
  // Called once when a repo opens (see legacy/main.ts's openRepo). If the app
  // quit (or the user switched repos) mid-bisect, the repo's .git is left in
  // a detached-HEAD, mid-sequencer state on disk with nothing in memory to
  // say so. This reads the real on-disk state (bisect_status is read-only,
  // safe to call anytime) and, only if a bisect is genuinely still running,
  // resurfaces the modal + canvas cues exactly like a normal refresh would.
  // A clean repo (or any failure) is left completely untouched: no modal, no
  // toast, nothing closed that wasn't already closed.
  async probeOnOpen(repo: string): Promise<void> {
    if (!repo || !IN_TAURI) return;
    let st: BisectStatus | null = null;
    try {
      st = await commands.bisectStatus(repo);
    } catch (e) {
      console.error("bisect_status", e);
      return;
    }
    if (!st || st.ok === false || !st.inProgress) return; // nothing to resume
    this.repo = repo;
    this.applyStatus(st); // vm + canvas cues, same as a normal refresh
    this.open = true;
    // Passive recovery, not an active mutation: no "thinking"/busy state —
    // just a one-time heads-up that we picked the session back up.
    bridge.tama.set("hint");
    bridge.tama.say(t("bisect.say_welcome_back"), 5200);
  }

  // ── real flow (from the legacy drawer) ────────────────────────────────────
  async start(repo: string, badSha: string, goodSha: string) {
    if (this.busy) return;
    if (!repo) {
      bridge.tama.warn(t("bisect.open_repo_first"));
      return;
    }
    this.demo = false;
    this.repo = repo;
    this.cheered = false;
    this.est0 = 0;
    this.tamaImg = bridge.TAMA_IMG.curious; // hunting for the first bad commit
    this.busy = true;
    bridge.tama.set("thinking");
    bridge.tama.say(t("bisect.say_starting", { good: goodSha, bad: badSha }));
    try {
      const st = await commands.bisectStart(repo, badSha, [goodSha]); // snapshots + checks out midpoint
      if (!st || st.ok === false) {
        bridge.tama.warn(t("bisect.warn_start_failed", { reason: be(st && st.message) || t("bisect.unknown_error") }));
        return;
      }
      await bridge.reloadGraph(true);
      await this.refresh();
      this.open = true;
    } catch (e) {
      bridge.tama.warn(t("bisect.warn_start_failed", { reason: String(e) }));
    } finally {
      this.busy = false;
    }
  }

  async mark(term: BisectTerm) {
    if (this.demo) {
      // legacy mutates the row-model + repaints, returns a partial demo status
      // (browser-only; the VM getters read every field defensively).
      this.applyVM(bridge.demoBisectMark(term) as unknown as BisectStatus);
      return;
    }
    // Defense-in-depth (unreachable via the shipped UI: `marksDisabled` already
    // guards the mark buttons on `autoRunning`) — matches `reset()`'s guard so
    // a stray/direct call can't race a manual mark against the automated
    // run's own good/bad/skip calls while it's mid-loop.
    if (this.busy || this.autoRunning || !this.repo) return;
    this.busy = true;
    this.activeTerm = term;
    bridge.tama.set("thinking");
    bridge.tama.say("");
    try {
      const st = await commands.bisectMark(this.repo, term); // HEAD moves (or converges)
      await bridge.reloadGraph(true); // rebuild rows
      await this.refresh();
      if (st && st.ok === false) bridge.tama.warn(t("bisect.warn_mark_failed", { reason: be(st.message) || t("bisect.try_again") }));
    } catch (e) {
      bridge.tama.warn(t("bisect.warn_mark_failed", { reason: String(e) }));
    } finally {
      this.busy = false;
      this.activeTerm = null;
    }
  }

  // ── automated run: `bisect run <command>` ─────────────────────────────────
  // bisectRunStart blocks on the Rust side for the WHOLE loop (many marks),
  // emitting "bisect-run-progress" once per applied step in the meantime. No
  // typed/generated event helper exists in this codebase — every other
  // listener (see src/main.ts's "repo-changed") goes through the raw
  // `window.__TAURI__.event.listen`, so this mirrors that exactly rather than
  // inventing a second subscription mechanism. The listener is armed BEFORE
  // the blocking await so no early step is missed, and each event is funneled
  // through `applyStatus` — the SAME function the manual good/bad/skip flow
  // uses — so the canvas gutter/ring cues update identically either way.
  async startRun(repo: string) {
    if (this.demo) {
      bridge.tama.warn(t("bisect.warn_auto_needs_repo"));
      return;
    }
    if (this.busy || this.autoRunning || !repo) return;
    const cmd = this.runCommand.trim();
    if (!cmd) {
      bridge.tama.warn(t("bisect.warn_enter_command"));
      return;
    }
    this.autoRunning = true;
    bridge.tama.set("thinking");
    bridge.tama.say(t("bisect.say_running_cmd", { cmd }));
    try {
      const w = window as unknown as { __TAURI__?: any };
      this.runUnlisten =
        (await w.__TAURI__?.event.listen("bisect-run-progress", (e: { payload: BisectStatus }) => {
          this.applyStatus(e.payload); // same canvas-cue path a manual mark drives
        })) ?? null;
      const st = await commands.bisectRunStart(repo, cmd); // blocks until converged/aborted/cancelled
      await bridge.reloadGraph(true); // rebuild rows, mirrors mark()'s finishing touch
      this.applyStatus(st); // final status is authoritative even if an event raced it
      if (st && st.ok === false) bridge.tama.warn(t("bisect.warn_run_stopped", { reason: be(st.message) || t("bisect.try_again") }));
    } catch (e) {
      bridge.tama.warn(t("bisect.warn_run_failed", { reason: String(e) }));
    } finally {
      this.stopListening();
      this.autoRunning = false;
    }
  }

  // Always callable — mirrors bisect_run_cancel's "must always be able to
  // run" escape-hatch spirit on the Rust side. Only requests the stop; the
  // loop notices before its NEXT step, so `autoRunning` flips back to false
  // via startRun's own finally once the in-flight call actually settles.
  async cancelRun() {
    try {
      await commands.bisectRunCancel();
    } catch (e) {
      bridge.tama.warn(t("bisect.warn_cancel_failed", { reason: String(e) }));
    }
  }

  // Best-effort guard shared by close() and legacy/main.ts's openRepo(): the
  // backend's bisect_run_start call is a real, long-lived blocking Tauri
  // invocation actually executing the user's command against the repo's
  // working tree — closing the modal or switching repos must not just
  // abandon the frontend's ability to see/stop it (it would keep running
  // headlessly, repeatedly testing and checking out commits, with progress
  // events silently misapplied once the current repo/view has moved on).
  // Only requests the stop (see cancelRun's own TOCTOU note above — it can't
  // interrupt a step already in flight, only ask it to stop before the next
  // one); does not wait for the backend loop to actually finish.
  async cancelIfRunning() {
    if (this.autoRunning) await this.cancelRun();
  }

  private stopListening() {
    this.runUnlisten?.();
    this.runUnlisten = null;
  }

  async reset() {
    if (this.demo) {
      this.endReset();
      bridge.clearBisectMarks();
      bridge.tama.set("hint");
      bridge.tama.say(t("bisect.say_ended_branch"));
      return;
    }
    if (this.busy || this.autoRunning) return; // cancel the automated run first
    if (!this.repo) {
      this.endReset();
      return;
    }
    this.busy = true;
    try {
      const r = await commands.bisectReset(this.repo); // restores original HEAD/branch
      if (r && r.ok === false) {
        bridge.tama.warn(t("bisect.warn_reset_failed", { reason: be(r.message) || t("bisect.reset_detached") }));
        return;
      }
      this.endReset();
      await bridge.reloadGraph(true);
      bridge.clearBisectMarks();
      bridge.tama.set("celebrate");
      bridge.tama.say(be(r && r.message) || t("bisect.say_ended_restored"), 3600);
    } catch (e) {
      bridge.tama.warn(t("bisect.warn_reset_failed", { reason: String(e) }));
    } finally {
      this.busy = false;
    }
  }

  // ── design-mode demo (browser) ────────────────────────────────────────────
  openDemo(status: BisectStatus) {
    this.demo = true;
    this.cheered = false;
    this.est0 = 0;
    this.tamaImg = bridge.TAMA_IMG.curious; // hunting for the first bad commit
    this.applyVM(status);
    this.open = true;
  }

  // ── modal lifecycle ───────────────────────────────────────────────────────
  reopen() {
    this.open = true;
  }
  close() {
    // non-destructive: hide the modal, the bisect keeps running (re-open via drawer).
    // Best-effort: also request the automated run stop, if one is in flight —
    // see cancelIfRunning's own note. Fired without awaiting so the modal
    // itself still hides instantly rather than waiting on the IPC round-trip.
    void this.cancelIfRunning();
    this.open = false;
  }
  private endReset() {
    this.open = false;
    this.vm = null;
    this.demo = false;
    this.cheered = false;
    this.est0 = 0;
    this.runCommand = "";
  }
}

export const bisectCtrl = new BisectState();
