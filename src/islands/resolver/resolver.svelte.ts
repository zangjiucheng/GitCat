// Conflict resolver — controller (Svelte 5 runes singleton).
//
// Owns the resolver's UI state + the whole cherry-pick/merge/rebase outcome
// flow. The legacy canvas-drag handler calls `resolver.startPick(...)`
// (cherry-pick) or `resolver.startMerge(...)` (merge) for a real op, the
// branch-menu calls `resolver.startRebase(...)` (rebase), or `openDemo(...)`
// (browser design mode); the modal buttons call the async methods below. All
// backend calls go through the typed `ipc` layer; cross-cutting UI effects
// (graph reload, mascot, cheer) go through the legacy `bridge`.
//
// ── op-dispatch design ──────────────────────────────────────────────────────
// One resolver instance serves cherry-pick, merge, AND rebase conflicts. There
// are three entry points — `startPick` (used by the existing cherry-pick drag
// handler, unchanged signature), `startMerge`, and `startRebase` — because
// each op's *start* command takes different args (cherry-pick's
// `recordOrigin`, rebase's `onto`, have no equivalent on the others). All
// funnel into the SAME shared `applyOutcome` + modal state (`.open`, `.files`,
// `.selected`, …), so there is exactly one conflict-resolution UI.
//
// Rebase is also the ONE op where a mid-sequence SKIP is meaningful — it drops
// the commit currently being replayed entirely, distinct from Abort (undo
// everything) and Continue (keep going after a resolved conflict). `skip()`
// below is only ever wired to a UI affordance when `.op === "rebase"`
// (Resolver.svelte conditionally renders the Skip button) — cherry-pick/merge
// have no skip concept.
//
// `abort()`/`continue()` do NOT remember "which entry point started this" —
// they dispatch on `.op`, which is re-derived from the LIVE `conflict_status`
// response every time `refresh()` runs (on open, and after every `take()`/
// partial `continue()`). This is deliberately more robust than trusting
// in-memory "which button did I click" state: even if the app were restarted
// mid-conflict, re-opening the resolver and reading `op` from disk state would
// still resolve to the right underlying command pair. `startPick`/`startMerge`
// only set `.op` OPTIMISTICALLY (so the very first conflict banner reads
// correctly before any `conflict_status` round-trip has happened); the first
// `refresh()` inside `openConflict` immediately overwrites it with the
// authoritative value.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import type { ConflictFile, MergeResult, PickResult, RebaseResult } from "../../ipc/bindings";

// specta generates `side: string`; keep the precise union at the call boundary.
type ConflictSide = "ours" | "theirs";

// The ops this resolver can drive end-to-end (has *_continue/*_abort wired).
// Mirrors conflict.rs's resolve_conflict_file allowlist — keep them in sync.
type ResolverOp = "cherry-pick" | "merge" | "rebase";

type OpResult = PickResult | MergeResult | RebaseResult;

const FAKE = [
  {
    path: "src/auth/token.ts",
    ours: "const ttl = 3600;\nrefresh(token);",
    base: "const ttl = 900;\nrefresh(token);",
    theirs: "const ttl = 1800;\nrefresh(token, opts);",
  },
];

// One dispatch entry per op: which commands `abort()`/`continue()` call.
const OPS: Record<ResolverOp, {
  abort: (repo: string) => Promise<OpResult>;
  continueOp: (repo: string) => Promise<OpResult>;
}> = {
  "cherry-pick": { abort: commands.cherryPickAbort, continueOp: commands.cherryPickContinue },
  merge: { abort: commands.mergeAbort, continueOp: commands.mergeContinue },
  rebase: { abort: commands.rebaseAbort, continueOp: commands.rebaseContinue },
};

// Op-flavored copy (modal title, banners, fallback messages). Keeping these
// keyed by op — rather than scattered ternaries — is what makes `applyOutcome`
// /`openConflict`/`abort`/`continue` op-agnostic below.
const MSG: Record<ResolverOp, {
  title: string;
  verb: string; // "Cherry-pick" | "Merge" — for the default error fallback
  clean: (sha: string) => string;
  empty: string;
  conflictBanner: (sha: string, n: number) => string;
  cheer: string;
  abortMsg: string;
  continueSay: string;
  continueCheer: string;
}> = {
  "cherry-pick": {
    title: "Cherry-pick hit a conflict",
    verb: "Cherry-pick",
    clean: (sha) => "Cherry-picked " + (sha || "") + ".",
    empty: "Already applied — nothing to pick.",
    conflictBanner: (sha, n) =>
      n
        ? "Picking " + (sha || "the commit") + " conflicts in " + n + " file" + (n === 1 ? "" : "s") +
          ". Pick a side per file, then Continue — or Abort."
        : "Cherry-pick of " + (sha || "the commit") + " needs review — resolve, then Continue, or Abort.",
    cheer: 'Cherry-pick applied. <span class="jp">よし!</span>',
    abortMsg: "Pick aborted — HEAD unchanged.",
    continueSay: "Conflict resolved — cherry-pick committed.",
    continueCheer: 'Conflict resolved — pick committed. <span class="jp">よし!</span>',
  },
  merge: {
    title: "Merge hit a conflict",
    verb: "Merge",
    clean: (sha) => "Merged " + (sha || "") + ".",
    empty: "Already up to date — nothing to merge.",
    conflictBanner: (sha, n) =>
      n
        ? "Merging " + (sha || "the commit") + " conflicts in " + n + " file" + (n === 1 ? "" : "s") +
          ". Pick a side per file, then Continue — or Abort."
        : "Merge of " + (sha || "the commit") + " needs review — resolve, then Continue, or Abort.",
    cheer: 'Merge applied. <span class="jp">よし!</span>',
    abortMsg: "Merge aborted — HEAD unchanged.",
    continueSay: "Conflict resolved — merge committed.",
    continueCheer: 'Conflict resolved — merge committed. <span class="jp">よし!</span>',
  },
  rebase: {
    title: "Rebase hit a conflict",
    verb: "Rebase",
    clean: (sha) => "Rebased onto " + (sha || "") + ".",
    empty: "Already up to date — nothing to rebase.",
    conflictBanner: (sha, n) =>
      n
        ? "Rebasing onto " + (sha || "the target") + " conflicts in " + n + " file" + (n === 1 ? "" : "s") +
          ". Pick a side per file, then Continue — or Skip this commit, or Abort."
        : "Rebase onto " + (sha || "the target") + " needs review — resolve, then Continue, Skip, or Abort.",
    cheer: 'Rebase complete. <span class="jp">よし!</span>',
    abortMsg: "Rebase aborted — back to the pre-rebase state.",
    continueSay: "Conflict resolved — rebase continuing.",
    continueCheer: 'Conflict resolved — rebase continuing. <span class="jp">よし!</span>',
  },
};

class ResolverState {
  open = $state(false);
  busy = $state(false); // re-entrancy lock (was PICK_BUSY)
  // Which of the modal's own action buttons is the current `busy` spell for
  // — "ours"/"theirs" (take), "skip", "abort", or "continue" — so the modal
  // can spinner/label-swap the ONE button actually clicked instead of every
  // button reacting identically to one shared flag.
  activeAction = $state<"ours" | "theirs" | "skip" | "abort" | "continue" | null>(null);
  demo = $state(false);
  sub = $state("");
  backupRef = $state("");
  tamaImg = $state("");
  files = $state<ConflictFile[]>([]);
  selected = $state<string | null>(null);
  remaining = $state<Set<string>>(new Set()); // reassigned, never mutated in place (Set isn't deep-proxied)
  // The in-progress op driving this conflict, e.g. "cherry-pick" | "merge".
  // Set optimistically by startPick/startMerge/openDemo; re-derived
  // authoritatively from conflict_status().op on every refresh() — see the
  // module doc's "op-dispatch design" note above.
  op = $state<ResolverOp>("cherry-pick");

  sha = "";
  repo = "";

  get current(): ConflictFile | null {
    return this.files.find((f) => f.path === this.selected) ?? null;
  }
  get currentLive(): boolean {
    const f = this.current;
    return !!(f && this.remaining.has(f.path));
  }
  get remainingCount(): number {
    return this.remaining.size;
  }
  // Modal title — "Cherry-pick hit a conflict" | "Merge hit a conflict".
  get title(): string {
    return MSG[this.op].title;
  }

  select(path: string) {
    this.selected = path;
  }

  private reset() {
    this.files = [];
    this.selected = null;
    this.remaining = new Set();
  }
  close() {
    this.open = false;
    this.reset();
  }

  // ── real entries (from the canvas drag handler) ────────────────────────────
  async startPick(repo: string, sha: string, recordOrigin: boolean) {
    if (this.busy) return;
    if (!repo) {
      bridge.tama.warn("Open a repository first.");
      return;
    }
    this.demo = false;
    this.op = "cherry-pick";
    this.repo = repo;
    this.busy = true;
    bridge.tama.event("mutation.caution", { count: 1 });
    try {
      const res = await commands.cherryPick(repo, sha, recordOrigin);
      await this.applyOutcome(res, sha);
    } catch (e) {
      bridge.tama.warn("Cherry-pick failed — " + e);
    } finally {
      this.busy = false;
    }
  }

  // Drag-a-commit/branch-tip-onto-HEAD merge entry (mirrors startPick).
  async startMerge(repo: string, sha: string) {
    if (this.busy) return;
    if (!repo) {
      bridge.tama.warn("Open a repository first.");
      return;
    }
    this.demo = false;
    this.op = "merge";
    this.repo = repo;
    this.busy = true;
    bridge.tama.event("mutation.caution", { count: 1 });
    try {
      const res = await commands.mergeStart(repo, sha);
      await this.applyOutcome(res, sha);
    } catch (e) {
      bridge.tama.warn("Merge failed — " + e);
    } finally {
      this.busy = false;
    }
  }

  // Rebase the current branch onto `onto` (mirrors startMerge; the branch-menu
  // "Rebase current branch onto here" action calls this with the target
  // branch's tip sha/name).
  async startRebase(repo: string, onto: string) {
    if (this.busy) return;
    if (!repo) {
      bridge.tama.warn("Open a repository first.");
      return;
    }
    this.demo = false;
    this.op = "rebase";
    this.repo = repo;
    this.busy = true;
    bridge.tama.event("mutation.caution", { count: 1 });
    try {
      const res = await commands.rebaseStart(repo, onto);
      await this.applyOutcome(res, onto);
    } catch (e) {
      bridge.tama.warn("Rebase failed — " + e);
    } finally {
      this.busy = false;
    }
  }

  // Route a start/continue result (PickResult, MergeResult, or RebaseResult —
  // same shape) to the UI, using `.op`'s copy for messages.
  private async applyOutcome(res: OpResult, sha: string) {
    const msg = MSG[this.op];
    switch (res.state) {
      case "clean":
        this.close();
        await bridge.reloadGraph(true);
        bridge.tama.event("snapshot.surfaced");
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || msg.clean(sha || ""), 4200);
        bridge.cheer(msg.cheer);
        break;
      case "empty":
        this.close();
        await bridge.reloadGraph(true);
        bridge.tama.set("hint");
        bridge.tama.say(res.message || msg.empty, 4200);
        break;
      case "conflict":
        await this.openConflict(res, sha);
        break;
      default: // "error"
        bridge.tama.warn(res.message || msg.verb + " could not start.");
        break;
    }
  }

  private async openConflict(res: OpResult, sha: string) {
    this.sha = sha || "";
    this.reset();
    this.tamaImg = bridge.TAMA_IMG.alarm;
    const n = res.conflictedFiles ? res.conflictedFiles.length : 0;
    this.sub = MSG[this.op].conflictBanner(sha, n);
    if (res.backupRef) this.backupRef = res.backupRef;
    await this.refresh();
    this.open = true;
  }

  // Pull authoritative unmerged files (AND the authoritative in-progress op —
  // see the module doc). conflict_status returns Result<T,E> via the
  // generated client — read r.data on ok, log r.error otherwise.
  private async refresh() {
    let files: ConflictFile[] = [];
    try {
      const r = await commands.conflictStatus(this.repo);
      if (r.status === "ok") {
        files = Array.isArray(r.data.files) ? r.data.files : [];
        // Re-derive `.op` from live repo state. Guarded to a known op so an
        // unsupported state (e.g. "revert"/"none") can never leave `.op`
        // pointing at a command pair that doesn't exist — abort/continue
        // would then fall back to the last-known-good op instead of throwing.
        if (r.data.op === "cherry-pick" || r.data.op === "merge" || r.data.op === "rebase") this.op = r.data.op;
      } else console.error("conflict_status", r.error);
    } catch (e) {
      console.error("conflict_status", e);
    }
    this.files = files;
    this.remaining = new Set(files.map((f) => f.path));
    if (this.selected == null || !this.remaining.has(this.selected)) {
      this.selected = files.length ? files[0].path : null;
    }
  }

  // Take a whole side for the selected file, then re-pull authoritative state.
  async take(side: ConflictSide) {
    const f = this.current;
    if (!f) return;
    if (this.demo) {
      this.remaining = new Set([...this.remaining].filter((p) => p !== f.path));
      const nx = this.files.find((x) => this.remaining.has(x.path));
      if (nx) this.selected = nx.path;
      bridge.tama.say("Took " + side + " for " + f.path + " (demo).");
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.activeAction = side;
    try {
      const r = await commands.resolveConflictFile(this.repo, f.path, side);
      if (!r.ok) bridge.tama.warn(r.message || "Could not resolve " + f.path);
    } catch (e) {
      bridge.tama.warn("Resolve failed — " + e);
      return;
    } finally {
      this.busy = false;
      this.activeAction = null;
    }
    await this.refresh();
  }

  // Drop the commit the rebase is currently stopped on entirely — rebase-only
  // (no cherry-pick/merge equivalent; Resolver.svelte only renders the Skip
  // button when `.op === "rebase"`). Re-classifies exactly like continue():
  // "conflict" again if skipping landed on the NEXT conflicting commit, or the
  // final outcome otherwise.
  async skip() {
    if (this.op !== "rebase") return;
    if (this.demo) {
      this.close();
      bridge.tama.set("hint");
      bridge.tama.say("Skipped this commit (demo).");
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.activeAction = "skip";
    try {
      const r = await commands.rebaseSkip(this.repo);
      if (r.state === "conflict") {
        await this.refresh();
        bridge.tama.warn(r.message || "Still conflicted — resolve the remaining files.");
      } else {
        await this.applyOutcome(r, this.sha);
      }
    } catch (e) {
      bridge.tama.warn("Skip failed — " + e);
    } finally {
      this.busy = false;
      this.activeAction = null;
    }
  }

  async abort() {
    if (this.demo) {
      this.close();
      bridge.tama.set("hint");
      bridge.tama.say(MSG[this.op].abortMsg);
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.activeAction = "abort";
    try {
      const r = await OPS[this.op].abort(this.repo);
      if (r && r.state === "clean") {
        this.close();
        await bridge.reloadGraph(true);
        bridge.tama.set("hint");
        bridge.tama.say(r.message || MSG[this.op].abortMsg);
      } else {
        bridge.tama.warn((r && r.message) || "Abort failed — try again, or abort from the command line.");
      }
    } catch (e) {
      bridge.tama.warn("Abort failed — " + e);
    } finally {
      this.busy = false;
      this.activeAction = null;
    }
  }

  async continue() {
    if (this.demo) {
      this.close();
      bridge.tama.set("celebrate");
      bridge.tama.say(MSG[this.op].continueSay);
      bridge.cheer(MSG[this.op].continueCheer);
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.activeAction = "continue";
    try {
      const r = await OPS[this.op].continueOp(this.repo);
      if (r.state === "conflict") {
        await this.refresh();
        bridge.tama.warn(r.message || "Still conflicted — resolve the remaining files.");
      } else {
        await this.applyOutcome(r, this.sha);
      }
    } catch (e) {
      bridge.tama.warn("Continue failed — " + e);
    } finally {
      this.busy = false;
      this.activeAction = null;
    }
  }

  // ── design-mode demo (browser, no Tauri) ──────────────────────────────────
  openDemo(sha: string, kind: ResolverOp = "cherry-pick") {
    this.demo = true;
    this.op = kind;
    this.sha = sha;
    this.tamaImg = bridge.TAMA_IMG.alarm;
    this.backupRef = "refs/gitgui/backup/…demo";
    this.sub =
      kind === "merge"
        ? "Merging " + sha + " into HEAD conflicts in src/auth/token.ts. Snapshot …demo sealed."
        : kind === "rebase"
          ? "Rebasing onto " + sha + " conflicts in src/auth/token.ts. Snapshot …demo sealed."
          : "Picking " + sha + " onto HEAD conflicts in src/auth/token.ts. Snapshot …demo sealed.";
    this.files = FAKE.map((f) => ({ ...f }));
    this.selected = FAKE[0].path;
    this.remaining = new Set([FAKE[0].path]);
    bridge.tama.event("mutation.caution", { count: 1 });
    this.open = true;
  }
}

export const resolver = new ResolverState();
