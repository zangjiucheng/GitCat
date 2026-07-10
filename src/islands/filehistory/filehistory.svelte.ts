// Per-file history (rename-following) view — controller (Svelte 5 runes
// singleton).
//
// Structural mirror of blame.svelte.ts: a real .scrim/.modal, opened on
// demand from a per-row "History" icon button in Detail.svelte's file tree
// and Workdir.svelte's staged/unstaged file rows (see those files' own
// `.wd-act` row markup) — same reasoning as Blame's own header doc for why
// this isn't wired through the Tools menu/⌘K either: it inherently needs a
// `(commit, file)` target that only exists in file-tree context.
//
// `openFor(repo, atCommit, file, oldPath?)` mirrors blameCtrl.openFor's own
// signature/lifecycle exactly: `atCommit: null` means HEAD, a sha string
// means "walk `--follow` starting from that commit's own tree" (Detail, or a
// first-parent sha the caller already resolved for a deleted/renamed-away
// file — see detail.svelte.ts's `historyFile()`, which mirrors `blameFile()`'s
// identical `<sha>^` handling). `oldPath` is ONLY for the "renamed from …"
// note in the modal head (FileHistory.svelte) — cosmetic, never sent to the
// backend, which only ever walks the exact `file` path passed in (the backend
// itself then reports every rename IT finds walking further back, via each
// entry's own `renamedFrom`).
//
// jumpToCommit(sha): deliberately its OWN copy of blameCtrl.jumpToCommit's
// body (shaRowIndex cache + scroll/select), not a call into blameCtrl —
// mirrors this codebase's existing precedent of cmdk.svelte.ts's jump() and
// blameCtrl.jumpToCommit() already being two independent copies of the same
// shape rather than one shared helper (see blameCtrl.jumpToCommit's own doc
// comment). Reusing blameCtrl's copy here would also incorrectly manipulate
// blame's `open`/`data` state instead of file-history's own.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";
import type { FileHistory, FileHistoryEntry } from "../../ipc/bindings";

// Demo data (design-mode only) — a small canned history with one rename, same
// spirit as every other island's DEMO constants, so the browser preview still
// shows a populated modal without a real backend.
const DEMO_HISTORY: FileHistory = {
  file: "src/auth/session.ts",
  atSha: "a1b2c3d4e5f6071829384756a1b2c3d4e5f60718",
  truncated: false,
  entries: [
    {
      sha: "a1b2c3da1b2c3da1b2c3da1b2c3da1b2c3da1b2",
      shortSha: "a1b2c3d",
      subject: "extend session ttl, add rate limiting",
      an: { n: "You", e: "you@example.com", t: 0 },
      path: "src/auth/session.ts",
      renamedFrom: null,
    },
    {
      sha: "bb01ccdbb01ccdbb01ccdbb01ccdbb01ccdbb01",
      shortSha: "bb01ccd",
      subject: "rename token-store -> auth/session",
      an: { n: "Ada Lovelace", e: "ada@example.com", t: 0 },
      path: "src/auth/session.ts",
      renamedFrom: "src/auth/token-store.ts",
    },
    {
      sha: "e4f5061e4f5061e4f5061e4f5061e4f5061e4f5",
      shortSha: "e4f5061",
      subject: "create token store",
      an: { n: "Ada Lovelace", e: "ada@example.com", t: 0 },
      path: "src/auth/token-store.ts",
      renamedFrom: null,
    },
  ],
};

class FileHistoryState {
  open = $state(false);
  loading = $state(false);
  error = $state<string | null>(null);
  data = $state<FileHistory | null>(null);
  // Only set when the caller's own FileChange.oldPath differs from the
  // queried path — see file header. Purely cosmetic (the "renamed from …"
  // note in FileHistory.svelte's modal head), never read by reload()/the
  // backend.
  oldPath = $state<string | null>(null);

  repo = "";
  file = "";
  atCommit: string | null = null;

  // Lazily-built sha(7-char)->row map, cached against bridge.G's identity —
  // own copy of blameCtrl's identical cache (see module doc on why this isn't
  // shared).
  private cacheG: unknown = null;
  private shaRowIndex: Map<string, number> = new Map();

  // Entry point — Detail.svelte's file-tree row / Workdir.svelte's .wd-act
  // button. Always re-fetches (see reload()'s own doc below), so reopening
  // for a different file/commit never shows stale data from whatever was
  // open before.
  async openFor(repo: string, atCommit: string | null, file: string, oldPath: string | null = null): Promise<void> {
    this.repo = repo || "";
    this.atCommit = atCommit;
    this.file = file;
    this.oldPath = oldPath && oldPath !== file ? oldPath : null;
    this.open = true;
    await this.reload();
  }

  close(): void {
    this.open = false;
    this.data = null;
    this.error = null;
  }

  // ── public refresh hook — same "safe to call repeatedly" shape as every
  // other controller's reload()/refresh().
  async reload(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      if (!IN_TAURI) {
        // design-mode preview: no backend, seed the canned demo history.
        this.data = { ...DEMO_HISTORY, entries: DEMO_HISTORY.entries.map((e) => ({ ...e })) };
        return;
      }
      if (!this.repo) {
        this.data = null;
        this.error = "Open a repository first.";
        return;
      }
      try {
        const r = await commands.fileHistory(this.repo, this.file, this.atCommit);
        if (r.status === "ok") {
          this.data = r.data;
          this.error = null;
        } else {
          this.data = null;
          this.error = String(r.error ?? "Could not load this file's history.");
        }
      } catch (e) {
        this.data = null;
        this.error = "File history unavailable — " + e;
      }
    } finally {
      this.loading = false;
    }
  }

  private ensureShaIndex(): void {
    if (this.cacheG === bridge.G) return;
    const map = new Map<string, number>();
    const G: any = bridge.G,
      BACKEND: any = bridge.BACKEND;
    const N = G ? G.N : 0;
    for (let r = 0; r < N; r++) {
      const sha: string = BACKEND ? BACKEND.rows[r]?.sha : bridge.hhex(r);
      if (sha) map.set(sha, r);
    }
    this.shaRowIndex = map;
    this.cacheG = bridge.G;
  }

  private rowForSha(shortSha7: string): number | null {
    this.ensureShaIndex();
    const row = this.shaRowIndex.get(shortSha7);
    return row == null ? null : row;
  }

  // Click a history row -> jump to that commit on the canvas. Own copy of
  // blameCtrl.jumpToCommit's body — see module doc on why this is
  // deliberately duplicated rather than shared.
  jumpToCommit(sha: string): void {
    const row = this.rowForSha(sha.slice(0, 7));
    this.close();
    if (row == null) {
      bridge.tama.warn("commit not loaded in the current graph");
      return;
    }
    const G: any = bridge.G;
    if (!G || row < 0 || row >= G.N) return;
    bridge.state.scrollTarget = bridge.clampScroll(row * bridge.layout.rowH - (bridge.view.cssH - bridge.bandH()) * 0.4);
    bridge.select(row);
    try {
      bridge.cv.focus();
    } catch (_) {
      /* best-effort focus, never blocks the jump */
    }
  }
}

export const fileHistoryCtrl = new FileHistoryState();
export type { FileHistoryEntry };
