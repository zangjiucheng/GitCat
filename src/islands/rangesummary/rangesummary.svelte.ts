// Compare two commits (#49) — controller.
//
// Two entry points:
//   * the commit context menu's "Compare with <sha>…": the anchor is whatever
//     commit is currently selected, and the right-clicked commit is the other
//     endpoint. Shift+click was the other candidate and is deliberately not
//     wired — a gesture nobody can discover is not a feature, and the menu
//     item says what it will do before you commit to it;
//   * the sidebar's branch and tag menus, "Compare with current branch": the
//     anchor is HEAD and the endpoints are revisions, not oids (see
//     compare.rs's module doc).
//
// All the work is in the backend (`commit_range_summary`): merge-base,
// ahead/behind, one tree-to-tree diff, and a capped chain. This holds the
// popover's position, the in-flight state, and the result.

import { commands, type RangeSummary, type RangeDiff, type FileChange } from "@/ipc/bindings";
import { buildDiffRows } from "../detail/diffrows.ts";
import type { DiffRow } from "../detail/detail.svelte.ts";
import * as bridge from "@/legacy/bridge";
import { be } from "@/i18n/i18n.svelte.ts";
import { IN_TAURI } from "@/ipc/env";
import { externalToolsCtrl } from "../externaltools/externaltools.svelte.ts";
import { pluginLanguagesCtrl } from "../pluginlanguages/pluginlanguages.svelte.ts";

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

const DEMO_DIFF: RangeDiff = {
  from: "a1b2c3d",
  to: "9f8e7d6",
  fromOid: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  toOid: "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432",
  canSinceFork: false,
  sinceFork: false,
  filesChanged: 1,
  additions: 2,
  deletions: 1,
  truncated: false,
  fileTree: [
    {
      path: "src/parser.ts",
      oldPath: null,
      status: "M",
      additions: 2,
      deletions: 1,
      binary: false,
      truncated: false,
      lang: "ts",
      hunks: [
        {
          header: "@@ -1,3 +1,4 @@",
          lines: [
            { kind: " ", oldNo: 1, newNo: 1, text: "export function parse(src: string) {" },
            { kind: "-", oldNo: 2, newNo: null, text: "  return src.split(\"\\n\");" },
            { kind: "+", oldNo: null, newNo: 2, text: "  if (!src) return [];" },
            { kind: "+", oldNo: null, newNo: 3, text: "  return src.split(/\\r?\\n/);" },
            { kind: " ", oldNo: 3, newNo: 4, text: "}" },
          ],
        },
      ],
    } as unknown as FileChange,
  ],
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
   * Open at the cursor and fetch. `a` is the anchor (the selected commit, or
   * HEAD), `b` the other endpoint. Either is a FULL oid resolved by the
   * caller, the same way commitMenuCtrl.openAt's are, or a revision the
   * backend resolves (`HEAD`, `refs/heads/x`) — this does no BACKEND/G
   * lookups of its own. `labels` name a revision for the header; an oid
   * needs none, it shows as its short sha.
   */
  #repo = "";
  #aFull = "";
  #bFull = "";

  async openAt(repo: string, a: string, b: string, x: number, y: number, labels: { a?: string; b?: string } = {}) {
    void pluginLanguagesCtrl.ensureLoaded(); // see detail.svelte.ts's select() for why this fires here too
    const mine = ++this.#seq;
    this.#repo = repo;
    this.#aFull = a;
    this.#bFull = b;
    this.x = x;
    this.y = y;
    this.aShort = labels.a ?? a.slice(0, 7);
    this.bShort = labels.b ?? b.slice(0, 7);
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

  // ── the full diff (a modal, not the popover) ────────────────────────────
  //
  // Split from the summary on purpose, and the backend is split the same way:
  // the popover opens on every compare and stays cheap (one Diff::stats, no
  // per-file patches), while this builds a Patch per file and is only fetched
  // when the user actually asks to see the diff.

  diffOpen = $state(false);
  diffLoading = $state(false);
  diffError = $state<string | null>(null);
  diff = $state<RangeDiff | null>(null);
  /** Which file's hunks are on screen. */
  selectedFile = $state<string | null>(null);
  rows = $state<DiffRow[]>([]);

  /** The two endpoints the OPEN diff is for — kept so closing the popover
   *  underneath cannot blank the modal's own header. */
  diffA = $state("");
  diffB = $state("");

  #diffSeq = 0;
  #diffRepo = "";

  /**
   * `sinceFork`: for a diverged pair, only what `b` did since the fork
   * (`git diff a...b`) instead of tip to tip. The backend ignores it where it
   * means nothing and says so in the result (`canSinceFork`), which is what
   * the modal's toggle keys off.
   */
  async openDiff(sinceFork = false) {
    const a = this.aShort, b = this.bShort;
    this.diffA = a;
    this.diffB = b;
    this.#diffRepo = this.#repo;
    this.open = false; // the popover steps aside; the modal is the surface now
    await this.#loadDiff(sinceFork);
  }

  /** Switch the open diff between tip-to-tip and since-the-fork. */
  setSinceFork(on: boolean) {
    if (!this.diff || this.diff.sinceFork === on) return;
    void this.#loadDiff(on);
  }

  async #loadDiff(sinceFork: boolean) {
    const repo = this.#diffRepo;
    const mine = ++this.#diffSeq;
    this.diff = null;
    this.rows = [];
    this.selectedFile = null;
    this.diffError = null;
    this.diffLoading = true;
    this.diffOpen = true;

    if (!IN_TAURI) {
      // Named after the picked endpoints, so the header reads like the real thing.
      this.diff = { ...DEMO_DIFF, from: this.diffA, to: this.diffB };
      this.diffLoading = false;
      this.selectFile(DEMO_DIFF.fileTree[0]?.path ?? null);
      return;
    }
    try {
      const r = await commands.commitRangeDiff(repo, this.#aFull, this.#bFull, sinceFork);
      if (mine !== this.#diffSeq) return;
      if (r.status === "ok") {
        this.diff = r.data;
        this.selectFile(r.data.fileTree[0]?.path ?? null);
      } else {
        this.diffError = be(r.error);
      }
    } catch (e) {
      if (mine !== this.#diffSeq) return;
      this.diffError = String(e);
    } finally {
      if (mine === this.#diffSeq) this.diffLoading = false;
    }
  }

  /** Show one file's hunks. Every file's diff is already in hand — no IPC. */
  selectFile(path: string | null) {
    this.selectedFile = path;
    const f = path ? this.diff?.fileTree.find((x) => x.path === path) : undefined;
    if (!f) {
      this.rows = [];
      return;
    }
    if (f.binary) {
      this.rows = [{ kind: "note", text: "binary file — not shown" }];
      return;
    }
    // Flatten the file's hunks into the [marker, text] shape the shared row
    // builder takes — the same shape commit detail hands it.
    const lines: [string, string][] = [];
    for (const h of f.hunks ?? []) {
      lines.push(["@@", h.header]);
      for (const l of h.lines ?? []) lines.push([l.kind, l.text]);
    }
    this.rows = buildDiffRows({ lang: bridge.resolveLang(f.path), lines, truncated: !!f.truncated });
  }

  /**
   * One file of the open diff in the user's external diff tool. The two full
   * oids come from the diff itself, so the tool shows exactly these two trees
   * — the merge base included when the diff is since the fork.
   */
  openExternalDiff(path: string) {
    const d = this.diff;
    if (!d) return;
    void externalToolsCtrl.openDiff(this.#diffRepo, path, false, d.fromOid, d.toOid);
  }

  closeDiff() {
    this.#diffSeq++;
    this.diffOpen = false;
    this.diffLoading = false;
    this.diff = null;
    this.rows = [];
    this.selectedFile = null;
    this.diffError = null;
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
