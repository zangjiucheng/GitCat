// Sidebar (refs tree + branch context menu) — controller (Svelte 5 runes
// singleton). Last of the four remaining legacy-UI migrations.
//
// Reads/mutates via the typed `commands` client (list_refs/checkout/
// create_branch/delete_branch — all already existed, this switches the raw
// `tinvoke` calls to the typed client like every other island). Peer-imports
// `resolver` directly (same shape as bisectDrawerCtrl peer-importing
// bisectCtrl) for the branch-menu's "Rebase current branch onto here" action
// — that entry point (added in commit 76f4cdd) must keep working unchanged.
//
// The branch context menu (`.ref-pop`) used to be an imperatively-appended
// `document.body` node with its own outside-click listener; here it's plain
// Svelte state (`menu`) positioned via inline style, closed via
// `<svelte:window onpointerdown>` in the view — same visual behavior, no
// manual DOM node lifecycle.
//
// Submodules (M2 — mutations on top of milestone 1's read-only status list):
// initAndUpdateSubmodule/updateSubmodule are per-row actions gated by
// submoduleAction(status) (see its own doc comment for the exact status ->
// action mapping); updateAllSubmodules is the section's bulk action. All
// three share the same busy/busyTarget re-entrancy lock as every other
// mutation in this file, and refresh via refreshSubmodules() on success only
// — a refusal (e.g. git's own "local changes would be overwritten" guard)
// surfaces through bridge.tama.warn exactly like checkout/delete's existing
// failure path, never a silent no-op.
//
// Submodules (M3 — add + sync, on top of M2's init/update):
// startNewSubmodule/cancelNewSubmodule/confirmNewSubmodule are the "+ Add
// submodule…" inline form, same shape (and same window.prompt()-doesn't-
// exist-in-Tauri's-webview rationale) as startNewBranch/startNewTag above —
// calls submodule_add and, on success, refreshes via refreshSubmodules()
// exactly like initAndUpdateSubmodule/updateSubmodule. syncSubmodule (per
// row, offered regardless of status — see its own doc comment) and
// syncAllSubmodules (the bulk "Sync all" row, alongside "Update all") call
// submodule_sync; unlike the mutations above, neither refreshes the
// submodule list on success — submodule_status's `url` field is read from
// `.gitmodules` (via git2's `Submodule::url()`), which `submodule_sync`
// never touches (it only rewrites `.git/config`), so there is nothing a
// refresh would show differently, exactly like pushTag's own "nothing local
// to refresh" precedent below.
//
// Submodules (M4 — deinit + remove, on top of M1-M3's status/init/add/sync):
// deinitSubmodule/removeSubmodule are the per-row destructive actions,
// routing through the shared armDanger typed-confirm scrim exactly like
// deleteBranch/deleteTag above. deinitSubmodule is status-gated the same way
// doDeleteBranch's own "isCurrent" checks are: submoduleNeedsForceConfirm(
// status) mirrors real git's own precondition (a dirty tree OR a merge-
// conflicted gitlink both refuse `deinit` without `-f` — see submodule.rs's
// module doc comment) — everything else (clean/out-of-date/not-initialized)
// calls straight through with force:false, no scrim at all, matching this
// app's "never show a needless confirm for a safe operation" rule. Its
// doDeinitSubmodule private helper has the same two-tier fallback as
// doDeleteBranch: a plain force:false attempt first, then (only for the
// stale-status race where a row looked safe but git itself refuses) a
// window.confirm()-gated retry with force:true. removeSubmodule always
// shows the scrim regardless of status — it's unambiguously final (also
// strips .gitmodules and stages an index change) — and always calls
// submodule_remove with no force parameter (the backend behaves as force
// internally; see its own doc comment for why a second forced round-trip
// would be redundant once the confirm has already been shown). Both
// doDeinitSubmodule/doRemoveSubmodule refresh via refreshSubmodules() on
// success only, same as every other mutation in this file — a refusal
// surfaces through bridge.tama.warn, never a silent no-op. Neither ever
// appends its own backup-location copy to the success toast: submodule.rs's
// own success `message` already names the backup path inline ("… (backup:
// gitgui/submodule-backup/…)") exactly when one was written, so passing
// `res.message` straight through (the existing convention every mutation
// here already follows) is sufficient.
//
// Submodules (M5 — foreach, on top of M1-M4's status/init/add/sync/deinit/
// remove): startForeach/cancelForeach run a caller's own shell command in
// every initialized submodule (submodule_foreach_start/-cancel), streaming
// results in as each submodule finishes. Unlike every mutation ABOVE (a
// quick one-shot IPC round-trip guarded by this file's usual busy/busyTarget
// lock and reading bridge.CUR_REPO internally), submodule_foreach_start is a
// real, long-lived BLOCKING call — the same shape as bisect.svelte.ts's
// bisectCtrl.startRun/cancelRun/cancelIfRunning (bisect_run_start) — so
// startForeach takes `repo` as an explicit parameter exactly like startRun
// does, subscribes to "submodule-foreach-progress" BEFORE the blocking
// await (armed early so no early submodule's result is missed), and
// unsubscribes in a try/finally regardless of outcome. `foreachRunning` is
// its own flag (distinct from `busy`, which still guards this file's other,
// short-lived mutations) and reuses `submodulesRecursive` — the same
// bulk-only toggle Update all/Sync all already share — rather than a third,
// parallel recursive flag. `cancelIfRunning` is wired into legacy/main.ts's
// openRepo() alongside bisectCtrl.cancelIfRunning's own existing call, for
// the identical reason: switching repos out from under a real, long-lived
// blocking sweep would leave it running headlessly against a repo the UI
// can no longer see or stop.

// Checkout dirty-tree resolution modes (backlog #34, on top of the plain
// checkout/checkoutRemote that already existed): a dirty-tree collision on
// `checkout`/`checkoutRemote`'s underlying `create_branch(checkout:true)` now
// opens `dirtyCheckoutMenu` (see DirtyCheckoutMenu's own doc comment) instead
// of just toasting git's plain error — 3 explicit, differently-labeled modes,
// in increasing order of risk: `stashSwitchReapply`/`stashSwitchLeaveStashed`
// (both pure orchestration of the pre-existing `stash_save`/`checkout`/
// `create_branch`/`stash_apply`/`stash_pop` — a reapply conflict opens the
// SAME shared Resolver a stash-pop conflict from the Workdir panel already
// does, via `resolver.openStashConflict`, no new conflict machinery at all)
// and `forceDiscardCheckout` (the one genuinely destructive mode, gated
// behind `armDanger` exactly like Force Push's "override" variant). Matches
// this codebase's "never silently stash/discard anything" philosophy — every
// use of the stash mechanism here is an explicit, user-visible choice, and
// checkout itself never auto-stashes. The plain non-dirty checkout path
// (still the overwhelming majority) is completely unchanged: one round trip,
// no extra branching, exactly like before this feature existed.

import { commands } from "../../ipc/bindings";
import * as bridge from "../../legacy/bridge";
import { resolver } from "../resolver/resolver.svelte.ts";
import { rebasePlanCtrl } from "../rebaseplan/rebaseplan.svelte.ts";
import { IN_TAURI } from "../../ipc/env";
import type { LocalBranch, SimpleRef, Snapshot, SubmoduleForeachEntry, SubmoduleInfo } from "../../ipc/bindings";

// Demo data (design-mode only) — mirrors the static markup this replaces, so
// the browser preview still shows a populated sidebar without a real repo.
const DEMO_LOCALS: LocalBranch[] = [
  { name: "main", sha: "a1b2c3d", ahead: 2, behind: null, upstream: "origin/main" },
  { name: "feat/inline-diff", sha: "b2c3d4e", ahead: null, behind: 3, upstream: "origin/feat/inline-diff" },
  { name: "fix/lane-cull", sha: "c3d4e5f", ahead: null, behind: null, upstream: null },
  { name: "release/0.3", sha: "d4e5f60", ahead: null, behind: null, upstream: null },
];
const DEMO_REMOTES: SimpleRef[] = [
  { name: "origin/main", sha: "a1b2c3d" },
  { name: "origin/feat/inline-diff", sha: "b2c3d4e" },
  { name: "origin/topic/rerere", sha: "e5f6071" },
  { name: "upstream/main", sha: "f60718a" },
  { name: "upstream/dev", sha: "60718a9" },
];
const DEMO_TAGS: SimpleRef[] = [
  { name: "v0.3.0", sha: "a1b2c3d" },
  { name: "v0.2.0", sha: "718a9bc" },
  { name: "nightly-2026-07-05", sha: "18a9bcd" },
];
// Deliberately one of each of the 5 classify_status outcomes (see
// src-tauri/src/submodule.rs) so the browser design-mode preview actually
// shows every status chip color, not just "clean".
const DEMO_SUBMODULES: SubmoduleInfo[] = [
  { name: "vendor/lib-a", path: "vendor/lib-a", absolutePath: "/demo/gitcat/vendor/lib-a", url: "https://github.com/example/lib-a.git", status: "clean", headSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", workdirSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" },
  { name: "vendor/lib-b", path: "vendor/lib-b", absolutePath: "/demo/gitcat/vendor/lib-b", url: "https://github.com/example/lib-b.git", status: "dirty", headSha: "b2c3d4e5f60718293a4b5c6d7e8f9012345678a1", workdirSha: "b2c3d4e5f60718293a4b5c6d7e8f9012345678a1" },
  { name: "third_party/tool", path: "third_party/tool", absolutePath: "/demo/gitcat/third_party/tool", url: "https://github.com/example/tool.git", status: "out-of-date", headSha: "c3d4e5f60718293a4b5c6d7e8f9012345678a1b2", workdirSha: "d4e5f60718293a4b5c6d7e8f9012345678a1b2c3" },
  { name: "docs/theme", path: "docs/theme", absolutePath: "/demo/gitcat/docs/theme", url: null, status: "not-initialized", headSha: "e5f60718293a4b5c6d7e8f9012345678a1b2c3d4", workdirSha: null },
  { name: "shared/proto", path: "shared/proto", absolutePath: "/demo/gitcat/shared/proto", url: "https://github.com/example/proto.git", status: "conflicted", headSha: "f60718a293a4b5c6d7e8f9012345678a1b2c3d4e", workdirSha: "0718a293a4b5c6d7e8f9012345678a1b2c3d4e5f" },
];

export type BranchMenu = { name: string; isCurrent: boolean; x: number; y: number };
// Tags never have an "isCurrent" concept (you don't "check out" a tag in this
// app — see sidebarCtrl.deleteTag's own doc comment), so this is intentionally
// a separate, smaller shape rather than reusing BranchMenu with a dummy field.
export type TagMenu = { name: string; x: number; y: number };
// A submodule row used to render up to 5 always-visible inline buttons
// (Open/Sync/Init+update-or-Update/Deinit/Remove) plus its status chip and
// path — at the sidebar's normal width these simply don't fit and got
// silently clipped (found via visual inspection, not a report). Fixed by
// collapsing everything but the row itself (click = Open, mirroring how a
// branch row's own click already means "checkout") into a "⋮" popover,
// exactly like BranchMenu/TagMenu above. Captures status/absolutePath at
// open-time (like BranchMenu captures isCurrent) rather than re-deriving
// them from `path` inside the popover, so the popover's own buttons never
// need a second lookup into `submodules`.
export type SubmoduleMenu = { path: string; status: string; absolutePath: string; x: number; y: number };
// Backlog #7's strategy chooser, opened from the branch popover's "Merge
// into current…" button (see `openMergeMenu`) — same shape/rationale as
// TagMenu above (no extra per-row info to capture beyond the branch name and
// where to draw the popover).
export type MergeMenu = { name: string; x: number; y: number };
// Backlog #34's dirty-tree resolution chooser — opened when `checkout`/
// `checkoutRemote` hits git_write.rs's `checkout`/`create_branch` dirty-tree
// collision (`WriteResult.conflictingFiles` non-empty) instead of just
// toasting the plain error like every OTHER checkout refusal (bad ref name,
// detached HEAD edge case, …) still does. `startPoint` mirrors the two shapes
// `checkout`/`checkoutRemote` can hit this from: `null` for an existing local
// branch (plain `checkout`), or the remote ref (e.g. "origin/feature-x") for
// `checkoutRemote`'s "no matching local branch yet" path, which needs
// `create_branch(..., checkout:true)`/`checkout_discard(..., startPoint)`
// instead of plain `checkout`/`checkout_discard(..., null)` — see
// stashSwitchThen/forceDiscardCheckout below, which both branch on this the
// same way. `files` is `WriteResult.conflictingFiles` verbatim, for the
// popover's own "N files would be overwritten: …" copy.
export type DirtyCheckoutMenu = { name: string; startPoint: string | null; files: string[]; x: number; y: number };

// Which action (if any) a submodule row's status affords — a pure, exported
// function rather than inline template logic so it's directly unit-testable
// without a component-rendering harness (this codebase's tests are all
// controller/state-level; see sidebar.svelte.test.ts). Mirrors
// submodule.rs's classify_status 6-way split 1:1 (plus the "unreadable" 7th
// state, added by the cyclic-submodule crash fix — see below):
//   - "not-initialized" -> "init"    (submodule_update with init:true — clone +
//     checkout a never-registered submodule in one call)
//   - "out-of-date"     -> "update"  (submodule_update with init:false — it's
//     already registered+cloned, just needs to move to the tracked commit)
//   - "dirty"/"conflicted" -> "blocked" (a button IS shown, but disabled with
//     an explanatory tooltip — there's nothing this app can usefully do until
//     the user resolves the submodule's own working tree/index state; NOT the
//     same as "clean", which shows no button at all)
//   - "clean" (or anything unrecognized) -> null (nothing to do)
//   - "removed" -> null (Bug 6 fix: already staged for removal by
//     submodule_remove, nothing committed yet — there's nothing left for
//     Init/Update to act on either; the row shows no action buttons AT ALL,
//     not just this one, so Sidebar.svelte additionally special-cases
//     s.status === "removed" directly rather than gating on this fn alone —
//     see its own comment above the Submodules list)
//   - "unreadable" -> null (CRASH FIX: this submodule's own reachable
//     nested-submodule subtree was found cyclic/unresolvable, so the backend
//     never even called submodule_status for it — there is nothing safe for
//     Init/Update/Sync/Deinit/Remove to act on, so like "removed" above,
//     Sidebar.svelte special-cases s.status === "unreadable" directly and
//     shows NO action buttons at all, not just this one — see its own
//     comment above the Submodules list)
export type SubmoduleAction = "init" | "update" | "blocked" | null;
export function submoduleAction(status: string): SubmoduleAction {
  switch (status) {
    case "not-initialized":
      return "init";
    case "out-of-date":
      return "update";
    case "dirty":
    case "conflicted":
      return "blocked";
    case "removed":
    case "unreadable":
      return null;
    default:
      return null;
  }
}
// Whether a submodule row's status makes Deinit's typed-confirm scrim
// necessary — a sibling pure classifier to submoduleAction above, exported
// the same way for the same reason (directly unit-testable, no component-
// rendering harness needed). Mirrors submodule.rs's own empirically-verified
// precondition for `git submodule deinit` refusing without `-f`: a dirty
// submodule tree OR a merge-conflicted gitlink (see that module's doc
// comment) — which is exactly submoduleAction's own "blocked" set
// (dirty/conflicted). Every other status is a no-op as far as force is
// concerned (git doesn't even require -f there), so Deinit skips the scrim
// entirely for those and calls straight through with force:false.
export function submoduleNeedsForceConfirm(status: string): boolean {
  return status === "dirty" || status === "conflicted";
}
// Whether a submodule row's status has an actual working directory on disk
// for the per-row "Open" action (bridge.enterSubmodule) to enter — a sibling
// pure classifier to submoduleAction/submoduleNeedsForceConfirm above,
// exported the same way for the same reason (directly unit-testable, no
// component-rendering harness needed). "clean"/"dirty"/"out-of-date"/
// "conflicted" all have SOMETHING checked out (submoduleAction's own
// "blocked" set — dirty/conflicted — still has a real working tree, just one
// this app won't Update/Deinit without the user resolving it first; that
// restriction is orthogonal to whether there's a directory to open at all).
// "not-initialized" (never cloned), "removed" (already cleared by
// submodule_remove), and "unreadable" (CRASH FIX — this submodule's own
// nested-submodule subtree was found cyclic/unresolvable, so submodule_status
// never even ran for it) all have nothing safe/meaningful to open, matching
// submoduleAction's own "removed"/"unreadable" -> null treatment and
// Sidebar.svelte's existing special-casing of those two statuses.
export function submoduleCanOpen(status: string): boolean {
  switch (status) {
    case "clean":
    case "dirty":
    case "out-of-date":
    case "conflicted":
      return true;
    default:
      return false;
  }
}
// Sentinel busyTarget for the bulk "Update all submodules" action — can never
// collide with a real submodule path (those come from `.gitmodules` and are
// relative repo paths, never wrapped in double underscores), same convention
// as the workdir island's "__commit__"/"__all__"/"__stash__" section-level
// sentinels for scoping a spinner to a whole action rather than one row.
export const SUBMODULES_ALL = "__submodules__";
// Sentinel busyTarget for the bulk "Sync all submodules" action — a distinct
// string from SUBMODULES_ALL above (not reused) so the "Update all" and
// "Sync all" buttons' spinners never cross-react to each other's in-flight
// request even though both bulk actions share the same busy lock and the
// same `submodulesRecursive` toggle.
export const SUBMODULES_SYNC_ALL = "__submodules_sync__";

class SidebarState {
  locals = $state<LocalBranch[]>([]);
  remotes = $state<SimpleRef[]>([]);
  tags = $state<SimpleRef[]>([]);
  submodules = $state<SubmoduleInfo[]>([]);
  head = $state<string | null>(null);
  snapshots = $state<Snapshot[]>([]);
  filter = $state("");
  busy = $state(false);
  // Which row `busy` applies to (a local branch name or a full remote ref
  // like "origin/main") — lets the view spinner-out just the one row being
  // acted on instead of dimming the whole tree.
  busyTarget = $state<string | null>(null);
  menu = $state<BranchMenu | null>(null);
  newBranchOpen = $state(false);
  newBranchInput = $state("");
  // "" means branch from HEAD (the default create_branch already had) —
  // otherwise a local/remote ref name to pass as create_branch's start_point,
  // which the backend has supported since M2a; this just exposes it in the UI.
  newBranchFrom = $state("");
  // Tag context menu ("Push to origin" / "Delete…") — separate popover state
  // from the branch `menu` above (see TagMenu's own doc comment). Only one of
  // `menu`/`tagMenu` is ever non-null at a time — opening either closes the
  // other (see openMenu/openTagMenu).
  tagMenu = $state<TagMenu | null>(null);
  // Submodule row "⋮" popover — same "only one of menu/tagMenu/submoduleMenu
  // is ever non-null at a time" rule as tagMenu above (see openMenu/
  // openTagMenu/openSubmoduleMenu, which each null the other two).
  submoduleMenu = $state<SubmoduleMenu | null>(null);
  // Backlog #7's merge-strategy chooser, opened FROM inside the branch
  // popover (`menu`'s own "Merge into current…" button) rather than from a
  // row's "⋮" directly — same "only one popover open at a time" invariant as
  // the other three, so opening this nulls menu/tagMenu/submoduleMenu too
  // (see `openMergeMenu`), and opening any of THOSE nulls this one back out
  // (see their own bodies below).
  mergeMenu = $state<MergeMenu | null>(null);
  // Backlog #34's dirty-tree resolution chooser — same "only one popover open
  // at a time" invariant as menu/tagMenu/submoduleMenu/mergeMenu above (see
  // openDirtyCheckoutMenu, and every other open* method's own null-out of
  // this one).
  dirtyCheckoutMenu = $state<DirtyCheckoutMenu | null>(null);
  newTagOpen = $state(false);
  newTagName = $state("");
  // "" means lightweight (no -a/-m); non-empty means annotated with this
  // message — same "empty means the simpler default" minimalism as
  // newBranchFrom's "" meaning HEAD, just for create_tag's `message` param.
  newTagMessage = $state("");
  // "" means at HEAD (the default create_tag already had) — otherwise a
  // local/remote ref name to pass as create_tag's target, mirroring
  // newBranchFrom exactly (same dropdown shape, same param semantics).
  newTagFrom = $state("");
  // Tracks CUR_REPO's own truthiness (not "did the last list_refs succeed" —
  // a transient refresh error shouldn't flip the sidebar back to the empty
  // state). Distinct from `head` being null, which also legitimately happens
  // for an open-but-unborn/detached repo. bridge.CUR_REPO itself is a plain
  // (non-$state) live binding, so the view can't react to it directly — this
  // is the reactive proxy for "is a repo open at all" (see Sidebar.svelte's
  // empty-state branch) that the rest of the file already needed anyway.
  hasRepo = $state(false);
  copiedSnapshotSha = $state("");
  // "Update all submodules" bulk toggle — deliberately only exposed at the
  // bulk level, not per-row (see initAndUpdateSubmodule/updateSubmodule
  // below): a single row's "Init + update"/"Update" button stays simple
  // (recursive:false, matching this app's existing minimal per-row-action
  // precedent), while the one place a nested submodule-of-a-submodule is
  // actually likely to matter is "update everything at once".
  submodulesRecursive = $state(false);
  // "+ Add submodule…" inline form state — same shape as newBranchOpen/
  // newBranchInput/newTagOpen/newTagName above (see startNewSubmodule's own
  // doc comment for why this is an inline form rather than window.prompt()).
  newSubmoduleOpen = $state(false);
  newSubmoduleUrl = $state("");
  newSubmodulePath = $state("");
  // "" means the remote's own default branch (submodule_add's own default
  // when `branch` is omitted) — otherwise checked out inside the freshly
  // cloned submodule instead, same "empty means the simpler default"
  // minimalism as newBranchFrom/newTagMessage above.
  newSubmoduleBranch = $state("");

  // "Run command in every submodule…" — the command-input's bound value.
  // `foreachRunning` is deliberately its own flag, distinct from `busy`
  // (guards this file's other short one-shot IPC round-trips): it reflects
  // the entire lifetime of a backend sweep blocking on
  // `submoduleForeachStart` for as long as it takes to run the command in
  // every submodule/converge/cancel — same distinction bisect.svelte.ts's
  // own `autoRunning` draws against `busy` there.
  foreachCommand = $state("");
  foreachRunning = $state(false);
  // Streamed in live from "submodule-foreach-progress" as each submodule
  // finishes, one entry appended per event; overwritten wholesale with the
  // final, authoritative list once submoduleForeachStart's own promise
  // resolves (mirrors bisect.svelte.ts's startRun applying its own final
  // status after the fact, in case an event ever raced it).
  foreachResults = $state<SubmoduleForeachEntry[]>([]);
  // Unlisten fn for the "submodule-foreach-progress" subscription, live only
  // while a sweep is in flight — see startForeach().
  private foreachUnlisten: (() => void) | null = null;

  async refresh(repo: string) {
    if (!IN_TAURI) {
      this.locals = DEMO_LOCALS;
      this.remotes = DEMO_REMOTES;
      this.tags = DEMO_TAGS;
      this.submodules = DEMO_SUBMODULES;
      this.head = "main";
      this.hasRepo = true;
      bridge.updateBranchPill(this.head, this.locals);
      return;
    }
    if (!repo) return;
    this.hasRepo = true;
    // Two independent reads, fired concurrently rather than one awaiting the
    // other — a submodule_status failure/slowdown shouldn't hold up refs (or
    // vice versa), and there's nothing one needs from the other's result.
    await Promise.all([this.refreshRefs(repo), this.refreshSubmodules(repo)]);
  }

  private async refreshRefs(repo: string) {
    try {
      const r = await commands.listRefs(repo);
      if (r.status !== "ok") {
        console.error("list_refs", r.error);
        return;
      }
      this.locals = r.data.locals || [];
      this.remotes = r.data.remotes || [];
      this.tags = r.data.tags || [];
      this.head = r.data.head;
      bridge.updateBranchPill(this.head, this.locals);
    } catch (e) {
      console.error("list_refs", e);
    }
  }

  private async refreshSubmodules(repo: string) {
    try {
      const r = await commands.submoduleStatus(repo);
      if (r.status !== "ok") {
        console.error("submodule_status", r.error);
        return;
      }
      this.submodules = r.data || [];
    } catch (e) {
      console.error("submodule_status", e);
    }
  }

  // "Open" — re-points the WHOLE APP at this submodule's own absolute path
  // (bridge.enterSubmodule: pushes CUR_REPO onto legacy/main.ts's navigation
  // stack, then calls its openRepo(absolutePath)) so the submodule becomes
  // the fully active repo — its own commit graph, working-directory panel,
  // branches/tags, bisect, rebase, even its own nested Submodules section —
  // with zero duplicated UI. Gated by submoduleCanOpen(status) in
  // Sidebar.svelte (see that function's own doc comment); this method itself
  // doesn't re-check status; it's a thin, directly-testable wrapper so
  // "clicking Open calls bridge.enterSubmodule with the right path" doesn't
  // need a component-rendering harness (see sidebar.svelte.test.ts).
  //
  // openRepo() (legacy/main.ts) has its own re-entrancy guard (openRepoBusy)
  // against actually firing twice, same as pickRepo/the setup wizard — but
  // load_graph + the sidebar/safety refresh it awaits is a real, sometimes
  // multi-hundred-ms round-trip against an ENTIRELY different repo, and
  // nothing near the click point ever showed that: Sidebar.svelte's own
  // template already renders a spinner keyed on `busyTarget === s.path` and
  // guards the row's click handler on `busy` (same shape as every other
  // submodule mutation above), but this method never actually SET either —
  // dead UI paths that made switching into a submodule look like it hung,
  // with the only real feedback (Tama "thinking", the topbar repo-pick
  // spinner) easy to miss from all the way down in a scrolled sidebar list.
  // `path` (relative, e.g. "vendor/lib-a") is what the row's own spinner and
  // `busy` guard key off — same convention as every mutation above (`path`,
  // not `absolutePath`, matches `s.path` in Sidebar.svelte's template); the
  // actual navigation needs `absolutePath` (bridge.enterSubmodule/openRepo).
  async openSubmodule(path: string, absolutePath: string): Promise<void> {
    if (!IN_TAURI) {
      bridge.tama.set("hint");
      bridge.tama.say("Opened " + absolutePath + " (demo).");
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.busyTarget = path;
    try {
      await bridge.enterSubmodule(absolutePath);
      // On success, openRepo() has already torn down and rebuilt this whole
      // controller's state via refresh() (a different repo, different rows
      // entirely) — this reset is a harmless no-op then. On failure (bad
      // path, permission error, transiently locked), the SAME rows are still
      // showing and this is what actually re-enables the click.
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  // "Init + update" — for a "not-initialized" row (submoduleAction(status)
  // === "init"): registers the URL AND clones/checks it out in one call
  // (submodule_update with init:true), rather than making the user run a
  // separate "Init" step first. recursive:false — see submodulesRecursive's
  // own doc comment for why that toggle lives at the bulk level only.
  async initAndUpdateSubmodule(path: string) {
    if (!IN_TAURI) {
      bridge.tama.set("hint");
      bridge.tama.say("Initialized + updated " + path + " (demo).");
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.busyTarget = path;
    bridge.tama.set("thinking");
    bridge.tama.say("Initializing " + path + "…");
    try {
      const res = await commands.submoduleUpdate(bridge.CUR_REPO as unknown as string, path, false, true);
      if (res && res.ok) {
        await this.refreshSubmodules(bridge.CUR_REPO as unknown as string);
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Initialized " + path + ".", 3200);
      } else {
        bridge.tama.warn((res && res.message) || "Couldn't initialize " + path + ".");
      }
    } catch (e) {
      bridge.tama.warn("Init failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  // "Update" — for an "out-of-date" row (submoduleAction(status) ===
  // "update"): it's already registered+cloned, so init:false — a plain
  // `git submodule update -- <path>` to move it to the commit the
  // superproject's index tracks. Never shown for "dirty"/"conflicted" rows
  // (see submoduleAction's doc comment) — those need the user to resolve the
  // submodule's own state first, so this app never even offers the button.
  async updateSubmodule(path: string) {
    if (!IN_TAURI) {
      bridge.tama.set("hint");
      bridge.tama.say("Updated " + path + " (demo).");
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.busyTarget = path;
    bridge.tama.set("thinking");
    bridge.tama.say("Updating " + path + "…");
    try {
      const res = await commands.submoduleUpdate(bridge.CUR_REPO as unknown as string, path, false, false);
      if (res && res.ok) {
        await this.refreshSubmodules(bridge.CUR_REPO as unknown as string);
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Updated " + path + ".", 3200);
      } else {
        bridge.tama.warn((res && res.message) || "Couldn't update " + path + ".");
      }
    } catch (e) {
      bridge.tama.warn("Update failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  // Bulk "Update all submodules" — submodule_path:null updates every
  // .gitmodules-registered submodule in one call, regardless of its current
  // status. Always passes init:true (not just for out-of-date ones): this is
  // the one bulk convenience action, so a never-initialized submodule sitting
  // next to an out-of-date one shouldn't need a second, separate click — folds
  // milestone 1's "Init" step in for free, exactly like a per-row "Init +
  // update" would, for every row at once. `recursive` is caller-supplied
  // (from submodulesRecursive's checkbox) rather than read from state
  // internally, so this stays trivially unit-testable with an explicit flag.
  async updateAllSubmodules(recursive: boolean) {
    if (!IN_TAURI) {
      bridge.tama.set("hint");
      bridge.tama.say("Updated all submodules (demo).");
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.busyTarget = SUBMODULES_ALL;
    bridge.tama.set("thinking");
    bridge.tama.say("Updating submodules…");
    try {
      const res = await commands.submoduleUpdate(bridge.CUR_REPO as unknown as string, null, recursive, true);
      if (res && res.ok) {
        await this.refreshSubmodules(bridge.CUR_REPO as unknown as string);
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Submodules updated.", 3200);
      } else {
        bridge.tama.warn((res && res.message) || "Couldn't update submodules.");
      }
    } catch (e) {
      bridge.tama.warn("Update failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  // "+ Add submodule…" inline form — same window.prompt()-doesn't-exist-in-
  // Tauri's-webview rationale as startNewBranch/startNewTag above; clones a
  // brand-new submodule (`submodule_add`) rather than acting on an existing
  // `.gitmodules`-registered row.
  startNewSubmodule() {
    this.newSubmoduleUrl = "";
    this.newSubmodulePath = "";
    this.newSubmoduleBranch = "";
    this.newSubmoduleOpen = true;
  }

  cancelNewSubmodule() {
    this.newSubmoduleOpen = false;
    this.newSubmoduleUrl = "";
    this.newSubmodulePath = "";
    this.newSubmoduleBranch = "";
  }

  async confirmNewSubmodule() {
    const url = this.newSubmoduleUrl.trim();
    const path = this.newSubmodulePath.trim();
    // Client-side guard mirrors confirmNewBranch/confirmNewTag's blank-name
    // check — both fields are required (submodule_add's own Rust-side
    // validate_repository_url/validate_submodule_path would refuse a blank
    // string anyway, but there's no reason to round-trip to the backend just
    // to learn that).
    if (!url || !path) {
      this.cancelNewSubmodule();
      return;
    }
    if (this.busy) return;
    const branch = this.newSubmoduleBranch.trim() || null; // "" -> remote's own default branch
    if (!IN_TAURI) {
      this.newSubmoduleOpen = false;
      this.newSubmoduleUrl = "";
      this.newSubmodulePath = "";
      this.newSubmoduleBranch = "";
      bridge.tama.set("hint");
      bridge.tama.say("Added submodule " + path + " (demo).");
      return;
    }
    // Keep the form open (disabled, spinnered) for the duration of the
    // request, same rationale as confirmNewBranch/confirmNewTag above.
    this.busy = true;
    this.busyTarget = path;
    bridge.tama.set("thinking");
    bridge.tama.say("Adding submodule " + path + "…");
    try {
      const res = await commands.submoduleAdd(bridge.CUR_REPO as unknown as string, url, path, branch);
      if (res && res.ok) {
        this.newSubmoduleOpen = false;
        this.newSubmoduleUrl = "";
        this.newSubmodulePath = "";
        this.newSubmoduleBranch = "";
        await this.refreshSubmodules(bridge.CUR_REPO as unknown as string);
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Added submodule " + path + ".", 3200);
      } else {
        bridge.tama.warn((res && res.message) || "Couldn't add submodule " + path + ".");
      }
    } catch (e) {
      bridge.tama.warn("Add failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  // "Sync" — per row, rewrites the superproject's OWN .git/config url for
  // just this one submodule from whatever `.gitmodules` currently has
  // (`submodule_sync`). Offered for EVERY row regardless of status (unlike
  // initAndUpdateSubmodule/updateSubmodule, gated by submoduleAction) — it
  // never touches the submodule's own working tree or index, just a config
  // value, so there's nothing about "dirty"/"conflicted" for it to collide
  // with. recursive:false — same bulk-only-toggle reasoning as
  // submodulesRecursive's own doc comment (a submodule-of-a-submodule sync is
  // the one case likely to matter "for everything at once", not per row).
  async syncSubmodule(path: string) {
    if (!IN_TAURI) {
      bridge.tama.set("hint");
      bridge.tama.say("Synced " + path + " (demo).");
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.busyTarget = path;
    bridge.tama.set("thinking");
    bridge.tama.say("Syncing " + path + "…");
    try {
      const res = await commands.submoduleSync(bridge.CUR_REPO as unknown as string, path, false);
      if (res && res.ok) {
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Synced " + path + ".", 3200);
      } else {
        bridge.tama.warn((res && res.message) || "Couldn't sync " + path + ".");
      }
    } catch (e) {
      bridge.tama.warn("Sync failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  // Bulk "Sync all" — submodule_path:null syncs EVERY .gitmodules-registered
  // submodule's .git/config url in one call, sitting alongside the existing
  // bulk "Update all" row and sharing its `submodulesRecursive` toggle
  // (applies to whichever bulk action is actually clicked). Uses its own
  // SUBMODULES_SYNC_ALL sentinel (not SUBMODULES_ALL) as busyTarget so the
  // two bulk buttons' spinners stay independent even though only one bulk
  // action can ever be in flight at a time (same shared `busy` lock as
  // everything else in this file).
  async syncAllSubmodules(recursive: boolean) {
    if (!IN_TAURI) {
      bridge.tama.set("hint");
      bridge.tama.say("Synced all submodules (demo).");
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.busyTarget = SUBMODULES_SYNC_ALL;
    bridge.tama.set("thinking");
    bridge.tama.say("Syncing submodules…");
    try {
      const res = await commands.submoduleSync(bridge.CUR_REPO as unknown as string, null, recursive);
      if (res && res.ok) {
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Submodules synced.", 3200);
      } else {
        bridge.tama.warn((res && res.message) || "Couldn't sync submodules.");
      }
    } catch (e) {
      bridge.tama.warn("Sync failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  // "Run command in every submodule…" (bulk, alongside Sync all/Update all)
  // — submodule_foreach_start runs `command` via a shell once in every
  // initialized submodule's own working directory (recursive:true also
  // descends into a submodule-of-a-submodule), emitting one
  // "submodule-foreach-progress" event per submodule as it finishes. This is
  // a real, long-lived BLOCKING Tauri call — the exact same shape as
  // bisect.svelte.ts's bisectCtrl.startRun (bisect_run_start) — so it's
  // mirrored almost exactly: `repo` is an explicit parameter (whatever was
  // current when Run was clicked) rather than read from bridge.CUR_REPO
  // internally the way every OTHER method in this file does; the listener is
  // armed BEFORE the blocking await so no early submodule's result is
  // missed; and it's torn down in a try/finally regardless of outcome.
  // Re-entrancy is guarded synchronously (busy/foreachRunning/repo, all
  // checked before any await), same discipline as every mutation here.
  async startForeach(repo: string, command: string, recursive: boolean) {
    if (!IN_TAURI) {
      bridge.tama.set("hint");
      bridge.tama.say('Ran "' + command.trim() + '" in each submodule (demo).');
      return;
    }
    if (this.busy || this.foreachRunning || !repo) return;
    const cmd = command.trim();
    if (!cmd) {
      bridge.tama.warn("Enter a command to run in each submodule first.");
      return;
    }
    this.foreachRunning = true;
    this.foreachResults = [];
    bridge.tama.set("thinking");
    bridge.tama.say('Running "' + cmd + '" in each submodule…');
    try {
      // No typed/generated event helper exists in this codebase — every
      // other listener (see bisect.svelte.ts's startRun, and src/main.ts's
      // "repo-changed") goes through the raw `window.__TAURI__.event.listen`,
      // so this mirrors that exactly rather than inventing a second
      // subscription mechanism.
      const w = window as unknown as { __TAURI__?: any };
      this.foreachUnlisten =
        (await w.__TAURI__?.event.listen(
          "submodule-foreach-progress",
          (e: { payload: SubmoduleForeachEntry }) => {
            this.foreachResults = [...this.foreachResults, e.payload];
          },
        )) ?? null;
      const res = await commands.submoduleForeachStart(repo, cmd, recursive); // blocks until the sweep finishes/cancels
      if (res.status === "ok") {
        this.foreachResults = res.data; // final list is authoritative even if an event raced it
        const failed = res.data.filter((e) => e.status === "failed").length;
        if (failed > 0) {
          bridge.tama.warn(failed + " of " + res.data.length + " submodule" + (res.data.length === 1 ? "" : "s") + " failed — see results below.");
        } else {
          bridge.tama.set("celebrate");
          bridge.tama.say('Ran "' + cmd + '" in every submodule.', 3200);
        }
      } else {
        bridge.tama.warn("Couldn't run in submodules — " + res.error);
      }
    } catch (e) {
      bridge.tama.warn("Foreach run failed — " + e);
      console.error(e);
    } finally {
      this.stopForeachListening();
      this.foreachRunning = false;
    }
  }

  // Always callable — mirrors bisect_run_cancel/submodule_foreach_cancel's
  // own "must always be able to run" escape-hatch spirit on the Rust side.
  // Only requests the stop; the sweep notices before its NEXT submodule
  // (same documented TOCTOU limitation as bisect's run_bisect), so
  // `foreachRunning` flips back to false via startForeach's own finally once
  // the in-flight call actually settles.
  async cancelForeach() {
    try {
      await commands.submoduleForeachCancel();
    } catch (e) {
      bridge.tama.warn("Couldn't cancel the run — " + e);
    }
  }

  // Best-effort guard wired into legacy/main.ts's openRepo() alongside
  // bisectCtrl.cancelIfRunning's own existing call — see this section's doc
  // comment above for the full rationale (submodule_foreach_start is a real,
  // long-lived blocking Tauri call actually executing the user's command
  // against every submodule's working tree; switching repos out from under
  // it would leave it running headlessly against a repo the UI can no
  // longer see or stop, with "submodule-foreach-progress" events silently
  // misapplied once the current repo/view has moved on). Only requests the
  // stop (see cancelForeach's own TOCTOU note above); does not wait for the
  // backend sweep to actually finish.
  async cancelIfRunning() {
    if (this.foreachRunning) await this.cancelForeach();
  }

  private stopForeachListening() {
    this.foreachUnlisten?.();
    this.foreachUnlisten = null;
  }

  // "Deinit" — status-gated confirm (see submoduleNeedsForceConfirm's own
  // doc comment): a "clean"/"out-of-date"/"not-initialized" row has nothing
  // at risk, so this calls straight through with force:false, no scrim at
  // all — matching this app's existing rule of never showing a needless
  // confirm for a safe operation. A "dirty"/"conflicted" row DOES show the
  // shared armDanger scrim first, since force:true is what's actually about
  // to run and that's the one path that can discard uncommitted content
  // (backed up first — see doDeinitSubmodule/submodule.rs).
  async deinitSubmodule(path: string, status: string) {
    if (!submoduleNeedsForceConfirm(status)) {
      await this.doDeinitSubmodule(path, false);
      return;
    }
    bridge.tama.set("danger");
    bridge.tama.say("Deinitializing " + path + " — type the path to arm it. I back up its uncommitted changes first.", 6000);
    bridge.armDanger({
      title: "Deinit submodule — " + path,
      steps: false,
      desc:
        "This clears the submodule's own checked-out files and unregisters it locally. Its committed history is NOT deleted — it stays in .git/modules and can be restored instantly (no re-clone) with Init + update. Only its UNCOMMITTED changes are at risk.",
      lose:
        "<h5>What happens</h5><ul><li>Clears <code>" +
        esc(path) +
        "</code>'s working tree</li><li>Unregisters it from this repo's local config</li><li>Its own uncommitted changes are backed up first, under <code>gitgui/submodule-backup/&#8230;</code></li></ul>",
      note:
        "🔁 I back up " +
        esc(path) +
        "'s own uncommitted changes before clearing it — its committed history is untouched and restorable via Init + update. This is NOT the global Undo (⌘Z) — that only ever rewinds THIS repo's own branches/HEAD.",
      name: path,
      confirmLabel: "Deinit submodule",
      onConfirm: async () => {
        await this.doDeinitSubmodule(path, true);
      },
    });
  }

  private async doDeinitSubmodule(path: string, force: boolean) {
    if (!IN_TAURI) {
      bridge.tama.set("celebrate");
      bridge.tama.say("Deinitialized " + path + " (demo).");
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.busyTarget = path;
    bridge.tama.set("thinking");
    bridge.tama.say("Deinitializing " + path + "…");
    try {
      let res = await commands.submoduleDeinit(bridge.CUR_REPO as unknown as string, path, force);
      // Stale-status race: the row's last-refreshed status said this was
      // safe (no scrim shown, force:false), but something changed it since
      // — git's own dirty/conflicted-gitlink refusal comes back here
      // instead. Mirrors doDeleteBranch's existing "not fully merged ->
      // confirm -> retry force" fallback exactly (sidebar.svelte.ts above).
      if (res && !res.ok && !force && /local modifications/i.test(res.message || "") && /use '-f'/i.test(res.message || "")) {
        if (confirm(path + " has local modifications. Force-deinit anyway? (its uncommitted changes are backed up first)")) {
          res = await commands.submoduleDeinit(bridge.CUR_REPO as unknown as string, path, true);
        } else {
          bridge.tama.warn("Kept " + path + " — deinit cancelled.");
          return;
        }
      }
      if (res && res.ok) {
        await this.refreshSubmodules(bridge.CUR_REPO as unknown as string);
        bridge.tama.set("celebrate");
        // res.message already names the backup path inline when one was
        // written ("… (backup: gitgui/submodule-backup/…)") — see
        // submodule.rs's ok_removal call sites — so no extra copy needed here.
        bridge.tama.say(res.message || "Deinitialized " + path + ".", 4200);
      } else {
        bridge.tama.warn((res && res.message) || "Couldn't deinit " + path + ".");
      }
    } catch (e) {
      bridge.tama.warn("Deinit failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  // "Remove" — always shows the shared armDanger scrim regardless of the
  // row's status, since it's unambiguously final (unlike Deinit, it also
  // strips the .gitmodules entry and stages a real, committable index
  // change). No force parameter to thread through onConfirm ->
  // doRemoveSubmodule -> submodule_remove: the backend always behaves as
  // force internally (see submodule_remove's own doc comment) — this
  // confirm dialog IS the gate, so there's no reason to let a first attempt
  // refuse pointlessly on a dirty submodule and force a redundant round-trip.
  removeSubmodule(path: string) {
    bridge.tama.set("danger");
    bridge.tama.say("Removing " + path + " — type the path to arm it. I back up any uncommitted changes first.", 6000);
    bridge.armDanger({
      title: "Remove submodule — " + path,
      steps: false,
      desc:
        "This removes " +
        path +
        " from this repository entirely: its checked-out files, its .gitmodules entry, and its tracked reference. This is staged, not committed — you'll still need to commit it. Its committed history is NOT deleted (it stays in .git/modules), and any of its own uncommitted changes are backed up first.",
      lose:
        "<h5>What happens</h5><ul><li>Clears and unregisters <code>" +
        esc(path) +
        "</code> (same as Deinit)</li><li>Stages its removal from the index (<code>git rm</code>)</li><li>Removes and stages its <code>[submodule]</code> entry from <code>.gitmodules</code></li><li>Nothing is committed — review and commit when ready</li></ul>",
      note:
        "🔁 If " +
        esc(path) +
        " had uncommitted changes, they're backed up first. This only STAGES the removal — Undo/discard the staged .gitmodules + " +
        esc(path) +
        " changes the normal way if you change your mind before committing.",
      name: path,
      confirmLabel: "Remove submodule",
      onConfirm: async () => {
        await this.doRemoveSubmodule(path);
      },
    });
  }

  private async doRemoveSubmodule(path: string) {
    if (!IN_TAURI) {
      bridge.tama.set("celebrate");
      bridge.tama.say("Removed " + path + " (demo).");
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.busyTarget = path;
    bridge.tama.set("thinking");
    bridge.tama.say("Removing " + path + "…");
    try {
      const res = await commands.submoduleRemove(bridge.CUR_REPO as unknown as string, path);
      if (res && res.ok) {
        await this.refreshSubmodules(bridge.CUR_REPO as unknown as string);
        bridge.tama.set("celebrate");
        // Same "message already names the backup path inline" reasoning as
        // doDeinitSubmodule above.
        bridge.tama.say(res.message || "Removed " + path + ".", 4200);
      } else {
        bridge.tama.warn((res && res.message) || "Couldn't remove " + path + ".");
      }
    } catch (e) {
      bridge.tama.warn("Remove failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  setSnapshots(snaps: Snapshot[]) {
    this.snapshots = Array.isArray(snaps) ? snaps.slice() : [];
  }

  copySnapshotSha(sha: string) {
    navigator.clipboard?.writeText(sha);
    this.copiedSnapshotSha = sha;
    setTimeout(() => {
      if (this.copiedSnapshotSha === sha) this.copiedSnapshotSha = "";
    }, 900);
  }

  reset() {
    this.locals = [];
    this.remotes = [];
    this.tags = [];
    this.submodules = [];
    this.head = null;
    this.snapshots = [];
    this.menu = null;
    this.tagMenu = null;
    this.submoduleMenu = null;
    this.mergeMenu = null;
    this.dirtyCheckoutMenu = null;
    this.hasRepo = false;
    this.foreachResults = [];
    this.foreachCommand = "";
  }

  // `pos`: the (x, y) to open backlog #34's dirty-tree resolution chooser at,
  // IF this hits a dirty-tree collision — the row click / "⋮" menu's
  // Checkout button both already have a position in hand at the moment they
  // call this (see Sidebar.svelte), so there's no need to re-measure an
  // anchor element after the fact. Optional (defaults to a fixed fallback
  // position) so every pre-existing call site/test that doesn't pass one
  // keeps working unchanged. The plain non-dirty path below (the
  // overwhelmingly common case) is BYTE-IDENTICAL to before this feature —
  // one round trip, no extra branching — the new `else if` only ever fires
  // instead of the pre-existing generic `else` toast, and only for THIS one
  // specific, previously-unrecoverable refusal.
  async checkout(name: string, pos?: { x: number; y: number }) {
    if (!IN_TAURI) {
      bridge.tama.set("hint");
      bridge.tama.say("Checked out " + name + " (demo).");
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.busyTarget = name;
    bridge.tama.set("thinking");
    bridge.tama.say("Checking out " + name + "…");
    try {
      const res = await commands.checkout(bridge.CUR_REPO as unknown as string, name);
      if (res && res.ok) {
        await bridge.reloadGraph(true);
        bridge.tama.set("celebrate");
        bridge.tama.say("On " + name + " now. にゃ〜", 3200);
      } else if (res && res.conflictingFiles && res.conflictingFiles.length) {
        // Dirty-tree collision (git_write.rs's `checkout` classified it via
        // `classify_switch_failure`) — offer the resolution chooser instead
        // of just toasting the plain error, like every OTHER refusal still
        // does below.
        const p = pos ?? { x: 24, y: 80 };
        this.openDirtyCheckoutMenu(name, null, res.conflictingFiles, p.x, p.y);
      } else {
        bridge.tama.warn((res && res.message) || "Couldn't check out " + name + " — you may have uncommitted changes.");
      }
    } catch (e) {
      bridge.tama.warn("Checkout failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  // Check out a REMOTE branch (e.g. "origin/feature-x") — previously remote
  // rows in the sidebar were display-only, with no way to start working on
  // someone else's branch at all. Mirrors `git checkout <shortname>`'s own
  // DWIM: if a local branch with the short name already exists, just switch
  // to it (assume it's the one tracking this remote); otherwise create one
  // via create_branch's existing start_point param — git's default
  // branch.autoSetupMerge sets up tracking automatically since the start
  // point is a remote-tracking ref, no extra plumbing needed here.
  // `pos`: same rationale as `checkout`'s own doc comment — forwarded
  // straight through to the `checkout(shortName, pos)` delegate below when a
  // local branch already exists, and used directly to open the chooser on
  // this method's OWN dirty-tree collision (the "new local branch tracking a
  // remote" `create_branch` path) otherwise.
  async checkoutRemote(remoteRef: string, pos?: { x: number; y: number }) {
    if (this.busy) return;
    const slash = remoteRef.indexOf("/");
    const shortName = slash >= 0 ? remoteRef.slice(slash + 1) : remoteRef;
    if (this.locals.some((b) => b.name === shortName)) {
      await this.checkout(shortName, pos);
      return;
    }
    if (!IN_TAURI) {
      bridge.tama.set("hint");
      bridge.tama.say("Checked out " + shortName + " tracking " + remoteRef + " (demo).");
      return;
    }
    this.busy = true;
    this.busyTarget = remoteRef;
    bridge.tama.set("thinking");
    bridge.tama.say("Creating " + shortName + " to track " + remoteRef + "…");
    try {
      const res = await commands.createBranch(bridge.CUR_REPO as unknown as string, shortName, remoteRef, true);
      if (res && res.ok) {
        await bridge.reloadGraph(true);
        bridge.tama.set("celebrate");
        bridge.tama.say("On " + shortName + " now, tracking " + remoteRef + ". にゃ〜", 3200);
      } else if (res && res.conflictingFiles && res.conflictingFiles.length) {
        // Dirty-tree collision on `create_branch(checkout:true)` — classified
        // identically to plain `checkout`'s own (see git_write.rs's shared
        // `classify_switch_failure`). `startPoint: remoteRef` so the chooser's
        // 3 modes all know to re-create-and-checkout from the remote ref
        // rather than switch to an already-existing local branch.
        const p = pos ?? { x: 24, y: 80 };
        this.openDirtyCheckoutMenu(shortName, remoteRef, res.conflictingFiles, p.x, p.y);
      } else {
        bridge.tama.warn((res && res.message) || "Couldn't check out " + remoteRef + ".");
      }
    } catch (e) {
      bridge.tama.warn("Checkout failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  // ── Backlog #34: dirty-tree resolution chooser's 3 modes ────────────────
  // All three are pure ORCHESTRATION of existing commands (`stash_save`,
  // `checkout`/`create_branch`, `stash_apply`/`stash_pop`, `checkout_discard`)
  // — no new backend surface needed for modes 1/2 at all (see the design
  // notes this backlog item shipped with). `startPoint` (`null` for an
  // existing local branch, a remote ref for `checkoutRemote`'s "new branch"
  // path) is threaded straight through from `DirtyCheckoutMenu` — see its own
  // doc comment.

  // Mode 1: "Stash, switch, then reapply". Stashes EVERYTHING (including
  // untracked — `includeUntracked:true`, so the switch is guaranteed
  // unblocked no matter which collision shape made it dirty in the first
  // place), switches, then immediately pops the SAME stash back on top of the
  // new branch. A reapply conflict is NOT a new conflict kind — it lands in
  // the exact existing stash-conflict Resolver flow via
  // `resolver.openStashConflict` (the SAME path workdir.svelte.ts's own
  // stash-pop button already uses), never any bespoke handling here.
  async stashSwitchReapply(name: string, startPoint: string | null) {
    await this.stashThenSwitch(name, startPoint, true);
  }

  // Mode 2: "Stash, switch, leave stashed" — identical to mode 1 up through
  // the switch, but deliberately does NOT reapply: the user's changes sit
  // safely in the stash list (recoverable any time via Manage Stash) instead
  // of being discarded. This is the SAFE, fully-recoverable analogue of
  // "discard" — matching this codebase's "never destroy without a net" ethos.
  async stashSwitchLeaveStashed(name: string, startPoint: string | null) {
    await this.stashThenSwitch(name, startPoint, false);
  }

  private async stashThenSwitch(name: string, startPoint: string | null, reapply: boolean) {
    if (!IN_TAURI) {
      bridge.tama.set("hint");
      bridge.tama.say((reapply ? "Stashed, switched to, and reapplied onto " : "Stashed and switched to ") + name + " (demo).");
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.busyTarget = name;
    bridge.tama.set("thinking");
    bridge.tama.say("Stashing your changes…");
    try {
      const repo = bridge.CUR_REPO as unknown as string;
      // Stash EVERYTHING (tracked + untracked) so the switch below is
      // guaranteed unblocked regardless of which collision shape (modified,
      // staged, untracked) made the tree dirty in the first place.
      const stashRes = await commands.stashSave(repo, "Auto-stash before switching to " + name, true);
      if (!stashRes.ok) {
        bridge.tama.warn(stashRes.message || "Couldn't stash your changes — nothing was switched.");
        return;
      }
      bridge.tama.say("Switching to " + name + "…");
      const switchRes = startPoint
        ? await commands.createBranch(repo, name, startPoint, true)
        : await commands.checkout(repo, name);
      if (!switchRes.ok) {
        // Genuinely unusual (we just cleared the dirty tree ourselves) — some
        // OTHER refusal (bad ref, name collision, …). The stash is untouched
        // and still recoverable via Manage Stash, so say so rather than
        // implying the changes are gone.
        bridge.tama.warn((switchRes.message || "Couldn't switch to " + name + ".") + " Your changes are safely stashed — see Manage Stash.");
        return;
      }
      await bridge.reloadGraph(true);
      if (!reapply) {
        bridge.tama.set("celebrate");
        bridge.tama.say("On " + name + " now — your changes are stashed. にゃ〜", 3200);
        return;
      }
      bridge.tama.say("Reapplying your changes…");
      // Fetch the just-created stash's own sha so stash_pop's optional
      // identity check (see stash_apply/stash_pop's own doc comment) can
      // catch a race if something else touched the stash list in between —
      // it's always stash@{0} here since nothing else has stashed since.
      let expectedSha: string | null = null;
      const listRes = await commands.stashList(repo);
      if (listRes.status === "ok" && listRes.data[0]) expectedSha = listRes.data[0].sha;
      const popRes = await commands.stashPop(repo, 0, expectedSha);
      if (popRes.ok) {
        bridge.tama.set("celebrate");
        bridge.tama.say("On " + name + " now. にゃ〜", 3200);
      } else if (popRes.conflictedFiles && popRes.conflictedFiles.length) {
        // Same shared Resolver merge/pick/rebase/stash conflict already use —
        // see resolver.svelte.ts's "stash" op entry and workdir.svelte.ts's
        // applyOrPopStash, which this mirrors exactly.
        await resolver.openStashConflict(repo, popRes);
      } else {
        bridge.tama.warn(popRes.message || "Couldn't reapply your stashed changes — they're kept in the stash list.");
      }
    } catch (e) {
      bridge.tama.warn("Checkout failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  // Mode 3: "Force switch, discarding my changes" — the one genuinely
  // destructive mode, gated behind the shared armDanger typed-confirm exactly
  // like Force Push's "override" variant (see forcepush.svelte.ts), with
  // equally unambiguous, scary copy: unlike modes 1/2 (both stash-backed and
  // fully recoverable), this is real, permanent data loss with NO recovery
  // path — `checkout_discard` deliberately writes no backup of the discarded
  // content (see its own doc comment).
  // `fileCount` is only the count of files that made the ORIGINAL plain
  // checkout refuse — NOT the true scope of what this mode discards. An
  // adversarial review found `git switch --force`'s real blast radius is
  // every uncommitted tracked/staged change anywhere in the working tree,
  // not just these `fileCount` colliding paths (see checkout_discard's own
  // doc comment in git_write.rs for the empirical verification) — so the
  // copy below deliberately does NOT imply the damage is scoped to
  // `fileCount` files; it names them for context, then separately and
  // unconditionally warns about the whole tree.
  forceDiscardCheckout(name: string, startPoint: string | null, fileCount: number) {
    const n = fileCount + " file" + (fileCount === 1 ? "" : "s");
    bridge.tama.set("danger");
    bridge.tama.say("Switching to " + name + " will DISCARD ALL your uncommitted changes, not just the " + n + " blocking this switch — type the branch name to arm it.", 6000);
    bridge.armDanger({
      title: "Force switch — discard changes — " + name,
      steps: false,
      desc:
        "This discards ALL of your uncommitted tracked changes — not just the " +
        n +
        " blocking this switch, but anywhere else in the working tree too — and switches to " +
        name +
        ", no matter what. Prefer Stash, switch, then reapply (or leave stashed) unless you're certain you don't need any of these changes.",
      lose:
        "<h5>What happens</h5><ul><li>Permanently discards ALL of your uncommitted tracked/staged changes across the whole working tree — not just the " +
        n +
        " that blocked this switch</li><li>Switches to <code>" +
        esc(name) +
        "</code></li></ul>",
      note:
        "⚠️ This is NOT recoverable, and it is NOT limited to the " +
        n +
        " named above — every uncommitted tracked/staged change in the repository is gone the instant you confirm. Safety Manager/Undo only ever protects committed history, never uncommitted content.",
      name,
      confirmLabel: "Discard & switch",
      onConfirm: async () => {
        await this.doForceDiscardCheckout(name, startPoint);
      },
    });
  }

  private async doForceDiscardCheckout(name: string, startPoint: string | null) {
    if (!IN_TAURI) {
      bridge.tama.set("celebrate");
      bridge.tama.say("Force-switched to " + name + " (demo).");
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.busyTarget = name;
    bridge.tama.set("thinking");
    bridge.tama.say("Force-switching to " + name + "…");
    try {
      const res = await commands.checkoutDiscard(bridge.CUR_REPO as unknown as string, name, startPoint);
      if (res && res.ok) {
        await bridge.reloadGraph(true);
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "On " + name + " now.", 3200);
      } else {
        bridge.tama.warn((res && res.message) || "Couldn't switch to " + name + ".");
      }
    } catch (e) {
      bridge.tama.warn("Checkout failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  // Tauri's webview (WKWebView on macOS in particular) doesn't implement
  // window.prompt() — it returns null immediately with no dialog ever shown,
  // so the old prompt()-based flow silently did nothing. Swap it for an
  // inline input in the "＋ New branch…" row itself instead (same shape as
  // every other island's typed-input flow, just without a whole modal for
  // one field).
  startNewBranch() {
    this.newBranchInput = "";
    this.newBranchFrom = "";
    this.newBranchOpen = true;
  }

  cancelNewBranch() {
    this.newBranchOpen = false;
    this.newBranchInput = "";
    this.newBranchFrom = "";
  }

  async confirmNewBranch() {
    const name = this.newBranchInput.trim();
    if (!name) {
      this.cancelNewBranch();
      return;
    }
    if (this.busy) return;
    const from = this.newBranchFrom || null; // "" (HEAD) -> null, same as create_branch's own default
    if (!IN_TAURI) {
      this.newBranchOpen = false;
      this.newBranchInput = "";
      this.newBranchFrom = "";
      bridge.tama.set("hint");
      bridge.tama.say("Created " + name + (from ? " from " + from : "") + " (demo).");
      return;
    }
    // Keep the form open (disabled, spinnered — see Sidebar.svelte) for the
    // duration of the request instead of closing it up front: closing before
    // the await resolves gave zero indication a request was even in flight,
    // and on failure silently threw away whatever the user had typed.
    this.busy = true;
    this.busyTarget = name;
    bridge.tama.set("thinking");
    bridge.tama.say("Creating " + name + "…");
    try {
      const res = await commands.createBranch(bridge.CUR_REPO as unknown as string, name, from, true);
      if (res && res.ok) {
        this.newBranchOpen = false;
        this.newBranchInput = "";
        this.newBranchFrom = "";
        await bridge.reloadGraph(true);
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Branch " + name + " created.", 3200);
      } else {
        bridge.tama.warn((res && res.message) || "Couldn't create " + name + ".");
      }
    } catch (e) {
      bridge.tama.warn("Create failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  deleteBranch(name: string) {
    bridge.tama.set("danger");
    bridge.tama.say("Deleting " + name + " — type the branch name to arm it. I pin its tip first.", 6000);
    bridge.armDanger({
      title: "Delete branch — " + name,
      steps: false,
      desc: "This removes the local branch ref. Its tip is pinned to a backup first, so the commits stay recoverable by sha.",
      lose:
        '<h5>What happens</h5><ul><li>Removes local branch <code>' +
        esc(name) +
        "</code></li><li>Its tip is pinned under <code>refs/gitgui/deleted/…</code> — recover with ＋ New branch → the printed sha</li></ul>",
      note: "🔁 I pin the branch tip before deleting; ⌘Z restores your CURRENT branch position (not the deleted branch).",
      name,
      confirmLabel: "Delete branch",
      onConfirm: async () => {
        await this.doDeleteBranch(name, false);
      },
    });
  }

  private async doDeleteBranch(name: string, force: boolean) {
    if (!IN_TAURI) {
      bridge.tama.set("celebrate");
      bridge.tama.say("Deleted " + name + " (demo).");
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.busyTarget = name;
    bridge.tama.set("thinking");
    bridge.tama.say("Deleting " + name + "…");
    try {
      let res = await commands.deleteBranch(bridge.CUR_REPO as unknown as string, name, force);
      if (res && !res.ok && !force && /not (fully )?merged/i.test(res.message || "")) {
        if (confirm(name + " is not fully merged. Force-delete anyway? (the tip is pinned to a backup)")) {
          res = await commands.deleteBranch(bridge.CUR_REPO as unknown as string, name, true);
        } else {
          bridge.tama.warn("Kept " + name + " — delete cancelled.");
          return;
        }
      }
      if (res && res.ok) {
        await bridge.reloadGraph(true);
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Deleted " + name + ".", 4200);
      } else {
        bridge.tama.warn((res && res.message) || "Couldn't delete " + name + ".");
      }
    } catch (e) {
      bridge.tama.warn("Delete failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  openMenu(name: string, isCurrent: boolean, anchor: HTMLElement) {
    this.tagMenu = null; // only one popover open at a time
    this.submoduleMenu = null;
    this.mergeMenu = null;
    this.dirtyCheckoutMenu = null;
    const r = anchor.getBoundingClientRect();
    this.menu = { name, isCurrent, x: Math.min(r.left, window.innerWidth - 168), y: r.bottom + 4 };
  }

  closeMenu() {
    this.menu = null;
  }

  // Backlog #7's strategy chooser — a SECOND-level popover opened from
  // inside the branch popover's own "Merge into current…" button, reusing
  // that button's already-computed (x, y) rather than re-measuring an
  // anchor element (the branch popover that button lives in is about to be
  // closed in the same click handler — see Sidebar.svelte).
  openMergeMenu(name: string, x: number, y: number) {
    this.menu = null; // only one popover open at a time
    this.tagMenu = null;
    this.submoduleMenu = null;
    this.dirtyCheckoutMenu = null;
    this.mergeMenu = { name, x: Math.min(x, window.innerWidth - 220), y };
  }

  closeMergeMenu() {
    this.mergeMenu = null;
  }

  // Backlog #34's dirty-tree resolution chooser — opened from `checkout`/
  // `checkoutRemote` the instant either hits a dirty-tree collision (see
  // DirtyCheckoutMenu's own doc comment), reusing whatever (x, y) the
  // triggering row/menu-button already had (mirrors openMergeMenu's own
  // "reuse the caller's already-computed position" shape — there's no
  // separate anchor element to re-measure here either, since this opens
  // asynchronously after an IPC round-trip, by which point the originating
  // click's own popover/row may already be gone).
  openDirtyCheckoutMenu(name: string, startPoint: string | null, files: string[], x: number, y: number) {
    this.menu = null; // only one popover open at a time
    this.tagMenu = null;
    this.submoduleMenu = null;
    this.mergeMenu = null;
    this.dirtyCheckoutMenu = { name, startPoint, files, x: Math.min(x, window.innerWidth - 260), y };
  }

  closeDirtyCheckoutMenu() {
    this.dirtyCheckoutMenu = null;
  }

  // Auto / always-create-a-merge-commit / fast-forward-only — all three
  // funnel through resolver.startMerge's now-optional `strategy` param (see
  // its own doc comment); the drag-gesture merge and commit-menu's "Merge"
  // action are UNCHANGED and never call this. Design-mode demo reuses the
  // existing "merge" conflict demo verbatim (ignoring which strategy was
  // picked) — same "demo doesn't need every real nuance" convention
  // rebaseOnto's own demo branch already uses.
  async mergeInto(name: string, strategy: "auto" | "no-ff" | "ff-only") {
    if (!IN_TAURI) {
      resolver.openDemo(name, "merge"); // ---- design-mode demo ----
      return;
    }
    await resolver.startMerge(bridge.CUR_REPO as unknown as string, name, strategy); // ---- real merge (Svelte island) ----
  }

  // Squash `name`'s entire diff into the index (no commit) — see
  // resolver.svelte.ts's `startMergeSquash` for the clean/conflict split
  // (clean hands off to the Workdir commit UI; conflict opens this same
  // shared Resolver with the "merge-squash" op).
  async squashInto(name: string) {
    if (!IN_TAURI) {
      resolver.openDemo(name, "merge-squash"); // ---- design-mode demo ----
      return;
    }
    await resolver.startMergeSquash(bridge.CUR_REPO as unknown as string, name); // ---- real squash (Svelte island) ----
  }

  // "+ New tag…" inline form — same window.prompt()-doesn't-exist-in-
  // Tauri's-webview rationale as startNewBranch above.
  startNewTag() {
    this.newTagName = "";
    this.newTagMessage = "";
    this.newTagFrom = "";
    this.newTagOpen = true;
  }

  cancelNewTag() {
    this.newTagOpen = false;
    this.newTagName = "";
    this.newTagMessage = "";
    this.newTagFrom = "";
  }

  async confirmNewTag() {
    const name = this.newTagName.trim();
    if (!name) {
      this.cancelNewTag();
      return;
    }
    if (this.busy) return;
    const target = this.newTagFrom || null; // "" (HEAD) -> null, same as create_tag's own default
    const message = this.newTagMessage.trim() || null; // "" -> lightweight tag
    if (!IN_TAURI) {
      this.newTagOpen = false;
      this.newTagName = "";
      this.newTagMessage = "";
      this.newTagFrom = "";
      bridge.tama.set("hint");
      bridge.tama.say("Created tag " + name + (target ? " at " + target : "") + " (demo).");
      return;
    }
    // Keep the form open (disabled, spinnered) for the duration of the
    // request, same rationale as confirmNewBranch above.
    this.busy = true;
    this.busyTarget = name;
    bridge.tama.set("thinking");
    bridge.tama.say("Creating tag " + name + "…");
    try {
      const res = await commands.createTag(bridge.CUR_REPO as unknown as string, name, target, message);
      if (res && res.ok) {
        this.newTagOpen = false;
        this.newTagName = "";
        this.newTagMessage = "";
        this.newTagFrom = "";
        await bridge.reloadGraph(true);
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Tag " + name + " created.", 3200);
      } else {
        bridge.tama.warn((res && res.message) || "Couldn't create tag " + name + ".");
      }
    } catch (e) {
      bridge.tama.warn("Create failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  deleteTag(name: string) {
    bridge.tama.set("danger");
    bridge.tama.say("Deleting tag " + name + " — type the tag name to arm it. I pin its target first.", 6000);
    bridge.armDanger({
      title: "Delete tag — " + name,
      steps: false,
      desc: "This removes the tag ref. Its target is pinned to a backup first, so it stays recoverable.",
      lose:
        "<h5>What happens</h5><ul><li>Removes tag <code>" +
        esc(name) +
        "</code></li><li>Its target is pinned under <code>refs/gitgui/deleted-tag/…</code> — recover with <code>git tag " +
        esc(name) +
        " &lt;pinned ref&gt;</code></li></ul>",
      note: "🔁 I pin the tag's target before deleting; this is NOT restorable via the global Undo (⌘Z) — that only rewinds branches, never tags.",
      name,
      confirmLabel: "Delete tag",
      onConfirm: async () => {
        await this.doDeleteTag(name);
      },
    });
  }

  private async doDeleteTag(name: string) {
    if (!IN_TAURI) {
      bridge.tama.set("celebrate");
      bridge.tama.say("Deleted tag " + name + " (demo).");
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.busyTarget = name;
    bridge.tama.set("thinking");
    bridge.tama.say("Deleting tag " + name + "…");
    try {
      const res = await commands.deleteTag(bridge.CUR_REPO as unknown as string, name);
      if (res && res.ok) {
        await bridge.reloadGraph(true);
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Deleted tag " + name + ".", 4200);
      } else {
        bridge.tama.warn((res && res.message) || "Couldn't delete tag " + name + ".");
      }
    } catch (e) {
      bridge.tama.warn("Delete failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  async pushTag(name: string) {
    if (!IN_TAURI) {
      bridge.tama.set("celebrate");
      bridge.tama.say("Pushed tag " + name + " (demo).");
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.busyTarget = name;
    bridge.tama.set("thinking");
    bridge.tama.say("Pushing tag " + name + "…");
    try {
      const res = await commands.pushTag(bridge.CUR_REPO as unknown as string, null, name);
      if (res && res.ok) {
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Pushed tag " + name + ".", 3200);
      } else {
        bridge.tama.warn((res && res.message) || "Couldn't push tag " + name + ".");
      }
    } catch (e) {
      bridge.tama.warn("Push failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  openTagMenu(name: string, anchor: HTMLElement) {
    this.menu = null; // only one popover open at a time
    this.submoduleMenu = null;
    this.mergeMenu = null;
    this.dirtyCheckoutMenu = null;
    const r = anchor.getBoundingClientRect();
    this.tagMenu = { name, x: Math.min(r.left, window.innerWidth - 168), y: r.bottom + 4 };
  }

  closeTagMenu() {
    this.tagMenu = null;
  }

  openSubmoduleMenu(path: string, status: string, absolutePath: string, anchor: HTMLElement) {
    this.menu = null; // only one popover open at a time
    this.tagMenu = null;
    this.mergeMenu = null;
    this.dirtyCheckoutMenu = null;
    const r = anchor.getBoundingClientRect();
    this.submoduleMenu = { path, status, absolutePath, x: Math.min(r.left, window.innerWidth - 168), y: r.bottom + 4 };
  }

  closeSubmoduleMenu() {
    this.submoduleMenu = null;
  }

  async rebaseOnto(name: string) {
    if (!IN_TAURI) {
      resolver.openDemo(name, "rebase"); // ---- design-mode demo ----
      return;
    }
    await resolver.startRebase(bridge.CUR_REPO as unknown as string, name); // ---- real rebase (Svelte island) ----
  }

  // Interactive rebase: opens the todo-list planner instead of rebasing
  // one-shot. rebasePlanCtrl.openFor() handles its own IN_TAURI/demo-mode
  // branching internally (unlike rebaseOnto/resolver.startRebase above), so
  // there's no design-mode branch to duplicate here.
  async interactiveRebaseOnto(name: string) {
    await rebasePlanCtrl.openFor(bridge.CUR_REPO as unknown as string, name);
  }
}

function esc(s: unknown): string {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
}

export const sidebarCtrl = new SidebarState();
