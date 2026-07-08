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
import type { DiffRow } from "../detail/detail.svelte.ts";
import type { FileChange, StashEntry, WorkdirStatus } from "../../ipc/bindings";

function esc(s: unknown): string {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
}

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
const DEMO_DIFFS: Record<string, DiffRow[]> = {
  "src/ui/LoginForm.tsx": [
    { kind: "hunk", text: "@@ -0,0 +1,5 @@" },
    { kind: "line", ln: 1, mk: "+", cls: "add", html: "export function LoginForm() {" },
    { kind: "line", ln: 2, mk: "+", cls: "add", html: "&nbsp;&nbsp;const [err, setErr] = useState(null);" },
    { kind: "line", ln: 3, mk: "+", cls: "add", html: "&nbsp;&nbsp;return submit(err);" },
    { kind: "line", ln: 4, mk: "+", cls: "add", html: "}" },
  ],
  "src/auth/session.ts": [
    { kind: "hunk", text: "@@ -18,6 +18,9 @@ export function createSession(user) {" },
    { kind: "line", ln: "", mk: "", cls: "", html: "&nbsp;&nbsp;const store = new TokenStore();" },
    { kind: "line", ln: 18, mk: "-", cls: "del", html: "&nbsp;&nbsp;const ttl = 900;" },
    { kind: "line", ln: 18, mk: "+", cls: "add", html: "&nbsp;&nbsp;const ttl = 3600; // extended, see #482" },
  ],
  "notes.txt": [{ kind: "note", text: "no textual diff" }],
};

// Convert a real `FileChange` (workdir_file_diff's payload) into the shared
// `DiffRow[]` shape `Detail.svelte`'s diff viewer already renders — same
// per-line transform as detail.svelte.ts's `selectFile()`, kept as a private
// copy here (a plain function, not a method) since it has no other state to
// close over.
function rowsFromFileChange(fc: FileChange): DiffRow[] {
  if (fc.binary) return [{ kind: "note", text: "binary file — not shown" }];
  let n1 = 0;
  let n2 = 0;
  const rows: DiffRow[] = [];
  (fc.hunks || []).forEach((h) => {
    rows.push({ kind: "hunk", text: h.header });
    (h.lines || []).forEach((l) => {
      const mk = l.kind === "+" || l.kind === "-" ? l.kind : "";
      const cls = mk === "+" ? "add" : mk === "-" ? "del" : "";
      const ln = mk === "+" ? n2++ : mk === "-" ? n1++ : (n1++, n2++);
      rows.push({ kind: "line", ln, mk, cls, html: bridge.highlight(l.text, fc.lang) });
    });
  });
  if (!rows.length) rows.push({ kind: "note", text: "no textual diff" });
  if (fc.truncated) rows.push({ kind: "note", text: "… diff truncated (file capped)" });
  return rows;
}

class WorkdirState {
  // Is the pinned row the active `#detail` selection — checked by both
  // Detail.svelte (which branch to render) and Workdir.svelte itself.
  selected = $state(false);

  status = $state<WorkdirStatus | null>(null);
  loading = $state(false);

  busy = $state(false);
  busyTarget = $state<string | null>(null);

  message = $state("");
  amend = $state(false);

  selectedDiffFile = $state<string | null>(null);
  // Which side the selected file's diff came from — a file can legitimately
  // appear in BOTH staged and unstaged (partially staged), so this is needed
  // to know which of the two rows is "the selected one" and which side to
  // re-fetch after a mutation. Not itself mentioned in the controller-state
  // spec list, but required to disambiguate that case.
  selectedDiffStaged = $state(false);
  diffHeader = $state("");
  diffRows = $state<DiffRow[]>([]);
  diffLoading = $state(false);

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
    this.diffRows = [];
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
      this.diffRows = [];
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
    const myReq = ++this.diffSeq;
    if (!IN_TAURI) {
      this.diffRows = DEMO_DIFFS[path] || [{ kind: "note", text: "no textual diff" }];
      return;
    }
    if (!this.repo) return;
    this.diffLoading = true;
    this.diffRows = [];
    try {
      const r = await commands.workdirFileDiff(this.repo, path, staged);
      if (myReq !== this.diffSeq) return; // a newer file selection superseded this one
      if (r.status === "ok") {
        this.diffRows = rowsFromFileChange(r.data);
      } else {
        this.diffRows = [{ kind: "note", text: "diff unavailable — " + r.error }];
      }
    } catch (e) {
      if (myReq !== this.diffSeq) return;
      this.diffRows = [{ kind: "note", text: "diff unavailable — " + e }];
    } finally {
      if (myReq === this.diffSeq) this.diffLoading = false;
    }
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
      note: "🔁 I back up the " + (untracked ? "file's bytes" : "exact diff") + " before discarding — ask if you need it back.",
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
      note: "🔁 I pin HEAD to a backup first, but that does not cover the stash's own content once git prunes it.",
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
