// Snapshot preview — controller (Svelte 5 runes singleton).
//
// Clicking a snapshot — either a tick on the vertical "snapshots" ribbon
// (legacy/main.ts's positionTicks) or a row in the sidebar's Snapshots group
// (Sidebar.svelte) — used to do nothing useful (the ribbon tick only pulsed;
// the sidebar row only copied its sha). This makes a click PREVIEW the
// snapshot, two ways at once (the "Both" option from the design decision):
//   1. Selects the snapshot's commit IN THE GRAPH when it's a loaded row —
//      the exact scroll+select jump ⌘K's own jump() performs — so the Detail
//      panel fills in with that commit's full diff.
//   2. Opens a compact popover anchored at the click with the commit's
//      subject, sha, age, and file-change list — an at-a-glance preview that
//      also works for a snapshot whose commit ISN'T in the current graph
//      (rewritten history reachable only via the backup ref), where there's no
//      row to select.
//
// Preview only, by request — there is deliberately no "restore to this
// snapshot" action here; ⌘Z (undo to the newest) stays the restore path.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";
import type { CommitDetail, Snapshot } from "../../ipc/bindings";

// Popover size budget, used only to clamp its anchor inside the viewport.
const POP_W = 320;
const POP_H = 300;

/// Graph row whose commit matches `sha` (full or abbreviated, either
/// direction), or -1. A snapshot's `sha` is a full oid while a streamed graph
/// row's may be either — compare prefix-wise so both resolve.
function rowForSha(sha: string): number {
  const be = bridge.BACKEND as unknown as { rows?: Array<{ sha?: string }> } | null;
  const rows = be?.rows;
  if (!rows || !sha) return -1;
  for (let r = 0; r < rows.length; r++) {
    const rsha = rows[r]?.sha;
    if (rsha && (rsha === sha || rsha.startsWith(sha) || sha.startsWith(rsha))) return r;
  }
  return -1;
}

/// Scroll to + select a graph row — byte-for-byte the jump cmdk.jump() does
/// (position below the pinned Uncommitted-changes band, then select()).
function jumpToRow(row: number): void {
  const g = bridge.G as unknown as { N?: number } | null;
  if (row < 0 || !g || row >= (g.N ?? 0)) return;
  bridge.state.scrollTarget = bridge.clampScroll(row * bridge.layout.rowH - (bridge.view.cssH - bridge.bandH()) * 0.4);
  bridge.select(row);
  try {
    bridge.cv.focus();
  } catch {
    /* best-effort focus, never blocks the preview */
  }
}

// A small synthetic detail so design-mode (no backend) still showcases the
// popover when a demo ribbon tick is clicked.
function demoDetail(snap: Snapshot): CommitDetail {
  const sha = snap.sha || "0000000";
  return {
    sha,
    shortSha: sha.slice(0, 7),
    subject: snap.subject || "snapshot",
    body: "",
    message: snap.subject || "snapshot",
    additions: 12,
    deletions: 5,
    filesChanged: 2,
    truncated: false,
    fileTree: [
      { path: "src/lane.rs", oldPath: null, status: "M", additions: 9, deletions: 3, binary: false, truncated: false, lang: "rust", hunks: [] },
      { path: "src/view.rs", oldPath: null, status: "M", additions: 3, deletions: 2, binary: false, truncated: false, lang: "rust", hunks: [] },
    ],
  };
}

class SnapshotPreviewState {
  open = $state(false);
  x = $state(0);
  y = $state(0);
  snap = $state<Snapshot | null>(null);
  detail = $state<CommitDetail | null>(null);
  loading = $state(false);
  error = $state("");
  // Whether the snapshot's commit was found as a row in the current graph (so
  // it was also selected there) — drives a small "not in this view" hint for
  // an off-graph snapshot, where the popover is the only preview available.
  inGraph = $state(false);

  // Bumped on every open/close so a slow commit_detail load that resolves
  // AFTER a newer open (or a close) is discarded instead of overwriting it.
  private token = 0;

  async showAt(snap: Snapshot, x: number, y: number): Promise<void> {
    if (!snap) return;
    this.snap = snap;
    // Clamp the anchor so the popover stays fully on-screen (offset a little
    // off the click so it doesn't sit directly under the cursor).
    const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
    const vh = typeof window !== "undefined" ? window.innerHeight : 800;
    this.x = Math.max(8, Math.min(x + 12, vw - POP_W - 8));
    this.y = Math.max(8, Math.min(y, vh - POP_H - 8));
    this.detail = null;
    this.error = "";
    this.loading = false;
    this.open = true;
    const my = ++this.token;

    // (1) Select the commit in the graph when it's a loaded row.
    const row = rowForSha(snap.sha || "");
    this.inGraph = row >= 0;
    if (row >= 0) jumpToRow(row);

    // (2) Load its detail for the popover's summary + file list.
    if (!IN_TAURI) {
      this.detail = demoDetail(snap);
      return;
    }
    this.loading = true;
    try {
      const res = await commands.commitDetail(bridge.CUR_REPO as unknown as string, snap.sha);
      if (this.token !== my) return; // superseded by a newer open/close
      if (res.status === "ok") this.detail = res.data;
      else this.error = res.error || "Couldn't load this snapshot's commit.";
    } catch (e) {
      if (this.token !== my) return;
      this.error = "Couldn't load this snapshot's commit — " + e;
      console.error("snapshot preview commit_detail failed", e);
    } finally {
      if (this.token === my) this.loading = false;
    }
  }

  close(): void {
    this.token++; // invalidate any in-flight load
    this.open = false;
    this.snap = null;
    this.detail = null;
    this.loading = false;
    this.error = "";
    this.inGraph = false;
  }
}

export const snapshotPreviewCtrl = new SnapshotPreviewState();
