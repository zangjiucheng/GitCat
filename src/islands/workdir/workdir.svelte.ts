// Working-tree changes (status, stage/unstage, discard, commit, stash) —
// controller (Svelte 5 runes singleton).
//
// Owns the pinned "Uncommitted changes" row's data AND the right-hand
// `#detail` pane's content whenever that row is selected (see
// legacy/main.ts's `selectWorkdir()`/the `-2` row sentinel, and
// Detail.svelte's leading `{#if workdirCtrl.selected}` branch — same slot,
// swapped content, exact shape as bisectDrawerCtrl peer-importing bisectCtrl).
//
// Two independent re-entrancy locks, deliberately NOT shared:
//   * `busy`/`busyTarget` — stage/unstage/stage-all/discard/commit/stash-save,
//     i.e. every action that touches the staging area or creates something
//     new. `busyTarget` is the file path being acted on, or a sentinel:
//     "__all__" (stage all), "__commit__" (the commit box), "__stash__" (the
//     "+ Stash changes…" form) — exact reuse of sidebar.svelte.ts's
//     busy/busyTarget pattern (one shared lock, a string tag for which row).
//   * `stashBusy`/`stashBusyTarget` — apply/pop/drop of an EXISTING stash
//     list entry, keyed by its numeric index (not a file path, so it can't
//     share the string-keyed `busyTarget` above). Kept separate so acting on
//     the stash list doesn't dim the staging area (and vice versa) — the two
//     are unrelated most of the time.
//
// Snapshot/backup messaging is entirely the backend's job (`WorkdirResult`
// already carries a human message); this controller just relays it via Tama,
// same "never invent copy the backend already wrote" convention as every
// other island.
//
// stash_apply/stash_pop CONFLICT note: the backend now has a real abort/
// continue pair for this (`stash_conflict_abort`/`stash_conflict_continue`,
// see workdir.rs), and resolver.svelte.ts's op dispatch table has grown a
// "stash" entry wired to them — so a conflicted apply/pop now opens the SAME
// shared Resolver merge/pick/rebase already use (`resolver.openStashConflict`)
// instead of only surfacing a Tama toast + `status.conflicted`. This
// controller still refreshes status/stashes first (the backend's message —
// "entry kept" for apply, "not yet dropped" for a conflicted pop — is worth
// having current even though the Resolver's own banner repeats the gist).
//
// stash identity check: `stashSha()` below looks up the LAST-fetched sha for
// a given `stash@{index}` (from `refreshStashes()`) and passes it as
// `expected_sha` to stash_apply/pop/drop, so an external `git stash` that
// changed the list out from under us (see src/main.ts's `repo-changed`
// listener, which now also calls `refreshStashes()`) is refused with a clear
// message instead of silently acting on a different entry than the one shown.
//
// `pendingStashUndo`: global Undo (⌘Z/#undoBtn, `globalUndo()` in
// legacy/main.ts) normally calls the backend's generic `undo_last`, but that
// can't help right after a stash_apply/stash_pop — nothing at the ref level
// moved, so there's nothing for it to rewind (see workdir.rs's
// `stash_undo_apply` doc comment). `pendingStashUndo` is this controller's
// record of "the LAST mutation here was exactly that, and nothing has
// touched the working tree since" — set true only in `applyOrPopStash`'s
// success path, and invalidated (back to false) at the top of every OTHER
// mutating method (stage/unstage/stage-all/discard/commit/stash-save/
// another apply-pop/drop) since the tree has moved on from "just
// applied/popped a stash" the instant anything else acts on it. `undoKind()`
// is the pure query `globalUndo()` reads to decide which backend call to
// make; main.ts already imports `workdirCtrl` directly (see e.g.
// `workdirCtrl.status` in `drawWorkdirBand()`), so this needs no bridge.ts
// plumbing — same direct-read pattern as that existing call site.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { resolver } from "../resolver/resolver.svelte.ts";
import { IN_TAURI } from "../../ipc/env";
import { ICON_BACKUP } from "../../legacy/icons";
import type { DiffLineRow, FileChange, HunkSelection, SelectedLine, StashEntry, WorkdirEntry, WorkdirStatus } from "../../ipc/bindings";

function esc(s: unknown): string {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
}

// Blame (Workdir.svelte's per-row "Blame" button) is only meaningful for a
// path HEAD's own committed tree actually has — and Workdir.svelte's Blame
// button always blames HEAD (`atCommit: null`, see blameCtrl.openFor's own
// contract). A rename — staged ("R" in the index-vs-HEAD diff) OR unstaged
// ("R" in the workdir-vs-index diff) — hasn't touched HEAD's tree yet, so
// `f.path` (the NEW name the row displays) isn't there; only `f.oldPath` is,
// so blame THAT identity instead (`blame_file`'s tree lookup would otherwise
// fail with "does not exist" — see blame.rs's module doc: it always reads
// `at_commit`'s own committed tree, never the index/workdir; verified against
// the backend's own
// `blame_at_head_fails_for_a_renames_new_path_when_the_rename_is_only_staged`
// test). A staged-new file ("A" — only ever appears in the STAGED list, see
// workdir.rs's `status_char`/head_to_index mapping) has no history at all
// yet — same "nothing to blame" case as an untracked ("?") row, just staged
// instead — so it's disabled alongside "?" rather than trying (and failing)
// to blame it.
export function canBlameWorkdirFile(f: Pick<WorkdirEntry, "status">): boolean {
  return f.status !== "?" && f.status !== "A";
}
export function blameTargetForWorkdirFile(f: Pick<WorkdirEntry, "path" | "status" | "oldPath">): string {
  return f.status === "R" ? (f.oldPath ?? f.path) : f.path;
}

// Folder-tree grouping for Workdir.svelte's staged/unstaged file lists — same
// split-on-"/", build-dirs-on-demand algorithm as detail.svelte.ts's own
// `tree` getter (that one isn't reused directly: `WorkdirEntry` has no
// add/del diffstat counts, and this codebase's own convention is a small
// per-module copy over a shared helper for something this size — see
// detail.svelte.ts's `TreeDir`/`TreeFile`). Deliberately no sorting, same as
// that precedent: `dirs` is a plain object walked in insertion order, `files`
// keeps the backend's own array order — libgit2 already returns status
// entries path-sorted, so this reads sorted "for free" without extra code.
export type WdTreeFile = WorkdirEntry & { name: string };
// `path` = the dir's full repo-relative path ("" for the root), so the collapse
// state (see WorkdirState.collapsedDirs) can key each folder stably across the
// tree re-deriving on every status refresh.
export type WdTreeDir = { dirs: Record<string, WdTreeDir>; files: WdTreeFile[]; path: string };

export function buildWdTree(entries: WorkdirEntry[]): WdTreeDir {
  const root: WdTreeDir = { dirs: {}, files: [], path: "" };
  for (const f of entries) {
    const parts = f.path.split("/");
    let n = root;
    parts.forEach((seg, j) => {
      if (j === parts.length - 1) {
        n.files.push({ ...f, name: seg });
      } else {
        n.dirs[seg] = n.dirs[seg] || { dirs: {}, files: [], path: n.path ? n.path + "/" + seg : seg };
        n = n.dirs[seg];
      }
    });
  }
  return root;
}

// One checked "+"/"-" row, keyed by the SAME anchor (hunk header + kind/
// oldNo/newNo) the backend's `apply_selected_lines` re-verifies against a
// fresh diff before trusting anything — see workdir.rs's `SelectedLine`/
// `HunkSelection` doc comments. `header` rides along here (not part of
// `SelectedLine` itself) purely so this controller can group a flat
// selection back into one `HunkSelection` per hunk in `buildSelectedHunks()`.
type CheckedLine = { header: string; kind: string; oldNo: number | null; newNo: number | null };

// Demo data (design-mode only) — a small canned changeset + one stash, same
// spirit as every other island's DEMO constants, so the browser preview still
// shows a populated staging panel without a real backend.
const DEMO_STATUS: WorkdirStatus = {
  staged: [{ path: "src/ui/LoginForm.tsx", oldPath: null, status: "A" }],
  unstaged: [
    { path: "src/auth/session.ts", oldPath: null, status: "M" },
    { path: "notes.txt", oldPath: null, status: "?" },
  ],
  conflicted: 0,
  branch: "feature/login",
  hasStash: true,
};
const DEMO_STASHES: StashEntry[] = [
  { index: 0, sha: "e5f6071", branch: "feature/login", message: "WIP on feature/login: e5f6071 Wire login form to API" },
];
// Demo diffs are now real (shaped) `FileChange` payloads — see this file's
// header note on why Workdir.svelte renders straight off `FileChange.hunks`
// (real `oldNo`/`newNo` per line) instead of the shared, index-recomputing
// `DiffRow[]` flattening `Detail.svelte` uses for its read-only viewer.
const DEMO_DIFF_FILES: Record<string, FileChange> = {
  "src/ui/LoginForm.tsx": {
    path: "src/ui/LoginForm.tsx",
    oldPath: null,
    status: "A",
    additions: 4,
    deletions: 0,
    binary: false,
    truncated: false,
    lang: "ts",
    hunks: [
      {
        header: "@@ -0,0 +1,5 @@",
        lines: [
          { kind: "+", oldNo: null, newNo: 1, text: "export function LoginForm() {" },
          { kind: "+", oldNo: null, newNo: 2, text: "  const [err, setErr] = useState(null);" },
          { kind: "+", oldNo: null, newNo: 3, text: "  return submit(err);" },
          { kind: "+", oldNo: null, newNo: 4, text: "}" },
        ],
      },
    ],
  },
  "src/auth/session.ts": {
    path: "src/auth/session.ts",
    oldPath: null,
    status: "M",
    additions: 1,
    deletions: 1,
    binary: false,
    truncated: false,
    lang: "ts",
    hunks: [
      {
        header: "@@ -18,6 +18,9 @@ export function createSession(user) {",
        lines: [
          { kind: " ", oldNo: 18, newNo: 18, text: "  const store = new TokenStore();" },
          { kind: "-", oldNo: 19, newNo: null, text: "  const ttl = 900;" },
          { kind: "+", oldNo: null, newNo: 19, text: "  const ttl = 3600; // extended, see #482" },
        ],
      },
    ],
  },
  "notes.txt": {
    path: "notes.txt",
    oldPath: null,
    status: "?",
    additions: 0,
    deletions: 0,
    binary: true,
    truncated: false,
    lang: "",
    hunks: [],
  },
};

// A `DiffLineRow` plus its pre-highlighted HTML — the per-hunk render shape
// Workdir.svelte iterates directly (real `oldNo`/`newNo`/`kind` kept intact,
// unlike the shared `DiffRow[]` flattening `Detail.svelte`'s read-only viewer
// uses), so a checkbox/toggle can build an exact `SelectedLine` anchor for
// any `+`/`-` row without recomputing anything.
export type DiffLineDisplay = DiffLineRow & { html: string };
export type DiffHunkDisplay = { header: string; lines: DiffLineDisplay[] };

// Convert a real `FileChange` (workdir_file_diff's payload) into the above
// per-hunk display shape — still calls `bridge.highlight()` per line exactly
// like the old shared-flattening path did, just without discarding oldNo/
// newNo along the way. Binary files naturally fall out with `hunks: []`
// (nothing to walk); Workdir.svelte checks `fc.binary`/`fc.truncated`
// directly rather than this function injecting synthetic "note" rows.
function hunksFromFileChange(fc: FileChange): DiffHunkDisplay[] {
  return (fc.hunks || []).map((h) => ({
    header: h.header,
    lines: (h.lines || []).map((l) => ({ ...l, html: bridge.highlight(l.text, fc.lang) })),
  }));
}

class WorkdirState {
  // Is the pinned row the active `#detail` selection — checked by both
  // Detail.svelte (which branch to render) and Workdir.svelte itself.
  selected = $state(false);

  status = $state<WorkdirStatus | null>(null);
  loading = $state(false);

  // Grouped-by-folder views of status's own flat staged/unstaged arrays, for
  // Workdir.svelte's tree rendering — see buildWdTree's own doc comment.
  // Getters (not cached $state), same as detail.svelte.ts's own `tree`:
  // status is already the single source of truth, and re-deriving on every
  // access is cheap relative to a real IPC round trip.
  get stagedTree(): WdTreeDir {
    return buildWdTree(this.status?.staged ?? []);
  }
  get unstagedTree(): WdTreeDir {
    return buildWdTree(this.status?.unstaged ?? []);
  }
  stagedHasDirs = $derived(Object.keys(buildWdTree(this.status?.staged ?? []).dirs).length > 0);
  unstagedHasDirs = $derived(Object.keys(buildWdTree(this.status?.unstaged ?? []).dirs).length > 0);

  // ── folder collapse state (Collapse all / Expand all + per-folder toggle) ──
  // Default is expanded: a folder is open UNLESS its key is in this set. Keyed
  // by `section \0 dirPath` (via `dirKey`) so the two sections never collide and
  // the state survives the tree re-deriving on every status refresh. Each
  // `<details>` binds `open` to !isDirCollapsed and syncs native toggles back
  // through `setDirOpen` (see Workdir.svelte). Reassigned, never mutated in
  // place, so Svelte 5 sees the change (a `$state` Set isn't deep-proxied).
  collapsedDirs = $state<Set<string>>(new Set());
  private dirKey(section: "staged" | "unstaged", path: string): string {
    return section + " " + path;
  }
  isDirCollapsed(section: "staged" | "unstaged", path: string): boolean {
    return this.collapsedDirs.has(this.dirKey(section, path));
  }
  setDirOpen(section: "staged" | "unstaged", path: string, open: boolean) {
    const k = this.dirKey(section, path);
    if (open === !this.collapsedDirs.has(k)) return; // already in that state — no churn
    const next = new Set(this.collapsedDirs);
    if (open) next.delete(k);
    else next.add(k);
    this.collapsedDirs = next;
  }
  private eachDirPath(node: WdTreeDir, out: string[]) {
    for (const seg in node.dirs) {
      const child = node.dirs[seg];
      out.push(child.path);
      this.eachDirPath(child, out);
    }
  }
  collapseAll(section: "staged" | "unstaged") {
    const tree = section === "staged" ? this.stagedTree : this.unstagedTree;
    const paths: string[] = [];
    this.eachDirPath(tree, paths);
    const next = new Set(this.collapsedDirs);
    for (const p of paths) next.add(this.dirKey(section, p));
    this.collapsedDirs = next;
  }
  expandAll(section: "staged" | "unstaged") {
    const pre = section + " ";
    this.collapsedDirs = new Set([...this.collapsedDirs].filter((k) => !k.startsWith(pre)));
  }

  busy = $state(false);
  busyTarget = $state<string | null>(null);

  message = $state("");
  amend = $state(false);
  // True only while generateMessage() is running — shares the `__commit__` busy
  // lock (so the textarea + Commit button disable), but drives ONLY the Generate
  // button's own spinner/label so it doesn't mislabel a plain commit.
  generating = $state(false);

  selectedDiffFile = $state<string | null>(null);
  // Which side the selected file's diff came from — a file can legitimately
  // appear in BOTH staged and unstaged (partially staged), so this is needed
  // to know which of the two rows is "the selected one" and which side to
  // re-fetch after a mutation. Not itself mentioned in the controller-state
  // spec list, but required to disambiguate that case.
  selectedDiffStaged = $state(false);
  diffHeader = $state("");
  // The fetched file itself (status/binary/truncated/lang flags) plus its
  // hunks pre-shaped for direct rendering — see `DiffHunkDisplay` above.
  // `diffError` is a plain message string for "couldn't fetch" (read failure),
  // kept separate from `diffFile` rather than folded into a synthetic hunk row.
  diffFile = $state<FileChange | null>(null);
  diffHunks = $state<DiffHunkDisplay[]>([]);
  diffError = $state<string | null>(null);
  diffLoading = $state(false);

  // Hunk/line-level staging selection — which `+`/`-` rows of the CURRENTLY
  // open diff are checked, as a flat list of anchors (header + kind/oldNo/
  // newNo, the exact shape `apply_selected_lines` re-verifies against a fresh
  // diff — see workdir.rs). Ephemeral: cleared on every `selectDiffFile()`
  // call and after every successful stageLines/unstageLines/discardLines,
  // since the acted-on lines no longer exist in the fresh diff by definition
  // (see this file's header + the design's §4 "never trust stale state").
  selectedLines = $state<CheckedLine[]>([]);
  // O(1) membership index over `selectedLines`, rebuilt (a `$derived`) only
  // when the selection actually changes. The diff view calls `isLineSelected`
  // for EVERY visible line — so a Set lookup here is what keeps a single toggle
  // from re-running an O(lines × selected) `.some()` scan across the whole
  // diff, which made a large staged diff lag on every click ("unstage diff
  // lags"). Keyed by header+kind+oldNo+newNo (see `lineKey`).
  selectedKeys = $derived(new Set(this.selectedLines.map((a) => WorkdirState.lineKey(a.header, a.kind, a.oldNo, a.newNo))));
  // Anchor for shift-click range extension — the last line clicked (plain,
  // ephemeral bookkeeping, not read by any template so it needs no rune).
  // A range never spans a hunk boundary (`lastClickedHeader` must match).
  private lastClickedHeader: string | null = null;
  private lastClickedIdx: number | null = null;

  stashes = $state<StashEntry[]>([]);
  stashOpen = $state(false); // the inline "+ Stash changes…" form, mirrors sidebar's newBranchOpen
  stashMessage = $state("");
  stashIncludeUntracked = $state(false);
  stashBusy = $state(false);
  stashBusyTarget = $state<number | null>(null); // which stash@{N} apply/pop/drop is in flight

  // True right after a successful stash apply/pop, until any other mutating
  // action on this controller runs — see the file-header doc comment above
  // and `undoKind()` below (the thing that actually reads it).
  pendingStashUndo = $state(false);

  private statusSeq = 0;
  private diffSeq = 0;
  private stashSeq = 0;
  private repo = "";

  // ── open/close (mirrors detailCtrl.select/deselect) ─────────────────────
  select(repo: string) {
    this.selected = true;
    this.repo = repo || "";
    this.message = "";
    this.amend = false;
    this.selectedDiffFile = null;
    this.diffHeader = "";
    this.diffFile = null;
    this.diffHunks = [];
    this.diffError = null;
    this.clearLineSelection();
    this.refreshStatus(this.repo);
    this.refreshStashes(this.repo);
  }

  deselect() {
    this.selected = false;
  }

  // Which backend call global Undo (⌘Z/#undoBtn's `globalUndo()`, legacy/
  // main.ts) should make next — "stash" (re-stash via `stash_undo_apply`,
  // see `pendingStashUndo`'s doc comment above) right after a successful
  // apply/pop and nothing else since, "ref" (the generic `undo_last`
  // snapshot-restore flow, unchanged) otherwise. A pure query — it does NOT
  // consume/clear `pendingStashUndo` itself; `globalUndo()` clears it once
  // it actually acts on "stash", exactly like it already owns `undo_last`'s
  // own re-entrancy/reporting for "ref".
  undoKind(): "stash" | "ref" {
    return this.pendingStashUndo ? "stash" : "ref";
  }

  // ── reads ────────────────────────────────────────────────────────────────
  // Re-fetch without changing `selected` — called post-mutation and from the
  // `repo-changed` live-refresh listener (src/main.ts), so the pinned row's
  // badge stays live even while the panel itself is closed.
  async refreshStatus(repo: string) {
    const myReq = ++this.statusSeq;
    if (!IN_TAURI) {
      this.status = {
        ...DEMO_STATUS,
        staged: DEMO_STATUS.staged.map((e) => ({ ...e })),
        unstaged: DEMO_STATUS.unstaged.map((e) => ({ ...e })),
      };
      // The pinned row's badge (drawn on the canvas, not this Svelte tree) reads
      // workdirCtrl.status every frame but only repaints when `dirty` is set —
      // same convention bisectdrawer.svelte.ts uses for its own canvas-visible
      // state (marks/cur).
      bridge.requestRedraw();
      return;
    }
    if (!repo) {
      this.status = null;
      bridge.requestRedraw();
      return;
    }
    this.loading = true;
    try {
      const r = await commands.workdirStatus(repo);
      if (myReq !== this.statusSeq) return; // a newer refresh superseded this one
      if (r.status === "ok") {
        this.status = r.data;
        this.dropStaleSelectedDiff();
        bridge.requestRedraw();
      } else {
        console.error("workdir_status", r.error);
      }
    } catch (e) {
      if (myReq !== this.statusSeq) return;
      console.error("workdir_status", e);
    } finally {
      if (myReq === this.statusSeq) this.loading = false;
    }
  }

  // If the file backing the open diff view no longer appears on the side it
  // was selected from (staged/unstaged), clear the stale diff instead of
  // leaving a dangling view of a file that no longer has that kind of change.
  private dropStaleSelectedDiff() {
    if (!this.selectedDiffFile || !this.status) return;
    const list = this.selectedDiffStaged ? this.status.staged : this.status.unstaged;
    if (!list.some((e) => e.path === this.selectedDiffFile)) {
      this.selectedDiffFile = null;
      this.diffHeader = "";
      this.diffFile = null;
      this.diffHunks = [];
      this.diffError = null;
      this.clearLineSelection();
    }
  }

  // Sequence-guarded exactly like refreshStatus() above — select() fire-and-
  // forgets this alongside refreshStatus() with no lock between them, so a
  // slower in-flight `stash_list` can genuinely resolve AFTER a faster,
  // newer one (e.g. two refreshes triggered back to back by a burst of
  // repo-changed events) and clobber it with stale data without this guard.
  async refreshStashes(repo: string) {
    const myReq = ++this.stashSeq;
    if (!IN_TAURI) {
      this.stashes = DEMO_STASHES.map((s) => ({ ...s }));
      return;
    }
    if (!repo) {
      this.stashes = [];
      return;
    }
    try {
      const r = await commands.stashList(repo);
      if (myReq !== this.stashSeq) return; // a newer refresh superseded this one
      if (r.status === "ok") this.stashes = r.data;
      else console.error("stash_list", r.error);
    } catch (e) {
      if (myReq !== this.stashSeq) return;
      console.error("stash_list", e);
    }
  }

  // Last-fetched sha for stash@{index} (from the most recent refreshStashes()),
  // passed as the identity sanity-check to stash_apply/pop/drop — see their
  // `expected_sha` doc comments in bindings.ts. `null` when we have no record
  // of this index (e.g. acting before any refresh ever completed), which the
  // backend treats as "skip the check" — same as today's behavior.
  private stashSha(index: number): string | null {
    const s = this.stashes.find((e) => e.index === index);
    return s ? s.sha : null;
  }

  async selectDiffFile(path: string, staged: boolean) {
    this.selectedDiffFile = path;
    this.selectedDiffStaged = staged;
    this.diffHeader = path;
    this.clearLineSelection(); // a fresh diff view invalidates any prior checkmarks
    const myReq = ++this.diffSeq;
    if (!IN_TAURI) {
      const fc = DEMO_DIFF_FILES[path] || null;
      this.diffFile = fc;
      this.diffHunks = fc ? hunksFromFileChange(fc) : [];
      this.diffError = fc ? null : "no textual diff";
      return;
    }
    if (!this.repo) return;
    this.diffLoading = true;
    this.diffFile = null;
    this.diffHunks = [];
    this.diffError = null;
    try {
      const r = await commands.workdirFileDiff(this.repo, path, staged);
      if (myReq !== this.diffSeq) return; // a newer file selection superseded this one
      if (r.status === "ok") {
        this.diffFile = r.data;
        this.diffHunks = hunksFromFileChange(r.data);
      } else {
        this.diffError = "diff unavailable — " + r.error;
      }
    } catch (e) {
      if (myReq !== this.diffSeq) return;
      this.diffError = "diff unavailable — " + e;
    } finally {
      if (myReq === this.diffSeq) this.diffLoading = false;
    }
  }

  // ── hunk/line selection (local, ephemeral — see field doc comments) ──────
  private clearLineSelection() {
    this.selectedLines = [];
    this.lastClickedHeader = null;
    this.lastClickedIdx = null;
  }

  private static lineMatches(a: CheckedLine, header: string, kind: string, oldNo: number | null, newNo: number | null): boolean {
    return a.header === header && a.kind === kind && a.oldNo === oldNo && a.newNo === newNo;
  }

  // Stable key for a selectable line — the membership index (`selectedKeys`)
  // and `isLineSelected` derive it identically, so the exact separator only has
  // to be injective over the ACTUAL fields: `kind` is a single char (+/-/space)
  // and old/newNo are numbers-or-null, so even a space-containing hunk header
  // (the only variable-length, leading field) can't collide with the trailing
  // three. Two tuples share a key only if they are the same line.
  private static lineKey(header: string, kind: string, oldNo: number | null, newNo: number | null): string {
    return header + " " + kind + " " + oldNo + " " + newNo;
  }

  isLineSelected(header: string, l: DiffLineRow): boolean {
    return this.selectedKeys.has(WorkdirState.lineKey(header, l.kind, l.oldNo, l.newNo));
  }

  get selectedLinesCount(): number {
    return this.selectedLines.length;
  }

  // Toggle one `+`/`-` row (context rows are never selectable — they're
  // always included for free, see workdir.rs's reconstruction rule).
  // `shiftKey` extends a contiguous range from the last-clicked row WITHIN
  // THE SAME HUNK only — clicking in a different hunk starts an independent
  // range there, since a selection never spans a hunk boundary (each hunk
  // becomes its own reconstructed sub-hunk on the backend).
  toggleLine(header: string, lines: DiffLineRow[], idx: number, shiftKey: boolean) {
    const l = lines[idx];
    if (l.kind !== "+" && l.kind !== "-") return;
    if (shiftKey && this.lastClickedHeader === header && this.lastClickedIdx !== null) {
      const lo = Math.min(this.lastClickedIdx, idx);
      const hi = Math.max(this.lastClickedIdx, idx);
      // Dedup against a local key set built once (O(selected)), not a per-line
      // `.some()` scan — a shift-range over a big existing selection would
      // otherwise be O(range × selected).
      const have = new Set(this.selectedLines.map((a) => WorkdirState.lineKey(a.header, a.kind, a.oldNo, a.newNo)));
      for (let i = lo; i <= hi; i++) {
        const li = lines[i];
        if (li.kind !== "+" && li.kind !== "-") continue;
        const k = WorkdirState.lineKey(header, li.kind, li.oldNo, li.newNo);
        if (have.has(k)) continue;
        have.add(k);
        this.selectedLines.push({ header, kind: li.kind, oldNo: li.oldNo, newNo: li.newNo });
      }
    } else {
      const i = this.selectedLines.findIndex((a) => WorkdirState.lineMatches(a, header, l.kind, l.oldNo, l.newNo));
      if (i >= 0) this.selectedLines.splice(i, 1);
      else this.selectedLines.push({ header, kind: l.kind, oldNo: l.oldNo, newNo: l.newNo });
    }
    this.lastClickedHeader = header;
    this.lastClickedIdx = idx;
  }

  // Every `+`/`-` row of one hunk as a single `HunkSelection` — the MVP
  // "Stage/Unstage/Discard hunk" buttons use this (whole-hunk is just the
  // line-level backend call with every eligible line included, see design §4).
  hunkSelectionFor(hunk: DiffHunkDisplay): HunkSelection {
    return {
      header: hunk.header,
      lines: hunk.lines.filter((l) => l.kind === "+" || l.kind === "-").map((l) => ({ kind: l.kind, oldNo: l.oldNo, newNo: l.newNo })),
    };
  }

  // The checked lines anywhere in the open diff, grouped back into one
  // `HunkSelection` per hunk with >=1 checked line — order follows
  // `diffHunks`' own top-to-bottom order (cosmetic here; the backend
  // re-derives its own authoritative order regardless, see workdir.rs).
  buildSelectedHunks(): HunkSelection[] {
    const out: HunkSelection[] = [];
    for (const hunk of this.diffHunks) {
      const lines: SelectedLine[] = this.selectedLines
        .filter((a) => a.header === hunk.header)
        .map((a) => ({ kind: a.kind, oldNo: a.oldNo, newNo: a.newNo }));
      if (lines.length) out.push({ header: hunk.header, lines });
    }
    return out;
  }

  // ── stage / unstage / stage all (index-only — no snapshot on the backend,
  //    see workdir.rs's doc comment) ────────────────────────────────────────
  async stageFile(repo: string, file: string) {
    if (this.busy) return;
    this.pendingStashUndo = false; // this controller has moved on — see doc comment above
    if (!IN_TAURI) {
      bridge.tama.set("hint");
      bridge.tama.say("Staged " + file + " (demo).");
      return;
    }
    this.busy = true;
    this.busyTarget = file;
    bridge.tama.set("thinking");
    try {
      const res = await commands.stageFile(repo, file);
      if (res.ok) {
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Staged " + file + ".", 1800);
        await this.refreshStatus(repo);
      } else {
        bridge.tama.warn(res.message || "Couldn't stage " + file + ".");
      }
    } catch (e) {
      bridge.tama.warn("Stage failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  async unstageFile(repo: string, file: string) {
    if (this.busy) return;
    this.pendingStashUndo = false; // this controller has moved on — see doc comment above
    if (!IN_TAURI) {
      bridge.tama.set("hint");
      bridge.tama.say("Unstaged " + file + " (demo).");
      return;
    }
    this.busy = true;
    this.busyTarget = file;
    bridge.tama.set("thinking");
    try {
      const res = await commands.unstageFile(repo, file);
      if (res.ok) {
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Unstaged " + file + ".", 1800);
        await this.refreshStatus(repo);
      } else {
        bridge.tama.warn(res.message || "Couldn't unstage " + file + ".");
      }
    } catch (e) {
      bridge.tama.warn("Unstage failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  async stageAll(repo: string) {
    if (this.busy) return;
    this.pendingStashUndo = false; // this controller has moved on — see doc comment above
    if (!IN_TAURI) {
      bridge.tama.set("hint");
      bridge.tama.say("Staged all changes (demo).");
      return;
    }
    this.busy = true;
    this.busyTarget = "__all__";
    bridge.tama.set("thinking");
    try {
      const res = await commands.stageAll(repo);
      if (res.ok) {
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Staged all changes.", 1800);
        await this.refreshStatus(repo);
      } else {
        bridge.tama.warn(res.message || "Couldn't stage everything.");
      }
    } catch (e) {
      bridge.tama.warn("Stage all failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  // Symmetric counterpart to stageAll — unstage every staged path in one call
  // (`git reset`, index back to HEAD, working tree untouched). Own busyTarget
  // (`__unstage_all__`) so its button spinner is distinct from Stage-all's.
  async unstageAll(repo: string) {
    if (this.busy) return;
    if (!IN_TAURI) {
      bridge.tama.set("hint");
      bridge.tama.say("Unstaged all changes (demo).");
      return;
    }
    this.busy = true;
    this.busyTarget = "__unstage_all__";
    bridge.tama.set("thinking");
    try {
      const res = await commands.unstageAll(repo);
      if (res.ok) {
        bridge.tama.set("hint");
        bridge.tama.say(res.message || "Unstaged all changes.", 1800);
        await this.refreshStatus(repo);
      } else {
        bridge.tama.warn(res.message || "Couldn't unstage everything.");
      }
    } catch (e) {
      bridge.tama.warn("Unstage all failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  // ── discard (destructive — routes through the shared typed-confirm scrim
  //    first, exactly like sidebarCtrl.deleteBranch) ──────────────────────
  confirmDiscard(file: string, untracked: boolean) {
    const repo = this.repo;
    bridge.tama.set("danger");
    bridge.tama.say("Discarding " + file + " — type the file name to arm it. I keep a backup copy first.", 6000);
    bridge.armDanger({
      title: "Discard changes — " + file,
      steps: false,
      desc: untracked
        ? "This deletes the untracked file from disk. Its bytes are backed up first, so it's recoverable."
        : "This restores the file to what's in the index/HEAD, discarding your unstaged edits. The exact diff is backed up first.",
      lose:
        "<h5>What happens</h5><ul><li>" +
        (untracked
          ? "Deletes <code>" + esc(file) + "</code> from disk (it was never committed)"
          : "Reverts <code>" + esc(file) + "</code> to its last staged/committed content") +
        "</li></ul>",
      note: ICON_BACKUP + " I back up the " + (untracked ? "file's bytes" : "exact diff") + " before discarding — ask if you need it back.",
      name: file,
      confirmLabel: "Discard changes",
      onConfirm: async () => {
        await this.doDiscard(repo, file, untracked);
      },
    });
  }

  private async doDiscard(repo: string, file: string, untracked: boolean) {
    if (!IN_TAURI) {
      bridge.tama.set("celebrate");
      bridge.tama.say("Discarded " + file + " (demo).");
      return;
    }
    if (this.busy) return;
    this.pendingStashUndo = false; // this controller has moved on — see doc comment above
    this.busy = true;
    this.busyTarget = file;
    bridge.tama.set("thinking");
    try {
      const res = await commands.discardFile(repo, file, untracked);
      if (res.ok) {
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Discarded " + file + ".", 4200);
        await this.refreshStatus(repo);
      } else {
        bridge.tama.warn(res.message || "Couldn't discard " + file + ".");
      }
    } catch (e) {
      bridge.tama.warn("Discard failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  // ── stage / unstage SELECTED LINES (index-only — no snapshot, same rule as
  //    stageFile/unstageFile above; see workdir.rs's doc comment) ──────────
  // After success: re-fetch status AND (if this file's diff is still open,
  // i.e. `dropStaleSelectedDiff` didn't just clear it out from under us)
  // re-run `selectDiffFile` to get the fresh post-mutation hunks — never
  // splice/patch the view in place, since hunks can merge/split/renumber
  // once some lines move to the other side (design §4's "never trust stale
  // state", the frontend analogue of the backend's own freshness check).
  async stageLines(repo: string, file: string, hunks: HunkSelection[]) {
    if (this.busy || !hunks.length) return;
    this.pendingStashUndo = false; // this controller has moved on — see doc comment above
    if (!IN_TAURI) {
      bridge.tama.set("hint");
      bridge.tama.say("Staged selected lines in " + file + " (demo).");
      return;
    }
    this.busy = true;
    this.busyTarget = file;
    bridge.tama.set("thinking");
    try {
      const res = await commands.stageLines(repo, file, hunks);
      if (res.ok) {
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Staged selected lines.", 1800);
        this.clearLineSelection();
        const staged = this.selectedDiffStaged;
        await this.refreshStatus(repo);
        if (this.selectedDiffFile === file) await this.selectDiffFile(file, staged);
      } else {
        bridge.tama.warn(res.message || "Couldn't stage those lines — " + file + ".");
      }
    } catch (e) {
      bridge.tama.warn("Stage failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  async unstageLines(repo: string, file: string, hunks: HunkSelection[]) {
    if (this.busy || !hunks.length) return;
    this.pendingStashUndo = false; // this controller has moved on — see doc comment above
    if (!IN_TAURI) {
      bridge.tama.set("hint");
      bridge.tama.say("Unstaged selected lines in " + file + " (demo).");
      return;
    }
    this.busy = true;
    this.busyTarget = file;
    bridge.tama.set("thinking");
    try {
      const res = await commands.unstageLines(repo, file, hunks);
      if (res.ok) {
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Unstaged selected lines.", 1800);
        this.clearLineSelection();
        const staged = this.selectedDiffStaged;
        await this.refreshStatus(repo);
        if (this.selectedDiffFile === file) await this.selectDiffFile(file, staged);
      } else {
        bridge.tama.warn(res.message || "Couldn't unstage those lines — " + file + ".");
      }
    } catch (e) {
      bridge.tama.warn("Unstage failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  // ── discard SELECTED LINES (destructive — backend backs up the whole
  //    file's patch first, exactly like discardFile; routes through the SAME
  //    typed-confirm scrim) ─────────────────────────────────────────────────
  confirmDiscardLines(file: string, hunks: HunkSelection[]) {
    if (!hunks.length) return;
    const repo = this.repo;
    const n = hunks.reduce((sum, h) => sum + h.lines.length, 0);
    const label = n + " line" + (n === 1 ? "" : "s");
    bridge.tama.set("danger");
    bridge.tama.say("Discarding " + label + " in " + file + " — type the file name to arm it. I keep a backup copy first.", 6000);
    bridge.armDanger({
      title: "Discard " + label + " — " + file,
      steps: false,
      desc: "This reverts the selected " + label + " in " + file + " to what's in the index/HEAD, discarding just those unstaged edits. The exact diff is backed up first.",
      lose: "<h5>What happens</h5><ul><li>Reverts " + label + " in <code>" + esc(file) + "</code> to their last staged/committed content</li></ul>",
      note: ICON_BACKUP + " I back up the file's exact diff before discarding — ask if you need it back.",
      name: file,
      confirmLabel: "Discard lines",
      onConfirm: async () => {
        await this.doDiscardLines(repo, file, hunks);
      },
    });
  }

  private async doDiscardLines(repo: string, file: string, hunks: HunkSelection[]) {
    if (!IN_TAURI) {
      bridge.tama.set("celebrate");
      bridge.tama.say("Discarded selected lines in " + file + " (demo).");
      return;
    }
    if (this.busy) return;
    this.pendingStashUndo = false; // this controller has moved on — see doc comment above
    this.busy = true;
    this.busyTarget = file;
    bridge.tama.set("thinking");
    try {
      const res = await commands.discardLines(repo, file, hunks);
      if (res.ok) {
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Discarded selected lines.", 4200);
        this.clearLineSelection();
        const staged = this.selectedDiffStaged;
        await this.refreshStatus(repo);
        if (this.selectedDiffFile === file) await this.selectDiffFile(file, staged);
      } else {
        bridge.tama.warn(res.message || "Couldn't discard those lines — " + file + ".");
      }
    } catch (e) {
      bridge.tama.warn("Discard failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  // ── commit (snapshots first on the backend) ──────────────────────────────
  async commit(repo: string) {
    if (this.busy) return;
    const msg = this.message;
    const isAmend = this.amend;
    if (!isAmend && !msg.trim()) {
      bridge.tama.warn("Write a commit message first.");
      return;
    }
    this.pendingStashUndo = false; // this controller has moved on — see doc comment above
    if (!IN_TAURI) {
      bridge.tama.set("celebrate");
      bridge.tama.say((isAmend ? "Amended" : "Committed") + " (demo).", 3200);
      return;
    }
    this.busy = true;
    this.busyTarget = "__commit__";
    bridge.tama.set("thinking");
    bridge.tama.say(isAmend ? "Amending…" : "Committing…");
    try {
      const res = await commands.commit(repo, msg.trim() ? msg : null, isAmend);
      if (res.ok) {
        this.message = "";
        this.amend = false;
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Committed.", 3200);
        await bridge.reloadGraph(true);
        await this.refreshStatus(repo);
      } else {
        bridge.tama.warn(res.message || "Commit failed.");
      }
    } catch (e) {
      bridge.tama.warn("Commit failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  // Run the user's configured commit-message command (Tools ▸ External Tools)
  // and drop its output into the message box. GitCat connects to no AI — this
  // just runs THEIR command (aicommit, opencommit, a script). Shares the commit
  // box's `__commit__` busy lock so the textarea + Commit button disable while
  // it runs. A missing/failed command surfaces the backend's own message (which
  // for "not configured" points at the setting).
  async generateMessage(repo: string) {
    if (this.busy) return;
    if (!IN_TAURI) {
      bridge.tama.set("hint");
      bridge.tama.say("Configure a commit-message command in Tools ▸ External Tools to use this (demo).");
      return;
    }
    this.busy = true;
    this.busyTarget = "__commit__";
    this.generating = true;
    bridge.tama.set("thinking");
    bridge.tama.say("Generating a commit message…");
    try {
      const res = await commands.generateCommitMessage(repo);
      if (res.status === "ok") {
        this.message = res.data;
        bridge.tama.set("hint");
        bridge.tama.say("Drafted a commit message — review and edit before committing.", 4200);
      } else {
        bridge.tama.warn(res.error || "Couldn't generate a commit message.");
      }
    } catch (e) {
      bridge.tama.warn("Generate failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
      this.generating = false;
    }
  }

  // ── stash: save (snapshots first) ────────────────────────────────────────
  openStashForm() {
    this.stashMessage = "";
    this.stashIncludeUntracked = false;
    this.stashOpen = true;
  }

  cancelStashForm() {
    this.stashOpen = false;
    this.stashMessage = "";
    this.stashIncludeUntracked = false;
  }

  async saveStash(repo: string) {
    if (this.busy) return;
    this.pendingStashUndo = false; // another stash op — this controller has moved on, see doc comment above
    const msg = this.stashMessage.trim();
    const includeUntracked = this.stashIncludeUntracked;
    if (!IN_TAURI) {
      bridge.tama.set("celebrate");
      bridge.tama.say("Stashed changes (demo).", 3200);
      return;
    }
    this.busy = true;
    this.busyTarget = "__stash__";
    bridge.tama.set("thinking");
    bridge.tama.say("Stashing changes…");
    try {
      const res = await commands.stashSave(repo, msg || null, includeUntracked);
      if (res.ok) {
        this.stashOpen = false;
        this.stashMessage = "";
        this.stashIncludeUntracked = false;
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Stashed.", 3200);
        await this.refreshStatus(repo);
        await this.refreshStashes(repo);
      } else {
        bridge.tama.warn(res.message || "Couldn't stash changes.");
      }
    } catch (e) {
      bridge.tama.warn("Stash failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  // ── stash: apply / pop (snapshot first; a conflict opens the shared
  //    Resolver — see this file's header) ──────────────────────────────────
  async applyStash(repo: string, index: number) {
    await this.applyOrPopStash(repo, index, false);
  }

  async popStash(repo: string, index: number) {
    await this.applyOrPopStash(repo, index, true);
  }

  private async applyOrPopStash(repo: string, index: number, pop: boolean) {
    if (this.stashBusy) return;
    // Another apply/pop invalidates whatever a PRIOR call left pending —
    // re-set to true below only if THIS call succeeds cleanly (see doc
    // comment above pendingStashUndo's declaration).
    this.pendingStashUndo = false;
    const verb = pop ? "pop" : "apply";
    if (!IN_TAURI) {
      bridge.tama.set("celebrate");
      bridge.tama.say((pop ? "Popped" : "Applied") + " stash@{" + index + "} (demo).", 3200);
      return;
    }
    this.stashBusy = true;
    this.stashBusyTarget = index;
    bridge.tama.set("thinking");
    try {
      const expectedSha = this.stashSha(index);
      const res = pop
        ? await commands.stashPop(repo, index, expectedSha)
        : await commands.stashApply(repo, index, expectedSha);
      if (res.ok) {
        // Bug B fix: a clean apply/pop leaves the tree dirty in a way only
        // stash_undo_apply (not the generic undo_last) can rewind — see
        // globalUndo() in legacy/main.ts, which reads this via undoKind().
        this.pendingStashUndo = true;
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Done.", 3200);
        await this.refreshStatus(repo);
        await this.refreshStashes(repo);
      } else if (res.conflictedFiles && res.conflictedFiles.length) {
        // Same shared Resolver merge/pick/rebase already use — see
        // resolver.svelte.ts's "stash" op entry and this file's header.
        await this.refreshStatus(repo);
        await this.refreshStashes(repo);
        await resolver.openStashConflict(repo, res);
      } else {
        bridge.tama.warn(res.message || "Couldn't " + verb + " that stash.");
      }
    } catch (e) {
      bridge.tama.warn((pop ? "Pop" : "Apply") + " failed — " + e);
      console.error(e);
    } finally {
      this.stashBusy = false;
      this.stashBusyTarget = null;
    }
  }

  // ── stash: drop (destructive — the one stash op behind the danger scrim) ─
  confirmDropStash(repo: string, index: number) {
    const label = "stash@{" + index + "}";
    bridge.tama.set("danger");
    bridge.tama.say("Dropping " + label + " — type it to arm it.", 6000);
    bridge.armDanger({
      title: "Drop " + label,
      steps: false,
      desc: "This permanently discards the stashed changes. Once git garbage-collects the stash commit, it's not recoverable from here.",
      lose: "<h5>What happens</h5><ul><li>Removes <code>" + esc(label) + "</code> from the stash list</li></ul>",
      note: ICON_BACKUP + " I pin HEAD to a backup first, but that does not cover the stash's own content once git prunes it.",
      name: label,
      confirmLabel: "Drop stash",
      onConfirm: async () => {
        await this.doDropStash(repo, index);
      },
    });
  }

  private async doDropStash(repo: string, index: number) {
    if (!IN_TAURI) {
      bridge.tama.set("celebrate");
      bridge.tama.say("Dropped stash@{" + index + "} (demo).");
      return;
    }
    if (this.stashBusy) return;
    this.pendingStashUndo = false; // another stash op — this controller has moved on, see doc comment above
    this.stashBusy = true;
    this.stashBusyTarget = index;
    bridge.tama.set("thinking");
    try {
      const res = await commands.stashDrop(repo, index, this.stashSha(index));
      if (res.ok) {
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Dropped.", 3200);
        await this.refreshStashes(repo);
      } else {
        bridge.tama.warn(res.message || "Couldn't drop that stash.");
      }
    } catch (e) {
      bridge.tama.warn("Drop failed — " + e);
      console.error(e);
    } finally {
      this.stashBusy = false;
      this.stashBusyTarget = null;
    }
  }
}

export const workdirCtrl = new WorkdirState();
