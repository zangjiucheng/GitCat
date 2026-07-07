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
import type { BisectStatus } from "../../ipc/bindings";

// specta generates `term: string`; keep the precise union at the call boundary.
type BisectTerm = "good" | "bad" | "skip";

function escHtml(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

class BisectState {
  open = $state(false);
  busy = $state(false);
  demo = $state(false);
  vm = $state<BisectStatus | null>(null);
  tamaImg = $state("");

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
    if (this.done) return "converged — first bad commit isolated";
    const rem = this.vm?.remainingRevs ?? 0;
    const steps = this.vm?.estSteps ?? 0;
    return (
      rem.toLocaleString() + " revision" + (rem === 1 ? "" : "s") +
      " left · ~" + steps + " step" + (steps === 1 ? "" : "s")
    );
  }
  get fillPct(): number {
    if (this.done) return 100;
    const steps = this.vm?.estSteps ?? 0;
    return Math.max(4, Math.round(100 * (1 - steps / Math.max(this.est0 || steps || 1, 1))));
  }
  get hint(): string {
    return this.done
      ? "Found the culprit. Reset to return to your branch — nothing was lost."
      : "Is the bug present in the commit below? Mark it Good, Bad, or Skip.";
  }
  get marksDisabled(): boolean {
    return this.busy || !this.inProgress;
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
        bridge.tama.say("Found it — first bad commit " + st.firstBad.sha + ".", 4600);
        bridge.cheer('First bad commit: <b>' + escHtml(st.firstBad.sha) + '</b>. <span class="jp">みつけた!</span>');
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

  // ── real flow (from the legacy drawer) ────────────────────────────────────
  async start(repo: string, badSha: string, goodSha: string) {
    if (this.busy) return;
    if (!repo) {
      bridge.tama.warn("Open a repository first.");
      return;
    }
    this.demo = false;
    this.repo = repo;
    this.cheered = false;
    this.est0 = 0;
    this.tamaImg = bridge.TAMA_IMG.alarm;
    this.busy = true;
    bridge.tama.set("thinking");
    bridge.tama.say("Starting bisect between " + goodSha + " and " + badSha + "…");
    try {
      const st = await commands.bisectStart(repo, badSha, [goodSha]); // snapshots + checks out midpoint
      if (!st || st.ok === false) {
        bridge.tama.warn("Couldn't start bisect — " + ((st && st.message) || "unknown error"));
        return;
      }
      await bridge.reloadGraph(true);
      await this.refresh();
      this.open = true;
    } catch (e) {
      bridge.tama.warn("Couldn't start bisect — " + e);
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
    if (this.busy || !this.repo) return;
    this.busy = true;
    bridge.tama.set("thinking");
    bridge.tama.say("");
    try {
      const st = await commands.bisectMark(this.repo, term); // HEAD moves (or converges)
      await bridge.reloadGraph(true); // rebuild rows
      await this.refresh();
      if (st && st.ok === false) bridge.tama.warn("Bisect mark failed — " + (st.message || "try again."));
    } catch (e) {
      bridge.tama.warn("Bisect mark failed — " + e);
    } finally {
      this.busy = false;
    }
  }

  async reset() {
    if (this.demo) {
      this.endReset();
      bridge.clearBisectMarks();
      bridge.tama.set("hint");
      bridge.tama.say("Bisect ended — back on your branch.");
      return;
    }
    if (this.busy) return;
    if (!this.repo) {
      this.endReset();
      return;
    }
    this.busy = true;
    try {
      const r = await commands.bisectReset(this.repo); // restores original HEAD/branch
      if (r && r.ok === false) {
        bridge.tama.warn("Bisect reset failed — " + (r.message || "HEAD still detached; clean the tree and retry."));
        return;
      }
      this.endReset();
      await bridge.reloadGraph(true);
      bridge.clearBisectMarks();
      bridge.tama.set("celebrate");
      bridge.tama.say((r && r.message) || "Bisect ended — HEAD restored to your branch.", 3600);
    } catch (e) {
      bridge.tama.warn("Bisect reset failed — " + e);
    } finally {
      this.busy = false;
    }
  }

  // ── design-mode demo (browser) ────────────────────────────────────────────
  openDemo(status: BisectStatus) {
    this.demo = true;
    this.cheered = false;
    this.est0 = 0;
    this.tamaImg = bridge.TAMA_IMG.alarm;
    this.applyVM(status);
    this.open = true;
  }

  // ── modal lifecycle ───────────────────────────────────────────────────────
  reopen() {
    this.open = true;
  }
  close() {
    // non-destructive: hide the modal, the bisect keeps running (re-open via drawer)
    this.open = false;
  }
  private endReset() {
    this.open = false;
    this.vm = null;
    this.demo = false;
    this.cheered = false;
    this.est0 = 0;
  }
}

export const bisectCtrl = new BisectState();
