// Multi-branch merge — controller (Svelte 5 runes singleton).
//
// Lets the user pick several LOCAL branches at once and merge them all into
// the current branch, choosing between:
//   - "octopus": ONE real `git merge` naming every branch — a single merge
//     commit, but ANY conflict fails the whole thing outright (git limitation,
//     not a GitCat gap — see git_merge.rs's `merge_start_multi` doc comment).
//   - "sequential": a queue of ordinary pairwise merges, one at a time, each
//     individually resolvable exactly like any other merge conflict.
//
// Shape precedent: closer to rebaseplan.svelte.ts than SetupWizard — branch
// picking is PURELY local state (a Set of branch names, toggled by checkbox)
// until Merge is pressed, same "local state until you commit to an action"
// feel; reuses Workdir's own "ephemeral Set-backed multi-select, one action
// button" idea rather than the Sidebar's persisted-filter checkboxes.
//
// Conflict/queue handoff: exactly like rebasePlanCtrl, this does NOT render
// its own conflict UI — a conflict result hands off to the SAME shared
// resolver island every other op uses. For sequential mode, `merge()` passes
// resolver.openFromResult an `onQueueContinue` callback (see that method's own
// doc comment) so that once the user resolves the CURRENT step's conflict via
// the ordinary Continue button, the queue automatically advances to the next
// branch — chaining through every clean step (and every conflict in turn)
// until the whole queue is done, without the user having to reopen this tool
// between steps. An `onQueueAbort` callback is also passed, so aborting the
// current step via the ordinary Abort button cancels the whole queue's
// backend sidecar too, instead of leaving it stranded.
//
// Progress/chaining is driven by ASKING `merge_queue_status` for ground truth
// after every step (`advanceOrFinish` below), never by a client-side counter:
// a single `merge_queue_continue` call can conclude TWO logical steps at once
// (it promotes the previous `current` into `done` before it even attempts the
// next branch — see that command's own doc comment), so a "one step per call"
// counter would drift out of sync with reality. Asking the backend directly
// is exact regardless of how many steps a given call happened to fold
// together.
//
// Reopen-recovery: `show()` checks `merge_queue_status` FIRST (mirrors
// bisectCtrl.probeOnOpen's own recovery pattern) — if a sequential queue is
// still in progress (e.g. the app closed between two steps, a narrow but real
// window), the picker is replaced with a small resume view instead.
//
// `queueBusy` (distinct from `busy`, which only spans one top-level call) is
// a mutex around "an independent queue-advance ENTRY is active" —
// ADVERSARIALLY-FOUND FIX: `busy` alone doesn't cover the window where
// advanceOrFinish's core logic runs as resolver's `onQueueContinue` callback
// (i.e. after the user resolves a conflict via the Resolver's own Continue
// button, entirely outside any top-level call here) — without `queueBusy`,
// the user could reopen this picker and click Continue in that exact window,
// firing a SECOND concurrent `merge_queue_continue` call racing the first.
// Acquired by `resumeContinue()` and by `advanceQueueGuarded()` (the
// onQueueContinue callback's own entry point) — NOT by `advanceOrFinish`
// itself, whose own doc comment explains why re-acquiring there would break
// its legitimate recursion through multiple clean steps in a row.
//
// Every callback captured for later (`onQueueContinue`/`onQueueAbort`, both
// closing over `repo`) re-checks that `repo` is still the active repository
// before doing anything — ADVERSARIALLY-FOUND FIX: without this, switching to
// a different repo (reachable via the native OS menu bar, which bypasses this
// app's own DOM overlay) while a queue conflict sits unresolved let a LATER,
// unrelated repo's conflict resolution fire the stale callback against the
// wrong repo.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { resolver } from "../resolver/resolver.svelte.ts";
import { IN_TAURI } from "../../ipc/env";
import type { LocalBranch, MergeResult } from "../../ipc/bindings";

export type MultiMergeMode = "octopus" | "sequential";
export type MultiMergeStrategy = "auto" | "no-ff" | "ff-only";

// Demo data (design-mode only) — same spirit as rebaseplan.svelte.ts's
// DEMO_PLAN: a small canned branch list so the browser preview still shows a
// populated picker without a real backend.
const DEMO_BRANCHES: LocalBranch[] = [
  { name: "feat/inline-diff", sha: "1111111111111111111111111111111111111111", ahead: 3, behind: 0, upstream: null },
  { name: "fix/lane-cull", sha: "2222222222222222222222222222222222222222", ahead: 1, behind: 2, upstream: null },
  { name: "release/0.3", sha: "3333333333333333333333333333333333333333", ahead: 5, behind: 0, upstream: null },
];

class MultiMergeState {
  open = $state(false);
  busy = $state(false);
  demo = $state(false);
  head = $state(""); // current branch name — excluded from the picker
  branches = $state<LocalBranch[]>([]);
  selected = $state<Set<string>>(new Set()); // branch NAMEs; reassigned, never mutated in place
  mode = $state<MultiMergeMode>("sequential");
  strategy = $state<MultiMergeStrategy>("auto");

  // Reopen-recovery view — populated when merge_queue_status reports a
  // sequential queue still in progress (see this module's own doc comment).
  // current/remaining/done are SHAs (the backend sidecar's own keying) —
  // labelFor() below maps them back to branch names for display.
  resuming = $state(false);
  queueCurrent = $state<string | null>(null);
  queueRemaining = $state<string[]>([]);
  queueDoneList = $state<string[]>([]);

  repo = "";

  // Re-entrancy guard around "a queue-advance step is in flight" — see this
  // module's own doc comment for why this is separate from `busy`. Not
  // `$state`: purely an internal mutex, never rendered.
  private queueBusy = false;

  get selectedCount(): number {
    return this.selected.size;
  }
  get canMerge(): boolean {
    return this.selected.size >= 2 && !this.busy;
  }

  // Display name for a sha the backend sidecar reports (current/remaining/
  // done) — falls back to a short sha if the branch isn't in `branches`
  // (e.g. it was deleted since the queue started).
  labelFor(sha: string): string {
    const b = this.branches.find((x) => x.sha === sha);
    return b ? b.name : sha.slice(0, 7);
  }

  private isStaleRepo(repo: string): boolean {
    return (bridge.CUR_REPO as unknown as string) !== repo;
  }

  async show(repo: string) {
    if (this.busy) return;
    this.selected = new Set();
    this.mode = "sequential";
    this.strategy = "auto";
    this.resuming = false;
    if (!IN_TAURI) {
      this.demo = true;
      this.repo = repo || "";
      this.head = "main";
      this.branches = DEMO_BRANCHES;
      this.open = true;
      return;
    }
    if (!repo) {
      bridge.tama.warn("Open a repository first.");
      return;
    }
    this.demo = false;
    this.repo = repo;
    this.busy = true;
    try {
      // Fetched together (not sequentially): the resume view ALSO wants
      // `branches` populated (see labelFor()), not just the non-resume picker.
      const [status, r] = await Promise.all([commands.mergeQueueStatus(repo), commands.listRefs(repo)]);
      if (r.status === "ok") {
        this.head = r.data.head || "";
        this.branches = (r.data.locals || []).filter((b) => b.name !== this.head);
      }
      if (status.inProgress) {
        this.resuming = true;
        this.queueCurrent = status.current;
        this.queueRemaining = status.remaining;
        this.queueDoneList = status.done;
        this.open = true;
        return;
      }
      if (r.status !== "ok") {
        bridge.tama.warn(r.error || "Could not list branches.");
        return;
      }
      this.open = true;
    } catch (e) {
      bridge.tama.warn("Could not open the branch picker — " + e);
    } finally {
      this.busy = false;
    }
  }

  close() {
    this.open = false;
    this.selected = new Set();
    this.resuming = false;
  }

  toggle(name: string) {
    const next = new Set(this.selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    this.selected = next;
  }

  setMode(mode: MultiMergeMode) {
    this.mode = mode;
  }
  setStrategy(strategy: MultiMergeStrategy) {
    this.strategy = strategy;
  }

  private shaFor(name: string): string {
    const b = this.branches.find((x) => x.name === name);
    return b ? b.sha : name;
  }

  async merge() {
    if (!this.canMerge) return;
    const names = [...this.selected];
    if (this.demo) {
      this.close();
      const modeLabel = this.mode === "octopus" ? "Octopus merge" : "Sequential merge";
      bridge.tama.set("celebrate");
      bridge.tama.say(modeLabel + " of " + names.length + " branch" + (names.length === 1 ? "" : "es") + " applied (demo).", 3200);
      bridge.cheer('Merge complete. <span class="jp">よし!</span>');
      return;
    }
    const repo = this.repo;
    const shas = names.map((n) => this.shaFor(n));
    this.busy = true;
    bridge.tama.event("mutation.caution", { count: names.length });
    bridge.tama.set("thinking");
    bridge.tama.say(
      this.mode === "octopus"
        ? "Merging " + names.length + " branches (octopus)…"
        : "Merging 1 of " + names.length + "…",
    );
    try {
      const res = await commands.mergeStartMulti(repo, shas, this.mode, this.mode === "sequential" ? this.strategy : null);
      this.close();
      await this.stepOutcome(repo, res, names[0] || "");
    } catch (e) {
      bridge.tama.warn("Merge failed — " + e);
    } finally {
      this.busy = false;
    }
  }

  // Resume view: advance a queue found still in progress on reopen. This one
  // call both confirms the stalled `current` step is genuinely finished and
  // attempts the next branch (see merge_queue_continue's own doc comment) —
  // its result is dispatched through the SAME stepOutcome merge() uses, so a
  // conflict here hands off to the resolver exactly the same way.
  async resumeContinue() {
    if (this.busy || this.queueBusy) return;
    this.busy = true;
    this.queueBusy = true;
    const repo = this.repo;
    this.close();
    bridge.tama.set("thinking");
    bridge.tama.say("Continuing the merge queue…");
    try {
      const res = await commands.mergeQueueContinue(repo);
      await this.stepOutcome(repo, res, "");
    } catch (e) {
      bridge.tama.warn("Could not continue the merge queue — " + e);
    } finally {
      this.busy = false;
      this.queueBusy = false;
    }
  }

  async resumeCancel() {
    if (this.busy) return;
    this.busy = true;
    try {
      const res = await commands.mergeQueueAbort(this.repo);
      if (res.ok) {
        this.close();
        await bridge.reloadGraph(true);
        bridge.tama.set("hint");
        bridge.tama.say(res.message || "Merge queue cancelled.", 3200);
      } else {
        bridge.tama.warn(res.message || "Could not cancel the merge queue.");
      }
    } catch (e) {
      bridge.tama.warn("Could not cancel the merge queue — " + e);
    } finally {
      this.busy = false;
    }
  }

  // Shared dispatch for every MergeResult this controller can receive —
  // whether from merge()'s own merge_start_multi call, resumeContinue()'s
  // merge_queue_continue call, or advanceOrFinish()'s own chained
  // merge_queue_continue calls below. `repo` is threaded explicitly (never
  // re-read from `this.repo`) so a callback that fires long after the picker
  // closed — e.g. once the user finishes resolving a conflict — still targets
  // the repo this particular queue actually belongs to, even if the app has
  // since moved on to a different one.
  private async stepOutcome(repo: string, res: MergeResult, label: string) {
    switch (res.state) {
      case "clean":
      case "empty":
        // Recurses into the UNGUARDED core (see advanceOrFinish's own doc
        // comment) — this is a synchronous continuation of whichever
        // already-guarded call chain got here (merge()'s own `busy`,
        // resumeContinue()'s own `busy`+`queueBusy`, or
        // advanceQueueGuarded()'s `queueBusy`), never a fresh, independent
        // entry that would need to acquire the mutex itself.
        if (this.mode === "sequential") await this.advanceOrFinish(repo);
        else await this.finish(res.message || "Octopus merge complete.");
        break;
      case "conflict":
        // Hand off to the SAME shared conflict UI every other op uses (see
        // this module's doc comment). Sequential mode passes onQueueContinue/
        // onQueueAbort so the queue advances or cleans itself up once this
        // step's conflict is resolved or aborted; octopus never reaches this
        // case with more to do (a single call covers every branch at once).
        // onQueueContinue goes through the GUARDED wrapper: unlike the
        // "clean"/"empty" recursion above, this callback fires LATER, from
        // resolver.svelte.ts, entirely outside any of this controller's own
        // busy-guarded calls — it's a genuinely independent entry, not a
        // continuation, so it must acquire `queueBusy` itself.
        await resolver.openFromResult(
          repo,
          res,
          label,
          "merge",
          this.mode === "sequential" ? () => this.advanceQueueGuarded(repo) : undefined,
          this.mode === "sequential" ? () => this.cancelQueueFromResolverAbort(repo) : undefined,
        );
        break;
      case "octopus-conflict-unsupported":
        bridge.tama.warn(res.message || "Octopus merge hit a conflict it can't resolve — try Sequential instead.");
        break;
      default: // "error"
        bridge.tama.warn(res.message || "Merge could not start.");
        break;
    }
  }

  // Guarded external entry point for the onQueueContinue callback (see
  // stepOutcome's own "conflict" case comment for why this one specifically
  // needs its own mutex acquisition, unlike the internal recursion in
  // stepOutcome's "clean"/"empty" case).
  private async advanceQueueGuarded(repo: string) {
    if (this.isStaleRepo(repo) || this.queueBusy) return;
    this.queueBusy = true;
    try {
      await this.advanceOrFinish(repo);
    } finally {
      this.queueBusy = false;
    }
  }

  // Called once a sequential step concludes — whether it was clean on the
  // first try, or just resolved via the resolver's ordinary Continue button
  // (see resolver.svelte.ts's `queueContinue` field). Asks merge_queue_status
  // for the AUTHORITATIVE remaining state (see this module's own doc comment
  // on why a client-side counter isn't reliable here) and either advances to
  // the next queued branch or finishes.
  //
  // Deliberately does NOT acquire `queueBusy` itself — every caller already
  // holds it (merge()'s/resumeContinue()'s own `busy`, spanning their entire
  // recursive chain since everything here is `await`ed in one unbroken
  // sequence; or advanceQueueGuarded()'s own `queueBusy`, for the one entry
  // point — the onQueueContinue callback — that fires independently, outside
  // any of those). Re-acquiring it here would block stepOutcome's own
  // legitimate recursion (chaining through MULTIPLE clean steps in a row)
  // against itself. `isStaleRepo` IS re-checked every call, including
  // recursive ones — cheap, stateless, and catches a repo switch mid-chain
  // too, not just at the very start.
  private async advanceOrFinish(repo: string) {
    if (this.isStaleRepo(repo)) return;
    try {
      const status = await commands.mergeQueueStatus(repo);
      if (!status.inProgress) {
        await this.finish("Sequential merge complete.");
        return;
      }
      const total = status.remaining.length + status.done.length + (status.current ? 1 : 0);
      bridge.tama.say("Merging " + (status.done.length + 1) + " of " + total + "…");
      const res = await commands.mergeQueueContinue(repo);
      await this.stepOutcome(repo, res, "");
    } catch (e) {
      bridge.tama.warn("Could not continue the merge queue — " + e);
    }
  }

  // Fired by resolver.svelte.ts's abort() success path (see `queueAbort`'s
  // own doc comment there) — the current step's conflict was just aborted
  // via the ordinary Abort button, so the whole queue is cancelled too,
  // rather than leaving the backend sidecar stranded.
  private async cancelQueueFromResolverAbort(repo: string) {
    if (this.isStaleRepo(repo)) return;
    try {
      const res = await commands.mergeQueueAbort(repo);
      if (res.ok) {
        bridge.tama.set("hint");
        bridge.tama.say(res.message || "Merge queue cancelled.", 3200);
        await bridge.reloadGraph(true);
      } else {
        bridge.tama.warn(res.message || "Could not cancel the merge queue.");
      }
    } catch (e) {
      bridge.tama.warn("Could not clean up the merge queue — " + e);
    }
  }

  private async finish(message: string) {
    bridge.tama.set("celebrate");
    bridge.tama.say(message, 4200);
    bridge.cheer('Merge complete. <span class="jp">よし!</span>');
    await bridge.reloadGraph(true);
  }
}

export const multimergeCtrl = new MultiMergeState();
