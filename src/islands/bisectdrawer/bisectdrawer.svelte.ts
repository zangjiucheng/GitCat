// Bisect drawer chrome — controller (Svelte 5 runes singleton).
//
// This is DIFFERENT from bisectCtrl (src/islands/bisect/bisect.svelte.ts),
// which owns the real in-progress MODAL (good/bad/skip talking to the
// backend). This controller owns the always-visible DRAWER pane's own
// pre-start state: letting the user "arm" candidate good/bad rows and see
// the narrowing range directly on the canvas BEFORE a real bisect exists.
// `bisectCtrl` only syncs INTO this local row-model (via syncBisectMarks/
// focusBisectCurrent/clearBisectMarks/demoBisectStatus/demoBisectMark, all
// re-pointed here from legacy/bridge.ts) once a real bisect is running or in
// demo mode — this is a peer import (bisectCtrl calls through bridge.*,
// legacy/main.ts imports bisectDrawerCtrl directly), the first instance of
// one island importing another, same shape as legacy's existing direct-
// singleton-import convention.
//
// The canvas RAF loop (legacy/main.ts's draw()) reads active()/skips/cur
// directly, every frame, to recolor the candidate range and current-test dot
// — that read happens outside Svelte's reactivity (draw() isn't a component),
// but $state fields are plain reactive values, readable synchronously from
// anywhere, so a plain property/getter read works exactly like before.

import * as bridge from "../../legacy/bridge";
import { bisectCtrl } from "../bisect/bisect.svelte.ts";
import { IN_TAURI } from "../../ipc/env";
import type { BisectStatus } from "../../ipc/bindings";

function esc(s: unknown): string {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
}

type Range = { lo: number; hi: number; good: number; bad: number };
export type BisectTerm = "good" | "bad" | "skip";

const DEFAULT_HINT = 'Select a commit in the graph, then mark it <b>good</b> or <b>bad</b> to narrow the range on the canvas.';

class BisectDrawerState {
  good = $state<number | null>(null);
  bad = $state<number | null>(null);
  cur = $state<number | null>(null);
  skips = $state<Set<number>>(new Set());

  active(): Range | null {
    if (this.good == null || this.bad == null) return null;
    const lo = Math.min(this.good, this.bad),
      hi = Math.max(this.good, this.bad);
    return { lo, hi, good: this.good, bad: this.bad };
  }

  candidates(): number[] {
    const B = this.active();
    if (!B) return [];
    const out: number[] = [];
    for (let r = B.lo + 1; r < B.hi; r++) if (!this.skips.has(r)) out.push(r);
    return out;
  }

  get stepsText(): string {
    const B = this.active();
    if (!B) return "≈0 steps left";
    const n = this.candidates().length;
    const steps = n <= 1 ? 0 : Math.ceil(Math.log2(n));
    return "≈" + steps + " steps left";
  }

  get fillPct(): number {
    const B = this.active();
    if (!B) return 0;
    const span = B.hi - B.lo - 1;
    const total = Math.max(1, Math.ceil(Math.log2(Math.max(2, span))));
    const n = this.candidates().length;
    const steps = n <= 1 ? 0 : Math.ceil(Math.log2(n));
    return 100 * (1 - steps / total);
  }

  get rangeCells(): { culled: boolean }[] {
    const B = this.active();
    if (!B) return [];
    const span = B.hi - B.lo - 1;
    const BUCKETS = Math.min(48, Math.max(span, 1));
    const cells: { culled: boolean }[] = [];
    for (let i = 0; i < BUCKETS; i++) {
      const r = B.lo + 1 + Math.floor((i * span) / BUCKETS);
      cells.push({ culled: this.skips.has(r) });
    }
    return cells;
  }

  get curHtml(): string {
    const B = this.active();
    if (!B) return DEFAULT_HINT;
    const cand = this.candidates();
    const n = cand.length;
    if (n === 0) {
      return `First bad commit isolated &#8594; <b>${bridge.hhex(this.bad!)}</b>. ${esc(bridge.msgOf(this.bad!))}`;
    }
    const mid = cand[Math.floor(cand.length / 2)];
    return (
      `Testing next: <b>${bridge.hhex(mid)}</b> &#8212; ${esc(bridge.msgOf(mid))}. ` +
      `<span class="mut">${n} candidate${n > 1 ? "s" : ""} in range &#183; read from <code>.git/BISECT_LOG</code>.</span>`
    );
  }

  // ── drawer buttons ─────────────────────────────────────────────────────
  mark(term: BisectTerm) {
    if (bisectCtrl.running) {
      bridge.tama.set("hint");
      bridge.tama.say("A bisect is already running — use Good / Skip / Bad in the panel above.");
      return;
    }
    const r = bridge.state.selectedRow;
    if (r < 0) {
      bridge.tama.set("hint");
      bridge.tama.say("Pick a commit in the graph first, then mark it " + term + ".");
      return;
    }
    if (term === "good") {
      this.good = r;
      if (this.bad === r) this.bad = null;
    } else if (term === "bad") {
      this.bad = r;
      if (this.good === r) this.good = null;
    } else {
      this.skips = new Set(this.skips).add(r);
    }
    bridge.ensureDrawerOpen("bisect");
    bridge.requestRedraw();
    bridge.tama.set("hint");
    bridge.tama.say("Marked " + bridge.hhex(r) + " " + term + ".");
  }

  reset() {
    if (bisectCtrl.running) {
      bisectCtrl.reset();
      return;
    }
    this.clearLocalMarks();
    bridge.tama.set("hint");
    bridge.tama.say("Bisect reset.");
  }

  async start() {
    if (bisectCtrl.running) {
      bisectCtrl.reopen();
      return;
    }
    const goodR = this.good;
    let badR = this.bad;
    if (badR == null) badR = 0; // convenience: known-bad defaults to HEAD (row 0)
    if (goodR == null) {
      bridge.ensureDrawerOpen("bisect");
      bridge.tama.set("hint");
      bridge.tama.say("Select a known-good commit and press Mark good, then Start bisect.");
      return;
    }
    const BACKEND: any = bridge.BACKEND;
    const goodSha = BACKEND && BACKEND.rows[goodR] ? BACKEND.rows[goodR].sha : bridge.hhex(goodR);
    const badSha = BACKEND && BACKEND.rows[badR] ? BACKEND.rows[badR].sha : bridge.hhex(badR);
    if (!IN_TAURI) {
      // ---- design-mode demo -> bisectCtrl's modal ----
      this.good = goodR;
      this.bad = badR;
      this.skips = new Set();
      const st = this.demoBisectStatus();
      bridge.requestRedraw();
      bisectCtrl.openDemo(st as unknown as BisectStatus);
      bridge.tama.set("thinking");
      bridge.tama.say("Bisecting between " + bridge.hhex(goodR) + " (good) and " + bridge.hhex(badR) + " (bad).");
      return;
    }
    await bisectCtrl.start(bridge.CUR_REPO as unknown as string, badSha, goodSha); // real: bisectCtrl owns the modal + IPC
  }

  // ── bridged from bisectCtrl (real + demo flows sync INTO this row-model) ──
  private bisectRowOf(sha: string | null | undefined): number {
    const BACKEND: any = bridge.BACKEND;
    if (!sha || !BACKEND || !BACKEND.rows) return -1;
    const s = String(sha);
    return BACKEND.rows.findIndex((r: any) => r.sha === s || s.startsWith(r.sha) || r.sha.startsWith(s));
  }

  syncBisectMarks(st: BisectStatus | null) {
    this.good = null;
    this.bad = null;
    this.cur = null;
    this.skips = new Set();
    if (!st) {
      bridge.requestRedraw();
      return;
    }
    const badR = this.bisectRowOf(st.firstBad ? st.firstBad.sha : (st as any).badRef);
    if (badR >= 0) this.bad = badR;
    let goodR = -1;
    ((st as any).goodRefs || []).forEach((g: string) => {
      const r = this.bisectRowOf(g);
      if (r > badR && (goodR < 0 || r < goodR)) goodR = r;
    });
    if (goodR < 0)
      ((st as any).goodRefs || []).forEach((g: string) => {
        const r = this.bisectRowOf(g);
        if (r >= 0 && (goodR < 0 || r > goodR)) goodR = r;
      });
    if (goodR >= 0) this.good = goodR;
    const curR = this.bisectRowOf(st.firstBad ? st.firstBad.sha : st.current && st.current.sha);
    if (curR >= 0) this.cur = curR;
    bridge.requestRedraw();
  }

  focusBisectCurrent() {
    if (this.cur == null) return;
    bridge.select(this.cur);
    bridge.state.scrollTarget = bridge.clampScroll(this.cur * bridge.layout.rowH - bridge.view.cssH / 2);
    bridge.requestRedraw();
  }

  clearBisectMarks() {
    this.clearLocalMarks();
  }

  // Boot-path reset (loadGraph/bootEmpty) — distinct from reset(), which also
  // aborts a running bisectCtrl; this only ever clears the local row-model.
  clearLocalMarks() {
    this.good = null;
    this.bad = null;
    this.cur = null;
    this.skips = new Set();
    bridge.requestRedraw();
  }

  demoBisectStatus() {
    const B = this.active();
    if (!B) return { inProgress: false, demo: true };
    const cand = this.candidates();
    if (cand.length <= 0) {
      this.cur = this.bad;
      return {
        inProgress: false,
        demo: true,
        firstBad: { sha: bridge.hhex(this.bad!), subject: bridge.msgOf(this.bad!) },
        remainingRevs: 0,
        estSteps: 0,
      };
    }
    const mid = cand[Math.floor(cand.length / 2)];
    this.cur = mid;
    return {
      inProgress: true,
      demo: true,
      current: { sha: bridge.hhex(mid), subject: bridge.msgOf(mid) },
      remainingRevs: cand.length,
      estSteps: Math.max(1, Math.ceil(Math.log2(Math.max(2, cand.length)))),
    };
  }

  demoBisectMark(term: BisectTerm) {
    const mid = this.cur;
    if (mid == null) return this.demoBisectStatus();
    if (term === "good") this.good = mid;
    else if (term === "bad") this.bad = mid;
    else this.skips = new Set(this.skips).add(mid);
    const st = this.demoBisectStatus();
    bridge.requestRedraw();
    return st;
  }
}

export const bisectDrawerCtrl = new BisectDrawerState();

// Thin standalone-function exports so legacy/bridge.ts can re-export these
// with the EXACT call shape bisectCtrl already uses (bridge.syncBisectMarks(st),
// not bridge.bisectDrawerCtrl.syncBisectMarks(st)) — bisectCtrl's own code
// needed zero changes when this moved from legacy/main.ts to here, only the
// re-export source in bridge.ts did.
export function syncBisectMarks(st: BisectStatus | null) {
  bisectDrawerCtrl.syncBisectMarks(st);
}
export function focusBisectCurrent() {
  bisectDrawerCtrl.focusBisectCurrent();
}
export function clearBisectMarks() {
  bisectDrawerCtrl.clearBisectMarks();
}
export function demoBisectStatus() {
  return bisectDrawerCtrl.demoBisectStatus();
}
export function demoBisectMark(term: BisectTerm) {
  return bisectDrawerCtrl.demoBisectMark(term);
}
