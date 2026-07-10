// Conflict resolver — controller (Svelte 5 runes singleton).
//
// Owns the resolver's UI state + the whole cherry-pick/merge/rebase/revert
// outcome flow. The legacy canvas-drag handler calls `resolver.startPick(...)`
// (cherry-pick) or `resolver.startMerge(...)` (merge) for a real op, the
// branch-menu calls `resolver.startRebase(...)` (rebase), the detail panel's
// "Revert commit" button calls `resolver.startRevert(...)` (revert), or
// `openDemo(...)` (browser design mode); the modal buttons call the async
// methods below. All backend calls go through the typed `ipc` layer;
// cross-cutting UI effects (graph reload, mascot, cheer) go through the
// legacy `bridge`.
//
// ── op-dispatch design ──────────────────────────────────────────────────────
// One resolver instance serves cherry-pick, merge, rebase, revert, AND
// merge-squash conflicts. There are five entry points — `startPick` (used by
// the existing cherry-pick drag handler, unchanged signature), `startMerge`,
// `startRebase`, `startRevert`, and `startMergeSquash` — because each op's
// *start* command takes different args (cherry-pick's `recordOrigin`,
// rebase's `onto`, revert's `signoff`, merge's `strategy`, have no equivalent
// on the others). All funnel into the SAME shared `applyOutcome` + modal
// state (`.open`, `.files`, `.selected`, …), so there is exactly one
// conflict-resolution UI. `startMergeSquash`'s SUCCESS path is the one
// exception to "funnel into the same outcome" — see its own "staged" case in
// `applyOutcome` and `openSquashStaged` below: unlike every other op, a
// successful squash still owes a real commit, so it hands off to the
// Workdir commit UI instead of closing the modal and cheering.
//
// `pullMerge`/`pullRebase` are NOT a fifth op — they're a thin orchestration
// layer in front of `startMerge`/`startRebase`: look up the current branch's
// upstream (`current_upstream`), fetch it fresh, then hand off to the SAME
// `startMerge`/`startRebase` used by the canvas drag gesture / branch menu.
// See `pullWithStrategy` below and git_remote.rs's module doc for why plain
// `pull` (the topbar button) stays untouched and ff-only.
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
//
// ── interactive-rebase "editing" state ──────────────────────────────────────
// `RebaseResult.state` can now also be `"editing"` (a `git rebase -i` paused
// cleanly at an `edit` todo line — see git_rebase.rs's module doc): nothing is
// conflicted, there is no file list, and `conflict_status`'s shape (`op` +
// `files`) genuinely CANNOT distinguish this from the pre-existing hook/
// gpgsign fallback (both report `in_progress:true, op:"rebase", files:[]`) —
// only the direct `RebaseResult` from start/continue/skip carries the
// distinguishing signal. So `.editing` is NOT re-derived by `refresh()`
// (unlike `.op`) — it is set directly from whichever `RebaseResult` we just
// received (`openEditing`, mirroring how `.op` is set "optimistically" by
// startRebase before any round trip), and cleared by `reset()` (called by
// every OTHER open*/close path, including a genuine conflict's `openConflict`
// — a real conflict always wins over a stale `.editing` flag). `continue()`/
// `abort()` need ZERO special-casing for this: `OPS[this.op]` already points
// at `rebaseContinue`/`rebaseAbort` regardless of `.editing`, and continuing
// from one edit-pause into ANOTHER falls through `applyOutcome` into
// `openEditing` again automatically.
//
// CRITICAL: `continue()`/`skip()`'s "still conflicted" branch (the caller's
// result is `state:'conflict'`, i.e. the SAME commit is still unresolved, or —
// for `continue()` specifically — resolving/amending landed on the NEXT
// conflicting commit in the sequence) must ALSO clear `.editing` back to
// false. Without this, continuing past an edit-pause straight into a REAL
// conflict on the next commit would leave `.editing` stuck true — the modal
// gates its entire file-list/three-way-diff UI on `!resolver.editing` (see
// Resolver.svelte), so a stuck flag stranded the user on the "paused to
// edit"/"Open Workdir to amend…" banner even though `conflictedFiles` was
// already correctly populated, with no in-app way to resolve the new conflict
// (only Abort). `skip()` can never actually be called while `.editing` is
// true (guarded below, and the button is hidden by Resolver.svelte too) — the
// same `this.editing = false` is set there anyway, defensively, so a future
// change to that guard can't silently reopen this gap.
//
// The Resolver view reuses the SAME modal shell for `.editing` (no separate
// component) but hides the three-way-diff file list and shows a banner + an
// affordance (`openWorkdirToAmend`) that BACKGROUNDS the scrim (`.open =
// false`, `.editing` stays true) and hands off to the already-built Workdir
// panel (`bridge.selectWorkdir()`) so the user can amend the paused commit
// with the SAME stage/amend-commit UI that panel already owns — no second
// amend UI implemented here. A small persistent pill (rendered whenever
// `.editing && !.open`) keeps Continue/Abort reachable while the user works in
// Workdir; `reopen()` brings the modal back to the foreground.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { workdirCtrl } from "../workdir/workdir.svelte.ts";
import type { ConflictFile, MergeResult, MergeSquashResult, PickResult, RebaseResult, RevertResult, StashResolveResult, WorkdirResult } from "../../ipc/bindings";

// specta generates `side: string`; keep the precise union at the call boundary.
type ConflictSide = "ours" | "theirs";

// The ops this resolver can drive end-to-end (has *_continue/*_abort wired).
// Mirrors conflict.rs's resolve_conflict_file allowlist — keep them in sync.
// "stash" is the odd one out: there's no matching `startStash()` entry point
// below (see `openStashConflict()`) because the "start" command (stash_apply/
// stash_pop) is already owned by workdirCtrl, which needs the result for its
// OWN non-conflict success/failure toasts too — see workdir.svelte.ts's
// `applyOrPopStash`. "merge-squash" (backlog #7) DOES have its own start entry
// (`startMergeSquash`, mirroring startMerge) since nothing else owns
// `merge_squash`'s result — but its SUCCESS state ("staged", not "clean")
// hands off to workdirCtrl's commit UI instead of closing+cheering — see
// `openSquashStaged` below.
type ResolverOp = "cherry-pick" | "merge" | "rebase" | "revert" | "stash" | "merge-squash";

type OpResult = PickResult | MergeResult | RebaseResult | RevertResult | StashResolveResult | MergeSquashResult;

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
  revert: { abort: commands.revertAbort, continueOp: commands.revertContinue },
  stash: { abort: commands.stashConflictAbort, continueOp: commands.stashConflictContinue },
  "merge-squash": { abort: commands.mergeSquashAbort, continueOp: commands.mergeSquashContinue },
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
  revert: {
    title: "Revert hit a conflict",
    verb: "Revert",
    clean: (sha) => "Reverted " + (sha || "") + ".",
    empty: "Nothing to revert — that change isn't present.",
    conflictBanner: (sha, n) =>
      n
        ? "Reverting " + (sha || "the commit") + " conflicts in " + n + " file" + (n === 1 ? "" : "s") +
          ". Pick a side per file, then Continue — or Abort."
        : "Revert of " + (sha || "the commit") + " needs review — resolve, then Continue, or Abort.",
    cheer: 'Revert applied. <span class="jp">よし!</span>',
    abortMsg: "Revert aborted — HEAD unchanged.",
    continueSay: "Conflict resolved — revert committed.",
    continueCheer: 'Conflict resolved — revert committed. <span class="jp">よし!</span>',
  },
  // No sha of its own (a stash conflict is keyed by stash index, not a
  // commit) — `sha` args below are always "". `clean`/`empty` are near-dead
  // fallbacks: stash_conflict_abort/continue always populate `message`
  // (StashResolveResult never omits it), and "empty" can't happen at all for
  // this op (see StashResolveResult's doc comment) — kept only so this entry
  // type-checks against the same shape every other op uses.
  stash: {
    title: "Stash conflict",
    verb: "Stash",
    clean: () => "Stash conflict resolved.",
    empty: "Nothing to finish — already resolved.",
    conflictBanner: (_sha, n) =>
      n
        ? "That stash conflicts in " + n + " file" + (n === 1 ? "" : "s") +
          ". Pick a side per file, then Continue — or Abort."
        : "That stash needs review — resolve, then Continue, or Abort.",
    cheer: 'Stash conflict resolved. <span class="jp">よし!</span>',
    abortMsg: "Reset back to before the stash was applied.",
    continueSay: "Conflict resolved — stash finished.",
    continueCheer: 'Conflict resolved — stash finished. <span class="jp">よし!</span>',
  },
  // `clean`/`empty` are near-dead fallbacks here too (same rationale as
  // stash's own comment above): a successful squash — from `merge_squash`
  // OR from resolving this op's own conflict — reports "staged", never
  // "clean" (see MergeSquashResult's own doc: squash never commits), which
  // `applyOutcome` routes to `openSquashStaged` instead of this table at all.
  "merge-squash": {
    title: "Squash-merge hit a conflict",
    verb: "Squash",
    clean: (sha) => "Squashed " + (sha || "") + " into the index.",
    empty: "Already up to date — nothing to squash.",
    conflictBanner: (sha, n) =>
      n
        ? "Squashing " + (sha || "the commit") + " conflicts in " + n + " file" + (n === 1 ? "" : "s") +
          ". Pick a side per file, then Continue — or Abort."
        : "Squashing " + (sha || "the commit") + " needs review — resolve, then Continue, or Abort.",
    cheer: 'Squash staged. <span class="jp">よし!</span>',
    abortMsg: "Squash-merge conflict aborted — back to the pre-squash state.",
    continueSay: "Conflict resolved — squash staged, write a commit message to finish.",
    continueCheer: 'Conflict resolved — squash staged. <span class="jp">よし!</span>',
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
  // Set optimistically by startPick/startMerge/startRebase/startRevert/
  // openDemo; re-derived authoritatively from conflict_status().op on every
  // refresh() — see the module doc's "op-dispatch design" note above.
  op = $state<ResolverOp>("cherry-pick");
  // True while paused at an interactive-rebase `edit` todo line — see the
  // module doc's "interactive-rebase editing state" note above. Only ever
  // true when `.op === "rebase"`. NOT re-derived by refresh() (conflict_status
  // can't tell this apart from a real in-progress rebase with no files yet);
  // set directly from a fresh RebaseResult by `openEditing`, cleared by
  // `reset()`.
  editing = $state(false);

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
  // Modal title — "Cherry-pick hit a conflict" | "Merge hit a conflict", or
  // (interactive rebase only) "Rebase paused to edit a commit" while `.editing`.
  get title(): string {
    if (this.editing) return "Rebase paused to edit a commit";
    return MSG[this.op].title;
  }

  select(path: string) {
    this.selected = path;
  }

  private reset() {
    this.files = [];
    this.selected = null;
    this.remaining = new Set();
    this.editing = false;
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
  // `strategy` (backlog #7) is optional and defaults to "auto" (today's exact
  // behavior — no extra flag) precisely so the THREE existing callers (the
  // canvas drag gesture, the commit-menu's "Merge" action, and
  // `pullWithStrategy`'s merge path, all of which call this with no third
  // arg) never need to change. Only the Sidebar's new branch-row "Merge into
  // current…" strategy chooser (see sidebar.svelte.ts's `mergeInto`) ever
  // passes an explicit non-default value. `commands.mergeStart` itself takes
  // a required `string | null` (specta has no optional-param concept), so
  // `?? null` is the boundary translation.
  async startMerge(repo: string, sha: string, strategy?: string | null) {
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
      const res = await commands.mergeStart(repo, sha, strategy ?? null);
      await this.applyOutcome(res, sha);
    } catch (e) {
      bridge.tama.warn("Merge failed — " + e);
    } finally {
      this.busy = false;
    }
  }

  // Squash `sha`'s entire diff into the index (no commit) — the Sidebar's new
  // branch-row "Merge into current… > Squash" action (see sidebar.svelte.ts's
  // `squashInto`). Mirrors startMerge/startPick's shape exactly; the only
  // difference is downstream, in `applyOutcome`'s "staged" case below (a
  // successful squash still owes a real commit, unlike every other op here).
  // Demo mode never reaches this method — see openDemo's "merge-squash" kind
  // and the callers' own `!IN_TAURI` branch, same convention as
  // startMerge/startRebase/startRevert.
  async startMergeSquash(repo: string, sha: string) {
    if (this.busy) return;
    if (!repo) {
      bridge.tama.warn("Open a repository first.");
      return;
    }
    this.demo = false;
    this.op = "merge-squash";
    this.repo = repo;
    this.busy = true;
    bridge.tama.event("mutation.caution", { count: 1 });
    try {
      const res = await commands.mergeSquash(repo, sha);
      await this.applyOutcome(res, sha);
    } catch (e) {
      bridge.tama.warn("Squash failed — " + e);
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

  // Pull-with-strategy: fetch, then merge/rebase the current branch onto its
  // configured upstream. The two new Tools-menu/⌘K entries "Pull (Merge)" /
  // "Pull (Rebase)" (see main.ts's menu-action switch and cmdk.svelte.ts's
  // ACTIONS) call these. Deliberately NOT wired into the existing topbar
  // Pull button/doPull() — see git_remote.rs's module doc: that stays the
  // one-click ff-only op, completely unchanged. This reuses startMerge's /
  // startRebase's ENTIRE clean/empty/conflict/error handling verbatim — the
  // upstream lookup + fetch below are just two new steps gating those two
  // ALREADY-EXISTING entry points, not a new outcome-handling path.
  async pullMerge(repo: string) {
    await this.pullWithStrategy(repo, "merge");
  }

  async pullRebase(repo: string) {
    await this.pullWithStrategy(repo, "rebase");
  }

  private async pullWithStrategy(repo: string, op: "merge" | "rebase") {
    if (this.busy) return;
    if (!repo) {
      bridge.tama.warn("Open a repository first.");
      return;
    }
    this.busy = true;
    let upstream: string | null;
    try {
      const r = await commands.currentUpstream(repo);
      if (r.status !== "ok") {
        bridge.tama.warn(r.error || "Could not read the current branch's upstream.");
        this.busy = false;
        return;
      }
      upstream = r.data;
    } catch (e) {
      bridge.tama.warn("Could not read the current branch's upstream — " + e);
      this.busy = false;
      return;
    }
    if (!upstream) {
      bridge.tama.warn("This branch has no upstream to pull from.");
      this.busy = false;
      return;
    }
    bridge.tama.set("thinking");
    bridge.tama.say("Fetching…");
    try {
      const f = await commands.fetch(repo, null);
      if (!f.ok) {
        bridge.tama.warn(f.message || "Fetch failed — pull aborted.");
        this.busy = false;
        return;
      }
    } catch (e) {
      bridge.tama.warn("Fetch failed — pull aborted. " + e);
      this.busy = false;
      return;
    }
    // Hand off to startMerge/startRebase for the actual merge/rebase — each
    // manages `.busy`/`.op`/`.repo` itself from a clean slate (see their own
    // bodies above), so release the lock here rather than double-guarding;
    // neither can re-enter early since this function's own re-entrancy check
    // already ran above.
    this.busy = false;
    if (op === "merge") await this.startMerge(repo, upstream);
    else await this.startRebase(repo, upstream);
  }

  // Revert `sha` onto HEAD (mirrors startPick/startMerge). The detail panel's
  // "Revert commit" button is the entry point (see detail.svelte.ts's
  // `revertCommit()`) — revert always applies onto HEAD given only the source
  // commit, so unlike cherry-pick/merge there's no drag-drop target at all.
  // `signoff` mirrors cherry-pick's `recordOrigin`: a single optional
  // message-annotation toggle, defaulted off.
  async startRevert(repo: string, sha: string, signoff = false) {
    if (this.busy) return;
    if (!repo) {
      bridge.tama.warn("Open a repository first.");
      return;
    }
    this.demo = false;
    this.op = "revert";
    this.repo = repo;
    this.busy = true;
    bridge.tama.event("mutation.caution", { count: 1 });
    try {
      const res = await commands.revertStart(repo, sha, signoff);
      await this.applyOutcome(res, sha);
    } catch (e) {
      bridge.tama.warn("Revert failed — " + e);
    } finally {
      this.busy = false;
    }
  }

  // Route a start/continue result (PickResult, MergeResult, RebaseResult, or
  // RevertResult — same shape) to the UI, using `.op`'s copy for messages.
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
      case "staged":
        // merge-squash-only (see MergeSquashResult's own doc comment): a
        // successful squash — from a clean-on-first-try `startMergeSquash`
        // OR from resolving this op's own conflict via `continue()` below —
        // still owes a real commit, unlike every other op's "clean". Hand
        // off to the Workdir commit UI instead of closing+cheering.
        this.openSquashStaged(res as MergeSquashResult);
        break;
      case "editing":
        // Interactive-rebase-only (see the module doc's "editing state" note)
        // — a RebaseResult, but applyOutcome is shared across every op's
        // result type, hence the cast rather than a narrower parameter type.
        this.openEditing(res as RebaseResult, sha);
        break;
      default: // "error"
        bridge.tama.warn(res.message || msg.verb + " could not start.");
        break;
    }
  }

  // Public entry point for a caller that already ran its OWN "start" command
  // (e.g. rebasePlanCtrl.start() after `rebase_interactive_start`) and just
  // wants the result routed through the SAME clean/empty/conflict/editing/
  // error handling every startPick/startMerge/startRebase/startRevert uses —
  // so there is exactly one conflict/editing-resolution UI no matter which of
  // the two rebase entry points (linear vs. planner) produced it. `op`
  // defaults to "rebase" (the only real caller today).
  async openFromResult(repo: string, res: OpResult, sha: string, op: ResolverOp = "rebase") {
    this.demo = false;
    this.op = op;
    this.repo = repo;
    await this.applyOutcome(res, sha);
  }

  // Takes a minimal structural slice (not the full `OpResult`/`WorkdirResult`
  // union) so `openStashConflict()` below can share this with a
  // `WorkdirResult` (stash_apply/stash_pop's own result type, which has no
  // `.state`/`.ok` fields in common with `PickResult`/`MergeResult`/
  // `RebaseResult` — the caller already knows it's a conflict).
  private async openConflict(res: { conflictedFiles: string[]; backupRef: string | null }, sha: string) {
    this.sha = sha || "";
    this.reset();
    this.tamaImg = bridge.TAMA_IMG.alarm;
    const n = res.conflictedFiles ? res.conflictedFiles.length : 0;
    this.sub = MSG[this.op].conflictBanner(sha, n);
    if (res.backupRef) this.backupRef = res.backupRef;
    await this.refresh();
    this.open = true;
  }

  // "editing" state (interactive-rebase only — see the module doc's note):
  // the sequencer stopped cleanly at an `edit` todo line. No conflict_status
  // round trip and no file list — there is nothing it could tell us that the
  // RebaseResult itself doesn't already carry (files are always empty here;
  // see git_rebase.rs's `classify`). `sha`/`res.message` come straight from
  // the backend, matching every other open* method's "never invent copy the
  // backend already wrote" convention.
  private openEditing(res: RebaseResult, sha: string) {
    this.sha = sha || "";
    this.reset();
    this.editing = true;
    this.tamaImg = bridge.TAMA_IMG.alarm;
    this.sub = res.message || "Rebase paused to edit a commit — amend it, then Continue.";
    if (res.backupRef) this.backupRef = res.backupRef;
    this.open = true;
  }

  // "editing"-only affordance: background the modal (keep `.editing`/`.sub`/
  // `.backupRef` alive) and hand off to the already-built Workdir panel so the
  // user can inspect/amend the paused commit with ITS existing stage/amend-
  // commit UI, rather than a second amend UI implemented here (see the module
  // doc). The persistent pill (Resolver.svelte, shown whenever
  // `.editing && !.open`) keeps Continue/Abort reachable in the meantime.
  openWorkdirToAmend() {
    if (!this.editing) return;
    this.open = false;
    bridge.selectWorkdir();
  }

  // Bring the modal back to the foreground without losing `.editing` state —
  // the persistent pill's own "Details" affordance.
  reopen() {
    if (this.editing) this.open = true;
  }

  // merge-squash-only success handoff (see MergeSquashResult's own doc
  // comment + this file's "staged" case above): closes the resolver (a no-op
  // if it was never opened — the clean-on-first-try path), then hands off to
  // the ALREADY-BUILT Workdir commit-message UI with `.git/SQUASH_MSG`'s
  // captured content prefilled, exactly like `openWorkdirToAmend` hands an
  // interactive-rebase edit-pause off to the SAME panel rather than
  // inventing a second commit UI. `bridge.selectWorkdir()` (via
  // `workdirCtrl.select`) resets `.message` to "" as a side effect, so the
  // prefill MUST happen after it, not before.
  private openSquashStaged(res: MergeSquashResult) {
    this.close();
    bridge.selectWorkdir();
    workdirCtrl.message = res.suggestedMessage || "";
    bridge.tama.set("hint");
    bridge.tama.say(res.message || "Squashed — write a commit message to finish.", 4200);
  }

  // Public entry for a stash-apply/pop conflict (workdir.svelte.ts's
  // `applyOrPopStash`). Unlike startPick/startMerge/startRebase, this does
  // NOT call a backend "start" command itself — stash_apply/stash_pop is
  // already owned by workdirCtrl (it needs the result for its own non-
  // conflict success/failure toasts too) — it just takes the already-
  // returned `WorkdirResult` and opens the same shared Resolver UI a
  // cherry-pick/merge/rebase conflict would.
  async openStashConflict(repo: string, res: WorkdirResult) {
    this.demo = false;
    this.op = "stash";
    this.repo = repo;
    await this.openConflict(res, "");
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
        // unsupported state (e.g. "none") can never leave `.op` pointing at a
        // command pair that doesn't exist — abort/continue would then fall
        // back to the last-known-good op instead of throwing.
        if (
          r.data.op === "cherry-pick" ||
          r.data.op === "merge" ||
          r.data.op === "rebase" ||
          r.data.op === "revert" ||
          r.data.op === "stash" ||
          r.data.op === "merge-squash"
        )
          this.op = r.data.op;
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
    // No skip concept for cherry-pick/merge/revert/stash, AND deliberately not
    // offered while paused for an interactive-rebase "edit" — semantically
    // ambiguous for a pause the user explicitly asked for (see the module
    // doc); Resolver.svelte's own guard (`!resolver.editing`) hides the button,
    // this mirrors it defensively at the call site.
    if (this.op !== "rebase" || this.editing) return;
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
        // See the module doc's "CRITICAL" note above: a transition INTO
        // "conflict" must always clear a stale `.editing` flag, even though
        // skip() can't actually be reached while editing is true today (the
        // guard above returns early) — defensive, so a future change to that
        // guard can't silently reopen the stuck-on-the-edit-banner bug.
        this.editing = false;
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
        // See the module doc's "CRITICAL" note above (the fix for the
        // "stuck on the edit banner" bug): landing on a real conflict —
        // whether it's the SAME commit still unresolved, or continuing past
        // an edit-pause straight into the NEXT commit's conflict — must
        // clear `.editing`, or the modal keeps showing the edit banner
        // instead of the file-list/three-way-diff UI even though
        // `conflictedFiles` was just correctly populated below.
        this.editing = false;
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
        : kind === "merge-squash"
          ? "Squashing " + sha + " into the index conflicts in src/auth/token.ts. Snapshot …demo sealed."
          : kind === "rebase"
            ? "Rebasing onto " + sha + " conflicts in src/auth/token.ts. Snapshot …demo sealed."
            : kind === "revert"
              ? "Reverting " + sha + " conflicts in src/auth/token.ts. Snapshot …demo sealed."
              : "Picking " + sha + " onto HEAD conflicts in src/auth/token.ts. Snapshot …demo sealed.";
    this.files = FAKE.map((f) => ({ ...f }));
    this.selected = FAKE[0].path;
    this.remaining = new Set([FAKE[0].path]);
    bridge.tama.event("mutation.caution", { count: 1 });
    this.open = true;
  }
}

export const resolver = new ResolverState();
