// Blame (line-annotation) view — controller (Svelte 5 runes singleton).
//
// A real .scrim/.modal, opened on demand from a per-row "Blame" icon button
// in Detail.svelte's file tree and Workdir.svelte's staged/unstaged file
// rows (see those files' own `.wd-act`/`.file` row markup) — NOT wired
// through the Tools menu or ⌘K (unlike Reflog/Rerere/Plumbing), since Blame
// inherently needs a `(commit, file)` target that only exists in file-tree
// context; see design doc §3.
//
// `openFor(repo, atCommit, file, oldPath?)` is the one public entry point
// both triggers call: `atCommit: null` means HEAD (Workdir's only sensible
// target — blaming a dirty-but-tracked file still shows HEAD's last
// committed version, see blame.rs's own module doc), a sha string means "that
// commit's own tree" (Detail, or a first-parent sha the caller already
// resolved for a deleted/renamed-away file — see Detail.svelte's own comment
// on that). `oldPath` is ONLY for the "renamed from …" chip in the modal head
// (Blame.svelte) — it is never sent to the backend, which only ever blames
// the exact `file` path passed in.
//
// `reload()` is the public, idempotent, safely-repeatable hook the
// "Ignore whitespace" checkbox's onchange calls — same "never invent a
// second fetch path" shape as every other controller's refresh().

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { IN_TAURI } from "../../ipc/env";
import type { BlameHunkRow, FileBlame } from "../../ipc/bindings";

// One flattened display row per line of `data.lines` — built fresh from
// `data`/`ignoreWhitespace` every time `rows` is read (cheap: at most
// MAX_BLAME_LINES entries, same order of magnitude as Detail's own diffRows).
export type BlameDisplayRow = {
  text: string;
  html: string;
  isFirst: boolean; // first line of its hunk's range — the only row that renders a gutter chip
  hunk: BlameHunkRow;
  tint: "a" | "b"; // alternates per hunk so consecutive same-commit lines read as one block
};

// Demo data (design-mode only) — a small canned blame, same spirit as every
// other island's DEMO constants, so the browser preview still shows a
// populated modal without a real backend.
const DEMO_BLAME: FileBlame = {
  path: "src/auth/session.ts",
  atSha: "a1b2c3d4e5f6071829384756a1b2c3d4e5f60718",
  lang: "ts",
  totalLines: 7,
  truncated: false,
  lines: [
    "export function createSession(user) {",
    "  const store = new TokenStore();",
    "  const ttl = 3600; // extended, see #482",
    "  const limiter = rateLimit({ windowMs: 60000, max: 30 });",
    "  return sign({ user, ttl }, secret);",
    "  // audit: Safety Manager seals a snapshot before mutation",
    "}",
  ],
  hunks: [
    {
      sha: "e4f5061e4f5061e4f5061e4f5061e4f5061e4f5",
      shortSha: "e4f5061",
      author: { n: "You", e: "you@example.com", t: 0 },
      startLine: 1,
      linesInHunk: 2,
      origPath: null,
    },
    {
      sha: "bb01ccdbb01ccdbb01ccdbb01ccdbb01ccdbb01",
      shortSha: "bb01ccd",
      author: { n: "Ada Lovelace", e: "ada@example.com", t: 0 },
      startLine: 3,
      linesInHunk: 2,
      origPath: "src/auth/token-store.ts",
    },
    {
      sha: "a1b2c3da1b2c3da1b2c3da1b2c3da1b2c3da1b2",
      shortSha: "a1b2c3d",
      author: { n: "You", e: "you@example.com", t: 0 },
      startLine: 5,
      linesInHunk: 3,
      origPath: null,
    },
  ],
};

class BlameState {
  open = $state(false);
  loading = $state(false);
  error = $state<string | null>(null);
  data = $state<FileBlame | null>(null);
  ignoreWhitespace = $state(false);
  // Only set when the caller's own FileChange.oldPath differs from the
  // blamed path — see file header. Purely cosmetic (the "renamed from …"
  // chip in Blame.svelte's modal head), never read by reload()/the backend.
  oldPath = $state<string | null>(null);

  repo = "";
  file = "";
  atCommit: string | null = null;

  // Lazily-built sha(7-char)->row map, cached against bridge.G's identity —
  // exact same staleness check as cmdk.svelte.ts's own `cacheG`. Rebuilt once
  // per graph load (O(N) scan), then O(1) lookups per gutter click.
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
    this.ignoreWhitespace = false;
    this.open = true;
    await this.reload();
  }

  close(): void {
    this.open = false;
    this.data = null;
    this.error = null;
  }

  // ── public refresh hook — called on open AND by the "Ignore whitespace"
  // checkbox's onchange, so toggling it always reflects the live flag rather
  // than whatever was fetched before. Safe to call repeatedly.
  async reload(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      if (!IN_TAURI) {
        // design-mode preview: no backend, seed the canned demo blame.
        this.data = { ...DEMO_BLAME, lines: [...DEMO_BLAME.lines], hunks: DEMO_BLAME.hunks.map((h) => ({ ...h })) };
        return;
      }
      if (!this.repo) {
        this.data = null;
        this.error = "Open a repository first.";
        return;
      }
      try {
        const r = await commands.blameFile(this.repo, this.file, this.atCommit, this.ignoreWhitespace);
        if (r.status === "ok") {
          this.data = r.data;
          this.error = null;
        } else {
          this.data = null;
          this.error = String(r.error ?? "Could not blame this file.");
        }
      } catch (e) {
        this.data = null;
        this.error = "Blame unavailable — " + e;
      }
    } finally {
      this.loading = false;
    }
  }

  async toggleIgnoreWhitespace(): Promise<void> {
    this.ignoreWhitespace = !this.ignoreWhitespace;
    await this.reload();
  }

  // Flattened per-line rows Blame.svelte iterates directly — see
  // BlameDisplayRow's own doc comment above.
  get rows(): BlameDisplayRow[] {
    const d = this.data;
    if (!d) return [];
    const out: BlameDisplayRow[] = [];
    d.hunks.forEach((h, hi) => {
      const tint: "a" | "b" = hi % 2 === 0 ? "a" : "b";
      for (let i = 0; i < h.linesInHunk; i++) {
        const lineIdx = h.startLine - 1 + i;
        const text = d.lines[lineIdx] ?? "";
        out.push({ text, html: bridge.highlight(text, d.lang), isFirst: i === 0, hunk: h, tint });
      }
    });
    return out;
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

  // Click a gutter chip -> jump to that commit on the canvas. Mirrors
  // cmdk.svelte.ts's jump() body exactly, plus a not-found warning (cmdk's
  // own jump() has nothing analogous to warn about: every result it offers
  // already came FROM the loaded graph, whereas a blame hunk's commit may not
  // be in it at all — a truncated graph, or history rewritten since load).
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

export const blameCtrl = new BlameState();
