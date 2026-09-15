// Compare two commits (#49) — controller.
//
// Opened from the commit context menu's "Compare with <sha>…", which is the
// ONE entry point: the anchor is whatever commit is currently selected, and
// the right-clicked commit is the other endpoint. Shift+click was the other
// candidate and is deliberately not wired — a gesture nobody can discover is
// not a feature, and the menu item says what it will do before you commit to it.
//
// All the work is in the backend (`commit_range_summary`): merge-base,
// ahead/behind, one tree-to-tree diff, and a capped chain. This holds the
// popover's position, the in-flight state, and the result.

import { commands, type RangeSummary } from "@/ipc/bindings";
import * as bridge from "@/legacy/bridge";
import { be } from "@/i18n/i18n.svelte.ts";
import { IN_TAURI } from "@/ipc/env";

/** Demo-mode stand-in, same convention as the other islands' DEMO_* data. */
const DEMO: RangeSummary = {
  from: "a1b2c3d",
  to: "9f8e7d6",
  mergeBase: "a1b2c3d",
  linear: true,
  ahead: 3,
  behind: 0,
  filesChanged: 4,
  additions: 128,
  deletions: 37,
  commits: [
    { sha: "9f8e7d6", subject: "Tidy the parser's error paths" },
    { sha: "5c4b3a2", subject: "Add the widget" },
    { sha: "1e2f3a4", subject: "Bump deps" },
  ],
  truncated: false,
};

class RangeSummaryState {
  open = $state(false);
  x = $state(0);
  y = $state(0);

  /** The two endpoints as the user picked them, for the header. */
  aShort = $state("");
  bShort = $state("");

  loading = $state(false);
  error = $state<string | null>(null);
  summary = $state<RangeSummary | null>(null);

  /**
   * Monotonic request id, same race guard as detail.svelte.ts's detailSeq: the
   * popover can be retargeted (compare A..B, then immediately A..C) while the
   * first walk is still running, and the slower answer must not overwrite the
   * newer one.
   */
  #seq = 0;

  /**
   * Open at the cursor and fetch. `a` is the anchor (the selected commit), `b`
   * the right-clicked one; both are FULL oids resolved by the caller, the same
   * way commitMenuCtrl.openAt's are — this does no BACKEND/G lookups of its own.
   */
  async openAt(repo: string, a: string, b: string, x: number, y: number) {
    const mine = ++this.#seq;
    this.x = x;
    this.y = y;
    this.aShort = a.slice(0, 7);
    this.bShort = b.slice(0, 7);
    this.summary = null;
    this.error = null;
    this.loading = true;
    this.open = true;

    if (!IN_TAURI) {
      this.summary = DEMO;
      this.loading = false;
      return;
    }
    try {
      const r = await commands.commitRangeSummary(repo, a, b);
      if (mine !== this.#seq) return; // a newer compare superseded this one
      if (r.status === "ok") this.summary = r.data;
      else this.error = be(r.error);
    } catch (e) {
      if (mine !== this.#seq) return;
      this.error = String(e);
    } finally {
      if (mine === this.#seq) this.loading = false;
    }
  }

  close() {
    // Bump the sequence so an in-flight walk that lands after this cannot
    // reopen the popover's contents behind the user's back.
    this.#seq++;
    this.open = false;
    this.loading = false;
    this.summary = null;
    this.error = null;
    this.aShort = "";
    this.bShort = "";
  }
}

export const rangeSummaryCtrl = new RangeSummaryState();

/** Resolve a row to its full oid the same way the commit menu's caller does. */
export function oidOfRow(row: number): string | null {
  const B = bridge.BACKEND as unknown as { oids?: string[]; rows?: { sha: string }[] } | null;
  if (!B) return null;
  if (B.oids && B.oids[row]) return B.oids[row];
  return B.rows && B.rows[row] ? B.rows[row].sha : null;
}
